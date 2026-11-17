/**
 * Fallback transcript sources that live in the page:
 *  - the native transcript panel (scraped, used when the caption API fails),
 *  - chapters rendered by the player,
 *  - text pasted by the user.
 *
 * YouTube renames and re-types the panel regularly (“Transcript” →
 * «Расшифровка видео», `ytd-transcript-segment-renderer` → timecode chips inside
 * an anonymous list), so nothing here may depend on a single component name:
 *  1. rows are found from the timecode elements themselves (any markup),
 *  2. the virtualised list is scrolled through to collect every row,
 *  3. if that fails, the panel's plain text is parsed line by line.
 */

(function () {
  const OSUM = window.OSUM;
  const { util } = OSUM;

  function q(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function qa(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  const SHOW_TRANSCRIPT_SELECTORS = [
    'ytd-video-description-transcript-section-renderer button',
    'ytd-video-description-transcript-section-renderer yt-button-shape button',
    'button[aria-label*="transcript" i]',
    'button[aria-label*="Транскрипт"]',
    'yt-button-shape button[aria-label*="transcript" i]',
    '[target-id*="transcript"] [role="tab"]',
  ];

  /**
   * YouTube labels this button differently in every UI language (“Show
   * transcript”, «Показать текст видео», «Расшифровка видео», «文字起こしを表示»…),
   * so we match stems, not full labels.
   */
  const TRANSCRIPT_KEYWORDS = [
    'transcri',
    'transkript',
    'transcriptie',
    'транскрип',
    'расшифровк',
    'текст видео',
    'текст відео',
    'субтитри',
    '字幕',
    '文字起こし',
    '스크립트',
    '자막',
  ];

  /** Panel headers and buttons that are not part of the transcript text. */
  const CHROME_LINES = new Set([
    'в этом видео',
    'эпизоды',
    'расшифровка видео',
    'транскрипт',
    'показать текст видео',
    'показать транскрипт',
    'поиск в расшифровке',
    'показать больше',
    'показать меньше',
    'субтитры',
    'автоматические субтитры',
    'in this video',
    'chapters',
    'transcript',
    'show transcript',
    'search transcript',
    'show more',
    'show less',
    'captions',
    'auto-generated',
  ]);

  const SEGMENT_SELECTORS = [
    'ytd-transcript-segment-renderer',
    'yt-transcript-segment-renderer',
    'transcript-segment-view-model',
  ];

  /** A bare timecode line: “0:12”, “12:34”, “1:02:03”. */
  const TIMECODE = /^\d{1,3}(?::\d{2}){1,2}$/;

  function labelOf(node) {
    return `${node?.getAttribute?.('aria-label') || ''} ${node?.getAttribute?.('title') || ''} ${node?.textContent || ''}`.toLowerCase();
  }

  function matchesTranscriptLabel(node) {
    const label = labelOf(node);
    return TRANSCRIPT_KEYWORDS.some((keyword) => label.includes(keyword));
  }

  function isChromeLine(line) {
    return CHROME_LINES.has(line.toLowerCase().replace(/[«»"“”']/g, '').trim());
  }

  function parseClock(value) {
    const m = String(value || '').trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
  }

  /** Seconds for a string that is *only* a timecode. */
  function strictClock(value) {
    const text = String(value || '').trim();
    if (!TIMECODE.test(text)) return null;
    return parseClock(text);
  }

  /**
   * A timecode cell may carry punctuation around it (“48:17 •”, “— 48:17”).
   * Letters are rejected so that chapter titles (“0:00 Вступление”) never look
   * like a timecode cell.
   */
  function decoratedClock(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 16) return null;
    // Decorations must not contain letters or digits, otherwise “48:17” would
    // be split into the decoration “4” and the timecode “8:17”.
    const m = text.match(/^[^\p{L}\d]{0,8}(\d{1,3}(?::\d{2}){1,2})[^\p{L}\d]{0,8}$/u);
    return m ? parseClock(m[1]) : null;
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  /**
   * The panel also renders a visually hidden spoken form of each timecode
   * (“5 минут 19 секунд”, “2 minutes 57 seconds”). innerText includes it, so
   * every row began with a fake sentence and the summary was built from
   * “минут секунд”. The prefix counts as a timestamp only when real speech
   * follows (“5 минут назад…” stays), which is what the lookahead checks.
   */
  const SPOKEN_TIME = [
    /^\d{1,3}\s*(?:час(?:а|ов)?|ч\.?)\s*(?:\d{1,2}\s*(?:минут(?:а|ы|у)?|мин\.?)\s*)?(?:\d{1,2}\s*(?:секунд(?:а|ы|у)?|сек\.?)\s*)?/u,
    /^\d{1,2}\s*(?:минут(?:а|ы|у)?|мин\.?)\s*(?:\d{1,2}\s*(?:секунд(?:а|ы|у)?|сек\.?))?\s*/u,
    /^\d{1,2}\s*(?:секунд(?:а|ы|у)?|сек\.?)\s*/u,
    /^\d{1,3}\s*(?:hours?|hrs?|h)\.?\s*(?:\d{1,2}\s*(?:minutes?|mins?|m)\.?\s*)?(?:\d{1,2}\s*(?:seconds?|secs?|s)\.?\s*)?/i,
    /^\d{1,2}\s*(?:minutes?|mins?)\s*(?:\d{1,2}\s*(?:seconds?|secs?))?\s*/i,
    /^\d{1,2}\s*(?:seconds?|secs?)\s*/i,
  ];
  const SPEECH_AFTER_TIME = /^[«"'“(\p{Lu}\p{N}]/u;

  function stripSpokenTime(text) {
    let t = String(text || '').trim();
    for (let guard = 0; guard < 2; guard++) {
      const before = t;
      t = t.replace(/^[\s•·—–\-|:.,]+/, '');
      for (const re of SPOKEN_TIME) {
        const m = t.match(re);
        if (!m || !m[0].trim()) continue;
        const rest = t.slice(m[0].length).replace(/^[\s•·—–\-|:.,]+/, '');
        if (!rest || !SPEECH_AFTER_TIME.test(rest)) continue;
        t = rest;
        break;
      }
      if (t === before) break;
    }
    return t;
  }

  /**
   * Drops the timestamp column from a row: the timecode itself plus the
   * punctuation a cell may wrap around it (“48:17 •” → “48:17”).
   */
  function stripTimecodes(text) {
    const withoutClock = stripSpokenTime(String(text || '')).replace(/^\s*\d{1,3}(?::\d{2}){1,2}\s*/, '');
    return stripSpokenTime(withoutClock)
      .replace(/^[\s•·—–\-|:.,]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** innerText is '' for hidden nodes but textContent still has the text. */
  /**
   * Timecodes that are not transcript rows: duration badges of related videos,
   * player controls, comments, chapter markers. They look exactly like a row's
   * timestamp cell (“1:14:51”), so the whole subtree has to be skipped —
   * otherwise the sidebar alone “proves” that a transcript is on screen and the
   * summary is built from recommended videos.
   */
  const FOREIGN_ANCESTORS = [
    'thumbnail',
    'lockup',
    'rich-item',
    'compact-video',
    'video-renderer',
    'playlist',
    'movie_player',
    'video-wall',
    'comment',
  ];

  /**
   * Careful: the transcript panel itself is often docked in `#secondary-inner`
   * (the same column as the recommendations), so column containers must not be
   * excluded — only the cards inside them. Duration badges always sit in a
   * thumbnail, which is what the filter keys on.
   */
  function isForeignRow(node) {
    let el = node;
    for (let depth = 0; depth < 9 && el; depth++, el = el.parentElement) {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag && FOREIGN_ANCESTORS.some((hint) => tag.includes(hint))) return true;
      const id = `${el.getAttribute?.('id') || ''} ${el.getAttribute?.('target-id') || ''}`.toLowerCase();
      if (id.includes('thumbnail')) return true;
    }
    return false;
  }

  function textOf(node) {
    if (!node) return '';
    const inner = typeof node.innerText === 'string' ? node.innerText : '';
    if (inner && inner.trim()) return inner;
    return node.textContent || '';
  }

  /** How many “0:12”-looking tokens a block of text contains. */
  function countTimecodes(text) {
    return (String(text || '').match(/\b\d{1,3}(?::\d{2}){1,2}\b/g) || []).length;
  }

  /* ------------------------------------------------------------- row scraping */

  /** Elements whose whole text is one timecode (the panel's timecode column). */
  function timestampLeaves(root, { allowForeign = false } = {}) {
    const out = [];
    const scope = root || document.body || document;
    if (!scope?.querySelectorAll) return out;
    for (const node of qa('*', scope)) {
      if ((node.childElementCount || 0) > 1) continue;
      const raw = node.textContent || '';
      if (!raw || raw.length > 16) continue;
      const at = decoratedClock(raw);
      if (at == null) continue;
      if (!allowForeign && isForeignRow(node)) continue;
      out.push({ node, at });
    }
    return out;
  }

  /** True when the node belongs to the chapters list, not to the transcript. */
  function isChapterContainer(node) {
    let el = node;
    for (let depth = 0; depth < 6 && el; depth++, el = el.parentElement) {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag.includes('macro-markers') || tag.includes('chapter')) return true;
      const id = `${el.getAttribute?.('id') || ''} ${el.getAttribute?.('target-id') || ''}`.toLowerCase();
      if (id.includes('chapter') || id.includes('macro-markers')) return true;
    }
    return false;
  }

  /** True when an ancestor advertises itself as the transcript panel. */
  function hasTranscriptMarker(node) {
    let el = node;
    for (let depth = 0; depth < 8 && el; depth++, el = el.parentElement) {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag.includes('transcript')) return true;
      const id = `${el.getAttribute?.('id') || ''} ${el.getAttribute?.('target-id') || ''}`.toLowerCase();
      if (id.includes('transcript')) return true;
    }
    return false;
  }

  /** How many ancestors above a timecode cell are tracked when counting. */
  const COUNT_DEPTH = 14;
  /** A row is a sentence, not a block: anything longer is a wrapper of rows. */
  const MAX_ROW_TEXT = 600;

  /**
   * Reads every rendered row.
   *
   * Rows are derived from their timecode cell, not from a fixed “list → row”
   * layout: YouTube nests rows in per-row components and in virtualised blocks,
   * and the nesting depth differs between releases. Grouping by the nearest
   * list ancestor used to return a single block of eight rows for a 172-cell
   * panel, so the transcript looked 20× shorter than the video. A row is now the
   * largest ancestor that still holds exactly this one timecode — whatever the
   * wrappers above it look like.
   */
  /**
   * The panel's current row component. YouTube's transcript list is rendered as
   * `yt-section-list-renderer` → `yt-item-section-renderer`, one item per line,
   * each holding its own timecode. Reading those components directly is exact;
   * the timecode heuristics below are only the fallback for other layouts.
   */
  function rowsFromItems(root, { allowForeign = false } = {}) {
    const scope = root || document.body || document;
    if (!scope?.querySelectorAll) return { rows: [], container: null };
    const items = qa('yt-item-section-renderer, yt-section-list-renderer yt-item-section-renderer', scope);
    if (items.length < 3) return { rows: [], container: null };
    const rows = [];
    const seen = new Set();
    let container = null;
    for (const item of items) {
      if (!allowForeign && isForeignRow(item)) continue;
      if (isChapterContainer(item) && !hasTranscriptMarker(item)) continue;
      const text = String(textOf(item) || '').replace(/\s+/g, ' ').trim();
      const match = text.match(/\b(\d{1,3}(?::\d{2}){1,2})\b/);
      if (!match || match.index === undefined) continue;
      const at = parseClock(match[1]);
      if (at == null) continue;
      let body = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`.trim();
      body = stripTimecodes(body).trim();
      if (body.length < 2 || body.length > MAX_ROW_TEXT) continue;
      const key = `${at}\u0000${body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ at, text: body });
      if (!container) {
        let el = item;
        for (let depth = 0; depth < 12 && el; depth++, el = el.parentElement) {
          const tag = String(el.tagName || '').toLowerCase();
          if (tag.includes('section-list') || tag.includes('transcript')) {
            container = el;
            break;
          }
        }
        container = container || item.parentElement;
      }
    }
    if (rows.length < 3) return { rows: [], container: null };
    rows.sort((a, b) => a.at - b.at);
    return { rows, container };
  }

  function rowsFromDom(root, { allowForeign = false } = {}) {
    const byItems = rowsFromItems(root, { allowForeign });
    if (byItems.rows.length >= 3) return byItems;
    const leaves = timestampLeaves(root, { allowForeign });
    if (leaves.length < 3) return { rows: [], container: null };

    const usable = leaves.filter(
      (leaf) => !isChapterContainer(leaf.node) || hasTranscriptMarker(leaf.node),
    );
    if (usable.length < 3) return { rows: [], container: null };

    // How many timecode cells sit inside each ancestor. Reading innerText of
    // every ancestor would force layout on YouTube's huge DOM, so the rows and
    // the list are derived from these counts instead.
    const counts = new Map();
    for (const leaf of usable) {
      let el = leaf.node;
      for (let depth = 0; depth < COUNT_DEPTH && el; depth++, el = el.parentElement) {
        counts.set(el, (counts.get(el) || 0) + 1);
      }
    }

    const rows = [];
    const seen = new Set();
    const anchors = [];
    for (const leaf of usable) {
      let row = leaf.node;
      let picked = null;
      for (let depth = 0; depth < COUNT_DEPTH && row.parentElement; depth++) {
        const parent = row.parentElement;
        // A wrapper of several rows would swallow their text; stop there.
        if ((counts.get(parent) || 0) !== 1) break;
        if (countTimecodes(textOf(parent)) > 1) break;
        row = parent;
        const candidate = stripTimecodes(textOf(row));
        if (candidate.length >= 2 && candidate.length <= MAX_ROW_TEXT) picked = { row, text: candidate };
      }
      let text = picked ? picked.text : stripTimecodes(textOf(row));
      // Some layouts render the timecode after the text; drop it when it is
      // this row's own timestamp (a spoken “48:17” would not equal it).
      const tail = text.match(/\s(\d{1,3}(?::\d{2}){1,2})$/);
      if (tail && parseClock(tail[1]) === leaf.at) text = text.slice(0, text.length - tail[0].length);
      text = text.trim();
      if (text.length < 2 || text.length > MAX_ROW_TEXT) continue;
      const key = `${leaf.at}\u0000${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ at: leaf.at, text });
      anchors.push(leaf.node);
    }
    if (rows.length < 3) return { rows: [], container: null };

    // The list is the nearest ancestor that holds every accepted row, so
    // scrolling it reaches the whole (virtualised) transcript. When the rows do
    // not share one (two panels, a stray timecode elsewhere), keep the widest
    // list around the first row instead of walking up into <body>.
    const target = anchors.length;
    let container = null;
    let fallback = null;
    let el = anchors[0];
    for (let depth = 0; depth < COUNT_DEPTH + 4 && el; depth++, el = el.parentElement) {
      if (el === document.body || el === document.documentElement) break;
      const count = counts.get(el) || 0;
      if (count >= 3) fallback = el;
      if (count >= target) {
        container = el;
        break;
      }
    }
    container = container || fallback;
    if (container && isChapterContainer(container) && !hasTranscriptMarker(container)) {
      return { rows: [], container: null };
    }
    return { rows, container };
  }

  function rowsToSegments(rows) {
    const segments = [];
    const sorted = (rows || []).slice().sort((a, b) => a.at - b.at);
    for (const row of sorted) {
      const text = stripTimecodes(row.text);
      if (text.length < 2) continue;
      const last = segments[segments.length - 1];
      if (last && last.start === row.at) {
        // The same row rendered twice while the list virtualises.
        if (text.length > last.text.length) last.text = text;
        continue;
      }
      segments.push({ start: row.at, text });
    }
    return withDurations(segments);
  }

  function withDurations(segments) {
    for (let i = 0; i < segments.length; i++) {
      const next = segments[i + 1];
      segments[i].dur = next && next.start > segments[i].start ? round2(next.start - segments[i].start) : 2.5;
    }
    return segments;
  }

  /* --------------------------------------------------------------- text parsing */

  /**
   * Parses transcript text when the rows themselves cannot be read:
   *
   *   0:12 Кэширование спасает          ← timestamps inline
   *   0:12                              ← or on their own line,
   *   Кэширование спасает                 text on the next one
   */
  function parseTranscriptText(text) {
    const segments = [];
    let pending = null;
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.replace(/\u00a0/g, ' ').trim();
      if (!line) continue;
      if (isChromeLine(line)) continue;
      const inline = line.match(/^(\d{1,3}(?::\d{2}){1,2})[\s]+(\S.*)$/);
      if (inline) {
        const start = parseClock(inline[1]);
        if (start == null) continue;
        const body = stripTimecodes(inline[2]);
        if (body.length >= 2) {
          pushSegment(segments, start, body);
          pending = null;
        } else {
          pending = start;
        }
        continue;
      }
      const only = strictClock(line);
      if (only != null) {
        pending = only;
        continue;
      }
      if (line.length < 2) continue;
      if (pending != null) {
        pushSegment(segments, pending, line);
        pending = null;
        continue;
      }
      const last = segments[segments.length - 1];
      // A wrapped row: the panel may split one row into several blocks, so any
      // line without its own timecode continues the previous segment.
      if (last) last.text = `${last.text} ${line}`.trim();
    }
    return withDurations(segments);
  }

  function pushSegment(segments, start, text) {
    const clean = stripTimecodes(text);
    if (clean.length < 2) return;
    const last = segments[segments.length - 1];
    if (last && last.start === start) {
      if (clean.length > last.text.length) last.text = clean;
      return;
    }
    segments.push({ start, text: clean });
  }

  /* ------------------------------------------------------------ quiet reading */

  /**
   * Hiding the panel while it is read. YouTube docks it into the sidebar column,
   * so it both appears on screen and pushes the page down; the user sees the
   * video jump, then the panel close. `position: fixed` + `opacity: 0` keeps the
   * element rendered (text, sizes, the virtualised list all still work) while
   * being invisible and out of the layout. The “…” overflow menu is hidden the
   * same way when it has to be used.
   */
  const QUIET_STYLE_ID = 'osum-quiet-transcript';
  const QUIET_CSS = [
    'ytd-engagement-panel-section-list-renderer[target-id*="transcript"],',
    '[target-id*="transcript"],',
    'ytd-transcript-renderer,',
    'ytd-transcript-search-panel-renderer,',
    'transcript-renderer {',
    '  position: fixed !important;',
    '  top: 0 !important;',
    '  left: -30000px !important;',
    '  width: 460px !important;',
    '  height: 720px !important;',
    '  opacity: 0 !important;',
    '  pointer-events: none !important;',
    '}',
    // The transcript button often hides behind the collapsed description. It had
    // to be expanded to be clicked, which pushed the whole page down in front of
    // the user; the height is pinned to its collapsed value instead.
    'html[data-osum-quiet] #description-inline-expander,',
    'html[data-osum-quiet] ytd-text-inline-expander,',
    'html[data-osum-quiet] ytd-expandable-video-description-body-renderer {',
    '  max-height: var(--osum-desc-h, 84px) !important;',
    '  overflow: hidden !important;',
    '}',
    // Any engagement panel, not only the ones whose target-id says
    // “transcript”: the first frame must never show a panel, whatever markup
    // YouTube ships this week. The stylesheet is removed as soon as the read
    // finishes, so nothing stays hidden for the user.
    'html[data-osum-quiet] ytd-engagement-panel-section-list-renderer,',
    'html[data-osum-quiet] ytd-engagement-panel-title-header-renderer {',
    '  position: fixed !important;',
    '  top: 0 !important;',
    '  left: -30000px !important;',
    '  opacity: 0 !important;',
    '  pointer-events: none !important;',
    '}',
    'html[data-osum-quiet] #engagement-panel-scrim,',
    'html[data-osum-quiet] ytd-menu-popup-renderer,',
    'html[data-osum-quiet] tp-yt-iron-dropdown,',
    'html[data-osum-quiet] ytd-popup-container { opacity: 0 !important; }',
  ].join('\n');

  function pageScrollTop() {
    try {
      return Number(window.scrollY || document.scrollingElement?.scrollTop || 0) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Viewport position of something the viewer is looking at (the player).
   * Restoring the bare scrollTop is not enough: opening the transcript panel
   * changes the height of the sidebar and of the description above the comments,
   * so the same number points at a different place and the page looks like it
   * jumped. Keeping this element at the same visual offset is what "the page
   * must not move" means to a viewer.
   */
  function pageAnchorTop() {
    try {
      const el = q('#movie_player') || q('ytd-player') || q('video.html5-main-video') || q('#primary-inner');
      const top = el?.getBoundingClientRect?.().top;
      return Number.isFinite(top) ? top : null;
    } catch {
      return null;
    }
  }

  function restorePageScroll(top, anchorTop = null) {
    try {
      if (anchorTop != null) {
        const now = pageAnchorTop();
        if (now != null && Math.abs(now - anchorTop) > 2) {
          const target = Math.max(0, pageScrollTop() + (now - anchorTop));
          if (typeof window.scrollTo === 'function') window.scrollTo({ top: target, behavior: 'instant' });
          else if (document.scrollingElement) document.scrollingElement.scrollTop = target;
          return;
        }
      }
      if (Math.abs(pageScrollTop() - top) < 2) return;
      if (typeof window.scrollTo === 'function') window.scrollTo({ top, behavior: 'instant' });
      else if (document.scrollingElement) document.scrollingElement.scrollTop = top;
    } catch {
      /* scrolling is best-effort */
    }
  }

  /**
   * Hides the panel/menus while it is read: `restore()` puts the page scroll
   * back (called right after the panel opens, because expanding the description
   * may have moved it) and `done()` removes the style and restores the scroll.
   */
  function beginQuiet() {
    const top = pageScrollTop();
    const anchorTop = pageAnchorTop();
    let style = null;
    let watching = false;
    let userScrolled = false;
    let descHeight = null;
    // YouTube scrolls the page itself while the panel opens: `scrollIntoView`
    // on the engagement panel it just mounted, the description expanding, the
    // panel closing again. Counting any scroll as “the reader took over”
    // switched our restore off, which is why the page stayed parked at the
    // transcript. Only a real gesture is a human — wheel, touch drag, scroll keys.
    let lastGestureAt = 0;
    const noteGesture = () => {
      lastGestureAt = Date.now();
      userScrolled = true;
    };
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);
    const onKeyDown = (event) => {
      try {
        if (SCROLL_KEYS.has(event?.key)) noteGesture();
      } catch {
        /* ignore */
      }
    };
    const gestureListeners = [
      ['wheel', noteGesture],
      ['touchmove', noteGesture],
      ['keydown', onKeyDown],
    ];
    // A scroll nobody asked for is YouTube's. Undo it on the event itself: the
    // 300 ms pin alone let a visible jump through before the next tick.
    const onScroll = () => {
      if (userScrolled) return;
      if (Date.now() - lastGestureAt < 600) return;
      restorePageScroll(top, anchorTop);
    };
    try {
      // Pin the collapsed description to the height it had before anything is
      // clicked, so expanding it to reach the button cannot move the page.
      const expander = descriptionExpander();
      const height = Number(expander?.getBoundingClientRect?.().height) || 0;
      if (height > 0) {
        descHeight = height;
        document.documentElement?.style?.setProperty?.('--osum-desc-h', `${Math.round(height)}px`);
      }
    } catch {
      /* measuring is best-effort */
    }
    try {
      document.documentElement?.setAttribute?.('data-osum-quiet', '1');
      style = document.createElement('style');
      style.id = QUIET_STYLE_ID;
      style.textContent = QUIET_CSS;
      (document.head || document.documentElement).appendChild(style);
    } catch {
      style = null;
    }
    const startWatching = () => {
      if (watching) return;
      watching = true;
      try {
        window.addEventListener?.('scroll', onScroll, { passive: true });
      } catch {
        /* ignore */
      }
      for (const [name, fn] of gestureListeners) {
        try {
          window.addEventListener?.(name, fn, { passive: true });
        } catch {
          /* ignore */
        }
      }
    };
    const stopWatching = () => {
      if (!watching) return;
      watching = false;
      try {
        window.removeEventListener?.('scroll', onScroll, { passive: true });
      } catch {
        /* ignore */
      }
      for (const [name, fn] of gestureListeners) {
        try {
          window.removeEventListener?.(name, fn, { passive: true });
        } catch {
          /* ignore */
        }
      }
    };
    // A panel that appears late must be hidden before it is painted. The pin
    // below polls every 300 ms, which is one or two visible frames; a mutation
    // observer reacts in the same task as the insert. It only runs while the
    // panel is ours, so a panel the reader opens is never touched.
    let watcher = null;
    try {
      if (typeof MutationObserver === 'function') {
        watcher = new MutationObserver(() => {
          if (openedByUs) {
            try {
              hideSurfaceInline();
            } catch {
              /* the page is free to be weird */
            }
          }
        });
        watcher.observe(document.documentElement, { childList: true, subtree: true });
      }
    } catch {
      watcher = null;
    }
    // While the panel is being read YouTube may scroll the page at any moment
    // (it calls scrollIntoView on the engagement panel it just opened). Pin the
    // page for the whole read instead of once after the click: the reader must
    // not see the page move, even for a frame.
    let pinTimer = null;
    const stopPin = () => {
      if (pinTimer) clearInterval(pinTimer);
      pinTimer = null;
    };
    return {
      restore: () => {
        // Once the reader scrolls, their position wins: never fight a human.
        if (userScrolled) return;
        restorePageScroll(top, anchorTop);
        // From here on a gesture means the reader took over: their position
        // wins over ours when the read finishes.
        startWatching();
      },
      pin: () => {
        if (pinTimer || typeof setInterval !== 'function') return;
        pinTimer = setInterval(() => {
          try {
            // A panel that appeared is ours to hide the moment it shows up.
            if (openedByUs && panelElementPresent()) hideSurfaceInline();
          } catch {
            /* ignore */
          }
          if (!userScrolled) restorePageScroll(top, anchorTop);
        }, 300);
        pinTimer?.unref?.();
      },
      done: () => {
        stopPin();
        try {
          watcher?.disconnect?.();
        } catch {
          /* ignore */
        }
        watcher = null;
        // The listeners stay until the late restores below finish: a gesture in
        // that window must still win, and YouTube's own jump must still be undone.
        const releaseStyles = () => {
          try {
            style?.remove?.();
          } catch {
            /* ignore */
          }
          try {
            document.documentElement?.removeAttribute?.('data-osum-quiet');
          } catch {
            /* ignore */
          }
          try {
            if (descHeight != null) document.documentElement?.style?.removeProperty?.('--osum-desc-h');
          } catch {
            /* ignore */
          }
        };
        // A panel that was just closed is still in YouTube's closing animation
        // for a few frames. Releasing the styles at that moment put the whole
        // transcript on screen for ~200 ms (the “I can still see it” report),
        // so they stay until the panel node has actually left the document.
        let released = false;
        const releaseNow = () => {
          if (released) return;
          released = true;
          releaseStyles();
          if (!userScrolled) restorePageScroll(top, anchorTop);
        };
        const releaseWhenGone = () => {
          if (released) return;
          let absent = 0;
          let tries = 0;
          // The first check is synchronous: a page that closes the panel at once
          // has nothing to wait for, and the read must not resolve with its
          // hiding styles still in the document.
          const check = () => {
            if (released) return;
            tries += 1;
            let present = true;
            try {
              present = panelElementPresent();
            } catch {
              present = true;
            }
            absent = present ? 0 : absent + 1;
            // The first check is the page as it is now; later polls need two
            // silent ticks, so a node that only leaves the tree right before its
            // closing animation paints cannot flash the transcript.
            if (absent >= (tries === 1 ? 1 : 2) || tries > 30) releaseNow();
          };
          check();
          if (released || typeof setInterval !== 'function') {
            if (!released) releaseNow();
            return;
          }
          const timer = setInterval(check, 100);
          timer?.unref?.();
        };
        if (typeof setInterval === 'function' && typeof panelElementPresent === 'function') releaseWhenGone();
        else releaseStyles();
        if (!userScrolled) restorePageScroll(top, anchorTop);
        // Closing the panel or collapsing the description can move the page a
        // moment later. Keep the guard (and the gesture listeners) for a short
        // while; the first real gesture cancels it.
        if (typeof setTimeout === 'function') {
          for (const delay of [200, 600, 1500]) {
            const timer = setTimeout(() => {
              if (!userScrolled) restorePageScroll(top, anchorTop);
              if (delay === 1500) stopWatching();
            }, delay);
            timer?.unref?.();
          }
        } else {
          stopWatching();
        }
      },
      /**
       * Keeps the panel hidden for as long as it is mounted. Used when the panel
       * could not be closed: releasing the styles then would show it to the
       * user, and a hidden off-screen panel costs nothing.
       */
      hold: () => {
        stopPin();
        stopWatching();
        try {
          watcher?.disconnect?.();
        } catch {
          /* ignore */
        }
        watcher = null;
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          let present = true;
          try {
            present = panelElementPresent();
          } catch {
            present = true;
          }
          if (!present || tries > 150) {
            clearInterval(timer);
            try {
              style?.remove?.();
            } catch {
              /* ignore */
            }
            try {
              document.documentElement?.removeAttribute?.('data-osum-quiet');
            } catch {
              /* ignore */
            }
            try {
              if (descHeight != null) document.documentElement?.style?.removeProperty?.('--osum-desc-h');
            } catch {
              /* ignore */
            }
            if (!userScrolled) restorePageScroll(top, anchorTop);
          }
        }, 100);
      },
    };
  }

  /** The outermost element of the panel that holds `node` (or null). */
  function panelHost(node) {
    let el = node;
    let best = null;
    for (let depth = 0; depth < 10 && el; depth++, el = el.parentElement) {
      const tag = String(el.tagName || '').toLowerCase();
      const id = `${el.getAttribute?.('id') || ''} ${el.getAttribute?.('target-id') || ''}`.toLowerCase();
      if (tag.includes('transcript') || tag.includes('engagement-panel') || id.includes('transcript')) best = el;
    }
    return best || node;
  }

  /**
   * CSS is the first line of defence, inline styles are the second: a selector
   * that misses (YouTube renames its components weekly) would let the panel
   * flash on screen while it is being scraped.
   */
  function hideSurfaceInline() {
    const surface = findTranscriptSurface();
    if (!surface) return null;
    const host = panelHost(surface);
    if (!host?.style) return null;
    const previous = host.getAttribute?.('style') || '';
    try {
      host.style.cssText = `${previous};position:fixed !important;left:-30000px !important;top:0 !important;width:460px !important;height:720px !important;opacity:0 !important;pointer-events:none !important;`;
    } catch {
      return null;
    }
    return () => {
      try {
        host.style.cssText = previous;
      } catch {
        /* ignore */
      }
    };
  }

  /* ------------------------------------------------------------ panel handling */

  function findShowTranscriptButtons() {
    const found = [];
    const push = (node) => {
      if (node && !found.includes(node)) found.push(node);
    };
    for (const selector of SHOW_TRANSCRIPT_SELECTORS) push(q(selector));
    for (const node of qa('button, tp-yt-paper-button, yt-button-shape button, [role="tab"], yt-tab-shape')) {
      if (matchesTranscriptLabel(node)) push(node);
    }
    return found;
  }

  function transcriptSegmentsInDom() {
    for (const selector of SEGMENT_SELECTORS) {
      const nodes = qa(selector);
      if (nodes.length) return nodes;
    }
    return [];
  }

  /**
   * Finds the element that currently renders the transcript. Rows win over
   * names; a plain timecode-density scan is the last resort.
   */
  function findTranscriptSurface() {
    const byRows = rowsFromDom(document);
    if (byRows.container && byRows.rows.length >= 3) return byRows.container;

    const candidates = [];
    for (const selector of [
      '[target-id*="transcript"]',
      'ytd-transcript-renderer',
      'transcript-renderer',
      '#segments-container',
    ]) {
      for (const node of qa(selector)) candidates.push(node);
    }
    let best = null;
    let bestCount = 0;
    for (const node of candidates) {
      const text = textOf(node);
      if (text.length < 40) continue;
      const count = countTimecodes(text);
      if (count >= 3 && count > bestCount) {
        best = node;
        bestCount = count;
      }
    }
    if (best) return best;

    for (const node of qa('[role="dialog"], tp-yt-paper-dialog, ytd-engagement-panel-section-list-renderer')) {
      if (isChapterContainer(node)) continue;
      const text = textOf(node);
      if (text.length < 40) continue;
      const count = countTimecodes(text);
      if (count >= 3 && count > bestCount) {
        best = node;
        bestCount = count;
      }
    }
    return best;
  }

  // The row scan walks the whole document, so it is throttled: it only runs a
  // couple of times per second while the panel is opening.
  let rowScan = { at: 0, ok: false };
  function hasRowsNow() {
    if (Date.now() - rowScan.at < 700) return rowScan.ok;
    rowScan = { at: Date.now(), ok: rowsFromDom(document).rows.length >= 3 };
    return rowScan.ok;
  }

  /** Cheap “is a transcript on screen” probe used while clicking buttons. */
  function hasTranscript() {
    if (transcriptSegmentsInDom().length) return true;
    if (hasRowsNow()) return true;
    const panel = q('[target-id*="transcript"], ytd-transcript-renderer, transcript-renderer, #segments-container');
    if (!panel) return false;
    const text = textOf(panel);
    return text.length > 40 && countTimecodes(text) >= 2;
  }

  /** Expands the collapsed description (it holds the transcript button). */
  function expandDescription() {
    const container = q('#description-inline-expander');
    if (container && !container.hasAttribute?.('collapsed')) {
      // Already expanded: clicking would collapse it and hide the button again.
      return false;
    }
    for (const selector of [
      'tp-yt-paper-button#expand',
      'ytd-text-inline-expander #expand',
      'ytd-expandable-video-description-body-renderer #expand',
      '#description-inline-expander tp-yt-paper-button#expand',
    ]) {
      const node = q(selector);
      if (!node) continue;
      try {
        node.click();
        return true;
      } catch {
        /* try the next one */
      }
    }
    return false;
  }

  /** The video description, whose “Show transcript” button may be collapsed. */
  function descriptionExpander() {
    return (
      q('#description-inline-expander') ||
      q('ytd-text-inline-expander') ||
      q('ytd-expandable-video-description-body-renderer')
    );
  }

  /** Puts an expanded description back the way the user had it. */
  function collapseDescription() {
    const expander = descriptionExpander();
    if (!expander) return false;
    for (const selector of ['#collapse', 'tp-yt-paper-button#collapse', 'button[aria-label*="свернуть" i]', 'button[aria-label*="collapse" i]']) {
      const node = q(selector, expander);
      if (!node) continue;
      try {
        node.click();
        return true;
      } catch {
        /* try the next one */
      }
    }
    return false;
  }

  function overflowMenuItem() {
    for (const item of qa(
      'ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer, tp-yt-paper-item, ytd-compact-link-renderer',
    )) {
      if (matchesTranscriptLabel(item)) return item;
    }
    return null;
  }

  async function openOverflowMenu() {
    for (const selector of [
      'ytd-watch-metadata ytd-menu-renderer button[aria-haspopup="true"]',
      'ytd-menu-renderer #button-shape button',
      'ytd-menu-renderer button[aria-label]',
    ]) {
      const node = q(selector);
      if (!node) continue;
      try {
        node.click();
      } catch {
        continue;
      }
      const item = await waitFor(overflowMenuItem, { timeout: 1600, interval: 100 });
      if (item) return item;
    }
    return null;
  }

  /** Polls until `condition()` returns a truthy value; returns it or null. */
  async function waitFor(condition, { timeout = 9000, interval = 220 } = {}) {
    const started = Date.now();
    for (;;) {
      let value = null;
      try {
        value = condition();
      } catch {
        value = null;
      }
      if (value) return value === true ? true : value;
      if (Date.now() - started > timeout) return null;
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** Clicks switches until the transcript shows up; returns the one that worked. */
  async function tryTranscriptButtons(candidates = findShowTranscriptButtons()) {
    for (const button of candidates.slice(0, 6)) {
      try {
        button.click();
      } catch {
        continue;
      }
      if (await waitFor(hasTranscript, { timeout: 4000, interval: 300 })) return button;
    }
    return null;
  }

  const PANEL_PRESENT_SELECTOR =
    '[target-id*="transcript"], ytd-transcript-renderer, transcript-renderer, #segments-container';

  function panelElementPresent() {
    return !!q(PANEL_PRESENT_SELECTOR);
  }

  /**
   * Any control that switches to the transcript. It is searched across the
   * whole page, not inside the row list: the panel's tabs live in its header,
   * which is a *sibling* of the list, so a panel-scoped search found nothing and
   * reported `tab=no-tab` while “Эпизоды” (ten chapter rows) stayed on screen.
   */
  function findTranscriptTabs(root = document) {
    const out = [];
    const scope = root || document;
    if (!scope?.querySelectorAll) return out;
    const push = (node) => {
      if (node && !out.includes(node)) out.push(node);
    };
    const shortLabel = (node) => {
      const label = String(textOf(node) || '').replace(/\s+/g, ' ').trim();
      // A control has a short label; a whole panel's text is long.
      return label && label.length <= 60 ? label : '';
    };
    // Real tabs first. The page-level “Show transcript” button also carries the
    // word “transcript”, but clicking it while the panel is open CLOSES that
    // panel — that is how a tab switch used to end with an empty read.
    for (const node of qa('[role="tab"], yt-tab-shape, tp-yt-paper-tab', scope)) {
      if (!matchesTranscriptLabel(node)) continue;
      if (!shortLabel(node)) continue;
      push(node);
    }
    if (out.length) return out;
    // Fallback: a button inside the open panel, never a page-level toggle.
    const panel = q('[target-id*="transcript"], ytd-transcript-renderer, transcript-renderer');
    for (const node of qa('button, [role="button"], a', panel || scope)) {
      if (!matchesTranscriptLabel(node)) continue;
      if (!shortLabel(node)) continue;
      push(node);
    }
    return out;
  }

  /**
   * Switches an open panel to its “Transcript” tab and waits until the rows
   * change. The panel also has a “Chapters” tab full of timecodes, which used
   * to be read as an eight-row transcript of a 36-minute video.
   */
  async function switchToTranscriptTab(before = []) {
    const signature = (list) => list.map((s) => `${s.start}:${s.text.length}`).join('|');
    const wanted = signature(before);
    const tabs = findTranscriptTabs();
    for (const tab of tabs.slice(0, 4)) {
      try {
        tab.click();
      } catch {
        continue;
      }
      const current = await waitFor(() => {
        const now = scrapeSegments();
        return now.length >= 3 && signature(now) !== wanted ? now : null;
      }, { timeout: 2500, interval: 350 });
      if (current) return true;
    }
    return false;
  }

  /** Tabs inside an already open panel (clicking one cannot close the panel). */
  async function tryInPanelTabs() {
    const tabs = findTranscriptTabs();
    for (const tab of tabs.slice(0, 4)) {
      try {
        tab.click();
      } catch {
        continue;
      }
      if (await waitFor(hasTranscript, { timeout: 2500, interval: 300 })) return true;
    }
    return false;
  }

  async function openTranscriptPanel() {
    if (hasTranscript()) return { ok: true, alreadyOpen: true };
    // A panel may be open while still loading its rows. Clicking the page's
    // “Show transcript” toggle in that state *closes* it, so only wait here.
    if (panelElementPresent()) {
      if (await waitFor(hasTranscript, { timeout: 2500, interval: 300 })) return { ok: true, alreadyOpen: true };
      if (await tryInPanelTabs()) return { ok: true, alreadyOpen: true, via: 'tab' };
      return { ok: false, reason: 'panel-empty' };
    }
    const candidates = findShowTranscriptButtons();
    const byButton = await tryTranscriptButtons(candidates);
    if (byButton) return { ok: true, alreadyOpen: false, via: 'button', toggle: byButton };

    // The button often lives behind the collapsed description.
    const expanded = expandDescription();
    if (expanded) {
      if (await waitFor(hasTranscript, { timeout: 1500, interval: 250 })) return { ok: true, alreadyOpen: false, via: 'description' };
      const byDescription = await tryTranscriptButtons(findShowTranscriptButtons());
      if (byDescription) return { ok: true, alreadyOpen: false, via: 'description', toggle: byDescription };
    }

    // Last resort: the “…” overflow menu of the video has “Show transcript”.
    const item = await openOverflowMenu();
    if (item) {
      try {
        item.click();
      } catch {
        /* ignore */
      }
      if (await waitFor(hasTranscript, { timeout: 6000, interval: 300 })) return { ok: true, alreadyOpen: false, via: 'menu' };
    }

    // Nothing on this page even looks like a transcript switch: do not make the
    // user wait for another four seconds.
    if (!candidates.length && !expanded && !item) return { ok: false, reason: 'no-button' };
    // One last chance: one of the clicks above may still be loading the panel.
    if (await waitFor(hasTranscript, { timeout: 4000, interval: 300 })) return { ok: true, alreadyOpen: false, via: 'late' };
    return { ok: false, reason: 'no-button' };
  }

  /** Counts for the “Details” block when the page transcript cannot be read. */
  function diagnose() {
    const filtered = rowsFromDom(document);
    const unfiltered = rowsFromDom(document, { allowForeign: true });
    return {
      panel: panelElementPresent(),
      rows: filtered.rows.length,
      rowsUnfiltered: unfiltered.rows.length,
      timecodeCells: timestampLeaves(document, { allowForeign: true }).length,
      segments: transcriptSegmentsInDom().length,
      duration: Number(util.pageMeta?.().lengthSeconds) || 0,
      url: location.href,
    };
  }

  /**
   * Closes a panel we opened and waits until it is really gone. The close
   * button is missing in some YouTube builds, and releasing the quiet styles
   * with the panel still mounted put the whole transcript on screen in front of
   * the user — the exact thing “the extension must never show it” forbids.
   */
  async function closeQuietly(toggle = null) {
    if (!panelElementPresent()) {
      openedByUs = false;
      return true;
    }
    closeTranscriptPanel();
    if (await waitFor(() => !panelElementPresent(), { timeout: 500, interval: 100 })) {
      openedByUs = false;
      return true;
    }
    // The control that opened it closes it again.
    for (const button of [toggle].filter(Boolean)) {
      try {
        button.click?.();
      } catch {
        /* ignore */
      }
      if (await waitFor(() => !panelElementPresent(), { timeout: 900, interval: 100 })) {
        openedByUs = false;
        return true;
      }
    }
    const gone = !panelElementPresent();
    if (gone) openedByUs = false;
    return gone;
  }

  /**
   * YouTube re-opens the panel by itself on some builds (the click that opens it
   * lands after our close, or the router restores the previous engagement
   * panel). A short guard after a read hides whatever appears again, restores
   * the page anchor and closes it — an invisible read must stay invisible.
   */
  function guardAgainstLatePanel(quiet = null, { timeoutMs = 4000, interval = 250 } = {}) {
    if (typeof setInterval !== 'function') return;
    const startedAt = Date.now();
    let quietFor = 0;
    const timer = setInterval(() => {
      const expired = Date.now() - startedAt > timeoutMs;
      let present = false;
      try {
        present = panelElementPresent();
      } catch {
        present = false;
      }
      if (!present) {
        // Absence for ~1 second after the read: the page is ours again.
        if (Date.now() - startedAt > 1200) {
          clearInterval(timer);
          openedByUs = false;
        }
        return;
      }
      if (!openedByUs && quietFor === 0) {
        // Somebody (the reader) opened it after us: leave it alone.
        clearInterval(timer);
        return;
      }
      try {
        hideSurfaceInline();
        quiet?.restore?.();
        closeTranscriptPanel();
      } catch {
        /* the page is free to be weird */
      }
      quietFor += 1;
      if (expired) {
        clearInterval(timer);
        console.info('[OpenSummary] панель расшифровки не закрылась: остаётся скрытой');
      }
    }, interval);
    // Intervals must not keep a test process (or a closed page) alive.
    timer?.unref?.();
  }

  function closeTranscriptPanel() {
    const surface = findTranscriptSurface();
    const closeBtn =
      q(
        'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #visibility-button button, ' +
          'ytd-transcript-renderer #close-button button, ' +
          'ytd-engagement-panel-title-header-renderer #visibility-button button',
      ) ||
      (surface && q('button[aria-label*="закры" i], button[aria-label*="clos" i]', surface));
    try {
      closeBtn?.click?.();
    } catch {
      /* ignore */
    }
  }

  /** The scroll container of a virtualised list (or null when everything fits). */
  function findScroller(node) {
    let el = node;
    for (let depth = 0; depth < 8 && el; depth++, el = el.parentElement) {
      if ((el.scrollHeight || 0) > (el.clientHeight || 0) + 60 && (el.clientHeight || 0) > 80) return el;
      if (el === document.body) break;
    }
    return null;
  }

  /**
   * Scrolls the virtualised list row by row so every segment is rendered at
   * least once, then puts the panel back where the user left it.
   */
  async function collectRows({ maxMs = 25000, allowForeign = false } = {}) {
    let { rows, container } = rowsFromDom(document, { allowForeign });
    if (!container) return { rows: [], container: null };
    const scroller = findScroller(container);
    if (!scroller) return { rows, container };

    const collected = new Map();
    const absorb = (list) => {
      let added = 0;
      for (const row of list) {
        const key = `${row.at}\u0000${row.text}`;
        if (collected.has(key)) continue;
        collected.set(key, row);
        added++;
      }
      return added;
    };
    absorb(rows);

    const originalTop = scroller.scrollTop || 0;
    // YouTube keeps a couple of screens of rows mounted, so jumping further than
    // one viewport still collects every row and halves the time for long videos.
    const step = Math.max(240, Math.floor((scroller.clientHeight || 400) * 1.4));
    const deadline = Date.now() + maxMs;
    try {
      scroller.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 120));
      for (let guard = 0; guard < 600 && Date.now() < deadline; guard++) {
        const batch = rowsFromDom(container, { allowForeign });
        if (batch.rows.length) absorb(batch.rows);
        const top = scroller.scrollTop || 0;
        const view = scroller.clientHeight || 0;
        const bottom = scroller.scrollHeight || 0;
        if (top + view >= bottom - 8) break;
        const next = Math.min(top + step, bottom);
        if (next <= top) break; // not scrollable after all
        scroller.scrollTop = next;
        await new Promise((r) => setTimeout(r, 90));
      }
      // One last read: the bottom row may have rendered after the final scroll.
      const last = rowsFromDom(container, { allowForeign });
      if (last.rows.length) absorb(last.rows);
    } catch {
      /* scrolling is best-effort */
    } finally {
      try {
        scroller.scrollTop = originalTop;
      } catch {
        /* ignore */
      }
    }
    rows = Array.from(collected.values()).sort((a, b) => a.at - b.at);
    return { rows, container };
  }

  /* ------------------------------------------------------------------ public */

  function scrapeSegments() {
    const { rows } = rowsFromDom(document);
    return rowsToSegments(rows);
  }

  function mergeSegments(target, segments) {
    for (const segment of segments || []) {
      const key = `${segment.start}\u0000${segment.text}`;
      if (!target.has(key)) target.set(key, segment);
    }
    return target;
  }

  function sortedSegments(collected) {
    return withDurations(Array.from(collected.values()).sort((a, b) => a.start - b.start));
  }

  /**
   * Collects every segment, scrolling a virtualised list (rows or plain text)
   * until it stops producing new content. Reading only the rendered rows would
   * summarise the visible ten lines of an hour-long video.
   */
  async function collectSegments() {
    let rowsBased = rowsFromDom(document).container ? rowsToSegments((await collectRows()).rows) : [];
    if (!rowsBased.length) {
      // The panel may sit inside a container we consider “foreign” (a docking
      // layout we have not seen yet). Its rows still have to pass the duration
      // and speech-density checks below, so reading them is safe.
      rowsBased = rowsFromDom(document, { allowForeign: true }).container
        ? rowsToSegments((await collectRows({ allowForeign: true })).rows)
        : [];
    }
    // If the rows cover far less than the video (virtualised list whose scroller
    // went unnoticed), let the text pass have a go as well and keep the longer
    // result.
    const duration = Number(util.pageMeta?.().lengthSeconds) || 0;
    const expected = duration ? Math.max(5, Math.round(duration / 20)) : 5;
    if (rowsBased.length >= expected) return rowsBased;
    const textBased = await collectFromText();
    return textBased.length > rowsBased.length ? textBased : rowsBased;
  }

  /** Last resort: parse the panel's text, scrolling it if it is virtualised. */
  async function collectFromText() {
    const panel = findTranscriptSurface();
    if (!panel) return [];
    const collected = mergeSegments(new Map(), parseTranscriptText(textOf(panel)));
    const scroller = findScroller(panel);
    if (scroller) {
      const originalTop = scroller.scrollTop || 0;
      const step = Math.max(240, Math.floor((scroller.clientHeight || 400) * 1.4));
      const deadline = Date.now() + 25000;
      try {
        scroller.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 120));
        for (let guard = 0; guard < 600 && Date.now() < deadline; guard++) {
          mergeSegments(collected, parseTranscriptText(textOf(panel)));
          const top = scroller.scrollTop || 0;
          const view = scroller.clientHeight || 0;
          const bottom = scroller.scrollHeight || 0;
          if (top + view >= bottom - 8) break;
          const next = Math.min(top + step, bottom);
          if (next <= top) break;
          scroller.scrollTop = next;
          await new Promise((r) => setTimeout(r, 90));
        }
        mergeSegments(collected, parseTranscriptText(textOf(panel)));
      } catch {
        /* scrolling is best-effort */
      } finally {
        try {
          scroller.scrollTop = originalTop;
        } catch {
          /* ignore */
        }
      }
    }
    return sortedSegments(collected);
  }

  /** Reports what the scraper saw to the worker's diagnostics ring buffer. */
  function journal(event) {
    try {
      util.sendMessage?.({ type: 'journal', event }).catch?.(() => {});
    } catch {
      /* diagnostics must never break the flow */
    }
  }

  /**
   * Waits until the freshly opened transcript stops adding rows (or 6 s pass).
   * A short list that never grows is returned immediately; a list that is still
   * filling is followed to the end, which is what makes the first attempt work.
   */
  async function waitForRowGrowth({ timeoutMs = 6000, quietMs = 700 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = rowsFromDom(document).rows.length;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const now = rowsFromDom(document).rows.length;
      if (now > last) {
        last = now;
        lastChange = Date.now();
        continue;
      }
      if (now === last && Date.now() - lastChange >= quietMs) break;
    }
    return last;
  }

  /** Drops rows whose timecode is past the end of the video. */
  function trimToDuration(segments) {
    const duration = Number(util.pageMeta?.().lengthSeconds) || 0;
    if (!duration) return segments;
    const kept = (segments || []).filter((s) => s && s.start <= duration + 10);
    return kept.length >= 3 ? kept : segments;
  }

  /**
   * Rejects a scrape that cannot be the transcript of this video: too few rows,
   * timecodes past the video length (a recommendation list), or far less speech
   * than a person can utter (~120–180 wpm, so under 20 wpm is a list of titles
   * or a chapter list).
   */
  function transcriptProblem(segments) {
    if (!segments || segments.length < 3) {
      return { code: 'NO_PAGE_TRANSCRIPT', message: `строк всего ${segments?.length || 0}` };
    }
    const duration = Number(util.pageMeta?.().lengthSeconds) || 0;
    const lastStart = segments[segments.length - 1].start;
    if (duration && lastStart > duration + 10) {
      return { code: 'PAGE_TRANSCRIPT_MISMATCH', message: `последний таймкод ${Math.round(lastStart)}s > длительности ${duration}s` };
    }
    const words = segments.reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0);
    if (duration > 120 && words / (duration / 60) < 20) {
      return { code: 'PAGE_TRANSCRIPT_NOT_SPEECH', message: `плотность речи ${Math.round(words / (duration / 60))} слов/мин на ${duration}s` };
    }
    return null;
  }

  let cached = null; // { videoId, at, payload }
  // Every read remembers the generation it started in. Navigating to another
  // video (or a test starting from a clean page) bumps it, and a read from the
  // previous page must not publish its transcript as the current one.
  let readGeneration = 0;
  // True while a transcript panel on the page is one we opened. A panel we did
  // not open belongs to the reader and must be left alone; a panel we opened
  // (or one an earlier read left behind) must never be shown again.
  let openedByUs = false;
  let pageApiRejected = ''; // video whose page-api call answered 4xx

  /**
   * The panel's own `get_transcript` JSON, captured in the page world. This is
   * the exact answer YouTube gave itself: complete even when the row list is
   * virtualised, and readable without scrolling the panel at all.
   */
  async function payloadFromCapture(json, videoId) {
    let parsed = null;
    try {
      parsed = await util.sendMessage({ type: 'parse-transcript', json: JSON.stringify(json) });
    } catch (err) {
      journal({
        code: err?.code || 'PARSE_FAILED',
        message: String(err?.message || err).slice(0, 160),
        videoId, route: 'page-capture', level: 'error',
      });
      return null;
    }
    const segments = (parsed?.segments || []).filter((s) => s && s.text);
    if (segments.length < 2) {
      journal({
        code: 'EMPTY',
        message: `в ответе панели ${segments.length} фрагментов`,
        videoId, route: 'page-capture', level: 'warn',
      });
      return null;
    }
    const meta = util.pageMeta();
    const payload = {
      segments,
      tracks: [{ lang: 'page', name: OSUM.t('transcriptFromPage'), auto: false }],
      meta: {
        ...meta,
        videoId: meta.videoId || videoId,
        lang: detectLang(segments),
        source: 'page-capture',
        autoGenerated: false,
        chapters: getChapters(),
        wordCount: segments.reduce((a, s) => a + s.text.split(/\s+/).length, 0),
        url: location.href,
      },
    };
    journal({
      code: 'PAGE_CAPTURE_OK',
      message: `${segments.length} фрагментов из ответа панели, до ${Math.round(segments[segments.length - 1].start)}s`,
      videoId, route: 'page-capture', level: 'ok', segments: segments.length,
    });
    return payload;
  }

  async function getTranscript({ keepPanelOpen = false } = {}) {
    const videoId = util.getVideoId?.() || '';
    const generation = readGeneration;
    const stale = () => generation !== readGeneration;
    if (cached && cached.videoId === videoId && Date.now() - cached.at < 5 * 60 * 1000) {
      return cached.payload;
    }
    // A freshly navigated watch page is a skeleton for a moment: the player is
    // there, but the description and the “Show transcript” control are not
    // rendered yet. Reading in that window reported “no button” on a real
    // three-hour video, so give the page a chance to hydrate before deciding
    // that it has no transcript.
    if (q('#movie_player') || q('ytd-watch-flexy')) {
      await waitFor(
        () => panelElementPresent() || findShowTranscriptButtons().length > 0 || !!descriptionExpander(),
        { timeout: 12000, interval: 250 },
      );
    }
    // Reading the page is a background job, not a show. A panel the user opened
    // by hand stays untouched; a panel *we* open is hidden off-screen before it
    // appears, closed again afterwards even when the scrape failed, and the page
    // scroll (which YouTube and the browser move when the panel or the expanded
    // description changes the layout) is put back.
    const hadPanel = panelElementPresent();
    // Always read quietly, even when a panel is already on screen. A reader's
    // own panel is hidden for the duration and put back afterwards (it is never
    // closed), so YouTube cannot scroll the page to it either.
    const quiet = beginQuiet();
    // Block the page's own programmatic scrolling before anything is clicked:
    // restoring the scroll afterwards is always a visible frame too late. The
    // bridge that carries the lock can take a moment on a page that refused it,
    // so the lock gets a head start, not an unlimited veto on the read.
    const lockStarted = lockPageScroll(true);
    await Promise.race([lockStarted, new Promise((r) => setTimeout(r, 600))]);
    // Subscribe to the page's own transcript answer before the panel opens: the
    // request is made by YouTube as the panel mounts, and its JSON is the full,
    // unvirtualised transcript. Nothing is fetched by us.
    const capture = ensureBridge()
      .then((ok) => (ok ? askPage('capture-transcript', { timeoutMs: 13000, fields: { timeoutMs: 12000 } }) : null))
      .catch(() => null);
    const description = descriptionExpander();
    const wasCollapsed = description ? description.hasAttribute?.('collapsed') === true : false;
    let unhideSurface = null;
    let toggle = null;
    const cleanup = async () => {
      let closed = true;
      try {
        // Order matters: the panel is closed while it is still invisible, and
        // only then does its own styling (and the page scroll) come back.
        if (!hadPanel && !keepPanelOpen) {
          closed = await closeQuietly(toggle);
          if (!closed) {
            journal({
              code: 'PANEL_NOT_CLOSED',
              message: 'панель расшрировки закрыть не удалось: остаётся скрытой вне экрана',
              videoId, route: 'page-panel', level: 'warn',
            });
          }
        }
        if (wasCollapsed && description && description.hasAttribute?.('collapsed') !== true) collapseDescription();
      } catch {
        /* the page is free to be weird */
      }
      if (closed) {
        try {
          unhideSurface?.();
        } catch {
          /* ignore */
        }
      }
      // With the panel still mounted the quiet styles stay: an invisible,
      // off-screen panel is harmless, a visible one is a bug report. They are
      // released as soon as YouTube finally drops it.
      if (closed) {
        quiet.done();
        guardAgainstLatePanel(quiet);
      } else {
        quiet.hold();
      }
      // Released last: the panel is closed and hidden before the page may move
      // again, so no late scroll can be seen. A bridge that is not there cannot
      // hold a lock, and the read must not wait seconds for the release.
      await Promise.race([
        lockPageScroll(false).catch(() => false),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    };

    try {
      if (quiet) quiet.pin();
      const opened = await openTranscriptPanel();
      toggle = opened?.toggle || null;
      if (!opened.ok) {
        // The panel may be present but rendered in a markup the row scraper does
        // not recognise (2026-10 “modern transcript view”): YouTube has still
        // made its own request, so the captured answer is the transcript. Give
        // it a moment before declaring the page unreadable.
        const grace = await Promise.race([
          capture,
          new Promise((r) => setTimeout(() => r(null), panelElementPresent() ? 2500 : 700)),
        ]);
        const late = grace?.captured ? await payloadFromCapture(grace.json, videoId) : null;
        if (late) {
          if (!hadPanel) openedByUs = true;
          if (!stale()) cached = { videoId: late.meta.videoId, at: Date.now(), payload: late };
          return stale() ? null : late;
        }
        const info = diagnose();
        console.info('[OpenSummary] панель транскрипта не открылась', { reason: opened.reason, ...info });
        journal({
          code: 'NO_PAGE_TRANSCRIPT',
          message: `панель не открылась (${opened.reason}); panel=${info.panel}, rows=${info.rows}/${info.rowsUnfiltered}, cells=${info.timecodeCells}, duration=${info.duration}s`,
          videoId, route: 'page-panel', level: 'error',
        });
        return null;
      }
      // Only a panel we opened is ours to close. A panel the reader already had
      // on screen is hidden for the read and restored afterwards.
      if (!hadPanel) openedByUs = true;
      if (quiet) {
        quiet.pin();
        unhideSurface = hideSurfaceInline();
        // The click may have scrolled the page (the panel or the expanded
        // description); put it back before the user notices.
        quiet.restore();
      }
      // The captured JSON is both faster and more complete than reading rows,
      // so it wins as soon as YouTube's own request lands. A page whose panel
      // renders rows without asking the API never answers that subscription, so
      // the window is short: it used to be four seconds, which was most of a
      // panel-only read (4.6 s → 2.1 s on the `rows` fixture).
      const captured = await Promise.race([
        capture,
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      const fromCapture = captured?.captured ? await payloadFromCapture(captured.json, videoId) : null;
      if (fromCapture) {
        if (!stale()) cached = { videoId: fromCapture.meta.videoId, at: Date.now(), payload: fromCapture };
        return stale() ? null : fromCapture;
      }
      // Give YouTube a moment to finish (virtualised) rendering.
      await new Promise((r) => setTimeout(r, 350));

      // A badge from the sidebar (“4:01:07” on a 33-minute video) used to make
      // the whole otherwise-good transcript fail the duration check, so rows past
      // the video's end are dropped instead of rejecting everything.
      let segments = trimToDuration(await collectSegments());
      let problem = transcriptProblem(segments);
      let tabSwitch = 'not-tried';
      if (problem) {
        // The open panel may be showing its “Chapters” tab: timecodes, but not a
        // transcript. Switching to the transcript tab is the only recovery the
        // page itself offers, so try it once before giving up.
        const tabCount = findTranscriptTabs().length;
        tabSwitch = tabCount ? `tried-${tabCount}` : 'no-tab';
        if (await switchToTranscriptTab(segments)) {
          tabSwitch = 'switched';
          journal({ code: 'PAGE_TRANSCRIPT_TAB', message: 'панель переключена на вкладку транскрипта', videoId, route: 'page-panel', level: 'info' });
          // The transcript of a 33-minute video arrives in pieces after the tab
          // switch. Reading once, 250 ms later, is what produced “11 rows, 4 words
          // per minute” on the first two attempts and a complete transcript only
          // on the third: wait for the list to stop growing instead.
          await waitForRowGrowth();
          segments = trimToDuration(await collectSegments());
          problem = transcriptProblem(segments);
        }
      }
      if (problem) {
        // The panel is closed by `cleanup()` above even here: leaving it on
        // screen was the “why did the page jump and show a transcript panel?”
        // report.
        const info = diagnose();
        console.info('[OpenSummary] панель открыта, но транскрипта в ней нет', problem.code, problem.message, info);
        journal({
          code: problem.code,
          message: `панель открыта (${opened.via || 'already-open'}), tab=${tabSwitch}, но ${problem.message}; panel=${info.panel}, rows=${info.rows}/${info.rowsUnfiltered}, cells=${info.timecodeCells}, duration=${info.duration}s`,
          videoId, route: 'page-panel', level: 'error',
        });
        return null;
      }
      const duration = Number(util.pageMeta?.().lengthSeconds) || 0;

      const meta = util.pageMeta();
      const payload = {
        segments,
        tracks: [{ lang: 'page', name: OSUM.t('transcriptFromPage'), auto: false }],
        meta: {
          ...meta,
          videoId: meta.videoId || videoId,
          lang: detectLang(segments),
          source: 'dom-panel',
          autoGenerated: false,
          chapters: getChapters(),
          wordCount: segments.reduce((a, s) => a + s.text.split(/\s+/).length, 0),
          url: location.href,
        },
      };
      journal({
        code: 'PAGE_TRANSCRIPT_OK',
        message: `${segments.length} фрагментов с панели, до ${Math.round(segments[segments.length - 1].start)}s из ${duration || '?'}s`,
        videoId, route: 'page-panel', level: 'ok', segments: segments.length,
      });
      // A read that started on the previous video must not answer for this one.
      if (!stale()) cached = { videoId: payload.meta.videoId, at: Date.now(), payload };
      return stale() ? null : payload;
    } finally {
      await cleanup();
    }
  }

  /** The transcript language decides the prompt/output language. */
  function detectLang(segments) {
    let cyr = 0;
    let lat = 0;
    for (const segment of (segments || []).slice(0, 60)) {
      const text = String(segment.text || '');
      for (const ch of text) {
        if (/[а-яё]/i.test(ch)) cyr++;
        else if (/[a-z]/i.test(ch)) lat++;
      }
    }
    if (!cyr && !lat) return 'ru';
    return cyr >= lat ? 'ru' : 'en';
  }

  function getChapters() {
    const out = [];
    const seen = new Set();
    for (const item of qa('ytd-macro-markers-list-item-renderer')) {
      const title = (q('#details h4, h4, .macro-markers', item)?.textContent || '').trim();
      const time = (q('#time, .ytd-macro-markers-list-item-renderer #time', item)?.textContent || '').trim();
      const at = parseClock(time);
      if (!title || at == null) continue;
      // The same marker is rendered in the player's chapter list more than once
      // (collapsed bar + expanded list); duplicates became duplicate sections.
      const key = `${at}|${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, at });
    }
    if (out.length >= 2) return out.sort((a, b) => a.at - b.at);
    return parseDescriptionChapters();
  }

  function parseDescriptionChapters() {
    const container = q('#description-inline-expander, #description, ytd-text-inline-expander');
    if (!container) return [];
    const text = textOf(container);
    const found = [];
    const re = /(^|\n)\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—•|:]?\s*(\S[^\n]{1,90})/g;
    let m;
    while ((m = re.exec(text))) {
      const at = parseClock(m[2]);
      if (at == null) continue;
      found.push({ title: m[3].trim(), at });
    }
    if (found.length < 2) return [];
    const ascending = found.every((c, i) => i === 0 || c.at > found[i - 1].at);
    return ascending && found[0].at <= 60 ? found.slice(0, 40) : [];
  }

  /** Parses pasted text: “00:12 line”, the panel's two-line layout, or prose. */
  function parsePasted(text) {
    const src = String(text || '').replace(/\r/g, '');
    if (!src.trim()) return null;
    const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);

    // The panel's own layout (timecode on its own line) and “0:12 text” lines.
    const asPanel = parseTranscriptText(src);
    if (asPanel.length >= 3) return { segments: asPanel, hasTimestamps: true };

    // Bracket layout from other tools: “[00:12] text”.
    const withTime = [];
    for (const line of lines) {
      const m = line.match(/^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?[\s,;:–—-]+(.+)$/);
      if (!m) continue;
      const at = parseClock(m[1]);
      if (at != null) withTime.push({ at, text: m[2].trim() });
    }
    if (withTime.length >= Math.max(2, lines.length * 0.4)) {
      const segments = withTime.map((item, i) => ({
        start: item.at,
        dur: i + 1 < withTime.length ? Math.max(1, withTime[i + 1].at - item.at) : 3,
        text: item.text,
      }));
      if (segments[0] && segments[0].start > 5) {
        segments.unshift({ start: 0, dur: Math.max(1, segments[0].start), text: 'Начало видео' });
      }
      return { segments, hasTimestamps: true };
    }

    // Plain prose: split into sentence-ish chunks so the engine can work.
    const chunks = src
      .split(/(?<=[.!?…])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.split(/\s+/).length >= 3);
    if (!chunks.length) return null;
    return { segments: chunks.map((text, i) => ({ start: i * 4, dur: 4, text })), hasTimestamps: false };
  }

  /* ------------------------------------------------- transcript from the page */

  // The extension's own request to youtubei/v1/get_transcript is answered with
  // HTTP 403 and YouTube's “Sorry…” page, while the very same call from the
  // page returns the transcript. The page bridge (page-bridge.js, injected into
  // the page world) makes that call with the page's cookies and visitor id.
  let bridgeReady = null;
  // The bridge announces itself with `{__osum:'response', id:'ready'}` as soon
  // as it runs. A page whose CSP refused the script never announces anything,
  // which is the only reliable difference between “loaded” and “blocked”.
  let bridgeAlive = false;
  // After a failure the bridge is not retried on every single call: the two
  // injections and their waits cost seconds, and a page where CSP refuses the
  // element would pay them on every read. A later read still gets a retry.
  let bridgeRetryAt = 0;

  function bridgeUrl() {
    try {
      return chrome.runtime.getURL('src/content/page-bridge.js');
    } catch {
      return '';
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin && event.origin !== location.origin) return;
    const data = event.data;
    if (data && data.__osum === 'response' && data.id === 'ready') bridgeAlive = true;
  });

  function waitBridge(ms) {
    if (bridgeAlive) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(ok);
      };
      function onMessage(event) {
        const data = event?.data;
        if (data && data.__osum === 'response' && data.id === 'ready') finish(true);
      }
      window.addEventListener('message', onMessage);
      // The ready message may have landed between the check above and here.
      if (bridgeAlive) {
        finish(true);
        return;
      }
      timer = setTimeout(() => finish(bridgeAlive), ms);
    });
  }

  /** Runs the same file in the page's world through the extension API. */
  async function injectBridgeThroughWorker() {
    try {
      const res = await util.sendMessage({ type: 'inject-page-bridge' });
      return !!res?.ok;
    } catch {
      return false;
    }
  }

  function addBridgeScript() {
    const url = bridgeUrl();
    if (!url) return false;
    try {
      if (document.querySelector('script[data-osum-bridge]')) return true;
      const script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.dataset.osumBridge = '1';
      (document.head || document.documentElement).appendChild(script);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Makes sure the page-world bridge is running.
   *
   * The `<script src="chrome-extension://…">` element is subject to the page's
   * CSP, and YouTube's script-src lists no extension origin: Chrome refuses the
   * element silently, the old code still resolved `true`, and every page route
   * then waited out a 25-second timeout on a bridge that was never there. The
   * extension API is not subject to the page CSP, so the same file is injected
   * with `scripting.executeScript({ world: 'MAIN' })` when the element is
   * refused. Success is decided by the bridge's own ready message, never by the
   * absence of an error event.
   */
  function ensureBridge() {
    if (bridgeAlive) return Promise.resolve(true);
    if (Date.now() < bridgeRetryAt) return Promise.resolve(false);
    if (bridgeReady) return bridgeReady;
    bridgeReady = (async () => {
      // Fast path: allowed wherever the page CSP lists the extension origin, and
      // the only route on a browser without a MAIN world (Firefox).
      addBridgeScript();
      if (await waitBridge(900)) return true;
      if (await injectBridgeThroughWorker()) {
        if (await waitBridge(1800)) return true;
      }
      // The element may still load late (a slow page, a CSP that changes).
      if (await waitBridge(600)) return true;
      // A failure is not remembered for ever: a retry, a reloaded player or a
      // bridge that finally arrives must be allowed to work. The caller journals
      // what it could not read; a missing bridge is only a reason, not the
      // verdict.
      bridgeReady = null;
      bridgeRetryAt = Date.now() + 30000;
      return false;
    })();
    return bridgeReady;
  }

  /**
   * Page-world scroll lock, best effort: it only exists while the bridge is
   * loaded, and a failure must never block the read.
   */
  async function lockPageScroll(on) {
    try {
      if (!(await ensureBridge())) return false;
      const res = await askPage('scroll-lock', { timeoutMs: 900, on: on === true });
      return !!res?.locked;
    } catch {
      return false;
    }
  }

  /** postMessage round-trip with the page bridge; null on any failure. */
  function askPage(kind, { timeoutMs = 25000, on, fields } = {}) {
    return new Promise((resolve) => {
      const id = `osum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        resolve(value);
      };
      function onMessage(event) {
        if (event.source !== window) return;
        if (event.origin && event.origin !== location.origin) return;
        const data = event.data;
        if (!data || data.__osum !== 'response' || data.id !== id) return;
        finish(data);
      }
      window.addEventListener('message', onMessage);
      try {
        const message = { __osum: 'request', id, kind };
        if (on !== undefined) message.on = on === true;
        if (fields && typeof fields === 'object') Object.assign(message, fields);
        window.postMessage(message, location.origin);
      } catch {
        finish(null);
        return;
      }
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  /**
   * Transcript via the page's own InnerTube session. This is the route that
   * works when the extension origin is refused and the DOM panel is only
   * partly rendered.
   */
  async function getTranscriptFromPageApi({ keepPanelOpen = false } = {}) {
    void keepPanelOpen;
    const videoId = util.getVideoId?.() || '';
    // `get_transcript` refuses some videos with 400 «Precondition check failed»
    // (stale params, client mismatch). Remember that and stop paying for a
    // request that will fail again on every retry of the same video — but only
    // for that one endpoint: the panel call below must still be tried.
    const skipLegacy = !!videoId && pageApiRejected === videoId;
    const bridge = await ensureBridge();
    if (!bridge) {
      journal({ code: 'BRIDGE_BLOCKED', message: 'скрипт моста не загрузился', videoId, route: 'page-api', level: 'warn' });
      return null;
    }
    /** Parses a page answer into the same payload shape as every other route. */
    const fromText = async (text, route, code) => {
      const parsed = await util.sendMessage({ type: 'parse-transcript', json: text }).catch((err) => {
        journal({ code: err?.code || 'PARSE_FAILED', message: String(err?.message || err), videoId, route, level: 'error' });
        return null;
      });
      const segments = (parsed?.segments || []).filter((s) => s && s.text);
      if (segments.length < 2) {
        journal({ code: 'EMPTY', message: `страница вернула ${segments.length} фрагментов`, videoId, route, level: 'error' });
        return null;
      }
      const meta = util.pageMeta();
      const payload = {
        segments,
        tracks: [{ lang: 'page', name: OSUM.t('transcriptFromPage'), auto: false }],
        meta: {
          ...meta,
          videoId: meta.videoId || videoId,
          lang: detectLang(segments),
          source: route,
          autoGenerated: false,
          chapters: getChapters(),
          wordCount: segments.reduce((a, s) => a + s.text.split(/\s+/).length, 0),
          url: location.href,
        },
      };
      journal({
        code,
        message: `${segments.length} фрагментов со страницы, до ${Math.round(segments[segments.length - 1].start)}s`,
        videoId, route, level: 'ok', segments: segments.length,
      });
      cached = { videoId: payload.meta.videoId, at: Date.now(), payload };
      return payload;
    };

    const answer = skipLegacy ? null : await askPage('get-transcript', { timeoutMs: 16000 });
    if (answer?.ok && answer.text) {
      const payload = await fromText(answer.text, 'page-api', 'PAGE_API_OK');
      if (payload) return payload;
    } else if (answer) {
      // 4xx means this route will not answer for this video at all; a network
      // hiccup is worth another try later.
      if (Number(answer.status) >= 400 && Number(answer.status) < 500) pageApiRejected = videoId;
      journal({
        code: answer.error || `HTTP_${answer.status || '?'}`,
        message: `get_transcript со страницы: ${String(answer.error || answer.text || '').replace(/\s+/g, ' ').slice(0, 120)}`,
        videoId, route: 'page-api', level: 'error',
      });
    } else if (!skipLegacy) {
      journal({ code: 'NO_RESPONSE', message: 'страница не ответила на запрос транскрипта', videoId, route: 'page-api', level: 'warn' });
    }

    // 2026-10: the panel's data comes from `get_panel`; the old endpoint answers
    // 400 for every video. Ask for the panel directly, before touching the DOM.
    const panel = await askPage('get-panel', { timeoutMs: 16000 });
    if (panel?.ok && panel.text) {
      const payload = await fromText(panel.text, 'page-panel-api', 'PAGE_PANEL_API_OK');
      if (payload) return payload;
    } else if (panel) {
      journal({
        code: panel.error || `HTTP_${panel.status || '?'}`,
        message: `get_panel со страницы: ${String(panel.error || panel.text || '').replace(/\s+/g, ' ').slice(0, 120)}`,
        videoId, route: 'page-panel-api', level: 'error',
      });
    }
    return null;
  }

  OSUM.register('transcriptDom', {
    getTranscript,
    getTranscriptFromPageApi,
    getChapters,
    parsePasted,
    parseClock,
    openTranscriptPanel,
    closeTranscriptPanel,
    matchesTranscriptLabel,
    parseTranscriptText,
    countTimecodes,
    detectLang,
    diagnose,
    rowsFromDom,
    rowsToSegments,
    scrapeSegments,
    switchToTranscriptTab,
    hasTranscriptPanel: () => transcriptSegmentsInDom().length > 0 || !!findTranscriptSurface(),
    transcriptKeywords: TRANSCRIPT_KEYWORDS,
    resetCache: () => {
      cached = null;
      readGeneration += 1;
    },
  });
})();
