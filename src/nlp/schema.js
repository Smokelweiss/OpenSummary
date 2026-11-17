/**
 * Canonical summary schema + normalizers + text renderers.
 * Both engines (local NLP and AI) produce this shape, so the UI,
 * cache, export and Q&A work identically for either.
 */

import { APP } from '../common/constants.js';
import { formatTime, parseTimestamp, truncate, normalizeWhitespace, countWords, capitalize } from '../common/util.js';

export const SCHEMA_VERSION = 1;

export const LABELS = {
  ru: {
    tldr: 'Кратко',
    keyPoints: 'Ключевые моменты',
    sections: 'Разделы',
    takeaways: 'Выводы',
    actionItems: 'Что можно сделать',
    questions: 'Вопросы для самопроверки',
    quotes: 'Цитаты',
    keywords: 'Ключевые слова',
    entities: 'Упомянутые сущности',
    stats: 'Статистика',
    timeline: 'Таймлайн',
    words: 'слов',
    duration: 'длительность',
    speechRate: 'темп речи',
    wpm: 'слов/мин',
    readingTime: 'время чтения конспекта',
    compression: 'сжатие',
    sentiment: 'тональность',
    speech: 'речь',
    local: 'локальный движок (без ИИ)',
    ai: 'ИИ',
    source: 'источник транскрипта',
    generated: 'Сгенерировано',
    transcript: 'Транскрипт',
  },
  en: {
    tldr: 'Overview',
    keyPoints: 'Key moments',
    sections: 'Sections',
    takeaways: 'Takeaways',
    actionItems: 'Action items',
    questions: 'Self-check questions',
    quotes: 'Quotes',
    keywords: 'Keywords',
    entities: 'Mentioned entities',
    stats: 'Stats',
    timeline: 'Timeline',
    words: 'words',
    duration: 'duration',
    speechRate: 'speech rate',
    wpm: 'wpm',
    readingTime: 'reading time',
    compression: 'compression',
    sentiment: 'sentiment',
    speech: 'speech',
    local: 'local engine (no AI)',
    ai: 'AI',
    source: 'transcript source',
    generated: 'Generated',
    transcript: 'Transcript',
  },
};

export function labelsFor(lang) {
  const l = String(lang || 'ru').slice(0, 2).toLowerCase();
  return LABELS[l] || LABELS.en;
}

/**
 * Field descriptions from the prompt schema (“строка: …”, “тема”, “тезис 8-25
 * слов”) are instructions for the model, not summary text. A weak free model
 * echoes the example JSON verbatim, and the draft then rendered cards titled
 * “тема” with “тезис 8-25 слов” as their bullets.
 */
const PLACEHOLDER_RE =
  /^(?:<[^>]{1,120}>|\.{2,}$|…$|-+$|n\/?a$|none$|строка\s*[:—-]|тема$|тезис(?:\s+8-25\s+слов)?$|цитата$|текст$|пример$|число\s*\/\s*факт|короткий заголовок|рекомендация(?:\s*,?\s*если\s+есть)?$|mm:ss$)/i;

export function withoutPlaceholder(value) {
  const text = normalizeWhitespace(value == null ? '' : String(value));
  return PLACEHOLDER_RE.test(text) ? '' : text;
}

export function normalizePoint(input) {
  if (typeof input === 'string') {
    const text = withoutPlaceholder(input);
    return text ? { text, at: null, ts: null } : null;
  }
  const text = withoutPlaceholder(input?.text || input?.point || input?.sentence || '');
  if (!text) return null;
  const at = parseTimestamp(input?.at ?? input?.time ?? input?.timestamp ?? input?.start ?? null);
  return {
    text,
    at: at == null ? null : at,
    ts: at == null ? null : formatTime(at),
  };
}

function normalizePoints(list, limit) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const p = normalizePoint(item);
    if (p) out.push(p);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/**
 * A weak model sometimes returns a string where the schema says array
 * (`"takeaways": "проверять факты"`). Treating it as an array keeps that one
 * item instead of throwing `value.map is not a function` and losing the whole
 * answer.
 */
function listOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  return [];
}

/**
 * One section, validated exactly as normalizeResult() validates it. Exported so
 * the streamed preview and the final result cannot drift apart: a section shown
 * before the answer ends is the same object the finished summary will contain.
 */
export function normalizeSection(input) {
  const s = input && typeof input === 'object' ? input : {};
  const heading = withoutPlaceholder(s.heading || s.title || s.name || '');
  const at = parseTimestamp(s.at ?? s.time ?? s.timestamp ?? null);
  const summary = withoutPlaceholder(s.summary || s.text || s.description || '');
  const points = normalizePoints(s.points || s.keyPoints || s.bullets, 8);
  if (!heading && !summary && !points.length) return null;
  return {
    heading: heading || (points[0] ? truncate(points[0].text, 60) : ''),
    at: at == null ? (points[0]?.at ?? null) : at,
    ts: at == null ? (points[0]?.ts ?? null) : formatTime(at),
    summary,
    points,
  };
}

export function emptyResult(ctx = {}) {
  return {
    schema: SCHEMA_VERSION,
    mode: ctx.mode || 'local',
    engine: ctx.engine || APP.engineLocal,
    videoId: ctx.videoId || '',
    videoTitle: ctx.videoTitle || '',
    channel: ctx.channel || '',
    lengthSeconds: Number(ctx.lengthSeconds) || 0,
    url: ctx.url || (ctx.videoId ? `https://www.youtube.com/watch?v=${ctx.videoId}` : ''),
    lang: ctx.lang || 'ru',
    uiLang: ctx.uiLang || ctx.lang || 'ru',
    createdAt: ctx.createdAt || new Date().toISOString(),
    provider: ctx.provider || '',
    model: ctx.model || '',
    tldr: '',
    keyPoints: [],
    sections: [],
    takeaways: [],
    actionItems: [],
    questions: [],
    quotes: [],
    entities: [],
    keywords: [],
    topics: [],
    timeline: [],
    sentiment: { label: 'neutral', score: 0 },
    stats: {},
    notes: [],
    meta: ctx.meta || {},
  };
}

/** Normalizes an AI (or local) payload into the canonical shape. */
export function normalizeResult(raw, ctx = {}) {
  const base = emptyResult(ctx);
  const r = raw && typeof raw === 'object' ? raw : {};
  const tldrRaw = r.tldr ?? r.summary ?? r.abstract ?? r.overview ?? base.tldr;
  const merge = {
    ...base,
    ...ctx,
    tldr: withoutPlaceholder(
      tldrRaw && typeof tldrRaw === 'object' ? tldrRaw.text || tldrRaw.summary || '' : tldrRaw,
    ),
    keyPoints: normalizePoints(listOf(r.keyPoints || r.key_points || r.points || r.highlights), 24),
    takeaways: listOf(r.takeaways || r.conclusions || r.insights).map((t) => withoutPlaceholder(typeof t === 'string' ? t : t?.text)).filter(Boolean).slice(0, 12),
    actionItems: listOf(r.actionItems || r.action_items || r.recommendations).map((t) => withoutPlaceholder(typeof t === 'string' ? t : t?.text)).filter(Boolean).slice(0, 12),
    questions: listOf(r.questions || r.openQuestions).map((t) => withoutPlaceholder(typeof t === 'string' ? t : t?.text)).filter(Boolean).slice(0, 12),
    quotes: normalizePoints(listOf(r.quotes), 8),
    entities: listOf(r.entities || r.mentions)
      .map((e) => {
        if (typeof e === 'string') return { name: normalizeWhitespace(e), type: 'other', mentions: 1 };
        const name = normalizeWhitespace(e?.name || e?.text || '');
        if (!name) return null;
        return { name, type: String(e?.type || 'other'), mentions: Number(e?.mentions || e?.count || 1) };
      })
      .filter(Boolean)
      .slice(0, 20),
    sections: listOf(r.sections || r.chapters)
      .map(normalizeSection)
      .filter(Boolean)
      .slice(0, 20),
    keywords: listOf(r.keywords || r.keyPhrases || r.key_phrases)
      .map((k) => {
        if (typeof k === 'string') return { term: normalizeWhitespace(k), score: 0.5 };
        const term = withoutPlaceholder(k?.term || k?.text || k?.name || '');
        if (!term) return null;
        return { term, score: Number(k?.score || k?.weight || 0.5), at: parseTimestamp(k?.at ?? k?.timestamp ?? null) };
      })
      .filter(Boolean)
      .slice(0, 40),
    notes: Array.isArray(r.notes) ? r.notes.map((n) => normalizeWhitespace(String(n))).filter(Boolean).slice(0, 10) : base.notes,
  };
  if (r.sentiment && typeof r.sentiment === 'object') {
    merge.sentiment = {
      label: String(r.sentiment.label || 'neutral'),
      score: Number(r.sentiment.score || 0),
    };
  } else if (typeof r.sentiment === 'string' && r.sentiment) {
    const s = r.sentiment.toLowerCase();
    merge.sentiment = {
      label: s.includes('pos') ? 'positive' : s.includes('neg') ? 'negative' : 'neutral',
      score: s.includes('pos') ? 0.4 : s.includes('neg') ? -0.4 : 0,
    };
  }
  if (r.stats && typeof r.stats === 'object') merge.stats = { ...base.stats, ...r.stats };
  if (Array.isArray(r.timeline)) merge.timeline = r.timeline;
  if (Array.isArray(r.topics)) {
    merge.topics = r.topics
      .map((t) => (typeof t === 'string' ? { term: normalizeWhitespace(t), score: 0.5 } : { term: normalizeWhitespace(t?.term || ''), score: Number(t?.score || 0.5), at: parseTimestamp(t?.at ?? null) }))
      .filter((t) => t.term);
  }
  // Chunks overlap so a topic spanning a boundary is not cut. The same sentence
  // can therefore arrive twice; drop only exact repeats, never paraphrases.
  const seenTexts = new Set();
  const uniquePoints = (points) =>
    points.filter((point) => {
      const key = normalizeWhitespace(point.text || '').toLowerCase();
      if (!key || seenTexts.has(key)) return false;
      seenTexts.add(key);
      return true;
    });
  merge.keyPoints = uniquePoints(merge.keyPoints);
  merge.sections = merge.sections.map((section) => ({ ...section, points: uniquePoints(section.points) }));
  // A summary reads along the video, not along the model's answer. Models emit
  // moments in the order they come to mind (21:32 before 13:38), so every list
  // of timestamped items is put back in transcript order here, once, for both
  // engines and every renderer. Points without a timecode keep their relative
  // order and stay after the timed ones instead of pretending to be at 0:00.
  const byTime = (a, b) => {
    const atA = a?.at ?? null;
    const atB = b?.at ?? null;
    if (atA != null && atB != null) return atA - atB;
    if (atA != null) return -1;
    if (atB != null) return 1;
    return 0;
  };
  merge.keyPoints = merge.keyPoints.slice().sort(byTime);
  merge.sections = merge.sections
    .slice()
    .sort(byTime)
    .map((section) => ({ ...section, points: section.points.slice().sort(byTime) }));

  merge.mode = ctx.mode || r.mode || base.mode;
  merge.engine = ctx.engine || r.engine || base.engine;
  merge.provider = ctx.provider || r.provider || '';
  merge.model = ctx.model || r.model || '';
  return merge;
}

/* --------------------------------------------------------------- renderers */

/**
 * Markdown lines for one list of timed points. Points that start at the same
 * second share one timecode link, and the rest become nested bullets: the model
 * writes several moments per second often, and a list that repeated “0:56”
 * three times read as three separate moments.
 */
function pushTimedGroups(lines, points, result, { hideTsAt = null } = {}) {
  const groups = [];
  for (const p of points || []) {
    const text = String(p?.text || '').trim();
    if (!text) continue;
    const at = p?.at == null ? null : Number(p.at);
    const last = groups[groups.length - 1];
    if (last && at != null && last.at === at) last.items.push({ ...p, text });
    else groups.push({ at, ts: p?.ts || (at == null ? null : formatTime(at)), items: [{ ...p, text }] });
  }
  for (const group of groups) {
    const hide = hideTsAt != null && group.at != null && Number(group.at) === Number(hideTsAt);
    const stamp = group.at == null || hide ? '' : `[${group.ts}](${timeLink(result, group.at)}) `;
    lines.push(`- ${stamp}${group.items[0].text}`);
    for (const extra of group.items.slice(1)) lines.push(`  - ${extra.text}`);
  }
}

export function renderMarkdown(result, { includeTranscript = false, transcript = null, uiLang } = {}) {
  const L = labelsFor(uiLang || result.uiLang || result.lang);
  const lines = [];
  const title = result.videoTitle || (result.videoId ? `YouTube ${result.videoId}` : 'Summary');
  lines.push(`# ${title}`);
  const metaBits = [];
  if (result.channel) metaBits.push(result.channel);
  if (result.lengthSeconds) metaBits.push(formatTime(result.lengthSeconds));
  if (result.stats?.words) metaBits.push(`${result.stats.words} ${L.words}`);
  if (result.lang) metaBits.push(result.lang);
  if (metaBits.length) lines.push(`*${metaBits.join(' · ')}*`);
  if (result.url) lines.push(`<${result.url}>`);
  lines.push('');

  if (result.tldr) {
    lines.push(`## ${L.tldr}`);
    lines.push(result.tldr);
    lines.push('');
  }

  if (result.sections.length) {
    lines.push(`## ${L.sections}`);
    for (const s of result.sections) {
      lines.push(`### ${s.ts ? `[${s.ts}](${timeLink(result, s.at)}) ` : ''}${s.heading}`);
      if (s.summary) lines.push(s.summary);
      pushTimedGroups(lines, s.points, result, { hideTsAt: s.at });
      lines.push('');
    }
  }

  if (result.keyPoints.length) {
    lines.push(`## ${L.keyPoints}`);
    pushTimedGroups(lines, result.keyPoints, result);
    lines.push('');
  }

  const block = (label, items) => {
    if (!items || !items.length) return;
    lines.push(`## ${label}`);
    for (const it of items) lines.push(`- ${it}`);
    lines.push('');
  };
  block(L.takeaways, result.takeaways);
  block(L.actionItems, result.actionItems);
  block(L.questions, result.questions);

  if (result.quotes.length) {
    lines.push(`## ${L.quotes}`);
    for (const q of result.quotes) lines.push(`> ${q.ts ? `**${q.ts}** ` : ''}${q.text}`);
    lines.push('');
  }

  if (result.keywords.length) {
    lines.push(`## ${L.keywords}`);
    lines.push(result.keywords.map((k) => k.term).join(', '));
    lines.push('');
  }

  if (result.stats && Object.keys(result.stats).length) {
    lines.push(`## ${L.stats}`);
    const s = result.stats;
    if (s.words) lines.push(`- ${L.words}: ${s.words}`);
    if (s.sentences) lines.push(`- sentences: ${s.sentences}`);
    if (result.lengthSeconds) lines.push(`- ${L.duration}: ${formatTime(result.lengthSeconds)}`);
    if (s.speechRateWpm) lines.push(`- ${L.speechRate}: ${s.speechRateWpm} ${L.wpm}`);
    if (s.readingTimeSec) lines.push(`- ${L.readingTime}: ${Math.max(1, Math.round(s.readingTimeSec / 60))} min`);
    if (s.compression) lines.push(`- ${L.compression}: ${Math.round(s.compression * 100)}%`);
    if (result.sentiment?.label) lines.push(`- ${L.sentiment}: ${result.sentiment.label} (${result.sentiment.score})`);
    if (s.transcriptSource) lines.push(`- ${L.source}: ${s.transcriptSource}`);
    lines.push('');
  }

  if (result.notes?.length) {
    lines.push('---');
    for (const n of result.notes) lines.push(`> ${n}`);
    lines.push('');
  }

  if (includeTranscript && Array.isArray(transcript) && transcript.length) {
    lines.push(`## ${L.transcript}`);
    for (const seg of transcript) lines.push(`- [${formatTime(seg.start)}](${timeLink(result, seg.start)}) ${seg.text}`);
    lines.push('');
  }

  lines.push('---');
  const engineLabel = result.mode === 'ai' ? `${L.ai}${result.model ? ` · ${result.model}` : ''}` : L.local;
  lines.push(`${L.generated}: ${APP.name} ${APP.version} · ${engineLabel} · ${new Date(result.createdAt).toISOString().slice(0, 16).replace('T', ' ')}`);
  return lines.join('\n');
}

export function renderText(result, opts = {}) {
  return renderMarkdown(result, opts)
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]\([^)]*\)/g, '[$1]')
    .replace(/\*\*/g, '')
    .replace(/^### /gm, '• ')
    .replace(/^## /gm, '\n')
    .replace(/^# /gm, '');
}

export function timeLink(result, at) {
  if (at == null) return result.url || '#';
  const seconds = Number(at);
  if (!Number.isFinite(seconds)) return result.url || '#';
  const id = result.videoId ? `v=${result.videoId}` : '';
  return `https://www.youtube.com/watch?${id}${id ? '&' : ''}t=${Math.max(0, Math.floor(seconds))}s`;
}

/** Compact one-line preview used in lists/popup. */
export function previewLine(result, max = 160) {
  const text = result?.tldr || result?.keyPoints?.[0]?.text || '';
  return truncate(normalizeWhitespace(text), max);
}

export function resultWordCount(result) {
  let words = 0;
  words += countWords(result.tldr);
  for (const p of result.keyPoints) words += countWords(p.text);
  for (const s of result.sections) {
    words += countWords(s.summary);
    for (const p of s.points) words += countWords(p.text);
  }
  for (const t of [...result.takeaways, ...result.actionItems, ...result.questions]) words += countWords(t);
  for (const q of result.quotes) words += countWords(q.text);
  return words;
}

/** Human-readable title for exports. */
export function exportFilename(result, ext) {
  const base = capitalize(String(result.videoTitle || result.videoId || 'summary').slice(0, 80));
  return `${base} — OpenSummary.${ext}`;
}
