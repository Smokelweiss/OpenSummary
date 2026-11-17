/**
 * Token estimation and transcript chunking for AI map-reduce pipelines.
 * Estimates are script-aware: Cyrillic costs ~2.2 chars/token, Latin ~3.8.
 */

import { formatTime } from '../common/util.js';
import { stemsOf, tokenize } from '../nlp/tokenize.js';

export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cyr = 0;
  let cjk = 0;
  let latin = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x0400 && code <= 0x04ff) cyr++;
    else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff)) cjk++;
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 0xc0 && code <= 0x17f)) latin++;
    else other++;
  }
  return Math.ceil(cyr / 2.2 + cjk * 0.9 + latin / 3.8 + other / 3.2);
}

/** Groups segments into ~30s blocks with a single [mm:ss] marker each. */
export function buildBlocks(segments, { blockSeconds = 30 } = {}) {
  const blocks = [];
  let current = null;
  for (const seg of segments || []) {
    const start = Number(seg.start) || 0;
    const text = String(seg.text || '').trim();
    if (!text) continue;
    if (!current || start - current.at >= blockSeconds * 2 || current.text.length > 700) {
      if (current) blocks.push(current);
      current = { at: start, text, tokens: 0 };
    } else {
      current.text += ` ${text}`;
    }
  }
  if (current) blocks.push(current);
  for (const b of blocks) {
    b.tokens = estimateTokens(b.text) + 5; // marker + spacing
  }
  return blocks;
}

export function blockLine(block) {
  return `[${formatTime(block.at)}] ${block.text}`;
}

export function renderBlocks(blocks) {
  return blocks.map(blockLine).join('\n');
}

/**
 * Lexical cohesion between two neighbouring blocks: how many content stems
 * they share, relative to the union. Cheap and deterministic — a real
 * embedding call per block would cost more than the summary itself.
 */
function cohesion(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const stem of a) if (b.has(stem)) common++;
  return common / (a.size + b.size - common);
}

function blockStems(block) {
  return new Set(stemsOf(tokenize(block?.text || '')));
}

/**
 * Indices of blocks that start a new topic.
 *
 * Compares a window of blocks *before* the candidate with a window *after* it
 * (TextTiling-style), not two adjacent blocks: a 30-second block that straddles
 * a topic change shares vocabulary with both sides, so adjacent-block cohesion
 * saw no dip there. Low window cohesion + a local minimum = a topic shift.
 *
 * Returned indices are block indices; `0` is never a boundary.
 */
export function topicBoundaries(blocks) {
  const n = Array.isArray(blocks) ? blocks.length : 0;
  if (n < 6) return new Set();
  const vectors = blocks.map(blockStems);
  const window = Math.max(2, Math.min(4, Math.floor(n / 6)));
  const scores = new Array(n).fill(NaN);
  for (let i = window; i <= n - window; i++) {
    const before = new Set();
    for (let j = i - window; j < i; j++) for (const stem of vectors[j]) before.add(stem);
    const after = new Set();
    for (let j = i; j < i + window; j++) for (const stem of vectors[j]) after.add(stem);
    scores[i] = cohesion(before, after);
  }
  const known = scores.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  if (!known.length) return new Set();
  // Relative to the transcript's own typical cohesion, with a minimum drop:
  // a quantile alone marked *every* position when most pairs shared all their
  // vocabulary (cohesion 1.0), and a fixed number would miss quiet speech where
  // every window is already dissimilar.
  const base = known[Math.floor(known.length / 2)];
  const gap = Math.max(0.01, base * 0.2);
  const out = new Set();
  for (let i = window; i <= n - window; i++) {
    const score = scores[i];
    if (Number.isFinite(score) && score <= base - gap) out.add(i);
  }
  return out;
}

/**
 * Splits a transcript into chunks that fit the model context.
 *
 * A chunk is cut where the topic changes whenever it is already reasonably
 * full: an argument split across two requests loses its own context and is
 * extracted twice (in both notes). Only a chunk that must be cut in the middle
 * of a topic keeps `overlapBlocks` trailing blocks, because there the missing
 * context is real; a cut on a topic boundary needs no repetition at all.
 * @returns {Array<{index:number,count:number,startAt:number,endAt:number,tokens:number,text:string}>}
 */
export function buildChunks(segments, { maxTokens = 3200, overlapBlocks = 1, blockSeconds = 30, semantic = true } = {}) {
  const blocks = buildBlocks(segments, { blockSeconds });
  if (!blocks.length) return [];
  const boundaries = semantic ? topicBoundaries(blocks) : new Set();
  const position = new Map(blocks.map((block, i) => [block, i]));
  const chunks = [];
  let pending = []; // blocks of the chunk being built
  let pendingTokens = 0;
  const emit = (list, cut) => {
    if (!list.length) return;
    chunks.push({
      index: chunks.length,
      startAt: list[0].at,
      endAt: list[list.length - 1].at,
      tokens: list.reduce((a, b) => a + b.tokens, 0),
      text: renderBlocks(list),
      blocks: list,
      cut,
    });
  };
  /**
   * Finds where to end a chunk that is already over its budget: an earlier
   * topic boundary still leaves the chunk at least `MIN_FILL` full, so it is
   * preferred over cutting a section in half. A cut at a boundary needs no
   * overlap; a forced cut repeats the last `overlapBlocks` blocks, because
   * there the missing context is real.
   */
  const MIN_FILL = 0.6;
  const cutAt = () => {
    for (let k = pending.length - 1; k >= 1; k--) {
      const headTokens = pending.slice(0, k).reduce((a, b) => a + b.tokens, 0);
      if (headTokens < maxTokens * MIN_FILL) break;
      if (!boundaries.has(position.get(pending[k]))) continue;
      emit(pending.slice(0, k), 'topic');
      pending = pending.slice(k);
      pendingTokens = pending.reduce((a, b) => a + b.tokens, 0);
      return true;
    }
    return false;
  };
  for (const block of blocks) {
    if (pending.length && pendingTokens + block.tokens > maxTokens) {
      if (!cutAt()) {
        emit(pending, 'size');
        const overlap = overlapBlocks > 0 ? pending.slice(-overlapBlocks) : [];
        pending = overlap.slice();
        pendingTokens = overlap.reduce((a, b) => a + b.tokens, 0);
      }
    }
    pending.push(block);
    pendingTokens += block.tokens;
  }
  emit(pending, 'end');
  return chunks.map((c) => ({ ...c, count: chunks.length }));
}

export function totalTokens(segments) {
  return estimateTokens(renderBlocks(buildBlocks(segments)));
}

/**
 * Decides how to summarise: a single request or map-reduce.
 * 'auto' -> single when everything fits comfortably, otherwise map-reduce.
 *
 * `reserveForPrompt` accounts for the system prompt, the JSON schema and the
 * video header, which are sent with every request but are not part of the
 * transcript estimate. Ignoring them made the “fits in one request” decision
 * optimistic by a couple of thousand tokens, and the provider answered with a
 * context-length error instead.
 */
export function planStrategy({
  segments,
  maxTokens,
  chunkTokens,
  strategy = 'auto',
  reserveForOutput = 1500,
  reserveForPrompt = 2000,
}) {
  const blocks = buildBlocks(segments);
  const tokens = blocks.reduce((a, b) => a + b.tokens, 0);
  // Never let the output reservation eat more than 30% of the budget.
  const reserve = Math.min(reserveForOutput, Math.round(maxTokens * 0.3));
  const budget = Math.max(500, maxTokens - reserve - Math.max(0, Number(reserveForPrompt) || 0));
  // `maxTokens` is the context budget of the model (how much one request may
  // carry); `chunkTokens` is how big a piece of a long transcript may be. They
  // used to be the same number, so a 16-minute video was split into pieces and
  // needed three or four requests where one would do — minutes of waiting.
  const chunkSize = Math.max(500, Number(chunkTokens) || budget);
  const chunks = buildChunks(segments, { maxTokens: chunkSize });
  const fits = tokens <= budget;
  let chosen = strategy;
  if (strategy === 'auto') chosen = fits || chunks.length <= 1 ? 'single' : 'map-reduce';
  if (chosen === 'single' && !fits && chunks.length > 1) chosen = 'map-reduce';
  return { blocks, tokens, chunks, strategy: chosen, budget };
}
