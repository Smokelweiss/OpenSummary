/**
 * Ring buffer of the last transcript events (which route was tried, what it
 * returned, why it failed). Lives in the worker's memory for the current
 * lifetime and is mirrored into extension storage, so a diagnostics report
 * still carries history after the worker has been torn down and restarted.
 *
 * Two storage areas are used on purpose: `storage.session` is not available in
 * every Firefox build (and a background page may be torn down before an
 * un-awaited write lands), so every write also falls back to `storage.local`.
 *
 * No secrets, no page text: codes, counters and host names only.
 */

import { ext } from './compat.js';

export const JOURNAL_LIMIT = 20;
const KEY = 'osum:journal';

let entries = [];
/** Latest pending write, so a caller can await persistence before answering. */
let pending = Promise.resolve();

function areas() {
  const list = [];
  try {
    if (ext?.storage?.session) list.push(ext.storage.session);
  } catch {
    /* session is optional */
  }
  try {
    if (ext?.storage?.local) list.push(ext.storage.local);
  } catch {
    /* local is required by the manifest, but never assume */
  }
  return list;
}

function byTime(list) {
  return list.slice().sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')));
}

/**
 * Reads the persisted tail. Always hits storage: the page that shows the
 * report may have been open since before the failure, so a cached copy would
 * show an empty log exactly when it matters.
 */
export async function loadJournal() {
  const found = [];
  for (const store of areas()) {
    try {
      const res = await store.get(KEY);
      const stored = res ? res[KEY] : null;
      if (Array.isArray(stored) && stored.length) found.push(...stored);
    } catch {
      /* a report without history is still a report */
    }
  }
  if (found.length) {
    const merged = dedupe(byTime(found));
    entries = merged.slice(-JOURNAL_LIMIT);
  }
  return entries.slice();
}

function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const key = `${item?.at || ''}\u0000${item?.route || ''}\u0000${item?.code || ''}\u0000${item?.message || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Appends one event; `at` is added automatically. Errors are never thrown. */
export function recordJournal(event = {}) {
  const entry = {
    at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    ...event,
  };
  entries = [...entries, entry].slice(-JOURNAL_LIMIT);
  const snapshot = entries.slice();
  for (const store of areas()) {
    pending = pending
      .catch(() => {})
      .then(() => store.set({ [KEY]: snapshot }))
      .catch(() => {});
  }
  return entry;
}

/** Resolves once the buffered writes have landed (or failed). */
export async function flushJournal() {
  try {
    await pending;
  } catch {
    /* ignore */
  }
}

export function readJournal() {
  return entries.slice();
}

export async function clearJournal() {
  entries = [];
  for (const store of areas()) {
    try {
      await store.remove(KEY);
    } catch {
      /* ignore */
    }
  }
}

/**
 * One human-readable line per event, oldest first:
 *   `FAIL 2026-10-17 14:18:27 page-panel/abc123 NO_PAGE_TRANSCRIPT — панель открыта …, cells=0`
 */
export function journalLines() {
  return entries.map((e) => {
    const status = e.level === 'ok' ? 'OK  ' : e.level === 'warn' ? 'WARN' : 'FAIL';
    const head = [e.route || 'transcript', e.videoId].filter(Boolean).join('/');
    const code = e.code ? `${e.code} — ` : '';
    const extra = [e.segments != null ? `${e.segments} seg` : '', e.lang || ''].filter(Boolean).join(' · ');
    return `${status} ${e.at} ${head} ${code}${e.message || ''}${extra ? ` [${extra}]` : ''}`.trim();
  });
}
