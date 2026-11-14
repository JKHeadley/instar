/**
 * The oversized-row rule shared by the signed pool reads (native-conversation-any-machine-access §3d
 * item 6). A page is built newest first and stops before the row that would pass the byte cap. When
 * the newest remaining row is alone larger than the cap, that one row is returned cut at the cap on a
 * UTF-8 boundary, with a marker saying how far it reaches; the rest is read by range. The row is
 * redacted BEFORE it is cut, and every count is in the redacted row, so a secret cannot leave in two
 * pieces.
 */

/** Room kept for the answer's other fields when a single row fills a page. */
export const ROW_ENVELOPE_BYTES = 8 * 1024;

export interface Utf8Piece {
  piece: string;
  /** Byte range of the piece within the (redacted) row text: [from, to). */
  from: number;
  to: number;
  totalBytes: number;
}

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

/**
 * The piece of `text` that starts at byte `from` and whose JSON encoding fits in `maxJsonBytes`.
 * Null when `from` is out of range or not on a character boundary (a continuation that does not
 * line up with a range this rule returned). A piece always holds at least one character, so a
 * caller reading on always moves forward.
 */
export function cutUtf8(text: string, from: number, maxJsonBytes: number): Utf8Piece | null {
  const buf = Buffer.from(text, 'utf8');
  const total = buf.length;
  if (!Number.isSafeInteger(from) || from < 0 || from > total || (from === total && total !== 0)) return null;
  if (from < total && (buf[from] & 0xc0) === 0x80) return null;
  if (total === 0) return { piece: '', from: 0, to: 0, totalBytes: 0 };
  let budget = Math.max(4, maxJsonBytes);
  for (;;) {
    let end = Math.min(total, from + budget);
    while (end < total && end > from && (buf[end] & 0xc0) === 0x80) end--;
    if (end === from) {
      // Not even one character fits the budget: take exactly one, so the reader still advances.
      end = from + 1;
      while (end < total && (buf[end] & 0xc0) === 0x80) end++;
      return { piece: buf.subarray(from, end).toString('utf8'), from, to: end, totalBytes: total };
    }
    const piece = buf.subarray(from, end).toString('utf8');
    const size = jsonBytes(piece);
    if (size <= maxJsonBytes || end - from <= 1) return { piece, from, to: end, totalBytes: total };
    // JSON escaping grew it past the budget: shrink in proportion and try again.
    budget = Math.max(1, Math.floor((end - from) * (maxJsonBytes / size)) - 1);
  }
}

/**
 * The newest rows (the END of an oldest-first list) whose JSON fits within `maxBytes` together with
 * `baseBytes` of answer fields. `kept` is a suffix of `rows`.
 */
export function newestWithinCap<T>(rows: readonly T[], maxBytes: number, baseBytes: number): { kept: T[]; dropped: number } {
  let used = baseBytes;
  let i = rows.length;
  while (i > 0) {
    const add = jsonBytes(rows[i - 1]) + 1;
    if (used + add > maxBytes) break;
    used += add;
    i--;
  }
  return { kept: rows.slice(i), dropped: i };
}
