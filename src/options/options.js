/**
 * Options page: provider management (with live model fetch and connection test),
 * interface/output/AI settings, data export-import and diagnostics.
 */

import { APP, DEFAULT_SETTINGS, LIMITS } from '../common/constants.js';
import {
  getSettings,
  saveSettings,
  resetSettings,
  getProviders,
  saveProviders,
  deleteProvider,
  getApiKeys,
  setApiKey,
  maskKey,
  cacheStats,
  getHistory,
  clearCache,
  clearHistory,
  exportAll,
  importAll,
  wipeAll,
  sanitizeProvider,
} from '../common/storage.js';
import {
  PRESETS,
  PRESET_GROUPS,
  PROVIDER_TYPES,
  providerFromPreset,
  expandBaseUrl,
  resolveChatUrl,
  resolveModelsUrl,
} from '../ai/providers.js';
import { listModels, testProvider } from '../ai/client.js';
import { loadJournal, journalLines, JOURNAL_LIMIT } from '../common/journal.js';
import { safeHttpUrl } from '../common/util.js';

const $ = (id) => document.getElementById(id);
const state = {
  settings: null,
  providers: [],
  keys: {},
  draft: null,
  editingId: '',
  activeProviderId: '',
};

/* ------------------------------------------------------------------- helpers */

let toastTimer = null;
function toast(message, variant = '') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast ${variant}`.trim();
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

function setStatus(id, text, variant = '') {
  const node = $(id);
  if (!text) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.className = `status ${variant}`.trim();
  node.textContent = text;
}

function originPattern(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) return '';
    return `${url.origin}/*`;
  } catch {
    return '';
  }
}

async function hasHostAccess(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) return true;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return true;
  }
}

async function requestHostAccess(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) return false;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------- nav */

function showSection(name) {
  for (const section of document.querySelectorAll('.section')) {
    section.hidden = section.id !== `section-${name}`;
  }
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.section === name);
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
}

function initNav() {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => showSection(item.dataset.section));
  }
  const initial = location.hash.slice(1);
  showSection(['providers', 'general', 'output', 'ai', 'data', 'about'].includes(initial) ? initial : 'providers');
  window.addEventListener('hashchange', () => {
    const name = location.hash.slice(1);
    if (name) showSection(name);
  });
}

/* ------------------------------------------------------------ provider list */

function providerTypeName(type) {
  return PROVIDER_TYPES.find((t) => t.id === type)?.name || type;
}

function renderProviderList() {
  const wrap = $('providerList');
  wrap.textContent = '';
  if (!state.providers.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.innerHTML =
      'Пока ни одного провайдера. Нажмите «Добавить провайдера» — например, <b>Google AI Studio</b>, <b>Groq</b> или <b>OpenRouter</b> (у всех есть бесплатный тариф), либо <b>Ollama</b> для полностью офлайн-работы.';
    wrap.appendChild(empty);
    return;
  }

  for (const provider of state.providers) {
    const key = state.keys[provider.id] || '';
    const ready = provider.local || provider.authScheme === 'none' || !!key;
    const isActive = provider.id === state.activeProviderId;
    const card = document.createElement('div');
    card.className = `provider-card${isActive ? ' active' : ''}`;

    const head = document.createElement('div');
    head.className = 'provider-head';
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = provider.name;
    head.appendChild(name);

    const badges = [];
    if (isActive) badges.push(['Основной', 'accent']);
    badges.push([providerTypeName(provider.type), '']);
    if (provider.free) badges.push(['бесплатный тариф', 'ok']);
    if (provider.local) badges.push(['локальный', 'ok']);
    badges.push([ready ? 'ключ есть' : 'нет ключа', ready ? 'ok' : 'err']);
    if (!provider.enabled) badges.push(['выключен', 'warn']);
    for (const [text, variant] of badges) {
      const badge = document.createElement('span');
      badge.className = `badge ${variant}`;
      badge.textContent = text;
      head.appendChild(badge);
    }
    card.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'muted small';
    const host = (() => {
      try {
        return new URL(expandBaseUrl(provider)).host;
      } catch {
        return provider.baseUrl || 'URL не задан';
      }
    })();
    meta.textContent = `${host} · модель: ${provider.defaultModel || 'не выбрана'}${key ? ` · ключ ${maskKey(key)}` : ''}`;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'provider-actions';
    actions.append(
      button('Изменить', () => openProviderForm(provider)),
      button('Проверить', async (btn) => {
        btn.disabled = true;
        btn.textContent = 'Проверяю…';
        try {
          const res = await testProvider({ provider, apiKey: key, model: provider.defaultModel || provider.models?.[0] });
          toast(`OK · ${res.latencyMs} мс · ${res.host || host}`, '');
        } catch (err) {
          toast(`${err.message}`, 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = 'Проверить';
        }
      }),
      button('Модели', async (btn) => {
        btn.disabled = true;
        btn.textContent = 'Загружаю…';
        try {
          const models = await listModels({ provider, apiKey: key });
          if (!models.length) {
            toast('Провайдер не вернул список моделей', 'err');
          } else {
            provider.models = Array.from(new Set([...(provider.models || []), ...models])).slice(0, 300);
            await upsert(provider);
            toast(`Загружено моделей: ${models.length}`);
            renderProviderList();
          }
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
          btn.textContent = 'Модели';
        }
      }),
      !isActive ? button('Сделать основным', () => makeDefault(provider)) : null,
      button('Удалить', () => removeProvider(provider), 'danger'),
    );
    card.appendChild(actions);
    wrap.appendChild(card);
  }
}

function button(label, onClick, variant = '') {
  const btn = document.createElement('button');
  btn.className = `btn ${variant}`.trim();
  btn.textContent = label;
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

async function upsert(provider) {
  state.providers = await saveProviders(upsertList(state.providers, provider));
  return provider;
}

function upsertList(list, provider) {
  const idx = list.findIndex((p) => p.id === provider.id);
  const clean = sanitizeProvider(provider);
  if (idx === -1) return [...list, clean];
  const next = list.slice();
  next[idx] = clean;
  return next;
}

async function makeDefault(provider) {
  await saveSettings({ ai: { providerId: provider.id, model: provider.defaultModel || (provider.models || [])[0] || '' } });
  state.activeProviderId = provider.id;
  state.settings = await getSettings();
  renderProviderList();
  toast(`Основной провайдер: ${provider.name}`);
}

async function removeProvider(provider) {
  if (!confirm(`Удалить провайдера «${provider.name}» вместе с его ключом?`)) return;
  state.providers = await deleteProvider(provider.id);
  delete state.keys[provider.id];
  state.settings = await getSettings();
  state.activeProviderId = state.settings.ai.providerId || '';
  renderProviderList();
  toast('Провайдер удалён');
}

/* ------------------------------------------------------------ preset picker */

function renderPresetPicker(filter = '') {
  const wrap = $('presetGroups');
  wrap.textContent = '';
  const needle = filter.trim().toLowerCase();
  for (const group of PRESET_GROUPS) {
    const presets = PRESETS.filter(
      (p) =>
        p.group === group.id &&
        (!needle || `${p.name} ${p.id} ${p.notes || ''} ${(p.models || []).join(' ')}`.toLowerCase().includes(needle)),
    );
    if (!presets.length) continue;
    const block = document.createElement('div');
    block.className = 'preset-group';
    const title = document.createElement('h3');
    title.textContent = group.name;
    block.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'preset-grid';
    for (const preset of presets) {
      const card = document.createElement('button');
      card.className = 'preset';
      card.type = 'button';
      const strong = document.createElement('strong');
      strong.textContent = preset.name;
      const note = document.createElement('span');
      note.className = 'muted';
      note.textContent = preset.notes || '';
      const tags = document.createElement('span');
      tags.className = 'tags';
      if (preset.free) tags.appendChild(tag('бесплатно', 'ok'));
      if (preset.local) tags.appendChild(tag('офлайн', 'ok'));
      tags.appendChild(tag(providerTypeName(preset.type)));
      if (preset.defaultModel) tags.appendChild(tag(preset.defaultModel));
      card.append(strong, note, tags);
      card.addEventListener('click', () => {
        $('presetPicker').hidden = true;
        openProviderForm(null, preset);
      });
      grid.appendChild(card);
    }
    block.appendChild(grid);
    wrap.appendChild(block);
  }
  if (!wrap.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Ничего не найдено. Добавьте свой endpoint через кнопку ниже.';
    const custom = document.createElement('button');
    custom.className = 'btn';
    custom.textContent = 'Свой endpoint';
    custom.addEventListener('click', () => {
      $('presetPicker').hidden = true;
      openProviderForm(null, null);
    });
    wrap.append(empty, custom);
  }
}

function tag(text, variant = '') {
  const span = document.createElement('span');
  span.className = `badge ${variant}`;
  span.textContent = text;
  return span;
}

/* -------------------------------------------------------------- provider form */

function fillTypeOptions() {
  const select = $('f-type');
  select.textContent = '';
  for (const type of PROVIDER_TYPES) {
    const option = document.createElement('option');
    option.value = type.id;
    option.textContent = type.name;
    select.appendChild(option);
  }
}

function openProviderForm(provider, preset = null) {
  const base = provider
    ? { ...provider }
    : preset
      ? providerFromPreset(preset.id)
      : sanitizeProvider({
          id: `custom-${Math.random().toString(36).slice(2, 7)}`,
          presetId: 'custom',
          name: 'Свой endpoint',
          type: 'openai',
          baseUrl: '',
          chatPath: '/chat/completions',
          modelsPath: '/models',
          authScheme: 'bearer',
          models: [],
          defaultModel: '',
          enabled: true,
        });

  state.draft = base;
  state.editingId = provider ? provider.id : '';
  $('providerForm').hidden = false;
  $('providerFormTitle').textContent = provider ? `Изменить: ${base.name}` : 'Новый провайдер';
  const presetInfo = base.presetId && base.presetId !== 'custom' ? PRESETS.find((p) => p.id === base.presetId) : null;
  $('providerFormNotes').textContent = base.notes || presetInfo?.notes || '';
  $('providerDocs').textContent = '';
  if (base.keyUrl || base.docs) {
    $('providerDocs').innerHTML = '';
    const label = document.createElement('span');
    label.textContent = base.keyUrl ? 'Где взять ключ: ' : 'Документация: ';
    // These strings come from presets, the user's form and imported configs.
    // Only http(s) may become a link: a `javascript:` URL would run inside the
    // extension origin, where the API keys live.
    const raw = base.keyUrl || base.docs;
    const href = safeHttpUrl(raw);
    if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = raw;
      $('providerDocs').append(label, link);
    } else {
      const text = document.createElement('span');
      text.textContent = raw;
      $('providerDocs').append(label, text);
    }
  }

  $('f-name').value = base.name || '';
  $('f-type').value = base.type || 'openai';
  $('f-baseUrl').value = base.baseUrl || '';
  $('f-accountId').value = base.accountId || '';
  $('f-chatPath').value = base.chatPath || '';
  $('f-modelsPath').value = base.modelsPath || '';
  $('f-authScheme').value = base.authScheme || 'bearer';
  $('f-authHeader').value = base.authHeader || '';
  $('f-authQueryParam').value = base.authQueryParam || 'key';
  $('f-models').value = (base.models || []).join('\n');
  $('f-defaultModel').value = base.defaultModel || '';
  $('f-headers').value = base.headers && Object.keys(base.headers).length ? JSON.stringify(base.headers, null, 2) : '';
  $('f-enabled').checked = base.enabled !== false;
  $('f-jsonMode').checked = !!base.jsonMode;
  $('f-apiKey').value = '';

  const existingKey = state.keys[base.id] || '';
  $('keyState').textContent = existingKey ? `Сохранён ключ: ${maskKey(existingKey)}` : 'Ключ не задан.';
  setStatus('providerStatus', '');

  syncFormVisibility();
  updateModelDatalist();
  checkHostAccess(base.baseUrl);
  $('providerForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function syncFormVisibility() {
  const scheme = $('f-authScheme').value;
  $('authHeaderField').hidden = scheme !== 'header';
  $('authQueryField').hidden = scheme !== 'query';
  const needsAccount = /\{accountId\}/.test($('f-baseUrl').value);
  $('accountField').hidden = !needsAccount;
}

function updateModelDatalist() {
  const list = $('modelOptions');
  list.textContent = '';
  for (const model of $('f-models').value.split('\n').map((m) => m.trim()).filter(Boolean)) {
    const option = document.createElement('option');
    option.value = model;
    list.appendChild(option);
  }
}

async function checkHostAccess(baseUrl) {
  const row = $('hostAccessRow');
  const hint = $('hostAccessText');
  if (!baseUrl) {
    row.hidden = true;
    return;
  }
  let host = '';
  try {
    host = new URL(expandBaseUrl({ baseUrl })).host;
  } catch {
    row.hidden = true;
    return;
  }
  const granted = await hasHostAccess(baseUrl);
  row.hidden = granted;
  if (!granted) hint.textContent = `Расширению нужен доступ к ${host}, чтобы отправлять запросы.`;
}

function collectForm() {
  const draft = { ...state.draft };
  draft.name = $('f-name').value.trim() || 'Провайдер';
  draft.type = $('f-type').value;
  draft.baseUrl = $('f-baseUrl').value.trim();
  draft.accountId = $('f-accountId').value.trim();
  draft.chatPath = $('f-chatPath').value.trim();
  draft.modelsPath = $('f-modelsPath').value.trim();
  draft.authScheme = $('f-authScheme').value;
  draft.authHeader = $('f-authHeader').value.trim();
  draft.authQueryParam = $('f-authQueryParam').value.trim() || 'key';
  draft.models = $('f-models').value
    .split('\n')
    .map((m) => m.trim())
    .filter(Boolean);
  draft.defaultModel = $('f-defaultModel').value.trim() || draft.models[0] || '';
  draft.enabled = $('f-enabled').checked;
  draft.jsonMode = $('f-jsonMode').checked;
  const headersText = $('f-headers').value.trim();
  if (headersText) {
    try {
      const parsed = JSON.parse(headersText);
      draft.headers = typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      throw new Error('Дополнительные заголовки: невалидный JSON');
    }
  } else {
    draft.headers = {};
  }
  return sanitizeProvider(draft);
}

/* --------------------------------------------------------------- settings UI */

const BINDINGS = [
  ['g-uiLang', 'ui', 'lang', 'string'],
  ['g-theme', 'ui', 'theme', 'string'],
  ['g-panelWidth', 'ui', 'panelWidth', 'number'],
  ['g-showFab', 'ui', 'showFab', 'bool'],
  ['g-docked', 'ui', 'docked', 'bool'],
  ['g-autoOpenPanel', 'ui', 'autoOpenPanel', 'bool'],
  ['g-autoSummarize', 'ui', 'autoSummarize', 'bool'],
  ['o-language', 'output', 'language', 'string'],
  ['o-length', 'output', 'length', 'string'],
  ['o-summaryMode', 'ai', 'summaryMode', 'string'],
  ['o-tone', 'output', 'tone', 'string'],
  ['o-includeTimestamps', 'output', 'includeTimestamps', 'bool'],
  ['o-selfCheck', 'output', 'selfCheck', 'bool'],
  ['o-customInstructions', 'output', 'customInstructions', 'string'],
  ['a-strategy', 'ai', 'strategy', 'string'],
  ['a-contextTokens', 'ai', 'contextTokens', 'number'],
  ['a-chunkTokens', 'ai', 'chunkTokens', 'number'],
  ['a-concurrency', 'ai', 'concurrency', 'number'],
  ['a-temperature', 'ai', 'temperature', 'number'],
  ['a-maxOutputTokens', 'ai', 'maxOutputTokens', 'number'],
  ['a-retries', 'ai', 'retries', 'number'],
  ['a-stream', 'ai', 'stream', 'bool'],
  ['a-fallbackEnabled', 'ai', 'fallbackEnabled', 'bool'],
  ['a-useCache', 'ai', 'useCache', 'bool'],
  ['a-chunkCache', 'ai', 'chunkCache', 'bool'],
  ['a-systemPromptOverride', 'ai', 'systemPromptOverride', 'string'],
  ['d-keyStorage', 'advanced', 'keyStorage', 'string'],
  ['d-cacheEnabled', 'cache', 'enabled', 'bool'],
  ['d-cacheTtl', 'cache', 'ttlDays', 'number'],
  ['d-historyLimit', 'cache', 'historyLimit', 'number'],
];

function fillSettingsForm() {
  const s = state.settings;
  for (const [id, group, key, kind] of BINDINGS) {
    const node = $(id);
    if (!node) continue;
    const value = key ? s[group]?.[key] : s[group];
    if (kind === 'bool') node.checked = value !== false && value !== 0;
    else if (kind === 'number') node.value = value ?? '';
    else node.value = value ?? '';
  }
  $('a-timeout').value = Math.round((s.ai?.timeoutMs || 90000) / 1000);
  $('aboutVersion').textContent = `Версия ${APP.version} · manifest v3`;
}

function readFromForm(id, kind) {
  const node = $(id);
  if (kind === 'bool') return node.checked;
  if (kind === 'number') {
    const n = Number(node.value);
    return Number.isFinite(n) ? n : undefined;
  }
  return node.value;
}

function initSettingsBindings() {
  // Registered before the generic handlers: chrome.permissions.request needs the
  // user gesture, and an earlier listener keeps it.
  for (const [id, group, key, kind] of BINDINGS) {
    const node = $(id);
    if (!node) continue;
    const handler = async () => {
      const value = readFromForm(id, kind);
      if (value === undefined) return;
      const patch = key ? { [group]: { [key]: value } } : { [group]: value };
      state.settings = await saveSettings(patch);
      await chrome.runtime.sendMessage({ type: 'save-settings', patch }).catch(() => {});
      notifyContent();
      if (id === 'd-keyStorage') toast('Ключи будут храниться по-новому после следующего сохранения');
      if (id === 'g-panelWidth') toast('Ширина панели применена');
    };
    node.addEventListener('change', handler);
    if (node.type === 'number' || node.tagName === 'TEXTAREA') node.addEventListener('blur', handler);
  }
  $('a-timeout').addEventListener('change', async () => {
    const seconds = Math.max(15, Math.min(900, Number($('a-timeout').value) || 180));
    state.settings = await saveSettings({ ai: { timeoutMs: seconds * 1000 } });
  });
}

function notifyContent() {
  chrome.tabs.query({ url: ['https://*.youtube.com/*'] }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'osum:settings-changed' }).catch(() => {});
    }
  });
}

/* ------------------------------------------------------------------ data ops */

async function refreshCacheStats() {
  const stats = await cacheStats();
  const history = await getHistory();
  $('d-cacheStats').textContent = `${stats.entries} конспектов · ${(stats.bytes / 1024).toFixed(0)} КБ · история ${history.length}`;
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function initDataActions() {
  $('clearCacheBtn').addEventListener('click', async () => {
    await clearCache();
    await refreshCacheStats();
    toast('Кэш очищен');
  });
  $('clearHistoryBtn').addEventListener('click', async () => {
    await clearHistory();
    await refreshCacheStats();
    toast('История очищена');
  });
  $('exportBtn').addEventListener('click', async () => {
    const data = await exportAll({ includeKeys: false });
    download(`opensummary-settings-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
    toast('Файл настроек сохранён');
  });
  $('exportKeysBtn').addEventListener('click', async () => {
    if (!confirm('В файл попадут API-ключи в открытом виде. Продолжить?')) return;
    const data = await exportAll({ includeKeys: true });
    download(`opensummary-backup-with-keys-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
    toast('Резервная копия с ключами сохранена');
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await importAll(payload, { merge: true });
      await reload();
      toast('Импорт выполнен');
    } catch (err) {
      toast(`Импорт не удался: ${err.message}`, 'err');
    } finally {
      event.target.value = '';
    }
  });
  $('resetSettingsBtn').addEventListener('click', async () => {
    if (!confirm('Сбросить все настройки к значениям по умолчанию? Провайдеры и ключи останутся.')) return;
    state.settings = await resetSettings();
    fillSettingsForm();
    toast('Настройки сброшены');
  });
  $('wipeBtn').addEventListener('click', async () => {
    if (!confirm('Удалить ВСЕ данные OpenSummary: настройки, провайдеров, ключи, историю и кэш?')) return;
    if (!confirm('Это действие необратимо. Точно продолжить?')) return;
    await wipeAll();
    await reload();
    toast('Все данные удалены');
  });
}

/* -------------------------------------------------------------- diagnostics */

async function renderDiagnostics() {
  const settings = await getSettings();
  const providers = await getProviders();
  const stats = await cacheStats();
  const history = await getHistory();
  const lines = [
    `OpenSummary ${APP.version}`,
    `extension id: ${chrome.runtime.id}`,
    `browser: ${navigator.userAgent}`,
    `platform: ${navigator.platform}`,
    `key storage: ${settings.advanced?.keyStorage}`,
    `providers: ${providers.length} (${providers.map((p) => `${p.name}:${p.type}`).join(', ') || '—'})`,
    `active: ${providers.find((p) => p.id === settings.ai.providerId)?.name || '—'} · model ${settings.ai.model || '—'}`,
    `mode: ${settings.mode} · strategy: ${settings.ai.strategy} · chunk ${settings.ai.chunkTokens}`,
    `cache: ${stats.entries} entries, ${stats.bytes} bytes · history: ${history.length}`,
    `hosts granted: ${await grantedHosts()}`,
  ];
  // History of transcript attempts: which route answered, what failed and why.
  const journal = await loadJournal();
  lines.push(`transcript log (last ${JOURNAL_LIMIT}, oldest first):`, ...(journal.length ? journalLines() : ['  — empty']));
  $('diagnostics').textContent = lines.join('\n');
}

async function grantedHosts() {
  try {
    const all = await chrome.permissions.getAll();
    return (all.origins || []).length;
  } catch {
    return '—';
  }
}

function initAboutActions() {
  $('copyDiagnosticsBtn').addEventListener('click', async () => {
    // Re-read first: the page may have been open since before the failure, and
    // a report without the journal is the one thing that cannot be debugged.
    await renderDiagnostics();
    const text = $('diagnostics').textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('Диагностика скопирована');
    } catch {
      toast('Не удалось скопировать', 'err');
    }
  });
  $('openShortcutsBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

/* ------------------------------------------------------------------ provider form wiring */

function initProviderForm() {
  fillTypeOptions();

  $('addProviderBtn').addEventListener('click', () => {
    $('presetPicker').hidden = false;
    renderPresetPicker($('presetSearch').value);
    $('presetSearch').focus();
  });
  $('closePresetBtn').addEventListener('click', () => {
    $('presetPicker').hidden = true;
  });
  $('presetSearch').addEventListener('input', (e) => renderPresetPicker(e.target.value));
  $('cancelProviderBtn').addEventListener('click', () => {
    $('providerForm').hidden = true;
    state.draft = null;
  });

  for (const id of ['f-baseUrl', 'f-authScheme']) {
    $(id).addEventListener('change', () => {
      syncFormVisibility();
      if (id === 'f-baseUrl') checkHostAccess($('f-baseUrl').value.trim());
    });
  }
  $('f-models').addEventListener('input', updateModelDatalist);
  $('f-type').addEventListener('change', syncFormVisibility);

  $('showKeyBtn').addEventListener('click', () => {
    const input = $('f-apiKey');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('showKeyBtn').textContent = hidden ? 'Скрыть' : 'Показать';
  });

  const clearKeyBtn = document.createElement('button');
  clearKeyBtn.className = 'btn';
  clearKeyBtn.type = 'button';
  clearKeyBtn.textContent = 'Удалить ключ';
  clearKeyBtn.addEventListener('click', async () => {
    if (!state.draft?.id) return;
    if (!confirm('Удалить сохранённый ключ для этого провайдера?')) return;
    await setApiKey(state.draft.id, '');
    delete state.keys[state.draft.id];
    $('keyState').textContent = 'Ключ не задан.';
    $('f-apiKey').value = '';
    renderProviderList();
    toast('Ключ удалён');
  });
  $('showKeyBtn').parentElement.appendChild(clearKeyBtn);

  $('grantHostBtn').addEventListener('click', async () => {
    const ok = await requestHostAccess($('f-baseUrl').value.trim());
    toast(ok ? 'Доступ к хосту разрешён' : 'Доступ не выдан', ok ? '' : 'err');
    await checkHostAccess($('f-baseUrl').value.trim());
  });

  $('fetchModelsBtn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    setStatus('providerStatus', 'Загружаю список моделей…', 'busy');
    try {
      const provider = collectForm();
      const apiKey = $('f-apiKey').value.trim() || state.keys[provider.id] || '';
      if (!(await hasHostAccess(provider.baseUrl))) {
        throw new Error(`Сначала разрешите доступ к хосту ${provider.baseUrl}`);
      }
      const models = await listModels({ provider, apiKey });
      if (!models.length) {
        setStatus('providerStatus', 'Провайдер вернул пустой список моделей. Проверьте путь к /models.', 'err');
        return;
      }
      const merged = Array.from(new Set([...(provider.models || []), ...models]));
      $('f-models').value = merged.join('\n');
      updateModelDatalist();
      if (!provider.defaultModel) $('f-defaultModel').value = models[0];
      setStatus('providerStatus', `Найдено моделей: ${models.length}. Первые: ${models.slice(0, 8).join(', ')}…`, 'ok');
    } catch (err) {
      setStatus('providerStatus', `${err.message}${err.hint ? `\n${err.hint}` : ''}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('testProviderBtn').addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    setStatus('providerStatus', 'Отправляю тестовый запрос…', 'busy');
    try {
      const provider = collectForm();
      const apiKey = $('f-apiKey').value.trim() || state.keys[provider.id] || '';
      if (!provider.defaultModel) throw new Error('Укажите модель по умолчанию');
      if (!(await hasHostAccess(provider.baseUrl))) throw new Error(`Сначала разрешите доступ к хосту ${provider.baseUrl}`);
      const res = await testProvider({ provider, apiKey, model: provider.defaultModel });
      setStatus(
        'providerStatus',
        `Успех: ${res.latencyMs} мс\nendpoint: ${res.endpoint}\nответ: ${res.sample || '(пусто)'}\nтокены: ${res.usage.promptTokens}/${res.usage.completionTokens}`,
        'ok',
      );
    } catch (err) {
      setStatus('providerStatus', `${err.message}${err.hint ? `\n${err.hint}` : ''}${err.detail ? `\n\n${err.detail}` : ''}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('makeDefaultBtn').addEventListener('click', async () => {
    const provider = collectForm();
    if (!provider.id) return;
    await setApiKey(provider.id, $('f-apiKey').value.trim() || state.keys[provider.id] || '');
    await upsert(provider);
    await makeDefault(provider);
    $('providerForm').hidden = true;
  });

  $('deleteProviderBtn').addEventListener('click', async () => {
    if (!state.draft?.id || !state.editingId) {
      $('providerForm').hidden = true;
      return;
    }
    await removeProvider(state.draft);
    $('providerForm').hidden = true;
  });

  $('saveProviderBtn').addEventListener('click', async () => {
    try {
      const provider = collectForm();
      if (!provider.baseUrl) throw new Error('Укажите базовый URL провайдера');
      if (!provider.defaultModel && !provider.models.length && provider.authScheme !== 'none') {
        setStatus('providerStatus', 'Совет: загрузите список моделей и выберите модель по умолчанию.', 'busy');
      }
      const typedKey = $('f-apiKey').value.trim();
      if (!(await hasHostAccess(provider.baseUrl))) {
        const granted = await requestHostAccess(provider.baseUrl);
        if (!granted) {
          setStatus('providerStatus', 'Без доступа к хосту запросы не пройдут. Нажмите «Разрешить доступ к хосту».', 'err');
          return;
        }
      }
      await upsert(provider);
      if (typedKey) {
        await setApiKey(provider.id, typedKey);
        state.keys[provider.id] = typedKey;
        $('f-apiKey').value = '';
        $('keyState').textContent = `Сохранён ключ: ${maskKey(typedKey)}`;
      }
      const settings = await getSettings();
      if (!settings.ai.providerId) await makeDefault(provider);
      state.settings = await getSettings();
      state.activeProviderId = state.settings.ai.providerId || '';
      renderProviderList();
      setStatus('providerStatus', 'Провайдер сохранён.', 'ok');
      toast('Сохранено');
    } catch (err) {
      setStatus('providerStatus', err.message, 'err');
    }
  });
}

/* --------------------------------------------------------------------- boot */

async function reload() {
  state.settings = await getSettings();
  state.providers = await getProviders();
  state.keys = await getApiKeys();
  state.activeProviderId = state.settings.ai.providerId || state.providers[0]?.id || '';
  fillSettingsForm();
  renderProviderList();
  renderPresetPicker('');
  await refreshCacheStats();
  await renderDiagnostics();
}

async function boot() {
  $('version').textContent = `v${APP.version}`;
  initNav();
  initSettingsBindings();
  initProviderForm();
  initDataActions();
  initAboutActions();
  await reload();
  // Keep two panels in sync when settings change elsewhere.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes['osum:settings'] || changes['osum:providers']) {
      reload().catch(() => {});
    }
  });
}

boot().catch((err) => {
  console.error(err);
  toast(`Ошибка настроек: ${err.message}`, 'err');
});
