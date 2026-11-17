/**
 * Durable state for long AI summaries.
 *
 * Manifest V3 may terminate the service worker at any moment — including while
 * a `fetch` waits for the model. Chunk results are written to extension storage
 * as soon as each one succeeds, and the job state is marked `interrupted` on
 * the next worker start. A later run with the same transcript, prompt revision
 * and settings resumes from those saved notes instead of paying for them again.
 *
 * No transcript text, prompt or API key is stored here: only chunk ranges,
 * statuses and the compact map notes (points/topics/facts).
 */

import { STORAGE } from '../common/constants.js';
import { getLocal, setLocal, removeLocal } from '../common/compat.js';
import { hashString, nowIso } from '../common/util.js';

const MAX_JOBS = 12;
const JOB_TTL_MS = 24 * 3600 * 1000;
/** A `running` record older than this is stale (the worker died mid-flight). */
const STALE_RUNNING_MS = 30 * 1000;

let writeChain = Promise.resolve();

/** Serialises read-modify-write cycles: map chunks settle in parallel. */
function mutate(work) {
  const next = writeChain.then(work, work);
  writeChain = next.catch(() => {});
  return next;
}

async function readJobs() {
  const data = await getLocal(STORAGE.jobs, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function prune(store) {
  const now = Date.now();
  for (const [id, job] of Object.entries(store)) {
    const at = Date.parse(job.updatedAt || job.createdAt || 0) || 0;
    if (!at || now - at > JOB_TTL_MS) delete store[id];
  }
  const ids = Object.keys(store);
  if (ids.length > MAX_JOBS) {
    ids
      .map((id) => [id, Date.parse(store[id].updatedAt || store[id].createdAt || 0) || 0])
      .sort((a, b) => a[1] - b[1])
      .slice(0, ids.length - MAX_JOBS)
      .forEach(([id]) => delete store[id]);
  }
  return store;
}

async function writeJobs(store) {
  await setLocal(STORAGE.jobs, prune(store));
}

/**
 * Stable identity of “what was asked”: a changed transcript, prompt revision,
 * model, provider or output settings must never resume an old run.
 */
export function jobFingerprint({ transcriptHash, promptVersion, appVersion, ai = {}, output = {}, providerId = '', model = '', uiLang = '' }) {
  return hashString(
    JSON.stringify([
      transcriptHash || '',
      promptVersion,
      appVersion,
      ai.contextTokens,
      ai.chunkTokens,
      ai.strategy,
      ai.systemPromptOverride,
      ai.temperature,
      ai.maxOutputTokens,
      output.length,
      output.tone,
      output.language,
      output.customInstructions,
      providerId,
      model,
      uiLang,
    ]),
  );
}

export function transcriptFingerprint(segments = []) {
  return hashString(
    (segments || [])
      .map((s) => `${Number(s.start) || 0}|${String(s.text || '').trim()}`)
      .join('\n'),
  );
}

export async function createJob({
  id,
  videoId = '',
  videoTitle = '',
  fingerprint = '',
  transcriptHash = '',
  promptVersion = 0,
  appVersion = '',
  providerId = '',
  model = '',
  strategy = 'auto',
  taskId = '',
}) {
  const job = {
    id: String(id || `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    videoId,
    videoTitle,
    fingerprint,
    transcriptHash,
    promptVersion,
    appVersion,
    providerId,
    model,
    requestedStrategy: strategy,
    strategy: '',
    status: 'running',
    taskId: taskId || '',
    chunks: [],
    partials: {},
    // Intermediate reduce notes, keyed by a hash of the group they were built
    // from. A continuation reuses them instead of paying for the same batches.
    reduceNotes: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await mutate(async () => {
    const store = await readJobs();
    store[job.id] = job;
    await writeJobs(store);
  });
  return job;
}

export async function getJob(id) {
  if (!id) return null;
  const store = await readJobs();
  return store[id] || null;
}

export async function listJobs() {
  const store = await readJobs();
  return Object.values(store).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * Finds a job worth resuming for exactly this request. A finished, failed or
 * cancelled job is never reused; a stale `running` record (worker died before
 * recovery ran) is treated as interrupted.
 */
export async function findResumableJob({ videoId = '', fingerprint = '' }) {
  const jobs = await listJobs();
  const now = Date.now();
  return (
    jobs.find((job) => {
      if (!job || job.fingerprint !== fingerprint) return false;
      if (videoId && job.videoId !== videoId) return false;
      if (job.status === 'interrupted') return true;
      if (job.status !== 'running') return false;
      const at = Date.parse(job.updatedAt || job.createdAt || 0) || 0;
      return now - at > STALE_RUNNING_MS;
    }) || null
  );
}

/**
 * Compact view of a saved job for the panel. It carries no transcript text,
 * prompt or credential: only counts, timestamps and the saved reason.
 */
export function jobResumeInfo(job) {
  if (!job) return null;
  const chunks = Array.isArray(job.chunks) ? job.chunks : [];
  const saved = Object.keys(job.partials || {}).length;
  return {
    id: job.id,
    videoId: job.videoId || '',
    videoTitle: job.videoTitle || '',
    status: job.status || '',
    strategy: job.strategy || job.requestedStrategy || '',
    savedChunks: saved,
    doneChunks: chunks.filter((c) => c && c.status === 'succeeded').length,
    failedChunks: chunks.filter((c) => c && c.status !== 'succeeded').length,
    totalChunks: chunks.length,
    interruptionReason: job.interruptionReason || '',
    error: job.error || '',
    createdAt: job.createdAt || '',
    updatedAt: job.updatedAt || '',
  };
}

/**
 * Atomically turns `interrupted` into `running`. Two clicks on “Продолжить”
 * must not start the same saved job twice: only the first claim wins.
 * @returns {Promise<{ok: boolean, job?: object, reason?: string}>}
 */
export function claimJob(jobId, { taskId = '' } = {}) {
  return mutate(async () => {
    const store = await readJobs();
    const job = store[jobId];
    if (!job) return { ok: false, reason: 'missing' };
    const at = Date.parse(job.updatedAt || job.createdAt || 0) || 0;
    const stale = job.status === 'running' && Date.now() - at > STALE_RUNNING_MS;
    if (job.status !== 'interrupted' && !stale) return { ok: false, reason: job.status || 'not-resumable' };
    job.status = 'running';
    if (taskId) job.taskId = taskId;
    job.error = '';
    job.updatedAt = nowIso();
    // The previous reason is kept in `lastInterruptionReason` for the panel: an
    // explicit resume does not erase why the run stopped.
    if (job.interruptionReason) job.lastInterruptionReason = job.interruptionReason;
    await writeJobs(store);
    return { ok: true, job };
  });
}

/** Intermediate reduce notes that survived a restart, keyed by group hash. */
export function resumableReduceNotes(job) {
  const out = {};
  if (!job || !job.reduceNotes) return out;
  for (const [key, text] of Object.entries(job.reduceNotes)) {
    if (typeof text === 'string' && text) out[key] = text;
  }
  return out;
}

/** Records one successful intermediate reduce group as soon as it settles. */
export function recordReduceNote(jobId, { key = '', text = '' } = {}) {
  const id = String(key || '');
  const value = String(text || '');
  if (!id || !value) return null;
  return mutate(async () => {
    const store = await readJobs();
    const job = store[jobId];
    if (!job) return null;
    job.reduceNotes = job.reduceNotes && typeof job.reduceNotes === 'object' ? job.reduceNotes : {};
    job.reduceNotes[id] = value;
    // A bound on storage: the final rounds supersede the earlier ones, and a
    // resumed job needs only the groups it may recompute next time.
    const keys = Object.keys(job.reduceNotes);
    for (const stale of keys.slice(0, Math.max(0, keys.length - 24))) delete job.reduceNotes[stale];
    job.updatedAt = nowIso();
    await writeJobs(store);
    return job;
  });
}

/** Chunk notes that survived a restart, keyed by chunk index. */
export function resumablePartials(job) {
  const out = {};
  if (!job || !job.partials) return out;
  for (const [index, partial] of Object.entries(job.partials)) {
    if (partial && typeof partial === 'object') out[Number(index)] = partial;
  }
  return out;
}

/**
 * Records one chunk as soon as it settles. Success also stores the compact note
 * itself, so resuming does not depend on the global chunk cache still having it.
 */
export function recordChunk(jobId, { index, startAt = 0, endAt = 0, status, reason = '', key = '', partial = null, cached = false, resumed = false }) {
  return mutate(async () => {
    const store = await readJobs();
    const job = store[jobId];
    if (!job) return null;
    job.chunks = Array.isArray(job.chunks) ? job.chunks : [];
    job.partials = job.partials && typeof job.partials === 'object' ? job.partials : {};
    const entry = {
      index: Number(index) || 0,
      startAt: Number(startAt) || 0,
      endAt: Number(endAt) || 0,
      status: status || 'failed',
      reason: reason || '',
      key: key || '',
      cached: !!cached,
      resumed: !!resumed,
      at: nowIso(),
    };
    const at = job.chunks.findIndex((c) => c && c.index === entry.index);
    if (at === -1) job.chunks.push(entry);
    else job.chunks[at] = entry;
    if (entry.status === 'succeeded' && partial) job.partials[entry.index] = partial;
    else if (entry.status !== 'succeeded') delete job.partials[entry.index];
    job.updatedAt = nowIso();
    await writeJobs(store);
    return job;
  });
}

export function setJobStatus(jobId, status, { strategy = '', error = '', reason = '', taskId = '' } = {}) {
  return mutate(async () => {
    const store = await readJobs();
    const job = store[jobId];
    if (!job) return null;
    job.status = status;
    if (strategy) job.strategy = strategy;
    if (error) job.error = String(error).slice(0, 300);
    if (reason) job.interruptionReason = String(reason).slice(0, 80);
    if (taskId) job.taskId = taskId;
    job.updatedAt = nowIso();
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      // The final summary lives in the summary cache; notes are only needed for
      // resuming an unfinished run.
      job.partials = {};
      job.reduceNotes = {};
    }
    await writeJobs(store);
    return job;
  });
}

/**
 * Called on every service-worker start. Jobs that were still `running` lost
 * their in-memory task; they become `interrupted` and keep their chunk notes
 * for the next explicit run. Nothing is restarted automatically: that would
 * spend quota without the user asking.
 */
export function recoverInterruptedJobs() {
  return mutate(async () => {
    const store = await readJobs();
    let recovered = 0;
    for (const job of Object.values(store)) {
      if (job && job.status === 'running') {
        job.status = 'interrupted';
        // The reason is user-facing: “the browser stopped the worker” is not
        // the same as “the model timed out”.
        job.interruptionReason = job.interruptionReason || 'worker-restart';
        job.updatedAt = nowIso();
        recovered++;
      }
    }
    await writeJobs(store);
    return recovered;
  });
}

export async function clearJobs() {
  await removeLocal(STORAGE.jobs);
}

/** Test helper: drops the in-module write queue between storage resets. */
export function __resetJobQueue() {
  writeChain = Promise.resolve();
}
