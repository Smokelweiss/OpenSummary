/**
 * Level A — synthetic player responses: the sanitizer keeps exactly the fields
 * the parsers read, removes everything signed, and the parse result does not
 * change between the original and the fixture.
 * Level B — a real captured `ytInitialPlayerResponse` in tests/fixtures/youtube.
 * Until such a file exists level B reports "ожидается fixture" and asserts
 * nothing; synthetic data must never be presented as a real-data check.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, assert, assertEqual } from './helpers.mjs';
import {
  auditFixture,
  detectVideoId,
  loadSource,
  parserVerdict,
  sameVerdict,
  sanitizeFixture,
  sanitizeUrl,
} from '../tools/player-response.mjs';
import { extractCaptionTracks, extractTranscriptParams, isPoTokenProtected, pickTrack } from '../src/transcript/youtube.js';

const VIDEO_ID = 'dQw4w9WgXcQ';
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'youtube');

const PLAYER = {
  playabilityStatus: { status: 'OK' },
  videoDetails: {
    videoId: VIDEO_ID,
    title: 'Synthetic test video',
    author: 'Channel',
    channelId: 'UC123',
    lengthSeconds: '212',
    viewCount: '1000',
    isLiveContent: false,
    keywords: ['cache', 'testing'],
    shortDescription: 'Описание\n0:00 Вступление\n1:30 Основная часть',
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/x/hq.jpg', width: 480 }] },
    trackingParams: 'CAAQ',
  },
  microformat: {
    playerMicroformatRenderer: {
      lengthSeconds: '212',
      publishDate: '2009-10-25',
      ownerChannelName: 'Channel',
      externalChannelId: 'UC123',
      category: 'Education',
    },
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&kind=asr&exp=xpe&pot=SECRETPOT123&potc=SECRETPOTC&signature=LONGSIGNATUREVALUE1234567890&ei=SECRETEI123&ip=1.2.3.4`,
          languageCode: 'en',
          kind: 'asr',
          vssId: 'a.en',
          isTranslatable: true,
          name: { simpleText: 'English (auto)' },
          trackingParams: 'CBQ',
        },
        {
          baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=ru&signature=RUSIG987654321&exp=1799999999`,
          languageCode: 'ru',
          vssId: '.ru',
          isTranslatable: false,
          name: { simpleText: 'Русский' },
        },
        {
          baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=de`,
          languageCode: 'de',
          vssId: '.de',
          isTranslatable: true,
          name: { simpleText: 'Deutsch' },
        },
      ],
      audioTracks: [{ audioTrackId: 'en-US', displayName: 'English (US)' }],
      defaultAudioTrackIndex: 0,
    },
  },
  playbackTracking: { videostatsPlaybackUrl: { baseUrl: 'https://s.youtube.com/api/stats/playback?cpn=SECRETCPN' } },
  playerConfig: { assets: { js: 'https://www.youtube.com/s/player/x/base.js' } },
};

const INITIAL_DATA = {
  contents: {
    padding: 'x'.repeat(240),
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: {
            transcriptRenderer: { content: { getTranscriptEndpoint: { params: 'Cg0KC2RRdzR3OVdnWGNR' } } },
          },
        },
      },
    ],
  },
};

function syntheticHtml() {
  return [
    '<html><body>',
    `<script>var ytInitialPlayerResponse = ${JSON.stringify(PLAYER)};</script>`,
    `<script>var ytInitialData = ${JSON.stringify(INITIAL_DATA)};</script>`,
    '<script>var ytcfg = {"INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20241010.00.00","visitorData":"CgtTRUNSRVZJU0lU"};</script>',
    '</body></html>',
  ].join('');
}

function withTempFiles(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'osum-fixture-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sanitized() {
  return sanitizeFixture({
    playerResponse: PLAYER,
    initialData: INITIAL_DATA,
    videoId: VIDEO_ID,
    capturedAt: '2026-10-21',
  }).fixture;
}

describe('player response fixture (level A: synthetic)', () => {
  it('reads the blobs out of a saved watch page', () => {
    withTempFiles((dir) => {
      const file = join(dir, 'watch.html');
      writeFileSync(file, syntheticHtml(), 'utf8');
      const source = loadSource(file);
      assertEqual(source.kind, 'html');
      assertEqual(detectVideoId(source.playerResponse), VIDEO_ID);
      assertEqual(extractCaptionTracks(source.playerResponse).length, 3);
      assertEqual(extractTranscriptParams(source.initialData), 'Cg0KC2RRdzR3OVdnWGNR');
    });
  });

  it('reads a bare JSON capture as well', () => {
    withTempFiles((dir) => {
      const file = join(dir, 'player.json');
      writeFileSync(file, JSON.stringify({ ytInitialPlayerResponse: PLAYER, ytInitialData: INITIAL_DATA }), 'utf8');
      const source = loadSource(file);
      assertEqual(source.kind, 'json');
      assertEqual(extractCaptionTracks(source.playerResponse).length, 3);
    });
  });

  it('replaces signed URL values but keeps the PO-token marker', () => {
    const redacted = [];
    const url = sanitizeUrl(PLAYER.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl, redacted);
    const parsed = new URL(url);
    assertEqual(parsed.searchParams.get('exp'), 'xpe', 'the PO marker must survive, otherwise the parser cannot be tested');
    assertEqual(parsed.searchParams.get('v'), VIDEO_ID, 'the video id is not a secret');
    assertEqual(parsed.searchParams.get('lang'), 'en');
    for (const name of ['pot', 'potc', 'signature', 'ei', 'ip']) {
      assertEqual(parsed.searchParams.get(name), 'REDACTED', `${name} must be redacted`);
    }
    assert(!url.includes('SECRETPOT123') && !url.includes('LONGSIGNATUREVALUE'), 'no token value may survive');

    const expOnly = new URL(sanitizeUrl(`https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&exp=1799999999`));
    assertEqual(expOnly.searchParams.get('exp'), 'REDACTED', 'an expiry timestamp is not a PO marker');
  });

  it('drops the fields the parser never reads and audits clean', () => {
    const fixture = sanitized();
    assertEqual(fixture.videoId, VIDEO_ID);
    assertEqual(fixture.redaction.transcriptParams, 'placeholder');
    assertEqual(extractTranscriptParams(fixture.initialData), 'PLACEHOLDER_TRANSCRIPT_PARAMS');
    assert(!JSON.stringify(fixture).includes('SECRET'), 'no synthetic secret may survive');
    assert(!JSON.stringify(fixture).includes('visitorData'), 'visitor ids must not be copied');
    assert(fixture.playerResponse.videoDetails.thumbnail, 'the thumbnail is public and read by extractVideoMeta');
    assertDeepEqualSorted(auditFixture(fixture), [], 'a sanitized fixture must pass its own audit');
  });

  it('keeps the parser verdict identical before and after sanitizing', () => {
    const original = parserVerdict(PLAYER, INITIAL_DATA);
    const cleaned = parserVerdict(sanitized().playerResponse, sanitized().initialData);
    assertEqual(original.tracks.length, 3);
    assertEqual(original.tracks[0].poProtected, true, 'exp=xpe must read as PO-protected');
    assertEqual(original.tracks[1].poProtected, false);
    assertEqual(original.picks.manual, 1, 'the manual Russian track wins for lang=auto');
    assertEqual(original.picks.auto, 0, 'preferManual:false picks the ASR track');
    assertEqual(original.picks.ru, 1, 'lang=ru picks the Russian track');
    assert(sameVerdict(original, cleaned), 'sanitizing must not change track selection');
    assertEqual(cleaned.transcriptParams, true, 'the pruned path still yields transcript params');
  });

  it('refuses a fixture that still carries a live-looking URL', () => {
    const leaky = JSON.parse(JSON.stringify(sanitized()));
    leaky.playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl =
      `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&signature=STILLSIGNED`;
    const issues = auditFixture(leaky);
    assert(issues.length > 0, 'a live signature must be reported');
    assert(JSON.stringify(issues).includes('signature'), 'the report names the offending parameter');
    assert(!JSON.stringify(issues).includes('STILLSIGNED'), 'the report must not echo the value');
  });

  it('reports the PO-token rule exactly as the parser applies it', () => {
    const tracks = extractCaptionTracks(PLAYER);
    assertEqual(tracks.filter(isPoTokenProtected).length, 1);
    assertEqual(pickTrack(tracks, { lang: 'de' })?.lang, 'de');
  });

  it('survives missing and partial fields without inventing tracks', () => {
    const noCaptions = sanitizeFixture({ playerResponse: { videoDetails: { videoId: VIDEO_ID, title: 'No captions' } } }).fixture;
    assertEqual(noCaptions.playerResponse.captions, undefined, 'no captions block means no captions block');
    assertDeepEqualSorted(auditFixture(noCaptions), [], 'a capture without captions still has to audit clean');
    const empty = parserVerdict(noCaptions.playerResponse, noCaptions.initialData);
    assertEqual(empty.tracks.length, 0);
    assertEqual(empty.picks.manual, -1, 'nothing to pick, nothing to invent');

    const partial = sanitizeFixture({
      playerResponse: {
        videoDetails: { videoId: VIDEO_ID },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{ languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto)' } }],
          },
        },
      },
    }).fixture;
    const track = partial.playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0];
    assertEqual(track.baseUrl, undefined, 'a missing baseUrl stays missing, it is not filled with a guess');
    assertEqual(track.languageCode, 'en');
    assertEqual(track.kind, 'asr');
    assertEqual(track.vssId, undefined);
    assert(!isPoTokenProtected(track), 'a track without a URL cannot be PO-protected');
    assertEqual(auditFixture(partial).length, 0);
  });

  it('explains an unreadable source instead of writing a broken fixture', () => {
    withTempFiles((dir) => {
      const file = join(dir, 'consent.html');
      writeFileSync(file, '<html><body>Before you continue to YouTube</body></html>', 'utf8');
      let message = '';
      try {
        loadSource(file);
      } catch (err) {
        message = err.message;
      }
      assert(/ytInitialPlayerResponse/.test(message), `expected a clear error, got: ${message}`);
    });
  });
});

function assertDeepEqualSorted(actual, expected, message) {
  assert(JSON.stringify(actual.slice().sort()) === JSON.stringify(expected.slice().sort()), `${message}: ${JSON.stringify(actual)}`);
}

describe('captured YouTube fixture (level B: real response)', () => {
  it('parses a real saved player response when one is committed', () => {
    const files = (() => {
      try {
        return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
      } catch {
        return [];
      }
    })();
    if (!files.length) {
      console.log(
        `       уровень B: ожидается fixture — ${join('tests', 'fixtures', 'youtube')}/*.json (уровень C — живой запрос — не проверен)`,
      );
      return;
    }
    for (const name of files) {
      const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
      assertEqual(auditFixture(fixture).length, 0, `${name}: fixture must be sanitized`);
      assert(fixture.videoId, `${name}: videoId is required`);
      const verdict = parserVerdict(fixture.playerResponse, fixture.initialData);
      assert(verdict.tracks.length > 0, `${name}: the capture must contain caption tracks`);
      for (const track of verdict.tracks) {
        assert(track.lang, `${name}: every track needs languageCode`);
        assert(track.hasUrl, `${name}: every track needs a baseUrl (sanitized is fine)`);
      }
      if (Array.isArray(fixture.expected?.poProtected)) {
        const actual = verdict.tracks.map((t) => t.poProtected);
        assert(
          JSON.stringify(actual) === JSON.stringify(fixture.expected.poProtected),
          `${name}: poProtected ${JSON.stringify(actual)} != expected ${JSON.stringify(fixture.expected.poProtected)}`,
        );
      }
      assert(pickTrack(extractCaptionTracks(fixture.playerResponse), { lang: 'auto' }), `${name}: a track must be selected`);
    }
  });
});
