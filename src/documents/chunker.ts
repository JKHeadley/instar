/**
 * Instar Documents — content-defined chunking of a version's text into `version-chunk` blobs
 * (spec docs/specs/instar-document-viewer.md §5.3).
 *
 * Units are paragraphs = "\n"-terminated lines (the same unit the compare diff uses). A chunk
 * ends after a non-blank paragraph whose FNV-1a hash has (hash & BOUNDARY_MASK) === 0, once the
 * chunk has reached minBytes; or before a paragraph that would push it past maxBytes. A paragraph
 * larger than maxBytes is cut at the last whitespace under maxBytes (else at a code-point
 * boundary). Sizes are measured on the serialized form, Buffer.byteLength(JSON.stringify(chunk)),
 * computed additively per character (JSON escaping is per character).
 *
 * Boundaries depend only on each paragraph's own text and the running size since the previous
 * boundary, so an edit re-cuts only the chunks up to the next boundary that both versions share.
 * Deterministic; concatenating the chunks returns the input exactly.
 */
import { FORMAT } from './rows.js';

/**
 * 1-in-64 non-blank paragraphs is a boundary candidate. With ~200-byte prose lines this gives
 * an average chunk of about minBytes + 64 × 200 B ≈ 16-17 KiB.
 */
export const BOUNDARY_MASK = 0x3f;
export const CHUNK_MIN_BYTES = 4096;
export const CHUNK_MAX_BYTES = Math.floor(FORMAT.blobBytes * 0.9);

/** Serialized bytes of one code point inside a JSON string (what JSON.stringify emits, UTF-8). */
function jsonCharBytes(cp: number, lone: boolean): number {
  if (lone) return 6; // lone surrogate → \udXXX
  if (cp === 0x22 || cp === 0x5c) return 2;
  if (cp < 0x20) return cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d ? 2 : 6;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Iterate code points with their UTF-16 length and serialized size. */
function forEachChar(s: string, fn: (i: number, len: number, bytes: number, isSpace: boolean) => boolean | void): void {
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    let len = 1, cp = c, lone = false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { len = 2; cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); } else lone = true;
    } else if (c >= 0xdc00 && c <= 0xdfff) lone = true;
    if (fn(i, len, jsonCharBytes(cp, lone), c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) === false) return;
    i += len;
  }
}

/** Serialized size without the two quotes. */
export function jsonInnerBytes(s: string): number {
  let n = 0;
  forEachChar(s, (_i, _l, b) => { n += b; });
  return n;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Split an oversized paragraph into pieces each ≤ maxInner serialized bytes. */
function splitLarge(p: string, maxInner: number): string[] {
  const out: string[] = [];
  let rest = p;
  while (jsonInnerBytes(rest) > maxInner) {
    let bytes = 0, cut = 0, lastSpaceEnd = 0;
    forEachChar(rest, (i, len, b, sp) => {
      if (bytes + b > maxInner) return false;
      bytes += b; cut = i + len;
      if (sp) lastSpaceEnd = cut;
    });
    const at = lastSpaceEnd > 0 ? lastSpaceEnd : Math.max(cut, 1);
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) out.push(rest);
  return out;
}

export function chunkText(text: string, opts: { minBytes?: number; maxBytes?: number } = {}): string[] {
  const minBytes = opts.minBytes ?? CHUNK_MIN_BYTES;
  const maxBytes = opts.maxBytes ?? CHUNK_MAX_BYTES;
  const maxInner = maxBytes - 2;
  if (maxInner < 6) throw new Error('chunkText: maxBytes too small');
  const paragraphs = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: string[] = [];
  let cur = '', curInner = 0;
  const flush = (): void => { if (cur) { chunks.push(cur); cur = ''; curInner = 0; } };
  for (const para of paragraphs) {
    const units = jsonInnerBytes(para) > maxInner ? splitLarge(para, maxInner) : [para];
    for (const u of units) {
      const b = jsonInnerBytes(u);
      if (cur && curInner + b > maxInner) flush();
      cur += u; curInner += b;
      if (curInner + 2 >= minBytes && u.trim() !== '' && (fnv1a(u) & BOUNDARY_MASK) === 0) flush();
    }
  }
  flush();
  return chunks;
}
