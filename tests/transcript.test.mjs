/**
 * YouTube transcript pipeline tests: embedded-JSON extraction, caption parsing
 * (json3 / vtt / srv1 / srv3), track picking, chapters, metadata and the two
 * network entry points (watch page + timedtext) with a mocked fetch.
 */

import { describe, it, assert, assertEqual, assertDeepEqual, assertThrows } from './helpers.mjs';
import {
  extractJsonAssignment,
  scanBalanced,
  getPlayerResponse,
  getInitialData,
  looksLikeConsentPage,
  looksLikeWatchPage,
  decodeEntities,
  ytText,
  deepCollect,
} from '../src/transcript/html-parse.js';
import {
  parseJson3,
  parseVtt,
  parseSrvXml,
  trimRollingCaptions,
  parseTimedText,
  parseTimecode,
  normalizeSegments,
  segmentsToText,
  formatMmSs,
  extractCaptionTracks,
  pickTrack,
  extractVideoMeta,
  extractChapters,
  parseDescriptionChapters,
  fetchWatchPage,
  fetchTimedText,
  fetchLegacyTimedText,
  isPoTokenProtected,
  getVideoData,
  getTranscript,
  extractTranscriptParams,
  parseTranscriptResponse,
} from '../src/transcript/youtube.js';

/* ------------------------------------------------------------------ fixtures */

const VIDEO_ID = 'dQw4w9WgXcQ';
const LONG_DESCRIPTION = [
  'Описание видео, достаточно длинное, чтобы извлечённый JSON превысил минимальный порог в двести символов. ' +
    'Здесь рассказывается о том, как работает расширение, какие движки используются и почему локальный режим не требует интернета, ' +
    'а также о том, как подключать собственных провайдеров моделей и что происходит с ключами доступа.',
  '',
  '00:00 Введение',
  '02:30 Основная часть',
  '06:00 Итоги',
].join('\n');

const PLAYER_RESPONSE = {
  videoDetails: {
    videoId: VIDEO_ID,
    title: 'Тест & видео о саммари',
    author: 'Канал OpenSummary',
    channelId: 'UC123',
    lengthSeconds: '754',
    viewCount: '12345',
    keywords: ['саммари', 'youtube'],
    shortDescription: LONG_DESCRIPTION,
    isLiveContent: false,
    thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/x/default.jpg' }, { url: 'https://i.ytimg.com/vi/x/maxres.jpg' }] },
  },
  microformat: { playerMicroformatRenderer: { publishDate: '2025-01-02', category: 'Science & Technology' } },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=' + VIDEO_ID + '&lang=ru', languageCode: 'ru', name: { simpleText: 'Русский' }, kind: 'asr', isTranslatable: true },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=' + VIDEO_ID + '&lang=ru&manual=1', languageCode: 'ru', name: { simpleText: 'Русский (вручную)' }, isTranslatable: true },
      ],
    },
  },
};

function watchHtml({ withCaptions = true, withChapters = true, xpe = false, transcriptParams = '' } = {}) {
  const player = JSON.parse(JSON.stringify(PLAYER_RESPONSE));
  if (!withCaptions) delete player.captions;
  // `xpe` mimics YouTube's PO-token rollout marker in a caption baseUrl.
  if (xpe && player.captions) {
    for (const track of player.captions.playerCaptionsTracklistRenderer.captionTracks) {
      if (xpe === 'all' || track.baseUrl.includes('manual=1')) track.baseUrl += '&exp=xpe';
    }
  }
  const initial = withChapters
    ? {
        contents: {
          twoColumnWatchNextResults: {
            results: { results: { contents: [
              { macroMarkersListItemRenderer: { title: { simpleText: 'Введение' }, timeDescription: { simpleText: '0:00' } } },
              { macroMarkersListItemRenderer: { title: { simpleText: 'Основная часть' }, timeDescription: { simpleText: '2:30' } } },
              { macroMarkersListItemRenderer: { title: { simpleText: 'Итоги' }, timeDescription: { simpleText: '6:00' } } },
            ] } },
          },
        },
      }
    : { contents: {} };
  if (transcriptParams) {
    // Shaped like the engagement panel's continuation endpoint in ytInitialData.
    initial.engagementPanels = [
      {
        engagementPanelSectionListRenderer: {
          content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: transcriptParams } } } },
        },
      },
    ];
  }
  return [
    '<!doctype html><html><head><title>Тестовое видео</title></head><body>',
    '<div id="player"></div>',
    `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`,
    `<script>var ytInitialData = ${JSON.stringify(initial)};</script>`,
    '</body></html>',
  ].join('\n');
}

const JSON3 = {
  events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Привет, ' }, { utf8: 'мир' }] },
    { tStartMs: 2000, dDurationMs: 1500, segs: [{ utf8: 'Второй сегмент' }] },
    { tStartMs: 3500, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'Второй сегмент плюс' }] },
  ],
};

const VTT = [
  'WEBVTT',
  'Kind: captions',
  'Language: ru',
  '',
  '00:00:00.000 --> 00:00:02.000',
  'Привет, мир',
  '',
  '00:00:02.500 --> 00:00:04.000 align:start position:0%',
  '<v Speaker>Второй</v> <b>сегмент</b>',
  '',
].join('\n');

/* -------------------------------------------------------------- fetch mock */

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    const response = await handler(href, init || {});
    if (!response) throw new Error(`unexpected fetch: ${href}`);
    return response;
  };
  return {
    calls,
    urls: () => calls.map((c) => c.url),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function withFetch(handler, fn) {
  const mock = mockFetch(handler);
  try {
    return await fn(mock);
  } finally {
    mock.restore();
  }
}

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

const CONSENT_HTML = '<html><body><h1>Before you continue to YouTube</h1><a href="https://consent.youtube.com/m?continue=...">OK</a></body></html>';

function errorCode(err) {
  return err?.code || err?.name;
}

/* -------------------------------------------------------------------- tests */

describe('html extraction', () => {
  it('reads an embedded JSON assignment and tolerates braces inside strings', () => {
    const html = `<script>var ytInitialPlayerResponse = {"a":{"b":"}{ не закрывать"},"c":[1,2],"d":${JSON.stringify('x'.repeat(240))}};</script>`;
    const json = extractJsonAssignment(html, 'ytInitialPlayerResponse');
    assert(json, 'assignment must be found');
    const parsed = JSON.parse(json);
    assertEqual(parsed.a.b, '}{ не закрывать');
    assertEqual(parsed.c.length, 2);
  });

  it('supports window["name"] = {...} and ignores short blobs', () => {
    const big = { payload: 'y'.repeat(250) };
    const viaWindow = extractJsonAssignment(`<script>window["ytInitialData"] = ${JSON.stringify(big)};</script>`, 'ytInitialData');
    assert(viaWindow && JSON.parse(viaWindow).payload.length === 250);
    assertEqual(extractJsonAssignment('<script>ytInitialPlayerResponse = {"tiny":1};</script>', 'ytInitialPlayerResponse'), null);
    assertEqual(scanBalanced('nope', 0), null);
  });

  it('extracts the player response and initial data from a watch page', () => {
    const html = watchHtml();
    const player = getPlayerResponse(html);
    assert(player?.videoDetails, 'player response parsed');
    assertEqual(player.videoDetails.title, PLAYER_RESPONSE.videoDetails.title);
    assert(getInitialData(html)?.contents, 'initial data parsed');
    assert(looksLikeWatchPage(html), 'watch page detected');
    assertEqual(looksLikeConsentPage(html), false);
  });

  it('detects a consent interstitial', () => {
    assert(looksLikeConsentPage(CONSENT_HTML), 'consent page detected');
    assertEqual(looksLikeWatchPage(CONSENT_HTML), false);
  });

  it('decodes entities and reads YouTube text nodes', () => {
    assertEqual(decodeEntities('Тест &amp; видео &quot;кавычки&quot; &#39;x&#39;'), 'Тест & видео "кавычки" \'x\'');
    assertEqual(decodeEntities('a\\u0026b'), 'a&b');
    assertEqual(ytText({ simpleText: 'привет' }), 'привет');
    assertEqual(ytText({ runs: [{ text: 'а' }, { text: 'б' }] }), 'аб');
    assertEqual(ytText('строка'), 'строка');
    assertEqual(ytText(null), '');
  });

  it('collects nested nodes with deepCollect', () => {
    const tree = { a: { target: { id: 1 } }, b: [{ target: { id: 2 } }, { target: { id: 3 } }] };
    const found = deepCollect(tree, (n) => !!n.target);
    assertEqual(found.length, 3);
  });
});

describe('caption parsing', () => {
  it('parses json3 including rolling-caption extensions', () => {
    const segments = parseJson3(JSON3);
    assertEqual(segments.length, 2, 'newline-only events must be dropped');
    assertEqual(segments[0].text, 'Привет, мир');
    assertEqual(segments[0].start, 0);
    assertEqual(segments[0].dur, 2);
    assertEqual(segments[1].text, 'Второй сегмент плюс', 'rolling caption must replace the shorter tail');
    assertEqual(segments[1].start, 2);
    assertEqual(segments[1].dur, 4, 'duration must extend to cover the longer line');
  });

  it('trims the repeated tail of a rolling caption window', () => {
    // Auto captions are a sliding window: every cue repeats the previous tail,
    // which used to reach the summary as “a lot of time a lot of time digging”.
    const rolling = trimRollingCaptions([
      { start: 0, dur: 3.4, text: 'we spent a lot of time digging' },
      { start: 2.6, dur: 3.2, text: 'a lot of time digging through the files' },
      { start: 5.0, dur: 3.0, text: 'the files to separate fact from conspiracy' },
    ]);
    assertEqual(rolling.length, 3, 'every cue keeps its own new words');
    assertEqual(rolling[1].text, 'through the files');
    assertEqual(rolling[2].text, 'to separate fact from conspiracy');
    assertEqual(
      rolling.map((s) => s.text).join(' '),
      'we spent a lot of time digging through the files to separate fact from conspiracy',
      'the joined transcript must read once, not twice',
    );
    assertEqual(rolling[0].dur, 3.4, 'a cue that keeps its new words keeps its duration');
  });

  it('drops a cue that only repeats the previous one and keeps its time', () => {
    const rolling = trimRollingCaptions([
      { start: 0, dur: 3, text: 'и вот тут всё началось' },
      { start: 2, dur: 3.5, text: 'тут всё началось' },
    ]);
    assertEqual(rolling.length, 1, 'the shorter repeat adds no words');
    assertEqual(rolling[0].text, 'и вот тут всё началось');
    assertEqual(rolling[0].dur, 5.5, 'its duration must cover the dropped cue');
  });

  it('chains several windows without losing or repeating words', () => {
    // Each window is compared with the raw previous one: after trimming
    // “смотрите что получилось” to “получилось”, the next window still overlaps
    // with the words already emitted.
    const segments = trimRollingCaptions([
      { start: 0, dur: 4.2, text: 'вот смотрите что' },
      { start: 1.8, dur: 3.8, text: 'смотрите что получилось' },
      { start: 3.6, dur: 4, text: 'что получилось когда' },
      { start: 5.4, dur: 3.6, text: 'получилось когда мы' },
      { start: 7.2, dur: 3.8, text: 'когда мы включили' },
    ]);
    assertEqual(segments.map((s) => s.text).join(' '), 'вот смотрите что получилось когда мы включили');
  });

  it('leaves intentional repetitions alone', () => {
    // A chant or a stutter is emphasis, not a rolling window.
    const chant = trimRollingCaptions([
      { start: 0, dur: 2, text: 'no, no, no' },
      { start: 1.5, dur: 2.5, text: 'no, no, no, that is wrong' },
    ]);
    assertEqual(chant[1].text, 'no, no, no, that is wrong');

    // The same sentence twice, separated by a full stop, is deliberate.
    const sentence = trimRollingCaptions([
      { start: 0, dur: 4, text: 'It was the longest day of my life.' },
      { start: 3.5, dur: 4, text: 'The longest day of my life, she said.' },
    ]);
    assertEqual(sentence[1].text, 'The longest day of my life, she said.');

    // Manual captions are separate lines: a shared set of words across a long
    // pause is two sentences, not one sliding window.
    const far = trimRollingCaptions([
      { start: 0, dur: 2, text: 'the same three words' },
      { start: 30, dur: 2, text: 'the same three words again' },
    ]);
    assertEqual(far[1].text, 'the same three words again');
  });

  it('applies the trim to json3 rolling captions end to end', () => {
    const segments = parseJson3({
      events: [
        { tStartMs: 0, dDurationMs: 3400, segs: [{ utf8: 'we spent a lot of time' }] },
        { tStartMs: 2600, dDurationMs: 3200, segs: [{ utf8: 'a lot of time digging' }] },
        // Real rolling windows overlap in time; a one-word repeat is only
        // trusted when they do.
        { tStartMs: 5000, dDurationMs: 3000, segs: [{ utf8: 'digging through the files' }] },
      ],
    });
    assertEqual(segments.map((s) => s.text).join(' '), 'we spent a lot of time digging through the files');
  });

  it('parses vtt and strips markup', () => {
    const segments = parseVtt(VTT);
    assertEqual(segments.length, 2);
    assertEqual(segments[0].text, 'Привет, мир');
    assertEqual(segments[0].start, 0);
    assertEqual(segments[0].dur, 2);
    assertEqual(segments[1].text, 'Второй сегмент');
    assertEqual(segments[1].start, 2.5);
    assertEqual(segments[1].dur, 1.5);
  });

  it('parses srv3 (<p t= d=) and srv1 (<text start= dur=) xml', () => {
    const srv3 = '<timedtext><body><p t="0" d="2000"><s>Привет</s><s>мир</s></p><p t="2500" d="1500">Второй</p></body></timedtext>';
    const fromSrv3 = parseSrvXml(srv3);
    assertEqual(fromSrv3.length, 2);
    assertEqual(fromSrv3[0].text, 'Привет мир');
    assertEqual(fromSrv3[0].start, 0);
    assertEqual(fromSrv3[0].dur, 2);
    assertEqual(fromSrv3[1].start, 2.5);

    const srv1 = '<transcript><text start="0" dur="2">Привет &amp; мир</text><text start="2.5" dur="1.5">Второй</text></transcript>';
    const fromSrv1 = parseSrvXml(srv1);
    assertEqual(fromSrv1.length, 2);
    assertEqual(fromSrv1[0].text, 'Привет & мир');
    assertEqual(fromSrv1[1].start, 2.5);
    assertEqual(fromSrv1[1].dur, 1.5);
  });

  it('auto-detects the payload format', () => {
    assertEqual(parseTimedText(JSON.stringify(JSON3)).format, 'json3');
    assertEqual(parseTimedText(VTT).format, 'vtt');
    assertEqual(parseTimedText('<transcript><text start="0" dur="2">Привет</text></transcript>').format, 'srv1');
    const text = parseTimedText('00:00:05.000 Первая фраза\n00:00:09.000 Вторая фраза');
    assertEqual(text.format, 'text');
    assertEqual(text.segments[0].start, 5);
    assertEqual(text.segments[1].text, 'Вторая фраза');
    assertDeepEqual(parseTimedText('').segments, []);
  });

  it('parses timecodes in every supported shape', () => {
    assertEqual(parseTimecode('1:02:03.500'), 3723.5);
    assertEqual(parseTimecode('00:00:02.500'), 2.5);
    assertEqual(parseTimecode('02:03'), 123);
    assertEqual(parseTimecode('0:05'), 5);
    assertEqual(parseTimecode('2:03.5'), 123.5);
    assertEqual(parseTimecode('m:1200'), null, 'garbage must not be parsed as a timecode');
  });

  it('normalizes segments: dedupes, clamps durations and drops empties', () => {
    const normalized = normalizeSegments([
      { start: 0, dur: 1, text: 'первый' },
      { start: 0.1, dur: 1, text: 'первый длиннее' },
      { start: 3, dur: 0, text: '' },
      { start: 4, dur: 0.05, text: '   ' },
    ]);
    assertEqual(normalized.length, 1, 'near-duplicates merge and empties vanish');
    assertEqual(normalized[0].text, 'первый длиннее');
    assertEqual(normalized[0].dur, 1.1);

    const kept = normalizeSegments([{ start: 1, dur: 1, text: '' }], { keepEmpty: true });
    assertEqual(kept.length, 1, 'keepEmpty must preserve silent segments');
    assertEqual(kept[0].dur, 1);
    assertEqual(normalizeSegments([{ start: 1, dur: 1, text: '' }]).length, 0);
  });

  it('renders transcript text with periodic timecodes', () => {
    const segments = [
      { start: 0, dur: 2, text: 'Начало' },
      { start: 10, dur: 2, text: 'Середина' },
      { start: 31, dur: 2, text: 'Дальше' },
    ];
    const text = segmentsToText(segments);
    assert(text.startsWith('[0:00]'), `expected a leading marker, got: ${text.slice(0, 20)}`);
    assert(text.includes('[0:31]'), 'marker every 30 seconds');

    const plain = segmentsToText(segments, { withTimecodes: false });
    assertEqual(plain.includes('['), false, 'no markers when disabled');
    assertEqual(formatMmSs(75), '1:15');
    assertEqual(formatMmSs(-5), '0:00');
  });
});

describe('track selection', () => {
  const tracks = extractCaptionTracks(PLAYER_RESPONSE);

  it('extracts caption tracks with languages and auto flags', () => {
    assertEqual(tracks.length, 2);
    assertEqual(tracks[0].lang, 'ru');
    assertEqual(tracks[0].auto, true, 'kind=asr means auto-generated');
    assertEqual(tracks[0].langName, 'Русский');
    assertEqual(tracks[1].auto, false);
    assert(tracks.every((t) => t.url.includes('timedtext')));
    assertDeepEqual(extractCaptionTracks({}), []);
  });

  it('prefers manual captions, then the requested language', () => {
    const manual = pickTrack(tracks, { lang: 'auto', preferManual: true });
    assertEqual(manual.auto, false, 'manual track wins by default');
    const auto = pickTrack(tracks, { lang: 'auto', preferManual: false });
    assertEqual(auto.auto, true, 'auto track can be preferred');

    const mixed = [...tracks, { url: 'https://x', lang: 'en', langName: 'English', auto: true }];
    const manualWins = pickTrack(mixed, { lang: 'en', preferManual: true });
    assertEqual(manualWins.auto, false, 'manual captions outrank the requested language by default');
    assertEqual(manualWins.lang, 'ru');
    const langWins = pickTrack(mixed, { lang: 'en', preferManual: false });
    assertEqual(langWins.lang, 'en', 'auto tracks follow the requested language');
    assertEqual(pickTrack([], {}), null);
  });
});

describe('video meta and chapters', () => {
  it('extracts metadata from the player response', () => {
    const meta = extractVideoMeta(PLAYER_RESPONSE, {}, VIDEO_ID);
    assertEqual(meta.videoTitle, 'Тест & видео о саммари');
    assertEqual(meta.channel, 'Канал OpenSummary');
    assertEqual(meta.lengthSeconds, 754);
    assertEqual(meta.viewCount, 12345);
    assertEqual(meta.publishDate, '2025-01-02');
    assertEqual(meta.thumbnail, 'https://i.ytimg.com/vi/x/maxres.jpg');
    assert(meta.description.includes('OpenSummary') === false, 'description comes from the fixture text');
    assert(meta.description.includes('расширение'), 'description is decoded');
    assertEqual(meta.url, `https://www.youtube.com/watch?v=${VIDEO_ID}`);
  });

  it('reads chapters from the initial data', () => {
    const initial = getInitialData(watchHtml());
    const chapters = extractChapters({ initialData: initial });
    assertEqual(chapters.length, 3);
    assertEqual(chapters[0].title, 'Введение');
    assertEqual(chapters[0].at, 0);
    assertEqual(chapters[1].at, 150);
  });

  it('falls back to chapters written in the description', () => {
    const chapters = parseDescriptionChapters(LONG_DESCRIPTION);
    assertEqual(chapters.length, 3);
    assertEqual(chapters[0].at, 0);
    assertEqual(chapters[1].title, 'Основная часть');
    assertEqual(chapters[2].at, 360);

    assertDeepEqual(parseDescriptionChapters('00:00 одна глава'), [], 'a single line is not a chapter list');
    assertDeepEqual(parseDescriptionChapters('05:00 поздно\n10:00 ещё позже'), [], 'chapters must start near the beginning');
    assertDeepEqual(parseDescriptionChapters(''), []);
  });
});

describe('transcript fetching', () => {
  it('loads video data from the watch page', async () => {
    await withFetch((url) => (url.includes('/watch?') ? htmlResponse(watchHtml()) : null), async (mock) => {
      const data = await getVideoData(VIDEO_ID);
      assertEqual(data.meta.videoTitle, 'Тест & видео о саммари');
      assertEqual(data.tracks.length, 2);
      assertEqual(data.chapters.length, 3);
      assertEqual(data.htmlError, '');
      assert(mock.calls[0].url.includes(`v=${VIDEO_ID}`), 'watch page URL must carry the video id');
      assertEqual(mock.calls[0].init.credentials, 'include');
    });
  });

  it('builds a full transcript from the caption track', async () => {
    const handler = (url) => {
      if (url.includes('/watch?')) return htmlResponse(watchHtml());
      if (url.includes('/api/timedtext')) return jsonResponse(JSON.stringify(JSON3));
      return null;
    };
    await withFetch(handler, async (mock) => {
      const stages = [];
      const transcript = await getTranscript(VIDEO_ID, { lang: 'ru', onStage: (s) => stages.push(s.stage) });
      assertEqual(transcript.segments.length, 2);
      assertEqual(transcript.segments[0].text, 'Привет, мир');
      assertEqual(transcript.tracks.length, 2);
      assertEqual(transcript.source, 'manual', `source: ${transcript.source}`);
      assertEqual(transcript.language, 'ru');
      assertEqual(transcript.translated, false);
      assertEqual(transcript.autoGenerated, false);
      assertEqual(transcript.format, 'json3');
      assertEqual(transcript.chapters.length, 3);
      assert(transcript.wordCount >= 4, `word count: ${transcript.wordCount}`);
      assert(stages.includes('video-data') && stages.includes('parsed'));
      const timedtext = mock.urls().find((u) => u.includes('/api/timedtext'));
      assert(timedtext.includes('fmt=json3'), 'json3 must be requested first');
      assertEqual(timedtext.includes('tlang='), false, 'no translation when the language matches');
    });
  });

  it('requests a translation when the language is missing', async () => {
    const handler = (url) => {
      if (url.includes('/watch?')) return htmlResponse(watchHtml());
      if (url.includes('/api/timedtext')) return jsonResponse(JSON.stringify(JSON3));
      return null;
    };
    await withFetch(handler, async (mock) => {
      const transcript = await getTranscript(VIDEO_ID, { lang: 'en', translate: true });
      const timedtext = mock.urls().find((u) => u.includes('/api/timedtext'));
      assert(timedtext.includes('tlang=en'), `expected translated track, got ${timedtext}`);
      assertEqual(transcript.translated, true);
      assertEqual(transcript.language, 'en');
      assertEqual(transcript.source, 'manual-translated:en');
      assertEqual(transcript.trackLang, 'ru');
    });
  });

  it('reports POT_REQUIRED for PO-token-protected tracks without calling timedtext', async () => {
      const protectedTrack = { url: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=ru&exp=xpe`, lang: 'ru' };
    assertEqual(isPoTokenProtected(protectedTrack), true);
    assertEqual(isPoTokenProtected({ url: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=ru` }), false);

    await assertThrowsAsync(async () => {
      try {
        await fetchTimedText(protectedTrack, { fmt: 'json3' });
        throw new Error('expected POT_REQUIRED');
      } catch (err) {
        assertEqual(errorCode(err), 'POT_REQUIRED');
        assert(String(err.hint || '').length > 0, 'the error must tell the user what to do');
        throw err;
      }
    });

    await withFetch((url) => (url.includes('/watch?') ? htmlResponse(watchHtml({ xpe: 'all' })) : null), async (mock) => {
      try {
        await getTranscript(VIDEO_ID);
        throw new Error('expected POT_REQUIRED');
      } catch (err) {
        assertEqual(errorCode(err), 'POT_REQUIRED');
      }
      assertEqual(
        mock.urls().filter((u) => u.includes('/api/timedtext')).length,
        0,
        'protected tracks must not be requested at all',
      );
    });
  });

  it('reads the transcript through InnerTube when every caption track is protected', async () => {
    // The panel's own API: no PO token, no DOM. This is the route that works for
    // videos where /api/timedtext answers with an empty body.
    const response = {
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                body: {
                  transcriptBodyRenderer: {
                    cueGroups: [
                      {
                        transcriptCueGroupRenderer: {
                          cues: [
                            { transcriptCueRenderer: { startOffsetMs: 1223000, durationMs: 4000, cue: { runs: [{ text: 'Европа без Трампа: ' }, { text: 'первый тезис' }] } } },
                            { transcriptCueRenderer: { startOffsetMs: 1227000, durationMs: 3000, cue: { simpleText: 'Второй тезис' } } },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      ],
    };
    await withFetch(
      (url) => {
        if (url.includes('/watch?')) return htmlResponse(watchHtml({ xpe: 'all', transcriptParams: 'abc123' }));
        if (url.includes('/youtubei/v1/get_transcript')) return jsonResponse(JSON.stringify(response));
        if (url.includes('/api/timedtext')) return jsonResponse('');
        return null;
      },
      async (mock) => {
        const transcript = await getTranscript(VIDEO_ID);
        assertEqual(transcript.segments.length, 2, `expected 2 cues, got ${transcript.segments.length}`);
        assertEqual(transcript.segments[0].start, 1223);
        assertEqual(transcript.segments[0].text, 'Европа без Трампа: первый тезис');
        assertEqual(transcript.segments[1].dur, 3);
        assertEqual(transcript.meta.lang || transcript.language, 'ru');
        const post = mock.calls.find((c) => c.url.includes('/youtubei/v1/get_transcript'));
        assert(post, 'the panel API must be called');
        assert(String(post.init.body).includes('abc123'), 'the transcript params must be sent');
        assertEqual(
          mock.urls().filter((u) => u.includes('/api/timedtext')).length,
          0,
          'protected tracks must not be requested',
        );
      },
    );
  });

  it('parses both get_transcript response shapes', () => {
    const segs = parseTranscriptResponse({
      a: [{ transcriptSegmentRenderer: { startMs: 5000, endMs: 8000, snippet: { runs: [{ text: 'Раз' }] } } }],
      b: [{ transcriptCueRenderer: { startOffsetMs: 9000, durationMs: 2500, cue: { simpleText: 'Два' } } }],
    });
    assertEqual(segs.length, 2);
    assertEqual(segs[0].start, 5);
    assertEqual(segs[0].dur, 3);
    assertEqual(segs[1].start, 9);
    assertEqual(segs[1].text, 'Два');
    assertEqual(
      extractTranscriptParams({ deep: { list: [{ continuationEndpoint: { getTranscriptEndpoint: { params: 'xyz' } } }] } }),
      'xyz',
      'params must be found at any depth',
    );
    assertEqual(extractTranscriptParams({}), '');
  });

  // 2026-10: the transcript panel moved from `get_transcript` (renderers) to
  // `get_panel` (view models with a display timestamp). Reading the old shape
  // only meant a working panel looked like an empty transcript.
  it('parses the get_panel transcript view models', () => {
    const panel = {
      content: {
        engagementPanelSectionListRenderer: {
          content: {
            sectionListRenderer: {
              contents: [
                {
                  itemSectionRenderer: {
                    contents: [
                      {
                        macroMarkersPanelItemViewModel: {
                          item: {
                            timelineItemViewModel: {
                              contentItems: [
                                { transcriptSegmentViewModel: { timestamp: '0:01', simpleText: 'Первая фраза' } },
                              ],
                            },
                          },
                        },
                      },
                      {
                        macroMarkersPanelItemViewModel: {
                          item: {
                            timelineItemViewModel: {
                              contentItems: [
                                { transcriptSegmentViewModel: { timestamp: '0:09', simpleText: 'Вторая &amp; фраза' } },
                              ],
                            },
                          },
                        },
                      },
                      {
                        macroMarkersPanelItemViewModel: {
                          item: {
                            timelineItemViewModel: {
                              contentItems: [
                                { transcriptSegmentViewModel: { timestamp: '1:02:03', simpleText: 'Дальше' } },
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
    const segs = parseTranscriptResponse(panel);
    assertEqual(segs.length, 3);
    assertEqual(segs[0].start, 1);
    assertEqual(segs[0].text, 'Первая фраза');
    assertEqual(segs[0].dur, 8, 'the cue lasts until the next line');
    assertEqual(segs[1].start, 9);
    assertEqual(segs[1].text, 'Вторая & фраза');
    assertEqual(segs[1].dur, 8, 'a long gap is capped instead of stretching a cue');
    assertEqual(segs[2].start, 3723);
    assertEqual(segs[2].dur, 2, 'the last line gets a default length');
  });

  it('skips a protected track and still builds the transcript from another one', async () => {
    await withFetch(
      (url) => {
        if (url.includes('/watch?')) return htmlResponse(watchHtml({ xpe: 'manual' }));
        if (url.includes('/api/timedtext')) return jsonResponse(JSON.stringify(JSON3));
        return null;
      },
      async (mock) => {
        const transcript = await getTranscript(VIDEO_ID);
        assert(transcript.segments.length > 0, 'the usable track must be used');
        assertEqual(transcript.source, 'auto', 'the protected manual track must be skipped');
        const timedtext = mock.urls().filter((u) => u.includes('/api/timedtext'));
        assertEqual(timedtext.some((u) => u.includes('exp=xpe')), false, 'no request for the protected track');
      },
    );
  });

  it('asks the app clients for a fetchable track when the web track is protected', async () => {
    const androidTrack = `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=ru`;
    const androidPlayer = {
      videoDetails: { videoId: VIDEO_ID, title: 'Тест', author: 'Канал', lengthSeconds: '60' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: androidTrack, languageCode: 'ru', name: { simpleText: 'Русский' } }],
        },
      },
    };
    await withFetch(
      (url) => {
        if (url.includes('/watch?')) return htmlResponse(watchHtml({ xpe: 'all' }));
        if (url.includes('/youtubei/')) return jsonResponse(androidPlayer);
        if (url.includes('/api/timedtext')) return jsonResponse(JSON.stringify(JSON3));
        return null;
      },
      async (mock) => {
        const video = await getVideoData(VIDEO_ID);
        assertEqual(video.tracks.length, 1, 'the app-client track must replace the protected one');
        assertEqual(isPoTokenProtected(video.tracks[0]), false);
        assert(
          mock.urls().some((u) => u.includes('/youtubei/v1/player')),
          'the InnerTube player must be asked for an alternative track',
        );
        const transcript = await getTranscript(VIDEO_ID);
        assert(transcript.segments.length > 0, 'the alternative track must produce a transcript');
      },
    );
  });

  it('reports a coded error when the video has no captions', async () => {
    await withFetch((url) => (url.includes('/watch?') || url.includes('/youtubei/') ? htmlResponse(watchHtml({ withCaptions: false })) : null), async () => {
      try {
        await getTranscript(VIDEO_ID);
        throw new Error('expected a NO_CAPTIONS failure');
      } catch (err) {
        assertEqual(errorCode(err), 'NO_CAPTIONS');
        assert(err.message.length > 0, 'the error must carry a human message');
      }
    });
  });

  it('detects the consent wall and invalid video ids', async () => {
    await withFetch((url) => (url.includes('/watch?') ? htmlResponse(CONSENT_HTML) : jsonResponse({})), async () => {
      try {
        await fetchWatchPage(VIDEO_ID);
        throw new Error('expected a CONSENT failure');
      } catch (err) {
        assertEqual(errorCode(err), 'CONSENT');
      }
    });

    await assertThrowsAsync(async () => {
      try {
        await getVideoData('!!');
        throw new Error('expected BAD_VIDEO_ID');
      } catch (err) {
        assertEqual(errorCode(err), 'BAD_VIDEO_ID');
        throw err;
      }
    });
  });

  it('maps timedtext failures to actionable codes', async () => {
    const track = { url: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=ru`, lang: 'ru' };
    await withFetch(() => new Response('slow down', { status: 429 }), async () => {
      try {
        await fetchTimedText(track, { fmt: 'json3' });
        throw new Error('expected RATE_LIMITED');
      } catch (err) {
        assertEqual(errorCode(err), 'RATE_LIMITED');
      }
    });

    await withFetch(() => new Response('', { status: 200 }), async () => {
      try {
        await fetchTimedText(track, { fmt: 'json3' });
        throw new Error('expected EMPTY_CAPTIONS');
      } catch (err) {
        assertEqual(errorCode(err), 'EMPTY_CAPTIONS');
      }
    });

    await withFetch(() => new Response('<html><body>not captions</body></html>', { status: 200 }), async () => {
      try {
        await fetchTimedText(track, { fmt: 'json3' });
        throw new Error('expected PARSE_FAILED');
      } catch (err) {
        assertEqual(errorCode(err), 'PARSE_FAILED', 'a body that the parser cannot read is not an empty track');
        assert(/байт/.test(String(err.message)), 'the message must say how much arrived');
        assertEqual(err.format, 'srv1');
      }
    });

    await withFetch(() => new Response('{"events":[{"tStartMs":0}]}', { status: 200 }), async () => {
      try {
        await fetchTimedText(track, { fmt: 'json3' });
        throw new Error('expected PARSE_FAILED');
      } catch (err) {
        assertEqual(errorCode(err), 'PARSE_FAILED', 'events without text are a parse failure, not an empty answer');
      }
    });

    await withFetch(() => new Response('{"events":[]}', { status: 200 }), async () => {
      try {
        await fetchTimedText(track, { fmt: 'json3' });
        throw new Error('expected EMPTY_CAPTIONS');
      } catch (err) {
        assertEqual(errorCode(err), 'EMPTY_CAPTIONS', 'an explicitly empty track stays EMPTY_CAPTIONS');
      }
    });

    // A valid container without cues is not a parsing defect: YouTube answers
    // like this for an untranslated tlang or a track that exists but is empty.
    for (const [label, body] of [
      ['vtt without cues', 'WEBVTT\n\n'],
      ['empty transcript xml', '<transcript></transcript>'],
      ['self-closing transcript', '<transcript/>'],
    ]) {
      await withFetch(() => new Response(body, { status: 200 }), async () => {
        try {
          await fetchTimedText(track, { fmt: 'json3' });
          throw new Error(`expected EMPTY_CAPTIONS for ${label}`);
        } catch (err) {
          assertEqual(errorCode(err), 'EMPTY_CAPTIONS', `${label} must not be reported as a parser failure`);
        }
      });
    }

    await assertThrowsAsync(async () => {
      try {
        await fetchTimedText({ url: '' });
        throw new Error('expected NO_TRACK');
      } catch (err) {
        assertEqual(errorCode(err), 'NO_TRACK');
        throw err;
      }
    });
  });
});

describe('legacy caption endpoint', () => {
  it('asks for the video, language and kind, and parses the XML answer', async () => {
    const xml =
      '<transcript><text start="12.5" dur="2">Привет</text><text start="14.5" dur="2">мир</text></transcript>';
    await withFetch(() => new Response(xml, { status: 200 }), async (mock) => {
      const segments = await fetchLegacyTimedText(VIDEO_ID, { lang: 'ru', kind: 'asr' });
      assertEqual(segments.length, 2, `expected 2 segments, got ${segments.length}`);
      assertEqual(segments[0].start, 12.5);
      assertEqual(segments[0].text, 'Привет');
      const url = mock.urls()[0];
      assert(url.startsWith('https://video.google.com/timedtext?'), `unexpected endpoint: ${url}`);
      assert(url.includes(`v=${VIDEO_ID}`), 'the video id must be sent');
      assert(url.includes('lang=ru') && url.includes('kind=asr'), 'language and kind must be sent');
    });
  });

  it('treats an empty body and a 404 as “no such track”', async () => {
    await withFetch(() => new Response('', { status: 200 }), async () => {
      assertDeepEqual(await fetchLegacyTimedText(VIDEO_ID, { lang: 'ru' }), []);
    });
    await withFetch(() => new Response('nope', { status: 404 }), async () => {
      try {
        await fetchLegacyTimedText(VIDEO_ID, { lang: 'ru' });
        throw new Error('expected 404 to throw');
      } catch (err) {
        assertEqual(err.code, 404);
      }
    });
  });
});

async function assertThrowsAsync(fn) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, 'expected the async function to throw');
}
void assertThrows;
