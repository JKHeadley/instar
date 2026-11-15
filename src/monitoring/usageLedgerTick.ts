/**
 * usageLedgerTick — the server's once-a-minute drive of the usage ledger.
 *
 * It lives apart from AgentServer so its rules can be tested by behaviour:
 *   - one tick at a time (the listing awaits; a tick that finds the last one
 *     still running is skipped, and a run of skipped ticks is reported, since a
 *     listing that never ends would otherwise stop the ledger without a word);
 *   - a failed tick frees the slot;
 *   - housekeeping every `housekeepingEvery` completed ticks;
 *   - nothing is done for, or recorded about, a ledger that was closed or
 *     replaced while the tick was listing.
 */
import type { ScanReport } from './UsageLedger.js';

export interface UsageLedgerTickLedger {
  scanTickAsync(): Promise<ScanReport>;
  prune(): unknown;
  dropMissingCheckpointsAsync(): Promise<number>;
  writeSnapshot(snapshotPath: string): unknown;
}

export interface UsageLedgerTickDeps {
  /** The ledger in use now, or null when it is off or closed. Read at every step. */
  getLedger: () => UsageLedgerTickLedger | null;
  snapshotPath: string;
  onTick: (report: ScanReport, tickMs: number) => void;
  onError: (error: unknown) => void;
  /** Called when `skipped` consecutive ticks found the previous one still running. */
  onStuck: (skipped: number, runningMs: number) => void;
  housekeepingEvery?: number;
  /** Report a stuck tick at this many consecutive skips, and again at every multiple. */
  stuckAfterSkips?: number;
  now?: () => number;
}

export interface UsageLedgerTick {
  /** Run one tick. Resolves when it has finished, or at once when it was skipped. Never rejects. */
  (): Promise<'ran' | 'skipped' | 'off' | 'failed'>;
}

export function createUsageLedgerTick(deps: UsageLedgerTickDeps): UsageLedgerTick {
  const housekeepingEvery = deps.housekeepingEvery ?? 60;
  const stuckAfterSkips = deps.stuckAfterSkips ?? 5;
  const now = deps.now ?? Date.now;
  let running = false;
  let startedAt = 0;
  let skipped = 0;
  let completed = 0;
  // The timer calls this with `void`, so nothing may escape it, a reporting callback included.
  const reportError = (error: unknown): void => {
    try { deps.onError(error); } catch (inner) { console.warn('[usage-ledger-tick] error reporting failed:', inner); }
  };
  return async () => {
    const ledger = deps.getLedger();
    if (!ledger) return 'off';
    if (running) {
      skipped++;
      if (skipped % stuckAfterSkips === 0) {
        try { deps.onStuck(skipped, now() - startedAt); } catch (error) { reportError(error); }
      }
      return 'skipped';
    }
    running = true;
    startedAt = now();
    skipped = 0;
    try {
      const report = await ledger.scanTickAsync();
      if (deps.getLedger() !== ledger) return 'off';
      deps.onTick(report, now() - startedAt);
      if (++completed % housekeepingEvery === 0) {
        ledger.prune();
        await ledger.dropMissingCheckpointsAsync();
        if (deps.getLedger() === ledger) ledger.writeSnapshot(deps.snapshotPath);
      }
      return 'ran';
    } catch (error) {
      reportError(error);
      return 'failed';
    } finally {
      running = false;
    }
  };
}
