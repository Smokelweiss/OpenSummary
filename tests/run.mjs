/**
 * Test entry point: imports every *.test.mjs file, runs the suites and exits
 * with a non-zero code when something fails.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAll } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

console.log(`OpenSummary test suite — ${files.length} file(s)\n`);
for (const file of files) {
  await import(new URL(`./${file}`, import.meta.url).href);
}

const failures = await runAll();
if (failures > 0) {
  console.error(`\n${failures} test(s) failed (${join(here, '*.test.mjs')})`);
  process.exit(1);
}
console.log('All tests passed.');
