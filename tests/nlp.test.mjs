import { describe, it, assert, assertEqual, assertThrows } from './helpers.mjs';
import { ruTranscript, enTranscript, longTranscript, meta, vlogTranscript, vlogMeta } from './fixtures.mjs';
import { splitSentences, tokenize, stem, stemsOf, cleanCaptionText, detectLang, countSpeakers, stripDanglingOpener, stripLeadingFillers } from '../src/nlp/tokenize.js';
import { extractKeywords } from '../src/nlp/keywords.js';
import { analyze, answerLocal, buildSentences, buildWindows, infoDensityScore } from '../src/nlp/extractive.js';
import { renderMarkdown, renderText, normalizeResult, previewLine } from '../src/nlp/schema.js';
import { normalizeWhitespace, formatTime, parseTimestamp, extractJsonBlock, countWords, computeSummaryStats } from '../src/common/util.js';
import { ACTION_CUES, countCueHits } from '../src/nlp/stopwords.js';

describe('util', () => {
  it('formats timecodes', () => {
    assertEqual(formatTime(0), '0:00');
    assertEqual(formatTime(65), '1:05');
    assertEqual(formatTime(3661), '1:01:01');
  });
  it('parses timestamps in several formats', () => {
    assertEqual(parseTimestamp('1:02:03'), 3723);
    assertEqual(parseTimestamp('02:03'), 123);
    assertEqual(parseTimestamp('90'), 90);
    assertEqual(parseTimestamp('1h2m3s'), 3723);
    assertEqual(parseTimestamp('нет'), null);
    assertEqual(parseTimestamp(12.6), 13);
  });
  it('extracts a JSON block from an LLM answer', () => {
    const text = 'Sure!\n```json\n{"a": [1, {"b": "}"}], "c": 2}\n```\nthanks';
    const parsed = JSON.parse(extractJsonBlock(text));
    assertEqual(parsed.c, 2);
    assertEqual(parsed.a[1].b, '}');
  });
});

describe('tokenize', () => {
  it('splits sentences and protects abbreviations and decimals', () => {
    const parts = splitSentences('Привет, т.е. это тест. Число 3.14 сохранилось. А. С. Пушкин писал! Готово?');
    assertEqual(parts.length, 4);
    assert(parts[1].includes('3.14'), 'decimals must stay intact');
  });
  it('cleans caption noise and counts speakers', () => {
    assertEqual(cleanCaptionText('[Music] привет (applause) мир'), 'привет мир');
    assertEqual(countSpeakers([{ text: '>> a' }, { text: 'b >> c' }]), 3);
  });
  it('tokenizes and filters stopwords for stems', () => {
    const tokens = tokenize('Кэширование и кэша — это 2024 год, до 40 мс!');
    assert(tokens.includes('кэширование'));
    assert(tokens.includes('2024'));
    assert(!tokens.includes('—'));
    const stems = stemsOf(tokens);
    assert(!stems.includes('и'), 'stopwords removed');
    assert(stems.some((s) => s.startsWith('кэш')));
  });
  it('stems russian and english inflections to the same root', () => {
    assertEqual(stem('кэширование'), stem('кэширования'));
    assertEqual(stem('databases'), stem('database'));
  });
  it('detects language', () => {
    assertEqual(detectLang('привет мир как дела').lang, 'ru');
    assertEqual(detectLang('hello world how are you').lang, 'en');
  });
  it('drops the spoken timecode the panel renders before each row', () => {
    // YouTube's scratch panel renders a visually hidden “5 минут 19 секунд”
    // before every cue; innerText included it, so the summary was built from
    // “минут секунд”.
    assertEqual(cleanCaptionText('5 минут 19 секунд И вот тут началось'), 'И вот тут началось');
    assertEqual(cleanCaptionText('0 минут 19 секунд Он построил империю'), 'Он построил империю');
    assertEqual(cleanCaptionText('1 час 2 минуты 3 секунды Финальная часть'), 'Финальная часть');
    assertEqual(cleanCaptionText('2 minutes 57 seconds The story begins'), 'The story begins');
    // Real speech that happens to start with a duration stays untouched.
    assertEqual(cleanCaptionText('5 минут назад он сказал об этом'), '5 минут назад он сказал об этом');
    // Rows often continue the previous sentence in lowercase: the panel's
    // timecode (“1 минута 46 секунд последнее время он дал интервью”) must go,
    // while a duration inside the sentence stays.
    assertEqual(cleanCaptionText('1 минута 46 секунд последнее время он дал интервью'), 'последнее время он дал интервью');
    assertEqual(cleanCaptionText('0:08 5 минут 19 секунд Как умудрилось попасть в Forbes'), 'Как умудрилось попасть в Forbes');
    assertEqual(cleanCaptionText('2 minutes 57 seconds the story begins'), 'the story begins');
    assertEqual(cleanCaptionText('5 minutes ago he said that'), '5 minutes ago he said that');
  });
  it('drops panel card chrome and keeps the speech glued to it', () => {
    // Recommendation cards share the innerText with the captions: a view
    // counter, a relative date, a title glued to the speech before it. They
    // used to reach the summary as “17 минут involved with Israeli
    // intelligence” and “Назадв Эфиреплейлист Микс”.
    assertEqual(cleanCaptionText('401 тыс. • 2 г. назад'), '');
    assertEqual(cleanCaptionText('2,4 млн • 3 мес.'), '');
    assertEqual(cleanCaptionText('3 мес.'), '');
    assertEqual(cleanCaptionText('НазадВ эфиреПлейлист Микс'), '');
    assertEqual(cleanCaptionText('How Israel Kills JournalistsHow israel kills journalistsfern2,4 млн • 3 мес.'), '');
    // Real speech in front of a glued recommendation title stays; the card goes.
    assertEqual(
      cleanCaptionText(
        "There's an entire class of people involved internationally and have How Israel Kills JournalistsHow israel kills journalistsfern2,4 млн • 3 мес.",
      ),
      "There's an entire class of people involved internationally and have",
    );
    // A Russian panel timecode glued to English speech goes too.
    assertEqual(cleanCaptionText('17 минут involved with Israeli intelligence.'), 'involved with Israeli intelligence.');
    // Look-alike speech is untouched.
    assertEqual(cleanCaptionText('3 месяца спустя он вернулся'), '3 месяца спустя он вернулся');
    assertEqual(cleanCaptionText('2019 год'), '2019 год');
    assertEqual(cleanCaptionText('5 лет назад Гриша приехал'), '5 лет назад Гриша приехал');
  });
  it('cuts a detached participle opener but keeps real first clauses', () => {
    // “Оправившись от потерь…” refers to the previous sentence; inside a summary
    // it is a dangling opening with no subject.
    assertEqual(
      stripDanglingOpener('Оправившись от потерь маминых денег, наш герой складывается с одноклассником.'),
      'Наш герой складывается с одноклассником.',
    );
    assertEqual(stripDanglingOpener('Перейдя в школу, он начал продавать мармелад.'), 'Он начал продавать мармелад.');
    // Nouns that merely end like a participle must stay.
    assertEqual(
      stripDanglingOpener('Состав, который мы купили, оказался дорогим.'),
      'Состав, который мы купили, оказался дорогим.',
    );
    // Only the first word may be a detached participle.
    assertEqual(
      stripDanglingOpener('Он, оправившись от потерь, снова начал торговать.'),
      'Он, оправившись от потерь, снова начал торговать.',
    );
    assertEqual(stripDanglingOpener('И вот смотрите, что получилось в итоге.'), 'И вот смотрите, что получилось в итоге.');
  });
});

describe('keywords', () => {
  it('extracts frequent topical terms with co-occurring phrases', () => {
    const segments = ruTranscript();
    const sentences = buildSentences(segments, {});
    const windows = buildWindows(sentences);
    const keywords = extractKeywords({ sentences, windows, topN: 15 });
    assert(keywords.length >= 5, 'expected some keywords');
    const terms = keywords.map((k) => k.term.toLowerCase());
    assert(terms.some((t) => t.includes('кэш')), `expected a cache term, got ${terms.join(', ')}`);
    assert(keywords[0].score > 0);
    // scores are normalized and descending
    assert(keywords[0].score >= keywords[keywords.length - 1].score);
  });
});

describe('offline analysis', () => {
  it('builds timed sentences and windows from captions', () => {
    const sentences = buildSentences(ruTranscript(), { filterFillers: true });
    assert(sentences.length >= 5, 'expected sentences');
    assertEqual(typeof sentences[0].at, 'number');
    assert(sentences[0].endAt >= sentences[0].at, 'a sentence ends after it starts');
    const windows = buildWindows(sentences);
    assert(windows.length >= 1, 'windows cover the video');
  });

  it('ranks sentences and exposes a density score', () => {
    const analysis = analyze({ segments: ruTranscript(), meta: meta({}), options: {} });
    assert(analysis.sentences.length > 0);
    assert(analysis.keywords.length > 0, 'keywords come from the content');
    assert(analysis.sentences.every((s) => Number.isFinite(s.finalScore)), 'every sentence is scored');
    const density = infoDensityScore(analysis);
    assert(density >= 0 && density <= 100, `density out of range: ${density}`);
  });

  it('answers questions offline with citations', () => {
    const analysis = analyze({ segments: ruTranscript(), meta: meta({}), options: {} });
    const res = answerLocal('Что такое кэширование и зачем нужно измерять?', analysis);
    assert(res.answer.length > 10, 'expected a local answer');
    assert(res.sources.length >= 1, 'expected citations');
    assert(res.sources[0].ts != null, 'citation must carry a timestamp');
    const miss = answerLocal('Как приготовить борщ в микроволновке?', analysis);
    assertEqual(miss.confidence, 0);
  });

  it('keeps the offline answer path fast on a long transcript', () => {
    const long = longTranscript(900);
    const started = Date.now();
    const analysis = analyze({ segments: long, meta: meta({ lengthSeconds: 3600, videoTitle: 'Длинное видео' }), options: {} });
    const res = answerLocal('о чём видео', analysis);
    const ms = Date.now() - started;
    assert(res.sources.length >= 1);
    assert(ms < 6000, `offline analysis took too long: ${ms}ms`);
    console.log(`       [bench] 900 captions analysed in ${ms}ms`);
  });

  it('throws a coded error for an empty transcript', () => {
    assertThrows(() => analyze({ segments: [], meta: meta({}) }), 'empty transcript must throw');
    try {
      analyze({ segments: [{ text: '...', start: 0, dur: 1 }], meta: meta({}) });
      throw new Error('should have thrown');
    } catch (err) {
      assertEqual(err.code, 'EMPTY_TRANSCRIPT');
    }
  });
});

describe('renderers', () => {
  const result = normalizeResult(
    {
      tldr: 'Видео объясняет, как устроено кэширование ответов и зачем измерять попадания.',
      keyPoints: [
        { text: 'Кэш хранит готовые ответы и экономит время запроса.', at: '0:20' },
        { text: 'Метрика попаданий показывает, насколько кэш полезен.', at: '1:05' },
      ],
      sections: [
        {
          heading: '缓存 и метрики',
          at: '0:20',
          summary: 'Разбирается, как работает кэш.',
          points: [{ text: 'Кэш экономит время запроса.', at: '0:20' }],
        },
      ],
      takeaways: ['Измеряйте попадания в кэш.'],
    },
    { mode: 'ai', videoId: 'dQw4w9WgXcQ', lengthSeconds: 600, lang: 'ru', uiLang: 'ru' },
  );
  it('renders markdown with clickable timecodes', () => {
    const md = renderMarkdown(result, { uiLang: 'ru' });
    assert(md.startsWith('# '), 'markdown starts with a title');
    assert(md.includes('[0:'), 'contains timecode links');
    assert(md.includes('watch?v=dQw4w9WgXcQ&t='), 'time links point back to the video');
    assert(md.includes('## Ключевые моменты'));
  });
  it('groups points that share a timecode under one link', () => {
    const shared = normalizeResult(
      {
        tldr: 'Видео о кэше и метриках, объясняет, зачем измерять попадания в кэш ответов.',
        keyPoints: [
          { text: 'Первый момент.', at: '0:56' },
          { text: 'Второй момент того же времени.', at: '0:56' },
          { text: 'Третий момент.', at: '2:00' },
        ],
        sections: [
          {
            heading: 'Начало',
            at: '0:00',
            summary: 'Разбирается начало записи.',
            points: [
              { text: 'Пункт под заголовком.', at: '0:00' },
              { text: 'Ещё один в ту же секунду.', at: '0:00' },
            ],
          },
        ],
      },
      { mode: 'ai', videoId: 'dQw4w9WgXcQ', lengthSeconds: 600, lang: 'ru', uiLang: 'ru' },
    );
    const md = renderMarkdown(shared, { uiLang: 'ru' });
    const stamps = md.match(/\[0:56\]\(/g) || [];
    assertEqual(stamps.length, 1, 'one 0:56 link for two points at that second');
    assert(md.includes('  - Второй момент того же времени.'), 'the second point is a nested bullet');
    const sectionPart = md.slice(md.indexOf('### '), md.indexOf('## Ключевые моменты'));
    assertEqual((sectionPart.match(/&t=0s/g) || []).length, 1, 'points at the heading second do not repeat its timecode');
  });

  it('renders plain text without markdown syntax', () => {
    const text = renderText(result, { uiLang: 'ru' });
    assert(!text.includes('](http'), 'links flattened');
    assert(!text.includes('## '), 'headings flattened');
  });
  it('normalizes loose AI payloads', () => {
    const norm = normalizeResult(
      {
        summary: '  Кратко  о видео  ',
        key_points: [{ point: 'Пункт', timestamp: '1:30' }],
        chapters: [{ title: 'Глава', time: '00:10', bullets: ['Буллет'] }],
        sentiment: 'positive',
        keywords: ['кэш', { text: 'инвалидация', weight: 0.7 }],
      },
      { mode: 'ai', videoId: 'abc', lengthSeconds: 100, uiLang: 'ru' },
    );
    assertEqual(norm.tldr, 'Кратко о видео');
    assertEqual(norm.keyPoints[0].at, 90);
    assertEqual(norm.sections[0].points[0].text, 'Буллет');
    assertEqual(norm.sentiment.label, 'positive');
    assertEqual(norm.keywords.length, 2);
    assert(previewLine(norm).startsWith('Кратко'));
  });
});

describe('schema placeholders', () => {
  it('drops the prompt schema echoed by a weak model', () => {
    const norm = normalizeResult({
      tldr: 'тезис 8-25 слов',
      keyPoints: [{ text: 'строка: конкретный факт/мысль' }],
      sections: [{ heading: 'тема', points: [{ text: 'тезис 8-25 слов', at: '0:10' }] }],
      takeaways: ['...'],
      keywords: [{ term: 'тема' }],
    });
    assertEqual(norm.tldr, '');
    assertEqual(norm.keyPoints.length, 0);
    assertEqual(norm.sections.length, 0);
    assertEqual(norm.takeaways.length, 0);
    assertEqual(norm.keywords.length, 0);
  });

  it('drops exact duplicates caused by overlapping chunks', () => {
    const norm = normalizeResult({
      tldr: 'Итог видео.',
      keyPoints: [
        { text: 'Один и тот же факт.', at: '0:10' },
        { text: 'Один и тот же факт.', at: '0:12' },
      ],
      sections: [
        { heading: 'Начало', points: [{ text: 'Один и тот же факт.', at: '0:10' }, { text: 'Уникальный пункт.', at: '0:20' }] },
      ],
    });
    assertEqual(norm.keyPoints.length, 1, 'an exact repeat must appear once');
    assertEqual(norm.sections[0].points.length, 1, 'a repeat of a key point must not reappear in a section');
    assertEqual(norm.sections[0].points[0].text, 'Уникальный пункт.');
  });

  it('keeps real text that merely starts with a similar word', () => {
    const norm = normalizeResult({
      tldr: 'Тема видео — история дома на Эшри-лейн.',
      keyPoints: [{ text: 'Тезис автора: дом больше внутри, чем снаружи.' }],
    });
    assert(norm.tldr.startsWith('Тема видео'));
    assertEqual(norm.keyPoints.length, 1);
  });
});
