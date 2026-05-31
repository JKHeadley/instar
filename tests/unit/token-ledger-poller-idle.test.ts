/**
 * TokenLedgerPoller idle-aware cadence wiring (Responsible Resource Usage):
 * with `isIdle` provided, the poller backs off the JSONL scan while idle and
 * runs at full cadence while active. Without it, the prior fixed cadence holds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenLedgerPoller } from '../../src/monitoring/TokenLedgerPoller.js';

function fakeLedger() {
  return { scanAllAsync: vi.fn(() => Promise.resolve(0)) } as unknown as import('../../src/monitoring/TokenLedger.js').TokenLedger;
}

describe('TokenLedgerPoller — idle-aware cadence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('backs off the scan while idle (no active-interval scans)', async () => {
    const ledger = fakeLedger();
    const p = new TokenLedgerPoller({ ledger, intervalMs: 1_000, idleIntervalMs: 60_000, isIdle: () => true });
    p.start();
    await vi.advanceTimersByTimeAsync(0); // drain the immediate microtask tick
    (ledger.scanAllAsync as ReturnType<typeof vi.fn>).mockClear(); // ignore the eager first scan
    await vi.advanceTimersByTimeAsync(5_000); // 5s < idleIntervalMs(60s)
    expect(ledger.scanAllAsync).not.toHaveBeenCalled(); // backed off — no scan yet
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ledger.scanAllAsync).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('runs at full cadence while active', async () => {
    const ledger = fakeLedger();
    const p = new TokenLedgerPoller({ ledger, intervalMs: 1_000, idleIntervalMs: 60_000, isIdle: () => false });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    (ledger.scanAllAsync as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ledger.scanAllAsync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ledger.scanAllAsync).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('without isIdle keeps the prior fixed cadence', async () => {
    const ledger = fakeLedger();
    const p = new TokenLedgerPoller({ ledger, intervalMs: 1_000 });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    (ledger.scanAllAsync as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ledger.scanAllAsync).toHaveBeenCalledTimes(1);
    p.stop();
  });
});
