/** Shadow-DOM stylesheet for the OpenSummary panel (injected as a JS string). */

(function () {
  const OSUM = window.OSUM;

  const CSS = `
:host { all: initial; }

.osum-root {
  --osum-accent: #6d5efc;
  --osum-accent-soft: rgba(109, 94, 252, 0.14);
  --osum-accent-2: #9b8cff;
  --osum-good: #2ecc71;
  --osum-warn: #f5a623;
  --osum-bad: #ff5c5c;
  --osum-bg: #ffffff;
  --osum-panel: #ffffff;
  --osum-card: #f5f6fb;
  --osum-card-2: #eceefa;
  --osum-border: #e1e5f0;
  --osum-text: #14161c;
  --osum-muted: #5d6579;
  --osum-shadow: 0 18px 48px rgba(18, 20, 32, 0.22);
  --osum-radius: 12px;
  --osum-width: 420px;
  font-family: "YouTube Sans", Roboto, "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: var(--osum-text);
  text-align: left;
  letter-spacing: normal;
  position: fixed;
  z-index: 2147483000;
  inset: auto 0 0 auto;
  pointer-events: none;
  box-sizing: border-box;
}

/*
 * Dark palette follows YouTube's own transcript panel: neutral greys, not the
 * blue-tinted slate this panel used to wear. Next to “В этом видео” a bluish box
 * read as a foreign window, and the panel is usually docked right beside it.
 * #212121 surface, #272727 raised, #303030 hairline — the same ladder YouTube
 * uses for its cards and menus.
 */
.osum-root[data-theme="dark"] {
  --osum-bg: #0f0f0f;
  --osum-panel: #212121;
  --osum-card: #272727;
  --osum-card-2: #303030;
  --osum-border: #3f3f3f;
  --osum-text: #f1f1f1;
  --osum-muted: #aaaaaa;
  /* Neutral tint, not the brand violet at 22%: a violet wash on a grey panel
     reads as a different product. YouTube tints its rows with white. */
  --osum-accent-soft: rgba(255, 255, 255, 0.08);
  --osum-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
}

.osum-root * { box-sizing: border-box; }

/* Docked mode: the host lives inside the YouTube sidebar, so the panel must be
   a normal in-flow block there. Keeping position:fixed inside a container (or a
   contain:layout host) collapses it to zero height. */
.osum-root[data-docked="true"] {
  position: static;
  inset: auto;
  width: 100%;
  pointer-events: auto;
}

.osum-root[data-docked="true"] .osum-panel {
  position: static;
  inset: auto;
  width: 100%;
  max-width: 100%;
  /* The panel lives in the sidebar, where a 640px cap left a third of the
     viewport empty under it. It now takes the rest of the screen, minus the
     masthead and a small bottom gap. */
  height: calc(100vh - 96px);
  height: calc(100dvh - 96px);
  min-height: 560px;
  max-height: none;
  margin-bottom: 12px;
  animation: none;
}

.osum-fab {
  pointer-events: auto;
  position: fixed;
  right: 22px;
  bottom: 22px;
  width: 48px;
  height: 48px;
  border: 0;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--osum-accent), var(--osum-accent-2));
  color: #fff;
  display: grid;
  place-items: center;
  cursor: pointer;
  box-shadow: 0 10px 26px rgba(60, 48, 190, 0.42);
  transition: transform 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease;
  font: inherit;
}
.osum-fab:hover { transform: translateY(-2px) scale(1.03); }
.osum-fab[hidden] { display: none; }
.osum-fab .osum-icon { width: 22px; height: 22px; }

.osum-panel {
  pointer-events: auto;
  position: fixed;
  right: 18px;
  top: 64px;
  bottom: 12px;
  width: var(--osum-width);
  max-width: calc(100vw - 24px);
  display: flex;
  flex-direction: column;
  background: var(--osum-panel);
  color: var(--osum-text);
  border: 1px solid var(--osum-border);
  border-radius: var(--osum-radius);
  box-shadow: var(--osum-shadow);
  overflow: hidden;
  transform-origin: 100% 100%;
  animation: osum-in 0.18s ease;
}
.osum-panel[hidden] { display: none; }
@keyframes osum-in {
  from { opacity: 0; transform: translateY(8px) scale(0.99); }
  to { opacity: 1; transform: none; }
}

/* The header is pure navigation: tabs on the left, actions on the right. */
.osum-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 0 4px;
  border-bottom: 1px solid var(--osum-border);
  background: var(--osum-panel);
}
.osum-head-actions { display: flex; gap: 2px; margin-left: auto; padding-bottom: 3px; }

.osum-icon-btn {
  border: 0; background: transparent; color: var(--osum-muted);
  width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center;
  cursor: pointer; font: inherit; transition: background 0.14s ease, color 0.14s ease;
}
.osum-icon-btn:hover { background: var(--osum-card-2); color: var(--osum-text); }
/* Sun/moon are emoji: they need a font size, not an SVG viewBox. */
.osum-emoji-btn {
  font-size: 15px; line-height: 1;
  font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
}
/* The primary action: words, an icon and a real hit area. It is the one thing
   a first-time reader is supposed to press, so it is taller than the icon
   buttons instead of shrinking to their size. */
.osum-head-actions .osum-run {
  height: 36px; padding: 0 15px; border-radius: 10px;
  font-size: 13.5px; font-weight: 650; letter-spacing: 0.01em; margin-left: 0;
  gap: 7px; box-shadow: 0 4px 14px rgba(85, 68, 220, 0.28);
}
.osum-head-actions .osum-run .osum-icon { width: 17px; height: 17px; }
.osum-head-actions .osum-run[aria-busy="true"] { background: var(--osum-card-2); color: var(--osum-text); border-color: var(--osum-border); }
.osum-icon-btn[disabled] { opacity: 0.45; cursor: default; background: transparent; }

/* One primary action, then the folded-away settings. */
.osum-actions-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 6px; }
.osum-actions-row .osum-btn { font-size: 12px; }

.osum-quick {
  margin: 10px 10px 0; padding: 6px;
  border: 1px solid var(--osum-border); border-radius: var(--osum-radius);
  background: var(--osum-card);
}
.osum-quick[hidden] { display: none; }
/* One line: the controls, then “All settings” against the right edge. In
   “No AI” mode that is genuinely one line; AI mode adds a provider, a model and
   a refresh button, so the controls wrap there instead of being cut off. */
.osum-quick-row { display: flex; align-items: flex-start; gap: 4px; }
.osum-quick-row .osum-controls {
  flex: 1 1 auto; flex-wrap: wrap; padding: 0; gap: 4px; min-width: 0;
}
.osum-quick-row .osum-select { min-width: 0; max-width: 92px; padding: 5px 18px 5px 7px; font-size: 11.5px; }
.osum-quick-all { flex: none; margin-left: auto; font-size: 10.5px; padding: 4px 7px; white-space: nowrap; }

.osum-controls { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 12px 10px; }

.osum-select {
  appearance: none; -webkit-appearance: none;
  background: var(--osum-card) url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23888f9f'><path d='M7 10l5 5 5-5z'/></svg>") no-repeat right 4px center;
  background-size: 18px 18px;
  color: var(--osum-text); border: 1px solid var(--osum-border); border-radius: 9px;
  padding: 6px 22px 6px 9px; font: inherit; font-size: 12px; max-width: 100%; cursor: pointer;
}
.osum-select:focus-visible, .osum-btn:focus-visible, .osum-icon-btn:focus-visible { outline: 2px solid var(--osum-accent); outline-offset: 1px; }

.osum-btn {
  border: 1px solid var(--osum-border); background: var(--osum-card); color: var(--osum-text);
  border-radius: 9px; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; transition: background 0.14s ease, border-color 0.14s ease;
}
.osum-btn:hover { background: var(--osum-card-2); }
.osum-btn .osum-icon { width: 14px; height: 14px; }
.osum-btn-primary {
  background: linear-gradient(135deg, var(--osum-accent), var(--osum-accent-2));
  border-color: transparent; color: #fff; font-weight: 600; margin-left: auto;
}
.osum-btn-primary:hover { filter: brightness(1.06); background: linear-gradient(135deg, var(--osum-accent), var(--osum-accent-2)); }
.osum-btn-danger { color: var(--osum-bad); border-color: rgba(255, 92, 92, 0.4); }
.osum-btn[disabled] { opacity: 0.55; cursor: not-allowed; }

.osum-resume { padding: 0 12px 6px; }
.osum-resume[hidden] { display: none; }
.osum-resume .osum-hint { margin-top: 2px; }
/* Breathing room under the tabs: the status line was glued to the active tab's
   underline, which read as a missing block rather than a choice. */
.osum-status { padding: 14px 14px 10px; display: flex; flex-direction: column; gap: 6px; }
.osum-status[hidden] { display: none; }
.osum-status-line { display: flex; align-items: center; gap: 8px; color: var(--osum-muted); font-size: 12px; }
.osum-status-line .osum-spin {
  width: 13px; height: 13px; border-radius: 50%; flex: none;
  border: 2px solid var(--osum-accent-soft); border-top-color: var(--osum-accent);
  animation: osum-spin 0.8s linear infinite;
}
@keyframes osum-spin { to { transform: rotate(360deg); } }
.osum-bar { height: 4px; border-radius: 3px; background: var(--osum-card-2); overflow: hidden; }
.osum-bar > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--osum-accent), var(--osum-accent-2)); transition: width 0.25s ease; }
/* Live draft of a single-pass answer: real cards, not raw streamed text. */
.osum-live { display: flex; flex-direction: column; gap: 8px; }
.osum-live .osum-card:first-of-type { border-color: var(--osum-accent-soft); }

.osum-tabs { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.osum-tabs::-webkit-scrollbar { display: none; }
.osum-tab {
  border: 0; background: transparent; color: var(--osum-muted); font: inherit; font-size: 12px;
  padding: 9px 9px 7px; border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap;
}
.osum-tab[aria-selected="true"] { color: var(--osum-text); border-bottom-color: var(--osum-accent); font-weight: 600; }
.osum-tab:hover { color: var(--osum-text); }

.osum-body { flex: 1; overflow-y: auto; padding: 14px 14px 18px; scrollbar-width: thin; }
.osum-body::-webkit-scrollbar { width: 9px; }
.osum-body::-webkit-scrollbar-thumb { background: var(--osum-card-2); border-radius: 6px; }

.osum-card { background: var(--osum-card); border: 1px solid var(--osum-border); border-radius: var(--osum-radius); padding: 10px 12px; margin-bottom: 10px; }
.osum-card-tldr { background: var(--osum-accent-soft); border-color: transparent; }
.osum-h { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--osum-muted); font-weight: 700; margin: 0 0 7px; display: flex; align-items: center; gap: 6px; }
.osum-tldr-text { font-size: 13.5px; line-height: 1.5; }
.osum-p { margin: 0 0 8px; }
.osum-p:last-child { margin-bottom: 0; }

.osum-points { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
/* A moment is one block: the timecode and every point that starts at that
   second. The button is the whole row, so hovering the number highlights the
   text next to it and clicking anywhere seeks — not only the words. */
.osum-point {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px; align-items: start;
  width: 100%; margin: 0; padding: 2px 5px; border: 0; border-radius: 8px;
  background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer;
  transition: background-color 0.12s ease;
}
.osum-point:hover { background: var(--osum-card); }
.osum-point:focus-visible { outline: 2px solid var(--osum-accent); outline-offset: 1px; }
.osum-stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.osum-line { display: block; }
.osum-dot { color: var(--osum-muted); margin-right: 7px; }
.osum-untimed { min-width: 0; }
.osum-point .osum-ts { margin-top: 1px; }
/* Every timecode is the same small accent chip, wherever it is rendered. Before
   this rule, a timestamp outside a key-point list was a bare <button> and used
   the browser's white-on-light colours on a dark panel. */
.osum-ts {
  appearance: none; -webkit-appearance: none;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px; line-height: 1.45; padding: 1px 5px; border-radius: 6px;
  background: var(--osum-card-2); color: var(--osum-accent);
  border: 1px solid transparent; cursor: pointer;
}
/* No hover ring and no underline on a timecode: the whole moment is the link,
   and the number is part of its plate. An underline under “4:04” alone read as
   a separate, half-styled link. */
.osum-ts:hover { border-color: transparent; text-decoration: none; }
.osum-ts.osum-chip { color: var(--osum-accent); }
.osum-point .osum-ts { flex: none; margin-top: 1px; }
.osum-text { flex: 1; }
.osum-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--osum-card-2); border: 1px solid var(--osum-border); border-radius: 999px; padding: 2px 9px; font-size: 11px; color: var(--osum-muted); }
.osum-chip-strong { color: var(--osum-text); font-weight: 600; }
.osum-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.osum-chips-scroll { max-height: 120px; overflow: auto; }

.osum-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: 8px; min-width: 0; }
.osum-stat { background: var(--osum-card); border: 1px solid var(--osum-border); border-radius: 10px; padding: 7px 9px; }
.osum-stat b { display: block; font-size: 15px; overflow-wrap: anywhere; }
.osum-stat span { overflow-wrap: anywhere; }
.osum-stat span { color: var(--osum-muted); font-size: 11px; }

.osum-sections { display: flex; flex-direction: column; gap: 10px; }
.osum-section { border-left: 2px solid var(--osum-accent); padding-left: 10px; }
.osum-section-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 4px; }
.osum-section-head h3 { margin: 0; font-size: 13px; }

.osum-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.osum-tag { background: var(--osum-card-2); border-radius: 8px; padding: 3px 8px; cursor: pointer; border: 1px solid transparent; }
.osum-tag:hover { border-color: var(--osum-accent); }

.osum-qa-input { display: flex; gap: 6px; margin-bottom: 10px; }
.osum-input {
  flex: 1; background: var(--osum-card); color: var(--osum-text); border: 1px solid var(--osum-border);
  border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 12.5px; min-width: 0;
}
.osum-input:focus-visible { outline: 2px solid var(--osum-accent); outline-offset: 1px; }
textarea.osum-input { resize: vertical; min-height: 76px; }
.osum-msg { border-radius: 10px; padding: 9px 11px; margin-bottom: 8px; border: 1px solid var(--osum-border); background: var(--osum-card); }
.osum-msg-user { background: var(--osum-accent-soft); border-color: transparent; }
.osum-msg-head { font-size: 11px; color: var(--osum-muted); margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
.osum-source { display: flex; gap: 7px; align-items: flex-start; padding: 5px 0; border-top: 1px dashed var(--osum-border); font-size: 12px; }
.osum-source:first-of-type { border-top: 0; }

.osum-transcript-tools { display: flex; gap: 6px; margin-bottom: 8px; }
.osum-transcript { display: flex; flex-direction: column; gap: 2px; }
.osum-mark { background: rgba(255, 214, 0, 0.4); color: inherit; border-radius: 3px; }

.osum-foot { border-top: 1px solid var(--osum-border); padding: 7px 10px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--osum-muted); font-size: 11px; }
.osum-foot .osum-btn { padding: 4px 9px; font-size: 11px; }

/*
 * Everything about the run, folded at the bottom of the panel. The body is part
 * of the panel's own scroll: its own max-height/overflow put a second scrollbar
 * on top of the content it was supposed to scroll.
 */
.osum-runs { border-top: 1px solid var(--osum-border); margin-top: 14px; padding-top: 4px; min-width: 0; }
.osum-runs[hidden] { display: none; }
.osum-runs > summary {
  cursor: pointer; padding: 7px 0 5px; color: var(--osum-muted);
  font-size: 11.5px; font-weight: 600; list-style: none; border-radius: 6px;
}
.osum-runs > summary:hover { color: var(--osum-text); }
.osum-runs > summary::-webkit-details-marker { display: none; }
.osum-runs > summary::before { content: '▸'; display: inline-block; margin-right: 6px; transition: transform 0.14s ease; }
.osum-runs[open] > summary::before { transform: rotate(90deg); }
/* One column rhythm for every block in the folded section: the old rules left
   the cards touching each other and the token line glued to the stats grid. */
.osum-runs-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 0 6px; min-width: 0; }
.osum-runs-body > * { margin: 0; min-width: 0; }
.osum-runs-body > .osum-card { padding: 9px 11px; }
.osum-runs-body .osum-hint { margin: 0; }
.osum-runs-body .osum-chip-row { row-gap: 6px; }
.osum-grounding { border-left: 2px solid var(--osum-accent); padding-left: 8px; margin: 0; }
.osum-spacer { margin-left: auto; }

.osum-error { border: 1px solid rgba(255, 92, 92, 0.45); background: rgba(255, 92, 92, 0.08); border-radius: 10px; padding: 10px 12px; }
.osum-error h4 { margin: 0 0 4px; font-size: 13px; color: var(--osum-bad); }
.osum-error p { margin: 0 0 8px; color: var(--osum-text); }
.osum-error .osum-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.osum-error pre { background: var(--osum-card); border-radius: 8px; padding: 8px; overflow: auto; max-height: 160px; font-size: 11px; }

.osum-empty { text-align: center; color: var(--osum-muted); padding: 22px 12px; }
.osum-empty .osum-icon { width: 26px; height: 26px; opacity: 0.6; }
.osum-hint { color: var(--osum-muted); font-size: 11.5px; margin-top: 6px; }
.osum-diag { background: var(--osum-card); border: 1px solid var(--osum-border); border-radius: var(--osum-radius); padding: 8px 12px; margin-bottom: 10px; font-size: 11.5px; }
.osum-diag summary { cursor: pointer; color: var(--osum-muted); font-weight: 600; }
.osum-diag-grid { display: grid; gap: 4px; margin-top: 8px; }
.osum-diag-row { display: flex; justify-content: space-between; gap: 12px; border-top: 1px dashed var(--osum-border); padding-top: 4px; }
.osum-diag-row span { color: var(--osum-muted); }
.osum-diag-row b { font-weight: 500; text-align: right; word-break: break-word; }
.osum-status-budget { font-variant-numeric: tabular-nums; }

/*
 * A section heading that seeks: the timecode chip and the words are one button.
 * Hover paints the whole row with a soft plate (what Yandex's summariser does);
 * an underline across two lines of heading read as a broken link.
 */
/* Grid, not flex: the heading and its summary are one plate, and the summary
   has to start under the words, not under the timecode. Hovering the paragraph
   highlights the whole block, timecode included. */
.osum-section-title {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px; align-items: start;
  width: 100%; margin: 0 -7px; padding: 4px 7px;
  background: none; border: 0; border-radius: 8px;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  transition: background-color 0.12s ease;
}
.osum-section-title .osum-h3 { display: block; font-size: 14.5px; font-weight: 600; line-height: 1.35; text-decoration: none; }
.osum-section-title .osum-sec-summary { display: block; margin-top: 5px; font-size: 13.5px; line-height: 1.55; }
.osum-section-title > .osum-ts { margin-top: 2px; }
.osum-section-title:hover { background: var(--osum-card); }
.osum-section-title:focus-visible { outline: 2px solid var(--osum-accent); outline-offset: 1px; }
.osum-section-title[aria-disabled="true"] { cursor: default; }
.osum-section-title[aria-disabled="true"]:hover { background: none; }

/* On-demand translation of a local summary. */
.osum-translate { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.osum-translate .osum-hint { margin: 0; flex: 1 1 180px; }

.osum-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 2px 7px; border-radius: 999px; background: var(--osum-card-2); color: var(--osum-muted); }
.osum-badge-ai { background: var(--osum-accent-soft); color: var(--osum-accent); font-weight: 600; }
.osum-badge-ok { color: var(--osum-good); }
.osum-badge-warn { color: var(--osum-warn); }

.osum-toasts { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; }
.osum-toast {
  background: var(--osum-text); color: var(--osum-bg); border-radius: 9px; padding: 7px 13px; font-size: 12px;
  opacity: 0; transform: translateY(8px); transition: opacity 0.2s ease, transform 0.2s ease; box-shadow: var(--osum-shadow);
  max-width: 320px; text-align: center;
}
.osum-toast-in { opacity: 1; transform: none; }
.osum-toast-error { background: var(--osum-bad); color: #fff; }

.osum-skeleton { height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--osum-card), var(--osum-card-2), var(--osum-card)); background-size: 200% 100%; animation: osum-shimmer 1.2s infinite linear; margin-bottom: 8px; }
@keyframes osum-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.osum-resize {
  position: absolute; left: 0; top: 0; bottom: 0; width: 6px; cursor: ew-resize; background: transparent;
}
.osum-resize:hover { background: var(--osum-accent-soft); }

.osum-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.osum-list li { display: flex; gap: 8px; align-items: flex-start; }
.osum-list .osum-icon { flex: none; margin-top: 3px; color: var(--osum-accent); width: 13px; height: 13px; }

/*
 * Reading view. The summary is a document: a lead, then headed blocks separated
 * by hairlines. No tinted cards, no accent bars, no uppercase tracked labels —
 * those read as a dashboard of features rather than something written about
 * the video. The accent is spent on timecodes and focus, nothing else.
 */
.osum-doc { font-size: 14px; line-height: 1.6; }
.osum-doc .osum-card { background: none; border: 0; border-radius: 0; padding: 0; margin: 0 0 18px; }
.osum-doc .osum-card + .osum-card { border-top: 1px solid var(--osum-border); padding-top: 16px; }
.osum-doc .osum-card-tldr { background: none; border: 0; }
.osum-doc .osum-tldr-text { font-size: 15px; line-height: 1.55; }
.osum-doc .osum-h {
  font-size: 12px; font-weight: 600; text-transform: none; letter-spacing: 0;
  color: var(--osum-muted); margin-bottom: 9px;
}
.osum-doc .osum-section { border-left: 0; padding-left: 0; }
.osum-doc .osum-section + .osum-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--osum-border); }
.osum-doc .osum-section-head { align-items: baseline; gap: 8px; margin-bottom: 5px; }
.osum-doc .osum-section-head h3 { font-size: 14.5px; font-weight: 600; line-height: 1.35; }
.osum-doc .osum-ts { background: none; border: 0; padding: 0; font-weight: 500; }
.osum-doc .osum-ts:hover { border: 0; text-decoration: none; }
.osum-doc .osum-points { gap: 7px; }
/* Grid, not flex: a wrapped line must start under the text, not under the
   timecode. */
.osum-doc .osum-point { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px; align-items: start; }
.osum-doc .osum-point .osum-ts { margin-top: 2px; }
.osum-doc .osum-point .osum-text { min-width: 0; }
.osum-doc .osum-p { margin-bottom: 6px; }
.osum-doc .osum-bullets li { display: block; position: relative; padding-left: 14px; }
.osum-doc .osum-bullets li::before { content: '•'; position: absolute; left: 2px; top: 0; color: var(--osum-muted); }
.osum-doc .osum-bullets .osum-text { display: inline; }

@media (max-width: 720px) {
  .osum-panel { right: 6px; left: 6px; top: 56px; bottom: 6px; width: auto; }
  .osum-fab { right: 12px; bottom: 12px; }
}

/* The panel is often docked narrow; the header must stay one row. */
@media (max-width: 420px) {
  .osum-head { padding-left: 10px; padding-right: 6px; }
  .osum-tab { padding: 7px 5px; font-size: 12px; }
  .osum-head-actions { gap: 0; }
  .osum-icon-btn { width: 26px; }
  .osum-doc { font-size: 13.5px; }
}

@media (prefers-reduced-motion: reduce) {
  .osum-panel, .osum-toast, .osum-fab { animation: none; transition: none; }
}
`;

  OSUM.register('css', CSS);
})();
