/**
 * Bounded Accumulation §4 — the poller drives TokenLedger.pruneToRetention on a
 * SUB-cadence (the scan runs every intervalMs; the prune only every
 * retentionPruneIntervalMs), and drains a backlog (more=true) across ticks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenLedgerPoller } from '../../src/monitoring/TokenLedgerPoller.js';

function fakeLedger(pruneReturn: { deleted: number; more: boolean } = { deleted: 0, more: false }) {
  return {
    scanAllAsync: vi.fn(() => Promise.resolve(0)),
    pruneToRetention: vi.fn(() => pruneReturn),
  } as unknown as import('../../src/monitoring/TokenLedger.js').TokenLedger;
}

describe('TokenLedgerPoller — retention prune sub-cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('prunes once initially, then only after the sub-cadence elapses (not every scan tick)', async () => {
    let now = 1_700_000_000_000;
    const ledger = fakeLedger();
    const p = new TokenLedgerPoller({ ledger, intervalMs: 1_000, retentionPruneIntervalMs: 10_000, now: () => now });
    p.start();
    await vi.advanceTimersByTimeAsync(0); // immediate first tick @ now0
    expect(ledger.pruneToRetention).toHaveBeenCalledTimes(1);
    // 8 scan ticks within the 10s prune window → no extra prune
    for (let i = 0; i < 8; i++) { now += 1_000; await vi.advanceTimersByTimeAsync(1_000); }
    expect(ledger.pruneToRetention).toHaveBeenCalledTimes(1);
    // cross the prune interval (now0 + 10_000) → prune again
    now += 2_000; await vi.advanceTimersByTimeAsync(1_000);
    expect(ledger.pruneToRetention).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('drains a backlog: while prune reports more=true, every tick prunes again', async () => {
    let now = 1_700_000_000_000;
    const ledger = fakeLedger({ deleted: 5000, more: true });
    const p = new TokenLedgerPoller({ ledger, intervalMs: 1_000, retentionPruneIntervalMs: 10_000, now: () => now });
    p.start();
    await vi.advanceTimersByTimeAsync(0); // tick 1 → prune (more:true → draining)
    expect(ledger.pruneToRetention).toHaveBeenCalledTimes(1);
    now += 1_000; await vi.advanceTimersByTimeAsync(1_000); // tick 2, within interval but draining → prune
    expect(ledger.pruneToRetention).toHaveBeenCalledTimes(2);
    now += 1_000; await vi.advanceTimersByTimeAsync(1_000); // tick 3, still draining → prune
    expect(ledger.pruneToRetention).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('a prune error is reported and never throws out of the tick (fail-open)', async () => {
    let now = 1_700_000_000_000;
    const errors: unknown[] = [];
    const ledger = {
      scanAllAsync: vi.fn(() => Promise.resolve(0)),
      pruneToRetention: vi.fn(() => { throw new Error('boom'); }),
    } as unknown as import('../../src/monitoring/TokenLedger.js').TokenLedger;
    const p = new TokenLedgerPoller({
      ledger, intervalMs: 1_000, retentionPruneIntervalMs: 10_000, now: () => now,
      onError: (e) => errors.push(e),
    });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.length).toBe(1);
    // and the poller keeps ticking (scan still runs next interval)
    (ledger.scanAllAsync as ReturnType<typeof vi.fn>).mockClear();
    now += 1_000; await vi.advanceTimersByTimeAsync(1_000);
    expect(ledger.scanAllAsync).toHaveBeenCalledTimes(1);
    p.stop();
  });
});
