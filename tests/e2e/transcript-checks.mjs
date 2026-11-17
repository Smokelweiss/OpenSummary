/**
 * Pure checks for a fetched transcript. Kept separate from the browser script
 * so the rules can be exercised without network access.
 */

/** Parses `m:ss` or `h:mm:ss` into seconds; null when it is not a timecode. */
export function parseTimecode(text) {
  const parts = String(text || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Throws with a human-readable reason when the rows are not a usable
 * transcript: empty text, HTML leftovers, duplicates, or timecodes out of
 * order. `rows` is `[{ at, ts, text }]` as rendered by the panel.
 */
export function validateTranscript(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('транскрипт пуст: нет ни одной строки');
  let previous = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const text = String(row?.text || '').trim();
    if (!text) throw new Error(`пустая строка транскрипта №${i + 1}`);
    if (!Number.isFinite(Number(row.at))) throw new Error(`у строки №${i + 1} нет таймкода`);
    const shown = parseTimecode(row.ts);
    // The panel renders `formatTime(start)`, which floors to whole seconds.
    if (row.ts && (shown === null || shown !== Math.floor(Number(row.at)))) {
      throw new Error(`таймкод строки №${i + 1} (${row.ts}) не совпадает с началом ${Number(row.at)} с`);
    }
    if (Number(row.at) < previous) {
      throw new Error(`таймкоды не по порядку: ${rows[i - 1]?.ts || previous} → ${row.ts || row.at} (строка ${i + 1})`);
    }
    if (/<[a-z/][^>]*>/i.test(text)) {
      throw new Error(`в тексте осталась HTML-разметка: ${text.slice(0, 120)}`);
    }
    if (/&(?:amp|lt|gt|quot|#\d+);/i.test(text)) {
      throw new Error(`в тексте остались HTML-сущности: ${text.slice(0, 120)}`);
    }
    if (i > 0 && String(rows[i - 1].text || '').trim() === text) {
      throw new Error(`подряд идёт одинаковый фрагмент: ${text.slice(0, 120)}`);
    }
    previous = Number(row.at);
  }
}

/**
 * Returns the fragments that did not reach any provider request. Prompts merge
 * neighbouring segments into blocks separated by spaces, so whitespace is
 * normalized before comparing; every row text must still appear contiguously.
 */
export function missingFromPrompt(rows, promptText) {
  const haystack = String(promptText || '').replace(/\s+/g, ' ');
  const missing = [];
  for (const row of rows || []) {
    const needle = String(row?.text || '').replace(/\s+/g, ' ').trim();
    if (needle && !haystack.includes(needle)) missing.push(needle);
  }
  return missing;
}
