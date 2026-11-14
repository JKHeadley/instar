/**
 * Reference checks for the in-repo diff and fuzzy matcher (spec §3.5): compared against simple
 * brute-force references written here, so the property tests have an independent oracle.
 */
import { describe, expect, it } from 'vitest';
import { myers } from '../../src/documents/diff.js';
import { fuzzyLocate } from '../../src/documents/anchor.js';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

/** Classic O(n·m) LCS length: the reference for how many edits Myers should need. */
function lcsLength(a: number[], b: number[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  return dp[a.length][b.length];
}

/** Brute-force best substring edit distance of `pat` inside `text`. */
function bestDistance(text: string, pat: string): number {
  let best = Infinity;
  for (let s = 0; s < text.length; s++) {
    let prev = Array.from({ length: pat.length + 1 }, (_, i) => i);
    for (let e = s; e < Math.min(text.length, s + pat.length * 2); e++) {
      const cur = [prev[0] + 1];
      for (let i = 1; i <= pat.length; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (pat[i - 1] === text[e] ? 0 : 1));
      best = Math.min(best, cur[pat.length]);
      prev = cur;
    }
  }
  return best;
}

describe('reference oracles', () => {
  it('Myers finds a minimal edit script (matches the LCS reference)', () => {
    const rnd = prng(7);
    for (let n = 0; n < 200; n++) {
      const a = Array.from({ length: Math.floor(rnd() * 30) }, () => Math.floor(rnd() * 5));
      const b = Array.from({ length: Math.floor(rnd() * 30) }, () => Math.floor(rnd() * 5));
      const script = myers(a, b, 10_000)!;
      const edits = script.filter(([kind]) => kind !== 0).length; // each step is one element: 0 eq, 1 del, 2 ins
      expect(edits).toBe(a.length + b.length - 2 * lcsLength(a, b));
    }
  });

  it('fuzzy matching finds a passage no worse than 25% from the brute-force best', () => {
    const rnd = prng(11);
    const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'kappa', 'sigma'];
    for (let n = 0; n < 40; n++) {
      const text = Array.from({ length: 60 }, () => words[Math.floor(rnd() * words.length)]).join(' ');
      const at = Math.floor(rnd() * (text.length - 40));
      let pat = text.slice(at, at + 32);
      pat = pat.slice(0, 10) + 'x' + pat.slice(11);
      const got = fuzzyLocate(text, pat, at);
      expect(got).not.toBeNull();
      const found = text.slice(got!.start, got!.end);
      expect(bestDistance(found, pat)).toBeLessThanOrEqual(bestDistance(text, pat) + Math.ceil(pat.length * 0.25));
    }
  });
});
