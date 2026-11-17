# fixtures/youtube

Сюда кладут **очищенный** снимок реального ответа YouTube (`ytInitialPlayerResponse`)
для проверки разбора субтитров без сети. Тест уровня B
(`tests/player-response.test.mjs`) подхватывает любой `*.json` из этой папки;
пока файлов нет, он печатает «ожидается fixture» и ничего не утверждает.

Что даёт такой файл, а что нет:

* **Даёт:** проверку `extractCaptionTracks`, `pickTrack`, `isPoTokenProtected`
  и `extractTranscriptParams` на настоящей разметке конкретного видео и
  конкретного снимка.
* **Не даёт:** доказательства, что скачивание субтитров работает. Подписанные
  `baseUrl` обезличены, срок их жизни истёк, а PO-token выдаётся только плеером.
  Это уровень C — живой запрос.

## Как снять

На машине, где YouTube открывается:

1. Откройте видео (`https://www.youtube.com/watch?v=…`), дождитесь плеера.
2. DevTools → Console → проверьте, что объект есть:
   `ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer`.
3. Сохраните страницу целиком (`Ctrl+S` → «Веб-страница, полностью») или
   скопируйте только `ytInitialPlayerResponse` в `.json`. Для первичного
   анализа достаточно `videoDetails` и `captions.playerCaptionsTracklistRenderer`,
   но HTML удобнее: из него берётся ещё и `getTranscriptEndpoint.params`.

Важно: `ytInitialPlayerResponse` не выдаёт ваш аккаунт, но в нём есть
подписанные `baseUrl`, `visitorData` и другие временные идентификаторы.
Не публикуйте исходный файл.

## Как очистить

```bash
node tools/player-response.mjs analyze  saved.html            # отчёт, ничего не пишет
node tools/player-response.mjs sanitize saved.html --out=tests/fixtures/youtube/<id>.json
node tools/player-response.mjs status                         # состояние уровней A/B/C
```

`sanitize` заменяет значения всех параметров URL, кроме `v`, `lang`, `fmt`,
`kind`, `tlang`, `hl` и маркера `exp=xpe`, на `REDACTED`; выбрасывает
`trackingParams`, `thumbnail`-трекеры, `playbackTracking`, `playerConfig`,
`visitorData` и прочие служебные блоки; `getTranscriptEndpoint.params`
заменяет заглушкой, сохраняя путь. Перед записью файл проверяется
(`auditFixture`): «живая» подпись, JWT, API-ключ или длинный токеноподобный
литерал — и fixture не создаётся.

После записи проверьте глазами `redaction` в файле: там перечислено, что
именно заменено и удалено. Сравнение разбора до/после (`паритет разбора`)
печатает команда `sanitize`; если оно расходится, fixture писать нельзя —
очистка уничтожила значимое поле.

## Формат

```json
{
  "fixtureVersion": 1,
  "capturedAt": "YYYY-MM-DD",
  "source": "ytInitialPlayerResponse",
  "videoId": "…",
  "redaction": { "urlParamsRedacted": [], "droppedPlayerFields": [], "droppedTrackFields": [], "transcriptParams": "placeholder" },
  "playerResponse": { "videoDetails": {}, "microformat": {}, "captions": {} },
  "initialData": { "…": { "getTranscriptEndpoint": { "params": "PLACEHOLDER_TRANSCRIPT_PARAMS" } } },
  "expected": { "poProtected": [false, true] }
}
```

`expected` необязателен: если он есть, тест сверит массив `poProtected` с
фактическим разбором и поймает изменение правила `exp=xpe`.
