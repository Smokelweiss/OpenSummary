/** Synthetic transcripts used by the tests (no network, no real user data). */

export function ruTranscript() {
  const lines = [
    'Приветствую вас на канале, сегодня разберём, как работает кэширование в веб-приложениях.',
    'Не забудьте подписаться на канал и поставить лайк, это помогает развитию канала.',
    'Кэширование это способ сохранить результат дорогой операции, чтобы не выполнять её повторно.',
    'Основных стратегий три: время жизни, инвалидация по событию и сквозная запись в базу.',
    'Если кэш не инвалидировать, пользователь увидит устаревшие данные, и это самая частая ошибка.',
    'Ссылку на статью и промокод оставлю в описании под видео.',
    'Второй важный момент — измерение: без метрики попаданий невозможно понять, помогает ли кэш.',
    'Мы поставили Redis перед базой данных и получили ускорение с 800 миллисекунд до 40 миллисекунд.',
    'Ключ кэша нужно строить из всех параметров запроса, иначе разные пользователи получат чужие данные.',
    'Третий момент — это инвалидация по событию: когда запись меняется, кэш удаляется немедленно.',
    'Попробуйте начать с простого правила: кэшируйте только чтение и только с явным временем жизни.',
    'В нашем проекте мы использовали каскадное удаление и очередь сообщений для инвалидации.',
    'Итак, кэширование требует трёх решений: что кэшировать, как инвалидировать и как измерять.',
    'Таким образом, главный вывод простой: кэш без инвалидации опаснее, чем отсутствие кэша.',
    'Спасибо за просмотр, до встречи в следующем видео.',
  ];
  const segments = [];
  let t = 0;
  lines.forEach((text, i) => {
    const words = text.split(' ').length;
    const dur = Math.max(2, Math.round(words / 2.5));
    segments.push({ text: i === 0 ? `>> ${text}` : text, start: t, dur });
    t += dur;
  });
  return segments;
}

export function enTranscript() {
  const lines = [
    'Welcome back to the channel, today we are talking about vector databases.',
    'Make sure to subscribe and hit the bell so you do not miss the next video.',
    'A vector database stores embeddings and answers nearest neighbour queries in milliseconds.',
    'The first approach is HNSW, a graph index that gives excellent recall at high speed.',
    'The second approach is IVF, which clusters vectors and searches only the closest cells.',
    'We benchmarked three systems and found a latency difference of about four times.',
    'The key takeaway is that you must measure recall together with latency, never latency alone.',
    'Remember to keep the embedding model and the query model exactly the same version.',
    'In conclusion, pick the index that matches your recall target, then tune memory usage.',
    'Thanks for watching, see you in the next one.',
  ];
  const segments = [];
  let t = 0;
  lines.forEach((text) => {
    const dur = Math.max(2, Math.round(text.split(' ').length / 2.8));
    segments.push({ text, start: t, dur });
    t += dur;
  });
  return segments;
}

/**
 * Spoken-word vlog: rambling sentences, a detached participle that refers to a
 * previous sentence, adjectives used as descriptions (“обычный парень”),
 * money and a subscribe pitch. This is the shape of the transcript that used to
 * produce “О чём видео: мармелад, простой и обычный”.
 */
export function vlogTranscript() {
  const lines = [
    'Вот эти вот простые люди, которые живут в России, они вообще не понимают, как можно зарабатывать на мармеладе.',
    'Последнее время он дал несколько интервью, где рассказал о переходе из обычного парня, из обычной простой семьи из Екатеринбурга в гения-миллиардера.',
    'Обычный парень Гриша Соловьёв родился в простой семье.',
    'Папа разорится, и начнётся путь главного мармеладного магната.',
    'Порошок лимонной кислоты за 15 руб из Пятёрочки станет стоить как штопорная наценка на мармелад.',
    'Оправившись от потерь маминых денег, наш герой складывается с одноклассником по 5000 руб. и покупает первую партию мармелада, фасует её и продаёт в школе.',
    'В своих роликах Гриша неоднократно говорит, что привозят мармелад из Европы и, в частности, супермегаэбожественный мармелад фирмы Дамель из Испании.',
    'Себестоимость одной коробки мармелада примерно триста рублей, а продаёт он её за тысячу двести рублей.',
    'То есть наценка получается четыреста процентов, и это главная причина, почему мармеладный бизнес такой прибыльный.',
    'Он не строил фабрику, он просто покупал готовый мармелад и клеил свои наклейки.',
    'В итоге за год он продал двадцать тысяч коробок и заработал девять миллионов рублей.',
    'Дальше он хочет открыть свой завод, но пока что это история про то, как обычный школьник стал мармеладным королём.',
    'Подпишитесь на канал, чтобы не пропустить вторую часть.',
    'Спасибо за просмотр.',
  ];
  const segments = [];
  let t = 0;
  lines.forEach((text) => {
    const dur = Math.max(2, Math.round(text.split(' ').length / 2.4));
    segments.push({ text, start: t, dur });
    t += dur;
  });
  return segments;
}

export function vlogMeta(overrides = {}) {
  return meta({
    videoId: 'lnC6VCwGWoM',
    videoTitle: 'Самый КИСЛЫЙ ЖМОТ - Гриша МАРМЕЛАДЫЧ',
    channel: 'СЕРГЕЙ ПАШАНИН',
    lengthSeconds: 931,
    url: 'https://www.youtube.com/watch?v=lnC6VCwGWoM',
    source: 'page-panel',
    autoGenerated: true,
    ...overrides,
  });
}

export function longTranscript(sentenceCount = 900) {
  const topics = [
    'производительность базы данных', 'схема данных', 'индексы', 'транзакции', 'репликация',
    'очереди сообщений', 'наблюдаемость', 'профилирование', 'кэширование', 'балансировка нагрузки',
  ];
  const verbs = ['улучшает', 'ускоряет', 'усложняет', 'меняет', 'оптимизирует', 'ломает', 'стабилизирует'];
  const segments = [];
  let t = 0;
  for (let i = 0; i < sentenceCount; i++) {
    const topic = topics[i % topics.length];
    const verb = verbs[i % verbs.length];
    const text = `На шаге ${i + 1} мы разбираем, как ${topic} ${verb} работу системы и почему это важно для команды размером ${5 + (i % 40)} человек.`;
    const dur = 4;
    segments.push({ text, start: t, dur });
    t += dur;
  }
  return segments;
}

export function meta(overrides = {}) {
  return {
    videoId: 'dQw4w9WgXcQ',
    videoTitle: 'Кэширование в веб-приложениях: три стратегии и метрики',
    channel: 'Test Channel',
    lengthSeconds: 120,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    source: 'youtube-timedtext-manual',
    autoGenerated: false,
    ...overrides,
  };
}
