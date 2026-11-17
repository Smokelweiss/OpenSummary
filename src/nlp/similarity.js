/** Vector similarity helpers: cosine (TF maps), Jaccard (stem sets), BM25. */

export function tfVector(items) {
  const v = new Map();
  for (const it of items) v.set(it, (v.get(it) || 0) + 1);
  return v;
}

export function cosineMaps(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w) dot += v * w;
  }
  if (!dot) return 0;
  let na = 0;
  for (const v of a.values()) na += v * v;
  let nb = 0;
  for (const v of b.values()) nb += v * v;
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function jaccardSets(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const v of small) if (large.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/**
 * BM25 ranking over an array of documents (each: {stems: string[], at, text}).
 * Returns [{index, score, doc}] sorted descending.
 */
export function bm25(queryStems, docs, { k1 = 1.4, b = 0.72 } = {}) {
  const N = docs.length;
  if (!N || !queryStems.length) return [];
  const df = new Map();
  const lengths = new Array(N);
  let totalLen = 0;
  for (let i = 0; i < N; i++) {
    const stems = docs[i].stems || [];
    lengths[i] = stems.length;
    totalLen += stems.length;
    const seen = new Set(stems);
    for (const s of seen) df.set(s, (df.get(s) || 0) + 1);
  }
  const avgdl = totalLen / N || 1;
  const qTerms = new Map();
  for (const q of queryStems) qTerms.set(q, (qTerms.get(q) || 0) + 1);

  const results = [];
  for (let i = 0; i < N; i++) {
    const stems = docs[i].stems || [];
    if (!stems.length) continue;
    const tf = tfVector(stems);
    const len = lengths[i] || 1;
    let score = 0;
    for (const [term, qtf] of qTerms) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += qtf * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgdl)));
    }
    if (score > 0) {
      // Small bonus for exact phrase containment handled by caller.
      results.push({ index: i, score, doc: docs[i] });
    }
  }
  return results.sort((x, y) => y.score - x.score);
}
