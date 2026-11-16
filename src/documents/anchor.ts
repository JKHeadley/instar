/**
 * Instar Documents — anchoring comments on the plain-text projection
 * (spec docs/specs/instar-document-viewer.md §3.5). W3C TextQuoteSelector + TextPositionSelector.
 *
 * Everything here is deterministic (no randomness, no clock) and pure, so every machine places
 * a comment identically. `reanchor` never throws.
 */
import { FORMAT } from './rows.js';
import { diffWords, offsetMap, type DiffOp } from './diff.js';

/** A selection that fits in FORMAT.quoteBytes: the full selected text. */
export interface ShortQuote { long: false; exact: string; prefix: string; suffix: string }
/**
 * A selection longer than FORMAT.quoteBytes: its first and last half (by UTF-8 bytes) and its
 * length in UTF-16 code units (the projection's offset unit).
 */
export interface LongQuote { long: true; exact: string; exactTail: string; length: number; prefix: string; suffix: string }
export type Quote = ShortQuote | LongQuote;

export interface Anchor { quote: Quote; start: number; end: number }
export type AnchorState = 'ok' | 'edited' | 'orphaned';
export interface ReanchorResult { state: AnchorState; start?: number; end?: number; exact?: string }

/** Proximity's weight in the exact-match score, and the distance at which it reaches zero. */
const PROXIMITY_MAX = FORMAT.contextChars;
const PROXIMITY_RANGE = 2000;
/** Fuzzy search: ±window around the mapped position, Bitap chunk size, acceptance. */
const FUZZY_WINDOW = 2000;
const FUZZY_MIN_CHARS = 20;
const BITAP_CHUNK = 32;
const FUZZY_ACCEPT = 0.75;
/** Upper bound on occurrences examined (bounds the work on pathological repeats). */
const MAX_OCCURRENCES = 10_000;

const utf8Len = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) n += utf8Len(ch.codePointAt(0)!);
  return n;
}

/** Longest prefix of s within maxBytes UTF-8 bytes, never splitting a code point. */
function headBytes(s: string, maxBytes: number): string {
  let n = 0, i = 0;
  for (const ch of s) {
    const b = utf8Len(ch.codePointAt(0)!);
    if (n + b > maxBytes) break;
    n += b; i += ch.length;
  }
  return s.slice(0, i);
}
function tailBytes(s: string, maxBytes: number): string {
  const chars = Array.from(s);
  let n = 0, i = s.length;
  for (let k = chars.length - 1; k >= 0; k--) {
    const b = utf8Len(chars[k].codePointAt(0)!);
    if (n + b > maxBytes) break;
    n += b; i -= chars[k].length;
  }
  return s.slice(i);
}
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

function cutPrefix(text: string, start: number): string {
  let s = Math.max(0, start - FORMAT.contextChars);
  if (s > 0 && isLow(text.charCodeAt(s))) s++;
  return text.slice(s, start);
}
function cutSuffix(text: string, end: number): string {
  let e = Math.min(text.length, end + FORMAT.contextChars);
  if (e < text.length && isHigh(text.charCodeAt(e - 1))) e--;
  return text.slice(end, e);
}

export function makeQuote(text: string, start: number, end: number): Quote {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const exact = text.slice(s, e);
  const prefix = cutPrefix(text, s), suffix = cutSuffix(text, e);
  if (utf8Bytes(exact) <= FORMAT.quoteBytes) return { long: false, exact, prefix, suffix };
  const half = FORMAT.quoteBytes / 2;
  return { long: true, exact: headBytes(exact, half), exactTail: tailBytes(exact, half), length: exact.length, prefix, suffix };
}

function matchesAt(text: string, q: Quote, start: number): number | null {
  if (!q.long) return q.exact && text.startsWith(q.exact, start) ? start + q.exact.length : null;
  const end = start + q.length;
  return end <= text.length && text.startsWith(q.exact, start) && text.startsWith(q.exactTail, end - q.exactTail.length) ? end : null;
}

function occurrences(text: string, q: Quote): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (!q.exact) return out;
  let i = text.indexOf(q.exact);
  while (i !== -1 && out.length < MAX_OCCURRENCES) {
    const e = matchesAt(text, q, i);
    if (e !== null) out.push({ start: i, end: e });
    i = text.indexOf(q.exact, i + 1);
  }
  return out;
}

/** Prefix agreement (longest common suffix) + suffix agreement (longest common prefix). */
function contextScore(text: string, q: Quote, start: number, end: number): number {
  let p = 0;
  while (p < q.prefix.length && start - 1 - p >= 0 && text.charCodeAt(start - 1 - p) === q.prefix.charCodeAt(q.prefix.length - 1 - p)) p++;
  let s = 0;
  while (s < q.suffix.length && end + s < text.length && text.charCodeAt(end + s) === q.suffix.charCodeAt(s)) s++;
  return p + s;
}

/**
 * Server-side write check: the quote must occur in the projection. Returns the given position if
 * it matches there, else the best occurrence (context agreement, then nearest), else null
 * (the caller refuses 422 quote-not-in-document).
 */
export function verifyQuote(text: string, quote: Quote, start: number, end: number): { start: number; end: number } | null {
  const at = matchesAt(text, quote, start);
  if (at !== null && at === end) return { start, end };
  let best: { start: number; end: number; score: number; dist: number } | null = null;
  for (const o of occurrences(text, quote)) {
    const score = contextScore(text, quote, o.start, o.end);
    const dist = Math.abs(o.start - start);
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { ...o, score, dist };
  }
  return best ? { start: best.start, end: best.end } : null;
}

// ── Fuzzy search ─────────────────────────────────────────────────────────────

/**
 * Bitap (shift-and, Wu–Manber errors) for a pattern of ≤ 32 code units over text[ws, we).
 * Returns the end index (inclusive) with the fewest errors (≤ k), ties nearest `expectedEnd`.
 */
function bitapBest(text: string, ws: number, we: number, pattern: string, k: number, expectedEnd: number): { end: number; errors: number } | null {
  const L = pattern.length;
  if (L === 0 || L > BITAP_CHUNK) return null;
  const masks = new Map<number, number>();
  for (let i = 0; i < L; i++) { const c = pattern.charCodeAt(i); masks.set(c, ((masks.get(c) ?? 0) | (1 << i)) >>> 0); }
  const hit = (1 << (L - 1)) >>> 0;
  let R = new Uint32Array(k + 1);
  let N = new Uint32Array(k + 1);
  for (let d = 0; d <= k; d++) R[d] = d >= 32 ? 0xffffffff : ((1 << d) - 1) >>> 0;
  let best: { end: number; errors: number } | null = null;
  for (let j = ws; j < we; j++) {
    const B = masks.get(text.charCodeAt(j)) ?? 0;
    N[0] = (((R[0] << 1) | 1) & B) >>> 0;
    for (let d = 1; d <= k; d++) {
      N[d] = ((((R[d] << 1) | 1) & B) | ((R[d - 1] << 1) | 1) | ((N[d - 1] << 1) | 1) | R[d - 1]) >>> 0;
    }
    for (let d = 0; d <= k; d++) {
      if (N[d] & hit) {
        if (!best || d < best.errors || (d === best.errors && Math.abs(j - expectedEnd) < Math.abs(best.end - expectedEnd))) best = { end: j, errors: d };
        break;
      }
    }
    const t = R; R = N; N = t;
  }
  return best;
}

/** Semi-global edit distance: best end (exclusive) of pattern in text[rs, re), ties nearest `expectedEnd`. */
function sellersEnd(text: string, rs: number, re: number, pattern: string, reversed: boolean, expected: number): { pos: number; dist: number } {
  const m = pattern.length;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  // Position before consuming any text.
  let best = { pos: reversed ? re : rs, dist: m };
  const n = re - rs;
  for (let step = 0; step < n; step++) {
    const c = reversed ? text.charCodeAt(re - 1 - step) : text.charCodeAt(rs + step);
    cur[0] = 0;
    for (let i = 1; i <= m; i++) {
      const pc = reversed ? pattern.charCodeAt(m - i) : pattern.charCodeAt(i - 1);
      const sub = prev[i - 1] + (pc === c ? 0 : 1);
      const del = prev[i] + 1, ins = cur[i - 1] + 1;
      cur[i] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    const pos = reversed ? re - 1 - step : rs + step + 1;
    if (cur[m] < best.dist || (cur[m] === best.dist && Math.abs(pos - expected) < Math.abs(best.pos - expected))) best = { pos, dist: cur[m] };
    const t = prev; prev = cur; cur = t;
  }
  return best;
}

/** Locate `pattern` approximately near `expectedStart` in text; null when nothing is close. */
export function fuzzyLocate(text: string, pattern: string, expectedStart: number): { start: number; end: number; similarity: number } | null {
  const m = pattern.length;
  if (m === 0) return null;
  const ws = Math.max(0, expectedStart - FUZZY_WINDOW);
  const we = Math.min(text.length, expectedStart + m + FUZZY_WINDOW);
  if (we <= ws) return null;
  const implied: number[] = [];
  for (let o = 0; o < m; o += BITAP_CHUNK) {
    const chunk = pattern.slice(o, o + BITAP_CHUNK);
    if (chunk.length < 8 && o > 0) break;
    const k = Math.floor(chunk.length * (1 - FUZZY_ACCEPT));
    const hit = bitapBest(text, ws, we, chunk, k, expectedStart + o + chunk.length - 1);
    if (hit) implied.push(hit.end - chunk.length + 1 - o);
  }
  if (!implied.length) return null;
  implied.sort((x, y) => x - y);
  const center = implied[(implied.length - 1) >> 1];
  const slack = Math.ceil(m / 4) + BITAP_CHUNK;
  const rs = Math.max(0, center - slack), re = Math.min(text.length, center + m + slack);
  if (re <= rs) return null;
  const fwd = sellersEnd(text, rs, re, pattern, false, center + m);
  const back = sellersEnd(text, rs, fwd.pos, pattern, true, center);
  const dist = Math.min(fwd.dist, back.dist);
  return { start: back.pos, end: fwd.pos, similarity: 1 - dist / m };
}

// ── Re-anchoring ─────────────────────────────────────────────────────────────

function reanchorUnsafe(oldText: string, newText: string, anchor: Anchor, diffOps?: readonly DiffOp[]): ReanchorResult {
  const q = anchor.quote;
  if (!q.exact) return { state: 'orphaned' };
  const map = offsetMap(diffOps ?? diffWords(oldText, newText).ops);
  const mapped = map(anchor.start);

  // 1. Exact with context.
  const occ = occurrences(newText, q);
  if (occ.length) {
    const maxScore = q.prefix.length + q.suffix.length + PROXIMITY_MAX;
    const scored = occ.map((o) => ({
      ...o,
      score: contextScore(newText, q, o.start, o.end) + PROXIMITY_MAX * Math.max(0, 1 - Math.abs(o.start - mapped) / PROXIMITY_RANGE),
    }));
    scored.sort((x, y) => y.score - x.score || x.start - y.start);
    if (scored.length === 1 || scored[0].score - scored[1].score >= 0.25 * maxScore) {
      return { state: 'ok', start: scored[0].start, end: scored[0].end };
    }
  }

  // 2. Fuzzy, near the mapped position.
  if (!q.long) {
    if (q.exact.length >= FUZZY_MIN_CHARS) {
      const f = fuzzyLocate(newText, q.exact, mapped);
      if (f && f.similarity >= FUZZY_ACCEPT && f.end > f.start) {
        const exact = newText.slice(f.start, f.end);
        return { state: exact === q.exact ? 'ok' : 'edited', start: f.start, end: f.end, exact };
      }
    }
    return { state: 'orphaned' };
  }
  const h = fuzzyLocate(newText, q.exact, mapped);
  const mappedTail = Math.max(0, map(anchor.end) - q.exactTail.length);
  const t = fuzzyLocate(newText, q.exactTail, mappedTail);
  if (h && t && h.similarity >= FUZZY_ACCEPT && t.similarity >= FUZZY_ACCEPT && t.end > h.start && t.start >= h.start) {
    return { state: 'edited', start: h.start, end: t.end, exact: newText.slice(h.start, t.end) };
  }
  return { state: 'orphaned' };
}

/** Place an anchor from oldText on newText. Deterministic; never throws. */
export function reanchor(oldText: string, newText: string, anchor: Anchor, diffOps?: readonly DiffOp[]): ReanchorResult {
  try {
    return reanchorUnsafe(oldText, newText, anchor, diffOps);
  } catch {
    return { state: 'orphaned' };
  }
}
