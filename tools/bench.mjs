#!/usr/bin/env node
/**
 * Manual, opt-in benchmark for the real AI path.
 *
 * It never runs from `npm test` and never sends a request without `--live`.
 * The report contains timings, token usage, the model the API reported and
 * whether the control facts survived — never the API key, headers, prompts or
 * the transcript itself.
 *
 *   OPENROUTER_API_KEY=... npm run bench -- --live --transcript=video.txt
 *   ... npm run bench -- --live --strategy=map-reduce --allow-many --transcript=video.txt
 *
 * A single-pass run costs exactly one request (no retries, no JSON repair, no
 * fallback). Map-reduce may cost a dozen, so it requires `--allow-many` as a
 * second explicit confirmation. `--synthetic` is only for harness tests.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { runAiSummary } from '../src/ai/pipeline.js';
import { providerFromPreset } from '../src/ai/providers.js';
import { buildBlocks, buildChunks, estimateTokens, renderBlocks } from '../src/ai/chunking.js';
import { countWords } from '../src/common/util.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value === undefined ? true : value];
  }),
);

function usage() {
  console.log(`OpenSummary benchmark (manual only)

  --live                 required; without it nothing is sent
  --strategy=single      single-pass (default)
  --strategy=map-reduce  explicit fallback comparison
  --allow-many           required for map-reduce (spends several requests)
  --transcript=FILE      local transcript ([hh:]mm:ss text, WebVTT, or plain text)
  --synthetic            use the built-in fixture (harness tests only)
  --model=...            default: openrouter/free
  --base-url=...         override the endpoint (local mock / compatible gateway)
  --mock                 start a loopback SSE mock (no key, simulated timings)
  --no-stream            with --mock: one non-streamed JSON answer instead
  --mock-delay=80        ms between mock stream events
  --mock-chunks=16       number of mock stream events
  --context=128000       context budget
  --chunk=6000           chunk size for map-reduce
  --timeout=180000       per-request timeout, ms
  --out=bench-report.json
  --sentences=1300       synthetic transcript length

The API key is read from OPENROUTER_API_KEY and is never written anywhere.
`);
}

if (!args.live) {
  usage();
  process.exit(2);
}

const strategy = String(args.strategy || 'single');
if (strategy === 'map-reduce' && !args['allow-many']) {
  console.error('map-reduce can spend many requests. Re-run with --allow-many if you accept that.');
  process.exit(2);
}
if (args.mock && args['base-url']) {
  console.error('--mock runs its own loopback server; drop --base-url.');
  process.exit(2);
}
const apiKey = process.env.OPENROUTER_API_KEY || (args.mock ? 'mock-local' : '');
if (!apiKey.trim()) {
  console.error('OPENROUTER_API_KEY is not set. Nothing was sent.');
  process.exit(2);
}

/**
 * Mock of an OpenAI-compatible endpoint for offline measurements.
 *
 * Both modes answer the same payload after the same simulated generation time;
 * the only difference is delivery: one SSE event per slice, or one JSON body at
 * the end. Timings therefore show what streaming itself changes, not what a
 * model would do.
 */
function mockSummary() {
  return JSON.stringify({
    tldr: 'Кэш промежуточных узлов ускоряет повторный рендер, ленивые вычисления убирают лишнюю работу, но кэш без ограничения памяти замедляет сборку мусора.',
    keyPoints: [
      { text: 'Кэш узлов сокращает повторный рендер с 40 до 6 мс.', at: 180, ts: '3:00' },
      { text: 'Ленивые вычисления откладывают работу до первого обращения к значению.', at: 420, ts: '7:00' },
      { text: 'Без ограничения памяти кэш растёт и замедляет сборку мусора.', at: 900, ts: '15:00' },
    ],
    sections: [
      {
        heading: 'Кэш узлов',
        at: 120,
        ts: '2:00',
        summary: 'Автор показывает, как повторное использование узлов убирает лишние проходы.',
        points: [{ text: 'Замер до и после: 40 мс против 6 мс.', at: 180, ts: '3:00' }],
      },
    ],
    takeaways: ['Кэш помогает только при повторных запросах.', 'Память кэша нужно ограничивать.'],
    quotes: [{ text: 'Кэш — это компромисс, а не бесплатный обед.', at: 900, ts: '15:00' }],
  });
}

async function startMockProvider({ stream, chunks, delayMs }) {
  const body = mockSummary();
  const totalMs = chunks * delayMs;
  const server = createServer((req, res) => {
    req.resume();
    // Answer only after the request body is in: replying mid-upload can leave
    // the client waiting for a response that is already buffered.
    req.on('end', () => {
      if (!stream) {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'mock-plain',
              model: 'mock-plain',
              choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 4200, completion_tokens: 260 },
            }),
          );
        }, totalMs);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      res.flushHeaders?.();
      // Split by code point so surrogate pairs are never cut between events.
      const chars = Array.from(body);
      const size = Math.max(1, Math.ceil(chars.length / chunks));
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks) {
          clearInterval(timer);
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          send({ choices: [], usage: { prompt_tokens: 4200, completion_tokens: 260 } });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        send({ choices: [{ delta: { content: chars.slice(i * size, (i + 1) * size).join('') } }] });
        i++;
      }, delayMs);
      res.on('close', () => clearInterval(timer));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const mock = args.mock
  ? await startMockProvider({
      stream: !args['no-stream'],
      chunks: Math.max(2, Number(args['mock-chunks']) || 16),
      delayMs: Math.max(5, Number(args['mock-delay']) || 80),
    })
  : null;
if (mock) {
  console.log(
    `mock provider: ${args['no-stream'] ? 'one JSON body after' : `${Number(args['mock-chunks']) || 16} SSE events over`} ` +
      `${(Math.max(2, Number(args['mock-chunks']) || 16) * Math.max(5, Number(args['mock-delay']) || 80))} ms (simulated)`,
  );
}

function timeToSeconds(value) {
  const parts = String(value || '')
    .replace(',', '.')
    .split(':')
    .map((v) => Number.parseFloat(v) || 0);
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1]);
  return 0;
}

/**
 * Local transcript reader: preserves timecodes when present, accepts WebVTT and
 * `[hh:]mm:ss text` lines, and falls back to plain text with estimated timing.
 * Nothing is uploaded; the file is read from disk only.
 */
function parseTranscript(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let nextStart = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === 'WEBVTT' || line === 'NOTE' || line.startsWith('NOTE ') || /^\d+$/.test(line)) continue;
    if (/\d{1,3}:\d{2}[.,]\d{3}\s*-->/.test(line)) {
      out.push({ start: timeToSeconds(line.split('-->')[0].trim()), dur: 0, text: '' });
      continue;
    }
    const marked = line.match(/^\[?((?:\d{1,3}:)?\d{1,2}:\d{2})\]?\s*(.*)$/);
    if (marked && marked[2].trim()) {
      out.push({ start: timeToSeconds(marked[1]), dur: 0, text: marked[2].trim() });
      nextStart = timeToSeconds(marked[1]) + 1;
      continue;
    }
    // A WebVTT cue placeholder receives the following text lines.
    if (out.length && !out[out.length - 1].text) {
      out[out.length - 1].text = line;
      continue;
    }
    out.push({ start: nextStart, dur: 0, text: line });
    nextStart += Math.max(2, Math.round(line.split(/\s+/).length / 2.5));
  }
  const segments = out.filter((seg) => seg.text);
  for (let i = 0; i < segments.length; i++) {
    const next = segments[i + 1]?.start;
    const estimated = Math.max(2, Math.round(segments[i].text.split(/\s+/).length / 2.5));
    segments[i].dur = next != null && next > segments[i].start ? next - segments[i].start : estimated;
  }
  return segments;
}

/** Synthetic transcript with three unmistakable facts at start / middle / end. */
function benchTranscript(sentenceCount = 1300) {
  const facts = [
    { at: 0, text: 'КОНТРОЛЬ-АЛЬФА: проект запущен в январе, бюджет 42 миллиона рублей.' },
    { at: Math.floor(sentenceCount / 2), text: 'КОНТРОЛЬ-БЕТА: задержка снизилась с 800 до 40 миллисекунд.' },
    { at: sentenceCount - 1, text: 'КОНТРОЛЬ-ГАММА: в финале команда решила отказаться от кэша без инвалидации.' },
  ];
  const topics = ['индексы', 'транзакции', 'репликация', 'очереди', 'наблюдаемость', 'профилирование', 'кэширование'];
  const segments = [];
  for (let i = 0; i < sentenceCount; i++) {
    const fact = facts.find((f) => f.at === i);
    const text = fact
      ? fact.text
      : `На шаге ${i + 1} разбираем ${topics[i % topics.length]}: это влияет на скорость и надёжность системы, поэтому решение нужно измерять.`;
    segments.push({ start: i * 4, dur: 4, text });
  }
  return segments;
}

let segments;
let transcriptSource;
let transcriptFile = '';
if (args.transcript) {
  try {
    const text = readFileSync(String(args.transcript), 'utf8');
    segments = parseTranscript(text);
    transcriptFile = basename(String(args.transcript));
    transcriptSource = 'file';
  } catch (err) {
    console.error(`Cannot read transcript file: ${err.message}`);
    process.exit(2);
  }
} else if (args.synthetic) {
  segments = benchTranscript(Math.max(100, Number(args.sentences) || 1300));
  transcriptSource = 'synthetic';
} else {
  console.error('Live run needs a real transcript: pass --transcript=FILE (or --synthetic for harness tests).');
  process.exit(2);
}

if (!segments.length) {
  console.error('The transcript is empty.');
  process.exit(2);
}

const last = segments[segments.length - 1];
const meta = {
  videoId: transcriptSource === 'file' ? 'bench-file' : 'bench-openrouter',
  videoTitle: transcriptSource === 'file' ? transcriptFile : 'OpenSummary benchmark transcript',
  channel: 'OpenSummary',
  lengthSeconds: Math.round((last.start || 0) + (last.dur || 0)),
  lang: 'ru',
  source: 'benchmark',
  autoGenerated: true,
  url: '',
};

const prepareStarted = Date.now();
const blocks = buildBlocks(segments);
const transcriptText = renderBlocks(blocks);
const estimatedTokens = estimateTokens(transcriptText);
const chunks = buildChunks(segments, { maxTokens: Number(args.chunk) || 6000 });
const prepareMs = Date.now() - prepareStarted;

if (countWords(transcriptText) < 1000) {
  console.error('The benchmark transcript is too short to be meaningful.');
  process.exit(2);
}

const progress = [];
const started = Date.now();
const provider = providerFromPreset(
  'openrouter',
  mock || args['base-url'] ? { baseUrl: mock ? mock.url : String(args['base-url']) } : {},
);
const report = {
  mode: mock ? 'mock' : 'live',
  app: 'opensummary',
  generatedAt: new Date().toISOString(),
  model: String(args.model || 'openrouter/free'),
  strategy,
  transcript: {
    source: transcriptSource,
    file: transcriptFile,
    sentences: segments.length,
    words: countWords(transcriptText),
    estimatedTokens,
    durationSeconds: meta.lengthSeconds,
    chunks: chunks.length,
  },
  settings: {
    contextTokens: Number(args.context) || 128000,
    chunkTokens: Number(args.chunk) || 6000,
    timeoutMs: Number(args.timeout) || 180000,
    retries: 0,
    jsonRepair: false,
    singleFallback: false,
  },
  timings: {
    prepareMs,
    totalMs: 0,
    apiMs: 0,
    localMs: 0,
    jsonParseMs: 0,
    resultBuildMs: 0,
    firstProgressMs: null,
  },
  controlFacts: { start: false, middle: false, end: false },
  result: null,
  calls: [],
  error: null,
  limitations: [
    mock
      ? 'Mock provider: timings are simulated delivery of a fixed answer, not a model or network measurement.'
      : 'Numbers are one live run from this machine and this account; they are not a benchmark of the provider at large.',
    'Token counts come from the API usage fields when provided, otherwise from the local estimator.',
  ],
};

try {
  const { result, usage, diagnostics, warnings, complete, strategy: chosen } = await runAiSummary({
    segments,
    meta,
    provider,
    apiKey,
    model: report.model,
    aiSettings: {
      strategy,
      contextTokens: Number(args.context) || 128000,
      chunkTokens: Number(args.chunk) || 6000,
      concurrency: 3,
      stream: !args['no-stream'],
      // Exactly one request: no network retry, no 429 retry, no JSON-mode
      // retry, no repair call, no compact/context fallback.
      retries: 0,
      allowRateRetry: false,
      allowFormatRetry: false,
      jsonRepair: false,
      singleFallback: false,
      timeoutMs: Number(args.timeout) || 180000,
    },
    output: { language: 'ru', length: 'standard', tone: 'neutral' },
    uiLang: 'ru',
    onProgress: (event) => {
      if (report.timings.firstProgressMs == null) report.timings.firstProgressMs = Date.now() - started;
      progress.push({ stage: event.stage, at: Date.now() - started, done: event.done, total: event.total });
    },
    onDelta: () => {
      if (report.timings.firstProgressMs == null) report.timings.firstProgressMs = Date.now() - started;
    },
  });

  const totalMs = Date.now() - started;
  const apiMs = diagnostics?.providerMs || (diagnostics?.chunks || []).reduce((sum, call) => sum + (call.ms || 0), 0);
  report.timings.totalMs = totalMs;
  report.timings.apiMs = apiMs;
  // Everything that is not waiting for the provider: planning, JSON parsing,
  // validation and building SummaryResult.
  report.timings.localMs = diagnostics?.localMs ?? Math.max(0, totalMs - apiMs);
  report.timings.jsonParseMs = diagnostics?.jsonParseMs || 0;
  report.timings.resultBuildMs = diagnostics?.resultBuildMs || 0;
  report.strategy = chosen;
  report.complete = complete !== false;
  report.usage = usage;
  report.warnings = (warnings || []).slice(0, 8);
  report.progress = progress.slice(0, 80);
  report.calls = (diagnostics?.chunks || []).map((call) => ({
    stage: call.stage,
    chunkId: call.chunkId,
    headersMs: call.headersMs,
    ttftMs: call.ttftMs,
    genMs: call.genMs,
    ms: call.ms,
    tokensIn: call.in,
    tokensOut: call.out,
    estimatedIn: call.estimatedIn,
    attempts: call.attempts,
    retries: call.retries,
    finish: call.finish,
    model: call.model,
    upstream: call.upstream,
    genId: call.genId,
    json: call.json,
    jsonOk: call.jsonOk,
    truncated: call.truncated,
    error: call.error,
  }));
  report.generationIds = report.calls.map((call) => call.genId).filter(Boolean);
  report.fallbacks = diagnostics?.fallbacks || [];
  report.estimatedRequestTokens = diagnostics?.requestEstimatedTokens || 0;
  report.outputLimit = diagnostics?.outputLimit || 0;
  // Where the wall clock went, per stage, and how often the provider pushed
  // back. These are the fields a before/after table needs; all of them come
  // from the pipeline's own diagnostics, not from a second estimate.
  report.stagesMs = diagnostics?.stageMs || {};
  report.reduceRounds = diagnostics?.reduceRounds || 0;
  report.concurrency = diagnostics?.concurrency || 0;
  report.rateLimited = diagnostics?.rateLimited || 0;
  report.mapPausedMs = diagnostics?.mapPausedMs || 0;
  report.mapQueueMs = diagnostics?.mapQueueMs || 0;
  report.firstPartialMs = diagnostics?.firstPartialMs || 0;
  report.timings.firstPartialMs = diagnostics?.firstPartialMs || 0;
  report.chunkCounts = diagnostics?.chunkCounts || null;
  // Single-pass streaming: when the answer's first text and first validated
  // item could be shown. These make “time to first useful result” measurable on
  // a live run instead of inferring it from the total duration.
  report.streamFirstTextMs = diagnostics?.streamFirstTextMs || 0;
  report.streamFirstItemMs = diagnostics?.streamFirstItemMs || 0;
  report.streamItems = diagnostics?.streamItems || 0;
  // The router may pick a different upstream model per request; each call
  // already carries the model the API reported.
  report.models = [...new Set(report.calls.map((call) => call.model).filter(Boolean))];

  const summaryText = [
    result.tldr,
    ...(result.keyPoints || []).map((p) => p.text),
    ...(result.sections || []).flatMap((s) => [s.heading, s.summary, ...(s.points || []).map((p) => p.text)]),
    ...(result.takeaways || []),
    ...(result.quotes || []).map((q) => q.text),
  ]
    .filter(Boolean)
    .join('\n');
  // Synthetic control facts are a harness test, not a quality claim about the
  // user's real transcript.
  report.controlFacts =
    transcriptSource === 'synthetic'
      ? { start: /АЛЬФА/.test(summaryText), middle: /БЕТА/.test(summaryText), end: /ГАММА/.test(summaryText) }
      : null;
  report.result = {
    tldrChars: String(result.tldr || '').length,
    keyPoints: (result.keyPoints || []).length,
    sections: (result.sections || []).length,
    hasTimestamps: (result.keyPoints || []).some((p) => p.ts),
    firstTimestamp: (result.keyPoints || []).find((p) => p.ts)?.ts || '',
    lastTimestamp:
      (result.keyPoints || [])
        .map((p) => p.at)
        .filter((v) => typeof v === 'number')
        .sort((a, b) => a - b)
        .pop() || null,
  };
  console.log(`\nstrategy: ${chosen} | complete: ${report.complete} | total ${totalMs} ms | api ${apiMs} ms`);
  console.log(
    `calls: ${report.calls.length} | ttft ${report.calls[0]?.ttftMs || 0} ms | ` +
      `tokens in/out: ${usage.promptTokens}/${usage.completionTokens} | model: ${report.calls[0]?.model || report.model}`,
  );
  if (report.streamItems) {
    console.log(
      `streamed items: ${report.streamItems} | first text ${report.streamFirstTextMs} ms | ` +
        `first validated item ${report.streamFirstItemMs} ms of ${totalMs} ms`,
    );
  }
  if (report.controlFacts) {
    console.log(
      `synthetic facts: start=${report.controlFacts.start} middle=${report.controlFacts.middle} end=${report.controlFacts.end}`,
    );
  }
} catch (err) {
  report.timings.totalMs = Date.now() - started;
  report.error = {
    code: err?.code || 'ERROR',
    message: String(err?.message || err).slice(0, 400),
    status: err?.status || 0,
  };
  console.error(`\nbenchmark failed: ${report.error.code} — ${report.error.message}`);
}

if (mock) await mock.close();

const out = String(args.out || 'bench-report.json');
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`report: ${out}`);
console.log('No API key, headers, prompts or transcript text were written to the report.');
