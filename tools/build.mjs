/**
 * Builds distributable archives: dist/opensummary-<target>-<version>.zip
 *
 * The Chrome build ships the manifest as-is (MV3 service worker).
 * The Firefox build rewrites the background section to an event page and keeps
 * the gecko application id.
 *
 * Usage: node tools/build.mjs [--target=chrome|firefox|all]
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);
const target = args.target || 'all';

const INCLUDE_DIRS = ['src', 'assets'];
const INCLUDE_FILES = ['LICENSE', 'PRIVACY.md', 'README.md', 'CHANGELOG.md'];
const IGNORE = [/\.map$/, /\.DS_Store$/, /Thumbs\.db$/, /\.zip$/];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (IGNORE.some((re) => re.test(entry.name))) continue;
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

function collectFiles() {
  const files = [];
  for (const dir of INCLUDE_DIRS) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) {
      console.warn(`! missing directory: ${dir}`);
      continue;
    }
    for (const rel of walk(abs, ROOT)) files.push(rel.replace(/\\/g, '/'));
  }
  for (const file of INCLUDE_FILES) {
    if (existsSync(join(ROOT, file))) files.push(file);
  }
  return files.sort();
}

function buildManifest(kind, manifest, version) {
  const copy = JSON.parse(JSON.stringify(manifest));
  copy.version = version;
  copy.version_name = version;

  if (kind === 'firefox') {
    copy.background = {
      scripts: ['src/background/service-worker.js'],
      type: 'module',
    };
    copy.browser_specific_settings = {
      ...(copy.browser_specific_settings || {}),
      gecko: {
        id: 'opensummary@opensummary.app',
        strict_min_version: '128.0',
        ...(copy.browser_specific_settings?.gecko || {}),
      },
    };
    // Firefox does not support the "unlimitedStorage" name in MV3 permissions.
    copy.permissions = (copy.permissions || []).filter((p) => p !== 'unlimitedStorage');
    // web_accessible_resources stays in its MV3 shape: Firefox 128+ reads
    // `{resources, matches}` here (a flat list is rejected with “Expected
    // object instead of …”).
  } else {
    delete copy.browser_specific_settings;
  }

  if (/\{(accountId|model)\}/.test(JSON.stringify(copy.host_permissions || []))) {
    throw new Error('host_permissions must not contain placeholders');
  }
  return copy;
}

function verifyAssets(manifest, files) {
  const required = [
    manifest.background?.service_worker,
    manifest.background?.scripts?.[0],
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
    // Injected page scripts must exist too; a missing one fails only at runtime.
    ...(manifest.web_accessible_resources || [])
      .flatMap((entry) => (Array.isArray(entry) ? entry : entry.resources || []))
      .filter((rel) => !rel.includes('*')),
  ].filter(Boolean);

  const missing = required.filter((rel) => !files.includes(rel.replace(/\\/g, '/')));
  if (missing.length) throw new Error(`missing files referenced by manifest:\n  - ${missing.join('\n  - ')}`);
}

/**
 * Windows keeps a transient lock on files opened by Explorer previews, AV scans
 * or an open archive viewer: `open` fails with an opaque UNKNOWN/EPERM error.
 * Deleting the stale file and retrying the write is enough, and it beats
 * failing a perfectly good build.
 */
function writeArtifact(outPath, buffer) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(outPath, buffer);
      return;
    } catch (err) {
      if (!['UNKNOWN', 'EPERM', 'EBUSY', 'EACCES'].includes(err?.code) || attempt === 2) throw err;
      // The old ZIP is still open somewhere (Explorer preview, archive viewer).
      // Removing it frees the name; the next attempt writes a fresh file.
      try {
        rmSync(outPath, { force: true });
      } catch {
        /* the lock holder may refuse even that; the retry decides */
      }
    }
  }
}

function buildOne(kind) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const files = collectFiles();
  const built = buildManifest(kind, manifest, pkg.version);
  verifyAssets(built, files);

  const zipFiles = files.map((rel) => ({ name: rel, data: readFileSync(join(ROOT, rel)) }));
  zipFiles.push({ name: 'manifest.json', data: JSON.stringify(built, null, 2) });

  mkdirSync(DIST, { recursive: true });
  const outName = `opensummary-${kind}-${pkg.version}.zip`;
  const outPath = join(DIST, outName);
  const buffer = createZip(zipFiles);
  writeArtifact(outPath, buffer);

  const sizeKb = Math.round(buffer.length / 1024);
  console.log(`${kind.padEnd(8)} → dist/${outName}  (${zipFiles.length} files, ${sizeKb} KB)`);
  return outName;
}

function makeSourceFolder(kind) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const built = buildManifest(kind, manifest, pkg.version);
  const dir = join(DIST, `opensummary-${kind}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const rel of collectFiles()) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(ROOT, rel)));
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(built, null, 2));
  console.log(`${kind.padEnd(8)} → dist/opensummary-${kind}/ (unpacked, load via «Загрузить распакованное»)`);
  return dir;
}

const targets = target === 'all' ? ['chrome', 'firefox'] : [target];
for (const kind of targets) {
  if (!['chrome', 'firefox'].includes(kind)) throw new Error(`unknown target: ${kind}`);
  buildOne(kind);
  makeSourceFolder(kind);
}
console.log('\nBuild finished.');
void statSync;
