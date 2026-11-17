/**
 * OpenSummary service worker (MV3). Wires listeners, keeps the SW alive during
 * long AI tasks, handles context menus, hotkeys, alarms and tab injection.
 */

import { APP, MSG, PORT } from '../common/constants.js';
import { ext, setLocal } from '../common/compat.js';
import { getSettings, saveSettings, readCache } from '../common/storage.js';
import { STORAGE } from '../common/constants.js';
import { dispatch } from './router.js';
import { registerTaskPort } from './tasks.js';
import { clearMemoryCaches, ensureContentScript, extractVideoId, sendToTab } from './state.js';
import { clearBundleCache } from './transcripts.js';
import { flushJournal } from '../common/journal.js';
import { recoverInterruptedJobs } from './jobs.js';

const CONTEXT_MENU_ID = 'osum-summarize-link';
const CLEANUP_ALARM = 'osum-cache-cleanup';

/* ------------------------------------------------------------------ lifecycle */

ext.runtime.onInstalled.addListener(async (details) => {
  await saveSettings({}); // materialise defaults
  await setupContextMenu();
  if (details.reason === 'install' || details.reason === 'update') {
    await injectIntoOpenTabs();
  }
});

ext.runtime.onStartup?.addListener(async () => {
  await setupContextMenu();
  await recoverJobsOnBoot();
});

/**
 * MV3 may kill the worker mid-run. Mark unfinished jobs as interrupted and
 * keep their saved chunk notes; the next explicit run for the same video,
 * transcript and settings resumes them. Nothing is restarted automatically —
 * that would spend the user's quota without an explicit request.
 */
async function recoverJobsOnBoot() {
  try {
    const recovered = await recoverInterruptedJobs();
    if (recovered) console.log(`[OpenSummary] ${recovered} interrupted AI job(s) kept for resume`);
  } catch (err) {
    console.warn('[OpenSummary] job recovery failed:', err && err.message ? err.message : err);
  }
}

async function setupContextMenu() {
  try {
    await ext.contextMenus.removeAll();
    ext.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Конспект OpenSummary для этого видео',
      contexts: ['link'],
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://youtu.be/*', '*://*.youtube.com/shorts/*'],
    });
    ext.contextMenus.create({
      id: `${CONTEXT_MENU_ID}-page`,
      title: 'Открыть панель OpenSummary',
      contexts: ['page', 'video'],
      documentUrlPatterns: ['*://*.youtube.com/*'],
    });
  } catch (err) {
    console.warn('[OpenSummary] context menu setup failed:', err);
  }
}

async function injectIntoOpenTabs() {
  try {
    const tabs = await ext.tabs.query({ url: ['https://*.youtube.com/*'] });
    for (const tab of tabs) {
      await ensureContentScript(tab.id);
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------- messages */

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  // Content scripts answer their own ping; ignore it here.
  if (message.type === 'osum:ping') return false;
  dispatch(message, sender)
    // The worker can be torn down right after the response is sent, so the
    // journal write must land first; otherwise a failed run reports an empty
    // log, which is exactly when the log is needed.
    .then(async (result) => {
      await flushJournal();
      sendResponse(result);
    })
    .catch(async (err) => {
      await flushJournal();
      sendResponse({ __error: err?.message || String(err), __code: err?.code || 'DISPATCH_ERROR' });
    });
  return true; // keep the channel open for the async response
});

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT.TASK) return;
  registerTaskPort(port);
});

/* ----------------------------------------------------------------- hotkeys/menu */

ext.commands?.onCommand?.addListener?.(async (command) => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'toggle-panel') {
    await sendToTab(tab.id, { type: 'osum:command', action: 'toggle' });
  } else if (command === 'summarize-current') {
    await sendToTab(tab.id, { type: 'osum:command', action: 'open', autoRun: true });
  }
});

ext.contextMenus?.onClicked?.addListener?.(async (info, tab) => {
  const baseId = String(info.menuItemId || '').replace('-page', '');
  if (baseId === CONTEXT_MENU_ID && info.linkUrl) {
    const videoId = extractVideoId(info.linkUrl);
    if (!videoId) return;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const created = await ext.tabs.create({ url, active: true });
    await waitForTabAndSummarize(created.id);
    return;
  }
  if (info.menuItemId === `${CONTEXT_MENU_ID}-page` && tab?.id) {
    await sendToTab(tab.id, { type: 'osum:command', action: 'open', autoRun: true });
  }
});

async function waitForTabAndSummarize(tabId) {
  if (!tabId) return;
  const started = Date.now();
  await new Promise((resolve) => {
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        ext.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    ext.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      ext.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 20000);
  });
  // Small delay for YouTube's SPA to render the player.
  await new Promise((r) => setTimeout(r, 800));
  const injected = await ensureContentScript(tabId);
  if (injected) await sendToTab(tabId, { type: 'osum:command', action: 'open', autoRun: true });
  void started;
}

/* --------------------------------------------------------------------- alarms */

ext.alarms?.create(CLEANUP_ALARM, { periodInMinutes: 24 * 60, delayInMinutes: 5 });

ext.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CLEANUP_ALARM) return;
  clearMemoryCaches();
  clearBundleCache();
  const settings = await getSettings();
  const ttl = (Number(settings.cache.ttlDays) || 30) * 86400000;
  const cache = await readCache();
  let removed = 0;
  for (const [key, entry] of Object.entries(cache)) {
    const at = Date.parse(entry.lastUsedAt || entry.createdAt || 0) || 0;
    if (!at || Date.now() - at > ttl) {
      delete cache[key];
      removed++;
    }
  }
  if (removed) await setLocal(STORAGE.cache, cache);
  console.log(`[OpenSummary] cleanup: removed ${removed} cached summaries`);
});

/* ------------------------------------------------------------------ bootstrap */

// Warm the settings cache on cold start so the first message is fast.
getSettings().catch(() => {});
recoverJobsOnBoot();

console.log(`[OpenSummary] service worker ready (v${APP.version})`);
