/**
 * Loose coercion of model output into the canonical payload shape.
 *
 * Free and small models rarely return exactly the requested JSON. They wrap it
 * in {"result": …}, use snake_case or Russian field names, put key points into
 * one bulleted string, write sections as plain strings, or answer in Markdown
 * prose. Every one of those used to end as "Модель вернула не-JSON" even though
 * the answer contained a usable summary. This module never throws and never
 * invents facts: it only renames fields, splits lists and unwraps containers.
 */

import { countWords, formatTime, normalizeWhitespace, parseTimestamp } from '../common/util.js';

const FIELD_ALIASES = {
  tldr: ['tldr', 'tldrtext', 'summary', 'abstract', 'overview', 'gist', 'short', 'кратко', 'суть', 'сутьвидео', 'итог', 'резюме', 'аннотация', 'обзор'],
  keyPoints: ['keypoints', 'keymoments', 'points', 'highlights', 'mainpoints', 'importantpoints', 'bullets', 'ключевыемоменты', 'ключевыетезисы', 'тезисы', 'пункты', 'основныемысли', 'главное'],
  sections: ['sections', 'chapters', 'parts', 'structure', 'разделы', 'главы', 'части', 'структура'],
  takeaways: ['takeaways', 'conclusions', 'insights', 'lessons', 'выводы', 'итоги'],
  actionItems: ['actionitems', 'actions', 'recommendations', 'todo', 'nextsteps', 'чтосделать', 'рекомендации', 'действия', 'шаги'],
  questions: ['questions', 'selfcheck', 'quiz', 'вопросы', 'вопросыдлясамопроверки'],
  quotes: ['quotes', 'directquotes', 'цитаты'],
  citations: ['citations', 'sources', 'evidence', 'источники', 'подтверждения'],
  entities: ['entities', 'mentions', 'people', 'сущности', 'упомянутыесущности'],
  keywords: ['keywords', 'keyphrases', 'tags', 'ключевыеслова', 'теги'],
  notes: ['notes', 'caveats', 'warnings', 'заметки', 'примечания', 'оговорки'],
  answer: ['answer', 'ответнавопрос', 'answertext'],
  notFound: ['notfound', 'notfoundinvideo', 'нетответа'],
  confidence: ['confidence', 'уверенность'],
};

const FIELD_BY_KEY = new Map();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  for (const alias of aliases) FIELD_BY_KEY.set(normKey(alias), field);
}

const WRAPPER_KEYS = new Set([
  'result', 'data', 'response', 'output', 'payload', 'json', 'content',
  'summaryresult', 'answerjson', 'конспект', 'результат', 'ответ', 'данные', 'содержание',
]);

/** Lowercase and drop separators: "key_points" / "Key Points" -> "keypoints". */
function normKey(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** One whitespace-collapsed line (normalizeWhitespace would eat newlines). */
function squashLine(value) {
  return String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/[ \t\f\v]+/g, ' ').trim();
}

/** Text without markdown decoration and without a leading "TL;DR:" label. */
function cleanText(value) {
  let s = normalizeWhitespace(value);
  s = s.replace(/^[#>*_\s]+/, '');
  s = s.replace(/^(?:[*_#>\s])*(?:tl;?dr|кратко|суть(?:\s+видео)?|итог|summary|резюме|выводы)\s*(?:\*\*|__)?\s*[:—–-]\s*/i, '');
  s = s.replace(/^\*\*([\s\S]+)\*\*$/, '$1');
  s = s.replace(/^["'«“](.*)["'»”]$/s, '$1');
  return s.trim();
}

function pickField(object, field) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  for (const key of Object.keys(object)) {
    if (FIELD_BY_KEY.get(normKey(key)) !== field) continue;
    const value = object[key];
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function pickRaw(object, names) {
  if (!object || typeof object !== 'object') return undefined;
  const wanted = new Set(names.map(normKey));
  for (const key of Object.keys(object)) {
    if (!wanted.has(normKey(key))) continue;
    const value = object[key];
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function asText(value) {
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    for (const key of ['text', 'summary', 'content', 'value', 'tldr', 'description']) {
      const text = asText(value[key]);
      if (text) return text;
    }
  }
  return '';
}

/** Removes list markers so "-- foo" and "1. foo" become one text. */
function stripMarkers(value) {
  let s = cleanText(value);
  s = s.replace(/^(?:[-*+•·–—]\s+|\d{1,2}[.)]\s+|\(\d{1,2}\)\s+)/, '');
  s = s.replace(/(?:\*\*|__|\*|_|`)$/, '');
  return s.trim();
}

/** Reads one list item: strips markers and a leading/trailing timecode. */
function extractPoint(input) {
  let text = stripMarkers(input);
  if (!text) return { text: '', at: null, ts: null };
  let at = null;
  const head = /^[[(]?(\d{1,3}:\d{2}(?::\d{2})?)[\])]?\s*(?:[-–—:|.)]+)?\s+/.exec(text);
  if (head) {
    at = parseTimestamp(head[1]);
    const rest = text.slice(head[0].length).trim();
    if (rest) text = rest;
  }
  const tail = /\s*[[(](\d{1,3}:\d{2}(?::\d{2})?)[\])]\s*$/.exec(text);
  if (tail) {
    if (at == null) at = parseTimestamp(tail[1]);
    const rest = text.slice(0, tail.index).trim();
    if (rest) text = rest;
  }
  return { text, at, ts: at == null ? null : formatTime(at) };
}

function coercePoint(item) {
  if (typeof item === 'string') {
    const point = extractPoint(item);
    return point.text ? point : null;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  let text = '';
  for (const key of ['text', 'point', 'sentence', 'content', 'value', 'fact', 'claim', 'insight', 'description', 'пункт', 'тезис', 'текст', 'факт', 'мысль']) {
    const value = pickRaw(item, [key]);
    if (typeof value === 'string' && value.trim()) {
      text = value;
      break;
    }
  }
  if (!text) {
    for (const value of Object.values(item)) {
      if (typeof value === 'string' && value.trim()) {
        text = value;
        break;
      }
    }
  }
  const point = extractPoint(text);
  if (!point.text) return null;
  const explicit = parseTimestamp(item.at ?? item.time ?? item.timestamp ?? item.start ?? item.ts ?? item.таймкод);
  const at = explicit == null ? point.at : explicit;
  return { text: point.text, at, ts: at == null ? null : formatTime(at) };
}

function splitListText(value) {
  const raw = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];
  const lines = raw.split('\n').map(squashLine).filter(Boolean);
  const bullets = lines.map(bulletOf).filter((line) => line != null);
  if (bullets.length >= 2) return bullets;
  if (lines.length === 1) return bullets.length ? bullets : [lines[0]];
  if (bullets.length === lines.length) return bullets;
  if (!bullets.length && lines.length <= 12 && lines.every((line) => countWords(line) <= 24)) return lines;
  const inline = raw.split(/\s*[•·]\s*/).filter(Boolean);
  if (inline.length > 1) return inline;
  return bullets.length ? bullets : [raw];
}

function coercePoints(value, limit = 24) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const point = coercePoint(item);
    if (!point) return;
    const key = point.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(point);
  };
  if (typeof value === 'string') {
    for (const part of splitListText(value)) push(part);
  } else if (Array.isArray(value)) {
    for (const item of value) push(item);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) push(item);
  }
  return out.slice(0, limit);
}

function coerceStringList(value, limit = 12) {
  if (value == null) return [];
  const list = typeof value === 'string' ? splitListText(value) : Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    const point = coercePoint(item);
    const text = point ? point.text : stripMarkers(asText(item));
    if (!text) continue;
    if (out.some((existing) => existing.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out.slice(0, limit);
}

/** "Введение: о чём видео" -> heading + summary; null when there is no colon. */
function splitHeadingLine(text) {
  const m = /^(.{2,60}?)\s*[:—–]\s+(.+)$/s.exec(text);
  if (!m) return null;
  const heading = cleanText(m[1]);
  const summary = cleanText(m[2]);
  if (!heading || !summary || countWords(heading) > 10) return null;
  return { heading, summary };
}

function coerceSection(item) {
  if (typeof item === 'string') {
    const text = stripMarkers(item);
    if (!text) return null;
    const split = splitHeadingLine(text);
    return split
      ? { heading: split.heading, summary: split.summary, points: [] }
      : { heading: '', summary: text, points: [] };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  let heading = asText(pickRaw(item, ['heading', 'title', 'name', 'заголовок', 'тема']));
  const summaryRaw = pickRaw(item, ['summary', 'description', 'text', 'about', 'описание', 'текст']);
  let summary = Array.isArray(summaryRaw) ? '' : asText(summaryRaw);
  const pointsValue = pickRaw(item, ['points', 'keypoints', 'bullets', 'items', 'пункты', 'тезисы'])
    ?? (Array.isArray(summaryRaw) ? summaryRaw : undefined);
  if (!heading && summary) {
    const split = splitHeadingLine(summary);
    if (split) {
      heading = split.heading;
      summary = split.summary;
    }
  }
  const points = coercePoints(pointsValue, 8);
  if (!heading && !summary && !points.length) return null;
  // Section timecodes are what groups the panel by moment; dropping them here
  // made every section fall back to nothing after normalization.
  const section = { heading, summary, points };
  const at = parseTimestamp(item.at ?? item.time ?? item.timestamp ?? item.start ?? item.ts ?? item.таймкод);
  if (at != null) {
    section.at = at;
    section.ts = formatTime(at);
  }
  return section;
}

function coerceSections(value, limit = 20) {
  if (typeof value === 'string') {
    const prose = proseToPayload(value);
    if (prose.sections?.length) return prose.sections.slice(0, limit);
    return splitListText(value).map(coerceSection).filter(Boolean).slice(0, limit);
  }
  if (Array.isArray(value)) return value.map(coerceSection).filter(Boolean).slice(0, limit);
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([heading, body]) => {
        if (Array.isArray(body)) return coerceSection({ heading, points: body });
        if (body && typeof body === 'object') return coerceSection({ heading, ...body });
        return coerceSection({ heading, summary: body });
      })
      .filter(Boolean)
      .slice(0, limit);
  }
  return [];
}

/** Descends into {"result": {...}} and similar single-container answers. */
function unwrapOnce(object) {
  const keys = Object.keys(object);
  const hasContent = keys.some((key) => {
    const field = FIELD_BY_KEY.get(normKey(key));
    if (!field || field === 'notFound' || field === 'confidence') return false;
    const value = object[key];
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return false;
  });
  if (hasContent) return null;
  for (const key of keys) {
    const value = object[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (WRAPPER_KEYS.has(normKey(key)) || (normKey(key) === 'summary' && !asText(value))) return value;
  }
  if (keys.length === 1) {
    const value = object[keys[0]];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

/**
 * Turns almost-any parsed object into a payload `normalizeResult` understands.
 * Original keys are kept (timeline and map paths read them directly), canonical
 * aliases are added on top.
 */
export function coercePayload(raw, depth = 0) {
  if (raw == null || depth > 3) return {};
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return coercePayload(parsed, depth + 1);
    } catch {
      /* not JSON: prose is handled below */
    }
    return looksLikeProseAnswer(text) ? proseToPayload(text) : {};
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const out = coercePayload(item, depth + 1);
      if (Object.keys(out).length) return out;
    }
    return {};
  }
  if (typeof raw !== 'object') return {};

  let object = raw;
  for (let i = 0; i < 3; i++) {
    const inner = unwrapOnce(object);
    if (!inner) break;
    object = inner;
  }

  const out = { ...object };

  const tldr = asText(pickField(object, 'tldr'));
  if (tldr) out.tldr = tldr;

  const sections = coerceSections(pickField(object, 'sections'));
  if (sections.length) out.sections = sections;

  const allKeyPoints = coercePoints(pickField(object, 'keyPoints'));
  // A single-section prose answer repeats its bullets as `points`, which is an
  // alias of `keyPoints`. Keeping both copies made `normalizeResult` drop the
  // section bullets as duplicates and leave the section empty.
  const sectionKeys = new Set();
  for (const section of sections) {
    for (const point of section.points || []) {
      const key = String(point?.text || '').trim().toLowerCase();
      if (key) sectionKeys.add(key);
    }
  }
  const keyPoints = allKeyPoints.filter((point) => !sectionKeys.has(String(point.text || '').trim().toLowerCase()));
  if (keyPoints.length || sections.length) {
    // An explicit empty array also hides an aliased duplicate list
    // (`key_points`) that `normalizeResult` would otherwise read instead.
    out.keyPoints = keyPoints;
  }
  if (keyPoints.length) {
    // The map path and the live draft read `points` directly; a model that put
    // its key moments into one bulleted string would otherwise look empty.
    const current = out.points;
    const canonical = Array.isArray(current)
      && current.length > 0
      && current.every((item) => item && typeof item === 'object' && String(item.text || '').trim());
    if (!canonical) out.points = keyPoints;
  }

  for (const field of ['takeaways', 'actionItems', 'questions', 'notes']) {
    const list = coerceStringList(pickField(object, field));
    if (list.length) out[field] = list;
  }

  const quotes = coercePoints(pickField(object, 'quotes'), 8);
  if (quotes.length) out.quotes = quotes;

  const citations = coercePoints(pickField(object, 'citations'), 8);
  if (citations.length) out.citations = citations;

  const entities = pickField(object, 'entities');
  if (Array.isArray(entities)) out.entities = entities;
  const keywords = pickField(object, 'keywords');
  if (Array.isArray(keywords)) out.keywords = keywords;
  if (object.sentiment && typeof object.sentiment === 'object') out.sentiment = object.sentiment;

  const answer = asText(pickField(object, 'answer'));
  if (answer) out.answer = answer;

  const notFound = pickField(object, 'notFound');
  if (typeof notFound === 'boolean') out.notFound = notFound;
  else if (typeof notFound === 'string' && /^(?:true|да|yes|1)$/i.test(notFound.trim())) out.notFound = true;

  const confidence = Number(pickField(object, 'confidence'));
  if (Number.isFinite(confidence)) out.confidence = confidence;

  return out;
}

function bulletOf(line) {
  const m = /^(?:[-*+•·–—]\s+|\d{1,2}[.)]\s+)(.+)$/.exec(String(line || '').trim());
  return m ? m[1].trim() : null;
}

/** Markdown heading or a short standalone bold line; null for ordinary text. */
function headingOf(line) {
  let m = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
  if (m) return cleanText(m[1]);
  m = /^(?:\*\*|__)([^*_]{2,80})(?:\*\*|__)\s*:?\s*$/.exec(line);
  if (m && countWords(m[1]) <= 10) return cleanText(m[1]);
  return null;
}

function splitSentences(text) {
  const matches = String(text || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  return (matches || []).map((s) => s.trim()).filter(Boolean);
}

function cleanFluff(text) {
  let s = normalizeWhitespace(text);
  s = s.replace(/^(?:конечно|разумеется|итак|вот|here(?:'s| is| are)|sure)[,!:]\s*/i, '');
  s = s.replace(/^(?:вот\s+)?(?:краткий\s+)?(?:конспект|пересказ)[^:]{0,40}:\s*/i, '');
  s = s.replace(/^(?:here is|here are)\s+(?:a|the)\s+(?:short\s+)?summary[^:]{0,40}:\s*/i, '');
  return s.trim();
}

/** Prose answer -> payload. Never throws; returns {} when there is no text. */
export function proseToPayload(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  if (!source) return {};
  const sections = [];
  const loose = [];
  const lead = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const summary = cleanFluff(current.summaryLines.join(' '));
    if (current.heading || summary || current.points.length) {
      sections.push({ heading: current.heading, summary, points: current.points });
    }
    current = null;
  };

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^```/.test(line)) continue;
    const heading = headingOf(line);
    if (heading) {
      flush();
      current = { heading, summaryLines: [], points: [] };
      continue;
    }
    const bullet = bulletOf(line);
    if (bullet != null) {
      const point = coercePoint(bullet);
      if (point) (current ? current.points : loose).push(point);
      continue;
    }
    if (current) current.summaryLines.push(line);
    else lead.push(line);
  }
  flush();

  const out = {};
  let tldr = cleanFluff(lead.join(' '));
  if (!tldr && sections.length === 1) tldr = sections[0].summary;
  if (tldr) {
    const sentences = splitSentences(tldr);
    if (sentences.length > 4) {
      tldr = sentences.slice(0, 3).join(' ');
      for (const sentence of sentences.slice(3)) loose.push({ text: sentence, at: null, ts: null });
    }
    out.tldr = tldr;
  }
  if (loose.length) out.keyPoints = loose;
  if (sections.length) {
    out.sections = sections;
    if (sections.length === 1) {
      out.heading = sections[0].heading;
      out.summary = sections[0].summary;
      if (sections[0].points.length) out.points = sections[0].points;
    }
  }
  const points = loose.length ? loose : sections.length === 1 ? sections[0].points : [];
  if (points.length) out.points = points;

  const answer = cleanAnswer(source);
  if (answer) out.answer = answer;
  const citations = extractCitations(source);
  if (citations.length) out.citations = citations;
  return out;
}

function cleanAnswer(source) {
  const lines = String(source)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    const first = lines[0];
    if (/[:：]$/.test(first) && countWords(first) <= 12) lines.shift();
  }
  return lines
    .join('\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim()
    .slice(0, 2000);
}

function extractCitations(source) {
  const out = [];
  for (const piece of String(source).split(/(?<=[.!?])\s+|\n+/)) {
    const m = /[[(](\d{1,3}:\d{2}(?::\d{2})?)[\])]/.exec(piece);
    if (!m) continue;
    const text = stripMarkers(piece.replace(m[0], '')).slice(0, 180);
    if (!text) continue;
    out.push({ text, at: m[1], ts: m[1] });
    if (out.length >= 3) break;
  }
  return out;
}

function isRefusal(text) {
  if (text.length > 600) return false;
  return /^(?:извините|простите|к сожалению|sorry|i(?:'m| am) sorry|as an ai|я не могу|i (?:can(?:'|no)t|cannot) (?:help|assist))/i.test(text);
}

/**
 * True when a failed JSON answer is still a usable prose summary or Q&A answer.
 * JSON-looking fragments, schema echoes and short refusals are rejected: they
 * must keep their real error instead of being rendered as a конспект.
 */
export function looksLikeProseAnswer(text) {
  const source = String(text || '').trim();
  if (!source) return false;
  if (!/[A-Za-zА-Яа-яЁё]/.test(source)) return false;
  // A broken JSON document is not prose: let the repair/salvage path own it.
  if (/\{\s*["']?[\p{L}_]/u.test(source)) return false;
  if (/^\s*[[{]/.test(source) && /["']\s*:/.test(source)) return false;
  if (countWords(source) < 3 && !/\d{1,3}:\d{2}/.test(source)) return false;
  if (isRefusal(source)) return false;
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const schemaLines = lines.filter((line) => /^(?:строка|тезис|тема|цитата|текст|пример|число)\s*[:—–-]/i.test(line)).length;
  if (schemaLines >= 2) return false;
  return true;
}
