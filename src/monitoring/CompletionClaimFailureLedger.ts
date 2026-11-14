/**
 * Per-turn failure record for the completion-claim verifier, plus the daily rollup
 * that decides whether the verifier may leave observe-only.
 *
 * Content-free by construction: rows hold fixed reason codes, a parser branch, and a
 * model name. Claim text, model output and error messages never reach this file.
 * Machine-local, like the stats file beside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ClaimArbitrationFailure } from './ClaimClauseArbiter.js';

export type CompletionFailureRow = Pick<ClaimArbitrationFailure, 'branch' | 'model' | 'framework'> & { reason: string };
interface DayRollup { turns: number; failed: number; byReason: Record<string, number> }
export interface CompletionFailureGate {
  met: boolean;
  thresholdRate: number;
  requiredDays: number;
  minTurnsPerDay: number;
  days: Array<{ date: string; turns: number; failed: number; failureRate: number | null; passed: boolean }>;
}

const FAILURE_THRESHOLD = 0.05;
const REQUIRED_DAYS = 7;
/** A day this quiet says nothing about the rate, so it cannot count toward the 7. */
const MIN_TURNS_PER_DAY = 20;
const RETAINED_DAYS = 30;
const DAY_MS = 86_400_000;

export class CompletionClaimFailureLedger {
  private readonly rowsFile: string;
  private readonly dailyFile: string;
  private days: Record<string, DayRollup>;

  constructor(private readonly opts: { stateDir: string; maxBytes?: number; now?: () => number }) {
    const logs = path.join(opts.stateDir, 'logs');
    this.rowsFile = path.join(logs, 'completion-claim-failures.jsonl');
    this.dailyFile = path.join(logs, 'completion-claim-daily.json');
    this.days = this.readDays();
  }

  recordSuccess(): void { this.bumpDay(); this.persistDays(); }

  recordFailure(row: CompletionFailureRow): void {
    const day = this.bumpDay();
    day.failed++;
    day.byReason[row.reason] = (day.byReason[row.reason] ?? 0) + 1;
    this.persistDays();
    try {
      fs.mkdirSync(path.dirname(this.rowsFile), { recursive: true });
      if (fs.existsSync(this.rowsFile) && fs.statSync(this.rowsFile).size > (this.opts.maxBytes ?? 5_000_000)) {
        fs.renameSync(this.rowsFile, `${this.rowsFile}.1`);
      }
      fs.appendFileSync(this.rowsFile, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), reason: row.reason, branch: row.branch,
        ...(row.model ? { model: row.model } : {}), ...(row.framework ? { framework: row.framework } : {}) })}\n`, { mode: 0o600 });
    } catch { /* @silent-fallback-ok — observe-only ledger cannot alter or suppress the response */ }
  }

  read(limit = 100): Array<Record<string, unknown>> {
    try {
      return fs.readFileSync(this.rowsFile, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Math.min(limit, 500)))
        .flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { /* @silent-fallback-ok — malformed row is excluded */ return []; } });
    } catch { /* @silent-fallback-ok — absent ledger reads as no rows */ return []; }
  }

  dailyRollup(): Record<string, DayRollup> { return JSON.parse(JSON.stringify(this.days)) as Record<string, DayRollup>; }

  /** The last 7 COMPLETE UTC days must each pass. A missing or quiet day fails, so unknown holds. */
  gate(): CompletionFailureGate {
    const today = Date.UTC(...utcParts(this.now()));
    const days = Array.from({ length: REQUIRED_DAYS }, (_, index) => {
      const date = new Date(today - (index + 1) * DAY_MS).toISOString().slice(0, 10);
      const { turns = 0, failed = 0 } = this.days[date] ?? {};
      const failureRate = turns > 0 ? failed / turns : null;
      return { date, turns, failed, failureRate,
        passed: turns >= MIN_TURNS_PER_DAY && failureRate !== null && failureRate < FAILURE_THRESHOLD };
    });
    return { met: days.every((day) => day.passed), thresholdRate: FAILURE_THRESHOLD,
      requiredDays: REQUIRED_DAYS, minTurnsPerDay: MIN_TURNS_PER_DAY, days };
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  private bumpDay(): DayRollup {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    const day = this.days[date] ??= { turns: 0, failed: 0, byReason: {} };
    day.turns++;
    return day;
  }

  private readDays(): Record<string, DayRollup> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dailyFile, 'utf8')) as Record<string, DayRollup>;
      const out: Record<string, DayRollup> = {};
      for (const [date, day] of Object.entries(parsed)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(day?.turns) || !Number.isSafeInteger(day?.failed)) continue;
        out[date] = { turns: day.turns, failed: day.failed, byReason: day.byReason && typeof day.byReason === 'object' ? day.byReason : {} };
      }
      return out;
    } catch { /* @silent-fallback-ok — absent or corrupt rollup restarts empty, which keeps the gate closed */ return {}; }
  }

  private persistDays(): void {
    try {
      const cutoff = new Date(this.now() - RETAINED_DAYS * DAY_MS).toISOString().slice(0, 10);
      for (const date of Object.keys(this.days)) if (date < cutoff) delete this.days[date];
      fs.mkdirSync(path.dirname(this.dailyFile), { recursive: true });
      const tmp = `${this.dailyFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.days)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.dailyFile);
    } catch { /* @silent-fallback-ok — metrics are signal-only and cannot affect the response */ }
  }
}

function utcParts(at: number): [number, number, number] {
  const date = new Date(at);
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
}
