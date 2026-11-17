/**
 * Stopword lists and heuristic phrase lexicons for the local (no-AI) engine.
 * Russian + English, oriented at spoken YouTube captions.
 */

const RU_STOP = `
и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему
теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они
тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого
какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой
хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше
чуть том нельзя такой им более всегда конечно всю между поэтому весь ней ним нею будуть буду будешь будем будете будут бывший
имя время дело раз два три четыре пять шесть семь восемь девять десять сто тысяча миллион миллиард лет год года лет годовой
минута минуты минуте минуту минут минутки секунда секунды секунде секунду секунд секундочку час часа часу часов
минутка секундочка полчаса
очень именно тоже также реально прямо действительно кстати например вроде типа как-то что-то кто-то где-то почему-то
какой-то какая-то какое-то такие такой такая такое такие вот тут сюда туда отсюда оттуда
вообще вообще-то собственно непосредственно буквально фактически практически почти совсем абсолютно целиком полностью
сегодня вчера завтра утром вечером днем ночью сейчас потом раньше позже мой моя мое мои твой твоя твое твои наш наша наше наши
ваш ваша ваше ваши свой своя свое свои этот эта это эти тот та те такой такая такое такие столько сколько который которая
которое которые весь вся всё все целый каждый любой некоторый несколько многие иной другой самый сам сама само сами
здесь там тут куда откуда где когда как почему зачем сколько насколько потому поэтому затем зато притом причём итак
итак вообще вообще-то конечно разумеется наверное возможно вероятно кажется вроде будто якобы мол дескать
пожалуйста спасибо здравствуйте привет пока до свидания
`

  .trim()
  .split(/\s+/);

const EN_STOP = `
a an the and or but if then than that this these those of in on at to for with from by as is are was were be been being am do does
did doing have has had having i you he she it we they me him her us them my your his its our their mine yours hers ours theirs
mine own same so such no nor not only own too very can will just don should now s t don t should ve ll re d m o
about above after again against all also any because before below between both during each few further here how into more most
other some there through under until up while who whom why what when where which whose would could may might must shall
into over out off own per via etc eg ie ok okay yeah yep nope yup right well like actually literally basically
minute minutes second seconds hour hours
very really actually literally basically honestly anyway anyways simply exactly definitely probably maybe perhaps
something anything everything nothing someone somebody anyone anybody everyone everybody somewhere anywhere everywhere
one two three four five six seven eight nine ten first second third another other others
people person persons man men woman women
know knew known think thinks thought say says said saying tell tells told ask asks asked
call calls called find finds found try tries tried use uses used using
get gets got getting make makes made making go goes going went gone come comes came coming
want wants wanted need needs needed look looks looked take takes took taken give gives gave given see sees saw seen
let put keep kept seem seems seemed
former still even yet though although however therefore since while also already always never often sometimes usually
thing things stuff way ways kind sort type part parts lot lots bit little big small good bad right wrong
whether approximately around roughly nearly almost about across along among behind beyond beside besides despite except
inside outside toward towards within without upon onto every each either neither both such
involve involves involved involving introduce introduces introduced introducing invest invests invested investing
million millions billion billions thousand thousands hundred hundreds dozen
able allow allows allowed begin begins began begun keep keeps kept start starts started started stop stops stopped
`

  .trim()
  .split(/\s+/);

/** Discourse markers / speech noise typical for auto-generated captions. */
export const FILLERS = `
э ээ эээ ээээ эм эмм мм ммм аа ааа ага угу мм-хм хм гм ну-у нууу ну-у-у
значит короче типа типо как-бы какбы вроде-бы вообще-то собственно наверное
понимаешь понимаете знаешь знаете видишь видите смотри смотрите слушай слушайте
ладно давай давайте стоп блин чёрт черт господи боже ой ай ух эх ах ох
um uh uhh uhm hmm huh er erm ah ahh oh ok okay yeah yep yup right
like literally basically actually honestly anyway anyways whatever kind of sort of
`

  .trim()
  .split(/\s+/);

/** Promotional / self-referential boilerplate that never belongs in a summary. */
export const CUE_PHRASES = [
  // ru
  'подписывайтесь', 'подпишись', 'подписаться', 'поставь лайк', 'поставьте лайк', 'ставьте лайк',
  'поделись видео', 'поделитесь видео', 'жми на колокольчик', 'колокольчик', 'не забудь подписаться',
  'всем привет', 'приветствую вас', 'с вами', 'меня зовут', 'ссылка в описании', 'ссылки в описании',
  'ссылочку в описании', 'промокод', 'промокоду', 'реклама', 'спонсор', 'спонсором', 'интеграция',
  'спасибо за просмотр', 'спасибо за внимание', 'до встречи', 'до новых встреч', 'следующем видео',
  'этом видео я', 'сегодня мы', 'в этом ролике', 'приятного просмотра', 'поехали', 'не забудьте',
  // en
  'subscribe', 'hit the bell', 'smash that', 'like and subscribe', 'link in the description',
  'links in the description', 'sponsor', 'sponsored', 'promo code', 'thanks for watching',
  'thank you for watching', 'see you in the next', 'in this video i', 'welcome back', 'my name is',
  'before we start', 'without further ado', 'let me know in the comments', 'comment below',
];

/** Markers of conclusions / summaries inside the video. */
export const CONCLUSION_CUES = [
  'таким образом', 'в итоге', 'в конечном счёте', 'в конечном счете', 'главное', 'самое важное',
  'вывод', 'выводы', 'итак', 'резюмируя', 'если коротко', 'коротко говоря', 'в заключение',
  'напоследок', 'запомните', 'ключевая мысль', 'главная мысль', 'суть в том', 'получается',
  'in conclusion', 'to sum up', 'in summary', 'the key takeaway', 'the bottom line', 'overall',
  'the main point', 'so the point is', 'in the end', 'the most important thing',
];

/** Markers of advice / instructions that can be turned into action items. */
export const ACTION_CUES = [
  'нужно', 'надо', 'стоит', 'должен', 'должны', 'рекомендую', 'советую', 'попробуйте', 'попробуй',
  'сделайте', 'сделай', 'используйте', 'используй', 'начните', 'начни', 'запомните', 'не забывайте',
  'избегайте', 'обратите внимание', 'важно', 'шаг', 'первый шаг', 'правило', 'лайфхак', 'совет',
  'you should', 'you need to', 'make sure', 'try to', 'start by', 'avoid', 'remember to',
  'keep in mind', 'the first step', 'a good rule', 'pro tip', 'tip', 'step one',
];

export const RU_STOPWORDS = new Set([...RU_STOP, ...FILLERS.filter((w) => /^[а-яё-]+$/i.test(w))]);
export const EN_STOPWORDS = new Set([...EN_STOP]);

export const STOPWORDS = new Set([...RU_STOP, ...EN_STOP, ...FILLERS]);

/** Non-speech markers in captions: [Music], (applause), ♪, [__], etc. */
export const NON_SPEECH_RE = /([[][^\]]{0,40}[\]])|(\([^)]{0,40}\))|♪+|♫+|\[__\]|_+/g;

/** Speaker change markers in YouTube auto-captions. */
export const SPEAKER_RE = /(?:^|\s)>>\s*/g;

export function isStopword(word, lang = 'ru') {
  const w = String(word || '').toLowerCase().replace(/ё/g, 'е');
  if (STOPWORDS.has(w)) return true;
  if (lang === 'ru' && RU_STOPWORDS.has(w)) return true;
  if (lang === 'en' && EN_STOPWORDS.has(w)) return true;
  return false;
}

/**
 * Short cues are matched at a word boundary only. Substring matching on “tip”
 * fired inside “mul-tip-le”, and ordinary narration (“Tom tries multiple times
 * to go down the stairs”) became an action item.
 */
const SHORT_CUE = 4;
const LATIN_CUE = /^[a-z' -]+$/;
/** Inflections an English cue may take: subscribe → subscribed, tip → tips. */
const LATIN_TAIL = /^(?:s|es|ed|ing|d)?(?:[^a-z]|$)/;

function containsCue(text, cue) {
  if (!cue) return false;
  // English cues must end at a word boundary: “avoid” matched “avoidance” and
  // turned an analytical sentence into an action item. Russian cues keep
  // substring matching, because inflection lives at the end of the word.
  if (LATIN_CUE.test(cue)) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(cue, from);
      if (idx === -1) return false;
      const startOk = idx === 0 || !/[a-z]/.test(text[idx - 1]);
      if (startOk && LATIN_TAIL.test(text.slice(idx + cue.length))) return true;
      from = idx + 1;
    }
  }
  if (cue.length > SHORT_CUE) return text.includes(cue);
  let from = 0;
  for (;;) {
    const idx = text.indexOf(cue, from);
    if (idx === -1) return false;
    if (idx === 0 || !/[\p{L}\p{N}]/u.test(text[idx - 1])) return true;
    from = idx + 1;
  }
}

/** True when a phrase matches a promo/boilerplate cue. */
export function matchesCue(text, cues = CUE_PHRASES) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  for (const cue of cues) {
    if (containsCue(t, cue)) return true;
  }
  return false;
}

export function countCueHits(text, cues) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  let hits = 0;
  for (const cue of cues) if (containsCue(t, cue)) hits++;
  return hits;
}
