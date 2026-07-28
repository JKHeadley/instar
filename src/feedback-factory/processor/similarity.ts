/**
 * similarity.ts — TS port of the feedback-factory title-similarity primitives.
 *
 * Part of scar (c) of docs/specs/feedback-factory-migration.md. Byte-exact port
 * of `_tokenize` (:1389) and `_jaccard_similarity` (:1394) from the reference
 * `the-portal/.claude/scripts/feedback-processor.py`. These are the FUZZY match
 * layer that sits on top of the exact-match fingerprint (fingerprint.ts): two
 * reports whose titles overlap enough (Jaccard ≥ threshold) are candidates for
 * the same cluster. The threshold-application logic (0.35 vs the 0.55 fixed-
 * cluster false-merge guard) lives in the clustering driver and is a later
 * increment; this module is the pure, parity-testable similarity primitive.
 *
 * Divergence surface (per spec / convergence): the TOKENIZER. Python
 * `re.findall(r'[a-z0-9]+', text.lower())` is ASCII-only — non-ASCII letters and
 * Unicode digits are token separators, NOT token content. JS `/[a-z0-9]+/g`
 * (no `u`, no `i`) matches the identical ASCII class, so the only residual risk
 * is `.lower()` vs `.toLowerCase()` on characters that then survive the ASCII
 * filter. The parity harness verifies equivalence over the adversarial corpus.
 */

/** Port of Python `_tokenize` (:1391): ASCII word tokens of the lowercased text, deduped. */
export function tokenize(text: string): Set<string> {
  // Python: set(re.findall(r'[a-z0-9]+', text.lower())). re.findall returns
  // non-overlapping matches; String.match(//g) is the JS equivalent (null when
  // none → treat as empty). The class is ASCII (no `u` flag), matching Python.
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return new Set(matches ?? []);
}

/** Port of Python `_jaccard_similarity` (:1394): |A∩B| / |A∪B|, 0 when either side is empty. */
export function jaccardSimilarity(text1: string, text2: string): number {
  const t1 = tokenize(text1);
  const t2 = tokenize(text2);
  if (t1.size === 0 || t2.size === 0) return 0.0;
  let intersection = 0;
  for (const tok of t1) {
    if (t2.has(tok)) intersection++;
  }
  // |A∪B| = |A| + |B| − |A∩B|. Integer division as float — IEEE-754 doubles in
  // both Python and JS, so boundary comparisons (≥0.35, ≥0.55) agree.
  const union = t1.size + t2.size - intersection;
  return intersection / union;
}
