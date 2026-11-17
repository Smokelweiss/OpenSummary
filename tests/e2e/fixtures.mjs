/**
 * Fixed inputs for the browser harness. They are deliberately plain strings:
 * the provider is a local SSE mock, so the test proves the real panel and the
 * real pipeline, not a model's answer quality.
 */

export const TLDR_HEAD = 'Кэш узлов ускоряет повторный рендер, но требует ограничения памяти.';
export const P1 = 'Повторный рендер сократился с 40 до 6 миллисекунд.';
export const P2 = 'Ленивые вычисления откладывают работу до первого чтения значения.';
export const P3 = 'Кэш без ограничения памяти растёт и замедляет сборку мусора.';
// Shares P2's timecode on purpose: two points of one moment must render as one
// block with a single timecode and a dotted list.
export const P4 = 'При повторном рендере обновляются только изменённые узлы.';
export const SECTION_HEADING = 'Кэш узлов';

/** The first half of one JSON object, streamed before the provider holds. */
export const HEAD =
  `{"tldr":"${TLDR_HEAD}","keyPoints":[{"text":"${P1}","at":60,"ts":"1:00"},`;

/** The rest of the same object, sent only after the harness releases the gate. */
export const TAIL =
  `{"text":"${P2}","at":120,"ts":"2:00"},` +
  `{"text":"${P4}","at":120,"ts":"2:00"},` +
  `{"text":"${P3}","at":180,"ts":"3:00"}],` +
  `"sections":[{"heading":"${SECTION_HEADING}","at":0,"ts":"0:00",` +
  `"summary":"Повторное использование узлов убирает лишние проходы."}],` +
  `"takeaways":["Ограничивайте память кэша."]}`;

export const TRANSCRIPT_LINES = 40;

/** A pasted transcript with 40 timestamped lines; every line reaches the prompt. */
export function transcriptText() {
  const topics = ['кэширование', 'рендер', 'память', 'профилирование', 'инвалидация'];
  const lines = [];
  for (let i = 0; i < TRANSCRIPT_LINES; i++) {
    const mm = String(Math.floor((i * 15) / 60)).padStart(2, '0');
    const ss = String((i * 15) % 60).padStart(2, '0');
    lines.push(
      `${mm}:${ss} На шаге ${i + 1} разбираем ${topics[i % topics.length]} и измеряем, ` +
        'как решение влияет на скорость рендера и надёжность.',
    );
  }
  return lines.join('\n');
}

/** A long synthetic transcript for the local-engine speed pass. */
export function longTranscriptText(count = 1000) {
  const topics = ['кэширование', 'рендер', 'память', 'профилирование', 'инвалидация', 'сеть', 'алгоритмы', 'тесты'];
  const lines = [];
  for (let i = 0; i < count; i++) {
    const total = i * 15;
    const hh = Math.floor(total / 3600);
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    const stamp = hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
    lines.push(
      `${stamp} На шаге ${i + 1} разбираем ${topics[i % topics.length]} и измеряем, ` +
        'как решение влияет на скорость рендера, потребление памяти и надёжность всей системы.',
    );
  }
  return lines.join('\n');
}
/**
 * A watch page served from 127.0.0.1. The extension only needs a watch-like URL
 * and a few metadata nodes; captions are never requested because the transcript
 * is pasted by the test.
 */
export const STUB_PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Кэш и рендер — тестовое видео</title></head>
<body style="font-family:sans-serif;margin:2rem">
<h1 class="title ytd-watch-metadata">Кэш и рендер: тестовое видео</h1>
<div id="info-container"><span>1 234 просмотра</span></div>
<span class="ytp-time-duration">10:00</span>
<div id="movie_player"><video></video></div>
<main><p>Локальная страница-заглушка. Настоящий YouTube не используется.</p></main>
</body></html>`;

/**
 * A watch page with YouTube's page-world globals and a scripted transcript
 * panel endpoint. The background has no network here, so the only way to a
 * transcript is the page bridge: `get_transcript` is refused (as YouTube does
 * today) and `get_panel` answers with the 2026-10 view-model shape. This is the
 * offline regression test for the route that replaces DOM scraping.
 */
export const CAPTURE_PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Панель транскрипта — тестовое видео</title>
<script>
  window.ytInitialData = { contents: [{ getTranscriptEndpoint: { params: 'test-params' } }] };
  window.ytcfg = { get(key) {
    return {
      INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.20261023.01.00', hl: 'ru' } },
      INNERTUBE_CLIENT_VERSION: '2.20261023.01.00',
      VISITOR_DATA: 'e2e-visitor',
    }[key];
  } };
</script>
</head>
<body style="font-family:sans-serif;margin:2rem">
<h1 class="title ytd-watch-metadata">Панель транскрипта: тестовое видео</h1>
<div id="info-container"><span>7 просмотров</span></div>
<span class="ytp-time-duration">3:00</span>
<div id="movie_player"><video></video></div>
<main><p>Локальная страница: транскрипт приходит из get_panel, не из DOM.</p></main>
</body></html>`;

/** Lines the fake panel endpoint returns; the marker proves their origin. */
export const CAPTURE_SEGMENTS = [
  ['0:00', 'ФРАЗА-ИЗ-ПАНЕЛИ первая: кэш узлов ускоряет повторный рендер.'],
  ['0:40', 'ФРАЗА-ИЗ-ПАНЕЛИ вторая: память ограничивает размер кэша.'],
  ['1:20', 'ФРАЗА-ИЗ-ПАНЕЛИ третья: финальная сборка учитывает лимиты.'],
];

/** The answer the fake `get_panel` endpoint returns: three timed view models. */
export const CAPTURE_PANEL = {
  content: {
    engagementPanelSectionListRenderer: {
      content: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: CAPTURE_SEGMENTS.map(([timestamp, simpleText]) => ({
                  macroMarkersPanelItemViewModel: {
                    item: { timelineItemViewModel: { contentItems: [{ transcriptSegmentViewModel: { timestamp, simpleText } }] } },
                  },
                })),
              },
            },
          ],
        },
      },
    },
  },
};
