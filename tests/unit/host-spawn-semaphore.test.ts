/**
 * Unit tests for HostSpawnSemaphore (fork-bomb prevention P1).
 *
 * Spec: docs/specs/forkbomb-prevention-simple.md §P1.
 *
 * Covers:
 *   - acquire/release happy path + count.
 *   - cap enforcement (acquire fails at the cap).
 *   - stale-holder reclaim (dead pid + stale heartbeat on THIS host).
 *   - foreign-hostname holder is NEVER reclaimed (refuse-loud host-lock contract).
 *   - a LIVE same-host holder (alive pid) is never reclaimed even if heartbeat stale.
 *   - df -P fail-closed: a non-host-local path reclaims NOTHING.
 *   - double-release is a no-op; unique-id (not pid) so pid-reuse can't steal a slot.
 *   - corrupt/partial holders file → empty set (bound from zero, never throw).
 *   - the env/config cap resolver precedence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HostSpawnSemaphore,
  resolveSpawnCap,
  resolveSpawnAcquireMs,
  resolveSpawnWaitersMax,
  classifyDfSourceLocal,
  HOLDER_STALE_MS,
} from '../../src/core/hostSpawnSemaphore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpHoldersPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-sem-'));
  return path.join(dir, 'host-spawn-holders.json');
}

const THIS_HOST = 'unit-host';

/** A semaphore pinned to a temp file, this-host, host-local FS, with injected pid liveness. */
function makeSem(opts: {
  holdersPath: string;
  cap: number;
  alivePids?: Set<number>;
  now?: () => number;
  hostLocal?: boolean;
}): HostSpawnSemaphore {
  const alive = opts.alivePids ?? new Set<number>([process.pid]);
  return new HostSpawnSemaphore({
    holdersPath: opts.holdersPath,
    cap: opts.cap,
    hostname: () => THIS_HOST,
    now: opts.now ?? (() => Date.now()),
    pidAlive: (pid) => alive.has(pid),
    isPathHostLocal: () => opts.hostLocal ?? true,
    genId: () => `${THIS_HOST}:${Math.random().toString(36).slice(2)}`,
  });
}

describe('HostSpawnSemaphore', () => {
  let holdersPath: string;
  beforeEach(() => { holdersPath = tmpHoldersPath(); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(path.dirname(holdersPath), { recursive: true, force: true, operation: 'tests/unit/host-spawn-semaphore.test.ts:afterEach' }); } catch { /* ignore */ }
  });

  it('acquires up to the cap, then refuses', () => {
    const sem = makeSem({ holdersPath, cap: 3 });
    expect(sem.acquire('a')).toBe(true);
    expect(sem.acquire('b')).toBe(true);
    expect(sem.acquire('c')).toBe(true);
    expect(sem.status().liveHolders).toBe(3);
    // At the cap — refuse.
    expect(sem.acquire('d')).toBe(false);
    expect(sem.status().liveHolders).toBe(3);
  });

  it('release frees a slot; double-release is a no-op', () => {
    const sem = makeSem({ holdersPath, cap: 2 });
    expect(sem.acquire('a')).toBe(true);
    expect(sem.acquire('b')).toBe(true);
    expect(sem.acquire('c')).toBe(false);
    sem.release('a');
    expect(sem.status().liveHolders).toBe(1);
    expect(sem.acquire('c')).toBe(true);
    // Double-release of 'a' (already gone) is a no-op.
    sem.release('a');
    expect(sem.status().liveHolders).toBe(2);
  });

  it('re-acquiring an existing id does not double-count (crash-safe retry)', () => {
    const sem = makeSem({ holdersPath, cap: 5 });
    expect(sem.acquire('same')).toBe(true);
    expect(sem.acquire('same')).toBe(true); // idempotent append
    expect(sem.status().liveHolders).toBe(1);
  });

  it('reclaims a dead same-host holder once its heartbeat is also stale', () => {
    let t = 1_000_000;
    const alive = new Set<number>([process.pid]); // 999 is NOT alive
    const sem = makeSem({ holdersPath, cap: 1, alivePids: alive, now: () => t });
    // Seed a stale dead holder directly.
    fs.writeFileSync(
      holdersPath,
      JSON.stringify({ version: 1, holders: [{ id: 'dead', pid: 999, hostname: THIS_HOST, heartbeat: t }] }),
    );
    // Not yet stale → cap is full → refuse.
    expect(sem.acquire('new')).toBe(false);
    // Advance past the stale window → the dead holder is reclaimed → acquire succeeds.
    t += HOLDER_STALE_MS + 1;
    expect(sem.acquire('new')).toBe(true);
    const status = sem.status();
    expect(status.liveHolders).toBe(1);
    expect(status.localHolders).toBe(1);
  });

  it('NEVER reclaims a foreign-hostname holder (refuse-loud host-lock contract)', () => {
    let t = 2_000_000;
    const sem = makeSem({ holdersPath, cap: 1, alivePids: new Set([process.pid]), now: () => t });
    // A foreign holder with a long-dead heartbeat AND a pid that is not alive.
    fs.writeFileSync(
      holdersPath,
      JSON.stringify({ version: 1, holders: [{ id: 'foreign', pid: 1234567, hostname: 'OTHER-MACHINE', heartbeat: 0 }] }),
    );
    t += HOLDER_STALE_MS * 10; // very stale
    // The foreign holder occupies the only slot and is NEVER pruned → refuse.
    expect(sem.acquire('mine')).toBe(false);
    expect(sem.status().foreignHolders).toBe(1);
  });

  it('NEVER reclaims a LIVE same-host holder even with a stale heartbeat (pid is primary)', () => {
    let t = 3_000_000;
    const alive = new Set<number>([process.pid, 4242]); // 4242 IS alive
    const sem = makeSem({ holdersPath, cap: 1, alivePids: alive, now: () => t });
    fs.writeFileSync(
      holdersPath,
      JSON.stringify({ version: 1, holders: [{ id: 'slow', pid: 4242, hostname: THIS_HOST, heartbeat: 0 }] }),
    );
    t += HOLDER_STALE_MS * 5; // heartbeat very stale, but pid alive
    expect(sem.acquire('mine')).toBe(false); // a slow live spawn is never reclaimed
  });

  it('df -P fail-closed: a non-host-local path reclaims NOTHING', () => {
    let t = 4_000_000;
    const sem = makeSem({ holdersPath, cap: 1, alivePids: new Set([process.pid]), now: () => t, hostLocal: false });
    fs.writeFileSync(
      holdersPath,
      JSON.stringify({ version: 1, holders: [{ id: 'dead', pid: 999, hostname: THIS_HOST, heartbeat: 0 }] }),
    );
    t += HOLDER_STALE_MS * 5;
    // Even a dead same-host holder is NOT reclaimed when the FS can't be confirmed local.
    expect(sem.acquire('mine')).toBe(false);
  });

  it('a corrupt/missing holders file is an EMPTY set (bound from zero, never throws)', () => {
    fs.writeFileSync(holdersPath, '{ not valid json');
    const sem = makeSem({ holdersPath, cap: 2 });
    expect(sem.acquire('a')).toBe(true); // started from zero
    expect(sem.status().liveHolders).toBe(1);
  });

  describe('resolveSpawnCap', () => {
    it('env > config > 8', () => {
      expect(resolveSpawnCap(undefined, {})).toBe(8);
      expect(resolveSpawnCap(12, {})).toBe(12);
      expect(resolveSpawnCap(12, { INSTAR_HOST_SPAWN_MAX: '20' })).toBe(20);
    });
    it('ignores a non-positive / non-finite override (a typo can never disable the cap)', () => {
      expect(resolveSpawnCap(0, {})).toBe(8);
      expect(resolveSpawnCap(-5, {})).toBe(8);
      expect(resolveSpawnCap(undefined, { INSTAR_HOST_SPAWN_MAX: 'nonsense' })).toBe(8);
      expect(resolveSpawnCap(undefined, { INSTAR_HOST_SPAWN_MAX: '0' })).toBe(8);
    });
  });

  describe('resolveSpawnAcquireMs / resolveSpawnWaitersMax', () => {
    it('acquire-ms env > config > 5000 (0 allowed = fail-fast)', () => {
      expect(resolveSpawnAcquireMs(undefined, {})).toBe(5000);
      expect(resolveSpawnAcquireMs(3000, {})).toBe(3000);
      expect(resolveSpawnAcquireMs(3000, { INSTAR_SPAWN_ACQUIRE_MS: '0' })).toBe(0);
    });
    it('waiters-max env > config > 64', () => {
      expect(resolveSpawnWaitersMax(undefined, {})).toBe(64);
      expect(resolveSpawnWaitersMax(32, {})).toBe(32);
      expect(resolveSpawnWaitersMax(32, { INSTAR_SPAWN_WAITERS_MAX: '128' })).toBe(128);
      expect(resolveSpawnWaitersMax(0, {})).toBe(64); // non-positive ignored
    });
  });

  describe('classifyDfSourceLocal', () => {
    it('local block devices are local; network shares are not', () => {
      expect(classifyDfSourceLocal('/dev/disk1s1')).toBe(true);
      expect(classifyDfSourceLocal('//server/share')).toBe(false); // SMB
      expect(classifyDfSourceLocal('host:/export/path')).toBe(false); // NFS
      expect(classifyDfSourceLocal('map -hosts')).toBe(false); // autofs
      expect(classifyDfSourceLocal('')).toBe(false); // fail-closed
    });
  });
});
