/**
 * Silent catches around guarded deletes stay, but a guard refusal is no longer swallowed:
 * it is recorded as a `guard-refused` degradation (docs/specs/guard-runtime-state-scope.md §3).
 * Any other cleanup failure is recorded as `cleanup-failed`. An ENOENT counts as clean and
 * records nothing.
 *
 * Kept out of SafeFsExecutor on purpose: DegradationReporter imports SafeFsExecutor, so the
 * callers import this module instead.
 */

import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { SourceTreeGuardError } from './SourceTreeGuard.js';
import { WorktreeTrashScopeError } from './SafeFsExecutor.js';

export type CleanupFailureKind = 'guard-refused' | 'cleanup-failed';

export function isGuardRefusal(err: unknown): boolean {
  return err instanceof SourceTreeGuardError || err instanceof WorktreeTrashScopeError;
}

/**
 * Record a failed guarded delete. Returns what was recorded, or null for ENOENT (clean).
 * Never throws.
 */
export function reportGuardedDeleteFailure(err: unknown, ctx: { operation: string; target: string; impact?: string }): CleanupFailureKind | null {
  if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
  const kind: CleanupFailureKind = isGuardRefusal(err) ? 'guard-refused' : 'cleanup-failed';
  try {
    DegradationReporter.getInstance().report({
      feature: `SafeFsExecutor.${kind}`,
      primary: `${ctx.operation}: delete ${ctx.target}`,
      fallback: 'The file or folder was left as it is.',
      reason: `${kind}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 600),
      impact: ctx.impact ?? 'A leftover stays on disk until it is cleaned up; nothing was removed that should not have been.',
      internalOnly: true,
    });
  } catch { /* @silent-fallback-ok — reporting must never break the caller's cleanup path */ }
  return kind;
}
