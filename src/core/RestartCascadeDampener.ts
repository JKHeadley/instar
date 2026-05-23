/**
 * RestartCascadeDampener — minimum-interval guard between update-driven restarts.
 *
 * Problem this solves:
 *   When two updates land within minutes of each other (e.g. v1.2.34 at T+0
 *   and v1.2.36 at T+30s after the v1.2.34 restart), the AutoUpdater fires a
 *   second user-visible restart sequence right on top of the first. From the
 *   user's side, this looks like Luna becoming "unresponsive" for two
 *   overlapping windows in quick succession — the symptom reported on
 *   2026-05-22 in topic 11838.
 *
 *   The existing 30-minute SAME-VERSION cooldown (AutoUpdater.gatedRestart
 *   line ~531) catches loops, but it does NOT debounce two DIFFERENT
 *   legitimate updates arriving back-to-back. This dampener fills that gap.
 *
 * Scope:
 *   - ONLY dampens update-driven restarts (AutoUpdater.gatedRestart).
 *   - Does NOT dampen crash, health-fail, version-skew, or external-signal
 *     restarts — those are handled by RestartOrchestrator with different
 *     semantics (no debounce, exit-and-let-launchd-respawn).
 *
 * Signal-vs-authority:
 *   The dampener emits a decision (proceed / batch / skip). AutoUpdater is
 *   the authority that acts. The dampener never writes the restart flag,
 *   never calls process.exit, never touches Telegram. See
 *   memory feedback_signal_vs_authority for the principle.
 *
 * State model:
 *   The dampener is stateless — it consults AutoUpdater's existing
 *   persisted state (`lastRestartRequestedAt`, `lastRestartRequestedVersion`)
 *   plus a tiny in-memory batch slot. State survives process restarts via
 *   the existing `state/auto-updater.json` file, which is why the gate
 *   works the FIRST time after the new server boots up.
 */

export interface DampenerInput {
  /** New version that AutoUpdater wants to restart for. */
  requestedVersion: string;
  /** ISO timestamp of the previous restart request, or null if never. */
  lastRequestedAt: string | null;
  /** Override clock for tests. Defaults to Date.now(). */
  now?: number;
}

export type DampenerDecision =
  | { kind: 'proceed'; reason: string }
  | { kind: 'batch'; eligibleAt: number; waitMs: number; reason: string };

export class RestartCascadeDampener {
  /** Minimum ms between two update-driven restart requests. Default 15 min. */
  public readonly windowMs: number;

  constructor(windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs < 0) {
      throw new Error(`RestartCascadeDampener: windowMs must be a non-negative finite number, got ${windowMs}`);
    }
    this.windowMs = windowMs;
  }

  /**
   * Decide whether to proceed with a restart now, or defer it until the
   * minimum-interval window has elapsed since the previous restart.
   *
   * Returns:
   *   - 'proceed' — no prior restart, or prior restart is outside the window.
   *                 AutoUpdater should fire the restart now.
   *   - 'batch'   — prior restart is within the window. AutoUpdater should
   *                 schedule a deferred restart at `eligibleAt` and notify
   *                 the user. Subsequent calls during the deferral window
   *                 will return another 'batch' against the SAME eligibleAt.
   */
  decide(input: DampenerInput): DampenerDecision {
    const now = input.now ?? Date.now();

    // No prior restart recorded — proceed immediately.
    if (!input.lastRequestedAt) {
      return { kind: 'proceed', reason: 'no prior restart recorded' };
    }

    const lastAt = Date.parse(input.lastRequestedAt);
    if (!Number.isFinite(lastAt)) {
      // Corrupt timestamp — fail open to proceed rather than block forever.
      return { kind: 'proceed', reason: 'prior restart timestamp unparseable; failing open' };
    }

    const elapsed = now - lastAt;
    if (elapsed >= this.windowMs) {
      const elapsedMin = Math.round(elapsed / 60_000);
      const windowMin = Math.round(this.windowMs / 60_000);
      return {
        kind: 'proceed',
        reason: `prior restart ${elapsedMin}m ago, outside ${windowMin}m window`,
      };
    }

    // Within window — batch.
    const eligibleAt = lastAt + this.windowMs;
    const waitMs = Math.max(0, eligibleAt - now);
    const elapsedMin = Math.round(elapsed / 60_000);
    const waitMin = Math.max(1, Math.round(waitMs / 60_000));
    const windowMin = Math.round(this.windowMs / 60_000);
    return {
      kind: 'batch',
      eligibleAt,
      waitMs,
      reason: `prior restart ${elapsedMin}m ago — within ${windowMin}m window; deferring ~${waitMin}m`,
    };
  }
}

/**
 * Format a millisecond-epoch timestamp as a short HH:MM local-time label
 * for user-facing batch-notification messages. Pure helper, no I/O.
 */
export function formatLocalTimeHHMM(ms: number, date: Date = new Date(ms)): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
