/**
 * Shared constants: message types, storage keys, defaults, limits.
 * Used by the service worker (ES modules) and, where needed, duplicated
 * conceptually in content scripts (classic scripts, no imports).
 */

export const APP = {
  id: 'opensummary',
  name: 'OpenSummary',
  version: '1.6.4',
  repo: 'https://github.com/opensummary/opensummary',
};

/** Message types for runtime.sendMessage (request/response). */
export const MSG = {
  PING: 'ping',
  GET_STATE: 'get-state',
  GET_VIDEO_DATA: 'get-video-data',
  GET_TRANSCRIPT: 'get-transcript',
  /** Offline retrieval over the transcript (Q&A fallback, no model). */
  LOCAL_ASK: 'local-ask',
  AI_SUMMARY: 'ai-summary',
  AI_ASK: 'ai-ask',
  LIST_MODELS: 'list-models',
  TEST_PROVIDER: 'test-provider',
  GET_CACHE: 'get-cache',
  PUT_CACHE: 'put-cache',
  CLEAR_CACHE: 'clear-cache',
  CACHE_STATS: 'cache-stats',
  GET_HISTORY: 'get-history',
  CLEAR_HISTORY: 'clear-history',
  EXPORT_DATA: 'export-data',
  IMPORT_DATA: 'import-data',
  SAVE_SETTINGS: 'save-settings',
  SAVE_PROVIDERS: 'save-providers',
  SAVE_KEY: 'save-key',
  DELETE_PROVIDER: 'delete-provider',
  DOWNLOAD: 'download',
  OPEN_OPTIONS: 'open-options',
  OPEN_PANEL: 'open-panel',
  INJECT_CONTENT: 'inject-content',
  /** Runs page-bridge.js inside the page world (no page CSP applies there). */
  INJECT_PAGE_BRIDGE: 'inject-page-bridge',
  REQUEST_HOST_ACCESS: 'request-host-access',
  EXPORT_MD: 'export-md',
  JOURNAL: 'journal',
  GET_JOURNAL: 'get-journal',
  RESUME_INFO: 'get-resumable',
  PARSE_TRANSCRIPT: 'parse-transcript',
  WIPE_ALL: 'wipe-all',
};

/** Port names. */
export const PORT = {
  TASK: 'osum-task',
};

/**
 * Client → worker messages on the task port. Content scripts hardcode the same
 * strings (`tools/check.mjs` validates them against this table).
 */
export const PORT_MSG = {
  SUMMARY: 'ai-summary',
  ASK: 'ai-ask',
  KEEPALIVE: 'keepalive',
  CANCEL: 'cancel',
};

/** Progress event types sent over the task port. */
export const EV = {
  READY: 'ready',
  STAGE: 'stage',
  PROGRESS: 'progress',
  DELTA: 'delta',
  RESULT: 'result',
  ERROR: 'error',
  DONE: 'done',
  PONG: 'pong',
};

export const STORAGE = {
  settings: 'osum:settings',
  providers: 'osum:providers',
  keys: 'osum:keys',
  sessionKeys: 'osum:session-keys',
  cache: 'osum:cache',
  // Intermediate map-reduce notes, keyed by chunk text + prompt revision.
  aiChunks: 'osum:ai-chunks',
  // Durable AI job state (strategy, chunk statuses, saved notes).
  jobs: 'osum:jobs',
  history: 'osum:history',
  usage: 'osum:usage',
};

export const DEFAULT_SETTINGS = {
  schema: 1,
  ui: {
    lang: 'auto',
    // Light by default: the panel is a document to read, and a white sheet is
    // easier to read for longer than a dark one for most people. The sun/moon
    // button in the header (or this setting) switches it.
    theme: 'light',
    showFab: true,
    docked: true,
    autoOpenPanel: false,
    autoSummarize: false,
    panelWidth: 420,
    showBadge: true,
  },
  output: {
    language: 'auto',
    length: 'standard',
    tone: 'neutral',
    includeTimestamps: true,
    // Off by default: “вопросы для самопроверки” is a study feature, not part
    // of a summary a viewer reads once. Enabling it adds the block back.
    selfCheck: false,
    customInstructions: '',
    markdown: true,
  },
  /** Offline retrieval (Q&A over the transcript) keeps the sentence filters. */
  local: {
    minSentenceWords: 4,
    maxSentenceWords: 45,
    filterFillers: true,
  },
  ai: {
    providerId: '',
    model: '',
    fallbackEnabled: true,
    temperature: 0.3,
    // A standard конспект по схеме не влезает в 2500 токенов: ответ обрезался,
    // «починка» JSON возвращала пустые поля, и пользователь видел пустой экран
    // после нескольких минут ожидания.
    maxOutputTokens: 4096,
    // Fallback segmentation for transcripts that do not fit one request.
    // 6000 keeps a 3.5-hour video near a dozen requests instead of twenty.
    chunkTokens: 6000,
    // Conservative safe budget for one direct request. openrouter/free
    // advertises a 200k window; prompt, schema and the answer reserve take the
    // rest, so 128k is the number the pipeline actually plans with.
    contextTokens: 128000,
    // Chunks are independent, so they go out in parallel; 6 is safe for most
    // endpoints and halves itself automatically on a rate limit.
    concurrency: 6,
    strategy: 'auto',
    // Whole recording (one request or map-reduce) by default. “timeline”
    // summarises each timecode block on its own, like Yandex's summary.
    summaryMode: 'whole',
    retries: 1,
    // Same as the pipeline's own default: 90 s is a generous single request,
    // and a stalled attempt no longer eats three minutes twice — the stream
    // watchdog aborts a silently hung answer much earlier (client.js).
    timeoutMs: 90000,
    stream: true,
    systemPromptOverride: '',
    useCache: true,
    // Reuse per-fragment notes across runs of the same video/model/prompt.
    chunkCache: true,
  },
  cache: {
    enabled: true,
    ttlDays: 30,
    historyLimit: 300,
  },
  advanced: {
    keyStorage: 'local',
    debug: false,
    preferManualCaptions: true,
    keepTranscriptInMemory: true,
    requestTimeoutMs: 20000,
  },
};

export const LIMITS = {
  maxTranscriptChars: 900000,
  maxChunks: 24,
  maxQuestionChars: 500,
  maxCustomInstructions: 2000,
  maxHistory: 500,
  maxSections: 14,
  portKeepAliveMs: 15000,
};

export const CACHE_PREFIX = 'osum:cache:';
