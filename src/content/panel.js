/**
 * The on-page panel: shadow DOM UI, AI streaming, summary rendering, Q&A,
 * transcript viewer and exports.
 */

(function () {
  const OSUM = window.OSUM;
  const { el, icon, highlight } = OSUM.dom;
  const { util, fmt, exporter } = OSUM;

  const LANGS = [
    ['auto', 'Авто'],
    ['ru', 'Русский'],
    ['en', 'English'],
    ['uk', 'Українська'],
    ['kk', 'Қазақша'],
    ['es', 'Español'],
    ['de', 'Deutsch'],
    ['fr', 'Français'],
    ['it', 'Italiano'],
    ['pt', 'Português'],
    ['pl', 'Polski'],
    ['tr', 'Türkçe'],
    ['ar', 'العربية'],
    ['hi', 'हिन्दी'],
    ['zh', '中文'],
    ['ja', '日本語'],
    ['ko', '한국어'],
    ['nl', 'Nederlands'],
    ['sv', 'Svenska'],
    ['he', 'עברית'],
    ['id', 'Indonesia'],
    ['vi', 'Tiếng Việt'],
  ];

  const LANG_LABELS = Object.fromEntries(LANGS);

  // Two reader-facing tabs. Sections already live inside the overview, and the
  // timeline was a second list of the same chapters with a heat strip nobody
  // used — removing both left the summary with one place to read and one place
  // to ask questions.
  const TABS = ['overview', 'ask'];

  let host = null;
  let shadow = null;
  let refs = {};
  let port = null;
  let keepAliveTimer = null;
  let currentTaskId = null;

  /* ------------------------------------------------------------------- mount */

  function mount() {
    if (host) return;
    // Never leave an older host behind: a reinjected content script would add a
    // second floating button over the first, and the visible one would be the
    // orphan whose state nobody updates any more.
    for (const stale of Array.from(document.querySelectorAll('#osum-host'))) stale.remove();
    host = document.createElement('div');
    host.id = 'osum-host';
    host.style.cssText = 'all: initial;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OSUM.css;
    shadow.appendChild(style);

    const root = el('div', { class: 'osum-root', id: 'osum-root' });
    const toastBox = el('div', { class: 'osum-toasts' });
    const fab = el('button', {
      class: 'osum-fab',
      title: OSUM.t('fabTitle'),
      'aria-label': OSUM.t('fabTitle'),
      onclick: () => OSUM.panel.toggle(),
    });
    fab.appendChild(icon('logo', 22));

    const panel = el('section', {
      class: 'osum-panel',
      role: 'dialog',
      'aria-label': OSUM.t('panelTitle'),
      hidden: true,
    });
    root.append(fab, panel, toastBox);
    shadow.appendChild(root);
    util.setToastHost(toastBox);

    refs = { root, panel, fab };
    root.dataset.docked = 'false';
    document.body.appendChild(host);
    applyTheme();
    render();
  }

  function applyTheme() {
    if (!refs.root) return;
    const settings = OSUM.state.settings || {};
    const mode = settings.ui?.theme || 'light';
    const theme = mode === 'auto' ? (util.isDarkTheme() ? 'dark' : 'light') : mode === 'dark' ? 'dark' : 'light';
    OSUM.state.theme = theme;
    refs.root.dataset.theme = theme;
    refs.root.style.setProperty('--osum-width', `${clampWidth(settings.ui?.panelWidth || 420)}px`);
  }

  function clampWidth(width) {
    const max = Math.max(320, Math.min(720, window.innerWidth - 40));
    return Math.max(300, Math.min(Number(width) || 420, max));
  }

  /* --------------------------------------------------------------- structure */

  function render() {
    if (!refs.panel) return;
    const st = OSUM.state;
    const panel = refs.panel;
    // Where the reader is in the document, captured before the rebuild: the old
    // body is detached below, and a detached element has no scroll position to
    // read afterwards — which is why every streamed item used to send the
    // reader back to the top.
    const scroll = captureScroll(refs.body);
    // One source of truth for the floating button: an open panel hides it,
    // whatever path opened the panel (FAB, hotkey, popup, auto-open).
    if (refs.root) refs.root.dataset.panelOpen = st.panelOpen ? 'true' : 'false';
    if (refs.fab) refs.fab.hidden = !!st.panelOpen || st.settings?.ui?.showFab === false;
    panel.textContent = '';
    panel.append(
      buildHeader(),
      buildQuickSettings(),
      buildResumeNotice(),
      buildStatus(),
    );
    const body = el('div', { class: 'osum-body' });
    body.appendChild(buildBody());
    // Everything about the run scrolls with the summary. As a sibling of the
    // body it was a flex item that could not shrink: its own content spilled
    // under the footer and the panel drew a second scrollbar across it.
    body.appendChild(buildRunDetails());
    refs.body = body;
    panel.append(body, buildFooter());
    // Only after the body is in the document does setting scrollTop do
    // anything. Streaming map notes arrive one by one; a rebuild must not jump
    // the reader back to the top of a long summary.
    restoreScroll(body, scroll);
    refs.panel.classList.toggle('osum-panel-wide', clampWidth(st.settings?.ui?.panelWidth || 420) > 560);
  }

  /**
   * Reading position of the scrolling body: the scroll offset plus the first
   * block that is (partly) visible and its offset from the body's top. The
   * block matters because streamed fragments may grow above the viewport, and
   * then the same pixel offset shows different text.
   */
  function captureScroll(body) {
    if (!body) return null;
    const top = Number(body.scrollTop) || 0;
    if (top <= 0) return { top: 0 };
    const children = Array.from(body.children || []);
    const bodyRect = body.getBoundingClientRect?.();
    if (!children.length || !bodyRect) return { top };
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect?.();
      if (!rect) return { top };
      if (rect.bottom > bodyRect.top + 4) return { top, index: i, offset: rect.top - bodyRect.top };
    }
    return { top, index: children.length - 1, offset: 0 };
  }

  /** Puts the reading position back after the body was rebuilt. */
  function restoreScroll(body, snap) {
    if (!body || !snap) return;
    if (snap.top > 0 && snap.offset != null) {
      const children = Array.from(body.children || []);
      const anchor = children[Math.min(snap.index, children.length - 1)];
      const bodyRect = body.getBoundingClientRect?.();
      const rect = anchor?.getBoundingClientRect?.();
      if (bodyRect && rect) {
        body.scrollTop = Math.max(0, snap.top + (rect.top - bodyRect.top) - snap.offset);
        return;
      }
    }
    body.scrollTop = snap.top || 0;
  }

  /**
   * The header is the navigation: four tabs, then the actions a viewer needs
   * while reading. The product name, logo and version are not one of them —
   * the panel is already inside the extension the user installed.
   */
  function buildHeader() {
    const st = OSUM.state;
    const actions = el('div', { class: 'osum-head-actions' });
    // The primary action keeps its words. A lone sparkle made the most important
    // button in the panel a guessing game, and the tabs have room next to it.
    const hasResult = !!st.result;
    const run = el(
      'button',
      {
        class: 'osum-btn osum-btn-primary osum-run',
        title: st.running ? OSUM.t('cancel') : hasResult ? OSUM.t('resummarize') : OSUM.t('summarize'),
        onclick: () => (st.running ? OSUM.panel.cancel() : OSUM.panel.run({ force: hasResult })),
      },
      [icon(st.running ? 'stop' : hasResult ? 'refresh' : 'sparkle', 15), el('span', { text: st.running ? OSUM.t('stop') : hasResult ? OSUM.t('resummarize') : OSUM.t('summarize') })],
    );
    if (st.running) run.setAttribute('aria-busy', 'true');
    actions.appendChild(run);
    // Explicit continuation of a saved run. It is offered only when the
    // background confirmed the saved job still matches this video, transcript,
    // prompt, model and settings — never for a cancelled or finished job.
    if (st.resumableJob && !st.running) {
      actions.appendChild(
        iconBtn('play', OSUM.t('resumeTitle'), () => OSUM.panel.run({ resume: true }), 'osum-resume-btn'),
      );
    }
    const dark = refs.root?.dataset.theme === 'dark';
    // Emoji, not a hand-drawn glyph: a small custom sun/moon at 17px read as an
    // abstract shape. The system emoji is unambiguous at any size.
    actions.append(
      emojiBtn(dark ? '☀️' : '🌙', dark ? OSUM.t('themeLight') : OSUM.t('themeDark'), () => OSUM.panel.toggleTheme(), 'osum-theme'),
      iconBtn('settings', OSUM.t('quickSettings'), () => OSUM.panel.toggleQuickSettings(), 'osum-quick-toggle'),
      iconBtn('close', OSUM.t('close'), () => OSUM.panel.close()),
    );
    return el('header', { class: 'osum-head' }, [buildTabs(), actions]);
  }

  /**
   * Quick settings: the mode/provider/model/language/length row, folded away
   * behind the gear. These are decisions made once, not on every video, and
   * keeping them on screen was most of the visual noise.
   */
  function buildQuickSettings() {
    const st = OSUM.state;
    const box = el('div', { class: 'osum-quick', hidden: !st.quickSettingsOpen });
    if (!st.quickSettingsOpen) return box;
    // One row: the controls, then “All settings” pinned to the right edge.
    // No “SETTINGS” heading — the gear that opened this box already says what
    // it is, and the heading cost a whole line above the first control.
    const row = el('div', { class: 'osum-quick-row' }, [buildControls()]);
    row.appendChild(
      el(
        'button',
        {
          class: 'osum-btn osum-quick-all',
          title: OSUM.t('allSettings'),
          onclick: () => openOptionsPage(),
        },
        [icon('settings', 13), el('span', { text: OSUM.t('allSettings') })],
      ),
    );
    box.appendChild(row);
    return box;
  }

  async function openOptionsPage() {
    try {
      await util.sendMessage({ type: 'open-options' });
    } catch {
      window.open('chrome-extension://' + chrome.runtime.id + '/src/options/options.html', '_blank');
    }
  }

  function iconBtn(name, title, onClick, extraClass = '') {
    const btn = el('button', { class: `osum-icon-btn ${extraClass}`.trim(), title, 'aria-label': title, onclick: onClick });
    btn.appendChild(icon(name, 17));
    return btn;
  }

  function emojiBtn(glyph, title, onClick, extraClass = '') {
    return el('button', {
      class: `osum-icon-btn osum-emoji-btn ${extraClass}`.trim(),
      title,
      'aria-label': title,
      text: glyph,
      onclick: onClick,
    });
  }

  function buildControls() {
    const st = OSUM.state;
    const settings = st.settings || {};
    const providers = st.providers || [];
    const controls = el('div', { class: 'osum-controls' });

    // One engine: the AI. The offline extractive engine was removed in 1.6.0
    // (its terse, repeated lead sentences were the main quality complaint), so
    // the mode switch has nothing left to switch between.
    {
      const providerSelect = el('select', {
        class: 'osum-select',
        title: OSUM.t('provider'),
        onchange: (e) => OSUM.panel.setProvider(e.target.value),
      });
      if (!providers.length) providerSelect.appendChild(el('option', { value: '', text: '— нет провайдеров —' }));
      for (const p of providers) {
        providerSelect.appendChild(el('option', { value: p.id, text: p.name, selected: p.id === st.providerId }));
      }
      controls.appendChild(providerSelect);

      const active = providers.find((p) => p.id === st.providerId);
      const models = (active?.models || []).slice();
      if (active?.defaultModel && !models.includes(active.defaultModel)) models.unshift(active.defaultModel);
      const modelSelect = el('select', {
        class: 'osum-select',
        title: OSUM.t('model'),
        onchange: (e) => OSUM.panel.setModel(e.target.value),
      });
      if (!models.length) modelSelect.appendChild(el('option', { value: '', text: '— модель —' }));
      for (const m of models) modelSelect.appendChild(el('option', { value: m, text: m, selected: m === st.model }));
      controls.appendChild(modelSelect);
      // Provider model lists drift constantly (free tiers especially), so let the
      // user pull the live list without opening the settings page.
      controls.appendChild(iconBtn('refresh', OSUM.t('loadModels'), () => OSUM.panel.loadModels(active)));
    }

    const langSelect = el('select', {
      class: 'osum-select',
      title: OSUM.t('language'),
      onchange: (e) => setOutput({ lang: e.target.value }),
    });
    for (const [value, label] of LANGS) {
      langSelect.appendChild(el('option', { value, text: value === 'auto' ? OSUM.t('langAuto') : label, selected: value === st.lang }));
    }
    controls.appendChild(langSelect);

    const lengthSelect = el('select', {
      class: 'osum-select',
      title: OSUM.t('length'),
      onchange: (e) => setOutput({ length: e.target.value }),
    });
    for (const [value, label] of [
      ['short', OSUM.t('lengthShort')],
      ['standard', OSUM.t('lengthStandard')],
      ['detailed', OSUM.t('lengthDetailed')],
    ]) {
      lengthSelect.appendChild(el('option', { value, text: label, selected: value === st.length }));
    }
    controls.appendChild(lengthSelect);

    const modeSelect = el('select', {
      class: 'osum-select',
      title: OSUM.t('summaryMode'),
      onchange: (e) => setOutput({ summaryMode: e.target.value }),
    });
    for (const [value, label] of [
      ['whole', OSUM.t('summaryModeWhole')],
      ['timeline', OSUM.t('summaryModeTimeline')],
    ]) {
      modeSelect.appendChild(el('option', { value, text: label, selected: value === st.summaryMode }));
    }
    controls.appendChild(modeSelect);
    void settings;
    return controls;
  }

  function buildResumeNotice() {
    const st = OSUM.state;
    const job = st.resumableJob;
    const show = !!(job && !st.running);
    const box = el('div', { class: 'osum-resume', hidden: !show });
    if (!show) return box;
    const saved = Number(job.savedChunks) || 0;
    const total = Number(job.totalChunks) || 0;
    const counts = total ? `${saved} / ${total}` : String(saved);
    box.appendChild(
      el('p', {
        class: 'osum-hint',
        text: `${OSUM.t('resumeHint')} · ${OSUM.t('resumeSavedChunks')}: ${counts}`,
      }),
    );
    const reason = resumeReasonLabel(job.interruptionReason || job.error);
    if (reason) box.appendChild(el('p', { class: 'osum-hint', text: `${OSUM.t('resumeReason')}: ${reason}` }));
    return box;
  }

  /** Human label for the saved interruption reason (worker-side codes). */
  function resumeReasonLabel(reason) {
    const map = {
      'job-timeout': 'finishJobTimeout',
      'call-timeout': 'finishCallTimeout',
      incomplete: 'finishIncomplete',
      'worker-restart': 'resumeReasonWorker',
      cancelled: 'finishCancelled',
    };
    const key = map[String(reason || '')];
    return key ? OSUM.t(key) : String(reason || '');
  }

  function buildStatus() {
    const st = OSUM.state;
    const box = el('div', { class: 'osum-status', hidden: !st.running && !st.statusMessage });
    if (!st.running && !st.statusMessage) return box;
    // A finished summary needs no “Готово” line: the result is the message.
    // Errors keep their own card above, so only that case stays visible.
    if (!st.running && st.result && !st.error) return el('div', { class: 'osum-status', hidden: true });
    const line = el('div', { class: 'osum-status-line' });
    if (st.running) line.appendChild(el('span', { class: 'osum-spin' }));
    line.appendChild(el('span', { text: st.statusMessage || '' }));
    box.appendChild(line);
    if (st.progress && st.progress.total > 1) {
      const bar = el('div', { class: 'osum-bar' }, [el('i', { style: { width: `${Math.round(((st.progress.done || 0) / st.progress.total) * 100)}%` } })]);
      box.appendChild(bar);
    }
    // Live deadline: how much of the job budget is left, counted down locally
    // from the deadline the worker sent. It used to be a static “6:10 / 6:10”
    // that only moved when a progress event arrived, which is no use for
    // deciding whether to wait.
    const diag = st.aiDiagnostics;
    if (st.running && diag && (diag.deadlineAt || diag.budgetMs > 0)) {
      const counts = diag.stage === 'map' && diag.total
        ? ` · ${diag.done || 0}/${diag.total} · ${OSUM.t('diagRunning')} ${diag.running || 0} · ${OSUM.t('diagPending')} ${diag.pending || 0}`
        : '';
      const line = el('div', { class: 'osum-status-line osum-status-budget', text: budgetLabel(diag, counts) });
      line.dataset.counts = counts;
      refs.budgetLine = line;
      box.appendChild(line);
    } else {
      refs.budgetLine = null;
    }
    // A finished run keeps no timing line up here: elapsed time, the initial
    // budget and every per-stage number live in “Run details” at the bottom,
    // where they explain the run instead of pushing the summary down.
    return box;
  }

  function buildTabs() {
    const st = OSUM.state;
    const nav = el('nav', { class: 'osum-tabs', role: 'tablist' });
    const labels = {
      overview: OSUM.t('tabOverview'),
      sections: OSUM.t('tabSections'),
      timeline: OSUM.t('tabTimeline'),
      ask: OSUM.t('tabAsk'),
    };
    for (const tab of TABS) {
      nav.appendChild(
        el('button', {
          class: 'osum-tab',
          role: 'tab',
          'aria-selected': String(st.tab === tab),
          text: labels[tab],
          onclick: () => OSUM.panel.setTab(tab),
        }),
      );
    }
    return nav;
  }

  /* -------------------------------------------------------------------- body */

  function buildBody() {
    const st = OSUM.state;
    if (st.error) {
      const error = buildError();
      if (st.partialChunks?.length) error.appendChild(buildPartialPreview());
      // Validated items that arrived before the failure are still worth
      // reading; they are labelled as unchecked by a completed run.
      if (st.streamDraft) error.appendChild(buildStreamPreview({ provisional: true }));
      // A failed refresh must not hide the summary the reader already has: the
      // card explains what went wrong, the old result stays readable below it.
      if (st.result && st.tab !== 'ask') {
        const wrap = el('div', {});
        wrap.append(error, asDocument(buildOverview(st.result)));
        return wrap;
      }
      return error;
    }
    if (st.tab === 'ask') return buildAskTab();
    if (!st.result) {
      if (st.partialChunks?.length) return asDocument(buildPartialPreview());
      if (st.streamDraft) return asDocument(buildStreamPreview({ provisional: !!st.streamDraft.provisional }));
      return buildEmptyState();
    }
    // The reading tabs are one document: a lead, then headed blocks separated
    // by hairlines. Boxes and accent fills belong to controls, not to prose.
    if (st.tab === 'overview') return asDocument(buildOverview(st.result));
    return buildEmptyState();
  }

  function buildEmptyState() {
    const box = el('div', { class: 'osum-empty' }, [
      icon('sparkle', 26),
      el('p', { text: OSUM.t('emptyStateAi') }),
    ]);
    return el('div', {}, [box]);
  }

  function st0() {
    return OSUM.state;
  }

  function buildError() {
    const err = OSUM.state.error || {};
    const box = el('div', { class: 'osum-error' });
    box.appendChild(el('h4', { text: OSUM.t('errorTitle') }));
    // Worker messages are always Russian; the panel owns its own language. For
    // the codes that have a written headline, show that instead of the
    // worker's text (an English card used to mix “Something went wrong” with
    // the Russian reason).
    const uiMessages = {
      BAD_JSON: 'badJsonTitle',
      MISROUTED_MODEL: 'misroutedModelTitle',
    };
    const messageKey = uiMessages[err.code];
    box.appendChild(el('p', { text: messageKey ? OSUM.t(messageKey) : err.message || String(err) }));
    const noTranscript = [
      'NO_CAPTIONS',
      'EMPTY_CAPTIONS',
      'POT_REQUIRED',
      'PARSE_FAILED',
      'NO_TRACK_SELECTED',
      'EMPTY_TRANSCRIPT',
      'NO_PAGE_TRANSCRIPT',
    ].includes(err.code);
    // Hints describe what to do next, so they must be in the panel's language:
    // the worker does not know the UI language and its text is always Russian.
    const uiHints = {
      NO_CAPTIONS: 'emptyTranscriptHint',
      EMPTY_CAPTIONS: 'potRequiredHint',
      POT_REQUIRED: 'potRequiredHint',
      PARSE_FAILED: 'parseFailedHint',
      NO_TRACK_SELECTED: 'emptyTranscriptHint',
      EMPTY_TRANSCRIPT: 'potRequiredHint',
      NO_PAGE_TRANSCRIPT: 'pageTranscriptFailedHint',
      WORKER_TIMEOUT: 'workerSilentHint',
      WORKER_SILENT: 'workerSilentHint',
      SAFETY: 'safetyHint',
      BAD_JSON: 'badJsonHint',
      MISROUTED_MODEL: 'misroutedModelHint',
    };
    const hintKey = uiHints[err.code];
    const hint = hintKey ? OSUM.t(hintKey) : err.hint || '';
    if (hint) box.appendChild(el('p', { class: 'osum-hint', text: hint }));
    if (err.finishReason) {
      box.appendChild(el('p', { class: 'osum-hint', text: `${OSUM.t('diagFinish')}: ${finishLabel(err.finishReason)}` }));
    }
    if (err.resumable) box.appendChild(el('p', { class: 'osum-hint', text: OSUM.t('diagResumeHint') }));
    if (err.pageError === 'NO_PAGE_TRANSCRIPT') {
      box.appendChild(el('p', { class: 'osum-hint', text: `${OSUM.t('pageTranscriptFailed')}: ${OSUM.t('pageTranscriptFailedHint')}` }));
    }
    const actions = el('div', { class: 'osum-actions' });
    if (err.resumable && OSUM.state.resumableJob) {
      actions.appendChild(
        el('button', {
          class: 'osum-btn osum-btn-primary',
          text: OSUM.t('resume'),
          title: OSUM.t('resumeTitle'),
          onclick: () => OSUM.panel.run({ resume: true }),
        }),
      );
    }
    const canResumeHere = !!(err.resumable && OSUM.state.resumableJob);
    actions.appendChild(
      el('button', {
        class: canResumeHere ? 'osum-btn' : 'osum-btn osum-btn-primary',
        text: OSUM.t('retry'),
        onclick: () => OSUM.panel.run({ force: true }),
      }),
    );
    if (noTranscript) {
      // The caption API is blocked (PO token) or empty, but the page itself has
      // a working transcript panel: read it instead of giving up.
      actions.appendChild(
        el('button', {
          class: 'osum-btn',
          text: OSUM.t('transcriptFromPage'),
          onclick: () => OSUM.panel.useTranscriptFromPage(),
        }),
      );
      actions.appendChild(
        el('button', {
          class: 'osum-btn',
          text: OSUM.t('showYoutubeTranscript'),
          onclick: async () => {
            const opened = await OSUM.transcriptDom.openTranscriptPanel();
            if (!opened.ok) util.toast(OSUM.t('pageTranscriptFailed'), { variant: 'error' });
          },
        }),
      );
    }
    if (
      ['NO_PROVIDER', 'NO_KEY', 'NO_MODEL', 'AUTH', 'TRUNCATED', 'CONTEXT_LENGTH', 'EMPTY_RESULT', 'BAD_JSON', 'SAFETY', 'MISROUTED_MODEL'].includes(
        err.code,
      )
    ) {
      actions.appendChild(
        el('button', {
          class: 'osum-btn',
          text: OSUM.t('openSettings'),
          onclick: async () => {
            try {
              await util.sendMessage({ type: 'open-options', section: 'providers' });
            } catch {
              /* ignore */
            }
          },
        }),
      );
    }
    box.appendChild(actions);
    const detailsText = [err.code && `code: ${err.code}`, err.status && `status: ${err.status}`, err.provider && `provider: ${err.provider}`, err.detail].filter(Boolean).join('\n');
    if (detailsText) {
      const details = el('details');
      details.appendChild(el('summary', { class: 'osum-hint', text: OSUM.t('details') }));
      details.appendChild(el('pre', { text: detailsText }));
      box.appendChild(details);
    }
    return box;
  }

  /**
   * Timed items grouped by their timecode. A model writes several points that
   * start at the same second, and a list of them used to repeat “0:56” three
   * times. One timecode per moment, the points under it as a small list — the
   * shape Yandex's summary uses.
   * @returns {Array<{at: number|null, ts: string|null, points: Array}>}
   */
  function groupByTime(points) {
    const groups = [];
    for (const point of points || []) {
      const text = String(point?.text || '').trim();
      if (!text) continue;
      const at = point?.at == null ? null : Number(point.at);
      const last = groups[groups.length - 1];
      // Only consecutive items share a block: the list is in video order, so a
      // point in between cannot belong to the same moment.
      if (last && at != null && last.at === at) last.points.push({ ...point, text });
      else groups.push({ at, ts: point?.ts || (at == null ? null : fmt.time(at)), points: [{ ...point, text }] });
    }
    return groups;
  }

  function seekPoint(at, ts) {
    if (!util.seekTo(at)) util.toast(OSUM.t('cantSeek'), { variant: 'error' });
    void ts;
  }

  /**
   * One moment: its timecode, then one line per point. The whole block is the
   * seek target and the hover plate, so the reader aims at the sentence (or at
   * the number next to it) and gets the same result.
   */
  function timedGroup(group, { query = '', hideTs = false } = {}) {
    const stack = el('span', { class: 'osum-stack' });
    const many = group.points.length > 1;
    for (const point of group.points) {
      const line = el('span', { class: 'osum-line' });
      // A small dot instead of a nested <ul>: a list of one-line bullets inside
      // a button cannot be a real list element, and the dot is the whole mark.
      if (many) line.appendChild(el('span', { class: 'osum-dot', text: '•' }));
      line.appendChild(query ? highlight(point.text, query) : document.createTextNode(point.text));
      stack.appendChild(line);
    }
    if (group.at == null) return el('div', { class: 'osum-untimed' }, [stack]);
    const btn = el('button', {
      class: 'osum-point',
      title: `${OSUM.t('openTimeline')} ${group.ts}`,
      onclick: () => seekPoint(group.at, group.ts),
    });
    if (!hideTs) btn.appendChild(el('span', { class: 'osum-ts', text: group.ts }));
    btn.appendChild(stack);
    return btn;
  }

  function pointList(points, { query = '', hideTsAt = null } = {}) {
    const list = el('ul', { class: 'osum-points' });
    for (const group of groupByTime(points)) {
      const li = el('li', {});
      // The section heading already carries this timecode: the points that
      // start there continue the heading instead of repeating the number.
      const hide = hideTsAt != null && group.at != null && group.at === Number(hideTsAt);
      li.appendChild(timedGroup(group, { query, hideTs: hide }));
      list.appendChild(li);
    }
    return list;
  }

  /**
   * One section: a seeking heading, its summary and its points grouped by
   * moment. Points that start exactly at the heading continue it without a
   * second copy of the same timecode.
   */
  function sectionBlock(section) {
    const block = el('div', { class: 'osum-section' });
    const head = el('div', { class: 'osum-section-head' });
    // The heading and its summary are one seek target and one hover plate: a
    // reader points at the paragraph they are reading, not only at the title.
    head.appendChild(sectionButton(section, section.summary));
    block.appendChild(head);
    const points = (section.points || []).filter((p) => String(p?.text || '').trim());
    if (!points.length) return block;
    const starting = section.at == null
      ? []
      : points.filter((p) => p.at != null && Number(p.at) === Number(section.at));
    if (starting.length) {
      // Same second as the heading: a bullet list under it, no second timecode.
      const list = el('ul', { class: 'osum-points' });
      for (const group of groupByTime(starting)) {
        const li = el('li', {});
        li.appendChild(timedGroup(group, { hideTs: true }));
        list.appendChild(li);
      }
      block.appendChild(list);
    }
    const rest = starting.length ? points.filter((p) => !starting.includes(p)) : points;
    if (rest.length) block.appendChild(pointList(rest));
    return block;
  }

  function tsButton(point) {
    const btn = el('button', {
      class: 'osum-ts',
      text: point.ts,
      title: `${OSUM.t('openTimeline')} ${point.ts}`,
      onclick: (e) => {
        e.stopPropagation();
        if (!util.seekTo(point.at)) util.toast(OSUM.t('cantSeek'), { variant: 'error' });
      },
    });
    return btn;
  }

  /**
   * A section heading that seeks: timecode and words are one button. Yandex's
   * summary works the same way — the title is the link, the number is its chip.
   */
  function sectionButton(section, summary = '') {
    const label = section.heading || '—';
    // A <div role="button"> rather than <button>: the block holds a heading and
    // a paragraph, and a button may not contain a <p>. Keyboard handling is
    // explicit so it still behaves like the button it announces itself as.
    const btn = el('div', {
      class: 'osum-section-title',
      role: 'button',
      tabindex: '0',
      title: section.ts ? `${OSUM.t('openTimeline')} ${section.ts}` : label,
      onclick: () => {
        if (section.at == null) return;
        if (!util.seekTo(section.at)) util.toast(OSUM.t('cantSeek'), { variant: 'error' });
      },
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        btn.click();
      },
    });
    if (section.at == null) btn.setAttribute('aria-disabled', 'true');
    if (section.ts) btn.appendChild(el('span', { class: 'osum-ts', text: section.ts }));
    const stack = el('span', { class: 'osum-stack' }, [el('span', { class: 'osum-h3', text: label })]);
    if (String(summary || '').trim()) stack.appendChild(el('span', { class: 'osum-sec-summary', text: String(summary).trim() }));
    btn.appendChild(stack);
    return btn;
  }

  function card(title, children, extraClass = '') {
    const node = el('div', { class: `osum-card ${extraClass}`.trim() });
    if (title) node.appendChild(el('h2', { class: 'osum-h', text: title }));
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) if (child) node.appendChild(child);
    return node;
  }

  /** A document wrapper so the reading view can drop the card styling. */
  function asDocument(content) {
    const wrap = el('div', { class: 'osum-doc' });
    wrap.appendChild(content);
    return wrap;
  }

  function bulletList(items) {
    // Plain dots instead of an icon per line: a list of chevrons is interface
    // decoration, and the text is the point.
    const list = el('ul', { class: 'osum-list osum-bullets' });
    for (const item of items) list.appendChild(el('li', {}, [el('span', { class: 'osum-text', text: item })]));
    return list;
  }

  /**
   * Provisional view of map notes that already passed JSON validation. The
   * final reduce replaces it; until then the user can read real points instead
   * of watching a spinner. Chunks are shown in transcript order, not arrival
   * order.
   */
  function buildPartialPreview() {
    const st = OSUM.state;
    const chunks = [...(st.partialChunks || [])].sort((a, b) => a.index - b.index);
    const ready = chunks.filter((chunk) => !chunk.failed);
    const total = Number(st.progress?.total) || Number(st.aiDiagnostics?.total) || chunks.length;
    const wrap = el('div', { class: 'osum-partials' });
    wrap.appendChild(
      el('h2', {
        class: 'osum-h',
        text: `${OSUM.t('partialTitle')} · ${ready.length}/${total}`,
      }),
    );
    for (const chunk of chunks) {
      const block = el('div', { class: 'osum-section' });
      block.appendChild(el('h3', { text: `${OSUM.t('partialChunk')} ${chunk.index + 1} · ${fmt.time(chunk.startAt)}` }));
      if (chunk.failed) {
        const reason = chunk.reason ? ` (${chunk.reason})` : '';
        block.appendChild(el('p', { class: 'osum-hint', text: `${OSUM.t('partialFailed')}${reason}` }));
      } else {
        const points = (chunk.partial?.points || []).filter((p) => String(p?.text || '').trim());
        if (points.length) block.appendChild(pointList(points.slice(0, 6)));
      }
      wrap.appendChild(block);
    }
    if (st.running && chunks.length < total) {
      wrap.appendChild(el('p', { class: 'osum-hint', text: OSUM.t('partialWaiting') }));
    }
    return card(null, wrap);
  }

  /**
   * Live draft of a single-pass answer. The pipeline emits only items whose
   * JSON value is closed and which passed the same normalisation as the final
   * result; raw stream fragments never reach the DOM.
   */
  function buildStreamPreview({ provisional = false } = {}) {
    const st = OSUM.state;
    const draft = st.streamDraft;
    if (!draft) return null;
    if (!draft.tldr && !draft.points?.length && !draft.sections?.length) return null;
    const wrap = el('div', { class: 'osum-live' });
    wrap.appendChild(el('h2', { class: 'osum-h', text: OSUM.t('streamTitle') }));
    wrap.appendChild(
      el('p', { class: 'osum-hint', text: provisional ? OSUM.t('streamProvisional') : OSUM.t('streamHint') }),
    );
    if (draft.tldr) {
      wrap.appendChild(card(OSUM.t('tldr'), el('p', { class: 'osum-tldr-text', text: draft.tldr }), 'osum-card-tldr'));
    }
    // Streamed items arrive in the order the model writes them; the draft must
    // still read along the video, like the finished summary will.
    if (draft.points?.length) wrap.appendChild(card(OSUM.t('keyPoints'), pointList(inVideoOrder(draft.points))));
    if (draft.sections?.length) {
      const sections = el('div', { class: 'osum-sections osum-sections-inline' });
      for (const section of inVideoOrder(draft.sections)) {
        sections.appendChild(
          sectionBlock({ ...section, points: inVideoOrder(section.points).slice(0, 3) }),
        );
      }
      wrap.appendChild(card(OSUM.t('tabSections'), sections));
    }
    return card(null, wrap);
  }

  /** Timed items by transcript order; untimed ones keep their order at the end. */
  function inVideoOrder(list) {
    return [...(list || [])].sort((a, b) => {
      const atA = a?.at ?? null;
      const atB = b?.at ?? null;
      if (atA != null && atB != null) return atA - atB;
      if (atA != null) return -1;
      if (atB != null) return 1;
      return 0;
    });
  }

  function buildOverview(result) {
    const frag = document.createDocumentFragment();
    if (result.tldr) frag.appendChild(card(OSUM.t('tldr'), el('p', { class: 'osum-tldr-text', text: result.tldr }), 'osum-card-tldr'));

    // Yandex-style: after the coherent lead, group by topic — a titled block
    // with its summary and its sharpest points — before the flat chronological
    // list. This is the default reading order.
    if (result.sections?.length) {
      const wrap = el('div', { class: 'osum-sections osum-sections-inline' });
      for (const section of result.sections) wrap.appendChild(sectionBlock(section));
      frag.appendChild(card(OSUM.t('tabSections'), wrap));
    }

    if (result.keyPoints?.length) frag.appendChild(card(OSUM.t('keyPoints'), pointList(result.keyPoints)));

    // Provider, stats, keywords, entities and diagnostics live in “Run details”
    // at the bottom of the panel: useful when checking how the summary was
    // made, noise when simply reading it.
    if (result.takeaways?.length) frag.appendChild(card(OSUM.t('takeaways'), bulletList(result.takeaways)));
    if (result.actionItems?.length) frag.appendChild(card(OSUM.t('actionItems'), bulletList(result.actionItems)));
    // A model ignores “questions: до 0” often enough that the block is gated on
    // the setting here as well: turning self-check off must remove it, not ask
    // the model nicely.
    if (result.questions?.length && OSUM.state.settings?.output?.selfCheck) {
      frag.appendChild(card(OSUM.t('selfQuestions'), bulletList(result.questions)));
    }

    if (result.quotes?.length) {
      const quotes = el('div', {});
      for (const quote of result.quotes) {
        const p = el('p', { class: 'osum-p' });
        if (quote.ts) p.appendChild(tsButton(quote));
        p.appendChild(document.createTextNode(` «${quote.text}»`));
        quotes.appendChild(p);
      }
      frag.appendChild(card(OSUM.t('quotes'), quotes));
    }

    // No “Recent” block here: the panel is about the video in front of the
    // user, and the history already has a home in the popup. An empty list at
    // the end of every summary was pure noise.
    return frag;
  }

  /**
   * Everything that explains the run rather than the video: provider, plan,
   * stats, token usage, keywords, entities, grounding doubts and diagnostics.
   * Folded into one <details> at the bottom of the panel.
   */
  function buildRunDetails() {
    const result = OSUM.state.result;
    if (!result) return el('div', { hidden: true });
    const details = el('details', { class: 'osum-runs' });
    details.appendChild(el('summary', { text: OSUM.t('runDetails') }));
    const wrap = el('div', { class: 'osum-runs-body' });

    const badges = el('div', { class: 'osum-chip-row' });
    badges.appendChild(el('span', { class: 'osum-chip osum-chip-strong', text: `${result.provider || 'AI'} · ${result.model || ''}` }));
    if (result.sentiment?.label) {
      const labelMap = { positive: OSUM.t('positive'), negative: OSUM.t('negative'), neutral: OSUM.t('neutral') };
      badges.appendChild(el('span', { class: 'osum-chip', text: `${OSUM.t('sentiment')}: ${labelMap[result.sentiment.label] || result.sentiment.label}` }));
    }
    if (result.meta?.strategy) {
      // Reduce/degraded suffixes mean the plan was map-reduce too; a strict
      // equality check used to label a partial run as “one request”.
      const strategy = String(result.meta.strategy);
      const plan = strategy.startsWith('timeline')
        ? OSUM.t('planTimeline')
        : strategy.startsWith('map-reduce')
          ? OSUM.t('planMap')
          : OSUM.t('planSingle');
      badges.appendChild(el('span', { class: 'osum-chip', text: plan }));
    }
    if (result.meta?.complete === false) badges.appendChild(el('span', { class: 'osum-chip osum-chip-strong', text: OSUM.t('incompleteBadge') }));
    if (result.meta?.cached) badges.appendChild(el('span', { class: 'osum-chip osum-chip-strong', text: OSUM.t('cachedBadge') }));
    wrap.appendChild(badges);

    const stats = result.stats || {};
    if (stats.words || stats.speechRateWpm) {
      const grid = el('div', { class: 'osum-stats' });
      const cells = [
        [stats.words ? String(stats.words) : null, OSUM.t('statWords')],
        [result.lengthSeconds ? fmt.time(result.lengthSeconds) : null, 'длительность'],
        [stats.speechRateWpm ? `${stats.speechRateWpm}` : null, OSUM.t('statSpeed')],
        [stats.readingTimeSec ? `${Math.max(1, Math.round(stats.readingTimeSec / 60))} мин` : null, OSUM.t('statRead')],
        [stats.compression ? fmt.percent(stats.compression) : null, OSUM.t('statCompression')],
        [stats.sentences ? String(stats.sentences) : null, OSUM.t('statSentences')],
        [stats.speakers ? String(stats.speakers) : null, OSUM.t('statSpeakers')],
        [stats.chunks ? String(stats.chunks) : null, 'фрагментов'],
      ];
      for (const [value, label] of cells) {
        if (!value) continue;
        grid.appendChild(el('div', { class: 'osum-stat' }, [el('b', { text: value }), el('span', { text: label })]));
      }
      wrap.appendChild(grid);
    }
    if (stats.aiTokensIn || stats.aiTokensOut) {
      wrap.appendChild(
        el('p', { class: 'osum-hint', text: `Использовано токенов: ${fmt.number(stats.aiTokensIn || 0)} → ${fmt.number(stats.aiTokensOut || 0)} · запросов: ${stats.aiCalls || 1}` }),
      );
    }

    // Claims whose numbers the transcript does not contain. Not hidden: this is
    // the whole point of keeping them folded rather than deleted.
    const grounding = result.meta?.grounding;
    if (grounding?.unsupported?.length) {
      const box = el('div', { class: 'osum-grounding' });
      box.appendChild(el('div', { class: 'osum-hint', text: OSUM.t('groundingTitle') }));
      for (const claim of grounding.unsupported.slice(0, 6)) {
        box.appendChild(el('p', { class: 'osum-hint', text: `• ${claim.text}` }));
      }
      wrap.appendChild(box);
    }

    const diagCard = buildDiagnosticsCard(result.meta?.diagnostics);
    if (diagCard) wrap.appendChild(diagCard);
    if (result.meta?.diagnostics) {
      const diag = el('button', { class: 'osum-btn', title: OSUM.t('diagnosticExport') });
      diag.append(icon('download', 13), el('span', { text: OSUM.t('diagnostic') }));
      diag.addEventListener('click', () => exporter.downloadDiagnostic(result));
      wrap.appendChild(diag);
    }

    if (result.keywords?.length) {
      const tags = el('div', { class: 'osum-tags' });
      const max = result.keywords[0]?.score || 1;
      for (const keyword of result.keywords.slice(0, 24)) {
        const size = 11 + Math.round((keyword.score / max) * 5);
        const tag = el('button', {
          class: 'osum-tag',
          style: { fontSize: `${size}px` },
          text: keyword.term,
          title: keyword.at != null ? `${OSUM.t('openTimeline')} ${fmt.time(keyword.at)}` : keyword.term,
          onclick: () => {
            if (keyword.at != null && !util.seekTo(keyword.at)) util.toast(OSUM.t('cantSeek'), { variant: 'error' });
          },
        });
        tags.appendChild(tag);
      }
      wrap.appendChild(card(OSUM.t('keywords'), tags));
    }

    if (result.entities?.length) {
      const row = el('div', { class: 'osum-chip-row osum-chips-scroll' });
      for (const entity of result.entities) row.appendChild(el('span', { class: 'osum-chip', text: `${entity.name} · ${entity.mentions}` }));
      wrap.appendChild(card(OSUM.t('entities'), row));
    }

    if (result.notes?.length) {
      wrap.appendChild(card(null, result.notes.map((note) => el('p', { class: 'osum-hint', text: `• ${note}` }))));
    }

    details.appendChild(wrap);
    return details;
  }

  /* ------------------------------------------------------------------ ask tab */

  function buildAskTab() {
    const st = OSUM.state;
    const frag = document.createDocumentFragment();
    const input = el('input', {
      class: 'osum-input',
      type: 'text',
      placeholder: OSUM.t('askPlaceholder'),
      'aria-label': OSUM.t('askPlaceholder'),
    });
    const ask = el('button', { class: 'osum-btn osum-btn-primary', style: { marginLeft: '0' } });
    ask.append(icon('search', 14), el('span', { text: OSUM.t('askButton') }));
    const submit = async () => {
      const question = input.value.trim();
      if (!question) return;
      input.value = '';
      await OSUM.panel.ask(question);
    };
    ask.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    frag.appendChild(el('div', { class: 'osum-qa-input' }, [input, ask]));

    const chips = el('div', { class: 'osum-chip-row', style: { marginBottom: '10px' } });
    const presets = ['О чём это видео?', 'Какие аргументы и цифры приводились?', 'Что делать по шагам?', 'Какие выводы и ограничения?'];
    for (const preset of presets) {
      chips.appendChild(
        el('button', {
          class: 'osum-btn',
          text: preset,
          onclick: () => OSUM.panel.ask(preset),
        }),
      );
    }
    frag.appendChild(chips);

    if (!st.qaHistory.length) {
      frag.appendChild(el('p', { class: 'osum-hint', text: OSUM.t('askEmpty') }));
      frag.appendChild(el('p', { class: 'osum-hint', text: OSUM.t('askHint') }));
      return frag;
    }
    for (const entry of st.qaHistory) {
      const block = el('div', { class: 'osum-msg' + (entry.role === 'user' ? ' osum-msg-user' : '') });
      const head = el('div', { class: 'osum-msg-head' });
      head.appendChild(el('span', { text: entry.role === 'user' ? 'Вы' : entry.mode === 'ai' ? `ИИ · ${entry.provider || ''}` : 'Локальный поиск' }));
      if (entry.confidence != null && entry.role !== 'user') head.appendChild(el('span', { text: `· ${OSUM.t('confidence')} ${Math.round(entry.confidence * 100)}%` }));
      block.appendChild(head);
      block.appendChild(el('p', { class: 'osum-p', text: entry.text }));
      if (entry.sources?.length) {
        const list = el('div', {});
        list.appendChild(el('div', { class: 'osum-hint', text: OSUM.t('sources') }));
        for (const source of entry.sources) {
          const row = el('div', { class: 'osum-source' });
          if (source.ts || source.at != null) row.appendChild(tsButton({ ts: source.ts || fmt.time(source.at), at: source.at }));
          row.appendChild(el('span', { class: 'osum-text', text: source.text }));
          list.appendChild(row);
        }
        block.appendChild(list);
      }
      frag.appendChild(block);
    }
    return frag;
  }

  /**
   * Inline transcript from a string, shared by page fallbacks and the manual
   * harness. It marks the source so the worker summarises it instead of
   * fetching captions again.
   */
  function inlineTranscript(parsed) {
    const st = OSUM.state;
    return {
      segments: parsed.segments,
      meta: {
        ...util.pageMeta(),
        lang: st.lang && st.lang !== 'auto' ? st.lang : OSUM.transcriptDom.detectLang(parsed.segments),
        source: parsed.hasTimestamps ? 'paste-timed' : 'paste-plain',
        autoGenerated: false,
        noTimestamps: !parsed.hasTimestamps,
        chapters: OSUM.transcriptDom.getChapters(),
        wordCount: parsed.segments.reduce((a, s) => a + s.text.split(/\s+/).length, 0),
      },
      tracks: [],
      format: 'paste',
    };
  }

  /* ------------------------------------------------------------------- footer */

  function buildFooter() {
    const st = OSUM.state;
    const foot = el('footer', { class: 'osum-foot' });
    // The transcript is not the summary: its copy button belongs to the bottom
    // strip with the other secondary actions, not next to the tabs.
    const copyTranscript = el('button', {
      class: 'osum-btn',
      title: OSUM.t('copyTranscript'),
      'aria-label': OSUM.t('copyTranscript'),
      onclick: () => OSUM.panel.copyTranscript(),
    });
    copyTranscript.appendChild(icon('transcript', 13));
    if (st.result) {
      // Only the two things a reader does with a finished summary. Provider,
      // model and version are in Run details; repeating them on every screen
      // was one of the reasons the panel felt crowded.
      const spacer = el('span', { class: 'osum-spacer' });
      foot.appendChild(spacer);
      foot.appendChild(copyTranscript);

      const copy = el('button', { class: 'osum-btn', title: OSUM.t('copyAll'), onclick: () => exporter.copyResult(st.result) });
      copy.append(icon('copy', 13));
      foot.appendChild(copy);

      const download = el('button', { class: 'osum-btn', title: OSUM.t('download') });
      download.append(icon('download', 13), el('span', { text: OSUM.t('download') }));
      download.addEventListener('click', () => {
        OSUM.panel.toggleExportMenu();
      });
      foot.appendChild(download);

      if (st.exportMenuOpen) {
        const menu = el('div', { class: 'osum-card', style: { width: '100%', marginTop: '6px' } });
        const withTranscript = el('label', { class: 'osum-hint', style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } });
        const checkbox = el('input', { type: 'checkbox' });
        checkbox.checked = !!st.includeTranscript;
        checkbox.addEventListener('change', () => {
          st.includeTranscript = checkbox.checked;
        });
        withTranscript.append(checkbox, el('span', { text: OSUM.t('exportWithTranscript') }));
        menu.appendChild(withTranscript);
        const row = el('div', { class: 'osum-chip-row' });
        for (const [format, label] of [
          ['md', OSUM.t('exportMd')],
          ['txt', OSUM.t('exportTxt')],
          ['json', OSUM.t('exportJson')],
        ]) {
          row.appendChild(
            el('button', {
              class: 'osum-btn',
              text: label,
              onclick: () => {
                st.exportMenuOpen = false;
                exporter.downloadResult(st.result, { format, includeTranscript: st.includeTranscript });
                render();
              },
            }),
          );
        }
        menu.appendChild(row);
        foot.appendChild(menu);
      }
    } else {
      foot.appendChild(el('span', { class: 'osum-badge', text: OSUM.t('keysHidden') }));
      foot.appendChild(el('span', { class: 'osum-spacer' }));
      foot.appendChild(copyTranscript);
      foot.appendChild(el('button', { class: 'osum-btn', text: OSUM.t('settings'), onclick: () => openOptionsPage() }));
    }
    return foot;
  }

  /* -------------------------------------------------------------- lifecycle */

  /**
   * Asks the worker whether an interrupted job can be continued with exactly
   * the current transcript, prompt, model and settings. The button is driven by
   * this answer only; the panel never guesses from a job id alone.
   */
  async function refreshResumable() {
    const st = OSUM.state;
    st.resumableJob = null;
    if (st.running || !st.videoId) return null;
    try {
      const res = await util.sendMessage({
        type: 'get-resumable',
        videoId: st.videoId,
        providerId: st.providerId,
        model: st.model,
      });
      st.resumableJob = res?.job || null;
    } catch {
      // An unreachable worker must not block the panel or invent a button.
      st.resumableJob = null;
    }
    return st.resumableJob;
  }

  async function refreshState({ keepResult = true } = {}) {
    const st = OSUM.state;
    st.videoId = util.getVideoId();
    const [settings, state] = await Promise.all([util.readSettings(), util.sendMessage({ type: 'get-state' })]);
    st.settings = settings;
    st.providers = state.providers || [];
    // One engine: the AI. Old settings may still carry mode: 'local'.
    st.length = settings.output?.length || 'standard';
    st.lang = settings.output?.language || 'auto';
    st.summaryMode = settings.ai?.summaryMode === 'timeline' ? 'timeline' : 'whole';
    st.providerId = state.activeProviderId || st.providers[0]?.id || '';
    const active = st.providers.find((p) => p.id === st.providerId);
    st.model = settings.ai?.model || active?.defaultModel || (active?.models || [])[0] || '';
    // The panel falls back to the first provider when settings carry none. That
    // choice used to stay in memory only, so diagnostics showed “active: —”
    // while a run was happily using OpenRouter. Persist it once.
    if (!settings.ai?.providerId && st.providerId) {
      const patch = { ai: { providerId: st.providerId, model: st.model } };
      util.sendMessage({ type: 'save-settings', patch }).catch(() => {});
      st.settings.ai = { ...(st.settings.ai || {}), ...patch.ai };
    }
    if (!keepResult) st.result = null;
    await refreshResumable();
    OSUM.i18n.refresh();
    return st;
  }

  function setState(patch) {
    Object.assign(OSUM.state, patch);
    render();
  }

  /**
   * A quick-settings choice: applied to the panel and saved. Language, length
   * and summary mode used to only change the in-memory state, so the row came
   * back to the old values on the next open and “the setting does not save”.
   */
  function setOutput(patch) {
    const st = OSUM.state;
    if (patch.lang != null) st.lang = patch.lang;
    if (patch.length != null) st.length = patch.length;
    if (patch.summaryMode != null) st.summaryMode = patch.summaryMode;
    persistMode().then(() => render());
  }

  function setTab(tab) {
    // A build from before this change may have saved “transcript” as the open
    // tab; it no longer exists, and an unknown tab would render an empty body.
    OSUM.state.tab = TABS.includes(tab) ? tab : 'overview';
    render();
  }

  function setProvider(providerId) {
    const st = OSUM.state;
    st.providerId = providerId;
    const provider = st.providers.find((p) => p.id === providerId);
    st.model = provider?.defaultModel || (provider?.models || [])[0] || '';
    persistMode();
    // A saved job is tied to its provider/model: re-check before offering it.
    refreshResumable().then(() => render());
  }

  function setModel(model) {
    OSUM.state.model = model;
    persistMode();
    refreshResumable().then(() => render());
  }

  async function persistMode() {
    const st = OSUM.state;
    try {
      await util.sendMessage({
        type: 'save-settings',
        patch: {
          output: { language: st.lang, length: st.length },
          ai: { providerId: st.providerId, model: st.model, summaryMode: st.summaryMode || 'whole' },
        },
      });
      if (st.settings) {
        st.settings.output = { ...(st.settings.output || {}), language: st.lang, length: st.length };
        st.settings.ai = {
          ...(st.settings.ai || {}),
          providerId: st.providerId,
          model: st.model,
          summaryMode: st.summaryMode || 'whole',
        };
      }
    } catch {
      /* non-fatal */
    }
  }

  function setResult(result, { cached = false, provider } = {}) {
    const st = OSUM.state;
    if (st.transcriptMeta?.noTimestamps) stripTimestamps(result);
    st.result = result;
    st.resultKey = `${st.providerId}:${st.model}:${st.lang}`;
    st.meta = { cached, provider };
    if (result.meta) result.meta.cached = cached;
    st.statusMessage = cached ? OSUM.t('statusCached') : OSUM.t('statusReady');
    st.streamDraft = null;
    st.progress = null;
    st.partialChunks = [];
    st.running = false;
    st.error = null;
    render();
    if (result.notes?.length) util.toast(result.notes[0], { variant: 'info', ms: 4200 });
  }

  function stripTimestamps(result) {
    for (const point of result.keyPoints || []) {
      point.at = null;
      point.ts = null;
    }
    for (const section of result.sections || []) {
      section.at = null;
      section.ts = null;
      for (const point of section.points || []) {
        point.at = null;
        point.ts = null;
      }
    }
    for (const quote of result.quotes || []) {
      quote.at = null;
      quote.ts = null;
    }
    for (const keyword of result.keywords || []) keyword.at = null;
    for (const bucket of result.timeline || []) bucket.at = bucket.at;
    result.timeline = [];
    result.notes = [...(result.notes || []), OSUM.t('noTimestamps')];
  }

  function setError(err) {
    const st = OSUM.state;
    st.error = {
      message: err?.message || String(err),
      code: err?.code,
      hint: err?.hint,
      provider: err?.provider,
      detail: err?.detail,
      status: err?.status,
      resumable: !!err?.resumable,
      finishReason: err?.finishReason || '',
      // Set when the on-page transcript fallback failed as well.
      pageError: err?.pageError,
    };
    st.aiDiagnostics = {
      ...(st.aiDiagnostics || {}),
      budgetMs: err?.budgetMs || st.aiDiagnostics?.budgetMs || 0,
      deadlineAt: err?.deadlineAt || st.aiDiagnostics?.deadlineAt || 0,
      remainingMs: err?.remainingMs != null ? err.remainingMs : 0,
      finishReason: err?.finishReason || (err?.detail === 'job-deadline' ? 'job-timeout' : 'provider-error'),
      complete: false,
      resumable: !!err?.resumable,
    };
    st.running = false;
    st.statusMessage = '';
    st.progress = null;
    // Keep the validated draft: buildError() shows it under the error.
    render();
  }

  function setStatus(message, extra = {}) {
    const st = OSUM.state;
    st.statusMessage = message;
    Object.assign(st, extra);
    render();
  }

  /* ---------------------------------------------------------------- running */

  async function run({ force = false, resume = false } = {}) {
    const st = OSUM.state;
    if (st.running) return;
    // Read before the running state hides the button: otherwise the explicit
    // continuation would reach runAi() without its job id.
    const resumeJobId = resume ? st.resumableJob?.id || '' : '';
    const seq = ++runSeq;
    activeRunSeq = seq;
    if (!st.videoId) {
      util.toast(OSUM.t('openVideoPage'), { variant: 'error' });
      return;
    }
    st.running = true;
    st.cancelRequested = false;
    st.error = null;
    st.streamDraft = null;
    st.progress = null;
    st.partialChunks = [];
    st.aiDiagnostics = null;
    // Hidden while running; the worker's answer re-enables it afterwards.
    st.resumableJob = null;
    // A run started from Q&A has nowhere to show its draft (and its result
    // would stay invisible after finishing).
    if (st.tab === 'ask') st.tab = 'overview';
    // The settings were consulted, not left on screen: fold them away together
    // with the paste box before the first draft appears.
    st.quickSettingsOpen = false;
    st.statusMessage = OSUM.t('statusTranscript');
    render();

    try {
      await runAi({ force, resume, resumeJobId, seq });
    } catch (err) {
      if (err?.code === 'CANCELLED') setStatus(OSUM.t('finishCancelled'));
      else if (st.cancelRequested) setStatus(OSUM.t('finishCancelled'));
      else setError(err);
    } finally {
      // A newer run may already own the panel: an old, stopped run must not
      // clear its “running” flag or its cancellation state.
      const owns = activeRunSeq === seq;
      if (owns || activeRunSeq === 0) {
        st.running = false;
        st.cancelRequested = false;
        runAbort = null;
        activeRunSeq = 0;
      }
      // The saved job may have become resumable (interrupted) or unusable
      // (finished, cancelled, mismatch): the button follows the worker.
      if (owns && st.videoId) await refreshResumable();
      render();
    }
  }

  /**
   * True for transcripts that already carry their segments (no worker fetch).
   *
   * The worker only knows how to fetch captions itself; everything the page
   * handed over must travel with the request. This used to be a whitelist of
   * three sources, and the two newest page routes (`page-capture` — the page's
   * own panel answer — and `page-panel`) were not on it. The panel then asked
   * the worker to fetch the captions again, the worker hit the PO-token wall,
   * and a run that already had a full transcript failed with “дорожка защищена
   * PO-token”. The rule is now the inverse: only the worker's own caption
   * sources are re-fetched.
   */
  function isInlineTranscript(meta) {
    const source = String(meta?.source || '');
    if (!source) return false;
    return !/^(captions|legacy|timedtext|innertube)/.test(source);
  }

  /**
   * Reads the transcript from the page: first the page's own InnerTube session
   * (the extension origin is refused there with 403), then the visible panel.
   * Throws when both are unavailable.
   */
  async function transcriptFromPage({ attempts = 2, apply = true, cancelled = () => false } = {}) {
    // One automatic retry. On the first attempt the page may still be building
    // the panel, or the injected bridge may not have finished loading; a second
    // click used to be the workaround users found themselves. Do it here.
    let dom = null;
    for (let attempt = 0; attempt < attempts && !dom?.segments?.length; attempt++) {
      // The worker may have answered while this route was still starting: do not
      // open a transcript panel nobody is waiting for any more.
      if (cancelled()) throw pageReadCancelled();
      if (attempt) await new Promise((r) => setTimeout(r, 1200));
      const startedAt = Date.now();
      dom = await OSUM.transcriptDom.getTranscriptFromPageApi?.({}).catch(() => null);
      if (cancelled()) throw pageReadCancelled();
      if (!dom?.segments?.length) dom = await OSUM.transcriptDom.getTranscript({}).catch(() => null);
      // Only a quick failure is worth repeating: it means the panel or the
      // bridge was not ready yet. A slow failure already had its chances, and
      // repeating it would just double the wait before the error card.
      if (!dom?.segments?.length && Date.now() - startedAt > 8000) break;
    }
    if (!dom?.segments?.length) {
      const err = new Error(OSUM.t('pageTranscriptFailed'));
      err.code = 'NO_PAGE_TRANSCRIPT';
      err.hint = OSUM.t('pageTranscriptFailedHint');
      // Numbers of what the scraper actually saw: they make a bug report
      // actionable instead of “it did not work again”.
      try {
        const info = OSUM.transcriptDom.diagnose?.();
        if (info) {
          err.detail = `panel: ${info.panel} · rows: ${info.rows}/${info.rowsUnfiltered} · timecode cells: ${info.timecodeCells} · duration: ${info.duration}s`;
        }
      } catch {
        /* diagnostics must never break the flow */
      }
      throw err;
    }
    dom.meta.videoTitle = dom.meta.videoTitle || util.pageMeta().videoTitle;
    if (apply) {
      OSUM.state.transcript = dom;
      OSUM.state.transcriptMeta = dom.meta;
    }
    return dom;
  }

  /** The worker's caption route: YouTube's timedtext / InnerTube, no page. */
  function transcriptFromWorker({ force = false } = {}) {
    const st = OSUM.state;
    return util.sendMessage({ type: 'get-transcript', videoId: st.videoId, lang: st.lang, force });
  }

  function rememberTranscript(payload) {
    const st = OSUM.state;
    st.transcript = payload;
    st.transcriptMeta = payload.meta;
    return payload;
  }

  // A page read opens, hides and closes a panel on somebody's real page. Two
  // reads at once (a run starting while a transcript load is still in flight)
  // closed each other's panel and both reported “not found”. Reads are queued
  // instead: the second one starts on a page the first has already put back.
  let pageReadQueue = Promise.resolve();
  function readPage(options = {}) {
    const run = pageReadQueue.then(() => transcriptFromPage(options));
    // The queue must survive a failed read, otherwise every later read rejects
    // with the first error instead of asking the page.
    pageReadQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Rejects with a coded error when `promise` takes longer than `ms`. */
  function withDeadline(promise, ms, code, message, hint) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          reject(Object.assign(new Error(message), { code, hint }));
        }, ms);
        timer?.unref?.();
      }),
    ]);
  }

  /** Reports a content-script decision to the worker's diagnostics ring. */
  function journalEvent(code, extra = {}, level = 'info') {
    try {
      util.sendMessage({ type: 'journal', event: { code, route: 'resolve', level, ...extra } }).catch?.(() => {});
    } catch {
      /* diagnostics must never break the flow */
    }
  }

  /** Marks a page read that lost the race to the worker; never shown to a user. */
  function pageReadCancelled() {
    const err = new Error('page transcript read cancelled');
    err.code = 'PAGE_READ_CANCELLED';
    return err;
  }

  async function ensureTranscriptLoaded({ force = false, preferPage = false } = {}) {
    const st = OSUM.state;
    if (st.transcript?.segments?.length && !force) return st.transcript;
    if (preferPage || String(st.transcript?.meta?.source || '').startsWith('dom') || String(st.transcript?.meta?.source || '').startsWith('page')) {
      if (st.transcript?.segments?.length) return st.transcript;
      return rememberTranscript(await readPage());
    }
    // Without a video id (a pasted transcript on a non-watch page) the worker
    // is the only route that knows what to fetch.
    if (!util.getVideoId?.()) return rememberTranscript(await transcriptFromWorker({ force }));

    // Both routes run at once, and the first one with segments wins.
    //
    // They fail for opposite reasons: the worker's timedtext answers with a
    // PO-token-protected track on many videos, while the page's own InnerTube
    // session reads those but needs the panel to mount. Asking one after the
    // other meant a blocked caption API cost the user a minute of waiting
    // before the page was even asked — and the error card named the first
    // failure (“PO-token”) even when the page route was the one that mattered.
    let workerAnswered = false;
    let abandoned = false;
    const pageTask = readPage({ attempts: 1, apply: false, cancelled: () => workerAnswered || abandoned }).then(
      (payload) => ({ route: 'page', payload }),
      (err) => ({ route: 'page', err }),
    );
    // A worker whose network is blackholed used to keep the panel waiting for
    // ever on a run that had already failed on the page. Its route is a bonus,
    // not a reason to hang: after the budget the page result decides.
    const workerTask = withDeadline(
      transcriptFromWorker({ force }),
      25000,
      'WORKER_TIMEOUT',
      OSUM.t('workerSilent'),
      OSUM.t('workerSilentHint'),
    ).then(
      (payload) => {
        // Only a real answer cancels the page read: a worker error is usually the
        // PO-token refusal, and the page is exactly the route that can still work.
        if (payload?.segments?.length) workerAnswered = true;
        return { route: 'worker', payload };
      },
      (err) => ({ route: 'worker', err }),
    );
    const outcomes = new Map();
    const winner = await new Promise((resolve) => {
      let left = 2;
      for (const task of [pageTask, workerTask]) {
        task.then((outcome) => {
          outcomes.set(outcome.route, outcome);
          if (outcome.payload?.segments?.length) resolve(outcome);
          else if (--left === 0) resolve(null);
        });
      }
    });
    if (winner) return rememberTranscript(winner.payload);
    abandoned = true;
    // Both routes failed. “PO-token” and “panel not found” used to be the only
    // record of a run that had a transcript in hand and then lost it, so the
    // outcome of each route is written down before the card is built.
    const describe = (outcome) =>
      outcome?.payload?.segments?.length
        ? `${outcome.payload.segments.length} из ${outcome.payload.meta?.source || '?'}`
        : outcome?.err?.code || '—';
    journalEvent('TRANSCRIPT_RACE', {
      page: describe(outcomes.get('page')),
      worker: describe(outcomes.get('worker')),
      held: OSUM.state.transcript?.segments?.length || 0,
    });

    // Neither route produced a transcript: the worker's error carries the code
    // the UI knows and its hint, the page's error carries the scraper counts.
    // They belong in one error card, not in two competing stories.
    const worker = outcomes.get('worker');
    const page = outcomes.get('page');
    // The worker route is a bonus with a small budget. When it only ran out of
    // that budget, it is not the reason the run stopped — the page route failed
    // for its own reason. Reporting the budget produced a dead-end “the
    // background worker did not answer, reload the tab” card, while the page
    // was saying “no transcript panel, press Show transcript”.
    const budgetCodes = new Set(['WORKER_TIMEOUT']);
    const pageSaysWhy = page?.err?.code && ['NO_PAGE_TRANSCRIPT', 'POT_REQUIRED', 'EMPTY_CAPTIONS', 'NO_CAPTIONS', 'PARSE_FAILED', 'EMPTY_TRANSCRIPT'].includes(page.err.code);
    const err =
      (budgetCodes.has(worker?.err?.code) && pageSaysWhy ? page.err : worker?.err) ||
      page?.err ||
      new Error(OSUM.t('pageTranscriptFailed'));
    err.detail = [err.detail, worker?.err?.detail, page?.err?.detail].filter(Boolean).join(' · ') || undefined;
    // The extra “on-page panel not found” line explains the page when the card
    // is about something else. As the headline it already says it.
    if (page?.err?.code === 'NO_PAGE_TRANSCRIPT' && err !== page.err) err.pageError = 'NO_PAGE_TRANSCRIPT';
    throw err;
  }

  async function runAi({ force, resume = false, resumeJobId: explicitResumeId = '', seq = 0 }) {
    const st = OSUM.state;
    // True once another run was started (or this one was stopped): every later
    // step of this call must be abandoned instead of touching the panel.
    const stale = () => seq !== activeRunSeq;
    if (!st.providers.length) {
      const err = new Error(OSUM.t('noProvider'));
      err.code = 'NO_PROVIDER';
      err.hint = OSUM.t('noProviderHint');
      throw err;
    }
    // Continue the exact saved job, never a freshly created summary of the same
    // video. A stale button (job finished in another tab) fails visibly instead
    // of silently starting a new paid run.
    const resumeJobId = resume ? explicitResumeId || st.resumableJob?.id || '' : '';
    if (resume && !resumeJobId) {
      const err = new Error(OSUM.t('resumeMissing'));
      err.code = 'RESUME_MISMATCH';
      err.hint = OSUM.t('resumeMissingHint');
      throw err;
    }
    // `force` means “do not trust the transcript fetched earlier from YouTube”.
    // It must not throw away a transcript the user pasted (or one scraped from
    // the page): that paste is the reason the run exists, and a video without
    // captions would fail here instead of being summarised.
    const inline = isInlineTranscript(st.transcript?.meta);
    try {
      await ensureTranscriptLoaded({ force: force && !inline });
    } catch (err) {
      // A refresh that fails after the page already handed us this very video's
      // text must not throw that text away. On a slow connection the retry can
      // outlive the first, successful read, and the panel then showed “no panel
      // found” while a 23-segment transcript sat in memory.
      if (err?.code === 'CANCELLED') throw err;
      const held = st.transcript;
      const sameVideo =
        held?.segments?.length > 0 && String(held.meta?.videoId || '') === String(st.videoId || '');
      if (!sameVideo) throw err;
      journalEvent(
        'TRANSCRIPT_REUSED',
        { source: held.meta?.source || '?', segments: held.segments.length, after: err?.code || 'ERROR' },
        'warn',
      );
    }
    if (stale() || st.cancelRequested) throw cancelledError();

    port = chrome.runtime.connect({ name: 'osum-task' });
    if (stale() || st.cancelRequested) {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
      throw cancelledError();
    }
    currentTaskId = `t_${Date.now().toString(36)}`;
    startKeepAlive();
    // The transcript is ours now; the wait is for the model. Leaving the “fetching
    // transcript” line on screen made a slow worker look like a stuck transcript.
    setStatus(OSUM.t('statusSending'));

    await new Promise((resolve, reject) => {
      let settled = false;
      // A worker that was torn down used to leave the panel “running” for ever,
      // with the Stop button lit and no error card: no result, no explanation.
      // Silence is a failure with an action, not a state to wait in.
      let idleTimer = null;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        stopKeepAlive();
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        fn(arg);
      };

      // Stop rejects the promise below at once; the worker's remaining events
      // must not repaint a run the user already ended. A late result used to
      // appear seconds after the button was pressed.
      runAbort = () => finish(reject, cancelledError());

      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          finish(
            reject,
            Object.assign(new Error(OSUM.t('workerSilent')), {
              code: 'WORKER_SILENT',
              hint: OSUM.t('workerSilentHint'),
            }),
          );
        }, 30000);
      };
      armIdle();

      port.onMessage.addListener((msg) => {
        if (!msg) return;
        // Any message proves the worker is alive — including the reply to a
        // keepalive ping, which carries no taskId. A reasoning model can think
        // for minutes without emitting a single progress event, so counting
        // only task messages as liveness killed healthy runs with
        // “Фоновый процесс не ответил” while the answer was still being written.
        armIdle();
        if (msg.taskId !== currentTaskId) return;
        if (stale() || st.cancelRequested) {
          if (msg.type === 'result' || msg.type === 'error' || msg.type === 'done') {
            finish(reject, cancelledError());
          }
          return;
        }
        switch (msg.type) {
          case 'stage':
            updateLiveDiagnostics(msg);
            setStatus(stageText(msg), { progress: msg.total ? { done: msg.done || 0, total: msg.total } : OSUM.state.progress });
            break;
          case 'progress':
            if (msg.stage === 'stream-item') {
              applyStreamItem(msg);
              break;
            }
            if (msg.stage === 'partial-item') {
              applyPartialItem(msg);
              break;
            }
            if (msg.stage === 'partial') {
              st.partialChunks = [
                ...(st.partialChunks || []).filter((chunk) => chunk.index !== msg.index),
                {
                  index: msg.index,
                  startAt: msg.startAt || 0,
                  endAt: msg.endAt || 0,
                  partial: msg.partial,
                  failed: !!msg.failed,
                  reason: msg.reason || '',
                },
              ].sort((a, b) => a.index - b.index);
              const ready = st.partialChunks.filter((chunk) => !chunk.failed).length;
              st.progress = { done: msg.done ?? ready, total: msg.total || 0 };
              st.statusMessage = `${OSUM.t('partialTitle')}: ${ready}/${msg.total || st.partialChunks.length}`;
              render();
              break;
            }
            updateLiveDiagnostics(msg);
            if (msg.stage === 'map') st.progress = { done: msg.done || 0, total: msg.total || 1 };
            setStatus(stageText(msg));
            break;
          case 'result':
            finish(resolve, msg);
            break;
          case 'error':
            if (msg.cancelled) {
              // The answer was stopped: the validated items stay on screen, but
              // must not look like a finished summary.
              if (st.streamDraft) st.streamDraft.provisional = true;
              st.aiDiagnostics = {
                ...(st.aiDiagnostics || {}),
                finishReason: 'cancelled',
                complete: false,
                remainingMs: msg.remainingMs || 0,
              };
              const err = new Error('Отменено');
              err.code = 'CANCELLED';
              finish(reject, err);
            } else {
              const err = new Error(msg.message || 'Ошибка');
              err.code = msg.code;
              err.hint = msg.hint;
              err.provider = msg.provider;
              err.detail = msg.detail;
              err.status = msg.status;
              err.resumable = !!msg.resumable;
              err.finishReason = msg.finishReason || '';
              err.budgetMs = msg.budgetMs || 0;
              err.deadlineAt = msg.deadlineAt || 0;
              err.remainingMs = msg.remainingMs != null ? msg.remainingMs : 0;
              finish(reject, err);
            }
            break;
          case 'done':
            if (!settled) finish(resolve, { empty: true });
            break;
          default:
            break;
        }
      });
      port.onDisconnect.addListener(() => {
        if (!settled) finish(reject, Object.assign(new Error('Соединение с фоновым процессом прервано'), { code: 'PORT_CLOSED' }));
      });

      port.postMessage({
        type: 'ai-summary',
        taskId: currentTaskId,
        ...(resumeJobId ? { resumeJobId } : {}),
        input: {
          videoId: st.videoId,
          lang: st.lang,
          segments: isInlineTranscript(st.transcript?.meta) ? st.transcript.segments : undefined,
          meta: st.transcript?.meta,
          force,
        },
        providerId: st.providerId,
        model: st.model,
      });
    }).then((res) => {
      if (res?.cancelled) return;
      if (!res?.result) return;
      st.aiDiagnostics = res.result.meta?.diagnostics || st.aiDiagnostics;
      // A model cut off by its output budget answers with valid JSON and empty
      // fields. Rendering that as “Готово” (stats, no TL;DR, no points) is what
      // made a finished run look like “ИИ не получилось”: show an error card
      // with a hint instead.
      if (!hasSummarySubstance(res.result)) {
        const err = new Error(OSUM.t('emptyAiResult'));
        err.code = 'EMPTY_RESULT';
        err.hint = OSUM.t('emptyAiResultHint');
        err.provider = res.provider || st.providerId || '';
        throw err;
      }
      setResult(res.result, { cached: !!res.cached, provider: res.provider });
    });
  }

  /**
   * One validated item from the single-pass stream. A new stream id means a
   * new attempt (for example a retry with a bigger output budget), so the old
   * draft is replaced instead of being mixed with a different answer.
   */
  // Streaming can deliver dozens of validated items in a few seconds. Each one
  // used to rebuild the whole panel; coalescing them into one render per frame
  // keeps the text smooth without changing what is shown.
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    const flush = () => {
      renderQueued = false;
      render();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else render();
  }

  function applyStreamItem(msg) {
    const st = OSUM.state;
    if (!st.streamDraft || st.streamDraft.id !== msg.streamId) {
      st.streamDraft = { id: msg.streamId, tldr: '', points: [], sections: [], firstItemMs: msg.firstItemMs || 0 };
    }
    const draft = st.streamDraft;
    const item = msg.item || {};
    // The same validated item can arrive twice: a retried request repeats its
    // opening fields, and some models repeat a point verbatim. Showing it twice
    // would look like the summary says it twice.
    const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    if (item.kind === 'tldr' && item.text && !draft.tldr) draft.tldr = item.text;
    else if (item.kind === 'keyPoint' && item.point) {
      if (draft.points.some((p) => sameText(p.text, item.point.text))) return;
      draft.points.push(item.point);
    } else if (item.kind === 'section' && item.section) {
      if (
        draft.sections.some(
          (s) => sameText(s.heading, item.section.heading) && sameText(s.summary, item.section.summary),
        )
      ) {
        return;
      }
      draft.sections.push(item.section);
    } else return;
    updateLiveDiagnostics(msg);
    const shown = draft.points.length + draft.sections.length + (draft.tldr ? 1 : 0);
    st.statusMessage = OSUM.t('streamStatus', { n: shown });
    scheduleRender();
  }

  /**
   * One point from a map-phase fragment, validated by the same schema as the
   * final result. It joins the fragment's preview entry, so the reader watches
   * the video's points appear in order instead of a spinner for minutes; the
   * finished note for that fragment replaces the entry and cannot duplicate it.
   */
  function applyPartialItem(msg) {
    const st = OSUM.state;
    if (st.cancelRequested) return;
    const point = msg.item?.kind === 'keyPoint' ? msg.item.point : null;
    if (!point || !String(point.text || '').trim()) return;
    const index = Number(msg.index) || 0;
    const entry = (st.partialChunks || []).find((chunk) => chunk.index === index);
    const points = entry?.partial?.points || [];
    const key = (p) => String(p?.text || '').trim().toLowerCase();
    if (points.some((p) => key(p) === key(point))) return;
    const next = {
      ...(entry || { index, startAt: msg.startAt || 0, endAt: msg.endAt || 0, failed: false, reason: '', partial: {} }),
      live: true,
      partial: { ...(entry?.partial || {}), points: [...points, point] },
    };
    st.partialChunks = [...(st.partialChunks || []).filter((chunk) => chunk.index !== index), next].sort(
      (a, b) => a.index - b.index,
    );
    const shown = st.partialChunks.reduce((n, chunk) => n + (chunk.partial?.points?.length || 0), 0);
    st.statusMessage = OSUM.t('livePointsStatus', { n: shown });
    updateLiveDiagnostics(msg);
    scheduleRender();
  }

  /** Keeps the live diagnostic line in sync with worker progress events. */
  function updateLiveDiagnostics(msg) {
    const st = OSUM.state;
    const prev = st.aiDiagnostics || {};
    st.aiDiagnostics = {
      ...prev,
      stage: msg.stage || prev.stage || '',
      lastMessage: msg.message || prev.lastMessage || '',
      budgetMs: msg.budgetMs || prev.budgetMs || 0,
      deadlineAt: msg.deadlineAt || prev.deadlineAt || 0,
      remainingMs: msg.remainingMs != null ? msg.remainingMs : prev.remainingMs,
      elapsedMs: msg.elapsedMs != null ? msg.elapsedMs : prev.elapsedMs,
      done: msg.done != null ? msg.done : prev.done,
      total: msg.total != null ? msg.total : prev.total,
      running: msg.running != null ? msg.running : prev.running,
      pending: msg.pending != null ? msg.pending : prev.pending,
      lastFallback: msg.stage === 'fallback' ? msg.message || prev.lastFallback : prev.lastFallback,
    };
  }

  /** True when a summary actually contains something to show. */
  function hasSummarySubstance(result) {
    const points = (result?.keyPoints || []).filter((p) => String(p?.text || '').trim()).length;
    const sections = (result?.sections || []).filter((s) => String(s?.summary || '').trim() || (s?.points || []).length).length;
    const tldrWords = String(result?.tldr || '').trim().split(/\s+/).filter(Boolean).length;
    return points >= 2 || sections >= 2 || tldrWords >= 8;
  }

  /** m:ss for the “still working” timer next to the stage. */
  /** “Осталось ~6:10 · 3/8 …” from the worker's deadline, not a stale number. */
  function budgetLabel(diag, counts = '') {
    const deadline = Number(diag?.deadlineAt) || 0;
    const budget = Number(diag?.budgetMs) || 0;
    const remaining = deadline
      ? Math.max(0, deadline - Date.now())
      : Math.max(0, Number(diag?.remainingMs) || 0);
    if (!budget && !deadline) return '';
    return `${OSUM.t('diagRemaining')} ~${elapsedLabel(remaining)}${counts}`;
  }

  function elapsedLabel(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const min = Math.floor(total / 60);
    return `${min}:${String(total % 60).padStart(2, '0')}`;
  }

  function withElapsed(text, msg) {
    return msg?.elapsedMs != null ? `${text} · ${elapsedLabel(msg.elapsedMs)}` : text;
  }

  function finishLabel(reason) {
    const map = {
      success: 'finishSuccess',
      cancelled: 'finishCancelled',
      'call-timeout': 'finishCallTimeout',
      'job-timeout': 'finishJobTimeout',
      'provider-error': 'finishProviderError',
      'output-limit': 'finishOutputLimit',
      quota: 'finishQuota',
      incomplete: 'finishIncomplete',
      'resume-mismatch': 'resumeReasonMismatch',
      'resume-busy': 'resumeBusy',
    };
    return map[reason] ? OSUM.t(map[reason]) : reason || '—';
  }

  /** Collapsed, local-only report of the last AI run. No extra requests. */
  function buildDiagnosticsCard(diag) {
    const d = diag;
    if (!d) return null;
    const details = el('details', { class: 'osum-diag' });
    details.appendChild(el('summary', { text: OSUM.t('diagTitle') }));
    const grid = el('div', { class: 'osum-diag-grid' });
    const row = (label, value) => {
      if (value == null || value === '' || value === '—') return;
      grid.appendChild(el('div', { class: 'osum-diag-row' }, [el('span', { text: label }), el('b', { text: String(value) })]));
    };
    const elapsed = d.totalMs != null ? d.totalMs : d.startedAt ? Date.now() - d.startedAt : null;
    row(OSUM.t('diagStrategy'), d.strategy);
    row(OSUM.t('diagStage'), d.lastMessage || d.stage);
    if (elapsed != null) row(OSUM.t('diagElapsed'), elapsedLabel(elapsed));
    if (d.firstPartialMs > 0) row(OSUM.t('diagFirstPartial'), elapsedLabel(d.firstPartialMs));
    if (d.streamFirstTextMs > 0) row(OSUM.t('diagStreamFirstText'), elapsedLabel(d.streamFirstTextMs));
    if (d.streamFirstItemMs > 0) {
      const items = Number(d.streamItems) || 0;
      row(
        OSUM.t('diagStreamFirstItem'),
        `${elapsedLabel(d.streamFirstItemMs)}${items ? ` · ${items} ${OSUM.t('diagStreamItems')}` : ''}`,
      );
    }
    if (d.concurrency) row(OSUM.t('diagConcurrency'), String(d.concurrency));
    if (d.initialOutputLimit || d.outputLimit) {
      const from = Number(d.initialOutputLimit) || 0;
      const to = Number(d.outputLimit) || from;
      row(OSUM.t('diagOutputLimit'), from && to && to !== from ? `${from} → ${to}` : String(to || from));
    }
    if (d.outputEscalations) row(OSUM.t('diagOutputEscalations'), String(d.outputEscalations));
    const initialBudget = Number(d.initialBudgetMs) || 0;
    const finalBudget = Number(d.budgetMs) || 0;
    if (initialBudget > 0) row(OSUM.t('diagInitialBudget'), elapsedLabel(initialBudget));
    if (finalBudget > 0 && (!initialBudget || finalBudget > initialBudget)) {
      row(OSUM.t('diagBudget'), elapsedLabel(finalBudget));
    }
    if (initialBudget > 0 || finalBudget > 0) {
      // A calculated ceiling must never read as an ETA.
      grid.appendChild(el('p', { class: 'osum-hint', text: OSUM.t('diagBudgetNote') }));
    }
    // No “remaining” row after a run: a finished, cancelled or failed task has
    // no countdown. Only the live status line shows it while running.
    const counts = d.chunkCounts;
    if (counts) {
      row(OSUM.t('diagChunks'), `${counts.done || 0} / ${(counts.done || 0) + (counts.failed || 0) + (counts.cancelled || 0)}`);
    }
    row(OSUM.t('diagRequests'), d.requests != null ? String(d.requests) : null);
    if (d.tokensIn || d.tokensOut) {
      row(OSUM.t('diagTokens'), `${d.tokensIn || 0} → ${d.tokensOut || 0}`);
    }
    if (d.rateLimited) {
      const paused = Number(d.mapPausedMs) > 0 ? ` · ${elapsedLabel(d.mapPausedMs)}` : '';
      row(OSUM.t('diagRateLimited'), `${d.rateLimited}${paused}`);
    }
    row(OSUM.t('diagRetries'), d.retries != null ? String(d.retries) : null);
    const switches = d.providerSwitches != null ? d.providerSwitches : (d.fallbacks || []).length;
    row(OSUM.t('diagFallbacks'), String(switches || 0));
    row(OSUM.t('diagLast'), d.lastFallback || '');
    row(OSUM.t('diagCompleteness'), d.complete === false ? OSUM.t('diagPartial') : OSUM.t('diagComplete'));
    row(OSUM.t('diagFinish'), finishLabel(d.finishReason));
    const stageMs = d.stageMs || {};
    const timeByStage = Object.entries(stageMs)
      .filter(([, ms]) => Number(ms) > 0)
      .map(([stage, ms]) => `${stage} ${elapsedLabel(ms)}`)
      .join(' · ');
    if (timeByStage) row(OSUM.t('diagStageMs'), timeByStage);
    if (d.resumable) {
      grid.appendChild(el('p', { class: 'osum-hint', text: OSUM.t('diagResumeHint') }));
    }
    details.appendChild(grid);
    return details;
  }

  function stageText(msg) {
    switch (msg.stage) {
      case 'prepare':
        return OSUM.t('statusPreparing');
      case 'single':
        return withElapsed(`${OSUM.t('statusSingle')}…`, msg);
      case 'map':
        return withElapsed(
          msg.total ? `${OSUM.t('statusMap')} ${msg.done || 0}/${msg.total}` : OSUM.t('statusMap'),
          msg,
        );
      case 'reduce':
      case 'reduce-batch':
        return withElapsed(OSUM.t('statusReduce'), msg);
      case 'transcript':
        return OSUM.t('statusTranscript');
      case 'cache':
        return OSUM.t('statusCached');
      case 'fallback':
        return `${OSUM.t('fallback')}: ${msg.message || ''}`;
      default:
        return msg.message || OSUM.t('statusSingle');
    }
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      try {
        port?.postMessage({ type: 'keepalive' });
      } catch {
        /* ignore */
      }
    }, 15000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  // Rejects the pending run from the outside, so Stop takes effect on the click
  // instead of after the worker's answer.
  let runAbort = null;
  // Run identity: an old run that was stopped mid-transcript must not adopt (or
  // overwrite) a new run started a second later.
  let runSeq = 0;
  let activeRunSeq = 0;
  function cancelledError() {
    const err = new Error(OSUM.t('finishCancelled'));
    err.code = 'CANCELLED';
    return err;
  }

  /**
   * Stop must always stop, and it must look stopped immediately. Waiting for
   * the worker's acknowledgement is what made the button feel dead: a slow
   * provider could keep the spinner (and the Stop button) alive for seconds
   * after the click, then paint its late result over the cancelled run.
   *
   * Locally the pending run is rejected at once. Remotely the port is
   * disconnected, which aborts the task inside the worker (`onDisconnect`
   * aborts its fetch); the explicit cancel message is still sent first, so a
   * worker that is between requests does not leave anything behind.
   */
  function cancel() {
    const st = OSUM.state;
    if (!st.running) return;
    st.cancelRequested = true;
    // Whatever was already validated stays readable, but never as a finished
    // summary.
    if (st.streamDraft) st.streamDraft.provisional = true;
    stopKeepAlive();
    if (port && currentTaskId) {
      try {
        port.postMessage({ type: 'cancel', taskId: currentTaskId });
      } catch {
        /* ignore */
      }
    }
    try {
      port?.disconnect?.();
    } catch {
      /* ignore */
    }
    port = null;
    currentTaskId = '';
    activeRunSeq = 0;
    const abort = runAbort;
    runAbort = null;
    st.running = false;
    st.progress = null;
    st.statusMessage = OSUM.t('finishCancelled');
    render();
    abort?.();
  }

  async function ask(question) {
    const st = OSUM.state;
    const entry = { role: 'user', text: question };
    st.qaHistory.push(entry);
    st.running = true;
    st.statusMessage = 'Спрашиваю модель…';
    if (st.tab !== 'ask') st.tab = 'ask';
    render();

    try {
      await ensureTranscriptLoaded({});
      if (st.cancelRequested) throw cancelledError();
      if (st.providers.length) {
        const answer = await askAi(question);
        st.qaHistory.push({
          role: 'assistant',
          mode: 'ai',
          text: answer.answer,
          sources: (answer.citations || []).map((c) => ({ text: c.text, at: c.at, ts: c.ts })),
          confidence: answer.confidence,
          provider: answer.provider,
        });
      } else {
        const res = await answerLocally(question);
        st.qaHistory.push({
          role: 'assistant',
          mode: 'local',
          text: res.answer,
          sources: res.sources || [],
          confidence: res.confidence,
        });
      }
    } catch (err) {
      // An AI answer that never came is answered by the local search instead of
      // an error bubble: the transcript is already here.
      const local = await answerLocally(question).catch(() => null);
      st.qaHistory.push({
        role: 'assistant',
        mode: 'local',
        text: local
          ? `${local.answer}\n\n${OSUM.t('askProviderMissing')}`
          : `${OSUM.t('errorTitle')}: ${err.message}${err.hint ? `\n${err.hint}` : ''}`,
        sources: local?.sources || [],
        confidence: local?.confidence,
      });
    } finally {
      st.running = false;
      st.statusMessage = '';
      render();
    }
  }

  /** Question → local BM25 search over the transcript (works offline). */
  function answerLocally(question) {
    const st = OSUM.state;
    const inline = st.transcript?.segments?.length && isInlineTranscript(st.transcript.meta);
    const payload = inline
      ? { videoId: st.videoId, segments: st.transcript.segments, meta: st.transcript.meta, question }
      : { videoId: st.videoId, lang: st.lang, question };
    return util.sendMessage({ type: 'local-ask', ...payload });
  }

  function askAi(question) {
    return new Promise((resolve, reject) => {
      const askPort = chrome.runtime.connect({ name: 'osum-task' });
      const taskId = `q_${Date.now().toString(36)}`;
      let settled = false;
      // The answer has the same liveness rules as a конспект: pings keep the
      // worker's event loop busy and every reply — task event or pong — proves
      // it is alive. Without this a torn-down worker left the question spinning
      // for ever, with no error bubble and no way back except a reload.
      let idleTimer = null;
      let pingTimer = null;
      const stopTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (pingTimer) clearInterval(pingTimer);
        idleTimer = null;
        pingTimer = null;
      };
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        stopTimers();
        try {
          askPort.disconnect();
        } catch {
          /* ignore */
        }
        fn(arg);
      };
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          done(
            reject,
            Object.assign(new Error(OSUM.t('workerSilent')), {
              code: 'WORKER_SILENT',
              hint: OSUM.t('workerSilentHint'),
            }),
          );
        }, 30000);
      };
      askPort.onMessage.addListener((msg) => {
        if (!msg) return;
        armIdle();
        if (msg.taskId !== taskId) return;
        if (msg.type === 'result') done(resolve, msg);
        else if (msg.type === 'error') done(reject, Object.assign(new Error(msg.message), { code: msg.code, hint: msg.hint }));
        else if (msg.type === 'done') done(reject, new Error('Пустой ответ'));
        else if (msg.type === 'stage' || msg.type === 'progress') {
          if (msg.message) {
            OSUM.state.statusMessage = msg.message;
            rerenderStatus();
          }
        }
      });
      askPort.onDisconnect.addListener(() => done(reject, new Error('Соединение прервано')));
      armIdle();
      pingTimer = setInterval(() => {
        try {
          askPort.postMessage({ type: 'keepalive' });
        } catch {
          /* ignore */
        }
      }, 15000);
      askPort.postMessage({
        type: 'ai-ask',
        taskId,
        question,
        input: { videoId: OSUM.state.videoId, lang: OSUM.state.lang },
        providerId: OSUM.state.providerId,
        model: OSUM.state.model,
      });
    });
  }

  async function loadTranscript({ force = false, silent = false, preferPage = false } = {}) {
    const st = OSUM.state;
    try {
      if (!silent) setStatus(OSUM.t('statusTranscript'), { running: true });
      await ensureTranscriptLoaded({ force, preferPage });
      if (!silent) util.toast(`${OSUM.t('transcriptReady')}: ${st.transcript.segments.length} ${OSUM.t('segments')}`);
    } catch (err) {
      if (!silent) setError(err);
    } finally {
      st.running = false;
      render();
    }
  }

  /* ------------------------------------------------------------ transcript sync */

  /* ------------------------------------------------------------------- utils */

  let bodyRerenderTimer = null;
  function scheduleBodyRerender() {
    clearTimeout(bodyRerenderTimer);
    bodyRerenderTimer = setTimeout(rerenderBody, 140);
  }

  function rerenderBody() {
    if (!refs.body) return;
    const scroll = captureScroll(refs.body);
    refs.body.textContent = '';
    refs.body.appendChild(buildBody());
    restoreScroll(refs.body, scroll);
  }

  function rerenderStatus() {
    if (!refs.panel) return;
    const oldStatus = refs.panel.querySelector('.osum-status');
    if (!oldStatus) return;
    oldStatus.replaceWith(buildStatus());
  }

  /** Puts the host back on <body> so the FAB floats over the page again. */
  function attachToViewport() {
    if (!host) return;
    if (host.parentElement !== document.body) document.body.appendChild(host);
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;';
    if (refs.root) refs.root.dataset.docked = 'false';
    applyTheme();
  }

  /**
   * Places the panel either inline in the YouTube sidebar (docked) or as an
   * overlay. In docked mode the stylesheet switches the panel to static flow:
   * `position: fixed` inside the sidebar/`contain` host would collapse it.
   */
  function ensureAttached() {
    if (!host) return;
    const settings = OSUM.state.settings || {};
    const docked = settings.ui?.docked !== false;
    const container = docked ? document.querySelector('#secondary-inner') || document.querySelector('#secondary') : null;
    if (container) {
      if (host.parentElement !== container) container.prepend(host);
      host.style.cssText = 'all: initial; display: block; margin-bottom: 12px;';
      if (refs.root) refs.root.dataset.docked = 'true';
      applyTheme();
    } else {
      attachToViewport();
    }
  }

  /* ------------------------------------------------------------------ public */

  OSUM.panel = {
    mount,
    render,
    rerenderBody,
    attach: ensureAttached,
    async open({ autoRun = false } = {}) {
      mount();
      try {
        await refreshState();
      } catch (err) {
        // A cold background (Firefox event page, extension reload) must not keep
        // the panel from opening: show it with whatever state we already have.
        util.toast(`${OSUM.t('errorTitle')}: ${err?.message || err}`, { variant: 'error', ms: 4000 });
      }
      ensureAttached();
      OSUM.state.panelOpen = true;
      refs.panel.hidden = false;
      refs.fab.hidden = true;
      render();
      if (autoRun) run({ force: false });
    },
    close() {
      OSUM.state.panelOpen = false;
      if (refs.panel) refs.panel.hidden = true;
      attachToViewport();
      if (refs.fab && OSUM.state.settings?.ui?.showFab !== false) refs.fab.hidden = false;
    },
    toggle() {
      if (OSUM.state.panelOpen) {
        this.close();
        return;
      }
      this.open({}).catch((err) => {
        util.toast(`${OSUM.t('errorTitle')}: ${err?.message || err}`, { variant: 'error', ms: 4000 });
      });
    },
    setTab,
    setProvider,
    setModel,
    /** Fetches the live model list from the provider and merges it in. */
    async loadModels(provider) {
      if (!provider?.id) return;
      const st = OSUM.state;
      st.running = true;
      setStatus(OSUM.t('statusLoadModels'));
      try {
        const res = await util.sendMessage({ type: 'list-models', providerId: provider.id });
        const models = (res?.models || []).filter(Boolean);
        if (!models.length) throw new Error(OSUM.t('modelsEmpty'));
        provider.models = Array.from(new Set([...(provider.models || []), ...models]));
        if (!st.model || !provider.models.includes(st.model)) st.model = provider.defaultModel || models[0];
        persistMode();
        util.toast(`${OSUM.t('modelsLoaded')}: ${models.length}`);
      } catch (err) {
        util.toast(`${OSUM.t('modelsFailed')}: ${err?.message || err}`, { variant: 'error', ms: 4200 });
      } finally {
        st.running = false;
        setStatus('');
        if (OSUM.state.panelOpen) render();
      }
    },
    setState,
    setOutput,
    setResult,
    setError,
    run,
    cancel,
    ask,
    loadTranscript,
    /**
     * Error-card action: take the transcript from the page and summarize it.
     * Works when YouTube blocks the caption API with a PO token.
     */
    async useTranscriptFromPage() {
      const st = OSUM.state;
      st.error = null;
      st.running = true;
      st.statusMessage = OSUM.t('statusTranscript');
      st.transcript = null;
      st.transcriptMeta = null;
      render();
      try {
        const dom = await readPage();
        util.toast(`${OSUM.t('transcriptReady')}: ${dom.segments.length} ${OSUM.t('segments')}`);
        st.running = false;
        render();
        await run({ force: true });
      } catch (err) {
        // Without this the panel stays “running” and every later Retry is a
        // silent no-op, which reads as “the button is dead”.
        setError(err);
      } finally {
        st.running = false;
        render();
      }
    },
    /**
     * Manual harness / caller with a ready transcript (no UI in the panel).
     * Returns the number of segments or 0 when the text is not a transcript.
     */
    async loadTranscriptText(text) {
      const parsed = OSUM.transcriptDom.parsePasted(text);
      if (!parsed?.segments?.length) return 0;
      const st = OSUM.state;
      st.transcript = inlineTranscript(parsed);
      st.transcriptMeta = st.transcript.meta;
      st.error = null;
      if (st.panelOpen) render();
      await run({ force: true });
      return parsed.segments.length;
    },
    toggleQuickSettings(value) {
      const st = OSUM.state;
      st.quickSettingsOpen = value === undefined ? !st.quickSettingsOpen : !!value;
      render();
    },
    /** Header button: the transcript behind the summary, as plain text. */
    async copyTranscript() {
      const st = OSUM.state;
      if (!st.transcript?.segments?.length) {
        try {
          await loadTranscript({ silent: true });
        } catch {
          /* the toast below explains the failure */
        }
      }
      if (!st.transcript?.segments?.length) {
        util.toast(OSUM.t('transcriptEmpty'), { variant: 'error' });
        return;
      }
      await exporter.copyTranscript(st.transcript);
    },

    /** Sun/moon in the header: one click, remembered. */
    toggleTheme() {
      const st = OSUM.state;
      const next = refs.root?.dataset.theme === 'dark' ? 'light' : 'dark';
      st.settings = { ...(st.settings || {}), ui: { ...(st.settings?.ui || {}), theme: next } };
      util.sendMessage({ type: 'save-settings', patch: { ui: { theme: next } } }).catch(() => {});
      applyTheme();
      render();
    },

    toggleExportMenu() {
      OSUM.state.exportMenuOpen = !OSUM.state.exportMenuOpen;
      render();
    },
    setVideoId(videoId) {
      if (OSUM.state.videoId === videoId) return;
      OSUM.state.videoId = videoId;
      OSUM.state.result = null;
      OSUM.state.transcript = null;
      OSUM.state.transcriptMeta = null;
      OSUM.state.error = null;
      OSUM.state.qaHistory = [];
      OSUM.state.statusMessage = '';
      refreshState({ keepResult: false }).then(() => {
        if (OSUM.state.settings?.ui?.autoSummarize) run({ force: false });
        if (OSUM.state.panelOpen) render();
      });
    },
    isOpen: () => !!OSUM.state.panelOpen,
    refs: () => refs,
    tickBudget,
  };

  /**
   * One second is the resolution the user needs to see the estimate move; the
   * tick only touches the text node of the budget line, never a full render.
   * Exposed through the panel API so tests can advance the clock by hand.
   */
  function tickBudget() {
    const st = OSUM.state;
    const line = refs.budgetLine;
    if (!st.running || !st.panelOpen || !line) return;
    // A node left over from the previous render is not the line on screen.
    if (!refs.panel || !refs.panel.contains(line)) return;
    line.textContent = budgetLabel(st.aiDiagnostics, line.dataset.counts || '');
  }
  setInterval(tickBudget, 1000);
})();
