/** Text normalization, sentence splitting, tokenization and light stemming. */

import { NON_SPEECH_RE, SPEAKER_RE, STOPWORDS, FILLERS } from './stopwords.js';

const ABBREV = new Set([
  'т', 'е', 'д', 'п', 'др', 'г', 'гг', 'рис', 'стр', 'см', 'напр', 'им', 'ул', 'руб', 'коп', 'млн',
  'млрд', 'тыс', 'англ', 'рус', 'лат', 'в', 'г', 'н', 'э', 'проф', 'доц', 'акад', 'обл', 'гор',
  'e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'no', 'fig', 'al', 'inc', 'ltd',
  'approx', 'dept', 'est', 'min', 'max', 'sec', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug',
  'sep', 'oct', 'nov', 'dec', 'u.s', 'u.k', 'sci', 'tech',
]);

const FILLER_SET = new Set(FILLERS.map((w) => w.toLowerCase()));
const STOP_SET = STOPWORDS;

export function normalizeText(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/[«»„“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * YouTube's transcript panel renders a visually hidden spoken form of each
 * row's timecode (“5 минут 19 секунд”, “2 minutes 57 seconds”) next to the cue
 * text. innerText includes it, so every scraped segment began with a fake
 * sentence and the summary was built from “минут секунд”. The prefix is only a
 * timestamp when real speech follows it (capital letter, quote, digit):
 * “5 минут назад он сказал…” is speech and must stay untouched.
 */
const SPOKEN_TIME_RU = [
  /^\d{1,3}\s*(?:час(?:а|ов)?|ч\.?)\s*(?:\d{1,2}\s*(?:минут(?:а|ы|у)?|мин\.?)\s*)?(?:\d{1,2}\s*(?:секунд(?:а|ы|у)?|сек\.?)\s*)?/u,
  /^\d{1,2}\s*(?:минут(?:а|ы|у)?|мин\.?)\s*(?:\d{1,2}\s*(?:секунд(?:а|ы|у)?|сек\.?))?\s*/u,
  /^\d{1,2}\s*(?:секунд(?:а|ы|у)?|сек\.?)\s*/u,
];

const SPOKEN_TIME_EN = [
  /^\d{1,3}\s*(?:hours?|hrs?|h)\.?\s*(?:\d{1,2}\s*(?:minutes?|mins?|m)\.?\s*)?(?:\d{1,2}\s*(?:seconds?|secs?|s)\.?\s*)?/i,
  /^\d{1,2}\s*(?:minutes?|mins?)\s*(?:\d{1,2}\s*(?:seconds?|secs?))?\s*/i,
  /^\d{1,2}\s*(?:seconds?|secs?)\s*/i,
];

/** Speech after a spoken timecode starts a new sentence. */
const SPEECH_AFTER_TIME = /^[«"'“(\p{Lu}\p{N}]/u;

/**
 * …but real speech can continue in lowercase after a *duration*: “5 минут
 * назад он сказал”. A direction word after the number means the number is part
 * of the sentence, not the panel's timecode.
 */
const TIME_DIRECTION = /^(назад|спустя|тому|позже|раньше|подряд|вперёд|ago|later|earlier|before|after)\b/i;

/** “X минут Y секунд” — the panel timecode; a bare “Y минут” stays untouched. */
const HAS_SECONDS_PART = /\d\s*(?:секунд|сек\.?|seconds?|secs?)/iu;

/** True when the duration and the speech after it are written in different scripts. */
function crossScript(timecode, rest) {
  const headRu = /[а-яё]/i.test(timecode);
  const headEn = /[a-z]/i.test(timecode);
  const restRu = /^[\s«"'“(]*[а-яё]/i.test(rest);
  const restEn = /^[\s«"'“(]*[a-z]/i.test(rest);
  return (headRu && restEn) || (headEn && restRu);
}

export function stripSpokenTime(text) {
  let t = normalizeText(text);
  // A row may carry two prefixes when the panel renders both the label and a
  // nested timing element; strip as long as one is there.
  for (let guard = 0; guard < 4; guard++) {
    const before = t;
    t = t.replace(/^[\s•·—–\-|:.,]+/, '');
    // The row may also start with the visible timecode itself (“0:08 5 минут 19
    // секунд Как умудрилось…”): the panel renders both the chip and the spoken
    // form. A caption line that begins with m:ss is a timestamp either way.
    t = t.replace(/^\d{1,3}:\d{2}(?::\d{2})?\s*/, '');
    for (const re of [...SPOKEN_TIME_RU, ...SPOKEN_TIME_EN]) {
      const m = t.match(re);
      if (!m || !m[0].trim()) continue;
      const rest = t.slice(m[0].length).replace(/^[\s•·—–\-|:.,]+/, '');
      if (!rest) continue;
      // A timecode that includes seconds is the panel's spoken form even when
      // the sentence continues in lowercase (“1 минута 46 секунд последнее
      // время он дал интервью”), while “5 минут назад…” is speech.
      // The panel is rendered in the interface language, the video in its own:
      // a Russian duration glued to English speech (“17 минут involved with
      // Israeli intelligence”) is chrome, never a spoken sentence.
      const timecode =
        SPEECH_AFTER_TIME.test(rest) ||
        (HAS_SECONDS_PART.test(m[0]) && !TIME_DIRECTION.test(rest)) ||
        (crossScript(m[0], rest) && !TIME_DIRECTION.test(rest));
      if (!timecode) continue;
      t = rest;
      break;
    }
    if (t === before) break;
  }
  return t;
}

/**
 * YouTube sometimes renders neighbouring UI chrome glued to a transcript row:
 * a recommendation title with no space before it, view counters (“401 тыс. •”),
 * relative dates (“• 2 г. назад”) and shelf labels (“В эфире”, “Плейлист Микс”).
 * The glue signature (a lowercase word touching an UPPERCASE word or a digit)
 * only fires when a counter/bullet anchor is present in the same row, so normal
 * speech — even “Gemini4”-style gluing in captions — is left alone.
 */
const UI_JUNK_ANCHOR = /(?:[•·]|\d[\d\s.,]{0,12}(?:тыс\w*|млн\w*|млрд\w*|views?\b)|\b\d{1,4}\s*(?:г|год\w*|лет|мес\w*|нед\w*|дн\w*|дня|дней)\.?\s*(?:назад|ago)|\b\d{1,4}\s*(?:мес\w*|нед\w*|дн\w*)|просмотрах?|просмотров|в эфире|up next|watch later)/iu;
// The real signature of concatenated UI strings: a lowercase word touching an
// UPPERCASE word or a digit (“РазборыПродолжение”, “назадВ”, “следует401”).
// Speech only qualifies with a counter/bullet anchor in the same row — “5 лет
// назад Гриша” or “стоит GPT6” stay untouched.
const UI_GLUE = /(\p{Ll}{2,})[\p{Lu}\d]/u;
const UI_COUNTER = /\b\d[\d\s.,]{0,12}(?:тыс\w*|млн\w*|млрд\w*|k\b|views?\b|просмотрах?|просмотров)|[•·]\s*\d{1,4}\s*(?:г|год\w*|лет|мес\w*|нед\w*|дн\w*|дня|дней|ч|час\w*|мин)\.?\s*(?:(?:назад|ago)(?![\p{L}\p{N}]))|\b\d{1,4}\s*(?:г|год\w*|лет|мес\w*|нед\w*|дн\w*|дня|дней)\.?\s*(?:(?:назад|ago)(?![\p{L}\p{N}]))/iu;
const UI_LABEL_RE = /^(?:[\s•·|,\-–—]*(?:в эфире|далее|подписчики|подписчиков|рекомендуемые|плейлист\w*|микс|смотреть позже|смотреть далее|продолжение следует|shorts|up next|watch later|playlist\w*|subscribers|recommended|mix|next up)(?![\p{L}\p{N}])[\s|·•—–-]*)+/iu;

/**
 * A row that is nothing but a view counter or a relative date: “401 тыс. • 2 г.
 * назад”, “2,4 млн • 3 мес.”, a leftover “3 мес.”. The panel prints these for
 * the recommendation cards next to the captions; “3 месяца спустя” is a spoken
 * sentence and does not end on the unit, so it stays.
 */
const COUNTER_ROW = /^[\s•·|,–—\-]*(?:\d[\d\s.,]{0,12}(?:тыс\w*|млн\w*|млрд\w*)?\.?\s*[•·]?\s*)?\d{0,4}\s*(?:г|год\w*|лет|мес\w*|нед\w*|дн\w*|дня|дней)\w*\.?\s*(?:(?:назад|ago)(?![\p{L}\p{N}]))?\s*[.?!]?$/iu;
const COUNTER_ROW_UNIT = /^[\s•·|,]*(?:\d[\d\s.,]{0,4})?\s*(?:мес\w*|нед\w*|дн\w*)\.?$/iu;

function isCounterRow(t) {
  if (!t || !COUNTER_ROW.test(t)) return false;
  // A bare date (“2019 год”, “5 лет”) can be speech; a view counter, a bullet
  // or a month/week unit is always the panel's card chrome.
  return UI_COUNTER.test(t) || COUNTER_ROW_UNIT.test(t);
}

/** Cuts glued YouTube UI chrome off a transcript row; no-op on clean speech. */
export function stripUiJunk(text) {
  let t = String(text || '');
  if (!UI_JUNK_ANCHOR.test(t)) return t;
  for (let pass = 0; pass < 5; pass++) {
    const before = t;
    const glue = t.match(UI_GLUE);
    if (glue) {
      // A recommendation title can be glued to the *end* of real speech
      // (“…and have How Israel Kills JournalistsHow israel kills…”), which
      // looks exactly like a title glued to the start of a row. Speech in front
      // of the glued title is kept when it reads as a sentence.
      const head = t.slice(0, glue.index + glue[1].length);
      const words = head.split(/\s+/).filter(Boolean);
      let cut = words.length;
      while (cut > 0 && /^[«"'“(]?\p{Lu}/u.test(words[cut - 1]) && !/[|:;]$/.test(words[cut - 1])) cut--;
      const speechHead = words.slice(0, cut).join(' ').trim();
      const speechWords = speechHead.split(/\s+/).filter(Boolean).length;
      if (speechWords >= 5 && !/\||https?:/i.test(speechHead) && UI_COUNTER.test(t.slice(glue.index))) {
        t = speechHead;
      } else {
        // Everything before the glued pair belongs to the previous UI blob.
        t = t.slice(glue.index + glue[1].length);
        // A counter/date blob often sits right after the glue («назадВ эфире»,
        // «следует401 тыс.»): it goes too, but only at the very front — the same
        // patterns inside real speech must stay.
        const counter = t.match(UI_COUNTER);
        if (counter && counter.index < 12) t = t.slice(counter.index + counter[0].length);
      }
    }
    t = t.replace(UI_LABEL_RE, ' ').trim();
    if (isCounterRow(t)) t = '';
    if (t === before) break;
  }
  return t;
}

/** Removes caption noise: [Music], (applause), speaker markers, duplicated spaces. */
export function cleanCaptionText(text) {
  let t = normalizeText(text);
  t = t.replace(SPEAKER_RE, ' ');
  t = t.replace(/\s*>>\s*/g, ' ');
  t = stripUiJunk(t);
  t = stripSpokenTime(t);
  t = t.replace(NON_SPEECH_RE, (m) => {
    // Keep short parenthetical words (they are usually actual speech).
    const inner = m.replace(/^[([(]|[)\]]$/g, '').trim();
    return inner && inner.length > 3 && /[а-яёa-z]/i.test(inner) && !/^(music|музыка|applause|аплодисменты|смех|laughter|sighs)$/i.test(inner)
      ? ` ${inner} `
      : ' ';
  });
  return normalizeText(t);
}

export function countSpeakers(segments) {
  let marks = 0;
  for (const s of segments || []) {
    const text = String(s && s.text ? s.text : '');
    const m = text.match(/>>/g);
    if (m) marks += m.length;
  }
  return marks + 1;
}

export function detectLang(text) {
  const s = String(text || '');
  let cyr = 0;
  let lat = 0;
  for (const ch of s) {
    if (/[А-Яа-яЁё]/.test(ch)) cyr++;
    else if (/[A-Za-z]/.test(ch)) lat++;
  }
  const total = cyr + lat;
  if (!total) return { lang: 'other', cyrillicRatio: 0, latinRatio: 0 };
  const cyrillicRatio = cyr / total;
  const lang = cyrillicRatio > 0.25 ? 'ru' : cyr === 0 ? 'en' : 'other';
  return { lang, cyrillicRatio, latinRatio: lat / total };
}

/**
 * Splits text into sentences, protecting abbreviations, initials and decimals.
 */
export function splitSentences(text) {
  const t = normalizeText(text);
  if (!t) return [];
  const out = [];
  let buf = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    buf += ch;
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;

    // Consume repeats and closing quotes: "?!", '..."'
    let j = i + 1;
    while (j < t.length && /[.!?…)"']/.test(t[j])) {
      buf += t[j];
      j++;
    }
    i = j - 1;

    const next = t[j];
    const boundary = !next || /\s/.test(next);
    if (!boundary) continue; // decimals like 3.14, domains like ya.ru

    const m = buf.trim().match(/([\p{L}\p{N}]+)[.!?…]+$/u);
    const lastWord = m ? m[1].toLowerCase().replace(/\./g, '') : '';
    if (ch === '.' && lastWord && lastWord.length <= 4) {
      if (ABBREV.has(lastWord)) continue;
      if (lastWord.length === 1 && /[а-яёa-z]/i.test(lastWord)) continue; // initials: "А. Пушкин"
    }
    out.push(buf.trim());
    buf = '';
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => (s.match(/[\p{L}\p{N}]/gu) || []).length > 1);
}

export function isCyrillic(word) {
  return /[а-яё]/i.test(word);
}

export function tokenize(text) {
  const normalized = normalizeText(text).toLowerCase().replace(/ё/g, 'е');
  const matches = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
  const out = [];
  for (let raw of matches) {
    const w = raw.replace(/^['’-]+|['’-]+$/g, '');
    if (!w) continue;
    if (/^\d+$/.test(w)) {
      if (/^(19|20)\d\d$/.test(w)) out.push(w); // years matter
      continue;
    }
    if (w.length < 2) continue;
    if (!/[\p{L}]/u.test(w)) continue;
    out.push(w);
  }
  return out;
}

const RU_SUFFIXES = [
  'иями', 'ями', 'ами', 'ией', 'иях', 'иям', 'ием', 'ия', 'ии', 'ию', 'ого', 'его', 'ому', 'ему',
  'ыми', 'ими', 'ей', 'ой', 'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ов', 'ев', 'ах', 'ях',
  'ам', 'ям', 'ом', 'ем', 'ую', 'юю', 'ся', 'сь', 'у', 'ю', 'а', 'я', 'ы', 'и', 'е', 'о', 'ь', 'й',
];

const EN_SUFFIXES = [
  'ational', 'ization', 'iveness', 'fulness', 'ousness', 'ations', 'ically', 'ingly', 'edly',
  'ments', 'tions', 'sions', 'nesses', 'ables', 'ibles', 'ing', 'ies', 'ied', 'ers', 'est',
  'ive', 'ity', 'ment', 'tion', 'sion', 'ness', 'able', 'ible', 'ally', 'ly', 'es', 'ed', 's', 'er',
];

/** Very light stemmer: strips common inflection suffixes, keeps roots. */
export function stem(word) {
  let w = String(word || '').toLowerCase().replace(/ё/g, 'е');
  if (w.length <= 4) return w;

  if (!isCyrillic(w)) return stemLatin(w);

  const suffixes = RU_SUFFIXES;
  let best = w;
  let bestLen = 0;
  for (const suf of suffixes) {
    if (w.endsWith(suf) && w.length - suf.length >= 4 && suf.length > bestLen) {
      best = w.slice(0, w.length - suf.length);
      bestLen = suf.length;
    }
  }
  if (best.endsWith('ться') && best.length > 6) best = best.slice(0, -3);
  else if (best.endsWith('тся') && best.length > 6) best = best.slice(0, -2);
  return best || w;
}

/** English: plural/verb endings plus a final silent "e" so caching/cache merge. */
function stemLatin(w) {
  let word = w;
  if (word.endsWith('ies') && word.length > 5) word = `${word.slice(0, -3)}y`;
  let best = word;
  let bestLen = 0;
  for (const suf of EN_SUFFIXES) {
    if (word.endsWith(suf) && word.length - suf.length >= 4 && suf.length > bestLen) {
      best = word.slice(0, word.length - suf.length);
      bestLen = suf.length;
    }
  }
  if (best.endsWith('e') && best.length > 4) best = best.slice(0, -1);
  return best || w;
}

export function stemsOf(tokens) {
  return stemPairs(tokens).map((p) => p.stem);
}

/**
 * Same filtering as {@link stemsOf}, but keeps the surface form of each stem.
 * Keyword extraction needs the pair: keying surfaces by the stem's *index* in
 * the filtered list mismatched them (stem “мармелад” was displayed as whatever
 * word happened to sit at that index), which is why the keyword cloud, section
 * headings and the lead line were built from wrong words.
 * @returns {Array<{stem: string, surface: string}>}
 */
export function stemPairs(tokens) {
  const out = [];
  for (const t of tokens || []) {
    if (STOP_SET.has(t)) continue;
    if (FILLER_SET.has(t) && t.length < 7) continue;
    const s = stem(t);
    if (s.length < 3 && !/^\d{4}$/.test(s)) continue;
    out.push({ stem: s, surface: t });
  }
  return out;
}

/** Co-occurring stem pairs used as an extra feature for long sentences. */
export function bigramsOf(stems) {
  const out = [];
  for (let i = 0; i + 1 < stems.length; i++) out.push(`${stems[i]} ${stems[i + 1]}`);
  return out;
}

/**
 * Discourse markers that never carry meaning at the start of a sentence.
 * “И вот тут, оправившись…” reads as a fragment; “Оправившись…” stands alone.
 */
const LEADING_NOISE = new Set([
  'и',
  'а',
  'но',
  'ну',
  'да',
  'вот',
  'тут',
  'вот-тут',
  'короче',
  'значит',
  'вобщем',
  'вообще',
  'просто',
]);

/** Removes leading discourse markers for cleaner display text. */
export function stripLeadingFillers(text) {
  let t = normalizeText(text);
  const parts = t.split(/\s+/);
  let i = 0;
  while (i < parts.length - 3) {
    const w = parts[i].toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
    if (FILLER_SET.has(w) || LEADING_NOISE.has(w)) i++;
    else break;
  }
  t = parts.slice(i).join(' ').trim();
  if (!t) return normalizeText(text);
  return t.replace(/^([\p{Ll}])/u, (ch) => ch.toUpperCase());
}

/**
 * A sentence that opens with a detached adverbial participle (“Оправившись от
 * потерь маминых денег, наш герой складывается…”) is grammatical in the video
 * and broken in a summary: the participle refers to the previous sentence,
 * which the summary does not show. The opening phrase is dropped so the main
 * clause stands on its own (“Наш герой складывается…”).
 *
 * Only a participle in the very first word is treated this way, and only when
 * the phrase ends with a comma: “Состав, который…” and “Устав, …” stay intact.
 */
const GERUND_TAIL = /(?:вшись|вши|шись|ив|ев|ав|яв|ув|йдя|идя)$/u;
const GERUND_NOUNS = new Set(['состав', 'устав', 'рукав', 'остров', 'кофе', 'экскаватор']);

export function stripDanglingOpener(text) {
  const t = normalizeText(text);
  const comma = t.indexOf(',');
  if (comma < 0) return t;
  const head = t.slice(0, comma).trim();
  const rest = t.slice(comma + 1).trim();
  if (!head || !rest) return t;
  const headWords = head.split(/\s+/);
  // A detached phrase is short; a long first clause is a real clause.
  if (headWords.length < 2 || headWords.length > 10) return t;
  const first = headWords[0].toLowerCase().replace(/[^а-яёa-z-]/gi, '');
  if (first.length < 5 || !GERUND_TAIL.test(first) || GERUND_NOUNS.has(first)) return t;
  // The remaining clause has to be a sentence on its own.
  if (rest.split(/\s+/).filter(Boolean).length < 4) return t;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Case-insensitive term-frequency map. */
export function termFreq(items) {
  const map = new Map();
  for (const it of items) map.set(it, (map.get(it) || 0) + 1);
  return map;
}
