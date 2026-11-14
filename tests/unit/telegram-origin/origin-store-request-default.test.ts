import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import {
  ORIGIN_STORE_REQUEST_TIMEOUT_MS, resolveOriginStoreRequestTimeout, setOriginStoreRequestTimeoutProcessDefault,
} from '../../../src/messaging/telegram-origin/OriginStageDeadlines.js';
import { admission, compileStallableOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

// The store's per-request deadline (2 s in production) has a process-wide default that
// tests/vitest-setup.ts lifts for every test file: beside a full suite a healthy worker can
// take longer than 2 s to answer, and tests that were not testing timing failed on it
// (2026-11-13: recovery-fairness, recovery-review-budget, forward-on-standby).
let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileStallableOriginWorker(); });
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  setOriginStoreRequestTimeoutProcessDefault(20_000); // what the suite setup file sets
});
const restart = { baseDelayMs: 20, maxDelayMs: 200, maxAttempts: 3, healthyWindowMs: 1 };

describe('origin store request deadline: process default', () => {
  it('resolves to the store\'s own option, else the process default, else the production 2 s', () => {
    setOriginStoreRequestTimeoutProcessDefault(null);
    expect(resolveOriginStoreRequestTimeout()).toBe(ORIGIN_STORE_REQUEST_TIMEOUT_MS);
    expect(ORIGIN_STORE_REQUEST_TIMEOUT_MS).toBe(2000);
    setOriginStoreRequestTimeoutProcessDefault(7000);
    expect(resolveOriginStoreRequestTimeout()).toBe(7000);
    expect(resolveOriginStoreRequestTimeout(300)).toBe(300);
    // An explicit option is passed through even when it is bad: the store itself refuses it.
    expect(resolveOriginStoreRequestTimeout(0)).toBe(0);
  });

  it('an invalid default is ignored: it never widens or removes the deadline', () => {
    for (const bad of [0, -1, 1.5, 30_001, Number.NaN, Number.POSITIVE_INFINITY, '5000' as unknown as number]) {
      setOriginStoreRequestTimeoutProcessDefault(7000);
      setOriginStoreRequestTimeoutProcessDefault(bad);
      expect(resolveOriginStoreRequestTimeout(), String(bad)).toBe(2000);
    }
  });

  // Read the latched value rather than racing a stalled worker against a clock: a timing test of
  // the deadline would be one more test that fails on a loaded machine.
  const latched = (store: OriginStore) => (store as unknown as { timeoutMs: number }).timeoutMs;
  const open = async (extra: { requestTimeoutMs?: number } = {}) => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo', stallTimeoutMs: 30_000, restart, ...extra }, worker);
    stores.push(store);
    return store;
  };

  it('a store opened without a deadline latches the process default; with none set, the production 2 s', async () => {
    setOriginStoreRequestTimeoutProcessDefault(7000);
    expect(latched(await open())).toBe(7000);
    setOriginStoreRequestTimeoutProcessDefault(null);
    expect(latched(await open())).toBe(2000);
    // And the store works at the lifted default.
    setOriginStoreRequestTimeoutProcessDefault(20_000);
    const store = await open();
    expect(latched(store)).toBe(20_000);
    await expect(store.admit(admission('lifted-default'))).resolves.toBeTruthy();
  });

  it('a store opened with its own deadline keeps it, whatever the process default', async () => {
    setOriginStoreRequestTimeoutProcessDefault(300);
    expect(latched(await open({ requestTimeoutMs: 15_000 }))).toBe(15_000);
  });

  it('a default set after a store is open does not change that store', async () => {
    setOriginStoreRequestTimeoutProcessDefault(9000);
    const store = await open();
    setOriginStoreRequestTimeoutProcessDefault(1000);
    expect(latched(store)).toBe(9000);
  });

  it('a store still refuses a bad explicit deadline, default or not', async () => {
    setOriginStoreRequestTimeoutProcessDefault(20_000);
    await expect(OriginStore.open({ stateDir: temporaryState(), agentId: 'echo', requestTimeoutMs: 30_001 }, worker)).rejects.toThrow(/origin-store:invalid-timeout/);
  });

  it('nothing under src/ calls the setter: production keeps the 2 s deadline', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(entry.name) || full.endsWith(path.join('telegram-origin', 'OriginStageDeadlines.ts'))) continue;
        if (fs.readFileSync(full, 'utf8').includes('setOriginStoreRequestTimeoutProcessDefault')) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(path.resolve('src'));
    expect(offenders).toEqual([]);
  });
});
