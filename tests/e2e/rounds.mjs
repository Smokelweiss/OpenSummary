#!/usr/bin/env node
/**
 * End-to-end rounds: many full runs through the real extension in real Chrome.
 *
 *   npm run e2e:rounds -- --cycles 20
 *
 * Every round loads a watch-like page from 127.0.0.1, opens the panel, starts a
 * summary and checks that the transcript actually reached the model. The pages
 * reproduce the transcript routes YouTube has served over the last releases,
 * including the one behind the “PO-token” error card:
 *
 *   capture   the track is PO-token protected, the rebuilt get_panel call is
 *             refused with 400, and only the page's OWN panel request answers.
 *             The bridge must capture that answer (this is the complaint).
 *   rows      the panel renders plain rows and never calls the API (old DOM).
 *   chapters  the panel opens on “Chapters” and the transcript is a second tab.
 *   late      the “Show transcript” control appears 2 s after load and the
 *             page's own request answers slowly.
 *
 * The worker's caption route cannot work here (no youtube.com), so a round that
 * passes proves the page route, not the network. Budgets are per round, and the
 * report is written to dist/e2e-rounds/report.json.
 */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
} from './chrome.mjs';
import { HEAD, P1, P3, TAIL, TLDR_HEAD } from './fixtures.mjs';
import { createMockProvider } from './mock-provider.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACTS = join(ROOT, 'dist', 'e2e-rounds');
const ROUND_BUDGET_MS = 45000;

/* ------------------------------------------------------------------- variants */

const SEGMENTS = {
  capture: [
    ['0:00', 'ФРАЗА-CAPTURE-01 кэш узлов ускоряет повторный рендер, но требует ограничения памяти, иначе сборщик мусора начинает работать заметно дольше'],
    ['0:30', 'ФРАЗА-CAPTURE-02 память ограничивает размер кэша, поэтому мы держим не больше тысячи записей и вытесняем самые старые из них'],
    ['1:00', 'ФРАЗА-CAPTURE-03 инвалидация сбрасывает устаревшие записи, когда меняются данные профиля, и делает это по ключу, а не целиком'],
    ['1:30', 'ФРАЗА-CAPTURE-04 профилирование показывает узкие места: половина времени уходила на сравнение пропсов, а не на сам рендер'],
    ['2:00', 'ФРАЗА-CAPTURE-05 финальная сборка учитывает лимиты памяти и держит повторный рендер в пределах шести миллисекунд на кадр'],
  ],
  rows: [
    ['0:00', 'ФРАЗА-ROWS-01 читаем панель построчно'],
    ['0:40', 'ФРАЗА-ROWS-02 каждый фрагмент несёт свой таймкод'],
    ['1:20', 'ФРАЗА-ROWS-03 виртуальный список отдаёт строки порциями'],
  ],
  // Real speech is ~140 words a minute; the density guard rejects a panel that
  // only holds chapter titles, so the fixture must read like speech.
  chapters: [
    ['0:00', 'ФРАЗА-CHAPTERS-01 вкладка транскрипта открывается второй и мы начинаем разговор о том, как устроен кэш узлов и почему он вообще нужен большому приложению'],
    ['0:30', 'ФРАЗА-CHAPTERS-02 главы тоже содержат таймкоды, но это не речь: в них только названия разделов и минуты, поэтому движок должен выбрать именно расшифровку'],
    ['1:00', 'ФРАЗА-CHAPTERS-03 текст приходит из транскрипта, где каждая фраза несёт свой таймкод и продолжение мысли, а не просто заголовок раздела'],
    ['1:30', 'ФРАЗА-CHAPTERS-04 дальше мы разбираем инвалидацию кэша, измеряем попадания и промахи, а также проверяем, как размер хранилища влияет на паузы сборщика мусора'],
    ['2:00', 'ФРАЗА-CHAPTERS-05 в финале собираем итоговый конспект: какие решения ускорили рендер и что осталось узким местом после всех изменений'],
  ],
  late: [
    ['0:00', 'ФРАЗА-LATE-01 кнопка появляется после загрузки страницы, поэтому расширение должно дождаться её, а не решать, что транскрипта нет'],
    ['0:45', 'ФРАЗА-LATE-02 ответ панели приходит с задержкой, но это тот же полный текст, и его нужно дождаться вместо повторного запроса'],
  ],
};

/** Where each variant's transcript must come from, per the journal. */
const EXPECTED_ROUTES = {
  capture: ['page-capture'],
  rows: ['page-panel'],
  chapters: ['page-panel'],
  late: ['page-capture', 'page-panel'],
};

const VARIANT_ORDER = ['capture', 'rows', 'chapters', 'late'];

// `?v=` values: the content script only accepts ids of 6–20 url-safe characters.
const VIDEO_IDS = { capture: 'capture', rows: 'rowsvid', chapters: 'chapters', late: 'latevid' };

function panelAnswer(segments) {
  return {
    content: {
      engagementPanelSectionListRenderer: {
        content: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: segments.map(([timestamp, simpleText]) => ({
                    macroMarkersPanelItemViewModel: {
                      item: { timelineItemViewModel: { contentItems: [{ transcriptSegmentViewModel: { timestamp, simpleText } }] } },
                    },
                  })),
                },
              },
            ],
          },
        },
      },
    },
  };
}

function pageShell({ title, duration, videoId, body, script }) {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<script>
  window.ytInitialData = { contents: [{ getTranscriptEndpoint: { params: 'params-${videoId}' } }] };
  window.ytcfg = { get(key) {
    return {
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261023.01.00', hl: 'ru' } },
      INNERTUBE_CLIENT_VERSION: '2.20261023.01.00',
      VISITOR_DATA: 'visitor-${videoId}',
    }[key];
  } };
</script>
</head>
<body style="font-family:sans-serif;margin:2rem">
<h1 class="title ytd-watch-metadata">${title}</h1>
<div id="info-container"><span>1 234 просмотра</span></div>
<span class="ytp-time-duration">${duration}</span>
<div id="movie_player"><video></video></div>
<main>${body}</main>
<script>
  window.__rows = ${JSON.stringify(SEGMENTS)};
  window.__VARIANT = ${JSON.stringify(videoId)};
  window.OSUM_STUB = { segments: window.__rows[window.__VARIANT] || [], panel: null };
  function buildPanel(rows) {
    const host = document.createElement('ytd-engagement-panel-section-list-renderer');
    host.setAttribute('target-id', 'engagement-panel-searchable-transcript');
    const header = document.createElement('div');
    header.id = 'visibility-button';
    const close = document.createElement('button');
    close.textContent = '×';
    close.addEventListener('click', () => host.remove());
    header.append(close);
    const list = document.createElement('div');
    for (const [time, text] of rows) {
      const row = document.createElement('div');
      const chip = document.createElement('span');
      chip.textContent = time;
      const body = document.createElement('div');
      body.textContent = text;
      row.append(chip, body);
      list.append(row);
    }
    host.append(header, list);
    document.body.append(host);
    window.OSUM_STUB.panel = host;
    return { host, list, render(next) {
      list.textContent = '';
      for (const [time, text] of next) {
        const row = document.createElement('div');
        const chip = document.createElement('span');
        chip.textContent = time;
        const body = document.createElement('div');
        body.textContent = text;
        row.append(chip, body);
        list.append(row);
      }
    } };
  }
  ${script}
</script>
</body></html>`;
}

function variantPage(variant) {
  const segments = SEGMENTS[variant];
  const duration = variant === 'late' ? '1:30' : variant === 'rows' ? '2:00' : '3:00';
  const commonButton = `
    const toggle = document.createElement('button');
    toggle.id = 'show-transcript';
    toggle.textContent = 'Показать текст видео';
    document.querySelector('main').append(toggle);`;

  const scripts = {
    // The page's own get_panel call is the only one answered; the extension's
    // rebuilt call (without pageOwn) gets the same 400 YouTube returns.
    capture: `${commonButton}
    toggle.addEventListener('click', async () => {
      if (window.OSUM_STUB.panel) return;
      const view = buildPanel([]);
      const res = await fetch('/youtubei/v1/get_panel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageOwn: true, params: 'params-capture' }),
      });
      const json = await res.json();
      const rows = [];
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.transcriptSegmentViewModel) {
          const vm = node.transcriptSegmentViewModel;
          rows.push([vm.timestamp, vm.simpleText]);
          return;
        }
        for (const value of Object.values(node)) walk(value);
      };
      walk(json);
      view.render(rows);
    });`,
    rows: `${commonButton}
      toggle.addEventListener('click', () => {
        if (window.OSUM_STUB.panel) return;
        buildPanel(window.OSUM_STUB.segments);
      });`,
    chapters: `${commonButton}
      toggle.addEventListener('click', () => {
        if (window.OSUM_STUB.panel) return;
        // Short chapter titles: a panel of three one-word rows over three
        // minutes is not a transcript, so the reader must switch tabs.
        const chapters = window.OSUM_STUB.segments.map((_, i) => [String(i) + ':00', 'Глава ' + (i + 1)]);
        const view = buildPanel(chapters);
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.textContent = 'Транскрипт';
        tab.className = 'osum-stub-tab';
        tab.addEventListener('click', () => view.render(window.OSUM_STUB.segments));
        view.host.prepend(tab);
      });`,
    late: `${commonButton}
      toggle.remove();
      setTimeout(() => {
        document.querySelector('main').append(toggle);
      }, 2200);
      toggle.addEventListener('click', async () => {
        if (window.OSUM_STUB.panel) return;
        const view = buildPanel([]);
        await new Promise((r) => setTimeout(r, 900));
        const res = await fetch('/youtubei/v1/get_panel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageOwn: true, params: 'params-late' }),
        });
        const json = await res.json();
        const rows = [];
        const walk = (node) => {
          if (!node || typeof node !== 'object') return;
          if (node.transcriptSegmentViewModel) {
            const vm = node.transcriptSegmentViewModel;
            rows.push([vm.timestamp, vm.simpleText]);
            return;
          }
          for (const value of Object.values(node)) walk(value);
        };
        walk(json);
        view.render(rows);
      });`,
  };

  return pageShell({
    title: `Проверка панели — ${variant}`,
    duration,
    videoId: variant,
    body: '<p>Локальная страница-заглушка: настоящий YouTube не используется.</p>',
    script: scripts[variant],
  });
}

/* ------------------------------------------------------------------ harness */

function parseArgs(argv) {
  const options = { cycles: 20, variants: VARIANT_ORDER.slice(), headed: false, chrome: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cycles') options.cycles = Math.max(1, Number(argv[++i]) || 20);
    else if (arg.startsWith('--cycles=')) options.cycles = Math.max(1, Number(arg.slice(9)) || 20);
    else if (arg === '--variants') options.variants = String(argv[++i] || '').split(',').filter((v) => SEGMENTS[v]);
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--chrome') options.chrome = argv[++i];
    else if (arg === '--keep-temp') options.keepTemp = true;
  }
  return options;
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

function log(line) {
  console.log(`[rounds] ${line}`);
}

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
  for (const entry of manifest.web_accessible_resources || []) {
    if (!Array.isArray(entry.matches)) continue;
    if (!entry.matches.includes('http://127.0.0.1/*')) entry.matches.push('http://127.0.0.1/*');
  }
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const build = spawnSync('node', [join(ROOT, 'tools', 'build.mjs'), '--target=chrome'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`сборка не удалась:\n${build.stdout}\n${build.stderr}`);

  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  const sourceExt = join(ROOT, 'dist', 'opensummary-chrome');
  if (!existsSync(sourceExt)) throw new Error(`сборка не найдена: ${sourceExt}`);
  const tempDir = mkdtempSync(join(tmpdir(), 'osum-rounds-'));
  const extDir = join(tempDir, 'ext');
  cpSync(sourceExt, extDir, { recursive: true });
  patchTestManifest(extDir);

  const mock = createMockProvider({ head: HEAD, tail: TAIL, log });
  const mockUrl = await listen(mock.server);
  mock.setMode('normal');

  const pageServer = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/youtubei/v1/get_panel' || url.pathname === '/youtubei/v1/get_transcript') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        // Only the page's own request is answered. A rebuilt call (the
        // extension asking on its own) is refused exactly as YouTube refuses it.
        if (url.pathname.endsWith('get_panel') && body.includes('"pageOwn":true')) {
          const variant = (body.match(/params-(capture|late)/) || [])[1] || 'capture';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(panelAnswer(SEGMENTS[variant])));
          return;
        }
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"Precondition check failed."}}');
      });
      return;
    }
    const watchId = url.searchParams.get('v') || 'capture';
    const variant = Object.keys(VIDEO_IDS).find((key) => VIDEO_IDS[key] === watchId) || 'capture';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(variantPage(variant));
  });
  const pagePort = await listen(pageServer);

  const { binary } = resolveChrome(options.chrome);
  const cdpPort = await freePort();
  const profileDir = join(tempDir, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const chrome = launchChrome(binary, {
    profileDir,
    port: cdpPort,
    headed: options.headed,
    logPath: join(ARTIFACTS, 'chrome.log'),
  });
  const version = await waitForCdp(cdpPort, { child: chrome.child, tail: chrome.stderrTail });
  const browser = await connectCdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send('Extensions.loadUnpacked', { path: extDir });
  const extId = loaded.id;
  log(`браузер ${version.Browser}, расширение ${extId}`);

  const optionsTarget = await newTarget(cdpPort, `chrome-extension://${extId}/src/options/options.html`);
  const optionsPage = await connectCdp(optionsTarget.webSocketDebuggerUrl);
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
  await optionsPage.evaluate(
    `chrome.storage.local.set(${JSON.stringify({
      'osum:settings': {
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
      },
      'osum:providers': [provider],
      'osum:keys': { 'p-mock': 'sk-mock-local' },
    })})`,
  );

  // Guard against an unnoticed seed failure: every cycle must run with the
  // caches off, otherwise the second lap of the same video answers from the
  // summary cache without asking the mock provider at all.
  const seeded = await optionsPage.evaluate(
    "chrome.storage.local.get('osum:settings').then((r) => JSON.stringify({ cache: r['osum:settings']?.cache, useCache: r['osum:settings']?.ai?.useCache, chunkCache: r['osum:settings']?.ai?.chunkCache, provider: r['osum:settings']?.ai?.providerId }))",
  );
  log(`настройки циклов: ${seeded}`);
  if (!/"enabled":false/.test(seeded) || !/"useCache":false/.test(seeded)) {
    throw new Error(`настройки не применились: ${seeded}`);
  }

  const readJournal = async () =>
    optionsPage
      .evaluate("chrome.storage.local.get('osum:journal').then((r) => r['osum:journal'] || [])")
      .catch(() => []);

  const results = [];
  let failures = 0;
  for (let i = 0; i < options.cycles; i++) {
    const variant = options.variants[i % options.variants.length];
    const videoId = VIDEO_IDS[variant];
    const url = `http://127.0.0.1:${pagePort}/youtube.com/watch?v=${videoId}&i=${i}`;
    const target = await newTarget(cdpPort, url);
    const page = await connectCdp(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    const requestsBefore = mock.state.requests;
    const startedAt = Date.now();
    const row = { cycle: i + 1, variant, videoId, ok: false };
    try {
      await waitFor(
        page,
        "!!document.getElementById('osum-host')?.shadowRoot?.querySelector('.osum-fab')",
        'панель расширения',
        { timeoutMs: 20000 },
      );
      await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-fab').click()");
      await waitFor(
        page,
        "!document.getElementById('osum-host').shadowRoot.querySelector('.osum-panel').hidden",
        'панель открылась',
        { timeoutMs: 8000 },
      );
      await waitFor(
        page,
        "(() => { const b = document.getElementById('osum-host').shadowRoot.querySelector('.osum-run'); return !!b && !b.disabled; })()",
        'кнопка запуска готова',
        { timeoutMs: 15000 },
      );
      await page.evaluate("document.getElementById('osum-host').shadowRoot.querySelector('.osum-run').click()");

      // A run started from a page route writes its transcript to the journal;
      // waiting for the final TL;DR is the real proof that it reached the model.
      await waitFor(
        page,
        `(() => {
          const sr = document.getElementById('osum-host').shadowRoot;
          return !!sr.querySelector('.osum-tldr-text') || !!sr.querySelector('.osum-error');
        })()`,
        `итог или ошибка (${variant})`,
        { timeoutMs: ROUND_BUDGET_MS },
      );
      const state = await page.evaluate(`(() => {
        const sr = document.getElementById('osum-host').shadowRoot;
        return {
          error: sr.querySelector('.osum-error')?.textContent?.replace(/\\s+/g, ' ').slice(0, 500) || '',
          tldr: sr.querySelector('.osum-tldr-text')?.textContent?.replace(/\\s+/g, ' ').slice(0, 300) || '',
          points: sr.querySelectorAll('.osum-point').length,
          status: sr.querySelector('.osum-status')?.textContent?.replace(/\\s+/g, ' ').slice(0, 200) || '',
        };
      })()`);
      const elapsed = Date.now() - startedAt;
      row.ms = elapsed;
      row.requests = mock.state.requests - requestsBefore;
      row.points = state.points;
      if (state.error) throw new Error(`панель показала ошибку: ${state.error}`);
      if (!state.tldr.includes(TLDR_HEAD.slice(0, 24))) throw new Error(`TL;DR не отрисован (${state.tldr.slice(0, 80)})`);
      if (!state.points) throw new Error('в итоге нет ключевых пунктов');

      const prompt = String(mock.state.prompts[mock.state.prompts.length - 1] || '');
      const missing = SEGMENTS[variant].map(([, text]) => text).filter((text) => !prompt.includes(text));
      if (missing.length) {
        throw new Error(`в запрос к модели не попали фрагменты: ${missing.map((t) => t.slice(0, 28)).join(' | ')}`);
      }
      if (row.requests < 1) throw new Error('провайдер не получил ни одного запроса');
      row.segments = SEGMENTS[variant].length;

      const journal = (await readJournal()).filter((entry) => entry.videoId === videoId);
      const okRoutes = journal.filter((entry) => entry.level === 'ok').map((entry) => entry.route).filter(Boolean);
      row.routes = [...new Set(okRoutes)];
      const expected = EXPECTED_ROUTES[variant];
      if (!row.routes.some((route) => expected.includes(route))) {
        throw new Error(`маршрут транскрипта ${row.routes.join('/') || '—'}, ожидался ${expected.join('/')}`);
      }
      if (elapsed > ROUND_BUDGET_MS) throw new Error(`цикл занял ${elapsed} мс — больше бюджета ${ROUND_BUDGET_MS} мс`);
      row.ok = true;
      log(`цикл ${i + 1}/${options.cycles} (${variant}): OK — ${row.segments} фрагментов, ${state.points} пунктов, ` +
        `${elapsed} мс, маршрут ${row.routes.join('/')}`);
    } catch (err) {
      failures++;
      row.error = err.message;
      log(`цикл ${i + 1}/${options.cycles} (${variant}): FAIL — ${err.message}`);
      try {
        const text = await panelText(page);
        row.panel = text.replace(/\s+/g, ' ').slice(0, 800);
        await screenshot(page, join(ARTIFACTS, `failure-${i + 1}-${variant}.png`));
        const journal = await readJournal();
        row.journal = journal
          .slice(-12)
          .map((entry) => `${entry.route || '?'}:${entry.code || entry.level || 'ok'}${entry.message ? ` — ${String(entry.message).slice(0, 90)}` : ''}`);
        // The panel's own state decides whether it was still waiting or had
        // already given up: the rendered text alone cannot tell.
        const context = page.events
          .filter((event) => event.method === 'Runtime.executionContextCreated')
          .map((event) => event.params.context)
          .filter((ctx) => String(ctx.origin || '').startsWith('chrome-extension://'))
          .pop();
        if (context?.id) {
          const dump = await page.send('Runtime.evaluate', {
            contextId: context.id,
            expression: `JSON.stringify({
              running: OSUM.state.running,
              status: OSUM.state.statusMessage,
              error: OSUM.state.error ? OSUM.state.error.code || OSUM.state.error.message : null,
              source: OSUM.state.transcript?.meta?.source || '',
              segments: OSUM.state.transcript?.segments?.length || 0,
              result: !!OSUM.state.result,
              streamDraft: !!OSUM.state.streamDraft,
            })`,
            returnByValue: true,
          });
          row.state = dump.result?.value;
        }
      } catch {
        /* diagnostics are best effort */
      }
    }
    results.push(row);
    try {
      await browser.send('Target.closeTarget', { targetId: target.id || target.targetId });
    } catch {
      /* the page may already be gone */
    }
  }

  writeFileSync(join(ARTIFACTS, 'report.json'), JSON.stringify(results, null, 2));
  const ok = results.filter((row) => row.ok);
  const times = ok.map((row) => row.ms).sort((a, b) => a - b);
  const summary = {
    cycles: results.length,
    passed: ok.length,
    failed: failures,
    variants: options.variants,
    medianMs: times.length ? times[Math.floor(times.length / 2)] : 0,
    maxMs: times.length ? times[times.length - 1] : 0,
    minMs: times.length ? times[0] : 0,
    requests: results.reduce((a, row) => a + (row.requests || 0), 0),
  };
  writeFileSync(join(ARTIFACTS, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`итог: ${summary.passed}/${summary.cycles} циклов, медиана ${summary.medianMs} мс, ` +
    `максимум ${summary.maxMs} мс, запросов к модели ${summary.requests}`);

  mock.close();
  pageServer.close();
  try {
    chrome.child.kill();
  } catch {
    /* the browser may already be gone */
  }
  await once(chrome.child, 'exit').catch(() => {});
  if (!options.keepTemp) rmSync(tempDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`[rounds] FAILED: ${err.stack || err.message}`);
  process.exit(1);
});
