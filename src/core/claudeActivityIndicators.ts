/**
 * claudeActivityIndicators — the canonical "Claude Code is mid-turn right now"
 * footer hints.
 *
 * Claude Code renders these strings in the status footer ONLY while a turn is
 * in flight (model generating, tool running, extended-think computing). They
 * disappear the instant the turn lands and the session returns to its idle
 * prompt. That structural property is exactly what makes them a reliable
 * "actively working" tell: a session sitting idle at the prompt — or a session
 * that has WEDGED and fast-fails every turn — never shows them.
 *
 * Why this is its own module: more than one recovery surface needs to answer
 * "is this pane actively working?" before taking a disruptive action —
 *   • StuckInputSentinel / SessionManager.verifyInjection refuse to fire a
 *     recovery Enter into a working pane (the input is correctly queued and
 *     will submit when the turn ends).
 *   • CompactionSentinel refuses to RE-INJECT a recovery prompt into a working
 *     pane — re-injecting buries the user's real message under stacked
 *     recovery bootstraps (the false "session is restarting" loop).
 * Centralizing the list keeps those surfaces from drifting apart.
 *
 * IMPORTANT — footer hints ONLY. We deliberately do NOT include the Braille
 * spinner glyphs (⠋⠙⠹…) here: a frozen last frame of a dead pane can still
 * contain a spinner glyph, which would make a genuinely-stuck session read as
 * "working" and starve it of recovery. The footer hints are present only while
 * a turn is actually in flight, so they cannot double-fire against a dead pane.
 * (See frameworkActivitySignals.ts for the spinner-inclusive, framework-portable
 * signal used by the triage nurse, where the trade-off is different.)
 */
export const CLAUDE_WORKING_INDICATORS: readonly string[] = [
  'esc to interrupt',     // Claude Code's "task in progress" hint
  'ctrl+t to hide tasks', // Multi-task display
  'tokens · esc',         // Token-counting + interrupt hint
];

/**
 * Pure check: does this captured tmux pane show Claude Code actively working?
 * Footer-hint based — see CLAUDE_WORKING_INDICATORS for why that's the precise
 * signal. Returns false for empty/missing panes.
 */
export function paneShowsClaudeWorking(pane: string | null | undefined): boolean {
  if (!pane) return false;
  return CLAUDE_WORKING_INDICATORS.some(ind => pane.includes(ind));
}
