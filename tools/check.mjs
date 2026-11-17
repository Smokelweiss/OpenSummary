/**
 * Static checks: JS/JSON syntax, manifest wiring, doc mentions, secret leaks.
 * Run: npm run check
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Local snapshots and build output are not part of the shipped extension.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'assets', 'BackupAI']);
const issues = [];
const notes = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.includes(`${join(ROOT, 'dist')}`));

/* ------------------------------------------------------------- JS syntax --- */

const jsFiles = files.filter((f) => ['.js', '.mjs'].includes(extname(f)));
for (const file of jsFiles) {
  // package.json has "type": "module", so `node --check` parses these as ESM.
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    issues.push(`syntax error in ${relative(ROOT, file)}:\n${(res.stderr || '').trim().split('\n').slice(0, 6).join('\n')}`);
  }
}
notes.push(`${jsFiles.length} JS files parsed`);

/* -------------------------------------------------------------- JSON files -- */

const jsonFiles = files.filter((f) => extname(f) === '.json');
for (const file of jsonFiles) {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    issues.push(`invalid JSON: ${relative(ROOT, file)} — ${err.message}`);
  }
}
notes.push(`${jsonFiles.length} JSON files parsed`);

/* ---------------------------------------------------------------- manifest -- */

const manifestPath = join(ROOT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const referenceChecks = [
  ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons || {}),
  ...(manifest.web_accessible_resources || []).flatMap((r) => (r.resources || []).filter((x) => !x.includes('*'))),
].filter(Boolean);

for (const rel of referenceChecks) {
  if (!existsSync(join(ROOT, rel))) issues.push(`manifest references a missing file: ${rel}`);
}
notes.push(`manifest: ${referenceChecks.length} referenced files verified`);

// The background and every content script must not import ES modules that the
// runtime cannot resolve in that context.
const contentFiles = (manifest.content_scripts || []).flatMap((cs) => cs.js || []);
for (const rel of contentFiles) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  if (/^\s*import\s/m.test(src)) issues.push(`content script ${rel} uses ES import (not supported without modules)`);
}

/* ------------------------------------------------------------------ docs ---- */

const readmePath = join(ROOT, 'README.md');
if (!existsSync(readmePath)) issues.push('README.md is missing');
else {
  const readme = readFileSync(readmePath, 'utf8');
  for (const required of ['OpenSummary', 'установк', 'Chrome', 'Firefox', 'Ollama', 'Google AI Studio']) {
    if (!readme.toLowerCase().includes(required.toLowerCase())) notes.push(`README.md does not mention «${required}»`);
  }
}

for (const doc of ['PRIVACY.md', 'LICENSE', 'CHANGELOG.md', 'AGENTS.md', 'PLAN.md']) {
  if (!existsSync(join(ROOT, doc))) notes.push(`${doc} is missing`);
}

/* ------------------------------------------------------------------ pages --- */

// Every id referenced by popup.js / options.js must exist in the matching HTML:
// a typo would only show up as a runtime TypeError in the browser.
for (const page of ['popup', 'options']) {
  const htmlPath = join(ROOT, 'src', page, `${page}.html`);
  const jsPath = join(ROOT, 'src', page, `${page}.js`);
  if (!existsSync(htmlPath) || !existsSync(jsPath)) continue;
  const html = readFileSync(htmlPath, 'utf8');
  const js = readFileSync(jsPath, 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set(
    [...js.matchAll(/(?:\$\(|getElementById\()\s*'([^']+)'\s*\)/g)].map((m) => m[1]),
  );
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  if (missing.length) issues.push(`${page}.js references unknown element ids: ${missing.join(', ')}`);
  notes.push(`${page}: ${referenced.size} element ids verified against ${page}.html`);
}

/* --------------------------------------------------------- message contracts */

// Every `type: '...'` the UI sends must be a known message/port type. A typo
// here silently breaks the extension at runtime and no unit test would see it.
const constantsSrc = readFileSync(join(ROOT, 'src', 'common', 'constants.js'), 'utf8');
function extractBlock(name) {
  const start = constantsSrc.indexOf(`export const ${name} = {`);
  if (start === -1) return [];
  const end = constantsSrc.indexOf('\n};', start);
  return [...constantsSrc.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}
const knownTypes = new Set([
  ...extractBlock('MSG'),
  ...extractBlock('EV'),
  ...extractBlock('PORT'),
  ...extractBlock('PORT_MSG'),
  'osum:ping',
  'osum:command',
  'osum:settings-changed',
  'osum:inject',
]);
// Not message types: HTML input types, provider API families, MIME-ish values.
const notMessages = new Set([
  'text',
  'search',
  'checkbox',
  'radio',
  'number',
  'password',
  'email',
  'url',
  'file',
  'hidden',
  'date',
  'range',
  'color',
  'submit',
  'button',
  'reset',
  'openai',
  'google',
  'anthropic',
  'ollama',
  'json',
  'markdown',
  'auto',
  'none',
  'local',
  'session',
]);

const uiFiles = [
  ...readdirSync(join(ROOT, 'src', 'content')).map((f) => join(ROOT, 'src', 'content', f)),
  ...readdirSync(join(ROOT, 'src', 'popup')).map((f) => join(ROOT, 'src', 'popup', f)),
  ...readdirSync(join(ROOT, 'src', 'options')).map((f) => join(ROOT, 'src', 'options', f)),
].filter((f) => f.endsWith('.js'));

let typeRefs = 0;
for (const file of uiFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\b(?:type|name):\s*'([a-z0-9:-]+)'/g)) {
    const value = match[1];
    if (notMessages.has(value)) continue;
    typeRefs++;
    if (!knownTypes.has(value)) {
      issues.push(`unknown message type "${value}" used in ${relative(ROOT, file)}`);
    }
  }
}
notes.push(`${typeRefs} message/port types validated against constants.js`);

/* ------------------------------------------------------------ module wiring */

// Named imports must exist as exports in the target module. A mismatch here
// (e.g. importing something the module never exports) breaks the service worker
// at load time — the worst kind of failure, invisible to unit tests.
function parseExports(source) {
  const names = new Set();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default\b/m.test(source)) names.add('default');
  return names;
}

function parseRelativeImports(source) {
  const out = [];
  for (const match of source.matchAll(/^import\s+([^;]+?)\s+from\s+'([^']+)';/gm)) {
    const clause = match[1].trim();
    const spec = match[2];
    if (!spec.startsWith('.')) continue;
    const names = [];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, '').replaceAll(',', '').trim();
    if (rest && !rest.startsWith('*')) names.push('default');
    out.push({ spec, names });
  }
  return out;
}

let importCount = 0;
const exportCache = new Map();
for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  for (const { spec, names } of parseRelativeImports(source)) {
    importCount++;
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) {
      issues.push(`${relative(ROOT, file)} imports a missing module: ${spec}`);
      continue;
    }
    if (!exportCache.has(target)) exportCache.set(target, parseExports(readFileSync(target, 'utf8')));
    const exported = exportCache.get(target);
    for (const name of names) {
      if (!exported.has(name)) {
        issues.push(`${relative(ROOT, file)} imports "${name}" from ${spec}, which does not export it`);
      }
    }
  }
}
notes.push(`${importCount} relative imports resolved against real exports`);

/* ------------------------------------------------------- undefined callees --- */

// A call to a function that is neither defined, imported nor a known global is
// almost always a runtime ReferenceError (e.g. a helper that was never written).
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'delete', 'in', 'of', 'do', 'else',
  'try', 'throw', 'case', 'break', 'continue', 'default', 'class', 'extends', 'yield', 'await', 'void', 'instanceof',
  'import', 'export', 'super', 'this', 'with', 'satisfies', 'async', 'get', 'set', 'static', 'constructor',
]);
const GLOBALS = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'Blob', 'Boolean', 'CustomEvent', 'DOMParser', 'Date', 'Element', 'Error', 'Event',
  'File', 'FileReader', 'FormData', 'Function', 'Headers', 'Image', 'Intl', 'JSON', 'Map', 'Math', 'MutationObserver',
  'Number', 'Object', 'Promise', 'Proxy', 'ReadableStream', 'RegExp', 'Request', 'Response', 'Set', 'String', 'Symbol',
  'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams', 'WeakMap', 'WeakSet', 'XMLHttpRequest', 'AbortController',
  'AbortSignal', 'IntersectionObserver', 'ResizeObserver', 'alert', 'atob', 'btoa', 'browser', 'cancelAnimationFrame',
  'caches', 'chrome', 'clearInterval', 'clearTimeout', 'confirm', 'console', 'crypto', 'decodeURI', 'decodeURIComponent',
  'document', 'encodeURI', 'encodeURIComponent', 'fetch', 'getComputedStyle', 'globalThis', 'history', 'indexedDB',
  'isFinite', 'isNaN', 'location', 'matchMedia', 'navigator', 'parseFloat', 'parseInt', 'performance', 'postMessage',
  'prompt', 'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback', 'screen', 'self', 'setInterval',
  'setTimeout', 'structuredClone', 'window', 'setImmediate', 'clearImmediate', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'DataView', 'Buffer', 'process', 'URLPattern', 'reportError',
]);

function collectBindings(source) {
  const names = new Set();
  const add = (name) => {
    if (name && !KEYWORDS.has(name)) names.add(name);
  };
  // declarations
  for (const m of source.matchAll(/\b(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) add(m[1]);
  // destructuring: const { a, b: c } = / const [a, b] =
  for (const m of source.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().replace(/[^\w$].*$/, '');
      add(name);
    }
  }
  // imports
  for (const m of source.matchAll(/\bimport\s+([^;]+?)\s+from\s+'[^']+';/g)) {
    const clause = m[1];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        add(name);
      }
    }
    const plain = clause.replace(/\{[^}]*\}/, '').replaceAll(',', '').trim();
    if (plain && !plain.startsWith('*')) add(plain);
  }
  // parameters of functions/arrows: (a, b) =>  /  function f(a, b)
  for (const m of source.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[=:]/)[0].replace(/[^\w$].*$/, '').replace(/^\.\.\./, '');
      add(name);
    }
  }
  // single-argument arrows: x => ...
  for (const m of source.matchAll(/(?:^|[\s(,{])([A-Za-z0-9_$]+)\s*=>/gm)) add(m[1]);
  // object-literal / class method shorthand: `name(args) {`
  for (const m of source.matchAll(/(?:^|[\s,{])([A-Za-z0-9_$]+)\s*\([^()]*\)\s*\{/gm)) add(m[1]);
  // catch (err) / for (const x of
  for (const m of source.matchAll(/\bcatch\s*\(\s*([A-Za-z0-9_$]+)/g)) add(m[1]);
  // parameter defaults, incl. nested destructuring: { onEvent = () => {}, signal }
  for (const m of source.matchAll(/[{,(]\s*([A-Za-z0-9_$]+)\s*=(?!=)/g)) add(m[1]);
  // object shorthand { a, b } — treat as bound (also used to export functions)
  for (const m of source.matchAll(/\{([^{}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim();
      if (/^[A-Za-z0-9_$]+$/.test(name)) add(name);
    }
  }
  return names;
}

let callSites = 0;
for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  // Strip comments and string literals so their contents are not scanned.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const bound = collectBindings(source);
  for (const m of code.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    callSites++;
    if (KEYWORDS.has(name) || GLOBALS.has(name) || bound.has(name)) continue;
    issues.push(`${relative(ROOT, file)} calls "${name}()", which is not defined, imported or a known global`);
  }
}
notes.push(`${callSites} call sites checked for undefined functions`);

/* --------------------------------------------------------------- secrets ---- */

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, 'OpenAI-style key'],
  [/AIza[0-9A-Za-z\-_]{30,}/, 'Google API key'],
  [/gsk_[A-Za-z0-9]{20,}/, 'Groq key'],
  [/sk-or-v1-[A-Za-z0-9]{20,}/, 'OpenRouter key'],
  [/ghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/nvapi-[A-Za-z0-9\-_]{20,}/, 'NVIDIA key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
];

// Values that are public by design (shipped inside youtube.com's own bundles,
// documented examples), not user credentials.
// Kept split in two parts on purpose: the scan below must not flag this file.
const PUBLIC_VALUES = [
  'AIza' + 'SyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', // YouTube InnerTube web client key
];

for (const file of files) {
  if (extname(file) === '.png') continue;
  const source = readFileSync(file, 'utf8');
  for (const [re, label] of SECRET_PATTERNS) {
    const match = source.match(re);
    if (!match) continue;
    if (/example|placeholder|your[-_]?key|xxxx/i.test(match[0])) continue;
    if (PUBLIC_VALUES.some((value) => match[0].includes(value))) continue;
    issues.push(`possible ${label} committed in ${relative(ROOT, file)}`);
  }
}
notes.push('secret scan completed');

/* ------------------------------------------------------------- structure ---- */

const requiredFiles = [
  'src/background/service-worker.js',
  'src/background/router.js',
  'src/background/tasks.js',
  'src/background/state.js',
  'src/background/transcripts.js',
  'src/ai/client.js',
  'src/ai/pipeline.js',
  'src/ai/providers.js',
  'src/nlp/extractive.js',
  'src/transcript/youtube.js',
  'src/content/panel.js',
  'src/popup/popup.html',
  'src/options/options.html',
];
for (const rel of requiredFiles) {
  if (!existsSync(join(ROOT, rel))) issues.push(`required file is missing: ${rel}`);
}

for (const rel of ['assets/icons/icon16.png', 'assets/icons/icon48.png', 'assets/icons/icon128.png']) {
  if (!existsSync(join(ROOT, rel))) notes.push(`${rel} not generated yet — run «npm run icons»`);
  else if (statSync(join(ROOT, rel)).size < 100) issues.push(`${rel} looks empty`);
}

/* ---------------------------------------------------------------- versions --- */

// The version lives in five places because the browser, the worker, the content
// script and the options page each need it. A bump that misses one of them
// shows as a stale number in diagnostics, so they are compared here.
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const version = pkg.version;
  const found = [];
  const expect = (label, value) => {
    found.push(label);
    if (value !== version) issues.push(`${label} has version ${value} but package.json says ${version}`);
  };
  expect('manifest.json version', manifest.version);
  if (manifest.version_name) expect('manifest.json version_name', manifest.version_name);
  const constants = readFileSync(join(ROOT, 'src/common/constants.js'), 'utf8');
  expect('APP.version in constants.js', constants.match(/version:\s*'([^']+)'/)?.[1]);
  const namespace = readFileSync(join(ROOT, 'src/content/namespace.js'), 'utf8');
  expect('OSUM.version in namespace.js', namespace.match(/OSUM\.version\s*=\s*'([^']+)'/)?.[1]);
  const optionsHtml = readFileSync(join(ROOT, 'src/options/options.html'), 'utf8');
  const htmlVersion = optionsHtml.match(/id="version"[^>]*>v?([\d.]+)</)?.[1];
  if (htmlVersion) expect('options.html #version', htmlVersion);
  notes.push(`version ${version} consistent across ${found.length + 1} files`);
}

/* ----------------------------------------------------------------- report --- */

console.log('OpenSummary checks');
console.log('-----------------');
for (const note of notes) console.log(`  · ${note}`);
if (!issues.length) {
  console.log('\nAll checks passed.');
  process.exit(0);
}
console.log(`\n${issues.length} problem(s):`);
for (const issue of issues) console.log(`  ✗ ${issue}`);
process.exit(1);
