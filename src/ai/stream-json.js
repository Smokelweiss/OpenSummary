/**
 * Incremental extraction of summary items from a streamed JSON answer.
 *
 * A single-pass response is one JSON object, so the final result only exists
 * after the closing brace. The user does not have to wait for that: a key
 * point, a section or the TL;DR becomes final the moment its own value is
 * closed and passes the same validation the full parse uses. This module
 * tracks only structural positions, so feeding a 50 KB answer costs O(total
 * characters) — not one re-parse per delta.
 *
 * It deliberately does not try to be a general JSON parser: only the fields
 * the panel can usefully show early are materialised, everything else is
 * skipped by brace/bracket counting.
 */

import { normalizePoint, normalizeSection, withoutPlaceholder } from '../nlp/schema.js';

/** Top-level array fields whose complete elements are worth showing early. */
const ARRAY_KINDS = new Map([
  ['keyPoints', 'keyPoint'],
  ['key_points', 'keyPoint'],
  ['points', 'keyPoint'],
  ['highlights', 'keyPoint'],
  ['sections', 'section'],
  ['chapters', 'section'],
]);

/** Same aliases normalizeResult() accepts for the lead paragraph. */
const TLDR_KEYS = new Set(['tldr', 'summary', 'abstract', 'overview']);

/** Caps mirror normalizeResult(), so the live view cannot exceed the final one. */
const MAX_ITEMS = { keyPoint: 24, section: 20 };

/**
 * @param {{ onItem?: (item: object) => void }} [options]
 * @returns {{ push: (chunk: string) => void, stats: () => object, items: () => object[] }}
 */
export function createSummaryStream({ onItem = null } = {}) {
  let buf = '';
  let pos = 0;
  /** Open containers; `depth` 0 is the response object itself. */
  const stack = [];
  let inString = false;
  let escape = false;
  let strStart = 0;
  let strRole = '';
  let strFrame = null;
  let closed = false;
  const counts = { keyPoint: 0, section: 0 };
  const seen = { keyPoint: new Set(), section: new Set() };
  let tldr = '';
  const emitted = [];

  const top = () => stack[stack.length - 1] || null;

  const emit = (item) => {
    emitted.push(item);
    if (typeof onItem === 'function') onItem(item);
  };

  const pushFrame = (kind, key) => {
    const parent = top();
    const frame = {
      kind,
      key,
      depth: stack.length,
      expect: kind === 'object' ? 'key' : 'item',
      // Which summary array this is, when it is a top-level one we care about.
      interest: kind === 'array' && parent && parent.kind === 'object' && parent.depth === 0
        ? ARRAY_KINDS.get(parent.key) || null
        : null,
      elemStart: pos + 1,
      start: pos,
    };
    stack.push(frame);
    return frame;
  };

  const decodeString = (raw) => {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return null;
    }
  };

  /** A closed string that is an array element: complete on its own. */
  const emitStringElement = (frame, value) => {
    if (!frame.interest || !frame.interest.startsWith('keyPoint')) return;
    acceptPoint(value, frame);
  };

  const acceptPoint = (value, frame) => {
    const point = normalizePoint(value);
    if (!point) return;
    const key = point.text.toLowerCase();
    if (point.text.length < 3 || seen.keyPoint.has(key)) return;
    if (counts.keyPoint >= MAX_ITEMS.keyPoint) return;
    seen.keyPoint.add(key);
    counts.keyPoint++;
    frame && (frame.elemStart = pos + 1);
    emit({ kind: 'keyPoint', index: counts.keyPoint - 1, point });
  };

  const acceptSection = (value, frame) => {
    const section = normalizeSection(value);
    if (!section) return;
    const key = `${section.heading}|${section.summary}`.toLowerCase();
    if (seen.section.has(key)) return;
    if (counts.section >= MAX_ITEMS.section) return;
    seen.section.add(key);
    counts.section++;
    frame && (frame.elemStart = pos + 1);
    emit({ kind: 'section', index: counts.section - 1, section });
  };

  /** A complete JSON element between `[`/`,` and `,`/`]`. */
  const flushElement = (frame, end) => {
    const slice = buf.slice(frame.elemStart, end).trim();
    frame.elemStart = end + 1;
    if (!slice || !frame.interest) return;
    let value;
    try {
      value = JSON.parse(slice);
    } catch {
      return; // A malformed element is not shown; the final parse decides.
    }
    if (frame.interest === 'keyPoint') acceptPoint(value, frame);
    else if (frame.interest === 'section') acceptSection(value, frame);
  };

  const feed = (from) => {
    for (pos = from; pos < buf.length; pos++) {
      const ch = buf[pos];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
          const raw = buf.slice(strStart, pos);
          const frame = strFrame;
          if (strRole === 'key' && frame) {
            const key = decodeString(raw);
            if (key != null) {
              frame.key = key;
              frame.expect = 'colon';
            }
          } else if (strRole === 'value' && frame) {
            frame.expect = 'comma';
            if (frame.depth === 0 && TLDR_KEYS.has(frame.key) && !tldr) {
              const text = withoutPlaceholder(decodeString(raw) || '');
              // Three words is the floor for “a sentence”, not a stray stub.
              if (text && text.split(/\s+/).length >= 3) {
                tldr = text;
                emit({ kind: 'tldr', text });
              }
            }
          } else if (strRole === 'element' && frame) {
            const value = decodeString(raw);
            if (value != null) {
              emitStringElement(frame, value);
              frame.elemStart = pos + 1;
            }
          }
        }
        continue;
      }
      if (closed) break;
      if (ch === '"') {
        const frame = top();
        if (!frame) continue;
        inString = true;
        escape = false;
        strStart = pos + 1;
        strFrame = frame;
        if (frame.kind === 'object') strRole = frame.expect === 'key' ? 'key' : 'value';
        else strRole = 'element';
        continue;
      }
      if (ch === '{') {
        pushFrame('object', null);
        continue;
      }
      if (ch === '[') {
        pushFrame('array', null);
        continue;
      }
      if (ch === '}') {
        const frame = stack.pop();
        if (!frame) continue;
        const parent = top();
        if (parent) parent.expect = 'comma';
        if (stack.length === 0) {
          closed = true;
          // A model sometimes wraps the answer in prose that contains braces
          // (“вот {json}”). An object that produced nothing is not the answer:
          // keep scanning so the real one is not silently ignored. Once a
          // validated item exists, the first object was the answer.
          if (!emitted.length && !tldr) closed = false;
        }
        continue;
      }
      if (ch === ']') {
        const frame = stack.pop();
        if (!frame) continue;
        if (frame.interest) flushElement(frame, pos);
        const parent = top();
        if (parent) parent.expect = 'comma';
        continue;
      }
      if (ch === ',') {
        const frame = top();
        if (!frame) continue;
        if (frame.kind === 'array') {
          if (frame.interest) flushElement(frame, pos);
        } else {
          frame.expect = 'key';
        }
        continue;
      }
      if (ch === ':') {
        const frame = top();
        if (frame && frame.kind === 'object') frame.expect = 'value';
      }
    }
    // Advance past what was scanned; a partial token is re-read on the next
    // push because its starting quote/comma is still the current position.
    return pos;
  };

  return {
    /**
     * Appends a delta. Chunk boundaries may fall anywhere: inside a key, a
     * string, an escape sequence or a number.
     */
    push(chunk) {
      if (!chunk) return;
      // Before the response object starts, only the opening brace matters; it
      // may be preceded by a markdown fence or stray prose.
      const text = String(chunk);
      buf += text;
      if (stack.length === 0 && !closed) {
        const open = buf.indexOf('{', pos);
        if (open === -1) {
          // Keep the search cheap on long prose: nothing before `{` is needed.
          if (buf.length > 4096) {
            buf = buf.slice(-16);
            pos = 0;
          }
          return;
        }
        pos = open;
      }
      feed(pos);
    },
    stats() {
      return { tldr: !!tldr, keyPoints: counts.keyPoint, sections: counts.section, items: emitted.length, closed };
    },
    items() {
      return [...emitted];
    },
  };
}
