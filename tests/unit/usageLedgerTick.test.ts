/**
 * usageLedgerTick — the rules of the server's once-a-minute usage-ledger drive,
 * tested by behaviour: one tick at a time, a stuck listing is reported, a failed
 * tick frees the slot, housekeeping on completed ticks, and nothing is done for
 * a ledger that was closed or replaced while the tick was listing.
 */
import { describe, it, expect } from 'vitest';
import { createUsageLedgerTick, type UsageLedgerTickLedger } from '../../src/monitoring/usageLedgerTick.js';
import type { ScanReport } from '../../src/monitoring/UsageLedger.js';

const report = (filesRead = 0): ScanReport => ({ filesRead, rowsInserted: 0, rowsCounted: 0, pending: 0 });
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fakeLedger(scan: () => Promise<ScanReport>): UsageLedgerTickLedger & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    scanTickAsync: () => { calls.push('scan'); return scan(); },
    prune: () => { calls.push('prune'); },
    dropMissingCheckpointsAsync: async () => { calls.push('drop'); return 0; },
    writeSnapshot: (p: string) => { calls.push(`snapshot:${p}`); },
  };
}
function harness(ledger: UsageLedgerTickLedger | null, extra: { housekeepingEvery?: number; stuckAfterSkips?: number } = {}) {
  const seen = { ticks: [] as Array<{ report: ScanReport; tickMs: number }>, errors: [] as unknown[], stuck: [] as Array<{ skipped: number; runningMs: number }> };
  const state = { ledger, now: 1_000_000 };
  const tick = createUsageLedgerTick({
    getLedger: () => state.ledger,
    snapshotPath: '/snap.db',
    onTick: (rep, tickMs) => seen.ticks.push({ report: rep, tickMs }),
    onError: (error) => seen.errors.push(error),
    onStuck: (skipped, runningMs) => seen.stuck.push({ skipped, runningMs }),
    now: () => state.now,
    ...extra,
  });
  return { tick, seen, state };
}

describe('createUsageLedgerTick', () => {
  it('runs a tick, reports it with its duration, and does no housekeeping before its turn', async () => {
    const ledger = fakeLedger(async () => report(3));
    const { tick, seen } = harness(ledger);
    expect(await tick()).toBe('ran');
    expect(seen.ticks).toEqual([{ report: report(3), tickMs: 0 }]);
    expect(ledger.calls).toEqual(['scan']);
  });

  it('does nothing when the ledger is off', async () => {
    const { tick, seen } = harness(null);
    expect(await tick()).toBe('off');
    expect(seen.ticks).toEqual([]);
  });

  it('skips a tick while one is running, and starts again once it ends', async () => {
    const gate = deferred<ScanReport>();
    let scans = 0;
    const ledger = fakeLedger(() => { scans++; return scans === 1 ? gate.promise : Promise.resolve(report()); });
    const { tick } = harness(ledger);
    const first = tick();
    expect(await tick()).toBe('skipped');
    expect(await tick()).toBe('skipped');
    expect(scans).toBe(1);
    gate.resolve(report(1));
    expect(await first).toBe('ran');
    expect(await tick()).toBe('ran');
    expect(scans).toBe(2);
  });

  it('reports a listing that does not end: at the fifth skipped tick and every fifth after, with how long it has run', async () => {
    const gate = deferred<ScanReport>();
    const { tick, seen, state } = harness(fakeLedger(() => gate.promise));
    const first = tick();
    for (let minute = 1; minute <= 11; minute++) {
      state.now += 60_000;
      await tick();
    }
    expect(seen.stuck).toEqual([{ skipped: 5, runningMs: 300_000 }, { skipped: 10, runningMs: 600_000 }]);
    gate.resolve(report());
    await first;
    // The count starts over with the next run.
    const again = deferred<ScanReport>();
    const { tick: tick2, seen: seen2 } = harness(fakeLedger(() => again.promise), { stuckAfterSkips: 2 });
    void tick2(); await tick2(); await tick2(); await tick2();
    expect(seen2.stuck.map((row) => row.skipped)).toEqual([2]);
    again.resolve(report());
  });

  it('a tick that fails reports the error and frees the slot', async () => {
    let scans = 0;
    const ledger = fakeLedger(() => { scans++; return scans === 1 ? Promise.reject(new Error('disk gone')) : Promise.resolve(report()); });
    const { tick, seen } = harness(ledger);
    expect(await tick()).toBe('failed');
    expect((seen.errors[0] as Error).message).toBe('disk gone');
    expect(seen.ticks).toEqual([]);
    expect(await tick()).toBe('ran');
  });

  it('a failure in housekeeping is reported and frees the slot too', async () => {
    const ledger = fakeLedger(async () => report());
    ledger.prune = () => { throw new Error('prune failed'); };
    const { tick, seen } = harness(ledger, { housekeepingEvery: 1 });
    expect(await tick()).toBe('failed');
    expect((seen.errors[0] as Error).message).toBe('prune failed');
    ledger.prune = () => { ledger.calls.push('prune'); };
    expect(await tick()).toBe('ran');
  });

  it('runs prune, the checkpoint cleanup and the snapshot, in that order, on every Nth completed tick only', async () => {
    const ledger = fakeLedger(async () => report());
    const { tick } = harness(ledger, { housekeepingEvery: 3 });
    for (let index = 0; index < 6; index++) await tick();
    expect(ledger.calls).toEqual([
      'scan', 'scan', 'scan', 'prune', 'drop', 'snapshot:/snap.db',
      'scan', 'scan', 'scan', 'prune', 'drop', 'snapshot:/snap.db',
    ]);
  });

  it('a skipped or failed tick does not count towards housekeeping', async () => {
    let fail = true;
    const ledger = fakeLedger(() => (fail ? Promise.reject(new Error('x')) : Promise.resolve(report())));
    const { tick } = harness(ledger, { housekeepingEvery: 2 });
    await tick(); await tick();
    fail = false;
    await tick();
    expect(ledger.calls.filter((call) => call === 'prune')).toEqual([]);
    await tick();
    expect(ledger.calls.filter((call) => call === 'prune')).toEqual(['prune']);
  });

  it('records nothing and does no housekeeping for a ledger closed or replaced while it was listing', async () => {
    const gate = deferred<ScanReport>();
    const ledger = fakeLedger(() => gate.promise);
    const { tick, seen, state } = harness(ledger, { housekeepingEvery: 1 });
    const pending = tick();
    state.ledger = null; // the server stopped
    gate.resolve(report(2));
    expect(await pending).toBe('off');
    expect(seen.ticks).toEqual([]);
    expect(ledger.calls).toEqual(['scan']);
  });

  it('never rejects, even when a reporting callback throws', async () => {
    const gate = deferred<ScanReport>();
    const seen: unknown[] = [];
    const tick = createUsageLedgerTick({
      getLedger: () => ledger, snapshotPath: '/snap.db', stuckAfterSkips: 1,
      onTick: () => { throw new Error('evidence store down'); },
      onStuck: () => { throw new Error('stuck reporter down'); },
      onError: (error) => { seen.push(error); throw new Error('error reporter down'); },
    });
    const ledger = fakeLedger(() => gate.promise);
    const first = tick();
    await expect(tick()).resolves.toBe('skipped');
    gate.resolve(report());
    await expect(first).resolves.toBe('failed');
    expect(seen.map((error) => (error as Error).message)).toEqual(['stuck reporter down', 'evidence store down']);
    await expect(tick()).resolves.toBe('failed'); // the slot was freed
  });

  it('does not write the snapshot when the ledger goes away during the checkpoint cleanup', async () => {
    const ledger = fakeLedger(async () => report());
    const { tick, state } = harness(ledger, { housekeepingEvery: 1 });
    ledger.dropMissingCheckpointsAsync = async () => { ledger.calls.push('drop'); state.ledger = null; return 0; };
    expect(await tick()).toBe('ran');
    expect(ledger.calls).toEqual(['scan', 'prune', 'drop']);
  });
});
