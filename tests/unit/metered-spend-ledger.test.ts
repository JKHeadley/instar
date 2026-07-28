// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Unit tests — MeteredSpendLedger (routing-control-room-spend Increment B, Layer 3).
 *
 * Pins the spec's money-truth invariants:
 *  - reserve/settle/expire idempotent terminal state machine (first terminal wins);
 *  - outstanding reserves are INSIDE the committed total (two-concurrent-reserves);
 *  - expiry-aware late settle books ACTUAL as an absolute row (never under-counts);
 *  - torn-write recovery both directions (append-without-totals is repaired from
 *    row truth; totals-without-append is impossible by ordering — asserted);
 *  - malformed trailing row is skipped (torn append), not fatal;
 *  - fail-closed non-swallowing writes (an unwritable rows file refuses the booking);
 *  - UTC-day rollover resets the day figure, never lifetime.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MeteredSpendLedger, MeteredLedgerWriteError } from '../../src/core/MeteredSpendLedger.js';

let dir: string;
let clock: number;

const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msl-'));
  clock = Date.parse('2026-07-08T10:00:00Z');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/metered-spend-ledger.test.ts' });
});

const mk = (ttlMs?: number) => new MeteredSpendLedger({ stateDir: dir, reserveTtlMs: ttlMs, now });
const rowsPath = () => path.join(dir, 'state', 'metered-spend-ledger.jsonl');
const totalsPath = () => path.join(dir, 'state', 'metered-spend-totals.json');

describe('MeteredSpendLedger', () => {
  it('books a reserve into the committed total and settles to actual', async () => {
    const l = mk();
    const h = await l.reserve({ keyRef: 'k1', door: 'openrouter-api', modelId: 'm', reserveUsd: 0.5, leaseEpoch: 1 });
    expect(h.committedLifetimeUsd).toBeCloseTo(0.5, 6);
    expect(l.committed('k1').committedDayUsd).toBeCloseTo(0.5, 6);
    await l.settle('k1', h.reserveId, 0.2);
    expect(l.committed('k1').committedLifetimeUsd).toBeCloseTo(0.2, 6);
    expect(l.committed('k1').committedDayUsd).toBeCloseTo(0.2, 6);
  });

  it('two concurrent reserves see each other (outstanding reserves are inside committed)', async () => {
    const l = mk();
    const [a, b] = await Promise.all([
      l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 1.0, leaseEpoch: 1 }),
      l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 2.0, leaseEpoch: 1 }),
    ]);
    // Whichever booked second saw the first's reservation in its running total.
    const totals = [a.committedLifetimeUsd, b.committedLifetimeUsd].sort((x, y) => x - y);
    expect(totals[0]).toBeGreaterThanOrEqual(1.0);
    expect(totals[1]).toBeCloseTo(3.0, 6);
    expect(l.committed('k1').committedLifetimeUsd).toBeCloseTo(3.0, 6);
  });

  it('settle is idempotent — the second terminal transition is a no-op', async () => {
    const l = mk();
    const h = await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 1.0, leaseEpoch: 1 });
    await l.settle('k1', h.reserveId, 0.3);
    await l.settle('k1', h.reserveId, 99); // loser — must be a no-op
    expect(l.committed('k1').committedLifetimeUsd).toBeCloseTo(0.3, 6);
  });

  it('reserve-expiry sweep expires only TTL-stale reserves; a late settle books ACTUAL as an absolute row', async () => {
    const l = mk(1000);
    const h = await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 1.0, leaseEpoch: 1 });
    const fresh = await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 0.4, leaseEpoch: 1 });
    clock += 2000; // only h is past TTL? No — both are. Re-reserve fresh after advancing:
    const fresher = await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 0.25, leaseEpoch: 1 });
    const expired = await l.sweepExpired();
    expect(expired).toBe(2); // h + fresh (past TTL); fresher survives
    expect(l.committed('k1').committedLifetimeUsd).toBeCloseTo(0.25, 6);
    // Late settle after expiry books the ACTUAL cost — never under-counts.
    await l.settle('k1', h.reserveId, 0.15);
    expect(l.committed('k1').committedLifetimeUsd).toBeCloseTo(0.4, 6);
    void fresher;
    void fresh;
  });

  it('no-charge settle ($0) releases the reservation', async () => {
    const l = mk();
    const h = await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 2.0, leaseEpoch: 1 });
    await l.settle('k1', h.reserveId, 0);
    expect(l.committed('k1').committedLifetimeUsd).toBe(0);
  });

  it('torn direction 1: append-without-totals is repaired from row truth on the next construction', async () => {
    const l = mk();
    await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 1.5, leaseEpoch: 1 });
    // Simulate the crash window: totals file vanishes after the fsync'd append.
    SafeFsExecutor.safeRmSync(totalsPath(), { force: true, operation: 'tests/unit/metered-spend-ledger.test.ts:torn-totals' });
    const l2 = new MeteredSpendLedger({ stateDir: dir, now });
    expect(l2.committed('k1').committedLifetimeUsd).toBeCloseTo(1.5, 6);
    expect(fs.existsSync(totalsPath())).toBe(true); // boot rewrote the cache from the fold
  });

  it('torn direction 2: a stale totals cache NEVER wins over row truth (rows are canon)', async () => {
    const l = mk();
    const h = await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 1.0, leaseEpoch: 1 });
    await l.settle('k1', h.reserveId, 0.1);
    // Corrupt the CACHE to claim a lower committed figure.
    fs.writeFileSync(totalsPath(), JSON.stringify({ rowsBytes: 1, totals: { k1: { keyRef: 'k1', committedLifetimeUsd: 0, committedDayUsd: 0, dayEpoch: '2026-07-08', updatedAt: 'x' } } }));
    const l2 = new MeteredSpendLedger({ stateDir: dir, now });
    expect(l2.committed('k1').committedLifetimeUsd).toBeCloseTo(0.1, 6); // fold wins
  });

  it('a torn trailing append (partial JSON line) is skipped, earlier rows survive', async () => {
    const l = mk();
    await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 0.7, leaseEpoch: 1 });
    fs.appendFileSync(rowsPath(), '{"ts":"2026-07-08T10:01:00Z","keyRef":"k1","door":"d","mo'); // torn
    const l2 = new MeteredSpendLedger({ stateDir: dir, now });
    expect(l2.committed('k1').committedLifetimeUsd).toBeCloseTo(0.7, 6);
  });

  it('an EXTERNAL append is caught by the high-water check on the next committed() read', async () => {
    const l = mk();
    await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 0.5, leaseEpoch: 1 });
    // Another process appends a settle row behind our back.
    const externallySettled = JSON.parse(fs.readFileSync(rowsPath(), 'utf-8').trim().split('\n')[0]).reserveId as string;
    fs.appendFileSync(rowsPath(), JSON.stringify({ ts: new Date(clock).toISOString(), keyRef: 'k1', door: 'd', modelId: 'm', kind: 'settle', reserveId: externallySettled, costUsd: 0.05, leaseEpoch: 1 }) + '\n');
    expect(l.committed('k1').committedLifetimeUsd).toBeCloseTo(0.05, 6);
  });

  it('fail-closed non-swallowing: an unwritable rows path refuses the booking', async () => {
    const l = mk();
    await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 0.1, leaseEpoch: 1 });
    // Replace the rows file with a DIRECTORY so the append open fails.
    SafeFsExecutor.safeRmSync(rowsPath(), { force: true, operation: 'tests/unit/metered-spend-ledger.test.ts:unwritable-path' });
    fs.mkdirSync(rowsPath());
    await expect(l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 0.1, leaseEpoch: 1 })).rejects.toBeInstanceOf(MeteredLedgerWriteError);
  });

  it('UTC-day rollover resets the day figure, never lifetime', async () => {
    const l = mk();
    await l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: 1.0, leaseEpoch: 1 });
    expect(l.committed('k1').committedDayUsd).toBeCloseTo(1.0, 6);
    clock += 24 * 60 * 60 * 1000; // next UTC day
    const t = l.committed('k1');
    expect(t.committedDayUsd).toBe(0);
    expect(t.committedLifetimeUsd).toBeCloseTo(1.0, 6);
  });

  it('rejects invalid reserve/settle amounts', async () => {
    const l = mk();
    await expect(l.reserve({ keyRef: 'k1', door: 'd', modelId: 'm', reserveUsd: -1, leaseEpoch: 1 })).rejects.toBeInstanceOf(MeteredLedgerWriteError);
    await expect(l.settle('k1', 'nope', Number.NaN)).rejects.toBeInstanceOf(MeteredLedgerWriteError);
  });
});
