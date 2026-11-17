/**
 * Content-script bootstrap: reacts to SPA navigation, background commands and
 * keeps the panel in sync with the current video.
 */

(function () {
  // A second injection (the popup asking for a content script the tab already
  // had, or a race while the page was still loading) used to register a second
  // set of listeners and a second panel host. The orphaned copy then answered
  // clicks on its own stale state, which looked like “the button does nothing”.
  if (window.__osumBooted) return;
  window.__osumBooted = true;

  const OSUM = window.OSUM;
  const { util } = OSUM;

  let lastVideoId = '';
  let navigatedAt = 0;

  /* ------------------------------------------------------------------ messages */

  // Background probes for presence with this message before injecting.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (message.type === 'osum:ping') {
      sendResponse({ ok: true, version: OSUM.version, videoId: util.getVideoId() });
      return false;
    }
    if (message.type === 'osum:command') {
      handleCommand(message).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === 'osum:settings-changed') {
      util.readSettings().then((settings) => {
        OSUM.state.settings = settings;
        OSUM.i18n.refresh();
        if (OSUM.panel?.isOpen?.()) OSUM.panel.render();
      });
      return false;
    }
    return false;
  });

  async function handleCommand(message) {
    const action = message.action || 'open';
    if (action === 'close') {
      OSUM.panel?.close?.();
      return;
    }
    if (action === 'toggle') {
      if (OSUM.panel?.isOpen?.()) {
        OSUM.panel.close();
      } else {
        await OSUM.panel.open({ autoRun: false });
      }
      return;
    }
    if (action === 'open' || action === 'summarize') {
      await OSUM.panel.open({ autoRun: message.autoRun === true || action === 'summarize' });
    }
  }

  /* ---------------------------------------------------------------- navigation */

  function isWatchPage() {
    const url = location.href;
    return /youtube\.com\/(watch|shorts|live|embed)/.test(url) && !!util.getVideoId();
  }

  function onNavigate({ force = false } = {}) {
    const videoId = util.getVideoId();
    if (!videoId || !isWatchPage()) {
      // Not a video page: hide the panel but keep it mounted.
      if (OSUM.panel?.isOpen?.()) OSUM.panel.close();
      if (OSUM.state.fabMounted) OSUM.panel?.refs?.().fab?.setAttribute('hidden', 'hidden');
      lastVideoId = '';
      return;
    }
    const now = Date.now();
    if (!force && now - navigatedAt < 400 && videoId === lastVideoId) return;
    navigatedAt = now;
    lastVideoId = videoId;

    OSUM.panel.mount();
    // YouTube rebuilds the sidebar column on navigation; re-attach a docked panel.
    if (OSUM.panel.isOpen?.()) OSUM.panel.attach?.();
    OSUM.panel.setVideoId(videoId);
    const settings = OSUM.state.settings || {};
    if (settings.ui?.showFab !== false) {
      const fab = OSUM.panel.refs?.().fab;
      if (fab && !OSUM.state.panelOpen) fab.removeAttribute('hidden');
      OSUM.state.fabMounted = true;
    }
    if (settings.ui?.autoOpenPanel) OSUM.panel.open({ autoRun: !!settings.ui.autoSummarize });
  }

  // YouTube fires this for both initial load and in-app navigation.
  document.addEventListener('yt-navigate-finish', () => onNavigate(), true);
  document.addEventListener('yt-page-data-updated', () => onNavigate(), true);

  // Fallback for browsers/paths where the event does not fire.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate();
    }
  }, 1200);

  /* ------------------------------------------------------------------- theme */

  function watchTheme() {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      if (!OSUM.state.panelOpen) return;
      const refs = OSUM.panel.refs?.();
      if (refs?.root) {
        const mode = OSUM.state.settings?.ui?.theme || 'auto';
        if (mode === 'auto') refs.root.dataset.theme = util.isDarkTheme() ? 'dark' : 'light';
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ['dark', 'class', 'style'] });
    window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => {
      if ((OSUM.state.settings?.ui?.theme || 'auto') === 'auto' && OSUM.state.panelOpen) {
        const refs = OSUM.panel.refs?.();
        if (refs?.root) refs.root.dataset.theme = util.isDarkTheme() ? 'dark' : 'light';
      }
    });
  }

  /* ------------------------------------------------------------------- boot */

  async function boot() {
    try {
      OSUM.state.settings = await util.readSettings();
    } catch {
      /* defaults are fine */
    }
    OSUM.i18n.refresh();
    onNavigate({ force: true });
    watchTheme();
    // Late content: the player and metadata may render after document_idle.
    setTimeout(() => onNavigate({ force: false }), 1500);
  }

  // Expose a small debug handle (used by the popup and manual testing).
  OSUM.debug = {
    open: () => OSUM.panel.open({}),
    summarize: () => OSUM.panel.open({ autoRun: true }),
    state: () => OSUM.state,
    settings: () => util.readSettings(),
    // Starts a run from transcript text without any panel UI. Used by the
    // browser E2E on a stub page that has no captions of its own.
    transcript: (text) => OSUM.panel.loadTranscriptText(text),
  };

  boot();
})();
