/**
 * Enforced Termination — the PURE decision core for the external hard-stop on
 * autonomous runs. Spec: docs/specs/enforced-termination-watchdog.md.
 * Constitution: "The User Experience Is the Product" → sub-standard #2 Enforced
 * Termination; an instance of "Structure beats Willpower" applied to the END of
 * work. Earned from 2026-06-25 (topic 27515 ran ~46h on a 24h budget).
 *
 * This module is intentionally dependency-free (no sessions, no fs, no clock of
 * its own) so the overrun predicate and the two-phase confirm are unit-tested
 * deterministically. The watchdog that actuates a kill (delete state file +
 * record operator-stop + cancel resume + clear endedMidWork + killSession) wires
 * THIS core to real deps — the safety-critical actuation is deliberately kept
 * out of the pure logic so the decision boundary is provable in isolation.
 */

/** A durable snapshot of one autonomous run, parsed from its state frontmatter. */
export interface AutonomousRunSnapshot {
  /** Telegram topic id (string key of the run). */
  topicId: string;
  /** Parsed `started_at` epoch ms, or null when absent/unparseable. */
  startedAtMs: number | null;
  /**
   * Fallback clock for the absolute ceiling ONLY — the run state file's mtime
   * (ms). Used when `startedAtMs` is null so an unparseable timestamp still has
   * a bounded ceiling (fail TOWARD termination, never toward run-forever).
   */
  fileMtimeMs: number;
  /** `duration_seconds` budget. null or 0 ⇒ UNBOUNDED (no time budget). */
  durationSeconds: number | null;
  /** Current iteration count (for the optional iteration ceiling). */
  iteration: number;
  /** Whether the run is marked active. */
  active: boolean;
  /** Whether the run is paused (operator pause / move). Paused ⇒ never terminated. */
  paused: boolean;
  /**
   * True when the run is mid cross-machine move (`move_suspended_at`/`moved_to`
   * present). The destination re-evaluates; this watchdog must NOT kill it.
   */
  moveSuspended: boolean;
}

export interface EnforcedTerminationConfig {
  /**
   * Grace past the time budget before the watchdog fires, letting the
   * cooperative in-hook duration check win the normal case. Default 120s.
   */
  graceSeconds: number;
  /**
   * Absolute hard ceiling from the run's start. Fires even for an UNBOUNDED run
   * or an unparseable `started_at` (via file mtime). Default 26h.
   */
  absoluteCeilingSeconds: number;
  /** Optional iteration ceiling. Unset ⇒ no iteration-based termination. */
  maxIterations?: number;
}

export const DEFAULT_ENFORCED_TERMINATION_CONFIG: EnforcedTerminationConfig = {
  graceSeconds: 120,
  absoluteCeilingSeconds: 26 * 60 * 60, // 26h
};

export type OverrunReason =
  | { kind: 'time-budget'; elapsedSeconds: number; budgetSeconds: number }
  | {
      kind: 'absolute-ceiling';
      elapsedSeconds: number;
      ceilingSeconds: number;
      clock: 'started_at' | 'file-mtime';
    }
  | { kind: 'iteration-ceiling'; iteration: number; max: number };

/**
 * Decide whether a run has PROVABLY overrun its budget. Pure: same inputs →
 * same output. Returns the first matching reason, or null when the run is
 * within budget / not eligible.
 *
 * Eligibility gates (return null): not active, paused, or mid-move. A run that
 * is not eligible is NEVER terminated by this watchdog — the reaper handles
 * idle/pressure; this fires ONLY on a genuine budget overrun.
 */
export function computeOverrun(
  run: AutonomousRunSnapshot,
  cfg: EnforcedTerminationConfig,
  nowMs: number,
): OverrunReason | null {
  if (!run.active || run.paused || run.moveSuspended) return null;

  // Iteration ceiling (optional, explicit opt-in).
  if (cfg.maxIterations != null && cfg.maxIterations > 0 && run.iteration >= cfg.maxIterations) {
    return { kind: 'iteration-ceiling', iteration: run.iteration, max: cfg.maxIterations };
  }

  // Time budget — only for a BOUNDED run with a parseable start. The grace
  // window gives the cooperative in-hook check first right of termination.
  if (run.startedAtMs != null && run.durationSeconds != null && run.durationSeconds > 0) {
    const elapsed = (nowMs - run.startedAtMs) / 1000;
    if (elapsed >= run.durationSeconds + cfg.graceSeconds) {
      return { kind: 'time-budget', elapsedSeconds: elapsed, budgetSeconds: run.durationSeconds };
    }
  }

  // Absolute ceiling — the backstop that covers the holes the in-hook check
  // can't: an UNBOUNDED run (no duration), and an UNPARSEABLE started_at (uses
  // file mtime). Fail TOWARD a bounded stop, never toward run-forever.
  const clockMs = run.startedAtMs ?? run.fileMtimeMs;
  const clock: 'started_at' | 'file-mtime' = run.startedAtMs != null ? 'started_at' : 'file-mtime';
  const elapsedAbs = (nowMs - clockMs) / 1000;
  if (elapsedAbs >= cfg.absoluteCeilingSeconds) {
    return {
      kind: 'absolute-ceiling',
      elapsedSeconds: elapsedAbs,
      ceilingSeconds: cfg.absoluteCeilingSeconds,
      clock,
    };
  }

  return null;
}

/**
 * Two-phase confirm — a topic is only terminated after it is observed overrun
 * on TWO consecutive reconcile() ticks. This absorbs a clock blip, an in-flight
 * cooperative stop landing between ticks, and a run that just completed. Mirrors
 * SessionReaper's mark-pending / re-confirm pattern.
 *
 * Stateful but pure of side effects: it only tracks per-topic consecutive
 * overrun counts. A topic that drops out of the overrun set is forgotten (its
 * pending count resets), so a transient overrun never accumulates toward a kill.
 */
export class TerminationConfirmer {
  private readonly pending = new Map<string, number>();
  private readonly threshold: number;

  constructor(confirmThreshold = 2) {
    this.threshold = Math.max(1, confirmThreshold);
  }

  /**
   * Feed the set of currently-overrun topic ids; returns the topics CONFIRMED
   * for termination this tick (overrun for `threshold` consecutive ticks).
   * Topics no longer overrun are cleared.
   */
  reconcile(overrunTopicIds: Iterable<string>): string[] {
    const overrun = new Set(overrunTopicIds);
    const confirmed: string[] = [];
    for (const topic of overrun) {
      const next = (this.pending.get(topic) ?? 0) + 1;
      this.pending.set(topic, next);
      if (next >= this.threshold) confirmed.push(topic);
    }
    // Forget topics that are no longer overrun (reset their streak).
    for (const topic of [...this.pending.keys()]) {
      if (!overrun.has(topic)) this.pending.delete(topic);
    }
    return confirmed;
  }

  /** Drop a topic's pending state once it has been actuated (or cancelled). */
  clear(topicId: string): void {
    this.pending.delete(topicId);
  }

  /** Topics currently marked terminate-pending (overrun but not yet confirmed). */
  pendingTopics(): string[] {
    return [...this.pending.entries()].filter(([, n]) => n < this.threshold).map(([t]) => t);
  }
}
