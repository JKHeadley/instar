/**
 * Judge budgets and the counters behind /attribution/status. Spec section 4: per use and persisted,
 * so a restart does not reset them. Write gate 200 a day and send record 300 a day are kept apart so
 * sends cannot starve the write gate; the audit's 40 a run is held by the audit itself. A failed save
 * loses a little counting, never a check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../SafeFsExecutor.js';

export type BudgetUse = 'write' | 'send';
export const DAILY_BUDGET: Record<BudgetUse, number> = { write: 200, send: 300 };

export interface AttributionCounters {
  checks: number;
  judgeCalls: number;
  judgeErrors: number;
  unchecked: number;
  overBudget: number;
  hookTimeouts: number;
  refused: number;
  wouldRefuse: number;
  prefilterSkipped: number;
  sampleJudged: number;
  sampleMisses: number;
}

const EMPTY_COUNTERS: AttributionCounters = {
  checks: 0, judgeCalls: 0, judgeErrors: 0, unchecked: 0, overBudget: 0, hookTimeouts: 0,
  refused: 0, wouldRefuse: 0, prefilterSkipped: 0, sampleJudged: 0, sampleMisses: 0,
};

interface BudgetFile { date: string; used: Record<BudgetUse, number>; counters: AttributionCounters }

export class AttributionBudget {
  private readonly file: string;
  private state: BudgetFile;

  constructor(private readonly options: { stateDir: string; now?: () => Date; limits?: Partial<Record<BudgetUse, number>> }) {
    this.file = path.join(options.stateDir, 'attribution', 'budget.json');
    this.state = this.load();
  }

  /** Takes one judge call from a daily budget. False means over budget, which reads `unchecked`. */
  take(use: BudgetUse): boolean {
    this.roll();
    const limit = this.options.limits?.[use] ?? DAILY_BUDGET[use];
    if (this.state.used[use] >= limit) {
      this.state.counters.overBudget += 1;
      this.save();
      return false;
    }
    this.state.used[use] += 1;
    this.save();
    return true;
  }

  count(counter: keyof AttributionCounters, by = 1): void {
    this.roll();
    this.state.counters[counter] += by;
    this.save();
  }

  snapshot(): BudgetFile & { limits: Record<BudgetUse, number> } {
    this.roll();
    return { ...this.state, limits: { ...DAILY_BUDGET, ...this.options.limits } };
  }

  private today(): string {
    return (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);
  }

  private roll(): void {
    const today = this.today();
    if (this.state.date === today) return;
    // Budgets are per day. The counters run on: status reports totals, not one day's slice.
    this.state = { ...this.state, date: today, used: { write: 0, send: 0 } };
    this.save();
  }

  private load(): BudgetFile {
    const fresh: BudgetFile = { date: this.today(), used: { write: 0, send: 0 }, counters: { ...EMPTY_COUNTERS } };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<BudgetFile>;
      if (typeof parsed.date !== 'string' || !parsed.used) return fresh;
      return {
        date: parsed.date,
        used: { write: Number(parsed.used.write) || 0, send: Number(parsed.used.send) || 0 },
        counters: { ...EMPTY_COUNTERS, ...parsed.counters },
      };
    } catch {
      return fresh;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      SafeFsExecutor.atomicWriteJsonSync(this.file, this.state, { operation: 'attribution-budget', mode: 0o600 });
    } catch {
      // @silent-fallback-ok — a failed save loses counting only; the budget still holds in memory.
    }
  }
}
