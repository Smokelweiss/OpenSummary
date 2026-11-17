/**
 * Integration tests for the content-script UI.
 *
 * The content scripts run in a stubbed DOM (no jsdom, no dependencies): every
 * module is loaded from disk exactly as the browser would load it, then we drive
 * the real panel code — local results, AI results over the task port, error
 * cards, Q&A, transcript tab and exports — and inspect the rendered tree.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, assert, assertEqual } from './helpers.mjs';
import { ruTranscript, meta as fixtureMeta, longTranscript } from './fixtures.mjs';
import { systemPrompt } from '../src/ai/prompts.js';
import { DEFAULT_SETTINGS } from '../src/common/constants.js';
import { normalizeResult } from '../src/nlp/schema.js';
import { APP } from '../src/common/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_FILES = [
  'src/content/namespace.js',
  'src/content/i18n.js',
  'src/content/css.js',
  'src/content/util.js',
  'src/content/transcript-dom.js',
  'src/content/exporter.js',
  'src/content/panel.js',
  'src/content/inject.js',
];

/* ------------------------------------------------------------------ fake DOM */

/*
 * A tiny selector engine, so the transcript scraper can be tested against a
 * fake page: tag, #id, .class, [attr], [attr=…], [attr*=…], [attr^=…],
 * [attr$=…] (with the `i` flag), descendant chains and comma groups. Values may
 * not contain spaces — the code under test never writes those.
 */

function attrOf(node, name) {
  if (name === 'id') return node.id ?? node.attrs?.id ?? null;
  if (name === 'class') return node.attrs?.class ?? [...(node._classes || [])].join(' ');
  const value = node.attrs?.[name];
  return value === undefined ? null : value;
}

function matchAttrExpr(node, expr) {
  const m = /^\s*([^\s\]=*^$~|]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?(i)?\s*$/.exec(expr);
  if (!m) return false;
  const actual = attrOf(node, m[1]);
  if (actual == null) return false;
  if (!m[2]) return true;
  const expected = m[3] ?? m[4] ?? m[5] ?? '';
  const insensitive = !!m[6];
  const value = insensitive ? String(actual).toLowerCase() : String(actual);
  const target = insensitive ? expected.toLowerCase() : expected;
  switch (m[2]) {
    case '=':
      return value === target;
    case '*=':
      return value.includes(target);
    case '^=':
      return value.startsWith(target);
    case '$=':
      return value.endsWith(target);
    default:
      return false;
  }
}

function closeBracket(selector, start) {
  let quote = '';
  for (let i = start + 1; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ']') return i;
  }
  return -1;
}

function matchCompound(node, selector) {
  if (!selector || selector === '*') return true;
  let i = 0;
  const tag = /^[a-zA-Z][\w-]*/.exec(selector);
  if (tag) {
    if (String(node.tagName || '').toLowerCase() !== tag[0].toLowerCase()) return false;
    i = tag[0].length;
  }
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '#') {
      const m = /^#([\w-]+)/.exec(selector.slice(i));
      if (!m || String(attrOf(node, 'id') ?? '') !== m[1]) return false;
      i += m[0].length;
    } else if (ch === '.') {
      const m = /^\.([\w-]+)/.exec(selector.slice(i));
      if (!m) return false;
      const classes = node._classes || new Set(String(attrOf(node, 'class') || '').split(/\s+/).filter(Boolean));
      if (!classes.has(m[1])) return false;
      i += m[0].length;
    } else if (ch === '[') {
      const end = closeBracket(selector, i);
      if (end < 0 || !matchAttrExpr(node, selector.slice(i + 1, end))) return false;
      i = end + 1;
    } else {
      return false;
    }
  }
  return true;
}

function matchSelector(node, selector) {
  for (const group of String(selector).split(',')) {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    let index = parts.length - 1;
    if (!matchCompound(node, parts[index])) continue;
    index--;
    let el = node.parentNode;
    while (index >= 0 && el) {
      if (matchCompound(el, parts[index])) index--;
      el = el.parentNode;
    }
    if (index < 0) return true;
  }
  return false;
}

function descendants(node, out = []) {
  for (const child of node.children || []) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = makeStyle();
    this._classes = new Set();
    this._text = '';
    this._html = '';
    this.parentNode = null;
    this.hidden = false;
    this.classList = {
      add: (...names) => names.forEach((n) => this._classes.add(n)),
      remove: (...names) => names.forEach((n) => this._classes.delete(n)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const want = force === undefined ? !this._classes.has(name) : !!force;
        if (want) this._classes.add(name);
        else this._classes.delete(name);
        return want;
      },
    };
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }

  /** Browsers insert separators between block children; the scraper relies on it. */
  get innerText() {
    const parts = [this._text, ...this.children.map((c) => c.innerText)].filter((part) => part !== '' && part != null);
    return parts.join('\n');
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value ?? '');
  }

  get value() {
    return this._value ?? '';
  }

  set value(v) {
    this._value = String(v ?? '');
  }

  get checked() {
    return !!this._checked;
  }

  set checked(v) {
    this._checked = !!v;
  }

  get src() {
    return this._src ?? '';
  }

  set src(v) {
    this._src = String(v ?? '');
  }

  get type() {
    return this._type ?? 'text';
  }

  set type(v) {
    this._type = String(v ?? '');
  }

  get disabled() {
    return !!this._disabled;
  }

  set disabled(v) {
    this._disabled = !!v;
  }

  get parentElement() {
    return this.parentNode;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get childElementCount() {
    return this.children.length;
  }

  get id() {
    return this.attrs.id ?? this._id ?? '';
  }

  set id(value) {
    this.attrs.id = String(value ?? '');
  }

  appendChild(node) {
    if (!node) return node;
    if (node.__fragment) {
      for (const child of node.children.slice()) this.appendChild(child);
      return node;
    }
    this.children.push(node);
    node.parentNode = this;
    return node;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      this.children.unshift(node);
      node.parentNode = this;
    }
  }

  insertBefore(node, ref) {
    const index = this.children.indexOf(ref);
    if (index === -1) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children[index] = node;
    node.parentNode = parent;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return descendants(this).filter((node) => matchSelector(node, selector));
  }

  closest(selector) {
    for (let el = this; el; el = el.parentNode) if (matchSelector(el, selector)) return el;
    return null;
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'hidden') this.hidden = true;
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  removeAttribute(name) {
    delete this.attrs[name];
    if (name === 'hidden') this.hidden = false;
  }

  hasAttribute(name) {
    return name in this.attrs;
  }

  addEventListener() {}

  removeEventListener() {}

  dispatchEvent() {
    return true;
  }

  attachShadow() {
    const root = new FakeNode('#shadow-root');
    root.host = this;
    this.shadowRoot = root;
    return root;
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
  }

  scrollIntoView() {}

  focus() {}

  click() {}

  select() {}

  cloneNode() {
    return new FakeNode(this.tagName);
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains?.(node));
  }

  /** Test helper: all descendants matching a predicate. */
  find(predicate, out = []) {
    if (predicate(this)) out.push(this);
    for (const child of this.children) child.find?.(predicate, out);
    return out;
  }
}

function makeStyle() {
  return {
    setProperty() {},
    removeProperty() {},
    cssText: '',
  };
}

const documentStub = {
  documentElement: new FakeNode('html'),
  body: new FakeNode('body'),
  head: new FakeNode('head'),
  createElement: (tag) => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode('#text');
    node._text = String(text ?? '');
    return node;
  },
  createDocumentFragment: () => {
    const fragment = new FakeNode('#fragment');
    fragment.__fragment = true;
    return fragment;
  },
  querySelector: (selector) => documentStub.querySelectorAll(selector)[0] || null,
  querySelectorAll: (selector) => {
    const roots = [documentStub.documentElement, documentStub.body, documentStub.head].filter(Boolean);
    return roots.flatMap((root) => descendants(root)).filter((node) => matchSelector(node, selector));
  },
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
};

// The panel docks into this node when `ui.docked` is on.
const secondaryInner = new FakeNode('div');
secondaryInner.id = 'secondary-inner';
documentStub.body.appendChild(secondaryInner);
const querySelectorStub = documentStub.querySelector;
documentStub.querySelector = (selector) =>
  selector === '#secondary-inner' || selector === '#secondary' ? secondaryInner : querySelectorStub(selector);

const copied = [];
const clipboard = { writeText: async (text) => copied.push(String(text)) };

/* --------------------------------------------------------------- fake chrome */

const PROVIDERS = [
  {
    id: 'mock-free',
    name: 'Mock Free',
    type: 'openai',
    baseUrl: 'https://mock.example/v1',
    models: ['mock-1', 'mock-2'],
    defaultModel: 'mock-1',
    hasKey: true,
    keyPreview: 'mock••••xxxx',
    enabled: true,
    free: true,
  },
];

const aiFixture = normalizeResult(
  {
    tldr: 'Короткий итог про ключевую идею видео.',
    keyPoints: [{ text: 'Первый тезис с цифрой 42', at: 30 }, { text: 'Второй тезис без времени' }],
    takeaways: ['Сделать вывод'],
    actionItems: ['Проверить гипотезу'],
    questions: ['Почему 42?'],
    quotes: [{ text: 'Цитата из видео', at: 120 }],
    keywords: ['ключевое', 'слово'],
    sections: [{ heading: 'Введение', at: 0, summary: 'О чём речь', points: [{ text: 'Тезис раздела', at: 5 }] }],
    entities: [{ name: 'OpenSummary', mentions: 3 }],
    timeline: [{ at: 0, score: 0.4, keywords: ['введение'] }],
    sentiment: { label: 'positive', score: 0.3 },
  },
  { mode: 'ai', provider: 'Mock Free', model: 'mock-1', videoId: 'dQw4w9WgXcQ', lang: 'ru', uiLang: 'ru', videoTitle: 'Тестовое видео', lengthSeconds: 600 },
);
aiFixture.stats = { words: 1200, sentences: 90, speechRateWpm: 140, compression: 0.08, readTimeSec: 60, aiCalls: 1, aiTokensIn: 900, aiTokensOut: 300 };

// Set by a test to make the mock provider answer with something else (e.g. the
// empty JSON a cut-off model returns).
let aiResultOverride = null;

// Set by a test to make the mock task port fail (code + message).
let aiErrorOverride = null;

// Set by a test to make the worker's caption route fail, the way YouTube does
// when every track is PO-token protected.
let transcriptErrorOverride = null;

// Set by a test to make the worker report a compatible interrupted job.
let resumeJobStub = null;

// When set, the mock worker emits these validated streamed items before the
// result. `streamGate` lets a test inspect the panel mid-stream.
let streamItemStub = null;
let streamGate = null;
// A worker that is busy without any task event: `{ ms, pongs }` makes the mock
// stay silent for `ms` and optionally answer keepalive pings meanwhile. This is
// a reasoning model thinking before its first token.
let slowWorkerStub = null;
// Map-phase points the mock worker publishes as they are validated.
let mapItemStub = null;

/** A finished AI-shaped result, used wherever a rendered summary is needed. */
const localFixture = normalizeResult(
  {
    tldr: 'Видео объясняет, как устроено кэширование ответов и зачем измерять попадания.',
    keyPoints: [
      { text: 'Кэш хранит готовые ответы и экономит время запроса.', at: '0:20' },
      { text: 'Метрика попаданий показывает, насколько кэш полезен.', at: '1:05' },
      { text: 'Инвалидация кэша защищает от устаревших данных.', at: '2:10' },
    ],
    sections: [
      { heading: 'Кэширование ответов', at: '0:20', summary: 'Разбирается, как работает кэш.' },
      { heading: 'Метрики', at: '1:05', summary: 'Как измерять пользу кэша.' },
    ],
    takeaways: ['Измеряйте попадания в кэш.'],
    quotes: [{ text: 'Кэш — это память о прошлом.', at: '1:30' }],
    keywords: [{ term: 'кэш', at: 20 }, { term: 'инвалидация', at: 130 }],
    sentiment: { label: 'neutral', score: 0 },
  },
  {
    mode: 'ai',
    videoId: 'dQw4w9WgXcQ',
    lengthSeconds: 180,
    lang: 'ru',
    uiLang: 'ru',
    provider: 'mock-free',
    model: 'mock-1',
  },
);

function respond(message) {
  const type = message?.type;
  switch (type) {
    case 'get-state':
      return {
        ok: true,
        version: APP.version,
        providers: PROVIDERS,
        activeProviderId: 'mock-free',
        cache: { entries: 2, bytes: 4096 },
        historyCount: 1,
        usage: { 'mock-free': { requests: 3, errors: 0, ms: 1200 } },
        engineInfo: {},
      };
    case 'get-history':
      return {
        ok: true,
        history: [{ videoId: 'aaa11111111', mode: 'ai', title: 'Старое видео', at: new Date().toISOString() }],
      };
    case 'get-transcript':
      if (transcriptErrorOverride) return transcriptErrorOverride;
      return {
        ok: true,
        videoId: 'dQw4w9WgXcQ',
        segments: ruTranscript(),
        tracks: [{ lang: 'ru', name: 'ru', auto: true }],
        format: 'json3',
        meta: fixtureMeta({ videoId: 'dQw4w9WgXcQ' }),
        plan: { strategy: 'map-reduce', chunks: 3, tokens: 4200 },
      };
    case 'local-ask':
      return {
        ok: true,
        answer: 'Локальный ответ по транскрипту.',
        sources: [{ text: 'Фрагмент транскрипта', at: 12, ts: '0:12' }],
        confidence: 0.42,
        density: 0.7,
        overview: [{ text: 'Обзорный тезис', at: 0 }],
      };
    case 'export-md':
      return { ok: true, text: '# Конспект\n\nТекст', filename: 'summary.md' };
    case 'save-settings':
      return { ok: true, settings: {} };
    case 'get-resumable':
      return { ok: true, job: resumeJobStub };
    default:
      return { ok: true };
  }
}

let portCount = 0;
let lastPort = null;
function makePort() {
  portCount++;
  const messageListeners = [];
  const disconnectListeners = [];
  const posted = [];
  const port = {
    name: 'osum-task',
    onMessage: { addListener: (cb) => messageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => disconnectListeners.push(cb) },
    posted,
    disconnected: false,
    // Emits a worker event to the panel without going through postMessage.
    emit: (payload) => messageListeners.forEach((cb) => cb(payload)),
    postMessage: (message) => {
      posted.push(message);
      const emit = (payload) => messageListeners.forEach((cb) => cb(payload));
      if (message.type === 'ai-summary') {
        queueMicrotask(async () => {
          if (slowWorkerStub) {
            const { ms, pongs } = slowWorkerStub;
            // A recursive `setTimeout`, not `setInterval`: this file stubs the
            // interval API for the whole run so the process can exit.
            let pinging = !!pongs;
            const pingLoop = () => {
              if (!pinging) return;
              emit({ type: 'pong', at: Date.now() });
              setTimeout(pingLoop, 20);
            };
            if (pongs) pingLoop();
            await new Promise((resolve) => setTimeout(resolve, ms));
            pinging = false;
          }
          if (aiErrorOverride) {
            if (streamItemStub) {
              for (const item of streamItemStub) {
                emit({ type: 'progress', taskId: message.taskId, stage: 'stream-item', streamId: item.streamId || 1, item, firstItemMs: 10, elapsedMs: 12 });
              }
            }
            emit({ type: 'error', taskId: message.taskId, ...aiErrorOverride });
            emit({ type: 'done', taskId: message.taskId });
            return;
          }
          emit({ type: 'stage', taskId: message.taskId, stage: 'prepare', message: 'Готовлю' });
          emit({ type: 'stage', taskId: message.taskId, stage: 'map', done: 1, total: 3 });
          emit({ type: 'progress', taskId: message.taskId, stage: 'map', done: 2, total: 3 });
          emit({ type: 'delta', taskId: message.taskId, chunk: 'тек', full: 'текст конспекта' });
          if (mapItemStub) {
            for (const item of mapItemStub) {
              emit({
                type: 'progress',
                taskId: message.taskId,
                stage: 'partial-item',
                index: item.index,
                startAt: item.startAt,
                endAt: item.endAt,
                total: 3,
                item: { kind: 'keyPoint', point: item.point },
              });
            }
          }
          if (streamItemStub) {
            for (const item of streamItemStub) {
              emit({ type: 'progress', taskId: message.taskId, stage: 'stream-item', streamId: item.streamId || 1, item, firstItemMs: 10, elapsedMs: 12 });
            }
          }
          if (streamGate) await streamGate;
          emit({
            type: 'result',
            taskId: message.taskId,
            result: JSON.parse(JSON.stringify(aiResultOverride || aiFixture)),
            strategy: 'single',
            usage: { calls: 1 },
            warnings: [],
            provider: PROVIDERS[0],
            model: 'mock-1',
            cached: false,
          });
          emit({ type: 'done', taskId: message.taskId });
        });
      } else if (message.type === 'ai-ask') {
        queueMicrotask(() => {
          if (aiErrorOverride) {
            emit({ type: 'error', taskId: message.taskId, ...aiErrorOverride });
            emit({ type: 'done', taskId: message.taskId });
            return;
          }
          emit({
            type: 'result',
            taskId: message.taskId,
            answer: 'ИИ-ответ',
            citations: [{ text: 'цитата', at: 30, ts: '0:30' }],
            confidence: 0.8,
            usage: {},
            provider: 'Mock Free',
          });
          emit({ type: 'done', taskId: message.taskId });
        });
      }
    },
    disconnect: () => {
      port.disconnected = true;
      disconnectListeners.forEach((cb) => cb(port));
    },
  };
  lastPort = port;
  return port;
}

const chromeStub = {
  runtime: {
    id: 'test-extension-id',
    getURL: (path) => `chrome-extension://test-extension-id/${path}`,
    onMessage: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    sendMessage: async (message) => respond(message),
    connect: () => makePort(),
    openOptionsPage: async () => {},
    lastError: null,
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: () => {} },
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
    sendMessage: async () => ({ ok: true }),
    create: async () => ({ id: 2 }),
  },
  permissions: { contains: async () => true, request: async () => true, getAll: async () => ({ origins: [] }) },
  downloads: { download: async () => 1 },
  contextMenus: { removeAll: async () => {}, create: () => {} },
  scripting: { executeScript: async () => [{}] },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
};

/* --------------------------------------------------------------- environment */

globalThis.window = globalThis;
globalThis.document = documentStub;
globalThis.chrome = chromeStub;
// Node 22 exposes a read-only global `navigator`, so redefine it.
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'ru', userAgent: 'node', clipboard },
  configurable: true,
  writable: true,
});
globalThis.location = {
  href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  pathname: '/watch',
  search: '?v=dQw4w9WgXcQ',
  hostname: 'www.youtube.com',
  origin: 'https://www.youtube.com',
};
globalThis.innerWidth = 1400;
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(18, 18, 18)' });
globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
globalThis.requestAnimationFrame = (fn) => {
  fn(0);
  return 1;
};
globalThis.open = () => null;
globalThis.self = globalThis;
// The scraper puts the page scroll back after reading the panel offline.
globalThis.scrollY = 0;
const scrollCalls = [];
globalThis.scrollTo = (options) => scrollCalls.push(options);
// Minimal window event bus: the scraper listens for wheel/keydown/scroll to
// tell the reader's own scrolling from YouTube's programmatic jumps.
const windowEvents = new Map();
globalThis.addEventListener = (name, fn) => {
  if (!windowEvents.has(name)) windowEvents.set(name, new Set());
  windowEvents.get(name).add(fn);
};
globalThis.removeEventListener = (name, fn) => windowEvents.get(name)?.delete(fn);
const dispatchWindow = (name, event = {}) => {
  for (const fn of [...(windowEvents.get(name) || [])]) fn(event);
};

// Intervals would keep the Node process alive (page polling, port keepalive),
// so they are stubbed for the whole run. The callbacks are kept, so a test can
// tick the live countdown by hand instead of waiting a real second.
const intervals = [];
globalThis.setInterval = (fn) => {
  intervals.push(fn);
  return intervals.length;
};
globalThis.clearInterval = () => {};

for (const rel of CONTENT_FILES) {
  const source = readFileSync(join(ROOT, rel), 'utf8');
  new Function(source)();
}

const OSUM = globalThis.OSUM;
const panel = OSUM.panel;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const refs = () => panel.refs();

function resetState() {
  Object.assign(OSUM.state, {
    tab: 'overview',
    result: null,
    transcript: null,
    transcriptMeta: null,
    error: null,
    fallback: null,
    running: false,
    partialChunks: [],
    progress: null,
    streamingText: '',
    statusMessage: '',
    qaHistory: [],
    pasteOpen: false,
    exportMenuOpen: false,
    transcriptQuery: '',
    panelOpen: true,
  });
}

function bodyText() {
  const body = refs().body;
  return body ? body.textContent : '';
}

function findNodes(predicate) {
  const body = refs().body;
  return body ? body.find(predicate) : [];
}

/* ------------------------------------------------------------------- tests */

describe('content UI (stubbed DOM)', () => {
  it('loads every content script and exposes the panel API', () => {
    assert(OSUM && OSUM.version, 'window.OSUM must exist');
    assertEqual(OSUM.version, APP.version, 'the content namespace must report the packaged version');
    for (const method of ['mount', 'open', 'close', 'toggle', 'setTab', 'run', 'ask', 'cancel', 'loadTranscript', 'setResult', 'setError']) {
      assert(typeof panel[method] === 'function', `panel.${method} must be a function`);
    }
    assertEqual(OSUM.t('tabOverview'), 'Обзор');
    assertEqual(OSUM.t('summarize'), 'Саммари');
    assert(typeof OSUM.transcriptDom.parsePasted === 'function', 'transcript DOM fallback must load');
    assert(typeof OSUM.exporter.copyResult === 'function', 'exporter must load');
  });

  it('mounts the shadow panel and injects the stylesheet', () => {
    panel.mount();
    panel.mount(); // idempotent
    const hosts = documentStub.body.find((n) => n.id === 'osum-host');    assertEqual(hosts.length, 1, 'exactly one host element');
    const shadow = hosts[0].shadowRoot;
    assert(shadow, 'shadow root must exist');
    assert(shadow.children.some((c) => c.tagName === 'STYLE' && c.textContent.includes('.osum-panel')), 'panel CSS must be injected');
    assertEqual(refs().panel.hidden, true, 'panel starts hidden');
    assert(refs().fab, 'floating button must exist');
  });

  it('docks the panel into the YouTube sidebar and returns to the overlay on close', async () => {
    await panel.open({});
    const host = documentStub.body.find((n) => n.id === 'osum-host')[0];
    assertEqual(host.parentNode, secondaryInner, 'docked host must live inside #secondary-inner');
    assertEqual(refs().root.dataset.docked, 'true', 'root must switch to the docked layout');
    assertEqual(refs().panel.hidden, false, 'panel must be visible after open()');
    assertEqual(refs().fab.hidden, true, 'the FAB must hide while the panel is open');

    panel.close();
    assertEqual(host.parentNode, documentStub.body, 'a closed panel must go back to <body>');
    assertEqual(refs().root.dataset.docked, 'false', 'root must switch back to the overlay layout');
    assertEqual(refs().fab.hidden, false, 'the FAB must come back after closing');
  });

  it('keeps the overlay layout when docking is disabled', async () => {
    const originalGet = chromeStub.storage.local.get;
    chromeStub.storage.local.get = async () => ({ 'osum:settings': { ui: { docked: false } } });
    try {
      await panel.open({});
      const host = documentStub.body.find((n) => n.id === 'osum-host')[0];
      assertEqual(host.parentNode, documentStub.body, 'undocked panel must stay on <body>');
      assertEqual(refs().root.dataset.docked, 'false');
      assertEqual(refs().panel.hidden, false);
    } finally {
      chromeStub.storage.local.get = originalGet;
      panel.close();
    }
  });

  it('opens the panel even when the background does not answer', async () => {
    const originalSend = chromeStub.runtime.sendMessage;
    chromeStub.runtime.sendMessage = async () => {
      throw new Error('Could not establish connection.');
    };
    try {
      await panel.open({});
      assertEqual(OSUM.state.panelOpen, true, 'panel must open without a background response');
      assertEqual(refs().panel.hidden, false, 'the panel must not stay hidden');
    } finally {
      chromeStub.runtime.sendMessage = originalSend;
      panel.close();
    }
  });

  it('renders a real result in the overview tab', async () => {
    resetState();
    panel.render();
    panel.setResult(JSON.parse(JSON.stringify(localFixture)), { cached: false });
    await tick();
    const text = bodyText();
    assert(text.includes(localFixture.tldr), 'TL;DR must be rendered');
    assert(text.includes('Ключевые моменты'), 'key points section must be rendered');
    const points = findNodes((n) => n.className.includes('osum-point'));
    assert(points.length >= 3, `expected several key points, got ${points.length}`);
    const timestamps = findNodes((n) => n.className === 'osum-ts');
    assert(timestamps.length > 0, 'clickable timestamps must be rendered');
    // Provider badges, stats and keywords are behind “Run details”, not in the
    // reading flow. Run details scrolls with the reading area: one scrollbar.
    const panelText = refs().panel.textContent;
    assert(panelText.includes('mock-free'), 'the provider badge must stay available in run details');
    assert(panelText.includes('Ключевые слова'), 'keywords belong to run details');
    assert(text.indexOf('Ключевые слова') > text.indexOf(localFixture.tldr), 'keywords must stay below the summary');
    assertEqual(findNodes((n) => n.className === 'osum-runs').length, 1, 'exactly one folded run block');
    assert(bodyText().includes(OSUM.t('runDetails')), 'run details lives inside the scrolling body');
  });

  it('shows only navigation and the reading area by default', () => {
    resetState();
    panel.setResult(JSON.parse(JSON.stringify(localFixture)), { cached: false });
    const tabs = refs().panel.find((n) => n.className === 'osum-tab').map((n) => n.textContent);
    assertEqual(
      tabs.join('|'),
      [OSUM.t('tabOverview'), OSUM.t('tabAsk')].join('|'),
      'the header must carry exactly two tabs: sections live in the overview and the timeline is a map',
    );
    assert(!refs().panel.textContent.includes(OSUM.t('tabTranscript')), 'the transcript tab must be gone');
    assertEqual(refs().panel.find((n) => n.className === 'osum-thumb').length, 0, 'no video thumbnail card');
    assertEqual(refs().panel.find((n) => n.className === 'osum-video-title').length, 0, 'no video title card');
    assert(!refs().panel.textContent.includes(`v${OSUM.version}`), 'the version badge must not be shown');
    assert(!refs().panel.textContent.includes(OSUM.t('panelTitle')), 'the product name must not be repeated');
    // The provider/model/length row is folded away until the gear is pressed.
    assertEqual(refs().panel.find((n) => n.className === 'osum-select').length, 0, 'controls must be collapsed by default');
    panel.toggleQuickSettings(true);
    assert(refs().panel.find((n) => n.className === 'osum-select').length > 0, 'the gear must reveal the quick settings');
    panel.toggleQuickSettings(false);
    // The primary action is a symbol in the header; the transcript copy moved
    // to the bottom strip and must not sit next to the tabs.
    const header = refs().panel.find((n) => n.className === 'osum-head')[0];
    assert(header, 'the panel must render a header');
    assertEqual(header.find((n) => n.className.includes('osum-run')).length, 1, 'the run/refresh symbol belongs to the header');
    assertEqual(header.find((n) => n.attrs?.title === OSUM.t('copyTranscript')).length, 0, 'no transcript copy in the header');
    const footer = refs().panel.find((n) => n.className === 'osum-foot')[0];
    assert(footer, 'the panel must render a footer');
    assertEqual(footer.find((n) => n.attrs?.title === OSUM.t('copyTranscript')).length, 1, 'the transcript copy belongs to the footer');
    // Run details sits below the reading area, closed.
    const details = refs().panel.find((n) => n.className === 'osum-runs');
    assertEqual(details.length, 1, 'exactly one Run details block');
    assert(!details[0].attrs.open, 'Run details must start collapsed');
  });

  it('puts key moments and sections back in video order', () => {
    resetState();
    // Models answer in the order the ideas come to mind: 21:32 before 13:38.
    const result = normalizeResult(
      {
        keyPoints: [
          { text: 'Поздний момент', at: 1292 },
          { text: 'Ранний момент', at: 138 },
          { text: 'Момент без времени' },
        ],
        sections: [
          { heading: 'Поздний раздел', at: 1292 },
          { heading: 'Ранний раздел', at: 138 },
        ],
      },
      { mode: 'ai', videoId: 'dQw4w9WgXcQ', lang: 'ru', uiLang: 'ru' },
    );
    panel.setResult(result, {});
    assertEqual(result.keyPoints[0].at, 138, 'the earliest moment must come first');
    assertEqual(result.keyPoints[2].text, 'Момент без времени', 'untimed points stay last, not at 0:00');
    assertEqual(result.sections[0].heading, 'Ранний раздел', 'sections must follow the video too');
    const text = bodyText();
    assert(text.indexOf('Ранний момент') < text.indexOf('Поздний момент'), 'key moments must render in order');
    assert(text.indexOf('Ранний раздел') < text.indexOf('Поздний раздел'), 'sections must render in order');
  });

  it('makes the section heading itself seek, not only its timecode', () => {
    resetState();
    const result = normalizeResult(
      {
        keyPoints: [{ text: 'Ранний', at: 60 }],
        sections: [
          { heading: 'Середина', at: 300, summary: 'О чём раздел' },
          { heading: 'Без таймкода', summary: 'Тоже раздел' },
        ],
        timeline: [],
      },
      { mode: 'ai', videoId: 'dQw4w9WgXcQ', lengthSeconds: 600, lang: 'ru', uiLang: 'ru' },
    );
    panel.setResult(result, {});
    const titles = findNodes((n) => n.className === 'osum-section-title');
    assertEqual(titles.length, 2, 'every section heading is a title button');
    assert(titles[0].textContent.includes('Середина'), 'the words are inside the button');
    assert(titles[0].textContent.includes('5:00'), 'the timecode chip is part of the same button');
    assert(titles[0].textContent.includes('О чём раздел'), 'the summary paragraph is part of the same block');
    assertEqual(titles[0].attrs.role, 'button', 'the block announces itself as a button');
    assert(!titles[0].attrs['aria-disabled'], 'a timed heading can seek');
    assertEqual(titles[1].attrs['aria-disabled'], 'true', 'a heading without a timecode is not clickable');
    // The whole moment is one button: timecode and words together, so a click
    // on the sentence — not only on “1:00” — seeks.
    const moments = findNodes((n) => String(n.className).split(/\s+/).includes('osum-point'));
    assertEqual(moments.length, 1, 'a timed key point must be one seek block');
    assertEqual(moments[0].tagName, 'BUTTON', 'the whole moment is the button');
    assert(moments[0].textContent.includes('Ранний'), 'the link carries the whole sentence');
    assert(moments[0].textContent.includes('1:00'), 'the timecode is part of the same block');
    // The old video map is gone: it showed the shape of the video, not its content.
    assertEqual(findNodes((n) => String(n.className).includes('osum-map')).length, 0, 'no map remains');
  });

  it('writes one timecode for every point of the same moment', () => {
    resetState();
    const result = normalizeResult(
      {
        keyPoints: [
          { text: 'Зеленский не спал в первые дни', at: 56 },
          { text: 'Он был в бункере под офисом', at: 56 },
          { text: 'Армия выросла с 200 до 800 тысяч', at: 56 },
        ],
        sections: [
          {
            heading: 'Первые дни войны',
            at: 56,
            summary: 'О начале вторжения.',
            points: [{ text: 'Пункт того же момента', at: 56 }, { text: 'Более поздний факт', at: 120 }],
          },
        ],
      },
      { mode: 'ai', videoId: 'dQw4w9WgXcQ', lang: 'ru', uiLang: 'ru' },
    );
    panel.setResult(result, {});
    const moments = findNodes((n) => String(n.className).split(/\s+/).includes('osum-point'));
    // Key moment (one block), the heading's continuation (no timecode) and the
    // later point of the section.
    assertEqual(moments.length, 3, `expected three rendered moments, got ${moments.length}`);
    // Sections render before key moments, so the block is found by its text.
    const keyMoment = moments.find((n) => n.textContent.includes('Зеленский не спал'));
    assert(keyMoment, 'the key-moment block must be rendered');
    assertEqual(keyMoment.find((n) => n.className === 'osum-ts').length, 1, 'one timecode per moment');
    assertEqual(keyMoment.find((n) => n.className === 'osum-dot').length, 3, 'the points are a dotted list');
    for (const text of ['Зеленский не спал', 'Он был в бункере', 'Армия выросла']) {
      assert(keyMoment.textContent.includes(text), `the shared moment must keep “${text}”`);
    }
    const heading = moments.find((n) => n.textContent.includes('Пункт того же момента'));
    assert(heading, 'the continuation point stays under its heading');
    assert(!heading.textContent.includes('0:56'), 'the heading already carries the timecode');
  });

  it('saves the quick-settings choices instead of only changing the view', async () => {
    resetState();
    const sent = [];
    const original = chromeStub.runtime.sendMessage;
    chromeStub.runtime.sendMessage = async (message) => {
      sent.push(message);
      return respond(message);
    };
    try {
      panel.setOutput({ lang: 'en', length: 'detailed', summaryMode: 'timeline' });
      await tick();
      await tick();
    } finally {
      chromeStub.runtime.sendMessage = original;
    }
    const save = sent.find((message) => message.type === 'save-settings');
    assert(save, 'the choice must be sent to the background');
    assertEqual(save.patch.output.language, 'en');
    assertEqual(save.patch.output.length, 'detailed');
    assertEqual(save.patch.ai.summaryMode, 'timeline');
    assertEqual(OSUM.state.lang, 'en', 'the panel must reflect the saved language');
  });

  it('keeps the reading position when a new item re-renders the panel', () => {
    resetState();
    panel.setResult(JSON.parse(JSON.stringify(localFixture)), { cached: false });
    const before = refs().body;
    before.scrollTop = 120;
    panel.setState({ statusMessage: 'Ready items: 4 — the model is still writing' });
    assertEqual(refs().body.scrollTop, 120, 'a re-render must not jump back to the top');
  });

  it('does not render self-check questions the setting turned off', () => {
    resetState();
    OSUM.state.settings = { output: { selfCheck: false } };
    panel.setResult(JSON.parse(JSON.stringify(aiFixture)), {});
    assert(!bodyText().includes(OSUM.t('selfQuestions')), 'questions must be hidden when the setting is off');
    OSUM.state.settings = { output: { selfCheck: true } };
    panel.render();
    assert(bodyText().includes(OSUM.t('selfQuestions')), 'questions must come back when the setting is on');
  });

  it('keeps self-check questions off unless asked', () => {
    assertEqual(DEFAULT_SETTINGS.output.selfCheck, false, 'self-check is off by default');
    const plain = systemPrompt({});
    assert(plain.includes('questions: до 0'), 'the AI prompt must not spend output budget on questions');
    const asked = systemPrompt({ selfCheck: true });
    assert(asked.includes('questions: до 3'), 'enabling self-check must ask for questions again');

  });

  it('counts the remaining time down every second', async () => {
    resetState();
    panel.render();
    panel.setState({
      running: true,
      statusMessage: 'Модель пишет конспект',
      aiDiagnostics: { stage: 'map', budgetMs: 300000, remainingMs: 59000, deadlineAt: Date.now() + 59000 },
    });
    const read = () => {
      const line = refs().panel.find((n) => String(n.className).includes('osum-status-budget'))[0];
      const text = line ? line.textContent : '';
      const m = /(\d+):(\d\d)/.exec(text);
      return { text, seconds: m ? Number(m[1]) * 60 + Number(m[2]) : -1 };
    };
    const first = read();
    assert(first.seconds > 0, `the live line must carry an estimate: ${first.text}`);
    // Move the clock two seconds forward and run the panel's own interval.
    const realNow = Date.now;
    Date.now = () => realNow() + 2000;
    try {
      panel.tickBudget();
    } finally {
      Date.now = realNow;
    }
    const second = read();
    assert(second.seconds < first.seconds, `the estimate must drop over time: ${first.text} → ${second.text}`);
    resetState();
  });

  it('does not end the summary with a Recent block', () => {
    resetState();
    panel.setResult(JSON.parse(JSON.stringify(aiFixture)), {});
    assert(!refs().panel.textContent.includes(OSUM.t('recent')), 'history belongs to the popup, not the panel');
    assertEqual(findNodes((n) => n.attrs?.id === 'osum-recent').length, 0, 'no recent-list node');
  });

  it('styles every timestamp through the base rule, not only key points', () => {
    const css = String(OSUM.css || '');
    // Anchored to the start of a rule: `.osum-point .osum-ts { … }` is not the
    // base rule.
    const base = css.match(/^\s*\.osum-ts\s*\{([^}]*)\}/m);
    assert(base, 'a base .osum-ts rule must exist');
    assert(/color:\s*var\(--osum-accent\)/.test(base[1]), 'every timestamp must use the accent colour');
    assert(!/color:\s*(?:#fff|#ffffff|white)\b/.test(base[1]), 'no white timestamps on a dark panel');
  });

  it('highlights headings and points with a plate instead of an underline', () => {
    // Yandex's summariser paints the whole row; an underline across a wrapped
    // heading read as a broken link and was the reported complaint.
    const css = String(OSUM.css || '');
    const bodyOf = (selector) => {
      const at = css.indexOf(`${selector} {`);
      if (at === -1) return '';
      const from = css.indexOf('{', at) + 1;
      return css.slice(from, css.indexOf('}', from));
    };
    for (const selector of ['.osum-section-title:hover', '.osum-point:hover']) {
      const body = bodyOf(selector);
      assert(body, `${selector} rule must exist`);
      assert(body.includes('background: var(--osum-card)'), `${selector} must paint a plate`);
      assert(!body.includes('underline'), `${selector} must not underline the text`);
    }
    // Hovering the timecode alone must not underline it: the plate covers the
    // whole moment, and an underline under “4:04” read as a separate link.
    const tsHover = bodyOf('.osum-doc .osum-ts:hover');
    assert(tsHover, 'the reading-view timecode hover rule must exist');
    assert(!tsHover.includes('underline'), 'timecodes must never be underlined on hover');
  });

  it('renders the summary as a document, not a stack of cards', () => {
    resetState();
    panel.setResult(JSON.parse(JSON.stringify(aiFixture)), {});
    assertEqual(findNodes((n) => n.className === 'osum-doc').length, 1, 'the reading view must be one document');
    const css = String(OSUM.css || '');
    const tldr = css.match(/\.osum-doc \.osum-card-tldr\s*\{([^}]*)\}/);
    assert(tldr, 'the lead card must be flattened');
    assert(/background:\s*none/.test(tldr[1]), 'the lead must not keep an accent fill');
    const heading = css.match(/\.osum-doc \.osum-h\s*\{([^}]*)\}/);
    assert(heading && /text-transform:\s*none/.test(heading[1]), 'category labels must not be uppercase');
    // Takeaways are plain bullets; the chevron icons per line are gone.
    const bullets = findNodes((n) => n.className?.includes('osum-bullets'));
    assert(bullets.length >= 1, 'takeaways must use a bullet list');
    assertEqual(bullets[0].find((n) => n.className === 'osum-icon').length, 0, 'no icon per bullet line');
  });

  it('renders AI results with sections inside the overview', () => {
    resetState();
    panel.setResult(JSON.parse(JSON.stringify(aiFixture)), { cached: true, provider: PROVIDERS[0] });
    assert(bodyText().includes(aiFixture.tldr));
    assert(refs().panel.textContent.includes('Mock Free'), 'provider badge must show the AI provider in run details');

    // Sections are part of the overview: no second tab repeats the same list.
    assert(bodyText().includes('Введение'), 'the overview must render section headings');
    assert(bodyText().includes('Тезис раздела'), 'the overview must render section points');

    // The heading is the seek target, so the timecode and the words are one
    // control — not a number beside a label.
    const titles = findNodes((n) => n.className === 'osum-section-title');
    assert(titles.length >= 1, 'section headings must be clickable titles');
    assert(titles[0].textContent.includes('Введение'), 'the heading text stays intact');

    panel.setTab('ask');
    assert(bodyText().includes(OSUM.t('askEmpty')), 'ask tab must show the empty-state hint');
  });

  it('runs the AI engine through the task port and streams progress', async () => {
    resetState();
    const before = portCount;
    await panel.run({ force: true });
    assertEqual(OSUM.state.error, null, 'no error expected');
    assertEqual(OSUM.state.running, false, 'run must finish');
    assert(OSUM.state.result, 'a result must be stored');
    assert(portCount > before, 'the task port must be used for AI runs');
    assertEqual(OSUM.state.result.mode, 'ai');
    assertEqual(OSUM.state.result.model, 'mock-1');
    assert(bodyText().includes('Первый тезис с цифрой 42'), 'AI key points must be rendered');
    assertEqual(OSUM.state.streamingText, '', 'stream buffer must be cleared after the result');
    assert(OSUM.state.transcript?.segments?.length > 0, 'transcript must be cached in the panel');
  });

  it('keeps a thinking model alive on keepalive answers', async () => {
    resetState();
    // A reasoning model can stay silent for minutes before its first token. The
    // worker still answers keepalive pings meanwhile, so the panel must not
    // report “Фоновый процесс не ответил” and kill a healthy run: only pings
    // that never get an answer mean the worker is gone.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 30000 ? 60 : ms, ...rest);
    slowWorkerStub = { ms: 400, pongs: true };
    try {
      await panel.run({ force: true });
      assertEqual(OSUM.state.error, null, 'a worker that answers keepalive pings is alive');
      assert(OSUM.state.result, 'the summary must still be rendered');
    } finally {
      slowWorkerStub = null;
      globalThis.setTimeout = realSetTimeout;
      resetState();
    }
  });

  it('reports a worker that stops answering at all', async () => {
    resetState();
    // Silence is still a failure: no task events and no pong for the whole
    // window means the worker was torn down, and the user needs a retry.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 30000 ? 60 : ms, ...rest);
    slowWorkerStub = { ms: 400, pongs: false };
    try {
      await panel.run({ force: true });
    } finally {
      slowWorkerStub = null;
      globalThis.setTimeout = realSetTimeout;
    }
    assert(OSUM.state.error, 'a silent worker must end in an error card');
    assertEqual(OSUM.state.error.code, 'WORKER_SILENT');
    assertEqual(OSUM.state.result, null, 'a silent worker must not produce a result');
    resetState();
  });

  it('keeps the transcript it already holds when a forced refresh fails', async () => {
    resetState();
    // A slow connection: the first read succeeded, the retry cannot open the
    // panel any more and the worker is refused with PO-token. Throwing the
    // held transcript away turned a ready run into “дорожка защищена PO-token”
    // with the text still sitting in memory.
    OSUM.state.transcript = {
      segments: ruTranscript(),
      meta: { ...fixtureMeta({ videoId: 'dQw4w9WgXcQ' }), source: 'captions-ui' },
    };
    OSUM.state.transcriptMeta = OSUM.state.transcript.meta;
    transcriptErrorOverride = { __error: 'дорожка защищена PO-token', __code: 'POT_REQUIRED' };
    try {
      const before = portCount;
      await panel.run({ force: true });
      assert(portCount > before, 'the run must still reach the worker');
      assertEqual(OSUM.state.error, null, 'a held transcript must not become an error card');
      assert(OSUM.state.result, 'the summary must be rendered');
    } finally {
      transcriptErrorOverride = null;
    }
  });

  it('blames the page reason, not the worker budget, when neither route finds captions', async () => {
    resetState();
    // Both routes failed: the worker ran out of its 25 s bonus budget while the
    // page said “no transcript panel”. The card used to lead with the worker
    // budget — “Фоновый процесс не ответил, обновите вкладку” — and offered only
    // Retry, although the page error says exactly what to press.
    OSUM.state.videoId = 'dQw4w9WgXcQ';
    transcriptErrorOverride = { __error: 'Фоновый процесс не ответил', __code: 'WORKER_TIMEOUT' };
    try {
      await panel.run({ force: true });
    } finally {
      transcriptErrorOverride = null;
    }
    const st = OSUM.state;
    assert(st.error, 'the run must fail visibly');
    assertEqual(st.error.code, 'NO_PAGE_TRANSCRIPT', 'the page reason is the actionable one');
    const text = bodyText();
    assert(!text.includes(OSUM.t('workerSilent')), 'the worker budget must not become the headline');
    assert(text.includes(OSUM.t('transcriptFromPage')), 'the card must offer the page transcript');
    resetState();
  });

  it('renders validated streamed items before the single answer ends', async () => {
    resetState();
    let release = null;
    streamGate = new Promise((resolve) => { release = resolve; });
    streamItemStub = [
      { kind: 'tldr', text: 'Черновой TL;DR из потока о кэше и метриках.' },
      { kind: 'keyPoint', index: 0, point: { text: 'Первый потоковый пункт про Redis', at: 5, ts: '0:05' } },
    ];
    try {
      const running = panel.run({ force: true });
      // Two microtask turns: the mock worker emits the items, then waits on the gate.
      await tick();
      await tick();
      const st = OSUM.state;
      assert(st.streamDraft, 'a live draft must exist while the answer is still streaming');
      assertEqual(st.result, null, 'no final result may exist yet');
      const live = bodyText();
      assert(live.includes('Черновой TL;DR из потока'), `expected the streamed TL;DR, got: ${live.slice(0, 300)}`);
      assert(live.includes('Первый потоковый пункт про Redis'), 'expected the streamed key point');
      assert(!live.includes('"keyPoints"'), 'raw JSON must never be rendered');
      assert(st.statusMessage.includes('2'), `status must count the ready items, got: ${st.statusMessage}`);
      release();
      await running;
      assertEqual(OSUM.state.streamDraft, null, 'the draft must be replaced by the final result');
      assertEqual(OSUM.state.result.mode, 'ai');
      assert(!bodyText().includes('Черновой TL;DR из потока'), 'the provisional card must disappear');
    } finally {
      streamItemStub = null;
      streamGate = null;
      resetState();
    }
  });

  it('keeps the validated draft under an error, labelled as unfinished', async () => {
    resetState();
    // AUTH is not in AI_FALLBACK_CODES: the error card stays, and the draft
    // must be visible under it rather than silently disappearing.
    aiErrorOverride = { code: 'AUTH', message: 'Провайдер отклонил ключ', hint: 'Проверьте ключ' };
    streamItemStub = [{ kind: 'keyPoint', index: 0, point: { text: 'Уцелевший проверенный пункт', at: 12, ts: '0:12' } }];
    try {
      await panel.run({ force: true });
    } finally {
      aiErrorOverride = null;
      streamItemStub = null;
    }
    const st = OSUM.state;
    assert(st.error, 'the run must end with an error card');
    assert(st.streamDraft, 'validated items must survive a broken answer');
    assertEqual(st.result, null, 'a broken answer must not become a final result');
    assertEqual(st.aiDiagnostics?.complete, false, 'the run must not be marked complete');
    const text = bodyText();
    assert(text.includes('Уцелевший проверенный пункт'), `expected the validated item, got: ${text.slice(0, 300)}`);
    assert(text.includes(OSUM.t('streamProvisional')), 'the draft must be labelled as unfinished');
    resetState();
  });

  it('replaces the draft when a retry starts a new stream', async () => {
    resetState();
    let release = null;
    streamGate = new Promise((resolve) => { release = resolve; });
    streamItemStub = [
      { kind: 'tldr', text: 'Хвост оборванного ответа', streamId: 1 },
      { kind: 'keyPoint', index: 0, point: { text: 'Пункт из оборванного ответа', at: 1, ts: '0:01' }, streamId: 1 },
      { kind: 'tldr', text: 'Чистый ответ после повтора', streamId: 2 },
      { kind: 'keyPoint', index: 0, point: { text: 'Пункт из чистого ответа', at: 2, ts: '0:02' }, streamId: 2 },
    ];
    try {
      const running = panel.run({ force: true });
      await tick();
      await tick();
      const st = OSUM.state;
      assert(st.streamDraft, 'a draft must exist while the first answer is streaming');
      assertEqual(st.streamDraft.id, 2, 'the retried answer must own a new draft');
      assertEqual(st.streamDraft.tldr, 'Чистый ответ после повтора');
      assertEqual(st.streamDraft.points.length, 1, 'items from the dropped answer must not survive');
      assertEqual(st.streamDraft.points[0].text, 'Пункт из чистого ответа');
      release();
      await running;
    } finally {
      streamItemStub = null;
      streamGate = null;
      resetState();
    }
  });

  it('does not repeat an item the model sent twice', async () => {
    resetState();
    let release = null;
    streamGate = new Promise((resolve) => { release = resolve; });
    const point = { text: 'Один и тот же пункт', at: 5, ts: '0:05' };
    streamItemStub = [
      { kind: 'keyPoint', index: 0, point, streamId: 3 },
      { kind: 'keyPoint', index: 1, point: { ...point }, streamId: 3 },
    ];
    try {
      const running = panel.run({ force: true });
      await tick();
      await tick();
      assertEqual(OSUM.state.streamDraft.points.length, 1, 'an exact repeat must be shown once');
      assertEqual(OSUM.state.streamDraft.points[0].text, 'Один и тот же пункт');
      release();
      await running;
    } finally {
      streamItemStub = null;
      streamGate = null;
      resetState();
    }
  });

  it('shows the empty-result card when the AI answers without a summary', async () => {
    // The reported case: a model cut off by its output budget answers with valid
    // JSON, the run “succeeds” after minutes and the user sees stats but no
    // TL;DR and no key points. That must be a card with a hint, never a
    // “finished” screen full of empty boxes.
    resetState();
    aiResultOverride = normalizeResult(
      { tldr: '', keyPoints: [], sections: [] },
      { mode: 'ai', provider: 'Mock Free', model: 'mock-1', videoId: 'dQw4w9WgXcQ', lang: 'ru', uiLang: 'ru' },
    );
    aiResultOverride.stats = { words: 2802, aiCalls: 1 };
    try {
      await panel.run({ force: true });
    } finally {
      aiResultOverride = null;
    }
    const st = OSUM.state;
    assertEqual(st.result, null, 'an empty AI answer must not be stored as a result');
    assertEqual(st.error?.code, 'EMPTY_RESULT', 'the card must name the failure');
    const text = bodyText();
    assert(text.includes(OSUM.t('emptyAiResult')), `expected the empty-result title, got: ${text.slice(0, 200)}`);
    assert(text.includes(OSUM.t('emptyAiResultHint')), 'the hint must explain what to do');
    assertEqual(findNodes((n) => String(n.className || '').includes('osum-card-tldr')).length, 0, 'no empty TL;DR card may be rendered');
    const buttons = findNodes((n) => n.tagName === 'BUTTON').map((b) => b.textContent);
    assert(buttons.includes(OSUM.t('retry')), `expected a retry button, got ${buttons.join(' | ')}`);
    resetState();
  });

  it('switches from the transcript tab to the overview when a run starts', async () => {
    resetState();
    panel.setTab('transcript');
    await panel.run({ force: true });
    assertEqual(OSUM.state.tab, 'overview', 'the draft and the result must have a visible tab');
    assert(OSUM.state.result, 'the run must complete');
    assert(bodyText().includes(OSUM.state.result.tldr), 'the finished summary must be rendered');
    resetState();
  });

  it('keeps the summary already on screen when a later AI run fails', async () => {
    // A cached summary was displayed and the user pressed Refresh. The error
    // card used to replace the only readable result with a red box.
    resetState();
    panel.render();
    panel.setResult(JSON.parse(JSON.stringify(localFixture)), { cached: true });
    aiResultOverride = normalizeResult(
      { tldr: '', keyPoints: [], sections: [] },
      { mode: 'ai', provider: 'Mock Free', model: 'mock-1', videoId: 'dQw4w9WgXcQ', lang: 'ru', uiLang: 'ru' },
    );
    try {
      await panel.run({ force: true });
    } finally {
      aiResultOverride = null;
    }
    const st = OSUM.state;
    assertEqual(st.error?.code, 'EMPTY_RESULT', 'the card must carry the AI failure code');
    assertEqual(st.result?.tldr, localFixture.tldr, 'the existing result must survive');
    const text = bodyText();
    assert(text.includes(localFixture.tldr), 'the summary must still be rendered under the card');
    assert(text.includes(OSUM.t('emptyAiResult')), `expected the failure card, got: ${text.slice(0, 200)}`);
    resetState();
  });

  it('answers questions locally and with AI, showing sources', async () => {
    // With no provider configured the offline retrieval still answers: it quotes
    // the transcript instead of inventing a summary.
    resetState();
    const providers = OSUM.state.providers;
    panel.setState({ providers: [] });
    await panel.ask('О чём это видео?');
    assertEqual(OSUM.state.qaHistory.length, 2, 'question + answer');
    assert(OSUM.state.qaHistory[1].text.includes('Локальный ответ'));
    assert(bodyText().includes('Локальный ответ по транскрипту'), 'answer must be rendered');
    assert(bodyText().includes('Фрагменты из видео'), 'sources block must be rendered');

    resetState();
    panel.setState({ providers });
    await panel.ask('Какие выводы?');
    const answer = OSUM.state.qaHistory[1];
    assertEqual(answer.mode, 'ai');
    assert(answer.text.includes('ИИ-ответ'));
    assertEqual(answer.sources.length, 1);
    assert(bodyText().includes('ИИ-ответ'));
  });

  it('answers from the transcript when the AI Q&A fails', async () => {
    resetState();
    aiErrorOverride = { code: 'EMPTY_RESPONSE', message: 'Модель вернула пустой ответ', hint: 'Выберите другую модель' };
    try {
      await panel.ask('О чём видео?');
    } finally {
      aiErrorOverride = null;
    }
    assertEqual(OSUM.state.qaHistory.length, 2, 'question + answer');
    const answer = OSUM.state.qaHistory[1];
    assertEqual(answer.mode, 'local', 'the answer must come from the local search');
    assert(answer.text.includes('Локальный ответ по транскрипту'), `expected a local answer, got: ${answer.text}`);
    assert(answer.text.includes(OSUM.t('askProviderMissing')), 'the panel must say why the AI did not answer');
    assert(bodyText().includes('Локальный ответ по транскрипту'), 'the answer must be rendered');
    resetState();
  });

  it('renders an error card with hint, retry and settings actions', () => {
    resetState();
    panel.setError({ message: 'У этого видео нет субтитров', code: 'NO_CAPTIONS', hint: 'Включите CC на странице' });
    let text = bodyText();
    assert(text.includes('У этого видео нет субтитров'));
    assert(text.includes(OSUM.t('emptyTranscriptHint')), 'transcript hint must be visible');
    let buttons = findNodes((n) => n.tagName === 'BUTTON').map((b) => b.textContent);
    assert(buttons.includes('Повторить'), `retry button expected, got ${buttons.join(' | ')}`);

    panel.setError({ message: 'Ключ отклонён провайдером', code: 'AUTH', hint: 'Проверьте ключ в настройках', status: 401 });
    text = bodyText();
    assert(text.includes('Проверьте ключ в настройках'), 'custom hint must be visible');
    assert(text.includes('code: AUTH'), 'diagnostic details must include the error code');
    buttons = findNodes((n) => n.tagName === 'BUTTON').map((b) => b.textContent);
    assert(buttons.includes(OSUM.t('openSettings')), `settings action expected, got ${buttons.join(' | ')}`);
    resetState();
  });

  it('recognises the “show transcript” button in any interface language', () => {
    const label = (attrs) => {
      const node = new FakeNode('button');
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return OSUM.transcriptDom.matchesTranscriptLabel(node);
    };
    assert(label({ 'aria-label': 'Show transcript' }), 'English label must match');
    assert(label({ 'aria-label': 'Показать текст видео' }), 'Russian label must match');
    assert(label({ 'aria-label': 'Показать транскрипт' }), 'Russian transcript label must match');
    assert(label({ 'aria-label': 'Расшифровка видео' }), 'the new Russian panel label must match');
    assert(label({ 'aria-label': 'Показать расшифровку' }), 'inflected Russian labels must match too');
    assert(label({ 'aria-label': 'Mostrar transcripción' }), 'Spanish label must match');
    assert(label({ 'aria-label': '文字起こしを表示' }), 'Japanese label must match');
    assert(!label({ 'aria-label': 'Поделиться' }), 'unrelated buttons must not match');
    assert(!label({ 'aria-label': 'Save to playlist' }), 'unrelated English buttons must not match');
  });

  it('offers the on-page transcript when YouTube blocks the caption API', () => {
    resetState();
    panel.setError({
      message: 'YouTube не отдал текст субтитров: дорожка защищена PO-token',
      code: 'POT_REQUIRED',
      hint: 'Нажмите «Взять транскрипт со страницы».',
    });
    const buttons = findNodes((n) => n.tagName === 'BUTTON').map((b) => b.textContent);
    assert(buttons.includes(OSUM.t('transcriptFromPage')), `expected the page-transcript action, got ${buttons}`);
    assert(buttons.includes(OSUM.t('showYoutubeTranscript')), 'expected the YouTube panel action');
    assert(!buttons.includes(OSUM.t('pasteManually')), 'manual pasting was removed: nobody maintains that flow');
    assert(bodyText().includes('PO-token'), 'the hint must explain the cause');
  });

  it('parses transcript text when YouTube ships markup we do not know', () => {
    const parsed = OSUM.transcriptDom.parseTranscriptText(
      [
        'Показать текст видео',
        '0:00 Приветствую вас на канале',
        '0:06 Кэширование это способ сохранить результат',
        '0:06 Кэширование это способ сохранить результат',
        '1:02:03 Далёкий фрагмент',
        '',
        'не строка субтитров',
      ].join('\n'),
    );
    assertEqual(parsed.length, 3, `expected 3 segments, got ${parsed.length}`);
    assertEqual(parsed[0].start, 0);
    assertEqual(parsed[1].start, 6);
    assertEqual(parsed[1].dur, 3717, 'durations must be derived from the next timecode');
    assertEqual(parsed[2].start, 3723);
  });

  it('parses the “In this video → Transcript” panel layout', () => {
    // Shape taken from the current YouTube panel: the timecode sits on its own
    // line (and the same row is rendered twice while the list virtualises).
    const parsed = OSUM.transcriptDom.parseTranscriptText(
      [
        'В этом видео',
        'Эпизоды',
        'Расшифровка видео',
        'Поиск в расшифровке',
        '48:17',
        'Да это рофл, [__] какой-то.',
        '48:21',
        'Что, [__] Так нахуй ты мне одного челика-то скинул?',
        '48:32',
        'Я вернусь к нему и задоначу',
      ].join('\n'),
    );
    assertEqual(parsed.length, 3, `expected 3 segments, got ${parsed.length}`);
    assertEqual(parsed[0].start, 48 * 60 + 17);
    assertEqual(parsed[0].text, 'Да это рофл, [__] какой-то.');
    assertEqual(parsed[1].start, 48 * 60 + 21);
    assertEqual(parsed[1].dur, 11, 'duration comes from the next timecode');
    assertEqual(parsed[2].start, 48 * 60 + 32);
  });

  it('reads hour-long timecodes and counts them for the panel search', () => {
    // Document order is preserved: the panel already renders the rows in order.
    const text = ['1:02:03 Поздний фрагмент', '2:30 Средний фрагмент'].join('\n');
    const parsed = OSUM.transcriptDom.parseTranscriptText(text);
    assertEqual(parsed.length, 2);
    assertEqual(parsed[0].start, 3723, 'h:mm:ss must be parsed as hours');
    assertEqual(parsed[1].start, 150);
    assertEqual(OSUM.transcriptDom.countTimecodes(text), 2, 'timecode counting drives the panel search');
  });

  it('shows transcript hints in the panel language without mixing or repeating them', () => {
    resetState();
    panel.setError({
      message: 'YouTube не отдал текст субтитров: дорожка защищена PO-token',
      code: 'POT_REQUIRED',
      hint: 'подсказка из воркера (русская)',
    });
    let text = bodyText();
    assert(text.includes(OSUM.t('potRequiredHint')), 'the panel must show its own hint');
    assert(!text.includes('подсказка из воркера'), 'the worker hint must not be mixed in');
    assertEqual(text.split(OSUM.t('potRequiredHint')).length - 1, 1, 'the hint must appear once');

    panel.setError({ message: 'нет панели', code: 'POT_REQUIRED', pageError: 'NO_PAGE_TRANSCRIPT' });
    text = bodyText();
    assert(text.includes(OSUM.t('pageTranscriptFailedHint')), 'a missing page panel must be explained too');
    assertEqual(text.split(OSUM.t('potRequiredHint')).length - 1, 1, 'still no duplicated hint');
  });

  it('explains the two AI answer failures in the panel language', () => {
    resetState();
    // The classifier verdict and a prose answer are different problems with
    // different next steps; both must be explained by the panel, not by the
    // worker's Russian message, and both must offer the settings action.
    panel.setError({ message: 'Вместо конспекта модель вернула вердикт', code: 'MISROUTED_MODEL' });
    let text = bodyText();
    assert(text.includes(OSUM.t('misroutedModelHint')), 'the classifier hint must be localized');
    assert(text.includes(OSUM.t('openSettings')), 'a wrong model route must offer settings');
    assert(!text.includes('Вместо конспекта модель вернула вердикт'), 'the worker message must not replace the explanation');

    resetState();
    panel.setError({ message: 'Модель ответила текстом без JSON', code: 'BAD_JSON' });
    text = bodyText();
    assert(text.includes(OSUM.t('badJsonHint')), 'a prose answer must explain the retry');
    assert(text.includes(OSUM.t('openSettings')), 'a prose answer must offer settings');
    resetState();
  });

  it('falls back to the page transcript action and reports when it is missing', async () => {
    resetState();
    panel.setError({ message: 'Пустая дорожка', code: 'EMPTY_CAPTIONS' });
    await panel.useTranscriptFromPage();
    assertEqual(OSUM.state.error.code, 'NO_PAGE_TRANSCRIPT', 'a missing page panel must be reported');
    assert(bodyText().includes(OSUM.t('pageTranscriptFailed')), 'the error card must explain what to do');
    assertEqual(OSUM.state.running, false, 'the panel must not stay busy');
  });

  it('sends a page-read transcript with the request instead of asking the worker to fetch it again', async () => {
    // The reported bug: the panel read the transcript from the page, then the
    // worker fetched the captions for itself, hit the PO-token wall and the run
    // failed with “дорожка защищена PO-token” although the text was already here.
    resetState();
    Object.assign(OSUM.state, {
      mode: 'ai',
      videoId: 'dQw4w9WgXcQ',
      providerId: 'mock-free',
      model: 'mock-1',
      providers: PROVIDERS,
      lang: 'ru',
    });
    for (const source of ['page-capture', 'page-panel', 'page-api', 'dom-panel', 'paste-timed']) {
      OSUM.state.transcript = {
        segments: ruTranscript(),
        meta: fixtureMeta({ videoId: 'dQw4w9WgXcQ', source }),
      };
      OSUM.state.transcriptMeta = OSUM.state.transcript.meta;
      lastPort.posted.length = 0;
      await panel.run({});
      const sent = lastPort.posted.find((message) => message.type === 'ai-summary');
      assert(sent, `${source}: the run must start`);
      assert(
        Array.isArray(sent.input?.segments) && sent.input.segments.length > 0,
        `${source}: the transcript must travel with the request instead of being fetched again`,
      );
    }
    // A transcript the worker fetched itself is not shipped back to it.
    OSUM.state.transcript = {
      segments: ruTranscript(),
      meta: fixtureMeta({ videoId: 'dQw4w9WgXcQ', source: 'captions-auto:json3' }),
    };
    OSUM.state.transcriptMeta = OSUM.state.transcript.meta;
    lastPort.posted.length = 0;
    await panel.run({});
    const fetched = lastPort.posted.find((message) => message.type === 'ai-summary');
    assert(fetched && fetched.input.segments === undefined, 'worker transcripts are not sent back');
  });

  it('pulls a fresh model list from the provider into the panel', async () => {
    resetState();
    OSUM.state.providers = [{ id: 'mock-free', name: 'Mock Free', models: ['mock-1'], defaultModel: 'mock-1', hasKey: true }];
    OSUM.state.providerId = 'mock-free';
    OSUM.state.mode = 'ai';
    const originalSend = chromeStub.runtime.sendMessage;
    chromeStub.runtime.sendMessage = async (message) =>
      message.type === 'list-models' ? { ok: true, models: ['mock-1', 'brand/new-model:free'], count: 2 } : respond(message);
    try {
      await panel.loadModels(OSUM.state.providers[0]);
      assert(
        OSUM.state.providers[0].models.includes('brand/new-model:free'),
        `the live model must be merged in: ${OSUM.state.providers[0].models}`,
      );
      panel.toggleQuickSettings(true);
      const text = refs().panel.textContent;
      assert(text.includes('brand/new-model:free'), 'the model must appear in the quick settings');
      panel.toggleQuickSettings(false);
    } finally {
      chromeStub.runtime.sendMessage = originalSend;
    }
  });

  it('hides timestamps when the transcript was pasted without timecodes', () => {
    resetState();
    OSUM.state.transcriptMeta = { noTimestamps: true };
    panel.setResult(JSON.parse(JSON.stringify(localFixture)), {});
    assertEqual(OSUM.state.result.timeline.length, 0, 'timeline must be dropped');
    assert(
      OSUM.state.result.keyPoints.every((p) => p.at == null && p.ts == null),
      'key points must lose timestamps',
    );
    assert(OSUM.state.result.notes.includes('Таймстемпов нет'), 'a note must explain the missing timecodes');
    const timestamps = findNodes((n) => n.className === 'osum-ts');
    assertEqual(timestamps.length, 0, 'no timestamp buttons may be rendered');
  });

  it('copies the transcript from the header instead of rendering a fifth tab', async () => {
    resetState();
    OSUM.state.transcript = { segments: ruTranscript(), meta: fixtureMeta({ videoId: 'dQw4w9WgXcQ' }) };
    // An old saved state may still point at the removed tab.
    panel.setTab('transcript');
    assertEqual(OSUM.state.tab, 'overview', 'an unknown tab must fall back to the overview');
    assertEqual(findNodes((n) => n.className === 'osum-seg').length, 0, 'no transcript rows may be rendered');

    copied.length = 0;
    await panel.copyTranscript();
    assertEqual(copied.length, 1, 'the header button must copy the transcript');
    assert(/привет/i.test(copied[0]), `expected the transcript text, got: ${(copied[0] || '').slice(0, 80)}`);
  });

  it('parses pasted transcripts with and without timecodes', () => {
    const timed = OSUM.transcriptDom.parsePasted('00:05 Первая фраза\n00:12 Вторая фраза\n00:30 Третья фраза');
    assert(timed && timed.hasTimestamps, 'timed paste must be detected');
    assertEqual(timed.segments.length, 3);
    assertEqual(timed.segments[1].start, 12);

    const plain = OSUM.transcriptDom.parsePasted('Это просто текст без таймкодов. Вторая фраза здесь. И третья тоже есть.');
    assert(plain && plain.hasTimestamps === false, 'plain paste must be detected');
    assert(plain.segments.length >= 2, 'plain text must be split into segments');
    assertEqual(OSUM.transcriptDom.parsePasted('   '), null);
  });

  it('exports a diagnostic report without transcript, prompts or secrets', () => {
    resetState();
    const result = JSON.parse(JSON.stringify(aiFixture));
    result.mode = 'ai';
    result.provider = 'OpenRouter';
    result.model = 'openrouter/free';
    result.videoTitle = 'Диагностическое видео';
    result.meta = {
      ...(result.meta || {}),
      strategy: 'single',
      complete: true,
      diagnostics: {
        strategy: 'single',
        complete: true,
        requests: 1,
        retries: 0,
        stages: { single: 1 },
        fallbacks: [],
        providerMs: 4200,
        localMs: 55,
        jsonParseMs: 7,
        resultBuildMs: 4,
        totalMs: 4255,
        transcriptTokens: 5200,
        requestEstimatedTokens: 7600,
        outputLimit: 4096,
        chunks: [
          {
            stage: 'single',
            chunkId: '',
            ms: 4200,
            ttftMs: 900,
            genMs: 3300,
            in: 7000,
            out: 900,
            estimatedIn: 7600,
            attempts: 1,
            retries: 0,
            finish: 'stop',
            model: 'some/free-model',
            genId: 'gen-abc',
            json: 'direct',
            jsonOk: true,
            truncated: false,
            error: '',
          },
        ],
      },
    };
    const report = OSUM.exporter.diagnosticReport(result);
    assertEqual(report.kind, 'ai-run-diagnostic');
    assertEqual(report.diagnostics.chunks[0].genId, 'gen-abc');
    assertEqual(report.diagnostics.chunks[0].ttftMs, 900);
    assertEqual(report.diagnostics.requestEstimatedTokens, 7600);
    const text = JSON.stringify(report);
    assert(!text.includes(aiFixture.tldr), 'summary text must not be in the diagnostic report');
    assert(!text.includes('sk-'), 'no key material');
    assert(!text.includes('messages'), 'no prompt messages');

    panel.setResult(result, {});
    assert(refs().panel.textContent.includes('Диагностика'), 'the panel must offer a diagnostic export for AI runs');
  });

  it('shows the live job budget and a collapsed run report', () => {
    resetState();
    panel.render();
    panel.setState({
      running: true,
      statusMessage: 'Модель пишет конспект',
      aiDiagnostics: { stage: 'map', budgetMs: 300000, remainingMs: 120000, deadlineAt: Date.now() + 120000 },
    });
    // “Осталось ~2:00”, not “2:00 / 5:00”: a live estimate, not a fraction of a
    // budget the reader never asked about.
    assert(refs().panel.textContent.includes('Осталось ~2:00'), `live budget missing: ${refs().panel.textContent}`);
    assert(!refs().panel.textContent.includes('2:00 / 5:00'), 'the budget fraction must be gone');

    resetState();
    const result = JSON.parse(JSON.stringify(aiFixture));
    result.mode = 'ai';
    result.provider = 'Mock Free';
    result.model = 'mock-1';
    result.meta = {
      ...(result.meta || {}),
      strategy: 'map-reduce:partial',
      complete: false,
      diagnostics: {
        strategy: 'map-reduce',
        complete: false,
        finishReason: 'job-timeout',
        resumable: true,
        budgetMs: 300000,
        initialBudgetMs: 300000,
        remainingMs: 0,
        totalMs: 240000,
        requests: 5,
        retries: 1,
        providerSwitches: 1,
        fallbacks: ['Mock Free: SERVER — 500'],
        lastFallback: 'Mock Free: SERVER — 500',
        chunkCounts: { done: 4, failed: 1, cancelled: 0 },
        stageMs: { map: 180000, reduce: 55000 },
        chunks: [],
      },
    };
    panel.setResult(result, { provider: 'Mock Free' });
    const text = refs().panel.textContent;
    assert(text.includes(OSUM.t('runDetails')), `Run details summary missing: ${text.slice(0, 200)}`);
    assert(text.includes('Ход выполнения'), `run report missing: ${text}`);
    assert(text.includes('Первоначальный бюджет задания'), 'the report must show the initial budget');
    assert(text.includes('Прошло'), 'the finished report must show the elapsed time');
    assert(!text.includes('Осталось'), 'a finished run must not keep a countdown');
    assert(text.includes('таймаут задания'), 'the report must name the finish reason');
    assert(text.includes('частичный результат'), 'the report must not hide partial coverage');
    assert(text.includes('Повторный запуск продолжит'), 'a resumable run must say so');
  });

  it('shows validated map fragments in transcript order before the result', () => {
    resetState();
    Object.assign(OSUM.state, {
      mode: 'ai',
      running: true,
      progress: { done: 2, total: 3 },
      partialChunks: [
        { index: 2, startAt: 1200, endAt: 1800, partial: { points: [{ text: 'Третий фрагмент.', at: '20:00' }] } },
        { index: 0, startAt: 0, endAt: 600, partial: { points: [{ text: 'Первый фрагмент.', at: '0:10' }] } },
      ],
    });
    panel.render();
    const text = bodyText();
    assert(text.includes('Первый фрагмент.'), 'validated points must be visible immediately');
    assert(text.includes('Третий фрагмент.'), 'later completed fragments must be visible too');
    assert(text.indexOf('Фрагмент 1') < text.indexOf('Фрагмент 3'), 'chunks must follow transcript order');
    assert(text.includes('TL;DR появятся после полного прохода'), 'the provisional view must explain the pending final pass');
  });

  it('shows a failed fragment without hiding the fragments that succeeded', () => {
    resetState();
    Object.assign(OSUM.state, {
      mode: 'ai',
      running: true,
      progress: { done: 1, total: 2 },
      partialChunks: [
        { index: 0, startAt: 0, endAt: 600, partial: { points: [{ text: 'Готовый факт.', at: '0:10' }] } },
        { index: 1, startAt: 600, endAt: 1200, failed: true, reason: 'RATE_LIMIT: слишком много запросов' },
      ],
    });
    panel.render();
    const text = bodyText();
    assert(text.includes('Готовые фрагменты · 1/2'), `the counter must count only ready fragments: ${text}`);
    assert(text.includes('Готовый факт.'), 'a local failure must not hide ready fragments');
    assert(text.includes('Фрагмент не обработан'), 'the failed fragment must be labelled as such');
    assert(text.includes('RATE_LIMIT'), 'the failure reason must stay visible');
  });

  it('offers “Continue” only for an interrupted compatible job', async () => {
    const originalSend = chromeStub.runtime.sendMessage;
    const showResume = async () => {
      Object.assign(OSUM.state, {
        mode: 'ai',
        videoId: 'dQw4w9WgXcQ',
        providerId: 'mock-free',
        model: 'mock-1',
        providers: PROVIDERS,
        running: false,
        result: null,
      });
      panel.setModel('mock-1');
      await tick();
      await tick();
    };
    try {
      resetState();
      resumeJobStub = null;
      await showResume();
      assertEqual(refs().panel.find((n) => n.className?.includes('osum-resume-btn')).length, 0, 'no continue symbol without a saved job');

      resumeJobStub = {
        id: 'job-ui',
        status: 'interrupted',
        savedChunks: 2,
        totalChunks: 5,
        interruptionReason: 'job-timeout',
      };
      await showResume();
      const text = refs().panel.textContent;
      assertEqual(
        refs().panel.find((n) => n.className?.includes('osum-resume-btn')).length,
        1,
        `the continue symbol must appear in the header: ${text}`,
      );
      assert(text.includes('готовых фрагментов: 2 / 5'), 'the notice must show saved fragments');
      assert(text.includes('таймаут задания'), 'the interruption reason must be visible');
    } finally {
      resumeJobStub = null;
      chromeStub.runtime.sendMessage = originalSend;
    }
  });

  it('sends the saved job id when the user continues it', async () => {
    resetState();
    Object.assign(OSUM.state, {
      mode: 'ai',
      videoId: 'dQw4w9WgXcQ',
      providerId: 'mock-free',
      model: 'mock-1',
      providers: PROVIDERS,
      running: false,
      resumableJob: { id: 'job-ui', status: 'interrupted', savedChunks: 2, totalChunks: 5 },
    });
    await panel.run({ resume: true });
    const sent = lastPort.posted.find((m) => m.type === 'ai-summary');
    assert(sent, 'the panel must start the AI task');
    assertEqual(sent.resumeJobId, 'job-ui', 'the explicit continuation must name the saved job');
  });

  it('copies the summary through the worker renderer', async () => {
    resetState();
    panel.setResult(JSON.parse(JSON.stringify(aiFixture)), {});
    copied.length = 0;
    await OSUM.exporter.copyResult(OSUM.state.result);
    assertEqual(copied.length, 1, 'clipboard must receive the rendered markdown');
    assert(copied[0].includes('# Конспект'), 'worker-rendered markdown must be copied');
  });

  it('handles a long summary without errors', () => {
    resetState();
    const result = normalizeResult(
      {
        tldr: aiFixture.tldr,
        keyPoints: Array.from({ length: 40 }, (_, i) => ({
          text: `Пункт ${i + 1}: кэш хранит готовые ответы и экономит время запроса.`,
          at: `${Math.floor(i / 2)}:${String((i * 7) % 60).padStart(2, '0')}`,
        })),
        sections: Array.from({ length: 12 }, (_, i) => ({
          heading: `Раздел ${i + 1}: метрики кэша`,
          at: `0:${String(i * 5).padStart(2, '0')}`,
          points: [{ text: `Тезис раздела ${i + 1} о попаданиях в кэш.`, at: `0:${String(i * 5).padStart(2, '0')}` }],
        })),
        takeaways: ['Измеряйте попадания в кэш.'],
      },
      { mode: 'ai', provider: 'Mock Free', model: 'mock-1', videoId: 'dQw4w9WgXcQ', lengthSeconds: 3600, lang: 'ru', uiLang: 'ru' },
    );
    panel.setResult(result, {});
    panel.setTab('sections');
    panel.setTab('timeline');
    panel.setTab('overview');
    assert(OSUM.state.result.keyPoints.length > 0);
    assert(bodyText().length > 200, 'overview must render substantial text');
  });

  it('clears per-video state when the video changes', () => {
    resetState();
    panel.setResult(JSON.parse(JSON.stringify(aiFixture)), {});
    OSUM.state.qaHistory = [{ role: 'user', text: 'вопрос' }];
    panel.setVideoId('newVideoId1');
    assertEqual(OSUM.state.result, null, 'result must be reset for a new video');
    assertEqual(OSUM.state.qaHistory.length, 0, 'Q&A history must be reset for a new video');
  });

  it('stops a running summary on the click and ignores the late answer', async () => {
    resetState();
    Object.assign(OSUM.state, {
      mode: 'ai',
      videoId: 'dQw4w9WgXcQ',
      providerId: 'mock-free',
      model: 'mock-1',
      providers: PROVIDERS,
      running: false,
    });
    let release;
    streamGate = new Promise((resolve) => {
      release = resolve;
    });
    streamItemStub = [{ kind: 'keyPoint', point: { text: 'Тезис до остановки.', at: 12, ts: '0:12' } }];
    try {
      const run = panel.run({ force: true });
      for (let i = 0; i < 6; i++) await tick();
      assertEqual(OSUM.state.running, true, 'the run must be in flight');
      const port = lastPort;
      panel.cancel();
      // Stop is local first: the panel must not wait for the worker.
      assertEqual(OSUM.state.running, false, 'Stop must end the run synchronously');
      assertEqual(OSUM.state.statusMessage, 'отмена', 'the cancelled state must be visible at once');
      assert(
        port.posted.some((m) => m.type === 'cancel'),
        'the worker must be told to cancel the task',
      );
      assertEqual(port.disconnected, true, 'closing the port aborts the task in the worker');
      release();
      await run;
      assertEqual(OSUM.state.result, null, 'a late answer must never become the summary');
      assertEqual(OSUM.state.running, false, 'the panel must stay stopped');
      // The cancel flag must not leak: the next action works without a “stop”.
      OSUM.state.qaHistory = [];
      await panel.ask('Что было дальше?');
      assert(
        OSUM.state.qaHistory.some((m) => m.role === 'assistant' && m.mode === 'ai'),
        'Q&A must still work after a cancelled run',
      );
    } finally {
      streamItemStub = null;
      streamGate = null;
    }
  });

  it('shows map-phase points as they are validated, before the final answer', async () => {
    resetState();
    Object.assign(OSUM.state, {
      mode: 'ai',
      videoId: 'dQw4w9WgXcQ',
      providerId: 'mock-free',
      model: 'mock-1',
      providers: PROVIDERS,
      running: false,
    });
    let release;
    streamGate = new Promise((resolve) => {
      release = resolve;
    });
    mapItemStub = [
      { index: 0, startAt: 40, endAt: 900, point: { text: 'Первый тезис появляется сразу.', at: 125, ts: '2:05' } },
      { index: 1, startAt: 900, endAt: 1800, point: { text: 'Второй фрагмент тоже отдаёт тезис.', at: 905, ts: '15:05' } },
    ];
    try {
      const run = panel.run({ force: true });
      for (let i = 0; i < 8; i++) await tick();
      const text = bodyText();
      assert(text.includes('Первый тезис появляется сразу.'), `a live point must be on screen: ${text.slice(0, 300)}`);
      assert(text.includes('2:05'), 'the live point must keep its timecode');
      assert(text.includes('Фрагмент 1'), 'the point must be grouped under its fragment');
      assertEqual(OSUM.state.result, null, 'the final answer is still being written');
      release();
      await run;
      assert(OSUM.state.result?.tldr?.length > 0, 'the finished answer must still arrive');
    } finally {
      mapItemStub = null;
      streamGate = null;
    }
  });
});

/*
 * The transcript panel is scraped from whatever markup YouTube ships that week.
 * These tests build the *current* “In this video → Расшифровка видео” layout with
 * anonymous elements (no ytd-transcript-renderer anywhere) and run the real
 * scraper against it.
 */
describe('on-page transcript scraping', () => {
  const PANEL_ROWS = [
    ['48:17', 'Да это рофл, какой-то. Тем более это мужчина пишет.'],
    ['48:21', 'Что, так нахуй ты мне одного челика-то скинул?'],
    ['48:32', 'Я вернусь к нему и задоначу, даже если он начнёт с ней отношения.'],
    ['48:47', 'Второй фрагмент закончился, начинаем следующий блок.'],
    ['49:02', 'И ещё одна длинная реплика для проверки разбора строк.'],
    ['49:15', 'Финальная фраза панели.'],
  ];

  function buildPanel({ rows = PANEL_ROWS, wrapper = 'div', parent = documentStub.body } = {}) {
    const panel = new FakeNode('div');
    panel.setAttribute('data-kind', 'in-this-video');
    const title = new FakeNode('h2');
    title.textContent = 'В этом видео';
    panel.appendChild(title);
    const tabs = new FakeNode('div');
    for (const label of ['Эпизоды', 'Расшифровка видео']) {
      const tab = new FakeNode('button');
      tab.textContent = label;
      tabs.appendChild(tab);
    }
    panel.appendChild(tabs);
    const list = new FakeNode('div');
    for (const [time, text] of rows) {
      const item = new FakeNode(wrapper);
      const chip = new FakeNode('span');
      chip.setAttribute('class', 'time-chip');
      chip.textContent = time;
      const body = new FakeNode('div');
      body.textContent = text;
      item.append(chip, body);
      list.appendChild(item);
    }
    panel.appendChild(list);
    parent.appendChild(panel);
    OSUM.transcriptDom.resetCache();
    return panel;
  }

  it('scrapes the current panel without knowing its component names', async () => {
    const panelNode = buildPanel();
    try {
      const rows = OSUM.transcriptDom.rowsFromDom(documentStub);
      assertEqual(rows.rows.length, PANEL_ROWS.length, `expected every row, got ${rows.rows.length}`);
      assert(rows.container, 'the row list container must be found');

      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'the on-page transcript must be readable');
      assertEqual(payload.segments.length, PANEL_ROWS.length);
      assertEqual(payload.segments[0].start, 48 * 60 + 17);
      assertEqual(payload.segments[0].text, PANEL_ROWS[0][1], 'the timecode column must not leak into the text');
      assertEqual(payload.segments[1].dur, 11, 'durations come from the next row');
      assertEqual(payload.meta.source, 'dom-panel');
      assertEqual(payload.meta.lang, 'ru', 'the transcript language must be detected');
      assert(!payload.segments.some((s) => s.text.includes('Эпизоды')), 'panel chrome must not become a segment');
    } finally {
      panelNode.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  /** The right-hand column: related videos with duration badges (“1:14:51”). */
  function buildSidebar(durations = ['10:12', '20:44', '1:14:51', '33:48'], parent = documentStub.body) {
    const sidebar = new FakeNode('ytd-watch-next-secondary-results-renderer');
    const items = new FakeNode('div');
    for (const duration of durations) {
      const item = new FakeNode('ytd-compact-video-renderer');
      const thumb = new FakeNode('ytd-thumbnail');
      const badge = new FakeNode('ytd-thumbnail-overlay-time-status-renderer');
      const span = new FakeNode('span');
      span.textContent = duration;
      badge.appendChild(span);
      thumb.appendChild(badge);
      const title = new FakeNode('span');
      title.textContent = 'Рекомендованное видео ' + duration;
      item.append(thumb, title);
      items.appendChild(item);
    }
    sidebar.appendChild(items);
    parent.appendChild(sidebar);
    return sidebar;
  }

  it('never clicks the page toggle when the panel is already readable', async () => {
    const panelNode = buildPanel();
    const toggle = new FakeNode('button');
    toggle.textContent = 'Показать текст видео';
    let clicks = 0;
    toggle.click = () => {
      clicks++;
    };
    documentStub.body.appendChild(toggle);
    try {
      const opened = await OSUM.transcriptDom.openTranscriptPanel();
      assertEqual(opened.ok, true);
      assertEqual(opened.alreadyOpen, true);
      assertEqual(clicks, 0, 'the description toggle closes an open panel — it must not be clicked');
    } finally {
      toggle.remove();
      panelNode.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('reads the panel invisibly and puts the page back the way it was', async () => {
    // The reported bug: the extension opened YouTube's transcript panel in the
    // sidebar, the page jumped down, and the panel stayed on screen while the
    // summary was built. Reading the page is a background job, not a show.
    const rows = [
      ['5:19', '5 минут 19 секунд И вот тут началось'],
      ['5:21', '5 минут 21 секунд И продолжилось дальше'],
      ['5:26', '5 минут 26 секунд Первая партия мармелада'],
    ];
    const toggle = new FakeNode('button');
    toggle.textContent = 'Показать текст видео';
    let host = null;
    let ghostStyleWhileOpening = false;
    toggle.click = () => {
      if (host) return;
      host = new FakeNode('ytd-engagement-panel-section-list-renderer');
      host.setAttribute('target-id', 'engagement-panel-searchable-transcript');
      const header = new FakeNode('div');
      header.id = 'visibility-button';
      const close = new FakeNode('button');
      close.click = () => host.remove();
      header.appendChild(close);
      const list = new FakeNode('div');
      for (const [time, text] of rows) {
        const item = new FakeNode('div');
        const chip = new FakeNode('span');
        chip.textContent = time;
        const body = new FakeNode('div');
        body.textContent = text;
        item.append(chip, body);
        list.appendChild(item);
      }
      host.append(header, list);
      documentStub.body.appendChild(host);
      // The hiding style must already be in place before the panel exists in
      // the document, otherwise the panel paints for one frame.
      ghostStyleWhileOpening = !!documentStub.head.querySelector('#osum-quiet-transcript');
      // YouTube scrolls the page while the panel opens.
      globalThis.scrollY = 0;
    };
    documentStub.body.appendChild(toggle);
    globalThis.scrollY = 700;
    const scrollsBefore = scrollCalls.length;
    OSUM.transcriptDom.resetCache();
    try {
      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'the transcript must be read');
      assert(ghostStyleWhileOpening, 'the panel must be hidden before it appears');
      assertEqual(documentStub.head.querySelector('#osum-quiet-transcript'), null, 'the hiding style must be removed');
      assertEqual(documentStub.querySelector('[target-id*="transcript"]'), null, 'the panel must not stay in the page');
      assertEqual(host?.style?.cssText, '', 'the inline hiding styles must be reverted');
      const scrolls = scrollCalls.slice(scrollsBefore);
      assert(
        scrolls.some((options) => options && options.top === 700),
        `the page scroll must be restored, got ${scrolls.length} call(s)`,
      );
      assertEqual(payload.segments.length, 3);
      assertEqual(payload.segments[0].text, 'И вот тут началось', 'the spoken timecode must be dropped');
      assert(
        payload.segments.every((s) => !/\d+\s*минут/i.test(s.text)),
        `panel timecodes must not leak into the text: ${payload.segments.map((s) => s.text).join(' | ')}`,
      );
    } finally {
      toggle.remove();
      host?.remove();
      globalThis.scrollY = 0;
      OSUM.transcriptDom.resetCache();
    }
  });

  it('waits for a freshly loaded watch page to render its transcript control', async () => {
    // Real bug on a three-hour video: the summary started on a page that already
    // had the player but had not rendered the description or the “Show
    // transcript” button yet, so the scrape reported “no panel” immediately and
    // the whole run failed. A watch page deserves a moment to hydrate.
    const player = new FakeNode('div');
    player.id = 'movie_player';
    documentStub.body.appendChild(player);
    const rows = [
      ['1:02:03', 'Первый час позади, начинаем вторую часть'],
      ['1:02:07', 'И сразу продолжаем разговор'],
      ['1:02:15', 'Заключительная реплика панели'],
    ];
    let host = null;
    let toggle = null;
    const hydrating = setTimeout(() => {
      toggle = new FakeNode('button');
      toggle.textContent = 'Показать текст видео';
      toggle.click = () => {
        if (host) return;
        host = new FakeNode('ytd-engagement-panel-section-list-renderer');
        host.setAttribute('target-id', 'engagement-panel-searchable-transcript');
        const header = new FakeNode('div');
        header.id = 'visibility-button';
        const close = new FakeNode('button');
        close.click = () => host.remove();
        header.appendChild(close);
        const list = new FakeNode('div');
        for (const [time, text] of rows) {
          const item = new FakeNode('div');
          const chip = new FakeNode('span');
          chip.textContent = time;
          const body = new FakeNode('div');
          body.textContent = text;
          item.append(chip, body);
          list.appendChild(item);
        }
        host.append(header, list);
        documentStub.body.appendChild(host);
      };
      documentStub.body.appendChild(toggle);
    }, 350);
    OSUM.transcriptDom.resetCache();
    try {
      const started = Date.now();
      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'a watch page that is still rendering must not report “no transcript”');
      assert(
        Date.now() - started >= 250,
        `the reader must wait for the page to render, waited only ${Date.now() - started}ms`,
      );
      assertEqual(payload.segments.length, 3);
      assertEqual(payload.segments[0].start, 3600 + 2 * 60 + 3);
      assertEqual(documentStub.querySelector('[target-id*="transcript"]'), null, 'the panel must be closed again');
    } finally {
      clearTimeout(hydrating);
      player.remove();
      toggle?.remove();
      host?.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('undoes a page scroll that the site made while reading, not the reader', async () => {
    // YouTube scrolls the page itself (closing the panel, collapsing the
    // description). Counting that scroll as “the user took over” is what left
    // the page parked at the transcript after a run.
    const rows = [
      ['5:19', '5 минут 19 секунд И вот тут началось'],
      ['5:21', '5 минут 21 секунд И продолжилось дальше'],
      ['5:26', '5 минут 26 секунд Первая партия мармелада'],
    ];
    const toggle = new FakeNode('button');
    toggle.textContent = 'Показать текст видео';
    let host = null;
    toggle.click = () => {
      if (host) return;
      host = new FakeNode('ytd-engagement-panel-section-list-renderer');
      host.setAttribute('target-id', 'engagement-panel-searchable-transcript');
      const header = new FakeNode('div');
      header.id = 'visibility-button';
      const close = new FakeNode('button');
      close.click = () => host.remove();
      header.appendChild(close);
      const list = new FakeNode('div');
      for (const [time, text] of rows) {
        const item = new FakeNode('div');
        const chip = new FakeNode('span');
        chip.textContent = time;
        const body = new FakeNode('div');
        body.textContent = text;
        item.append(chip, body);
        list.appendChild(item);
      }
      host.append(header, list);
      documentStub.body.appendChild(host);
      globalThis.scrollY = 0;
    };
    documentStub.body.appendChild(toggle);
    globalThis.scrollY = 700;
    OSUM.transcriptDom.resetCache();
    try {
      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'the transcript must be read');
      // The site moves the page again while the panel is being torn down.
      globalThis.scrollY = 0;
      const before = scrollCalls.length;
      dispatchWindow('scroll');
      const scrolls = scrollCalls.slice(before);
      assert(
        scrolls.some((options) => options && options.top === 700),
        `a site-made scroll must be undone, got ${JSON.stringify(scrolls)}`,
      );
    } finally {
      toggle.remove();
      host?.remove();
      globalThis.scrollY = 0;
      OSUM.transcriptDom.resetCache();
    }
  });

  it('leaves the reader where they scrolled after a real gesture', async () => {
    const rows = [
      ['5:19', '5 минут 19 секунд И вот тут началось'],
      ['5:21', '5 минут 21 секунд И продолжилось дальше'],
      ['5:26', '5 минут 26 секунд Первая партия мармелада'],
    ];
    const toggle = new FakeNode('button');
    toggle.textContent = 'Показать текст видео';
    let host = null;
    toggle.click = () => {
      if (host) return;
      host = new FakeNode('ytd-engagement-panel-section-list-renderer');
      host.setAttribute('target-id', 'engagement-panel-searchable-transcript');
      const header = new FakeNode('div');
      header.id = 'visibility-button';
      const close = new FakeNode('button');
      close.click = () => host.remove();
      header.appendChild(close);
      const list = new FakeNode('div');
      for (const [time, text] of rows) {
        const item = new FakeNode('div');
        const chip = new FakeNode('span');
        chip.textContent = time;
        const body = new FakeNode('div');
        body.textContent = text;
        item.append(chip, body);
        list.appendChild(item);
      }
      host.append(header, list);
      documentStub.body.appendChild(host);
      globalThis.scrollY = 0;
    };
    documentStub.body.appendChild(toggle);
    globalThis.scrollY = 700;
    OSUM.transcriptDom.resetCache();
    try {
      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'the transcript must be read');
      // A wheel turn is the reader taking over: their position wins.
      dispatchWindow('wheel');
      globalThis.scrollY = 320;
      const before = scrollCalls.length;
      dispatchWindow('scroll');
      assertEqual(
        scrollCalls.slice(before).some((options) => options && options.top === 700),
        false,
        'the reader must not be pulled back to where the run started',
      );
    } finally {
      toggle.remove();
      host?.remove();
      globalThis.scrollY = 0;
      OSUM.transcriptDom.resetCache();
    }
  });

  it('sends what the scraper saw to the background journal', async () => {
    const original = chromeStub.runtime.sendMessage;
    const sent = [];
    chromeStub.runtime.sendMessage = async (message) => {
      sent.push(message);
      return { ok: true };
    };
    try {
      OSUM.transcriptDom.resetCache();
      const payload = await OSUM.transcriptDom.getTranscript({});
      assertEqual(payload, null, 'no panel on an empty page');
      await tick();
      const report = sent.find((m) => m?.type === 'journal');
      assert(report, `a journal report must be sent, got ${sent.map((m) => m?.type).join(',')}`);
      assertEqual(report.event.route, 'page-panel');
      assertEqual(report.event.code, 'NO_PAGE_TRANSCRIPT');
      assert(report.event.message.includes('panel='), 'the report must carry the scraper counters');
    } finally {
      chromeStub.runtime.sendMessage = original;
      OSUM.transcriptDom.resetCache();
    }
  });

  it('reports what the scraper saw when no panel is found', async () => {
    const info = OSUM.transcriptDom.diagnose();
    for (const key of ['panel', 'rows', 'rowsUnfiltered', 'timecodeCells', 'segments', 'duration']) {
      assert(key in info, `diagnose() must expose ${key}`);
    }
    assertEqual(info.panel, false, 'no panel on an empty page');
  });

  it('reads a transcript docked in the sidebar column next to recommendations', async () => {
    // YouTube renders the transcript panel inside #secondary-inner on the docked
    // layout: the column must not be excluded, only the recommendation cards.
    const sidebar = buildSidebar(['10:12', '20:44', '1:14:51'], secondaryInner);
    const panelNode = buildPanel({ parent: secondaryInner });
    try {
      const rows = OSUM.transcriptDom.rowsFromDom(documentStub).rows;
      assertEqual(rows.length, PANEL_ROWS.length, `docked panel rows expected, got ${rows.length}`);
      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'a panel docked next to recommendations must still be readable');
      assertEqual(payload.segments[0].text, PANEL_ROWS[0][1]);
    } finally {
      sidebar.remove();
      panelNode.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('ignores related-video duration badges when a transcript panel is open', async () => {
    const sidebar = buildSidebar();
    const panelNode = buildPanel();
    try {
      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'the panel transcript must still be found next to the sidebar');
      assertEqual(payload.segments.length, PANEL_ROWS.length, `sidebar badges leaked in: ${payload.segments.length} segments`);
      assert(
        payload.segments.every((s) => !s.text.includes('Рекомендованное видео')),
        'recommended videos must never end up in the transcript',
      );
      assertEqual(payload.segments[0].start, 48 * 60 + 17);
    } finally {
      sidebar.remove();
      panelNode.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('refuses to export recommendations when there is no transcript at all', async () => {
    const sidebar = buildSidebar();
    try {
      assertEqual(OSUM.transcriptDom.rowsFromDom(documentStub).rows.length, 0, 'duration badges are not rows');
      assertEqual(await OSUM.transcriptDom.getTranscript({}), null, 'no panel means no transcript');
    } finally {
      sidebar.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('rejects rows whose timecodes cannot belong to this video', async () => {
    const clock = new FakeNode('span');
    clock.className = 'ytp-time-duration';
    clock.textContent = '24:40';
    documentStub.body.appendChild(clock);
    const panelNode = buildPanel({
      rows: [
        ['1:14:51', 'Фрагмент из другого видео, которое длиннее этого'],
        ['1:14:54', 'И ещё один фрагмент оттуда же'],
        ['1:14:58', 'Третий фрагмент'],
      ],
    });
    try {
      assertEqual(await OSUM.transcriptDom.getTranscript({}), null, 'timecodes past the video length must invalidate the scrape');
    } finally {
      panelNode.remove();
      clock.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('rejects a “transcript” that is really a list of video titles', async () => {
    // The reported bug: 24:40 video, 157 words, source: dom-panel.
    const clock = new FakeNode('span');
    clock.className = 'ytp-time-duration';
    clock.textContent = '24:40';
    documentStub.body.appendChild(clock);
    const panelNode = buildPanel({
      rows: [
        ['20:23', 'назадВ эфиреПлейлист Микс Svampe Alkemi - Raritäten XX-XXV full album, 2025 DEATH FETISH7,4 тыс. • 10 мес.'],
        ['20:44', 'назадВ эфиреПлейлист Микс У Трампа сдают нервы перед выборами.'],
        ['20:47', 'назадВ эфиреПлейлист Микс GTA 6\'s Development Hell2kliksphilip97 тыс. • 1 дн.'],
      ],
    });
    try {
      assertEqual(await OSUM.transcriptDom.getTranscript({}), null, 'a few titles must never be exported as a transcript');
    } finally {
      panelNode.remove();
      clock.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('reads timecode cells with punctuation, but not chapter titles', async () => {
    const panel = new FakeNode('div');
    const list = new FakeNode('div');
    const entries = [
      ['48:17 •', 'Первая реплика панели'],
      ['— 48:21', 'Вторая реплика панели'],
      ['48:32', 'Третья реплика панели'],
      ['0:00 Вступление', 'это заголовок главы, а не таймкод'],
    ];
    for (const [time, text] of entries) {
      const item = new FakeNode('div');
      const chip = new FakeNode('span');
      chip.textContent = time;
      const body = new FakeNode('div');
      body.textContent = text;
      item.append(chip, body);
      list.appendChild(item);
    }
    panel.appendChild(list);
    documentStub.body.appendChild(panel);
    OSUM.transcriptDom.resetCache();
    try {
      const rows = OSUM.transcriptDom.rowsFromDom(documentStub).rows;
      assertEqual(rows.length, 3, `chapter titles must not count as rows, got ${rows.length}`);
      assertEqual(rows[0].at, 48 * 60 + 17);
      assertEqual(rows[0].text, 'Первая реплика панели');
      assertEqual(rows[1].at, 48 * 60 + 21);
    } finally {
      panel.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('reads every virtualised block instead of just the first one', async () => {
    // The reported bug: 172 timecode cells on screen, but only 8 rows read, so
    // the panel looked 20× shorter than the video. Rows are nested in blocks of
    // eight inside one list; the scraper must not stop at the nearest block.
    const panel = new FakeNode('div');
    panel.setAttribute('target-id', 'engagement-panel-searchable-transcript');
    const list = new FakeNode('div');
    for (let block = 0; block < 3; block++) {
      const wrapper = new FakeNode('div');
      for (let i = 0; i < 8; i++) {
        const item = new FakeNode('div');
        const chip = new FakeNode('span');
        chip.textContent = `48:${String(10 + block * 8 + i).padStart(2, '0')}`;
        const body = new FakeNode('div');
        body.textContent = `Реплика ${block * 8 + i + 1} панели транскрипта`;
        item.append(chip, body);
        wrapper.appendChild(item);
      }
      list.appendChild(wrapper);
    }
    panel.appendChild(list);
    documentStub.body.appendChild(panel);
    OSUM.transcriptDom.resetCache();
    try {
      const { rows, container } = OSUM.transcriptDom.rowsFromDom(documentStub);
      assertEqual(rows.length, 24, `every block must be read, got ${rows.length} rows`);
      assertEqual(container, list, 'the container must be the list, not the first block');
      assertEqual(rows[0].text, 'Реплика 1 панели транскрипта', 'block text must not leak into a row');
      assertEqual(rows[23].at, 48 * 60 + 33);
    } finally {
      panel.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('reads the panel rendered as yt-section-list-renderer items', async () => {
    // The layout from the user's screenshot: yt-section-list-renderer → #contents
    // → wrapper → yt-item-section-renderer, one item per line. Reading that
    // component is exact, so the timecode heuristics are not involved at all.
    const clock = new FakeNode('span');
    clock.className = 'ytp-time-duration';
    clock.textContent = '0:40';
    documentStub.body.appendChild(clock);

    const panel = new FakeNode('div');
    panel.setAttribute('target-id', 'engagement-panel-searchable-transcript');
    const list = new FakeNode('yt-section-list-renderer');
    list.setAttribute('data-target-id', '');
    const contents = new FakeNode('div');
    contents.setAttribute('id', 'contents');
    const rows = [
      ['0:05', 'Первая фраза расшифровки'],
      ['0:11', 'Вторая фраза расшифровки'],
      ['0:18', 'Третья фраза расшифровки'],
      ['0:24', 'Четвёртая фраза расшифровки'],
      ['0:31', 'Пятая фраза расшифровки'],
      ['0:37', 'Шестая фраза расшифровки'],
      // A badge from the sidebar rendered through the same component: hours past
      // the end of a 33-minute video. It must be dropped, not reject the scrape.
      ['4:01:07', 'Рекомендованное видео'],
    ];
    for (const [time, text] of rows) {
      const holder = new FakeNode('div');
      const item = new FakeNode('yt-item-section-renderer');
      item.setAttribute('data-target-id', '');
      const chip = new FakeNode('span');
      chip.textContent = time;
      const body = new FakeNode('div');
      body.textContent = text;
      item.append(chip, body);
      holder.appendChild(item);
      contents.appendChild(holder);
    }
    list.appendChild(contents);
    panel.appendChild(list);
    documentStub.body.appendChild(panel);
    OSUM.transcriptDom.resetCache();
    try {
      const found = OSUM.transcriptDom.rowsFromDom(documentStub);
      assertEqual(found.rows.length, rows.length, `every item must be read, got ${found.rows.length}`);
      assertEqual(found.container, list, 'the container must be the section list');
      assertEqual(found.rows[0].text, rows[0][1], 'the timecode must not leak into the row text');

      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'the transcript must be readable');
      assertEqual(payload.segments.length, rows.length - 1, 'the 4-hour badge must be trimmed, not fatal');
      assertEqual(payload.segments[0].start, 5);
    } finally {
      panel.remove();
      clock.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('finds the transcript tab in the panel header, not inside the row list', async () => {
    // The reported layout: yt-section-list-renderer with #header (tabs) and
    // #contents (ten chapter rows). Searching tabs inside the list found none,
    // so the panel stayed on “Эпизоды” and reported tab=no-tab.
    const panel = new FakeNode('ytd-engagement-panel-section-list-renderer');
    panel.setAttribute('target-id', 'engagement-panel-searchable-transcript');
    const header = new FakeNode('div');
    header.setAttribute('id', 'header');
    const episodesTab = new FakeNode('button');
    episodesTab.setAttribute('role', 'tab');
    episodesTab.textContent = 'Эпизоды';
    const transcriptTab = new FakeNode('button');
    transcriptTab.setAttribute('role', 'tab');
    transcriptTab.textContent = 'Расшифровка видео';
    header.append(episodesTab, transcriptTab);
    panel.appendChild(header);

    const list = new FakeNode('yt-section-list-renderer');
    const contents = new FakeNode('div');
    contents.setAttribute('id', 'contents');
    for (let i = 0; i < 10; i++) {
      const holder = new FakeNode('div');
      const item = new FakeNode('yt-item-section-renderer');
      const chip = new FakeNode('span');
      chip.textContent = `${i * 3}:00`;
      const body = new FakeNode('div');
      body.textContent = `Глава ${i + 1}`;
      item.append(chip, body);
      holder.appendChild(item);
      contents.appendChild(holder);
    }
    list.appendChild(contents);
    panel.appendChild(list);
    documentStub.body.appendChild(panel);

    transcriptTab.click = () => {
      while (contents.firstChild) contents.removeChild(contents.firstChild);
      for (const [time, text] of PANEL_ROWS) {
        const holder = new FakeNode('div');
        const item = new FakeNode('yt-item-section-renderer');
        const chip = new FakeNode('span');
        chip.textContent = time;
        const body = new FakeNode('div');
        body.textContent = text;
        item.append(chip, body);
        holder.appendChild(item);
        contents.appendChild(holder);
      }
    };
    OSUM.transcriptDom.resetCache();
    try {
      const before = OSUM.transcriptDom.rowsToSegments(OSUM.transcriptDom.rowsFromDom(documentStub).rows);
      assertEqual(before.length, 10, `the chapters tab must be seen first, got ${before.length}`);
      assertEqual(await OSUM.transcriptDom.switchToTranscriptTab(before), true, 'the header tab must be found and clicked');

      const payload = await OSUM.transcriptDom.getTranscript({});
      assert(payload, 'the transcript must be readable after the switch');
      assertEqual(payload.segments.length, PANEL_ROWS.length);
      assertEqual(payload.segments[0].text, PANEL_ROWS[0][1]);
    } finally {
      panel.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('switches an open panel from its chapters tab to the transcript tab', async () => {
    const panel = new FakeNode('div');
    panel.setAttribute('target-id', 'engagement-panel-searchable-transcript');
    const tabs = new FakeNode('div');
    const chaptersTab = new FakeNode('button');
    chaptersTab.setAttribute('role', 'tab');
    chaptersTab.textContent = 'Эпизоды';
    const transcriptTab = new FakeNode('button');
    transcriptTab.setAttribute('role', 'tab');
    transcriptTab.textContent = 'Расшифровка видео';
    tabs.append(chaptersTab, transcriptTab);
    panel.appendChild(tabs);

    const list = new FakeNode('div');
    const chapters = new FakeNode('div');
    for (const [time, title] of [
      ['0:00', 'Вступление'], ['2:10', 'Первый раздел'], ['7:45', 'Второй раздел'], ['12:00', 'Итоги'],
      ['18:20', 'Пятый раздел'], ['24:10', 'Шестой раздел'], ['30:00', 'Седьмой раздел'], ['34:40', 'Выводы'],
    ]) {
      const item = new FakeNode('div');
      const chip = new FakeNode('span');
      chip.textContent = time;
      const body = new FakeNode('div');
      body.textContent = title;
      item.append(chip, body);
      chapters.appendChild(item);
    }
    list.appendChild(chapters);
    panel.appendChild(list);
    transcriptTab.click = () => {
      if (!chapters.parentNode) return;
      chapters.remove();
      const rows = new FakeNode('div');
      for (const [time, text] of PANEL_ROWS) {
        const item = new FakeNode('div');
        const chip = new FakeNode('span');
        chip.textContent = time;
        const body = new FakeNode('div');
        body.textContent = text;
        item.append(chip, body);
        rows.appendChild(item);
      }
      list.appendChild(rows);
    };
    documentStub.body.appendChild(panel);
    OSUM.transcriptDom.resetCache();
    try {
      const before = OSUM.transcriptDom.rowsToSegments(OSUM.transcriptDom.rowsFromDom(documentStub).rows);
      assertEqual(before.length, 8, `the chapters tab must be what the scraper sees first, got ${before.length}`);
      assertEqual(await OSUM.transcriptDom.switchToTranscriptTab(before), true, 'the transcript tab must be clicked');
      const rows = OSUM.transcriptDom.rowsFromDom(documentStub).rows;
      assertEqual(rows.length, PANEL_ROWS.length, `transcript rows expected after the switch, got ${rows.length}`);
      assertEqual(rows[0].text, PANEL_ROWS[0][1]);
    } finally {
      panel.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('never mistakes a chapters list for a transcript', async () => {
    const chapters = new FakeNode('ytd-macro-markers-list-item-renderer');
    const list = new FakeNode('div');
    for (const [time, text] of [['0:00', 'Вступление'], ['2:10', 'Первый раздел'], ['7:45', 'Второй раздел'], ['12:00', 'Итоги']]) {
      const item = new FakeNode('div');
      const chip = new FakeNode('span');
      chip.textContent = time;
      const title = new FakeNode('div');
      title.textContent = text;
      item.append(chip, title);
      list.appendChild(item);
    }
    chapters.appendChild(list);
    documentStub.body.appendChild(chapters);
    OSUM.transcriptDom.resetCache();
    try {
      assertEqual(OSUM.transcriptDom.rowsFromDom(documentStub).rows.length, 0, 'chapters are not a transcript');
      assertEqual(await OSUM.transcriptDom.getTranscript({}), null, 'the fallback must decline instead of exporting chapters');
    } finally {
      chapters.remove();
      OSUM.transcriptDom.resetCache();
    }
  });

  it('keeps wrapped rows together when only the text is available', () => {
    const parsed = OSUM.transcriptDom.parseTranscriptText(
      ['48:17', 'Да это рофл, какой-то.', 'Тем более это мужчина пишет.', '48:21', 'Что, так нахуй ты мне одного челика-то скинул?'].join('\n'),
    );
    assertEqual(parsed.length, 2, `expected 2 segments, got ${parsed.length}`);
    assertEqual(parsed[0].text, 'Да это рофл, какой-то. Тем более это мужчина пишет.');
    assertEqual(parsed[1].start, 48 * 60 + 21);
  });

  it('keeps timestamps when the panel text is pasted as is', () => {
    const pasted = OSUM.transcriptDom.parsePasted(PANEL_ROWS.map(([time, text]) => `${time}\n${text}`).join('\n'));
    assert(pasted && pasted.hasTimestamps, 'a two-line paste must keep its timecodes');
    assertEqual(pasted.segments.length, PANEL_ROWS.length);
    assertEqual(pasted.segments[0].start, 48 * 60 + 17);
  });
});
