/**
 * Keyword / key phrase extraction via TF-ISF over "windows" (time slices),
 * unigrams + bigrams, with cohesion filtering for phrases.
 */

import { STOPWORDS } from './stopwords.js';
import { stemPairs } from './tokenize.js';
import { capitalize, normalizeWhitespace } from '../common/util.js';

/**
 * @param {object} p
 * @param {Array} p.sentences  sentences with {stems, tokens}
 * @param {Array} p.windows    windows with {stems}
 * @param {number} p.topN
 */
export function extractKeywords({ sentences, windows, topN = 24 }) {
  const totalWindows = windows.length || 1;
  const df = new Map();
  for (const w of windows) {
    const seen = new Set(w.stems);
    for (const s of seen) df.set(s, (df.get(s) || 0) + 1);
  }

  const uniCount = new Map(); // stem -> count
  const surfaces = new Map(); // key -> Map(surface -> count)
  const firstAt = new Map(); // key -> seconds
  const bigramCount = new Map();

  const bump = (key, surface, at) => {
    let m = surfaces.get(key);
    if (!m) {
      m = new Map();
      surfaces.set(key, m);
    }
    m.set(surface, (m.get(surface) || 0) + 1);
    if (at != null && !firstAt.has(key)) firstAt.set(key, at);
  };

  for (const s of sentences) {
    // Stem/surface pairs, never two parallel arrays: the surfaces must belong to
    // the stems they are displayed with.
    const pairs = stemPairs(s.tokens || []);
    for (let i = 0; i < pairs.length; i++) {
      const st = pairs[i].stem;
      uniCount.set(st, (uniCount.get(st) || 0) + 1);
      bump(st, pairs[i].surface, s.at);
    }
    for (let i = 0; i + 1 < pairs.length; i++) {
      const key = `${pairs[i].stem} ${pairs[i + 1].stem}`;
      bigramCount.set(key, (bigramCount.get(key) || 0) + 1);
      bump(key, `${pairs[i].surface} ${pairs[i + 1].surface}`.trim(), s.at);
    }
  }

  const isf = (stem) => Math.log((totalWindows + 1) / ((df.get(stem) || 0) + 1)) + 1;
  // How many windows a term reaches. A word present everywhere (“model”,
  // “video”, “модель”) names no particular part of the video: it may stay in
  // the cloud but must not title a section.
  const spreadOf = (stem) => (df.get(stem) || 0) / totalWindows;

  const scored = [];

  for (const [stem, count] of uniCount) {
    if (count < 2) continue;
    if (STOPWORDS.has(stem)) continue;
    const term = bestSurface(surfaces, stem);
    // “рублей”, “процентов” and “минут” are facts, not topics: the numbers they
    // attach to already carry them.
    if (UNIT_TERM.test(term)) continue;
    // A verb is a topic only when nothing better is left: “начал”, “стало” and
    // “говорит” used to outrank the actual subject of the video.
    const verbal = looksVerbal(term);
    const verbPenalty = verbal ? 0.45 : 1;
    // An adjective describes a topic, it is not one: “Обычный” and “Простой”
    // were the joint subject of a video about marmalade; “new” and “pretty” are
    // the English counterparts.
    const subject = !verbal && !isAdjectivalStem(surfaces, stem) && !looksAdjectival(term);
    const score = count * isf(stem) * (stem.length >= 6 ? 1.12 : 1) * verbPenalty * (subject ? 1 : 0.22);
    scored.push({
      key: stem,
      term,
      score,
      count,
      ngram: 1,
      subject,
      spread: round3(spreadOf(stem)),
      at: firstAt.has(stem) ? firstAt.get(stem) : null,
    });
  }

  for (const [key, count] of bigramCount) {
    if (count < 2) continue;
    const [a, b] = key.split(' ');
    const ca = uniCount.get(a) || 0;
    const cb = uniCount.get(b) || 0;
    if (ca < 2 || cb < 2) continue;
    const cohesion = count / Math.max(1, Math.min(ca, cb));
    if (cohesion < 0.3) continue;
    const surface = bestSurface(surfaces, key);
    const verbal = looksVerbal(surface);
    const verbPenalty = verbal ? 0.6 : 1;
    // A phrase is named by its words: “простой семьи” and “обычный парень” are
    // descriptions, “наценка на мармелад” style nouns are topics. Each word is
    // checked through its own inflections — “простой” alone hides the adjective,
    // “простые люди” in the same transcript shows it.
    const subject = wordIsSubject(surfaces, a) && wordIsSubject(surfaces, b);
    const score = count * Math.min(isf(a), isf(b)) * (1 + cohesion) * 0.9 * verbPenalty * (subject ? 1 : 0.35);
    scored.push({
      key,
      term: surface,
      score,
      count,
      ngram: 2,
      subject,
      spread: round3(Math.min(spreadOf(a), spreadOf(b))),
      at: firstAt.has(key) ? firstAt.get(key) : null,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // Descriptions are dropped from the topic list when there is something left
  // to name the video with; the keyword cloud is read as “what this is about”.
  const nouns = scored.filter((item) => item.subject);
  const pool = nouns.length >= 3 ? nouns : scored;

  // De-duplicate: drop bigrams that contain an already accepted single term
  // only if the unigram is stronger; keep both otherwise.
  const accepted = [];
  const seenTerm = new Set();
  for (const item of pool) {
    const norm = normalizeWhitespace(item.term).toLowerCase();
    if (!norm || norm.length < 3) continue;
    // The stem of a filler/adverb may survive stemming, so the chosen surface
    // is checked as well: “Очень · Конечно” is not a topic.
    if (STOPWORDS.has(norm)) continue;
    if (seenTerm.has(norm)) continue;
    if (item.ngram === 2) {
      const parts = norm.split(' ');
      if (parts.some((p) => STOPWORDS.has(p))) continue;
    }
    seenTerm.add(norm);
    accepted.push(item);
    if (accepted.length >= topN) break;
  }

  const max = accepted.length ? accepted[0].score : 1;
  return accepted.map((item, i) => ({
    term: displayTerm(item.term),
    score: round3(item.score / max),
    count: item.count,
    ngram: item.ngram,
    subject: item.subject !== false,
    spread: item.spread != null ? item.spread : 1,
    at: item.at,
    rank: i + 1,
  }));
}

/**
 * Verb endings. A topic word (“мармелад”, “наценка”) almost never ends like
 * this, while any conjugated verb does. Nouns such as “канал” и “материал” are
 * exempted on purpose.
 */
const VERB_ENDINGS = /(?:ться|тся|ться|ть|ти|ешь|ете|ем|им|ет|ют|ит|ат|ят|ал|ял|ил|ыл|ел|ла|ло|ли|ся|сь|ует|ает|яет|ела|ело|ели|ала|ало|али|ила|ило|или)$/u;

const NOUN_EXCEPTIONS = new Set([
  'канал',
  'материал',
  'финал',
  'сигнал',
  'журнал',
  'квартал',
  'капитал',
  'персонал',
  'сериал',
  'скандал',
  'идеал',
  'зал',
  'отдел',
  'предел',
  'юбилей',
]);

/**
 * Inflections that only an adjective (or a participle) takes. Nouns do not end
 * like this — the risky endings (“-ой”, “-ий”, “-ие”) are left out on purpose,
 * because “герой”, “сценарий” and “здание” are exactly those nouns.
 */
const ADJECTIVE_ENDINGS = /(?:ый|ые|ая|ое|ого|ому|ему|ым|ых|ыми|ую|ею)$/u;

/** Numbers and units: “рублей”, “процентов”, “тысяч”, “минут”. */
const UNIT_TERM = /^(?:руб|рубл|долл|евро|коп|процент|тыс|млн|млрд|минут|секунд|час|штук|кг|км)/i;

function isAdjectivalStem(surfaces, key) {
  const m = surfaces.get(key);
  if (!m || !m.size) return false;
  for (const surface of m.keys()) {
    const words = String(surface).trim().split(/\s+/).filter(Boolean);
    const word = words[words.length - 1];
    if (word && ADJECTIVE_ENDINGS.test(word.toLowerCase().replace(/ё/g, 'е'))) return true;
  }
  return false;
}

/** A single word names a topic when it is neither a verb nor a description. */
function wordIsSubject(surfaces, stem) {
  const surface = bestSurface(surfaces, stem);
  return !looksVerbal(surface) && !isAdjectivalStem(surfaces, stem) && !looksAdjectival(surface);
}

/**
 * English: frequent spoken verbs in their base form. Inflected forms are caught
 * by the suffix rules below; the base forms are exactly what the Russian
 * endings cannot see (“see”, “make”, “get” used to become section headings).
 */
const EN_COMMON_VERBS = new Set((`
be have do say go get make know think take see come want look use find give tell work call try ask need feel become
leave put mean keep let begin seem help talk turn start show hear play run move like live believe bring happen write
provide sit stand lose pay meet include continue set learn change lead understand watch follow stop create speak read
spend grow open walk win teach offer remember consider appear buy wait serve die send expect build stay fall cut reach
kill remain suggest raise pass sell require report decide pull return explain hope develop carry break receive agree
support hit produce eat cover catch draw choose cause point listen realize place close increase describe deliver
release launch announce showcase demo compare benchmark train download install subscribe mention looks looking makes
gets goes comes takes gives finds tells tries asks needs thinks knows sees wants uses works plays runs moves starts
stops turns creates reads spends grows pays meets sets learns changes leads understands watches follows speaks
learn stream render market generate include includes including use using used talk talked talks talked build built
contain contains containing name names named naming host hosts hosted hosting seal seals sealed deny denies denied
claim claims claimed warn warns warned certify certifies certified convene convenes convened
promise promises promised promising admit admits admitted confirm confirms confirmed reveal reveals revealed
accuse accuses accused sue sues sued testify testifies testified plead pleads pleaded approve approves approved
`)
  .trim()
  .split(/\s+/));

/** Adjective suffixes and the most common irregular adjectives. */
const EN_ADJECTIVE_ENDINGS = /(?:ous|ive|able|ible|ful|less|ical|ic|ent|ant|ish)$/;
const EN_ADJECTIVES = new Set((`
new good great best better big small long short different same main last next first free open important popular
quick fast slow hard easy real full whole single double huge massive sure possible available current recent general
pretty amazing incredible awesome insane weird crazy terrible awful nice lovely beautiful boring interesting exciting
open-source open source
`)
  .trim()
  .split(/\s+/));

function looksVerbalEn(word) {
  const w = String(word || '').toLowerCase();
  if (EN_COMMON_VERBS.has(w)) return true;
  // “-ing” alone is not a verb marker: “learning”, “marketing” and “rendering”
  // name topics. Only a known verb stem counts (“including” → include).
  if (w.length >= 6 && /ing$/.test(w)) {
    const stem = w.slice(0, -3);
    if (EN_COMMON_VERBS.has(stem) || EN_COMMON_VERBS.has(`${stem}e`)) return true;
  }
  if (w.length >= 6 && /ed$/.test(w)) {
    const stem = w.slice(0, -2);
    if (EN_COMMON_VERBS.has(stem) || EN_COMMON_VERBS.has(`${stem}e`) || EN_COMMON_VERBS.has(w.slice(0, -1))) return true;
  }
  // Third person singular: “drops”, “releases”, “announces” — a known base verb
  // plus s/es/ies.
  if (w.length >= 5 && /(?:ies|es|s)$/.test(w)) {
    const bases = [w.replace(/ies$/, 'y'), w.replace(/es$/, ''), w.replace(/s$/, ''), w];
    if (bases.some((b) => EN_COMMON_VERBS.has(b))) return true;
  }
  return false;
}

function looksAdjectivalEn(word) {
  const w = String(word || '').toLowerCase();
  if (EN_ADJECTIVES.has(w)) return true;
  return w.length >= 6 && EN_ADJECTIVE_ENDINGS.test(w);
}

/** True for words that describe a topic instead of naming one. */
export function looksAdjectival(term) {
  const words = normalizeWhitespace(term).toLowerCase().split(' ').filter(Boolean);
  if (!words.length) return false;
  const last = words[words.length - 1];
  if (/^[a-z'-]+$/.test(last)) return looksAdjectivalEn(last);
  return ADJECTIVE_ENDINGS.test(last);
}

export function looksVerbal(term) {
  const words = normalizeWhitespace(term).toLowerCase().split(' ').filter(Boolean);
  if (!words.length) return false;
  const last = words[words.length - 1];
  if (NOUN_EXCEPTIONS.has(last)) return false;
  if (/^[a-z'-]+$/.test(last) && looksVerbalEn(last)) return true;
  return words.some((w) => w.length >= 4 && VERB_ENDINGS.test(w) && !/^[a-z'-]+$/.test(w));
}

function bestSurface(surfaces, key) {
  const m = surfaces.get(key);
  if (!m || !m.size) return key;
  let best = key;
  let bestCount = -1;
  for (const [surface, count] of m) {
    if (count > bestCount || (count === bestCount && surface.length < best.length)) {
      best = surface;
      bestCount = count;
    }
  }
  return best;
}

function displayTerm(term) {
  const t = normalizeWhitespace(term);
  return t.split(' ').map((w) => (w.length > 3 ? capitalize(w) : w)).join(' ');
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/**
 * Keywords dominant inside a specific time slice (used for section headings).
 * Without `fallback` an empty slice stays empty: repeating the global topics as
 * the heading of every section titles nothing. `specific` additionally drops
 * words that appear everywhere in the video (“model”, “open”, “image” titled
 * five different sections of one news roundup): only terms local to the slice
 * may name it.
 */
export function keywordsInRange(keywords, from, to, limit = 3, { fallback = true, specific = false } = {}) {
  const inRange = keywords.filter((k) => k.at != null && k.at >= from && k.at < to);
  const list = inRange.length || !fallback ? inRange : keywords;
  const kept = list.filter((k) => k.ngram >= 1 && (!specific || k.subject !== false || k.ngram === 2));
  if (!specific) return kept.slice(0, limit);
  const local = kept.filter((k) => (k.spread == null ? true : k.spread <= 0.5));
  // A heading must name THIS part: rank by how local the term is (low spread)
  // and prefer multi-word phrases over single words.
  const ranked = (local.length ? local : kept)
    .slice()
    .sort((a, b) => {
      const va = a.score * (1.05 - (a.spread ?? 0.5)) * (a.ngram === 2 ? 1.3 : 1);
      const vb = b.score * (1.05 - (b.spread ?? 0.5)) * (b.ngram === 2 ? 1.3 : 1);
      return vb - va;
    });
  return ranked.slice(0, limit);
}
