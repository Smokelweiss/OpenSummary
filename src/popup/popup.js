/**
 * Popup: quick actions for the active YouTube tab, provider status and history.
 * Talks to the service worker through messages only (single source of truth).
 */

const $ = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message).then((res) => {
    if (res && typeof res === 'object' && res.__error) {
      const err = new Error(res.__error);
      err.code = res.__code;
      err.hint = res.__data?.hint || '';
      throw err;
    }
    return res;
  });
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n > 1048576) return `${(n / 1048576).toFixed(1)} МБ`;
  if (n > 1024) return `${Math.round(n / 1024)} КБ`;
  return `${n} Б`;
}

function relative(iso) {
  const then = Date.parse(iso || '');
  if (!then) return '';
  const min = Math.round((Date.now() - then) / 60000);
  if (min < 1) return 'сейчас';
  if (min < 60) return `${min} мин`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч`;
  return `${Math.round(hours / 24)} дн`;
}

function isYouTube(url) {
  return /^https?:\/\/(www\.|m\.)?youtube\.com\//.test(String(url || ''));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'osum:ping' });
    if (res?.ok) return true;
  } catch {
    /* not injected yet */
  }
  try {
    await send({ type: 'inject-content', tabId });
    const res = await chrome.tabs.sendMessage(tabId, { type: 'osum:ping' });
    return !!res?.ok;
  } catch {
    return false;
  }
}

async function command(tabId, action, extra = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'osum:command', action, ...extra });
  } catch {
    return null;
  }
}

async function renderProvider(state) {
  const providers = state.providers || [];
  const active = providers.find((p) => p.id === state.activeProviderId) || providers[0] || null;
  const dot = $('providerDot');
  const name = $('providerName');
  const modelEl = $('providerModel');
  const usageRow = $('usageRow');
  const usageText = $('usageText');

  if (!active) {
    dot.classList.remove('ok');
    name.textContent = 'Не настроен';
    modelEl.textContent = 'Добавьте провайдера — есть бесплатные тарифы';
    return;
  }
  const ready = active.hasKey || active.local || active.authScheme === 'none';
  dot.classList.toggle('ok', ready);
  name.textContent = active.name + (active.free ? ' · бесплатный тариф' : '');
  const model = active.id === state.activeProviderId ? active.defaultModel || state.settings?.ai?.model || '' : active.defaultModel || '';
  modelEl.textContent = ready ? model || 'модель не выбрана' : active.keyPreview ? `ключ ${active.keyPreview}` : 'нет API-ключа';

  const usage = state.usage?.[active.id];
  if (usage?.requests) {
    usageRow.hidden = false;
    const totalMs = usage.ms || 0;
    usageText.textContent = `запросов: ${usage.requests}${usage.errors ? ` · ошибок: ${usage.errors}` : ''}${totalMs ? ` · ср. ${Math.round(totalMs / Math.max(1, usage.requests))} мс` : ''}`;
  } else {
    usageRow.hidden = true;
  }
}

function renderHistory(history) {
  const list = $('historyList');
  list.textContent = '';
  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'Пока пусто';
    list.appendChild(li);
    return;
  }
  for (const item of history.slice(0, 6)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.title = item.title || item.videoId;
    const badge = document.createElement('span');
    badge.textContent = item.mode === 'ai' ? '🤖' : '⚙️';
    const title = document.createElement('span');
    title.className = 'h-title';
    title.textContent = item.title || item.videoId;
    const meta = document.createElement('span');
    meta.className = 'h-meta';
    meta.textContent = relative(item.at);
    btn.append(badge, title, meta);
    btn.addEventListener('click', () => {
      chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${item.videoId}` });
      window.close();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function notice(text, { actionLabel, onAction } = {}) {
  const existing = document.querySelector('.notice');
  if (existing) existing.remove();
  const box = document.createElement('div');
  box.className = 'notice';
  box.textContent = text;
  if (actionLabel && onAction) {
    const link = document.createElement('button');
    link.className = 'link';
    link.textContent = actionLabel;
    link.style.marginLeft = '6px';
    link.addEventListener('click', onAction);
    box.appendChild(link);
  }
  document.body.insertBefore(box, document.body.firstChild);
}

async function main() {
  const state = await send({ type: 'get-state' });
  $('version').textContent = `v${state.version || ''}`;
  await renderProvider(state);
  renderHistory(state.history || (await send({ type: 'get-history' })).history || []);
  $('cacheInfo').textContent = state.cache?.entries ? `кэш: ${state.cache.entries} · ${formatBytes(state.cache.bytes)}` : '';

  const tab = await activeTab();
  const hint = $('pageHint');
  const buttons = ['runAi', 'openPanel'];
  const setEnabled = (enabled) => buttons.forEach((id) => ($(id).disabled = !enabled));

  if (!tab || !isYouTube(tab.url)) {
    hint.textContent = 'Откройте видео на YouTube — тогда здесь появятся кнопки для конспекта.';
    setEnabled(false);
    return;
  }

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    hint.textContent = 'Не удалось подключиться к странице. Обновите вкладку и попробуйте снова.';
    setEnabled(false);
    return;
  }

  hint.hidden = true;
  $('videoRow').hidden = false;
  setEnabled(true);

  const onPage = await chrome.tabs.sendMessage(tab.id, { type: 'osum:ping' }).catch(() => null);
  const videoId = onPage?.videoId || '';
  const thumb = $('thumb');
  if (videoId) {
    thumb.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    thumb.addEventListener('error', () => {
      thumb.style.visibility = 'hidden';
    });
  } else {
    thumb.style.display = 'none';
  }

  try {
    const data = await send({ type: 'get-video-data', videoId });
    const meta = data.meta || {};
    $('videoTitle').textContent = meta.videoTitle || 'Видео YouTube';
    const bits = [];
    if (meta.channel) bits.push(meta.channel);
    if (meta.lengthSeconds) bits.push(`${Math.floor(meta.lengthSeconds / 60)} мин`);
    if (data.tracks?.length) bits.push(`субтитры: ${data.tracks.length}`);
    else bits.push('нет субтитров');
    $('videoSub').textContent = bits.join(' · ');
  } catch (err) {
    $('videoTitle').textContent = tab.title || 'Видео YouTube';
    $('videoSub').textContent = err.message || '';
  }

  const runWith = async (autoRun) => {
    await command(tab.id, 'open', { autoRun });
    window.close();
  };

  $('runAi').addEventListener('click', () => {
    const active = (state.providers || []).find((p) => p.id === state.activeProviderId);
    if (!active || (!active.hasKey && !active.local && active.authScheme !== 'none')) {
      notice('ИИ пока не настроен: нет провайдера или ключа.', {
        actionLabel: 'Настроить',
        onAction: () => chrome.runtime.openOptionsPage(),
      });
      return;
    }
    runWith(true);
  });
  $('openPanel').addEventListener('click', () => runWith(false));

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openProviders').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

main().catch((err) => {
  notice(`Ошибка: ${err.message || err}`);
});
