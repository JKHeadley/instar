/**
 * The run machine's borrowed-helper state (docs/specs/local-verify-borrowed-unit-slices.md, F):
 * `state/local-verify/borrowed-helpers.json` keeps ONLY each helper's breaker state and rolling
 * counters for its last 50 runs. Machine-local, rebuildable, not backed up.
 *
 * Unreachable helpers: a helper that does not answer, or answers with a bad signature, three runs
 * in a row is skipped. The wait doubles from 30 min up to 8 h and resets on the first good answer.
 * The degradation is reported once (`helper-unreachable since <t>`), not on every probe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { BORROWED_PLAN, p90 } from './borrowedPlan.js';

export const BORROWED_BREAKER = Object.freeze({ badRunsToSkip: 3, firstWaitMs: 30 * 60_000, maxWaitMs: 8 * 60 * 60_000, keepRuns: 50 });

export interface HelperBreaker {
  consecutiveBad: number;
  skipUntil: number | null;
  /** The wait the NEXT opening uses. */
  nextWaitMs: number;
  unreachableSince: number | null;
  reported: boolean;
}

export interface HelperRunSummary {
  at: number;
  /** At least one finished slice: only these runs count toward the 20-run report and the measured figures. */
  counted: boolean;
  slicesSent: number;
  done: number;
  agree: number;
  disagree: number;
  helperMs: number;
  localMs: number;
  prepMs: number | null;
  vitestStartMs: number | null;
}

export interface HelperState { breaker: HelperBreaker; runs: HelperRunSummary[] }

export const freshBreaker = (): HelperBreaker => ({ consecutiveBad: 0, skipUntil: null, nextWaitMs: BORROWED_BREAKER.firstWaitMs, unreachableSince: null, reported: false });

/** True while the breaker says skip this helper. */
export function helperSkipped(b: HelperBreaker, now: number): boolean {
  return b.skipUntil !== null && now < b.skipUntil;
}

/**
 * Record one run's outcome. `bad` = no answer or a bad signature. Returns whether the breaker
 * opened now and whether the degradation should be reported now (once per outage).
 */
export function noteHelperOutcome(b: HelperBreaker, outcome: 'good' | 'bad', now: number): { opened: boolean; reportNow: boolean; recovered: boolean } {
  if (outcome === 'good') {
    const recovered = b.unreachableSince !== null;
    Object.assign(b, freshBreaker());
    return { opened: false, reportNow: false, recovered };
  }
  b.consecutiveBad++;
  if (b.unreachableSince === null) b.unreachableSince = now;
  if (b.consecutiveBad < BORROWED_BREAKER.badRunsToSkip) return { opened: false, reportNow: false, recovered: false };
  b.skipUntil = now + b.nextWaitMs;
  b.nextWaitMs = Math.min(BORROWED_BREAKER.maxWaitMs, b.nextWaitMs * 2);
  const reportNow = !b.reported;
  b.reported = true;
  return { opened: true, reportNow, recovered: false };
}

/** Measured throughput (local file-seconds per helper-second) after 5 counted runs, else null. */
export function measuredThroughput(runs: readonly HelperRunSummary[]): number | null {
  const c = runs.filter((r) => r.counted && r.helperMs > 0);
  if (c.length < BORROWED_PLAN.measuredAfterRuns) return null;
  const helper = c.reduce((n, r) => n + r.helperMs, 0);
  const local = c.reduce((n, r) => n + r.localMs, 0);
  return helper > 0 ? local / helper : null;
}

export function measuredPrepP90(runs: readonly HelperRunSummary[]): number | null {
  const c = runs.filter((r) => r.counted && r.prepMs !== null).map((r) => r.prepMs as number);
  return c.length >= BORROWED_PLAN.measuredAfterRuns ? p90(c) : null;
}

export class BorrowedHelpersStore {
  private readonly file: string;
  private data: { v: 1; helpers: Record<string, HelperState> };

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'borrowed-helpers.json');
    this.data = { v: 1, helpers: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { v?: unknown; helpers?: unknown };
      if (raw.v === 1 && raw.helpers && typeof raw.helpers === 'object') {
        for (const [id, h] of Object.entries(raw.helpers as Record<string, Partial<HelperState>>)) {
          if (!h || typeof h !== 'object') continue;
          this.data.helpers[id] = { breaker: { ...freshBreaker(), ...(h.breaker ?? {}) }, runs: Array.isArray(h.runs) ? h.runs.slice(-BORROWED_BREAKER.keepRuns) : [] };
        }
      }
    } catch { /* @silent-fallback-ok: absent or unreadable state is rebuilt (breakers closed, counters empty) */ }
  }

  get(machineId: string): HelperState {
    let h = this.data.helpers[machineId];
    if (!h) { h = { breaker: freshBreaker(), runs: [] }; this.data.helpers[machineId] = h; }
    return h;
  }

  addRun(machineId: string, run: HelperRunSummary): void {
    const h = this.get(machineId);
    h.runs = [...h.runs, run].slice(-BORROWED_BREAKER.keepRuns);
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteJsonSync(this.file, this.data, { operation: 'local-verify:borrowed-helpers' });
  }

  snapshot(): Record<string, HelperState> {
    return JSON.parse(JSON.stringify(this.data.helpers)) as Record<string, HelperState>;
  }
}
