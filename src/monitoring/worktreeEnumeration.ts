/**
 * Shared enumeration contract for the worktree guards.
 *
 * Lives in its own module deliberately. Both `AgentWorktreeReaper` and
 * `OrphanedWorkSentinel` need this type and helper, and having the sentinel import
 * its diagnostics from the *reaper* would couple two independent guards through an
 * accident of which one was written first. Neither owns the contract; the contract
 * owns itself.
 *
 * The rule it encodes: **a guard must be able to say "I could not look", distinctly
 * from "I looked and found nothing".** Spec: docs/specs/guard-enumeration-fail-visible.md
 */

/**
 * The three-state result of enumerating worktrees: success (with the list, which may
 * legitimately be empty) or failure (with a bounded diagnostic).
 *
 * This exists so the failure state cannot be reached by accident. A bare array forces
 * the two "nothing here" meanings — *I looked and found none* and *I could not look* —
 * into the same value, and every consumer downstream inherits that ambiguity. Making
 * `ok` a required narrowing step means a caller that ignores failure does not compile,
 * rather than silently reporting a reassuring zero.
 *
 * Generic over the info type so the reaper and the orphaned-work sentinel (whose
 * `OrphanedWorktreeInfo` is structurally identical but nominally separate) share one
 * contract instead of drifting into two.
 */
export type WorktreeEnumeration<T> =
  | { ok: true; worktrees: T[] }
  | { ok: false; error: string };

export interface WorktreeEnumerationFailureHistory {
  enumerationFailures: number;
  lastEnumerationFailureAt: number | null;
}

/**
 * Bound persistence port used by one guard. Production binds both guards to a
 * shared ledger; tests may omit it when durable history is irrelevant.
 */
export interface WorktreeEnumerationFailureHistoryPort {
  load(): WorktreeEnumerationFailureHistory;
  recordFailure(at: number): WorktreeEnumerationFailureHistory;
}

/**
 * Upper bound on the diagnostic string. It is served over HTTP and written to the
 * server log, so an unbounded upstream git error must not become an unbounded field.
 */
export const MAX_ENUMERATION_ERROR_CHARS = 300;

/**
 * Bounded, single-line, control-character-free diagnostic for an enumeration failure.
 *
 * `Error.message` only — NEVER a stack. Control characters are stripped BEFORE the
 * whitespace collapse, because a `\s+` collapse leaves `ESC` intact and git/path output
 * can carry ANSI escape sequences that a terminal reading the log would interpret.
 * Sanitizing at the source is cheaper than trusting every downstream renderer.
 *
 * Operator-facing diagnostics, not user-facing copy — see the spec's trust-boundary
 * section.
 */
export function summarizeEnumerationError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const printable = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  const oneLine = printable.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_ENUMERATION_ERROR_CHARS
    ? `${oneLine.slice(0, MAX_ENUMERATION_ERROR_CHARS - 1)}…`
    : oneLine;
}
