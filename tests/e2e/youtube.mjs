#!/usr/bin/env node
/**
 * Opt-in browser test on a real YouTube watch page.
 *
 *   OSUM_YOUTUBE_TEST_URL="https://www.youtube.com/watch?v=..." npm run e2e:youtube
 *
 * AI stays mocked (local SSE server); only YouTube is live. The browser uses a
 * throw-away profile without personal cookies, and consent cookies are set for
 * that profile only. The harness checks:
 *
 *   1. the page loads, the extension mounts and finds the right video;
 *   2. the current transcript route returns normalized, ordered captions and
 *      every segment reaches the (mocked) summarization prompt;
 *   3. a supplied transcript on the same real page still shows the draft,
 *      the final summary, the local fallback and the AUTH error;
 *   4. console errors and uncaught exceptions from the extension are absent.
 *
 * A timeout is never reported as “no captions”: page, consent, CAPTCHA,
 * network, caption and provider failures carry separate codes.
 *
 * Optional: OSUM_YOUTUBE_NO_CAPTIONS_URL points at a video without captions;
 * the harness then expects the explicit no-captions state and the on-page
 * transcript action.
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { HEAD, P1, P3, TAIL, TLDR_HEAD, TRANSCRIPT_LINES, transcriptText } from './fixtures.mjs';
import { createMockProvider } from './mock-provider.mjs';
import { missingFromPrompt } from './transcript-checks.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = join(ROOT, 'dist', 'e2e-youtube-artifacts');
const WATCHDOG_MS = 420000;

let artifactsReady = false;
let logFile = '';
let tempDir = '';
let mock = null;
let chrome = null;
let browser = null;
let optionsPage = null;
let page = null;
let cleaned = false;
let watchdog = null;
let extId = '';

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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArgs(argv) {
  const options = {
    chrome: '',
    url: '',
    noCaptionsUrl: '',
    headed: false,
    build: true,
    keepTemp: false,
    cycles: 0,
    cycleUrls: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'OpenSummary real-YouTube E2E',
          '',
          '  OSUM_YOUTUBE_TEST_URL="https://www.youtube.com/watch?v=..." npm run e2e:youtube',
          '  npm run e2e:youtube -- [--url <url>] [--no-captions-url <url>] [--chrome <path>]',
          '',
          '  --url <url>               video with captions (or OSUM_YOUTUBE_TEST_URL)',
          '  --no-captions-url <url>   optional video without captions',
          '  --chrome <path>           Chrome/Chromium binary',
          '  --headed                  visible window for debugging',
          '  --no-build                use the existing dist/opensummary-chrome',
          '  --keep-temp               keep the temporary profile and extension copy',
          '  --cycles N                repeat the whole summary flow N times',
          '  --cycle-urls a,b          videos for the cycles (default: --url)',
          '',
          'Artifacts: dist/e2e-youtube-artifacts/',
        ].join('\n'),
      );
      process.exit(0);
    }
    if (arg === '--headed') options.headed = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--keep-temp') options.keepTemp = true;
    else if (arg === '--cycles') options.cycles = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith('--cycles=')) options.cycles = Math.max(0, Number(arg.slice('--cycles='.length)) || 0);
    else if (arg === '--cycle-urls') options.cycleUrls = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--cycle-urls=')) options.cycleUrls = arg.slice('--cycle-urls='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--url') options.url = argv[++i] || '';
    else if (arg.startsWith('--url=')) options.url = arg.slice('--url='.length);
    else if (arg === '--no-captions-url') options.noCaptionsUrl = argv[++i] || '';
    else if (arg.startsWith('--no-captions-url=')) options.noCaptionsUrl = arg.slice('--no-captions-url='.length);
    else if (arg === '--chrome') options.chrome = argv[++i] || '';
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

function normalizeYouTubeUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`OSUM_YOUTUBE_TEST_URL не является URL: ${input}`);
  }
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.replace(/^\//, '').split('/')[0];
    if (!id) throw new Error(`в ссылке youtu.be нет идентификатора видео: ${input}`);
    return `https://www.youtube.com/watch?v=${id}&hl=en`;
  }
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) {
    throw new Error(`тестовый URL должен быть на youtube.com, получено: ${url.origin}`);
  }
  return url.toString();
}

function videoIdFromUrl(input) {
  const url = new URL(input);
  return url.searchParams.get('v') || (url.pathname.match(/\/(?:shorts|live|embed)\/([\w-]+)/) || [])[1] || '';
}

/** Adds only the test origin that the temporary copy may be missing. */
function patchTestManifest(extDir, origin) {
  const file = join(extDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const script = (manifest.content_scripts || []).find((entry) =>
    (entry.matches || []).includes('https://www.youtube.com/*'),
  );
  if (!script) throw new Error('в собранном manifest нет контент-скрипта для YouTube');
  const pattern = `${origin}/*`;
  if (!script.matches.includes(pattern)) script.matches.push(pattern);
  const hosts = new Set(manifest.host_permissions || []);
  hosts.add('https://*.youtube.com/*');
  manifest.host_permissions = [...hosts];
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

async function listen(server) {
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

async function pageInfo() {
  return page.evaluate(`(() => ({
    href: location.href,
    title: document.title || '',
    text: (document.body && document.body.innerText || '').slice(0, 1200),
    panel: !!document.getElementById('osum-host'),
  }))()`);
}

/** Classifies a page that is not a usable watch page; null when it looks fine. */
function classifyPage(info) {
  const href = String(info.href || '');
  const text = `${info.title || ''}\n${info.text || ''}`;
  if (href.startsWith('chrome-error://') || /ERR_(?:CONNECTION|NAME|TIMED_OUT|INTERNET|SSL|CERT|BLOCKED|ABORTED)/i.test(text)) {
    const code = (text.match(/ERR_[A-Z_]+/) || ['ERR_NETWORK'])[0];
    return { code: 'NETWORK', message: `YouTube недоступен из этой сети (${code})` };
  }
  if (/consent\.youtube\.com|Before you continue to YouTube|Прежде чем перейти/i.test(`${href}\n${text}`)) {
    return {
      code: 'CONSENT',
      message: 'YouTube показал страницу согласия на cookie вместо видео',
    };
  }
  if (/\/sorry\/|unusual traffic|not a robot|Подтвердите, что вы не робот|Подозрительный трафик/i.test(`${href}\n${text}`)) {
    return {
      code: 'CAPTCHA',
      message: 'YouTube потребовал проверку «вы не робот» — автоматическая сессия заблокирована',
    };
  }
  if (/Video unavailable|Это видео недоступно|Private video|Приватное видео|Sign in to confirm your age|Подтвердите свой возраст/i.test(text)) {
    return {
      code: 'VIDEO_UNAVAILABLE',
      message: `Видео недоступно без входа: ${String(info.title || href).slice(0, 120)}`,
    };
  }
  return null;
}

/**
 * A local proxy (VPN/Tor) can refuse one connection under load; that is a
 * transport hiccup, not a statement about the video, so it is retried once.
 * Consent walls, CAPTCHAs and “no captions” are never retried.
 */
async function navigate(url) {
  try {
    await navigateOnce(url);
  } catch (err) {
    if (!/ERR_(?:SOCKS|CONNECTION|NAME|TIMED_OUT|PROXY|INTERNET)/i.test(err.message)) throw err;
    log(`  сеть: ${String(err.message).slice(0, 120)} — повтор через 2 с`);
    await delay(2000);
    await navigateOnce(url);
  }
}

async function navigateOnce(url) {
  // A blocked network can leave Page.navigate pending for a long time. Race it
  // with a hard limit, then read the actual network error instead of reporting
  // a mysterious CDP timeout.
  let result = null;
  try {
    result = await Promise.race([
      page.send('Page.navigate', { url }),
      delay(20000).then(() => null),
    ]);
  } catch (err) {
    throw new Error(`YouTube не открылся: ${err.message}`);
  }
  if (result?.errorText) {
    throw new Error(`YouTube недоступен: ${result.errorText}`);
  }
  if (!result) {
    await page.send('Page.stopLoading').catch(() => {});
    let failed = null;
    for (let i = 0; i < 20 && !failed; i++) {
      failed = page.events
        .filter(
          (event) =>
            event.method === 'Network.loadingFailed' &&
            event.params?.errorText &&
            !/ERR_ABORTED/.test(event.params.errorText),
        )
        .pop();
      if (!failed) await delay(150);
    }
    if (failed) throw new Error(`YouTube недоступен: ${failed.params.errorText}`);
    const info = await pageInfo().catch(() => null);
    const problem = info ? classifyPage(info) : null;
    if (problem) throw new Error(`${problem.message} [${problem.code}]`);
    throw new Error(
      'YouTube не открылся за 20 с: соединение с youtube.com не установлено (сеть или прокси)',
    );
  }
  await waitFor(page, "document.readyState === 'complete'", 'загрузка страницы YouTube', {
    timeoutMs: 30000,
  }).catch(() => {});
  const problem = classifyPage(await pageInfo());
  if (problem) throw new Error(`${problem.message} [${problem.code}]`);
}

async function openPanel() {
  const problem = classifyPage(await pageInfo());
  if (problem) throw new Error(`${problem.message} [${problem.code}]`);
  await waitFor(
    page,
    "!!document.getElementById('osum-host')?.shadowRoot?.querySelector('.osum-fab')",
    'панель расширения не смонтировалась на странице YouTube',
    { timeoutMs: 30000 },
  );
  await page.evaluate(
    "document.getElementById('osum-host').shadowRoot.querySelector('.osum-fab').click()",
  );
  await waitFor(
    page,
    "!document.getElementById('osum-host').shadowRoot.querySelector('.osum-panel').hidden",
    'панель расширения не открылась',
    { timeoutMs: 10000 },
  );
}

async function clickPrimary() {
  await waitFor(
    page,
    "!!document.getElementById('osum-host').shadowRoot.querySelector('.osum-run')",
    'кнопка «Саммари» не появилась',
    { timeoutMs: 15000 },
  );
  await page.evaluate(
    "document.getElementById('osum-host').shadowRoot.querySelector('.osum-run').click()",
  );
}

/** The mode switch now lives in quick settings, folded behind the gear. */
async function switchToAi() {
  const opened = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const box = sr.querySelector('.osum-quick');
    if (box && !box.hidden) return false;
    sr.querySelector('.osum-quick-toggle').click();
    return true;
  })()`);
  if (opened) await waitFor(page, "!document.getElementById('osum-host').shadowRoot.querySelector('.osum-quick').hidden", 'быстрые настройки не раскрылись');
}

/**
 * Feeds the transcript through the content script's own entry point. The panel
 * no longer has a manual paste box, and CDP cannot reach the extension's
 * isolated world by evaluating in the page, so the evaluation is bound to the
 * content-script context Runtime.enable reported.
 */
async function runOnGivenTranscript() {
  await switchToAi();
  const contexts = page.events
    .filter((event) => event.method === 'Runtime.executionContextCreated')
    .map((event) => event.params?.context)
    .filter((context) => String(context?.origin || '').startsWith('chrome-extension://'));
  const contextId = contexts.length ? contexts[contexts.length - 1].id : 0;
  if (!contextId) throw new Error('контекст контент-скрипта не найден');
  const out = await page.send('Runtime.evaluate', {
    contextId,
    expression: `OSUM.debug.transcript(${JSON.stringify(transcriptText())})`,
    awaitPromise: false,
    returnByValue: true,
    userGesture: true,
  });
  if (out.exceptionDetails) {
    throw new Error(`контент-скрипт не смог принять транскрипт: ${out.exceptionDetails.text}`);
  }
}

async function reloadWatchPage() {
  await page.send('Page.reload');
  await waitFor(page, "document.readyState === 'complete'", 'перезагрузка страницы YouTube', {
    timeoutMs: 60000,
  });
  const problem = classifyPage(await pageInfo());
  if (problem) throw new Error(`${problem.message} [${problem.code}]`);
  await openPanel();
}

async function readJournal() {
  return optionsPage.evaluate("chrome.storage.local.get('osum:journal').then((r) => r['osum:journal'] || [])");
}

/**
 * Saves the service-worker journal next to a failed run. Without it a
 * TRANSCRIPT_ERROR only says “no text”; with it every route (timedtext,
 * get_transcript, legacy) shows its own code and message.
 */
async function dumpJournal(label) {
  if (!optionsPage) return;
  try {
    const entries = await readJournal();
    writeFileSync(join(ARTIFACTS, 'journal.json'), JSON.stringify(entries, null, 2));
    if (entries.length) {
      log(`журнал (${label}): ${entries.map((e) => `${e.route || '?'}:${e.code || e.level || 'ok'}`).join(', ')}`);
    } else {
      log(`журнал (${label}) пуст — service worker не записал ни одного маршрута`);
    }
  } catch (err) {
    log(`журнал (${label}) не прочитан: ${String(err.message || err).slice(0, 120)}`);
  }
}

function classifyTranscriptFailure(card, journal) {
  const text = String(card || '');
  const codes = journal.map((entry) => entry.code).filter(Boolean);
  const routes = [...new Set(journal.map((entry) => entry.route).filter(Boolean))];
  if (/PO-token|POT_REQUIRED/i.test(text) || codes.includes('POT_REQUIRED')) {
    return { code: 'POT_REQUIRED', message: text.slice(0, 400), routes };
  }
  if (/нет субтитров|NO_CAPTIONS|EMPTY_CAPTIONS/i.test(text) || codes.includes('NO_CAPTIONS')) {
    return { code: 'NO_CAPTIONS', message: text.slice(0, 400), routes };
  }
  if (/cookie|CONSENT|согласи/i.test(text) || codes.includes('CONSENT')) {
    return { code: 'CONSENT', message: text.slice(0, 400), routes };
  }
  if (/YouTube ответил|сеть|соединени|NETWORK|ERR_/i.test(text) || codes.includes('NETWORK')) {
    return { code: 'NETWORK', message: text.slice(0, 400), routes };
  }
  return { code: 'TRANSCRIPT_ERROR', message: text.slice(0, 400), routes };
}

/**
 * Waits for either a provider request (transcript loaded) or an explicit error
 * card. A timeout is a separate failure: it must never read as “no captions”.
 */
async function waitRunStart({ videoId, timeoutMs = 120000, since = 0 }) {
  const started = Date.now();
  let lastStatus = '';
  for (;;) {
    if (mock.state.requests > since) return { started: true };
    const state = await page.evaluate(`(() => {
      const sr = document.getElementById('osum-host')?.shadowRoot;
      return {
        error: sr?.querySelector('.osum-error')?.textContent || '',
        status: sr?.querySelector('.osum-status')?.textContent || '',
        href: location.href,
      };
    })()`);
    if (state.error) {
      const journal = (await readJournal()).filter((entry) => entry.videoId === videoId);
      const failure = classifyTranscriptFailure(state.error, journal);
      return { error: failure, card: state.error, status: state.status, journal };
    }
    if (state.status && state.status !== lastStatus) {
      lastStatus = state.status;
      log(`  статус: ${state.status.slice(0, 160)}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `не дождались ни запроса к мок-провайдеру, ни ошибки транскрипта за ${Math.round(timeoutMs / 1000)} с ` +
          `(статус: ${lastStatus || '—'}). Это таймаут, а не «нет субтитров»`,
      );
    }
    await delay(250);
  }
}

/**
 * The panel no longer renders a transcript tab (YouTube's own panel covers
 * it), so the delivery check runs on what actually reached the provider. The
 * real video's transcript is not the synthetic fixture: count the timecode
 * markers and words the prompt actually carries, not “На шаге N” lines.
 */
async function transcriptSnapshot() {
  const prompt = mock.state.prompts.join('\n');
  const total = (prompt.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g) || []).length;
  const words = prompt.split(/\s+/).filter(Boolean).length;
  if (total < 3 || words < 50) {
    throw new Error(`транскрипт пуст: в запросе ${total} таймкодов и ${words} слов`);
  }
  return { rows: [], total, words, hint: '' };
}

/** Validates what a user would see and what the prompt must contain. */
function promptCoverage(rows) {
  const missing = missingFromPrompt(rows, mock.state.prompts.join('\n'));
  if (missing.length) {
    throw new Error(
      `в запрос к провайдеру не попали ${missing.length} фрагментов, например: ${missing[0].slice(0, 120)}`,
    );
  }
}

async function waitForDraft(label) {
  await waitFor(
    page,
    `document.getElementById('osum-host').shadowRoot.querySelector('.osum-live')?.textContent.includes(${JSON.stringify(TLDR_HEAD)})`,
    label,
    { timeoutMs: 30000 },
  );
}

async function waitForFinal() {
  await waitFor(
    page,
    `!document.getElementById('osum-host').shadowRoot.querySelector('.osum-live') &&
     document.getElementById('osum-host').shadowRoot.textContent.includes(${JSON.stringify(P3)})`,
    'готовый конспект вместо черновика',
    { timeoutMs: 40000 },
  );
}

async function waitForRequestAtLeast(count, timeoutMs = 60000) {
  const started = Date.now();
  for (;;) {
    if (mock.state.requests >= count) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`провайдер получил ${mock.state.requests} запрос(ов), ожидалось ${count}`);
    }
    await delay(200);
  }
}

/**
 * Watches the page while the transcript is collected: the reader must not see
 * the page scroll and must not see YouTube's transcript panel appear at all.
 * Sampling runs in the page itself at 20 Hz, so a jump that a single check
 * after the fact would miss (YouTube calls scrollIntoView for a frame) counts.
 */
async function startScrollProbe() {
  await page.evaluate(`(() => {
    const probe = { start: Math.round(window.scrollY || 0), samples: [], panelFrames: 0 };
    window.__osumScrollProbe = probe;
    probe.details = [];
    probe.timer = setInterval(() => {
      probe.samples.push(Math.round(window.scrollY || 0));
      const node = document.querySelector(
        'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"], ytd-transcript-renderer',
      );
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const visible =
        rect.width > 40 && rect.height > 40 && rect.left > -1000 && rect.top > -1000 &&
        style.opacity !== '0' && style.visibility !== 'hidden' && style.display !== 'none';
      if (!visible) return;
      probe.panelFrames++;
      if (probe.details.length < 4) {
        probe.details.push({
          at: Date.now(),
          tag: node.tagName?.toLowerCase() || '',
          quiet: document.documentElement.hasAttribute('data-osum-quiet'),
          left: Math.round(rect.left), top: Math.round(rect.top),
          w: Math.round(rect.width), h: Math.round(rect.height),
          scrollY: Math.round(window.scrollY || 0),
        });
      }
    }, 50);
  })()`);
}

async function readScrollProbe(label) {
  const probe = await page.evaluate(`(() => {
    const p = window.__osumScrollProbe;
    if (!p) return null;
    clearInterval(p.timer);
    return {
      start: p.start,
      end: Math.round(window.scrollY || 0),
      min: Math.min(p.start, ...p.samples),
      max: Math.max(p.start, ...p.samples),
      panelFrames: p.panelFrames,
      samples: p.samples.length,
      details: p.details || [],
    };
  })()`);
  log(`позиция страницы (${label}): ${JSON.stringify(probe)}`);
  if (!probe) throw new Error('зонд прокрутки не установился');
  if (Math.abs(probe.max - probe.start) > 8 || Math.abs(probe.min - probe.start) > 8) {
    throw new Error(
      `страница прокрутилась, пока читался транскрипт: ${probe.start} → ${probe.min}..${probe.max}`,
    );
  }
  if (probe.panelFrames > 2) {
    throw new Error(`окно расшифровки было видно ${probe.panelFrames} кадров — должно быть скрыто`);
  }
  return probe;
}

async function autoTranscriptScenario(videoId) {
  log('авто-транскрипт: запускаю «Саммари» на реальном видео');
  mock.setMode('hold');
  mock.resetGate();
  await switchToAi();
  await startScrollProbe();
  await clickPrimary();
  const started = await waitRunStart({ videoId });
  if (started.error) {
    const failure = started.error;
    throw new Error(
      `транскрипт не получен (${failure.code}): ${failure.message}` +
        (failure.routes.length ? ` · маршруты: ${failure.routes.join(', ')}` : ''),
    );
  }
  await waitForDraft('черновик после реального транскрипта');
  await readScrollProbe('после транскрипта');
  await screenshot(page, join(ARTIFACTS, '1-youtube-draft.png'));
  const snapshot = await transcriptSnapshot();
  const allJournal = await readJournal();
  const foreign = allJournal.filter((entry) => entry.videoId && entry.videoId !== videoId);
  if (foreign.length) {
    throw new Error(
      `расширение обращалось к другому видео: ${foreign.map((entry) => entry.videoId).join(', ')}, а страница — ${videoId}`,
    );
  }
  const journal = allJournal.filter((entry) => entry.videoId === videoId);
  const routes = [...new Set(journal.map((entry) => entry.route).filter(Boolean))];
  log(
    `авто-транскрипт: ${snapshot.total} таймкодов, ${mock.state.requests} запрос, ` +
      `маршруты: ${routes.length ? routes.join(', ') : 'журнал пуст'}`,
  );
  if (snapshot.total < 3) {
    throw new Error(`в запрос попало слишком мало таймкодов: ${snapshot.total}`);
  }
  await clickText(page, '.osum-tab', 'Обзор', 'вкладка «Обзор»');
  await waitForDraft('черновик на «Обзоре»');
  const draft = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      activeTab: sr.querySelector('.osum-tab[aria-selected="true"]')?.textContent || '',
      live: sr.querySelector('.osum-live')?.textContent || '',
      finalChips: !!sr.querySelector('.osum-chip-row'),
    };
  })()`);
  if (draft.activeTab !== 'Обзор') throw new Error(`после запуска открыта «${draft.activeTab}», а не «Обзор»`);
  if (draft.finalChips) throw new Error('черновик выдаёт себя за готовый конспект');
  await screenshot(page, join(ARTIFACTS, '2-youtube-transcript.png'));
  mock.release();
  await waitForFinal();
  promptCoverage(snapshot.rows);
  const final = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      tldr: sr.querySelector('.osum-tldr-text')?.textContent || '',
      hasP3: sr.textContent.includes(${JSON.stringify(P3)}),
      rawJson: sr.textContent.includes('"keyPoints"'),
      error: !!sr.querySelector('.osum-error'),
    };
  })()`);
  if (!final.tldr.includes(TLDR_HEAD)) throw new Error(`итоговый TL;DR не совпал с черновым: ${final.tldr}`);
  if (!final.hasP3) throw new Error('в итоге нет позднего пункта');
  if (final.rawJson) throw new Error('сырой JSON попал в конспект');
  if (final.error) throw new Error('после успешного прогона показана карточка ошибки');
  await screenshot(page, join(ARTIFACTS, '3-youtube-final.png'));
  log(`авто-транскрипт: OK (${snapshot.total} таймкодов, ${snapshot.words} слов, ${mock.state.requests} запрос)`);
}

async function manualPasteScenario() {
  log('ручная вставка: перезагружаю ту же страницу YouTube');
  mock.setMode('hold');
  mock.resetGate();
  await reloadWatchPage();
  const base = mock.state.requests;
  await runOnGivenTranscript();
  await waitForRequestAtLeast(base + 1);
  await waitForDraft('черновик после ручной вставки на YouTube');
  const draft = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const live = sr.querySelector('.osum-live');
    return {
      activeTab: sr.querySelector('.osum-tab[aria-selected="true"]')?.textContent || '',
      hasP1: !!live && live.textContent.includes(${JSON.stringify(P1)}),
      rawJson: !!live && live.textContent.includes('"tldr"'),
      chips: !!sr.querySelector('.osum-chip-row'),
    };
  })()`);
  if (mock.state.promptSegments !== TRANSCRIPT_LINES) {
    throw new Error(
      `вставленный текст дошёл до провайдера не целиком: ${mock.state.promptSegments} из ${TRANSCRIPT_LINES}`,
    );
  }
  if (draft.activeTab !== 'Обзор') throw new Error(`после запуска открыта «${draft.activeTab}», а не «Обзор»`);
  if (!draft.hasP1) throw new Error('в черновике нет первого проверенного пункта');
  if (draft.rawJson) throw new Error('сырой JSON попал в черновик');
  if (draft.chips) throw new Error('черновик выдаёт себя за готовый конспект');
  await screenshot(page, join(ARTIFACTS, '4-youtube-manual-draft.png'));
  mock.release();
  await waitForFinal();
  log('ручная вставка: черновик и итог OK');

  log('ручная вставка: обрыв ответа провайдера');
  mock.setMode('error');
  mock.resetGate();
  await reloadWatchPage();
  await runOnGivenTranscript();
  await waitFor(
    page,
    "document.getElementById('osum-host').shadowRoot.querySelector('.osum-error')?.textContent.includes('PROVIDER_ERROR')",
    'карточка ошибки после обрыва',
    { timeoutMs: 40000 },
  );
  const failure = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      error: sr.querySelector('.osum-error')?.textContent || '',
      card: !!sr.querySelector('.osum-fallback'),
      live: sr.querySelector('.osum-live')?.textContent || '',
      chips: sr.querySelector('.osum-chip-row')?.textContent || '',
    };
  })()`);
  if (!failure.error.includes('upstream died')) throw new Error('сообщение провайдера не дошло');
  if (failure.card) throw new Error('жёлтая плашка локального фолбэка вернулась');
  if (failure.chips) throw new Error('после ошибки остался блок Run details');
  await screenshot(page, join(ARTIFACTS, '5-youtube-provider-error.png'));
  log('ручная вставка: карточка ошибки OK');

  log('ручная вставка: отклонённый ключ');
  mock.setMode('auth');
  await reloadWatchPage();
  await runOnGivenTranscript();
  await waitFor(
    page,
    "document.getElementById('osum-host').shadowRoot.querySelector('.osum-error')?.textContent.includes('Ключ отклонён')",
    'карточка ошибки AUTH',
    { timeoutMs: 30000 },
  );
  const auth = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    return {
      error: sr.querySelector('.osum-error')?.textContent || '',
      live: !!sr.querySelector('.osum-live'),
      chips: !!sr.querySelector('.osum-chip-row'),
      action: !!sr.querySelector('.osum-actions .osum-btn'),
    };
  })()`);
  if (!auth.error.includes('не принял ключ')) throw new Error('в карточке AUTH нет подсказки');
  if (auth.live || auth.chips) throw new Error('после AUTH остался конспект');
  if (!auth.action) throw new Error('карточка AUTH не предлагает действие');
  await screenshot(page, join(ARTIFACTS, '6-youtube-auth.png'));
  log('ручная вставка: AUTH OK');
}

async function noCaptionsScenario(url) {
  const id = videoIdFromUrl(url);
  log(`видео без субтитров: ${id}`);
  mock.setMode('hold');
  mock.resetGate();
  await navigate(url);
  await openPanel();
  const base = mock.state.requests;
  await clickPrimary();
  const started = await waitRunStart({ videoId: id, since: base });
  if (!started.error) {
    throw new Error('ожидался явный отказ из-за отсутствия субтитров, но провайдер получил запрос');
  }
  const failure = started.error;
  if (!['NO_CAPTIONS', 'EMPTY_CAPTIONS'].includes(failure.code)) {
    throw new Error(`ожидалось отсутствие субтитров, получено ${failure.code}: ${failure.message}`);
  }
  await waitFor(
    page,
    "document.getElementById('osum-host').shadowRoot.textContent.includes('Взять транскрипт со страницы')",
    'предложение взять транскрипт со страницы',
    { timeoutMs: 10000 },
  );
  await screenshot(page, join(ARTIFACTS, '7-youtube-no-captions.png'));
  log(`видео без субтитров: OK (${failure.code})`);
}

function extensionErrors(extensionId) {
  const contexts = new Set(
    page.events
      .filter((event) => event.method === 'Runtime.executionContextCreated')
      .map((event) => event.params?.context)
      .filter((context) => {
        const origin = String(context?.origin || '');
        const name = String(context?.name || '');
        return origin.includes(extensionId) || name.includes(extensionId);
      })
      .map((context) => context.id),
  );
  if (!contexts.size) return { contexts: 0, errors: [], skipped: true };
  const errors = [];
  for (const event of page.events) {
    if (event.method === 'Runtime.exceptionThrown') {
      if (contexts.has(event.params?.exceptionDetails?.executionContextId)) {
        errors.push(JSON.stringify(event.params).slice(0, 500));
      }
      continue;
    }
    if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
      if (contexts.has(event.params.executionContextId)) {
        errors.push(
          (event.params.args || []).map((arg) => arg.value || arg.description || '').join(' ').slice(0, 500),
        );
      }
    }
  }
  return { contexts: contexts.size, errors, skipped: false };
}

/**
 * The same user flow, repeated N times: real YouTube, real transcript, mock
 * model. This is the measurement the product promise needs — one lucky run
 * says nothing about a route that fails on every second video.
 */
async function cycleScenario({ cycles, urls }) {
  const results = [];
  for (let i = 0; i < cycles; i++) {
    const raw = urls[i % urls.length] || urls[0];
    const url = normalizeYouTubeUrl(raw);
    const videoId = videoIdFromUrl(url);
    const startedAt = Date.now();
    log(`цикл ${i + 1}/${cycles}: ${url}`);
    try {
      await optionsPage.evaluate("chrome.storage.local.remove('osum:journal')");
      mock.setMode('hold');
      mock.resetGate();
      await navigate(url);
      await waitFor(
        page,
        "!!document.getElementById('osum-host')?.shadowRoot?.querySelector('.osum-fab')",
        'панель на странице YouTube',
        { timeoutMs: 40000 },
      );
      await openPanel();
      await switchToAi();
      const since = Number(mock.state.requests) || 0;
      // A cycle proves what this cycle sent: keeping the previous cycle's
      // bodies would let an earlier run satisfy the delivery check.
      mock.state.prompts.length = 0;
      await clickPrimary();
      const started = await waitRunStart({ videoId, since });
      if (started.error) {
        throw new Error(`${started.error.code}: ${started.error.message}`);
      }
      const transcriptMs = Date.now() - startedAt;
      await waitForDraft(`цикл ${i + 1}: черновик`);
      // Real captions, not the synthetic fixture: count the timecodes and words
      // that actually reached the model, so a cycle cannot pass on a page that
      // produced an empty transcript.
      const snapshot = await transcriptSnapshot();
      mock.release();
      await waitForFinal();
      const elapsed = Date.now() - startedAt;
      const journal = (await readJournal()).filter((entry) => entry.videoId === videoId);
      const routes = [...new Set(journal.map((entry) => entry.route).filter(Boolean))];
      results.push({
        cycle: i + 1, videoId, ok: true, ms: elapsed, transcriptMs,
        segments: snapshot.total, words: snapshot.words, routes,
      });
      log(
        `цикл ${i + 1}: OK — ${snapshot.total} таймкодов, ${snapshot.words} слов, ` +
          `транскрипт за ${transcriptMs} мс, всего ${elapsed} мс, маршрут ${routes.join('/') || '—'}`,
      );
    } catch (err) {
      results.push({ cycle: i + 1, videoId, ok: false, ms: Date.now() - startedAt, error: err.message });
      log(`цикл ${i + 1}: FAILED — ${err.message}`);
      try {
        await screenshot(page, join(ARTIFACTS, `cycle-${i + 1}-failure.png`));
        await dumpJournal(`цикл ${i + 1}`);
      } catch {
        /* diagnostics are best-effort */
      }
    }
  }
  writeFileSync(join(ARTIFACTS, 'cycles.json'), JSON.stringify(results, null, 2));
  const ok = results.filter((r) => r.ok);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  log(`циклы: ${ok.length}/${results.length} успешных, медиана ${median} мс`);
  if (ok.length !== results.length) {
    const failed = results.filter((r) => !r.ok).map((r) => `#${r.cycle} ${r.error}`).join(' | ');
    throw new Error(`циклы: ${results.length - ok.length} из ${results.length} неудачных: ${failed}`);
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Every cycle needs its own real page load; the smoke-test budget would cut
  // a 20-cycle run off in the middle.
  if (options.cycles > 0) armWatchdog(WATCHDOG_MS + options.cycles * 120000);
  installSignalHandlers();
  const rawUrl = options.url || process.env.OSUM_YOUTUBE_TEST_URL || '';
  if (!rawUrl) {
    throw new Error(
      'не задан URL видео. Укажите OSUM_YOUTUBE_TEST_URL или --url:\n' +
        '  OSUM_YOUTUBE_TEST_URL="https://www.youtube.com/watch?v=..." npm run e2e:youtube',
    );
  }
  const url = normalizeYouTubeUrl(rawUrl);
  const noCaptionsUrl = options.noCaptionsUrl || process.env.OSUM_YOUTUBE_NO_CAPTIONS_URL || '';
  const videoId = videoIdFromUrl(url);

  if (options.build) buildExtension();
  prepareArtifacts();
  const sourceExt = join(ROOT, 'dist', 'opensummary-chrome');
  if (!existsSync(sourceExt)) {
    throw new Error(`сборка не найдена: ${sourceExt}\nЗапустите npm run build или уберите --no-build.`);
  }
  log(`видео: ${url} (${videoId || 'id не найден'})`);
  if (!videoId) throw new Error(`не удалось выделить идентификатор видео из ${url}`);

  const { binary, searched } = resolveChrome(options.chrome);
  log(`браузер: ${binary}`);
  if (!options.chrome) log(`искал среди ${searched.length} путей`);

  const prodManifestPath = join(ROOT, 'manifest.json');
  const prodManifestBefore = readFileSync(prodManifestPath, 'utf8');
  const origin = new URL(url).origin;

  tempDir = mkdtempSync(join(tmpdir(), 'osum-youtube-e2e-'));
  const extDir = join(tempDir, 'ext');
  cpSync(sourceExt, extDir, { recursive: true });
  patchTestManifest(extDir, origin);
  log(`изолированная копия расширения: ${extDir}`);

  mock = createMockProvider({ head: HEAD, tail: TAIL, log });
  const mockUrl = await listen(mock.server);
  log(`SSE-мок: http://127.0.0.1:${mockUrl}`);

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
  const version = await waitForCdp(cdpPort, { child: chrome.child, tail: chrome.stderrTail });
  log(`браузер запущен: ${version.Browser}`);

  browser = await connectCdp(version.webSocketDebuggerUrl);
  let loaded;
  try {
    loaded = await browser.send('Extensions.loadUnpacked', { path: extDir });
  } catch (err) {
    throw new Error(`Chrome не смог загрузить unpacked-расширение через CDP: ${err.message}`);
  }
  extId = loaded.id;
  log(`расширение загружено: ${extId}`);

  const optionsTarget = await newTarget(cdpPort, `chrome-extension://${extId}/src/options/options.html`);
  optionsPage = await connectCdp(optionsTarget.webSocketDebuggerUrl);
  await waitFor(optionsPage, "!!document.getElementById('version')", 'страница настроек');
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
  await optionsPage.evaluate("chrome.storage.local.remove('osum:journal')");
  log('настройки и мок-провайдер записаны');

  const tab = await newTarget(cdpPort, 'about:blank');
  page = await connectCdp(tab.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  // Consent cookies for this throw-away profile only; no personal data.
  for (const [name, value] of [
    ['CONSENT', 'YES+cb'],
    ['SOCS', 'CAI'],
    ['PREF', 'hl=en'],
  ]) {
    await page.send('Network.setCookie', {
      name,
      value,
      url: 'https://www.youtube.com/',
      path: '/',
    });
  }
  await navigate(url);
  await waitFor(
    page,
    "!!document.getElementById('osum-host')?.shadowRoot?.querySelector('.osum-fab')",
    'панель на странице YouTube',
    { timeoutMs: 30000 },
  );
  log(`страница загружена: ${(await pageInfo()).title.slice(0, 100)}`);
  await openPanel();
  log('панель открыта');

  let autoFailure = null;
  try {
    await autoTranscriptScenario(videoId);
  } catch (err) {
    autoFailure = err;
    log(`авто-транскрипт: FAILED — ${err.message}`);
    if (artifactsReady) {
      try {
        writeFileSync(join(ARTIFACTS, 'auto-transcript-failure.txt'), String(err.message));
        await dumpJournal('авто-транскрипт');
        await screenshot(page, join(ARTIFACTS, 'auto-transcript-failure.png'));
      } catch {
        /* diagnostics are best-effort */
      }
    }
  }

  let manualFailure = null;
  try {
    await manualPasteScenario();
  } catch (err) {
    manualFailure = err;
    log(`ручная вставка: FAILED — ${err.message}`);
    if (artifactsReady) {
      try {
        const body = await panelText(page).catch(() => '');
        writeFileSync(join(ARTIFACTS, 'transcript-failure.txt'), `${err.message}\n\n${body}`);
        await screenshot(page, join(ARTIFACTS, 'transcript-failure.png'));
      } catch {
        /* diagnostics are best-effort */
      }
    }
  }

  let cyclesFailure = null;
  if (options.cycles > 0) {
    // The first lap is the smoke test above; these are the repetitions that
    // turn “it worked once” into a rate.
    try {
      await cycleScenario({ cycles: options.cycles, urls: options.cycleUrls.length ? options.cycleUrls : [url] });
    } catch (err) {
      cyclesFailure = err;
      log(`циклы: FAILED — ${err.message}`);
    }
  }

  let noCaptionsFailure = null;
  if (noCaptionsUrl) {
    try {
      await noCaptionsScenario(normalizeYouTubeUrl(noCaptionsUrl));
    } catch (err) {
      noCaptionsFailure = err;
      log(`видео без субтитров: FAILED — ${err.message}`);
      if (artifactsReady) {
        try {
          await dumpJournal('видео без субтитров');
        } catch {
          /* diagnostics are best-effort */
        }
      }
    }
  }

  const counts = extensionErrors(extId);
  log(`контекстов контент-скрипта: ${counts.contexts}; ошибок расширения: ${counts.errors.length}`);
  await dumpJournal('итог');
  if (counts.skipped) {
    log('предупреждение: изолированный контекст контент-скрипта не найден — ошибки консоли не проверены');
  }
  const parts = [];
  if (autoFailure) parts.push(`авто-транскрипт: ${autoFailure.message}`);
  if (cyclesFailure) parts.push(`циклы: ${cyclesFailure.message}`);
  if (manualFailure) parts.push(`ручная вставка: ${manualFailure.message}`);
  if (noCaptionsFailure) parts.push(`видео без субтитров: ${noCaptionsFailure.message}`);
  if (counts.errors.length) parts.push(`console.error/исключения: ${counts.errors.join(' | ')}`);
  if (parts.length) throw new Error(parts.join('; '));

  const prodManifestAfter = readFileSync(prodManifestPath, 'utf8');
  if (prodManifestAfter !== prodManifestBefore) {
    throw new Error('производственный manifest.json был изменён тестом');
  }

  log(`YouTube E2E OK: транскрипт, ручная вставка, фолбэк и AUTH проверены`);
  log(`артефакты: ${ARTIFACTS}`);
}

function armWatchdog(ms) {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    log(`E2E FAILED: общий таймаут ${Math.round(ms / 1000)} с`);
    (async () => {
      if (page && artifactsReady) {
        await dumpJournal('общий таймаут');
        await screenshot(page, join(ARTIFACTS, 'failure.png')).catch(() => {});
      }
      await cleanup().catch(() => {});
      process.exit(1);
    })();
  }, ms);
  watchdog.unref();
}

let exitCode = 0;
try {
  armWatchdog(WATCHDOG_MS);
  await main();
} catch (err) {
  exitCode = 1;
  log(`E2E FAILED: ${err.message}`);
  if (page && artifactsReady) {
    try {
      const body = await panelText(page).catch(() => '');
      writeFileSync(join(ARTIFACTS, 'failure-panel.txt'), `${err.message}\n\n${body}`);
      await dumpJournal('сбой');
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
