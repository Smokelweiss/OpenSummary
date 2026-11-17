/**
 * Chrome/Chromium discovery and a small CDP client for the browser E2E harness.
 *
 * Chrome 137+ ignores `--load-extension` in branded builds, so the extension is
 * loaded through the `Extensions.loadUnpacked` CDP command instead. That needs
 * `--enable-unsafe-extension-debugging` at launch.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { openWebSocket } from './ws.mjs';

/** Every path the harness considers, in priority order. */
export function chromeCandidates({ platform = process.platform, env = process.env } = {}) {
  const out = [];
  const add = (path) => {
    if (path && !out.includes(path)) out.push(path);
  };
  if (env.OSUM_CHROME) add(env.OSUM_CHROME);
  if (env.CHROME_PATH) add(env.CHROME_PATH);

  if (platform === 'win32') {
    for (const base of [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]) {
      if (!base) continue;
      add(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      add(join(base, 'Chromium', 'Application', 'chrome.exe'));
      add(join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    return out;
  }

  if (platform === 'darwin') {
    for (const app of [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ]) {
      add(`/Applications/${app}`);
      add(join(env.HOME || '', 'Applications', app));
    }
    return out;
  }

  const names = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
    'microsoft-edge',
  ];
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) add(join(dir, name));
  }
  return out;
}

/** @returns {{binary: string, searched: string[]}} */
export function resolveChrome(explicit, options = {}) {
  const env = options.env || process.env;
  const searched = [];
  // An explicit path is authoritative: silently falling back to another
  // installed browser would test something else than the user asked for.
  const pinned = explicit || env.OSUM_CHROME || env.CHROME_PATH || '';
  if (pinned) {
    if (!existsSync(pinned)) {
      throw new Error(
        `указанный браузер не найден: ${pinned}\n` +
          'Исправьте --chrome / OSUM_CHROME / CHROME_PATH или уберите их, чтобы искать браузер автоматически.',
      );
    }
    return { binary: pinned, searched: [pinned] };
  }
  for (const candidate of chromeCandidates(options)) {
    searched.push(candidate);
    if (existsSync(candidate)) return { binary: candidate, searched };
  }
  const list = searched.length ? searched.map((p) => `  • ${p}`).join('\n') : '  (пути не найдены)';
  throw new Error(
    'Chromium/Chrome не найден — браузерный тест не может быть запущен.\n' +
      'Установите Chrome/Chromium или укажите бинарник явно:\n' +
      '  OSUM_CHROME="/путь/к/chrome" npm run e2e\n' +
      '  npm run e2e -- --chrome "/путь/к/chrome"\n' +
      `Проверенные пути:\n${list}`,
  );
}

/** Starts the browser and forwards its output to a log file. */
export function launchChrome(binary, { profileDir, port, headed = false, logPath = '', proxy = '' }) {
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  // A machine whose network blocks youtube.com can point the test browser at a
  // local proxy/VPN (`OSUM_CHROME_PROXY=socks5://127.0.0.1:9150`) without
  // touching the system settings Chrome would otherwise inherit.
  const route = proxy || process.env.OSUM_CHROME_PROXY || '';
  const args = [
    ...(headed ? [] : ['--headless=new']),
    '--window-size=1280,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    ...(route ? [`--proxy-server=${route}`] : []),
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const tail = [];
  const record = (chunk) => {
    const text = String(chunk);
    tail.push(text);
    while (tail.length > 40) tail.shift();
    if (logPath) {
      try {
        appendFileSync(logPath, text);
      } catch {
        /* logging must never break the run */
      }
    }
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  return { child, stderrTail: () => tail.join('').slice(-4000) };
}

/** Polls `/json/version` until the DevTools endpoint answers. */
export async function waitForCdp(port, { timeoutMs = 20000, child = null, tail = () => '' } = {}) {
  const started = Date.now();
  for (;;) {
    if (child && child.exitCode !== null) {
      throw new Error(`браузер завершился с кодом ${child.exitCode} до запуска CDP.\n${tail()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not listening yet */
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`CDP не ответил за ${Math.round(timeoutMs / 1000)} с.\n${tail()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Opens a new tab through the DevTools HTTP endpoint. */
export async function newTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`не удалось открыть вкладку ${url}: HTTP ${res.status}`);
  return res.json();
}

/** A thin CDP session over one WebSocket, collecting events for diagnostics. */
export async function connectCdp(wsUrl) {
  const socket = await openWebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let seq = 0;
  let closed = false;

  socket.onmessage = (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    if (!message.id && message.method) events.push(message);
  };
  socket.onclose = () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error('CDP session closed'));
    pending.clear();
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error('CDP session is closed'));
        return;
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP ${method} не ответил за 30 с`));
      }, 30000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });

  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (out.exceptionDetails) {
      const detail = out.exceptionDetails.exception?.description || '';
      throw new Error(`ошибка на странице: ${out.exceptionDetails.text} ${detail}`.trim());
    }
    return out.result?.value;
  };

  return { send, evaluate, events, close: () => socket.close() };
}

/** Retries an expression until it is truthy. */
export async function waitFor(page, expression, label, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await page.evaluate(expression);
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`не дождались: ${label} (${Math.round(timeoutMs / 1000)} с)`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Clicks the first element matching `selector` whose text contains `text`. */
export async function clickText(page, selector, text, label, options = {}) {
  const expression = `(() => {
    const sr = document.getElementById('osum-host')?.shadowRoot;
    if (!sr) return false;
    const el = [...sr.querySelectorAll(${JSON.stringify(selector)})].find(
      (node) => node.textContent.trim() === ${JSON.stringify(text)} ||
        node.textContent.includes(${JSON.stringify(text)}),
    );
    if (!el) return false;
    el.click();
    return true;
  })()`;
  return waitFor(page, expression, label || `элемент «${text}»`, options);
}

/** Screenshot of the current viewport, written into the artifacts directory. */
export async function screenshot(page, file) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/** Text of the panel body (Shadow DOM), useful in failure reports. */
export function panelText(page) {
  return page.evaluate(`(() => {
    const sr = document.getElementById('osum-host')?.shadowRoot;
    return sr ? sr.querySelector('.osum-body')?.textContent || '' : '';
  })()`);
}
