/**
 * Adversarial input tests: a weak model (or a hostile transcript) is allowed to
 * return anything. None of the parsing, coercion or rendering paths may throw,
 * lose a whole answer because one field had the wrong type, or let a payload
 * touch the prototype chain.
 */

import { describe, it, assert, assertEqual } from './helpers.mjs';
import { coercePayload, proseToPayload, looksLikeProseAnswer } from '../src/ai/coerce.js';
import { parseAiJson } from '../src/ai/json.js';
import { normalizeResult, renderMarkdown, renderText, timeLink } from '../src/nlp/schema.js';

/* ------------------------------------------------------------------ inputs */

const HOSTILE = [
  null,
  undefined,
  0,
  42,
  true,
  '',
  '   ',
  '{',
  '[]',
  'null',
  '{"tldr": "ok"',
  '`'.repeat(500),
  [],
  [null],
  [[[[[[]]]]]],
  [{}, {}, {}],
  { tldr: null, sections: null, keyPoints: null },
  { sections: 'не массив' },
  { sections: { heading: 'A', points: 'не массив' } },
  { keyPoints: 'строка вместо массива' },
  { takeaways: 'строка вместо массива' },
  { actionItems: { text: 'объект' } },
  { questions: 7 },
  { entities: 'Илон Маск' },
  { keywords: 'LLM' },
  { quotes: 'цитата' },
  { notes: 'заметка' },
  { tldr: { text: 'объект вместо строки' } },
  { sentiment: 'позитив' },
  { sentiment: { label: 42, score: 'много' } },
  { sections: [{ heading: '', points: [{ text: null }, null, 'ok'] }] },
  { keyPoints: [null, undefined, 1, true, { text: '' }, { text: 'ok' }] },
  { sections: [{ heading: 'A', at: 'не время', points: ['x'] }] },
  { stats: null, meta: null, topics: null, timeline: null },
  { __proto__: { polluted: 'yes' } },
  JSON.parse('{"__proto__": {"polluted": "yes"}}'),
  { tldr: 'x'.repeat(20000) },
  { keyPoints: Array.from({ length: 500 }, (_, i) => `пункт ${i}`) },
  { sections: Array.from({ length: 100 }, (_, i) => ({ heading: `S${i}`, points: [`p${i}`] })) },
];

/** Deterministic LCG: the same corpus on every run, no flaky failures. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomValue(next, depth = 0) {
  const pick = Math.floor(next() * (depth > 3 ? 6 : 9));
  switch (pick) {
    case 0: return null;
    case 1: return Math.floor(next() * 1000) - 500;
    case 2: return next() > 0.5;
    case 3: return ['', 'ok', '<script>alert(1)</script>', 'строка', '{"a":1}', 'true'][Math.floor(next() * 6)];
    case 4: return `поле ${Math.floor(next() * 100)}`;
    case 5: return undefined;
    case 6: return [randomValue(next, depth + 1), randomValue(next, depth + 1)];
    case 7: {
      const obj = {};
      const keys = ['tldr', 'sections', 'keyPoints', 'takeaways', 'entities', '__proto__', 'sentiment', 'points'];
      for (let i = 0; i < 1 + Math.floor(next() * 4); i++) {
        obj[keys[Math.floor(next() * keys.length)]] = randomValue(next, depth + 1);
      }
      return obj;
    }
    default: {
      const obj = {};
      for (let i = 0; i < 3; i++) obj[`k${Math.floor(next() * 5)}`] = randomValue(next, depth + 1);
      return obj;
    }
  }
}

/* ------------------------------------------------------------------- tests */

describe('adversarial: coercion never throws', () => {
  it('survives every malformed payload in the corpus', () => {
    for (const input of HOSTILE) {
      const coerced = coercePayload(input);
      assert(coerced && typeof coerced === 'object' && !Array.isArray(coerced), 'coercePayload must return an object');
      const result = normalizeResult(coerced, { mode: 'ai', lang: 'ru' });
      assert(typeof result.tldr === 'string');
      for (const field of ['keyPoints', 'sections', 'takeaways', 'actionItems', 'questions', 'quotes', 'entities', 'keywords']) {
        assert(Array.isArray(result[field]), `${field} must always be an array`);
      }
    }
  });

  it('keeps a string that a weak model used instead of an array', () => {
    const result = normalizeResult({ takeaways: 'проверять факты', keywords: 'LLM', entities: 'OpenAI' }, { mode: 'ai' });
    assertEqual(result.takeaways[0], 'проверять факты');
    assertEqual(result.keywords[0].term, 'LLM');
    assertEqual(result.entities[0].name, 'OpenAI');
  });

  it('does not read an object into the summary text', () => {
    const result = normalizeResult({ tldr: { text: 'настоящий вывод' } }, { mode: 'ai' });
    assertEqual(result.tldr, 'настоящий вывод');
    assert(!result.tldr.includes('[object'), 'an object must not become “[object Object]”');
  });

  it('never pollutes Object.prototype', () => {
    for (const input of HOSTILE) {
      coercePayload(input);
      normalizeResult(coercePayload(input), { mode: 'ai' });
    }
    assertEqual({}.polluted, undefined);
    assertEqual(Object.prototype.polluted, undefined);
  });

  it('caps a runaway answer instead of crashing on it', () => {
    const result = normalizeResult(coercePayload(HOSTILE[HOSTILE.length - 1]), { mode: 'ai' });
    assert(result.sections.length <= 20, 'sections must stay bounded');
    assert(result.keyPoints.length <= 24, 'key points must stay bounded');
    assert(renderMarkdown(result).length < 200000);
  });

  it('fuzzes 200 generated payloads without a throw', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const input = randomValue(next);
      const result = normalizeResult(coercePayload(input), { mode: 'ai', lang: 'ru' });
      assert(typeof result.tldr === 'string', `seed ${seed}: tldr`);
      assert(Array.isArray(result.sections), `seed ${seed}: sections`);
      const md = renderMarkdown(result);
      const txt = renderText(result);
      assert(typeof md === 'string' && typeof txt === 'string', `seed ${seed}: renders must be strings`);
    }
  });

  it('treats prose answers as answers, not as errors', () => {
    const prose =
      'Главная мысль видео в том, что контекст важнее размера модели. Автор показывает три примера ' +
      'и делает вывод: сначала измеряйте, потом оптимизируйте. В конце он отвечает на вопросы зрителей.';
    assert(looksLikeProseAnswer(prose));
    const payload = proseToPayload(prose);
    assert(payload.sections?.length || payload.tldr, 'prose must produce a summary');
    const result = normalizeResult(payload, { mode: 'ai' });
    assert(result.tldr.length > 20 || result.sections.length > 0);
  });
});

describe('adversarial: JSON parsing', () => {
  const cases = [
    "{'a': 1, 'b': [1, 2,],}",
    '{a: 1, b: "x"}',
    '{"a": True, "b": None}',
    'Вот ответ:\n```json\n{"tldr": "ок"}\n```\nГотово.',
    '\uFEFF{"tldr": "bom"}',
    '{"tldr": "обрезано"',
    '{"sections": [{"heading": "A", "points": ["x"',
    '{"tldr": "a"} trailing text {"other": 1}',
    '```\n{"tldr": "без языка"}\n```',
    '['.repeat(200),
    '{"a":' + '['.repeat(200),
  ];

  it('returns a verdict for every sloppy shape without throwing', () => {
    for (const text of cases) {
      const res = parseAiJson(text);
      assert(res && typeof res === 'object', 'parseAiJson must return a verdict');
      assert(typeof res.ok === 'boolean');
    }
  });

  it('accepts the shapes a weak model actually emits', () => {
    assert(parseAiJson("{'a': 1, 'b': [1, 2,],}").ok);
    assert(parseAiJson('{"a": True, "b": None}').ok);
    assert(parseAiJson('Вот ответ:\n```json\n{"tldr": "ок"}\n```\nГотово.').ok);
  });
});

describe('adversarial: renderers', () => {
  it('renders every hostile result as text without a throw', () => {
    for (const input of HOSTILE) {
      const result = normalizeResult(coercePayload(input), { mode: 'ai', lang: 'ru' });
      const md = renderMarkdown(result, { uiLang: 'ru' });
      const txt = renderText(result, { uiLang: 'ru' });
      assert(typeof md === 'string' && typeof txt === 'string');
      // Markdown may contain model text, but it must never be an HTML document
      // the browser would run: the panel renders it through textContent and the
      // exported file is plain text.
      assert(!/^\s*</.test(md.trim()), 'the document must not start as an HTML element');
    }
  });

  it('builds time links only from a numeric position', () => {
    const result = normalizeResult({ videoId: 'abc' }, { mode: 'ai', videoId: 'abc' });
    for (const at of [0, 12.5, -5, '55', null, undefined, 'javascript:alert(1)', NaN]) {
      const link = timeLink(result, at);
      // Either a valid `t=Ns` or the plain video URL (never `t=NaN`).
      const plain = 'https://www.youtube.com/watch?v=abc';
      assert(link === plain || /[&?]t=\d+s$/.test(link), `unexpected link for ${String(at)}: ${link}`);
      assert(link.startsWith(plain), `unexpected link for ${String(at)}: ${link}`);
      assert(!link.includes('NaN'), `time must never be NaN: ${link}`);
    }
  });
});
