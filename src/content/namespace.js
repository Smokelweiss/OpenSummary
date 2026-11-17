/**
 * Shared namespace for OpenSummary content scripts.
 * Content scripts cannot use ES modules, so every file attaches to window.OSUM.
 */

(function () {
  const OSUM = (window.OSUM = window.OSUM || {});
  OSUM.version = '1.6.4';
  OSUM.appName = 'OpenSummary';
  OSUM.constants = OSUM.constants || {};
  OSUM.state = OSUM.state || {
    panelOpen: false,
    tab: 'overview',
    result: null,
    resultKey: '',
    transcript: null,
    transcriptMeta: null,
    settings: null,
    providers: [],
    providerId: '',
    model: '',
    lang: 'auto',
    length: 'standard',
    status: 'idle',
    error: null,
    // Set when the AI run failed and the panel showed a local summary instead.
    fallback: null,
    running: false,
    streamingText: '',
    // Live/final AI diagnostics (deadline, stage, retries, finish reason).
    aiDiagnostics: null,
    // Compatible interrupted job offered through the “Продолжить” button.
    resumableJob: null,
    qaHistory: [],
    videoId: '',
    theme: 'auto',
    // The quick-settings dropdown (mode, provider, model, language, length).
    // Closed by default: those are decisions made once, not per video.
    quickSettingsOpen: false,
  };
  OSUM.register = function register(name, value) {
    OSUM[name] = value;
    return value;
  };
})();
