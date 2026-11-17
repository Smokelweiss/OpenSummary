/**
 * Browser API compatibility layer.
 * Chrome exposes `chrome.*` (promise-based since MV3 for most APIs),
 * Firefox exposes `browser.*` (always promise-based).
 */

export const ext = (() => {
  if (typeof globalThis.browser !== 'undefined' && globalThis.browser?.runtime?.id) {
    return globalThis.browser;
  }
  if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome?.runtime?.id) {
    return globalThis.chrome;
  }
  return globalThis.chrome || globalThis.browser;
})();

export const isFirefox = (() => {
  try {
    return typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent || '');
  } catch {
    return false;
  }
})();

/** storage.local.get with a default. */
export async function getLocal(key, fallback = undefined) {
  const res = await ext.storage.local.get(key);
  const value = res ? res[key] : undefined;
  return value === undefined ? fallback : value;
}

export async function setLocal(key, value) {
  await ext.storage.local.set({ [key]: value });
  return value;
}

export async function removeLocal(key) {
  await ext.storage.local.remove(key);
}

export async function getSession(key, fallback = undefined) {
  const store = ext.storage.session || ext.storage.local;
  const res = await store.get(key);
  const value = res ? res[key] : undefined;
  return value === undefined ? fallback : value;
}

export async function setSession(key, value) {
  const store = ext.storage.session || ext.storage.local;
  await store.set({ [key]: value });
  return value;
}

/**
 * Sends a message to the background service worker and resolves with the
 * response, surfacing background errors as rejections for easier handling.
 */
export async function sendMessage(message) {
  const res = await ext.runtime.sendMessage(message);
  if (res && typeof res === 'object' && res.__error) {
    const err = new Error(res.__error);
    err.code = res.__code || 'BACKGROUND_ERROR';
    err.data = res.__data;
    throw err;
  }
  return res;
}

export function hasHostPermission(originPattern) {
  if (!originPattern) return Promise.resolve(true);
  try {
    return Promise.resolve(ext.permissions.contains({ origins: [originPattern] }));
  } catch {
    return Promise.resolve(true);
  }
}

export async function requestHostPermission(originPattern) {
  if (!originPattern) return true;
  try {
    if (await ext.permissions.contains({ origins: [originPattern] })) return true;
    return await ext.permissions.request({ origins: [originPattern] });
  } catch {
    return false;
  }
}

/** Origin match pattern for a base URL, e.g. https://api.example.com/v1 -> https://api.example.com/* */
export function originPatternFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      return `${u.protocol}//${u.hostname}/*`;
    }
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
