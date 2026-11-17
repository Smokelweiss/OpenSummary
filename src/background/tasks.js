/**
 * Long-running AI tasks: summary (with provider fallback chain) and Q&A.
 * Progress, stream deltas and results are pushed over a long-lived port so the
 * panel can render while the model is still writing.
 */

import { APP, EV, MSG, PORT, PORT_MSG } from '../common/constants.js';
import { ext } from '../common/compat.js';
import { getSettings, getCached, putCached, addHistory, trackUsage, cacheKey, getAiChunk, putAiChunk } from '../common/storage.js';
import { hashString } from '../common/util.js';
import { runAiSummary, runAiAsk, computeJobBudgetMs } from '../ai/pipeline.js';
import { operationBudgetMs } from '../ai/client.js';
import { PROMPT_VERSION } from '../ai/prompts.js';
import {
  claimJob,
  createJob,
  findResumableJob,
  getJob,
  jobResumeInfo,
  listJobs,
  recordChunk,
  recordReduceNote,
  resumablePartials,
  resumableReduceNotes,
  setJobStatus,
  transcriptFingerprint,
  jobFingerprint,
} from './jobs.js';
import { planStrategy } from '../ai/chunking.js';
import { resolveFallbackChain } from './state.js';
import { ensureTranscript } from './transcripts.js';

/**
 * Tasks running in this worker instance. A saved job whose task is still alive
 * is not resumable: without this, reopening the panel during one long call
 * would offer “Продолжить” for a job that is already being worked on.
 */
const activeTaskIds = new Set();

/** Errors for which switching to the next configured provider is pointless. */
const NO_FALLBACK = new Set([
  'RESUME_MISMATCH',
  'RESUME_IN_PROGRESS',
  'NO_PROVIDER',
  'NO_KEY',
  'NO_MODEL',
  'EMPTY_TRANSCRIPT',
  'BAD_VIDEO_ID',
  'NO_CAPTIONS',
  'POT_REQUIRED',
  'EMPTY_CAPTIONS',
  'PARSE_FAILED',
  'NO_TRACK_SELECTED',
  'TRANSCRIPT_TOO_LARGE',
  'TOO_LARGE',
]);

/**
 * Least job time that justifies one more provider after a call-level timeout:
 * below this the attempt cannot finish, and switching only delays the report.
 */
const TIMEOUT_FALLBACK_MIN_MS = 60000;

/** The saved job no longer matches the transcript, prompt, model or settings. */
function resumeMismatchError(detail = 'resume-mismatch') {
  const err = new Error('Сохранённое задание больше не совместимо с текущими данными');
  err.code = 'RESUME_MISMATCH';
  err.detail = detail;
  err.hint = 'Транскрипт, модель, промпт или настройки изменились. Запустите конспект заново — частичные результаты этого задания использовать нельзя.';
  err.finishReason = 'resume-mismatch';
  return err;
}

/** The same saved job is already being resumed by another click/tab. */
function resumeBusyError() {
  const err = new Error('Это задание уже продолжается');
  err.code = 'RESUME_IN_PROGRESS';
  err.detail = 'resume-busy';
  err.hint = 'Дождитесь завершения текущего продолжения — повторный запуск не нужен.';
  err.finishReason = 'resume-busy';
  return err;
}

/** Stable identity of a request: transcript + prompt + model + output settings. */
function fingerprintFor({ transcriptHash, settings, provider, model, uiLang, appVersion = APP.version }) {
  return jobFingerprint({
    transcriptHash,
    promptVersion: PROMPT_VERSION,
    appVersion,
    ai: settings.ai,
    output: settings.output,
    providerId: provider?.id || provider?.provider?.id || '',
    model,
    uiLang,
  });
}

/** Only switch providers with enough time left for a meaningful attempt. */
const MIN_PROVIDER_SWITCH_MS = 20000;

/** The whole job ran out of its plan-aware time budget. */
function jobDeadlineError(budgetMs = 0) {
  const err = new Error('Общий бюджет задания исчерпан');
  err.code = 'TIMEOUT';
  err.detail = 'job-deadline';
  err.hint = 'Задание остановлено по общему бюджету времени. Успешные фрагменты сохранены — повторный запуск продолжит с них.';
  err.budgetMs = budgetMs || 0;
  err.remainingMs = 0;
  err.finishReason = 'job-timeout';
  err.resumable = true;
  return err;
}

/**
 * Finds an interrupted job the user can explicitly continue. Compatibility is
 * checked against exactly what the resume would use: transcript fingerprint,
 * prompt revision, app version, provider, model and output settings. An
 * incompatible job is never offered — the panel would otherwise promise a
 * continuation that the task then refuses.
 *
 * No transcript is fetched when the video has no saved jobs: the panel calls
 * this on every open.
 */
export async function inspectResumableJob({ input = {}, providerId, model, settings: providedSettings } = {}) {
  const settings = providedSettings || (await getSettings());
  const videoId = input.videoId || '';
  let jobs = [];
  try {
    jobs = await listJobs();
  } catch {
    return { ok: true, job: null };
  }
  const now = Date.now();
  const candidates = jobs.filter((job) => {
    if (!job || (job.videoId || '') !== videoId) return false;
    if (job.status === 'interrupted') return true;
    if (job.status !== 'running') return false;
    // A live task owns its job even if no chunk has been written for a while:
    // single-pass makes exactly one long request. Without this, reopening the
    // panel during that request would offer “Продолжить” for a running job.
    if (job.taskId && activeTaskIds.has(job.taskId)) return false;
    // A `running` record without a live task is what a terminated worker
    // leaves behind; it is resumable exactly like `interrupted`.
    return now - (Date.parse(job.updatedAt || job.createdAt || 0) || 0) > 30 * 1000;
  });
  if (!candidates.length) return { ok: true, job: null };

  let transcript;
  try {
    transcript = await ensureTranscript(input);
  } catch (err) {
    return { ok: true, job: null, reason: err?.code || 'TRANSCRIPT_ERROR' };
  }
  let primary = null;
  try {
    primary = (await resolveFallbackChain({ providerId, model }))[0] || null;
  } catch {
    // No configured provider, no key: there is nothing a resume could run with.
    return { ok: true, job: null, reason: 'NO_PROVIDER' };
  }
  if (!primary) return { ok: true, job: null, reason: 'NO_PROVIDER' };
  const uiLang = uiLangFor(settings, transcript.meta.lang);
  const job = await findResumableJob({
    videoId: transcript.videoId || videoId,
    fingerprint: fingerprintFor({
      transcriptHash: transcriptFingerprint(transcript.segments),
      settings,
      provider: primary.provider,
      model: primary.model,
      uiLang,
    }),
  });
  // Saved jobs exist but none match the current data: say so explicitly, and
  // never offer a resume for them.
  if (!job) return { ok: true, job: null, mismatch: true };
  return { ok: true, job: jobResumeInfo(job) };
}

/** Languages the engine can write a конспект in (see prompts.LANG_NAMES). */
const WRITABLE_LANGS = new Set([
  'ru', 'en', 'uk', 'kk', 'es', 'de', 'fr', 'it', 'pt', 'pl', 'tr', 'ar', 'hi', 'zh', 'ja', 'ko', 'nl', 'sv', 'he', 'id', 'vi',
]);

/**
 * The user's language. “Auto” used to follow the VIDEO's language, so an
 * English video produced an English конспект (and an English panel) for a
 * Russian user. Now it follows the browser/extension language; an explicit
 * setting always wins.
 */
export function uiLangFor(settings, metaLang) {
  const configured = settings?.ui?.lang;
  if (configured && configured !== 'auto') return configured.slice(0, 2);
  let nav = '';
  try {
    nav = String(ext.i18n?.getUILanguage?.() || navigator?.language || '').slice(0, 2).toLowerCase();
  } catch {
    nav = '';
  }
  if (WRITABLE_LANGS.has(nav)) return nav;
  return 'en';
}

function aiVariant(settings) {
  const ai = settings.ai || {};
  const out = settings.output || {};
  // APP.version participates: a prompt or pipeline change must not serve
  // summaries cached with the previous behaviour.
  return `ai:${APP.version}:${hashString(
    JSON.stringify([
      PROMPT_VERSION,
      ai.contextTokens,
      ai.chunkTokens,
      ai.strategy,
      ai.summaryMode || 'whole',
      out.length,
      out.tone,
      out.language,
      // Self-check changes what the summary body contains: a cached answer with
      // questions must not be served after the block was turned off (and vice
      // versa).
      out.selfCheck === true,
      ai.systemPromptOverride,
      out.customInstructions,
    ]),
  )}`;
}

export async function runAiSummaryTask({
  input = {},
  providerId,
  model,
  taskId = '',
  settings: providedSettings,
  // Optional outer ceiling: a caller that owns a larger operation can only
  // shorten the job, never extend it.
  deadlineAt = 0,
  // Explicit “Продолжить”: the saved job id from the panel. When present, only
  // that job may be resumed and its fingerprint must still match; a fallback
  // provider starts its own job as usual.
  resumeJobId = '',
  onEvent = () => {},
  signal,
} = {}) {
  const settings = providedSettings || (await getSettings());
  onEvent({ type: EV.STAGE, stage: 'transcript', message: 'Получаю транскрипт' });
  const transcript = await ensureTranscript(input);
  const uiLang = uiLangFor(settings, transcript.meta.lang);
  const transcriptHash = transcriptFingerprint(transcript.segments);
  const videoId = transcript.videoId || '';
  // One absolute deadline for the logical summary operation, shared by every
  // provider in the fallback chain. It is planned from the transcript, strategy
  // and concurrency, never reset when the provider changes.
  const computedBudgetMs = computeJobBudgetMs({ segments: transcript.segments, aiSettings: settings.ai });
  const ownDeadlineAt = computedBudgetMs > 0 ? Date.now() + computedBudgetMs : 0;
  const parentDeadlineAt = Number(deadlineAt) > 0 ? Number(deadlineAt) : 0;
  const activeDeadlines = [ownDeadlineAt, parentDeadlineAt].filter((v) => v > 0);
  const jobDeadlineAt = activeDeadlines.length ? Math.min(...activeDeadlines) : 0;
  const jobBudgetMs = jobDeadlineAt ? Math.max(0, jobDeadlineAt - Date.now()) : computedBudgetMs;

  const chain = await resolveFallbackChain({ providerId, model });
  const primary = chain[0];
  const providerFallbacks = [];

  const cacheParams = {
    videoId: transcript.videoId || `inline:${hashString(transcript.meta.videoTitle || 'inline')}`,
    // A cached summary belongs to one exact transcript version. Without this,
    // a re-fetched caption track could serve word counts from another text.
    transcriptHash,
    mode: 'ai',
    lang: transcript.meta.lang,
    providerId: primary.provider.id,
    model: primary.model,
    variant: aiVariant(settings),
  };

  if (settings.cache.enabled && settings.ai.useCache && !input.force) {
    const cached = await getCached(cacheParams);
    if (cached) {
      onEvent({ type: EV.STAGE, stage: 'cache', message: 'Найдено в кэше' });
      return {
        result: cached.summary,
        cached: true,
        provider: primary.provider,
        model: primary.model,
        transcriptMeta: transcript.meta,
        usage: cached.summary?.stats || {},
        warnings: [],
        strategy: cached.summary?.meta?.strategy || 'cache',
      };
    }
  }

  let lastError = null;
  // Consumed by the first provider only: a fallback provider cannot reuse a job
  // that was fingerprinted for another provider/model.
  let requestedResume = String(resumeJobId || '');
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    const isLast = i === chain.length - 1;
    const started = Date.now();
    let job = null;
    let savedIndexes = new Set();
    if (jobDeadlineAt && Date.now() >= jobDeadlineAt) throw jobDeadlineError(jobBudgetMs);
    try {
      const fingerprint = fingerprintFor({
        transcriptHash,
        settings,
        provider: candidate.provider,
        model: candidate.model,
        uiLang,
      });
      let resumable = null;
      if (requestedResume) {
        const wanted = await getJob(requestedResume);
        if (!wanted) throw resumeMismatchError('resume-missing');
        if (wanted.status === 'running' && wanted.taskId && activeTaskIds.has(wanted.taskId)) {
          throw resumeBusyError();
        }
        // Everything that defines the saved notes must still be identical.
        const compatible =
          wanted.fingerprint === fingerprint &&
          (wanted.transcriptHash || '') === transcriptHash &&
          Number(wanted.promptVersion) === PROMPT_VERSION &&
          wanted.appVersion === APP.version &&
          (wanted.videoId || '') === videoId;
        if (!compatible) throw resumeMismatchError();
        const claim = await claimJob(wanted.id, { taskId });
        if (!claim.ok) {
          if (claim.reason === 'running') throw resumeBusyError();
          if (claim.reason === 'missing') throw resumeMismatchError('resume-missing');
          throw resumeMismatchError(`resume-${claim.reason}`);
        }
        resumable = claim.job;
        job = claim.job;
        // Only the first provider attempt may use the explicitly chosen job.
        requestedResume = '';
      } else {
        resumable = await findResumableJob({ videoId, fingerprint });
        if (resumable) job = await setJobStatus(resumable.id, 'running', { taskId });
      }
      const saved = resumable ? resumablePartials(resumable) : {};
      const savedReduce = resumable ? resumableReduceNotes(resumable) : {};
      savedIndexes = new Set(Object.keys(saved).map(Number));
      if (resumable) {
        const count = Object.keys(saved).length;
        if (count) {
          onEvent({
            type: EV.STAGE,
            stage: 'resume',
            message: `Возобновляю прерванный запуск: ${count} фрагмент(ов) уже готовы`,
            resumed: count,
          });
        }
      } else {
        job = await createJob({
          // One durable job per provider attempt: reusing `taskId` for the
          // fallback would overwrite the previous provider's saved fragments.
          id: taskId ? `${taskId}-${i + 1}` : '',
          videoId,
          videoTitle: transcript.meta.videoTitle || '',
          fingerprint,
          transcriptHash,
          promptVersion: PROMPT_VERSION,
          appVersion: APP.version,
          providerId: candidate.provider.id,
          model: candidate.model,
          strategy: settings.ai.strategy,
          taskId,
        });
      }
      onEvent({
        type: EV.STAGE,
        stage: 'provider',
        message: chain.length > 1 ? `Провайдер ${i + 1}/${chain.length}: ${candidate.provider.name}` : `Провайдер: ${candidate.provider.name}`,
        provider: candidate.provider.name,
        model: candidate.model,
      });
      const { result, strategy, usage, warnings, complete, diagnostics } = await runAiSummary({
        segments: transcript.segments,
        meta: transcript.meta,
        provider: candidate.provider,
        apiKey: candidate.apiKey,
        model: candidate.model,
        aiSettings: settings.ai,
        output: settings.output,
        uiLang,
        onProgress: (event) => onEvent({ type: EV.PROGRESS, ...event }),
        // Raw deltas are not forwarded: the panel shows validated `stream-item`
        // events instead, and copying the whole growing answer into every port
        // message was O(n²) traffic for text nobody rendered.
        onDelta: undefined,
        signal,
        // The pipeline owns its budget and may extend it once for a definitive
        // CONTEXT_LENGTH; the caller's own ceiling is the only hard cap. Across
        // providers the remaining chain time is passed as the next budget, so a
        // switch never restarts the clock.
        deadlineAt: parentDeadlineAt,
        budgetMs: jobDeadlineAt
          ? Math.min(computedBudgetMs, Math.max(0, jobDeadlineAt - Date.now()))
          : computedBudgetMs,
        resumePartials: saved,
        resumeReduce: savedReduce,
        onReduceState: (state) => (job ? recordReduceNote(job.id, state) : null),
        onChunkState: (state) => {
          if (state?.status === 'succeeded') savedIndexes.add(Number(state.index));
          return job ? recordChunk(job.id, state) : null;
        },
        chunkCache: {
          get: (key) => (settings.ai.chunkCache === false ? null : getAiChunk(key)),
          put: (key, partial) => (settings.ai.chunkCache === false ? null : putAiChunk(key, partial)),
        },
      });
      const latency = Date.now() - started;
      // A run that lost fragments is not finished: keep its notes resumable so
      // the next attempt only pays for the missing parts. It is also never
      // cached and never presented as a complete summary.
      if (job) {
        await setJobStatus(job.id, complete === false ? 'interrupted' : 'done', {
          strategy,
          reason: complete === false ? diagnostics?.finishReason || 'incomplete' : '',
        });
      }
      await trackUsage(candidate.provider.id, {
        ok: true,
        ms: latency,
        chunks: usage.calls || 1,
        tokensIn: usage.promptTokens || 0,
        tokensOut: usage.completionTokens || 0,
      });
      if (diagnostics) {
        if (providerFallbacks.length) {
          diagnostics.fallbacks = [...(diagnostics.fallbacks || []), ...providerFallbacks].slice(0, 30);
        }
        diagnostics.providerAttempts = i + 1;
        diagnostics.providerSwitches = providerFallbacks.length;
        diagnostics.lastFallback = providerFallbacks.length
          ? providerFallbacks[providerFallbacks.length - 1]
          : diagnostics.lastFallback || '';
        diagnostics.budgetMs = diagnostics.budgetMs || jobBudgetMs;
        diagnostics.deadlineAt = diagnostics.deadlineAt || jobDeadlineAt;
        // The pipeline may have extended the job for a CONTEXT_LENGTH fallback:
        // the remaining time must be measured from its deadline, not the first
        // plan's (now stale) one.
        diagnostics.remainingMs = diagnostics.deadlineAt
          ? Math.max(0, diagnostics.deadlineAt - Date.now())
          : 0;
        diagnostics.complete = complete !== false;
        diagnostics.finishReason = diagnostics.finishReason || (complete === false ? 'incomplete' : 'success');
        diagnostics.resumable = complete === false;
        diagnostics.cancelled = false;
      }
      result.meta = {
        ...(result.meta || {}),
        providerId: candidate.provider.id,
        providerName: candidate.provider.name,
        latencyMs: latency,
        strategy,
        complete: complete !== false,
        diagnostics: diagnostics || null,
      };
      result.provider = candidate.provider.name;
      result.model = candidate.model;
      // Operational warnings (retries, budget escalation, provider switches)
      // belong to the run diagnostics, not to the exported summary body. The
      // panel showed them as progress events; the diagnostics card keeps them.
      if (diagnostics) diagnostics.warnings = warnings.slice(0, 10);
      result.notes = Array.from(new Set(result.notes || []));

      // An incomplete run must not be cached: a later attempt with a working
      // provider has to be able to fill the missing fragments instead of
      // serving the partial result for the whole TTL.
      result.stats = { ...(result.stats || {}), transcriptHash };
      if (settings.cache.enabled && complete !== false) {
        await putCached(cacheParams, result, {
          title: result.videoTitle || transcript.meta.videoTitle,
          channel: result.channel || transcript.meta.channel,
          lengthSeconds: result.lengthSeconds || transcript.meta.lengthSeconds,
        });
      }
      await addHistory({
        videoId: result.videoId,
        mode: 'ai',
        title: result.videoTitle,
        channel: result.channel,
        lengthSeconds: result.lengthSeconds,
        lang: result.lang,
        providerId: candidate.provider.id,
        model: candidate.model,
      });
      return { result, strategy, usage, warnings, provider: candidate.provider, model: candidate.model, transcriptMeta: transcript.meta, cached: false };
    } catch (err) {
      lastError = err;
      const canResume = savedIndexes.size > 0 || err?.resumable === true;
      if (job) {
        const finishReason = err?.finishReason || (err?.code === 'TIMEOUT' ? 'call-timeout' : '');
        await setJobStatus(job.id, signal?.aborted ? 'cancelled' : canResume ? 'interrupted' : 'failed', {
          error: err?.message || String(err),
          // Cancellation is not a resumable interruption: the reason is kept
          // for diagnostics, but the job status already says `cancelled`.
          reason: signal?.aborted ? '' : finishReason,
        }).catch(() => null);
      }
      await trackUsage(candidate.provider.id, { ok: false, ms: Date.now() - started, error: err?.message || String(err) });
      err.budgetMs = err.budgetMs || jobBudgetMs;
      err.deadlineAt = err.deadlineAt || jobDeadlineAt;
      err.remainingMs = jobDeadlineAt ? Math.max(0, jobDeadlineAt - Date.now()) : 0;
      err.resumable = canResume;
      err.finishReason = err.finishReason
        || (err.detail === 'job-deadline'
          ? 'job-timeout'
          : err.code === 'TIMEOUT'
            ? 'call-timeout'
            : err.code === 'RATE_LIMIT'
              ? 'quota'
              : 'provider-error');
      const code = err?.code || 'UNKNOWN';
      if (signal?.aborted) throw err;
      // An expired job budget is final: switching providers would silently
      // extend an operation the user was promised a ceiling for.
      if (err?.detail === 'job-deadline') throw err;
      if (jobDeadlineAt && Date.now() >= jobDeadlineAt) throw jobDeadlineError(jobBudgetMs);
      if (isLast || NO_FALLBACK.has(code)) throw err;
      // A call-level timeout is worth another provider only when the job still
      // has time for a real attempt. The old unconditional stop avoided
      // repeating the same long wait; refusing to switch at all left the run
      // dead while a second key sat unused.
      if (
        code === 'TIMEOUT' &&
        (err?.detail === 'job-deadline' || !jobDeadlineAt || jobDeadlineAt - Date.now() < TIMEOUT_FALLBACK_MIN_MS)
      ) {
        throw err;
      }
      providerFallbacks.push(`${candidate.provider.name}: ${code} — ${String(err?.message || '').slice(0, 120)}`);
      onEvent({
        type: EV.STAGE,
        stage: 'fallback',
        message: `${candidate.provider.name}: ${err.message}. Пробую следующий провайдер…`,
        warning: true,
      });
    }
  }
  throw lastError || new Error('Не удалось получить конспект');
}

export async function runAiAskTask({ input = {}, question, providerId, model, settings: providedSettings, onEvent = () => {}, signal, deadlineAt = 0 } = {}) {
  const settings = providedSettings || (await getSettings());
  const transcript = await ensureTranscript(input);
  const uiLang = uiLangFor(settings, transcript.meta.lang);
  const chain = await resolveFallbackChain({ providerId, model });
  // One call budget for the whole Q&A operation, shared across providers.
  const askBudgetMs = operationBudgetMs(settings.ai?.timeoutMs || 120000);
  const ownAskDeadlineAt = askBudgetMs > 0 ? Date.now() + askBudgetMs : 0;
  const parentAskDeadlineAt = Number(deadlineAt) > 0 ? Number(deadlineAt) : 0;
  const activeAskDeadlines = [ownAskDeadlineAt, parentAskDeadlineAt].filter((v) => v > 0);
  const askDeadlineAt = activeAskDeadlines.length ? Math.min(...activeAskDeadlines) : 0;
  let lastError = null;
  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    if (askDeadlineAt && Date.now() >= askDeadlineAt) throw jobDeadlineError(askBudgetMs);
    try {
      const res = await runAiAsk({
        question,
        segments: transcript.segments,
        meta: transcript.meta,
        provider: candidate.provider,
        apiKey: candidate.apiKey,
        model: candidate.model,
        aiSettings: { ...settings.ai, maxOutputTokens: Math.min(1200, settings.ai.maxOutputTokens) },
        output: settings.output,
        uiLang,
        onProgress: (event) => onEvent({ type: EV.PROGRESS, ...event }),
        signal,
        deadlineAt: askDeadlineAt,
      });
      await trackUsage(candidate.provider.id, { ok: true, ms: res.latencyMs || 0, chunks: 1, tokensIn: res.usage.promptTokens, tokensOut: res.usage.completionTokens });
      return { ...res, provider: candidate.provider.name, model: candidate.model, transcriptMeta: transcript.meta };
    } catch (err) {
      lastError = err;
      await trackUsage(candidate.provider.id, { ok: false, ms: 0, error: err?.message || String(err) });
      const code = err?.code || 'UNKNOWN';
      err.budgetMs = err.budgetMs || askBudgetMs;
      err.deadlineAt = err.deadlineAt || askDeadlineAt;
      err.remainingMs = askDeadlineAt ? Math.max(0, askDeadlineAt - Date.now()) : 0;
      if (signal?.aborted || err?.detail === 'job-deadline' || (askDeadlineAt && Date.now() >= askDeadlineAt)) throw err;
      if (i === chain.length - 1 || NO_FALLBACK.has(code)) throw err;
    }
  }
  throw lastError || new Error('Не удалось получить ответ');
}

/* --------------------------------------------------------------- port bridge */

export function registerTaskPort(port) {
  const controllers = new Map();

  const send = (payload) => {
    try {
      port.postMessage(payload);
    } catch {
      /* port closed */
    }
  };

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === PORT_MSG.KEEPALIVE) {
      send({ type: EV.PONG, at: Date.now() });
      return;
    }
    if (msg.type === PORT_MSG.CANCEL) {
      const controller = controllers.get(msg.taskId);
      if (controller) controller.abort(new Error('cancelled'));
      return;
    }

    const isSummary = msg.type === PORT_MSG.SUMMARY;
    const isAsk = msg.type === PORT_MSG.ASK;
    if (!isSummary && !isAsk) return;

    const taskId = msg.taskId || `${Date.now()}`;
    if (controllers.has(taskId)) return;
    const controller = new AbortController();
    controllers.set(taskId, controller);
    activeTaskIds.add(taskId);
    send({ type: EV.READY, taskId });

    try {
      const common = {
        input: msg.input || msg,
        providerId: msg.providerId,
        model: msg.model,
        taskId,
        onEvent: (event) => send({ ...event, taskId }),
        signal: controller.signal,
        deadlineAt: Number(msg.deadlineAt) > 0 ? Number(msg.deadlineAt) : 0,
        resumeJobId: msg.resumeJobId || '',
      };
      const result = isSummary
        ? await runAiSummaryTask(common)
        : await runAiAskTask({ ...common, question: msg.question });
      send({ type: EV.RESULT, taskId, ...result });
    } catch (err) {
      if (controller.signal.aborted) {
        send({
          type: EV.ERROR,
          taskId,
          cancelled: true,
          code: 'CANCELLED',
          message: 'Задача отменена',
          finishReason: 'cancelled',
          budgetMs: err?.budgetMs || 0,
          deadlineAt: err?.deadlineAt || 0,
          remainingMs: err?.remainingMs != null ? err.remainingMs : 0,
        });
      } else {
        send({
          type: EV.ERROR,
          taskId,
          code: err?.code || 'UNKNOWN',
          message: err?.message || String(err),
          hint: err?.hint || '',
          provider: err?.provider || '',
          status: err?.status || 0,
          detail: err?.detail || '',
          resumable: !!err?.resumable,
          finishReason: err?.finishReason || '',
          budgetMs: err?.budgetMs || 0,
          deadlineAt: err?.deadlineAt || 0,
          remainingMs: err?.remainingMs || 0,
        });
      }
    } finally {
      controllers.delete(taskId);
      activeTaskIds.delete(taskId);
      send({ type: EV.DONE, taskId });
    }
  });

  port.onDisconnect.addListener(() => {
    for (const controller of controllers.values()) controller.abort(new Error('port-disconnected'));
    controllers.clear();
  });
}

export function openTaskPort() {
  return ext.runtime.connect({ name: PORT.TASK });
}
