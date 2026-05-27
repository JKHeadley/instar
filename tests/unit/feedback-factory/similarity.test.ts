/**
 * Unit tests (Tier 1) — feedback-factory similarity primitives (scar c, fuzzy layer).
 *
 * Behavioral + both-sides-of-boundary coverage that runs in CI. Byte-exact
 * equivalence to the reference Python is proven separately by the local parity
 * harness (scripts/feedback-factory/similarity-parity.mjs). Golden values anchor
 * the exact output so a tokenizer/division regression fails in CI too.
 */

import { describe, it, expect } from 'vitest';
import { tokenize, jaccardSimilarity } from '../../../src/feedback-factory/processor/similarity.js';

describe('tokenize', () => {
  it('lowercases and splits on non-[a-z0-9], deduping', () => {
    expect(tokenize('GitSync.pull FAILS')).toEqual(new Set(['gitsync', 'pull', 'fails']));
    expect(tokenize('duplicate duplicate word')).toEqual(new Set(['duplicate', 'word']));
  });

  it('is ASCII-only — non-ASCII letters/digits are separators, not tokens', () => {
    // "café" → "caf" + "" ; arabic digits dropped; é/ß split tokens.
    expect(tokenize('café')).toEqual(new Set(['caf']));
    expect(tokenize('arabic ٣٤٥ digits')).toEqual(new Set(['arabic', 'digits']));
    expect(tokenize('Straße')).toEqual(new Set(['stra', 'e']));
  });

  it('returns an empty set for punctuation-only / empty input', () => {
    expect(tokenize('')).toEqual(new Set());
    expect(tokenize('!!! ??? ...')).toEqual(new Set());
  });
});

describe('jaccardSimilarity', () => {
  it('is 1.0 for identical token sets', () => {
    expect(jaccardSimilarity('the quick brown fox', 'the quick brown fox')).toBe(1.0);
    // Case/punctuation differences that tokenize identically still score 1.0.
    expect(jaccardSimilarity('GitSync.pull FAILS', 'gitsync pull fails')).toBe(1.0);
  });

  it('is 0.0 for fully disjoint token sets', () => {
    expect(jaccardSimilarity('alpha beta gamma', 'one two three')).toBe(0.0);
  });

  it('is 0.0 when either side has no tokens (the empty guard)', () => {
    expect(jaccardSimilarity('', 'non empty title')).toBe(0.0);
    expect(jaccardSimilarity('non empty title', '')).toBe(0.0);
    expect(jaccardSimilarity('!!!', 'something')).toBe(0.0);
  });

  it('computes |A∩B| / |A∪B| exactly', () => {
    // {the,quick,brown,fox} vs {the,quick,red,fox}: ∩={the,quick,fox}=3, ∪=5 → 0.6
    expect(jaccardSimilarity('the quick brown fox', 'the quick red fox')).toBeCloseTo(0.6, 12);
    // {a,b,c,d,e,f,g} vs {a,b,c,d,h,i,j}: ∩=4, ∪=10 → 0.4
    expect(jaccardSimilarity('a b c d e f g', 'a b c d h i j')).toBeCloseTo(0.4, 12);
  });

  it('orders the merge thresholds correctly (the clustering decision boundary)', () => {
    // ∩=3,∪=5 → 0.6 ≥ 0.55 (fixed-cluster false-merge threshold)
    expect(jaccardSimilarity('the quick brown fox', 'the quick red fox')).toBeGreaterThanOrEqual(0.55);
    // ∩=4,∪=10 → 0.4: ≥0.35 (default merge) but <0.55 (would NOT merge into a fixed cluster)
    const mid = jaccardSimilarity('a b c d e f g', 'a b c d h i j');
    expect(mid).toBeGreaterThanOrEqual(0.35);
    expect(mid).toBeLessThan(0.55);
  });
});
