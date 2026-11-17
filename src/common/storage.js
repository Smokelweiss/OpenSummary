/**
 * Storage layer: settings, providers, API keys, summary cache, history, usage.
 * Everything lives in extension storage; nothing is sent anywhere.
 */

import { DEFAULT_SETTINGS, STORAGE, LIMITS } from './constants.js';
import { getLocal, setLocal, removeLocal, getSession, setSession } from './compat.js';
import { deepMerge, hashString, nowIso, isPlainObject } from './util.js';

const MAX_CACHE_ENTRIES = 240;
/** Bounded intermediate cache: a 3-hour video leaves ~12 entries per run. */
const MAX_AI_CHUNK_ENTRIES = 400;
const AI_CHUNK_TTL_MS = 14 * 86400000;

/* ------------------------------------------------------------------ settings */

export async function getSettings() {
  const stored = (await getLocal(STORAGE.settings, {})) || {};
  const merged = deepMerge(DEFAULT_SETTINGS, stored);
  merged.ai = merged.ai || {};
  return merged;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = deepMerge(current, patch || {});
  await setLocal(STORAGE.settings, next);
  return next;
}

export async function resetSettings() {
  await setLocal(STORAGE.settings, structuredClone(DEFAULT_SETTINGS));
  return getSettings();
}

/* ----------------------------------------------------------------- providers */

export async function getProviders() {
  const list = await getLocal(STORAGE.providers, []);
  return Array.isArray(list) ? list.filter((p) => isPlainObject(p) && p.id) : [];
}

export async function saveProviders(list) {
  const clean = (Array.isArray(list) ? list : []).map(sanitizeProvider);
  const previous = await getProviders();
  await setLocal(STORAGE.providers, clean);
  // A saved key belongs to an endpoint, not to a name. If a provider is edited
  // (or imported) to point somewhere else, the key must not travel with it —
  // otherwise an imported config that keeps the familiar name “OpenRouter” but
  // changes `baseUrl` would receive the user's key on the next run.
  const before = new Map(previous.map((p) => [p.id, p]));
  for (const p of clean) {
    const old = before.get(p.id);
    if (old && endpointSignature(old) !== endpointSignature(p)) await deleteApiKey(p.id);
  }
  return clean;
}

function endpointSignature(p) {
  return [
    p?.baseUrl || '',
    p?.type || '',
    p?.accountId || '',
    p?.authScheme || '',
    p?.authHeader || '',
    p?.authQueryParam || '',
  ].join('|');
}

export async function upsertProvider(provider) {
  const list = await getProviders();
  const idx = list.findIndex((p) => p.id === provider.id);
  const clean = sanitizeProvider(provider);
  if (idx === -1) list.push(clean);
  else list[idx] = { ...list[idx], ...clean };
  await saveProviders(list);
  return clean;
}

export async function deleteProvider(id) {
  const list = (await getProviders()).filter((p) => p.id !== id);
  await saveProviders(list);
  await deleteApiKey(id);
  const settings = await getSettings();
  if (settings.ai.providerId === id) {
    await saveSettings({ ai: { providerId: '', model: '' } });
  }
  return list;
}

export function sanitizeProvider(p) {
  const headers = isPlainObject(p.headers) ? p.headers : {};
  const cleanHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && k && !/^(authorization|x-api-key)$/i.test(k)) cleanHeaders[k.trim()] = v;
  }
  return {
    id: String(p.id || '').trim(),
    presetId: String(p.presetId || 'custom'),
    name: String(p.name || 'Custom provider').slice(0, 60),
    type: ['openai', 'google', 'anthropic', 'ollama'].includes(p.type) ? p.type : 'openai',
    baseUrl: String(p.baseUrl || '').trim().replace(/\/+$/, ''),
    chatPath: String(p.chatPath || '').trim(),
    modelsPath: String(p.modelsPath || '').trim(),
    authScheme: ['bearer', 'x-api-key', 'query', 'header', 'none'].includes(p.authScheme) ? p.authScheme : 'bearer',
    authHeader: String(p.authHeader || '').trim(),
    authQueryParam: String(p.authQueryParam || 'key').trim(),
    accountId: String(p.accountId || '').trim(),
    headers: cleanHeaders,
    models: Array.isArray(p.models) ? p.models.map(String).slice(0, 200) : [],
    defaultModel: String(p.defaultModel || '').trim(),
    jsonMode: !!p.jsonMode,
    maxTokens: Number.isFinite(Number(p.maxTokens)) && Number(p.maxTokens) > 0 ? Math.min(Number(p.maxTokens), 64000) : 0,
    enabled: p.enabled !== false,
    free: !!p.free,
    local: !!p.local,
    docs: String(p.docs || '').trim(),
    keyUrl: String(p.keyUrl || '').trim(),
    notes: String(p.notes || '').slice(0, 400),
    order: Number.isFinite(p.order) ? p.order : 0,
    createdAt: p.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

/* ---------------------------------------------------------------------- keys */

async function keyStore() {
  const settings = await getSettings();
  const sessionOnly = settings?.advanced?.keyStorage === 'session';
  return sessionOnly && globalThis.chrome?.storage?.session ? 'session' : 'local';
}

export async function getApiKeys() {
  const store = await keyStore();
  const data = store === 'session'
    ? await getSession(STORAGE.sessionKeys, {})
    : await getLocal(STORAGE.keys, {});
  return isPlainObject(data) ? data : {};
}

export async function getApiKey(providerId) {
  if (!providerId) return '';
  const keys = await getApiKeys();
  return keys[providerId] || '';
}

export async function setApiKey(providerId, key) {
  if (!providerId) return;
  const store = await keyStore();
  const storageKey = store === 'session' ? STORAGE.sessionKeys : STORAGE.keys;
  const keys = store === 'session'
    ? await getSession(storageKey, {})
    : await getLocal(storageKey, {});
  const next = { ...(isPlainObject(keys) ? keys : {}) };
  if (key) next[providerId] = String(key).trim();
  else delete next[providerId];
  if (store === 'session') await setSession(storageKey, next);
  else await setLocal(storageKey, next);
}

export async function deleteApiKey(providerId) {
  await setApiKey(providerId, '');
}

export async function hasApiKey(providerId) {
  return !!((await getApiKey(providerId)) || '').trim();
}

/** Never leak a full key to the UI; return a masked preview. */
export function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

/* --------------------------------------------------------------------- cache */

export function cacheKey({ videoId, mode, lang, providerId = '', model = '', variant = 'v1' }) {
  const raw = [variant, videoId, mode, lang || 'auto', providerId, model].join('|');
  return hashString(raw);
}

export async function readCache() {
  const data = await getLocal(STORAGE.cache, {});
  return isPlainObject(data) ? data : {};
}

export async function getCached(params) {
  const settings = await getSettings();
  if (!settings.cache.enabled) return null;
  const store = await readCache();
  const id = cacheKey(params);
  const entry = store[id];
  if (!entry) return null;
  // Bind the entry to the exact transcript it was built from. Older entries
  // without the hash never match a caller that supplies one.
  if (params.transcriptHash && entry.transcriptHash !== params.transcriptHash) return null;
  const ttl = (Number(settings.cache.ttlDays) || 30) * 86400000;
  if (entry.createdAt && Date.now() - Date.parse(entry.createdAt) > ttl) {
    delete store[id];
    await setLocal(STORAGE.cache, store);
    return null;
  }
  entry.hits = (entry.hits || 0) + 1;
  entry.lastUsedAt = nowIso();
  store[id] = entry;
  await setLocal(STORAGE.cache, store);
  return entry;
}

export async function putCached(params, summary, meta = {}) {
  const settings = await getSettings();
  if (!settings.cache.enabled) return null;
  const store = await readCache();
  const id = cacheKey(params);
  store[id] = {
    id,
    createdAt: nowIso(),
    lastUsedAt: nowIso(),
    hits: 0,
    videoId: params.videoId,
    mode: params.mode,
    lang: params.lang || 'auto',
    providerId: params.providerId || '',
    model: params.model || '',
    transcriptHash: params.transcriptHash || '',
    title: meta.title || summary?.videoTitle || '',
    channel: meta.channel || summary?.channel || '',
    lengthSeconds: meta.lengthSeconds || summary?.lengthSeconds || 0,
    summary,
  };
  const ids = Object.keys(store);
  if (ids.length > MAX_CACHE_ENTRIES) {
    ids
      .map((k) => [k, Date.parse(store[k].lastUsedAt || store[k].createdAt || 0) || 0])
      .sort((a, b) => a[1] - b[1])
      .slice(0, ids.length - MAX_CACHE_ENTRIES)
      .forEach(([k]) => delete store[k]);
  }
  await setLocal(STORAGE.cache, store);
  return store[id];
}

export async function clearCache() {
  await Promise.all([setLocal(STORAGE.cache, {}), removeLocal(STORAGE.aiChunks)]);
}

/* ------------------------------------------------------- map-reduce chunk cache */

async function readAiChunks() {
  const data = await getLocal(STORAGE.aiChunks, {});
  return isPlainObject(data) ? data : {};
}

/**
 * Cached notes for one transcript fragment. The key is computed by the pipeline
 * from the chunk text, prompt revision, model and output settings, so an edited
 * transcript or a changed prompt never reuses stale notes.
 */
export async function getAiChunk(key) {
  if (!key) return null;
  const store = await readAiChunks();
  const entry = store[key];
  if (!entry) return null;
  if (Date.now() - (Date.parse(entry.at) || 0) > AI_CHUNK_TTL_MS) {
    delete store[key];
    await setLocal(STORAGE.aiChunks, store);
    return null;
  }
  return entry.partial || null;
}

export async function putAiChunk(key, partial) {
  if (!key || !isPlainObject(partial)) return null;
  const store = await readAiChunks();
  store[key] = { at: nowIso(), partial };
  const ids = Object.keys(store);
  if (ids.length > MAX_AI_CHUNK_ENTRIES) {
    ids
      .map((k) => [k, Date.parse(store[k].at) || 0])
      .sort((a, b) => a[1] - b[1])
      .slice(0, ids.length - MAX_AI_CHUNK_ENTRIES)
      .forEach(([k]) => delete store[k]);
  }
  await setLocal(STORAGE.aiChunks, store);
  return store[key];
}

export async function clearAiChunks() {
  await removeLocal(STORAGE.aiChunks);
}

export async function cacheStats() {
  const store = await readCache();
  const ids = Object.keys(store);
  const bytes = JSON.stringify(store).length;
  const chunkStore = await readAiChunks();
  const chunkIds = Object.keys(chunkStore);
  return {
    entries: ids.length,
    bytes,
    chunkEntries: chunkIds.length,
    chunkBytes: JSON.stringify(chunkStore).length,
    lastCreatedAt: ids
      .map((k) => store[k].createdAt)
      .filter(Boolean)
      .sort()
      .pop() || null,
  };
}

/* ------------------------------------------------------------------- history */

export async function getHistory() {
  const list = await getLocal(STORAGE.history, []);
  return Array.isArray(list) ? list : [];
}

export async function addHistory(entry) {
  const settings = await getSettings();
  const limit = Math.min(Number(settings.cache.historyLimit) || 300, LIMITS.maxHistory);
  const list = await getHistory();
  const filtered = list.filter((e) => !(e.videoId === entry.videoId && e.mode === entry.mode));
  filtered.unshift({
    videoId: entry.videoId,
    mode: entry.mode,
    title: entry.title || '',
    channel: entry.channel || '',
    lengthSeconds: entry.lengthSeconds || 0,
    lang: entry.lang || '',
    providerId: entry.providerId || '',
    model: entry.model || '',
    at: nowIso(),
  });
  await setLocal(STORAGE.history, filtered.slice(0, limit));
  return filtered;
}

export async function clearHistory() {
  await setLocal(STORAGE.history, []);
}

/* --------------------------------------------------------------------- usage */

export async function getUsage() {
  const data = await getLocal(STORAGE.usage, {});
  return isPlainObject(data) ? data : {};
}

export async function trackUsage(providerId, { ok = true, ms = 0, error = '', chunks = 1, tokensIn = 0, tokensOut = 0 } = {}) {
  if (!providerId) return;
  const usage = await getUsage();
  const rec = usage[providerId] || { requests: 0, errors: 0, ms: 0, chunks: 0, tokensIn: 0, tokensOut: 0 };
  rec.requests += 1;
  rec.chunks += chunks;
  rec.ms += ms || 0;
  rec.tokensIn += tokensIn || 0;
  rec.tokensOut += tokensOut || 0;
  rec.lastUsedAt = nowIso();
  if (!ok) {
    rec.errors += 1;
    rec.lastError = String(error || '').slice(0, 300);
  } else {
    rec.lastError = '';
  }
  usage[providerId] = rec;
  await setLocal(STORAGE.usage, usage);
}

/* ------------------------------------------------------------- export/import */

export async function exportAll({ includeKeys = false } = {}) {
  const settings = await getSettings();
  const providers = await getProviders();
  const keys = includeKeys ? await getApiKeys() : {};
  const payload = {
    app: 'opensummary',
    schema: 1,
    exportedAt: nowIso(),
    settings,
    providers,
    keys,
    cache: await readCache(),
    history: await getHistory(),
  };
  return payload;
}

export async function importAll(payload, { merge = true } = {}) {
  if (!payload || payload.app !== 'opensummary') throw new Error('Файл не похож на экспорт OpenSummary');
  if (payload.settings && isPlainObject(payload.settings)) {
    await setLocal(STORAGE.settings, merge ? deepMerge(await getSettings(), payload.settings) : payload.settings);
  }
  if (Array.isArray(payload.providers)) {
    const existing = merge ? await getProviders() : [];
    const byId = new Map(existing.map((p) => [p.id, p]));
    for (const p of payload.providers) byId.set(p.id, p);
    await saveProviders(Array.from(byId.values()));
  }
  if (isPlainObject(payload.keys) && Object.keys(payload.keys).length) {
    // Go through setApiKey so an import honours the “session only” key-storage
    // setting instead of quietly persisting keys to disk.
    for (const [id, key] of Object.entries(payload.keys)) {
      if (typeof key === 'string' && key.trim()) await setApiKey(id, key);
    }
  }
  if (isPlainObject(payload.cache)) {
    const current = merge ? await readCache() : {};
    await setLocal(STORAGE.cache, { ...current, ...payload.cache });
  }
  if (Array.isArray(payload.history)) {
    const current = merge ? await getHistory() : [];
    const seen = new Set();
    const merged = [...payload.history, ...current].filter((e) => {
      const k = `${e.videoId}|${e.mode}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    await setLocal(STORAGE.history, merged.slice(0, LIMITS.maxHistory));
  }
  return true;
}

export async function wipeAll() {
  await Promise.all([
    removeLocal(STORAGE.settings),
    removeLocal(STORAGE.providers),
    removeLocal(STORAGE.keys),
    removeLocal(STORAGE.cache),
    removeLocal(STORAGE.aiChunks),
    removeLocal(STORAGE.jobs),
    removeLocal(STORAGE.history),
    removeLocal(STORAGE.usage),
  ]);
  return true;
}
