#!/usr/bin/env node
/**
 * Live summarization loop: real YouTube video, real provider, real panel.
 *
 *   OSUM_OPENROUTER_KEY=... npm run live
 *   npm run live -- --video https://youtu.be/... --model openrouter/free
 *   npm run live -- --key-file "$TEMP/osum-live/openrouter.key" --headed
 *
 * The key is read from the environment or a file outside the repository and is
 * never written to the project, the log or the report: this script exists to
 * measure how often a summary actually succeeds, not to store credentials.
 *
 * For every video it writes one JSON line into dist/live-artifacts/report.jsonl
 * (outcome, error code and detail, strategy, timings, counts) plus a screenshot
 * when the run failed. Exit code is 1 when any run failed, so a fix can be
 * re-checked by simply running it again.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectCdp,
  launchChrome,
  newTarget,
  panelText,
  resolveChrome,
  screenshot,
  waitFor,
  waitForCdp,
} from '../e2e/chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = join(ROOT, 'dist', 'live-artifacts');

// Short videos are the default so a cycle finishes in minutes; the three-hour
// interview from the report is opt-in with --video. The id is case-sensitive:
// a typo here silently measured a different video.
const DEFAULT_VIDEOS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',
];

let logFile = '';
let tempDir = '';
let chrome = null;
let browser = null;
let optionsPage = null;
let page = null;
let cleaned = false;

function log(message) {
  const line = String(message);
  console.log(line);
  try {
    if (logFile) appendFileSync(logFile, `${line}\n`);
  } catch {
    /* logging must never break a run */
  }
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    chrome: '',
    headed: false,
    build: true,
    keepTemp: false,
    model: process.env.OSUM_MODEL || 'openrouter/free',
    keyFile: process.env.OSUM_OPENROUTER_KEY_FILE || '',
    videos: [],
    // The quality complaints are about a mode and a length, so a live cycle has
    // to be able to run the same one the user reports: standard/detailed and
    // whole/timeline.
    length: process.env.OSUM_LENGTH || 'standard',
    summaryMode: process.env.OSUM_SUMMARY_MODE || 'whole',
    repeat: 1,
    timeoutMs: 15 * 60 * 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'OpenSummary live run',
          '',
          '  OSUM_OPENROUTER_KEY=... npm run live',
          '  npm run live -- [--video <url>]... [--model <id>] [--key-file <path>] [--headed] [--no-build] [--keep-temp]',
          '',
          '  --video <url>     video to summarize (repeatable; defaults to three public videos)',
          '  --repeat <n>      summarize every video n times (default: 1) — measures flakiness',
          '  --model <id>      OpenRouter model (default: openrouter/free)',
          '  --length <mode>   standard | detailed | short (default: standard)',
          '  --mode <mode>     whole | timeline (default: whole)',
          '  --key-file <path> file with the API key (or OSUM_OPENROUTER_KEY / OSUM_OPENROUTER_KEY_FILE)',
          '  --headed          visible browser window',
          '  --no-build        reuse the existing dist/opensummary-chrome',
          '  --keep-temp       keep the temporary profile and extension copy',
          '',
          `Report: ${ARTIFACTS}/report.jsonl`,
        ].join('\n'),
      );
      process.exit(0);
    }
    if (arg === '--headed') options.headed = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--keep-temp') options.keepTemp = true;
    else if (arg === '--video') {
      const value = argv[++i];
      if (!value) fail('--video требует ссылку');
      options.videos.push(value);
    } else if (arg === '--model') {
      const value = argv[++i];
      if (!value) fail('--model требует ID модели');
      options.model = value;
    } else if (arg === '--length') {
      const value = argv[++i];
      if (!['short', 'standard', 'detailed'].includes(value)) fail('--length требует short, standard или detailed');
      options.length = value;
    } else if (arg === '--mode') {
      const value = argv[++i];
      if (!['whole', 'timeline'].includes(value)) fail('--mode требует whole или timeline');
      options.summaryMode = value;
    } else if (arg === '--key-file') {
      const value = argv[++i];
      if (!value) fail('--key-file требует путь');
      options.keyFile = value;
    } else if (arg === '--repeat') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 20) fail('--repeat требует целое число 1–20');
      options.repeat = value;
    } else if (arg === '--timeout') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) fail('--timeout требует миллисекунды');
      options.timeoutMs = value;
    } else fail(`неизвестный аргумент: ${arg} (см. --help)`);
  }
  if (!options.videos.length) options.videos = [...DEFAULT_VIDEOS];
  if (options.repeat > 1) options.videos = options.videos.flatMap((url) => Array.from({ length: options.repeat }, () => url));
  return options;
}

function readKey(options) {
  if (process.env.OSUM_OPENROUTER_KEY) return process.env.OSUM_OPENROUTER_KEY.trim();
  if (options.keyFile) {
    if (!existsSync(options.keyFile)) fail(`файл с ключом не найден: ${options.keyFile}`);
    return readFileSync(options.keyFile, 'utf8').trim();
  }
  fail('нужен ключ OpenRouter: OSUM_OPENROUTER_KEY, OSUM_OPENROUTER_KEY_FILE или --key-file');
  return '';
}

function buildExtension() {
  log('сборка: node tools/build.mjs');
  const res = spawnSync(process.execPath, [join(ROOT, 'tools', 'build.mjs')], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) {
    const output = `${res.stdout || ''}${res.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
    fail(`сборка расширения не удалась (код ${res.status}):\n${output}`);
  }
  log('сборка готова');
}

function pageInfo() {
  return page
    .evaluate(`({
      href: location.href,
      title: document.title,
      ready: document.readyState,
      fab: !!document.getElementById('osum-host')?.shadowRoot?.querySelector('.osum-fab'),
    })`)
    .catch(() => null);
}

async function navigate(url) {
  const res = await page.send('Page.navigate', { url });
  if (res?.errorText) fail(`YouTube недоступен: ${res.errorText}`);
  await waitFor(page, "document.readyState === 'complete'", 'загрузка страницы YouTube', { timeoutMs: 45000 });
}

/** Summaries can take minutes: poll the panel until it shows an end state. */
async function waitForTerminal({ timeoutMs }) {
  const started = Date.now();
  let last = '';
  for (;;) {
    const snapshot = await page
      .evaluate(`(() => {
        const sr = document.getElementById('osum-host')?.shadowRoot;
        if (!sr) return { mounted: false };
        const body = sr.querySelector('.osum-body');
        const error = sr.querySelector('.osum-error');
        const run = sr.querySelector('.osum-run');
        const runText = run ? String(run.textContent || '').trim() : '';
        return {
          mounted: true,
          error: error ? error.textContent : '',
          // The tabs are always rendered; “Обновить/Refresh” only appears once a
          // summary exists. A spinner means the run is still going.
          result: !error && !sr.querySelector('.osum-spin') && /Обновить|Refresh/.test(runText),
          running: !!run && /Стоп|Stop/.test(runText),
          runText,
          status: sr.querySelector('.osum-status')?.textContent || '',
          body: body ? body.textContent : '',
          bodyLength: body ? body.textContent.length : 0,
        };
      })()`)
      .catch(() => null);
    last = JSON.stringify(snapshot);
    if (snapshot?.error) return { kind: 'error', snapshot };
    if (snapshot?.result) return { kind: 'result', snapshot };
    if (Date.now() - started > timeoutMs) return { kind: 'timeout', snapshot, last };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * The isolated world of the content script. Chrome reports it either with a
 * chrome-extension:// origin or as an isolated context of the page, so the
 * context is identified by asking it whether OSUM exists.
 */
async function findContentContext() {
  const contexts = page.events
    .filter((event) => event.method === 'Runtime.executionContextCreated')
    .map((event) => event.params?.context)
    .filter(Boolean);
  const candidates = contexts
    .filter(
      (context) =>
        String(context.origin || '').startsWith('chrome-extension://') ||
        context.auxData?.type === 'isolated',
    )
    .reverse();
  for (const context of candidates) {
    const probe = await page
      .send('Runtime.evaluate', { contextId: context.id, expression: 'typeof OSUM', returnByValue: true })
      .catch(() => null);
    if (probe?.result?.value === 'object') return context.id;
  }
  return 0;
}

/** Content-script world state: the only place with the real error code. */
async function contentState() {
  const contextId = await findContentContext();
  if (!contextId) return null;
  const out = await page
    .send('Runtime.evaluate', {
      contextId,
      expression: `(() => {
        const st = OSUM.state || {};
        const err = st.error || null;
        const res = st.result || null;
        return {
          url: location.href,
          running: !!st.running,
          strategy: st.aiDiagnostics?.strategy || '',
          providerAttempts: st.aiDiagnostics?.providerAttempts || 0,
          streamItems: st.aiDiagnostics?.streamItems || 0,
          firstItemMs: st.aiDiagnostics?.streamFirstItemMs || 0,
          firstPartialMs: st.aiDiagnostics?.firstPartialMs || 0,
          finishReason: st.aiDiagnostics?.finishReason || '',
          complete: st.aiDiagnostics?.complete,
          error: err ? { code: err.code || '', message: err.message || '', hint: err.hint || '', detail: err.detail || '', provider: err.provider || '' } : null,
          result: res ? {
            tldr: String(res.tldr || '').slice(0, 200),
            keyPoints: (res.keyPoints || []).length,
            sections: (res.sections || []).length,
            words: res.stats?.words || 0,
            transcriptSource: res.stats?.transcriptSource || res.meta?.transcriptSource || '',
            // A partial-coverage result is usable but not complete: the report
            // must not call a summary of 9/24 fragments a clean success.
            complete: res.stats?.aiComplete !== false,
            chunksOk: res.stats?.aiChunksOk ?? null,
            chunksTotal: res.stats?.aiChunksTotal ?? null,
          } : null,
          partials: (st.partialChunks || []).length,
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    .catch(() => null);
  return out?.result?.value || null;
}

async function openPanel() {
  await waitFor(page, "!!document.getElementById('osum-host')?.shadowRoot?.querySelector('.osum-fab')", 'кнопка расширения на странице', {
    timeoutMs: 40000,
  });
  // A video unavailable in this region/session has no transcript to measure:
  // it must not be counted as a summary failure.
  const unavailable = await page.evaluate(
    `/недоступно|больше не доступно|no longer available|Video unavailable|Приватное видео|Private video/i.test(document.body?.innerText || '')`,
  );
  if (unavailable) {
    const err = new Error('видео недоступно в этой сессии');
    err.code = 'VIDEO_UNAVAILABLE';
    throw err;
  }
  await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-fab').click()");
  await waitFor(
    page,
    "!document.getElementById('osum-host').shadowRoot.querySelector('.osum-panel').hidden",
    'панель расширения не открылась',
    { timeoutMs: 10000 },
  );
}

async function clickRun() {
  const clicked = await page.evaluate(`(() => {
    const sr = document.getElementById('osum-host').shadowRoot;
    const run = sr.querySelector('.osum-run');
    if (!run) return false;
    run.click();
    return true;
  })()`);
  if (!clicked) fail('кнопка «Саммари» не найдена');
}

/** Provider traffic the page made, from CDP network events. */
function networkReport() {
  const requests = new Map();
  for (const event of page.events) {
    const p = event.params || {};
    if (event.method === 'Network.requestWillBeSent' && /openrouter\.ai/.test(p.request?.url || '')) {
      let body = null;
      try {
        body = p.request.postData ? JSON.parse(p.request.postData) : null;
      } catch {
        body = null;
      }
      requests.set(p.requestId, {
        url: p.request.url,
        startedAt: p.timestamp || 0,
        model: body?.model || '',
        stream: !!body?.stream,
        jsonMode: !!body?.response_format,
        maxTokens: body?.max_tokens || 0,
        messages: (body?.messages || []).map((m) => `${m.role}:${String(m.content || '').length}`),
      });
    }
    if (event.method === 'Network.responseReceived' && requests.has(p.requestId) && /openrouter\.ai/.test(p.response?.url || '')) {
      Object.assign(requests.get(p.requestId), { status: p.response.status, fromCache: !!p.response.fromDiskCache, type: p.type });
    }
    if (event.method === 'Network.loadingFinished' && requests.has(p.requestId)) {
      const record = requests.get(p.requestId);
      record.durationMs = record.startedAt ? Math.round((p.timestamp - record.startedAt) * 1000) : 0;
    }
    if (event.method === 'Network.loadingFailed' && requests.has(p.requestId)) {
      requests.get(p.requestId).failure = p.errorText || 'failed';
    }
  }
  return [...requests.values()];
}

/** What the page actually rendered, for a failure report. */
async function pageDiagnostics() {
  return page
    .evaluate(`(() => {
      const all = [...document.querySelectorAll('button, tp-yt-paper-button, [role="tab"], yt-button-shape button')];
      return {
        url: location.href,
        title: document.title,
        player: !!document.querySelector('#movie_player'),
        watchFlexy: !!document.querySelector('ytd-watch-flexy'),
        watchMetadata: !!document.querySelector('ytd-watch-metadata'),
        description: !!document.querySelector('#description-inline-expander, ytd-text-inline-expander, ytd-expandable-video-description-body-renderer'),
        panels: document.querySelectorAll('ytd-engagement-panel-section-list-renderer').length,
        consent: /Before you continue|Прежде чем продолжить|Sign in to confirm/i.test(document.body?.innerText || ''),
        transcriptButtons: all.filter((b) => /transcript|расшифровк|текст видео/i.test(b.textContent || b.getAttribute?.('aria-label') || '')).map((b) => String(b.textContent || b.getAttribute?.('aria-label') || '').trim().slice(0, 40)).slice(0, 6),
        menuButtons: document.querySelectorAll('ytd-menu-renderer button').length,
        bodyText: String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
      };
    })()`)
    .catch((err) => ({ error: String(err) }));
}

async function runOne(url, options) {
  log(`\n=== ${url}`);
  await navigate(url);
  await new Promise((r) => setTimeout(r, 1500));
  await openPanel();
  const startedAt = Date.now();
  await clickRun();
  const terminal = await waitForTerminal({ timeoutMs: options.timeoutMs });
  const elapsedMs = Date.now() - startedAt;
  const state = await contentState();
  if (!state) log('  контекст контент-скрипта не найден — состояние беру из DOM');
  const panel = terminal.snapshot?.body || (await panelText(page).catch(() => ''));
  const outcome = {
    url,
    at: new Date().toISOString(),
    elapsedMs,
    kind: terminal.kind,
    ran: !!state?.running || terminal.kind !== 'timeout',
    running: !!state?.running,
    strategy: state?.strategy || '',
    providerAttempts: state?.providerAttempts || 0,
    streamItems: state?.streamItems || 0,
    firstItemMs: state?.firstItemMs || 0,
    firstPartialMs: state?.firstPartialMs || 0,
    finishReason: state?.finishReason || '',
    error: state?.error || null,
    result: state?.result || null,
    partials: state?.partials || 0,
    panel: String(panel || '').slice(0, 600),
  };
  log(
    `итог: ${outcome.kind} · ${Math.round(elapsedMs / 1000)} с · стратегия ${outcome.strategy || '?'} · ` +
      `ошибка ${outcome.error?.code || '—'} · пунктов ${outcome.result?.keyPoints ?? '—'} · ` +
      `разделов ${outcome.result?.sections ?? '—'} · ` +
      (outcome.result?.chunksTotal
        ? `полнота ${outcome.result.chunksOk ?? '?'}/${outcome.result.chunksTotal}${outcome.result.complete ? '' : ' (частичный конспект)'} · `
        : '') +
      `первый пункт ${outcome.streamItems ? `${outcome.firstItemMs || '?'} мс` : outcome.firstPartialMs ? `${outcome.firstPartialMs} мс` : 'нет'} · ` +
      `попыток ${outcome.providerAttempts || 0}`,
  );
  if (outcome.error) log(`  ${outcome.error.code}: ${outcome.error.message} ${outcome.error.detail ? `(${outcome.error.detail.slice(0, 160)})` : ''}`);
  if (terminal.kind !== 'result') {
    const slug = url.replace(/[^a-z0-9]+/gi, '-').slice(-40);
    outcome.page = await pageDiagnostics();
    outcome.requests = networkReport();
    outcome.journal = await optionsPage
      .evaluate("chrome.storage.local.get('osum:journal').then((r) => (r['osum:journal'] || []).slice(-12))")
      .catch(() => null);
    await screenshot(page, join(ARTIFACTS, `failure-${slug}.png`)).catch(() => {});
    writeFileSync(join(ARTIFACTS, `failure-${slug}.txt`), `${JSON.stringify(outcome, null, 2)}\n\n${panel}`);
    log(`  страница: ${JSON.stringify(outcome.page)}`);
    if (outcome.journal?.length) log(`  журнал: ${JSON.stringify(outcome.journal).slice(0, 800)}`);
    if (outcome.requests?.length) {
      log(
        `  запросы: ${outcome.requests
          .map(
            (r) =>
              `${r.status || r.failure || '?'} ${r.durationMs ?? '?'}ms ${r.model} stream=${r.stream} json=${r.jsonMode} max=${r.maxTokens} ${r.messages.join(',')}`,
          )
          .join(' | ')}`,
      );
    }
  }
  return outcome;
}

async function seedSettings(extId, options, key) {
  const target = await newTarget(chrome.port, `chrome-extension://${extId}/src/options/options.html`);
  optionsPage = await connectCdp(target.webSocketDebuggerUrl);
  await waitFor(optionsPage, "!!document.getElementById('version')", 'страница настроек');
  const provider = {
    id: 'p-live',
    name: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    models: [options.model],
    defaultModel: options.model,
    authScheme: 'bearer',
    enabled: true,
  };
  const settings = {
    schema: 1,
    mode: 'ai',
    ai: {
      providerId: 'p-live',
      model: options.model,
      stream: true,
      retries: 1,
      useCache: false,
      chunkCache: false,
      strategy: 'auto',
      summaryMode: options.summaryMode,
      contextTokens: 128000,
      chunkTokens: 6000,
      timeoutMs: 90000,
    },
    cache: { enabled: false },
    output: { length: options.length, selfCheck: false },
    ui: { lang: 'ru', showFab: true, autoOpenPanel: false, theme: 'light' },
  };
  // The key goes into the throw-away browser profile only, never into a file.
  await optionsPage.evaluate(
    `chrome.storage.local.set(${JSON.stringify({
      'osum:settings': settings,
      'osum:providers': [provider],
      'osum:keys': { 'p-live': key },
    })})`,
  );
  await optionsPage.evaluate("chrome.storage.local.remove('osum:journal')");
  log(`настройки записаны: ${options.model}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const key = readKey(options);
  // The success rate is a property of many runs, not of the last one: keep the
  // report across invocations (screenshots and logs are still fresh each time).
  const reportFile = join(ARTIFACTS, 'report.jsonl');
  const previousReport = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '';
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  logFile = join(ARTIFACTS, 'run.log');
  writeFileSync(logFile, '');
  if (previousReport) writeFileSync(reportFile, previousReport);

  if (options.build) buildExtension();
  const sourceExt = join(ROOT, 'dist', 'opensummary-chrome');
  if (!existsSync(sourceExt)) fail('нет dist/opensummary-chrome — сначала npm run build');

  tempDir = mkdtempSync(join(tmpdir(), 'osum-live-'));
  const extDir = join(tempDir, 'ext');
  cpSync(sourceExt, extDir, { recursive: true });

  const { binary, searched } = resolveChrome(options.chrome);
  log(`браузер: ${binary}${searched.length > 1 ? ` (искал среди ${searched.length} путей)` : ''}`);
  const profileDir = join(tempDir, 'profile');
  const port = 9400 + Math.floor(Math.random() * 200);
  chrome = launchChrome(binary, {
    profileDir,
    port,
    headed: options.headed,
    logPath: join(ARTIFACTS, 'chrome.log'),
  });
  chrome.port = port;
  chrome.child.on('exit', (code) => log(`браузер завершился с кодом ${code}`));
  const version = await waitForCdp(port, { child: chrome.child, tail: chrome.stderrTail });
  log(`браузер запущен: ${version.Browser}`);
  browser = await connectCdp(version.webSocketDebuggerUrl);
  let loaded;
  try {
    loaded = await browser.send('Extensions.loadUnpacked', { path: extDir });
  } catch (err) {
    fail(`Chrome не смог загрузить расширение: ${err.message}`);
  }
  const extId = loaded.id;
  log(`расширение загружено: ${extId}`);
  await seedSettings(extId, options, key);

  const tab = await newTarget(port, 'about:blank');
  page = await connectCdp(tab.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  for (const [name, value] of [
    ['CONSENT', 'YES+cb'],
    ['SOCS', 'CAI'],
    ['PREF', 'hl=ru'],
  ]) {
    await page.send('Network.setCookie', { name, value, url: 'https://www.youtube.com/', path: '/' });
  }

  const outcomes = [];
  for (const url of options.videos) {
    try {
      outcomes.push(await runOne(url, options));
    } catch (err) {
      const failed = {
        url,
        kind: err?.code === 'VIDEO_UNAVAILABLE' ? 'unavailable' : 'harness-error',
        error: { code: err?.code || 'HARNESS', message: err.message },
        at: new Date().toISOString(),
      };
      outcomes.push(failed);
      log(`СБОЙ ПРОГОНА: ${err.message}`);
      await screenshot(page, join(ARTIFACTS, 'failure-harness.png')).catch(() => {});
    }
  }

  for (const outcome of outcomes) appendFileSync(reportFile, `${JSON.stringify(outcome)}\n`);
  // Same bar the panel uses for a usable summary: a real lead or real content.
  // A three-section summary of a 19-second clip legitimately has no key points.
  const usable = (o) =>
    o.kind === 'result' &&
    o.result &&
    (o.result.keyPoints > 0 || o.result.sections > 0) &&
    String(o.result.tldr || '').trim().split(/\s+/).length >= 5;
  const ok = outcomes.filter(usable);
  const attempted = outcomes.filter((o) => o.kind !== 'unavailable');
  const rate = attempted.length ? ((ok.length / attempted.length) * 100).toFixed(1) : '0.0';
  const skipped = outcomes.length - attempted.length;
  const full = ok.filter((o) => o.result?.complete !== false);
  log(`\nуспешно ${ok.length}/${attempted.length} (${rate}%)${skipped ? `, недоступных видео: ${skipped}` : ''}`);
  if (full.length !== ok.length) {
    log(`из них полных конспектов: ${full.length}/${ok.length} (остальные — честно помеченный частичный охват)`);
  }
  // Lifetime rate: every report line ever written, unreadable ones skipped.
  try {
    const history = readFileSync(reportFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((o) => o.kind !== 'unavailable' && o.kind !== 'harness-error');
    const done = history.filter((o) => o.kind === 'result' && o.result && (o.result.keyPoints > 0 || o.result.sections > 0));
    log(
      `за всё время: ${done.length}/${history.length} успешных прогонов ` +
        `(${history.length ? ((done.length / history.length) * 100).toFixed(1) : '0.0'}%), ` +
        `полных ${history.filter((o) => o.kind === 'result' && o.result?.complete === true).length}`,
    );
  } catch {
    /* a damaged report must not fail the run */
  }
  for (const outcome of outcomes) {
    const why = outcome.error ? `${outcome.error.code} ${outcome.error.message}` : outcome.kind;
    log(`  ${outcome.kind === 'result' ? 'OK  ' : 'FAIL'} ${outcome.url} — ${why}`);
  }
  log(`отчёт: ${join(ARTIFACTS, 'report.jsonl')}`);
  process.exitCode = ok.length === attempted.length ? 0 : 1;
}

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    page?.close?.();
    optionsPage?.close?.();
    browser?.close?.();
  } catch {
    /* ignore */
  }
  try {
    chrome?.child?.kill();
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 300));
  if (tempDir && !process.argv.includes('--keep-temp')) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* Windows may still hold a lock on the profile */
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup().finally(() => process.exit(1));
  });
}

try {
  await main();
} catch (err) {
  log(`LIVE FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
