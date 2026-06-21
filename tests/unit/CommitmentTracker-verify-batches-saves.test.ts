/**
 * Regression test for the event-loop WEDGE fix (2026-06-21).
 *
 * Bug: CommitmentTracker.verify() iterates every active commitment and mutates
 * each via mutateSync(), and EVERY mutateSync() called saveStore(), which
 * JSON.stringify()s the ENTIRE store. With a large store (~1.6MB / ~1700
 * commitments) and N active commitments that was O(N) full-store serializations
 * per 60s sweep — minutes of synchronous work that froze the single event-loop
 * thread (observed live: /health HTTP 000, watchdog SIGKILL/respawn loop).
 *
 * Fix: verify() runs the whole sweep under `batchingSaves`, so the per-mutation
 * saveStore() calls are coalesced into exactly ONE write at the end of the sweep.
 *
 * This test asserts the store is persisted ONCE per verify() sweep regardless of
 * how many commitments are mutated — the structural guarantee that prevents the
 * O(N) blow-up from regressing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createTmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-batch-'));
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ updates: { autoApply: true } }, null, 2));
  return {
    stateDir,
    cleanup: () => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/CommitmentTracker-verify-batches-saves.test.ts' }),
  };
}

/** Count writes to the commitments store file (its atomic tmp path), excluding the meta sidecar. */
function isStoreWrite(p: unknown): boolean {
  return typeof p === 'string' && /commitments\.json\.\d+\.tmp$/.test(p);
}

describe('CommitmentTracker.verify() batches store saves (wedge fix)', () => {
  let stateDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ stateDir, cleanup } = createTmpState());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('persists the store exactly ONCE per verify() sweep, not once per commitment', () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });

    // N behavioral commitments: verify() will mutate each (pending -> verified)
    // via mutateSync(), so the pre-fix code would have written the store N times.
    const N = 40;
    for (let i = 0; i < N; i++) {
      tracker.record({
        userRequest: `rule ${i}`,
        agentResponse: 'ok',
        type: 'behavioral',
        behavioralRule: `Always do thing number ${i}`,
      });
    }

    const realWrite = fs.writeFileSync.bind(fs);
    let storeWrites = 0;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (isStoreWrite(p)) storeWrites++;
      return (realWrite as any)(p, ...rest);
    }) as typeof fs.writeFileSync);

    // Reset after setup — record() above writes the store per insert.
    storeWrites = 0;

    tracker.verify();

    spy.mockRestore();

    // The whole sweep mutated all N commitments but must persist the store ONCE.
    expect(storeWrites).toBe(1);
  });

  it('still persists a normal single mutate immediately (no batching outside a sweep)', async () => {
    const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
    const c = tracker.record({ userRequest: 'x', agentResponse: 'ok', type: 'behavioral', behavioralRule: 'do x' });

    const realWrite = fs.writeFileSync.bind(fs);
    let storeWrites = 0;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: any, ...rest: any[]) => {
      if (isStoreWrite(p)) storeWrites++;
      return (realWrite as any)(p, ...rest);
    }) as typeof fs.writeFileSync);

    await tracker.mutate(c.id, cur => ({ ...cur, verificationCount: cur.verificationCount + 1 }));

    spy.mockRestore();
    // A lone mutate outside verify() persists immediately (batching is sweep-scoped).
    expect(storeWrites).toBe(1);
  });
});
