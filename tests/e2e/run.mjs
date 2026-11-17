#!/usr/bin/env node
/**
 * Real-browser regression test for OpenSummary.
 *
 *   npm run e2e
 *   npm run e2e -- --chrome "/path/to/chrome" --headed --keep-temp --no-build
 *
 * The harness builds the extension, copies it to a temporary directory, adds a
 * loopback content-script match to that copy only, and loads it into a real
 * Chrome/Chromium through CDP. A local page and a controllable SSE provider
 * exercise the actual panel:
 *
 *   paste transcript -> AI mode -> run -> draft while the provider holds
 *   -> release -> final summary -> provider error card -> AUTH -> run details
 *   -> rejected key -> auth error card
 *
 * Exit code is non-zero on any failed assertion, including console errors and
 * uncaught exceptions. Screenshots and logs stay in dist/e2e-artifacts; the
 * temporary profile and extension copy are removed.
 *
 * The `job-deadline` race is a client-level condition with no UI trigger: a
 * fetch that rejects synchronously on abort can beat the wall clock. It stays
 * covered by the unit test in tests/ai.test.mjs and is run by `npm test`.
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clickText,
  connectCdp,
  launchChrome,
  newTarget,
  panelText,
  resolveChrome,
  screenshot,
  waitFor,
  waitForCdp,
} from './chrome.mjs';
import {
  CAPTURE_PAGE,
  CAPTURE_PANEL,
  CAPTURE_SEGMENTS,
  HEAD,
  P1,
  P3,
  P4,
  STUB_PAGE,
  TAIL,
  TLDR_HEAD,
  TRANSCRIPT_LINES,
  longTranscriptText,
  transcriptText,
} from './fixtures.mjs';
import { createMockProvider } from './mock-provider.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = join(ROOT, 'dist', 'e2e-artifacts');
const WATCHDOG_MS = 180000;

/** A computed colour as a string, spelled out without an `rgb(...)` literal. */
const rgb = (...channels) => ['rgb', '(', channels.join(', '), ')'].join('');

let artifactsReady = false;
let logFile = '';
let tempDir = '';
let pageServer = null;
let mock = null;
let chrome = null;
let browser = null;
let optionsPage = null;
let page = null;
let cleaned = false;
let watchdog = null;

function log(message) {
  const line = String(message);
  console.log(line);
  if (artifactsReady && logFile) {
    try {
      writeFileSync(logFile, `${line}\n`, { flag: 'a' });
    } catch {
      /* logging must never break the run */
    }
  }
}

function parseArgs(argv) {
  const options = { chrome: '', headed: false, build: true, keepTemp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'OpenSummary browser E2E',
          '',
          '  npm run e2e',
          '  npm run e2e -- [--chrome <path>] [--headed] [--no-build] [--keep-temp]',
          '',
          '  --chrome <path>  Chrome/Chromium binary (or OSUM_CHROME / CHROME_PATH)',
          '  --headed         run with a visible window for debugging',
          '  --no-build       use the existing dist/opensummary-chrome',
          '  --keep-temp      keep the temporary profile and extension copy',
          '',
          `Artifacts: dist/e2e-artifacts/`,
        ].join('\n'),
      );
      process.exit(0);
    }
    if (arg === '--headed') options.headed = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--keep-temp') options.keepTemp = true;
    else if (arg === '--chrome') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--chrome требует путь к браузеру');
      options.chrome = value;
    }
    else if (arg.startsWith('--chrome=')) options.chrome = arg.slice('--chrome='.length);
    else throw new Error(`неизвестный аргумент: ${arg} (см. --help)`);
  }
  return options;
}

function prepareArtifacts() {
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  logFile = join(ARTIFACTS, 'run.log');
  artifactsReady = true;
  writeFileSync(logFile, '');
}

function buildExtension() {
  log('сборка: node tools/build.mjs');
  const res = spawnSync(process.execPath, [join(ROOT, 'tools', 'build.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    const output = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
    throw new Error(`сборка расширения не удалась (код ${res.status}):\n${output}`);
  }
  log('сборка готова');
}

/** Adds the loopback match to the temporary copy, never to the real build. */
function patchTestManifest(extDir) {
  const file = join(extDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const script = (manifest.content_scripts || []).find((entry) =>
    (entry.matches || []).includes('https://www.youtube.com/*'),
  );
  if (!script) throw new Error('в собранном manifest нет контент-скрипта для YouTube');
  if (!script.matches.includes('http://127.0.0.1/*')) script.matches.push('http://127.0.0.1/*');
  const hosts = new Set(manifest.host_permissions || []);
  hosts.add('http://127.0.0.1/*');
  manifest.host_permissions = [...hosts];
  // The page-world bridge is a web-accessible script: without the loopback
  // origin here its <script> is blocked and the capture route cannot be tested.
  for (const entry of manifest.web_accessible_resources || []) {
    if (!Array.isArray(entry.matches)) continue;
    if (!entry.matches.includes('http://127.0.0.1/*')) entry.matches.push('http://127.0.0.1/*');
  }
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

function listen(server) {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePort(server.address().port);
    });
  });
}

async function cleanup({ keepTemp = false } = {}) {
  if (cleaned) return;
  cleaned = true;
  if (watchdog) clearTimeout(watchdog);
  for (const session of [page, optionsPage, browser]) {
    try {
      session?.close();
    } catch {
      /* already closed */
    }
  }
  try {
    pageServer?.closeAllConnections?.();
    pageServer?.close();
  } catch {
    /* already closed */
  }
  try {
    mock?.close();
  } catch {
    /* already closed */
  }
  const child = chrome?.child;
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    // Windows keeps the profile files locked until the process has exited, so
    // wait for it before deleting the temporary directory.
    await Promise.race([
      once(child, 'exit').catch(() => {}),
      new Promise((resolveWait) => setTimeout(resolveWait, 3000)),
    ]);
  }
  if (tempDir && !keepTemp) {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      log(`не удалось удалить временный каталог: ${tempDir}`);
    }
  } else if (tempDir) {
    log(`временный каталог сохранён: ${tempDir}`);
  }
}

function installSignalHandlers() {
  const stop = (signal, code) => {
    log(`прервано (${signal}) — освобождаю порты и процессы`);
    cleanup().finally(() => process.exit(code));
  };
  process.on('SIGINT', () => stop('SIGINT', 130));
  process.on('SIGTERM', () => stop('SIGTERM', 143));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  installSignalHandlers();

  if (options.build) buildExtension();
  prepareArtifacts();
  const sourceExt = join(ROOT, 'dist', 'opensummary-chrome');
  if (!existsSync(sourceExt)) {
    throw new Error(
      `сборка не найдена: ${sourceExt}\nЗапустите npm run build или уберите --no-build.`,
    );
  }

  const { binary, searched } = resolveChrome(options.chrome);
  log(`браузер: ${binary}`);
  if (!options.chrome) log(`искал среди ${searched.length} путей`);

  const prodManifestPath = join(ROOT, 'manifest.json');
  const prodManifestBefore = readFileSync(prodManifestPath, 'utf8');

  tempDir = mkdtempSync(join(tmpdir(), 'osum-e2e-'));
  const extDir = join(tempDir, 'ext');
  cpSync(sourceExt, extDir, { recursive: true });
  patchTestManifest(extDir);
  log(`изолированная копия расширения: ${extDir}`);

  mock = createMockProvider({ head: HEAD, tail: TAIL, log });
  const mockUrl = await listen(mock.server);
  log(`SSE-мок: http://127.0.0.1:${mockUrl}`);

  pageServer = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // The fake YouTube endpoints used by the capture page: the old transcript
    // route refuses (as it does in production) and the panel route answers with
    // the view-model shape that replaced it.
    if (url.pathname === '/youtubei/v1/get_transcript') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Precondition check failed."}}');
      return;
    }
    if (url.pathname === '/youtubei/v1/get_panel') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(CAPTURE_PANEL));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(url.searchParams.get('capture') === '1' ? CAPTURE_PAGE : STUB_PAGE);
  });
  const pagePort = await listen(pageServer);
  log(`страница-заглушка: http://127.0.0.1:${pagePort}`);

  const cdpPort = await freePort();
  const profileDir = join(tempDir, 'profile');
  mkdirSync(profileDir, { recursive: true });
  chrome = launchChrome(binary, {
    profileDir,
    port: cdpPort,
    headed: options.headed,
    logPath: join(ARTIFACTS, 'chrome.log'),
  });
  chrome.child.on('exit', (code) => log(`браузер завершился с кодом ${code}`));

  const version = await waitForCdp(cdpPort, {
    child: chrome.child,
    tail: chrome.stderrTail,
  });
  log(`браузер запущен: ${version.Browser}`);
  if (!/Chrome\/(\d+)/.test(version.Browser) || Number(RegExp.$1) < 116) {
    log('предупреждение: расширению нужен Chrome 116+');
  }

  browser = await connectCdp(version.webSocketDebuggerUrl);
  let loaded;
  try {
    loaded = await browser.send('Extensions.loadUnpacked', { path: extDir });
  } catch (err) {
    throw new Error(
      `Chrome не смог загрузить unpacked-расширение через CDP: ${err.message}\n` +
        'Нужен Chrome 137+ и флаг --enable-unsafe-extension-debugging; харнесс включает его сам.',
    );
  }
  const extId = loaded.id;
  log(`расширение загружено: ${extId}`);

  const optionsTarget = await newTarget(cdpPort, `chrome-extension://${extId}/src/options/options.html`);
  optionsPage = await connectCdp(optionsTarget.webSocketDebuggerUrl);
  await waitFor(optionsPage, "!!document.getElementById('version')", 'страница настроек');
  const optionsTitle = await optionsPage.evaluate('document.title');
  if (!String(optionsTitle).includes('OpenSummary')) {
    throw new Error(`страница настроек не открылась: title="${optionsTitle}"`);
  }
  log(`настройки: "${optionsTitle}"`);

  // Both pages must wear YouTube's dark palette, not the blue-tinted slate they
  // had before: #0f0f0f page, #212121 cards, #f1f1f1 text.
  const darkPalette = async (page, label) => {
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    const colors = await page.evaluate(`(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        bg: root.getPropertyValue('--bg').trim(),
        card: root.getPropertyValue('--card').trim(),
        text: root.getPropertyValue('--text').trim(),
        body: getComputedStyle(document.body).backgroundColor,
      };
    })()`);
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    const want = { bg: '#0f0f0f', card: '#212121', text: '#f1f1f1', body: rgb(15, 15, 15) };
    for (const [key, value] of Object.entries(want)) {
      if (colors[key] !== value) {
        throw new Error(`${label}: тёмная тема не в палитре YouTube — ${key} = ${colors[key]}, ожидалось ${value}`);
      }
    }
    log(`${label}: тёмная палитра ${JSON.stringify(colors)}`);
  };
  await darkPalette(optionsPage, 'настройки');
  const popupTarget = await newTarget(cdpPort, `chrome-extension://${extId}/src/popup/popup.html`);
  const popupPage = await connectCdp(popupTarget.webSocketDebuggerUrl);
  await waitFor(popupPage, "!!document.querySelector('.head')", 'popup');
  await darkPalette(popupPage, 'popup');

  const provider = {
    id: 'p-mock',
    name: 'Mock Local',
    type: 'openai',
    baseUrl: `http://127.0.0.1:${mockUrl}/v1`,
    chatPath: '/chat/completions',
    models: ['mock-1'],
    defaultModel: 'mock-1',
    authScheme: 'bearer',
    enabled: true,
  };
  const settings = {
    schema: 1,
    mode: 'ai',
    ai: {
      providerId: 'p-mock',
      model: 'mock-1',
      stream: true,
      retries: 0,
      useCache: false,
      chunkCache: false,
      strategy: 'auto',
      contextTokens: 128000,
      chunkTokens: 6000,
      timeoutMs: 60000,
    },
    cache: { enabled: false },
    ui: { lang: 'ru', showFab: true, autoOpenPanel: false, theme: 'light' },
  };
  await optionsPage.evaluate(
    `chrome.storage.local.set(${JSON.stringify({
      'osum:settings': settings,
      'osum:providers': [provider],
      'osum:keys': { 'p-mock': 'sk-mock-local' },
    })})`,
  );
  log('настройки и провайдер записаны в storage.local');

  const watchTarget = await newTarget(
    cdpPort,
    `http://127.0.0.1:${pagePort}/youtube.com/watch?v=dQw4w9WgXcQ`,
  );
  page = await connectCdp(watchTarget.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');

  const speed = {};
  const openPanel = async () => {
    const openStartedAt = Date.now();
    await waitFor(
      page,
      "!!document.getElementById('osum-host')?.shadowRoot?.querySelector('.osum-fab')",
      'панель не смонтировалась',
    );
    await page.evaluate(
      "document.getElementById('osum-host').shadowRoot.querySelector('.osum-fab').click()",
    );
    await waitFor(
      page,
      "!document.getElementById('osum-host').shadowRoot.querySelector('.osum-panel').hidden",
      'панель не открылась',
    );
    // The floating button must be gone once the panel is open — it used to sit
    // on top of the panel and answer clicks on stale state.
    const fab = await page.evaluate(`(() => {
      const hosts = document.querySelectorAll('#osum-host');
      const button = document.getElementById('osum-host').shadowRoot.querySelector('.osum-fab');
      return { hosts: hosts.length, hidden: !!button?.hidden, display: getComputedStyle(button).display };
    })()`);
    if (fab.hosts !== 1) throw new Error(`в документе ${fab.hosts} копий панели — контент-скрипт внедрён дважды`);
    if (!fab.hidden || fab.display !== 'none') {
      throw new Error(`кнопка осталась поверх открытой панели: hidden=${fab.hidden}, display=${fab.display}`);
    }
    speed.openMs = Date.now() - openStartedAt;
    if (speed.openMs > 2500) throw new Error(`панель открывалась ${speed.openMs} мс — медленнее бюджета 2500 мс`);
  };

  /**
   * The stub page has no captions of its own, so the transcript is handed to the
   * content script through the same entry point a page-scraped transcript uses.
   * CDP can only see the page's main world, so this evaluates inside the
   * extension's isolated world (the contexts Runtime.enable reported).
   */
  const contentScriptContextId = () => {
    const contexts = page.events
      .filter((event) => event.method === 'Runtime.executionContextCreated')
      .map((event) => event.params.context)
      .filter((context) => String(context.origin || '').startsWith('chrome-extension://'));
    return contexts.length ? contexts[contexts.length - 1].id : 0;
  };

  const feedTranscript = async (text = transcriptText()) => {
    const contextId = contentScriptContextId();
    if (!contextId) throw new Error('контекст контент-скрипта не найден');
    // Not awaited: the run itself is held open by the mock provider, so waiting
    // for the promise would block until the release that comes later.
    const out = await page.send('Runtime.evaluate', {
      contextId,
      expression: `OSUM.debug.transcript(${JSON.stringify(text)})`,
      awaitPromise: false,
      returnByValue: true,
      userGesture: true,
    });
    if (out.exceptionDetails) {
      throw new Error(`контент-скрипт не смог принять транскрипт: ${out.exceptionDetails.text}`);
    }
  };

  const runOnStubTranscript = async () => {
    await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-quick-toggle').click()");
    await waitFor(
      page,
      "!document.getElementById('osum-host').shadowRoot.querySelector('.osum-quick').hidden",
      'быстрые настройки не раскрылись',
    );
    await feedTranscript();
  };

  const reload = async () => {
    await page.send('Page.reload');
  };

  /* ---------------------------------------------------------- 1. draft + final */
  mock.setMode('hold');
  mock.resetGate();
  await openPanel();

  /* --------------------- 1d. quick settings fit on one row, All settings at right */
  await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-quick-toggle').click()");
  await waitFor(
    page,
    "!document.getElementById('osum-host').shadowRoot.querySelector('.osum-quick').hidden",
    'быстрые настройки не раскрылись',
    { timeoutMs: 5000 },
  );
  // One engine: provider, model, language, length and the summary mode. The
  // selects legitimately wrap to a second line, so only the row height and the
  // pinned “All settings” are checked.
  await waitFor(
    page,
    "document.getElementById('osum-host').shadowRoot.querySelectorAll('.osum-quick-row .osum-select').length === 5",
    'в быстрых настройках нет провайдера, модели, языка, объёма и режима',
    { timeoutMs: 5000 },
  );
  const engineSwitch = await page.evaluate(
    "document.getElementById('osum-host').shadowRoot.querySelectorAll('.osum-seg').length",
  );
  if (engineSwitch !== 0) throw new Error('переключатель движка вернулся в панель');
  const quick = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const row = sr.querySelector('.osum-quick-row');
    const all = sr.querySelector('.osum-quick-all');
    const controls = sr.querySelector('.osum-quick-row .osum-controls');
    const rect = (node) => (node ? node.getBoundingClientRect() : { top: 0, right: 0, height: 0 });
    return {
      rowHeight: Math.round(rect(row).height),
      allRight: rect(all).right - rect(controls).right,
      hasTitle: !!sr.querySelector('.osum-quick-title'),
      paste: sr.textContent.includes('Вставить текст'),
      placeholders: [...sr.querySelectorAll('input, textarea')].length,
      parts: [...(row?.children || [])].map((node) => ({
        cls: node.className,
        w: Math.round(rect(node).width),
        h: Math.round(rect(node).height),
      })),
      inner: [...(controls?.children || [])].map((node) => ({
        cls: node.className,
        w: Math.round(rect(node).width),
      })),
    };
  })()`);
  log(`быстрые настройки: ${JSON.stringify(quick)}`);
  if (quick.hasTitle) throw new Error('заголовок «Настройки» вернулся в блок быстрых настроек');
  if (quick.paste || quick.placeholders) throw new Error('поле ручной вставки текста вернулось в панель');
  if (quick.rowHeight > 96) throw new Error(`быстрые настройки занимают ${quick.rowHeight}px — больше двух строк`);
  if (quick.allRight < 0) throw new Error('«Все настройки» должны стоять справа от контролов');
  await screenshot(page, join(ARTIFACTS, '6-quick-settings.png'));
  await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-quick-toggle').click()");

  const draftStartedAt = Date.now();
  await runOnStubTranscript();
  log('транскрипт передан, панель запустила конспект сама');

  await waitFor(
    page,
    `document.getElementById('osum-host').shadowRoot.querySelector('.osum-live')?.textContent.includes(${JSON.stringify(TLDR_HEAD)})`,
    'черновик до конца ответа',
  );
  speed.firstDraftMs = Date.now() - draftStartedAt;
  const draft = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const live = sr.querySelector('.osum-live');
    return {
      liveText: live ? live.textContent.slice(0, 400) : '',
      hasP1: !!live && live.textContent.includes(${JSON.stringify(P1)}),
      hasRawJson: !!live && live.textContent.includes('"tldr"'),
      hasFinalChips: !!sr.querySelector('.osum-chip-row'),
      activeTab: sr.querySelector('.osum-tab[aria-selected="true"]')?.textContent || '',
      status: sr.querySelector('.osum-status')?.textContent || '',
    };
  })()`);
  const mockBefore = { ...mock.state };
  log(`черновик: ${JSON.stringify({ ...draft, liveText: draft.liveText.slice(0, 90) })}`);

  if (mockBefore.promptSegments !== TRANSCRIPT_LINES) {
    throw new Error(
      `переданный текст дошёл до провайдера не целиком: ${mockBefore.promptSegments} из ${TRANSCRIPT_LINES} фрагментов`,
    );
  }
  if (mockBefore.released) {
    throw new Error('мок отпустил остаток слишком рано: черновика ещё не должно быть видно');
  }
  if (mockBefore.requests !== 1) throw new Error(`ожидался один запрос, получено ${mockBefore.requests}`);
  if (!draft.liveText.includes(TLDR_HEAD)) throw new Error('в черновике нет TL;DR');
  if (!draft.hasP1) throw new Error('в черновике нет первого проверенного пункта');
  if (draft.hasRawJson) throw new Error('сырой JSON попал в черновик');
  if (draft.hasFinalChips) throw new Error('черновик выдаёт себя за готовый конспект');
  if (draft.activeTab !== 'Обзор') {
    throw new Error(`после запуска открыта вкладка «${draft.activeTab}», а не «Обзор»`);
  }
  await screenshot(page, join(ARTIFACTS, '1-draft-before-release.png'));

  const finishStartedAt = Date.now();
  mock.release();
  await waitFor(
    page,
    "!document.getElementById('osum-host').shadowRoot.querySelector('.osum-live')",
    'готовый конспект вместо черновика',
    { timeoutMs: 20000 },
  );
  speed.finalRenderMs = Date.now() - finishStartedAt;
  if (speed.finalRenderMs > 3000) {
    throw new Error(`готовый конспект отрисовался за ${speed.finalRenderMs} мс — медленнее бюджета 3000 мс`);
  }
  const finalState = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      tldr: sr.querySelector('.osum-tldr-text')?.textContent || '',
      hasP3: sr.textContent.includes(${JSON.stringify(P3)}),
      rawJson: sr.textContent.includes('"keyPoints"'),
      error: !!sr.querySelector('.osum-error'),
      activeTab: sr.querySelector('.osum-tab[aria-selected="true"]')?.textContent || '',
    };
  })()`);
  log(`итог: ${JSON.stringify({ ...finalState, tldr: finalState.tldr.slice(0, 80) })}`);
  log(`скорость: ${JSON.stringify(speed)}`);
  if (!finalState.tldr.includes(TLDR_HEAD)) {
    throw new Error(`итоговый TL;DR не совпал с черновым: ${finalState.tldr}`);
  }
  if (!finalState.hasP3) throw new Error('в итоговом конспекте нет позднего пункта');
  if (finalState.rawJson) throw new Error('сырой JSON попал в итоговый конспект');
  if (finalState.error) throw new Error('после успешного прогона показана карточка ошибки');
  if (finalState.activeTab !== 'Обзор') throw new Error('итог показан не на вкладке «Обзор»');
  await screenshot(page, join(ARTIFACTS, '2-final-result.png'));

  // Typography check: a wrapped key moment must keep its second line under the
  // text column, not under the timecode. Range rects are the real layout.
  const wrapInfo = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    for (const el of sr.querySelectorAll('.osum-doc .osum-point .osum-line')) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1);
      if (rects.length > 1) {
        return { lines: rects.map((r) => Math.round(r.left)), text: el.textContent.slice(0, 60) };
      }
    }
    return null;
  })()`);
  if (wrapInfo && Math.abs(wrapInfo.lines[0] - wrapInfo.lines[1]) > 2) {
    throw new Error(
      `вторая строка пункта смещена под таймкод: ${wrapInfo.lines.join(' / ')} (${wrapInfo.text})`,
    );
  }

  // One moment, one timecode: P2 and P4 share 2:00 and must be a single block
  // with a dotted list, not two rows repeating the same number.
  const grouping = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    for (const block of sr.querySelectorAll('.osum-doc .osum-point')) {
      if (!block.textContent.includes(${JSON.stringify(P4)})) continue;
      return {
        chips: block.querySelectorAll('.osum-ts').length,
        dots: block.querySelectorAll('.osum-dot').length,
        ts: block.querySelector('.osum-ts')?.textContent || '',
        paired: block.textContent.includes('Ленивые вычисления'),
      };
    }
    return null;
  })()`);
  log(`группа по таймкоду: ${JSON.stringify(grouping)}`);
  if (!grouping) throw new Error('блок с общим таймкодом не отрисован');
  if (grouping.chips !== 1) throw new Error(`таймкод момента повторился: ${grouping.chips}`);
  if (grouping.dots < 2) throw new Error(`пункты одного момента не сложились в список: ${grouping.dots}`);
  if (!grouping.paired) throw new Error('второй пункт того же момента потерялся');

  /* ------------- 1b. no video map; the whole section heading is the seek link */
  const overviewState = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const title = sr.querySelector('.osum-doc .osum-section-head .osum-section-title');
    return {
      tabs: [...sr.querySelectorAll('.osum-tab')].map((t) => t.textContent),
      mapBars: sr.querySelectorAll('.osum-map-bar, .osum-map').length,
      hasMapLabel: /Video map|Карта видео/.test(sr.querySelector('.osum-body')?.textContent || ''),
      headingTag: title ? title.tagName : '',
      headingRole: title?.getAttribute('role') || '',
      headingTs: title?.querySelector('.osum-ts')?.textContent || '',
      headingText: title?.querySelector('.osum-h3')?.textContent || '',
      headingSummary: title?.querySelector('.osum-sec-summary')?.textContent || '',
      headingTitle: title?.getAttribute('title') || '',
    };
  })()`);
  log(`обзор: ${JSON.stringify(overviewState)}`);
  if (overviewState.tabs.join('|') !== 'Обзор|Вопросы') {
    throw new Error(`ожидались две вкладки, получено: ${overviewState.tabs.join('|')}`);
  }
  if (overviewState.mapBars || overviewState.hasMapLabel) {
    throw new Error(`карта видео должна быть удалена: колонок ${overviewState.mapBars}`);
  }
  if (
    overviewState.headingTag !== 'DIV' ||
    overviewState.headingRole !== 'button' ||
    !overviewState.headingTs ||
    !overviewState.headingText ||
    !overviewState.headingSummary
  ) {
    throw new Error(
      `заголовок и его саммари должны быть одним блоком с таймкодом: ${JSON.stringify(overviewState)}`,
    );
  }
  // The heading itself seeks: clicking the words must not fall into the “cannot
  // seek” error, which is what a dead element would show.
  await page.evaluate(
    "document.getElementById('osum-host').shadowRoot.querySelector('.osum-doc .osum-section-head .osum-section-title').click()",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const seekToast = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return sr.querySelector('.osum-toast')?.textContent || '';
  })()`);
  if (/не удалось|cannot/i.test(seekToast)) throw new Error(`клик по заголовку не перематывает видео: ${seekToast}`);
  await screenshot(page, join(ARTIFACTS, '5-section-heading.png'));

  /* ------------------------- 1b2. the header theme button really switches the panel */
  const themeBefore = await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-root').dataset.theme");
  await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-theme').click()");
  await waitFor(
    page,
    "document.getElementById('osum-host').shadowRoot.querySelector('.osum-root').dataset.theme === 'dark'",
    'тёмная тема не включилась',
  );
  // The dark palette must be YouTube's: the transcript window's #212121 surface
  // on #0f0f0f, not the bluish slate the panel used to wear.
  const darkColors = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const root = sr.querySelector('.osum-root');
    const panel = sr.querySelector('.osum-panel');
    const style = getComputedStyle(root);
    return {
      surface: getComputedStyle(panel).backgroundColor,
      card: style.getPropertyValue('--osum-card').trim(),
      border: style.getPropertyValue('--osum-border').trim(),
      text: style.getPropertyValue('--osum-text').trim(),
      muted: style.getPropertyValue('--osum-muted').trim(),
    };
  })()`);
  log(`тёмная палитра: ${JSON.stringify(darkColors)}`);
  const wantDark = {
    surface: rgb(33, 33, 33),
    card: '#272727',
    border: '#3f3f3f',
    text: '#f1f1f1',
    muted: '#aaaaaa',
  };
  for (const [key, want] of Object.entries(wantDark)) {
    if (darkColors[key] !== want) {
      throw new Error(`тёмная тема не в палитре YouTube: ${key} = ${darkColors[key]}, ожидалось ${want}`);
    }
  }
  await screenshot(page, join(ARTIFACTS, '5b-dark-theme.png'));
  await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-theme').click()");
  await waitFor(
    page,
    `document.getElementById('osum-host').shadowRoot.querySelector('.osum-root').dataset.theme === ${JSON.stringify(themeBefore)}`,
    'светлая тема не вернулась',
  );

  /* ----------------------- 1c. a chapter must not repeat its own timecode below it */
  const duplicate = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const section = sr.querySelector('.osum-doc .osum-section');
    if (!section) return null;
    return {
      head: section.querySelector('.osum-section-head .osum-ts')?.textContent || '',
      first: section.querySelector('.osum-point .osum-ts')?.textContent || '',
    };
  })()`);
  log(`таймкоды раздела: ${JSON.stringify(duplicate)}`);
  if (duplicate && duplicate.head && duplicate.first === duplicate.head) {
    throw new Error(`таймкод «${duplicate.head}» повторяется в заголовке раздела и в первом пункте`);
  }

  /* ------------------------------------------------ 2. provider error mid-answer */
  mock.setMode('error');
  mock.resetGate();
  await reload();
  await openPanel();
  await runOnStubTranscript();
  await waitFor(
    page,
    "document.getElementById('osum-host').shadowRoot.querySelector('.osum-error')?.textContent.includes('PROVIDER_ERROR')",
    'карточка ошибки провайдера после обрыва ответа',
    { timeoutMs: 20000 },
  );
  const errorState = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      error: sr.querySelector('.osum-error')?.textContent || '',
      card: !!sr.querySelector('.osum-fallback'),
      live: sr.querySelector('.osum-live')?.textContent || '',
      liveUnfinished: (sr.querySelector('.osum-live')?.textContent || '').includes('показана только проверенная часть'),
      chips: sr.querySelector('.osum-chip-row')?.textContent || '',
      body: sr.querySelector('.osum-body')?.textContent.slice(0, 400) || '',
    };
  })()`);
  log(`ошибка провайдера: ${errorState.error.slice(0, 120)}`);
  if (!errorState.error.includes('upstream died')) {
    throw new Error('сообщение провайдера не дошло до карточки');
  }
  if (errorState.card) throw new Error('жёлтая плашка локального фолбэка вернулась');
  // Validated streamed items stay under the card, but must say they are partial.
  if (errorState.live && !errorState.liveUnfinished) {
    throw new Error('оборванный ответ остался на экране как готовый результат');
  }
  if (errorState.chips) throw new Error('после ошибки остался блок Run details');
  if (errorState.error.includes('локальный конспект')) {
    throw new Error('карточка обещает локальный конспект, которого больше нет');
  }
  await screenshot(page, join(ARTIFACTS, '3-provider-error.png'));

  /* --------------------------------------------------------- 3. rejected API key */
  mock.setMode('auth');
  await reload();
  await openPanel();
  await runOnStubTranscript();
  await waitFor(
    page,
    "document.getElementById('osum-host').shadowRoot.querySelector('.osum-error')?.textContent.includes('Ключ отклонён')",
    'карточка ошибки AUTH',
  );
  const authState = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      error: sr.querySelector('.osum-error')?.textContent || '',
      live: !!sr.querySelector('.osum-live'),
      chips: !!sr.querySelector('.osum-chip-row'),
      action: !!sr.querySelector('.osum-actions .osum-btn'),
    };
  })()`);
  log(`ошибка ключа: ${authState.error.slice(0, 120)}`);
  if (!authState.error.includes('не принял ключ')) throw new Error('в карточке AUTH нет подсказки');
  if (authState.live || authState.chips) throw new Error('после ошибки ключа остался конспект');
  if (!authState.action) throw new Error('карточка ошибки не предлагает действие');
  await screenshot(page, join(ARTIFACTS, '4-auth-error.png'));

  /* ------------------------------------- 4. run details: one scroll, nothing clipped */
  mock.setMode('ok');
  mock.resetGate();
  await reload();
  await openPanel();
  await runOnStubTranscript();
  await waitFor(
    page,
    "!!document.getElementById('osum-host').shadowRoot.querySelector('.osum-tldr-text')",
    'готовый конспект для проверки «Подробностей запуска»',
    { timeoutMs: 20000 },
  );
  await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const details = sr.querySelector('.osum-runs');
    details.open = true;
  })()`);
  const runsLayout = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const panel = sr.querySelector('.osum-panel');
    const body = sr.querySelector('.osum-body');
    const details = sr.querySelector('.osum-runs');
    const grid = sr.querySelector('.osum-runs .osum-stats');
    const rect = (node) => (node ? node.getBoundingClientRect() : { top: 0, bottom: 0, height: 0, right: 0 });
    return {
      count: sr.querySelectorAll('.osum-runs').length,
      insideBody: !!body?.querySelector('.osum-runs'),
      detailsScrolls: details ? details.scrollHeight - details.clientHeight : 0,
      panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 0,
      gridRight: Math.round(rect(grid).right),
      bodyRight: Math.round(rect(body).right),
      panelBottom: Math.round(rect(panel).bottom),
      detailsBottom: Math.round(rect(details).bottom),
    };
  })()`);
  log(`подробности запуска: ${JSON.stringify(runsLayout)}`);
  if (runsLayout.count !== 1) throw new Error(`ожидался один блок «Подробности запуска», найдено ${runsLayout.count}`);
  if (!runsLayout.insideBody) throw new Error('«Подробности запуска» снова вне области чтения: будет вторая полоса прокрутки');
  if (runsLayout.detailsScrolls > 2) throw new Error('у «Подробностей запуска» своя прокрутка поверх контента');
  if (runsLayout.panelOverflow > 2) throw new Error(`панель шире себя на ${runsLayout.panelOverflow}px`);
  if (runsLayout.gridRight > runsLayout.bodyRight + 1) {
    throw new Error(`сетка статистики вылезает за область чтения: ${runsLayout.gridRight} > ${runsLayout.bodyRight}`);
  }
  await screenshot(page, join(ARTIFACTS, '7-run-details.png'));

  /* ------------------------------------------------------ 5. browser hygiene */
  if (mock.state.requests !== 4) {
    throw new Error(`ожидалось ровно 4 запроса к провайдеру, получено ${mock.state.requests}`);
  }
  const exceptions = page.events.filter((event) => event.method === 'Runtime.exceptionThrown');
  if (exceptions.length) {
    throw new Error(
      `необработанное исключение на странице: ${JSON.stringify(exceptions[0].params).slice(0, 400)}`,
    );
  }
  const consoleErrors = page.events
    .filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
    .map((event) => event.params.args.map((arg) => arg.value || arg.description || '').join(' '));
  if (consoleErrors.length) {
    throw new Error(`console.error из панели: ${consoleErrors.join(' | ').slice(0, 400)}`);
  }

  /* ------- 6. transcript through the page's get_panel (no network, no DOM) */
  mock.setMode('ok');
  mock.resetGate();
  // A watch-shaped URL: the content script mounts on /youtube.com/watch only.
  const captureTarget = await newTarget(
    cdpPort,
    `http://127.0.0.1:${pagePort}/youtube.com/watch?v=captureTest01&capture=1`,
  );
  const capturePage = await connectCdp(captureTarget.webSocketDebuggerUrl);
  await capturePage.send('Page.enable');
  await capturePage.send('Runtime.enable');
  await waitFor(
    capturePage,
    "!!document.getElementById('osum-host')?.shadowRoot?.querySelector('.osum-fab')",
    'панель на тестовой странице get_panel',
    { timeoutMs: 20000 },
  );
  await capturePage.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-fab').click()");
  await waitFor(
    capturePage,
    `(() => {
      const sr = document.getElementById('osum-host').shadowRoot;
      const btn = sr.querySelector('.osum-run');
      // The panel asks the worker for providers when it opens; clicking before
      // that answer is a NO_PROVIDER, not a transcript failure.
      return !!btn && !btn.disabled;
    })()`,
    'активная кнопка запуска и быстрые настройки на тестовой странице get_panel',
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const beforeCapture = Number(mock.state.requests) || 0;
  await capturePage.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-run').click()");
  try {
    await waitFor(
      capturePage,
      `(() => {
        const sr = document.getElementById('osum-host').shadowRoot;
        return !!sr.querySelector('.osum-tldr-text') || !!sr.querySelector('.osum-error');
      })()`,
      'итог или ошибка на странице get_panel',
      { timeoutMs: 60000 },
    );
  } catch (err) {
    // What the panel was doing when the wait expired: a bare timeout says
    // nothing about which route was still hanging.
    const text = await panelText(capturePage).catch(() => '');
    const controls = await capturePage
      .evaluate(`(() => {
        const sr = document.getElementById('osum-host')?.shadowRoot;
        const buttons = [...(sr?.querySelectorAll('.osum-run') || [])].map((b) => ({
          text: b.textContent.trim(),
          disabled: !!b.disabled,
          busy: b.getAttribute('aria-busy'),
          hidden: b.hasAttribute('hidden'),
          title: b.title || '',
        }));
        return {
          status: sr?.querySelector('.osum-status')?.textContent?.replace(/\\s+/g, ' ').slice(0, 180) || '',
          error: sr?.querySelector('.osum-error')?.textContent?.replace(/\\s+/g, ' ').slice(0, 180) || '',
          toast: sr?.querySelector('.osum-toast')?.textContent?.replace(/\\s+/g, ' ').slice(0, 180) || '',
          live: !!sr?.querySelector('.osum-live'),
          buttons,
          settings: sr?.querySelector('.osum-quick')?.textContent?.replace(/\\s+/g, ' ').slice(0, 160) || '',
        };
      })()`)
      .catch((err) => ({ failed: err.message }));
    const journal = await optionsPage
      .evaluate("chrome.storage.local.get('osum:journal').then((r) => r['osum:journal'] || [])")
      .catch(() => []);
    throw new Error(
      `${err.message}\nпанель: ${text.replace(/\s+/g, ' ').slice(0, 500)}\nконтролы: ${JSON.stringify(controls)}\n` +
        `журнал: ${journal.map((entry) => `${entry.route || '?'}:${entry.code || entry.level || 'ok'}`).join(', ') || 'пуст'}`,
    );
  }
  const captureState = await capturePage.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      error: sr.querySelector('.osum-error')?.textContent || '',
      tldr: sr.querySelector('.osum-tldr-text')?.textContent || '',
    };
  })()`);
  if (captureState.error) {
    throw new Error(`маршрут get_panel не сработал: ${captureState.error.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  if (mock.state.requests <= beforeCapture) throw new Error('провайдер не получил запрос с конспектом из get_panel');
  const capturePrompt = String(mock.state.prompts[mock.state.prompts.length - 1] || '');
  for (const [, text] of CAPTURE_SEGMENTS) {
    if (!capturePrompt.includes(text)) {
      throw new Error(`в запрос не попал фрагмент из get_panel: ${text.slice(0, 60)}`);
    }
  }
  const captureJournal = await optionsPage.evaluate(
    "chrome.storage.local.get('osum:journal').then((r) => r['osum:journal'] || [])",
  );
  if (!captureJournal.some((entry) => entry.route === 'page-panel-api' && entry.level === 'ok')) {
    throw new Error('журнал не подтверждает маршрут page-panel-api');
  }
  log(`get_panel: ${CAPTURE_SEGMENTS.length} фрагмента дошли до модели, маршрут page-panel-api`);
  await screenshot(capturePage, join(ARTIFACTS, '8-get-panel.png'));

  /* ------ 7. a classifier verdict is retried, never shown as “text without JSON” */
  // The live case: a free router answered “User Safety: safe” instead of a
  // summary, the answer reached the JSON parser and the user saw BAD_JSON with
  // a hint to change the model. In the browser the retry must simply work.
  // The successful run in step 4 cached its summary for this exact video and
  // transcript: without clearing it the panel would never call the provider.
  await optionsPage.evaluate("chrome.storage.local.remove('osum:cache')");
  mock.setMode('verdict');
  mock.resetGate();
  await reload();
  await openPanel();
  await runOnStubTranscript();
  await waitFor(
    page,
    `(() => {
      const sr = document.getElementById('osum-host').shadowRoot;
      return !!sr.querySelector('.osum-tldr-text') || !!sr.querySelector('.osum-error');
    })()`,
    'итог после вердикта классификатора',
    { timeoutMs: 30000 },
  );
  const verdictState = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      error: sr.querySelector('.osum-error')?.textContent || '',
      tldr: sr.querySelector('.osum-tldr-text')?.textContent || '',
    };
  })()`);
  if (verdictState.error) {
    throw new Error(`вердикт классификатора не переигран: ${verdictState.error.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  if (!verdictState.tldr) throw new Error('повтор после вердикта классификатора не дал конспекта');
  if (mock.state.verdicts < 1) throw new Error('провайдер не отдавал вердикт классификатора');
  log(`вердикт классификатора: ${mock.state.verdicts} ответ(ов), конспект получен повтором`);
  await screenshot(page, join(ARTIFACTS, '9-misrouted-retry.png'));

  /* ------- 8. a long silent thinking phase is not “the worker did not answer” */
  // The reported bug: the panel counted only task events as liveness, ignored
  // the pong answers to its own keepalive, and killed a healthy run after 30 s.
  // The provider here sends its first items and then thinks for 35 s — longer
  // than the panel watchdog, well inside the client's 60 s progress window.
  await optionsPage.evaluate("chrome.storage.local.remove('osum:cache')");
  mock.setMode('hold');
  mock.resetGate();
  await reload();
  await openPanel();
  // The get_panel tab was opened last and owns the foreground; a background tab
  // does not run animation frames, so the streamed draft would never paint.
  await page.send('Page.bringToFront');
  await runOnStubTranscript();
  await waitFor(
    page,
    `document.getElementById('osum-host').shadowRoot.querySelector('.osum-live')?.textContent.includes(${JSON.stringify(TLDR_HEAD)})`,
    'черновик перед долгой паузой',
    { timeoutMs: 30000 },
  );
  const silentStartedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 35000));
  const duringSilence = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      error: sr.querySelector('.osum-error')?.textContent || '',
      live: sr.querySelector('.osum-live')?.textContent || '',
      run: sr.querySelector('.osum-run')?.textContent.trim() || '',
    };
  })()`);
  if (duringSilence.error) {
    throw new Error(
      `живой прогон убит после ${Math.round((Date.now() - silentStartedAt) / 1000)} с тишины: ${duringSilence.error.replace(/\s+/g, ' ').slice(0, 300)}`,
    );
  }
  if (!duringSilence.run.includes('Стоп')) throw new Error('во время паузы панель не показывает «Стоп»');
  mock.release();
  await waitFor(
    page,
    "!!document.getElementById('osum-host').shadowRoot.querySelector('.osum-tldr-text')",
    'итог после долгой паузы',
    { timeoutMs: 30000 },
  );
  log('тишина 35 с: прогон не убит, конспект получен');
  await screenshot(page, join(ARTIFACTS, '10-long-silence.png'));

  const prodManifestAfter = readFileSync(prodManifestPath, 'utf8');
  if (prodManifestAfter !== prodManifestBefore) {
    throw new Error('производственный manifest.json был изменён тестом');
  }

  log(
    'E2E OK: черновик, итог, ошибка провайдера, AUTH, быстрые настройки, «Подробности запуска», get_panel, повтор после вердикта классификатора и 35 с тишины проверены',
  );
  log(`артефакты: ${ARTIFACTS}`);
}

let exitCode = 0;
try {
  watchdog = setTimeout(() => {
    log(`E2E FAILED: общий таймаут ${Math.round(WATCHDOG_MS / 1000)} с`);
    if (page && artifactsReady) {
      screenshot(page, join(ARTIFACTS, 'failure.png')).catch(() => {});
    }
    cleanup().finally(() => process.exit(1));
  }, WATCHDOG_MS);
  // Do not let the watchdog keep a finished process alive.
  watchdog.unref();
  await main();
} catch (err) {
  exitCode = 1;
  log(`E2E FAILED: ${err.message}`);
  if (page && artifactsReady) {
    try {
      const body = await panelText(page).catch(() => '');
      writeFileSync(join(ARTIFACTS, 'failure-panel.txt'), `${err.message}\n\n${body}`);
      await screenshot(page, join(ARTIFACTS, 'failure.png'));
    } catch {
      /* diagnostics are best-effort */
    }
  }
} finally {
  await cleanup({ keepTemp: process.argv.includes('--keep-temp') });
  if (exitCode === 0 && artifactsReady) log(`артефакты сохранены: ${ARTIFACTS}`);
  process.exit(exitCode);
}
