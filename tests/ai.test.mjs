import { createServer } from 'node:http';
import { describe, it, assert, assertEqual, assertDeepEqual, near } from './helpers.mjs';
import { buildChunks, planStrategy, estimateTokens, buildBlocks, renderBlocks, topicBoundaries } from '../src/ai/chunking.js';
import { verifyResult, unsupportedNumbers, claimNumbers } from '../src/ai/verify.js';
import { parseAiJson, sanitizeJsonText, salvageAiJson } from '../src/ai/json.js';
import { coercePayload, proseToPayload, looksLikeProseAnswer } from '../src/ai/coerce.js';
import { createSummaryStream } from '../src/ai/stream-json.js';
import { buildRequest, chat, listModels, testProvider, mapHttpError, operationBudgetMs, retryBackoffMs } from '../src/ai/client.js';
import { runAiSummary, runAiAsk, createLimiter, mapAdaptive, chunkCacheKey, initialOutputBudget, reduceInputBudget, reduceAllowanceMs, timelineBlocks, computeJobBudgetMs } from '../src/ai/pipeline.js';
import { resolveOutputLanguage, languageInstruction } from '../src/ai/prompts.js';
import { providerFromPreset, resolveChatUrl, resolveModelsUrl, expandBaseUrl, PRESETS, getPreset } from '../src/ai/providers.js';
import { ruTranscript, longTranscript, meta } from './fixtures.mjs';
import { countWords } from '../src/common/util.js';

/* --------------------------------------------------------------- mock fetch */

const enc = new TextEncoder();

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function sseResponse(events, { done = true } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`));
      if (done) controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One OpenAI-style SSE delta event carrying `text` as the answer chunk. */
function deltaSse(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function ndjsonResponse(objects) {
  const stream = new ReadableStream({
    start(controller) {
      for (const o of objects) controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Upstream accepted the request and then went silent: the stream never ends. */
function hungSseResponse(events) {
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      /* no close — the model stalled */
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A slow but alive upstream: bytes keep coming at the given pace. */
function dripSseResponse(events, delayMs) {
  const stream = new ReadableStream({
    async start(controller) {
      for (const e of events) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * SSE keepalive comments (`: ping`) on an interval, forever: the transport
 * keeps proving it is alive, while no generation event ever arrives.
 */
function keepaliveOnlySse(commentMs = 15) {
  let timer = null;
  const stream = new ReadableStream({
    start(controller) {
      timer = setInterval(() => controller.enqueue(enc.encode(': keepalive\n\n')), commentMs);
      /* no close — generation never starts */
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Generation started (the given events arrive), then froze, while keepalive
 * comments keep coming: the transport stays alive, the generation does not.
 */
function frozenAfterContentSse(events, commentMs = 15) {
  let timer = null;
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      timer = setInterval(() => controller.enqueue(enc.encode(': keepalive\n\n')), commentMs);
      /* no close — generation froze */
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Slow but genuinely progressing generation, optionally preceded by a long
 * “thinking” phase in which only keepalive comments stream: `leadMs` of
 * keepalive-only bytes, then content deltas `delayMs` apart, then close.
 */
function drippingSse(events, delayMs, { leadMs = 0, commentMs = 15 } = {}) {
  let timer = null;
  const stream = new ReadableStream({
    async start(controller) {
      timer = setInterval(() => controller.enqueue(enc.encode(': keepalive\n\n')), commentMs);
      if (leadMs) await new Promise((resolve) => setTimeout(resolve, leadMs));
      for (const e of events) {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      clearInterval(timer);
      controller.close();
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const shortChatOptions = { temperature: 0, maxTokens: 20 };

function withFetch(mock, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return mock(String(url), init);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    })
    .then((res) => ({ res, calls }));
}

const SUMMARY_JSON = {
  tldr: 'Видео о кэшировании: три стратегии, метрики и инвалидация.',
  keyPoints: [
    { text: 'Кэш хранит результат дорогой операции, чтобы не выполнять её повторно.', at: '0:05' },
    { text: 'Redis ускорил ответ с 800 до 40 миллисекунд.', at: '1:10' },
  ],
  sections: [{ heading: 'Стратегии кэширования', at: '0:20', summary: 'Три подхода.', points: [{ text: 'TTL, инвалидация по событию, сквозная запись.', at: '0:25' }] }],
  takeaways: ['Кэш без инвалидации опаснее, чем отсутствие кэша.'],
  actionItems: ['Кэшируйте только чтение и только с TTL.'],
  questions: ['Что такое инвалидация кэша?'],
  quotes: [{ text: 'Мы получили ускорение с 800 миллисекунд до 40.', at: '1:10' }],
  entities: [{ name: 'Redis', type: 'product', mentions: 2 }],
  keywords: [{ term: 'кэширование', score: 0.9 }, { term: 'инвалидация', score: 0.8 }],
  sentiment: { label: 'neutral', score: 0.1 },
};

describe('providers', () => {
  it('exposes a broad catalog with free options', () => {
    assert(PRESETS.length >= 25, `expected a large catalog, got ${PRESETS.length}`);
    const free = PRESETS.filter((p) => p.free).length;
    assert(free >= 10, `expected many free presets, got ${free}`);
    const ids = new Set(PRESETS.map((p) => p.id));
    for (const required of ['google', 'openrouter', 'groq', 'cerebras', 'ollama', 'lmstudio', 'github', 'custom-openai']) {
      assert(ids.has(required), `missing preset ${required}`);
    }
    assert(getPreset('openrouter').defaultModel.includes('free'));
  });
  it('builds provider configs and urls', () => {
    const p = providerFromPreset('openrouter');
    assertEqual(p.type, 'openai');
    assertEqual(resolveChatUrl({ ...p, chatPath: '/chat/completions' }, 'x'), 'https://openrouter.ai/api/v1/chat/completions');
    const g = providerFromPreset('google');
    assertEqual(resolveChatUrl(g, 'gemini-2.5-flash'), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assertEqual(resolveModelsUrl({ ...providerFromPreset('ollama') }), 'http://localhost:11434/api/tags');
    assertEqual(expandBaseUrl({ baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/', accountId: 'abc' }), 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1');
  });
});

describe('output language', () => {
  it('auto follows the interface language, not the video language', () => {
    // An English video watched with a Russian interface must produce a Russian
    // конспект: this was the reported “must translate any language to the
    // user's language” bug — auto used to resolve to the transcript language.
    assertEqual(resolveOutputLanguage('auto', 'ru'), 'ru');
    assertEqual(resolveOutputLanguage('auto', 'en'), 'en');
    assertEqual(resolveOutputLanguage(undefined, 'ru'), 'ru');
    // An unknown or missing interface language keeps the old behaviour.
    assertEqual(resolveOutputLanguage('auto', 'xx'), 'auto');
    assertEqual(resolveOutputLanguage('auto', ''), 'auto');
  });
  it('an explicit language wins over the interface language', () => {
    assertEqual(resolveOutputLanguage('de', 'ru'), 'de');
    assertEqual(resolveOutputLanguage('uk', 'en'), 'uk');
  });
  it('instructs the model to translate the meaning on a foreign transcript', () => {
    const en = languageInstruction('ru', 'en');
    assert(en.includes('русск'), `expected a russian instruction, got: ${en}`);
    assert(en.includes('переведи смысл'), 'must ask for meaning, not word-for-word');
    const autoOnRu = languageInstruction('auto', 'ru');
    assert(autoOnRu.includes('языке видео'), `auto without a known ui language stays on the video language, got: ${autoOnRu}`);
  });
});

describe('chunking', () => {
  it('estimates tokens script-aware', () => {
    const ru = estimateTokens('Привет мир как дела');
    const en = estimateTokens('hello world how are you');
    assert(ru > en, 'cyrillic text must cost more tokens than latin of the same length');
  });
  it('builds blocks with timecode markers', () => {
    const blocks = buildBlocks(ruTranscript());
    assert(blocks.length >= 2);
    assert(renderBlocks(blocks).startsWith('[0:00]'));
  });
  it('splits long transcripts into overlapping chunks', () => {
    const segments = longTranscript(400);
    const chunks = buildChunks(segments, { maxTokens: 900, overlapBlocks: 1 });
    assert(chunks.length > 2, `expected multiple chunks, got ${chunks.length}`);
    assert(chunks.every((c) => c.tokens <= 1400), 'chunks must respect the budget');
    assert(chunks[1].blocks[0].at <= chunks[0].blocks[chunks[0].blocks.length - 1].at, 'expected overlap between chunks');
    assertEqual(chunks[0].count, chunks.length);
  });
  it('keeps every word and invents no timecodes when segments carry none', () => {
    const segments = Array.from({ length: 40 }, (_, i) => ({ text: `Строка номер ${i} без времени.` }));
    const chunks = buildChunks(segments, { maxTokens: 400, overlapBlocks: 0 });
    assert(chunks.length > 1, 'an untimed long transcript must still be split');
    const joined = chunks.map((c) => c.text).join(' ');
    for (let i = 0; i < 40; i++) {
      assert(joined.includes(`Строка номер ${i} без времени.`), `segment ${i} was lost`);
    }
    assert(chunks.every((c) => c.startAt === 0 && c.endAt === 0), 'missing timestamps must stay 0 rather than be guessed');
  });

  it('covers each block of a long transcript and keeps chunks chronological', () => {
    const segments = longTranscript(500);
    const chunks = buildChunks(segments, { maxTokens: 1200, overlapBlocks: 1 });
    const blocks = buildBlocks(segments);
    const covered = new Set();
    for (const chunk of chunks) for (const block of chunk.blocks) covered.add(block.text);
    assertEqual(covered.size, blocks.length, 'every transcript block must belong to at least one chunk');
    for (let i = 1; i < chunks.length; i++) {
      assert(chunks[i].startAt >= chunks[i - 1].startAt, 'chunks must follow the transcript');
    }
    assertEqual(chunks[0].startAt, blocks[0].at);
    assertEqual(chunks[chunks.length - 1].endAt, blocks[blocks.length - 1].at);
  });

  /** Six topics, two rounds: each topic owns its own vocabulary. */
  const multiTopicTranscript = (rounds = 2) => {
    const topics = [
      ['court', 'judge', 'prosecutor', 'appeal', 'witnesses'],
      ['bank', 'depositors', 'branch', 'regulators', 'lenders'],
      ['agency', 'officer', 'oversight', 'audit', 'companies'],
      ['election', 'turnout', 'ballot', 'candidates', 'parliament'],
      ['climate', 'arctic', 'flood', 'wetlands', 'groundwater'],
      ['software', 'cache', 'database', 'regression', 'sprint'],
    ];
    const segments = [];
    let at = 0;
    for (let round = 0; round < rounds; round++) {
      for (const topic of topics) {
        for (let i = 0; i < 6; i++) {
          segments.push({
            start: at,
            dur: 5,
            text: `The ${topic[i % 5]} and the ${topic[(i + 1) % 5]} discussed the ${topic[(i + 2) % 5]} during the ${topic[(i + 3) % 5]} review.`,
          });
          at += 5;
        }
      }
    }
    return segments;
  };

  const rescannedTokens = (chunks) => {
    const seen = new Set();
    let repeated = 0;
    for (const chunk of chunks) {
      for (const block of chunk.blocks) {
        if (seen.has(block.at)) repeated += block.tokens;
        else seen.add(block.at);
      }
    }
    return repeated;
  };

  it('finds topic shifts from windowed lexical cohesion', () => {
    const multi = topicBoundaries(buildBlocks(multiTopicTranscript()));
    assert(multi.size > 0, 'a transcript that changes subject must expose at least one boundary');
    for (const index of multi) assert(index > 0, 'the first block is never a boundary');
  });

  it('ends a chunk at a topic change and does not repeat that text in the next one', () => {
    const segments = multiTopicTranscript();
    const chunks = buildChunks(segments, { maxTokens: 900 });
    assert(chunks.length > 1, 'expected multiple chunks');
    const semantic = chunks.filter((c) => c.cut === 'topic');
    assert(semantic.length > 0, `expected a topic cut, got ${chunks.map((c) => c.cut).join(',')}`);
    for (let i = 0; i < chunks.length - 1; i++) {
      if (chunks[i].cut !== 'topic') continue;
      const lastAt = chunks[i].blocks[chunks[i].blocks.length - 1].at;
      assert(chunks[i + 1].blocks[0].at > lastAt, 'a topic cut must not repeat the previous tail');
    }
  });

  it('rescans less text than size-only cuts that keep the same overlap', () => {
    const segments = multiTopicTranscript();
    const semantic = buildChunks(segments, { maxTokens: 900 });
    const sizeOnly = buildChunks(segments, { maxTokens: 900, semantic: false });
    assert(rescannedTokens(semantic) < rescannedTokens(sizeOnly), 'semantic cuts must send less duplicated text');
  });

  it('plans single vs map-reduce', () => {
    const shortPlan = planStrategy({ segments: ruTranscript(), maxTokens: 4000, strategy: 'auto' });
    assertEqual(shortPlan.strategy, 'single');
    const longPlan = planStrategy({ segments: longTranscript(600), maxTokens: 2000, strategy: 'auto' });
    assertEqual(longPlan.strategy, 'map-reduce');
    assert(longPlan.chunks.length > 1);
  });
});

describe('parallel chunks', () => {
  it('halves the request window on a rate limit and never goes below one', () => {
    const limiter = createLimiter(8);
    assertEqual(limiter.current, 8);
    assertEqual(limiter.lower(), 4);
    assertEqual(limiter.lower(), 2);
    assertEqual(limiter.lower(), 1);
    assertEqual(limiter.lower(), 1, 'one request in flight is the floor');
    assertEqual(createLimiter(0).current, 1, 'a garbage limit still runs one at a time');
  });

  it('keeps the configured number of chunks in flight and returns them in order', async () => {
    const limiter = createLimiter(4);
    let active = 0;
    let peak = 0;
    const results = await mapAdaptive(
      Array.from({ length: 10 }, (_, i) => i),
      async (n) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return n * 2;
      },
      limiter,
    );
    assert(peak <= 4, `at most 4 chunks may run at once, saw ${peak}`);
    assert(peak >= 2, 'chunks must actually run in parallel');
    assertEqual(results.length, 10);
    assertEqual(results[9], 18, 'results keep the chunk order');
  });

  it('holds every queued chunk during a shared rate-limit cooldown', async () => {
    const limiter = createLimiter(2);
    const started = [];
    let pausedAt = 0;
    const results = await mapAdaptive(
      ['a', 'b', 'c', 'd'],
      async (n) => {
        started.push({ n, at: Date.now() });
        if (n === 'a') {
          // The chunk that got the 429 asks the whole run to wait.
          pausedAt = Date.now();
          limiter.pause(60);
        }
        return n;
      },
      limiter,
    );
    assertEqual(results.join(''), 'abcd', 'the shared pause must not change the order');
    const later = started.filter((s) => s.n === 'c' || s.n === 'd');
    assertEqual(later.length, 2);
    for (const s of later) {
      assert(s.at - pausedAt >= 40, `chunk ${s.n} started ${s.at - pausedAt}ms after the 429, before the cooldown ended`);
    }
    assertEqual(limiter.waitMs(), 0, 'the cooldown must expire');
  });

  it('lowering the window and pausing are independent controls', async () => {
    const limiter = createLimiter(6);
    limiter.pause(40);
    const remaining = limiter.waitMs();
    assert(remaining > 0 && remaining <= 40, `pause must be bounded, saw ${remaining}`);
    limiter.pause(5);
    assert(limiter.waitMs() >= 10, 'a shorter pause must not shorten the running one');
    limiter.pause(0);
    assert(limiter.waitMs() > 0, 'a zero pause must not clear the running one');
    assertEqual(limiter.lower(), 3);
  });

  it('lowers the window while the run is going', async () => {
    const limiter = createLimiter(6);
    let peak = 0;
    let active = 0;
    const results = await mapAdaptive(
      Array.from({ length: 8 }, (_, i) => i),
      async (n) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (n === 0) limiter.lower();
        active--;
        return n;
      },
      limiter,
    );
    assertEqual(limiter.current, 3);
    assertEqual(results.length, 8);
    assert(peak <= 6, 'a lowered window never widens');
  });
});

describe('json parsing', () => {
  it('parses fenced, prose-wrapped and sloppy json', () => {
    assert(parseAiJson('{"a":1}').ok);
    assert(parseAiJson('Here you go:\n```json\n{"a":1}\n```').ok);
    const sloppy = parseAiJson("{'a': 1, 'b': [1,2,], }");
    assert(sloppy.ok, 'sanitizer must fix quotes and trailing commas');
    assertEqual(sloppy.value.b.length, 2);
    assert(!parseAiJson('no json here').ok);
    assertEqual(sanitizeJsonText('{"a":1,}'), '{"a":1}');
  });

  it('picks the real summary when a weak model prints the schema first', () => {
    const schemaEcho = '{"tldr":"строка: 2-3 предложения","keyPoints":[{"text":"тезис","at":"mm:ss"}]}';
    const answer = '{"tldr":"Кэш ускоряет ответы, но его нужно инвалидировать.","keyPoints":[{"text":"Redis ускорил ответ с 800 до 40 миллисекунд.","at":"1:10"},{"text":"TTL ограничивает время жизни записи.","at":"2:00"}]}';
    const parsed = parseAiJson(`Схема ответа:\n${schemaEcho}\n\nОтвет:\n${answer}`);
    assert(parsed.ok);
    assertEqual(parsed.strategy, 'blocks');
    assert(parsed.value.tldr.includes('инвалидировать'), parsed.value.tldr);
  });

  it('rejects a cut-off document instead of salvaging one nested array as an answer', () => {
    const cut = '{"tldr":"Кэш ускоряет ответы","keyPoints":[{"text":"TTL ограничивает запись","at":"1:10"},';
    const parsed = parseAiJson(cut);
    assert(!parsed.ok, 'a cut-off answer is not a complete summary');
  });
});

describe('loose coercion', () => {
  it('unwraps a result object and reads Russian field names', () => {
    const payload = coercePayload({
      result: {
        суть: 'Видео о кэшировании и метриках.',
        'Ключевые тезисы': '- Кэш хранит результат дорогой операции.\n- Redis ускорил ответ с 800 до 40 миллисекунд.',
      },
    });
    assertEqual(payload.tldr, 'Видео о кэшировании и метриках.');
    assertEqual(payload.keyPoints.length, 2);
    assertEqual(payload.keyPoints[0].text, 'Кэш хранит результат дорогой операции.');
    assertEqual(payload.points.length, 2, 'the map path and live draft read points directly');
  });

  it('splits a bulleted string, strips markers and reads timecodes', () => {
    const payload = coercePayload({
      points: '1. [0:05] Кэш хранит результат дорогой операции.\n2. [1:10] Redis ускорил ответ с 800 до 40 мс.',
    });
    assertEqual(payload.points.length, 2);
    assertEqual(payload.points[0].at, 5);
    assertEqual(payload.points[1].at, 70);
    assert(!payload.points[1].text.includes('[1:10]'));
  });

  it('keeps section timecodes and does not duplicate section bullets', () => {
    const payload = coercePayload({
      tldr: 'Кэш ускоряет ответы, но требует инвалидации.',
      sections: [
        { heading: 'Кэш', summary: 'Повторное использование узлов убирает лишние проходы.', at: 120 },
        { heading: 'Инвалидация', ts: '3:10', points: ['TTL ограничивает время жизни записи.'] },
      ],
      points: ['TTL ограничивает время жизни записи.'],
    });
    assertEqual(payload.sections[0].at, 120);
    assertEqual(payload.sections[0].ts, '2:00');
    assertEqual(payload.sections[1].at, 190);
    assertEqual(payload.sections[1].points.length, 1);
    assertEqual(payload.keyPoints.length, 0, 'section bullets must not be repeated as key points');
  });

  it('turns markdown prose into sections without inventing facts', () => {
    const prose = [
      'Кэш ускоряет ответы, но требует инвалидации.',
      '',
      '## Стратегии кэширования',
      'Разбираются три подхода: TTL, инвалидация по событию и сквозная запись.',
      '',
      '- TTL ограничивает время жизни записи.',
      '- Инвалидация по событию сбрасывает запись сразу.',
    ].join('\n');
    const payload = proseToPayload(prose);
    assertEqual(payload.sections.length, 1);
    assertEqual(payload.sections[0].heading, 'Стратегии кэширования');
    assertEqual(payload.sections[0].points.length, 2);
    assert(payload.tldr.includes('Кэш ускоряет'));
  });

  it('distinguishes a prose summary from a refusal or a schema echo', () => {
    assert(looksLikeProseAnswer('Кэш ускоряет ответы: Redis сократил задержку с 800 до 40 мс.'));
    assert(!looksLikeProseAnswer('{"tldr":"строка: 2-3 предложения"}'));
    assert(!looksLikeProseAnswer('Извините, я не могу помочь с этим видео.'));
  });
});

describe('client', () => {
  const provider = { ...providerFromPreset('groq'), baseUrl: 'https://api.groq.com/openai/v1' };

  it('builds requests for every api family', () => {
    const openai = buildRequest({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 10, stream: false });
    assertEqual(openai.url, 'https://api.groq.com/openai/v1/chat/completions');
    assertEqual(openai.headers.Authorization, 'Bearer k');
    assertEqual(openai.mode, 'openai-json');

    const google = buildRequest({ provider: providerFromPreset('google'), apiKey: 'g', model: 'gemini-2.5-flash', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], temperature: 0, maxTokens: 10, stream: true });
    assert(google.url.includes(':streamGenerateContent'), google.url);
    assert(google.url.includes('key=g'), google.url);
    assertEqual(google.body.systemInstruction.parts[0].text, 's');
    assertEqual(google.mode, 'google-sse');

    const anthropic = buildRequest({ provider: providerFromPreset('anthropic'), apiKey: 'a', model: 'claude-3-5-haiku-latest', messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 10, stream: false });
    assertEqual(anthropic.url, 'https://api.anthropic.com/v1/messages');
    assertEqual(anthropic.headers['x-api-key'], 'a');
    assertEqual(anthropic.headers['anthropic-dangerous-direct-browser-access'], 'true');

    const ollama = buildRequest({ provider: providerFromPreset('ollama'), apiKey: '', model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 10, stream: true });
    assertEqual(ollama.url, 'http://localhost:11434/api/chat');
    assertEqual(ollama.mode, 'ollama-ndjson');
  });

  it('turns thinking off for Gemini 2.5 Flash so the output budget holds the JSON', () => {
    // Reported bug: a summary request ended twice with TRUNCATED. Gemini 2.5
    // counts thinking tokens against maxOutputTokens, so a flash model spent
    // the whole allowance reasoning and returned MAX_TOKENS with no JSON.
    const flash = buildRequest({
      provider: providerFromPreset('google'),
      apiKey: 'g',
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      maxTokens: 5000,
      stream: false,
    });
    assertEqual(flash.body.generationConfig.thinkingConfig.thinkingBudget, 0);
    assertEqual(flash.body.generationConfig.maxOutputTokens, 5000);

    const lite = buildRequest({
      provider: providerFromPreset('google'),
      apiKey: 'g',
      model: 'models/gemini-2.5-flash-lite',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      maxTokens: 5000,
      stream: false,
    });
    assertEqual(lite.body.generationConfig.thinkingConfig.thinkingBudget, 0);

    // Pro cannot disable thinking; it must not be sent a zero it rejects.
    const pro = buildRequest({
      provider: providerFromPreset('google'),
      apiKey: 'g',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      maxTokens: 5000,
      stream: false,
    });
    assertEqual(pro.body.generationConfig.thinkingConfig.thinkingBudget, 128);

    // Other generations do not accept thinkingConfig at all.
    const old = buildRequest({
      provider: providerFromPreset('google'),
      apiKey: 'g',
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      maxTokens: 5000,
      stream: false,
    });
    assertEqual(old.body.generationConfig.thinkingConfig, undefined);
  });

  it('asks OpenRouter for low reasoning on free reasoning routes only', () => {
    const call = (preset, model) =>
      buildRequest({
        provider: providerFromPreset(preset),
        apiKey: 'k',
        model,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxTokens: 5000,
        stream: false,
      });
    // The free router can land on a thinking model that burns the whole answer
    // budget on reasoning and returns finish_reason=length with no JSON.
    assertEqual(call('openrouter', 'openrouter/free').body.reasoning.effort, 'low');
    assertEqual(call('openrouter', 'qwen/qwen3-235b:free').body.reasoning.effort, 'low');
    // A plain model on the same endpoint is left alone.
    assertEqual(call('openrouter', 'anthropic/claude-3.5-haiku').body.reasoning, undefined);
    // Other OpenAI-compatible endpoints must not receive an unknown field.
    assertEqual(call('groq', 'openrouter/free').body.reasoning, undefined);
  });

  it('streams openai deltas', async () => {
    const { res, calls } = await withFetch(
      () => sseResponse([{ choices: [{ delta: { content: 'При' } }] }, { choices: [{ delta: { content: 'вет' } }] }, { choices: [{ delta: { content: '!' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }]),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, temperature: 0, maxTokens: 20 }),
    );
    assertEqual(res.text, 'Привет!');
    assertEqual(res.usage.completionTokens, 3);
    assertEqual(calls[0].body.stream, true);
  });

  it('reads the reasoning trace when a thinking model sends no visible text', async () => {
    // OpenRouter reports the trace as `reasoning`; the client only knew
    // `reasoning_content`, so an answer that consisted of the JSON inside the
    // reasoning looked like an empty response.
    const plain = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: '', reasoning: '{"tldr":"ok"}' }, finish_reason: 'stop' }] }),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 40 }),
    );
    assertEqual(plain.res.text, '{"tldr":"ok"}');

    const streamed = await withFetch(
      () =>
        sseResponse([
          { choices: [{ delta: { reasoning: '{"tldr":' } }] },
          { choices: [{ delta: { reasoning: '"ok"}' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 8 } },
        ]),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, temperature: 0, maxTokens: 40 }),
    );
    assertEqual(streamed.res.text, '{"tldr":"ok"}');
    assertEqual(streamed.res.usage.completionTokens, 8);
  });

  it('streams google and anthropic and ollama', async () => {
    const google = await withFetch(
      () => sseResponse([{ candidates: [{ content: { parts: [{ text: 'При' }] } }] }, { candidates: [{ content: { parts: [{ text: 'вет' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 } }]),
      () => chat({ provider: providerFromPreset('google'), apiKey: 'k', model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], stream: true, temperature: 0, maxTokens: 20 }),
    );
    assertEqual(google.res.text, 'Привет');
    assertEqual(google.res.usage.promptTokens, 7);

    const anthropic = await withFetch(
      () => sseResponse([{ type: 'content_block_delta', delta: { text: 'При' } }, { type: 'content_block_delta', delta: { text: 'вет' } }]),
      () => chat({ provider: providerFromPreset('anthropic'), apiKey: 'k', model: 'claude-3-5-haiku-latest', messages: [{ role: 'user', content: 'hi' }], stream: true, temperature: 0, maxTokens: 20 }),
    );
    assertEqual(anthropic.res.text, 'Привет');

    const ollama = await withFetch(
      () => ndjsonResponse([{ message: { content: 'При' }, done: false }, { message: { content: 'вет' }, done: true, prompt_eval_count: 9, eval_count: 2 }]),
      () => chat({ provider: providerFromPreset('ollama'), apiKey: '', model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }], stream: true, temperature: 0, maxTokens: 20 }),
    );
    assertEqual(ollama.res.text, 'Привет');
    assertEqual(ollama.res.usage.promptTokens, 9);
  });

  it('aborts a stalled stream instead of eating the whole timeout', async () => {
    // A hung free model (accepted the request, then fell silent) used to pin the
    // run until the full timeout — twice with the default retry, which is the
    // "six minutes and no result" report. The stall watchdog must end the
    // attempt long before the deadline.
    let err = null;
    const t0 = Date.now();
    await withFetch(
      () => hungSseResponse([{ choices: [{ delta: { content: 'час' } }] }]),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, temperature: 0, maxTokens: 20, timeoutMs: 30000, streamStallMs: 60, streamProgressMs: 30000, streamProgressFirstMs: 30000, retries: 0 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'a stalled stream must throw');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.attempts, 1);
    // Way below the 30 s deadline: the watchdog fired after ~60 ms of silence.
    assert(Date.now() - t0 < 5000, `stall abort should be early, took ${Date.now() - t0} ms`);
  });

  it('finishes a slow but alive stream: the stall timer resets on every byte', async () => {
    const { res } = await withFetch(
      () => dripSseResponse([{ choices: [{ delta: { content: 'При' } }] }, { choices: [{ delta: { content: 'вет' } }] }], 60),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 300, retries: 0 }),
    );
    assertEqual(res.text, 'Привет');
  });

  it('cuts a keepalive-only stream: comments keep the transport alive, but never pass for progress', async () => {
    // The old watchdog reset on every byte, so a hung model politely streaming
    // `: keepalive` comments masked its dead generation until the full
    // timeout — twice with a retry. Comments prove liveness, not progress:
    // the first-content window must end the attempt.
    let err = null;
    const t0 = Date.now();
    await withFetch(
      () => keepaliveOnlySse(15),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 30000, streamProgressMs: 100, streamProgressFirstMs: 80, retries: 0 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'a keepalive-only hang must throw');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.attempts, 1);
    assert(/generation-not-started/i.test(err.detail || ''), `detail should name generation-not-started, got: ${err.detail}`);
    const took = Date.now() - t0;
    assert(took >= 70, `watchdog must honour the first-content window, took ${took} ms`);
    assert(took < 5000, `keepalive comments must not mask the hang, took ${took} ms`);
  });

  it('cuts a mid-generation freeze even when keepalive comments keep coming', async () => {
    // Transport and progress are separate clocks: after real deltas started,
    // bytes alone (comments) must not keep the attempt alive.
    let err = null;
    const t0 = Date.now();
    await withFetch(
      () => frozenAfterContentSse([{ choices: [{ delta: { content: 'час' } }] }], 15),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 30000, streamProgressMs: 80, retries: 0 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'a frozen generation must throw');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.attempts, 1);
    assert(/progress-stalled/i.test(err.detail || ''), `detail should name progress-stalled, got: ${err.detail}`);
    const took = Date.now() - t0;
    assert(took >= 70, `watchdog must honour the progress window, took ${took} ms`);
    assert(took < 5000, `a mid-generation freeze must not last the whole timeout, took ${took} ms`);
  });

  it('finishes slow real generation padded with keepalive comments', async () => {
    const { res } = await withFetch(
      () => drippingSse([{ choices: [{ delta: { content: 'При' } }] }, { choices: [{ delta: { content: 'вет' } }] }], 60),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 300, streamProgressMs: 300, retries: 0 }),
    );
    assertEqual(res.text, 'Привет');
  });

  it('does not abort a long thinking phase that streams only keepalive comments', async () => {
    // “Не применяй короткий таймаут прогресса к долгому обдумыванию”: the
    // first-content window is the generous one, so 400 ms of keepalive-only
    // bytes still completes. The transport window is wide on purpose — this
    // test exercises the progress clock, not the byte clock.
    const { res } = await withFetch(
      () => drippingSse([{ choices: [{ delta: { content: 'При' } }] }, { choices: [{ delta: { content: 'вет' } }] }], 60, { leadMs: 400 }),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 3000, streamProgressMs: 300, streamProgressFirstMs: 1500, retries: 0 }),
    );
    assertEqual(res.text, 'Привет');
  });

  it('reasoning deltas count as generation progress', async () => {
    // A reasoning model that streams its trace emits content events: each one
    // must reset the progress watchdog (gaps 190 ms just under the 200 ms
    // window would abort before the second delta without a reset).
    const { res } = await withFetch(
      () => drippingSse([{ choices: [{ delta: { reasoning: 'думаю' } }] }, { choices: [{ delta: { reasoning: '…' } }] }], 190),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 300, streamProgressMs: 200, streamProgressFirstMs: 200, retries: 0 }),
    );
    assertEqual(res.text, 'думаю…');
  });

  it('keeps the total timeout authoritative over the first-content window', async () => {
    let err = null;
    await withFetch(
      () => keepaliveOnlySse(15),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 200, streamStallMs: 30000, streamProgressMs: 5000, streamProgressFirstMs: 5000, retries: 0 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'the total deadline must fire');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.detail, 'timeout');
  });

  it('retries a watchdog-killed attempt and finishes on the next one', async () => {
    let call = 0;
    const { res, calls } = await withFetch(
      () => {
        call++;
        if (call === 1) return frozenAfterContentSse([{ choices: [{ delta: { content: 'зам' } }] }], 15);
        return sseResponse([{ choices: [{ delta: { content: 'Ответ' } }] }, { choices: [{ delta: { content: ' готов' } }] }]);
      },
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 30000, streamProgressMs: 80, retries: 1 }),
    );
    assertEqual(res.text, 'Ответ готов');
    assertEqual(calls.length, 2);
    assertEqual(res.attempts, 2);
  });

  it('caps the worst case: two silent attempts plus retry backoff stay bounded', async () => {
    // retries: 1 with a fully silent upstream: attempt 1 dies at the transport
    // window, then 700 ms of backoff, then attempt 2 dies the same way —
    // documented worst case ≈ transportMs + backoff + transportMs.
    let err = null;
    const t0 = Date.now();
    await withFetch(
      () => hungSseResponse([]),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 60, retries: 1 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'a fully silent stream must throw');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.attempts, 2, 'both attempts must run');
    assert(/transport-stalled/i.test(err.detail || ''), `final detail should name transport-stalled, got: ${err.detail}`);
    const took = Date.now() - t0;
    assert(took < 5000, `two silent attempts must stay bounded, took ${took} ms`);
  });

  it('adds bounded jitter without ever shortening Retry-After', () => {
    assertEqual(retryBackoffMs(1, 0, () => 0), 700, 'the first retry starts at the base wait');
    const jittered = retryBackoffMs(1, 0, () => 0.999);
    assert(jittered > 700 && jittered <= 900, `jitter must stay bounded, saw ${jittered}`);
    assertEqual(retryBackoffMs(1, 15000, () => 0), 15000, 'a provider Retry-After is a floor');
    assert(retryBackoffMs(1, 15000, () => 0.5) >= 15000, 'jitter must not undercut Retry-After');
    assertEqual(retryBackoffMs(12, 0, () => 0), 45000, 'the cap is absolute');
    assert(retryBackoffMs(12, 0, () => 0.9) <= 45000, 'jitter must not exceed the cap');
  });

  it('documents the per-operation budget: one full generation plus one retry and wait', () => {
    // Defaults (90 s, retries: 1): 90 + 45 + 90 = 225 s, instead of 3 attempts
    // plus two 45 s waits (360 s) when a provider keeps answering 429.
    assertEqual(operationBudgetMs(90000), 225000);
    assertEqual(operationBudgetMs(120000), 285000);
    assertEqual(operationBudgetMs(0), 0, 'no per-attempt deadline means no derived budget');
  });

  it('treats a byte-silent thinking phase as dead transport once the transport window ends', async () => {
    // Intentional limitation: with zero bytes there is nothing to distinguish
    // “the model is thinking” from “the socket died”, so the 45 s transport
    // clock wins over the generous 150 s first-content window. This test pins
    // that precedence (progressFirstMs is wide on purpose here).
    let err = null;
    const t0 = Date.now();
    await withFetch(
      () => hungSseResponse([]),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 80, streamProgressMs: 30000, streamProgressFirstMs: 5000, retries: 0 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'a silent stream must throw');
    assertEqual(err.code, 'TIMEOUT');
    assert(/transport-stalled/i.test(err.detail || ''), `expected transport-stalled, got: ${err.detail}`);
    assert(Date.now() - t0 < 1500, 'the transport clock must fire long before the first-content window');
  });

  it('does not start a retry after the operation deadline is spent', async () => {
    let err = null;
    const t0 = Date.now();
    const { calls } = await withFetch(
      () => hungSseResponse([]),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 120, totalTimeoutMs: 150, streamStallMs: 30000, retries: 3 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'an exhausted budget must throw');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.detail, 'operation-deadline');
    assertEqual(err.retryable, false, 'an exhausted budget must not invite more retries');
    assertEqual(err.attempts, 1);
    assertEqual(calls.length, 1, 'no request may be sent after the operation deadline');
    assert(Date.now() - t0 < 1500, 'the budget must fail fast instead of sleeping into the deadline');
  });

  it('fails fast instead of sleeping a Retry-After that would outlive the deadline', async () => {
    let err = null;
    const retries = [];
    const { calls } = await withFetch(
      () => new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '60' } }),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, ...shortChatOptions, timeoutMs: 5000, totalTimeoutMs: 4000, retries: 3, onRetry: (r) => retries.push(r) });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'the operation must end');
    assertEqual(err.detail, 'operation-deadline');
    assertEqual(calls.length, 1, 'a wait that cannot finish in budget must not fire another request');
    assertEqual(retries.length, 0, 'onRetry must not announce a wait that will never happen');
  });

  it('stops during a retry wait on cancel, without a second request', async () => {
    const controller = new AbortController();
    let err = null;
    const t0 = Date.now();
    const { calls } = await withFetch(
      () => new Response('{"error":{"message":"boom"}}', { status: 500 }),
      async () => {
        setTimeout(() => controller.abort(new Error('cancelled')), 60);
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, ...shortChatOptions, timeoutMs: 5000, signal: controller.signal, retries: 3 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'a cancelled run must reject');
    assertEqual(err.attempts, 1);
    assertEqual(calls.length, 1, 'cancel during backoff must not fire a retry');
    assert(Date.now() - t0 < 2000, 'cancel must not wait out the full backoff');
  });

  it('gives the first live generation the full per-attempt timeout', async () => {
    // The operation budget is 450 ms here; the first attempt still gets its own
    // 400 ms instead of being clipped to a fraction of it.
    const { res } = await withFetch(
      () => dripSseResponse([{ choices: [{ delta: { content: 'При' } }] }, { choices: [{ delta: { content: 'вет' } }] }], 90),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 400, totalTimeoutMs: 450, streamStallMs: 3000, retries: 0 }),
    );
    assertEqual(res.text, 'Привет');
    assertEqual(res.attempts, 1);
  });

  it('keeps the free-tier 429 retry while its wait fits the operation budget', async () => {
    let call = 0;
    const { res, calls } = await withFetch(
      () => {
        call++;
        if (call === 1) return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0.05' } });
        return sseResponse([{ choices: [{ delta: { content: 'Ответ' } }] }]);
      },
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 3000, totalTimeoutMs: 8000, retries: 0 }),
    );
    assertEqual(calls.length, 2, 'the extra 429 attempt must survive the budget');
    assertEqual(res.text, 'Ответ');
    assertEqual(res.attempts, 2);
  });

  it('inherits an absolute deadline instead of starting a fresh call budget', async () => {
    // A parent operation (job or fallback chain) passes one epoch deadline. The
    // attempt may use only the remaining time, and the retry wait cannot exceed
    // it; the error names the parent budget, not a stream hang.
    let err = null;
    const t0 = Date.now();
    const { calls } = await withFetch(
      () => hungSseResponse([]),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 5000, deadlineAt: Date.now() + 150, retries: 5 });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'the inherited deadline must end the call');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.detail, 'job-deadline');
    assertEqual(err.retryable, false);
    assertEqual(calls.length, 1, 'no retry may outlive the parent deadline');
    assert(Date.now() - t0 < 2000, `the call must stop near the inherited deadline, took ${Date.now() - t0} ms`);
  });

  it('keeps the deadline reason when the fetch rejects before the wall clock agrees', async () => {
    // Regression: a provider that rejects synchronously on abort reaches the
    // catch block a moment before the recorded deadline instant, so a
    // wall-clock-only check reported a generic "aborted" detail.
    let err = null;
    const controller = new AbortController();
    const { calls } = await withFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) return onAbort();
          init.signal?.addEventListener('abort', onAbort, { once: true });
          // The parent clock aborts with its own reason well before the
          // deadline instant this call was given.
          setTimeout(() => controller.abort(new Error('job-deadline')), 40);
          void resolve;
        }),
      async () => {
        try {
          await chat({
            provider,
            apiKey: 'k',
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            ...shortChatOptions,
            timeoutMs: 5000,
            deadlineAt: Date.now() + 5000,
            retries: 5,
            signal: controller.signal,
          });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'the aborted call must throw');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.detail, 'job-deadline');
    assertEqual(calls.length, 1, 'a deadline abort must not issue another request');
  });

  it('does not sleep a Retry-After past an inherited deadline', async () => {
    let err = null;
    const retries = [];
    const { calls } = await withFetch(
      () => new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '30' } }),
      async () => {
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, ...shortChatOptions, timeoutMs: 5000, deadlineAt: Date.now() + 250, retries: 3, onRetry: (r) => retries.push(r) });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'the inherited budget must fail fast');
    assertEqual(err.detail, 'job-deadline');
    assertEqual(calls.length, 1);
    assertEqual(retries.length, 0, 'no wait is announced when it cannot fit');
  });

  it('ends an already-cancelled request after a single attempt: no retries against a dead signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls } = await withFetch(
      () => hungSseResponse([{ choices: [{ delta: { content: 'час' } }] }]),
      async () => {
        let err = null;
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true, ...shortChatOptions, timeoutMs: 30000, streamStallMs: 30000, signal: controller.signal, retries: 3 });
        } catch (e) {
          err = e;
        }
        assert(err, 'a cancelled request must end with an error');
        assertEqual(err.attempts, 1);
      },
    );
    assertEqual(calls.length, 1);
  });

  it('retries without response_format when the provider rejects it', async () => {
    let call = 0;
    const { res, calls } = await withFetch(
      () => {
        call++;
        if (call === 1) return jsonResponse({ error: { message: 'response_format is not supported' } }, 400);
        return jsonResponse({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3 } });
      },
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], jsonMode: true, stream: false, temperature: 0, maxTokens: 20 }),
    );
    assertEqual(res.text, '{"ok":true}');
    assertEqual(calls.length, 2);
    assertEqual(calls[0].body.response_format.type, 'json_object');
    assert(!calls[1].body.response_format, 'second attempt must drop response_format');
  });

  it('maps auth, model and rate-limit errors to actionable codes', () => {
    assertEqual(mapHttpError(401, '{"error":{"message":"bad key"}}', provider).code, 'AUTH');
    assertEqual(mapHttpError(404, '{}', provider).code, 'MODEL_NOT_FOUND');
    assertEqual(mapHttpError(429, '{}', provider).code, 'RATE_LIMIT');
    assertEqual(mapHttpError(402, '{}', provider).code, 'BILLING');
    assertEqual(mapHttpError(500, '{}', provider).code, 'SERVER');
    const ctxErr = mapHttpError(400, '{"error":{"message":"maximum context length is 8192 tokens"}}', provider);
    assertEqual(ctxErr.code, 'CONTEXT_LENGTH');
    assert(ctxErr.hint.length > 10, 'errors must carry a human hint');
  });

  it('maps a provider safety refusal to SAFETY, never to BAD_JSON', async () => {
    // OpenRouter writes its moderation verdict as plain text with a 200 answer:
    // “User Safety: unsafe / Response Safety: unsafe / Safety Categories: …”.
    const refusal =
      'User Safety: unsafe\nResponse Safety: unsafe\nSafety Categories: Violence, Profanity, Political/Misinformation/Conspiracy';
    assertEqual(mapHttpError(403, JSON.stringify({ error: { message: refusal } }), provider).code, 'SAFETY');
    assertEqual(
      mapHttpError(400, JSON.stringify({ error: { message: refusal } }), provider).code,
      'SAFETY',
      'a moderation verdict is not an auth or a format problem',
    );
    const { calls } = await withFetch(
      () =>
        jsonResponse({
          choices: [{ message: { content: refusal }, finish_reason: 'content_filter' }],
        }),
      async () => {
        let threw = null;
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, retries: 0 });
        } catch (err) {
          threw = err;
        }
        assert(threw, 'a refusal must throw');
        assertEqual(threw.code, 'SAFETY');
        assert(threw.hint.length > 20, 'the refusal must explain what to do');
        return threw;
      },
    );
    assertEqual(calls.length, 1, 'a refusal must not be retried or “repaired”');

    // The safety classifier itself can be routed as the model: “User Safety:
    // safe” is a useless answer, not a refusal.
    // `withFetch` resolves to `{ res, calls }`: the error itself is `res`.
    const { res: safeVerdict } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: 'User Safety: safe' }, finish_reason: 'stop' }] }),
      async () => {
        let threw = null;
        try {
          await chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, retries: 0 });
        } catch (err) {
          threw = err;
        }
        return threw;
      },
    );
    assert(safeVerdict, 'a non-JSON verdict must still be an error');
    assert(safeVerdict.code !== 'SAFETY', `“safe” must not be reported as a refusal, got ${safeVerdict.code}`);
    assertEqual(
      safeVerdict.code,
      'MISROUTED_MODEL',
      'a classifier verdict must not read as “the model answered with text, not JSON”',
    );

    // A real answer about moderation is still JSON, not a refusal.
    const legit = JSON.stringify({ points: [{ text: 'Content policy and moderation of comments.', at: '0:10' }] });
    const ok = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: legit }, finish_reason: 'stop' }] }),
      () => chat({ provider, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false, retries: 0 }),
    );
    assertEqual(ok.res.text, legit, 'a JSON answer mentioning moderation must not be flagged');
  });

  it('recognizes the one-line classifier verdict and retries it as a wrong route', async () => {
    // Live run: the free router dispatched the request to a guard model, which
    // answered exactly “User Safety: safe”. The old detector required the
    // multi-line verdict, so the answer reached the JSON parser and the user saw
    // “Модель ответила текстом без JSON” with a hint to change the model — while
    // a plain retry would have landed on a writing model.
    let calls = 0;
    const { res } = await withFetch(
      () => {
        calls++;
        const content = calls === 1 ? 'User Safety: safe' : JSON.stringify(SUMMARY_JSON);
        return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
      },
      () =>
        chat({
          provider: providerFromPreset('openrouter'),
          apiKey: 'k',
          model: 'openrouter/free',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
          retries: 1,
        }),
    );
    assertEqual(calls, 2, 'a one-line verdict must be retried');
    assert(res.text.includes('"tldr"'), 'the retry must return the real summary');
  });

  it('retries when the free router answers with a safety classifier instead of a summary', async () => {
    // Live 3-hour run: openrouter/free dispatched the transcript to a content-
    // safety model, which answered “User Safety: unsafe / Response Safety: …”
    // to every request. Treating that as a final refusal lost the run, although
    // the next route almost always is a writing model. Verdict shape ≠ refusal.
    const verdict =
      'User Safety: unsafe\nResponse Safety: unsafe\nSafety Categories: Violence, Profanity, Political/Misinformation/Conspiracy';
    let calls = 0;
    const { res } = await withFetch(
      () => {
        calls++;
        const content = calls === 1 ? verdict : JSON.stringify(SUMMARY_JSON);
        return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
      },
      () =>
        chat({
          provider: providerFromPreset('openrouter'),
          apiKey: 'k',
          model: 'openrouter/free',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
          retries: 1,
        }),
    );
    assertEqual(calls, 2, 'a classifier verdict must be retried on the router');
    assert(res.text.includes('"tldr"'), 'the retry must return the real summary');

    // With no retries left it is still a provider problem (the route was wrong),
    // not a SAFETY refusal: the panel must not tell the user their video was
    // blocked when it was merely sent to the wrong model.
    let threw = null;
    try {
      await withFetch(
        () => jsonResponse({ choices: [{ message: { content: verdict }, finish_reason: 'stop' }] }),
        () =>
          chat({ provider: providerFromPreset('openrouter'), apiKey: 'k', model: 'openrouter/free', messages: [{ role: 'user', content: 'hi' }], stream: false, retries: 0 }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'the verdict must still be an error');
    assertEqual(threw.code, 'MISROUTED_MODEL');
    assertEqual(threw.retryable, true, 'another model is worth trying');
    assertEqual(threw.code === 'SAFETY', false, 'a misrouted answer is not a content refusal');
  });

  it('surfaces an error object that arrives with HTTP 200', async () => {
    // OpenRouter answers with `error` in the body on some failures; treating it
    // as “the model said nothing” hid the cause behind EMPTY_RESPONSE.
    let threw = null;
    try {
      await withFetch(
        () => jsonResponse({ error: { code: 404, message: 'No allowed providers are available' } }),
        () => chat({ provider, apiKey: 'k', model: 'openrouter/free', messages: [{ role: 'user', content: 'hi' }], stream: false, retries: 0 }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'an error body must throw');
    assertEqual(threw.code, 'PROVIDER_ERROR');
    assert(threw.message.includes('No allowed providers'), threw.message);
    assert(threw.hint, 'the error must carry a hint');
  });

  it('fails fast when the api key is missing', async () => {
    let threw = null;
    try {
      await chat({ provider: { ...provider, local: false }, apiKey: '', model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    } catch (err) {
      threw = err;
    }
    assert(threw && threw.code === 'NO_KEY', 'expected NO_KEY error');
  });

  it('lists models from openai and google shapes', async () => {
    const openai = await withFetch(() => jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'text-embedding-3' }] }), () => listModels({ provider, apiKey: 'k' }));
    assertEqual(openai.res.length, 1);
    assertEqual(openai.res[0], 'llama-3.3-70b-versatile');

    const google = await withFetch(
      () => jsonResponse({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] }),
      () => listModels({ provider: providerFromPreset('google'), apiKey: 'k' }),
    );
    assertEqual(google.res.length, 1);
    assertEqual(google.res[0], 'gemini-2.5-flash');
  });

  it('tests a provider end to end', async () => {
    const { res } = await withFetch(() => jsonResponse({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }] }), () =>
      testProvider({ provider, apiKey: 'k', model: 'llama-3.3-70b-versatile' }),
    );
    assert(res.ok);
    assertEqual(res.sample, 'pong');
    assertEqual(res.host, 'api.groq.com');
  });
});

describe('pipeline', () => {
  const provider = providerFromPreset('groq');
  const segments = ruTranscript();
  const metaInfo = meta({ lengthSeconds: 150 });

  it('summarises in a single request', async () => {
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 200 } }),
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'auto', stream: false },
          output: { language: 'auto', length: 'standard' },
          uiLang: 'ru',
        }),
    );
    assertEqual(res.strategy, 'single');
    assertEqual(res.result.mode, 'ai');
    assertEqual(res.result.provider, provider.name);
    assertEqual(res.result.keyPoints[0].at, 5);
    assertEqual(res.result.keyPoints[0].ts, '0:05');
    assertEqual(res.result.sections[0].points[0].text.startsWith('TTL'), true);
    assert(res.result.stats.aiTokensIn === 100);
    assertEqual(calls.length, 1);
    assert(calls[0].url.includes('api.groq.com'), 'must call the configured provider');
    // the prompt carries the transcript and the timestamp markers
    assert(calls[0].body.messages[1].content.includes('[0:00]'));
    const sys = calls[0].body.messages[0].content;
    assert(sys.includes('OpenSummary'), 'system prompt must be the summarizer prompt');
    assert(!sys.includes('Приветствую вас'), 'transcript must not leak into the system prompt');
  });

  it('accepts a wrapped answer with Russian field names in one request', async () => {
    const weakAnswer = {
      result: {
        суть: 'Видео о кэшировании и метриках.',
        тезисы: '- Кэш хранит результат дорогой операции.\n- Redis ускорил ответ с 800 до 40 миллисекунд.',
      },
    };
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify(weakAnswer) }, finish_reason: 'stop' }] }),
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'single', stream: false, retries: 0 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(calls.length, 1, 'a wrapped answer needs no repair call');
    assert(res.result.tldr.includes('кэшировании'), res.result.tldr);
    assertEqual(res.result.keyPoints.length, 2);
  });

  it('accepts a Markdown answer instead of failing on non-JSON', async () => {
    const prose = [
      'Кэш ускоряет ответы, но требует инвалидации.',
      '',
      '## Стратегии кэширования',
      'Разбираются три подхода: TTL, инвалидация по событию и сквозная запись.',
      '',
      '- TTL ограничивает время жизни записи.',
      '- Инвалидация по событию сбрасывает запись сразу.',
    ].join('\n');
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: prose }, finish_reason: 'stop' }] }),
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'single', stream: false, retries: 0 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(calls.length, 1, 'prose must not trigger a repair request');
    assertEqual(res.result.mode, 'ai');
    assertEqual(res.result.sections[0].heading, 'Стратегии кэширования');
    assertEqual(res.result.sections[0].points.length, 2);
  });

  it('uses the prose answer of a repair call instead of failing the run', async () => {
    let call = 0;
    const { res, calls } = await withFetch(
      () => {
        call++;
        const content = call === 1
          ? '{"tldr": "Кэш ускоряет ответы, но требует инвалидации'
          : 'Кэш ускоряет ответы.\n\n## Инвалидация\nБез сброса записей кэш опаснее, чем его отсутствие.';
        return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'single', stream: false, retries: 0 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(calls.length, 2, 'the broken JSON must be repaired once');
    assertEqual(res.result.sections[0].heading, 'Инвалидация');
  });

  it('raises an output budget that is too small for the JSON schema', async () => {
    // The reported bug: “Максимум токенов ответа” at 2500 cut a standard summary
    // mid-JSON, the repair call returned empty fields and the user waited
    // minutes for a result with no TL;DR and no key points. The request must
    // carry a budget the schema actually fits into, in one call.
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        if (body.max_tokens < 5000) {
          return jsonResponse({ choices: [{ message: { content: '{"tldr":"обр' }, finish_reason: 'length' }] });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'single', stream: false, retries: 0, maxOutputTokens: 2500 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(calls.length, 1, 'one request must be enough for a standard summary');
    assertEqual(calls[0].body.max_tokens, 5000, 'the budget must fit the standard profile');
    assert(res.result.keyPoints.length > 0);
  });

  it('chooses an initial output budget from the actual transcript size', () => {
    const short = initialOutputBudget({ length: 'standard', transcriptTokens: 3000, configured: 4096 });
    const long = initialOutputBudget({ length: 'standard', transcriptTokens: 30000, configured: 4096 });
    const huge = initialOutputBudget({ length: 'detailed', transcriptTokens: 200000, configured: 4096 });
    assertEqual(short, 5000, 'a short transcript keeps the standard base budget, which now fits the schema');
    assert(long > 5000, `a long transcript needs a bigger initial budget, got ${long}`);
    assert(long <= 16000, 'the initial budget must stay bounded');
    assert(huge > 8192 && huge <= 16000, `a detailed summary of a huge transcript grows past the old 8192 ceiling, got ${huge}`);
    assertEqual(
      initialOutputBudget({ length: 'short', transcriptTokens: 200000, configured: 0 }),
      2048,
      'the short format must not pay for a long-video cushion',
    );
  });

  it('sizes one reduce request from the model context, not the map chunk size', () => {
    assertEqual(
      reduceInputBudget({ contextTokens: 128000, chunkTokens: 6000, maxOutputTokens: 4096 }),
      121904,
      'a large context must allow all map notes in one assembly',
    );
    assert(
      reduceInputBudget({ contextTokens: 128000, chunkTokens: 6000, maxOutputTokens: 4096 }) > 6000,
      'the old chunk-sized bound made three-hour videos take an extra reduce round',
    );
    assertEqual(
      reduceInputBudget({ contextTokens: 8192, chunkTokens: 6000, maxOutputTokens: 4096 }),
      2096,
      'a small context must leave room for the reduce prompt and the answer',
    );
    assertEqual(reduceInputBudget({ contextTokens: 4000 }), 1500, 'the floor still allows a tiny assembly');
    assertEqual(
      reduceInputBudget({ contextTokens: 128000, maxOutputTokens: 16384 }),
      121904,
      'the answer reserve is capped: a huge output setting must not shrink the input budget forever',
    );
  });

  it('does not reserve a hierarchical reduce round when the notes fit the context', () => {
    // 27 chunks × 260 tokens ≈ 7k, which fits a 128k window in one request.
    const call = 225000; // operationBudgetMs(90000)
    assertEqual(reduceAllowanceMs(27, { contextTokens: 128000, chunkTokens: 6000, timeoutMs: 90000 }), 2 * call);
    // The old chunk-sized bound planned one extra round of two calls.
    assert(reduceAllowanceMs(27, { contextTokens: 8192, chunkTokens: 6000, timeoutMs: 90000 }) > 2 * call);
  });

  it('retries a truncated single answer with a bigger output budget', async () => {
    const events = [];
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        // A reasoning model that ignores the budget and burns it all on
        // thinking: no text, length stop.
        if (body.max_tokens < 8192) {
          return jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'single', stream: false, retries: 0, maxOutputTokens: 4096 },
          output: { length: 'standard' },
          uiLang: 'ru',
          onProgress: (e) => events.push(e),
        }),
    );
    assertEqual(calls.length, 2, 'the single call must be retried once');
    assertEqual(calls[0].body.max_tokens, 5000);
    assert(calls[1].body.max_tokens > 5000, `the retry must use a bigger budget, got ${calls[1].body.max_tokens}`);
    assert(res.result.keyPoints.length > 0, 'the retry must produce a summary');
    assert(
      res.warnings.some((w) => w.includes('лимит')),
      `the user must be told about the retry: ${JSON.stringify(res.warnings)}`,
    );
    assert(events.some((e) => e.stage === 'fallback'), 'progress must report the retry');
    assert(
      !res.result.notes.some((n) => /лимит|повтор/i.test(n)),
      'operational retry messages must stay out of the exported summary',
    );
  });

  it('fails with EMPTY_RESULT instead of saving a summary without TL;DR or points', async () => {
    // A cut-off model can still return valid JSON with empty fields. That used
    // to be cached and rendered as a finished run with nothing in it.
    let threw = null;
    const sent = [];
    try {
      await withFetch(
        (url, init) => {
          sent.push(JSON.parse(init.body));
          return jsonResponse({ choices: [{ message: { content: '{"tldr":"","keyPoints":[]}' }, finish_reason: 'stop' }] });
        },
        () =>
          runAiSummary({
            segments,
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: { strategy: 'single', stream: false, retries: 0, maxOutputTokens: 4096 },
            output: {},
            uiLang: 'ru',
          }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'an empty summary must fail the run');
    assertEqual(threw.code, 'EMPTY_RESULT');
    assert(threw.hint, 'the error must carry a hint');
    // The full request plus exactly one compact retry — not the old chain of
    // repeat-repair-repeat that kept the user waiting for minutes.
    assertEqual(sent.length, 2, `expected two requests, got ${sent.length}`);
  });

  it('accepts a snake_case answer instead of calling it empty', async () => {
    // The auto-routed free model answered with `summary` / `key_points` /
    // `chapters`; resultSubstance only knew camelCase, so a good summary was
    // discarded and replaced with a smaller retry that failed as well.
    const snake = {
      summary: 'Видео о том, как школьник построил бизнес на мармеладе.',
      key_points: [
        { text: 'Первая партия мармелада стоила пять тысяч рублей.', at: '0:39' },
        { text: 'Наценка на коробку достигает четырёхсот процентов.', at: '0:59' },
      ],
      chapters: [{ title: 'Начало', time: '0:20', bullets: [{ text: 'Гриша родился в простой семье.', time: '0:20' }] }],
      keywords: ['мармелад', { term: 'наценка', score: 0.7 }],
    };
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify(snake) }, finish_reason: 'stop' }] }),
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'openrouter/free',
          aiSettings: { strategy: 'single', stream: false, retries: 0, maxOutputTokens: 4096 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(calls.length, 1, `a usable answer must not be retried, got ${calls.length} calls`);
    assert(res.result.tldr.includes('мармеладе'), res.result.tldr);
    assert(res.result.keyPoints.length >= 2, JSON.stringify(res.result.keyPoints));
    assert(res.result.sections.length >= 1, 'chapters must become sections');
  });

  it('keeps the original error when the escalated retry fails too', async () => {
    let threw = null;
    try {
      await withFetch(
        () => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
        () =>
          runAiSummary({
            segments,
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: { strategy: 'single', stream: false, retries: 0, maxOutputTokens: 2500 },
            output: {},
            uiLang: 'ru',
          }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'the run must fail');
    assertEqual(threw.code, 'TRUNCATED');
  });

  it('retries an empty answer once in a compact form instead of repeating the big request', async () => {
    // The reported bug: a free model answered with nothing, the run repeated the
    // same huge request twice and the user waited minutes for an error card.
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        if (body.max_tokens > 1600) return jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'single', stream: true, retries: 0, maxOutputTokens: 4096 },
          output: { length: 'standard' },
          uiLang: 'ru',
        }),
    );
    assertEqual(calls.length, 2, `expected one compact retry, got ${calls.length} calls`);
    assert(calls[1].body.max_tokens <= 1600, `the retry must be small, got ${calls[1].body.max_tokens}`);
    assertEqual(calls[1].body.stream, undefined, 'the compact retry must not stream');
    assert(
      calls[1].body.messages[0].content.includes('"keyPoints"') && !calls[1].body.messages[0].content.includes('takeaways'),
      'the compact retry must ask for the simplified schema, not the full one',
    );
    assert(res.result.keyPoints.length > 0, 'the compact retry must produce a summary');
    assert(
      res.warnings.some((w) => w.includes('пустой')),
      `the user must be told about the retry: ${JSON.stringify(res.warnings)}`,
    );
  });

  it('reports EMPTY_RESPONSE with a hint and does not repair an empty answer', async () => {
    let threw = null;
    const sent = [];
    try {
      await withFetch(
        (url, init) => {
          sent.push(JSON.parse(init.body));
          return jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
        },
        () =>
          runAiSummary({
            segments,
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: { strategy: 'single', stream: false, retries: 0, maxOutputTokens: 4096 },
            output: {},
            uiLang: 'ru',
          }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'an empty answer must fail the run');
    assertEqual(threw.code, 'EMPTY_RESPONSE');
    assert(threw.hint, 'the error must carry a hint');
    // The empty answer plus its single compact retry — no JSON “repair” call.
    assertEqual(sent.length, 2, `an empty answer must not trigger repair calls, got ${sent.length}`);
  });

  it('retries a truncated chunk with a bigger budget in map-reduce', async () => {
    const long = longTranscript(500);
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const content = body.messages[body.messages.length - 1].content;
        const isMap = content.includes('Транскрипт фрагмента');
        if (isMap) {
          if (body.max_tokens <= 2500) {
            return jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
          }
          return jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    points: [{ text: 'Тезис из фрагмента про производительность.', at: '0:10' }],
                    topics: ['производительность'],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: long,
          meta: meta({ lengthSeconds: 3600 }),
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'auto', contextTokens: 4000, chunkTokens: 1200, concurrency: 2, stream: false, retries: 0, maxOutputTokens: 2500 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(res.strategy, 'map-reduce');
    const mapCalls = calls.filter((c) => c.body.messages[c.body.messages.length - 1].content.includes('Транскрипт фрагмента'));
    assert(mapCalls.length > res.plan.chunks.length, 'every chunk must have been retried with a bigger budget');
    assert(mapCalls.some((c) => c.body.max_tokens > 1200), 'the retry must raise the budget');
    assert(
      !res.warnings.some((w) => w.includes('не обработан')),
      `no chunk should be lost: ${JSON.stringify(res.warnings)}`,
    );
  });

  it('retries a chunk that answers with the schema instead of a summary', async () => {
    const long = longTranscript(500);
    const echo = JSON.stringify({ points: [{ text: 'тезис 8-25 слов', at: 'mm:ss' }], topics: ['тема'] });
    const partial = JSON.stringify({
      points: [{ text: 'Кэширование ускоряет чтение и снижает нагрузку на базу данных.', at: '0:10' }],
      topics: ['кэширование'],
    });
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const content = body.messages[body.messages.length - 1].content;
        if (content.includes('Транскрипт фрагмента')) {
          const reminded = body.messages[0].content.includes('предыдущая попытка');
          return jsonResponse({ choices: [{ message: { content: reminded ? partial : echo }, finish_reason: 'stop' }] });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: long,
          meta: meta({ lengthSeconds: 3600 }),
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'auto', contextTokens: 4000, chunkTokens: 1200, concurrency: 2, stream: false, retries: 0, maxOutputTokens: 2500 },
          output: {},
          uiLang: 'ru',
        }),
    );
    const mapCalls = calls.filter((c) => c.body.messages[c.body.messages.length - 1].content.includes('Транскрипт фрагмента'));
    assert(mapCalls.length > res.plan.chunks.length, 'an echoed chunk must be asked again');
    assert(
      !res.warnings.some((w) => w.includes('не содержит конспекта')),
      `the retry must save the fragment: ${JSON.stringify(res.warnings)}`,
    );
    assert(
      res.result.keyPoints.every((p) => !/тезис 8-25|^тема$/i.test(p.text)),
      `schema placeholders leaked: ${JSON.stringify(res.result.keyPoints)}`,
    );
  });

  it('fails clearly when every chunk only echoes the schema', async () => {
    const long = longTranscript(500);
    const echo = JSON.stringify({ points: [{ text: 'тезис 8-25 слов', at: 'mm:ss' }], topics: ['тема'] });
    let threw = null;
    try {
      await withFetch(
        () => jsonResponse({ choices: [{ message: { content: echo }, finish_reason: 'stop' }] }),
        () =>
          runAiSummary({
            segments: long,
            meta: meta({ lengthSeconds: 3600 }),
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: { strategy: 'auto', contextTokens: 4000, chunkTokens: 1200, concurrency: 2, stream: false, retries: 0, maxOutputTokens: 2500 },
            output: {},
            uiLang: 'ru',
          }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'an all-placeholder answer must not be saved as a summary');
    assertEqual(threw.code, 'MAP_FAILED');
    assert(/не содержит конспекта/.test(threw.hint || ''), `hint must name the cause: ${threw.hint}`);
  });

  it('reports a truncated single answer with an actionable message', async () => {
    let threw = null;
    try {
      await withFetch(
        () => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
        () =>
          chat({
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: 'привет' }],
            stream: false,
            maxTokens: 2500,
          }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'an empty truncated answer must throw');
    assertEqual(threw.code, 'TRUNCATED');
    assert(/лимит/i.test(threw.message), `message must explain the token limit: ${threw.message}`);
    assert(/Максимум токенов|фрагментами/.test(threw.hint), `hint must be actionable: ${threw.hint}`);
    assertEqual(threw.detail, 'length');
  });

  it('runs map-reduce over long transcripts with progress events', async () => {
    const events = [];
    const long = longTranscript(500);
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const last = body.messages[body.messages.length - 1].content;
        if (last.includes('Транскрипт фрагмента')) {
          return jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    points: [{ text: 'Тезис из фрагмента про производительность и индексы.', at: '0:10' }],
                    topics: ['производительность'],
                    quotes: [{ text: 'Система ускорилась.', at: '0:12' }],
                    facts: ['40 ms'],
                    actions: ['Профилировать запросы'],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: long,
          meta: meta({ lengthSeconds: 3600 }),
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'auto', contextTokens: 4000, chunkTokens: 1200, concurrency: 3, stream: false },
          output: {},
          uiLang: 'ru',
          onProgress: (e) => events.push(e),
        }),
    );
    assertEqual(res.strategy, 'map-reduce');
    assert(res.plan.chunks.length > 1, 'expected multiple chunks');
    // one map call per chunk + at least one reduce call (more when batching)
    assert(calls.length >= res.plan.chunks.length + 1, `expected >= ${res.plan.chunks.length + 1} calls, got ${calls.length}`);
    const stages = new Set(events.map((e) => e.stage));
    assert(stages.has('map') && stages.has('reduce'), `missing progress stages: ${Array.from(stages)}`);
    // The panel shows a live timer next to “Анализирую N/M”: it needs elapsedMs.
    const mapEvents = events.filter((e) => e.stage === 'map');
    assert(mapEvents.length >= 2, `expected per-chunk progress, got ${mapEvents.length} events`);
    assert(mapEvents.every((e) => typeof e.elapsedMs === 'number'), 'every map event must carry elapsedMs');
    assert(res.result.keyPoints.length >= 2);
  });

  it('summarises a sixteen-minute video in one request', async () => {
    // The reported problem: a 16-minute video took three to four minutes. The
    // strategy test used the chunk size (3200) as the context budget too, so the
    // transcript was split and needed four model calls. One call is enough — and
    // it must carry the whole transcript, not the first piece of it.
    const segments = longTranscript(120); // ≈6.2k tokens, past the old 3200 budget
    const lastSentence = segments[segments.length - 1].text;
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] }),
      () =>
        runAiSummary({
          segments,
          meta: meta({ lengthSeconds: 960 }),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'auto', chunkTokens: 3200, stream: false },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(res.strategy, 'single', 'a fitting transcript must not be chunked');
    assertEqual(calls.length, 1, `one request expected, got ${calls.length}`);
    const body = typeof calls[0].body === 'string' ? JSON.parse(calls[0].body) : calls[0].body;
    const sent = body.messages.map((m) => String(m.content)).join('\n');
    assert(sent.includes(lastSentence), 'the single request must carry the whole transcript');
  });

  it('keeps the chunk size for splitting but uses the context budget for the decision', () => {
    const segments = longTranscript(120);
    const old = planStrategy({ segments, maxTokens: 3200, strategy: 'auto' });
    const now = planStrategy({ segments, maxTokens: 12000, chunkTokens: 3200, strategy: 'auto' });
    assertEqual(old.strategy, 'map-reduce');
    assertEqual(now.strategy, 'single');
    assert(now.chunks.length > 1, 'the pieces must still be built with the chunk size');
  });

  it('jumps to the output ceiling when a thinking model burns the chunk budget', async () => {
    // Free models often route to reasoning variants: the first budget goes to
    // “thinking”, the answer is empty with finish_reason=length. Doubling 1200
    // was still too small, so the retry must jump to the ceiling — and the user
    // must be told why some fragments came back empty.
    const long = longTranscript(500);
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
        const isChunk = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (isChunk) {
          if (body.max_tokens <= 4096) {
            return jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
          }
          return jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({ points: [{ text: 'Тезис фрагмента про индексы и запросы.', at: '0:10' }], topics: ['индексы'] }),
                },
                finish_reason: 'stop',
              },
            ],
          });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: long,
          meta: meta({ lengthSeconds: 3600 }),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'auto', contextTokens: 4000, chunkTokens: 1200, concurrency: 2, stream: false },
          output: {},
          uiLang: 'ru',
        }),
    );
    const budgets = calls
      .map((c) => (typeof c.body === 'string' ? JSON.parse(c.body) : c.body))
      .filter((body) => body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента')))
      .map((body) => body.max_tokens);
    assert(budgets.length > res.plan.chunks.length, `every chunk must be retried once, got ${budgets.length} chunk calls`);
    assert(budgets.some((value) => value >= 4000), `the retry must jump to the ceiling, got ${budgets.join(', ')}`);
    assert(
      res.warnings.some((w) => w.includes('размышлени')),
      `the thinking-model hint must be shown: ${JSON.stringify(res.warnings)}`,
    );
  });

  it('degrades gracefully when map calls all fail', async () => {
    const chunks = buildChunks(longTranscript(300), { maxTokens: 800 });
    let threw = null;
    try {
      await withFetch(
        () => jsonResponse({ error: { message: 'model overloaded' } }, 529),
        () =>
          runAiSummary({
            segments: longTranscript(300),
            meta: meta({}),
            provider,
            apiKey: 'k',
            model: 'm',
            aiSettings: { strategy: 'map-reduce', chunkTokens: 800, retries: 0 },
            output: {},
            uiLang: 'ru',
          }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'expected an error when every chunk fails');
    assert(['MAP_FAILED', 'SERVER', 'RATE_LIMIT'].includes(threw.code), `unexpected error code ${threw.code}`);
    assert(chunks.length > 1);
  });

  it('keeps partial coverage when only some chunks fail', async () => {
    let mapCalls = 0;
    const { res } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const last = body.messages[body.messages.length - 1].content;
        if (last.includes('Транскрипт фрагмента')) {
          mapCalls++;
          if (mapCalls === 2) return jsonResponse({ error: { message: 'boom' } }, 500);
          const answer = JSON.stringify({ points: [{ text: 'Рабочий фрагмент с фактами.', at: '0:30' }], topics: ['темы'], facts: ['7x'], actions: [] });
          // Fragment calls stream now: their notes are shown while the model
          // writes them, so the mock has to answer in the requested transport.
          if (body.stream) return sseResponse([{ choices: [{ delta: { content: answer } }] }]);
          return jsonResponse({
            choices: [{ message: { content: answer }, finish_reason: 'stop' }],
          });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify({ tldr: 'Итог', keyPoints: [{ text: 'Итоговый пункт.', at: '0:30' }], sections: [], takeaways: [], actionItems: [], quotes: [], keywords: [], sentiment: { label: 'neutral', score: 0 } }) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: longTranscript(240),
          meta: meta({}),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'map-reduce', chunkTokens: 700, retries: 0, concurrency: 1 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assert(res.result.tldr.length > 0);
    assert(res.warnings.length >= 1, 'partial failure must be reported');
  });

  it('builds the “by timecodes” summary block by block, without a final assembly', async () => {
    const seen = [];
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const prompt = String(body.messages[body.messages.length - 1].content);
        const at = /Транскрипт отрезка:[\s\S]*?\[(\d+:\d{2})\]/.exec(prompt)?.[1] || '0:00';
        seen.push(at);
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  heading: `Отрезок ${seen.length}`,
                  summary: `В отрезке ${seen.length} разбираются конкретные детали и цифры.`,
                  points: [{ text: `Факт ${seen.length} с числом ${seen.length * 7}`, at }],
                  quotes: [],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        });
      },
      () =>
        runAiSummary({
          segments: longTranscript(180),
          meta: meta({ lengthSeconds: 720 }),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { summaryMode: 'timeline', stream: false, retries: 0, concurrency: 2 },
          output: { length: 'standard' },
          uiLang: 'ru',
        }),
    );
    assertEqual(res.strategy, 'timeline');
    assertEqual(res.result.meta.strategy, 'timeline');
    assert(res.result.sections.length >= 3, `expected several sections, got ${res.result.sections.length}`);
    assertEqual(res.result.keyPoints.length, 0, 'key moments must not repeat the section points');
    assert(res.result.tldr.length > 20, 'the lead is assembled from the section summaries');
    assertEqual(seen.length, res.result.sections.length, 'one request per rendered section');
    assertEqual(calls.length, res.result.sections.length, 'no extra reduce request is made');
  });

  it('keeps the successful blocks when one block of the timecode mode fails', async () => {
    let blockCalls = 0;
    const { res } = await withFetch(
      () => {
        blockCalls++;
        if (blockCalls === 2) return jsonResponse({ error: { message: 'router hiccup' } }, 500);
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  heading: `Тема ${blockCalls}`,
                  summary: `Содержание блока ${blockCalls}.`,
                  points: [{ text: `Факт блока ${blockCalls}.`, at: '0:05' }],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        });
      },
      () =>
        runAiSummary({
          segments: longTranscript(120),
          meta: meta({ lengthSeconds: 480 }),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { summaryMode: 'timeline', stream: false, retries: 0, concurrency: 1 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assert(res.result.sections.length >= 2, 'the other blocks must still be shown');
    assertEqual(res.complete, false, 'a lost block is an incomplete result');
    assert(res.warnings.some((w) => w.includes('не обработан')), 'the lost block must be named');
  });

  it('drops self-check questions the model wrote anyway when the setting is off', async () => {
    const answer = () =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
    const { res } = await withFetch(answer, () =>
      runAiSummary({
        segments,
        meta: metaInfo,
        provider,
        apiKey: 'k',
        model: 'm',
        aiSettings: { strategy: 'single', stream: false, retries: 0, singleFallback: false },
        output: { selfCheck: false },
        uiLang: 'ru',
      }),
    );
    assertEqual(res.result.questions.length, 0, 'the setting wins over a model that wrote the block');
    const { res: asked } = await withFetch(answer, () =>
      runAiSummary({
        segments,
        meta: metaInfo,
        provider,
        apiKey: 'k',
        model: 'm',
        aiSettings: { strategy: 'single', stream: false, retries: 0, singleFallback: false },
        output: { selfCheck: true },
        uiLang: 'ru',
      }),
    );
    assert(asked.result.questions.length > 0, 'turning the setting on keeps the questions');
  });

  it('escalates and salvages a cut-off final assembly instead of dropping the whole answer', async () => {
    const truncated =
      '{"tldr":"Кэш, метрики и инвалидация в одном конспекте.","sections":[{"heading":"Кэш","at":"0:10","summary":"Разбирается, как кэш экономит время.","points":[{"text":"TTL и инвалидация.","at":"0:12"}]}],"keyPoin';
    const reduceBudgets = [];
    const { res } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const prompt = String(body.messages[body.messages.length - 1].content);
        if (prompt.includes('Транскрипт фрагмента')) {
          const note = JSON.stringify({ points: [{ text: 'Факт из фрагмента про кэш.', at: '0:10' }], topics: ['кэш'] });
          return jsonResponse({ choices: [{ message: { content: note }, finish_reason: 'stop' }] });
        }
        if (prompt.includes('заметки по ВСЕМ фрагментам')) {
          reduceBudgets.push(body.max_tokens);
          return jsonResponse({ choices: [{ message: { content: truncated }, finish_reason: 'length' }] });
        }
        return jsonResponse({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: longTranscript(60),
          meta: meta({ lengthSeconds: 240 }),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'map-reduce', chunkTokens: 700, contextTokens: 3000, concurrency: 1, stream: false, retries: 0 },
          output: { length: 'detailed' },
          uiLang: 'ru',
        }),
    );
    assert(reduceBudgets.length >= 2, `the assembly must be retried with a bigger ceiling, got ${reduceBudgets.join(', ')}`);
    assert(
      reduceBudgets[reduceBudgets.length - 1] > reduceBudgets[0],
      `the retry ceiling must grow: ${reduceBudgets.join(' -> ')}`,
    );
    assert(res.result.sections.length >= 1, 'complete fields of the cut-off answer are kept');
    assert(res.result.tldr.includes('Кэш'), 'the salvaged lead is used');
    assertEqual(res.complete, false, 'a salvaged assembly is not a complete summary');
  });

  it('answers questions with citations and retrieval for long videos', async () => {
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify({ answer: 'Кэш ускорил ответ до 40 мс.', citations: [{ text: 'ускорение с 800 миллисекунд до 40', at: '1:10' }], confidence: 0.7, notFound: false }) }, finish_reason: 'stop' }] }),
      () =>
        runAiAsk({
          question: 'Насколько ускорился ответ?',
          segments: longTranscript(400),
          meta: meta({}),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { contextTokens: 1500 },
          output: {},
        }),
    );
    assert(res.answer.includes('40 мс'));
    assertEqual(res.citations[0].at, 70);
    assert(res.retrieved < 400, 'retrieval must shrink the context');
    const prompt = calls[0].body.messages[1].content;
    assert(prompt.includes('Вопрос:'), 'question must be in the prompt');
    assert(prompt.length < 60000, 'context must stay bounded');
  });

  it('answers a question written in prose when the model ignores JSON', async () => {
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: 'В видео сказано, что кэш сократил задержку с 800 до 40 миллисекунд [1:10].' }, finish_reason: 'stop' }] }),
      () =>
        runAiAsk({
          question: 'Насколько ускорился ответ?',
          segments: longTranscript(400),
          meta: meta({}),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { contextTokens: 1500 },
          output: {},
        }),
    );
    assertEqual(calls.length, 1, 'prose must not trigger a repair request');
    assert(res.answer.includes('40'));
    assertEqual(res.citations[0].at, 70);
    assertEqual(res.citations[0].ts, '1:10');
  });

  it('normalizes malformed model output via the repair pass', async () => {
    let call = 0;
    const { res } = await withFetch(
      (url, init) => {
        call++;
        const body = JSON.parse(init.body);
        const isRepair = body.messages[0].content.includes('валидатор JSON');
        if (isRepair) {
          return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
        }
        return jsonResponse({ choices: [{ message: { content: 'Вот конспект: { broken json ...' }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: ruTranscript(),
          meta: meta({}),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { stream: false },
          output: {},
        }),
    );
    assertEqual(call, 2);
    assert(res.result.tldr.includes('кэшировании'));
  });

  it('summarises a 64k-token video in one request with the default context budget', async () => {
    // The control case from the report: a 3:22 video, ~34.8k words. Splitting it
    // into twenty 3.2k-token requests was the reason a run took minutes.
    const segments = longTranscript(1300);
    const tokens = estimateTokens(renderBlocks(buildBlocks(segments)));
    assert(tokens > 55000, `fixture must be ≈64k tokens, got ${tokens}`);
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] }),
      () =>
        runAiSummary({
          segments,
          meta: meta({ lengthSeconds: 12150 }),
          provider,
          apiKey: 'k',
          model: 'openrouter/free',
          // No contextTokens override: the shipped default (128k) must decide.
          aiSettings: { strategy: 'auto', chunkTokens: 6000, stream: false },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(res.strategy, 'single', 'a 64k transcript fits the safe 128k budget');
    assertEqual(calls.length, 1, `one request expected, got ${calls.length}`);
    const sent = calls[0].body.messages.map((m) => String(m.content)).join('\n');
    // Coverage, not just length: beginning, middle and end must all be present.
    assert(sent.includes('На шаге 1 '), 'the opening must be sent');
    assert(sent.includes('На шаге 650 '), 'the middle must be sent');
    assert(sent.includes('На шаге 1300 '), 'the ending must be sent');
    assertEqual(res.complete, true);
    assert(res.result.meta.diagnostics.chunks.length === 1, 'single-pass must be measured too');
  });

  it('reduces the number of fallback requests without dropping coverage', async () => {
    const segments = longTranscript(1300);
    const plan = planStrategy({ segments, maxTokens: 128000, chunkTokens: 6000, strategy: 'auto' });
    assertEqual(plan.strategy, 'single');
    // When it truly does not fit, 6k pieces keep a 64k transcript near eleven
    // requests instead of twenty — the old 3.2k default.
    const forced = planStrategy({ segments, maxTokens: 4000, chunkTokens: 6000, strategy: 'auto' });
    assert(forced.chunks.length >= 8 && forced.chunks.length <= 14, `expected ~11 chunks, got ${forced.chunks.length}`);
  });

  it('enforces one absolute job deadline across parallel map requests', async () => {
    // Map chunks start together; when the job clock fires, every in-flight
    // request is aborted and no later chunk is sent. This is the collaborative
    // cancellation path, not just a per-chunk timeout.
    const signals = [];
    let err = null;
    const t0 = Date.now();
    const segments = longTranscript(240);
    const { calls } = await withFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          signals.push(init.signal);
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) return onAbort();
          init.signal?.addEventListener('abort', onAbort, { once: true });
          void resolve;
        }),
      async () => {
        try {
          await runAiSummary({
            segments,
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: { strategy: 'map-reduce', chunkTokens: 1200, contextTokens: 4000, concurrency: 2, stream: false, retries: 0, chunkCache: false },
            output: { language: 'auto', length: 'standard' },
            uiLang: 'ru',
            deadlineAt: Date.now() + 400,
            budgetMs: 400,
          });
        } catch (e) {
          err = e;
        }
      },
    );
    assert(err, 'an exhausted job budget must throw');
    assertEqual(err.code, 'TIMEOUT');
    assertEqual(err.detail, 'job-deadline');
    assertEqual(calls.length, 2, 'only the first parallel wave may be in flight');
    assert(
      signals.length === 2 && signals.every((s) => s && s.aborted),
      'every in-flight request must be aborted by the job deadline',
    );
    assert(Date.now() - t0 < 3000, `the job must stop at its deadline, took ${Date.now() - t0} ms`);
  });

  it('never retries or loops the reduce after the job deadline', async () => {
    // Map finishes fast; the final assembly hangs. The job clock must abort the
    // reduce, skip its retry and return the draft fragments instead of starting
    // another multi-minute round.
    const started = Date.now();
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (isMap) {
          return jsonResponse({
            choices: [
              {
                message: { content: JSON.stringify({ points: [{ text: 'Факт из фрагмента.', at: '0:10' }], topics: ['тема'] }) },
                finish_reason: 'stop',
              },
            ],
          });
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) return onAbort();
          init.signal?.addEventListener('abort', onAbort, { once: true });
          void resolve;
        });
      },
      async () => {
        try {
          return await runAiSummary({
            segments: longTranscript(240),
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: {
              strategy: 'map-reduce',
              chunkTokens: 1200,
              contextTokens: 4000,
              concurrency: 4,
              stream: false,
              retries: 0,
              chunkCache: false,
            },
            output: { language: 'auto', length: 'standard' },
            uiLang: 'ru',
            deadlineAt: Date.now() + 1200,
            budgetMs: 1200,
          });
        } catch (err) {
          return { error: err };
        }
      },
    );
    const reduceCalls = calls.filter((c) => JSON.stringify(c.body?.messages || []).includes('Собери из них итоговый конспект'));
    assertEqual(reduceCalls.length, 1, 'the reduce must not be retried after the deadline');
    assert(Date.now() - started < 4000, `the reduce must stop with the job clock, took ${Date.now() - started} ms`);
    if (res.error) {
      assertEqual(res.error.code, 'TIMEOUT');
      assertEqual(res.error.detail, 'job-deadline');
    } else {
      // All fragments may already be saved, so coverage can be complete; what
      // matters is that the missing assembly is reported as a timeout and the
      // pipeline stops instead of buying another round.
      assert(res.strategy.includes('degraded'), `expected a degraded draft, got ${res.strategy}`);
      assertEqual(res.result.meta.diagnostics.finishReason, 'job-timeout');
      assert(
        res.warnings.some((w) => /бюджет задания исчерпан/i.test(w)),
        `the draft must explain the timeout: ${JSON.stringify(res.warnings)}`,
      );
    }
  });

  it('reuses intermediate reduce notes instead of requesting the same groups again', async () => {
    const longNote = 'Подробный факт из фрагмента. '.repeat(120);
    const segments = longTranscript(240);
    const savedReduce = {};
    const run = (resumeReduce, collect) =>
      withFetch(
        (url, init) => {
          const body = JSON.parse(init.body);
          const isReduce = body.messages.some((m) => String(m.content).includes('Собери из них итоговый конспект'));
          const content = isReduce
            ? JSON.stringify(SUMMARY_JSON)
            : JSON.stringify({ points: [{ text: longNote, at: '0:10' }], topics: ['тема'] });
          return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
        },
        () =>
          runAiSummary({
            segments,
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: {
              strategy: 'map-reduce',
              chunkTokens: 1200,
              contextTokens: 4000,
              concurrency: 4,
              stream: false,
              retries: 0,
              chunkCache: false,
            },
            output: { language: 'auto', length: 'standard' },
            uiLang: 'ru',
            resumeReduce,
            onReduceState: ({ key, text }) => {
              if (collect) savedReduce[key] = text;
            },
          }),
      );
    const reduceCalls = (calls) =>
      calls.filter((c) =>
        (c.body?.messages || []).some((m) => String(m.content).includes('Собери из них итоговый конспект')),
      ).length;

    const first = await run(null, true);
    assert(reduceCalls(first.calls) > 0, 'the fixture must use intermediate reduce groups');
    assert(Object.keys(savedReduce).length > 0, 'every successful group must be saved');

    const second = await run(savedReduce, false);
    assert(
      second.res.diagnostics.reduceResumed > 0,
      'the continuation must report the reused reduce notes',
    );
    assertEqual(
      reduceCalls(second.calls),
      1,
      'only the final assembly may be requested again; every saved group must be reused',
    );
    assert(
      reduceCalls(second.calls) < reduceCalls(first.calls),
      'the continuation must send fewer reduce requests than the first run',
    );
  });

  it('publishes validated map fragments as they finish, before the reduce', async () => {
    const events = [];
    let mapCalls = 0;
    let slowFinishedAt = 0;
    const { res } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (!isMap) return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
        mapCalls++;
        const content = JSON.stringify({ points: [{ text: `Факт из фрагмента ${mapCalls}.`, at: '0:10' }], topics: ['тема'] });
        if (mapCalls === 1) {
          // One deliberately slow chunk must not hold back the others.
          return new Promise((resolve) =>
            setTimeout(() => {
              slowFinishedAt = Date.now();
              resolve(jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
            }, 150),
          );
        }
        return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: longTranscript(240),
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'map-reduce', chunkTokens: 1200, contextTokens: 4000, concurrency: 2, stream: false, retries: 0, chunkCache: false },
          output: {},
          uiLang: 'ru',
          onProgress: (event) => events.push({ ...event, at: Date.now() }),
        }),
    );
    const partials = events.filter((e) => e.stage === 'partial');
    assert(partials.length >= 2, 'every validated map chunk must be published');
    assert(partials.every((p) => p.partial?.points?.length), 'only validated points are published');
    assert(
      partials.some((p) => p.at < slowFinishedAt),
      'a slow chunk must not block the first useful result',
    );
    const firstReduce = events.findIndex((e) => e.stage === 'reduce');
    assert(firstReduce > 0, 'the final reduce must run');
    assert(
      partials.every((p) => events.indexOf(p) < firstReduce),
      'TL;DR and reduce may only start after the map results are published',
    );
    assert(res.diagnostics.firstPartialMs > 0, 'time to the first useful result must be measured');
    assertEqual(res.diagnostics.concurrency, 2);
  });

  it('streams a fragment’s points before the fragment request finishes', async () => {
    const events = [];
    const answer = JSON.stringify({
      points: [
        { text: 'Первый тезис фрагмента виден сразу.', at: '0:42' },
        { text: 'Второй тезис приходит следом.', at: '1:05' },
      ],
      topics: ['тема'],
    });
    // Split mid-string: the parser must wait for each value to close and then
    // publish it, long before the request resolves.
    const cuts = [0, 25, 55, 90, answer.length];
    const pieces = cuts.slice(1).map((end, i) => answer.slice(cuts[i], end));
    const { res } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (!isMap) return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
        assertEqual(body.stream, true, 'a fragment must be requested as a stream');
        return sseResponse(pieces.map((content) => ({ choices: [{ delta: { content } }] })));
      },
      () =>
        runAiSummary({
          segments: longTranscript(160),
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'map-reduce', chunkTokens: 700, contextTokens: 3000, concurrency: 1, retries: 0, chunkCache: false },
          output: {},
          uiLang: 'ru',
          onProgress: (event) => events.push(event),
        }),
    );
    const live = events.filter((e) => e.stage === 'partial-item');
    assert(live.length >= 2, `every validated point must be published live, got ${live.length}`);
    assertEqual(live[0].item.kind, 'keyPoint');
    assertEqual(live[0].item.point.ts, '0:42', 'the timecode must survive streaming');
    assert(typeof live[0].index === 'number', 'a live point must name its fragment');
    const firstReduce = events.findIndex((e) => e.stage === 'reduce');
    assert(firstReduce > 0, 'the reduce phase must run');
    assert(
      live.every((e) => events.indexOf(e) < firstReduce),
      'live points belong to the map phase, before the final assembly',
    );
    assert(res.result.tldr, 'the final summary must still be built');
  });

  it('treats a safety refusal as final instead of repairing it as JSON', async () => {
    let calls = 0;
    const refusal =
      'User Safety: unsafe\nResponse Safety: unsafe\nSafety Categories: Violence, Profanity, Political/Misinformation/Conspiracy';
    let threw = null;
    try {
      await withFetch(
        () => {
          calls++;
          return new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: refusal }, finish_reason: 'content_filter' }] })}\n\ndata: [DONE]\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        },
        () =>
          runAiSummary({
            segments: ruTranscript(),
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'm',
            aiSettings: { strategy: 'single', retries: 0, stream: true },
            output: {},
            uiLang: 'ru',
          }),
      );
    } catch (err) {
      threw = err;
    }
    assert(threw, 'a refusal must throw');
    assertEqual(threw.code, 'SAFETY');
    assertEqual(calls, 1, 'the blocked answer must not be sent through the repair prompt');
  });

  it('holds queued fragments after a 429 with Retry-After instead of hammering the provider', async () => {
    const mapStarts = [];
    let mapCalls = 0;
    const { res } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (!isMap) return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
        mapCalls++;
        mapStarts.push(Date.now());
        if (mapCalls === 1) {
          return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '0.06' },
          });
        }
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                jsonResponse({
                  choices: [
                    {
                      message: { content: JSON.stringify({ points: [{ text: `Факт из фрагмента ${mapCalls}.`, at: '0:10' }] }) },
                      finish_reason: 'stop',
                    },
                  ],
                }),
              ),
            20,
          ),
        );
      },
      () =>
        runAiSummary({
          segments: longTranscript(240),
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: {
            strategy: 'map-reduce',
            chunkTokens: 1200,
            contextTokens: 4000,
            concurrency: 2,
            stream: false,
            retries: 0,
            allowRateRetry: false,
            chunkCache: false,
          },
          output: {},
          uiLang: 'ru',
        }),
    );
    assert(mapStarts.length >= 3, `expected a queued fragment after the 429, got ${mapStarts.length} requests`);
    const delay = mapStarts[2] - mapStarts[0];
    assert(delay >= 40, `a queued fragment started ${delay}ms after the 429, before Retry-After elapsed`);
    assertEqual(res.diagnostics.rateLimited, 1, 'the rate limit must be counted');
    assert(res.diagnostics.mapPausedMs >= 40, 'the shared pause must be measured');
    assertEqual(mapStarts.length, mapCalls, 'no fragment may be requested twice');
  });

  it('reports stage timings and a finish reason without adding map stages to single-pass', async () => {
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'single', stream: false, retries: 0 },
          output: { language: 'auto', length: 'standard' },
          uiLang: 'ru',
        }),
    );
    assertEqual(calls.length, 1, 'single-pass must stay one request');
    const d = res.diagnostics;
    assertEqual(d.strategy, 'single');
    assert(d.budgetMs > 0, 'the job must carry a plan-aware budget');
    assert(d.deadlineAt > Date.now() - 60000, 'the job must carry an absolute deadline');
    assertEqual(d.stageMs.map || 0, 0, 'single-pass must not run map stages');
    assertEqual(d.stageMs.reduce || 0, 0, 'single-pass must not run reduce stages');
    assertEqual(d.finishReason, 'success');
    assertEqual(d.complete, true);
    assertEqual(d.resumable, false);
    assertEqual(d.tokensIn, 10, 'reported input tokens must survive into diagnostics');
    assertEqual(d.tokensOut, 20, 'reported output tokens must survive into diagnostics');
  });

  it('falls back to map-reduce when the single request overflows the model window', async () => {
    const segments = longTranscript(1300);
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (!isMap && body.messages.some((m) => String(m.content).includes('Транскрипт с таймкодами'))) {
          return jsonResponse({ error: { message: 'maximum context length exceeded' } }, 400);
        }
        if (isMap) {
          return jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({ points: [{ text: 'Факт из фрагмента.', at: '0:10' }], topics: ['тема'] }),
                },
                finish_reason: 'stop',
              },
            ],
          });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments,
          meta: meta({ lengthSeconds: 12150 }),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'auto', contextTokens: 128000, chunkTokens: 6000, stream: false, retries: 0 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(res.strategy, 'map-reduce');
    assert(
      res.warnings.some((w) => w.includes('не поместился')),
      `the fallback must be explained: ${JSON.stringify(res.warnings)}`,
    );
    // One failed single call + one per chunk + reduce; no retry loop.
    assert(calls.length < res.plan.chunks.length + 4, `fallback looped: ${calls.length} calls`);
  });

  it('can be forced to spend exactly one request on a context error', async () => {
    // The manual benchmark must not silently turn one live call into a dozen.
    let threw = null;
    const { calls } = await withFetch(
      () => jsonResponse({ error: { message: 'maximum context length exceeded' } }, 400),
      async () => {
        try {
          await runAiSummary({
            segments: longTranscript(1300),
            meta: meta({ lengthSeconds: 12150 }),
            provider,
            apiKey: 'k',
            model: 'm',
            aiSettings: { strategy: 'auto', contextTokens: 128000, chunkTokens: 6000, stream: false, retries: 0, singleFallback: false },
            output: {},
            uiLang: 'ru',
          });
        } catch (err) {
          threw = err;
        }
      },
    );
    assert(threw, 'the context error must be reported');
    assertEqual(threw.code, 'CONTEXT_LENGTH');
    assertEqual(calls.length, 1, `exactly one request expected, got ${calls.length}`);
  });

  it('does not start a chunked run after a single-pass timeout', async () => {
    // A timeout is not a definitive “does not fit” signal. Starting map-reduce
    // after it would silently multiply the waiting time, so the run must stop.
    const { calls } = await withFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) return onAbort();
          init.signal?.addEventListener('abort', onAbort, { once: true });
          setTimeout(() => resolve(jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) } }] })), 5000);
        }),
      async () => {
        let err = null;
        const started = Date.now();
        try {
          await runAiSummary({
            segments: longTranscript(1300),
            meta: meta({ lengthSeconds: 12150 }),
            provider,
            apiKey: 'k',
            model: 'm',
            aiSettings: { strategy: 'auto', contextTokens: 128000, chunkTokens: 6000, stream: false, retries: 0 },
            output: {},
            uiLang: 'ru',
            deadlineAt: Date.now() + 600,
            budgetMs: 600,
          });
        } catch (e) {
          err = e;
        }
        assert(err, 'an exhausted single-pass budget must throw');
        assertEqual(err.code, 'TIMEOUT');
        assert(Date.now() - started < 3000, 'the timeout must not open a new scenario');
      },
    );
    assertEqual(calls.length, 1, 'a single-pass timeout must not send chunk requests');
  });

  it('never marks a run complete when a fragment is missing', async () => {
    let mapIndex = 0;
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const last = String(body.messages[body.messages.length - 1].content);
        if (last.includes('Транскрипт фрагмента')) {
          mapIndex++;
          if (mapIndex === 2) return jsonResponse({ error: { message: 'boom' } }, 500);
          return jsonResponse({
            choices: [
              {
                message: { content: JSON.stringify({ points: [{ text: 'Рабочий фрагмент с фактами.', at: '0:30' }], topics: ['темы'] }) },
                finish_reason: 'stop',
              },
            ],
          });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: longTranscript(240),
          meta: meta({}),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'map-reduce', chunkTokens: 1200, retries: 0, concurrency: 1, stream: false },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(res.complete, false, 'a missing fragment must not be reported as complete');
    assertEqual(res.result.meta.complete, false);
    assertEqual(res.result.meta.strategy, 'map-reduce:partial');
    assertEqual(res.result.stats.aiComplete, false);
    assert(res.warnings.some((w) => w.includes('неполный')), `warning must say the result is partial: ${JSON.stringify(res.warnings)}`);
    // Successful fragments are not re-requested because another one failed.
    const perChunk = new Map();
    for (const call of calls) {
      const body = call.body;
      const last = String(body.messages[body.messages.length - 1].content);
      if (!last.includes('Транскрипт фрагмента')) continue;
      perChunk.set(last, (perChunk.get(last) || 0) + 1);
    }
    assert(perChunk.size === res.plan.chunks.length, `every chunk must be asked: ${perChunk.size}/${res.plan.chunks.length}`);
    for (const [text, count] of perChunk) {
      assertEqual(count, 1, `a chunk was re-requested: ${text.slice(0, 40)}`);
    }
  });

  it('rejects an empty fragment answer instead of treating it as a summary', async () => {
    let mapCalls = 0;
    const { res } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const last = String(body.messages[body.messages.length - 1].content);
        if (last.includes('Транскрипт фрагмента')) {
          mapCalls++;
          // One substantive fragment answers with valid JSON that holds nothing —
          // twice, including the reminder. The rest are fine, so the run has a
          // result but it must be marked as partial coverage.
          if (last.includes('На шаге 1 ')) {
            return jsonResponse({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
          }
          return jsonResponse({
            choices: [
              {
                message: { content: JSON.stringify({ points: [{ text: 'Факт из фрагмента.', at: '0:10' }], topics: ['тема'] }) },
                finish_reason: 'stop',
              },
            ],
          });
        }
        return jsonResponse({ choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }] });
      },
      () =>
        runAiSummary({
          segments: longTranscript(240),
          meta: meta({}),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'map-reduce', chunkTokens: 1200, retries: 0, concurrency: 2, stream: false },
          output: {},
          uiLang: 'ru',
        }),
    );
    assert(mapCalls > res.plan.chunks.length, 'empty answers must be asked again once');
    assertEqual(res.complete, false, 'empty fragments must leave the run incomplete');
  });

  it('reuses cached fragment notes and never repeats successful chunks', async () => {
    const store = new Map();
    const chunkCache = {
      get: async (key) => store.get(key) || null,
      put: async (key, partial) => void store.set(key, partial),
    };
    const segments = longTranscript(240);
    const settings = { strategy: 'map-reduce', chunkTokens: 1200, retries: 0, concurrency: 2, stream: false };
    const mock = (url, init) => {
      const body = JSON.parse(init.body);
      const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
      const content = isMap
        ? JSON.stringify({ points: [{ text: 'Факт из фрагмента.', at: '0:10' }], topics: ['тема'] })
        : JSON.stringify(SUMMARY_JSON);
      return jsonResponse({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    };
    const first = await withFetch(mock, () =>
      runAiSummary({ segments, meta: meta({}), provider, apiKey: 'k', model: 'm', aiSettings: settings, output: {}, uiLang: 'ru', chunkCache }),
    );
    const second = await withFetch(mock, () =>
      runAiSummary({ segments, meta: meta({}), provider, apiKey: 'k', model: 'm', aiSettings: settings, output: {}, uiLang: 'ru', chunkCache }),
    );
    assertEqual(store.size, first.res.plan.chunks.length);
    assert(
      second.calls.length < first.calls.length,
      `the second run must reuse the notes: ${first.calls.length} vs ${second.calls.length}`,
    );
    assertEqual(second.calls.length, 1, 'only the final reduce should hit the provider');
    assert(second.res.diagnostics.cacheHits >= first.res.plan.chunks.length, 'cache hits must be reported');
  });

  it('keeps complete fields of a twice-truncated answer as an incomplete result', async () => {
    const full = JSON.stringify({
      tldr: 'Короткий итог, который успел сгенерироваться.',
      keyPoints: [
        { text: 'Первый готовый факт.', at: '0:05' },
        { text: 'Второй готовый факт.', at: '0:10' },
      ],
      sections: [{ heading: 'Начало', at: '0:00', summary: 'Первый раздел.', points: [{ text: 'Пункт раздела.', at: '0:02' }] }],
      takeaways: ['Вывод, который обрезался на полуслове'],
    });
    const partial = full.slice(0, full.indexOf('"takeaways"') + 24);
    const { res, calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: partial }, finish_reason: 'length' }] }),
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'single', stream: false, retries: 0 },
          output: {},
          uiLang: 'ru',
        }),
    );
    // Full format at 5000 → larger budget at 8192 → short format at 8192.
    // Only after all three come back cut off is the complete prefix salvaged.
    assertEqual(calls.length, 3, 'the cut-off answer must be retried twice before salvage');
    assertEqual(res.complete, false, 'a salvaged answer is never a complete summary');
    assertEqual(res.result.meta.complete, false);
    assertEqual(res.result.meta.diagnostics.finishReason, 'output-limit');
    assertEqual(res.result.meta.diagnostics.salvaged, true);
    assertEqual(res.result.meta.diagnostics.truncated, true);
    assert(res.result.keyPoints.length >= 2, 'complete points must survive both truncations');
    assert(res.result.tldr.length > 0, 'the complete TL;DR must survive');
    assertEqual(res.result.meta.diagnostics.complete, false);
    assert(res.warnings.some((w) => w.includes('полностью полученная часть')), `the salvage must be explained: ${JSON.stringify(res.warnings)}`);
  });

  it('does not accept a truncated single answer as complete', async () => {
    const partial = { tldr: 'Начало конспекта', keyPoints: [{ text: 'Первый факт.', at: '0:10' }], sections: [] };
    const { res, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const content = body.max_tokens >= 8192 ? JSON.stringify(SUMMARY_JSON) : JSON.stringify(partial);
        const finish = body.max_tokens >= 8192 ? 'stop' : 'length';
        return jsonResponse({ choices: [{ message: { content }, finish_reason: finish }] });
      },
      () =>
        runAiSummary({
          segments: longTranscript(1300),
          meta: meta({ lengthSeconds: 12150 }),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'auto', contextTokens: 128000, chunkTokens: 6000, stream: false, retries: 0 },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(res.strategy, 'single');
    assertEqual(calls.length, 2, 'the cut-off answer must be retried with a bigger budget');
    assert(calls[1].body.max_tokens > calls[0].body.max_tokens, 'the retry must raise the budget');
    assert(calls[1].body.max_tokens <= 16000, 'the retry must stay under the ceiling');
    assert(res.warnings.some((w) => w.includes('не поместился')), `the retry must be explained: ${JSON.stringify(res.warnings)}`);
    assertEqual(res.complete, true);
  });

  it('records the critical path and the served generation id', async () => {
    const { res } = await withFetch(
      () =>
        jsonResponse({
          id: 'gen-test-123',
          model: 'some/free-model',
          choices: [{ message: { content: JSON.stringify(SUMMARY_JSON) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5000, completion_tokens: 800 },
        }),
      () =>
        runAiSummary({
          segments: longTranscript(1300),
          meta: meta({ lengthSeconds: 12150 }),
          provider,
          apiKey: 'k',
          model: 'openrouter/free',
          aiSettings: { strategy: 'auto', contextTokens: 128000, chunkTokens: 6000, stream: false, retries: 0 },
          output: {},
          uiLang: 'ru',
        }),
    );
    const call = res.diagnostics.chunks[0];
    assertEqual(res.diagnostics.stages.single, 1);
    assertEqual(call.genId, 'gen-test-123');
    assertEqual(call.model, 'some/free-model');
    assertEqual(call.jsonOk, true);
    assertEqual(call.retries, 0);
    assertEqual(typeof call.ttftMs, 'number');
    assertEqual(typeof call.genMs, 'number');
    assert(call.estimatedIn > res.plan.tokens, 'the estimate must include the prompt and schema');
    assert(res.diagnostics.requestEstimatedTokens > 0);
    assert(res.diagnostics.providerMs >= call.ms);
    assert(res.diagnostics.localMs >= 0);
    assertEqual(res.result.meta.diagnostics.chunks[0].genId, 'gen-test-123');
    assert(res.result.meta.diagnostics.outputLimit >= 4096, 'a long transcript needs at least the standard budget');
    assert(res.result.meta.diagnostics.outputLimit <= 16000, 'the ceiling must stay bounded');
    assertEqual(res.result.meta.diagnostics.initialOutputLimit, res.result.meta.diagnostics.outputLimit);
  });

  it('makes exactly one request when repair and fallbacks are disabled', async () => {
    let threw = null;
    const { calls } = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: 'Вот конспект: { broken' }, finish_reason: 'stop' }] }),
      async () => {
        try {
          await runAiSummary({
            segments: ruTranscript(),
            meta: meta({}),
            provider,
            apiKey: 'k',
            model: 'm',
            aiSettings: {
              stream: false,
              retries: 0,
              jsonRepair: false,
              singleFallback: false,
              allowRateRetry: false,
              allowFormatRetry: false,
            },
            output: {},
          });
        } catch (err) {
          threw = err;
        }
      },
    );
    assert(threw, 'invalid JSON must fail');
    assertEqual(threw.code, 'BAD_JSON');
    assertEqual(calls.length, 1, `no repair/fallback request allowed, got ${calls.length}`);
  });

  it('keys cached fragment notes by content, prompt revision and model', () => {
    const chunk = { startAt: 0, endAt: 30, text: 'Первый фрагмент' };
    const opts = { outputLanguage: 'ru', tone: 'neutral', length: 'standard' };
    const base = chunkCacheKey({ chunk, model: 'm', provider, opts });
    assertEqual(base, chunkCacheKey({ chunk, model: 'm', provider, opts }));
    assert(base !== chunkCacheKey({ chunk: { ...chunk, text: 'Другой фрагмент' }, model: 'm', provider, opts }));
    assert(base !== chunkCacheKey({ chunk, model: 'other-model', provider, opts }));
    assert(base !== chunkCacheKey({ chunk, model: 'm', provider: { ...provider, id: 'another' }, opts }));
  });
});

describe('timecode blocks', () => {
  it('cuts on the page chapters and keeps their real start marker', () => {
    const segments = longTranscript(120);
    const chapters = [
      { title: 'Вступление', at: 0 },
      { title: 'Середина', at: 160 },
      { title: 'Финал', at: 320 },
    ];
    const blocks = timelineBlocks({ segments, meta: { chapters }, totalWords: 3000 });
    assertEqual(blocks.length, 3);
    assertEqual(blocks[0].startAt, 0);
    assertEqual(blocks[1].startAt, 160);
    assert(blocks[0].text.startsWith('[0:00]'), blocks[0].text.slice(0, 24));
    assert(blocks[1].text.startsWith('[2:40]'), `the second block must start at its chapter, got ${blocks[1].text.slice(0, 24)}`);
    assertEqual(blocks[1].title, 'Середина');
  });

  it('falls back to equal stretches of speech without chapters', () => {
    const segments = longTranscript(150);
    const blocks = timelineBlocks({ segments, totalWords: countWords(segments.map((s) => s.text).join(' ')) });
    assert(blocks.length >= 3, `expected several blocks, got ${blocks.length}`);
    assertEqual(blocks[0].startAt, 0);
    const last = blocks[blocks.length - 1];
    // endAt is the marker of the block's last ~30 s group, so it may sit one
    // marker behind the very last segment.
    assert(last.endAt + 30 >= segments[segments.length - 1].start, 'the last block must reach the end of the video');
    for (const block of blocks) {
      assert(/^\[\d+:\d{2}\]/.test(block.text), `every block needs a real timecode marker: ${block.text.slice(0, 16)}`);
    }
  });

  it('budgets one request per block, not one for the whole video', () => {
    const segments = longTranscript(300);
    const single = computeJobBudgetMs({ segments, aiSettings: { summaryMode: 'whole', timeoutMs: 90000, concurrency: 3 } });
    const timeline = computeJobBudgetMs({ segments, aiSettings: { summaryMode: 'timeline', timeoutMs: 90000, concurrency: 3 } });
    assert(timeline > single * 2, `the timecode mode needs its own budget: ${timeline} vs ${single}`);
    assert(timeline <= 20 * 60 * 1000, 'the budget must stay bounded');
  });
});

describe('streamed summary items', () => {
  const provider = providerFromPreset('groq');
  const segments = ruTranscript();
  const metaInfo = meta({ lengthSeconds: 150 });
  const payload = JSON.stringify(SUMMARY_JSON);

  const feedChars = (text, chunk = 1) => {
    const items = [];
    const stream = createSummaryStream({ onItem: (item) => items.push(item) });
    for (let i = 0; i < text.length; i += chunk) stream.push(text.slice(i, i + chunk));
    return { items, stream };
  };

  it('extracts only closed, validated items and keeps schema order', () => {
    const { items, stream } = feedChars(payload);
    assertEqual(items[0]?.kind, 'tldr');
    assertEqual(items[0].text, SUMMARY_JSON.tldr);
    assertEqual(items.filter((i) => i.kind === 'keyPoint').length, SUMMARY_JSON.keyPoints.length);
    assertEqual(items.filter((i) => i.kind === 'section').length, 1);
    assertDeepEqual(items.map((i) => i.kind), ['tldr', 'keyPoint', 'keyPoint', 'section']);
    assertEqual(items[1].point.ts, '0:05');
    assertEqual(items[3].section.heading, 'Стратегии кэширования');
    assertEqual(stream.stats().closed, true);
  });

  it('never emits an item before its own value is closed', () => {
    const items = [];
    const stream = createSummaryStream({ onItem: (item) => items.push(item) });
    stream.push('{"keyPoints":[{"text":"Первый пункт без конца');
    assertEqual(items.length, 0, 'an unterminated string must emit nothing');
    stream.push(' строки"');
    assertEqual(items.length, 0, 'a closed string inside an open object is not an item yet');
    stream.push(',"at":"0:10"}');
    assertEqual(items.length, 0, 'an object is only an item once the array delimiter arrives');
    stream.push(',');
    assertEqual(items.length, 1, 'the completed element must be emitted at the comma');
    assertEqual(items[0].point.at, 10);
    stream.push('{"at":"0:20"}');
    stream.push(']}');
    assertEqual(items.length, 1, 'a point without text must be dropped');
  });

  it('drops schema placeholders and exact repeats', () => {
    const { items } = feedChars(
      JSON.stringify({
        tldr: 'строка: суть видео',
        keyPoints: [{ text: 'тема' }, { text: 'Один и тот же пункт' }, { text: 'Один и тот же пункт' }],
      }),
    );
    assertEqual(items.filter((i) => i.kind === 'tldr').length, 0, 'a schema placeholder is not a TL;DR');
    assertEqual(items.filter((i) => i.kind === 'keyPoint').length, 1, 'only the unique real point survives');
  });

  it('survives escapes and emoji split across every chunk boundary', () => {
    // A newline becomes a space (normalizeWhitespace), the quote stays quoted
    // and the emoji survives a chunk boundary inside its surrogate pair.
    const raw = 'Он сказал "кэш" —\nи путь 🧠 работает.';
    const { items } = feedChars(JSON.stringify({ tldr: raw }), 3);
    assertEqual(items.length, 1);
    assertEqual(items[0].text, 'Он сказал "кэш" — и путь 🧠 работает.');
  });

  it('ignores a prose brace before the real answer', () => {
    const { items } = feedChars(
      'Вот ответ: {"oops": 1} и сам конспект: ' + JSON.stringify({ tldr: 'Нормальный пересказ видео о кэше.' }),
    );
    assertEqual(items.length, 1, 'the real object must still be found after a false brace');
    assertEqual(items[0].text, 'Нормальный пересказ видео о кэше.');
  });

  it('accepts the snake_case aliases normalizeResult accepts', () => {
    const { items } = feedChars(
      JSON.stringify({
        summary: 'Короткий пересказ видео о кэше и метриках.',
        key_points: [{ text: 'Первый факт из видео', at: '0:02' }],
        chapters: [{ heading: 'Начало', at: '0:00', summary: 'Вступление', points: [] }],
      }),
    );
    assertDeepEqual(items.map((i) => i.kind), ['tldr', 'keyPoint', 'section']);
  });

  it('shows validated items while the single answer is still streaming', async () => {
    // The mock sends the rest of the answer only after the panel has received a
    // validated item. If the pipeline waited for the stream to end, the gate
    // would time out and the assertion below would fail instead of hanging.
    const cut = payload.indexOf('"takeaways"');
    const head = deltaSse(payload.slice(0, cut));
    const tail = deltaSse(payload.slice(cut)) + 'data: [DONE]\n\n';
    const headBytes = enc.encode(head);
    // Split inside a Cyrillic character: the byte stream must decode cleanly.
    const inside = enc.encode(head.slice(0, head.indexOf('Видео'))).length + 1;
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    let closed = false;
    const items = [];
    const body = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(headBytes.slice(0, inside));
          controller.enqueue(headBytes.slice(inside));
          const early = await Promise.race([
            gate.then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
          ]);
          closed = true;
          if (early) {
            controller.enqueue(enc.encode(tail));
            controller.close();
          }
        } catch {
          /* the consumer may already be gone */
        }
      },
    });
    const { res, calls } = await withFetch(
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      () =>
        runAiSummary({
          segments,
          meta: metaInfo,
          provider,
          apiKey: 'k',
          model: 'llama-3.3-70b-versatile',
          aiSettings: { strategy: 'single', stream: true, retries: 0, jsonRepair: false, singleFallback: false },
          output: { language: 'auto', length: 'standard' },
          uiLang: 'ru',
          onProgress: (event) => {
            if (event.stage !== 'stream-item') return;
            items.push({ ...event, beforeClose: !closed });
            release();
          },
        }),
    );
    assertEqual(calls.length, 1, 'streaming must not add a request');
    assertEqual(items.length, 4, `expected tldr + 2 points + section, got ${items.length}`);
    assert(items.every((i) => i.beforeClose), 'every item must arrive before the stream closes');
    assertEqual(items[0].item.kind, 'tldr');
    assertEqual(items[0].item.text, SUMMARY_JSON.tldr, 'the Cyrillic TL;DR must survive a byte split');
    assertEqual(res.result.tldr, SUMMARY_JSON.tldr);
    assertEqual(res.result.keyPoints.length, SUMMARY_JSON.keyPoints.length);
    assertEqual(res.diagnostics.streamItems, 4);
    assertEqual(res.diagnostics.streamTldr, true);
    assert(typeof res.diagnostics.streamFirstItemMs === 'number', 'the first-item time must be recorded');
  });

  it('produces the same result as a non-streamed answer', async () => {
    const options = {
      segments,
      meta: metaInfo,
      provider,
      apiKey: 'k',
      model: 'llama-3.3-70b-versatile',
      aiSettings: { strategy: 'single', stream: true, retries: 0, jsonRepair: false, singleFallback: false },
      output: { language: 'auto', length: 'standard' },
      uiLang: 'ru',
    };
    const streamed = await withFetch(
      () => sseResponse([{ choices: [{ delta: { content: payload } }] }]),
      () => runAiSummary(options),
    );
    const plain = await withFetch(
      () => jsonResponse({ choices: [{ message: { content: payload }, finish_reason: 'stop' }] }),
      () => runAiSummary({ ...options, aiSettings: { ...options.aiSettings, stream: false } }),
    );
    for (const field of ['tldr', 'keyPoints', 'sections', 'takeaways', 'actionItems', 'questions', 'quotes', 'entities', 'keywords']) {
      assertDeepEqual(streamed.res.result[field], plain.res.result[field], `${field} must match the full parse`);
    }
    assertEqual(streamed.calls.length, 1);
    assertEqual(plain.res.diagnostics.streamItems, 0, 'a non-streamed run emits no live items');
  });

  it('does not present a broken stream as a complete summary', async () => {
    let threw = null;
    const items = [];
    await withFetch(
      () =>
        sseResponse([
          { choices: [{ delta: { content: payload.slice(0, payload.indexOf('"takeaways"')) } }] },
          { error: { message: 'upstream died' } },
        ]),
      async () => {
        try {
          await runAiSummary({
            segments,
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: { strategy: 'single', stream: true, retries: 0, jsonRepair: false, singleFallback: false, allowFormatRetry: false, allowRateRetry: false },
            output: {},
            uiLang: 'ru',
            onProgress: (event) => {
              if (event.stage === 'stream-item') items.push(event);
            },
          });
        } catch (err) {
          threw = err;
        }
      },
    );
    assert(threw, 'a stream error must reject the run');
    assert(items.length > 0, 'validated items that already arrived stay available');
    assertEqual(threw.code, 'PROVIDER_ERROR');
  });

  it('stops the stream on cancel without firing another request', async () => {
    const controller = new AbortController();
    let threw = null;
    const items = [];
    const t0 = Date.now();
    const head = deltaSse(payload.slice(0, payload.indexOf('"takeaways"')));
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(head));
        /* never closes: the model is still “working” when the user stops it */
      },
    });
    const { calls } = await withFetch(
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      async () => {
        try {
          await runAiSummary({
            segments,
            meta: metaInfo,
            provider,
            apiKey: 'k',
            model: 'llama-3.3-70b-versatile',
            aiSettings: { strategy: 'single', stream: true, retries: 0, jsonRepair: false, singleFallback: false },
            output: {},
            uiLang: 'ru',
            signal: controller.signal,
            onProgress: (event) => {
              if (event.stage !== 'stream-item') return;
              items.push(event);
              controller.abort(new Error('cancelled'));
            },
          });
        } catch (err) {
          threw = err;
        }
      },
    );
    assert(threw, 'a cancelled run must reject');
    assertEqual(calls.length, 1, 'cancel must not start a retry');
    assert(items.length > 0, 'the item delivered before the cancel was validated');
    assert(Date.now() - t0 < 3000, 'cancel must end the stream promptly');
  });
});
describe('stream protocol variants', () => {
  const provider = providerFromPreset('openrouter');
  const segments = ruTranscript();
  const metaInfo = meta({ lengthSeconds: 120 });
  const ANSWER = JSON.stringify({
    tldr: 'Кэш узлов ускоряет повторный рендер, но требует ограничения памяти.',
    keyPoints: [
      { text: 'Повторный рендер: 40 мс вместо 800 мс.', at: 180 },
      { text: 'Кэш без ограничения памяти замедляет сборку мусора.', at: 900 },
    ],
    sections: [{ heading: 'Кэш узлов', at: 120, summary: 'Повторное использование узлов.', points: [] }],
  });

  const sseEvent = (obj, eol = '\n') => `data: ${JSON.stringify(obj)}${eol}${eol}`;
  const contentEvent = (text, eol = '\n') => sseEvent({ choices: [{ delta: { content: text } }] }, eol);
  const rawResponse = (chunks, { close = true } = {}) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
          if (close) controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const chatOptions = (extra = {}) => ({
    provider,
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    stream: true,
    timeoutMs: 4000,
    totalTimeoutMs: 4000,
    retries: 0,
    ...extra,
  });
  const summaryOptions = (extra = {}) => ({
    segments,
    meta: metaInfo,
    provider,
    apiKey: 'k',
    model: 'm',
    aiSettings: { strategy: 'single', stream: true, retries: 0, jsonRepair: false, singleFallback: false },
    output: {},
    uiLang: 'ru',
    ...extra,
  });
  const catchAsync = async (fn) => {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    return null;
  };

  it('parses CRLF framing split inside the separator', async () => {
    const cut = Math.floor(ANSWER.length / 2);
    const { res } = await withFetch(
      () =>
        rawResponse([
          contentEvent(ANSWER.slice(0, cut), '\r\n').slice(0, -1), // ends on `\r\n\r`
          '\n',
          contentEvent(ANSWER.slice(cut), '\r\n'),
          'data: [DONE]\r\n\r\n',
        ]),
      () => chat(chatOptions()),
    );
    assertEqual(res.text, ANSWER, 'CRLF framing must not swallow the answer');
  });

  it('releases the connection after [DONE] instead of waiting for a close', async () => {
    const t0 = Date.now();
    const { res } = await withFetch(
      () => rawResponse([contentEvent(ANSWER), 'data: [DONE]\n\n'], { close: false }),
      () => chat(chatOptions()),
    );
    assertEqual(res.text, ANSWER);
    const took = Date.now() - t0;
    assert(took < 1200, `[DONE] must end the call promptly, took ${took} ms`);
  });

  it('stops an Ollama NDJSON stream on done:true without a close', async () => {
    const ollama = providerFromPreset('ollama');
    const t0 = Date.now();
    const { res } = await withFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(enc.encode(`${JSON.stringify({ message: { content: ANSWER } })}\n`));
              controller.enqueue(enc.encode(`${JSON.stringify({ done: true })}\n`));
              /* no close, like a keep-alive connection */
            },
          }),
          { status: 200 },
        ),
      () => chat(chatOptions({ provider: ollama, model: 'llama3' })),
    );
    assertEqual(res.text, ANSWER);
    assert(Date.now() - t0 < 1200, 'done:true must end the call promptly');
  });

  it('stops an Anthropic stream on message_stop without a close', async () => {
    const anthropic = providerFromPreset('anthropic');
    const t0 = Date.now();
    const { res } = await withFetch(
      () =>
        rawResponse(
          [
            sseEvent({ type: 'content_block_delta', delta: { text: ANSWER } }),
            sseEvent({ type: 'message_stop' }),
          ],
          { close: false },
        ),
      () => chat(chatOptions({ provider: anthropic, model: 'claude-3-5-sonnet-latest' })),
    );
    assertEqual(res.text, ANSWER);
    assert(Date.now() - t0 < 1200, 'message_stop must end the call promptly');
  });

  it('reads a Google SSE stream split into candidate parts', async () => {
    const google = providerFromPreset('google');
    const { res } = await withFetch(
      () =>
        rawResponse([
          sseEvent({ candidates: [{ content: { parts: [{ text: ANSWER.slice(0, 40) }] } }] }),
          sseEvent({ candidates: [{ content: { parts: [{ text: ANSWER.slice(40) }] }, finishReason: 'STOP' }] }),
        ]),
      () => chat(chatOptions({ provider: google, model: 'gemini-1.5-flash' })),
    );
    assertEqual(res.text, ANSWER);
    assertEqual(res.finishReason, 'STOP');
    const cut = await withFetch(
      () =>
        rawResponse([
          sseEvent({ candidates: [{ content: { parts: [{ text: ANSWER.slice(0, 40) }] }, finishReason: 'MAX_TOKENS' }] }),
        ]),
      () => chat(chatOptions({ provider: google, model: 'gemini-1.5-flash' })),
    );
    assertEqual(cut.res.finishReason, 'MAX_TOKENS');
    assertEqual(cut.res.truncated, true, 'a cut-off Google stream must be marked truncated');
  });

  it('treats finish_reason:error as a provider error', async () => {
    const err = await catchAsync(() =>
      withFetch(
        () =>
          rawResponse([
            contentEvent(ANSWER),
            sseEvent({ choices: [{ delta: {}, finish_reason: 'error' }] }),
            'data: [DONE]\n\n',
          ]),
        () => chat(chatOptions()),
      ),
    );
    assert(err, 'the call must fail');
    assertEqual(err.code, 'PROVIDER_ERROR');
  });

  it('keeps usage and finish from empty service chunks', async () => {
    const { res } = await withFetch(
      () =>
        rawResponse([
          contentEvent(ANSWER),
          sseEvent({ choices: [{ delta: {} }] }),
          sseEvent({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          sseEvent({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
          'data: [DONE]\n\n',
        ]),
      () => chat(chatOptions()),
    );
    assertEqual(res.text, ANSWER);
    assertEqual(res.finishReason, 'stop');
    assertEqual(res.usage.promptTokens, 11);
    assertEqual(res.usage.completionTokens, 7);
  });

  it('ignores keepalive comments between events', async () => {
    const { res } = await withFetch(
      () =>
        rawResponse([
          ': ping\n\n',
          contentEvent(ANSWER.slice(0, 30)),
          ': keepalive\n\n',
          contentEvent(ANSWER.slice(30)),
          'data: [DONE]\n\n',
        ]),
      () => chat(chatOptions()),
    );
    assertEqual(res.text, ANSWER);
  });

  it('drops a BOM before the first SSE event', async () => {
    const { res } = await withFetch(
      () => rawResponse(['\uFEFF' + contentEvent(ANSWER), 'data: [DONE]\n\n']),
      () => chat(chatOptions()),
    );
    assertEqual(res.text, ANSWER);
  });

  it('keeps an HTML error body out of the user message', async () => {
    const err = await catchAsync(() =>
      withFetch(
        () => new Response('<html><body>Bad gateway</body></html>', { status: 502, headers: { 'content-type': 'text/html' } }),
        () => chat(chatOptions()),
      ),
    );
    assert(err, 'an HTTP error must fail');
    assertEqual(err.code, 'SERVER');
    assert(!String(err.message).includes('<html'), `the message must not contain HTML, got: ${err.message}`);
  });

  it('rejects a stream cut off mid-JSON and publishes no final result', async () => {
    const items = [];
    const err = await catchAsync(() =>
      withFetch(
        () => rawResponse([contentEvent(ANSWER.slice(0, ANSWER.indexOf('"sections"')))], { close: true }),
        () =>
          runAiSummary(
            summaryOptions({
              onProgress: (event) => {
                if (event.stage === 'stream-item') items.push(event);
              },
            }),
          ),
      ),
    );
    assert(err, 'a cut-off answer must reject');
    assertEqual(err.code, 'BAD_JSON');
    assert(items.length > 0, 'items closed before the cut stay available for the panel draft');
  });

  it('does not treat reasoning deltas as summary text or items', async () => {
    const deltas = [];
    const items = [];
    const err = await catchAsync(() =>
      withFetch(
        () =>
          rawResponse([
            sseEvent({ choices: [{ delta: { reasoning: 'Сначала подумаю о кэше и памяти. ' } }] }),
            'data: [DONE]\n\n',
          ]),
        () =>
          runAiSummary(
            summaryOptions({
              onDelta: (delta) => deltas.push(delta.chunk),
              onProgress: (event) => {
                if (event.stage === 'stream-item') items.push(event);
              },
            }),
          ),
      ),
    );
    assert(err, 'reasoning alone is not a summary');
    assertEqual(deltas.length, 0, 'reasoning must never reach the delta/extractor path');
    assertEqual(items.length, 0, 'reasoning must never become a summary item');
  });

  it('starts a fresh stream id when a dropped answer is retried', async () => {
    let attempt = 0;
    const items = [];
    const first = '{"tldr":"Первый ответ про кэш","keyPoints":[{"text":"Хвост оборванного';
    const cleanTldr = 'Чистый ответ после повтора: кэш ускоряет рендер и требует ограничения памяти.';
    const second = JSON.stringify({
      tldr: cleanTldr,
      keyPoints: [
        { text: 'Пункт чистого ответа', at: 5 },
        { text: 'Второй пункт чистого ответа', at: 9 },
      ],
    });
    const { res, calls } = await withFetch(
      () => {
        attempt++;
        if (attempt === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(enc.encode(contentEvent(first)));
                setTimeout(() => controller.error(new Error('socket hang up')), 5);
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return rawResponse([contentEvent(second), 'data: [DONE]\n\n']);
      },
      () =>
        runAiSummary(
          summaryOptions({
            aiSettings: { strategy: 'single', stream: true, retries: 1, jsonRepair: false, singleFallback: false },
            onProgress: (event) => {
              if (event.stage === 'stream-item') items.push(event);
            },
          }),
        ),
    );
    assertEqual(calls.length, 2, 'exactly one retry is allowed');
    const ids = [...new Set(items.map((item) => item.streamId))];
    assertEqual(ids.length, 2, `each attempt must own a stream id, got ${ids.join(', ')}`);
    const last = items.filter((item) => item.streamId === ids[1]);
    assertEqual(last[0].item.kind, 'tldr');
    assertEqual(last[0].item.text, cleanTldr);
    assert(
      last.every((item) => !String(item.item.text || '').includes('{')),
      'a retried answer must not be glued to the dropped one',
    );
    assertEqual(res.result.tldr, cleanTldr);
  });

  it('publishes a validated item over a real socket before the answer ends', async () => {
    const cut = ANSWER.indexOf('"keyPoints"');
    const head = ANSWER.slice(0, cut);
    const tail = ANSWER.slice(cut);
    let finished = false;
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.write(contentEvent(head, '\r\n'));
        gate.then(() => {
          finished = true;
          res.write(contentEvent(tail, '\r\n'));
          res.write('data: [DONE]\r\n\r\n');
          res.end();
        });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const liveProvider = providerFromPreset('openrouter', {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      });
      const safety = setTimeout(release, 3000);
      const out = await runAiSummary(
        summaryOptions({
          provider: liveProvider,
          onProgress: (event) => {
            if (event.stage !== 'stream-item') return;
            seen.push({ kind: event.item.kind, serverFinished: finished });
            if (event.item.kind === 'tldr') {
              clearTimeout(safety);
              release();
            }
          },
        }),
      );
      clearTimeout(safety);
      assertEqual(seen.length, 4, `expected tldr + 2 points + section, got ${seen.length}`);
      assertEqual(seen[0].kind, 'tldr');
      assertEqual(seen[0].serverFinished, false, 'the item must arrive while the server still holds the rest');
      assertEqual(out.result.tldr, JSON.parse(ANSWER).tldr);
      assertEqual(out.complete, true);
      assertEqual(out.diagnostics.streamItems, 4);
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
  });
});

describe('grounding check', () => {
  const transcript = 'Кэш ускорил ответ с 800 миллисекунд до 40. В 2023 году команда переписала индексы.';
  const result = {
    tldr: '',
    keyPoints: [
      { text: 'Задержка упала с 800 до 40 миллисекунд.' },
      { text: 'В 2019 году команда переписала индексы.' },
    ],
    takeaways: ['Кэш без инвалидации опаснее, чем его отсутствие.'],
    sections: [{ summary: '', points: [{ text: 'Экономия составила 95 процентов.' }] }],
    quotes: [
      { text: 'Кэш ускорил ответ с 800 миллисекунд до 40' },
      { text: 'Мы полностью переписали базу за неделю' },
    ],
  };

  it('extracts the numbers of a claim', () => {
    assertDeepEqual(claimNumbers('с 800 до 40,5 мс в 2023 году'), ['800', '40,5', '2023']);
  });

  it('flags only the numbers the transcript does not contain', () => {
    assertDeepEqual(unsupportedNumbers('В 2019 году было 800 запросов.', new Set(['800', '2023'])), ['2019']);
  });

  it('reports unsupported figures without rewriting the summary', () => {
    const report = verifyResult(result, transcript);
    assertEqual(report.unsupported.length, 2, `expected two unsupported claims, got ${JSON.stringify(report.unsupported)}`);
    assert(report.unsupported.some((u) => u.missing.includes('2019')), 'the invented year must be reported');
    assert(report.unsupported.some((u) => u.missing.includes('95')), 'the invented percentage must be reported');
    assertEqual(report.checked, 4, 'every point, takeaway and section bullet is checked');
    assertEqual(report.unverifiedQuotes, 1, 'the paraphrased quote is counted');
    assertEqual(result.keyPoints[1].text, 'В 2019 году команда переписала индексы.', 'claims are reported, not deleted');
  });

  it('reports a clean result as checked and clean', () => {
    const clean = verifyResult({ ...result, keyPoints: [{ text: 'Задержка упала до 40 миллисекунд.' }], sections: [], quotes: [] }, transcript);
    assertEqual(clean.unsupported.length, 0);
    assertEqual(clean.checked, 2);
  });

  it('wires the report into the run diagnostics and warnings', async () => {
    const provider = providerFromPreset('groq');
    const segments = ruTranscript();
    const { res } = await withFetch(
      () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  tldr: 'Кэширование и инвалидация.',
                  keyPoints: [
                    { text: 'В 2019 году кэш ускорил систему.', at: '0:05' },
                    { text: 'Инвалидация важнее TTL.', at: '0:20' },
                  ],
                  quotes: [{ text: 'Такой фразы в видео не было', at: '0:10' }],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      () =>
        runAiSummary({
          segments,
          meta: meta({}),
          provider,
          apiKey: 'k',
          model: 'm',
          aiSettings: { strategy: 'single', stream: false },
          output: {},
          uiLang: 'ru',
        }),
    );
    assertEqual(res.diagnostics.grounding.unsupported, 1, 'the invented year must reach diagnostics');
    assertEqual(res.diagnostics.grounding.unverifiedQuotes, 1);
    assert(res.warnings.some((w) => w.includes('Проверка по транскрипту')), `expected a grounding warning, got ${JSON.stringify(res.warnings)}`);
    assert(res.result.meta.grounding.unsupported.length === 1, 'the claim is kept and marked in result.meta');
    assert(res.result.meta.warnings.some((w) => w.includes('Проверка по транскрипту')), 'the note travels with the saved result');
  });
});
