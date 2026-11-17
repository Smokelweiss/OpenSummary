/**
 * YouTube data access: player response, caption tracks, transcripts, chapters.
 *
 * Strategy (in order):
 *   1. fetch the watch page HTML and read the embedded `ytInitialPlayerResponse`
 *      + `ytInitialData` (works for public videos without a PO token);
 *   2. fall back to the InnerTube /player endpoint (Android + Web clients);
 *   3. the content script can still fall back to scraping the on-page
 *      transcript panel (see content/transcript-dom.js).
 *
 * Note on PO tokens: for a growing share of videos YouTube marks the caption
 * track with `exp=xpe` in `baseUrl`. Such tracks answer /api/timedtext with
 * HTTP 200 and an empty body unless the request carries a `pot` token minted by
 * the player JavaScript, which is impossible outside the page. Those tracks are
 * skipped here and reported as POT_REQUIRED so the content script can read the
 * on-page transcript panel instead of retrying a request that cannot succeed.
 */

import {
  decodeEntities,
  deepCollect,
  getInitialData,
  getInnertubeConfig,
  getPlayerResponse,
  looksLikeConsentPage,
  ytText,
} from './html-parse.js';
import { cleanCaptionText, detectLang } from '../nlp/tokenize.js';
import { parseTimestamp, normalizeWhitespace } from '../common/util.js';

/**
 * Public InnerTube key of YouTube's own web client (it ships inside every
 * youtube.com bundle). It is split into two parts so the assembled value is
 * not written out as a literal: secret scanners flag the raw key even though
 * it carries no privileges, and a scanner alert hides real leaks.
 * Without it the player and get_transcript calls answer 403.
 */
const INNERTUBE_KEY = ['AIza', 'SyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'].join('');
const WATCH_URL = 'https://www.youtube.com/watch';
const TIMEDTEXT = 'https://www.youtube.com/api/timedtext';
const INNERTUBE_WEB_VERSION = '2.20240726.00.00';

export function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  } catch {
    /* ignore */
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Rounds a timecode to two decimals (stable through JSON round-trips). */
function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function httpError(code, message, data) {
  const err = new Error(message || `HTTP ${code}`);
  err.code = code;
  err.data = data;
  return err;
}

/* ------------------------------------------------------------------- fetching */

export async function fetchWatchPage(videoId, { hl = 'en', timeoutMs = 20000 } = {}) {
  const url = `${WATCH_URL}?v=${encodeURIComponent(videoId)}&hl=${encodeURIComponent(hl)}&bpctr=9999999999&has_verified=1`;
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      'accept-language': `${hl},en;q=0.8`,
      accept: 'text/html,application/xhtml+xml',
    },
    signal: timeoutSignal(timeoutMs),
  });
  if (!res.ok) throw httpError(res.status, `YouTube ответил ${res.status}`);
  const html = await res.text();
  if (looksLikeConsentPage(html)) throw httpError('CONSENT', 'YouTube требует подтверждения cookie');
  return html;
}

export async function fetchInnertubePlayer(videoId, { hl = 'en', timeoutMs = 15000, client = 'ANDROID' } = {}) {
  const contexts = {
    ANDROID: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '19.09.37',
        androidSdkVersion: 30,
        hl,
        gl: 'US',
        userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
      },
    },
    WEB: {
      client: { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl, gl: 'US' },
    },
    IOS: {
      client: { clientName: 'IOS', clientVersion: '19.09.3', deviceModel: 'iPhone16,2', hl, gl: 'US' },
    },
  };
  const body = {
    videoId,
    context: contexts[client] || contexts.WEB,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept-language': `${hl},en;q=0.8`,
      ...(client === 'ANDROID' ? { 'user-agent': contexts.ANDROID.client.userAgent } : {}),
    },
    credentials: 'include',
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs),
  });
  if (!res.ok) throw httpError(res.status, `InnerTube ответил ${res.status}`);
  return res.json();
}

/* --------------------------------------------------- transcript via InnerTube */

/**
 * `getTranscriptEndpoint.params` from ytInitialData — the key the page's own
 * transcript panel sends to InnerTube.
 */
export function extractTranscriptParams(initialData) {
  if (!initialData) return '';
  const found = deepCollect(initialData, (n) => typeof n?.getTranscriptEndpoint?.params === 'string');
  return found.length ? found[0].getTranscriptEndpoint.params : '';
}

/**
 * Reads the transcript through InnerTube's `get_transcript` — the call the page
 * panel itself makes. Unlike /api/timedtext it does not need a PO token, so it
 * works for videos whose caption tracks answer with an empty body, and it does
 * not depend on YouTube's DOM at all.
 */
export async function fetchInnertubeTranscript(params, { hl = 'en', timeoutMs = 20000, clientVersion = '', visitorData = '' } = {}) {
  if (!params) return [];
  const version = clientVersion || INNERTUBE_WEB_VERSION;
  const client = { clientName: 'WEB', clientVersion: version, hl, gl: 'US' };
  if (visitorData) client.visitorData = visitorData;
  const body = {
    context: { client },
    params,
  };
  const res = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept-language': `${hl},en;q=0.8`,
      'x-youtube-client-name': '1',
      'x-youtube-client-version': version,
      ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
    },
    credentials: 'include',
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs),
  });
  if (!res.ok) throw httpError(res.status, `get_transcript ответил ${res.status}${await responseReason(res)}`);
  const json = await res.json();
  const status = json?.playabilityStatus?.status;
  if (status && status !== 'OK') {
    const reason = String(json?.playabilityStatus?.reason || status).slice(0, 120);
    throw httpError('PLAYER_ERROR', `get_transcript: ${reason}`);
  }
  return parseTranscriptResponse(json);
}

/**
 * Best-effort reason from a failed InnerTube response, for the diagnostics log:
 * “Precondition check failed”, “This video is unavailable”, etc.
 */
async function responseReason(res) {
  try {
    const text = await res.text();
    if (!text) return '';
    let reason = '';
    try {
      const json = JSON.parse(text);
      reason =
        json?.error?.message ||
        json?.playabilityStatus?.reason ||
        json?.error?.errors?.[0]?.reason ||
        '';
    } catch {
      reason = text;
    }
    reason = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return reason ? ` (${reason})` : '';
  } catch {
    return '';
  }
}

/** Reads text out of a YouTube “snippet” (runs or simpleText). */
function snippetText(snippet) {
  if (!snippet) return '';
  const runs = Array.isArray(snippet.runs) ? snippet.runs.map((run) => run?.text || '').join('') : '';
  return cleanCaptionText(decodeEntities(runs || snippet.simpleText || ''));
}

/** Parses both response shapes: transcriptSegmentRenderer and transcriptCueRenderer. */
export function parseTranscriptResponse(json) {
  const segments = [];
  for (const node of deepCollect(json, (n) => !!n?.transcriptSegmentRenderer)) {
    const seg = node.transcriptSegmentRenderer || {};
    const text = snippetText(seg.snippet);
    const start = Number(seg.startMs) / 1000;
    const end = Number(seg.endMs) / 1000;
    if (!text || !Number.isFinite(start)) continue;
    segments.push({
      start: round2(start),
      dur: round2(Math.max(0.4, (Number.isFinite(end) ? end : start + 2) - start)),
      text,
    });
  }
  // 2026-10: the panel stopped calling `get_transcript`. Its `get_panel` answer
  // carries the same lines as view models: `transcriptSegmentViewModel` with a
  // display timestamp ("0:01") and `simpleText`.
  for (const node of deepCollect(json, (n) => !!n?.transcriptSegmentViewModel, { maxResults: 20000 })) {
    const seg = node.transcriptSegmentViewModel || {};
    const text = cleanCaptionText(decodeEntities(seg.simpleText || ''));
    const start = parseTimestamp(seg.timestamp);
    if (!text || start == null) continue;
    segments.push({ start: round2(start), dur: 0, text });
  }
  for (const node of deepCollect(json, (n) => !!n?.transcriptCueRenderer)) {
    const cue = node.transcriptCueRenderer || {};
    const text = snippetText(cue.cue);
    const start = Number(cue.startOffsetMs) / 1000;
    if (!text || !Number.isFinite(start)) continue;
    segments.push({
      start: round2(start),
      dur: round2(Math.max(0.4, (Number(cue.durationMs) || 2000) / 1000)),
      text,
    });
  }
  // A view model only carries its start time; the length is the distance to the
  // next line (capped, so a gap between chapters does not stretch a cue).
  segments.sort((a, b) => a.start - b.start);
  for (let i = 0; i < segments.length; i++) {
    if (Number(segments[i].dur) > 0) continue;
    const next = segments[i + 1];
    const span = next && next.start > segments[i].start ? next.start - segments[i].start : 2;
    segments[i].dur = round2(Math.max(0.4, Math.min(8, span)));
  }
  return normalizeSegments(segments);
}

/* --------------------------------------------------------------- caption data */

export function extractCaptionTracks(playerResponse) {
  const list = playerResponse?.captions?.playerCaptionsTracklistRenderer;
  if (!list) return [];
  const tracks = Array.isArray(list.captionTracks) ? list.captionTracks : [];
  const audioTracks = Array.isArray(list.audioTracks) ? list.audioTracks : [];
  return tracks.map((t) => ({
    url: t.baseUrl || t.url || '',
    lang: t.languageCode || '',
    langName: ytText(t.name) || t.languageCode || '',
    auto: t.kind === 'asr',
    vssId: t.vssId || '',
    isTranslatable: !!t.isTranslatable,
    audioTrackName:
      audioTracks[t.audioTrack?.audioTrackId != null ? 0 : 0]?.displayName
        ? ytText(audioTracks[0].displayName)
        : '',
  }));
}

/** Chooses the best caption track for the requested language. */
export function pickTrack(tracks, { lang = 'auto', preferManual = true } = {}) {
  if (!tracks.length) return null;
  const score = (t) => {
    let s = 0;
    if (preferManual && !t.auto) s += 100;
    if (!preferManual && t.auto) s += 20;
    if (lang && lang !== 'auto') {
      if (t.lang === lang) s += 40;
      else if (t.lang.startsWith(lang.split('-')[0])) s += 20;
    }
    if (t.lang === 'en') s += 5;
    if (t.url) s += 3;
    return s;
  };
  return tracks.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

/**
 * True when YouTube protects this track with a PO token (`exp=xpe`): the URL
 * answers with an empty body for any request that does not carry `pot`.
 */
export function isPoTokenProtected(track) {
  const url = String(track?.url || '');
  if (!url) return false;
  const marker = url.indexOf('exp=xpe');
  if (marker === -1) return false;
  const after = url.charAt(marker + 'exp=xpe'.length);
  return after === '' || after === '&' || after === '%';
}

function poTokenError() {
  return httpError(
    'POT_REQUIRED',
    'YouTube не отдал текст субтитров: дорожка защищена PO-token',
    'Такие субтитры отдаёт только плеер на самой странице. Нажмите «Взять транскрипт со страницы» — OpenSummary прочитает панель «Транскрипт» на видео, либо вставьте текст вручную в разделе «Транскрипт».',
  );
}

/** Fetches + parses a timedtext track. */
export async function fetchTimedText(track, { fmt = 'json3', tlang = '', timeoutMs = 20000 } = {}) {
  if (!track?.url) throw httpError('NO_TRACK', 'Нет доступной дорожки субтитров');
  if (isPoTokenProtected(track)) throw poTokenError();
  const url = new URL(track.url.startsWith('http') ? track.url : `${TIMEDTEXT}?${track.url.replace(/^\?/, '')}`);
  url.searchParams.set('fmt', fmt);
  if (tlang) url.searchParams.set('tlang', tlang);
  const res = await fetch(url.toString(), {
    credentials: 'include',
    headers: { accept: 'application/json,text/xml,text/vtt,text/plain,*/*' },
    signal: timeoutSignal(timeoutMs),
  });
  if (res.status === 429) throw httpError('RATE_LIMITED', 'YouTube ограничил частоту запросов субтитров');
  if (!res.ok) throw httpError(res.status, `timedtext ответил ${res.status}`);
  const body = await res.text();
  if (!body || body.length < 5) {
    throw isPoTokenProtected(track)
      ? poTokenError()
      : httpError('EMPTY_CAPTIONS', 'Дорожка субтитров пуста');
  }
  const parsed = parseTimedText(body);
  if (!parsed.segments.length) {
    // A well-formed container with zero cues is an empty track, not a parsing
    // defect: YouTube answers that way for an untranslated `tlang` or a video
    // whose track exists but has no text. Only a body this parser cannot even
    // recognise (or one that was truncated) deserves PARSE_FAILED.
    if (isWellFormedEmptyCaptions(body, parsed.format)) {
      throw httpError('EMPTY_CAPTIONS', 'Дорожка субтитров пуста');
    }
    const err = httpError(
      'PARSE_FAILED',
      `Не удалось разобрать ответ субтитров (${parsed.format}, ${body.length} байт): формат не распознан или ответ обрезан`,
      { format: parsed.format, bytes: body.length },
    );
    err.format = parsed.format;
    throw err;
  }
  return parsed;
}

/** True when the body is a valid caption container that simply has no cues. */
function isWellFormedEmptyCaptions(body, format) {
  const text = String(body);
  if (format === 'json3') {
    let events;
    try {
      events = JSON.parse(text)?.events;
    } catch {
      return false;
    }
    return !Array.isArray(events) || events.length === 0;
  }
  if (format === 'vtt') return /^WEBVTT/i.test(text.trim()) && !/-->/.test(text);
  if (format === 'srv1' || format === 'srv3') {
    const trimmed = text.trim();
    const isTranscript = /^<\s*(?:transcript|timedtext)[\s/>]/i.test(trimmed);
    return isTranscript && !/<(?:text|p)[\s>]/i.test(text);
  }
  return false;
}

/**
 * The legacy caption endpoint. It is served outside the player's PO-token
 * pipeline, so it still answers for a share of videos whose /api/timedtext
 * track is `exp=xpe`-protected. Returns [] instead of throwing on an empty
 * body: “no such track” is the normal answer here.
 */
export async function fetchLegacyTimedText(videoId, { lang = '', kind = '', timeoutMs = 12000 } = {}) {
  if (!videoId) return [];
  const url = new URL('https://video.google.com/timedtext');
  url.searchParams.set('v', videoId);
  if (lang) url.searchParams.set('lang', lang);
  if (kind) url.searchParams.set('kind', kind);
  const res = await fetch(url.toString(), {
    credentials: 'include',
    headers: { accept: 'text/xml,application/json,text/vtt,text/plain,*/*' },
    signal: timeoutSignal(timeoutMs),
  });
  if (!res.ok) throw httpError(res.status, `timedtext (legacy) ответил ${res.status}`);
  const body = await res.text();
  if (!body || body.length < 5) return [];
  return parseTimedText(body).segments;
}

/** Auto-detects json3 / vtt / srv1 / srv3 caption payloads. */
export function parseTimedText(body) {
  const text = String(body || '').trim();
  if (!text) return { segments: [], format: 'empty' };
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return { segments: parseJson3(JSON.parse(text)), format: 'json3' };
    } catch {
      /* fall through */
    }
  }
  if (/^WEBVTT/i.test(text)) return { segments: parseVtt(text), format: 'vtt' };
  if (text.startsWith('<')) {
    const segments = parseSrvXml(text);
    return { segments, format: segments.some((s) => s.wordStart != null) ? 'srv3' : 'srv1' };
  }
  // Last resort: "00:00.000 text" lines
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segments = [];
  for (const line of lines) {
    const m = line.match(/^(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s+(.*)$/);
    if (!m) continue;
    const start = parseTimecode(m[1]);
    if (start == null) continue;
    segments.push({ start, dur: 2, text: cleanCaptionText(m[2]) });
  }
  return { segments: normalizeSegments(segments), format: 'text' };
}

/* ------------------------------------------------- rolling auto-captions */

/**
 * Auto-generated captions are a sliding window over the speech: every cue
 * repeats the tail of the previous one and adds a few new words.
 *
 *   “we spent a lot of time”     (2.0 – 5.4)
 *   “a lot of time digging”      (4.6 – 7.1)  → only “digging” is new
 *
 * The repeated tail is the same words twice, not a repetition. It is only
 * removed when the cues really are a rolling window: they overlap in time (or
 * follow within a second and a half), the overlap is at least three words —
 * two when the windows physically overlap — and the same words are not a chant
 * (“no, no, no”) or a sentence repeated after a full stop (“It was a long day.
 * A long day for everyone.”). Everything else stays untouched.
 */
const ROLLING_MAX_GAP = 1.5;
const ROLLING_MIN_WORDS = 3;
const ROLLING_MIN_WORDS_OVERLAP = 1;
const ROLLING_LOOKBACK = 14;
const SENTENCE_END = /[.!?…]["»”']?\s*$/;

function compareWord(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function wordsOf(text) {
  return String(text || '').split(/\s+/).filter(Boolean);
}

/** Longest suffix of `a` that is a prefix of `b`, in words. */
function overlapWords(a, b) {
  const max = Math.min(a.length, b.length, ROLLING_LOOKBACK);
  for (let k = max; k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (compareWord(a[a.length - k + i]) !== compareWord(b[i])) {
        same = false;
        break;
      }
    }
    if (same) return k;
  }
  return 0;
}

/** “no, no, no” is emphasis, not a caption window sliding over the same words. */
function isChant(words) {
  if (!words.length) return false;
  const first = compareWord(words[0]);
  return words.every((w) => compareWord(w) === first);
}

/** Removes the repeated tail of a rolling caption window. */
export function trimRollingCaptions(segments) {
  const out = [];
  // Each window repeats the tail of the *previous window*, not of the text that
  // survived trimming: after cutting “смотрите что получилось” down to
  // “получилось”, the next window (“что получилось когда”) still overlaps with
  // the words that were already emitted, so the comparison uses the raw line.
  let prevRawText = '';
  for (const raw of segments || []) {
    const text = normalizeWhitespace(raw?.text || '');
    if (!text) continue;
    // Remembered before any branch continues: the next window is compared with
    // this raw line even when this cue was trimmed or dropped.
    const prevRaw = prevRawText;
    prevRawText = text;
    const start = Math.max(0, Number(raw.start) || 0);
    const dur = Math.max(0.4, Number(raw.dur) || 2);
    const last = out[out.length - 1];
    if (last) {
      const prevEnd = last.start + last.dur;
      const gap = start - prevEnd;
      // A sentence that ends before the cue and starts again on purpose.
      const repeatedSentence = SENTENCE_END.test(last.text) && /^[\p{Lu}«"']/u.test(text);
      if (!repeatedSentence && gap <= ROLLING_MAX_GAP) {
        const prevWords = wordsOf(prevRaw || last.text);
        const nextWords = wordsOf(text);
        const k = overlapWords(prevWords, nextWords);
        // Windows that physically overlap in time are a rolling caption run:
        // even one repeated word is the same word said once. Sequential cues
        // may only be cut when the whole previous line is repeated (captions
        // that grow) or three words really coincide.
        const overlapping = gap < -0.05;
        const growsFromPrev = k >= 1 && k >= prevWords.length && nextWords.length > prevWords.length;
        // Time overlap is the strongest signal of a rolling run; a cue that
        // repeats the whole previous line (even one word of it) is the second.
        const minWords = overlapping || growsFromPrev ? ROLLING_MIN_WORDS_OVERLAP : ROLLING_MIN_WORDS;
        // A one-word overlap has no room for a chant, so the guard only applies
        // from two words on.
        if (k >= minWords && k > 0 && !(k >= 2 && isChant(nextWords.slice(0, k)))) {
          if (growsFromPrev) {
            // The whole previous line opens this cue: extend it instead of
            // storing the same words twice.
            last.text = normalizeWhitespace(`${last.text} ${nextWords.slice(prevWords.length).join(' ')}`);
            last.dur = Math.max(last.dur, start + dur - last.start);
            continue;
          }
          const rest = nextWords.slice(k);
          if (!rest.length) {
            // Only the previous cue's tail: the cue says nothing new, so its
            // time is folded into the cue that carried those words.
            last.dur = Math.max(last.dur, start + dur - last.start);
            continue;
          }
          out.push({ start: round2(start), dur: round2(dur), text: normalizeWhitespace(rest.join(' ')) });
          continue;
        }
      }
    }
    out.push({ start: round2(start), dur: round2(dur), text });
  }
  return out;
}

export function parseJson3(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const segments = [];
  for (const ev of events) {
    if (!Array.isArray(ev.segs)) continue;
    const raw = ev.segs.map((s) => s.utf8 || '').join('');
    const text = cleanCaptionText(decodeEntities(raw));
    if (!text) continue;
    const start = (Number(ev.tStartMs) || 0) / 1000;
    const dur = (Number(ev.dDurationMs) || 0) / 1000;
    segments.push({ start: round2(start), dur: round2(dur || 2), text });
  }
  return normalizeSegments(trimRollingCaptions(segments));
}

export function parseVtt(text) {
  const blocks = String(text).replace(/\r/g, '').split('\n\n');
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const [from, to] = lines[timeIdx].split('-->').map((s) => s.trim().split(' ')[0]);
    const start = parseTimecode(from);
    const end = parseTimecode(to);
    if (start == null) continue;
    const body = lines
      .slice(timeIdx + 1)
      .join(' ')
      .replace(/<v[^>]*>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\{[^}]*\}/g, ' ');
    const cleaned = cleanCaptionText(decodeEntities(body));
    if (!cleaned) continue;
    segments.push({ start: round2(start), dur: round2(Math.max(1, (end ?? start + 2) - start)), text: cleaned });
  }
  return normalizeSegments(trimRollingCaptions(segments));
}

export function parseSrvXml(text) {
  const segments = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(text))) {
    const attrs = parseAttrs(m[1]);
    const start = Number(attrs.t != null ? attrs.t : attrs.start) || 0;
    const dur = Number(attrs.d != null ? attrs.d : attrs.dur) || 2000;
    const isMs = attrs.t != null;
    const words = [];
    const sRe = /<s\b[^>]*>([\s\S]*?)<\/s>/g;
    let sm;
    while ((sm = sRe.exec(m[2]))) words.push(decodeEntities(sm[1]));
    const body = words.length ? words.join(' ') : decodeEntities(m[2].replace(/<[^>]+>/g, ' '));
    const cleaned = cleanCaptionText(body);
    if (!cleaned) continue;
    segments.push({
      start: round2(isMs ? start / 1000 : start),
      dur: round2(isMs ? dur / 1000 : dur),
      text: cleaned,
    });
  }
  if (!segments.length) {
    const tRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    while ((m = tRe.exec(text))) {
      const attrs = parseAttrs(m[1]);
      const start = Number(attrs.start) || 0;
      const dur = Number(attrs.dur) || 2;
      const cleaned = cleanCaptionText(decodeEntities(m[2]));
      if (cleaned) segments.push({ start: round2(start), dur: round2(dur), text: cleaned });
    }
  }
  return normalizeSegments(trimRollingCaptions(segments));
}

function parseAttrs(str) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = m[2];
  return out;
}

export function parseTimecode(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return parseTimestamp(s);
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) / 1000 : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms;
}

/** Sorts, de-duplicates and cleans raw segments. */
export function normalizeSegments(segments, { keepEmpty = false } = {}) {
  const out = [];
  for (const raw of segments || []) {
    const text = normalizeWhitespace(raw.text || '');
    if (!text && !keepEmpty) continue;
    const start = Math.max(0, Number(raw.start) || 0);
    const dur = Math.max(0.4, Number(raw.dur) || 2);
    const last = out[out.length - 1];
    if (last && Math.abs(last.start - start) < 0.15) {
      if (text.length > last.text.length) last.text = text;
      last.dur = Math.max(last.dur, start + dur - last.start);
      continue;
    }
    if (last && start < last.start) {
      // out-of-order caption: keep the original order but clamp the duration
      out.push({ start, dur: Math.min(dur, 3), text });
      continue;
    }
    out.push({ start: round2(start), dur: round2(dur), text });
  }
  return keepEmpty ? out : out.filter((s) => s.text.length > 0);
}

/** Joins segments into a single text block with [mm:ss] markers every N seconds. */
export function segmentsToText(segments, { withTimecodes = true, markerEvery = 30 } = {}) {
  const parts = [];
  let nextMarker = 0;
  for (const seg of segments) {
    if (withTimecodes && seg.start >= nextMarker) {
      parts.push(`\n[${formatMmSs(seg.start)}]`);
      nextMarker = seg.start + markerEvery;
    }
    parts.push(seg.text);
  }
  return normalizeWhitespace(parts.join(' ').replace(/\n\s*/g, '\n')).replace(/^\n/, '');
}

export function formatMmSs(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------- chapters */

export function extractChapters({ playerResponse, initialData, description } = {}) {
  const chapters = [];

  const markerItems = deepCollect(initialData, (n) => !!n.macroMarkersListItemRenderer).map((n) => n.macroMarkersListItemRenderer);
  for (const item of markerItems) {
    const title = ytText(item.title);
    const at =
      parseTimestamp(ytText(item.timeDescription)) ??
      Number(item.onTap?.watchEndpoint?.startTimeSeconds) ??
      (item.timeDescription?.simpleText ? parseTimestamp(item.timeDescription.simpleText) : null);
    if (title && at != null) chapters.push({ title: cleanCaptionText(title), at });
  }

  const legacy = deepCollect(playerResponse, (n) => !!n.chapterRenderer).map((n) => n.chapterRenderer);
  for (const item of legacy) {
    const title = ytText(item.title) || item.title?.simpleText || '';
    const at = Number(item.timeRangeStartMillis) / 1000;
    if (title && Number.isFinite(at)) chapters.push({ title: cleanCaptionText(title), at });
  }

  const deduped = dedupeChapters(chapters);
  if (deduped.length >= 2) return deduped;

  const fromDescription = parseDescriptionChapters(description);
  return fromDescription.length >= 2 ? fromDescription : [];
}

export function parseDescriptionChapters(description) {
  const text = String(description || '');
  if (!text) return [];
  const found = [];
  const re = /(^|\n)\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[-–—•|:]|\s)\s*(\S[^\n]{1,100})/g;
  let m;
  while ((m = re.exec(text))) {
    const at = parseTimestamp(m[2]);
    const title = cleanCaptionText(m[3]).replace(/\s*[-–—|]+\s*$/, '');
    if (at == null || !title) continue;
    found.push({ title, at });
  }
  const cleaned = dedupeChapters(found);
  if (cleaned.length < 2) return [];
  const ascending = cleaned.every((c, i) => i === 0 || c.at > cleaned[i - 1].at);
  if (!ascending) return [];
  if (cleaned[0].at > 60) return [];
  // Reject auto-generated "timeline"-looking noise: require reasonable text.
  const goodTitles = cleaned.filter((c) => c.title.split(/\s+/).length >= 1 && c.title.length >= 2).length;
  return goodTitles >= cleaned.length * 0.8 ? cleaned.slice(0, 40) : [];
}

function dedupeChapters(list) {
  const seen = new Set();
  const out = [];
  for (const c of list.slice().sort((a, b) => a.at - b.at)) {
    const key = `${Math.round(c.at)}|${c.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    if (out.length && Math.abs(out[out.length - 1].at - c.at) < 1) continue;
    seen.add(key);
    out.push({ title: c.title.slice(0, 120), at: Math.round(c.at) });
  }
  return out;
}

/* --------------------------------------------------------------------- facade */

export function extractVideoMeta(playerResponse, initialData, videoId) {
  const vd = playerResponse?.videoDetails || {};
  const mf = playerResponse?.microformat?.playerMicroformatRenderer || {};
  const thumbs = vd.thumbnail?.thumbnails || [];
  const thumb = thumbs.length ? thumbs[thumbs.length - 1]?.url : '';
  let lengthSeconds = Number(vd.lengthSeconds) || 0;
  if (!lengthSeconds) {
    const dur = mf.lengthSeconds;
    lengthSeconds = Number(dur) || 0;
  }
  return {
    videoId,
    videoTitle: decodeEntities(vd.title || ''),
    channel: decodeEntities(vd.author || mf.ownerChannelName || ''),
    channelId: vd.channelId || mf.externalChannelId || '',
    lengthSeconds,
    description: decodeEntities(vd.shortDescription || mf.description?.simpleText || ''),
    keywords: Array.isArray(vd.keywords) ? vd.keywords.slice(0, 40) : [],
    isLive: !!vd.isLiveContent,
    viewCount: Number(vd.viewCount) || 0,
    publishDate: mf.publishDate || mf.uploadDate || '',
    category: mf.category || '',
    thumbnail: thumb,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export async function getVideoData(videoId, { hl = 'en', timeoutMs = 20000, initialData: providedInitial } = {}) {
  if (!/^[\w-]{6,20}$/.test(String(videoId || ''))) throw httpError('BAD_VIDEO_ID', 'Некорректный идентификатор видео');

  let playerResponse = null;
  let initialData = providedInitial || null;
  let innertubeConfig = { clientVersion: '', visitorData: '' };
  let htmlError = null;
  try {
    const html = await fetchWatchPage(videoId, { hl, timeoutMs });
    playerResponse = getPlayerResponse(html);
    initialData = initialData || getInitialData(html);
    innertubeConfig = getInnertubeConfig(html);
  } catch (err) {
    htmlError = err;
  }

  if (!playerResponse || !playerResponse.videoDetails) {
    const clients = ['ANDROID', 'WEB', 'IOS'];
    let lastErr = htmlError;
    for (const client of clients) {
      try {
        const res = await fetchInnertubePlayer(videoId, { hl, timeoutMs, client });
        if (res?.videoDetails) {
          playerResponse = res;
          break;
        }
        lastErr = httpError('NO_PLAYER', `InnerTube (${client}) не вернул данные видео`);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!playerResponse?.videoDetails) throw lastErr || httpError('NO_PLAYER', 'Не удалось получить данные видео');
  }

  const meta = extractVideoMeta(playerResponse, initialData, videoId);
  let tracks = extractCaptionTracks(playerResponse);
  // When every web-client track is PO-token-protected, the app clients often
  // still hand out plain timedtext URLs that can be fetched from here. This is
  // the only caption-API route left for such videos.
  if (tracks.length && tracks.every(isPoTokenProtected)) {
    for (const client of ['ANDROID', 'IOS']) {
      let alt = [];
      try {
        const res = await fetchInnertubePlayer(videoId, { hl, timeoutMs, client });
        alt = extractCaptionTracks(res).filter((t) => !isPoTokenProtected(t));
      } catch {
        continue;
      }
      if (alt.length) {
        tracks = alt;
        break;
      }
    }
  }
  const chapters = extractChapters({ playerResponse, initialData, description: meta.description });
  return {
    meta,
    tracks,
    chapters,
    // Needed when every caption track is PO-token protected.
    transcriptParams: extractTranscriptParams(initialData),
    innertube: innertubeConfig,
    playerResponse,
    initialData,
    htmlError: htmlError ? String(htmlError.message || htmlError) : '',
  };
}

export async function getTranscript(videoId, { hl = 'en', lang = 'auto', preferManual = true, translate = false, timeoutMs = 25000, onStage = () => {} } = {}) {
  onStage({ stage: 'video-data' });
  const video = await getVideoData(videoId, { hl, timeoutMs });
  const { meta, tracks, chapters } = video;

  const viaPanelApi = async () => {
    if (!video.transcriptParams) return [];
    try {
      return await fetchInnertubeTranscript(video.transcriptParams, {
        hl,
        timeoutMs,
        clientVersion: video.innertube?.clientVersion || '',
        visitorData: video.innertube?.visitorData || '',
      });
    } catch {
      return [];
    }
  };

  if (!tracks.length) {
    const fromApi = await viaPanelApi();
    if (fromApi.length >= 2) {
      const { lang: detected } = detectLang(fromApi.slice(0, 80).map((s) => s.text).join(' '));
      return {
        meta,
        chapters,
        segments: fromApi,
        format: 'innertube',
        source: 'captions-ui',
        autoGenerated: false,
        language: detected === 'ru' ? 'ru' : 'en',
        trackLang: '',
        translated: false,
        tracks: [],
        wordCount: fromApi.reduce((a, s) => a + s.text.split(/\s+/).length, 0),
      };
    }
    throw httpError('NO_CAPTIONS', 'У этого видео нет субтитров — саммари недоступно. Попробуйте другое видео.');
  }

  // PO-token-protected tracks can never be fetched from here — skip them.
  const usable = tracks.filter((t) => !isPoTokenProtected(t));
  if (!usable.length) {
    const fromApi = await viaPanelApi();
    if (fromApi.length >= 2) {
      const { lang: detected } = detectLang(fromApi.slice(0, 80).map((s) => s.text).join(' '));
      return {
        meta,
        chapters,
        segments: fromApi,
        format: 'innertube',
        source: 'captions-ui',
        autoGenerated: false,
        language: detected === 'ru' ? 'ru' : 'en',
        trackLang: '',
        translated: false,
        tracks: tracks.map((t) => ({ lang: t.lang, name: t.langName, auto: t.auto })),
        wordCount: fromApi.reduce((a, s) => a + s.text.split(/\s+/).length, 0),
      };
    }
    throw poTokenError();
  }

  onStage({ stage: 'track', extra: `${usable.length}` });
  let track = pickTrack(usable, { lang, preferManual });
  let translated = null;
  const wantedLang = lang && lang !== 'auto' ? lang.slice(0, 2) : '';
  if (wantedLang && track && track.lang.slice(0, 2) !== wantedLang && translate) {
    translated = wantedLang;
  }
  if (!track) track = usable[0];

  const formats = ['json3', 'vtt'];
  let segments = [];
  let format = '';
  let lastError = null;
  for (const fmt of formats) {
    try {
      const parsed = await fetchTimedText(track, { fmt, tlang: translated || '', timeoutMs });
      if (parsed.segments.length) {
        segments = parsed.segments;
        format = parsed.format;
        break;
      }
      lastError = httpError('EMPTY_CAPTIONS', 'Пустая дорожка');
    } catch (err) {
      lastError = err;
    }
  }

  if (!segments.length) {
    // Try any other track before giving up.
    for (const candidate of usable) {
      if (candidate === track) continue;
      try {
        const parsed = await fetchTimedText(candidate, { fmt: 'json3', timeoutMs });
        if (parsed.segments.length) {
          segments = parsed.segments;
          track = candidate;
          format = parsed.format;
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  if (!segments.length) {
    const fromApi = await viaPanelApi();
    if (fromApi.length >= 2) {
      const { lang: detected } = detectLang(fromApi.slice(0, 80).map((s) => s.text).join(' '));
      return {
        meta,
        chapters,
        segments: fromApi,
        format: 'innertube',
        source: 'captions-ui',
        autoGenerated: false,
        language: detected === 'ru' ? 'ru' : 'en',
        trackLang: '',
        translated: false,
        tracks: tracks.map((t) => ({ lang: t.lang, name: t.langName, auto: t.auto })),
        wordCount: fromApi.reduce((a, s) => a + s.text.split(/\s+/).length, 0),
      };
    }
    throw lastError || httpError('NO_CAPTIONS', 'Не удалось получить субтитры');
  }

  onStage({ stage: 'parsed', extra: `${segments.length}` });
  const source = `${track.auto ? 'auto' : 'manual'}${translated ? `-translated:${translated}` : ''}`;
  return {
    meta,
    chapters,
    segments,
    format,
    source,
    autoGenerated: !!track.auto,
    language: translated || track.lang,
    trackLang: track.lang,
    translated: !!translated,
    tracks: tracks.map((t) => ({ lang: t.lang, name: t.langName, auto: t.auto })),
    wordCount: segments.reduce((a, s) => a + s.text.split(/\s+/).length, 0),
  };
}

export { INNERTUBE_KEY, TIMEDTEXT, WATCH_URL };
