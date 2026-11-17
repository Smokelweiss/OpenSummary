/**
 * Deterministic grounding check for an AI summary.
 *
 * The model writes the summary; this module checks the parts that can be
 * checked without another model: numbers (dates, counts, durations, prices) and
 * verbatim quotes. It never rewrites the answer — a claim whose number is not in
 * the transcript is reported (and stored in `result.meta.grounding`), so the
 * user sees which lines need a look at the source instead of trusting every
 * line equally.
 *
 * What it cannot do is stated plainly: a paraphrase with no numbers, a wrong
 * causal link between two real events, or a translated summary where every
 * quote legitimately differs from the spoken words are out of reach here. This
 * is a filter for invented figures and fabricated quotes, not a fact-checker.
 */

import { normalizeWhitespace } from '../common/util.js';

/** Digits with an optional decimal part: 40, 800, 1.5, 2023. */
const NUMBER_RE = /\d+(?:[.,]\d+)?/g;

function norm(text) {
  return normalizeWhitespace(String(text == null ? '' : text)).toLowerCase().replace(/ё/g, 'е');
}

/** Numeric tokens of a claim, in order of appearance. */
export function claimNumbers(text) {
  return String(text == null ? '' : text).match(NUMBER_RE) || [];
}

/**
 * Every number a claim uses, without the ones the transcript contains.
 * An empty array means “no unsupported figures found”, not “verified true”.
 */
export function unsupportedNumbers(text, transcriptNumbers) {
  const missing = [];
  for (const number of claimNumbers(text)) {
    const variants = [number, number.replace(',', '.'), number.replace('.', ',')];
    if (variants.some((v) => transcriptNumbers.has(v))) continue;
    if (!missing.includes(number)) missing.push(number);
  }
  return missing;
}

/**
 * @param {object} result  normalized SummaryResult (already built)
 * @param {string} transcriptText  the text the model was given, without markers
 * @returns {{checked:number, claims:number, unsupported:Array<{where:string,text:string,missing:string[]}>,
 *            quotes:number, unverifiedQuotes:number}}
 */
export function verifyResult(result, transcriptText) {
  const transcript = norm(transcriptText);
  const transcriptNumbers = new Set();
  for (const number of transcript.match(NUMBER_RE) || []) {
    transcriptNumbers.add(number);
    transcriptNumbers.add(number.replace(',', '.'));
    transcriptNumbers.add(number.replace('.', ','));
  }

  const unsupported = [];
  const check = (where, text) => {
    const clean = normalizeWhitespace(String(text || ''));
    if (!clean) return;
    const missing = unsupportedNumbers(clean, transcriptNumbers);
    if (missing.length) unsupported.push({ where, text: clean.slice(0, 200), missing: missing.slice(0, 6) });
  };

  let claims = 0;
  for (const point of result.keyPoints || []) {
    claims++;
    check('keyPoints', point.text);
  }
  for (const text of result.takeaways || []) {
    claims++;
    check('takeaways', text);
  }
  for (const section of result.sections || []) {
    if (section.summary) {
      claims++;
      check('sections', section.summary);
    }
    for (const point of section.points || []) {
      claims++;
      check('sections', point.text);
    }
  }

  const quotes = result.quotes || [];
  let unverifiedQuotes = 0;
  for (const quote of quotes) {
    const text = norm(quote.text).replace(/[«»"“”„]/g, '');
    if (!text) continue;
    if (!transcript.includes(text.replace(/[«»"“”„]/g, ''))) unverifiedQuotes++;
  }

  return { checked: claims, claims, unsupported, quotes: quotes.length, unverifiedQuotes };
}

/** One user-facing line per kind of doubt; empty when nothing was flagged. */
export function verificationWarnings(report) {
  const out = [];
  if (!report) return out;
  if (report.unsupported.length) {
    out.push(
      `Проверка по транскрипту: в ${report.unsupported.length} из ${report.checked} тезисов есть числа, которых нет в тексте, — они помечены в диагностике.`,
    );
  }
  if (report.unverifiedQuotes) {
    out.push(
      `Проверка по транскрипту: ${report.unverifiedQuotes} цитат(ы) не найдены дословно (это ожидаемо для переведённого конспекта).`,
    );
  }
  return out;
}
