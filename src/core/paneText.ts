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

/**
 * Extract the last completed Gemini assistant block from a live TUI pane.
 *
 * Gemini renders final prose as a block beginning with `✦`, then returns to an
 * input/footer area (`Type your message`, model footer, etc.). This helper only
 * returns a block when that idle footer appears after the assistant block, so a
 * streaming/in-progress answer does not get relayed early.
 */
export function extractGeminiFinalAssistantBlock(text: string): string | null {
  if (!text) return null;
  const lines = trimTrailingBlankRows(text.split('\n'));
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*✦\s*/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const after = lines.slice(start + 1).join('\n');
  if (!/(Type your message|YOLO mode|no sandbox|\/model)/i.test(after)) return null;

  const out: string[] = [];
  const first = lines[start].replace(/^\s*✦\s*/, '').trimEnd();
  if (first.trim()) out.push(first);

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*[╭╰│]/.test(line)) break;
    if (/(Type your message|YOLO mode|no sandbox|\/model)/i.test(line)) break;
    if (/^\s*\d+\s+GEMINI\.md files\b/i.test(line)) break;
    if (/^\s*>/.test(line)) break;
    out.push(line);
  }

  const trimmed = trimTrailingBlankRows(out).join('\n').trim();
  if (!trimmed) return null;

  const bodyLines = trimmed.split('\n');
  const nonEmpty = bodyLines.filter((l) => l.trim());
  const indents = nonEmpty
    .map((l) => (/^(\s*)/.exec(l)?.[1].length ?? 0))
    .filter((n) => n > 0);
  const commonIndent = indents.length ? Math.min(...indents) : 0;
  return commonIndent > 0
    ? bodyLines.map((l) => l.trim() ? l.slice(Math.min(commonIndent, /^(\s*)/.exec(l)?.[1].length ?? 0)) : '').join('\n').trim()
    : trimmed;
}
