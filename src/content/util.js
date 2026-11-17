/** DOM helpers, YouTube page integration and small utilities. */

(function () {
  const OSUM = window.OSUM;

  const ICONS = {
    logo: 'M4 4h10v2H4V4zm0 5h16v2H4V9zm0 5h12v2H4v-2zm14-9.5 4 2.5-4 2.5v-5z',
    close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z',
    // A real cog: eight teeth and a ring. The old glyph was an unreadable blob.
    settings:
      'M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
    sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.22 2.81 6.34 4.93 4.93 6.34 2.81 4.22zm13.44 16.26 2.12 2.12-1.41 1.41-2.12-2.12zm2.12-16.26 1.41 1.41-2.12 2.12-1.41-1.41zM6.34 19.07l1.41 1.41-2.12 2.12-1.41-1.41z',
    moon: 'M9 2c-1.05 0-2.05.16-3 .46a10 10 0 0 0 12.54 13.08A10 10 0 0 1 9 2z',
    copy: 'M8 3h9a2 2 0 0 1 2 2v12h-2V5H8V3zm-3 4h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v12h9V9H5z',
    transcript: 'M4 4h16v2H4V4zm0 4h16v2H4V8zm0 4h16v2H4v-2zm0 4h10v2H4v-2zm0 4h16v2H4v-2z',
    download: 'M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-4.7 1.4-1.4L12 13.6V3zM5 19h14v2H5z',
    refresh: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
    stop: 'M7 7h10v10H7z',
    play: 'M8 5v14l11-7L8 5z',
    sparkle: 'M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2zm6 12 .9 2.6L21.5 18l-2.6.9-.9 2.6-.9-2.6L14.5 18l2.6-.9L18 14z',
    chip: 'M9 2v2H7a3 3 0 0 0-3 3v2H2v2h2v2H2v2h2v2a3 3 0 0 0 3 3h2v2h2v-2h2v2h2v-2h2a3 3 0 0 0 3-3v-2h2v-2h-2v-2h2V9h-2V7a3 3 0 0 0-3-3h-2V2h-2v2h-2V2H9zm-1 6h8v8H8V8z',
    search: 'M10 4a6 6 0 1 0 3.9 10.6l4.3 4.2 1.4-1.4-4.3-4.2A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
    timer: 'M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3zm1 4v5l4 2.4-1 1.7-5-3V7h2z',
    info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
    chevron: 'M9 6l6 6-6 6-1.4-1.4L12.2 12 7.6 7.4 9 6z',
  };

  const fmt = {
    time(sec) {
      const s = Math.max(0, Math.floor(Number(sec) || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
    },
    duration(sec) {
      const s = Math.max(0, Math.round(Number(sec) || 0));
      const h = Math.floor(s / 3600);
      const m = Math.round((s % 3600) / 60);
      if (h) return `${h} ч ${m} мин`;
      if (m) return `${m} мин`;
      return `${s} с`;
    },
    number(n) {
      const v = Number(n) || 0;
      if (v >= 1e9) return `${(v / 1e9).toFixed(1)} млрд`;
      if (v >= 1e6) return `${(v / 1e6).toFixed(1)} млн`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)} тыс`;
      return String(v);
    },
    percent(v) {
      return `${Math.round((Number(v) || 0) * 100)}%`;
    },
  };

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'icon') node.appendChild(icon(value));
      else node.setAttribute(key, String(value));
    }
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function icon(name, size = 16) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('osum-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name] || ICONS.info);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  /** Highlights query matches inside a text node without using innerHTML. */
  function highlight(text, query) {
    const wrapper = document.createDocumentFragment();
    const src = String(text || '');
    if (!query) {
      wrapper.appendChild(document.createTextNode(src));
      return wrapper;
    }
    const re = new RegExp(escapeRegExp(query), 'gi');
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      if (m.index > last) wrapper.appendChild(document.createTextNode(src.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      wrapper.appendChild(mark);
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (last < src.length) wrapper.appendChild(document.createTextNode(src.slice(last)));
    return wrapper;
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function debounce(fn, ms = 180) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function getVideoId() {
    try {
      const url = new URL(location.href);
      if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1, 20);
      const v = url.searchParams.get('v');
      if (v) return v;
      const m = url.pathname.match(/\/(shorts|live|embed)\/([\w-]{6,20})/);
      if (m) return m[2];
    } catch {
      /* ignore */
    }
    return '';
  }

  function pageMeta() {
    const pick = (selectors) => {
      for (const sel of selectors) {
        const node = document.querySelector(sel);
        const text = node?.textContent?.trim();
        if (text) return text;
      }
      return '';
    };
    const viewText = pick(['#info-container span', '#info span', '.ytd-video-view-count-renderer']);
    const viewsM = viewText.match(/([\d\s.,]+)\s*(просмотр|views?)/i);
    const lengthM = pick(['.ytp-time-duration']).match(/(\d+):(\d{2})(?::(\d{2}))?/);
    let lengthSeconds = 0;
    if (lengthM) {
      lengthSeconds = lengthM[3]
        ? Number(lengthM[1]) * 3600 + Number(lengthM[2]) * 60 + Number(lengthM[3])
        : Number(lengthM[1]) * 60 + Number(lengthM[2]);
    }
    return {
      videoId: getVideoId(),
      videoTitle: pick(['h1.ytd-watch-metadata yt-formatted-string', '#title h1 yt-formatted-string', '#title h1', 'ytd-video-primary-info-renderer h1']),
      channel: pick(['#owner ytd-channel-name a', 'ytd-channel-name a', '#upload-info #channel-name a']),
      views: viewsM ? Number(viewsM[1].replace(/[\s.,]/g, '')) : 0,
      lengthSeconds,
      thumbnail: `https://i.ytimg.com/vi/${getVideoId()}/mqdefault.jpg`,
    };
  }

  let pendingSeek = null;

  function seekTo(seconds) {
    const target = Math.max(0, Number(seconds) || 0);
    const video =
      document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video');
    if (!video) return false;
    try {
      if (video.readyState < 1) {
        pendingSeek = target;
        video.addEventListener(
          'loadedmetadata',
          () => {
            if (pendingSeek != null) {
              video.currentTime = pendingSeek;
              pendingSeek = null;
            }
          },
          { once: true },
        );
        return true;
      }
      video.currentTime = target;
      const player = document.querySelector('#movie_player');
      if (typeof player?.playVideo === 'function' && video.paused) player.playVideo();
      else if (video.paused) video.play?.().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function currentTime() {
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    return video ? video.currentTime : 0;
  }

  function isDarkTheme() {
    const html = document.documentElement;
    if (html.hasAttribute('dark')) return true;
    if (html.getAttribute('dark') === 'false') return false;
    const bg = getComputedStyle(document.body).backgroundColor || '';
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) {
      const lum = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
      return lum < 128;
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  }

  async function copyText(text) {
    const value = String(text ?? '');
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function downloadText(filename, content, mime = 'text/markdown') {
    try {
      const blob = new Blob([content], { type: `${mime};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch {
      return false;
    }
  }

  /** sendMessage wrapper that turns background __error payloads into Errors. */
  async function sendMessage(message) {
    const res = await chrome.runtime.sendMessage(message);
    if (res && typeof res === 'object' && res.__error) {
      const err = new Error(res.__error);
      err.code = res.__code || 'BACKGROUND_ERROR';
      err.hint = res.__data?.hint || '';
      err.provider = res.__data?.provider || '';
      err.detail = res.__data?.detail || '';
      err.status = res.__data?.status || 0;
      throw err;
    }
    return res;
  }

  async function readSettings() {
    const defaults = {
      mode: 'local',
      ui: { lang: 'auto', theme: 'light', showFab: true, docked: true, autoOpenPanel: false, autoSummarize: false, panelWidth: 420 },
      output: { language: 'auto', length: 'standard', tone: 'neutral', includeTimestamps: true, selfCheck: false, customInstructions: '' },
      local: { keyPoints: 8, sectionsMode: 'auto', perSectionPoints: 3, keywordCount: 24, timelineBuckets: 20 },
      ai: { providerId: '', model: '', strategy: 'auto', summaryMode: 'whole', contextTokens: 128000, chunkTokens: 6000, concurrency: 3, stream: true, useCache: true, chunkCache: true },
      cache: { enabled: true },
      advanced: { preferManualCaptions: true, keepTranscriptInMemory: true },
    };
    try {
      const data = await chrome.storage.local.get('osum:settings');
      return deepMerge(defaults, data['osum:settings'] || {});
    } catch {
      return defaults;
    }
  }

  function deepMerge(base, patch) {
    if (Array.isArray(base)) return Array.isArray(patch) ? patch.slice() : base.slice();
    if (!base || typeof base !== 'object') return patch ?? base;
    const out = { ...base };
    if (!patch || typeof patch !== 'object') return out;
    for (const [k, v] of Object.entries(patch)) {
      out[k] = base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' ? deepMerge(base[k], v) : v;
    }
    return out;
  }

  let toastHost = null;
  function toast(message, { variant = 'info', ms = 2600 } = {}) {
    if (!toastHost) return;
    const node = el('div', { class: `osum-toast osum-toast-${variant}`, text: message });
    toastHost.appendChild(node);
    requestAnimationFrame(() => node.classList.add('osum-toast-in'));
    setTimeout(() => {
      node.classList.remove('osum-toast-in');
      setTimeout(() => node.remove(), 260);
    }, ms);
  }

  function setToastHost(node) {
    toastHost = node;
  }

  function relativeTime(iso) {
    const then = Date.parse(iso || '');
    if (!then) return '';
    const diff = Date.now() - then;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return `${min} мин назад`;
    const hours = Math.round(min / 60);
    if (hours < 24) return `${hours} ч назад`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} дн назад`;
    return new Date(then).toLocaleDateString();
  }

  OSUM.register('dom', { el, icon, highlight, ICONS });
  OSUM.register('fmt', fmt);
  OSUM.register('util', {
    debounce,
    getVideoId,
    pageMeta,
    seekTo,
    currentTime,
    isDarkTheme,
    copyText,
    downloadText,
    sendMessage,
    readSettings,
    deepMerge,
    toast,
    setToastHost,
    relativeTime,
    escapeRegExp,
  });
})();
