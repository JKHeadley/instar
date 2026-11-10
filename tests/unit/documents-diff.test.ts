import { describe, it, expect } from 'vitest';
import { diffWords, offsetMap, myers, type DiffOp } from '../../src/documents/diff.js';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WORDS = ['the', 'cat', 'sat', 'on', 'a', 'mat', 'and', 'dog', 'ran', ',', '.', 'é', '😀'];
function randomText(r: () => number, paras: number): string {
  const out: string[] = [];
  for (let p = 0; p < paras; p++) {
    const n = 1 + Math.floor(r() * 12);
    out.push(Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(r() < 0.2 ? '  ' : ' '));
  }
  return out.join('\n');
}
function mutate(r: () => number, s: string): string {
  let t = s;
  const edits = Math.floor(r() * 6);
  for (let i = 0; i < edits; i++) {
    const at = Math.floor(r() * (t.length + 1));
    const kind = r();
    if (kind < 0.4) t = t.slice(0, at) + WORDS[Math.floor(r() * WORDS.length)] + ' ' + t.slice(at);
    else if (kind < 0.8) t = t.slice(0, at) + t.slice(at + Math.floor(r() * 15));
    else t = t.slice(0, at) + '\n' + t.slice(at);
  }
  return t;
}
const side = (ops: DiffOp[], keep: 'a' | 'b'): string => ops.filter((o) => o.op === 'eq' || o.op === (keep === 'a' ? 'del' : 'ins')).map((o) => o.text).join('');

describe('diffWords', () => {
  it('produces a word-level diff inside a changed paragraph', () => {
    const { ops, truncated } = diffWords('one\nthe quick fox\nthree', 'one\nthe slow fox\nthree');
    expect(truncated).toBe(false);
    expect(ops).toEqual([
      { op: 'eq', text: 'one\nthe ' },
      { op: 'del', text: 'quick' },
      { op: 'ins', text: 'slow' },
      { op: 'eq', text: ' fox\nthree' },
    ]);
  });

  it('round-trips both sides (property, 300 seeded cases)', () => {
    const r = prng(42);
    for (let i = 0; i < 300; i++) {
      const a = randomText(r, 1 + Math.floor(r() * 8));
      const b = r() < 0.15 ? randomText(r, Math.floor(r() * 8)) : mutate(r, a);
      const { ops } = diffWords(a, b);
      expect(side(ops, 'a')).toBe(a);
      expect(side(ops, 'b')).toBe(b);
      for (const o of ops) expect(o.text.length).toBeGreaterThan(0);
    }
  });

  it('myers finds the minimal edit count', () => {
    const steps = myers(Int32Array.from([1, 2, 3, 4, 5]), Int32Array.from([1, 3, 4, 6, 5]), 100)!;
    expect(steps.filter(([k]) => k !== 0).length).toBe(2);
    expect(myers(Int32Array.from([1, 2, 3]), Int32Array.from([4, 5, 6]), 2)).toBeNull();
  });

  it('caps the paragraph level and falls back to prefix + replace + suffix', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n');
    const res = diffWords('head\n' + a + '\ntail', 'head\n' + b + '\ntail', { maxOps: 10 });
    expect(res.truncated).toBe(true);
    expect(res.ops.map((o) => o.op)).toEqual(['eq', 'del', 'ins', 'eq']);
    expect(side(res.ops, 'a')).toBe('head\n' + a + '\ntail');
    expect(side(res.ops, 'b')).toBe('head\n' + b + '\ntail');
  });

  it('a paragraph pair over 2,000 word edits is shown as replaced', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `x${i}`).join(' ');
    const b = Array.from({ length: 1500 }, (_, i) => `y${i}`).join(' ');
    const res = diffWords(a, b);
    expect(res.truncated).toBe(true);
    expect(res.ops).toEqual([{ op: 'del', text: a }, { op: 'ins', text: b }]);
  });

  it('offsetMap is monotonic, maps eq text exactly, and clamps', () => {
    const r = prng(7);
    for (let i = 0; i < 100; i++) {
      const a = randomText(r, 5);
      const b = mutate(r, a);
      const { ops } = diffWords(a, b);
      const map = offsetMap(ops);
      let prev = -1;
      for (let off = 0; off <= a.length; off++) {
        const m = map(off);
        expect(m).toBeGreaterThanOrEqual(prev);
        expect(m).toBeLessThanOrEqual(b.length);
        prev = m;
      }
      let o = 0, n = 0;
      for (const op of ops) {
        if (op.op === 'eq') { for (let k = 0; k < op.text.length; k++) expect(b[map(o + k)]).toBe(a[o + k]); }
        if (op.op !== 'ins') o += op.text.length;
        if (op.op !== 'del') n += op.text.length;
      }
      expect(map(a.length + 100)).toBe(b.length);
    }
  });
});
