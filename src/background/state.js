/**
 * Background state helpers: provider resolution (with fallback chain),
 * in-memory transcript cache and tab injection.
 */

import { ext } from '../common/compat.js';
import { getApiKey, getProviders, getSettings } from '../common/storage.js';
import { AIError } from '../ai/client.js';
import { LIMITS } from '../common/constants.js';

/* ------------------------------------------------------------ memory caches */

const transcriptCache = new Map(); // key -> {payload, at}
const analysisCache = new Map(); // key -> {analysis, at}
const TRANSCRIPT_TTL = 15 * 60 * 1000;
const ANALYSIS_TTL = 10 * 60 * 1000;

function prune(map, ttl, maxEntries) {
  const now = Date.now();
  for (const [key, value] of map) {
    if (now - value.at > ttl) map.delete(key);
  }
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

export function transcriptKey({ videoId, lang, kind, translate }) {
  return `${videoId}|${lang || 'auto'}|${kind || 'any'}|${translate ? 1 : 0}`;
}

export function getCachedTranscript(key) {
  const entry = transcriptCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TRANSCRIPT_TTL) {
    transcriptCache.delete(key);
    return null;
  }
  return entry.payload;
}

export function setCachedTranscript(key, payload) {
  transcriptCache.set(key, { payload, at: Date.now() });
  prune(transcriptCache, TRANSCRIPT_TTL, 6);
  return payload;
}

export function getCachedAnalysis(key) {
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ANALYSIS_TTL) {
    analysisCache.delete(key);
    return null;
  }
  return entry.analysis;
}

export function setCachedAnalysis(key, analysis) {
  analysisCache.set(key, { analysis, at: Date.now() });
  prune(analysisCache, ANALYSIS_TTL, 4);
  return analysis;
}

export function clearMemoryCaches() {
  transcriptCache.clear();
  analysisCache.clear();
}

/* ---------------------------------------------------------------- providers */

export function providerHasCredentials(provider, apiKey) {
  if (provider.local || (provider.authScheme || 'bearer') === 'none') return true;
  return !!String(apiKey || '').trim();
}

/** Picks a provider: explicit id -> default from settings -> first enabled with a key. */
export async function resolveProvider({ providerId, model } = {}) {
  const settings = await getSettings();
  const providers = (await getProviders()).filter((p) => p.enabled !== false);
  if (!providers.length) {
    throw new AIError('NO_PROVIDER', 'ИИ-провайдер не настроен', {
      hint: 'Откройте настройки OpenSummary и добавьте провайдера (например, Google AI Studio или Groq — у них есть бесплатный тариф).',
    });
  }
  const wanted = providerId || settings.ai.providerId;
  let provider = providers.find((p) => p.id === wanted);
  if (!provider) {
    for (const candidate of providers) {
      if (providerHasCredentials(candidate, await getApiKey(candidate.id))) {
        provider = candidate;
        break;
      }
    }
  }
  provider = provider || providers[0];
  const apiKey = await getApiKey(provider.id);
  const chosenModel = model || (provider.id === settings.ai.providerId ? settings.ai.model : '') || provider.defaultModel || (provider.models || [])[0] || '';
  if (!provider.local && !apiKey && (provider.authScheme || 'bearer') !== 'none') {
    throw new AIError('NO_KEY', `Не задан API-ключ для ${provider.name}`, {
      hint: `Получите ключ: ${provider.keyUrl || provider.docs || 'в кабинете провайдера'} и вставьте его в настройках OpenSummary.`,
      provider: provider.name,
    });
  }
  if (!chosenModel) {
    throw new AIError('NO_MODEL', `Не выбрана модель для ${provider.name}`, {
      hint: 'Загрузите список моделей кнопкой «Обновить» и выберите модель в настройках провайдера.',
      provider: provider.name,
    });
  }
  return { provider, apiKey, model: chosenModel, settings };
}

/** Ordered list of providers to try (primary first), used as a fallback chain. */
export async function resolveFallbackChain({ providerId, model } = {}) {
  const primary = await resolveProvider({ providerId, model });
  const settings = primary.settings;
  if (!settings.ai.fallbackEnabled) return [primary];
  const providers = (await getProviders()).filter((p) => p.enabled !== false && p.id !== primary.provider.id);
  const chain = [primary];
  for (const provider of providers) {
    const apiKey = await getApiKey(provider.id);
    if (!providerHasCredentials(provider, apiKey)) continue;
    const chosen = provider.defaultModel || (provider.models || [])[0] || '';
    if (!chosen) continue;
    chain.push({ provider, apiKey, model: chosen, settings });
    if (chain.length >= 4) break;
  }
  return chain;
}

/* -------------------------------------------------------------- tab helpers */

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

/** Ensures the content scripts are present in an already-open tab. */
export async function ensureContentScript(tabId) {
  if (!tabId) return false;
  try {
    const res = await ext.tabs.sendMessage(tabId, { type: 'osum:ping' });
    if (res?.ok) return true;
  } catch {
    /* not injected yet */
  }
  try {
    await ext.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Runs page-bridge.js in the page's own JS world.
 *
 * A `<script src="chrome-extension://…">` element is subject to the page's
 * CSP, and YouTube's script-src does not list extension origins: the element is
 * silently refused and the page routes then report “bridge did not load”.
 * `scripting.executeScript` with `world: 'MAIN'` is the sanctioned way past it
 * (no page CSP applies to an extension injection). Returned as data, never
 * thrown: a browser without a MAIN world (Firefox) keeps the element route.
 */
export async function injectPageBridge(tabId) {
  if (!tabId) return { ok: false, error: 'NO_TAB' };
  const scripting = ext.scripting;
  if (!scripting?.executeScript) return { ok: false, error: 'NO_SCRIPTING' };
  try {
    const results = await scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['src/content/page-bridge.js'],
    });
    return { ok: true, injected: (results || []).length };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function sendToTab(tabId, message) {
  if (!tabId) return null;
  try {
    return await ext.tabs.sendMessage(tabId, message);
  } catch {
    const injected = await ensureContentScript(tabId);
    if (!injected) return null;
    try {
      return await ext.tabs.sendMessage(tabId, message);
    } catch {
      return null;
    }
  }
}

export function extractVideoId(url) {
  const s = String(url || '');
  const patterns = [
    /[?&]v=([\w-]{6,20})/,
    /youtu\.be\/([\w-]{6,20})/,
    /\/shorts\/([\w-]{6,20})/,
    /\/embed\/([\w-]{6,20})/,
    /\/live\/([\w-]{6,20})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return '';
}

export function assertTranscriptSize(segments) {
  const chars = (segments || []).reduce((a, s) => a + String(s.text || '').length, 0);
  if (chars > LIMITS.maxTranscriptChars) {
    const err = new Error('TRANSCRIPT_TOO_LARGE');
    err.code = 'TRANSCRIPT_TOO_LARGE';
    err.message = 'Транскрипт слишком большой для обработки';
    throw err;
  }
  return true;
}
