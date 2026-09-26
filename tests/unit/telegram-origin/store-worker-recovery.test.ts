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
function options(stateDir: string, extra: Partial<OriginStoreOptions> = {}): OriginStoreOptions {
  return { stateDir, agentId: 'echo', requestTimeoutMs: 100, stallTimeoutMs: 600,
    restart: { baseDelayMs: 20, maxDelayMs: 200, maxAttempts: 3, healthyWindowMs: 1 }, ...extra };
}
function quietReports() {
  return vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
}

describe('origin store worker: a slow moment never permanently silences the agent', () => {
  it('a caller deadline answers only that caller; a slow disk keeps the same worker serving', async () => {
    const stateDir = temporaryState(), report = quietReports();
    const store = await OriginStore.open(options(stateDir, { requestTimeoutMs: 100, stallTimeoutMs: 5000 }), worker); stores.push(store);
    const slow = admission('slow-disk');
    inject(stateDir, 'stall-ms', 600);
    const error = await store.admit(slow).catch(e => e);
    expect(error).toBeInstanceOf(OriginStoreUnavailableError);
    expect(error.mutationMayHaveCommitted).toBe(true);
    // No latch: the store never left service and no generation was replaced.
    expect(store.isUnavailable()).toBe(false);
    expect(store.health()).toMatchObject({ state: 'ready', generation: 1, restarts: 0 });
    // Reads serialize behind the slow write, so a re-read once the disk catches
    // up sees what it committed — exactly once, never replayed.
    await new Promise(resolve => setTimeout(resolve, 700));
    expect((await store.getOrigin(slow.record.originId))?.record.originId).toBe(slow.record.originId);
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
    await vi.waitFor(() => expect(store.health().state).toBe('restarting'), { timeout: 3000 });
    // Fail-closed while down: nothing is admitted, and the refusal is a known non-commit.
    const refused = await store.admit(admission('while-down')).catch(e => e);
    expect(refused).toBeInstanceOf(OriginStoreUnavailableError);
    expect(refused.mutationMayHaveCommitted).toBe(false);
    expect(store.needsReplacement()).toBe(false);
    await vi.waitFor(() => expect(store.health()).toMatchObject({ state: 'ready', generation: 2 }), { timeout: 3000 });
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
    const store = await OriginStore.open(options(stateDir, { stallTimeoutMs: 300,
      restart: { baseDelayMs: 20, maxDelayMs: 20, maxAttempts: 2, healthyWindowMs: 60_000 } }), worker); stores.push(store);
    for (let cycle = 1; cycle <= 3; cycle++) {
      inject(stateDir, 'stall-ms', 60_000);
      await store.admit(admission(`recurring-${cycle}`)).catch(() => undefined);
      await vi.waitFor(() => expect(store.health().consecutiveFailures).toBe(cycle), { timeout: 3000 });
      if (cycle < 3) {
        await vi.waitFor(() => expect(store.health().state).toBe('ready'), { timeout: 3000 });
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
    const store = await OriginStore.open(options(stateDir, { requestTimeoutMs: 100, stallTimeoutMs: 600 }), worker); stores.push(store);
    // Three slow-but-progressing operations, 400ms each, posted together: the
    // last waits ~1.2s from posting (past the 600ms stall deadline) while the
    // worker answers every 400ms. A per-request clock would kill this worker.
    inject(stateDir, 'stall-n', '3,400');
    const started = Date.now();
    await Promise.all([0, 1, 2].map(i => store.admit(admission(`queued-${i}`)).catch(() => undefined)));
    await vi.waitFor(async () => expect(await store.getOrigin('origin-queued-2').catch(() => null)).not.toBeNull(), { timeout: 5000, interval: 50 });
    expect(Date.now() - started).toBeGreaterThan(1000);
    expect(store.health()).toMatchObject({ state: 'ready', generation: 1, restarts: 0 });
    for (let i = 0; i < 3; i++) expect(await store.getOrigin(`origin-queued-${i}`)).not.toBeNull();
  });

  it('within the restart cap: a failing boot generation recovers by itself, reported once', async () => {
    const stateDir = temporaryState(), report = quietReports();
    inject(stateDir, 'fail-starts', 3); // the boot generation plus two restarts fail; cap is 3
    const store = await OriginStore.openForRuntime(options(stateDir), undefined, worker); stores.push(store);
    expect(store.isUnavailable()).toBe(true);
    await vi.waitFor(() => expect(store.health().state).toBe('ready'), { timeout: 5000 });
    await store.healthTransaction();
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
