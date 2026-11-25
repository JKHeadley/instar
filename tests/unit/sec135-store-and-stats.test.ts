/**
 * SEC-135 (docs/specs/sec135-approval-link-guess-bound.md, Tests: storage and counters; owner paths at
 * the token cap): PinAttemptStore.recordFailures charges several keys in one write; the confirm
 * counters flush at most once a minute and report `unknown` when unreadable; the token store's owner
 * allowance and eviction rules.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PinAttemptStore, GLOBAL_PIN_KEY } from '../../src/core/PinAttemptStore.js';
import { ConfirmStats, confirmStatsFile } from '../../src/recommended/confirmStats.js';
import { ConfirmTokenStore, ConfirmTokensFullError, MAX_MINTS_PER_MINUTE, confirmTokensFile, type ConfirmBinding } from '../../src/recommended/confirmTokens.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir = '';
const fresh = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec135-')); return dir; };
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec135-store-and-stats.test.ts cleanup' });
  dir = '';
});

describe('PinAttemptStore.recordFailures', () => {
  it('charges every key in one persist and returns each key\'s remaining count', () => {
    const store = new PinAttemptStore({ stateDir: fresh() });
    const writes = vi.spyOn(fs, 'writeFileSync');
    const remaining = store.recordFailures([{ key: '198.51.100.1' }, { key: GLOBAL_PIN_KEY, max: 20 }, { key: 'req:abc', max: 5 }]);
    expect(writes).toHaveBeenCalledTimes(1);
    expect([...remaining]).toEqual([['198.51.100.1', 4], [GLOBAL_PIN_KEY, 19], ['req:abc', 4]]);
    for (let i = 0; i < 4; i++) store.recordFailures([{ key: 'req:abc', max: 5 }]);
    expect(store.blocked('req:abc', 5)).toBe(true);
    expect(store.recordFailure('x')).toBe(4); // the single-key call is unchanged
  });

  it('keeps the counts in memory when the write fails', () => {
    const store = new PinAttemptStore({ stateDir: fresh() });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk full'); });
    for (let i = 0; i < 5; i++) store.recordFailures([{ key: 'req:k', max: 5 }]);
    expect(store.blocked('req:k', 5)).toBe(true);
  });
});

describe('ConfirmStats', () => {
  it('flushes at most once a minute, and reports the in-memory counters before the first flush', () => {
    let now = 1_000_000;
    const stats = new ConfirmStats({ stateDir: fresh(), now: () => now });
    expect(stats.report()).toMatchObject({ publicPathRefused: 0 });
    const writes = vi.spyOn(fs, 'writeFileSync');
    stats.recordPublicRefused(); // first event writes at once
    for (let i = 0; i < 50; i++) stats.recordPublicRefused();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(stats.report()).toMatchObject({ publicPathRefused: 51 });
    now += 61_000;
    stats.recordAnswer('marker', true);
    expect(writes).toHaveBeenCalledTimes(2);
    const onDisk = JSON.parse(fs.readFileSync(confirmStatsFile(dir), 'utf8'));
    expect(onDisk).toMatchObject({ publicPathRefused: 51, answersByPath: { marker: 1, local: 0, public: 0 }, exemptPathAnswersWhileAggregateFull: { marker: 1, local: 0 } });
    expect(onDisk.events).toHaveLength(1);
    stats.flushNow();
  });

  it('an unreadable stats file reports unknown with the reason, never zeros', () => {
    fresh();
    fs.mkdirSync(path.dirname(confirmStatsFile(dir)), { recursive: true });
    fs.writeFileSync(confirmStatsFile(dir), '{not json');
    const stats = new ConfirmStats({ stateDir: dir });
    const r = stats.report();
    expect(r).toMatchObject({ state: 'unknown' });
    expect((r as { reason: string }).reason).toMatch(/damaged/);
  });

  it('a failed write reports unknown and is reported once', () => {
    const onWriteError = vi.fn();
    const stats = new ConfirmStats({ stateDir: fresh(), onWriteError });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('read-only'); });
    stats.recordOwnerOpen();
    expect(stats.report()).toMatchObject({ state: 'unknown' });
    expect(onWriteError).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmTokenStore owner opens', () => {
  const binding: ConfirmBinding = { service: 'jev', owner: '777', targetMachine: 'm', offerTextHash: 'h', origin: 'person-asked', nosAtOpen: [] };
  const rows = () => JSON.parse(fs.readFileSync(confirmTokensFile(dir), 'utf8')) as Array<{ protected?: boolean; expiresAt: number }>;

  it('owner opens have their own allowance of 30 a minute, separate from the strangers\' cap', () => {
    const store = new ConfirmTokenStore({ stateDir: fresh() });
    for (let i = 0; i < MAX_MINTS_PER_MINUTE; i++) store.mint(binding, { protected: false });
    expect(store.mayMint()).toBe(false);
    expect(store.mayMint({ protected: true })).toBe(true);
    for (let i = 0; i < MAX_MINTS_PER_MINUTE; i++) store.mint({ ...binding, service: 'tailscale' }, { protected: true });
    expect(store.mayMint({ protected: true })).toBe(false);
    expect(store.mintRefillSeconds({ protected: true })).toBeGreaterThanOrEqual(1);
  });

  it('an unprotected flood never evicts a protected token', () => {
    let now = 1_000_000;
    const store = new ConfirmTokenStore({ stateDir: fresh(), now: () => now });
    const own = store.mint(binding, { protected: true });
    for (let i = 0; i < 200; i++) { now += 1; store.mint(binding, { protected: false }); }
    expect(rows()).toHaveLength(50);
    expect(store.isLive(own.token, 'jev')).toBe(true);
  });

  it('at capacity with all 50 protected, an unprotected mint and a protected mint are both refused with no row changed', () => {
    let now = 1_000_000;
    const store = new ConfirmTokenStore({ stateDir: fresh(), now: () => now });
    for (let i = 0; i < 50; i++) { now += 1; store.mint(binding, { protected: true }); }
    const before = fs.readFileSync(confirmTokensFile(dir), 'utf8');
    expect(() => store.mint(binding, { protected: false })).toThrow(ConfirmTokensFullError);
    expect(() => store.mint(binding, { protected: true })).toThrow(ConfirmTokensFullError);
    expect(fs.readFileSync(confirmTokensFile(dir), 'utf8')).toBe(before);
  });

  it('a protected mint at capacity evicts the oldest unprotected token', () => {
    let now = 1_000_000;
    const store = new ConfirmTokenStore({ stateDir: fresh(), now: () => now });
    const first = store.mint(binding, { protected: false });
    for (let i = 0; i < 49; i++) { now += 1; store.mint(binding, { protected: true }); }
    now += 1;
    store.mint(binding, { protected: true });
    expect(store.isLive(first.token, 'jev')).toBe(false);
    expect(rows().every((r) => r.protected === true)).toBe(true);
  });

  it('without options the mint is piece 1c\'s exactly: the oldest token falls off, no protected field', () => {
    let now = 1_000_000;
    const store = new ConfirmTokenStore({ stateDir: fresh(), now: () => now });
    const first = store.mint(binding);
    for (let i = 0; i < 50; i++) { now += 1; store.mint(binding); }
    expect(store.isLive(first.token, 'jev')).toBe(false);
    expect(rows().some((r) => 'protected' in r)).toBe(false);
  });

  it('a consumed protected token returns the binding without the flag', () => {
    const store = new ConfirmTokenStore({ stateDir: fresh() });
    const own = store.mint(binding, { protected: true });
    expect(store.consume(own.token, 'jev')).toEqual(binding);
  });
});
