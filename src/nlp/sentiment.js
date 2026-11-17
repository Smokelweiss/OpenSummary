/**
 * Lexicon-based sentiment/tone estimation (ru + en) with simple negation
 * handling. Used to label the overall tone of a video in local mode.
 */

const POSITIVE = `
хороший хорошая хорошее хорошие хорошо отличный отличная отлично замечательный прекрасный классный крутой супер лучший лучше
полезный полезно польза эффективный эффективно успех успешный успешно просто легко лёгкий лёгко быстро быстрый удобный удобно
интересный интересно увлекательный важно важный преимущество плюс рост растёт развивается улучшение улучшает работает
получается достигли результат рекомендую советую рад радость нравится люблю вдохновляет мотивирует надёжный качественный
победа выигрыш экономия выгодно бесплатно доступно безопасный здоровье счастье спокойствие надёжно верно правильно
great good excellent awesome amazing fantastic best better useful effective easy simple fast convenient interesting
important advantage growth improvement works success win benefit recommend love like happy inspiring reliable
quality efficient powerful helpful valuable positive boost gain free safe healthy clear smooth
`

  .trim()
  .split(/\s+/);

const NEGATIVE = `
плохой плохая плохое плохо ужасный ужасно отвратительный проблема проблемы сложный сложно трудно трудность ошибка ошибки
провал провальный неудача опасно опасность риск вред вредный бесполезно скучно раздражает ненавижу не нравится медленно
медленный дорого дорогой убыток потеря потери падение падает сломан сломался не работает не получилось неверно неправильно
виноват виновата страшно страх тревога больно боль кризис катастрофа конфликт спор агрессия запрет ограничение
bad poor terrible awful horrible worst problem problems difficult hard error mistake fail failure dangerous risk harm
useless boring annoying hate slow expensive loss falling broken doesn't broken incorrect wrong scared fear crisis
catastrophe conflict argument aggression ban limit
`

  .trim()
  .split(/\s+/);

const POS_SET = new Set(POSITIVE.map((w) => w.toLowerCase()).filter((w) => !w.includes(' ')));
const NEG_SET = new Set(NEGATIVE.map((w) => w.toLowerCase()).filter((w) => !w.includes(' ')));

const NEGATIONS = new Set(['не', 'ни', 'нет', 'never', 'not', 'no', 'without', 'нe']);

/**
 * @param {Array<{tokens: string[], weight?: number}>} sentences
 * @returns {{label: string, score: number, positive: number, negative: number}}
 */
export function analyzeSentiment(sentences) {
  let pos = 0;
  let neg = 0;
  let considered = 0;

  for (const s of sentences) {
    const tokens = (s.tokens || []).map((t) => t.toLowerCase());
    if (!tokens.length) continue;
    const weight = Number.isFinite(s.weight) ? s.weight : 1;
    let local = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const p = POS_SET.has(t) ? 1 : 0;
      const n = NEG_SET.has(t) ? 1 : 0;
      if (!p && !n) continue;
      let value = p ? 1 : -1;
      const prev = tokens[i - 1];
      const prev2 = tokens[i - 2];
      if ((prev && NEGATIONS.has(prev)) || (prev2 && NEGATIONS.has(prev2)) || (prev && prev.endsWith("n't"))) {
        value = -value * 0.8;
      }
      local += value;
    }
    if (local > 0) pos += local * weight;
    else if (local < 0) neg += -local * weight;
    considered++;
  }

  const total = pos + neg;
  const score = total ? round3((pos - neg) / total) : 0;
  let label = 'neutral';
  if (score > 0.18) label = 'positive';
  else if (score < -0.18) label = 'negative';
  return { label, score, positive: round3(pos), negative: round3(neg), sentences: considered };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
