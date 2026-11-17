/** Request/response router for runtime.sendMessage. */

import { APP, MSG } from '../common/constants.js';
import { ext } from '../common/compat.js';
import {
  getSettings,
  saveSettings,
  resetSettings,
  getProviders,
  saveProviders,
  upsertProvider,
  deleteProvider,
  getApiKey,
  setApiKey,
  getApiKeys,
  maskKey,
  getCached,
  putCached,
  clearCache,
  cacheStats,
  getHistory,
  addHistory,
  clearHistory,
  getUsage,
  exportAll,
  importAll,
  wipeAll,
  cacheKey,
} from '../common/storage.js';
import { hashString, safeFilename } from '../common/util.js';
import { inspectResumableJob, uiLangFor } from './tasks.js';
import { analyze, answerLocal, infoDensityScore } from '../nlp/extractive.js';
import { renderMarkdown, renderText } from '../nlp/schema.js';
import { listModels, testProvider, AIError } from '../ai/client.js';
import { providerHasCredentials, resolveProvider, injectPageBridge } from './state.js';
import { recordJournal, journalLines, clearJournal } from '../common/journal.js';
import { ensureTranscript, loadBundle } from './transcripts.js';
import { transcriptFingerprint } from './jobs.js';
import { parseTranscriptResponse } from '../transcript/youtube.js';
import { buildChunks, planStrategy } from '../ai/chunking.js';

/**
 * A download is written from a `data:` URL. Only text formats the extension
 * itself produces may be requested; anything else could turn a model answer
 * into an HTML file the user is later tricked into opening.
 */
const DOWNLOAD_MIMES = new Set(['text/plain', 'text/markdown', 'application/json', 'text/csv']);

/** The offline Q&A path: sentence ranking over the transcript, no model. */
async function loadAnalysis(input, settings) {
  const transcript = await ensureTranscript(input);
  const options = { uiLang: uiLangFor(settings, transcript.meta.lang) };
  const analysis = analyze({ segments: transcript.segments, meta: transcript.meta, options });
  return { transcript, analysis };
}

/* ------------------------------------------------------------------ handlers */

const handlers = {
  [MSG.PING]: async () => ({ ok: true, version: APP.version, name: APP.name }),

  [MSG.GET_STATE]: async () => {
    const settings = await getSettings();
    const providers = await getProviders();
    const keys = await getApiKeys();
    const stats = await cacheStats();
    const history = await getHistory();
    const usage = await getUsage();
    const activeProvider = providers.find((p) => p.id === settings.ai.providerId) || null;
    return {
      ok: true,
      version: APP.version,
      settings,
      providers: providers
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((p) => ({
          ...p,
          hasKey: providerHasCredentials(p, keys[p.id]),
          keyPreview: maskKey(keys[p.id]),
        })),
      activeProviderId: settings.ai.providerId || (activeProvider ? activeProvider.id : providers[0]?.id || ''),
      cache: stats,
      historyCount: history.length,
      usage,
      engineInfo: {
        strategy: `${settings.ai.strategy} · контекст ${settings.ai.contextTokens} · чанк ${settings.ai.chunkTokens} токенов`,
        keyStorage: settings.advanced.keyStorage,
      },
    };
  },

  /** Panel: is there an interrupted job this video can explicitly continue? */
  [MSG.RESUME_INFO]: async (msg) =>
    inspectResumableJob({
      input: msg,
      providerId: msg.providerId,
      model: msg.model,
    }),

  [MSG.GET_VIDEO_DATA]: async (msg) => {
    const bundle = await loadBundle(msg.videoId, { force: !!msg.force, hl: msg.hl || 'en' });
    return { ok: true, ...bundle };
  },

  [MSG.GET_TRANSCRIPT]: async (msg) => {
    const settings = await getSettings();
    const transcript = await ensureTranscript({
      videoId: msg.videoId,
      segments: msg.segments,
      meta: msg.meta,
      lang: msg.lang || settings.output.language,
      preferManual: settings.advanced.preferManualCaptions,
      translate: msg.translate !== false,
      force: !!msg.force,
    });
    const plan = planStrategy({
      segments: transcript.segments,
      maxTokens: Math.max(settings.ai.contextTokens || 128000, settings.ai.chunkTokens || 6000),
      chunkTokens: settings.ai.chunkTokens,
      strategy: settings.ai.strategy,
    });
    return {
      ok: true,
      videoId: transcript.videoId,
      segments: transcript.segments,
      meta: transcript.meta,
      tracks: transcript.tracks,
      format: transcript.format,
      cached: !!transcript.cached,
      plan: { strategy: plan.strategy, chunks: plan.chunks.length, tokens: plan.tokens },
    };
  },

  [MSG.LOCAL_ASK]: async (msg) => {
    const settings = await getSettings();
    const { analysis, transcript } = await loadAnalysis(msg, settings);
    const res = answerLocal(msg.question || '', analysis, { topK: 5 });
    const density = infoDensityScore(analysis);
    return {
      ok: true,
      ...res,
      density,
      overview: analysis.sentences
        .slice()
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, 3)
        .sort((a, b) => (a.at || 0) - (b.at || 0))
        .map((s) => ({ text: s.display, at: s.at })),
      meta: { lang: transcript.meta.lang, source: transcript.meta.source, engine: 'search' },
    };
  },

  [MSG.LIST_MODELS]: async (msg) => {
    const providers = await getProviders();
    const provider = providers.find((p) => p.id === msg.providerId);
    if (!provider) throw new AIError('NO_PROVIDER', 'Провайдер не найден');
    const apiKey = await getApiKey(provider.id);
    const models = await listModels({ provider, apiKey });
    if (models.length) {
      const merged = Array.from(new Set([...(provider.models || []), ...models])).slice(0, 300);
      await upsertProvider({ ...provider, models: merged });
    }
    return { ok: true, models, count: models.length };
  },

  [MSG.TEST_PROVIDER]: async (msg) => {
    const providers = await getProviders();
    const provider = providers.find((p) => p.id === msg.providerId);
    if (!provider) throw new AIError('NO_PROVIDER', 'Провайдер не найден');
    const apiKey = msg.apiKey !== undefined ? msg.apiKey : await getApiKey(provider.id);
    const model = msg.model || provider.defaultModel || (provider.models || [])[0];
    const res = await testProvider({ provider, apiKey, model });
    return { ok: true, ...res };
  },

  [MSG.SAVE_SETTINGS]: async (msg) => {
    const settings = msg.reset ? await resetSettings() : await saveSettings(msg.patch || {});
    return { ok: true, settings };
  },

  [MSG.SAVE_PROVIDERS]: async (msg) => {
    if (Array.isArray(msg.providers)) {
      const saved = await saveProviders(msg.providers);
      return { ok: true, providers: saved };
    }
    if (msg.provider) {
      const saved = await upsertProvider(msg.provider);
      if (msg.setDefault) await saveSettings({ ai: { providerId: saved.id, model: saved.defaultModel || (saved.models || [])[0] || '' } });
      return { ok: true, provider: saved };
    }
    return { ok: true, providers: await getProviders() };
  },

  [MSG.DELETE_PROVIDER]: async (msg) => {
    const providers = await deleteProvider(msg.providerId);
    return { ok: true, providers };
  },

  [MSG.SAVE_KEY]: async (msg) => {
    await setApiKey(msg.providerId, msg.apiKey || '');
    return { ok: true, keyPreview: maskKey(msg.apiKey || '') };
  },

  [MSG.GET_CACHE]: async (msg) => {
    const entry = await getCached({
      videoId: msg.videoId,
      mode: msg.mode,
      lang: msg.lang,
      providerId: msg.providerId || '',
      model: msg.model || '',
      variant: msg.variant || 'v1',
    });
    return { ok: true, entry };
  },

  [MSG.PUT_CACHE]: async (msg) => {
    const entry = await putCached(msg.params || {}, msg.summary, msg.meta || {});
    return { ok: true, entry };
  },

  [MSG.CLEAR_CACHE]: async () => {
    await clearCache();
    return { ok: true };
  },

  [MSG.CACHE_STATS]: async () => ({ ok: true, ...(await cacheStats()) }),

  [MSG.GET_HISTORY]: async () => ({ ok: true, history: await getHistory() }),

  [MSG.CLEAR_HISTORY]: async () => {
    await clearHistory();
    return { ok: true };
  },

  [MSG.EXPORT_DATA]: async (msg) => ({ ok: true, data: await exportAll({ includeKeys: !!msg.includeKeys }) }),

  [MSG.IMPORT_DATA]: async (msg) => {
    await importAll(msg.payload, { merge: msg.merge !== false });
    return { ok: true };
  },

  [MSG.OPEN_OPTIONS]: async (msg) => {
    const section = msg?.section;
    const base = ext.runtime.getURL('src/options/options.html');
    const url = `${base}${section ? `#${section}` : ''}`;
    if (section) {
      // Deep links (e.g. "providers" from an error card) must land on the
      // right section, so reuse an open options tab or create one with the hash.
      const tabs = await ext.tabs.query({}).catch(() => []);
      const existing = (tabs || []).find((tab) => (tab.url || '').startsWith(base));
      if (existing) {
        await ext.tabs.update(existing.id, { active: true, url }).catch(() => {});
        return { ok: true };
      }
      await ext.tabs.create({ url });
      return { ok: true };
    }
    if (ext.runtime.openOptionsPage) {
      await ext.runtime.openOptionsPage();
    } else {
      await ext.tabs.create({ url });
    }
    return { ok: true };
  },

  [MSG.EXPORT_MD]: async (msg) => {
    const settings = await getSettings();
    const result = msg.result;
    if (!result) throw new Error('Нет данных для экспорта');
    const transcript = msg.includeTranscript ? await ensureTranscript(msg).catch(() => null) : null;
    const format = msg.format || 'md';
    const text =
      format === 'json'
        ? JSON.stringify(transcript ? { ...result, transcript: transcript.segments } : result, null, 2)
        : format === 'txt'
          ? renderText(result, { includeTranscript: !!transcript, transcript: transcript?.segments, uiLang: settings.ui.lang })
          : renderMarkdown(result, { includeTranscript: !!transcript, transcript: transcript?.segments, uiLang: settings.ui.lang });
    return { ok: true, text, filename: filenameFor(result, format) };
  },

  [MSG.DOWNLOAD]: async (msg) => {
    const filename = safeFilename(msg.filename || 'opensummary');
    const mime = DOWNLOAD_MIMES.has(String(msg.mime || '')) ? String(msg.mime) : 'text/plain';
    const content = String(msg.content ?? '');
    if (content.length > 1500000) {
      throw new AIError('TOO_LARGE', 'Файл слишком большой для этого способа сохранения', {
        hint: 'Скопируйте текст в буфер обмена.',
      });
    }
    const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
    const id = await ext.downloads.download({ url, filename, saveAs: !!msg.saveAs });
    return { ok: true, downloadId: id, filename };
  },

  [MSG.INJECT_CONTENT]: async (msg) => {
    const ok = await ensureContentInTab(msg.tabId);
    return { ok };
  },

  [MSG.OPEN_PANEL]: async (msg) => {
    const tabs = msg.tabId ? [{ id: msg.tabId }] : await ext.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) return { ok: false, error: 'Нет активной вкладки' };
    const sent = await sendToTabSafe(tab.id, { type: 'osum:command', action: msg.action || 'open', mode: msg.mode, autoRun: msg.autoRun !== false });
    return { ok: !!sent };
  },

  // The content script reports what its scraper saw: the panel lives in the
  // page, so only it can tell why nothing was read. Appended to the diagnostics
  // ring buffer (no page text, no secrets).
  [MSG.JOURNAL]: async (msg) => {
    const event = msg?.event && typeof msg.event === 'object' ? msg.event : {};
    recordJournal({ level: 'warn', ...event, route: event.route || 'page-panel' });
    return { ok: true };
  },

  [MSG.GET_JOURNAL]: async () => ({ ok: true, lines: journalLines() }),

  // The content script gets the transcript from the page itself (the only
  // origin YouTube accepts for get_transcript) and sends the raw JSON here:
  // the parser is an ES module, which a content script cannot import.
  [MSG.PARSE_TRANSCRIPT]: async (msg) => {
    const text = String(msg?.json || '');
    if (!text) throw Object.assign(new Error('Пустой ответ транскрипта'), { code: 'EMPTY_RESPONSE' });
    if (text.length > 8 * 1024 * 1024) {
      throw Object.assign(new Error('Ответ транскрипта слишком большой'), { code: 'TOO_LARGE' });
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Ответ get_transcript не JSON'), { code: 'BAD_JSON' });
    }
    const segments = parseTranscriptResponse(json);
    return { ok: true, segments, count: segments.length };
  },

  [MSG.WIPE_ALL]: async () => {
    await wipeAll();
    clearJournal();
    return { ok: true };
  },

  /** Content script → worker: put the page bridge into the page's own world. */
  [MSG.INJECT_PAGE_BRIDGE]: async (_msg, sender) => {
    const tabId = sender?.tab?.id;
    if (!tabId) return { ok: false, error: 'NO_TAB' };
    return injectPageBridge(tabId);
  },
};

async function addHistoryEntry(result) {
  await addHistory({
    videoId: result.videoId,
    mode: result.mode,
    title: result.videoTitle,
    channel: result.channel,
    lengthSeconds: result.lengthSeconds,
    lang: result.lang,
    providerId: result.meta?.providerId || '',
    model: result.model || '',
  });
}

function filenameFor(result, format) {
  const ext = format === 'json' ? 'json' : format === 'txt' ? 'txt' : 'md';
  return safeFilename(`${result.videoTitle || result.videoId || 'summary'} — OpenSummary.${ext}`);
}

async function ensureContentInTab(tabId) {
  const { ensureContentScript } = await import('./state.js');
  return ensureContentScript(tabId);
}

async function sendToTabSafe(tabId, message) {
  const { sendToTab } = await import('./state.js');
  return sendToTab(tabId, message);
}

/* ------------------------------------------------------------------ dispatch */

export async function dispatch(message, sender = {}) {
  if (!message || typeof message !== 'object') return { ok: false, error: 'Пустое сообщение' };
  const handler = handlers[message.type];
  if (!handler) return { __error: `Неизвестный тип сообщения: ${message.type}`, __code: 'UNKNOWN_MESSAGE' };
  try {
    return await handler(message, sender);
  } catch (err) {
    const code = err?.code || 'HANDLER_ERROR';
    const messageText = err?.message || String(err);
    if (code !== 'EMPTY_TRANSCRIPT') {
      console.warn(`[OpenSummary] ${message.type} failed:`, code, messageText);
    }
    return {
      __error: messageText,
      __code: code,
      __data: {
        hint: err?.hint || '',
        provider: err?.provider || '',
        status: err?.status || 0,
        detail: err?.detail || '',
      },
    };
  }
}

export { handlers };
