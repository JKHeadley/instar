/**
 * Keyword search over conversations — the pure parts (docs/specs/conversation-search.md §2).
 *
 * The route (`src/server/mobileConversationSearchRoutes.ts`) gathers candidate messages from three
 * places: the TopicMemory full-text index for Telegram topics, and bounded scans of the rows the
 * history reads serve for app conversations and Slack. Everything here is shared by all three, so
 * a hit means the same thing whichever channel it came from:
 *
 *   - `searchTerms` turns the typed text into words (letters, digits and combining marks);
 *   - `ftsMatchExpression` is the FTS5 query for those words (every word, each as a prefix);
 *   - `termMarks` finds the same words in a text (word-start prefix, case-insensitive), the way
 *     the store scans match;
 *   - `marksFromHighlight` reads the exact spans FTS5 matched (it stems, so "runs" can match
 *     "running" — the spans come from the index, never guessed);
 *   - `buildSnippet` cuts ~160 characters around the first match and re-bases the marks;
 *   - `hitScore` is the one ranking every hit gets, so hits from different sources compare.
 *
 * Every index is in UTF-16 code units (JavaScript string indices), as the wire contract says.
 */

/** A matched span in a string: UTF-16 code units. */
export interface TextMark { start: number; length: number }

export const MAX_QUERY_CHARS = 200;
export const MAX_TERMS = 8;
const MAX_TERM_CHARS = 64;
export const SNIPPET_CHARS = 160;
/** How far before the first match a snippet starts, when the text allows. */
const SNIPPET_LEAD = 50;

/** FTS5 highlight markers: private-use code points, never typed by a person in practice. */
export const HIGHLIGHT_OPEN = '\uE000';
export const HIGHLIGHT_CLOSE = '\uE001';

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * The words of a query, lowercased, unique, in typed order, at most MAX_TERMS (each cut to 64
 * characters). An empty list means the query had nothing searchable (only punctuation).
 */
export function searchTerms(q: string): string[] {
  const out: string[] = [];
  for (const m of q.normalize('NFC').matchAll(WORD_RE)) {
    const t = m[0].toLowerCase().slice(0, MAX_TERM_CHARS);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** The FTS5 MATCH expression: every term required, each a prefix. Terms are letters only, so quoting is safe. */
export function ftsMatchExpression(terms: ReadonlyArray<string>): string {
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Merge overlapping or touching marks; sorted by start. */
function mergeMarks(marks: TextMark[]): TextMark[] {
  const sorted = marks.filter((m) => m.length > 0).sort((a, b) => a.start - b.start || b.length - a.length);
  const out: TextMark[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start <= last.start + last.length) {
      last.length = Math.max(last.length, m.start + m.length - last.start);
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/**
 * Where the terms occur in a text: each occurrence of a term at the start of a word, extended to
 * the end of that word, case-insensitive. `all` is true only when every term occurred (the AND a
 * store scan requires, matching the FTS query).
 */
export function termMarks(text: string, terms: ReadonlyArray<string>): { marks: TextMark[]; all: boolean } {
  const marks: TextMark[] = [];
  let all = terms.length > 0;
  for (const t of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escapeRegex(t)}[\\p{L}\\p{N}\\p{M}]*`, 'giu');
    let found = false;
    for (const m of text.matchAll(re)) {
      if (m.index === undefined || m[0].length === 0) continue;
      marks.push({ start: m.index, length: m[0].length });
      found = true;
    }
    if (!found) all = false;
  }
  return { marks: mergeMarks(marks), all };
}

/**
 * The plain text and the matched spans of an FTS5 `highlight()` result made with
 * HIGHLIGHT_OPEN / HIGHLIGHT_CLOSE. Null when the markers are unbalanced.
 */
export function marksFromHighlight(highlighted: string): { text: string; marks: TextMark[] } | null {
  let text = '';
  const marks: TextMark[] = [];
  let open = -1;
  for (const ch of highlighted) {
    if (ch === HIGHLIGHT_OPEN) { if (open !== -1) return null; open = text.length; continue; }
    if (ch === HIGHLIGHT_CLOSE) { if (open === -1) return null; marks.push({ start: open, length: text.length - open }); open = -1; continue; }
    text += ch;
  }
  if (open !== -1) return null;
  return { text, marks: mergeMarks(marks) };
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isSpace = (ch: string | undefined) => ch !== undefined && /\s/u.test(ch);

/**
 * About SNIPPET_CHARS characters of `text` around the first mark (the start of the text when
 * there is none), line breaks shown as spaces, "…" where text was cut, and the marks that fall
 * inside, re-based to the snippet. Never splits a surrogate pair; the first mark is never cut.
 */
export function buildSnippet(text: string, marks: ReadonlyArray<TextMark>, width = SNIPPET_CHARS): { snippet: string; marks: TextMark[] } {
  const flat = text.replace(/[\r\n\t\v\f\u2028\u2029]/g, ' ');
  const len = flat.length;
  const first = marks[0];
  let start = first ? Math.max(0, first.start - SNIPPET_LEAD) : 0;
  let end = Math.min(len, start + width);
  if (end - start < width) start = Math.max(0, end - width);
  if (first && first.start + first.length > end) end = Math.min(len, first.start + first.length);
  // Start at a word boundary when one is near and it does not pass the first match.
  if (start > 0 && !isSpace(flat[start - 1])) {
    const limit = Math.min(first ? first.start : start + 15, start + 15);
    for (let i = start; i < limit; i++) if (isSpace(flat[i])) { start = i + 1; break; }
  }
  if (start > 0 && start < len && isLow(flat.charCodeAt(start))) start -= 1;
  if (end < len && end > 0 && isHigh(flat.charCodeAt(end - 1))) end += 1;
  let body = flat.slice(start, end);
  // Trim the spaces at both ends, keeping the mark offsets right.
  const lead = body.length - body.trimStart().length;
  body = body.trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = end < len ? '…' : '';
  const shift = prefix.length - start - lead;
  const out: TextMark[] = [];
  for (const m of marks) {
    const s = Math.max(m.start + shift, prefix.length);
    const e = Math.min(m.start + m.length + shift, prefix.length + body.length);
    if (e > s) out.push({ start: s, length: e - s });
  }
  return { snippet: prefix + body + suffix, marks: out };
}

/**
 * The one ranking every hit gets (BM25-shaped, no document frequencies): more marked words per
 * length ranks higher, saturating. Higher is better.
 */
export function hitScore(textLength: number, markCount: number): number {
  const tf = Math.max(1, markCount);
  const k1 = 1.2, b = 0.75, avg = 200;
  const norm = k1 * (1 - b + b * (Math.max(1, textLength) / avg));
  return Math.round((tf * (k1 + 1)) / (tf + norm) * 1e6) / 1e6;
}
