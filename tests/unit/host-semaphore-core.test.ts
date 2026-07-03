/**
 * hostSemaphoreCore extraction tests (test-runner-concurrency-bound §2.1/§5).
 *
 * The extraction is its OWN reviewed change with its own tests — not an
 * assumed no-op:
 *  - a GOLDEN test pins the spawn holders-file byte format (disabled-lane
 *    state) unchanged pre/post extraction, including the optional `lane`
 *    field's presence/absence;
 *  - an export-list assertion pins hostSpawnSemaphore's public surface;
 *  - the ReclaimPolicy / lock-reclaim parameterization is exercised directly;
 *  - the HOLDER_STALE_MS doc-comment now states the AND semantics (doc-code
 *    contradiction fixed in the extraction).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  atomicWriteFileSync,
  classifyDfSourceLocal,
  legacyPidDeathLockReclaim,
  probeDfHostLocalDetailed,
  pruneHolders,
  releaseLock,
  tryTakeLockOnce,
  type ReclaimContext,
} from '../../src/core/hostSemaphoreCore.js';
import * as spawnModule from '../../src/core/hostSpawnSemaphore.js';
import { HostSpawnSemaphore, HOLDER_STALE_MS } from '../../src/core/hostSpawnSemaphore.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'host-sem-core-'));
}

describe('hostSemaphoreCore — extraction', () => {
  // ── Golden test: spawn holders-file byte format unchanged ──────────────
  it('GOLDEN: spawn lane writes the exact pre-extraction holders byte format (no lane field when priority off)', () => {
    const dir = tmpDir();
    const holdersPath = path.join(dir, 'host-spawn-holders.json');
    const sem = new HostSpawnSemaphore({
      holdersPath,
      cap: 8,
      now: () => 1700000000000,
      hostname: () => 'golden-host',
      pidAlive: () => true,
      genId: () => 'golden-id-1',
    });
    expect(sem.acquire('golden-id-1')).toBe(true);
    const raw = fs.readFileSync(holdersPath, 'utf-8');
    // The EXACT byte format the pre-extraction module wrote: JSON.stringify of
    // {version:1, holders:[{id,pid,hostname,heartbeat}]} — no whitespace, no
    // trailing newline, NO `lane` field while interactive-priority is off.
    expect(raw).toBe(
      `{"version":1,"holders":[{"id":"golden-id-1","pid":${process.pid},"hostname":"golden-host","heartbeat":1700000000000}]}`,
    );
  });

  it('GOLDEN: spawn lane writes the lane field ONLY when interactive-priority is enabled', () => {
    const dir = tmpDir();
    const holdersPath = path.join(dir, 'host-spawn-holders.json');
    const sem = new HostSpawnSemaphore({
      holdersPath,
      cap: 8,
      now: () => 1700000000000,
      hostname: () => 'golden-host',
      pidAlive: () => true,
      interactivePriority: { enabled: true, ri: 2, rb: 2 },
    });
    expect(sem.acquire('golden-id-2', 'interactive')).toBe(true);
    const raw = fs.readFileSync(holdersPath, 'utf-8');
    expect(raw).toBe(
      `{"version":1,"holders":[{"id":"golden-id-2","pid":${process.pid},"hostname":"golden-host","heartbeat":1700000000000,"lane":"interactive"}]}`,
    );
  });

  // ── Export-list assertion ───────────────────────────────────────────────
  it('hostSpawnSemaphore public export list is unchanged by the extraction', () => {
    const expected = [
      'HOLDER_STALE_MS',
      'HostSpawnSemaphore',
      '_resetHostSpawnSemaphoreForTest',
      'clampInteractiveReserves',
      'classifyDfSourceLocal',
      'configureHostSpawnSemaphore',
      'configuredSpawnAcquireMs',
      'configuredSpawnWaitersMax',
      'defaultHoldersPath',
      'getHostSpawnSemaphore',
      'isPathHostLocalDefault',
      'resolveSpawnAcquireMs',
      'resolveSpawnCap',
      'resolveSpawnWaitersMax',
    ];
    const actual = Object.keys(spawnModule).sort();
    expect(actual).toEqual(expected.sort());
  });

  // ── Doc-contract fidelity (§2.1): AND semantics stated + implemented ────
  it('HOLDER_STALE_MS doc-comment states the AND semantics and pruneDead implements AND', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'core', 'hostSpawnSemaphore.ts'),
      'utf-8',
    );
    // The comment must state the AND conjunction, not the old OR wording.
    const commentBlock = src.slice(src.indexOf('Heartbeat staleness window'), src.indexOf('export const HOLDER_STALE_MS'));
    expect(commentBlock).toMatch(/AND/);
    expect(commentBlock).not.toMatch(/pid dead OR/i);

    // Behavior: a dead-pid holder with a FRESH heartbeat is KEPT (AND, not OR).
    const dir = tmpDir();
    const holdersPath = path.join(dir, 'host-spawn-holders.json');
    const nowMs = 1700000000000;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      holdersPath,
      JSON.stringify({
        version: 1,
        holders: [{ id: 'dead-fresh', pid: 99999999, hostname: 'h', heartbeat: nowMs - 1000 }],
      }),
    );
    const sem = new HostSpawnSemaphore({
      holdersPath,
      cap: 8,
      now: () => nowMs,
      hostname: () => 'h',
      pidAlive: () => false, // pid dead
      isPathHostLocal: () => true,
    });
    const status = sem.status();
    expect(status.liveHolders).toBe(1); // dead pid + fresh heartbeat ⇒ kept (AND)

    // And dead + stale ⇒ reclaimed.
    fs.writeFileSync(
      holdersPath,
      JSON.stringify({
        version: 1,
        holders: [
          { id: 'dead-stale', pid: 99999999, hostname: 'h', heartbeat: nowMs - HOLDER_STALE_MS - 1 },
        ],
      }),
    );
    expect(sem.status().liveHolders).toBe(0);
  });

  // ── ReclaimPolicy parameterization ──────────────────────────────────────
  it('pruneHolders applies the injected policy mechanically and drops garbage rows', () => {
    interface Row {
      pid: number;
      tag: string;
    }
    const isRow = (r: unknown): r is Row =>
      !!r && typeof r === 'object' && typeof (r as Row).pid === 'number' && typeof (r as Row).tag === 'string';
    const ctx: ReclaimContext = {
      nowMs: 1000,
      hostname: 'h',
      pidAlive: (p) => p === 1,
      dfLocal: true,
    };
    const rows: unknown[] = [
      { pid: 1, tag: 'live' },
      { pid: 2, tag: 'dead' },
      { garbage: true },
      'not-an-object',
    ];
    const kept = pruneHolders<Row>(rows, isRow, (r, c) => !c.pidAlive(r.pid), ctx);
    expect(kept).toEqual([{ pid: 1, tag: 'live' }]);
  });

  it('two lanes can hold DIFFERENT reclaim policies over the same core (parameterization, not inheritance)', () => {
    interface Row {
      pid: number;
      acquiredAt: number;
    }
    const isRow = (r: unknown): r is Row =>
      !!r && typeof r === 'object' && typeof (r as Row).pid === 'number';
    const ctx: ReclaimContext = { nowMs: 100_000, hostname: 'h', pidAlive: () => true, dfLocal: true };
    const rows: unknown[] = [{ pid: 1, acquiredAt: 0 }];
    // Policy A (spawn-shaped): live pid ⇒ never reclaim.
    expect(pruneHolders<Row>(rows, isRow, (r, c) => !c.pidAlive(r.pid), ctx)).toHaveLength(1);
    // Policy B (test-shaped): max-hold TTL reclaims EVEN a live pid.
    expect(
      pruneHolders<Row>(rows, isRow, (r, c) => c.nowMs - r.acquiredAt > 50_000, ctx),
    ).toHaveLength(0);
  });

  // ── Lock primitive + legacy reclaim ─────────────────────────────────────
  it('tryTakeLockOnce is exclusive; releaseLock is idempotent', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'x.lock');
    const a = tryTakeLockOnce(lockPath, '{"pid":1}');
    expect(a.ok).toBe(true);
    const b = tryTakeLockOnce(lockPath, '{"pid":2}');
    expect(b).toEqual({ ok: false, reason: 'held' });
    releaseLock(lockPath, a.ok ? a.fd : null, 'test');
    releaseLock(lockPath, null, 'test'); // double release — no throw
    const c = tryTakeLockOnce(lockPath, '{"pid":3}');
    expect(c.ok).toBe(true);
    releaseLock(lockPath, c.ok ? c.fd : null, 'test');
  });

  it('legacyPidDeathLockReclaim: dead-pid lock reclaimed, live-pid lock kept (spawn-lane legacy, preserved)', () => {
    const dir = tmpDir();
    const lockPath = path.join(dir, 'y.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, at: 1 }));
    expect(legacyPidDeathLockReclaim(lockPath, () => true)).toBe(false); // live — kept
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(legacyPidDeathLockReclaim(lockPath, () => false)).toBe(true); // dead — reclaimed
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // ── df classifier + detailed probe ──────────────────────────────────────
  it('classifyDfSourceLocal fail-closed classification', () => {
    expect(classifyDfSourceLocal('/dev/disk3s5')).toBe(true);
    expect(classifyDfSourceLocal('//smb/share')).toBe(false);
    expect(classifyDfSourceLocal('nfs-host:/export')).toBe(false);
    expect(classifyDfSourceLocal('map auto_home')).toBe(false);
    expect(classifyDfSourceLocal('')).toBe(false);
  });

  it('probeDfHostLocalDetailed distinguishes unknown (failed probe) from not-local (positive classification)', () => {
    // A nonexistent path makes df fail → 'unknown', NOT 'not-local'. This is
    // the §1.2 root-cause distinction: a failed probe must never be cacheable
    // as a positive not-local verdict.
    const res = probeDfHostLocalDetailed(path.join(os.tmpdir(), 'definitely-missing-' + Date.now()));
    expect(res.status).toBe('unknown');
  });

  // ── atomic write ─────────────────────────────────────────────────────────
  it('atomicWriteFileSync writes via temp+rename and leaves no temp on success', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'out.json');
    atomicWriteFileSync(p, '{"a":1}', { operation: 'test' });
    expect(fs.readFileSync(p, 'utf-8')).toBe('{"a":1}');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });
});
