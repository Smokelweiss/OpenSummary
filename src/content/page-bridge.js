/**
 * Page-world bridge for transcript requests.
 *
 * Runs INSIDE the YouTube page (injected as a web-accessible script), not in
 * the content-script sandbox. Why it exists: `youtubei/v1/get_transcript`
 * answers 403 with YouTube's “Sorry…” abuse page when the POST arrives from an
 * extension origin, while the very same call from the page — with the page's
 * cookies, Origin and visitor id — returns the transcript. This bridge is that
 * call, with the answer handed back to the content script over postMessage.
 *
 * Classic script on purpose: it is a page script, so it must not use imports.
 */
(function () {
  'use strict';
  if (window.__osumPageBridge) return;
  window.__osumPageBridge = true;

  const REQUEST = 'request';
  const RESPONSE = 'response';

  function post(message) {
    try {
      window.postMessage({ __osum: RESPONSE, ...message }, location.origin);
    } catch {
      /* the page may be shutting down */
    }
  }

  /** `getTranscriptEndpoint.params` out of a page-data tree. */
  function findParams(root) {
    if (!root) return '';
    const queue = [root];
    const seen = new Set();
    for (let guard = 0; queue.length && guard < 20000; guard++) {
      const node = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (typeof node.getTranscriptEndpoint?.params === 'string' && node.getTranscriptEndpoint.params) {
        return node.getTranscriptEndpoint.params;
      }
      for (const key in node) {
        const value = node[key];
        if (value && typeof value === 'object') queue.push(value);
      }
    }
    return '';
  }

  /**
   * Every `params` string the page currently holds, freshest first.
   *
   * `window.ytInitialData` is the *first* video of the tab's lifetime: YouTube
   * navigates between videos without reloading, and a request rebuilt from the
   * stale tree is answered with 400 “Precondition check failed”. The watched
   * page's live Polymer data (`ytd-app.data.response`) is the current one, so
   * it is asked first and the globals are only a last resort.
   */
  function paramSources() {
    const out = [];
    const add = (value) => {
      const params = typeof value === 'string' ? value : findParams(value);
      if (params && !out.includes(params) && out.length < 4) out.push(params);
    };
    const nodes = [];
    try {
      for (const selector of ['ytd-app', 'ytd-watch-flexy', '#page-manager']) {
        const node = document.querySelector(selector);
        if (node) nodes.push(node);
      }
    } catch {
      /* the page is free to be weird */
    }
    for (const node of nodes) {
      try {
        add(node.data?.response);
        add(node.__data?.data?.response);
        add(node.data);
      } catch {
        /* Polymer data can throw while it is being replaced */
      }
    }
    add(readGlobal('ytInitialData'));
    add(readGlobal('ytInitialPlayerResponse'));
    return out;
  }

  /** Current video id, as the page itself sees it. */
  function pageVideoId() {
    try {
      const fromPlayer = document.querySelector('#movie_player')?.getVideoData?.()?.video_id;
      if (fromPlayer) return String(fromPlayer);
    } catch {
      /* no player yet */
    }
    try {
      return new URL(location.href).searchParams.get('v') || '';
    } catch {
      return '';
    }
  }

  function readGlobal(name) {
    try {
      return window[name] || null;
    } catch {
      return null;
    }
  }

  function cfgValue(key) {
    try {
      return typeof window.ytcfg?.get === 'function' ? window.ytcfg.get(key) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The page's own InnerTube context; absent fields are filled in. */
  function clientContext() {
    const context = cfgValue('INNERTUBE_CONTEXT') || {};
    const client = { ...(context.client || {}) };
    if (!client.clientName) client.clientName = 'WEB';
    if (!client.clientVersion) client.clientVersion = cfgValue('INNERTUBE_CLIENT_VERSION') || '';
    if (!client.hl) client.hl = document.documentElement.lang || 'en';
    if (!client.gl) client.gl = 'US';
    if (!client.visitorData) client.visitorData = cfgValue('VISITOR_DATA') || '';
    return { ...context, client };
  }

  /* ------------------------------------------- capturing the page's own answer */

  // YouTube now rejects a transcript request rebuilt from the page's initial
  // data with 400 “Precondition check failed”: the panel's call carries the
  // player's proof-of-origin token, which no hand-made request can reproduce.
  // So the bridge stops asking and starts listening: when the panel loads its
  // transcript, the answer passes through the page's `fetch`/XHR right here,
  // and the content script gets the exact JSON the page itself received —
  // before any virtualised row rendering, without scrolling the list.
  const CAPTURE_TTL_MS = 60000;
  let captured = null;
  let captureWaiters = [];

  function looksLikeTranscript(json) {
    try {
      if (!json || typeof json !== 'object') return false;
      const status = json.playabilityStatus?.status;
      if (status && status !== 'OK') return false;
      const text = JSON.stringify(json);
      return (
        text.includes('transcriptSegmentRenderer') ||
        text.includes('transcriptCueRenderer') ||
        // 2026-10: YouTube moved the panel to get_panel with a view-model list.
        text.includes('transcriptSegmentViewModel')
      );
    } catch {
      return false;
    }
  }

  function acceptCapture(json) {
    if (!looksLikeTranscript(json)) return;
    captured = { json, at: Date.now() };
    const waiters = captureWaiters;
    captureWaiters = [];
    for (const waiter of waiters) {
      try {
        waiter(captured);
      } catch {
        /* a dead waiter must not stop the others */
      }
    }
  }

  function freshCapture() {
    if (!captured) return null;
    if (Date.now() - captured.at > CAPTURE_TTL_MS) {
      captured = null;
      return null;
    }
    return captured;
  }

  function isTranscriptRequest(url) {
    const text = String(url || '');
    // `get_transcript` was the endpoint until 2026-10; the panel now loads its
    // list from `get_panel` (same idea, view-model renderers instead of a
    // renderer tree). Both are captured, and a non-transcript panel answer is
    // filtered out by `looksLikeTranscript`.
    return text.includes('/youtubei/v1/get_transcript') || text.includes('/youtubei/v1/get_panel');
  }

  // Patches installed once, as early as the bridge loads. Both wrappers only
  // *observe* the page's own requests; the returned promise/response is the
  // untouched original one.
  function installCapture() {
    try {
      const nativeFetch = window.fetch;
      if (typeof nativeFetch === 'function' && !nativeFetch.__osumCapture) {
        const patched = function (...args) {
          const promise = nativeFetch.apply(this, args);
          try {
            const input = args[0];
            const url = typeof input === 'string' ? input : input?.url || '';
            if (isTranscriptRequest(url)) {
              promise
                .then((res) => {
                  try {
                    if (!res || !res.ok) return;
                    res.clone().json().then(acceptCapture).catch(() => {});
                  } catch {
                    /* an opaque response cannot be cloned */
                  }
                })
                .catch(() => {});
            }
          } catch {
            /* never break the page's fetch */
          }
          return promise;
        };
        patched.__osumCapture = true;
        window.fetch = patched;
      }
    } catch {
      /* the page may freeze fetch */
    }
    try {
      const XHR = window.XMLHttpRequest;
      if (XHR?.prototype && !XHR.prototype.__osumCapture) {
        const nativeOpen = XHR.prototype.open;
        const nativeSend = XHR.prototype.send;
        XHR.prototype.open = function (method, url, ...rest) {
          try {
            this.__osumUrl = String(url || '');
          } catch {
            /* ignore */
          }
          return nativeOpen.call(this, method, url, ...rest);
        };
        XHR.prototype.send = function (...args) {
          try {
            if (isTranscriptRequest(this.__osumUrl)) {
              this.addEventListener('load', function () {
                try {
                  if (this.status >= 200 && this.status < 300 && this.responseText) {
                    acceptCapture(JSON.parse(this.responseText));
                  }
                } catch {
                  /* not JSON, not ours */
                }
              });
            }
          } catch {
            /* ignore */
          }
          return nativeSend.apply(this, args);
        };
        XHR.prototype.__osumCapture = true;
      }
    } catch {
      /* ignore */
    }
  }

  installCapture();

  /**
   * Pins the page during a transcript read.
   *
   * YouTube scrolls the watch page itself when the transcript panel mounts
   * (`scrollIntoView` on the engagement panel, the description expanding). The
   * page moved in front of the viewer even though the panel is hidden, because
   * a hidden panel still has a position. Blocking those calls in the page world
   * is the only place it works: from the content script's isolated world the
   * page's own `Element.prototype` is a different object.
   */
  let scrollLock = null;
  function setScrollLock(on) {
    try {
      if (on && !scrollLock) {
        const saved = {
          windowScrollTo: window.scrollTo,
          windowScrollBy: window.scrollBy,
          windowScrollIntoView: window.scrollIntoView,
          elementScrollIntoView: Element.prototype.scrollIntoView,
          scrollBehavior: document.documentElement.style.scrollBehavior,
          y: Number(window.scrollY) || 0,
        };
        const noop = function () {};
        window.scrollTo = noop;
        window.scrollBy = noop;
        window.scrollIntoView = noop;
        Element.prototype.scrollIntoView = noop;
        document.documentElement.style.scrollBehavior = 'auto';
        scrollLock = saved;
      } else if (!on && scrollLock) {
        const saved = scrollLock;
        scrollLock = null;
        window.scrollTo = saved.windowScrollTo;
        window.scrollBy = saved.windowScrollBy;
        window.scrollIntoView = saved.windowScrollIntoView;
        Element.prototype.scrollIntoView = saved.elementScrollIntoView;
        document.documentElement.style.scrollBehavior = saved.scrollBehavior;
        if (Math.abs((Number(window.scrollY) || 0) - saved.y) > 2) {
          try {
            window.scrollTo(0, saved.y);
          } catch {
            /* the page may be navigating */
          }
        }
      }
      return { ok: true, locked: !!scrollLock };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /**
   * The panel's data request, rebuilt from the page's own initial data.
   *
   * YouTube serves the transcript list from `get_panel` since 2026-10; the
   * request needs the same `params` key the page already holds and the page's
   * cookies. Asking for it directly means a video whose “Show transcript”
   * control is missing from a throttled or half-rendered page is still
   * summarisable.
   */
  const TRANSCRIPT_PANEL_IDS = ['PAmodern_transcript_view', 'engagement-panel-searchable-transcript'];

  function requestHeaders() {
    const context = clientContext();
    const client = context.client;
    const headers = { 'content-type': 'application/json' };
    if (client.clientVersion) headers['x-youtube-client-version'] = client.clientVersion;
    if (client.visitorData) headers['x-goog-visitor-id'] = client.visitorData;
    if (client.clientName === 'WEB') headers['x-youtube-client-name'] = '1';
    return { context, headers };
  }

  /** One POST to an InnerTube endpoint with a hard per-request timeout. */
  async function request(path, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${path}?prettyPrint=false`, {
        method: 'POST',
        credentials: 'include',
        headers: requestHeaders().headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: res.status, ok: res.ok, text: (await res.text()).slice(0, 8000000) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getPanel() {
    const { context } = requestHeaders();
    const sources = paramSources();
    if (!sources.length) return { error: 'NO_PARAMS' };
    const deadline = Date.now() + 12000;
    let last = null;
    for (const params of sources) {
      for (const panelId of TRANSCRIPT_PANEL_IDS) {
        const left = deadline - Date.now();
        if (left < 800) return last || { error: 'TIMEOUT' };
        try {
          const answer = await request(
            '/youtubei/v1/get_panel',
            { context, panelId, params },
            Math.min(6000, left),
          );
          // Another panel (chapters, “in this video”) answers 200 without the
          // transcript: only keep an answer that actually carries it.
          if (answer.ok && answer.text.includes('transcriptSegmentViewModel')) {
            return { status: answer.status, ok: true, text: answer.text };
          }
          last = { status: answer.status, ok: answer.ok, text: answer.text.slice(0, 600) };
        } catch (err) {
          last = { error: String((err && err.message) || err) };
        }
      }
    }
    return last || { error: 'NO_PANEL' };
  }

  async function getTranscript() {
    const { context } = requestHeaders();
    const sources = paramSources();
    if (!sources.length) return { error: 'NO_PARAMS' };
    const deadline = Date.now() + 9000;
    let last = null;
    for (const params of sources) {
      const left = deadline - Date.now();
      if (left < 800) break;
      try {
        const answer = await request('/youtubei/v1/get_transcript', { context, params }, Math.min(7000, left));
        if (answer.ok) return answer;
        last = answer;
      } catch (err) {
        last = { error: String((err && err.message) || err) };
      }
    }
    return last || { error: 'NO_RESPONSE' };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    // Only the same document may talk to the bridge. `source === window`
    // already rules out other frames; the origin test also rules out a
    // document that a navigation left behind.
    if (event.origin && event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.__osum !== REQUEST || !data.id) return;
    // Liveness probe: the content script asks before it spends a 25-second
    // timeout on a bridge that a page CSP refused to load.
    if (data.kind === 'ping') {
      post({ id: data.id, ok: true, bridge: 1, videoId: pageVideoId() });
      return;
    }
    if (data.kind === 'scroll-lock') {
      post({ id: data.id, ...setScrollLock(data.on === true) });
      return;
    }
    if (data.kind === 'capture-transcript') {
      // An already captured answer (the reader's own panel) is returned at once;
      // otherwise this resolves when the panel's request finishes.
      const ready = freshCapture();
      if (ready) {
        post({ id: data.id, captured: true, json: ready.json });
        return;
      }
      const timeout = Math.max(1000, Math.min(20000, Number(data.timeoutMs) || 8000));
      let done = false;
      const waiter = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        post({ id: data.id, captured: true, json: payload.json });
      };
      captureWaiters.push(waiter);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const at = captureWaiters.indexOf(waiter);
        if (at !== -1) captureWaiters.splice(at, 1);
        post({ id: data.id, captured: false });
      }, timeout);
      return;
    }
    if (data.kind === 'get-panel') {
      try {
        const result = await getPanel();
        post({ id: data.id, ...result });
      } catch (err) {
        post({ id: data.id, error: String((err && err.message) || err) });
      }
      return;
    }
    if (data.kind !== 'get-transcript') {
      post({ id: data.id, error: 'UNKNOWN_KIND' });
      return;
    }
    try {
      const result = await getTranscript();
      post({ id: data.id, ...result });
    } catch (err) {
      post({ id: data.id, error: String((err && err.message) || err) });
    }
  });

  // Lets the content script know the bridge is alive even if a request races
  // the script's `load` event.
  post({ id: 'ready' });
})();
