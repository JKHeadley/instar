/**
 * paneTail — ONE definition of "the live tail" of a tmux pane capture, shared by
 * every pane-signal consumer (StuckSignatureClassifier, IdleErrorClassifier, …).
 *
 * Extracted (CMT-1785) so the tail-gating + line-lead-stripping logic is not COPIED
 * per consumer (the copies were already drifting: tailLines 12 / 20 / 8). A single
 * definition is the only way "what counts as the live tail" stays consistent.
 *
 * Pure, dependency-free, allocation-cheap. No tmux, no I/O — it operates on an
 * already-captured string.
 */

/**
 * Claude Code line-lead glyphs (the bullet / tree-branch / box-drawing characters
 * the TUI prints at the start of a rendered line) plus the box-drawing range.
 * These are CONTENT (Unicode), not ANSI escapes — tmux `capture-pane -p` preserves
 * them. The set is the static contract pinned by IdleErrorClassifier's fixture tests.
 */
const LEAD_GLYPH_CLASS =
  '\\u23FA\\u23BF\\u273B\\u25CF\\u2502\\u00B7\\u276F\\u203A\\u2570\\u256D\\u2717\\u2500-\\u257F';

/** A leading ANSI SGR colour run (absent under `-p`, stripped defensively in case a
 *  future caller captures with `-e`). */
const ANSI_SGR = '\\x1b\\[[0-9;]*m';

/** Matches the leading run of (ANSI SGR | whitespace | lead-glyph), in any interleaving. */
const LEAD_RE = new RegExp(`^(?:${ANSI_SGR}|[\\s${LEAD_GLYPH_CLASS}])+`);

/** True iff the (single) char is one of the known lead glyphs. */
const GLYPH_RE = new RegExp(`[${LEAD_GLYPH_CLASS}]`);

/**
 * The last `tailLines` NON-EMPTY (non-whitespace-after-trim) lines of a capture,
 * AS LINES (trimmed). The "live tail" — the region right above the prompt. Callers
 * that need a joined string do `.join('\n')`.
 */
export function liveTail(text: string, tailLines: number): string[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return tailLines >= 0 ? lines.slice(-tailLines) : lines;
}

/**
 * Strip a leading run of ANSI SGR escapes + Claude Code lead glyphs + whitespace
 * (any interleaving) so the first *content* token of the line is exposed. Idempotent.
 */
export function stripLineLead(line: string): string {
  const m = LEAD_RE.exec(line);
  return m ? line.slice(m[0].length) : line;
}

/**
 * True iff the line's stripped lead contained at least one known Claude lead glyph —
 * i.e. the line was rendered as a Claude TUI line-lead (the discriminator that
 * separates a Claude-emitted frame from raw column-0 content / prose).
 */
export function wasGlyphLed(line: string): boolean {
  const m = LEAD_RE.exec(line);
  return m ? GLYPH_RE.test(m[0]) : false;
}
