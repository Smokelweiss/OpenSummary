/**
 * Background integration tests: the real router + tasks + storage stack running
 * against an in-memory `chrome` stub. This covers the message contracts the UI
 * relies on (get-state, save-settings, providers, cache, history, export/import)
 * and the AI task port (progress events, cancellation).
 *
 * The chrome stub is installed before the background modules are imported,
 * because `src/common/compat.js` captures the global API object once.
 */

import { describe, it, assert, assertEqual, assertDeepEqual } from './helpers.mjs';
import { ruTranscript, longTranscript, meta } from './fixtures.mjs';

/* ------------------------------------------------------------------- stubs */

function makeStorageArea() {
  const map = new Map();
  return {
    _map: map,
    get: async (key) => {
      if (key == null) return Object.fromEntries(map);
      if (typeof key === 'string') return map.has(key) ? { [key]: map.get(key) } : {};
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (map.has(k)) out[k] = map.get(k);
        return out;
      }
      const out = {};
      for (const [k, fallback] of Object.entries(key)) out[k] = map.has(k) ? map.get(k) : fallback;
      return out;
    },
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj || {})) {
        map.set(k, v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
      }
    },
    remove: async (key) => {
      for (const k of Array.isArray(key) ? key : [key]) map.delete(k);
    },
    clear: async () => map.clear(),
  };
}

let msgListener = null;
let connectListener = null;
const tabsState = [];
const createdDownloads = [];
let openedOptions = 0;

function makeChromeStub() {
  return {
    runtime: {
      id: 'osum-test-extension',
      getURL: (path) => `chrome-extension://osum-test-extension/${String(path).replace(/^\/+/, '')}`,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (fn) => { msgListener = fn; } },
      onConnect: { addListener: (fn) => { connectListener = fn; } },
      onSuspend: { addListener: () => {} },
      sendMessage: async () => {
        throw new Error('no receiver in the test stub');
      },
      openOptionsPage: async () => { openedOptions++; },
    },
    storage: {
      local: makeStorageArea(),
      session: makeStorageArea(),
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async (filter = {}) => (filter.active ? [] : tabsState.slice()),
      sendMessage: async (tabId, message) => ({ ok: true, tabId, received: message?.type || '' }),
      create: async (opts) => {
        const tab = { id: tabsState.length + 10, url: opts?.url || '', active: !!opts?.active };
        tabsState.push(tab);
        return tab;
      },
      update: async (id, opts) => {
        const tab = tabsState.find((t) => t.id === id);
        if (tab && opts?.url) tab.url = opts.url;
        return tab || { id };
      },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: { executeScript: async () => [{ result: true }] },
    contextMenus: { create: () => {}, removeAll: async () => {}, onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
    downloads: {
      download: async (opts) => {
        createdDownloads.push(opts);
        return createdDownloads.length;
      },
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
      getAll: async () => ({ origins: ['https://api.example.com/*'] }),
    },
    windows: { update: async () => {} },
  };
}

globalThis.chrome = makeChromeStub();

const { dispatch } = await import('../src/background/router.js');
await import('../src/background/service-worker.js');
const { registerTaskPort } = await import('../src/background/tasks.js');
const { MSG, EV, PORT, APP } = await import('../src/common/constants.js');
const {
  getSettings,
  saveSettings,
  getProviders,
  upsertProvider,
  exportAll,
  importAll,
  addHistory,
  setApiKey,
  getApiKey,
  getApiKeys,
} = await import('../src/common/storage.js');
const { loadTranscript } = await import('../src/background/transcripts.js');
const { recordJournal, readJournal, loadJournal, flushJournal, journalLines, JOURNAL_LIMIT } = await import(
  '../src/common/journal.js'
);

/* ------------------------------------------------------------------ helpers */

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function resetAll() {
  const { wipeAll } = await import('../src/common/storage.js');
  await wipeAll();
  await saveSettings({ reset: true });
}

async function send(message) {
  const res = await dispatch(message, {});
  if (res && typeof res === 'object' && res.__error) {
    const err = new Error(res.__error);
    err.code = res.__code;
    err.data = res.__data;
    throw err;
  }
  return res;
}

function errorOf(res) {
  return res?.__code || '';
}

const TEST_PROVIDER = {
  id: 'p-test',
  name: 'Test Provider',
  type: 'openai',
  baseUrl: 'http://127.0.0.1:9999/v1',
  models: ['test-model'],
  defaultModel: 'test-model',
  authScheme: 'bearer',
  enabled: true,
};

const SUMMARY_JSON = {
  tldr: 'Видео объясняет, как работает локальный движок и ИИ-конвейер расширения.',
  keyPoints: [
    { text: 'Локальный режим работает офлайн по субтитрам.', at: '0:05' },
    { text: 'ИИ-режим поддерживает десятки провайдеров моделей.', at: '0:20' },
  ],
  sections: [{ heading: 'Движки', at: '0:00', summary: 'Два режима.', points: [{ text: 'Локальный и ИИ.', at: '0:03' }] }],
  takeaways: ['Ключи хранятся только в браузере.'],
  actionItems: [],
  questions: [],
  quotes: [],
  keywords: [{ term: 'движок', score: 0.8 }],
  sentiment: { label: 'neutral', score: 0 },
};

function openAiResponse(content = JSON.stringify(SUMMARY_JSON)) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 240 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function openAiSseResponse(content = JSON.stringify(SUMMARY_JSON)) {
  const encoder = new TextEncoder();
  const step = 60;
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < content.length; i += step) {
          const chunk = content.slice(i, i + step);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init, body: init.body ? JSON.parse(init.body) : null });
    const res = await handler(href, init);
    if (!res) throw new Error(`unexpected fetch: ${href}`);
    return res;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    })
    .then((res) => ({ res, calls }));
}

function makePort() {
  const messages = [];
  let listener = null;
  return {
    name: PORT.TASK,
    onMessage: {
      addListener: (fn) => {
        listener = fn;
      },
    },
    onDisconnect: { addListener: () => {} },
    postMessage: (msg) => messages.push(msg),
    disconnect: () => {},
    // test helpers
    push: (msg) => listener(msg),
    messages,
    async waitFor(predicate, timeoutMs = 3000) {
      const started = Date.now();
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (Date.now() - started > timeoutMs) {
          const seen = messages.map((m) => m.type).join(',') || '(none)';
          throw new Error(`timed out waiting for a port event; saw: ${seen}`);
        }
        await tick(3);
      }
    },
  };
}

/* ------------------------------------------------------------------- tests */

describe('router: state and settings', () => {
  it('answers ping and rejects unknown message types', async () => {
    await resetAll();
    const ping = await send({ type: MSG.PING });
    assertEqual(ping.ok, true);
    assertEqual(ping.version, APP.version, 'the worker must report the packaged version');

    const unknown = await dispatch({ type: 'nope' });
    assertEqual(errorOf(unknown), 'UNKNOWN_MESSAGE');
    const empty = await dispatch(null);
    assertEqual(empty.ok, false);
  });

  it('reports a complete state snapshot for the popup', async () => {
    await resetAll();
    const state = await send({ type: MSG.GET_STATE });
    assertEqual(state.ok, true);
    assert(state.settings.ai && state.settings.ui, 'settings must carry the AI and UI groups');
    assertDeepEqual(state.providers, []);
    assertEqual(typeof state.cache.entries, 'number');
    assertEqual(typeof state.usage, 'object');
    assert(state.engineInfo && typeof state.engineInfo.strategy === 'string');
    assertEqual(state.version, APP.version, 'the state snapshot must carry the packaged version');
  });

  it('persists settings patches and can reset them', async () => {
    await resetAll();
    const saved = await send({ type: MSG.SAVE_SETTINGS, patch: { ui: { panelWidth: 520, theme: 'dark' } } });
    assertEqual(saved.settings.ui.panelWidth, 520);

    const state = await send({ type: MSG.GET_STATE });
    assertEqual(state.settings.ui.theme, 'dark');

    const reset = await send({ type: MSG.SAVE_SETTINGS, reset: true });
    assertEqual(reset.settings.ui.theme, 'light');
    assertEqual(reset.settings.ui.panelWidth !== 520, true, 'reset restores defaults');
  });
});

describe('router: providers and keys', () => {
  it('creates, updates, defaults and deletes providers', async () => {
    await resetAll();
    const created = await send({ type: MSG.SAVE_PROVIDERS, providers: [TEST_PROVIDER] });
    assertEqual(created.providers.length, 1);
    assertEqual(created.providers[0].id, 'p-test');

    const upserted = await send({
      type: MSG.SAVE_PROVIDERS,
      provider: { ...TEST_PROVIDER, name: 'Renamed' },
      setDefault: true,
    });
    assertEqual(upserted.provider.name, 'Renamed');
    const settings = await getSettings();
    assertEqual(settings.ai.providerId, 'p-test', 'setDefault must point the settings at the provider');
    assertEqual(settings.ai.model, 'test-model');

    const removed = await send({ type: MSG.DELETE_PROVIDER, providerId: 'p-test' });
    assertDeepEqual(removed.providers, []);
    assertDeepEqual(await getProviders(), []);
  });

  it('stores the api key outside settings and only exposes a masked preview', async () => {
    await resetAll();
    await send({ type: MSG.SAVE_PROVIDERS, providers: [TEST_PROVIDER] });
    const rawKey = 'sk-example-key-0123456789abcdef';
    const saved = await send({ type: MSG.SAVE_KEY, providerId: 'p-test', apiKey: rawKey });
    assert(saved.keyPreview !== rawKey, 'the raw key must never be echoed back');
    assert(saved.keyPreview.includes('•'), `expected a masked preview, got ${saved.keyPreview}`);
    assertEqual(saved.keyPreview.includes('0123456789'), false);

    const state = await send({ type: MSG.GET_STATE });
    const provider = state.providers.find((p) => p.id === 'p-test');
    assertEqual(provider.hasKey, true);
    assertEqual(provider.keyPreview.includes(rawKey), false);

    // The key is not part of the exported settings.
    const exported = await send({ type: MSG.EXPORT_DATA });
    assertDeepEqual(exported.data.keys, {}, 'export without keys must not include them');
    assertEqual(JSON.stringify(exported.data).includes(rawKey), false, 'the raw key must never appear in an export');

    // ...but can be included explicitly.
    const withKeys = await send({ type: MSG.EXPORT_DATA, includeKeys: true });
    assertEqual(withKeys.data.keys['p-test'], rawKey, 'includeKeys must include the stored key');
  });
});

describe('router: offline retrieval', () => {
  it('rejects the removed local summariser', async () => {
    await resetAll();
    const gone = await dispatch({ type: 'local-summary', videoId: '', segments: ruTranscript(), meta: meta({}) });
    assertEqual(errorOf(gone), 'UNKNOWN_MESSAGE', 'the non-AI summariser must not come back');
  });

  it('answers questions offline with citations', async () => {
    await resetAll();
    const res = await send({ type: MSG.LOCAL_ASK, videoId: '', segments: ruTranscript(), meta: meta({}), question: 'О чём это видео?' });
    assertEqual(res.ok, true);
    assert(typeof res.answer === 'string' && res.answer.length > 0, 'a local answer is required');
    assert(Array.isArray(res.sources), 'sources must be an array');
    assert(res.sources.length > 0, 'an overview question must cite transcript fragments');
    assertEqual(typeof res.sources[0].text, 'string');
    assertEqual(res.meta.engine, 'search');
    assertEqual(res.overview.length > 0, true);
  });

  it('returns transcript and strategy plan for inline input', async () => {
    await resetAll();
    const res = await send({ type: MSG.GET_TRANSCRIPT, segments: ruTranscript(), meta: meta({ source: 'manual-paste' }), lang: 'ru' });
    assertEqual(res.ok, true);
    assert(res.segments.length >= 2);
    assertEqual(res.format, 'inline');
    assertEqual(res.plan.strategy, 'single');
    assertEqual(res.meta.source, 'manual-paste');
    assertEqual(res.meta.videoId, 'dQw4w9WgXcQ');
  });

  it('surfaces coded errors instead of throwing across the boundary', async () => {
    await resetAll();
    const noInput = await dispatch({ type: MSG.LOCAL_ASK, videoId: '', segments: [], meta: {} });
    assertEqual(errorOf(noInput), 'BAD_VIDEO_ID');
    assertEqual(noInput.__data.hint !== undefined, true);

    const noProvider = await dispatch({ type: MSG.LIST_MODELS, providerId: 'missing' });
    assertEqual(errorOf(noProvider), 'NO_PROVIDER');
  });
});

describe('router: cache, history and data operations', () => {
  it('round-trips cache entries and clears them', async () => {
    await resetAll();
    await saveSettings({ cache: { enabled: true } });
    const params = { videoId: 'vid-1', mode: 'local', lang: 'ru', variant: 'test' };
    const summary = { videoId: 'vid-1', mode: 'local', tldr: 'Кэшированный конспект', keyPoints: [] };
    const put = await send({ type: MSG.PUT_CACHE, params, summary, meta: { title: 'Видео', channel: 'Канал' } });
    assertEqual(put.ok, true);

    const got = await send({ type: MSG.GET_CACHE, videoId: 'vid-1', mode: 'local', lang: 'ru', variant: 'test' });
    assertEqual(got.entry.summary.tldr, 'Кэшированный конспект');
    assertEqual(got.entry.title, 'Видео');
    assertEqual(got.entry.channel, 'Канал');
    assertEqual(got.entry.hits >= 1, true, 'reading a cache entry must count a hit');

    const cleared = await send({ type: MSG.CLEAR_CACHE });
    assertEqual(cleared.ok, true);
    const after = await send({ type: MSG.GET_CACHE, videoId: 'vid-1', mode: 'local', lang: 'ru', variant: 'test' });
    assertEqual(after.entry, null);
  });

  it('exports, imports and wipes all user data', async () => {
    await resetAll();
    await send({ type: MSG.SAVE_PROVIDERS, providers: [TEST_PROVIDER] });
    await send({ type: MSG.SAVE_SETTINGS, patch: { ui: { theme: 'dark' } } });
    const exported = await send({ type: MSG.EXPORT_DATA });
    assertEqual(exported.data.settings.ui.theme, 'dark');
    assertEqual(exported.data.providers.length, 1);

    await send({ type: MSG.WIPE_ALL });
    const empty = await send({ type: MSG.GET_STATE });
    assertDeepEqual(empty.providers, []);
    assertEqual(empty.settings.ui.theme, 'light');

    const imported = await send({ type: MSG.IMPORT_DATA, payload: exported.data, merge: true });
    assertEqual(imported.ok, true);
    const restored = await send({ type: MSG.GET_STATE });
    assertEqual(restored.providers.length, 1);
    assertEqual(restored.settings.ui.theme, 'dark');
    assertEqual(typeof (await exportAll({ includeKeys: false })), 'object');
  });

  it('clears history on request', async () => {
    await resetAll();
    await addHistory({ videoId: 'dQw4w9WgXcQ', mode: 'ai', title: 'Тестовое видео', provider: 'p-test', model: 'test-model' });
    assert((await send({ type: MSG.GET_HISTORY })).history.length >= 1);
    await send({ type: MSG.CLEAR_HISTORY });
    assertEqual((await send({ type: MSG.GET_HISTORY })).history.length, 0);
  });
});

describe('router: ai providers and downloads', () => {
  it('lists models and merges them into the provider', async () => {
    await resetAll();
    await send({ type: MSG.SAVE_PROVIDERS, providers: [TEST_PROVIDER] });
    await send({ type: MSG.SAVE_KEY, providerId: 'p-test', apiKey: 'sk-example-0123456789abcdef' });
    const { res } = await withFetch(
      (url) => (url.includes('/models') ? new Response(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'test-model-2' }] }), { status: 200, headers: { 'content-type': 'application/json' } }) : null),
      () => send({ type: MSG.LIST_MODELS, providerId: 'p-test' }),
    );
    assertEqual(res.count, 2);
    assertEqual(res.models[0], 'test-model');
    const provider = (await getProviders())[0];
    assertEqual(provider.models.includes('test-model-2'), true, 'fetched models must be stored');
  });

  it('tests a provider and reports host and latency', async () => {
    await resetAll();
    await send({ type: MSG.SAVE_PROVIDERS, providers: [TEST_PROVIDER] });
    await send({ type: MSG.SAVE_KEY, providerId: 'p-test', apiKey: 'sk-example-0123456789abcdef' });
    const { res } = await withFetch(
      (url) =>
        url.includes('/chat/completions')
          ? new Response(JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
          : null,
      () => send({ type: MSG.TEST_PROVIDER, providerId: 'p-test' }),
    );
    assertEqual(res.ok, true);
    assertEqual(res.sample, 'pong');
    assertEqual(res.host, '127.0.0.1:9999');
    assert(res.latencyMs >= 0);
  });

  it('renders markdown for export and saves downloads', async () => {
    await resetAll();
    const summary = {
      result: {
        videoId: 'dQw4w9WgXcQ',
        mode: 'ai',
        title: 'Тестовое видео',
        tldr: 'Кэш хранит готовые ответы и экономит время запроса.',
        createdAt: new Date().toISOString(),
        keyPoints: [{ text: 'Метрика попаданий показывает пользу кэша.', at: 20, ts: '0:20' }],
        sections: [],
        takeaways: ['Измеряйте попадания в кэш.'],
        keywords: [{ term: 'кэш' }],
        quotes: [],
      },
    };
    const md = await send({ type: MSG.EXPORT_MD, result: summary.result, format: 'md' });
    assert(md.text.includes('#'), 'markdown must contain a heading');
    assertEqual(md.filename.endsWith('.md'), true);
    assert(md.filename.includes('OpenSummary'));

    const txt = await send({ type: MSG.EXPORT_MD, result: summary.result, format: 'txt' });
    assertEqual(txt.filename.endsWith('.txt'), true);
    const json = await send({ type: MSG.EXPORT_MD, result: summary.result, format: 'json', segments: ruTranscript(), videoId: '', includeTranscript: true });
    const parsed = JSON.parse(json.text);
    assertEqual(Array.isArray(parsed.transcript), true, 'json export can inline the transcript');

    const failed = await dispatch({ type: MSG.EXPORT_MD });
    assertEqual(errorOf(failed), 'HANDLER_ERROR');

    const download = await send({ type: MSG.DOWNLOAD, filename: 'test.md', content: '# привет', mime: 'text/markdown' });
    assertEqual(download.ok, true);
    assert(download.downloadId >= 1);
    assertEqual(createdDownloads[createdDownloads.length - 1].filename.endsWith('.md'), true);
  });

  it('opens the options page, including deep links, and drives the content tab', async () => {
    await resetAll();
    const options = await send({ type: MSG.OPEN_OPTIONS });
    assertEqual(options.ok, true);
    assertEqual(openedOptions, 1);
    const deep = await send({ type: MSG.OPEN_OPTIONS, section: 'providers' });
    assertEqual(deep.ok, true);
    assert(tabsState.some((t) => String(t.url).includes('#providers')), 'a deep link must open the options page on that section');

    const injected = await send({ type: MSG.INJECT_CONTENT, tabId: 5 });
    assertEqual(injected.ok, true);
    const panel = await send({ type: MSG.OPEN_PANEL, tabId: 5 });
    assertEqual(panel.ok, true);
    const noTab = await send({ type: MSG.OPEN_PANEL, tabId: 0 });
    assertEqual(noTab.ok, false);
  });
});

describe('task port: ai summary', () => {
  async function setupAi(overrides = {}) {
    await resetAll();
    await send({ type: MSG.SAVE_PROVIDERS, provider: TEST_PROVIDER, setDefault: true });
    await send({ type: MSG.SAVE_KEY, providerId: 'p-test', apiKey: 'sk-example-0123456789abcdef' });
    await send({ type: MSG.SAVE_SETTINGS, patch: { mode: 'ai', ai: { stream: false, retries: 0, useCache: false }, ...overrides } });
  }

  it('streams stage/result events for a summary task', async () => {
    await setupAi();
    const port = makePort();
    registerTaskPort(port);
    const { res: event, calls } = await withFetch(
      (url) => (url.includes('/chat/completions') ? openAiResponse() : null),
      async () => {
        port.push({ type: MSG.AI_SUMMARY, taskId: 'task-1', input: { videoId: '', segments: ruTranscript(), meta: meta({}), force: true } });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );

    assertEqual(event.type, EV.RESULT, `unexpected error event: ${JSON.stringify(event)}`);
    assertEqual(event.taskId, 'task-1');
    assertEqual(event.result.mode, 'ai');
    assert(event.result.tldr.length > 0, 'the ai result must carry a tldr');
    assertEqual(event.result.provider, 'Test Provider');
    assertEqual(event.cached, false);
    assertEqual(calls.length >= 1, true, 'the provider must be called');
    assert(calls[0].url.includes('127.0.0.1:9999'), 'must call the configured endpoint');

    assert(port.messages.some((m) => m.type === EV.READY), 'the worker must announce READY');
    assert(port.messages.some((m) => m.type === EV.STAGE), 'stage events must be emitted');
    assertEqual(port.messages.some((m) => m.type === EV.ERROR), false, 'no error expected');
  });

  it('forwards validated stream items through the task port', async () => {
    await setupAi({ ai: { stream: true, retries: 0, useCache: false } });
    const port = makePort();
    registerTaskPort(port);
    const { res: event } = await withFetch(
      (url) => (url.includes('/chat/completions') ? openAiSseResponse() : null),
      async () => {
        port.push({
          type: MSG.AI_SUMMARY,
          taskId: 'task-stream',
          input: { videoId: '', segments: ruTranscript(), meta: meta({}), force: true },
        });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );

    assertEqual(event.type, EV.RESULT, `unexpected event: ${JSON.stringify(event).slice(0, 300)}`);
    const items = port.messages.filter((m) => m.type === EV.PROGRESS && m.stage === 'stream-item');
    assert(items.length >= 2, `expected validated items on the port, got ${items.length}`);
    assert(
      items.every((m) => typeof m.streamId === 'string' && m.streamId && m.item && m.item.kind),
      'every stream item must carry its draft id and kind',
    );
    assertEqual(items[0].item.kind, 'tldr');
    assertEqual(event.result.meta.diagnostics.streamItems, items.length, 'the diagnostics must count what the port received');
  });

  it('does not cache or return a result when the stream breaks mid-answer', async () => {
    await setupAi({ ai: { stream: true, retries: 0, useCache: false } });
    await send({ type: MSG.SAVE_SETTINGS, patch: { cache: { enabled: true } } });
    const encoder = new TextEncoder();
    const port = makePort();
    registerTaskPort(port);
    const { res: event } = await withFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: '{"tldr":"Частичный ответ, который оборвался слишком рано' } }] })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: 'upstream died' } })}\n\n`));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      async () => {
        port.push({
          type: MSG.AI_SUMMARY,
          taskId: 'task-broken',
          input: { videoId: '', segments: ruTranscript(), meta: meta({}), force: true },
        });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );

    assertEqual(event.type, EV.ERROR, 'a broken answer must end with an error, not a result');
    assertEqual(event.code, 'PROVIDER_ERROR');
    const state = await send({ type: MSG.GET_STATE });
    assertEqual(state.cache.entries, 0, 'a partial answer must never be stored as a complete cache entry');
  });

  it('shares one deadline across provider fallback and never restarts it', async () => {
    await setupAi();
    const backup = {
      ...TEST_PROVIDER,
      id: 'p-backup',
      name: 'Backup Provider',
      baseUrl: 'http://127.0.0.1:9998/v1',
    };
    await send({ type: MSG.SAVE_PROVIDERS, providers: [TEST_PROVIDER, backup] });
    await send({ type: MSG.SAVE_KEY, providerId: 'p-backup', apiKey: 'sk-example-backup-0123456789' });

    const port = makePort();
    registerTaskPort(port);
    const aborted = [];
    const { res, calls } = await withFetch(
      (url, init) => {
        if (url.includes('127.0.0.1:9999')) return new Response('{"error":{"message":"boom"}}', { status: 500 });
        // The fallback provider hangs; its request is bounded by the SAME
        // deadline the primary got, not by a fresh 90 s budget.
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            aborted.push(init.signal);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (init.signal?.aborted) return onAbort();
          init.signal?.addEventListener('abort', onAbort, { once: true });
          void resolve;
        });
      },
      async () => {
        const started = Date.now();
        port.push({
          type: MSG.AI_SUMMARY,
          taskId: 'task-fallback-deadline',
          deadlineAt: Date.now() + 450,
          input: { videoId: '', segments: ruTranscript(), meta: meta({}), force: true },
        });
        const event = await port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
        return { event, elapsed: Date.now() - started };
      },
    );
    assertEqual(res.event.type, EV.ERROR, `unexpected result: ${JSON.stringify(res.event)}`);
    assertEqual(res.event.code, 'TIMEOUT');
    assertEqual(res.event.detail, 'job-deadline');
    assertEqual(calls.length, 2, 'primary and exactly one fallback provider may be called');
    assertEqual(aborted.length, 1, 'the fallback request must be aborted by the shared deadline');
    assert(res.elapsed < 2500, `fallback must not reset the deadline, took ${res.elapsed} ms`);
    assertEqual(port.messages.some((m) => m.type === EV.RESULT), false, 'no late result after the deadline');
  });

  it('switches providers after a call timeout when the job still has time', async () => {
    // OpenRouter's free models routinely hit the 90 s call timeout. With a
    // second key configured the run used to die anyway; now it moves on.
    await setupAi({ ai: { stream: false, retries: 0, useCache: false, timeoutMs: 300 } });
    const backup = {
      ...TEST_PROVIDER,
      id: 'p-backup',
      name: 'Backup Provider',
      baseUrl: 'http://127.0.0.1:9998/v1',
    };
    await send({ type: MSG.SAVE_PROVIDERS, providers: [TEST_PROVIDER, backup] });
    await send({ type: MSG.SAVE_KEY, providerId: 'p-backup', apiKey: 'sk-example-backup-0123456789' });

    const port = makePort();
    registerTaskPort(port);
    const { res, calls } = await withFetch(
      (url, init) => {
        if (url.includes('127.0.0.1:9999')) {
          // The primary model hangs: every attempt is aborted by its timeout.
          return new Promise((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (init.signal?.aborted) return onAbort();
            init.signal?.addEventListener('abort', onAbort, { once: true });
            void resolve;
          });
        }
        return openAiResponse();
      },
      async () => {
        port.push({
          type: MSG.AI_SUMMARY,
          taskId: 'task-timeout-switch',
          input: { videoId: '', segments: ruTranscript(), meta: meta({}), force: true },
        });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );

    assertEqual(res.type, EV.RESULT, `the backup provider must answer: ${JSON.stringify(res)}`);
    assertEqual(res.result.provider, 'Backup Provider');
    assertEqual(calls.length, 2, 'primary (timed out) and backup (answered)');
    assert(
      port.messages.some((m) => m.type === EV.STAGE && m.stage === 'fallback'),
      'the switch must be reported to the panel',
    );
  });

  it('emits no late events or unhandled rejections after a job deadline', async () => {
    await setupAi();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const port = makePort();
    registerTaskPort(port);
    try {
      await withFetch(
        (url, init) =>
          new Promise((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (init.signal?.aborted) return onAbort();
            init.signal?.addEventListener('abort', onAbort, { once: true });
            void resolve;
          }),
        async () => {
          port.push({
            type: MSG.AI_SUMMARY,
            taskId: 'task-deadline-late',
            deadlineAt: Date.now() + 250,
            input: { videoId: '', segments: ruTranscript(), meta: meta({}), force: true },
          });
          return port.waitFor((m) => m.type === EV.ERROR && m.taskId === 'task-deadline-late');
        },
      );
      await tick(200);
      const terminal = port.messages.filter((m) => m.taskId === 'task-deadline-late' && (m.type === EV.RESULT || m.type === EV.ERROR));
      assertEqual(terminal.length, 1, 'exactly one terminal event may be emitted');
      assertEqual(terminal[0].detail, 'job-deadline');
      assertEqual(port.messages.some((m) => m.type === EV.RESULT && m.taskId === 'task-deadline-late'), false);
      assertEqual(unhandled.length, 0, `no unhandled rejection may escape, got: ${unhandled.map(String).join('; ')}`);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('answers keepalive pings and cancels a running task', async () => {
    await setupAi();
    const port = makePort();
    registerTaskPort(port);

    port.push({ type: 'keepalive' });
    const pong = await port.waitFor((m) => m.type === EV.PONG);
    assertEqual(typeof pong.at, 'number');

    const original = globalThis.fetch;
    globalThis.fetch = (url, init = {}) =>
      new Promise((resolve, reject) => {
        const signal = init.signal;
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort);
        }
        // never resolves on its own: the task can only end through cancellation
        void resolve;
      });
    try {
      port.push({ type: MSG.AI_SUMMARY, taskId: 'task-2', input: { videoId: '', segments: ruTranscript(), meta: meta({}), force: true } });
      await port.waitFor((m) => m.type === EV.READY && m.taskId === 'task-2');
      await tick(10);
      port.push({ type: 'cancel', taskId: 'task-2' });
      const error = await port.waitFor((m) => m.type === EV.ERROR && m.taskId === 'task-2');
      assertEqual(error.code, 'CANCELLED');
      assertEqual(error.cancelled, true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('resumes an interrupted run from saved fragment notes', async () => {
    await setupAi({
      ai: {
        strategy: 'map-reduce',
        contextTokens: 4000,
        chunkTokens: 1200,
        concurrency: 2,
        chunkCache: false,
        useCache: false,
        stream: false,
      },
    });
    const { buildChunks } = await import('../src/ai/chunking.js');
    const { PROMPT_VERSION } = await import('../src/ai/prompts.js');
    const { uiLangFor } = await import('../src/background/tasks.js');
    const jobs = await import('../src/background/jobs.js');
    const segments = longTranscript(240);
    const info = meta({ lang: 'en' });
    const settings = await getSettings();
    const transcriptHash = jobs.transcriptFingerprint(segments);
    const fingerprint = jobs.jobFingerprint({
      transcriptHash,
      promptVersion: PROMPT_VERSION,
      appVersion: APP.version,
      ai: settings.ai,
      output: settings.output,
      providerId: 'p-test',
      model: 'test-model',
      uiLang: uiLangFor(settings, info.lang),
    });
    const chunks = buildChunks(segments, { maxTokens: settings.ai.chunkTokens });
    const savedCount = Math.min(3, chunks.length - 1);
    const job = await jobs.createJob({
      id: 'job-resume',
      videoId: info.videoId,
      fingerprint,
      transcriptHash,
      promptVersion: PROMPT_VERSION,
      appVersion: APP.version,
      providerId: 'p-test',
      model: 'test-model',
    });
    for (const chunk of chunks.slice(0, savedCount)) {
      await jobs.recordChunk(job.id, {
        index: chunk.index,
        startAt: chunk.startAt,
        endAt: chunk.endAt,
        status: 'succeeded',
        partial: { points: [{ text: 'Сохранённый факт из прошлого запуска.', at: '0:10' }], topics: ['тема'] },
      });
    }
    await jobs.setJobStatus(job.id, 'interrupted');

    const port = makePort();
    registerTaskPort(port);
    const { res: event, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (isMap) {
          return openAiResponse(
            JSON.stringify({ points: [{ text: 'Новый факт из оставшегося фрагмента.', at: '0:20' }], topics: ['тема'] }),
          );
        }
        return openAiResponse();
      },
      async () => {
        port.push({
          type: MSG.AI_SUMMARY,
          taskId: 'task-resume',
          input: { videoId: '', segments, meta: info, force: true },
        });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );
    assertEqual(event.type, EV.RESULT, `unexpected error event: ${JSON.stringify(event)}`);
    assert(
      port.messages.some((m) => m.stage === 'resume' && m.resumed === savedCount),
      `a resume stage must report ${savedCount} saved fragments`,
    );
    const mapCalls = calls.filter((c) => c.body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'))).length;
    assertEqual(mapCalls, chunks.length - savedCount, 'saved fragments must not be requested again');
    const finished = await jobs.getJob('job-resume');
    assertEqual(finished.status, 'done');
  });

  it('continues exactly the saved job and refuses a second click', async () => {
    await setupAi({
      ai: { strategy: 'map-reduce', contextTokens: 4000, chunkTokens: 1200, concurrency: 2, chunkCache: false, useCache: false, stream: false },
    });
    const { buildChunks } = await import('../src/ai/chunking.js');
    const { PROMPT_VERSION } = await import('../src/ai/prompts.js');
    const { uiLangFor, inspectResumableJob } = await import('../src/background/tasks.js');
    const jobs = await import('../src/background/jobs.js');
    const segments = longTranscript(240);
    const info = meta({ lang: 'en' });
    const settings = await getSettings();
    const transcriptHash = jobs.transcriptFingerprint(segments);
    const fingerprint = jobs.jobFingerprint({
      transcriptHash,
      promptVersion: PROMPT_VERSION,
      appVersion: APP.version,
      ai: settings.ai,
      output: settings.output,
      providerId: 'p-test',
      model: 'test-model',
      uiLang: uiLangFor(settings, info.lang),
    });
    const chunks = buildChunks(segments, { maxTokens: settings.ai.chunkTokens });
    assert(chunks.length >= 3, 'the fixture must need several chunks');
    const job = await jobs.createJob({
      id: 'job-explicit',
      videoId: info.videoId,
      fingerprint,
      transcriptHash,
      promptVersion: PROMPT_VERSION,
      appVersion: APP.version,
      providerId: 'p-test',
      model: 'test-model',
    });
    const savedIndex = chunks[0].index;
    await jobs.recordChunk(job.id, {
      index: savedIndex,
      startAt: chunks[0].startAt,
      endAt: chunks[0].endAt,
      status: 'succeeded',
      partial: { points: [{ text: 'Сохранённый факт явного продолжения.', at: '0:10' }], topics: ['тема'] },
    });
    await jobs.setJobStatus(job.id, 'interrupted');

    // The panel's own question: is this saved job exactly compatible?
    const offered = await inspectResumableJob({
      input: { videoId: info.videoId, segments, meta: info },
      providerId: 'p-test',
      model: 'test-model',
    });
    assertEqual(offered.job?.id, 'job-explicit', 'a compatible interrupted job must be offered');
    assertEqual(offered.job.savedChunks, 1, 'the offer must count saved fragments');

    // Same video, edited transcript: the old notes must not be offered.
    const changed = await inspectResumableJob({
      input: { videoId: info.videoId, segments: longTranscript(241), meta: info },
      providerId: 'p-test',
      model: 'test-model',
    });
    assertEqual(changed.job, null, 'a changed transcript must hide the resume button');
    assertEqual(changed.mismatch, true, 'the mismatch must be reported, not guessed');

    // Two clicks: only the atomic claim wins, the second sees a running job.
    const firstClaim = await jobs.claimJob(job.id, { taskId: 'task-first' });
    const secondClaim = await jobs.claimJob(job.id, { taskId: 'task-second' });
    assertEqual(firstClaim.ok, true, 'the first claim must win');
    assertEqual(secondClaim.ok, false, 'a second click must not start the same job');
    assertEqual(secondClaim.reason, 'running');
    assertEqual((await jobs.getJob(job.id)).taskId, 'task-first', 'the losing click must not touch the job');

    // Run the explicit continuation through the real task port.
    await jobs.setJobStatus(job.id, 'interrupted');
    const port = makePort();
    registerTaskPort(port);
    const { res: event, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        return isMap
          ? openAiResponse(JSON.stringify({ points: [{ text: 'Факт оставшейся части.', at: '0:20' }], topics: ['тема'] }))
          : openAiResponse();
      },
      async () => {
        port.push({
          type: MSG.AI_SUMMARY,
          taskId: 'task-explicit',
          resumeJobId: job.id,
          input: { videoId: info.videoId, segments, meta: info, force: true },
        });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );
    assertEqual(event.type, EV.RESULT, `unexpected error: ${JSON.stringify(event)}`);
    assert(
      port.messages.some((m) => m.stage === 'resume' && m.resumed === 1),
      'the explicit continuation must report the reused fragment',
    );
    const mapCalls = calls.filter((c) => c.body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'))).length;
    assertEqual(mapCalls, chunks.length - 1, 'the saved fragment must never be requested twice');
    assertEqual((await jobs.getJob(job.id)).status, 'done', 'the continued job must finish');
  });

  it('does not offer a saved job that a live task is still working on', async () => {
    await setupAi();
    const { inspectResumableJob } = await import('../src/background/tasks.js');
    const jobs = await import('../src/background/jobs.js');
    const segments = ruTranscript();
    const info = meta({});
    const port = makePort();
    registerTaskPort(port);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, init = {}) =>
      new Promise((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) return onAbort();
        init.signal?.addEventListener('abort', onAbort, { once: true });
        void resolve;
      });
    try {
      port.push({ type: MSG.AI_SUMMARY, taskId: 'task-live', input: { videoId: info.videoId, segments, meta: info, force: true } });
      await port.waitFor((m) => m.type === EV.READY && m.taskId === 'task-live');
      await tick(30);
      const live = (await jobs.listJobs()).find((j) => j.taskId === 'task-live');
      assert(live, 'the live task must create a durable job');

      // Reopening the panel during one long call must not offer “Продолжить”.
      const offered = await inspectResumableJob({ input: { videoId: info.videoId, segments, meta: info }, providerId: 'p-test', model: 'test-model' });
      assertEqual(offered.job, null, 'a live job must not be offered for continuation');

      // And an explicit second click is refused before any claim.
      port.push({
        type: MSG.AI_SUMMARY,
        taskId: 'task-live-second',
        resumeJobId: live.id,
        input: { videoId: info.videoId, segments, meta: info, force: true },
      });
      const refused = await port.waitFor((m) => m.type === EV.ERROR && m.taskId === 'task-live-second');
      assertEqual(refused.code, 'RESUME_IN_PROGRESS');
      assertEqual(refused.detail, 'resume-busy');
    } finally {
      port.push({ type: 'cancel', taskId: 'task-live' });
      await port.waitFor((m) => m.type === EV.ERROR && m.taskId === 'task-live');
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps partial chunks resumable and never marks a deadline-cut run complete', async () => {
    await setupAi({
      ai: { strategy: 'map-reduce', contextTokens: 4000, chunkTokens: 1200, concurrency: 1, chunkCache: false, useCache: false, stream: false, retries: 0 },
    });
    const { buildChunks } = await import('../src/ai/chunking.js');
    const jobs = await import('../src/background/jobs.js');
    const segments = longTranscript(240);
    const info = meta({ lang: 'en' });
    const chunks = buildChunks(segments, { maxTokens: 1200 });
    assert(chunks.length >= 3, 'the fixture must need several chunks');

    let mapCalls = 0;
    const firstRun = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (!isMap) return openAiResponse();
        mapCalls++;
        if (mapCalls === 1) {
          return openAiResponse(JSON.stringify({ points: [{ text: 'Первый фрагмент сохранён.', at: '0:10' }], topics: ['тема'] }));
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) return onAbort();
          init.signal?.addEventListener('abort', onAbort, { once: true });
          void resolve;
        });
      },
      async () => {
        const port = makePort();
        registerTaskPort(port);
        port.push({
          type: MSG.AI_SUMMARY,
          taskId: 'task-deadline-partial',
          deadlineAt: Date.now() + 700,
          input: { videoId: info.videoId, segments, meta: info, force: true },
        });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );
    const event = firstRun.res;
    assertEqual(event.type, EV.RESULT, `unexpected error: ${JSON.stringify(event)}`);
    assertEqual(event.result.meta.complete, false, 'a deadline-cut run must not look complete');
    assertEqual(event.result.meta.diagnostics.finishReason, 'job-timeout');
    assertEqual(event.result.meta.diagnostics.resumable, true);
    assert(event.warnings.some((w) => /неполн|бюджет/i.test(w)), 'the warnings must explain the partial coverage');

    const saved = (await jobs.listJobs()).find((j) => j.taskId === 'task-deadline-partial');
    assert(saved, 'the interrupted job must survive in durable storage');
    assertEqual(saved.status, 'interrupted');
    assert(Object.keys(saved.partials || {}).length >= 1, 'successful chunks must stay resumable');

    // Second run with a healthy provider: saved chunks are reused, never paid
    // for twice.
    mapCalls = 0;
    const secondRun = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        if (!isMap) return openAiResponse();
        mapCalls++;
        return openAiResponse(
          JSON.stringify({ points: [{ text: 'Новый факт из оставшегося фрагмента.', at: '0:20' }], topics: ['тема'] }),
        );
      },
      async () => {
        const port = makePort();
        registerTaskPort(port);
        port.push({
          type: MSG.AI_SUMMARY,
          taskId: 'task-deadline-resume',
          input: { videoId: info.videoId, segments, meta: info, force: true },
        });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );
    assertEqual(secondRun.res.type, EV.RESULT, `unexpected error: ${JSON.stringify(secondRun.res)}`);
    assertEqual(mapCalls, chunks.length - 1, 'the saved fragment must not be requested again');
  });

  it('never resumes a cancelled or finished job', async () => {
    await setupAi({
      ai: { strategy: 'map-reduce', contextTokens: 4000, chunkTokens: 1200, concurrency: 2, chunkCache: false, useCache: false, stream: false },
    });
    const { buildChunks } = await import('../src/ai/chunking.js');
    const { PROMPT_VERSION } = await import('../src/ai/prompts.js');
    const { uiLangFor } = await import('../src/background/tasks.js');
    const jobs = await import('../src/background/jobs.js');
    const segments = longTranscript(240);
    const info = meta({ lang: 'en' });
    const settings = await getSettings();
    const transcriptHash = jobs.transcriptFingerprint(segments);
    const fingerprint = jobs.jobFingerprint({
      transcriptHash,
      promptVersion: PROMPT_VERSION,
      appVersion: APP.version,
      ai: settings.ai,
      output: settings.output,
      providerId: 'p-test',
      model: 'test-model',
      uiLang: uiLangFor(settings, info.lang),
    });
    const job = await jobs.createJob({ id: 'job-cancelled', videoId: info.videoId, fingerprint, transcriptHash });
    await jobs.recordChunk(job.id, {
      index: 0,
      status: 'succeeded',
      partial: { points: [{ text: 'Старый факт.', at: '0:01' }], topics: ['тема'] },
    });
    await jobs.setJobStatus(job.id, 'cancelled');

    const chunks = buildChunks(segments, { maxTokens: settings.ai.chunkTokens });
    const port = makePort();
    registerTaskPort(port);
    const { res: event, calls } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        return isMap
          ? openAiResponse(JSON.stringify({ points: [{ text: 'Факт.', at: '0:20' }], topics: ['тема'] }))
          : openAiResponse();
      },
      async () => {
        port.push({ type: MSG.AI_SUMMARY, taskId: 'task-cancel', input: { videoId: '', segments, meta: info, force: true } });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );
    assertEqual(event.type, EV.RESULT, `unexpected error: ${JSON.stringify(event)}`);
    assertEqual(port.messages.some((m) => m.stage === 'resume'), false, 'a cancelled job must not be resumed');
    const mapCalls = calls.filter((c) => c.body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'))).length;
    assertEqual(mapCalls, chunks.length, 'a cancelled job must be recalculated from scratch');
  });

  it('rejects a saved job when the transcript changed', async () => {
    await setupAi({
      ai: { strategy: 'map-reduce', contextTokens: 4000, chunkTokens: 1200, concurrency: 2, chunkCache: false, useCache: false, stream: false },
    });
    const { PROMPT_VERSION } = await import('../src/ai/prompts.js');
    const { uiLangFor } = await import('../src/background/tasks.js');
    const jobs = await import('../src/background/jobs.js');
    const info = meta({ lang: 'en' });
    const settings = await getSettings();
    const oldSegments = longTranscript(240);
    const newSegments = longTranscript(241);
    const oldHash = jobs.transcriptFingerprint(oldSegments);
    const fingerprint = jobs.jobFingerprint({
      transcriptHash: oldHash,
      promptVersion: PROMPT_VERSION,
      appVersion: APP.version,
      ai: settings.ai,
      output: settings.output,
      providerId: 'p-test',
      model: 'test-model',
      uiLang: uiLangFor(settings, info.lang),
    });
    const job = await jobs.createJob({ id: 'job-old', videoId: info.videoId, fingerprint, transcriptHash: oldHash });
    await jobs.recordChunk(job.id, {
      index: 0,
      status: 'succeeded',
      partial: { points: [{ text: 'Факт старой версии.', at: '0:01' }], topics: ['тема'] },
    });
    await jobs.setJobStatus(job.id, 'interrupted');

    const port = makePort();
    registerTaskPort(port);
    const { res: event } = await withFetch(
      (url, init) => {
        const body = JSON.parse(init.body);
        const isMap = body.messages.some((m) => String(m.content).includes('Транскрипт фрагмента'));
        return isMap
          ? openAiResponse(JSON.stringify({ points: [{ text: 'Факт новой версии.', at: '0:20' }], topics: ['тема'] }))
          : openAiResponse();
      },
      async () => {
        port.push({ type: MSG.AI_SUMMARY, taskId: 'task-changed', input: { videoId: '', segments: newSegments, meta: info, force: true } });
        return port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
      },
    );
    assertEqual(event.type, EV.RESULT, `unexpected error: ${JSON.stringify(event)}`);
    assertEqual(port.messages.some((m) => m.stage === 'resume'), false, 'changed transcript must invalidate saved notes');
    assertEqual((await jobs.getJob('job-old')).status, 'interrupted', 'the old job must be left untouched');
  });

  it('marks running jobs as interrupted on the next worker start', async () => {
    const jobs = await import('../src/background/jobs.js');
    await jobs.clearJobs();
    jobs.__resetJobQueue();
    const a = await jobs.createJob({ id: 'boot-a', videoId: 'v1', fingerprint: 'f1' });
    await jobs.recordChunk(a.id, {
      index: 0,
      status: 'succeeded',
      partial: { points: [{ text: 'Сохранённый факт.', at: '0:01' }], topics: ['т'] },
    });
    await jobs.createJob({ id: 'boot-b', videoId: 'v2', fingerprint: 'f2' });
    assertEqual(await jobs.recoverInterruptedJobs(), 2);
    assertEqual((await jobs.getJob('boot-a')).status, 'interrupted');
    assertEqual((await jobs.getJob('boot-b')).status, 'interrupted');
    assert(Object.keys((await jobs.getJob('boot-a')).partials).length === 1, 'saved notes must survive recovery');
    assertEqual(await jobs.recoverInterruptedJobs(), 0, 'recovery must be idempotent');
  });

  it('ignores unknown port messages and duplicate task ids', async () => {
    await setupAi();
    const port = makePort();
    registerTaskPort(port);
    port.push(null);
    port.push({ type: 'unrelated' });
    await tick(5);
    assertEqual(port.messages.length, 0, 'unknown messages must be ignored');

    const original = globalThis.fetch;
    // A slow (but finishing) provider: the second push with the same id must be
    // dropped while the first task is still in flight.
    globalThis.fetch = () => new Promise((resolve) => setTimeout(() => resolve(openAiResponse()), 40));
    try {
      const task = { type: MSG.AI_ASK, taskId: 'dup', question: 'Что?', input: { videoId: '', segments: ruTranscript(), meta: meta({}) } };
      port.push({ ...task });
      port.push({ ...task });
      await tick(10);
      const readyCount = port.messages.filter((m) => m.type === EV.READY && m.taskId === 'dup').length;
      assertEqual(readyCount, 1, 'a duplicate task id must not start a second task');
      await port.waitFor((m) => m.type === EV.RESULT || m.type === EV.ERROR);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('service worker wiring', () => {
  it('registered a message listener that routes through the dispatcher', async () => {
    assertEqual(typeof msgListener, 'function', 'the service worker must listen for messages');
    const response = await new Promise((resolve) => {
      const keepsChannel = msgListener({ type: MSG.PING }, {}, resolve);
      assertEqual(keepsChannel, true, 'the channel must stay open for the async answer');
    });
    assertEqual(response.ok, true);
    assertEqual(response.version, APP.version, 'the wired listener must answer with the packaged version');

    const ignored = msgListener({ type: 'osum:ping' }, {}, () => {});
    assertEqual(ignored, false, 'content-script pings are answered in the tab, not the worker');
  });

  it('registers a task port listener for the OpenSummary port name', () => {
    assertEqual(typeof connectListener, 'function');
    const port = makePort();
    connectListener(port);
    port.push({ type: 'keepalive' });
    assertEqual(port.messages[0].type, EV.PONG);
  });

  it('builds a transcript via InnerTube when every caption track is PO-token protected', async () => {
    // Production path: loadTranscript() in the service worker, not the legacy
    // youtube.getTranscript() helper the transcript tests use.
    const videoId = 'potrealtest1';
    const player = {
      videoDetails: { videoId, title: 'PO token video', author: 'Кто-то', lengthSeconds: '600' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ru&exp=xpe`,
              languageCode: 'ru',
              name: { simpleText: 'Русский' },
              kind: 'asr',
            },
          ],
        },
      },
    };
    const initial = {
      // ytInitialData parsing has a 200-character sanity floor.
      contents: { padding: 'x'.repeat(240) },
      engagementPanels: [
        {
          engagementPanelSectionListRenderer: {
            content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: 'params-xyz' } } } },
          },
        },
      ],
    };
    const html = [
      '<html><body>',
      `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`,
      `<script>var ytInitialData = ${JSON.stringify(initial)};</script>`,
      '</body></html>',
    ].join('');
    const cue = (start, dur, text) => ({ transcriptCueRenderer: { startOffsetMs: start, durationMs: dur, cue: { runs: [{ text }] } } });
    const panel = {
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                body: {
                  transcriptBodyRenderer: {
                    cueGroups: [{ g: { cues: [cue(0, 4000, 'Первая реплика видео'), cue(4000, 3000, 'Вторая реплика видео')] } }],
                  },
                },
              },
            },
          },
        },
      ],
    };

    const original = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      const href = String(url);
      urls.push(href);
      if (href.includes('/watch?')) return { ok: true, status: 200, text: async () => html };
      if (href.includes('/youtubei/v1/get_transcript')) return { ok: true, status: 200, json: async () => panel };
      if (href.includes('/api/timedtext')) return { ok: true, status: 200, text: async () => '' };
      throw new Error(`unexpected fetch: ${href}`);
    };
    try {
      const res = await loadTranscript({ videoId, lang: 'auto' });
      assertEqual(res.meta.source, 'captions-ui');
      assertEqual(res.segments.length, 2);
      assertEqual(res.meta.lang, 'ru', 'the language must be detected from the text');
      assertEqual(urls.filter((u) => u.includes('/api/timedtext')).length, 0, 'protected tracks are not requested');
      assert(urls.some((u) => u.includes('/youtubei/v1/get_transcript')), 'the panel API must be used');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps a ring buffer of the last transcript events', async () => {
    await loadJournal();
    for (let i = 1; i <= JOURNAL_LIMIT + 5; i++) {
      recordJournal({ level: i % 2 ? 'ok' : 'error', route: 'timedtext', videoId: `vid${i}`, code: `CODE_${i}` });
    }
    const entries = readJournal();
    assertEqual(entries.length, JOURNAL_LIMIT, 'the buffer must be capped');
    assertEqual(entries[0].videoId, 'vid6', 'the oldest entries must be dropped');
    assertEqual(entries[entries.length - 1].videoId, `vid${JOURNAL_LIMIT + 5}`, 'newest last');
    assert(entries[0].at, 'every entry carries a timestamp');

    const lines = journalLines();
    assertEqual(lines.length, JOURNAL_LIMIT);
    assert(lines[0].startsWith('FAIL'), `level must lead the line, got ${lines[0]}`);
    assert(lines[0].includes('CODE_6'), 'the code must be visible');
  });

  it('accepts transcript reports from the content script and clears them on wipe', async () => {
    await send({ type: MSG.JOURNAL, event: { code: 'NO_PAGE_TRANSCRIPT', message: 'панель не открылась', videoId: 'abc12345678' } });
    const afterReport = await send({ type: MSG.GET_JOURNAL });
    assert(
      afterReport.lines.some((l) => l.includes('NO_PAGE_TRANSCRIPT') && l.includes('page-panel')),
      `the report must reach the journal, got ${afterReport.lines.slice(-3).join(' | ')}`,
    );

    await send({ type: MSG.WIPE_ALL });
    const cleared = await send({ type: MSG.GET_JOURNAL });
    assertEqual(cleared.lines.length, 0, 'wiping data must clear the journal too');
    await saveSettings({ reset: true });
  });

  it('journals every transcript route it tries', async () => {
    const videoId = 'journalvideo1';
    const player = {
      videoDetails: { videoId, title: 'T', author: 'A', lengthSeconds: '600' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ru&exp=xpe`, languageCode: 'ru', name: { simpleText: 'ru' }, kind: 'asr' }],
        },
      },
    };
    const html = [
      '<html><body>',
      `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`,
      `<script>var ytInitialData = ${JSON.stringify({ contents: { pad: 'y'.repeat(240) } })};</script>`,
      '</body></html>',
    ].join('');
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/watch?')) return { ok: true, status: 200, text: async () => html };
      throw new Error('unexpected fetch');
    };
    let threw = false;
    try {
      await loadTranscript({ videoId });
    } catch {
      threw = true;
    } finally {
      globalThis.fetch = original;
    }
    assert(threw, 'loadTranscript must fail when no route works');
    const entries = readJournal().filter((e) => e.videoId === videoId);
    assert(entries.some((e) => e.code === 'POT_REQUIRED' && e.route === 'timedtext'), 'timedtext refusal must be logged');
    assert(entries.some((e) => e.code === 'NO_PARAMS' && e.route === 'get_transcript'), 'the missing panel params must be logged');
    assert(entries.some((e) => e.route === 'resolve' && e.level === 'error'), 'the final failure must be logged');
    assert(!JSON.stringify(entries).includes('защищена PO-token'), 'no page text or long strings belong in the journal');
  });

  it('separates a refused download from a body the parser cannot read', async () => {
    const htmlFor = (videoId) => {
      const player = {
        videoDetails: { videoId, title: 'T', author: 'A', lengthSeconds: '300' },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ru`,
                languageCode: 'ru',
                vssId: '.ru',
                name: { simpleText: 'ru' },
              },
            ],
          },
        },
      };
      return `<html><body><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></body></html>`;
    };

    const runWith = async (videoId, captionReply) => {
      const html = htmlFor(videoId);
      const original = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const href = String(url);
        if (href.includes('/watch?')) return new Response(html, { status: 200 });
        if (href.includes('/api/timedtext')) return captionReply();
        if (href.includes('video.google.com/timedtext')) return new Response('<transcript></transcript>', { status: 200 });
        throw new Error(`unexpected fetch ${href}`);
      };
      try {
        await loadTranscript({ videoId, force: true });
        return { err: null, entries: [] };
      } catch (err) {
        return { err, entries: readJournal().filter((entry) => entry.videoId === videoId) };
      } finally {
        globalThis.fetch = original;
      }
    };

    const parsed = await runWith('parsefailvid1', () => new Response('<html><body>not captions</body></html>', { status: 200 }));
    assertEqual(parsed.err?.code, 'PARSE_FAILED', 'a body with no cues must fail as a parse error');
    const parseEntry = parsed.entries.find((entry) => entry.route === 'timedtext' && entry.code === 'PARSE_FAILED');
    assert(parseEntry, 'the journal must record the parse failure on the timedtext route');
    assert(/json3:PARSE_FAILED/.test(parseEntry.message), `the journal must name the formats tried, got: ${parseEntry.message}`);
    assert(parsed.entries.some((entry) => entry.route === 'resolve' && entry.code === 'PARSE_FAILED'), 'the final failure must repeat the code');

    const refused = await runWith('refusedvid1', () => new Response('nope', { status: 403 }));
    assertEqual(String(refused.err?.code), '403', 'an HTTP refusal keeps its own code');
    assert(
      refused.entries.some((entry) => entry.route === 'timedtext' && String(entry.code) === '403'),
      'the journal must show the download refusal, not a parse error',
    );
    assert(
      !refused.entries.some((entry) => entry.code === 'PARSE_FAILED'),
      'a refused download must never be recorded as a parser problem',
    );
  });

  it('persists journal entries to storage before answering', async () => {
    recordJournal({ level: 'ok', route: 'timedtext', videoId: 'persistvid1', segments: 42 });
    await flushJournal();
    // The tests share one process, so `compat.js` may hold a storage stub that
    // is not `globalThis.chrome` here: read through the same object it uses.
    const { ext } = await import('../src/common/compat.js');
    const local = await ext.storage.local.get('osum:journal');
    const localEntries = local['osum:journal'] || [];
    assert(
      localEntries.some((e) => e.videoId === 'persistvid1'),
      'the durable copy must hold the event (the fallback for browsers without storage.session)',
    );
    const fresh = await loadJournal();
    assert(fresh.some((e) => e.videoId === 'persistvid1'), 'a fresh read must see the persisted event');
  });

  it('parses the get_transcript answer the page bridge sends back', async () => {
    const answer = {
      actions: [
        {
          updateEngagementPanelAction: {
            content: {
              transcriptRenderer: {
                body: {
                  transcriptBodyRenderer: {
                    cueGroups: [
                      {
                        transcriptCueGroupRenderer: {
                          cues: [
                            { transcriptCueRenderer: { startOffsetMs: 1500, durationMs: 3000, cue: { simpleText: 'Фраза со страницы' } } },
                            { transcriptCueRenderer: { startOffsetMs: 4600, durationMs: 2000, cue: { runs: [{ text: 'Вторая ' }, { text: 'фраза' }] } } },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      ],
    };
    const parsed = await send({ type: MSG.PARSE_TRANSCRIPT, json: JSON.stringify(answer) });
    assertEqual(parsed.ok, true);
    assertEqual(parsed.segments.length, 2);
    assertEqual(parsed.segments[0].text, 'Фраза со страницы');
    assertEqual(parsed.segments[0].start, 1.5);
    assertEqual(parsed.segments[1].text, 'Вторая фраза');

    // YouTube's “Sorry…” HTML page must surface as a coded error, not a crash.
    let code = '';
    try {
      await send({ type: MSG.PARSE_TRANSCRIPT, json: '<html><title>Sorry...</title></html>' });
    } catch (err) {
      code = err.code;
    }
    assertEqual(code, 'BAD_JSON');
  });

  it('falls back to the legacy caption endpoint for PO-token videos', async () => {
    const videoId = 'legacyvid001';
    const player = {
      videoDetails: { videoId, title: 'Legacy route', author: 'A', lengthSeconds: '600' },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ru&exp=xpe`, languageCode: 'ru', name: { simpleText: 'ru' }, kind: 'asr' },
          ],
        },
      },
    };
    const html = [
      '<html><body>',
      `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`,
      `<script>var ytInitialData = ${JSON.stringify({ contents: { pad: 'y'.repeat(240) } })};</script>`,
      '</body></html>',
    ].join('');
    const xml = [
      '<transcript>',
      '<text start="1" dur="2">Первая фраза</text>',
      '<text start="3" dur="2">Вторая фраза</text>',
      '<text start="5" dur="2">Третья фраза</text>',
      '</transcript>',
    ].join('');
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes('/watch?')) return { ok: true, status: 200, text: async () => html };
      if (href.includes('video.google.com/timedtext')) return { ok: true, status: 200, text: async () => xml };
      throw new Error(`unexpected fetch: ${href}`);
    };
    let payload = null;
    try {
      payload = await loadTranscript({ videoId });
    } finally {
      globalThis.fetch = original;
    }
    assert(payload, 'the legacy endpoint must produce a transcript');
    assertEqual(payload.format, 'legacy');
    assertEqual(payload.segments.length, 3);
    assertEqual(payload.meta.source, 'captions-manual:legacy');
    assert(
      readJournal().some((e) => e.route === 'legacy-timedtext' && e.level === 'ok'),
      'the route that answered must be logged',
    );
  });

  it('keeps settings materialised on a cold start', async () => {
    const settings = await getSettings();
    assertEqual(typeof settings.ui.theme, 'string');
    assertEqual(typeof settings.ai.chunkTokens, 'number');
    assertEqual(typeof settings.cache.ttlDays, 'number');
  });
});

describe('security: keys stay bound to their endpoint', () => {
  it('drops a key when a provider is repointed at another baseUrl', async () => {
    await resetAll();
    await upsertProvider(TEST_PROVIDER);
    await setApiKey(TEST_PROVIDER.id, 'sk-original-secret');
    assertEqual(await getApiKey(TEST_PROVIDER.id), 'sk-original-secret');

    await upsertProvider({ ...TEST_PROVIDER, baseUrl: 'https://evil.example/v1' });
    assertEqual(await getApiKey(TEST_PROVIDER.id), '', 'the key must not follow the provider');

    await setApiKey(TEST_PROVIDER.id, 'sk-second-secret');
    await upsertProvider({ ...TEST_PROVIDER, baseUrl: 'https://evil.example/v1', name: 'Renamed' });
    assertEqual(await getApiKey(TEST_PROVIDER.id), 'sk-second-secret', 'a rename keeps the key');
  });

  it('does not let an imported config silently keep a key on a changed host', async () => {
    await resetAll();
    await upsertProvider(TEST_PROVIDER);
    await setApiKey(TEST_PROVIDER.id, 'sk-import-secret');

    // Import without a key map: the existing key must not survive the repoint.
    await importAll({
      app: 'opensummary',
      schema: 1,
      providers: [{ ...TEST_PROVIDER, baseUrl: 'https://attacker.invalid/v1' }],
    });
    const providers = await getProviders();
    assertEqual(providers[0].baseUrl, 'https://attacker.invalid/v1');
    assertEqual(await getApiKey(TEST_PROVIDER.id), '', 'the old key must be gone');
  });

  it('imports keys into session storage when the user chose session-only storage', async () => {
    await resetAll();
    await saveSettings({ advanced: { keyStorage: 'session' } });
    await importAll({ app: 'opensummary', schema: 1, keys: { 'p-session': 'sk-session-secret' } });
    const local = await chrome.storage.local.get('osum:keys');
    assertEqual(local['osum:keys'], undefined, 'nothing may be written to storage.local');
    assertEqual((await getApiKeys())['p-session'], 'sk-session-secret');
    await saveSettings({ advanced: { keyStorage: 'local' } });
  });
});

describe('security: downloads and external links', () => {
  it('never writes a download with a non-text mime type', async () => {
    await resetAll();
    await send({
      type: MSG.DOWNLOAD,
      filename: 'x.html',
      content: '<script>alert(1)</script>',
      mime: 'text/html',
    });
    const last = createdDownloads[createdDownloads.length - 1];
    assert(last.url.startsWith('data:text/plain;'), `unexpected url: ${String(last.url).slice(0, 40)}`);
  });

  it('accepts only http and https links for extension pages', async () => {
    const { safeHttpUrl } = await import('../src/common/util.js');
    assertEqual(safeHttpUrl('https://openrouter.ai/keys'), 'https://openrouter.ai/keys');
    assertEqual(safeHttpUrl('http://localhost:11434'), 'http://localhost:11434/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>1</b>', 'file:///etc/passwd', 'chrome://settings', '']) {
      assertEqual(safeHttpUrl(bad), '', `must reject ${bad}`);
    }
  });
});
