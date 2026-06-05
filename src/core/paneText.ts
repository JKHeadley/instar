/**
 * Pane-text helpers — blank-fill-immune tail extraction for tmux captures.
 *
 * tmux `capture-pane -S -N` returns the last N PHYSICAL rows of the pane. A
 * tall pane (e.g. the default 50-row Gemini window) pads below the last real
 * output with blank rows, so a small-N capture can be ENTIRELY blank while the
 * meaningful text (an idle prompt, a modal, a readiness marker) sits just
 * above the window. PR #818 fixed this class inside PromptGate; this module is
 * the shared primitive so every small-tail consumer reads MEANINGFUL rows
 * (task #77 — the 2026-06-05 cycle-2 differential finding).
 *
 * Semantics are identical to PromptGate's original local helper: trailing
 * blank rows are trimmed, INTERIOR blank lines are preserved (they carry
 * modal/layout structure), and an all-blank capture yields [''] — callers see
 * an empty-but-defined window, never a crash on an empty array.
 */

/** Trim trailing blank rows only; interior blanks are structure and stay. */
export function trimTrailingBlankRows(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return end === 0 ? [''] : lines.slice(0, end);
}

/**
 * The last `n` MEANINGFUL lines of `text` (post trailing-blank trim), joined.
 * An all-blank input returns '' — same falsy contract small-tail callers
 * already apply to a null/blank capture.
 */
export function meaningfulTail(text: string, n: number): string {
  const trimmed = trimTrailingBlankRows(text.split('\n'));
  return trimmed.slice(-n).join('\n');
}
