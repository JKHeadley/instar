// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * autonomous-run-outlives-session — GAP-D: the resume-queue host-lock must
 * distinguish a single-host RENAME (auto-heal) from a genuine shared-volume
 * conflict (stay disabled), FAIL-CLOSED on any uncertainty, and a disabled
 * queue must self-report via guardStatus(). FD1/FD2/FD4/FD5.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ResumeQueue,
  classifyDfSourceLocal,
  type ResumeQueueDeps,
  type ResumeQueueConfig,
} from '../../src/monitoring/ResumeQueue.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-autoheal-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const lockPath = (dir: string) => path.join(dir, 'state', 'resume-queue.lock');

function writeForeignLock(dir: string, lock: { pid?: number; hostname?: string }, mtimeMsAgo = 0): void {
  const p = lockPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(lock));
  if (mtimeMsAgo > 0) {
    const t = new Date(Date.now() - mtimeMsAgo);
    fs.utimesSync(p, t, t);
  }
}

function makeQueue(dir: string, over: {
  cfg?: Partial<ResumeQueueConfig>;
  deps?: Partial<ResumeQueueDeps>;
  nowMs?: number;
} = {}): { q: ResumeQueue; audits: Record<string, unknown>[]; aggregated: { kind: string; detail: string }[] } {
  const audits: Record<string, unknown>[] = [];
  const aggregated: { kind: string; detail: string }[] = [];
  const q = new ResumeQueue(
    {
      stateDir: dir,
      audit: (e) => audits.push(e),
      raiseAggregated: (kind, detail) => aggregated.push({ kind, detail }),
      now: () => over.nowMs ?? Date.now(),
      hostname: () => 'current-host',
      pidAlive: () => false,
      isStateDirHostLocal: () => true,
      ...over.deps,
    },
    { enabled: true, dryRun: false, ...over.cfg },
  );
  return { q, audits, aggregated };
}

describe('classifyDfSourceLocal (FD1 truth-table, fail-closed)', () => {
  it('positively-local block devices → true', () => {
    expect(classifyDfSourceLocal('/dev/disk3s5')).toBe(true);
    expect(classifyDfSourceLocal('/dev/sda1')).toBe(true);
  });
  it('network/shared signatures → false', () => {
    expect(classifyDfSourceLocal('//fileserver/share')).toBe(false); // SMB/CIFS
    expect(classifyDfSourceLocal('nas:/exports/data')).toBe(false); // NFS host:/path
    expect(classifyDfSourceLocal('10.0.0.5:/vol')).toBe(false);
  });
  it('unknown/empty/map/tmpfs → false (fail-closed)', () => {
    expect(classifyDfSourceLocal('')).toBe(false);
    expect(classifyDfSourceLocal('map')).toBe(false);
    expect(classifyDfSourceLocal('tmpfs')).toBe(false);
    expect(classifyDfSourceLocal('devfs')).toBe(false);
  });
});

describe('foreign-host lock — rename-vs-conflict classifier', () => {
  const STALE = 6 * 60_000; // older than the 5-min heartbeat window

  it('auto-heals a provable RENAME (local FS + dead pid + stale heartbeat) when enabled', () => {
    writeForeignLock(tmpDir, { pid: 99999, hostname: 'old-host-name' }, STALE);
    const { q, audits } = makeQueue(tmpDir, { cfg: { autoHealStaleHostLock: true } });
    expect(q.start()).toBe(true);
    expect(q.isDisabled()).toBeFalsy();
    // lock rewritten to the current host
    const lock = JSON.parse(fs.readFileSync(lockPath(tmpDir), 'utf-8'));
    expect(lock.hostname).toBe('current-host');
    expect(audits.some((a) => a.event === 'lock-foreign-host-autohealed' && a.took === true)).toBe(true);
  });

  it('STAYS DISABLED on a non-local FS even with dead pid + stale heartbeat (FS-local dispositive)', () => {
    writeForeignLock(tmpDir, { pid: 99999, hostname: 'old-host-name' }, STALE);
    const { q, aggregated } = makeQueue(tmpDir, {
      cfg: { autoHealStaleHostLock: true },
      deps: { isStateDirHostLocal: () => false },
    });
    expect(q.start()).toBe(false);
    expect(q.isDisabled()).toBeTruthy();
    expect(aggregated.some((a) => a.kind === 'lock-foreign-host')).toBe(true);
  });

  it('STAYS DISABLED when the foreign pid is alive (genuine conflict), never pid-clobbered', () => {
    writeForeignLock(tmpDir, { pid: 4242, hostname: 'old-host-name' }, STALE);
    const { q } = makeQueue(tmpDir, {
      cfg: { autoHealStaleHostLock: true },
      deps: { pidAlive: (pid) => pid === 4242 },
    });
    expect(q.start()).toBe(false);
    expect(q.isDisabled()).toBeTruthy();
  });

  it('dryRun: logs would-autoheal and STAYS DISABLED without rewriting the lock', () => {
    writeForeignLock(tmpDir, { pid: 99999, hostname: 'old-host-name' }, STALE);
    const { q, audits, aggregated } = makeQueue(tmpDir, { cfg: { autoHealStaleHostLock: true, dryRun: true } });
    expect(q.start()).toBe(false);
    expect(audits.some((a) => a.event === 'lock-foreign-host-would-autoheal')).toBe(true);
    expect(aggregated.some((a) => a.kind === 'lock-foreign-host-would-autoheal')).toBe(true);
    // NOT rewritten — still the old host
    const lock = JSON.parse(fs.readFileSync(lockPath(tmpDir), 'utf-8'));
    expect(lock.hostname).toBe('old-host-name');
  });

  it('auto-heal OFF (default) → today\'s disable-on-mismatch behavior preserved', () => {
    writeForeignLock(tmpDir, { pid: 99999, hostname: 'old-host-name' }, STALE);
    const { q } = makeQueue(tmpDir, { cfg: { autoHealStaleHostLock: false } });
    expect(q.start()).toBe(false);
    expect(q.isDisabled()).toBeTruthy();
  });
});

describe('guardStatus() — a disabled queue self-reports (D2)', () => {
  it('reports enabled:false + reason when disabled by an un-healable foreign lock', () => {
    writeForeignLock(tmpDir, { pid: 4242, hostname: 'old-host-name' });
    const { q } = makeQueue(tmpDir, {
      cfg: { autoHealStaleHostLock: false },
    });
    q.start();
    const gs = q.guardStatus();
    expect(gs.enabled).toBe(false);
    expect(gs.reason).toMatch(/disabled/i);
  });

  it('reports enabled:true after a healthy start (no lock contention)', () => {
    const { q } = makeQueue(tmpDir, { cfg: { autoHealStaleHostLock: true } });
    expect(q.start()).toBe(true);
    expect(q.guardStatus().enabled).toBe(true);
  });

  it('guardStatus reflects runtime state regardless of dryRun (always loud)', () => {
    writeForeignLock(tmpDir, { pid: 4242, hostname: 'old-host-name' });
    const { q } = makeQueue(tmpDir, { cfg: { autoHealStaleHostLock: false, dryRun: true } });
    q.start();
    const gs = q.guardStatus();
    expect(gs.enabled).toBe(false);
    expect(gs.dryRun).toBe(true);
  });
});
