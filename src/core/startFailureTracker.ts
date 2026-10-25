/**
 * SessionStartFailureTracker — "this machine cannot start a session right now"
 * as a placement-eligibility signal.
 *
 * Placement already avoids a machine whose account quota is exhausted or whose
 * llm-circuit is open, because routing a conversation there is silence the user
 * has to discover (see selfQuotaState.ts). A machine that cannot START A
 * SESSION AT ALL is the same failure with a different cause, and it was not
 * covered.
 *
 * Live incident, 2026-10-20: two of the Mac Mini's pool logins had never
 * recorded folder trust, so every Claude session launched under them hit "Do
 * you trust the files in this folder?" — whose default option is "No, exit" —
 * and died in 16 seconds. The operator's conversation had been PLACED on that
 * machine. It spawned three times in 35 minutes, died three times, and
 * placement kept the conversation there throughout. The operator saw delivery
 * receipts and no replies, for 35 minutes, with nothing raised anywhere.
 *
 * This counts CONSECUTIVE startup deaths and, past a threshold, reports the
 * machine as unable to start work. A single successful start clears it, so a
 * machine that recovers is re-admitted on its own with no operator action.
 *
 * Deliberately a pure counter with injected time: the decision boundary (how
 * many failures, how recent) has to be unit-testable on both sides, and a
 * placement-eligibility signal that can only be observed in production is a
 * signal nobody can trust.
 */

/** Failures older than this stop counting — a machine that failed twice this
 *  morning and has been quiet since is not currently broken. */
export const DEFAULT_START_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** Consecutive startup deaths before the machine is dropped from placement.
 *  Three is the Mini's observed count: enough that a one-off crash or a single
 *  resource blip never costs a machine its work, few enough that the operator
 *  is not left in silence for a third of an hour. */
export const DEFAULT_START_FAILURE_THRESHOLD = 3;

export interface StartFailureState {
  /** Consecutive startup deaths still inside the window. */
  consecutive: number;
  /** True once `consecutive` reaches the threshold. */
  blocked: boolean;
  /** When the most recent startup death was recorded (ISO), if any. */
  lastFailureAt?: string;
}

export interface SessionStartFailureTrackerOptions {
  thresholdFailures?: number;
  windowMs?: number;
}

export class SessionStartFailureTracker {
  private readonly threshold: number;
  private readonly windowMs: number;
  /** Timestamps of consecutive startup deaths, oldest first. */
  private failures: number[] = [];

  constructor(opts: SessionStartFailureTrackerOptions = {}) {
    this.threshold = Math.max(1, opts.thresholdFailures ?? DEFAULT_START_FAILURE_THRESHOLD);
    this.windowMs = Math.max(1, opts.windowMs ?? DEFAULT_START_FAILURE_WINDOW_MS);
  }

  /** A session died during its startup window. */
  recordStartFailure(now: number = Date.now()): void {
    this.prune(now);
    this.failures.push(now);
  }

  /**
   * A session reached its ready prompt. This is the ONLY thing that clears the
   * count, and it clears it completely: the machine has just demonstrated the
   * exact capability the block was about, so holding a grudge would keep work
   * off a machine that works.
   */
  recordStartSuccess(): void {
    this.failures = [];
  }

  /** Current state. Pure — reading it never mutates the count. */
  state(now: number = Date.now()): StartFailureState {
    const live = this.failures.filter((t) => now - t < this.windowMs);
    const last = live.length > 0 ? live[live.length - 1] : undefined;
    return {
      consecutive: live.length,
      blocked: live.length >= this.threshold,
      ...(last !== undefined ? { lastFailureAt: new Date(last).toISOString() } : {}),
    };
  }

  /** Drop failures that have aged out of the window. */
  private prune(now: number): void {
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
  }
}
