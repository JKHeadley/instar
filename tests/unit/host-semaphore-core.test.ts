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
  classifyLinuxMountLocal,
  fstypeForPath,
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

  // ── Linux fstype second opinion (2026-08-25 WSL2 finding) ───────────────
  //
  // The df-source column cannot see several ordinary LOCAL Linux filesystems
  // because none of them names a block device. Before this, the test-runner
  // lane failed OPEN on them (bound present, guarding nothing) and the spawn
  // lane failed CLOSED (reclaim off, cap slowly clogs). These tests pin both
  // the newly-correct verdicts AND the rejections that must stay rejections.

  const MOUNTS = [
    '/dev/sdd / ext4 rw,relatime 0 0',
    'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
    'overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0',
    'devtmpfs /dev devtmpfs rw 0 0',
    'rpool/ROOT/ubuntu /srv/pool zfs rw 0 0',
    'C:\\134 /mnt/c 9p rw,aname=drvfs 0 0',
    'nfs-host:/export /srv/remote nfs4 rw 0 0',
    '//fileserver/share /srv/smb cifs rw 0 0',
    'myfs /srv/virtio virtiofs rw 0 0',
    'bucket-name /srv/cloud fuse.gcsfuse rw 0 0',
    'tmpfs /srv/with\\040space tmpfs rw 0 0',
  ].join('\n');

  it('fstypeForPath resolves the LONGEST matching mount point, not the first', () => {
    // `/` is a prefix of everything — a shorter match must never win, or every
    // nested mount would report the root filesystem's type.
    expect(fstypeForPath(MOUNTS, '/home/echo/.instar')).toBe('ext4');
    expect(fstypeForPath(MOUNTS, '/tmp/holders.json')).toBe('tmpfs');
    expect(fstypeForPath(MOUNTS, '/var/lib/docker/overlay2/abc/merged/root')).toBe('overlay');
    expect(fstypeForPath(MOUNTS, '/mnt/c/Users/x')).toBe('9p');
  });

  it('fstypeForPath does not treat a same-prefix sibling directory as a mount match', () => {
    // `/tmp` must not match `/tmpfoo` — that would misattribute the fstype.
    expect(fstypeForPath('tmpfs /tmp tmpfs rw 0 0\n/dev/sdd / ext4 rw 0 0', '/tmpfoo/x')).toBe('ext4');
  });

  it('fstypeForPath decodes octal-escaped mount points', () => {
    expect(fstypeForPath(MOUNTS, '/srv/with space/holders.json')).toBe('tmpfs');
  });

  it('fstypeForPath returns null when nothing matches', () => {
    expect(fstypeForPath('tmpfs /tmp tmpfs rw 0 0', '/home/echo')).toBeNull();
    expect(fstypeForPath('', '/home/echo')).toBeNull();
    expect(fstypeForPath('garbage-line-without-enough-fields', '/home/echo')).toBeNull();
  });

  it('classifyLinuxMountLocal accepts the local filesystems df-source cannot see', () => {
    expect(classifyLinuxMountLocal(MOUNTS, '/tmp/holders.json')).toBe(true); // tmpfs
    expect(classifyLinuxMountLocal(MOUNTS, '/var/lib/docker/overlay2/abc/merged/x')).toBe(true); // overlay
    expect(classifyLinuxMountLocal(MOUNTS, '/dev/shm')).toBe(true); // devtmpfs
    expect(classifyLinuxMountLocal(MOUNTS, '/srv/pool/data')).toBe(true); // zfs
    expect(classifyLinuxMountLocal(MOUNTS, '/home/echo/.instar')).toBe(true); // ext4
  });

  it('classifyLinuxMountLocal never upgrades a filesystem that must not hold the lock', () => {
    // Network by definition.
    expect(classifyLinuxMountLocal(MOUNTS, '/srv/remote/x')).toBeNull(); // nfs4
    expect(classifyLinuxMountLocal(MOUNTS, '/srv/smb/x')).toBeNull(); // cifs
    expect(classifyLinuxMountLocal(MOUNTS, '/srv/cloud/x')).toBeNull(); // fuse.gcsfuse
    // Same machine, but unsafe or shareable — deliberate rejections.
    expect(classifyLinuxMountLocal(MOUNTS, '/mnt/c/Users/x')).toBeNull(); // 9p/drvfs
    expect(classifyLinuxMountLocal(MOUNTS, '/srv/virtio/x')).toBeNull(); // virtiofs
    // Unknown fstype → null, so the df-source fail-closed verdict stands.
    expect(classifyLinuxMountLocal('somefs /srv/x weirdfs rw 0 0', '/srv/x/y')).toBeNull();
  });

  it('probeDfHostLocalDetailed: linux fstype rescues the local verdicts df-source cannot reach', () => {
    // df on a tmpfs/overlay/zfs mount prints a NON-/dev source, which is
    // exactly what the source classifier fails closed on. These drive the real
    // probe end-to-end (df output injected) so the wiring is covered, not just
    // the pure classifier underneath it.
    const dfOut = (source: string) =>
      `Filesystem 512-blocks Used Available Capacity Mounted on\n${source} 100 1 99 1% /whatever\n`;

    const onTmpfs = probeDfHostLocalDetailed('/tmp/holders.json', 3000, {
      platform: 'linux',
      runDf: () => dfOut('tmpfs'),
      readProcMounts: () => 'tmpfs /tmp tmpfs rw 0 0\n/dev/sdd / ext4 rw 0 0',
    });
    expect(onTmpfs.status).toBe('local');
    expect(onTmpfs.fstype).toBe('tmpfs');

    const onOverlay = probeDfHostLocalDetailed('/app/state', 3000, {
      platform: 'linux',
      runDf: () => dfOut('overlay'),
      readProcMounts: () => 'overlay / overlay rw 0 0',
    });
    expect(onOverlay.status).toBe('local');
    expect(onOverlay.fstype).toBe('overlay');

    const onZfs = probeDfHostLocalDetailed('/srv/pool/data', 3000, {
      platform: 'linux',
      runDf: () => dfOut('rpool/ROOT/ubuntu'),
      readProcMounts: () => 'rpool/ROOT/ubuntu /srv/pool zfs rw 0 0\n/dev/sdd / ext4 rw 0 0',
    });
    expect(onZfs.status).toBe('local');
    expect(onZfs.fstype).toBe('zfs');
  });

  it('probeDfHostLocalDetailed: the linux path never rescues a filesystem that must stay rejected', () => {
    const dfOut = (source: string) =>
      `Filesystem 512-blocks Used Available Capacity Mounted on\n${source} 100 1 99 1% /whatever\n`;

    // A FUSE cloud mount names a bucket, which has the same shape as a ZFS
    // pool. Only the fstype separates them — this is why the pool-name shape
    // is deliberately not pattern-matched.
    const onGcsfuse = probeDfHostLocalDetailed('/srv/cloud/x', 3000, {
      platform: 'linux',
      runDf: () => dfOut('bucket-name'),
      readProcMounts: () => 'bucket-name /srv/cloud fuse.gcsfuse rw 0 0',
    });
    expect(onGcsfuse.status).toBe('not-local');
    expect(onGcsfuse.fstype).toBeUndefined();

    // WSL's Windows-drive translation layer: same machine, unreliable locking.
    const onDrvfs = probeDfHostLocalDetailed('/mnt/c/Users/x', 3000, {
      platform: 'linux',
      runDf: () => dfOut('drvfs'),
      readProcMounts: () => 'C:\\134 /mnt/c 9p rw,aname=drvfs 0 0',
    });
    expect(onDrvfs.status).toBe('not-local');

    // An unknown fstype leaves the pre-existing fail-closed verdict alone.
    const onWeird = probeDfHostLocalDetailed('/srv/x/y', 3000, {
      platform: 'linux',
      runDf: () => dfOut('somefs'),
      readProcMounts: () => 'somefs /srv/x weirdfs rw 0 0',
    });
    expect(onWeird.status).toBe('not-local');
  });

  it('probeDfHostLocalDetailed: macOS never reads procfs, and a linux host without procfs is unchanged', () => {
    const dfOut = `Filesystem 512-blocks Used Available Capacity Mounted on\ntmpfs 100 1 99 1% /whatever\n`;

    const mac = probeDfHostLocalDetailed('/tmp/x', 3000, {
      platform: 'darwin',
      runDf: () => dfOut,
      readProcMounts: () => {
        throw new Error('procfs must not be read off linux');
      },
    });
    expect(mac.status).toBe('not-local'); // byte-identical to pre-fix behaviour
    expect(mac.fstype).toBeUndefined();

    const noProc = probeDfHostLocalDetailed('/tmp/x', 3000, {
      platform: 'linux',
      runDf: () => dfOut,
      readProcMounts: () => null,
    });
    expect(noProc.status).toBe('not-local');
  });

  it('probeDfHostLocalDetailed: a /dev-backed source still short-circuits before procfs is consulted', () => {
    const res = probeDfHostLocalDetailed('/home/echo/.instar', 3000, {
      platform: 'linux',
      runDf: () =>
        `Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/sdd 100 1 99 1% /\n`,
      readProcMounts: () => {
        throw new Error('procfs must not be consulted when df already said local');
      },
    });
    expect(res.status).toBe('local');
    expect(res.fstype).toBeUndefined();
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
