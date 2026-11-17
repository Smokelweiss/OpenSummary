/**
 * AI summarization pipeline: single-shot, map-reduce and Q&A, with retries,
 * graceful degradation and progress reporting.
 */

import { chat, AIError, operationBudgetMs } from './client.js';
import { buildChunks, planStrategy, renderBlocks, buildBlocks, blockLine, estimateTokens } from './chunking.js';
import { parseAiJson, salvageAiJson } from './json.js';
import { coercePayload, looksLikeProseAnswer, proseToPayload } from './coerce.js';
import { compactMessages, mapMessages, reduceMessages, repairMessages, singleMessages, qaMessages, timelineMessages, resolveOutputLanguage, PROMPT_VERSION } from './prompts.js';
import { createSummaryStream } from './stream-json.js';
import { verifyResult, verificationWarnings } from './verify.js';
import { normalizeResult, normalizeSection, withoutPlaceholder } from '../nlp/schema.js';
import { formatTime, truncate, countWords, computeSummaryStats, hashString } from '../common/util.js';
import { tokenize, stemsOf } from '../nlp/tokenize.js';
import { bm25 } from '../nlp/similarity.js';

const noop = () => {};

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = new Array(size).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * A concurrency limit that can shrink while the run is going. Free tiers allow
 * one request per 30 s while paid endpoints take fifteen chunks at once, and
 * the pipeline only learns which one it is talking to from a 429 — so the limit
 * halves on rate limits instead of the whole video failing.
 */
export function createLimiter(limit) {
  return {
    current: Math.max(1, Number(limit) || 1),
    // Earliest wall-clock moment the next request may leave. A 429 (and its
    // Retry-After) concerns the whole run, not only the chunk that received
    // it, so every queued fragment waits for the same cooldown.
    readyAt: 0,
    lower() {
      this.current = Math.max(1, Math.floor(this.current / 2));
      return this.current;
    },
    /** Holds every new request for `ms`; returns what is left of the wait. */
    pause(ms) {
      const wait = Math.max(0, Number(ms) || 0);
      if (!wait) return this.waitMs();
      this.readyAt = Math.max(this.readyAt, Date.now() + wait);
      return this.waitMs();
    },
    waitMs() {
      return Math.max(0, this.readyAt - Date.now());
    },
  };
}

/**
 * Like `mapLimit`, but the number of requests in flight follows a limiter that
 * may drop mid-run (a 429 from the provider). Chunks already running finish;
 * the queue stops opening new ones until fewer requests are in flight.
 */
export async function mapAdaptive(items, worker, limiter) {
  const results = new Array(items.length);
  let cursor = 0;
  let active = 0;
  let failure = null;
  let timer = null;
  await new Promise((resolve) => {
    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve();
    };
    const pump = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (failure || (active === 0 && cursor >= items.length)) return finish();
      // A provider that just said “too many requests” is not asked again until
      // the shared cooldown ends. Chunks already in flight still finish; the
      // lowered window applies to everything that starts after it.
      const wait = limiter.waitMs ? limiter.waitMs() : 0;
      if (wait > 0) {
        timer = setTimeout(pump, Math.min(wait, 5000));
        return;
      }
      while (!failure && cursor < items.length && active < limiter.current) {
        const index = cursor++;
        active++;
        Promise.resolve()
          .then(() => worker(items[index], index))
          .then(
            (value) => { results[index] = value; },
            (err) => { failure = failure || err; },
          )
          .then(() => { active--; pump(); });
      }
      if (!failure && active === 0 && cursor >= items.length) finish();
    };
    pump();
  });
  if (failure) throw failure;
  return results;
}

/** Runs one call and parses JSON, repairing once with a dedicated prompt. */
async function callForJson({ messages, ctx, onDelta, onRetry, repair = true, jsonMode = true }) {
  const res = await chat({ ...ctx, messages, onDelta, onRetry, jsonMode });
  let parseStarted = Date.now();
  let parsed = parseAiJson(res.text);
  let jsonMs = Date.now() - parseStarted;
  if (parsed.ok) return { ...res, json: coercePayload(parsed.value), parseStrategy: parsed.strategy, jsonMs, jsonOk: true };
  // A cut-off answer must not trigger a JSON “repair” request: it cannot fit
  // either, and the pipeline owns the one deliberate retry with a bigger
  // output budget. Return the truncation so it can salvage complete fields.
  if (res.truncated) {
    return { ...res, json: null, parseStrategy: 'truncated', jsonMs, jsonOk: false };
  }
  // A readable answer without JSON is still a конспект: free models often
  // ignore the schema and write Markdown. Repairing costs a whole extra call
  // and usually fails on the same model, so prose is accepted directly.
  if (looksLikeProseAnswer(res.text)) {
    return {
      ...res,
      json: coercePayload(proseToPayload(res.text)),
      parseStrategy: 'prose',
      jsonMs,
      jsonOk: true,
    };
  }
  if (!repair) throw new AIError('BAD_JSON', 'Модель вернула не-JSON', { detail: truncate(res.text, 300) });
  const broken = String(res.text || '');
  // Nothing to repair when the answer is empty or has no JSON in it at all:
  // asking again used to double the wait for the same nothing.
  if (!broken.includes('{')) {
    throw new AIError('BAD_JSON', 'Модель ответила текстом без JSON', {
      hint: 'Попробуйте другую модель или уменьшите объём конспекта.',
      detail: truncate(broken, 300),
    });
  }
  const repaired = await chat({
    ...ctx,
    messages: repairMessages({ broken: res.text, opts: ctx.opts || {} }),
    stream: false,
    onDelta: undefined,
  });
  parseStarted = Date.now();
  parsed = parseAiJson(repaired.text);
  jsonMs += Date.now() - parseStarted;
  const merged = {
    ...repaired,
    usage: {
      promptTokens: (res.usage?.promptTokens || 0) + (repaired.usage?.promptTokens || 0),
      completionTokens: (res.usage?.completionTokens || 0) + (repaired.usage?.completionTokens || 0),
    },
    latencyMs: (res.latencyMs || 0) + (repaired.latencyMs || 0),
  };
  if (!parsed.ok) {
    // Some models ignore "JSON only" in both attempts and answer in prose.
    // The text is still a конспект: use it instead of failing the run.
    const prose = [repaired.text, res.text].find((text) => looksLikeProseAnswer(text));
    if (prose != null) {
      return {
        ...merged,
        json: coercePayload(proseToPayload(prose)),
        jsonMs,
        jsonOk: true,
        parseStrategy: 'prose',
      };
    }
    const err = new AIError('BAD_JSON', 'Модель вернула ответ, который не удалось разобрать как JSON', {
      hint: 'Попробуйте другую модель (лучше поддерживающую JSON-режим) или уменьшите объём конспекта.',
      detail: truncate(res.text, 300),
    });
    err.rawText = res.text;
    throw err;
  }
  return {
    ...merged,
    json: coercePayload(parsed.value),
    jsonMs,
    jsonOk: true,
    parseStrategy: `repaired:${parsed.strategy}`,
  };
}

/**
 * Errors that mean "the answer did not fit into the request". They are worth one
 * retry with a larger output budget: reasoning models burn the whole budget
 * before they write any JSON. Codes that cannot be fixed by more tokens (auth,
 * rate limit…) are deliberately not listed.
 */
const BUDGET_CODES = new Set(['TRUNCATED', 'CONTEXT_LENGTH']);

/**
 * Codes that mean “the answer itself was useless”. A short, different ask has a
 * real chance where repeating the huge one does not.
 */
const COMPACT_RETRY_CODES = new Set(['EMPTY_RESULT', 'EMPTY_RESPONSE', 'BAD_JSON']);

/** Budget and deadline of the compact retry (short profile, no streaming). */
const COMPACT_OUTPUT_TOKENS = 1600;
const COMPACT_TIMEOUT_MS = 45000;

/** Hard cap on the map phase, kept from the pre-deadline pipeline. */
export const MAP_DEADLINE_MS = 10 * 60 * 1000;
/** Local JSON parsing, validation and result building for a whole job. */
export const JOB_LOCAL_RESERVE_MS = 10000;
/** At most two hierarchical reduce rounds, as before. */
export const REDUCE_ROUND_LIMIT = 2;
/**
 * A context-length failure is definitive and arrives fast. Only then may the
 * pipeline buy extra time for the chunked path; the extension is capped, is
 * charged to this specific recovery, and never happens after a timeout.
 */
export const CONTEXT_FALLBACK_MAX_MS = 15 * 60 * 1000;
/** How quickly CONTEXT_LENGTH must arrive to count as “definitive, cheap”. */
export const CONTEXT_FALLBACK_TRIGGER_MS = 45000;
/**
 * Rough tokens of one saved map note (points/topics/facts). Used only to budget
 * the reduce rounds; the real note text is measured before each round.
 */
export const MAP_NOTE_TOKENS = 260;
/** Prompt, schema and video header sent with every reduce request. */
export const REDUCE_PROMPT_RESERVE_TOKENS = 2000;

/**
 * How much map-note text one reduce request may carry.
 *
 * This used to be `chunkTokens` (6000 by default), i.e. the size of a *map*
 * fragment. A reduce request has no reason to be that small: its real limit is
 * the model context minus the reduce prompt and the answer. With a 128k
 * context, a three-hour video's notes (~10k tokens) fit one assembly; the old
 * bound split them into an extra hierarchical round of parallel calls — a whole
 * sequential wave for no quality gain. Conversely, a small local model (8k)
 * could be asked for 6000 input tokens plus prompt and answer, which does not
 * fit at all. The context, not the map chunk size, is the correct bound.
 */
export function reduceInputBudget(aiSettings = {}) {
  const s = jobSettings(aiSettings);
  const context = Math.max(4000, Number(s.contextTokens) || 128000);
  const output = Math.min(4096, Math.max(1200, Number(s.maxOutputTokens) || 4096));
  return Math.max(1500, context - REDUCE_PROMPT_RESERVE_TOKENS - output);
}

function jobSettings(aiSettings = {}) {
  return {
    chunkTokens: 6000,
    contextTokens: 128000,
    concurrency: 3,
    strategy: 'auto',
    timeoutMs: 90000,
    singleFallback: true,
    ...aiSettings,
  };
}

/**
 * Map phase allowance: one full call per parallel wave, plus one tail wave for
 * the per-chunk retries (budget escalation / JSON reminder). It is capped by
 * MAP_DEADLINE_MS, so a huge transcript cannot claim an unbounded map phase.
 */
export function mapAllowanceMs(chunkCount, aiSettings = {}) {
  const s = jobSettings(aiSettings);
  const call = operationBudgetMs(s.timeoutMs);
  if (!call) return 0;
  const chunks = Math.max(1, Number(chunkCount) || 1);
  const concurrency = Math.max(1, Math.min(20, Number(s.concurrency) || 1));
  const waves = Math.ceil(chunks / concurrency);
  return Math.min(MAP_DEADLINE_MS, (waves + 1) * call);
}

/**
 * Reduce allowance: intermediate rounds only exist when the saved notes do not
 * fit one assembly request. The grouping is estimated from the note size, so a
 * 3-chunk video is not charged for waves of reduce calls it will never make.
 * The final assembly may be retried once, hence `2 * call`.
 */
export function reduceAllowanceMs(chunkCount, aiSettings = {}) {
  const s = jobSettings(aiSettings);
  const call = operationBudgetMs(s.timeoutMs);
  if (!call) return 0;
  const chunks = Math.max(2, Number(chunkCount) || 2);
  const groups = Math.max(1, Math.ceil((chunks * MAP_NOTE_TOKENS) / reduceInputBudget(s)));
  const rounds = groups > 1 ? Math.min(REDUCE_ROUND_LIMIT, groups > 2 ? 2 : 1) : 0;
  const reduceWaves = Math.ceil(groups / Math.max(1, Math.min(s.concurrency, 2)));
  return rounds * reduceWaves * call + call * 2;
}

export function mapReduceAllowanceMs(chunkCount, aiSettings = {}) {
  return mapAllowanceMs(chunkCount, aiSettings) + reduceAllowanceMs(chunkCount, aiSettings);
}

/**
 * One single-pass attempt plus one cheap recovery retry. The retry is either a
 * bigger output budget (after TRUNCATED) or a short compact ask (after an empty
 * answer); both share the compact call budget, and neither is charged twice.
 */
export function singleAllowanceMs(aiSettings = {}) {
  const s = jobSettings(aiSettings);
  const call = operationBudgetMs(s.timeoutMs);
  if (!call) return 0;
  const recovery = Math.min(call, operationBudgetMs(COMPACT_TIMEOUT_MS));
  return call + recovery + JOB_LOCAL_RESERVE_MS;
}

/**
 * Overall budget of one summarization job. No upfront reserve for every
 * conceivable failure path: a single-pass run pays for a single call and one
 * cheap retry, a map-reduce run pays for its actual waves and reduce rounds.
 * A definitive CONTEXT_LENGTH may extend the job once, inside the pipeline.
 * @returns {number} milliseconds, 0 for unbounded
 */
export function computeJobBudgetMs({ segments = [], aiSettings = {} } = {}) {
  const s = jobSettings(aiSettings);
  const singleBudget = Math.max(Number(s.chunkTokens) || 6000, Number(s.contextTokens) || 12000);
  const plan = planStrategy({ segments, maxTokens: singleBudget, chunkTokens: s.chunkTokens, strategy: s.strategy });
  const call = operationBudgetMs(s.timeoutMs);
  if (!call) return 0;
  // The timecode mode makes one request per block, not one or two for the whole
  // video: a single-request budget would cut it off after the first blocks.
  if (s.summaryMode === 'timeline') {
    const totalWords = countWords(segments.map((seg) => String(seg.text || '')).join(' '));
    const blocks = timelineBlocks({ segments, totalWords }).length || 1;
    const perWave = Math.max(1, Math.min(3, Number(s.concurrency) || 3));
    const waves = Math.ceil(blocks / perWave);
    return Math.min(20 * 60 * 1000, (waves + 1) * call + JOB_LOCAL_RESERVE_MS);
  }
  if (plan.strategy === 'single' || plan.chunks.length <= 1) return singleAllowanceMs(s);
  return mapAllowanceMs(plan.chunks.length, s) + reduceAllowanceMs(plan.chunks.length, s) + JOB_LOCAL_RESERVE_MS;
}

/**
 * One absolute clock for a whole summary job: external cancel, job deadline and
 * in-flight stream aborts. The timer is always cleared.
 */
function createJobClock(deadlineAt, externalSignal) {
  const controller = new AbortController();
  let at = Number(deadlineAt) > 0 ? Number(deadlineAt) : 0;
  let expired = false;
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = at
      ? setTimeout(() => {
          expired = true;
          controller.abort(new Error('job-deadline'));
        }, Math.max(0, at - Date.now()))
      : null;
  };
  arm();
  const onExternal = () => controller.abort(externalSignal?.reason || new Error('cancelled'));
  if (externalSignal) {
    if (externalSignal.aborted) onExternal();
    else externalSignal.addEventListener('abort', onExternal, { once: true });
  }
  return {
    signal: controller.signal,
    remainingMs: () => (at ? Math.max(0, at - Date.now()) : Infinity),
    // True only when the job clock itself fired; a user cancel is not a timeout.
    expired: () => expired || (at > 0 && Date.now() >= at),
    deadlineAt: () => at,
    // Extends the current clock to a later absolute deadline. Used only for a
    // fast, definitive CONTEXT_LENGTH fallback; the caller bounds the value.
    extendTo: (nextAt) => {
      const next = Number(nextAt) > 0 ? Number(nextAt) : 0;
      if (!next) return false;
      if (at && next <= at) return false;
      at = next;
      expired = false;
      arm();
      return true;
    },
    cleanup: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (externalSignal) externalSignal.removeEventListener('abort', onExternal);
    },
  };
}

function jobDeadlineError() {
  return new AIError('TIMEOUT', 'Истёк общий лимит времени задания', {
    hint: 'Задание остановлено по общему бюджету времени. Успешные фрагменты сохранены — повторный запуск продолжит с них.',
    detail: 'job-deadline',
  });
}

function cancelledError() {
  return new AIError('CANCELLED', 'Задача отменена', { detail: 'cancelled' });
}

/**
 * How much output the JSON schema actually needs. 2500 was the old default and
 * a standard конспект (tldr + 8 points + 6 sections + quotes + keywords ~ 1000
 * Russian words) does not fit: the answer was cut mid-JSON, the repair call
 * returned nothing usable, and the run ended with empty cards after minutes of
 * waiting. The budget is per requested length; bigger asks get more.
 */
// A 70-minute video asked for “standard” used to start at 4096 output tokens
// and was cut off mid-JSON: 6 sections with 3 points each plus 8 key points is
// more than that once the text is written in full sentences. The floor is
// higher now, and the pressure ramp starts earlier.
const OUTPUT_BUDGET_BY_LENGTH = { short: 2048, standard: 5000, detailed: 6144 };

/**
 * Ceiling for any output budget. The options page allows 16 000, and a
 * reasoning model that cannot switch thinking off may need all of it; 8 192
 * was a guess from an older generation of chat models.
 */
const ESCALATED_OUTPUT_TOKENS = 16000;

/**
 * Initial output budget from the requested format and the actual input size.
 * The schema itself needs the base amount; a long transcript makes a model
 * write more sections (and a reasoning model spend more thinking tokens before
 * the JSON), so above ~12k input tokens the initial budget grows gradually.
 * Short videos keep the base budget — raising every run to the ceiling would
 * pay for tokens nobody uses. A user-configured larger value is still
 * respected.
 * @returns {number} tokens
 */
export function initialOutputBudget({ length = 'standard', transcriptTokens = 0, configured = 0 } = {}) {
  const base = OUTPUT_BUDGET_BY_LENGTH[length] || OUTPUT_BUDGET_BY_LENGTH.standard;
  const tokens = Math.max(0, Number(transcriptTokens) || 0);
  const pressure =
    length === 'short' || tokens <= 8000
      ? 0
      : Math.min(3072, Math.round((tokens - 8000) / 6));
  const adaptive = Math.min(ESCALATED_OUTPUT_TOKENS, base + pressure);
  const requested = Math.min(ESCALATED_OUTPUT_TOKENS, Math.max(0, Number(configured) || 0));
  return Math.max(adaptive, requested);
}

function isBudgetError(err) {
  return !!err && BUDGET_CODES.has(err.code);
}

/** Doubles an output budget up to ESCALATED_OUTPUT_TOKENS, or 0 when capped. */
function escalateBudget(current) {
  const from = Number(current) || 0;
  const next = Math.min(ESCALATED_OUTPUT_TOKENS, Math.max(2048, Math.round(from * 2)));
  return next > from ? next : 0;
}

/**
 * Does the parsed JSON actually contain a summary? A model that was cut off
 * returns syntactically valid JSON with empty fields, which used to be saved,
 * cached and rendered as “Готово” with no TL;DR and no key points at all.
 */
function resultSubstance(result) {
  const sections = (Array.isArray(result?.sections) ? result.sections : []).filter(
    (s) => String(s?.summary || '').trim() || (Array.isArray(s?.points) ? s.points : []).some((p) => String(p?.text || '').trim()),
  );
  const points = (Array.isArray(result?.keyPoints) ? result.keyPoints : []).filter((p) => String(p?.text || '').trim()).length;
  const sectionPoints = sections.reduce(
    (n, s) => n + (Array.isArray(s?.points) ? s.points : []).filter((p) => String(p?.text || '').trim()).length,
    0,
  );
  // A prose answer often has one section with a real paragraph and no bullets.
  // Counting only key points rejected it as “ответ пустой”.
  const sectionWords = sections.reduce((n, s) => n + countWords(`${s?.heading || ''} ${s?.summary || ''}`), 0);
  const tldrWords = countWords(result?.tldr || '');
  return {
    points,
    sections: sections.length,
    tldrWords,
    ok: points + sectionPoints >= 2 || sections.length >= 2 || tldrWords >= 8 || sectionWords >= 8,
  };
}

/**
 * The model answered, but the answer holds no summary. When the answer was cut
 * off (`truncated`) the budget is to blame, not the model's willingness: the
 * pipeline escalates the budget instead of asking a second, smaller question.
 */
function emptyResultError(text, call) {
  if (call?.truncated) {
    return new AIError('TRUNCATED', 'Модель израсходовала лимит ответа на рассуждения и не написала конспект', {
      hint:
        'Увеличьте «Максимум токенов ответа» в настройках, включите анализ фрагментами или выберите модель без режима размышления.',
      detail: truncate(String(text || ''), 300),
    });
  }
  return new AIError('EMPTY_RESULT', 'Модель не вернула конспект: ответ пустой', {
    hint:
      'Бесплатные модели иногда отвечают пустым JSON, особенно если лимит ответа мал. Попробуйте другую модель (без режима размышления) или увеличьте «Максимум токенов ответа» в настройках.',
    detail: truncate(String(text || ''), 300),
  });
}

/**
 * A model may answer in snake_case (`summary`, `key_points`, `chapters…`).
 * `normalizeResult` accepts those aliases, so the “is there anything in it”
 * check must look at the normalized object — otherwise a perfectly good answer
 * was thrown away as “Модель не вернула конспект: ответ пустой” and replaced by
 * a smaller retry that the same free model also ignored.
 */
function substanceOf(raw) {
  return resultSubstance(normalizeResult(coercePayload(raw), {}));
}

/**
 * Counts usable material in one map answer. A syntactically valid object with
 * empty arrays is not a summary: on a 3.5-hour video nineteen such answers used
 * to be accepted as successes, and the result looked complete while covering a
 * single fragment. Schema placeholders do not count either.
 */
function partialMaterial(partial) {
  if (!partial || typeof partial !== 'object') return 0;
  let n = 0;
  const count = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      const text = typeof item === 'object' && item ? item.text : item;
      if (text != null && String(text).trim() && withoutPlaceholder(String(text))) n++;
    }
  };
  for (const list of [partial.points, partial.keyPoints, partial.facts, partial.actions, partial.topics, partial.quotes]) {
    count(list);
  }
  // A model that answered with sections instead of flat points still produced
  // usable notes; the reduce step can read them.
  for (const section of Array.isArray(partial.sections) ? partial.sections : []) {
    count(section?.points);
  }
  if (partial.tldr != null && String(partial.tldr).trim() && withoutPlaceholder(String(partial.tldr))) n++;
  return n;
}

/**
 * Very short fragments can legitimately contain nothing (outro, ad, silence).
 * Treating those as failures would mark every second video incomplete, so the
 * empty-answer rule only applies to fragments with enough speech to summarise.
 */
const SUBSTANTIVE_CHUNK_WORDS = 120;

/** Cache identity of one map answer: content, prompt revision and model. */
export function chunkCacheKey({ chunk, model, provider, opts = {} }) {
  return hashString(
    [
      'ai-chunk',
      PROMPT_VERSION,
      model || '',
      provider?.id || '',
      provider?.presetId || '',
      opts.outputLanguage || '',
      opts.tone || '',
      opts.length || '',
      opts.customInstructions || '',
      chunk?.startAt ?? '',
      chunk?.endAt ?? '',
      chunk?.text || '',
    ].join('|'),
  );
}

/**
 * True when every text in a partial is a field description from the prompt
 * (“тема”, “тезис 8-25 слов”, “...”): the model echoed the schema instead of
 * summarising its fragment. An honestly empty partial is not an echo.
 */
function echoedSchemaOnly(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const texts = [];
  const push = (value) => {
    if (value != null && value !== '') texts.push(String(value));
  };
  for (const list of [raw.points, raw.facts, raw.actions, raw.topics, raw.quotes]) {
    for (const item of Array.isArray(list) ? list : []) push(typeof item === 'object' && item ? item.text : item);
  }
  push(raw.tldr);
  if (!texts.length) return false;
  return texts.every((text) => !withoutPlaceholder(text));
}

function partialToText(partial) {
  if (!partial || typeof partial !== 'object') return '';
  const points = Array.isArray(partial.points) ? partial.points : [];
  const lines = points.map((p) => `[${p.at || '--:--'}] ${p.text || ''}`);
  const topics = Array.isArray(partial.topics) ? partial.topics : [];
  const facts = Array.isArray(partial.facts) ? partial.facts : [];
  const quotes = Array.isArray(partial.quotes) ? partial.quotes : [];
  const actions = Array.isArray(partial.actions) ? partial.actions : [];
  const out = [];
  if (lines.length) out.push(lines.join('\n'));
  if (topics.length) out.push(`Темы: ${topics.join(', ')}`);
  if (facts.length) out.push(`Факты: ${facts.join('; ')}`);
  if (quotes.length) out.push(`Цитаты: ${quotes.map((q) => `[${q.at || '--:--'}] ${q.text || ''}`).join(' | ')}`);
  if (actions.length) out.push(`Рекомендации: ${actions.join('; ')}`);
  return out.join('\n');
}

/**
 * Degraded result built from map partials when the reduce step fails, and the
 * base result of the “by timecodes” mode.
 *
 * This used to glue every fragment's points into sections titled “Часть N” with
 * an empty summary and then repeat the same points as key moments — the draft
 * the user read as “not detailed”. The notes already hold topics and facts, so
 * a section gets a heading and a summary from them, keeps its own points once,
 * and key moments stay empty instead of swallowing the sections.
 */
function degradedFromPartials({ partials, chunks, meta, ctx, warnings }) {
  const sections = [];
  const keywords = new Map();
  const quotes = [];
  const takeaways = [];
  const actions = [];
  for (let i = 0; i < partials.length; i++) {
    const partial = partials[i];
    const chunk = chunks[i];
    if (!partial) continue;
    const own = (Array.isArray(partial.points) ? partial.points : [])
      .map((p) => {
        const at = parseAt(p?.at) ?? (chunk ? chunk.startAt : null);
        return {
          text: String((typeof p === 'object' && p ? p.text : p) || '').trim(),
          at,
          ts: at == null ? null : formatTime(at),
        };
      })
      .filter((p) => p.text && withoutPlaceholder(p.text));
    if (!own.length) continue;
    const topics = (Array.isArray(partial.topics) ? partial.topics : []).map((t) => String(t || '').trim()).filter(Boolean);
    const facts = (Array.isArray(partial.facts) ? partial.facts : []).map((f) => String(f || '').trim()).filter(Boolean);
    const heading = withoutPlaceholder(topics[0] || '') || truncate(own[0].text, 52);
    // A section with no summary was the whole visual problem of the draft: a
    // bare list of fragments. The notes' facts describe the same stretch.
    const summary = facts.slice(0, 2).join(' ') || topics.slice(1, 3).join(' ');
    sections.push({
      heading,
      at: chunk ? chunk.startAt : null,
      ts: chunk ? formatTime(chunk.startAt) : null,
      summary,
      points: own.slice(0, 6),
    });
    for (const t of topics) keywords.set(t, (keywords.get(t) || 0) + 1);
    for (const q of Array.isArray(partial.quotes) ? partial.quotes : []) {
      if (!q?.text) continue;
      const at = parseAt(q.at);
      quotes.push({ text: String(q.text), at, ts: at == null ? null : formatTime(at) });
    }
    for (const a of Array.isArray(partial.actions) ? partial.actions : []) if (String(a).trim()) actions.push(String(a));
    for (const f of facts) takeaways.push(f);
  }
  const sortedSections = sections.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(0, 20);
  const summaries = sortedSections.map((s) => s.summary).filter(Boolean);
  const tldr =
    [summaries[0], summaries[1], sortedSections.length > 2 ? summaries[summaries.length - 1] : '']
      .filter(Boolean)
      .join(' ') || sortedSections[0]?.points?.slice(0, 2).map((p) => p.text).join(' ') || '';
  const maxScore = Math.max(1, ...Array.from(keywords.values()));
  return normalizeResult(
    {
      tldr,
      // Every point already lives inside its section; repeating them here was
      // the “duplicated timecodes” report.
      keyPoints: [],
      sections: sortedSections,
      takeaways: takeaways.slice(0, 6),
      actionItems: actions.slice(0, 5),
      quotes: uniqPoints(quotes).slice(0, 4),
      keywords: Array.from(keywords.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 18)
        .map(([term, count]) => ({ term, score: Math.round((count / maxScore) * 100) / 100 })),
      notes: warnings,
    },
    ctx,
  );
}

/**
 * Splits a transcript for the “by timecodes” mode: one block per chapter when
 * the page has them, otherwise equal stretches of speech. Each block becomes
 * one section written by its own small request.
 */
export function timelineBlocks({ segments = [], meta = {}, totalWords = 0 } = {}) {
  const chapters = (Array.isArray(meta.chapters) ? meta.chapters : [])
    .map((c) => ({ at: Number(c?.at), title: String(c?.title || '').trim() }))
    .filter((c) => Number.isFinite(c.at) && c.at >= 0)
    .sort((a, b) => a.at - b.at);
  const blocks = [];
  // `segments`, not pre-built blocks: buildBlocks expects {start,text} and
  // uses `start` for the marker. Passing its own output back would flatten
  // every marker of a block to 0:00.
  const pushSegments = (list, title = '') => {
    if (!list.length) return;
    const built = buildBlocks(list);
    if (!built.length) return;
    const text = renderBlocks(built);
    if (!text.trim()) return;
    blocks.push({
      index: blocks.length,
      startAt: built[0].at,
      endAt: built[built.length - 1].at,
      tokens: built.reduce((a, b) => a + b.tokens, 0),
      title,
      text,
    });
  };
  if (chapters.length >= 3 && chapters.length <= 24) {
    for (let i = 0; i < chapters.length; i++) {
      const from = chapters[i].at;
      const to = i + 1 < chapters.length ? chapters[i + 1].at : Infinity;
      const inside = segments.filter((s) => Number(s.start) >= from && Number(s.start) < to);
      pushSegments(inside, chapters[i].title);
    }
    if (blocks.length >= 3) return blocks;
  }
  blocks.length = 0;
  // No usable chapters: cut the speech itself, roughly into 8–18 pieces.
  const target = Math.max(320, Math.ceil((Number(totalWords) || 0) / 14) || 0);
  let current = [];
  let words = 0;
  for (const seg of segments) {
    const text = String(seg.text || '').trim();
    if (!text) continue;
    current.push(seg);
    words += countWords(text);
    if (words < target) continue;
    pushSegments(current);
    current = [];
    words = 0;
  }
  if (current.length) pushSegments(current);
  return blocks;
}

function parseAt(value) {
  if (value == null) return null;
  // Coerced payloads already carry numeric seconds; raw model answers use
  // "mm:ss". Both must reach the renderer as the same number.
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const s = String(value).trim();
  if (/^\d{1,6}$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

function uniqPoints(points) {
  const seen = new Set();
  const out = [];
  for (const p of points) {
    const key = String(p.text || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 90);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function describeStrategy(settings) {
  return `${settings.strategy || 'auto'} · контекст ${settings.contextTokens || 128000} tok · chunk ${settings.chunkTokens || 6000} tok · параллельно ${settings.concurrency || 3}`;
}

/**
 * Main entry: summarize a transcript with an AI provider.
 *
 * One absolute job deadline is created here (or inherited from a parent task)
 * and enforced across single, map, reduce and every provider call. Child calls
 * can only see the remaining time; none of them may extend the deadline.
 * @returns {Promise<{result: object, strategy: string, usage: object, warnings: string[]}>}
 */
export async function runAiSummary(args) {
  const runStarted = Date.now();
  const settings = jobSettings(args.aiSettings);
  const budget = Number(args.budgetMs) > 0
    ? Number(args.budgetMs)
    : computeJobBudgetMs({ segments: args.segments || [], aiSettings: settings });
  const parentDeadlineAt = Number(args.deadlineAt) > 0 ? Number(args.deadlineAt) : 0;
  const ownDeadlineAt = budget > 0 ? runStarted + budget : 0;
  const activeDeadlines = [parentDeadlineAt, ownDeadlineAt].filter((v) => v > 0);
  const deadlineAt = activeDeadlines.length ? Math.min(...activeDeadlines) : 0;
  const clock = createJobClock(deadlineAt, args.signal);
  const jobBudgetMs = budget > 0 ? budget : (deadlineAt ? Math.max(0, deadlineAt - runStarted) : 0);
  // Shared with the inner run: a CONTEXT_LENGTH recovery may extend the clock,
  // and every later progress event must report the extended deadline/budget.
  const jobState = { budgetMs: jobBudgetMs, deadlineAt: deadlineAt || 0 };
  const emit = (event) => {
    if (typeof args.onProgress !== 'function') return;
    args.onProgress({
      ...event,
      deadlineAt: jobState.deadlineAt,
      budgetMs: jobState.budgetMs,
      remainingMs: clock.remainingMs(),
    });
  };
  try {
    return await runAiSummaryInner({
      ...args,
      onProgress: emit,
      signal: clock.signal,
      userSignal: args.signal || null,
      jobDeadlineAt: deadlineAt,
      jobBudgetMs,
      parentDeadlineAt,
      jobState,
      jobClock: clock,
    });
  } finally {
    clock.cleanup();
  }
}

async function runAiSummaryInner({
  segments,
  meta = {},
  provider,
  apiKey = '',
  model,
  aiSettings = {},
  output = {},
  uiLang = 'ru',
  onProgress = noop,
  onDelta = noop,
  signal,
  userSignal = null,
  jobDeadlineAt = 0,
  jobBudgetMs = 0,
  parentDeadlineAt = 0,
  jobState = null,
  jobClock = null,
  // Optional adapter {get(key), put(key, partial)} supplied by the background
  // worker. Tests and the standalone benchmark run without extension storage,
  // so the pipeline itself must not import the chrome-backed layer.
  chunkCache = null,
  // Map notes saved by a previous run that was interrupted (MV3 worker death).
  // Keyed by chunk index; only fragments whose transcript/prompt/settings
  // fingerprint matched the current request are supplied.
  resumePartials = null,
  // Notes produced by completed intermediate reduce groups, keyed by a group
  // hash. A continuation must not pay for the same batch twice.
  resumeReduce = null,
  // Called as soon as one fragment settles, so durable job state can record it
  // before the next request is sent.
  onChunkState = noop,
  // Same, for an intermediate reduce group.
  onReduceState = noop,
}) {
  const settings = {
    temperature: 0.3,
    maxOutputTokens: 4096,
    chunkTokens: 6000,
    // Conservative share of the 200k window advertised by openrouter/free:
    // prompt, schema and output reserve stay inside the rest.
    contextTokens: 128000,
    concurrency: 3,
    strategy: 'auto',
    retries: 1,
    // 90s is already a generous single request. A free model that has not
    // answered by then is not going to; waiting three minutes per attempt was
    // what made a failed AI run feel endless.
    timeoutMs: 90000,
    stream: true,
    systemPromptOverride: '',
    // When false, a single-pass run makes exactly one request: a context-length
    // or truncation error is reported instead of silently rolling into
    // map-reduce (the manual benchmark relies on this to protect free quota).
    singleFallback: true,
    jsonRepair: true,
    allowRateRetry: true,
    allowFormatRetry: true,
    ...aiSettings,
  };
  const chunkStateSink = typeof onChunkState === 'function' ? onChunkState : noop;
  const reduceStateSink = typeof onReduceState === 'function' ? onReduceState : noop;
  const savedReduce = resumeReduce && typeof resumeReduce === 'object' ? resumeReduce : {};
  const remainingMs = () => (jobClock ? jobClock.remainingMs() : Infinity);
  const jobExpired = () => !!(jobClock && jobClock.expired());
  const userCancelled = () => !!userSignal?.aborted;
  // Called before a phase that would start a new provider request. A cancelled
  // run wins over an expired one: the user asked to stop, not to retry.
  const assertRunnable = () => {
    if (userCancelled()) throw cancelledError();
    if (jobExpired() || remainingMs() <= 0) throw jobDeadlineError();
  };
  const opts = {
    // “Auto” follows the user's language: an English video on a Russian
    // interface must produce a Russian конспект, translated, not English.
    outputLanguage: resolveOutputLanguage(output.language, uiLang),
    transcriptLang: meta.lang || 'ru',
    tone: output.tone || 'neutral',
    length: output.length || 'standard',
    customInstructions: settings.systemPromptOverride || output.customInstructions || '',
    uiLang,
    selfCheck: output.selfCheck === true,
  };
  onProgress({ stage: 'prepare', message: 'Готовлю транскрипт' });
  // One request may carry up to the model's context budget; only longer
  // transcripts are split into chunk-sized pieces. The old code used the chunk
  // size (3200 by default) as the context budget too, so anything past ~10
  // minutes of speech became map-reduce with multiple model calls.
  const singleBudget = Math.max(Number(settings.chunkTokens) || 6000, Number(settings.contextTokens) || 12000);
  let plan = planStrategy({
    segments,
    maxTokens: singleBudget,
    chunkTokens: settings.chunkTokens,
    strategy: settings.strategy,
  });
  // The initial budget now knows how big the actual input is. A long video is
  // likely to need more schema fields and a reasoning model burns more tokens
  // before it starts the JSON; a short one stays at the format's base budget.
  const outputBudget = initialOutputBudget({
    length: opts.length,
    transcriptTokens: plan.tokens,
    configured: settings.maxOutputTokens,
  });
  const ctx = {
    provider,
    apiKey,
    model,
    temperature: settings.temperature,
    maxTokens: outputBudget,
    retries: settings.retries,
    timeoutMs: settings.timeoutMs,
    allowRateRetry: settings.allowRateRetry !== false,
    allowFormatRetry: settings.allowFormatRetry !== false,
    signal,
    deadlineAt: jobDeadlineAt || 0,
    deadlineDetail: 'job-deadline',
    opts,
  };
  const warnings = [];
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0, latencyMs: 0 };
  // Lightweight, local-only diagnostics. They travel inside SummaryResult.meta
  // (already exported as JSON) and never include prompts, transcript text or
  // credentials.
  const diagnostics = {
    strategy: plan.strategy,
    complete: true,
    chunks: [],
    cacheHits: 0,
    cacheMisses: 0,
    resumed: 0,
    retries: 0,
    requests: 0,
    reduceRounds: 0,
    reduceResumed: 0,
    // Streaming map diagnostics: when the first validated fragment appeared and
    // how long chunks waited for a free slot. Measured, never estimated.
    firstPartialMs: 0,
    mapQueueMs: 0,
    concurrency: settings.concurrency,
    // Single-pass streaming: the first visible text, the first item that passed
    // validation, and how many items the panel could show before the answer
    // ended. Times are relative to the start of that request.
    streamFirstTextMs: 0,
    streamFirstItemMs: 0,
    streamItems: 0,
    streamKeyPoints: 0,
    streamSections: 0,
    streamTldr: false,
    // How often the provider asked to slow down and how long new fragments
    // were held back because of it.
    rateLimited: 0,
    mapPausedMs: 0,
    transcriptTokens: plan.tokens,
    transcriptFetchedMs: 0,
    // Where the wall clock went: waiting for providers versus local planning,
    // JSON repair and building SummaryResult.
    providerMs: 0,
    localMs: 0,
    jsonParseMs: 0,
    resultBuildMs: 0,
    stages: { single: 0, map: 0, 'reduce-batch': 0, reduce: 0 },
    // Wall clock spent inside provider calls, per stage.
    stageMs: { single: 0, map: 0, 'reduce-batch': 0, reduce: 0 },
    fallbacks: [],
    lastFallback: '',
    // Overall job clock: shown in the panel and used by final diagnostics.
    budgetMs: jobBudgetMs || 0,
    // The ceiling the run started with. A CONTEXT_LENGTH recovery may grow
    // budgetMs, but the panel must still be able to show the original figure.
    initialBudgetMs: jobBudgetMs || 0,
    deadlineAt: jobDeadlineAt || 0,
    initialOutputLimit: outputBudget,
    outputLimit: outputBudget,
    outputEscalations: 0,
    truncated: false,
    salvaged: false,
    finishReason: '',
    totalMs: 0,
    startedAt: Date.now(),
  };
  const noteFallback = (reason) => {
    diagnostics.lastFallback = String(reason || '');
    if (diagnostics.fallbacks.length < 30) diagnostics.fallbacks.push(reason);
  };
  const noteCall = ({ stage, chunkId = '', call = null, error = null, extra = {} }) => {
    diagnostics.requests++;
    diagnostics.stages[stage] = (diagnostics.stages[stage] || 0) + 1;
    diagnostics.retries += Math.max(0, (call?.attempts || error?.attempts || 1) - 1);
    const ms = call?.latencyMs || error?.elapsedMs || 0;
    diagnostics.providerMs += ms;
    diagnostics.stageMs[stage] = (diagnostics.stageMs[stage] || 0) + ms;
    diagnostics.jsonParseMs += call?.jsonMs || 0;
    if (diagnostics.chunks.length >= 60) return;
    const ttft = call?.ttftMs || 0;
    diagnostics.chunks.push({
      stage,
      chunkId,
      ms,
      headersMs: call?.headersMs || 0,
      ttftMs: ttft,
      // Time spent streaming the answer after the first token.
      genMs: ms && ttft ? Math.max(0, ms - ttft) : 0,
      in: call?.usage?.promptTokens || 0,
      out: call?.usage?.completionTokens || 0,
      estimatedIn: call?.estimatedIn || extra.estimatedIn || 0,
      attempts: call?.attempts || error?.attempts || 1,
      retries: Math.max(0, (call?.attempts || error?.attempts || 1) - 1),
      finish: call?.finishReason || '',
      model: call?.model || '',
      upstream: call?.upstreamProvider || '',
      genId: call?.generationId || '',
      json: call?.parseStrategy || '',
      jsonOk: call ? call.jsonOk !== false : false,
      truncated: !!call?.truncated,
      error: error ? error.code || 'ERROR' : '',
      ...extra,
    });
  };
  const addUsage = (u, latency, calls = 1) => {
    usage.promptTokens += u?.promptTokens || 0;
    usage.completionTokens += u?.completionTokens || 0;
    usage.latencyMs += latency || 0;
    usage.calls += calls;
  };
  /**
   * Checks the finished result against the transcript it was built from.
   * Numbers absent from the source and quotes that are not verbatim are
   * reported, never silently dropped: the user decides what to trust, and the
   * panel can show which lines need a look at the source.
   */
  const sourceText = segments.map((s) => String(s.text || '')).join(' ');
  const applyGrounding = (result) => {
    const report = verifyResult(result, sourceText);
    diagnostics.grounding = {
      checked: report.checked,
      unsupported: report.unsupported.length,
      quotes: report.quotes,
      unverifiedQuotes: report.unverifiedQuotes,
    };
    if (!result || typeof result !== 'object') return report;
    // Always recorded, so “checked and clean” is distinguishable from “never
    // checked”; the individual claims are only listed when something was found.
    result.meta = {
      ...(result.meta || {}),
      grounding: {
        checked: report.checked,
        unsupported: report.unsupported.slice(0, 8),
        unverifiedQuotes: report.unverifiedQuotes,
      },
    };
    if (!report.unsupported.length && !report.unverifiedQuotes) return report;
    for (const note of verificationWarnings(report)) {
      warnings.push(note);
      // `ctx.meta.warnings` was copied when the result was built, so the note
      // is appended there too; otherwise it would only reach the run summary.
      if (Array.isArray(result.meta.warnings)) result.meta.warnings.push(note);
    }
    return report;
  };

  let raw = null;
  let singleSalvaged = false;
  // A cut-off final assembly is used (its complete fields are real content) but
  // never reported as a complete summary.
  let reduceSalvaged = false;
  let strategy = plan.strategy;
  const timelineOnce = settings.summaryMode === 'timeline';
  /**
   * “By timecodes”: every block of the video is summarised by its own small
   * request and becomes one section, like Yandex's summary. No final giant
   * assembly, so a single failed answer costs one block instead of the whole
   * конспект — and a free router that drops one request in five still produces
   * a usable result.
   */
  if (timelineOnce) {
    strategy = 'timeline';
    diagnostics.strategy = 'timeline';
    const totalWordsTimeline = countWords(segments.map((s) => String(s.text || '')).join(' '));
    const blocks = timelineBlocks({ segments, meta, totalWords: totalWordsTimeline });
    diagnostics.blocks = blocks.length;
    const blockStartedAt = Date.now();
    onProgress({
      stage: 'map',
      done: 0,
      total: blocks.length,
      message: `Разбираю ${blocks.length} отрезков по таймкодам`,
    });
    const timelineLimiter = createLimiter(Math.max(1, Math.min(3, Number(settings.concurrency) || 3)));
    let blocksDone = 0;
    const blockResults = await mapAdaptive(
      blocks,
      async (block) => {
        if (userCancelled()) throw cancelledError();
        if (jobExpired() || remainingMs() <= 0) return null;
        try {
          const messages = timelineMessages({ block, meta, opts, index: block.index, total: blocks.length });
          const estimatedIn = estimateTokens(messages.map((m) => m.content).join('\n'));
          const res = await callForJson({
            messages,
            ctx: { ...ctx, stream: false },
            repair: settings.jsonRepair !== false,
          });
          addUsage(res.usage, res.latencyMs);
          noteCall({ stage: 'map', chunkId: String(block.index + 1), call: res, extra: { estimatedIn } });
          return { block, json: res.json || {} };
        } catch (err) {
          if (err?.code === 'RATE_LIMIT') timelineLimiter.lower();
          noteCall({ stage: 'map', chunkId: String(block.index + 1), error: err });
          warnings.push(`Отрезок ${formatTime(block.startAt)} не обработан: ${err.message}`);
          return null;
        } finally {
          blocksDone++;
          onProgress({
            stage: 'map',
            done: blocksDone,
            total: blocks.length,
            elapsedMs: Date.now() - blockStartedAt,
            message: `Отрезок ${blocksDone}/${blocks.length}`,
          });
        }
      },
      timelineLimiter,
    );
    const sections = [];
    const timelineQuotes = [];
    let blocksMissing = 0;
    for (const item of blockResults) {
      if (!item) {
        blocksMissing++;
        continue;
      }
      const json = item.json || {};
      // The page's own chapter title is better than a model guess when present;
      // the model still writes the summary and the points.
      const heading = withoutPlaceholder(item.block.title || json.heading || json.title || '');
      const section = normalizeSection({
        heading,
        at: formatTime(item.block.startAt),
        summary: json.summary || json.text || '',
        points: json.points || json.keyPoints || [],
      });
      if (section) sections.push(section);
      for (const quote of Array.isArray(json.quotes) ? json.quotes : []) {
        if (!quote?.text) continue;
        const at = parseAt(quote.at);
        timelineQuotes.push({ text: String(quote.text), at, ts: at == null ? null : formatTime(at) });
      }
      if (section) {
        // Same live preview the chunked path uses: the panel fills in order.
        onProgress({
          stage: 'partial',
          index: item.block.index,
          startAt: item.block.startAt,
          endAt: item.block.endAt,
          partial: {
            points: section.points,
            topics: [section.heading],
          },
          done: sections.length,
          total: blocks.length,
        });
      }
    }
    if (!sections.length) {
      if (jobExpired() || remainingMs() <= 0) throw jobDeadlineError();
      throw new AIError('MAP_FAILED', 'Ни один отрезок не обработан', {
        hint: warnings[0] || 'Проверьте провайдера и модель.',
      });
    }
    diagnostics.complete = blocksMissing === 0;
    if (blocksMissing) {
      warnings.unshift(
        `Не обработано отрезков: ${blocksMissing} из ${blocks.length}. Конспект покрывает только успешные части видео.`,
      );
      onProgress({ stage: 'incomplete', done: sections.length, total: blocks.length, message: 'Неполное покрытие' });
    }
    const summaries = sections.map((s) => s.summary).filter(Boolean);
    const tldr = [summaries[0], summaries[1], summaries.length > 2 ? summaries[summaries.length - 1] : '']
      .filter(Boolean)
      .join(' ')
      || sections.slice(0, 2).map((s) => s.points[0]?.text).filter(Boolean).join(' ');
    diagnostics.blocksOk = sections.length;
    raw = {
      tldr,
      sections,
      // Every point is already inside its section; key moments stay empty so
      // the same timecodes are not printed twice.
      keyPoints: [],
      takeaways: [],
      actionItems: [],
      questions: [],
      quotes: timelineQuotes,
      notes: [],
    };
  }
  let useSingle = !timelineOnce && (plan.strategy === 'single' || plan.chunks.length <= 1);
  if (useSingle) {
    strategy = 'single';
    const singleStartedAt = Date.now();
    // Every attempt (including a budget escalation, and the next provider in a
    // fallback chain) is a separate stream: the panel resets its live draft when
    // this id changes instead of gluing items from two different answers
    // together. The per-run prefix keeps two providers apart, because each
    // runAiSummary call starts its own attempt counter.
    const streamRunId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let streamRun = 0;
    try {
      assertRunnable();
      onProgress({ stage: 'single', message: 'Отправляю транскрипт в модель', tokens: plan.tokens });
      const singleCtx = { ...ctx, stream: settings.stream !== false };
      // The whole transcript, not `chunks[0]`: with the bigger context budget a
      // fitting transcript can still be split into pieces, and sending only the
      // first piece would quietly summarise a third of the video.
      const singleText = renderBlocks(plan.blocks) || plan.chunks[0]?.text || '';
      const sendSingle = async (maxTokens, { length, timeoutMs, simple } = {}) => {
        const messages = simple
          ? compactMessages({ transcript: singleText, meta, opts })
          : singleMessages({ transcript: singleText, meta, opts: length ? { ...opts, length } : opts });
        // The estimate covers the system prompt, schema and transcript — the
        // number that actually decides whether a request fits the model.
        const estimatedIn = estimateTokens(messages.map((m) => m.content).join('\n'));
        const streamIdBase = `${streamRunId}-${++streamRun}`;
        let attemptStartedAt = Date.now();
        let streamAttempt = 0;
        let live = null;
        // A retry after a dropped stream is a new answer. Reusing the old parser
        // would glue the second answer's opening brace onto the first one's cut
        // string and show a mangled item; a new streamId also tells the panel to
        // replace its draft instead of appending to it. The counters restart
        // with it, so they describe the answer that is actually on screen.
        const resetStreamDiagnostics = () => {
          diagnostics.streamFirstTextMs = 0;
          diagnostics.streamFirstItemMs = 0;
          diagnostics.streamItems = 0;
          diagnostics.streamKeyPoints = 0;
          diagnostics.streamSections = 0;
          diagnostics.streamTldr = false;
        };
        const startStream = () => {
          if (timeoutMs || settings.stream === false) return;
          const streamId = `${streamIdBase}.${++streamAttempt}`;
          attemptStartedAt = Date.now();
          if (streamAttempt > 1) resetStreamDiagnostics();
          live = createSummaryStream({
            onItem: (item) => {
              if (!diagnostics.streamFirstItemMs) diagnostics.streamFirstItemMs = Date.now() - attemptStartedAt;
              diagnostics.streamItems++;
              if (item.kind === 'keyPoint') diagnostics.streamKeyPoints++;
              else if (item.kind === 'section') diagnostics.streamSections++;
              else if (item.kind === 'tldr') diagnostics.streamTldr = true;
              // A progress event, not a delta: the item is a validated object
              // that the panel can render without parsing anything itself.
              onProgress({
                stage: 'stream-item',
                streamId,
                item,
                elapsedMs: Date.now() - attemptStartedAt,
                firstItemMs: diagnostics.streamFirstItemMs,
                counts: {
                  items: diagnostics.streamItems,
                  keyPoints: diagnostics.streamKeyPoints,
                  sections: diagnostics.streamSections,
                  tldr: diagnostics.streamTldr,
                },
              });
            },
          });
        };
        startStream();
        const res = await callForJson({
          messages,
          ctx: { ...singleCtx, maxTokens, ...(timeoutMs ? { timeoutMs, stream: false } : {}) },
          onDelta: !live
            ? undefined
            : (chunk, full) => {
                if (typeof chunk === 'string' && chunk.trim() && !diagnostics.streamFirstTextMs) {
                  diagnostics.streamFirstTextMs = Date.now() - attemptStartedAt;
                }
                live?.push(chunk);
                onDelta({ chunk, full });
              },
          onRetry: startStream,
          repair: settings.jsonRepair !== false,
        });
        return { ...res, estimatedIn };
      };
      // The small ask used when the model produced nothing usable: fewer items,
      // no streaming and a short deadline. One such attempt costs less than
      // repeating the full request that already failed.
      const sendCompact = () => sendSingle(COMPACT_OUTPUT_TOKENS, { simple: true, timeoutMs: COMPACT_TIMEOUT_MS });

      let call = null;
      let firstError = null;
      try {
        call = await sendSingle(singleCtx.maxTokens);
        // A cut-off answer can still parse as JSON with a few fields filled in;
        // accepting it would silently drop the rest of the video.
        if (call.truncated) {
          addUsage(call.usage, call.latencyMs, 1);
          noteCall({ stage: 'single', call, error: { code: 'TRUNCATED' }, extra: { estimatedIn: call.estimatedIn } });
          firstError = new AIError('TRUNCATED', 'Ответ модели обрезан по лимиту токенов', {
            hint: 'Расширение повторит запрос с большим лимитом. Если ответ снова обрежется, выберите модель без режима размышления или формат «Кратко».',
          });
          diagnostics.truncated = true;
          // Keep the partial JSON. If the escalation also fails, complete fields
          // can still be shown as an explicitly incomplete result instead of
          // throwing away everything the model already wrote.
          firstError.partialText = call.text || '';
          call = null;
        } else if (!substanceOf(call.json).ok) {
          // Valid JSON with empty fields means the model was cut off (or answered
          // with a stub).
          // The wasted request still cost the user tokens: count it, even though
          // its answer is thrown away.
          addUsage(call.usage, call.latencyMs, 1);
          noteCall({ stage: 'single', call, error: { code: 'EMPTY_RESULT' }, extra: { estimatedIn: call.estimatedIn } });
          firstError = emptyResultError(call.text, call);
          call = null;
        }
      } catch (err) {
        firstError = err;
        call = null;
      }

      if (!call) {
        if (settings.singleFallback === false) throw firstError;
        const escalate = isBudgetError(firstError) && firstError.code !== 'CONTEXT_LENGTH';
        if (escalate) {
          // Typical cause: a reasoning model spends the whole output budget while
          // "thinking" and never gets to the JSON. One retry with a bigger
          // budget is cheap; against a context-length error it cannot help.
          const bigger = escalateBudget(singleCtx.maxTokens);
          if (!bigger) throw firstError;
          diagnostics.outputEscalations++;
          warnings.push(`Ответ не поместился в ${singleCtx.maxTokens} токенов — повторяю с лимитом ${bigger}.`);
          noteFallback(`single:budget-escalation ${singleCtx.maxTokens}->${bigger}`);
          onProgress({ stage: 'fallback', message: `Повторяю с лимитом ответа ${bigger} токенов` });
          try {
            assertRunnable();
            const retry = await sendSingle(bigger);
            if (retry.truncated) {
              // Still cut off: the full schema is bigger than this model can
              // write in one answer, or it keeps spending the budget on
              // thinking. A short-format answer at the same ceiling asks for
              // far less text and is the last cheap chance before chunks.
              const compact = await sendSingle(bigger, { simple: true, timeoutMs: COMPACT_TIMEOUT_MS }).catch((compactErr) => {
                if (compactErr?.detail === 'job-deadline' || compactErr?.code === 'CANCELLED') throw compactErr;
                return null;
              });
              if (compact && !compact.truncated && substanceOf(compact.json).ok) {
                call = compact;
                diagnostics.outputLimit = bigger;
                warnings.push('Полный формат не помещался в лимит — помог короткий формат.');
              } else {
                const truncation = new AIError('TRUNCATED', 'Ответ модели обрезан и после увеличения лимита');
                truncation.partialText = retry.text || compact?.text || '';
                throw truncation;
              }
            } else if (!substanceOf(retry.json).ok) {
              throw emptyResultError(retry.text, retry);
            } else {
              call = retry;
              diagnostics.outputLimit = bigger;
              warnings.push('Повтор с большим лимитом ответа помог.');
            }
          } catch (retryErr) {
            if (retryErr?.detail === 'job-deadline' || retryErr?.code === 'CANCELLED') throw retryErr;
            // No safe continuation across providers: keep the complete fields
            // of the cut-off answer, mark the result incomplete and never
            // present it as a full summary.
            const salvaged = salvageAiJson(retryErr?.partialText || firstError.partialText || '');
            if (!salvaged.ok || !substanceOf(salvaged.value).ok) throw firstError;
            diagnostics.outputLimit = bigger;
            diagnostics.salvaged = true;
            diagnostics.finishReason = 'output-limit';
            singleSalvaged = true;
            warnings.push('Ответ модели обрезан по лимиту: показана только полностью полученная часть.');
            noteFallback('single:partial-salvage');
            call = {
              json: salvaged.value,
              text: firstError.partialText || '',
              usage: { promptTokens: 0, completionTokens: 0 },
              latencyMs: 0,
              finishReason: 'length',
              truncated: true,
              parseStrategy: 'salvaged',
              estimatedIn: 0,
              salvaged: true,
            };
          }
        } else if (COMPACT_RETRY_CODES.has(firstError?.code)) {
          warnings.push('Модель вернула пустой конспект — повторяю коротким запросом.');
          noteFallback('single:compact-retry');
          onProgress({ stage: 'fallback', message: 'Пустой ответ — пробую короткий формат' });
          assertRunnable();
          const retry = await sendCompact().catch((compactErr) => {
            if (compactErr?.detail === 'job-deadline' || compactErr?.code === 'CANCELLED') throw compactErr;
            return null;
          });
          if (!retry || !substanceOf(retry.json).ok) throw firstError;
          call = retry;
          warnings.push('Короткий повтор помог.');
        } else {
          throw firstError;
        }
      }
      raw = call.json;
      addUsage(call.usage, call.latencyMs, 1);
      diagnostics.requestEstimatedTokens = call.estimatedIn || plan.tokens;
      if (!call.salvaged && !diagnostics.outputEscalations) diagnostics.outputLimit = singleCtx.maxTokens;
      noteCall({ stage: 'single', call, extra: { estimatedIn: call.estimatedIn } });
      if (call.parseStrategy && call.parseStrategy !== 'direct') warnings.push(`JSON разобран со второй попытки (${call.parseStrategy}).`);
    } catch (err) {
      // The model's own window is smaller than the transcript: fall back to
      // chunks instead of failing a run that could have succeeded. The manual
      // benchmark disables this so one live run costs exactly one request.
      // TRUNCATED belongs here too: the model could not write the whole summary
      // in one answer, and the chunked path asks for much less per request. It
      // used to fail the run (and drop to the local engine) even though the same
      // transcript would have summarized fine in pieces.
      // A call-level timeout on a long transcript is not the same as a dead
      // job: the chunked path asks for far less per request and shows each
      // fragment's notes as they are written, so the run can still finish
      // instead of dying on the first slow answer.
      const timeoutRecoverable = err?.code === 'TIMEOUT' && err?.detail !== 'job-deadline';
      if (
        (!['CONTEXT_LENGTH', 'TRUNCATED'].includes(err?.code) && !timeoutRecoverable) ||
        settings.singleFallback === false ||
        plan.tokens <= Number(settings.chunkTokens || 0)
      ) {
        throw err;
      }
      const outputLimited = err.code === 'TRUNCATED';
      // The context-length fallback starts a new phase: no point in planning
      // it when the job clock has already run out.
      assertRunnable();
      warnings.push(
        outputLimited
          ? 'Ответ модели не поместился в лимит токенов — перехожу на анализ фрагментами.'
          : timeoutRecoverable
            ? 'Модель не ответила за отведённое время — перехожу на анализ фрагментами.'
            : 'Транскрипт не поместился в контекст модели — перехожу на анализ фрагментами.',
      );
      noteFallback(
        outputLimited ? 'single:output-limit' : timeoutRecoverable ? 'single:timeout' : 'single:context-length',
      );
      onProgress({ stage: 'fallback', message: 'Перехожу на анализ фрагментами' });
      plan = planStrategy({
        segments,
        maxTokens: Number(settings.chunkTokens) || 6000,
        chunkTokens: settings.chunkTokens,
        strategy: 'map-reduce',
      });
      // This specific recovery may buy time — but only when the rejection was
      // definitive and immediate. A slow failure (a timeout, a hung model) must
      // not start another multi-minute scenario automatically.
      const elapsedBeforeFallback = Date.now() - singleStartedAt;
      if (elapsedBeforeFallback <= CONTEXT_FALLBACK_TRIGGER_MS) {
        const wantedExtension = Math.min(
          CONTEXT_FALLBACK_MAX_MS,
          mapReduceAllowanceMs(plan.chunks.length, settings) + JOB_LOCAL_RESERVE_MS,
        );
        const hardCap = parentDeadlineAt ? Math.max(0, parentDeadlineAt - Date.now()) : Infinity;
        const extension = Math.max(0, Math.min(wantedExtension, hardCap));
        const previousDeadlineAt = jobDeadlineAt;
        const extendedTo = Date.now() + extension;
        if (extension > 0 && jobClock?.extendTo(extendedTo)) {
          jobDeadlineAt = jobClock.deadlineAt();
          // The reported budget is what the job could actually use, not the
          // first plan's figure. It stays an upper bound, never an ETA.
          jobBudgetMs = Math.max(0, jobBudgetMs + Math.max(0, jobDeadlineAt - previousDeadlineAt));
          ctx.deadlineAt = jobDeadlineAt;
          diagnostics.deadlineAt = jobDeadlineAt;
          diagnostics.budgetMs = jobBudgetMs;
          diagnostics.recoveryMs = (diagnostics.recoveryMs || 0) + Math.max(0, jobDeadlineAt - previousDeadlineAt);
          if (jobState) {
            jobState.deadlineAt = jobDeadlineAt;
            jobState.budgetMs = jobBudgetMs;
          }
          noteFallback(`single:fallback-extension +${Math.round(extension / 1000)}s`);
          onProgress({
            stage: 'fallback',
            message: `Анализ фрагментами (+${Math.round(extension / 1000)} с к бюджету)`,
          });
        }
      }
      diagnostics.strategy = 'map-reduce';
      diagnostics.transcriptTokens = plan.tokens;
      useSingle = false;
    }
  }
  if (!useSingle && !timelineOnce) {
    strategy = 'map-reduce';
    const total = plan.chunks.length;
    const mapStartedAt = Date.now();
    const inflight = () => Math.min(settings.concurrency, total);
    onProgress({
      stage: 'map',
      done: 0,
      total,
      running: inflight(),
      pending: Math.max(0, total - inflight()),
      elapsedMs: 0,
      message: `Анализирую ${total} фрагмент(ов)`,
    });
    let done = 0;
    // A map answer is short, but a reasoning model spends part of the same
    // budget on thinking. max_tokens is a cap, not a bill: keeping it at 1000
    // made every fragment of a thinking model arrive truncated.
    const mapBudget = Math.min(4096, Math.max(2000, Number(settings.maxOutputTokens) || 0));
    // The map phase must leave room for reduce and the final assembly, and it
    // still obeys its own 10-minute cap. A job deadline can shorten it further.
    const reduceReserve = reduceAllowanceMs(total, settings);
    // Reserve for reduce, but never starve map: on a very tight job budget map
    // gets at least 75% of the remaining time and reduce takes the rest. This
    // keeps partial coverage possible instead of skipping every chunk.
    const remainingAtMapStart = jobDeadlineAt ? Math.max(0, jobDeadlineAt - Date.now()) : Infinity;
    const effectiveReserve = Number.isFinite(remainingAtMapStart)
      ? Math.min(reduceReserve, Math.floor(remainingAtMapStart / 4))
      : reduceReserve;
    const mapDeadlineAt = Math.min(
      mapStartedAt + MAP_DEADLINE_MS,
      jobDeadlineAt ? Math.max(mapStartedAt, jobDeadlineAt - effectiveReserve) : Infinity,
    );
    // Фрагмент небольшой, и полный таймаут запроса для него избыточен: одна
    // зависшая бесплатная модель съедала минуты на чанк. Ошибка раньше —
    // понятнее, чем бесконечное «Анализирую».
    const mapTimeoutMs = Math.min(Number(settings.timeoutMs) || 90000, 90000);
    // Notes for one fragment are short, so they can be shown while the model is
    // still writing them: on a three-hour video waiting for a whole wave of
    // fragments meant minutes of an empty screen. Every emitted point is a
    // closed JSON value validated by the same schema as the final result; the
    // finished fragment replaces its live entry, so nothing is shown twice.
    const makeChunkStream = (chunk) =>
      settings.stream === false
        ? null
        : createSummaryStream({
            onItem: (item) => {
              if (userCancelled() || item.kind !== 'keyPoint') return;
              onProgress({
                stage: 'partial-item',
                index: chunk.index,
                startAt: chunk.startAt,
                endAt: chunk.endAt,
                item,
                total,
              });
            },
          });
    const sendChunk = async (chunk, maxTokens, { remind = false } = {}) => {
      const messages = mapMessages({ chunk, meta, opts, total, remind });
      const estimatedIn = estimateTokens(messages.map((m) => m.content).join('\n'));
      let live = makeChunkStream(chunk);
      const res = await callForJson({
        messages,
        ctx: { ...ctx, stream: !!live, maxTokens, timeoutMs: mapTimeoutMs },
        onDelta: (delta) => live?.push(delta),
        // A retry is a new answer: a parser left closed by the first object
        // would silently ignore everything the second one writes.
        onRetry: () => {
          live = makeChunkStream(chunk);
        },
        repair: settings.jsonRepair !== false,
      });
      return { ...res, estimatedIn };
    };
    // A stuck or rate-limited provider must not make the run endless: after the
    // deadline the remaining chunks are skipped and the summary is built from
    // what was already collected (the panel shows the warnings).
    let budgetRetries = 0;
    let proseRetries = 0;
    // Chunks are independent, so they go out in parallel: fifteen chunks at
    // concurrency 3 take five waves, at 15 they take one. A rate-limited
    // provider halves the limit for whatever is still queued.
    const mapLimiter = createLimiter(settings.concurrency);
    // Explicit lifecycle per chunk. “The run finished” must never be inferred
    // from “some chunks answered”: a 3.5-hour video used to show a complete
    // looking конспект built from a single fragment because 19 empty answers
    // were counted as successes.
    const records = plan.chunks.map((chunk) => ({
      index: chunk.index,
      startAt: chunk.startAt,
      endAt: chunk.endAt,
      status: 'pending',
      reason: '',
      cached: false,
    }));
    // Publishes one validated map note as soon as it settles. The panel sorts by
    // `index`, so completion order never reorders the video.
    const publishPartial = (chunk, partial, extra = {}) => {
      if (userCancelled() || !partial || partialMaterial(partial) === 0) return;
      if (!diagnostics.firstPartialMs) diagnostics.firstPartialMs = Date.now() - diagnostics.startedAt;
      const ready = records.filter((r) => r.status === 'succeeded').length;
      onProgress({
        stage: 'partial',
        index: chunk.index,
        startAt: chunk.startAt,
        endAt: chunk.endAt,
        partial,
        done: ready,
        total,
        ...extra,
      });
    };
    const partials = await mapAdaptive(plan.chunks, async (chunk) => {
      const record = records[chunk.index];
      record.queueMs = Date.now() - mapStartedAt;
      diagnostics.mapQueueMs = Math.max(diagnostics.mapQueueMs || 0, record.queueMs);
      const outOfTime = Date.now() >= mapDeadlineAt || jobExpired() || remainingMs() <= 0;
      if (outOfTime || userCancelled()) {
        record.status = userCancelled() ? 'cancelled' : 'failed';
        record.reason = userCancelled()
          ? 'задача отменена'
          : jobExpired() || remainingMs() <= 0
            ? 'исчерпан бюджет задания'
            : 'превышен лимит времени анализа';
        // No new request is started after the deadline: the queue drains
        // without fetch calls and the run keeps whatever already succeeded.
        if (!userCancelled()) warnings.push(`Фрагмент ${chunk.index + 1} пропущен: ${record.reason}`);
        done++;
        onProgress({ stage: 'map', done, total, elapsedMs: Date.now() - mapStartedAt, message: `Фрагмент ${done}/${total} (${userCancelled() ? 'отмена' : 'лимит времени'})` });
        return null;
      }
      record.status = 'running';
      try {
        // A fragment saved before the worker was terminated needs no request.
        const resumedPartial = resumePartials ? resumePartials[chunk.index] : null;
        if (resumedPartial && partialMaterial(resumedPartial) > 0) {
          diagnostics.resumed++;
          record.status = 'succeeded';
          record.resumed = true;
          try {
            await chunkStateSink({ index: chunk.index, startAt: chunk.startAt, endAt: chunk.endAt, status: 'succeeded', partial: resumedPartial, resumed: true });
          } catch {
            /* persistence must not break the run */
          }
          publishPartial(chunk, resumedPartial, { resumed: true });
          return resumedPartial;
        }
        const key = chunkCacheKey({ chunk, model, provider, opts });
        if (chunkCache && settings.chunkCache !== false) {
          const cached = await chunkCache.get(key).catch(() => null);
          if (cached && partialMaterial(cached) > 0) {
            diagnostics.cacheHits++;
            record.status = 'succeeded';
            record.cached = true;
            try {
              await chunkStateSink({ index: chunk.index, startAt: chunk.startAt, endAt: chunk.endAt, status: 'succeeded', key, partial: cached, cached: true });
            } catch {
              /* ignore */
            }
            publishPartial(chunk, cached, { cached: true });
            return cached;
          }
          diagnostics.cacheMisses++;
        }
        const substantive = countWords(chunk.text) >= SUBSTANTIVE_CHUNK_WORDS;
        let call;
        try {
          call = await sendChunk(chunk, mapBudget);
          if (call.truncated) {
            // The JSON was cut mid-answer: its parsed fields look valid but the
            // fragment is only partially covered, so it must not be stored as
            // a successful chunk result.
            throw new AIError('TRUNCATED', 'Ответ фрагмента обрезан по лимиту токенов', { retryable: true });
          }
        } catch (err) {
          if (isBudgetError(err)) {
            // One retry with a much larger budget: reasoning models spend the
            // first one on thinking and never reach the JSON. The retry jumps
            // straight to the ceiling, because a fragment-sized doubling is
            // still mostly thinking tokens.
            const bigger = Math.min(ESCALATED_OUTPUT_TOKENS, Math.max(mapBudget * 2, 4096));
            if (bigger <= mapBudget) throw err;
            budgetRetries++;
            noteFallback(`map:budget-escalation ${mapBudget}->${bigger}`);
            call = await sendChunk(chunk, bigger);
            if (call.truncated) throw new AIError('TRUNCATED', 'Ответ фрагмента обрезан и после увеличения лимита');
          } else if (err?.code === 'BAD_JSON') {
            // The model answered with prose instead of JSON. A short retry with
            // an explicit reminder costs seconds and saves the fragment — three
            // lost fragments used to turn a 40-minute video into a draft.
            proseRetries++;
            noteFallback('map:json-retry');
            call = await sendChunk(chunk, mapBudget, { remind: true });
          } else {
            throw err;
          }
        }
        // A weak free model sometimes answers with the schema itself instead of
        // the fragment ("тезис 8-25 слов", "тема").
        if (echoedSchemaOnly(call.json)) {
          proseRetries++;
          noteFallback('map:schema-echo-retry');
          call = await sendChunk(chunk, mapBudget, { remind: true });
          if (echoedSchemaOnly(call.json)) {
            throw new AIError('EMPTY_RESULT', 'Фрагмент не содержит конспекта: модель повторила схему вместо ответа');
          }
        }
        // Valid JSON with no material is not “processed” for a fragment that
        // contains speech; short outros and ad reads may be legitimately empty.
        if (partialMaterial(call.json) === 0 && substantive) {
          proseRetries++;
          noteFallback('map:empty-retry');
          call = await sendChunk(chunk, mapBudget, { remind: true });
          if (partialMaterial(call.json) === 0) {
            throw new AIError('EMPTY_RESULT', 'Модель не извлекла ни одного факта из содержательного фрагмента');
          }
        }
        addUsage(call.usage, call.latencyMs);
        noteCall({ stage: 'map', chunkId: String(chunk.index + 1), call, extra: { estimatedIn: call.estimatedIn } });
        if (chunkCache && settings.chunkCache !== false && partialMaterial(call.json) > 0) {
          await chunkCache.put(key, call.json).catch(() => null);
        }
        record.status = 'succeeded';
        try {
          await chunkStateSink({ index: chunk.index, startAt: chunk.startAt, endAt: chunk.endAt, status: 'succeeded', key, partial: call.json });
        } catch {
          /* ignore */
        }
        publishPartial(chunk, call.json);
        return call.json;
      } catch (err) {
        const cancelled = userCancelled() || err?.code === 'CANCELLED';
        record.status = cancelled ? 'cancelled' : err?.retryable ? 'retryable_failed' : 'failed';
        record.reason = cancelled
          ? 'задача отменена'
          : err?.detail === 'job-deadline'
            ? 'исчерпан бюджет задания'
            : err?.code ? `${err.code}: ${err.message}` : String(err?.message || err);
        try {
          await chunkStateSink({ index: chunk.index, startAt: chunk.startAt, endAt: chunk.endAt, status: record.status, reason: record.reason });
        } catch {
          /* ignore */
        }
        if (err?.code === 'RATE_LIMIT') {
          const now = mapLimiter.lower();
          diagnostics.rateLimited++;
          // Retry-After (or a modest default when the provider sends none)
          // applies to the whole run: the chunks still queued must not keep
          // hammering the endpoint that asked for a pause. The cooldown is
          // capped by the map deadline so it can never outlive the job.
          const requested = Math.max(0, Number(err?.retryAfterMs) || 2000);
          const untilDeadline = Number.isFinite(mapDeadlineAt)
            ? Math.max(0, mapDeadlineAt - Date.now())
            : requested;
          const held = mapLimiter.pause(Math.min(requested, untilDeadline));
          diagnostics.mapPausedMs = Math.max(diagnostics.mapPausedMs || 0, Math.round(held));
          warnings.push(
            held > 0
              ? `Провайдер ограничил частоту запросов — новые фрагменты начнутся через ${Math.ceil(held / 1000)} с, параллельных запросов теперь ${now}.`
              : `Провайдер ограничил частоту запросов — параллельных запросов теперь ${now}.`,
          );
        }
        noteCall({ stage: 'map', chunkId: String(chunk.index + 1), error: err });
        warnings.push(`Фрагмент ${chunk.index + 1} (${formatTime(chunk.startAt)}) не обработан: ${err.message}`);
        if (!cancelled) {
          // A local failure must be visible next to the fragments that did
          // succeed, instead of being hidden until the final result.
          onProgress({
            stage: 'partial',
            index: chunk.index,
            startAt: chunk.startAt,
            endAt: chunk.endAt,
            failed: true,
            reason: record.reason,
            done: records.filter((r) => r.status === 'succeeded').length,
            total,
          });
        }
        return null;
      } finally {
        done++;
        // Report the window that is actually open now, not the starting one:
        // after a 429 the panel must show the reduced parallelism.
        const running = Math.min(mapLimiter.current, Math.max(0, total - done));
        onProgress({
          stage: 'map',
          done,
          total,
          running,
          pending: Math.max(0, total - done - running),
          elapsedMs: Date.now() - mapStartedAt,
          message: `Фрагмент ${done}/${total}`,
        });
      }
    }, mapLimiter);

    if (budgetRetries) {
      warnings.push(
        `Модель не уложилась в лимит ответа на ${budgetRetries} фрагмент(ах): бесплатные модели с режимом размышления тратят лимит на рассуждения. ` +
          'Выберите обычную модель без режима размышления или поднимите «Максимум токенов ответа» в настройках.',
      );
    }
    if (userCancelled()) throw cancelledError();
    const usable = partials.filter(Boolean);
    if (!usable.length) {
      if (jobExpired() || remainingMs() <= 0) throw jobDeadlineError();
      const reason = records.find((r) => r.reason)?.reason || '';
      throw new AIError('MAP_FAILED', 'Ни один фрагмент не был обработан', {
        hint: [reason, warnings[0]].filter(Boolean).join(' · ') || 'Проверьте настройки провайдера и размер чанка.',
      });
    }
    const missing = records.filter((r) => r.status !== 'succeeded');
    const complete = missing.length === 0;
    diagnostics.complete = complete;
    diagnostics.lastFailure = missing.find((r) => r.reason)?.reason || '';
    diagnostics.chunkCounts = {
      done: total - missing.length,
      running: 0,
      pending: 0,
      failed: missing.filter((r) => r.status === 'failed' || r.status === 'retryable_failed').length,
      cancelled: missing.filter((r) => r.status === 'cancelled').length,
    };
    diagnostics.chunkStatus = records.map(
      (r) => `${r.index + 1}:${r.status}${r.cached ? ':cache' : ''}${r.resumed ? ':resume' : ''}`,
    );
    if (!complete) {
      const ranges = missing
        .slice(0, 6)
        .map((r) => `${formatTime(r.startAt)}–${formatTime(r.endAt)}`)
        .join(', ');
      warnings.unshift(
        `Не обработано фрагментов: ${missing.length} из ${total} (${ranges}${missing.length > 6 ? '…' : ''}). ` +
          'Конспект покрывает только успешно обработанные части видео — это неполный результат.',
      );
      onProgress({
        stage: 'incomplete',
        done: total - missing.length,
        total,
        missing: missing.length,
        message: `Неполное покрытие: ${missing.length} фрагмент(ов) без конспекта`,
      });
    }

    onProgress({ stage: 'reduce', elapsedMs: Date.now() - mapStartedAt, message: 'Собираю итоговый конспект' });
    const partialTexts = partials.map((p, i) => (p ? partialToText(p) : `--- Фрагмент ${i + 1} (пропущен) ---`));
    // Бюджет входа для одной сборки — окно модели минус промпт и ответ, а не
    // размер map-фрагмента: заметки трёхчасового видео (~10k токенов) должны
    // собираться одним запросом, а не лишним раундом иерархического reduce.
    const reduceBudget = reduceInputBudget(settings);

    // Hierarchical reduce when the partials do not fit the context.
    let toReduce = partialTexts;
    let round = 0;
    while (estimateTokens(toReduce.join('\n')) > reduceBudget && round < REDUCE_ROUND_LIMIT && toReduce.length > 2 && remainingMs() > 0 && !jobExpired()) {
      const groupSize = Math.max(2, Math.ceil(toReduce.length / Math.ceil(estimateTokens(toReduce.join('\n')) / reduceBudget)));
      const groups = [];
      for (let i = 0; i < toReduce.length; i += groupSize) groups.push(toReduce.slice(i, i + groupSize));
      onProgress({
        stage: 'reduce-batch',
        elapsedMs: Date.now() - mapStartedAt,
        message: `Промежуточная сборка (${groups.length} групп)`,
      });
      const reduceLimiter = createLimiter(Math.max(1, Math.min(settings.concurrency, 2)));
      const reduced = await mapAdaptive(groups, async (group) => {
        if (userCancelled()) throw cancelledError();
        // A group whose note was saved by the interrupted run is reused as is.
        const groupKey = hashString(JSON.stringify([model, group]));
        const reused = savedReduce[groupKey];
        if (typeof reused === 'string' && reused) {
          diagnostics.reduceResumed++;
          return reused;
        }
        // No new reduce request once the job clock is spent: keep the original
        // text so the draft can still be built from successful chunks.
        if (jobExpired() || remainingMs() <= 0) return group.join('\n');
        try {
          const messages = reduceMessages({ partials: group, meta, opts });
          const estimatedIn = estimateTokens(messages.map((m) => m.content).join('\n'));
          const res = await callForJson({
            messages,
            ctx: { ...ctx, stream: false, maxTokens: Math.min(1600, settings.maxOutputTokens) },
            repair: settings.jsonRepair !== false,
          });
          const call = { ...res, estimatedIn };
          addUsage(call.usage, call.latencyMs);
          noteCall({ stage: 'reduce-batch', call, extra: { round: round + 1, estimatedIn } });
          const text = partialToText(call.json) || JSON.stringify(call.json);
          try {
            await reduceStateSink({ key: groupKey, text });
          } catch {
            /* persistence must not break the run */
          }
          return text;
        } catch (err) {
          if (err?.code === 'RATE_LIMIT') reduceLimiter.lower();
          noteCall({ stage: 'reduce-batch', error: err, extra: { round: round + 1 } });
          warnings.push(`Промежуточная сборка не удалась: ${err.message}`);
          return group.join('\n');
        }
      }, reduceLimiter);
      toReduce = reduced;
      round++;
      diagnostics.reduceRounds = round;
    }

    // The assembly is the single most failure-prone call of a long video: one
    // huge answer from a free reasoning model. It gets three chances — a plain
    // retry for invalid JSON, a bigger output ceiling when the answer was cut
    // off (reasoning models spend the budget before writing), and finally the
    // complete fields of the cut-off answer instead of throwing all of them
    // away. Only then does the draft fallback run.
    let reduceCall = null;
    let reduceErr = null;
    let reduceTokens = Math.max(2048, Number(ctx.maxTokens) || outputBudget);
    for (let attempt = 0; attempt < 3 && !reduceCall && remainingMs() > 0 && !jobExpired(); attempt++) {
      const streaming = attempt === 0 && settings.stream !== false;
      try {
        const messages = reduceMessages({ partials: toReduce, meta, opts });
        const estimatedIn = estimateTokens(messages.map((m) => m.content).join('\n'));
        const res = await callForJson({
          messages,
          ctx: { ...ctx, stream: streaming, maxTokens: reduceTokens },
          onDelta: streaming ? (chunk, full) => onDelta({ chunk, full }) : undefined,
          repair: settings.jsonRepair !== false,
        });
        const call = { ...res, estimatedIn };
        if (call.truncated) {
          // The answer was cut mid-JSON. Complete fields are real content: a
          // valid tldr and several sections are worth much more than a draft,
          // but the run must say it is incomplete.
          const salvaged = salvageAiJson(call.text || '');
          // A cut-off assembly can be fine content-wise (one complete section and
          // a lead) while still missing fields; it is worth keeping once the
          // ceiling can no longer grow. Until then a bigger budget is better.
          const salvagedSections = Array.isArray(salvaged.value?.sections) ? salvaged.value.sections.length : 0;
          const usable =
            salvaged.ok && (substanceOf(salvaged.value).ok || salvagedSections > 0 || countWords(salvaged.value?.tldr || '') >= 5);
          const bigger = Math.min(ESCALATED_OUTPUT_TOKENS, Math.max(reduceTokens * 2, 6144));
          if (bigger > reduceTokens && attempt < 2) {
            diagnostics.outputEscalations++;
            warnings.push(`Итоговая сборка обрезана — повторяю с лимитом ${bigger} токенов.`);
            noteFallback(`reduce:budget-escalation ${reduceTokens}->${bigger}`);
            onProgress({ stage: 'fallback', message: `Повторяю сборку с лимитом ${bigger} токенов` });
            reduceTokens = bigger;
            continue;
          }
          if (usable) {
            addUsage(call.usage, call.latencyMs, 1);
            noteCall({ stage: 'reduce', call, extra: { estimatedIn, salvaged: true } });
            diagnostics.salvaged = true;
            diagnostics.outputLimit = reduceTokens;
            reduceSalvaged = true;
            warnings.push('Итоговая сборка обрезана по лимиту: показана только полностью полученная часть.');
            noteFallback('reduce:partial-salvage');
            reduceCall = {
              ...call,
              json: salvaged.value,
              truncated: true,
              salvaged: true,
              parseStrategy: 'salvaged',
            };
            break;
          }
          throw new AIError('TRUNCATED', 'Итоговая сборка не поместилась в лимит ответа', { retryable: true });
        }
        const substance = substanceOf(call.json);
        if (!substance.ok) throw emptyResultError(call.text, call);
        addUsage(call.usage, call.latencyMs, 1);
        noteCall({ stage: 'reduce', call, extra: { estimatedIn } });
        reduceCall = call;
      } catch (err) {
        if (userCancelled() || err?.code === 'CANCELLED') throw cancelledError();
        reduceErr = err;
        const retryable = ['BAD_JSON', 'EMPTY_RESULT', 'EMPTY_RESPONSE', 'TRUNCATED'].includes(err?.code);
        if (attempt < 2 && retryable) {
          warnings.push(`Итоговая сборка не удалась (${err?.code || 'нет ответа'}) — повторяю.`);
          noteFallback(`reduce:retry ${err?.code || ''}`);
          onProgress({ stage: 'fallback', message: 'Повторяю итоговую сборку' });
          continue;
        }
        break;
      }
    }
    if (reduceCall) {
      if (reduceCall.parseStrategy && reduceCall.parseStrategy !== 'direct' && !reduceCall.salvaged) {
        warnings.push(`JSON разобран со второй попытки (${reduceCall.parseStrategy}).`);
      }
      raw = reduceCall.json;
    } else {
      if (userCancelled()) throw cancelledError();
      noteCall({ stage: 'reduce', error: reduceErr });
      const outOfTime = jobExpired() || remainingMs() <= 0;
      warnings.push(
        outOfTime
          ? 'Общий бюджет задания исчерпан — показан черновой конспект из готовых фрагментов.'
          : `Итоговая сборка не удалась (${reduceErr?.message || 'нет ответа'}) — показан черновой конспект.`,
      );
      const totalWords = countWords(segments.map((s) => String(s.text || '')).join(' '));
      const result = degradedFromPartials({
        partials,
        chunks: plan.chunks,
        meta,
        ctx: buildCtx({
          meta,
          provider,
          model,
          uiLang,
          strategy: complete ? `${strategy}:degraded` : `${strategy}:partial`,
          usage,
          warnings,
          totalWords,
          tokens: plan.tokens,
          diagnostics,
          complete,
        }),
        warnings,
      });
      // Self-check is off by default; a model that writes the block anyway
      // must not put it on screen.
      if (!opts.selfCheck) result.questions = [];
      applyGrounding(result);
      result.stats = {
        ...result.stats,
        words: totalWords,
        ...computeSummaryStats(result, totalWords),
        chunks: plan.chunks.length,
        transcriptSource: meta.source || '',
        aiComplete: complete,
        aiChunksOk: total - missing.length,
        aiChunksTotal: total,
      };
      diagnostics.totalMs = Date.now() - diagnostics.startedAt;
      diagnostics.localMs = Math.max(0, diagnostics.totalMs - diagnostics.providerMs);
      diagnostics.outputLimit = outputBudget;
      diagnostics.finishReason = outOfTime
        ? 'job-timeout'
        : records.some((r) => /RATE_LIMIT/.test(r.reason))
          ? 'quota'
          : records.some((r) => /TIMEOUT/.test(r.reason))
            ? 'call-timeout'
            : 'provider-error';
      diagnostics.resumable = !complete;
      diagnostics.remainingMs = Math.max(0, Math.round(remainingMs()));
      diagnostics.tokensIn = usage.promptTokens;
      diagnostics.tokensOut = usage.completionTokens;
      return { result, strategy: `${strategy}:degraded`, usage, warnings, plan, complete, diagnostics };
    }
  }

  if (userCancelled()) throw cancelledError();
  const totalWords = countWords(segments.map((s) => String(s.text || '')).join(' '));
  // A salvaged assembly is a real summary, but not the whole one: it must not
  // be presented (or cached) as complete.
  const complete = reduceSalvaged ? false : strategy === 'single' ? !singleSalvaged : diagnostics.complete;
  diagnostics.complete = complete;
  const finalCtx = buildCtx({
    meta,
    provider,
    model,
    uiLang,
    strategy: complete ? strategy : `${strategy}:partial`,
    usage,
    warnings: [...warnings],
    totalWords,
    tokens: plan.tokens,
    diagnostics,
    complete,
  });
  const buildStarted = Date.now();
  const result = normalizeResult(coercePayload(raw), finalCtx);
  // “questions: до 0” is an instruction, not a guarantee: free models write the
  // block anyway. The setting wins over the model's choice.
  if (!opts.selfCheck) result.questions = [];
  applyGrounding(result);
  diagnostics.resultBuildMs = Date.now() - buildStarted;
  result.stats = {
    ...result.stats,
    words: totalWords,
    ...computeSummaryStats(result, totalWords),
    chunks: strategy === 'timeline' ? diagnostics.blocks || 0 : plan.chunks.length,
    transcriptSource: meta.source || '',
    aiTokensIn: usage.promptTokens,
    aiTokensOut: usage.completionTokens,
    aiCalls: usage.calls,
    aiLatencyMs: usage.latencyMs,
    aiComplete: complete,
    aiChunksOk: strategy === 'timeline'
      ? diagnostics.blocksOk || 0
      : strategy === 'single'
        ? plan.chunks.length
        : plan.chunks.length - (diagnostics.chunkStatus || []).filter((s) => !s.includes(':succeeded')).length,
    aiChunksTotal: strategy === 'timeline' ? diagnostics.blocks || 0 : plan.chunks.length,
    aiCacheHits: diagnostics.cacheHits,
  };
  if (plan.tokens > settings.chunkTokens * 8) {
    result.notes.push('Очень длинное видео: качество конспекта зависит от модели и размера чанка.');
  }
  diagnostics.startedAt = diagnostics.startedAt || Date.now();
  diagnostics.totalMs = Date.now() - diagnostics.startedAt;
  // Everything that is not waiting for a provider: planning, JSON parsing,
  // validation and building SummaryResult.
  diagnostics.localMs = Math.max(0, diagnostics.totalMs - diagnostics.providerMs);
  diagnostics.outputLimit = diagnostics.outputLimit || outputBudget;
  diagnostics.finishReason = singleSalvaged
    ? 'output-limit'
    : complete
      ? 'success'
      : jobExpired() || remainingMs() <= 0
        ? 'job-timeout'
        : /RATE_LIMIT/.test(diagnostics.lastFailure || '')
          ? 'quota'
          : /TIMEOUT/.test(diagnostics.lastFailure || '')
            ? 'call-timeout'
            : strategy === 'timeline' || reduceSalvaged
              ? 'incomplete'
              : 'provider-error';
  diagnostics.resumable = !complete;
  diagnostics.remainingMs = Math.max(0, Math.round(remainingMs()));
  // What the API reported for the whole run; unknown stays zero, never guessed.
  diagnostics.tokensIn = usage.promptTokens;
  diagnostics.tokensOut = usage.completionTokens;
  onProgress({ stage: 'done', message: 'Готово' });
  return { result, strategy, usage, warnings, plan, complete, diagnostics };
}

function buildCtx({ meta, provider, model, uiLang, strategy, usage, warnings, totalWords, tokens, diagnostics = null, complete = true }) {
  return {
    mode: 'ai',
    engine: `ai:${provider?.presetId || provider?.id || 'custom'}`,
    videoId: meta.videoId || '',
    videoTitle: meta.videoTitle || '',
    channel: meta.channel || '',
    lengthSeconds: meta.lengthSeconds || 0,
    url: meta.url || (meta.videoId ? `https://www.youtube.com/watch?v=${meta.videoId}` : ''),
    lang: meta.lang || 'ru',
    uiLang,
    provider: provider?.name || '',
    model: model || '',
    meta: {
      transcriptSource: meta.source || '',
      autoGenerated: !!meta.autoGenerated,
      strategy,
      complete,
      transcriptTokens: tokens,
      transcriptWords: totalWords,
      usage,
      warnings,
      ...(diagnostics ? { diagnostics } : {}),
    },
  };
}

/**
 * Q&A over a transcript. Uses whole-transcript context when it fits,
 * otherwise local BM25 retrieval picks the most relevant fragments first.
 */
export async function runAiAsk({
  question,
  segments,
  meta = {},
  provider,
  apiKey = '',
  model,
  aiSettings = {},
  output = {},
  uiLang = 'ru',
  onProgress = noop,
  signal,
  deadlineAt = 0,
}) {
  const settings = { temperature: 0.2, maxOutputTokens: 1200, chunkTokens: 3200, contextTokens: 12000, ...aiSettings };
  const blocks = buildBlocks(segments);
  const allText = renderBlocks(blocks);
  const totalTokens = estimateTokens(allText);
  let context = allText;
  let retrieved = 0;

  if (totalTokens > settings.contextTokens) {
    const docs = blocks.map((b) => ({ ...b, stems: stemsOf(tokenize(b.text)), at: b.at, text: b.text }));
    const ranked = bm25(stemsOf(tokenize(question)), docs, {});
    const picked = new Set(ranked.slice(0, 36).map((r) => r.index));
    // Always include the opening and the ending for global context.
    for (let i = 0; i < Math.min(3, blocks.length); i++) picked.add(i);
    for (let i = Math.max(0, blocks.length - 2); i < blocks.length; i++) picked.add(i);
    const selected = Array.from(picked).sort((a, b) => a - b).map((i) => blocks[i]);
    retrieved = selected.length;
    context = selected.map(blockLine).join('\n');
    onProgress({ stage: 'retrieve', message: `Выбрано ${selected.length} релевантных фрагментов из ${blocks.length}` });
  }

  const res = await callForJson({
    messages: qaMessages({ question, context, meta, opts: { outputLanguage: resolveOutputLanguage(output.language, uiLang), transcriptLang: meta.lang || 'ru' } }),
    ctx: {
      provider,
      apiKey,
      model,
      temperature: settings.temperature,
      maxTokens: settings.maxOutputTokens,
      timeoutMs: 120000,
      retries: 1,
      signal,
      deadlineAt: Number(deadlineAt) > 0 ? Number(deadlineAt) : 0,
      deadlineDetail: 'job-deadline',
      stream: false,
    },
    repair: true,
  });

  const json = res.json || {};
  const citations = (Array.isArray(json.citations) ? json.citations : [])
    .map((c) => {
      const at = parseAt(c?.at);
      return { text: String(c?.text || '').trim(), at, ts: at == null ? null : formatTime(at) };
    })
    .filter((c) => c.text);
  const notFound = json.notFound === true || !json.answer;
  return {
    answer: notFound
      ? 'В этом видео ответ не прозвучал — в транскрипте нет подтверждающих фрагментов.'
      : String(json.answer).trim(),
    citations,
    confidence: Number(json.confidence) || (notFound ? 0 : 0.5),
    notFound,
    retrieved: retrieved || blocks.length,
    usage: { promptTokens: res.usage?.promptTokens || 0, completionTokens: res.usage?.completionTokens || 0 },
    latencyMs: res.latencyMs || 0,
    mode: 'ai',
  };
}

export { buildChunks, planStrategy, mapLimit };
