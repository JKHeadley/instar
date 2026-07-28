/**
 * Unit tests for SingleInstanceLock (fork-bomb prevention P2).
 *
 * Spec: docs/specs/forkbomb-prevention-simple.md §P2/§D-LOCK.
 *
 * Covers:
 *   - a free lock is acquired.
 *   - a LIVE same-host holder is refused after the bounded handoff grace
 *     (duplicate-flood guard).
 *   - a clean restart HANDS OFF: a same-host holder that releases during the
 *     grace lets the incoming instance acquire (no refusal).
 *   - a FOREIGN-host lock is NEVER reclaimed (refuse-loud).
 *   - a DEAD same-host holder is reclaimed (host-local) but NOT when the FS
 *     can't be confirmed local (fail-closed).
 *   - INSTAR_ALLOW_SECOND_INSTANCE=1 bypasses the lock.
 *   - release only removes OUR OWN lock (never a successor's).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SingleInstanceLock } from '../../src/core/SingleInstanceLock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'single-inst-'));
}

const HOST = 'lock-host';

interface Overrides {
  alivePids?: Set<number>;
  hostname?: string;
  hostLocal?: boolean;
  handoffGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  autoHealStaleHostRename?: boolean;
  staleHostRenameMs?: number;
}

function makeLock(stateDir: string, o: Overrides = {}): SingleInstanceLock {
  const alive = o.alivePids ?? new Set<number>([process.pid]);
  return new SingleInstanceLock({
    stateDir,
    hostname: () => o.hostname ?? HOST,
    pidAlive: (pid) => alive.has(pid),
    isStateDirHostLocal: () => o.hostLocal ?? true,
    handoffGraceMs: o.handoffGraceMs ?? 100,
    pollIntervalMs: 10,
    sleep: async () => {},
    env: o.env ?? {},
    now: o.now,
    autoHealStaleHostRename: o.autoHealStaleHostRename,
    staleHostRenameMs: o.staleHostRenameMs,
    log: () => {},
  });
}

function seedLock(stateDir: string, rec: { pid: number; hostname: string; heartbeat?: number }): void {
  const localDir = path.join(stateDir, 'local');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(
    path.join(localDir, 'server-instance.lock'),
    JSON.stringify({ heartbeat: Date.now(), ...rec }),
  );
}

describe('SingleInstanceLock', () => {
  let dir: string;
  beforeEach(() => { dir = makeStateDir(); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/single-instance-lock.test.ts:afterEach' }); } catch { /* ignore */ }
  });

  it('acquires a free lock', async () => {
    const lock = makeLock(dir);
    const r = await lock.acquire();
    expect(r.acquired).toBe(true);
    expect(fs.existsSync(path.join(dir, 'local', 'server-instance.lock'))).toBe(true);
  });

  it('refuses a LIVE same-host duplicate after the handoff grace', async () => {
    // A live holder pid (12345) that is NOT this process and never releases.
    seedLock(dir, { pid: 12345, hostname: HOST });
    const lock = makeLock(dir, { alivePids: new Set([process.pid, 12345]), handoffGraceMs: 50 });
    const r = await lock.acquire();
    expect(r.acquired).toBe(false);
    expect(r.reason).toBe('duplicate-live-instance');
  });

  it('HANDS OFF on a clean restart: a holder that releases during the grace lets us in', async () => {
    const lockFile = path.join(dir, 'local', 'server-instance.lock');
    seedLock(dir, { pid: 12345, hostname: HOST });
    let pollCount = 0;
    const lock = new SingleInstanceLock({
      stateDir: dir,
      hostname: () => HOST,
      pidAlive: (pid) => pid === process.pid || pid === 12345,
      isStateDirHostLocal: () => true,
      handoffGraceMs: 1000,
      pollIntervalMs: 10,
      // On the 2nd poll, the outgoing instance "exits" → its exit handler frees the lock.
      sleep: async () => { if (++pollCount === 2) { try { SafeFsExecutor.safeUnlinkSync(lockFile, { operation: 'tests/unit/single-instance-lock.test.ts:simulate-handoff-release' }); } catch { /* */ } } },
      env: {},
      log: () => {},
    });
    const r = await lock.acquire();
    expect(r.acquired).toBe(true); // handed off, not refused
  });

  it('NEVER reclaims a FOREIGN-host lock (refuse-loud)', async () => {
    seedLock(dir, { pid: 999999, hostname: 'OTHER-HOST' });
    const lock = makeLock(dir, { hostname: HOST });
    const r = await lock.acquire();
    expect(r.acquired).toBe(false);
    expect(r.reason).toBe('foreign-host-conflict');
  });

  it('reclaims a DEAD same-host holder when the FS is host-local', async () => {
    seedLock(dir, { pid: 4040, hostname: HOST }); // 4040 not in alive set → dead
    const lock = makeLock(dir, { alivePids: new Set([process.pid]), hostLocal: true });
    const r = await lock.acquire();
    expect(r.acquired).toBe(true);
  });

  it('refuses to reclaim a DEAD same-host holder when the FS is NOT confirmed local (fail-closed)', async () => {
    seedLock(dir, { pid: 4040, hostname: HOST });
    const lock = makeLock(dir, { alivePids: new Set([process.pid]), hostLocal: false });
    const r = await lock.acquire();
    expect(r.acquired).toBe(false);
    expect(r.reason).toBe('foreign-host-conflict');
  });

  it('INSTAR_ALLOW_SECOND_INSTANCE=1 bypasses the lock', async () => {
    seedLock(dir, { pid: 12345, hostname: HOST });
    const lock = makeLock(dir, {
      alivePids: new Set([process.pid, 12345]),
      env: { INSTAR_ALLOW_SECOND_INSTANCE: '1' },
    });
    const r = await lock.acquire();
    expect(r.acquired).toBe(true);
    expect(r.overridden).toBe(true);
  });

  it('release removes only OUR lock, never a successor\'s', async () => {
    const lock = makeLock(dir);
    await lock.acquire();
    const lockFile = path.join(dir, 'local', 'server-instance.lock');
    // A successor overwrites the lock with its own pid+host.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 777777, hostname: HOST, heartbeat: Date.now() }));
    lock.release();
    // Our release must NOT have deleted the successor's lock.
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf-8')).pid).toBe(777777);
  });

  // ── Single-host RENAME auto-heal (2026-07-08 os.hostname() flap wedge) ──
  // A dead-holder lock stamped with THIS host's OLD name (mac.lan ↔
  // Justins-MacBook-Pro-99) looks FOREIGN after a flap and wedged every boot.
  // Reclaim it IFF provably a rename (flag on + dead pid + host-local + stale hb);
  // fail-closed on every other combination (never widen the shared-volume refuse).
  describe('single-host rename auto-heal', () => {
    const STALE_MS = 300_000;
    const staleHb = (): number => Date.now() - (STALE_MS + 60_000);

    it('(a) reclaims a FOREIGN-name lock that is a single-host rename (dead + host-local + stale hb + flag on)', async () => {
      seedLock(dir, { pid: 987654, hostname: 'Justins-MacBook-Pro-99.local', heartbeat: staleHb() });
      const lock = makeLock(dir, {
        hostname: 'mac.lan', alivePids: new Set([process.pid]), hostLocal: true,
        autoHealStaleHostRename: true, staleHostRenameMs: STALE_MS,
      });
      const r = await lock.acquire();
      expect(r.acquired).toBe(true);
    });

    it('(b) refuses when the FOREIGN holder pid is still ALIVE', async () => {
      seedLock(dir, { pid: 987654, hostname: 'old-name', heartbeat: staleHb() });
      const lock = makeLock(dir, {
        hostname: 'mac.lan', alivePids: new Set([process.pid, 987654]), hostLocal: true,
        autoHealStaleHostRename: true, staleHostRenameMs: STALE_MS,
      });
      const r = await lock.acquire();
      expect(r.acquired).toBe(false);
      expect(r.reason).toBe('foreign-host-conflict');
    });

    it('(c) refuses (fail-closed) when the FS is NOT host-local — a possible shared volume', async () => {
      seedLock(dir, { pid: 987654, hostname: 'old-name', heartbeat: staleHb() });
      const lock = makeLock(dir, {
        hostname: 'mac.lan', alivePids: new Set([process.pid]), hostLocal: false,
        autoHealStaleHostRename: true, staleHostRenameMs: STALE_MS,
      });
      const r = await lock.acquire();
      expect(r.acquired).toBe(false);
      expect(r.reason).toBe('foreign-host-conflict');
    });

    it('(d) refuses when the FOREIGN holder heartbeat is FRESH (not provably stale)', async () => {
      seedLock(dir, { pid: 987654, hostname: 'old-name', heartbeat: Date.now() });
      const lock = makeLock(dir, {
        hostname: 'mac.lan', alivePids: new Set([process.pid]), hostLocal: true,
        autoHealStaleHostRename: true, staleHostRenameMs: STALE_MS,
      });
      const r = await lock.acquire();
      expect(r.acquired).toBe(false);
      expect(r.reason).toBe('foreign-host-conflict');
    });

    it('(e) refuses when the heartbeat is 0/absent (cannot confirm staleness)', async () => {
      seedLock(dir, { pid: 987654, hostname: 'old-name', heartbeat: 0 });
      const lock = makeLock(dir, {
        hostname: 'mac.lan', alivePids: new Set([process.pid]), hostLocal: true,
        autoHealStaleHostRename: true, staleHostRenameMs: STALE_MS,
      });
      const r = await lock.acquire();
      expect(r.acquired).toBe(false);
      expect(r.reason).toBe('foreign-host-conflict');
    });

    it('(f) refuses when the flag is OFF, even if dead + host-local + stale (gate respected)', async () => {
      seedLock(dir, { pid: 987654, hostname: 'old-name', heartbeat: staleHb() });
      const lock = makeLock(dir, {
        hostname: 'mac.lan', alivePids: new Set([process.pid]), hostLocal: true,
        autoHealStaleHostRename: false, staleHostRenameMs: STALE_MS,
      });
      const r = await lock.acquire();
      expect(r.acquired).toBe(false);
      expect(r.reason).toBe('foreign-host-conflict');
    });

    it('(g) still refuses a genuine FOREIGN-host live lock (shared-volume hazard unchanged)', async () => {
      seedLock(dir, { pid: 987654, hostname: 'OTHER-REAL-HOST', heartbeat: Date.now() });
      const lock = makeLock(dir, {
        hostname: 'mac.lan', alivePids: new Set([process.pid, 987654]), hostLocal: false,
        autoHealStaleHostRename: true, staleHostRenameMs: STALE_MS,
      });
      const r = await lock.acquire();
      expect(r.acquired).toBe(false);
      expect(r.reason).toBe('foreign-host-conflict');
    });
  });
});
