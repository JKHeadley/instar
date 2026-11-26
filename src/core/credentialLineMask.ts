/**
 * credentialLineMask — SEC-164 part 1 §3.1 and §3.2: mask live keys inside one JSON line WITHOUT
 * changing its length or its structure. Used by the transcript copy scrub (slice 1c) and the
 * session-record sweeper (slice 1d).
 *
 * - Every string literal is found with its raw byte offsets by a small tokenizer (so a literal that
 *   `JSON.parse` would hide behind a later duplicate key is still scanned).
 * - Each literal is decoded and scanned on its own; matches map back to raw bytes, so a match never
 *   crosses a literal or the JSON structure, and no key name is ever changed.
 * - A span of 20 bytes or more becomes `[credential removed]` padded with spaces; a shorter span
 *   becomes `*` per byte. Neither writes a backslash or a quote; an escape inside the span becomes
 *   plain characters.
 * - Integrity-bound values (a thinking block's text when it carries a signature, encrypted reasoning
 *   content, redacted thinking data) and media base64 are never changed; a match there is reported
 *   as unmeasured.
 * - The result is re-read: it must parse with the same structure and keys, or nothing changes and
 *   the line is reported as unscannable.
 */
import { findWallCredentialSpans, CREDENTIAL_REMOVED_MARKER, type OwnCredentialMatcher } from '../messaging/outbound-credential-guard.js';

export interface LineMaskResult {
  /** The masked line (same byte length), or the input when nothing changed. */
  line: Buffer;
  /** Spans masked (or that would be masked, in dry run). */
  masked: number;
  /** Kinds found, never values. */
  kinds: string[];
  /** Matches inside integrity-bound fields or media data, left unchanged. */
  unmeasured: number;
  /** True when the line could not be tokenized or the re-read failed; nothing was changed. */
  unscannable: boolean;
}

interface Literal { start: number; end: number; isKey: boolean }

const QUOTE = 0x22; const BACKSLASH = 0x5c; const COLON = 0x3a;

/** Every string literal in a JSON line, by raw byte range [start, end) including the quotes. */
function literals(buf: Buffer): Literal[] | null {
  const out: Literal[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== QUOTE) { i++; continue; }
    const start = i;
    i++;
    while (i < buf.length && buf[i] !== QUOTE) i += buf[i] === BACKSLASH ? 2 : 1;
    if (i >= buf.length) return null; // unterminated literal
    i++;
    let j = i;
    while (j < buf.length && (buf[j] === 0x20 || buf[j] === 0x09 || buf[j] === 0x0a || buf[j] === 0x0d)) j++;
    out.push({ start, end: i, isKey: buf[j] === COLON });
  }
  return out;
}

/**
 * Decode one literal's body (between the quotes) and record, for every UTF-16 unit of the decoded
 * string, the raw byte offset where its source starts. `map[decoded.length]` is the body's end.
 */
function decodeWithMap(buf: Buffer, bodyStart: number, bodyEnd: number): { text: string; map: number[] } | null {
  let text = '';
  const map: number[] = [];
  let i = bodyStart;
  while (i < bodyEnd) {
    const b = buf[i]!;
    if (b === BACKSLASH) {
      const c = buf[i + 1];
      const simple: Record<number, string> = { 0x22: '"', 0x5c: '\\', 0x2f: '/', 0x62: '\b', 0x66: '\f', 0x6e: '\n', 0x72: '\r', 0x74: '\t' };
      if (c !== undefined && simple[c] !== undefined) { map.push(i); text += simple[c]; i += 2; continue; }
      if (c === 0x75) {
        const hex = buf.subarray(i + 2, i + 6).toString('latin1');
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        map.push(i); text += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
      }
      return null;
    }
    // One UTF-8 character: its byte length from the lead byte.
    const len = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
    const ch = buf.subarray(i, i + len).toString('utf8');
    for (let k = 0; k < ch.length; k++) map.push(i); // a surrogate pair maps both units to the lead byte
    text += ch;
    i += len;
  }
  map.push(bodyEnd);
  return { text, map };
}

/** The same-length replacement for `len` raw bytes. Never a backslash or a quote. */
export function sameLengthMask(len: number): string {
  return len >= CREDENTIAL_REMOVED_MARKER.length
    ? CREDENTIAL_REMOVED_MARKER + ' '.repeat(len - CREDENTIAL_REMOVED_MARKER.length)
    : '*'.repeat(len);
}

const MEDIA_MAGIC: ReadonlyArray<string> = ['iVBORw0KGgo', '/9j/', 'R0lGOD', 'UklGR', 'JVBERi0', 'AAAA'];

/** Values that must never change: integrity-bound text and media base64, collected from the parse. */
function protectedValues(parsed: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.thinking === 'string' && typeof o.signature === 'string') { out.add(o.thinking); out.add(o.signature); }
    if (typeof o.encrypted_content === 'string') out.add(o.encrypted_content);
    if (o.type === 'redacted_thinking' && typeof o.data === 'string') out.add(o.data);
    if (typeof o.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(o.data) && MEDIA_MAGIC.some((m) => (o.data as string).startsWith(m))) out.add(o.data);
    for (const x of Object.values(o)) walk(x);
  };
  walk(parsed);
  return out;
}

/** The structure with every string value blanked: two lines with equal skeletons differ only in values. */
function skeleton(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(skeleton);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, skeleton(x)]));
  return typeof v === 'string' ? '' : v;
}

/**
 * Mask the live keys in one JSON line (without its trailing newline handling: a trailing `\n` is kept
 * as is). `apply: false` counts without changing anything (the dry run).
 */
export function maskJsonLine(line: Buffer, opts: { apply: boolean; ownCredentials?: OwnCredentialMatcher | null }): LineMaskResult {
  const none = (unscannable = false): LineMaskResult => ({ line, masked: 0, kinds: [], unmeasured: 0, unscannable });
  const hasNl = line.length > 0 && line[line.length - 1] === 0x0a;
  const body = hasNl ? line.subarray(0, line.length - 1) : line;
  // Cheap exit: no literal can hold a key if the raw line shows no candidate at all. The scan of the
  // raw line is a superset check only when it has no escapes; with escapes, scan every literal.
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return none(true); }
  const lits = literals(body);
  if (!lits) return none(true);
  let guard: Set<string>;
  try { guard = protectedValues(parsed); } catch { return none(true); } // a pathologically deep line is left alone, never thrown
  const edits: Array<{ start: number; end: number }> = [];
  const kinds = new Set<string>();
  let unmeasured = 0;
  for (const lit of lits) {
    if (lit.isKey) continue;
    const dec = decodeWithMap(body, lit.start + 1, lit.end - 1);
    if (!dec) return none(true);
    const spans = findWallCredentialSpans(dec.text, { ownCredentials: opts.ownCredentials ?? null });
    if (spans.length === 0) continue;
    if (guard.has(dec.text)) { unmeasured += spans.length; continue; }
    for (const s of spans) {
      kinds.add(s.kind);
      edits.push({ start: dec.map[s.start]!, end: s.end < dec.map.length ? dec.map[s.end]! : lit.end - 1 });
    }
  }
  if (edits.length === 0) return { line, masked: 0, kinds: [], unmeasured, unscannable: false };
  if (!opts.apply) return { line, masked: edits.length, kinds: [...kinds], unmeasured, unscannable: false };
  const out = Buffer.from(line);
  for (const e of edits) out.write(sameLengthMask(e.end - e.start), e.start, 'latin1');
  // Re-read: same structure and keys, or nothing is written.
  try {
    const re = JSON.parse(out.subarray(0, body.length).toString('utf8'));
    if (JSON.stringify(skeleton(re)) !== JSON.stringify(skeleton(parsed))) return none(true);
  } catch { return none(true); }
  return { line: out, masked: edits.length, kinds: [...kinds], unmeasured, unscannable: false };
}

/** Mask every complete line of a JSONL buffer. Lines that are not JSON pass through unchanged. */
export function maskJsonlBuffer(buf: Buffer, opts: { apply: boolean; ownCredentials?: OwnCredentialMatcher | null }): { buf: Buffer; masked: number; kinds: string[]; unmeasured: number; unscannable: number } {
  let start = 0; let masked = 0; let unmeasured = 0; let unscannable = 0;
  const kinds = new Set<string>();
  const parts: Buffer[] = [];
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue;
    const end = i < buf.length ? i + 1 : i;
    if (end > start) {
      const r = maskJsonLine(buf.subarray(start, end), opts);
      parts.push(r.line); masked += r.masked; unmeasured += r.unmeasured; if (r.unscannable) unscannable++;
      for (const k of r.kinds) kinds.add(k);
    }
    start = end;
  }
  const out = Buffer.concat(parts);
  return { buf: out, masked, kinds: [...kinds], unmeasured, unscannable };
}
