import { describe, it, expect } from 'vitest';
import { makeQuote, verifyQuote, reanchor, utf8Bytes, fuzzyLocate, type Anchor } from '../../src/documents/anchor.js';
import { diffWords } from '../../src/documents/diff.js';
import { FORMAT } from '../../src/documents/rows.js';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const anchorOf = (text: string, needle: string, from = 0): Anchor => {
  const start = text.indexOf(needle, from);
  if (start < 0) throw new Error('needle missing');
  return { quote: makeQuote(text, start, start + needle.length), start, end: start + needle.length };
};

const DOC = 'Intro paragraph about the plan.\nThe budget is tight this quarter and we must cut travel.\nWe will review hiring in March.\nClosing remarks and thanks.';

describe('makeQuote / verifyQuote', () => {
  it('cuts exact, prefix and suffix from the projection', () => {
    const q = makeQuote(DOC, 32, 42);
    expect(q).toEqual({ long: false, exact: 'The budget', prefix: DOC.slice(0, 32).slice(-FORMAT.contextChars), suffix: DOC.slice(42, 42 + FORMAT.contextChars) });
  });

  it('verifies, corrects a wrong position, and refuses a quote not in the document', () => {
    const q = makeQuote(DOC, 32, 42);
    expect(verifyQuote(DOC, q, 32, 42)).toEqual({ start: 32, end: 42 });
    expect(verifyQuote(DOC, q, 0, 10)).toEqual({ start: 32, end: 42 });
    expect(verifyQuote(DOC, { long: false, exact: 'never said', prefix: '', suffix: '' }, 0, 10)).toBeNull();
  });

  it('long selections store head + tail of 1 KiB each and still verify', () => {
    const text = 'start ' + 'é'.repeat(3000) + ' middle ' + 'ü'.repeat(3000) + ' end';
    const q = makeQuote(text, 6, text.length - 4);
    expect(q.long).toBe(true);
    if (!q.long) return;
    expect(utf8Bytes(q.exact)).toBeLessThanOrEqual(FORMAT.quoteBytes / 2);
    expect(utf8Bytes(q.exactTail)).toBeLessThanOrEqual(FORMAT.quoteBytes / 2);
    expect(q.exact.startsWith('ééé')).toBe(true);
    expect(q.exactTail.endsWith('üüü')).toBe(true);
    expect(q.length).toBe(text.length - 10);
    expect(verifyQuote(text, q, 6, text.length - 4)).toEqual({ start: 6, end: text.length - 4 });
    expect(verifyQuote('xx' + text, q, 6, text.length - 4)).toEqual({ start: 8, end: text.length - 2 });
    // An edit in the middle keeps head and tail findable: re-anchors as edited.
    const edited = text.replace(' middle ', ' a new middle part ');
    const r = reanchor(text, edited, { quote: q, start: 6, end: text.length - 4 });
    expect(r.state).toBe('edited');
    expect(r.start).toBe(6);
    expect(r.end).toBe(edited.length - 4);
  });
});

describe('reanchor', () => {
  it('exact and unique → ok at the new position', () => {
    const a = anchorOf(DOC, 'review hiring');
    const next = 'New first line.\n' + DOC;
    expect(reanchor(DOC, next, a)).toEqual({ state: 'ok', start: a.start + 16, end: a.end + 16 });
  });

  it('ambiguous occurrences are resolved by context', () => {
    const A = 'The alpha team, reporting from the north office, asks you to note this, kindly.\n';
    const B = 'Our beta group in the harbour warehouse would also have you note this before Friday.\n';
    const C = 'Finally gamma, who rarely writes, wants everyone to note this as well.\n';
    const old = A + B + C;
    const a = anchorOf(old, 'note this', old.indexOf('beta'));
    const next = C + A + B;
    const r = reanchor(old, next, a);
    expect(r.state).toBe('ok');
    expect(r.start).toBe(next.indexOf('note this', next.indexOf('beta')));
  });

  it('a word edit inside the passage → edited', () => {
    const a = anchorOf(DOC, 'The budget is tight this quarter and we must cut travel.');
    const next = DOC.replace('must cut travel', 'should cut travel');
    const r = reanchor(DOC, next, a, diffWords(DOC, next).ops);
    expect(r.state).toBe('edited');
    expect(r.exact).toBe('The budget is tight this quarter and we should cut travel.');
    expect(next.slice(r.start!, r.end!)).toBe(r.exact);
  });

  it('a deleted passage → orphaned', () => {
    const a = anchorOf(DOC, 'The budget is tight this quarter and we must cut travel.');
    const next = DOC.replace('The budget is tight this quarter and we must cut travel.\n', '');
    expect(reanchor(DOC, next, a)).toEqual({ state: 'orphaned' });
  });

  it('short quotes under 20 chars that change are orphaned, not fuzzed', () => {
    const a = anchorOf(DOC, 'in March');
    expect(reanchor(DOC, DOC.replace('in March', 'in April'), a).state).toBe('orphaned');
  });

  it('fuzzyLocate finds a lightly edited passage', () => {
    const f = fuzzyLocate('xxxxx the quick brown fax jumped over yyyy', 'the quick brown fox jumped over', 3)!;
    expect(f.similarity).toBeGreaterThan(0.9);
    expect(f.start).toBe(6);
  });

  it('random edits never throw and always return a valid state (property, 300 seeded)', () => {
    const r = prng(2026);
    const words = ['plan', 'budget', 'the', 'and', 'travel', 'hiring', 'March', '.', '\n', 'é', '😀'];
    for (let i = 0; i < 300; i++) {
      const old = Array.from({ length: 20 + Math.floor(r() * 200) }, () => words[Math.floor(r() * words.length)]).join(' ');
      const s = Math.floor(r() * old.length);
      const e = Math.min(old.length, s + 1 + Math.floor(r() * 80));
      const anchor: Anchor = { quote: makeQuote(old, s, e), start: s, end: e };
      let next = old;
      for (let k = Math.floor(r() * 5); k > 0; k--) {
        const at = Math.floor(r() * (next.length + 1));
        next = r() < 0.5 ? next.slice(0, at) + words[Math.floor(r() * words.length)] + next.slice(at) : next.slice(0, at) + next.slice(at + Math.floor(r() * 30));
      }
      const useOps = r() < 0.5;
      const res = reanchor(old, next, anchor, useOps ? diffWords(old, next).ops : undefined);
      expect(['ok', 'edited', 'orphaned']).toContain(res.state);
      if (res.state !== 'orphaned') {
        expect(res.start!).toBeGreaterThanOrEqual(0);
        expect(res.end!).toBeLessThanOrEqual(next.length);
        expect(res.start!).toBeLessThanOrEqual(res.end!);
      }
      if (res.state === 'ok' && !anchor.quote.long) expect(next.slice(res.start!, res.end!)).toBe(anchor.quote.exact);
      // Deterministic.
      expect(reanchor(old, next, anchor, useOps ? diffWords(old, next).ops : undefined)).toEqual(res);
    }
  });

  it('never throws on garbage input', () => {
    expect(reanchor('', '', { quote: { long: false, exact: '', prefix: '', suffix: '' }, start: 5, end: 1 }).state).toBe('orphaned');
    expect(reanchor('abc', 'abc', { quote: null as never, start: 0, end: 1 }).state).toBe('orphaned');
  });
});
