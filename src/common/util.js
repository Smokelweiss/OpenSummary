/** Small dependency-free helpers shared by every module. */

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Fast, stable 32-bit FNV-1a hash, returned as a short base36 string. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function normalizeWhitespace(str) {
  return String(str || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

export function squash(str) {
  return normalizeWhitespace(str).toLowerCase();
}

/** Seconds -> "h:mm:ss" | "m:ss". */
export function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** "1:02:03" | "02:03" | " 63 " | "1h2m3s" -> seconds (or null). */
export function parseTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const str = String(value).trim();
  if (!str) return null;
  const hm = str.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  if (hm) {
    const h = hm[1] ? parseInt(hm[1], 10) : 0;
    return h * 3600 + parseInt(hm[2], 10) * 60 + parseInt(hm[3], 10);
  }
  const verbose = str.match(/^(?:(\d{1,3})\s*h)?\s*(?:(\d{1,3})\s*m)?\s*(?:(\d{1,3})\s*s)?$/i);
  if (verbose && (verbose[1] || verbose[2] || verbose[3])) {
    return (
      (parseInt(verbose[1] || '0', 10) || 0) * 3600 +
      (parseInt(verbose[2] || '0', 10) || 0) * 60 +
      (parseInt(verbose[3] || '0', 10) || 0)
    );
  }
  const plain = str.match(/^(\d{1,6})$/);
  if (plain) return parseInt(plain[1], 10);
  return null;
}

export function truncate(str, max, suffix = '…') {
  const s = String(str || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - suffix.length));
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + suffix;
}

export function capitalize(str) {
  const s = String(str || '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function titleCase(str) {
  return String(str || '')
    .split(/\s+/)
    .map((w) => (w.length > 3 ? capitalize(w) : w))
    .join(' ');
}

export function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? patch.slice() : base.slice();
  if (!isPlainObject(base)) return patch === undefined ? base : patch;
  const out = { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(base[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function uniq(arr) {
  return Array.from(new Set(arr));
}

export function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Waits `ms`; with a signal, rejects as soon as that signal aborts. */
export function sleep(ms, signal = null) {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error('abort'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('abort'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Extracts the first `{...}` / `[...]` JSON document from an LLM answer. */
export function extractJsonBlock(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(s);
  for (const candidate of candidates) {
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const slice = candidate.slice(start);
    const balanced = takeBalanced(slice);
    if (balanced) return balanced;
  }
  return null;
}

function takeBalanced(str) {
  const open = str[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return str.slice(0, i + 1);
    }
  }
  return null;
}

export function countWords(text) {
  const m = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

/**
 * Text a reader actually sees in a summary. Headings, quotes and keywords are
 * included because they are rendered too; timestamps, scores and metadata are
 * not. Both engines use this so “compression” means the same thing.
 */
export function summaryBodyText(result) {
  const r = result || {};
  const parts = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text) parts.push(text);
  };
  push(r.tldr);
  for (const section of Array.isArray(r.sections) ? r.sections : []) {
    push(section?.heading);
    push(section?.summary);
    for (const point of Array.isArray(section?.points) ? section.points : []) push(point?.text);
  }
  for (const point of Array.isArray(r.keyPoints) ? r.keyPoints : []) push(point?.text ?? point);
  for (const key of ['takeaways', 'actionItems', 'questions']) {
    for (const item of Array.isArray(r[key]) ? r[key] : []) push(item?.text ?? item);
  }
  for (const quote of Array.isArray(r.quotes) ? r.quotes : []) push(quote?.text ?? quote);
  const keywords = (Array.isArray(r.keywords) ? r.keywords : []).map((k) => (typeof k === 'string' ? k : k?.term));
  if (keywords.length) parts.push(keywords.join(', '));
  return parts.join(' ');
}

/**
 * Deterministic volume stats for one summary: transcript words from the exact
 * source text that was processed, summary words from the final rendered body,
 * and compression as summaryWords / transcriptWords.
 */
export function computeSummaryStats(result, transcriptWords) {
  const words = Math.max(0, Number(transcriptWords) || 0);
  const summaryWords = countWords(summaryBodyText(result));
  return {
    summaryWords,
    readingTimeSec: Math.round((summaryWords / 190) * 60),
    compression: words ? Math.round((summaryWords / words) * 1000) / 1000 : 0,
  };
}

export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function safeFilename(name) {
  return String(name || 'summary')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'summary';
}

/**
 * A URL that is safe to put into an `href` of an extension page: only http(s).
 * Anything else (`javascript:`, `data:`, `file:`) returns '' so the caller can
 * render plain text instead. Settings files are importable, so a providers'
 * `docs`/`keyUrl` field is not automatically trusted.
 */
export function safeHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}
