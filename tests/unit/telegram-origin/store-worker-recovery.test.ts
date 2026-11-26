import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { OriginStore, OriginStoreUnavailableError } from '../../../src/messaging/telegram-origin/OriginStore.js';
import type { OriginStoreOptions } from '../../../src/messaging/telegram-origin/StoreTypes.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
import { admission, compileStallableOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

// 2026-09-26: one slow boot-time request tripped the 2s timeout, fail() latched
// the store dead for the life of the process, and every Telegram send held until
// a manual restart. These tests pin the replacement: bounded self-recovery.
let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileStallableOriginWorker(); });
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  vi.restoreAllMocks();
});
const inject = (stateDir: string, name: 'stall-ms' | 'stall-n' | 'fail-starts', value: number | string) =>
  fs.writeFileSync(path.join(stateDir, `origin-worker-${name}`), String(value));
const remaining = (stateDir: string) => Number(fs.readFileSync(path.join(stateDir, 'origin-worker-fail-starts'), 'utf8'));
// Caller deadlines leave real SQLite work (a synchronous fsync) a full second
// even on a loaded machine; every injected stall sits well past the deadline it
// tests. A 100 ms deadline made real transactions time out under suite load
// (Rule 37 repair of a demonstrated flake, PR #2087 review item 3).
function options(stateDir: string, extra: Partial<OriginStoreOptions> = {}): OriginStoreOptions {
  return { stateDir, agentId: 'echo', requestTimeoutMs: 1000, stallTimeoutMs: 1500,
    restart: { baseDelayMs: 20, maxDelayMs: 200, maxAttempts: 3, healthyWindowMs: 1 }, ...extra };
}
// healthyWindowMs is 1: a response in the same millisecond the generation became
// ready is (correctly) still inside the window and does not close the episode.
const pastHealthyWindow = () => new Promise(resolve => setTimeout(resolve, 5));
// A read that waits, bounded, for the row: a read that only ran out its caller deadline is asked
// again (reads change nothing), and a row that never appears still fails the case.
async function readOrigin(store: OriginStore, originId: string, timeout = 10_000) {
  return vi.waitFor(async () => {
    const row = await store.getOrigin(originId);
    expect(row).not.toBeNull();
    return row!;
  }, { timeout, interval: 50 });
}
function quietReports() {
  return vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
}

describe('origin store worker: a slow moment never permanently silences the agent', () => {
  it('a caller deadline answers only that caller; a slow disk keeps the same worker serving', async () => {
    const stateDir = temporaryState(), report = quietReports();
    // A 3 s caller deadline and a 4.5 s stall (was 1 s and 2.5 s): the stall still outlasts the
    // deadline by half, and the re-read and the next admit below get 3 s of real work each. With
    // 1 s they hit their own deadline on a loaded host (2026-11-07..17, "origin request deadline
    // exceeded" on the re-read and on the admit that must resolve).
    const store = await OriginStore.open(options(stateDir, { requestTimeoutMs: 3000, stallTimeoutMs: 10_000 }), worker); stores.push(store);
    const slow = admission('slow-disk');
    inject(stateDir, 'stall-ms', 4500);
    const error = await store.admit(slow).catch(e => e);
    expect(error).toBeInstanceOf(OriginStoreUnavailableError);
    expect(error.mutationMayHaveCommitted).toBe(true);
    // No latch: the store never left service and no generation was replaced.
    expect(store.isUnavailable()).toBe(false);
    expect(store.health()).toMatchObject({ state: 'ready', generation: 1, restarts: 0 });
    // Reads serialize behind the slow write, so a re-read once the disk catches
    // up sees what it committed — exactly once, never replayed.
    // Wait for the committed row itself, bounded, instead of a fixed 2 s guess at when the disk
    // has caught up.
    expect((await readOrigin(store, slow.record.originId)).record.originId).toBe(slow.record.originId);
    await expect(store.admit(admission('after-slow'))).resolves.toBeTruthy();
    expect(report).not.toHaveBeenCalled();
  });

  it('replaces a stuck worker automatically; later requests succeed with no restart of the process', async () => {
    const stateDir = temporaryState(), report = quietReports();
    const store = await OriginStore.open(options(stateDir, { restart: { baseDelayMs: 300, maxDelayMs: 300, maxAttempts: 3, healthyWindowMs: 1 } }), worker); stores.push(store);
    const stuck = admission('stuck');
    inject(stateDir, 'stall-ms', 60_000);
    const error = await store.admit(stuck).catch(e => e);
    expect(error).toBeInstanceOf(OriginStoreUnavailableError);
    expect(error.mutationMayHaveCommitted).toBe(true);
    await vi.waitFor(() => expect(store.health().state).toBe('restarting'), { timeout: 5000 });
    // Fail-closed while down: nothing is admitted, and the refusal is a known non-commit.
    const refused = await store.admit(admission('while-down')).catch(e => e);
    expect(refused).toBeInstanceOf(OriginStoreUnavailableError);
    expect(refused.mutationMayHaveCommitted).toBe(false);
    expect(store.needsReplacement()).toBe(false);
    await vi.waitFor(() => expect(store.health()).toMatchObject({ state: 'ready', generation: 2 }), { timeout: 5000 });
    await pastHealthyWindow();
    await store.healthTransaction();
    const after = admission('after-recovery');
    await expect(store.admit(after)).resolves.toBeTruthy();
    expect(await store.getOrigin(after.record.originId)).not.toBeNull();
    // The unknown write is never replayed by the store: the killed generation did
    // not commit it, and the new generation was never handed it.
    expect(await store.getOrigin(stuck.record.originId)).toBeNull();
    expect(await store.getOrigin(`origin-while-down`)).toBeNull();
    const health = store.health();
    expect(health).toMatchObject({ restarts: 1, consecutiveFailures: 0, downSince: null });
    expect(health.lastFailure?.reason).toMatch(/^request-stalled: admit with no worker progress/);
    expect(health.lastRecoveredAt).not.toBeNull();
    // Loud, once: one report for the outage episode.
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0].feature).toBe('telegram-origin.store-worker');
  });

  it('a stall that keeps coming back between served responses still reaches the cap (no endless restart)', async () => {
    const stateDir = temporaryState(), report = quietReports();
    const store = await OriginStore.open(options(stateDir, { stallTimeoutMs: 1000,
      restart: { baseDelayMs: 20, maxDelayMs: 20, maxAttempts: 2, healthyWindowMs: 60_000 } }), worker); stores.push(store);
    for (let cycle = 1; cycle <= 3; cycle++) {
      inject(stateDir, 'stall-ms', 60_000);
      await store.admit(admission(`recurring-${cycle}`)).catch(() => undefined);
      await vi.waitFor(() => expect(store.health().consecutiveFailures).toBe(cycle), { timeout: 5000 });
      if (cycle < 3) {
        await vi.waitFor(() => expect(store.health().state).toBe('ready'), { timeout: 5000 });
        // Served between stalls, but inside the healthy window: the budget is not restored.
        await store.healthTransaction();
        expect(store.health().consecutiveFailures).toBe(cycle);
      }
    }
    expect(store.health().state).toBe('exhausted');
    expect(store.needsReplacement()).toBe(true);
    expect(report).toHaveBeenCalledOnce();
  });

  it('queue wait behind a progressing worker is not a stall', async () => {
    const stateDir = temporaryState(); quietReports();
    // Five slow-but-progressing operations, 900ms each, posted together: the
    // last waits ~4.5s from posting (past the 3.5s stall deadline) while the
    // worker answers every 900ms. A per-request clock would kill this worker.
    // It was three operations against a 1.5 s stall deadline, which left one 900 ms operation
    // only 600 ms of slack: on a loaded host a single answer came later than 1.5 s, the watchdog
    // (correctly) replaced the worker and the case failed (2026-11-02..14: generation 2, and the
    // last row never appearing). One answer now has 2.6 s of slack; the queue wait still exceeds
    // the stall deadline, which the elapsed-time assertion below pins.
    const stallTimeoutMs = 3500;
    const store = await OriginStore.open(options(stateDir, { stallTimeoutMs }), worker); stores.push(store);
    inject(stateDir, 'stall-n', '5,900');
    const started = Date.now();
    await Promise.all([0, 1, 2, 3, 4].map(i => store.admit(admission(`queued-${i}`)).catch(() => undefined)));
    await readOrigin(store, 'origin-queued-4', 15_000);
    expect(Date.now() - started).toBeGreaterThan(stallTimeoutMs);
    expect(store.health()).toMatchObject({ state: 'ready', generation: 1, restarts: 0 });
    for (let i = 0; i < 5; i++) expect(await readOrigin(store, `origin-queued-${i}`)).not.toBeNull();
  });

  it('within the restart cap: a failing boot generation recovers by itself, reported once', async () => {
    const stateDir = temporaryState(), report = quietReports();
    inject(stateDir, 'fail-starts', 3); // the boot generation plus two restarts fail; cap is 3
    const store = await OriginStore.openForRuntime(options(stateDir), undefined, worker); stores.push(store);
    expect(store.isUnavailable()).toBe(true);
    await vi.waitFor(() => expect(store.health().state).toBe('ready'), { timeout: 5000 });
    await pastHealthyWindow();
    // Wait, bounded, for a health transaction the worker actually served: one that only ran out
    // its 1 s caller deadline on a loaded host says nothing about recovery (2026-11-16, "origin
    // request deadline exceeded" here). The generation and restart counts below still fail if the
    // worker was replaced again in the meantime.
    await vi.waitFor(() => store.healthTransaction(), { timeout: 10_000, interval: 50 });
    expect(store.health()).toMatchObject({ generation: 4, restarts: 3, consecutiveFailures: 0, downSince: null });
    expect(remaining(stateDir)).toBe(0);
    expect(report).toHaveBeenCalledOnce();
  });

  it('past the restart cap: stops restarting, stays fail-closed, and asks for the slower replacement', async () => {
    const stateDir = temporaryState(); quietReports();
    inject(stateDir, 'fail-starts', 10);
    const store = await OriginStore.openForRuntime(options(stateDir), undefined, worker); stores.push(store);
    await vi.waitFor(() => expect(store.health().state).toBe('exhausted'), { timeout: 5000 });
    // Boot generation + three restarts, then no further spawns.
    expect(store.health()).toMatchObject({ generation: 4, restarts: 3, consecutiveFailures: 4 });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(store.health().generation).toBe(4);
    expect(remaining(stateDir)).toBe(6);
    expect(store.needsReplacement()).toBe(true);
    const refused = await store.admit(admission('exhausted')).catch(e => e);
    expect(refused).toBeInstanceOf(OriginStoreUnavailableError);
    expect(refused.mutationMayHaveCommitted).toBe(false);
    // The replacement path still works once the cause clears.
    inject(stateDir, 'fail-starts', 0);
    const replacement = await OriginStore.open(options(stateDir), worker); stores.push(replacement);
    await replacement.healthTransaction();
  });

  it('the recovery tick can ask for the next attempt now instead of waiting out the backoff', async () => {
    const stateDir = temporaryState(); quietReports();
    inject(stateDir, 'fail-starts', 1);
    const store = await OriginStore.openForRuntime(options(stateDir, { restart: { baseDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: 3, healthyWindowMs: 1 } }), undefined, worker); stores.push(store);
    expect(store.health().state).toBe('restarting');
    const started = Date.now();
    await store.restartNow();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(store.health()).toMatchObject({ state: 'ready', generation: 2 });
    await store.healthTransaction();
    // A ready store is left alone.
    await store.restartNow();
    expect(store.health().generation).toBe(2);
  });

  it('a recovery replacement inherits the spent budget and outage: no fresh burst, no second report', async () => {
    const stateDir = temporaryState(), report = quietReports();
    inject(stateDir, 'fail-starts', 3);
    const exhausted = await OriginStore.openForRuntime(options(stateDir, { restart: { baseDelayMs: 20, maxDelayMs: 20, maxAttempts: 2, healthyWindowMs: 1 } }), undefined, worker); stores.push(exhausted);
    await vi.waitFor(() => expect(exhausted.health().state).toBe('exhausted'), { timeout: 5000 });
    expect(report).toHaveBeenCalledOnce();
    // Still failing: the replacement's single attempt fails and it does not restart itself.
    inject(stateDir, 'fail-starts', 5);
    await expect(OriginStore.openReplacement(exhausted, options(stateDir, { restart: { baseDelayMs: 20, maxDelayMs: 20, maxAttempts: 2, healthyWindowMs: 1 } }), undefined, worker))
      .rejects.toBeInstanceOf(OriginStoreUnavailableError);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(remaining(stateDir)).toBe(4);
    // Cause cleared: the replacement serves, which alone restores the budget and closes the episode.
    inject(stateDir, 'fail-starts', 0);
    const replacement = await OriginStore.openReplacement(exhausted, options(stateDir, { restart: { baseDelayMs: 20, maxDelayMs: 20, maxAttempts: 2, healthyWindowMs: 1 } }), undefined, worker); stores.push(replacement);
    expect(replacement.health()).toMatchObject({ state: 'ready', consecutiveFailures: 3 });
    expect(replacement.health().downSince).not.toBeNull();
    await pastHealthyWindow();
    await replacement.healthTransaction();
    expect(replacement.health()).toMatchObject({ consecutiveFailures: 0, downSince: null });
    expect(report).toHaveBeenCalledOnce();
  });

  it('a deliberately closed store never restarts itself', async () => {
    const stateDir = temporaryState(), report = quietReports();
    const store = await OriginStore.open(options(stateDir), worker);
    await store.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(store.health()).toMatchObject({ state: 'closed', generation: 1, restarts: 0 });
    expect(store.needsReplacement()).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });

  it('a failed standalone open does not leave restarts running behind the caller', async () => {
    const stateDir = temporaryState(); quietReports();
    inject(stateDir, 'fail-starts', 1);
    await expect(OriginStore.open(options(stateDir), worker)).rejects.toBeInstanceOf(OriginStoreUnavailableError);
    inject(stateDir, 'fail-starts', 5);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(remaining(stateDir)).toBe(5);
  });

  it('rejects restart and stall policies that could spin or undercut the caller deadline', async () => {
    const stateDir = temporaryState();
    await expect(OriginStore.open(options(stateDir, { requestTimeoutMs: 1000, stallTimeoutMs: 500 }), worker)).rejects.toThrow('invalid-stall-timeout');
    await expect(OriginStore.open(options(stateDir, { restart: { baseDelayMs: 0 } }), worker)).rejects.toThrow('invalid-restart-policy');
    await expect(OriginStore.open(options(stateDir, { restart: { maxAttempts: 1000 } }), worker)).rejects.toThrow('invalid-restart-policy');
  });
});
