/**
 * Robust extraction of embedded JSON blobs from a YouTube watch page.
 * Avoids fragile regexes by scanning balanced braces/strings.
 */

/** Finds `varName = { ... }` / `window["varName"] = {...}` and returns the JSON text. */
export function extractJsonAssignment(html, varName) {
  const text = String(html || '');
  const patterns = [
    new RegExp(`(?:var\\s+)?${escapeRe(varName)}\\s*=\\s*`),
    new RegExp(`window\\s*\\[\\s*["']${escapeRe(varName)}["']\\s*\\]\\s*=\\s*`),
    new RegExp(`${escapeRe(varName)}\\s*:\\s*`),
  ];
  for (const re of patterns) {
    const match = re.exec(text);
    if (!match) continue;
    const start = text.indexOf('{', match.index + match[0].length - 1);
    if (start === -1) continue;
    const json = scanBalanced(text, start);
    if (json && json.length > 200) return json;
  }
  return null;
}

/** Scans a balanced JSON object starting at `start` (index of `{`). */
export function scanBalanced(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function getPlayerResponse(html) {
  return parseJsonSafe(extractJsonAssignment(html, 'ytInitialPlayerResponse'));
}

export function getInitialData(html) {
  return parseJsonSafe(extractJsonAssignment(html, 'ytInitialData'));
}

/**
 * The watch page carries the InnerTube client version and visitor id it was
 * rendered with. Reusing them makes API calls look like the page's own ones —
 * a stale hard-coded client version is what makes `get_transcript` answer 400.
 */
export function getInnertubeConfig(html) {
  const text = String(html || '');
  const pick = (patterns) => {
    for (const re of patterns) {
      const m = re.exec(text);
      if (m && m[1]) return m[1];
    }
    return '';
  };
  return {
    clientVersion: pick([
      /"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([\d.]+)"/,
      /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([\d.]+)"/,
      /INNERTUBE_CONTEXT_CLIENT_VERSION["']?\s*[:=]\s*["']([\d.]+)["']/,
    ]),
    visitorData: pick([/"visitorData"\s*:\s*"([^"]+)"/, /"VISITOR_DATA"\s*:\s*"([^"]+)"/]),
  };
}

export function looksLikeConsentPage(html) {
  const t = String(html || '');
  return /consent\.youtube\.com|Before you continue to YouTube|Прежде чем перейти/.test(t) && !t.includes('ytInitialPlayerResponse');
}

export function looksLikeWatchPage(html) {
  return /ytInitialPlayerResponse/.test(String(html || ''));
}

/**
 * Depth-first search for the first object satisfying `predicate`.
 * Returns { value, path } or null. Guards against cycles and huge trees.
 */
export function deepFind(root, predicate, { maxNodes = 60000, maxDepth = 40 } = {}) {
  let visited = 0;
  const stack = [{ node: root, depth: 0, path: '' }];
  const seen = new Set();
  while (stack.length) {
    const { node, depth, path } = stack.pop();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (++visited > maxNodes) break;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], depth: depth + 1, path });
      continue;
    }
    if (predicate(node)) return { value: node, path };
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      const child = node[key];
      if (child && typeof child === 'object') stack.push({ node: child, depth: depth + 1, path: `${path}.${key}` });
    }
  }
  return null;
}

/** Collects every object satisfying `predicate` (bounded). */
export function deepCollect(root, predicate, { maxNodes = 80000, maxResults = 400, maxDepth = 40 } = {}) {
  const out = [];
  let visited = 0;
  const stack = [{ node: root, depth: 0 }];
  const seen = new Set();
  while (stack.length && out.length < maxResults) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (++visited > maxNodes) break;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push({ node: node[i], depth: depth + 1 });
      continue;
    }
    if (predicate(node)) out.push(node);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
    }
  }
  return out;
}

/** Extracts text from a YouTube text object ({simpleText} | {runs:[{text}]}). */
export function ytText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return String(node.simpleText);
  if (Array.isArray(node.runs)) return node.runs.map((r) => r?.text || '').join('');
  if (node.text) return String(node.text);
  return '';
}

export function decodeEntities(str) {
  return String(str || '')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
