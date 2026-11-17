/**
 * Prompt construction for the AI engine.
 * Everything is generated from one schema description so the output can be
 * parsed deterministically and merged into the canonical summary shape.
 */

import { formatTime } from '../common/util.js';

/**
 * Bumped whenever prompt structure or output expectations change. Chunk results
 * cached under an older revision must not be mixed into a new run: a compact
 * map note from revision 1 is not interchangeable with revision 2.
 */
export const PROMPT_VERSION = 4;

export const LANG_NAMES = {
  ru: 'русском',
  en: 'English',
  uk: 'українською',
  kk: 'қазақша',
  es: 'español',
  de: 'Deutsch',
  fr: 'français',
  it: 'italiano',
  pt: 'português',
  pl: 'polski',
  tr: 'Türkçe',
  ar: 'العربية',
  hi: 'हिन्दी',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  sv: 'svenska',
  he: 'עברית',
  id: 'Bahasa Indonesia',
  vi: 'Tiếng Việt',
};

export const LENGTH_PROFILES = {
  short: { tldr: '1-2 предложения', keyPoints: 5, sections: 4, perSection: 2, sectionSummary: '1 предложение', takeaways: 3, quotes: 0, questions: 0 },
  standard: { tldr: '2-3 предложения', keyPoints: 8, sections: 6, perSection: 3, sectionSummary: '1-2 предложения', takeaways: 4, quotes: 2, questions: 3 },
  // “Detailed” used to differ from “standard” by a couple of items, and a
  // fragment-only draft (the reduce failed) had no section summaries at all —
  // which the user rightly read as “not detailed”. More sections, more points
  // per section, a mandatory summary for each and a higher output budget.
  detailed: { tldr: '3-4 предложения', keyPoints: 14, sections: 12, perSection: 5, sectionSummary: '2-3 предложения', takeaways: 6, quotes: 4, questions: 5 },
};

const SCHEMA_SPEC = `{
  "tldr": "строка: суть видео в 1-4 предложениях, без воды и без обращений к зрителю",
  "keyPoints": [{ "text": "строка: конкретный факт/мысль", "at": "mm:ss" }],
  "sections": [{ "heading": "строка: короткий заголовок 2-6 слов", "at": "mm:ss", "summary": "строка: 1-2 предложения", "points": [{ "text": "строка", "at": "mm:ss" }] }],
  "takeaways": ["строка: вывод, который зритель должен запомнить"],
  "actionItems": ["строка: что зрителю стоит сделать (только если в видео есть реальные рекомендации)"],
  "questions": ["строка: вопрос для самопроверки по материалу"],
  "quotes": [{ "text": "строка: дословная или почти дословная цитата", "at": "mm:ss" }],
  "entities": [{ "name": "строка", "type": "person|company|product|place|metric|acronym|other", "mentions": 2 }],
  "keywords": [{ "term": "строка", "score": 0.8 }],
  "sentiment": { "label": "positive|neutral|negative", "score": 0.2 },
  "notes": ["строка: важные оговорки, ограничения, если транскрипт неполный или автоматический"]
}`;

export function languageInstruction(outputLanguage, transcriptLang) {
  if (!outputLanguage || outputLanguage === 'auto') {
    const name = LANG_NAMES[transcriptLang] || LANG_NAMES[String(transcriptLang || '').slice(0, 2)];
    return name
      ? `Пиши ответ на языке видео (${name}), сохраняя термины такими, как в транскрипте.`
      : 'Пиши ответ на том же языке, что и транскрипт.';
  }
  const name = LANG_NAMES[String(outputLanguage).slice(0, 2)] || outputLanguage;
  return `Пиши ответ на языке: ${name}. Если транскрипт на другом языке — переведи смысл, а не слова. Названия продуктов, компаний и имена собствай транслитерируй или оставь как есть, если они общеприняты.`;
}

/**
 * “Auto” means the user's language, not the video's: an English video watched
 * by a Russian interface must produce a Russian конспект. Following the video
 * language was exactly why English videos produced English summaries for a
 * Russian user.
 */
export function resolveOutputLanguage(outputLanguage, uiLang) {
  // Compare the raw value to 'auto' *before* slicing: "auto".slice(0, 2) is
  // "au", so slicing first made the default mode resolve to a bogus "au"
  // language instead of following the interface.
  const raw = String(outputLanguage || '').trim().toLowerCase();
  if (raw && raw !== 'auto') return raw.slice(0, 2);
  const ui = String(uiLang || '').trim().slice(0, 2).toLowerCase();
  return LANG_NAMES[ui] ? ui : 'auto';
}

function profileFor(length) {
  return LENGTH_PROFILES[length] || LENGTH_PROFILES.standard;
}

export function systemPrompt({ outputLanguage = 'auto', transcriptLang = 'ru', tone = 'neutral', length = 'standard', customInstructions = '', uiLang = 'ru', selfCheck = false }) {
  const p = profileFor(length);
  // Self-check questions are a study aid, not part of a summary a viewer reads
  // once. Asking for them by default spent output budget on a block most runs
  // never needed — and on a weak free model that budget came out of the summary
  // itself.
  const questions = selfCheck ? p.questions : 0;
  const toneText = {
    neutral: 'Нейтральный, информативный тон без оценок и без маркетинга.',
    concise: 'Максимально сжатый телеграфный стиль, только факты.',
    simple: 'Простыми словами, как для новичка: расшифровывай термины коротко в скобках.',
    expert: 'Технический стиль для специалиста: термины, числа, детали без разжёвывания.',
  }[tone] || 'Нейтральный, информативный тон.';

  return [
    'Ты — движок конспектирования видео OpenSummary. Ты получаешь транскрипт видео с таймкодами вида [mm:ss] и создаёшь по нему структурный конспект.',
    '',
    'Правила:',
    '1. Опирайся ТОЛЬКО на транскрипт. Ничего не выдумывай. Если чего-то нет — не упоминай.',
    '2. Игнорируй рекламу, призывы подписаться/поставить лайк, промокоды, болтовню ведущего и само-представление.',
    '3. Таймкоды копируй из маркеров в транскрипте (ближайший перед фрагментом). Формат строго "mm:ss" или "h:mm:ss". Если таймкода нет — null.',
    '4. Пиши плотно: без вводных слов, без «в этом видео автор рассказывает о…», без обращений к читателю.',
    '5. Формулируй пункты как законченные тезисы, а не как названия тем.',
    '6. Один факт — один раз. Пункты разделов и keyPoints не пересказывают друг друга: keyPoints — это отдельные важные моменты, которых нет в разделах. Разделы тоже не повторяют один и тот же факт разными словами.',
    '7. Имена, компании, продукты и термины пиши так, как они звучат в транскрипте, а не по догадке: искажённое «Дуааджа» или «сверер интеллект» вместо реального названия — ошибка. Знакомое имя пиши в общепринятой форме (Илон Маск, Дженсен Хуанг), незнакомое оставляй в латинице.',
    `8. ${toneText}`,
    `9. ${languageInstruction(outputLanguage, transcriptLang)}`,
    '',
    'Плотность:',
    '- В detailed каждый факт должен быть проверяемым: цифры, имена, названия, сроки, условия. Не заменяй конкретику общими словами («обсуждают проблемы», «рассказывает о планах»).',
    '- Не сокращай содержание до одной мысли на раздел: если в отрезке пять конкретных фактов, в разделе должно быть пять пунктов.',
    '',
    'Объём:',
    `- tldr: ${p.tldr}. Это связный пересказ ВСЕГО видео: о чём сюжет, главные события/факты и чем всё закончилось. Не обрывок первой попавшейся мысли и не начало первой темы. Не список тем через запятую: назови главную линию и вывод, а темы раскроют разделы.`,
    `- keyPoints: до ${p.keyPoints} пунктов, каждый 8-25 слов, в порядке появления в видео. Это моменты, которых нет среди пунктов разделов: если факт уже в разделе, в keyPoints его не повторяй.`,
    `- sections: до ${p.sections} разделов, у каждого до ${p.perSection} пунктов. Заголовки — по смыслу фрагмента, не по названиям глав. Каждый пункт — новый факт, а не пересказ предыдущего раздела.`,
    `- summary раздела: ${p.sectionSummary}. Обязательно заполняй его: назови, что разбирается в этом отрезке, с именами, числами и аргументами из транскрипта. Пустая строка вместо summary — ошибка.`,
    `- quotes: до ${p.quotes} (если 0 — пустой массив). questions: до ${questions} (если 0 — пустой массив).`,
    '- keywords: 8-20 ключевых терминов, score от 0 до 1 (важность).',
    '',
    'Формат ответа: ТОЛЬКО валидный JSON без markdown-обёрток, комментариев и текста вокруг, ровно по схеме:',
    SCHEMA_SPEC,
    'Описания после двоеточия объясняют поле — не копируй их в значения: вместо “строка: суть видео” нужен настоящий текст конспекта.',
    customInstructions ? `\nДополнительные требования пользователя (приоритетнее дефолтных, кроме правила «не выдумывать»):\n${String(customInstructions).slice(0, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function videoHeader(meta) {
  const bits = [];
  if (meta?.videoTitle) bits.push(`Название: ${meta.videoTitle}`);
  if (meta?.channel) bits.push(`Канал: ${meta.channel}`);
  if (meta?.lengthSeconds) bits.push(`Длительность: ${formatTime(meta.lengthSeconds)}`);
  if (meta?.chapters?.length) {
    bits.push(`Главы видео: ${meta.chapters.slice(0, 30).map((c) => `${formatTime(c.at)} ${c.title}`).join(' | ')}`);
  }
  if (meta?.description) bits.push(`Описание (кратко): ${String(meta.description).slice(0, 500)}`);
  return bits.join('\n');
}

export function singleMessages({ transcript, meta, opts }) {
  return [
    { role: 'system', content: systemPrompt({ ...opts, transcriptLang: meta?.lang }) },
    {
      role: 'user',
      content: [
        'Видео:',
        videoHeader(meta) || '(метаданные недоступны)',
        '',
        'Транскрипт с таймкодами:',
        '"""',
        transcript,
        '"""',
        '',
        'Сделай конспект строго по схеме JSON.',
      ].join('\n'),
    },
  ];
}

/**
 * The smallest useful request. Used when a model failed the full schema (or
 * could not fit it into the output budget): fewer fields mean less to get
 * wrong, and every field of this answer still lands in the same `SummaryResult`.
 */
export function compactMessages({ transcript, meta, opts = {} }) {
  return [
    {
      role: 'system',
      content: [
        'Ты — движок конспектирования OpenSummary. Верни ТОЛЬКО валидный JSON без markdown и без текста вокруг:',
        '{"tldr":"2-3 предложения о видео","keyPoints":["конкретный факт","конкретный факт"],"sections":[{"heading":"тема раздела","points":["конкретный факт"]}]}',
        'keyPoints — 5-10 самых важных фактов видео. sections — необязательны: до 4 разделов, до 3 пунктов в каждом.',
        'Вместо примеров подставляй настоящее содержание. Не копируй подписи полей и заглушки в ответ: "факт", "тема раздела" — это не конспект.',
        'Игнорируй рекламу, призывы подписаться и болтовню ведущего. Не выдумывай факты.',
        languageInstruction(opts.outputLanguage, meta?.lang),
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: [
        'Видео:',
        videoHeader(meta) || '(метаданные недоступны)',
        '',
        'Транскрипт:',
        '"""',
        transcript,
        '"""',
        'Верни JSON.',
      ].join('\n'),
    },
  ];
}

export function  mapMessages({ chunk, meta, opts, total, remind = false }) {
  const p = profileFor(opts.length);
  return [
    {
      role: 'system',
      content: [
        'Ты — движок конспектирования OpenSummary. Ты обрабатываешь ОДИН фрагмент транскрипта видео.',
        'Верни ТОЛЬКО валидный JSON без markdown. Схема полей:',
        '{"points":[{"text":"...","at":"mm:ss"}],"topics":["..."],"quotes":[{"text":"...","at":"mm:ss"}],"facts":["..."],"actions":["..."]}',
        'Вместо «...» и «mm:ss» подставляй настоящее содержимое фрагмента. Не копируй подписи полей и заглушки в ответ: "тема" или "тезис 8-25 слов" — это не конспект.',
        '',
        `Фрагмент ${chunk.index + 1} из ${total} (${formatTime(chunk.startAt)}–${formatTime(chunk.endAt)}).`,
        `Пунктов: до ${Math.min(10, p.perSection + 3)}. Таймкоды копируй из маркеров [mm:ss] внутри фрагмента.`,
        'Пиши сжато: это промежуточные заметки для финальной сборки, а не готовый конспект. Не повторяй одни и те же факты разными словами.',
        'Не пересказывай рекламу, призывы подписаться и болтовню. Не выдумывай факты.',
        'Если во фрагменте нет содержательного материала — верни пустые массивы.',
        'Пустой объект {} или ответ без единого тезиса означает, что фрагмент не обработан.',
        languageInstruction(opts.outputLanguage, meta?.lang),
        remind ? 'Внимание: предыдущая попытка закончилась текстом без JSON. Ответ — строго JSON-объект, никакого текста до или после.' : '',
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: ['Транскрипт фрагмента:', '"""', chunk.text, '"""', 'Верни JSON.'].join('\n'),
    },
  ];
}

export function reduceMessages({ partials, meta, opts }) {
  const p = profileFor(opts.length);
  return [
    { role: 'system', content: systemPrompt({ ...opts, transcriptLang: meta?.lang }) },
    {
      role: 'user',
      content: [
        'Видео:',
        videoHeader(meta) || '(метаданные недоступны)',
        '',
        'Ниже — заметки по ВСЕМ фрагментам видео по порядку (пункты с таймкодами). Собери из них итоговый конспект всего видео:',
        'убери повторы, сгруппируй по смыслу в разделы, оставь самые важные факты, добавь выводы и (если запрошены) вопросы.',
        'Один факт встречается в конспекте один раз: keyPoints не пересказывают пункты разделов, разделы не повторяют друг друга. Имена и названия — как в заметках, без догадок.',
        `Ограничения: tldr — ${p.tldr}; keyPoints — до ${p.keyPoints}; sections — до ${p.sections} (до ${p.perSection} пунктов в каждом); takeaways — до ${p.takeaways}.`,
        `У каждого раздела обязательно заполни summary (${p.sectionSummary}): что разбирается в этом отрезке, с конкретными деталями. Раздел без summary — не готовый раздел.`,
        'Вопросы для самопроверки: ' + (opts.selfCheck ? 'до 5, по материалу заметок.' : 'пустой массив (они отключены настройкой).'),
        'tldr — связный пересказ ВСЕГО видео (включая середину и финал, а не только первых фрагментов): 2-3 предложения по всем темам сразу.',
        'Не выдумывай факты и цитаты, которых нет в заметках. Если заметки по части видео отсутствуют — не заполняй этот промежуток догадками.',
        '',
        'Фрагменты:',
        partials
          .map((part, i) => `--- Фрагмент ${i + 1} ---\n${typeof part === 'string' ? part : JSON.stringify(part)}`)
          .join('\n'),
        '',
        'Верни только итоговый JSON по схеме.',
      ].join('\n'),
    },
  ];
}

  /**
 * One chronological block of the “by timecodes” mode. Each request returns a
 * finished section for its own part of the video, so a failure costs one block
 * instead of the whole конспект and no single huge reduce call is needed.
 */
export function timelineMessages({ block, meta, opts, index = 0, total = 1 }) {
  const p = profileFor(opts.length);
  return [
    {
      role: 'system',
      content: [
        'Ты — движок конспектирования OpenSummary. Ты обрабатываешь ОДИН временной отрезок транскрипта видео и пишешь по нему раздел конспекта.',
        'Верни ТОЛЬКО валидный JSON без markdown и текста вокруг:',
        '{"heading":"короткий заголовок раздела 2-6 слов","summary":"что разбирается в отрезке, 1-3 предложения","points":[{"text":"конкретный факт","at":"mm:ss"}],"quotes":[{"text":"дословная фраза","at":"mm:ss"}]}',
        'Вместо подписей подставляй настоящее содержание. Заголовок описывает тему отрезка, а не его номер.',
        'Пункты — конкретные факты: имена, числа, аргументы, шаги. Один факт — один пункт. Не повторяй summary в пунктах.',
        'Таймкоды копируй из маркеров [mm:ss] внутри отрезка. Если таймкода нет — null.',
        'Игнорируй рекламу, призывы подписаться и болтовню ведущего.',
        `Пунктов: 3-${p.perSection + 2}. Цитат: до 2 (если 0 — пустой массив).`,
        languageInstruction(opts.outputLanguage, meta?.lang),
        `Это отрезок ${index + 1} из ${total}.`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: ['Транскрипт отрезка:', '"""', block.text, '"""', 'Верни JSON.'].join('\n'),
    },
  ];
}

export function repairMessages({ broken, opts }) {
  return [
    {
      role: 'system',
      content: [
        'Ты — валидатор JSON. Тебе дают почти-JSON вывод модели. Верни ТОЛЬКО исправленный валидный JSON по той же схеме, без markdown и без пояснений.',
        'Сохрани все данные, исправь синтаксис: кавычки, запятые, экранирование, незакрытые скобки.',
        'Схема:',
        SCHEMA_SPEC,
        languageInstruction(opts.outputLanguage, opts.transcriptLang),
      ].join('\n'),
    },
    { role: 'user', content: ['Исправь JSON:', '"""', String(broken).slice(0, 24000), '"""'].join('\n') },
  ];
}

export function qaMessages({ question, context, meta, opts }) {
  return [
    {
      role: 'system',
      content: [
        'Ты отвечаешь на вопрос по конкретному видео на основе приведённого транскрипта с таймкодами.',
        'Правила:',
        '1. Отвечай только тем, что есть в транскрипте. Если ответа нет — верни {"notFound": true}.',
        '2. Ответ — 1-4 предложения по существу, без вступлений.',
        '3. Обязательно приведи 1-3 цитаты-подтверждения с таймкодами строго из маркеров [mm:ss].',
        '4. Формат ответа: ТОЛЬКО валидный JSON: {"answer":"строка","citations":[{"text":"короткая цитата","at":"mm:ss"}],"confidence":0.8,"notFound":false}',
        `5. ${languageInstruction(opts.outputLanguage, meta?.lang || opts.transcriptLang)}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        meta?.videoTitle ? `Видео: ${meta.videoTitle}` : '',
        '',
        'Транскрипт (фрагменты):',
        '"""',
        context,
        '"""',
        '',
        `Вопрос: ${question}`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

/** Chat-style prompt: turn a summary into a nicer title / tags (used by popup). */
export function titleMessages({ summary, meta, opts }) {
  return [
    {
      role: 'system',
      content: [
        'Ты придумываешь короткий заголовок конспекта видео (до 60 символов) и 3-5 тегов.',
        'Только валидный JSON: {"title":"...","tags":["..."]}',
        languageInstruction(opts.outputLanguage, meta?.lang),
      ].join('\n'),
    },
    { role: 'user', content: `Видео: ${meta?.videoTitle || ''}\nКонспект: ${String(summary || '').slice(0, 3000)}` },
  ];
}

export { SCHEMA_SPEC };
