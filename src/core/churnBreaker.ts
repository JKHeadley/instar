/**
 * B2 (multimachine-lease-poll-robustness, Decision 8) — the lease flap
 * circuit-breaker. Implements the `leaseSelfHeal.churnDetector` config that ships
 * today as DEAD config (a type + defaults with ZERO consumers).
 *
 * When the awake/standby role flips more than `maxFlipsPerWindow` times within
 * `windowMs`, the breaker LATCHES: the machine stops contending and holds a
 * DETERMINISTIC role (the `preferredAwakeMachineId` machine → awake, every other
 * machine → standby) so the resting state is exactly-one-awake, never a random
 * mid-flap snapshot (which on a 2-machine pair is a coin-flip → 25% both-standby
 * silence / 25% both-awake dual-poll). It auto-resets after a calm `windowMs`.
 *
 * "Guard bypass carries its own cap" — a breaker that re-latches more than
 * `maxLatchesPerHour` is itself an incident: it stops auto-resetting (stays
 * latched) and surfaces a HIGH signal, rather than self-resetting forever.
 *
 * Pure + deterministic (clock injected) so the lifecycle is fully unit-testable.
 * SIGNAL only at this layer — it returns a verdict; the coordinator decides what
 * to do with it (and ships it dark/dry-run first).
 */

export interface ChurnBreakerConfig {
  /** Flips within windowMs that trip the breaker. Default 4. */
  maxFlipsPerWindow: number;
  /** Rolling window for the flip count AND the calm-reset interval. Default 600000 (10m). */
  windowMs: number;
  /** Latches within the trailing hour that exhaust the breaker (then no auto-reset). Default 3. */
  maxLatchesPerHour: number;
}

export const DEFAULT_CHURN_CONFIG: ChurnBreakerConfig = {
  maxFlipsPerWindow: 4,
  windowMs: 600_000,
  maxLatchesPerHour: 3,
};

export interface ChurnVerdict {
  /** Is the breaker currently latched (machine should stop contending)? */
  latched: boolean;
  /** Has the breaker exhausted its latch budget (stays latched, raise HIGH attention)? */
  exhausted: boolean;
  /** Flip count in the current window (for observability). */
  flipsInWindow: number;
  /** Latch count in the trailing hour (for observability). */
  latchesInHour: number;
}

const HOUR_MS = 3_600_000;

export class ChurnBreaker {
  private readonly cfg: ChurnBreakerConfig;
  private readonly now: () => number;
  private flips: number[] = [];
  private latches: number[] = [];
  private latched = false;
  private exhausted = false;
  private lastFlipAt = 0;

  constructor(cfg: Partial<ChurnBreakerConfig>, now: () => number) {
    this.cfg = {
      maxFlipsPerWindow: cfg.maxFlipsPerWindow ?? DEFAULT_CHURN_CONFIG.maxFlipsPerWindow,
      windowMs: cfg.windowMs ?? DEFAULT_CHURN_CONFIG.windowMs,
      maxLatchesPerHour: cfg.maxLatchesPerHour ?? DEFAULT_CHURN_CONFIG.maxLatchesPerHour,
    };
    this.now = now;
  }

  private prune(t: number): void {
    const winFloor = t - this.cfg.windowMs;
    this.flips = this.flips.filter((x) => x > winFloor);
    const hourFloor = t - HOUR_MS;
    this.latches = this.latches.filter((x) => x > hourFloor);
  }

  /** Record a role transition. Returns the breaker verdict AFTER this flip. */
  recordFlip(): ChurnVerdict {
    const t = this.now();
    this.flips.push(t);
    this.lastFlipAt = t;
    this.prune(t);
    if (!this.latched && this.flips.length > this.cfg.maxFlipsPerWindow) {
      this.latched = true;
      this.latches.push(t);
      if (this.latches.length > this.cfg.maxLatchesPerHour) this.exhausted = true;
    }
    return this.verdict(t);
  }

  /**
   * Tick WITHOUT a flip — checks auto-reset. The breaker auto-resets once a full
   * `windowMs` has elapsed with NO new flip (a calm window), UNLESS it is
   * exhausted (then it stays latched until the operator clears it). Call this on
   * the coordinator's heartbeat tick so a settled system un-latches on its own.
   */
  tick(): ChurnVerdict {
    const t = this.now();
    this.prune(t);
    if (this.latched && !this.exhausted && t - this.lastFlipAt >= this.cfg.windowMs) {
      this.latched = false;
    }
    return this.verdict(t);
  }

  private verdict(t: number): ChurnVerdict {
    this.prune(t);
    return {
      latched: this.latched,
      exhausted: this.exhausted,
      flipsInWindow: this.flips.length,
      latchesInHour: this.latches.length,
    };
  }

  /**
   * The DETERMINISTIC role this machine should hold while latched. Never a
   * mid-flap snapshot: the preferred-awake machine holds awake, everyone else
   * holds standby → exactly-one-awake resting state. Returns null when not
   * latched (the lease decides normally).
   */
  latchedRole(isPreferredAwake: boolean): 'awake' | 'standby' | null {
    if (!this.latched) return null;
    return isPreferredAwake ? 'awake' : 'standby';
  }
}
