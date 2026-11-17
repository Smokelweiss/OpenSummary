#!/usr/bin/env node
/**
 * Imports a real YouTube watch page (or a bare ytInitialPlayerResponse) and
 * turns it into a fixture the caption parsers can be tested against offline.
 *
 * Why: this project cannot reach youtube.com from every environment, so the
 * only way to check `extractCaptionTracks` / `pickTrack` / `isPoTokenProtected`
 * on real markup is to capture that markup once on a machine that can open the
 * video and keep a cleaned copy as a test fixture.
 *
 * Two modes:
 *   analyze  — read-only report for debugging; never writes anything.
 *   sanitize — write a fixture with signed URLs, tokens, visitor ids and
 *              session identifiers replaced by placeholders.
 *
 * A sanitized fixture still proves nothing about downloading captions: the
 * signed `baseUrl` values are dead by construction. It only proves how the
 * player response is parsed and which track is chosen.
 *
 *   node tools/player-response.mjs analyze saved.html
 *   node tools/player-response.mjs sanitize saved.html --out=tests/fixtures/youtube/sample.json
 *   node tools/player-response.mjs status
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getInitialData,
  getInnertubeConfig,
  getPlayerResponse,
} from '../src/transcript/html-parse.js';
import {
  extractCaptionTracks,
  extractTranscriptParams,
  isPoTokenProtected,
  pickTrack,
} from '../src/transcript/youtube.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'youtube');
const REDACTED = 'REDACTED';
const PLACEHOLDER_PARAMS = 'PLACEHOLDER_TRANSCRIPT_PARAMS';
const FIXTURE_VERSION = 1;

/** Query parameters the parser actually reads; everything else is redacted. */
const URL_KEEP = new Set(['v', 'lang', 'fmt', 'kind', 'tlang', 'hl']);
/** PO-token marker: the only `exp` value the parser tests for. */
const PO_MARKER = 'xpe';

const TRACK_KEYS = ['baseUrl', 'languageCode', 'kind', 'vssId', 'isTranslatable', 'name', 'displayName', 'audioTrack'];
const VIDEO_DETAIL_KEYS = [
  'videoId',
  'title',
  'author',
  'channelId',
  'lengthSeconds',
  'viewCount',
  'isLiveContent',
  'keywords',
  'shortDescription',
  // Public CDN thumbnail, read by extractVideoMeta; no signed values inside.
  'thumbnail',
];
const MICROFORMAT_KEYS = [
  'lengthSeconds',
  'publishDate',
  'uploadDate',
  'ownerChannelName',
  'externalChannelId',
  'category',
  'isFamilySafe',
  'description',
];
const DESCRIPTION_LIMIT = 2000;

/* ------------------------------------------------------------------ input --- */

/** Reads an HTML watch page or a JSON dump; returns the two blobs the parsers use. */
export function loadSource(path) {
  const raw = readFileSync(path, 'utf8');
  const text = raw.trim();
  if (/^[[{]/.test(text)) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`это не JSON: ${err.message}`);
    }
    const playerResponse =
      json.playerResponse || json.ytInitialPlayerResponse || (json.captions || json.videoDetails ? json : null);
    if (!playerResponse) {
      throw new Error('в JSON нет ни playerResponse, ни ytInitialPlayerResponse');
    }
    const initialData = json.initialData || json.ytInitialData || null;
    return { kind: 'json', bytes: Buffer.byteLength(raw), playerResponse, initialData, innertube: { clientVersion: '', visitorData: '' } };
  }
  const playerResponse = getPlayerResponse(raw);
  if (!playerResponse) {
    throw new Error('в HTML нет ytInitialPlayerResponse (страница согласия, ошибка или другой формат?)');
  }
  return {
    kind: 'html',
    bytes: Buffer.byteLength(raw),
    playerResponse,
    initialData: getInitialData(raw),
    innertube: getInnertubeConfig(raw),
  };
}

export function detectVideoId(playerResponse, fallback = '') {
  return String(playerResponse?.videoDetails?.videoId || fallback || '');
}

/* --------------------------------------------------------------- sanitize --- */

/**
 * Keeps the URL shape and the parameter names, replaces every value the parser
 * does not need. `exp=xpe` is the PO-token marker itself, not a secret, so it
 * survives — without it `isPoTokenProtected` could not be tested at all.
 */
export function sanitizeUrl(rawUrl, redacted = []) {
  if (!rawUrl) return '';
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return REDACTED;
  }
  for (const [name, value] of [...url.searchParams.entries()]) {
    if (URL_KEEP.has(name)) continue;
    if (name === 'exp' && value === PO_MARKER) continue;
    url.searchParams.set(name, REDACTED);
    redacted.push(name);
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function truncate(text, limit) {
  const str = String(text ?? '');
  return str.length > limit ? `${str.slice(0, limit)}…` : str;
}

function sanitizeAudioTrackId(value) {
  const id = String(value ?? '');
  return /^[a-z]{2}(?:-[A-Za-z0-9]{1,8})?$/.test(id) ? id : REDACTED;
}

function sanitizeTrack(track, dropped, urlParams) {
  const out = {};
  for (const key of TRACK_KEYS) {
    if (!(key in track)) continue;
    if (key === 'baseUrl') {
      out.baseUrl = sanitizeUrl(track.baseUrl, urlParams);
    } else if (key === 'audioTrack' && track.audioTrack && typeof track.audioTrack === 'object') {
      const audio = {};
      if ('audioTrackId' in track.audioTrack) audio.audioTrackId = sanitizeAudioTrackId(track.audioTrack.audioTrackId);
      if (track.audioTrack.displayName) audio.displayName = clone(track.audioTrack.displayName);
      out.audioTrack = audio;
    } else {
      out[key] = clone(track[key]);
    }
  }
  for (const key of Object.keys(track)) if (!TRACK_KEYS.includes(key)) dropped.add(key);
  return out;
}

/** Prunes ytInitialData down to the path that carries getTranscriptEndpoint. */
function pruneToTranscriptParams(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.getTranscriptEndpoint?.params === 'string') {
    return { getTranscriptEndpoint: { params: PLACEHOLDER_PARAMS } };
  }
  if (Array.isArray(node)) {
    const kept = node.map(pruneToTranscriptParams).filter(Boolean);
    return kept.length ? kept : null;
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    const kept = pruneToTranscriptParams(value);
    if (kept) out[key] = kept;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Builds a shareable fixture. Everything the parsers read is kept; everything
 * else (signed values, tokens, visitor ids, tracking blobs) is dropped or
 * replaced. `notes` records what was removed so the report can list it.
 */
export function sanitizeFixture({ playerResponse, initialData, videoId, capturedAt }) {
  const notes = { urlParams: [], droppedTrackKeys: new Set(), droppedPlayerKeys: new Set(), truncated: [] };
  const out = {};
  const pr = playerResponse || {};

  if (pr.playabilityStatus) {
    const status = {};
    if (pr.playabilityStatus.status) status.status = String(pr.playabilityStatus.status);
    if (pr.playabilityStatus.reason) status.reason = String(pr.playabilityStatus.reason);
    out.playabilityStatus = status;
  }

  if (pr.videoDetails) {
    const details = {};
    for (const key of VIDEO_DETAIL_KEYS) {
      if (!(key in pr.videoDetails)) continue;
      if (key === 'shortDescription') {
        const value = String(pr.videoDetails[key] ?? '');
        details[key] = truncate(value, DESCRIPTION_LIMIT);
        if (value.length > DESCRIPTION_LIMIT) notes.truncated.push(`videoDetails.${key} (${value.length} → ${DESCRIPTION_LIMIT})`);
      } else {
        details[key] = clone(pr.videoDetails[key]);
      }
    }
    for (const key of Object.keys(pr.videoDetails)) if (!VIDEO_DETAIL_KEYS.includes(key)) notes.droppedPlayerKeys.add(`videoDetails.${key}`);
    out.videoDetails = details;
  }

  const mf = pr.microformat?.playerMicroformatRenderer;
  if (mf) {
    const micro = {};
    for (const key of MICROFORMAT_KEYS) {
      if (!(key in mf)) continue;
      if (key === 'description' && mf.description && typeof mf.description === 'object') {
        if (mf.description.simpleText != null) {
          const value = String(mf.description.simpleText);
          micro.description = { simpleText: truncate(value, DESCRIPTION_LIMIT) };
          if (value.length > DESCRIPTION_LIMIT) notes.truncated.push(`microformat.description (${value.length} → ${DESCRIPTION_LIMIT})`);
        }
        continue;
      }
      micro[key] = typeof mf[key] === 'string' ? truncate(mf[key], DESCRIPTION_LIMIT) : clone(mf[key]);
    }
    out.microformat = { playerMicroformatRenderer: micro };
    for (const key of Object.keys(mf)) if (!MICROFORMAT_KEYS.includes(key)) notes.droppedPlayerKeys.add(`microformat.${key}`);
  }

  const list = pr.captions?.playerCaptionsTracklistRenderer;
  if (list) {
    const renderer = {};
    renderer.captionTracks = (Array.isArray(list.captionTracks) ? list.captionTracks : []).map((track) =>
      sanitizeTrack(track, notes.droppedTrackKeys, notes.urlParams),
    );
    if (Array.isArray(list.audioTracks) && list.audioTracks.length) {
      renderer.audioTracks = list.audioTracks.map((audio) => {
        const kept = {};
        if (audio?.audioTrackId != null) kept.audioTrackId = sanitizeAudioTrackId(audio.audioTrackId);
        if (audio?.displayName) kept.displayName = clone(audio.displayName);
        return kept;
      });
    }
    if (list.defaultAudioTrackIndex != null) renderer.defaultAudioTrackIndex = Number(list.defaultAudioTrackIndex);
    out.captions = { playerCaptionsTracklistRenderer: renderer };
    for (const key of Object.keys(list)) {
      if (!['captionTracks', 'audioTracks', 'defaultAudioTrackIndex'].includes(key)) {
        notes.droppedPlayerKeys.add(`captions.${key}`);
      }
    }
  }

  const fixture = {
    fixtureVersion: FIXTURE_VERSION,
    capturedAt: capturedAt || new Date().toISOString().slice(0, 10),
    source: 'ytInitialPlayerResponse',
    videoId: detectVideoId(pr, videoId),
    redaction: {
      version: 1,
      urlParamsRedacted: [...new Set(notes.urlParams)].sort(),
      droppedPlayerFields: [...notes.droppedPlayerKeys].sort(),
      droppedTrackFields: [...notes.droppedTrackKeys].sort(),
      transcriptParams: 'placeholder',
      note: 'подписанные URL и токены заменены на REDACTED; fixture не годится для скачивания',
    },
    playerResponse: out,
  };

  // Only the path to getTranscriptEndpoint is kept, and its opaque params value
  // is always replaced: the shape is what extractTranscriptParams needs, and a
  // per-capture blob has no business in a committed fixture.
  const pruned = initialData ? pruneToTranscriptParams(initialData) : null;
  if (pruned) fixture.initialData = pruned;
  return { fixture, notes };
}

/* ------------------------------------------------------------------ audit --- */

const SAFE_TEXT_KEYS = new Set([
  'title',
  'author',
  'shortDescription',
  'description',
  'name',
  'displayName',
  'category',
  'reason',
  'ownerChannelName',
  'status',
  'languageCode',
  'kind',
  'vssId',
  'urlParamsRedacted',
  'droppedPlayerFields',
  'droppedTrackFields',
  'transcriptParams',
  'note',
  'source',
  'capturedAt',
  'videoId',
  'audioTrackId',
  'fixtureVersion',
  'version',
]);

/**
 * Last line of defence before a fixture is written or committed: any query
 * parameter with a live-looking value, any base64 blob, JWT, API key or known
 * session key is reported. Findings never echo the value itself.
 */
export function auditFixture(fixture) {
  const issues = [];
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === 'string') {
      const key = path.split('.').pop() || '';
      if (/^https?:\/\//i.test(node)) {
        try {
          const url = new URL(node);
          for (const [name, value] of url.searchParams.entries()) {
            if (URL_KEEP.has(name)) continue;
            if (name === 'exp' && value === PO_MARKER) continue;
            if (value !== REDACTED) issues.push(`${path}: параметр ${name} не обезличен`);
          }
        } catch {
          issues.push(`${path}: неразбираемый URL`);
        }
        return;
      }
      if (/visitorData|authorization|bearer|cookie|session/i.test(node)) {
        issues.push(`${path}: упоминание сессии/секрета`);
      }
      if (/^eyJ[A-Za-z0-9_-]{10,}/.test(node)) issues.push(`${path}: похоже на JWT`);
      if (/AIza[0-9A-Za-z_-]{30,}/.test(node)) issues.push(`${path}: похоже на API-ключ`);
      if (!SAFE_TEXT_KEYS.has(key) && node.length >= 40 && /^[A-Za-z0-9_-]{40,}$/.test(node)) {
        issues.push(`${path}: длинный токеноподобный литерал (${node.length} символов)`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (/visitor_?data|session|authorization|cookie/i.test(key)) issues.push(`${path}.${key}: поле сессии/секрета`);
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(fixture, '');
  return issues;
}

/* ------------------------------------------------------------------ parser --- */

/** What the production parser concludes from a player response. */
export function parserVerdict(playerResponse, initialData) {
  const tracks = extractCaptionTracks(playerResponse);
  const index = (track) => (track ? tracks.indexOf(track) : -1);
  return {
    tracks: tracks.map((t) => ({
      lang: t.lang,
      auto: t.auto,
      vssId: t.vssId,
      translatable: t.isTranslatable,
      poProtected: isPoTokenProtected(t),
      hasUrl: !!t.url,
      langName: t.langName,
    })),
    picks: {
      manual: index(pickTrack(tracks, { lang: 'auto', preferManual: true })),
      auto: index(pickTrack(tracks, { lang: 'auto', preferManual: false })),
      ru: index(pickTrack(tracks, { lang: 'ru', preferManual: true })),
    },
    transcriptParams: !!extractTranscriptParams(initialData),
  };
}

export function sameVerdict(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* -------------------------------------------------------------------- cli --- */

function describeTrack(track, i) {
  const parts = [
    `${i + 1}. ${track.lang || '??'}${track.auto ? ' (авто)' : ''}`,
    track.vssId ? `vssId=${track.vssId}` : 'vssId=нет',
    track.poProtected ? 'PO-token' : 'без PO-token',
    track.hasUrl ? 'url=есть' : 'url=НЕТ',
  ];
  return parts.join('  ');
}

function analyzeReport(source, videoId) {
  const verdict = parserVerdict(source.playerResponse, source.initialData);
  const pr = source.playerResponse;
  const tracks = extractCaptionTracks(pr);
  const lines = [];
  lines.push(`источник: ${source.kind} (${source.bytes} байт)`);
  lines.push(`видео: ${videoId || 'не найден'}${pr?.videoDetails?.title ? ` · ${truncate(pr.videoDetails.title, 80)}` : ''}`);
  lines.push(`дорожек: ${tracks.length}`);
  verdict.tracks.forEach((t, i) => lines.push(`  ${describeTrack(t, i)}`));
  const po = verdict.tracks.filter((t) => t.poProtected).length;
  lines.push(`PO-token: ${po} из ${tracks.length}; ручных: ${tracks.filter((t) => !t.auto).length}, авто: ${tracks.filter((t) => t.auto).length}`);
  lines.push(
    `выбор: вручную → #${verdict.picks.manual + 1}, авто → #${verdict.picks.auto + 1}, ru → #${verdict.picks.ru + 1}`,
  );
  lines.push(`getTranscriptEndpoint.params: ${verdict.transcriptParams ? 'есть' : 'нет'}`);
  const detailKeys = Object.keys(pr?.videoDetails || {});
  lines.push(`videoDetails: ${detailKeys.length ? detailKeys.join(', ') : 'нет'}`);
  if (pr?.microformat?.playerMicroformatRenderer) lines.push('microformat: есть');
  const params = [];
  for (const track of tracks) {
    try {
      for (const name of new URL(track.url).searchParams.keys()) if (!params.includes(name)) params.push(name);
    } catch {
      /* relative url */
    }
  }
  lines.push(`параметры URL (имена): ${params.length ? params.join(', ') : 'нет'}`);
  return lines.join('\n');
}

function readFixtureDir() {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(FIXTURE_DIR, f));
}

function runStatus() {
  const files = readFixtureDir();
  console.log('уровень A (синтетические тесты): npm test — не зависит от этого файла');
  if (!files.length) {
    console.log(`уровень B (сохранённый ответ YouTube): ожидается fixture — ${join('tests', 'fixtures', 'youtube')}/*.json`);
    console.log('  как снять: MANUAL-TESTING.md → «Saved player response from YouTube (offline, level B)»');
  } else {
    let ok = 0;
    for (const file of files) {
      try {
        const fixture = JSON.parse(readFileSync(file, 'utf8'));
        const issues = auditFixture(fixture);
        if (issues.length) {
          console.log(`  ✗ ${file}: ${issues.join('; ')}`);
          continue;
        }
        const verdict = parserVerdict(fixture.playerResponse, fixture.initialData);
        console.log(
          `  ok ${file}: видео ${fixture.videoId || '—'}, дорожек ${verdict.tracks.length}, PO-token ${verdict.tracks.filter((t) => t.poProtected).length}`,
        );
        ok++;
      } catch (err) {
        console.log(`  ✗ ${file}: ${err.message}`);
      }
    }
    console.log(`уровень B: ${ok}/${files.length} fixture прошли разбор`);
  }
  console.log('уровень C (живое скачивание субтитров): не проверен — нужен сетевой доступ к youtube.com');
  return 0;
}

function runAnalyze(input) {
  const source = loadSource(input);
  console.log(analyzeReport(source, detectVideoId(source.playerResponse)));
  const { notes } = sanitizeFixture({
    playerResponse: source.playerResponse,
    initialData: source.initialData,
    videoId: detectVideoId(source.playerResponse),
  });
  const params = [...new Set(notes.urlParams)].sort();
  console.log(`при очистке будут заменены параметры: ${params.length ? params.join(', ') : 'нет'}`);
  const dropped = [...notes.droppedPlayerKeys, ...[...notes.droppedTrackKeys].map((k) => `track.${k}`)].sort();
  console.log(`будут удалены поля: ${dropped.length ? dropped.join(', ') : 'нет'}`);
  return 0;
}

function runSanitize(input, { out, capturedAt }) {
  const source = loadSource(input);
  const videoId = detectVideoId(source.playerResponse);
  const { fixture, notes } = sanitizeFixture({
    playerResponse: source.playerResponse,
    initialData: source.initialData,
    videoId,
    capturedAt,
  });
  const original = parserVerdict(source.playerResponse, source.initialData);
  const cleaned = parserVerdict(fixture.playerResponse, fixture.initialData);
  const parity = sameVerdict(original, cleaned);
  console.log(`видео: ${videoId || '—'}, дорожек: ${cleaned.tracks.length}`);
  console.log(`паритет разбора до/после очистки: ${parity ? 'OK' : 'РАСХОЖДЕНИЕ'}`);
  if (!parity) {
    console.log(`  до:     ${JSON.stringify(original)}`);
    console.log(`  после:  ${JSON.stringify(cleaned)}`);
  }
  const issues = auditFixture(fixture);
  if (issues.length) {
    console.log('очистка не прошла проверку:');
    for (const issue of issues) console.log(`  ✗ ${issue}`);
  }
  const target = out || join('dist', 'player-response-fixture.json');
  if (issues.length) {
    console.log('fixture не записан: сначала устраните находки выше (или проверьте входной файл)');
    return 1;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`fixture: ${target}`);
  console.log(`заменено параметров: ${[...new Set(notes.urlParams)].sort().join(', ') || 'нет'}`);
  console.log(`удалено полей: ${notes.droppedPlayerKeys.size + notes.droppedTrackKeys.size}`);
  if (notes.truncated.length) console.log(`обрезано: ${notes.truncated.join(', ')}`);
  console.log('напоминание: подписанные URL обезличены, скачивание по этому fixture не проверяется');
  return parity ? 0 : 1;
}

function main(argv) {
  const args = argv.slice(2);
  const command = ['analyze', 'sanitize', 'status'].includes(args[0]) ? args[0] : 'analyze';
  const rest = command === args[0] ? args.slice(1) : args;
  if (command === 'status') return runStatus();
  const input = rest.find((a) => !a.startsWith('--'));
  if (!input) {
    console.error('usage: node tools/player-response.mjs <analyze|sanitize|status> <file> [--out=path] [--captured=YYYY-MM-DD]');
    return 2;
  }
  if (!existsSync(input)) {
    console.error(`файл не найден: ${input}`);
    return 2;
  }
  const out = (rest.find((a) => a.startsWith('--out=')) || '').slice('--out='.length);
  const capturedAt = (rest.find((a) => a.startsWith('--captured=')) || '').slice('--captured='.length);
  try {
    return command === 'sanitize' ? runSanitize(input, { out, capturedAt }) : runAnalyze(input);
  } catch (err) {
    console.error(`ошибка: ${err.message}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) process.exit(main(process.argv));
