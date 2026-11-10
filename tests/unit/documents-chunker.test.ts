import { describe, it, expect } from 'vitest';
import { chunkText, CHUNK_MAX_BYTES } from '../../src/documents/chunker.js';
import { FORMAT } from '../../src/documents/rows.js';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ALPHABET = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', '"quoted"', 'back\\slash', 'tab\there', 'ünï', '漢字', '😀', '\u0001'];
function doc(r: () => number, paras: number): string {
  const out: string[] = [];
  for (let p = 0; p < paras; p++) {
    if (r() < 0.2) { out.push(''); continue; }
    const n = 5 + Math.floor(r() * 60);
    out.push(Array.from({ length: n }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join(' '));
  }
  return out.join('\n');
}
const serialized = (s: string): number => Buffer.byteLength(JSON.stringify(s));

describe('chunkText', () => {
  it('default max is 90% of a blob', () => expect(CHUNK_MAX_BYTES).toBe(Math.floor(FORMAT.blobBytes * 0.9)));

  it('concatenation identity and size bound (property, 60 seeded documents)', () => {
    const r = prng(1);
    for (let i = 0; i < 60; i++) {
      let text = doc(r, Math.floor(r() * 1500));
      if (r() < 0.3) text += '\n' + 'x'.repeat(Math.floor(r() * 120_000)); // oversized paragraph, no whitespace
      if (r() < 0.3) text += '\n' + 'word '.repeat(Math.floor(r() * 30_000)); // oversized paragraph with spaces
      if (r() < 0.2) text += '\n' + '😀"'.repeat(Math.floor(r() * 20_000)); // escaped + astral
      const chunks = chunkText(text);
      expect(chunks.join('')).toBe(text);
      for (const c of chunks) {
        expect(c.length).toBeGreaterThan(0);
        expect(serialized(c)).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
      }
      expect(chunkText(text)).toEqual(chunks);
    }
  });

  it('small options and tiny inputs', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('one line')).toEqual(['one line']);
    const t = 'aaaa bbbb cccc dddd eeee ffff gggg';
    const c = chunkText(t, { minBytes: 1, maxBytes: 12 });
    expect(c.join('')).toBe(t);
    for (const x of c) expect(serialized(x)).toBeLessThanOrEqual(12);
    expect(c[0]).toBe('aaaa bbbb ');
  });

  it('never splits a surrogate pair when hard-splitting', () => {
    const t = '😀'.repeat(50);
    const c = chunkText(t, { minBytes: 1, maxBytes: 18 });
    expect(c.join('')).toBe(t);
    for (const x of c) expect(x).toMatch(/^(😀)+$/u);
  });

  it('an edit near the top changes only the first chunk(s) of a long document', () => {
    const r = prng(99);
    const text = doc(r, 3000);
    const before = chunkText(text);
    expect(before.length).toBeGreaterThan(8);
    const edited = 'An inserted opening line here.\n' + text.slice(0, 40) + ' EDIT ' + text.slice(40);
    const after = chunkText(edited);
    expect(after.join('')).toBe(edited);
    const beforeSet = new Set(before);
    const changed = after.filter((c) => !beforeSet.has(c)).length;
    expect(changed).toBeLessThanOrEqual(2);
    // The tails are identical.
    expect(after.slice(-(before.length - 2))).toEqual(before.slice(-(before.length - 2)));
  });

  it('average chunk lands in the intended range', () => {
    const r = prng(5);
    const text = doc(r, 6000);
    const chunks = chunkText(text);
    const avg = Buffer.byteLength(text) / chunks.length;
    expect(avg).toBeGreaterThan(6 * 1024);
    expect(avg).toBeLessThan(40 * 1024);
  });
});
