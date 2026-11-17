/** Forgiving JSON parsing for LLM output: fences, prose, trailing commas. */

import { countWords, extractJsonBlock } from '../common/util.js';

export function sanitizeJsonText(text) {
  let s = String(text || '');
  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  s = convertSingleQuotes(s);
  s = convertPythonLiterals(s);
  s = s.replace(/,\s*([}\]])/g, '$1'); // trailing commas
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'); // unquoted keys
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  return s;
}

/** Converts 'single quoted' strings to "double quoted" (JSON-safe). */
function convertSingleQuotes(input) {
  let out = '';
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inDouble) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === "'") {
      let captured = '';
      let closed = false;
      let j = i + 1;
      for (; j < input.length; j++) {
        const c = input[j];
        if (c === '\\' && j + 1 < input.length) {
          const next = input[j + 1];
          if (next === "'") {
            captured += "'";
            j++;
            continue;
          }
          if (next === '"') {
            captured += '"';
            j++;
            continue;
          }
          captured += `${c}${next}`;
          j++;
          continue;
        }
        if (c === "'") {
          closed = true;
          break;
        }
        captured += c;
      }
      if (!closed) {
        out += ch;
        continue;
      }
      out += `"${captured.replace(/(?<!\\)"/g, '\\"')}"`;
      i = j;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * `True` / `False` / `None` are Python, not JSON, but small models emit them
 * often enough that a whole answer would otherwise be thrown away. Only bare
 * tokens outside string literals are replaced.
 */
function convertPythonLiterals(input) {
  const tokens = [
    ['True', 'true', 4],
    ['False', 'false', 5],
    ['None', 'null', 4],
  ];
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    const token = tokens.find(([word]) => input.startsWith(word, i));
    if (token) {
      const [word, replacement] = token;
      const next = input[i + word.length] || '';
      const previous = i > 0 ? input[i - 1] : '';
      if (!/[A-Za-z0-9_$]/.test(next) && !/[A-Za-z0-9_$]/.test(previous)) {
        out += replacement;
        i += word.length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}
/** Field descriptions from the schema are not content; they must not win. */
const SCHEMA_PLACEHOLDER = /^(?:строка|тезис|тема|цитата|текст|пример|число|короткий заголовок|mm:ss|\.{2,}|…|<[^>]*>)/i;

/**
 * Rough amount of real text inside a parsed JSON value. Used to choose between
 * several balanced blocks in one answer: a weak model sometimes prints the
 * schema example first and the actual summary after it.
 */
function jsonContentWeight(value, depth = 0) {
  if (value == null || depth > 6) return 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || SCHEMA_PLACEHOLDER.test(text)) return 0;
    return Math.min(countWords(text), 200);
  }
  if (typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    let weight = Math.min(value.length, 20);
    for (const item of value) weight += jsonContentWeight(item, depth + 1);
    return weight;
  }
  let weight = Math.min(Object.keys(value).length, 20);
  for (const key of Object.keys(value)) weight += jsonContentWeight(value[key], depth + 1);
  return weight;
}

/** Parses the most substantive balanced {...} / [...] block of an answer. */
function bestJsonBlock(text) {
  const source = String(text || '');
  const blocks = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = findJsonClose(source, i);
    // An unclosed block owns the rest of the answer: every brace after it is
    // inside. Picking a complete nested fragment would turn a cut-off stream
    // into a “summary” of one point instead of the truncation error it is.
    if (end < 0) break;
    blocks.push(source.slice(i, end));
    i = end - 1;
    if (blocks.length >= 20) break;
  }
  let best = null;
  for (const block of blocks) {
    for (const candidate of [block, sanitizeJsonText(block)]) {
      try {
        const value = JSON.parse(candidate);
        if (!value || typeof value !== 'object') break;
        const weight = jsonContentWeight(value);
        if (!best || weight > best.weight) best = { value, weight };
        break;
      } catch {
        // try the sanitized copy, then the next block
      }
    }
  }
  if (!best) throw new Error('в ответе нет разбираемого JSON-блока');
  return best.value;
}

/**
 * Tries several strategies to turn a model answer into an object.
 * @returns {{ok: boolean, value: any, strategy: string, error?: string}}
 */
export function parseAiJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, value: null, strategy: 'empty', error: 'Пустой ответ модели' };

  const attempts = [
    ['direct', () => JSON.parse(raw)],
    ['sanitized', () => JSON.parse(sanitizeJsonText(raw))],
    // Before the fence: the first block in the text may be a schema echo while
    // the real summary is the second one.
    ['blocks', () => bestJsonBlock(raw)],
    ['fence', () => JSON.parse(sanitizeJsonText(extractJsonBlock(raw) || ''))],
  ];
  for (const [strategy, fn] of attempts) {
    try {
      const value = fn();
      if (value && typeof value === 'object') return { ok: true, value, strategy };
    } catch (err) {
      // try next strategy
      if (strategy === 'fence') return { ok: false, value: null, strategy, error: String(err.message || err) };
    }
  }
  return { ok: false, value: null, strategy: 'failed', error: 'Не удалось разобрать JSON из ответа модели' };
}

/** Reads one JSON string starting at `start` (which must be a quote). */
function readJsonString(source, start) {
  let escaped = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      const raw = source.slice(start, i + 1);
      try {
        return { value: JSON.parse(raw), end: i + 1, closed: true };
      } catch {
        return { value: null, end: i + 1, closed: false };
      }
    }
  }
  return { value: null, end: source.length, closed: false };
}

/** Finds the matching `}`/`]` for a nested value, ignoring brackets in strings. */
function findJsonClose(source, start) {
  const open = source[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Collects complete elements of an array that may itself be cut off. A complete
 * section or point before the cut is real data and must not be thrown away;
 * an incomplete tail element is dropped, never guessed.
 */
function readJsonArrayItems(source, start) {
  const items = [];
  let i = start + 1;
  const skip = (j) => {
    while (j < source.length && /\s/.test(source[j])) j++;
    return j;
  };
  for (;;) {
    i = skip(i);
    if (i >= source.length) return { items, end: source.length, closed: false };
    if (source[i] === ']') return { items, end: i + 1, closed: true };
    if (source[i] === ',') {
      i++;
      continue;
    }
    let end = -1;
    if (source[i] === '{' || source[i] === '[') {
      end = findJsonClose(source, i);
    } else if (source[i] === '"') {
      const str = readJsonString(source, i);
      end = str.closed ? str.end : -1;
    } else {
      const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
      if (match) end = i + match[0].length;
    }
    if (end < 0) return { items, end: source.length, closed: false };
    try {
      items.push(JSON.parse(source.slice(i, end)));
    } catch {
      return { items, end: source.length, closed: false };
    }
    i = skip(end);
    if (source[i] === ']') return { items, end: i + 1, closed: true };
    if (source[i] !== ',') return { items, end: source.length, closed: false };
    i++;
  }
}

/**
 * Last-resort recovery for a response cut off by `max_tokens`. It returns only
 * complete top-level fields and complete array elements of the truncated JSON;
 * callers must mark the result incomplete. It never closes an unterminated
 * string or invents a missing value.
 */
export function salvageAiJson(text) {
  const raw = String(text || '').trim();
  const first = raw.indexOf('{');
  if (first < 0) return { ok: false, value: null, fields: 0 };
  const source = raw.slice(first);
  const value = {};
  let fields = 0;
  let i = 1;
  const skip = (j) => {
    while (j < source.length && /\s/.test(source[j])) j++;
    return j;
  };
  for (;;) {
    i = skip(i);
    if (i >= source.length || source[i] === '}') break;
    if (source[i] === ',') {
      i++;
      continue;
    }
    if (source[i] !== '"') break;
    const key = readJsonString(source, i);
    if (!key.closed) break;
    i = skip(key.end);
    if (source[i] !== ':') break;
    i = skip(i + 1);
    if (i >= source.length) break;
    if (source[i] === '"') {
      const str = readJsonString(source, i);
      if (!str.closed) break;
      value[key.value] = str.value;
      fields++;
      i = str.end;
    } else if (source[i] === '[') {
      const arr = readJsonArrayItems(source, i);
      value[key.value] = arr.items;
      if (arr.items.length) fields++;
      i = arr.end;
      if (!arr.closed) break;
    } else if (source[i] === '{') {
      const end = findJsonClose(source, i);
      if (end < 0) break;
      try {
        value[key.value] = JSON.parse(source.slice(i, end));
        fields++;
      } catch {
        break;
      }
      i = end;
    } else {
      const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
      if (!match) break;
      value[key.value] = JSON.parse(match[0]);
      fields++;
      i += match[0].length;
    }
    i = skip(i);
    if (source[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  const hasContent = Object.keys(value).some((key) => {
    const v = value[key];
    if (Array.isArray(v)) return v.length > 0;
    return v != null && String(v).trim() !== '';
  });
  return { ok: hasContent, value: hasContent ? value : null, fields };
}

/** Extracts an array of strings from a loose model field. */
export function toStringArray(value, limit = 12) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((v) => (typeof v === 'string' ? v : v?.text || v?.point || v?.value || ''))
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}
