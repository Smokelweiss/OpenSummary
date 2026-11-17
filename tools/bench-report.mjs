#!/usr/bin/env node
/**
 * Aggregates several live benchmark reports into one before/after table.
 *
 *   for i in 1 2 3 4 5; do npm run bench -- --live --transcript=video.txt --out=run-$i.json; done
 *   node tools/bench-report.mjs run-*.json
 *
 * The median is reported with min–max spread, never a single lucky run. Reports
 * may come from different versions: pass `--label=1.4.6` before a group of files
 * to name that group.
 *
 *   node tools/bench-report.mjs --label=before run-1.json ... --label=after new-1.json ...
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const groups = [];
let current = { label: 'all', files: [] };
for (const arg of argv) {
  if (arg.startsWith('--label=')) {
    if (current.files.length) groups.push(current);
    current = { label: arg.slice('--label='.length) || 'all', files: [] };
  } else {
    current.files.push(arg);
  }
}
if (current.files.length) groups.push(current);
if (!groups.length) {
  console.error('Usage: node tools/bench-report.mjs [--label=name] report.json [more.json ...]');
  process.exit(2);
}

const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const fmt = (ms) => (ms == null ? '—' : ms > 0 && ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
// A zero first-partial means the run never published one (single-pass), not “instant”.
const fmtNullable = (ms) => (ms == null || ms === 0 ? '—' : fmt(ms));

function summarize(files, label) {
  const reports = [];
  for (const file of files) {
    try {
      reports.push({ file, data: JSON.parse(readFileSync(file, 'utf8')) });
    } catch (err) {
      console.error(`${file}: ${err.message}`);
    }
  }
  const ok = reports.filter((r) => !r.data.error);
  const pick = (fn) => ok.map((r) => fn(r.data)).filter((v) => v != null);
  const stat = (fn) => {
    const values = pick(fn);
    if (!values.length) return null;
    const m = median(values);
    return { median: m, min: Math.min(...values), max: Math.max(...values), n: values.length };
  };
  return {
    label,
    files: files.length,
    failed: reports.length - ok.length,
    total: stat((d) => d.timings?.totalMs),
    firstPartial: stat((d) => d.firstPartialMs || d.timings?.firstPartialMs),
    // Single-pass: the first validated item the panel could show. Zero means
    // the run emitted none (non-streamed or map-reduce), not “instant”.
    streamFirstItem: stat((d) => d.streamFirstItemMs),
    firstProgress: stat((d) => d.timings?.firstProgressMs),
    requests: stat((d) => d.calls?.length),
    tokensOut: stat((d) => d.usage?.completionTokens),
    tokensIn: stat((d) => d.usage?.promptTokens),
    reduceRounds: stat((d) => d.reduceRounds),
    rateLimited: stat((d) => d.rateLimited),
    models: [...new Set(ok.flatMap((r) => r.data.models || []))],
    stages: ok.length ? ok[ok.length - 1].data.stagesMs || {} : {},
  };
}

const rows = groups.map((g) => summarize(g.files, g.label));
const width = (s) => String(s).length;

console.log('\n| run | n | total (median) | spread | first partial | first item | requests | in→out tokens | reduce rounds | 429 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const spread =
    r.total && r.total.n > 1 ? `${fmt(r.total.min)}–${fmt(r.total.max)}` : r.total ? 'single run' : '—';
  console.log(
    `| ${r.label} | ${r.total?.n ?? 0} | ${fmt(r.total?.median)} | ${spread} | ${fmtNullable(r.firstPartial?.median)} | ` +
      `${fmtNullable(r.streamFirstItem?.median)} | ${r.requests?.median ?? '—'} | ${r.tokensIn?.median ?? '—'}→${r.tokensOut?.median ?? '—'} | ` +
      `${r.reduceRounds?.median ?? '—'} | ${r.rateLimited?.median ?? 0} |`,
  );
}
for (const r of rows) {
  const stages = Object.entries(r.stages).filter(([, ms]) => Number(ms) > 0);
  if (stages.length) console.log(`\n${r.label} stage time (sum of provider calls): ${stages.map(([s, ms]) => `${s} ${fmt(ms)}`).join(' · ')}`);
  if (r.models.length) console.log(`${r.label} reported models: ${r.models.join(', ')}`);
  if (r.failed) console.log(`${r.label}: ${r.failed} run(s) failed and were left out of the medians.`);
}
