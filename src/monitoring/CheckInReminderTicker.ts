/**
 * CheckInReminderTicker — the server-side driver for the check-in reminder pass
 * (docs/specs/check-in-reminder-server-tick.md, CMT-1130).
 *
 * The pass needs no session and no LLM, but its only driver was a built-in job
 * that would have spawned a session every five minutes, so it shipped off and
 * nothing ran. AgentServer owns the timer; this owns what one tick does.
 *
 * Passes are single-flight: the route and the tick share one in-flight pass, so
 * two callers cannot both act on the same due rows between a send and its stamp.
 *
 * The soak ledger exists because dry-run logs a line per waiting row. A tick
 * pass is quiet in the server log and writes one row on change (plus hourly).
 * Rows carry ids and counts, never promise text. The ledger is observability:
 * a write failure is counted and never stops a pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CheckInReminderPassReport } from './CheckInReminderReconciler.js';

export const CHECK_IN_TICK_DEFAULT_INTERVAL_MS = 5 * 60_000;
export const CHECK_IN_TICK_MIN_INTERVAL_MS = 1_000;
/** Consecutive thrown passes before one degradation report. */
export const CHECK_IN_TICK_FAILURE_STREAK = 3;

/** A pass still running after this long is reported, never overlapped. */
export const CHECK_IN_TICK_STALL_MS = 10 * 60_000;

const LEDGER_HEARTBEAT_MS = 60 * 60_000;
const LEDGER_MAX_BYTES = 5_000_000;

/** Nullish-safe: an absent or nonsensical interval is the default, never 0. */
export function resolveCheckInTickIntervalMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return CHECK_IN_TICK_DEFAULT_INTERVAL_MS;
  return Math.max(raw, CHECK_IN_TICK_MIN_INTERVAL_MS);
}

export type CheckInTickSkip = string;

export interface CheckInReminderTickerDeps {
  /** Why a tick must not run right now, or null to run. Re-read every tick. */
  skipReason: () => CheckInTickSkip | null;
  runPass: (opts: { quiet: boolean }) => Promise<CheckInReminderPassReport>;
  stateDir: string;
  intervalMs: number;
  now?: () => number;
  /** A pass reported retries exhausted: those promises did not reach the user. */
  onUndelivered?: (report: CheckInReminderPassReport) => void | Promise<void>;
  /** Passes keep throwing. Fired once per streak. */
  onFailureStreak?: (streak: number, error: string) => void;
}

export interface CheckInReminderTickStatus {
  armed: boolean;
  enabled: boolean;
  intervalMs: number;
  ticks: number;
  lastTickAt: string | null;
  lastSkip: CheckInTickSkip | null;
  lastReport: CheckInReminderPassReport | null;
  consecutiveFailures: number;
  lastError: string | null;
  ledgerWriteFailures: number;
}

export class CheckInReminderTicker {
  readonly ledgerPath: string;
  private inFlight: Promise<CheckInReminderPassReport> | null = null;
  private inFlightSince = 0;
  private armed = false;
  private ticks = 0;
  private lastTickAt: number | null = null;
  private lastSkip: CheckInTickSkip | null = null;
  private lastReport: CheckInReminderPassReport | null = null;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private ledgerWriteFailures = 0;
  private lastLedgerKey: string | null = null;
  private lastLedgerAt = 0;

  constructor(private readonly deps: CheckInReminderTickerDeps) {
    this.ledgerPath = path.join(deps.stateDir, 'logs', 'check-in-reminder-tick.jsonl');
  }

  setArmed(armed: boolean): void {
    this.armed = armed;
  }

  /** One pass, or the pass already running. The route calls this too. */
  pass(opts: { quiet: boolean }): Promise<CheckInReminderPassReport> {
    if (this.inFlight) return this.inFlight;
    const run = this.runAndRecord(opts).finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    this.inFlightSince = this.nowMs();
    return run;
  }

  /** True when the running pass has outlived the stall bound. */
  stalled(): boolean {
    return !!this.inFlight && this.nowMs() - this.inFlightSince >= CHECK_IN_TICK_STALL_MS;
  }

  /** One timer tick. Never rejects: a timer callback has nowhere to report. */
  async tick(): Promise<CheckInReminderPassReport | null> {
    this.ticks += 1;
    this.lastTickAt = this.nowMs();
    this.lastSkip = this.deps.skipReason();
    if (this.lastSkip) return null;
    if (this.stalled()) {
      // Starting another pass could double-send the row this one is stuck on,
      // so a stuck pass stays alone and is reported until a restart clears it.
      this.recordFailure('pass-stalled');
      return null;
    }
    try {
      return await this.pass({ quiet: true });
    } catch (err) {
      this.recordFailure(String(err));
      return null;
    }
  }

  /**
   * Bookkeeping lives here, not in tick(), because retries exhaust once per
   * commitment: a route or job pass that gives up must raise the notice too,
   * or those rows are never due again and nothing says so.
   */
  private async runAndRecord(opts: { quiet: boolean }): Promise<CheckInReminderPassReport> {
    const report = await this.deps.runPass(opts);
    this.lastReport = report;
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.recordLedger(report);
    if (report.gaveUp > 0) {
      try {
        await this.deps.onUndelivered?.(report);
      } catch (err) {
        // @silent-fallback-ok — surfaced as lastError; the rows stay listed
        // under `undelivered` on the read route.
        this.lastError = `undelivered-notice-failed: ${err}`;
        console.warn(`[check-in-reminder] ${this.lastError}`);
      }
    }
    return report;
  }

  private recordFailure(error: string): void {
    this.lastError = error;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === CHECK_IN_TICK_FAILURE_STREAK) {
      this.deps.onFailureStreak?.(this.consecutiveFailures, error);
    }
  }

  status(): CheckInReminderTickStatus {
    return {
      armed: this.armed,
      enabled: this.deps.skipReason() === null,
      intervalMs: this.deps.intervalMs,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt === null ? null : new Date(this.lastTickAt).toISOString(),
      lastSkip: this.lastSkip,
      lastReport: this.lastReport,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      ledgerWriteFailures: this.ledgerWriteFailures,
    };
  }

  private recordLedger(report: CheckInReminderPassReport): void {
    const now = this.nowMs();
    const key = [...report.dueIds].sort().join(',');
    const acted = report.sent > 0 || report.failed > 0 || report.gaveUp > 0;
    if (!acted && key === this.lastLedgerKey && now - this.lastLedgerAt < LEDGER_HEARTBEAT_MS) return;
    this.lastLedgerKey = key;
    this.lastLedgerAt = now;
    const row = {
      ts: new Date(now).toISOString(),
      dryRun: report.dryRun,
      scanned: report.scanned,
      due: report.due,
      wouldSend: report.wouldSend,
      sent: report.sent,
      failed: report.failed,
      gaveUp: report.gaveUp,
      capped: report.capped,
      dueIds: report.dueIds,
      errors: report.errors.length,
    };
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      try {
        if (fs.statSync(this.ledgerPath).size > LEDGER_MAX_BYTES) {
          fs.renameSync(this.ledgerPath, `${this.ledgerPath}.1`);
        }
      } catch { /* @silent-fallback-ok — no file yet, nothing to rotate */ }
      fs.appendFileSync(this.ledgerPath, `${JSON.stringify(row)}\n`, 'utf-8');
    } catch (err) {
      // @silent-fallback-ok — counted and exposed on the status block.
      this.ledgerWriteFailures += 1;
      console.warn(`[check-in-reminder] tick ledger write failed: ${err}`);
    }
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }
}
