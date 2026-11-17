/**
 * Offline transcript analysis: sentence segmentation, TextRank/TF-ISF scoring
 * and BM25 retrieval. It powers the Q&A “the model is unreachable” fallback and
 * the info-density score — it no longer writes summaries (the extractive
 * engine was removed: its lead sentences repeated and its headings were
 * filler). Fully deterministic, no network.
 */

import { formatTime, clamp, countWords, normalizeWhitespace } from '../common/util.js';
import {
  cleanCaptionText,
  countSpeakers,
  detectLang,
  splitSentences,
  stemsOf,
  stripDanglingOpener,
  stripLeadingFillers,
  tokenize,
} from './tokenize.js';
import { cosineMaps, tfVector, bm25 } from './similarity.js';
import { extractKeywords } from './keywords.js';
import { CUE_PHRASES, countCueHits } from './stopwords.js';

const DEFAULT_OPTIONS = {
  keyPoints: 8,
  sectionsMode: 'auto',
  perSectionPoints: 3,
  minSentenceWords: 4,
  maxSentenceWords: 45,
  filterFillers: true,
  timelineBuckets: 20,
  keywordCount: 24,
  // Study aid, off unless the user asks for it (output.selfCheck).
  quiz: false,
  stats: true,
  composeLead: true,
  maxSections: 10,
  minSections: 3,
  uiLang: 'ru',
};

/**
 * Sentences that talk about the video instead of its subject. They carry no
 * facts but are short, early and dense in pronouns, so they used to win the
 * lead: “You are watching the second part of the conversation.” Such a line
 * may still appear in the transcript view; it must not become the TL;DR.
 * Distinct from CUE_PHRASES (ads and calls to subscribe): this is the author
 * narrating the video, not selling anything.
 */
// `\b` is useless here: in JavaScript it is defined through ASCII \w, so a
// Cyrillic word followed by a space has no boundary at all and every Russian
// pattern with \b silently never matched. The lookahead does the same job for
// both alphabets.
const END = '(?![\\p{L}\\p{N}])';
const META_TALK = [
  new RegExp(`^(?:you['’]re|you are|you['’]ll|you will)\\s+(?:watching|going to|gonna|about to|not going to)${END}`, 'iu'),
  new RegExp(`^(?:in|on)\\s+this\\s+(?:video|episode|interview|conversation|talk)${END}`, 'iu'),
  new RegExp(`^(?:today|tonight)\\s+we${END}`, 'iu'),
  new RegExp(`^(?:we['’]re|we are)\\s+(?:going to|gonna|about to)${END}`, 'iu'),
  new RegExp(`^(?:i['’]m|i am)\\s+going to\\s+(?:show|tell|explain|walk)${END}`, 'iu'),
  new RegExp(`^let['’]s\\s+(?:take a look|get into|dive|start|begin|talk about)${END}`, 'iu'),
  new RegExp(`^(?:stay|stick)\\s+(?:tuned|with us|around)${END}`, 'iu'),
  new RegExp(`^(?:watch\\s+)?till\\s+the\\s+end${END}`, 'iu'),
  new RegExp(`^(?:в|на)\\s+этом\\s+(?:видео|ролике|выпуске|интервью)${END}`, 'iu'),
  new RegExp(`^сегодня\\s+мы${END}`, 'iu'),
  /^давайте\s+(?:посмотрим|разбер|поговор|начн|рассмотр|пройд)/iu,
  new RegExp(`^вы\\s+(?:узнаете|увидите|услышите|пойм[её]те)${END}`, 'iu'),
  /^(?:я|мы)\s+(?:расскаж|покаж|разбер|поговор)/iu,
  /^оставайтесь\s+(?:до|с\s+нами)/iu,
  new RegExp(`^досмотрите\\s+до\\s+конца${END}`, 'iu'),
];

export function isMetaTalk(text) {
  const t = normalizeWhitespace(text == null ? '' : String(text));
  if (!t) return false;
  return META_TALK.some((re) => re.test(t));
}

/**
 * Display text of a sentence: discourse markers off the front, and a detached
 * participle opener cut so the clause can be read on its own.
 */
function makeDisplay(text, filterFillers) {
  const t = filterFillers ? stripLeadingFillers(text) : text;
  return stripDanglingOpener(t);
}

/* ------------------------------------------------------------------ analysis */

/** Builds sentences with timecodes and stem vectors from transcript segments. */
export function buildSentences(segments, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sentences = [];
  let buffer = '';
  let bufferStart = null;
  let bufferEnd = null;

  const push = (text, at, endAt, forced = false) => {
    const cleaned = cleanCaptionText(text);
    if (!cleaned) return;
    const tokens = tokenize(cleaned);
    if (!tokens.length) return;
    const words = tokens.length;
    const stems = stemsOf(tokens);
    const tooThin = words < (forced ? 2 : opts.minSentenceWords) || stems.length < 2;
    if (tooThin) return;
    const promoHits = countCueHits(cleaned, CUE_PHRASES);
    sentences.push({
      i: sentences.length,
      text: cleaned,
      display: makeDisplay(cleaned, opts.filterFillers),
      at: at == null ? null : Math.round(at),
      endAt: endAt == null ? null : Math.round(endAt),
      tokens,
      stems,
      tf: tfVector(stems),
      words,
      promo: promoHits > 0,
      cueHits: promoHits,
      // “You're going to hear…” — the author presenting the video. Kept in the
      // sentence list (the transcript view shows it) but never selected as
      // summary content.
      meta: isMetaTalk(cleaned),
    });
  };

  for (const raw of segments || []) {
    // Clean every segment on its own. The spoken timecode (“5 минут 19 секунд”)
    // sits at the start of a row, but rows are glued together while a sentence
    // is still open — cleaning only the joined buffer stripped the first one and
    // left the rest in the middle of sentences (“…, в частности, 7 минут 4
    // секунды супермегаэбожественный мармелад…”).
    const text = cleanCaptionText(String((raw && (raw.text || raw.snippet)) || ''));
    if (!text) continue;
    const start = Number(raw.start ?? raw.offset ?? 0) || 0;
    const dur = Number(raw.dur ?? raw.duration ?? 0) || 0;
    const segEnd = start + dur;
    if (bufferStart == null) bufferStart = start;
    bufferEnd = segEnd;
    buffer = buffer ? `${buffer} ${text}` : text;

    const parts = splitSentences(cleanCaptionText(buffer));
    if (parts.length > 1) {
      for (let i = 0; i < parts.length - 1; i++) push(parts[i], bufferStart, segEnd);
      buffer = parts[parts.length - 1];
      bufferStart = segEnd;
      continue;
    }
    // No terminator yet: force a break for run-on speech without punctuation.
    const words = countWords(buffer);
    if (words > opts.maxSentenceWords * 1.7) {
      const cut = cutAtBoundary(buffer, opts.maxSentenceWords * 1.2);
      if (cut) {
        push(cut.head, bufferStart, segEnd, true);
        buffer = cut.tail;
        bufferStart = segEnd;
      }
    }
  }
  if (buffer) push(buffer, bufferStart, bufferEnd, true);

  // Split remaining over-long sentences at clause boundaries.
  const result = [];
  for (const s of sentences) {
    if (s.words <= opts.maxSentenceWords * 2) {
      s.i = result.length;
      result.push(s);
      continue;
    }
    for (const piece of splitLong(s.text, opts.maxSentenceWords)) {
      const tokens = tokenize(piece);
      const stems = stemsOf(tokens);
      if (tokens.length < opts.minSentenceWords || stems.length < 2) continue;
      result.push({
        ...s,
        i: result.length,
        text: piece,
        display: makeDisplay(piece, opts.filterFillers),
        tokens,
        stems,
        tf: tfVector(stems),
        words: tokens.length,
      });
    }
  }
  return result;
}

function cutAtBoundary(text, targetWords) {
  const words = text.split(/\s+/);
  if (words.length < 6) return null;
  let idx = Math.min(words.length - 2, Math.max(3, Math.round(targetWords)));
  // prefer a comma or a conjunction around the target
  for (let delta = 0; delta < 6; delta++) {
    for (const candidate of [idx - delta, idx + delta]) {
      if (candidate < 3 || candidate > words.length - 3) continue;
      if (/[,;:]$/.test(words[candidate - 1])) {
        idx = candidate;
        delta = 99;
        break;
      }
    }
  }
  return { head: words.slice(0, idx).join(' '), tail: words.slice(idx).join(' ') };
}

function splitLong(text, maxWords) {
  const clauses = String(text).split(/(?<=[,;:])\s+/);
  const out = [];
  let buf = '';
  for (const clause of clauses) {
    const candidate = buf ? `${buf} ${clause}` : clause;
    if (countWords(candidate) > maxWords && buf) {
      out.push(buf);
      buf = clause;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out.flatMap((c) => {
    if (countWords(c) <= maxWords * 1.35) return [c.trim()];
    const words = c.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(' '));
    return chunks;
  }).filter((c) => countWords(c) >= 3);
}

/** Time windows (default 60s) used as pseudo-documents for ISF. */
export function buildWindows(sentences, { windowSec = 60, sentencesPerWindow = 6 } = {}) {
  const windows = [];
  if (!sentences.length) return windows;
  const timed = sentences.every((s) => s.at != null);
  let current = null;
  const flush = () => {
    if (current && current.stems.length) windows.push(current);
    current = null;
  };
  for (const s of sentences) {
    const key = timed ? Math.floor(s.at / windowSec) : Math.floor(s.i / sentencesPerWindow);
    if (!current || current.key !== key) {
      flush();
      current = { key, stems: [], sentenceIdx: [], startAt: s.at, endAt: s.endAt };
    }
    current.stems.push(...s.stems);
    current.sentenceIdx.push(s.i);
    current.endAt = s.endAt ?? current.endAt;
  }
  flush();
  return windows;
}

export function textRank(sentences, { damping = 0.85, iterations = 25, neighborWindow = 60 } = {}) {
  const n = sentences.length;
  if (!n) return [];
  const edges = new Array(n);
  for (let i = 0; i < n; i++) {
    const map = new Map();
    let sum = 0;
    const from = Math.max(0, i - neighborWindow);
    const to = Math.min(n - 1, i + neighborWindow);
    for (let j = from; j <= to; j++) {
      if (i === j) continue;
      const sim = cosineMaps(sentences[i].tf, sentences[j].tf);
      if (sim > 0.06) {
        map.set(j, sim);
        sum += sim;
      }
    }
    edges[i] = { map, sum: sum || 1 };
  }
  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Array(n).fill((1 - damping) / n);
    for (let i = 0; i < n; i++) {
      const { map, sum } = edges[i];
      if (!map.size) continue;
      const share = (damping * scores[i]) / sum;
      for (const [j, sim] of map) next[j] += share * sim;
    }
    const total = next.reduce((a, b) => a + b, 0) || 1;
    scores = next.map((v) => v / total);
  }
  return scores;
}

function tfisfScores(sentences, windows) {
  const N = windows.length || 1;
  const df = new Map();
  for (const w of windows) {
    for (const s of new Set(w.stems)) df.set(s, (df.get(s) || 0) + 1);
  }
  return sentences.map((s) => {
    let score = 0;
    for (const [stem, count] of s.tf) {
      const isf = Math.log((N + 1) / ((df.get(stem) || 0) + 1)) + 1;
      score += count * isf;
    }
    return score / Math.sqrt(s.words || 1);
  });
}

function normalizeScores(list) {
  if (!list.length) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of list) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  return list.map((v) => (v - min) / span);
}

/** Full local analysis; reusable for summary and for offline Q&A. */
export function analyze({ segments, meta = {}, options = {} }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sentences = buildSentences(segments, opts);
  if (!sentences.length) {
    const err = new Error('EMPTY_TRANSCRIPT');
    err.code = 'EMPTY_TRANSCRIPT';
    throw err;
  }
  const langInfo = detectLang(sentences.slice(0, 400).map((s) => s.text).join(' '));
  const lang = meta.lang && meta.lang !== 'auto' ? meta.lang : langInfo.lang;
  const windows = buildWindows(sentences);
  // Keywords come from the content only: the promo rows (“подпишитесь на
  // канал”, “промокод в описании”) used to make “канал” a top topic of the
  // video and put it into the lead line.
  const contentSentences = sentences.filter((s) => !s.promo);
  const keywords = extractKeywords({
    sentences: contentSentences.length >= 3 ? contentSentences : sentences,
    windows,
    topN: opts.keywordCount,
  });
  const rank = normalizeScores(textRank(sentences));
  const tfisf = normalizeScores(tfisfScores(sentences, windows));
  const duration = Number(meta.lengthSeconds) || (sentences[sentences.length - 1].endAt || 0);
  const titleStems = new Set(stemsOf(tokenize(`${meta.videoTitle || ''} ${meta.chapterTitles || ''}`)));
  const keywordScores = new Map(keywords.map((k) => [k.term.toLowerCase(), k.score]));
  const topKeywordStems = new Set(
    keywords.filter((k) => k.ngram === 1).slice(0, 12).flatMap((k) => stemsOf(tokenize(k.term))),
  );

  for (const s of sentences) {
    s.finalScore = scoreSentence(s, {
      rank,
      tfisf,
      keywordScores,
      topKeywordStems,
      titleStems,
      total: sentences.length,
      duration,
      sentenceCount: sentences.length,
    });
  }

  return {
    sentences,
    windows,
    keywords,
    lang,
    langInfo,
    duration,
    options: opts,
    meta,
    speakers: countSpeakers(segments),
  };
}

function scoreSentence(s, ctx) {
  const base = 0.55 * ctx.rank[s.i] + 0.45 * ctx.tfisf[s.i];
  let factor = 1;

  // Position: the opening of a video usually holds the thesis.
  const pos = ctx.sentenceCount > 1 ? s.i / (ctx.sentenceCount - 1) : 0;
  factor *= 1.18 - 0.4 * pos;

  // Length: prefer informative but not bloated sentences.
  const z = (s.words - 16) / 20;
  factor *= 0.72 + 0.42 * Math.exp(-0.5 * z * z);

  // Title overlap.
  if (ctx.titleStems.size) {
    let hit = 0;
    for (const st of s.stems) if (ctx.titleStems.has(st)) hit++;
    factor *= 1 + 0.4 * Math.min(1, hit / Math.max(2, ctx.titleStems.size / 2));
  }

  // Keyword density.
  if (s.stems.length) {
    let kw = 0;
    for (const st of s.stems) {
      if (ctx.topKeywordStems.has(st)) kw++;
      const surface = ctx.keywordScores.get(st);
      if (surface) kw += surface * 0.5;
    }
    factor *= 1 + 0.22 * Math.min(1, kw / Math.max(2, s.stems.length / 3));
  }

  // Numbers, dates and percentages carry facts.
  if (/\d/.test(s.text)) factor *= 1.06;

  // Pronoun-ish vagueness penalty.
  const pronouns = s.tokens.filter((t) => /^(это|этот|эта|эти|такой|такая|там|тут|этого|этой|то|неё|него|его|их|они|мы|вы|я|it|this|that|they|them|there)$/.test(t)).length;
  if (pronouns / Math.max(1, s.tokens.length) > 0.16) factor *= 0.78;

  // Promo / boilerplate sentences are never the summary.
  if (s.promo) factor *= 0.12;

  return base * factor;
}

/* ---------------------------------------------------------------- selection */

/* ----------------------------------------------------------------- sections */

/**
 * YouTube's chapter bar can list the same marker twice (the collapsed bar and
 * the expanded list are both in the DOM). Two entries at the same second are
 * one chapter: keeping both produced sections with the same title, the same
 * timecode and the same bullets.
 */
/**
 * The lead line must name topics (“кэш”, “инвалидация”); a verb (“начал”,
 * “получили”) is not a topic, while it stays fine in the keyword cloud.
 */
/**
 * A heading names a part of the video, so the fallback cuts the first point at
 * a clause boundary: “Epste was close to Ehood Barak, hosted former…” read as a
 * broken sentence, while “Epste was close to Ehood Barak” reads as a title.
 */
/** Words that must not end a heading: “…directed Epstein crimes or” is not a title. */
const TRAILING_CONNECTOR = /^(?:and|or|of|to|in|on|at|the|a|an|that|this|was|is|are|were|be|been|with|for|from|by|as|but|if|so|и|или|в|во|на|с|со|к|ко|по|из|от|до|для|как|что|это|был|была|было|были|будет|а|но|же|ли)$/i;

/** Stems of one heading term, used to detect “Agency” inside “Intelligence Agency”. */
/**
 * “Intelligence Agency · Intelligence · Agency” names one thing three times and
 * reads like a broken keyword list. Keep the longest (most specific) term and
 * drop every term whose words are already covered by it.
 */
/**
 * Two sections titled the same way (“Depositors moved their savings…”) tell the
 * reader nothing about the difference between them. Rename the later one from
 * its own first bullet; when even that repeats, prefix the timecode so the
 * heading stays unique and traceable.
 */
/**
 * One sentence, one place: a bullet that already appeared in an earlier
 * section (or in the overview) is not shown twice.
 */
/**
 * The sentence that opens the TL;DR. It has to name someone from the title (or
 * a person who keeps coming up in the transcript) and stay readable without the
 * surrounding talk. The earliest strong candidate wins: a late mention assumes
 * the reader already knows who “он” is.
 */
/**
 * One line of the summary. A sentence that already fits is never cut: the old
 * code truncated the whole TL;DR by characters, so it ended mid-phrase (“…день
 * существования 9…”). Only an over-long sentence is shortened, at a comma.
 */
/** Money/units make terrible lead words: “О чём видео: руб, гриша и простои”. */
const NOT_A_TOPIC = /^(руб|рубл|долл|доллар|евро|коп|процент|тыс|млн|млрд|штук|секунд|минут|час|год|лет|день|недел|месяц|раз|человек)/i;

/**
 * Picks that cover the whole video instead of one region: the best sentence of
 * the opening, of the middle and of the finale, joined in chronological order.
 * A two-sentence lead over one region reads like a random quote from the middle
 * of the transcript — exactly what made “о чём видео” useless on long videos.
 */
/* --------------------------------------------------------------------- main */

/** Comparison key for “is this the same line elsewhere?”. */

/** Concessive openers mark commentary, not an instruction. */
const CONCESSIVE_OPENER = /^(?:though|although|even though|whereas|despite|while|хотя|несмотря|тогда как)\b/i;

/** “Let's start by…” is the author narrating the essay, not advice to a viewer. */
const COLLAB_OPENER = /^(?:let['’]s|let us|давай|давайте)\b/i;

/**
 * Advice has to open the sentence and be an instruction: a cue somewhere in the
 * first ten words matched “Though it's certainly compelling…” (avoid) and
 * “Though Karen's reaction… we should keep in mind…” — analysis, not a to-do.
 */
/* ----------------------------------------------------------------- offline QA */

export function answerLocal(question, analysis, { topK = 5 } = {}) {
  const q = normalizeWhitespace(question || '');
  const ru = analysis.lang !== 'en';
  if (!q) return { answer: '', sources: [], confidence: 0 };
  const questionStems = stemsOf(tokenize(q));
  const { sentences, duration } = analysis;

  const overviewIntent = /(о чём|о чем|про что|суть|кратко|обзор|what.{0,6}about|summary|overview|tl;?dr)/i.test(q);
  const ranked = bm25(questionStems, sentences, {});
  const top = ranked.slice(0, topK);
  const sources = top.map((t) => ({
    text: t.doc.display,
    at: t.doc.at,
    ts: t.doc.at == null ? null : formatTime(t.doc.at),
    score: Math.round(t.score * 100) / 100,
  }));

  if (overviewIntent) {
    const best = sentences.slice().sort((a, b) => b.finalScore - a.finalScore).slice(0, 3).sort((a, b) => (a.at || 0) - (b.at || 0));
    return {
      answer: best.map((s) => s.display).join(' '),
      sources: best.map((s) => ({ text: s.display, at: s.at, ts: s.at == null ? null : formatTime(s.at), score: 1 })),
      confidence: 0.6,
      mode: 'local',
    };
  }

  if (!top.length || top[0].score < 1) {
    return {
      answer: ru
        ? 'В транскрипте этого видео нет подходящих фрагментов. Попробуйте переформулировать вопрос или подключите ИИ-режим.'
        : 'No matching fragments were found in the transcript. Try rephrasing the question or switch to AI mode.',
      sources: [],
      confidence: 0,
      mode: 'local',
    };
  }

  const answerSentences = top.slice(0, 2).map((t) => t.doc.display);
  const confidence = Math.min(1, top[0].score / 8);
  const prefix = ru ? 'Наиболее релевантные фрагменты:' : 'Most relevant fragments:';
  return {
    answer: `${prefix} ${answerSentences.join(' ')}`,
    sources,
    confidence: Math.round(confidence * 100) / 100,
    mode: 'local',
  };
}

/** Fast "is this video worth watching" score (0-100), local only. */
export function infoDensityScore(analysis) {
  const { sentences, keywords, duration } = analysis;
  if (!sentences.length) return 0;
  const words = sentences.reduce((a, s) => a + s.words, 0);
  const kwDensity = keywords.length ? Math.min(1, keywords.reduce((a, k) => a + k.score, 0) / 12) : 0;
  const numbers = sentences.filter((s) => /\d/.test(s.text)).length / sentences.length;
  const promoRatio = sentences.filter((s) => s.promo).length / sentences.length;
  const density = Math.min(1, words / Math.max(1, duration) / 2.2);
  const score = 100 * (0.35 * kwDensity + 0.2 * numbers + 0.25 * density + 0.2 * (1 - Math.min(1, promoRatio * 8)));
  return Math.round(clamp(score, 0, 100));
}

