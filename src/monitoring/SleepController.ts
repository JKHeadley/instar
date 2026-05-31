/**
 * SleepController — the decision half of agent hard-sleep (Stage B of the
 * Responsible Resource Usage / agent-sleep design, docs/specs/agent-sleep-mode.md).
 *
 * This module owns ONE question: "is it safe for this agent to drop its server to
 * near-zero footprint right now?" It is deliberately split from the MECHANISM that
 * actually stops/respawns the server (the supervisor + lifeline handshake, a later
 * slice). Getting the decision — and every safety guard — correct and OBSERVABLE
 * first, in dry-run, is what makes the mechanism safe to wire: the same dark +
 * dry-run discipline the AgentWorktreeReaper shipped with.
 *
 * Pure `evaluateSleep()` is fake-free and exhaustively unit-testable. The thin
 * `SleepController` class ticks it on a cadence and, in dry-run (the default),
 * only records what it WOULD do to an audit sink — it never stops anything.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Live inputs sampled once per tick. All timestamps are epoch ms. */
export interface SleepInput {
  now: number;
  /** Active Claude/codex sessions. Any > 0 ⇒ never sleep. */
  runningSessions: number;
  /** Last inbound user/agent message timestamp, or null if never. */
  lastInboundAt: number | null;
  /** Last any-activity timestamp (session output, outbound, tick work), or null. */
  lastActivityAt: number | null;
  /** This machine currently holds the multi-machine serving lease. */
  holdsLease: boolean;
  /** Multi-machine lease coordination is active at all (single-machine ⇒ false). */
  leaseActive: boolean;
  /** Any in-flight forward, recovery, or queued/undelivered message. */
  inflightWork: boolean;
  /** Next scheduled cron job fire time (epoch ms), or null if none scheduled. */
  nextScheduledJobAt: number | null;
}

export interface SleepThresholds {
  /** Time since last activity to count as "idle" at all. */
  idleGraceMs: number;
  /** Continuous idle time before deep-idle ⇒ a sleep candidate. */
  deepIdleMs: number;
  /** Don't sleep if a scheduled job fires within this lead window. */
  wakeLeadMs: number;
}

export type SleepDecision = 'awake' | 'idle-shallow' | 'keep-awake' | 'would-sleep';

export interface SleepVerdict {
  decision: SleepDecision;
  reason: string;
  /** Idle duration in ms at evaluation time (Infinity if never any signal). */
  idleForMs: number;
}

export const DEFAULT_SLEEP_THRESHOLDS: SleepThresholds = {
  idleGraceMs: 120_000, // 2 min
  deepIdleMs: 900_000, // 15 min
  wakeLeadMs: 120_000, // 2 min
};

/**
 * Decide whether the agent may hard-sleep. Pure; no I/O. The guards are ordered
 * so the returned reason names the FIRST blocking condition — easiest to read in
 * an audit trail.
 */
export function evaluateSleep(input: SleepInput, t: SleepThresholds): SleepVerdict {
  // 1. Active sessions ⇒ never sleep. (A session means real work in flight.)
  if (input.runningSessions > 0) {
    return {
      decision: 'awake',
      reason: `${input.runningSessions} running session(s)`,
      idleForMs: 0,
    };
  }

  // 2. Idle duration = time since the most recent inbound OR activity signal.
  const lastSignal = Math.max(input.lastInboundAt ?? 0, input.lastActivityAt ?? 0);
  const idleForMs = lastSignal > 0 ? input.now - lastSignal : Number.POSITIVE_INFINITY;

  if (idleForMs < t.idleGraceMs) {
    return { decision: 'awake', reason: `recent activity ${secs(idleForMs)} ago`, idleForMs };
  }
  if (idleForMs < t.deepIdleMs) {
    return {
      decision: 'idle-shallow',
      reason: `idle ${secs(idleForMs)} (< deepIdle ${secs(t.deepIdleMs)})`,
      idleForMs,
    };
  }

  // 3. Deep-idle — every safety guard below blocks sleep (KEEP-awake on any).
  if (input.leaseActive && input.holdsLease) {
    return {
      decision: 'keep-awake',
      reason: 'holds the multi-machine serving lease — must hand off before sleeping',
      idleForMs,
    };
  }
  if (input.inflightWork) {
    return { decision: 'keep-awake', reason: 'in-flight work (forward / recovery / queued message)', idleForMs };
  }
  if (input.nextScheduledJobAt !== null) {
    const until = input.nextScheduledJobAt - input.now;
    if (until <= t.wakeLeadMs) {
      return { decision: 'keep-awake', reason: `scheduled job fires in ${secs(Math.max(0, until))} (< wakeLead)`, idleForMs };
    }
  }

  // 4. Deep-idle and every guard clear ⇒ safe to sleep.
  return {
    decision: 'would-sleep',
    reason: `deep-idle ${secs(idleForMs)}; no sessions, no held lease, no in-flight work, no imminent job`,
    idleForMs,
  };
}

function secs(ms: number): string {
  if (!Number.isFinite(ms)) return '∞';
  return `${Math.round(ms / 1000)}s`;
}

// ── Audit + handshake ────────────────────────────────────────────────

export interface SleepAuditEntry {
  ts: string;
  decision: SleepDecision;
  reason: string;
  idleForMs: number;
  dryRun: boolean;
}

export type SleepAuditSink = (entry: SleepAuditEntry) => void;

/**
 * Append-only JSONL audit sink at `logs/agent-sleep-events.jsonl`. Only writes on
 * a decision CHANGE (transition), never every tick — the same low-noise pattern as
 * the reaper audit, so a deep-idle agent doesn't spam the log every cadence.
 */
export function sleepAuditSink(stateDir: string): SleepAuditSink {
  const file = path.join(stateDir, 'logs', 'agent-sleep-events.jsonl');
  return (entry: SleepAuditEntry) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch {
      /* @silent-fallback-ok — audit is best-effort observability, never load-bearing */
    }
  };
}

export interface SleepControllerOptions {
  enabled: boolean;
  /** When true (default), evaluate + audit but NEVER write the sleep-request flag. */
  dryRun: boolean;
  thresholds?: Partial<SleepThresholds>;
}

export interface SleepControllerDeps {
  sample: () => SleepInput;
  audit?: SleepAuditSink;
  /** Live-mode only (dryRun=false): request the supervisor to sleep the server. */
  requestSleep?: (verdict: SleepVerdict) => void;
}

/**
 * Ticks the sleep decision on a cadence. Records every TRANSITION to the audit
 * sink; in live mode (dryRun=false) calls `requestSleep` on a fresh would-sleep.
 * In dry-run it is pure observability — the foundation slice ships this way.
 */
export class SleepController {
  private readonly thresholds: SleepThresholds;
  private lastDecision: SleepDecision | null = null;
  private lastVerdict: SleepVerdict | null = null;
  private sleepRequested = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: SleepControllerDeps,
    private readonly opts: SleepControllerOptions & { tickIntervalMs?: number },
  ) {
    this.thresholds = { ...DEFAULT_SLEEP_THRESHOLDS, ...(opts.thresholds ?? {}) };
  }

  /** Begin ticking on the configured cadence. No-op when not enabled (the audit
   *  still works in dry-run-but-enabled; a fully disabled controller never ticks). */
  start(): void {
    if (this.timer || !this.opts.enabled) return;
    const intervalMs = this.opts.tickIntervalMs ?? 60_000;
    this.timer = setInterval(() => {
      try { this.tick(); } catch { /* @silent-fallback-ok — observability tick, never load-bearing */ }
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Evaluate once. Returns the verdict (also used by tests + a status route). */
  tick(): SleepVerdict {
    const verdict = evaluateSleep(this.deps.sample(), this.thresholds);
    this.lastVerdict = verdict;

    if (verdict.decision !== this.lastDecision) {
      this.lastDecision = verdict.decision;
      this.deps.audit?.({
        ts: new Date().toISOString(),
        decision: verdict.decision,
        reason: verdict.reason,
        idleForMs: verdict.idleForMs,
        dryRun: this.opts.dryRun,
      });
    }

    // Live mechanism (off in the foundation slice): request sleep once per
    // would-sleep episode; reset the latch as soon as we leave would-sleep.
    if (verdict.decision === 'would-sleep') {
      if (!this.opts.dryRun && this.opts.enabled && !this.sleepRequested) {
        this.sleepRequested = true;
        this.deps.requestSleep?.(verdict);
      }
    } else {
      this.sleepRequested = false;
    }

    return verdict;
  }

  /** Current latched state — for a status route / tests. */
  get state(): { lastDecision: SleepDecision | null; sleepRequested: boolean } {
    return { lastDecision: this.lastDecision, sleepRequested: this.sleepRequested };
  }

  /** Read-only status for GET /sleep. Ticks once so the verdict is fresh. */
  snapshot(): {
    enabled: boolean;
    dryRun: boolean;
    thresholds: SleepThresholds;
    verdict: SleepVerdict;
    sleepRequested: boolean;
  } {
    const verdict = this.tick();
    return {
      enabled: this.opts.enabled,
      dryRun: this.opts.dryRun,
      thresholds: this.thresholds,
      verdict,
      sleepRequested: this.sleepRequested,
    };
  }
}
