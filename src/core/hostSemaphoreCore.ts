/**
 * hostSemaphoreCore — shared holder-set semaphore primitives.
 *
 * Extraction seam per docs/specs/test-runner-concurrency-bound.md §2.1: the
 * proven MECHANICS of `hostSpawnSemaphore.ts` (the 2026-06-20 fork-bomb floor)
 * are extracted here so the test-runner lane can reuse them WITHOUT inheriting
 * spawn-lane POLICY. What moves into the core:
 *
 *  - the exclusive O_CREAT|O_EXCL lock primitive — but lock-RECLAIM policy is
 *    a PARAMETER of the consumer, not the core: the spawn lane keeps its
 *    legacy pid-death unlink reclaim (`legacyPidDeathLockReclaim`, preserved
 *    bug-for-bug — see the defect note on that function), while the test lane
 *    uses ONLY its own race-safe age-reclaim (atomic rename + dev+ino verify,
 *    implemented in hostTestRunnerSemaphore.ts) and NEVER calls the legacy
 *    reclaim;
 *  - holders-file atomic write (temp+rename) and the safe read;
 *  - the `df -P` host-local determination (fail-closed classifier);
 *  - the prune-dead pass, taking a ReclaimPolicy parameter (NOT the spawn
 *    cap's hardcoded `pidDead && heartbeatStale && dfLocal`).
 *
 * ReclaimPolicy contract (the authoritative statement — this fixes the
 * HOLDER_STALE_MS doc-code contradiction found in review): the SPAWN lane
 * reclaims a holder only when its pid is dead (PRIMARY signal) AND its
 * heartbeat is stale past HOLDER_STALE_MS (SECONDARY signal) AND the holders
 * file is df-confirmed host-local. It is an AND conjunction — a live-pid
 * holder is never reclaimed by heartbeat alone, and a dead-pid holder is kept
 * until its heartbeat also goes stale. The TEST lane passes a different
 * policy (immediate dead-pid reclaim + start-time corroboration + max-hold
 * TTL) — see hostTestRunnerSemaphore.ts §2.4.
 *
 * The singleton + config layer is NOT extracted (two caps cannot share one
 * singleton) — each lane keeps its own thin configure/get/reset trio.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SafeFsExecutor } from './SafeFsExecutor.js';

// ── df -P host-local determination (fail-closed) ─────────────────────────

/** Pure FD1 classifier over the `df -P` device-source column. FAIL-CLOSED. */
export function classifyDfSourceLocal(source: string): boolean {
  if (!source) return false;
  if (source.startsWith('//')) return false; // SMB/CIFS //host/share → network
  if (/^[^/][^:]*:/.test(source)) return false; // NFS host:/path → network
  if (source.startsWith('/dev/')) return true; // a real block device → local
  return false; // map/tmpfs/anything unrecognized → fail-closed
}

/**
 * Linux fstype allowlist — filesystems that are HOST-LOCAL *and* support the
 * exclusive-create + atomic-rename semantics the holder lock is built on.
 *
 * WHY THIS EXISTS (2026-08-25, first non-CI Linux host — WSL2/Ubuntu 26.04).
 * `classifyDfSourceLocal` reads the `df -P` *device-source* column, which only
 * recognises a filesystem as local when it looks like a block device
 * (`/dev/...`). Several perfectly ordinary local Linux filesystems do not name
 * a device there, so they were classified as "possibly a shared network
 * volume" and the two host semaphores degraded silently in OPPOSITE
 * directions: the test-runner lane FAILS OPEN (admits the run unslotted — the
 * bound reports itself present while guarding nothing), and the spawn lane
 * FAILS CLOSED (stops reclaiming dead holders, so the cap slowly clogs until
 * it blocks legitimate work). Neither announces itself.
 *
 * Misclassified before this fix, all commonplace:
 *   tmpfs      — RAM-backed; Ubuntu's default /tmp. Cannot be shared by
 *                construction.
 *   overlay    — every Docker container's root filesystem. This one means any
 *                containerised instar was in the misjudged set.
 *   devtmpfs   — the kernel's own /dev.
 *   zfs        — ZFS names a POOL (`rpool/ROOT/x`), never a device. Note the
 *                pool-name SHAPE is deliberately NOT pattern-matched: FUSE
 *                cloud mounts (gcsfuse/s3fs bucket names) share that shape and
 *                are genuinely remote. Only the fstype settles it.
 *
 * DELIBERATELY ABSENT (these are correct rejections, not oversights):
 *   9p / drvfs — WSL's translation layer onto the Windows drive. Same physical
 *                machine, but exclusive-create and rename semantics are not
 *                dependable across it, so it must not hold the lock.
 *   virtiofs   — host-shared directory; may be mounted by sibling guests.
 *   nfs/cifs/smb/fuse.sshfs/ceph/glusterfs/lustre/afs — network by definition.
 *
 * Anything not on this list keeps the pre-existing fail-closed behaviour.
 */
const LINUX_HOST_LOCAL_FSTYPES: ReadonlySet<string> = new Set([
  // on-disk local filesystems
  'ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'bcachefs', 'nilfs2', 'squashfs', 'erofs', 'vfat', 'exfat', 'msdos',
  // in-memory local filesystems
  'tmpfs', 'ramfs', 'devtmpfs',
  // container/union local filesystems
  'overlay', 'overlayfs', 'aufs',
]);

/** Injectable reader for `/proc/self/mounts` (tests override; null when absent). */
export type ProcMountsReader = () => string | null;

/** Injectable `df -P <path>` runner (tests override; throws exactly as df failing does). */
export type DfRunner = (p: string, timeoutMs: number) => string;

const defaultProcMountsReader: ProcMountsReader = () => {
  try {
    return fs.readFileSync('/proc/self/mounts', 'utf-8');
  } catch {
    // @silent-fallback-ok: no procfs (non-Linux, or a jail without it) — the
    // caller falls back to the df-source classifier, which is fail-closed.
    return null;
  }
};

/**
 * Pure: given `/proc/self/mounts` content and an absolute path, return the
 * fstype of the LONGEST mount-point prefix of that path, or null when nothing
 * matches. Longest-prefix is required — `/` matches everything, so a shorter
 * match would report the root filesystem for a path on a nested mount.
 */
export function fstypeForPath(procMounts: string, absPath: string): string | null {
  let bestPoint = '';
  let bestType: string | null = null;
  for (const line of procMounts.split('\n')) {
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    // /proc/self/mounts octal-escapes spaces and friends in the mount point.
    const point = parts[1].replace(/\\(\d{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
    const type = parts[2];
    if (!point || !type) continue;
    const isPrefix = absPath === point || point === '/' || absPath.startsWith(point.endsWith('/') ? point : `${point}/`);
    if (!isPrefix) continue;
    if (point.length >= bestPoint.length) {
      bestPoint = point;
      bestType = type;
    }
  }
  return bestType;
}

/**
 * Pure: classify a path as host-local from `/proc/self/mounts` content.
 * Returns null when the fstype is unknown to the allowlist — the caller then
 * falls back to the df-source classifier rather than inventing a verdict.
 */
export function classifyLinuxMountLocal(procMounts: string, absPath: string): boolean | null {
  const type = fstypeForPath(procMounts, absPath);
  if (!type) return null;
  return LINUX_HOST_LOCAL_FSTYPES.has(type) ? true : null;
}

/**
 * Detailed df probe. Distinguishes a POSITIVE not-local classification from a
 * FAILED probe ('unknown') — the distinction the 2026-07-01 §1.2 root-cause
 * hinges on: the spawn lane memoizes a boolean, so a df TIMEOUT under load is
 * cached forever as "not local" and silently disables all reclaim for the
 * process lifetime. Consumers that cache MUST NOT cache an 'unknown' result.
 */
export function probeDfHostLocalDetailed(
  p: string,
  timeoutMs = 3000,
  deps: { platform?: NodeJS.Platform; readProcMounts?: ProcMountsReader; runDf?: DfRunner } = {},
): { status: 'local' | 'not-local' | 'unknown'; source?: string; fstype?: string } {
  let out: string;
  try {
    // lint-allow-sync-spawn: a bounded (3s) one-shot host-FS classification,
    // run once per cold start and cached by callers on SUCCESS only — never on
    // the hot acquire path.
    out = deps.runDf
      ? deps.runDf(p, timeoutMs)
      : execFileSync('df', ['-P', p], { timeout: timeoutMs, encoding: 'utf-8' });
  } catch {
    // @silent-fallback-ok: df unavailable/timed out ⇒ we could not PROBE — the
    // caller must treat this as unknown (reclaim disabled this pass), never
    // cache it as a positive not-local classification.
    return { status: 'unknown' };
  }
  const lines = out.trim().split('\n');
  if (lines.length < 2) return { status: 'unknown' }; // unparseable → unknown
  const source = lines[1]?.trim().split(/\s+/)[0] ?? '';
  if (classifyDfSourceLocal(source)) return { status: 'local', source };

  // Linux second opinion. The df-source column cannot see tmpfs / overlay /
  // devtmpfs / zfs as local because none of them names a block device, so the
  // fstype is consulted before settling on 'not-local'. This can only ever
  // UPGRADE not-local → local for an explicitly allowlisted fstype; it never
  // downgrades a positive, and an unknown fstype leaves the fail-closed
  // verdict exactly as it was.
  const platform = deps.platform ?? process.platform;
  if (platform === 'linux') {
    const procMounts = (deps.readProcMounts ?? defaultProcMountsReader)();
    if (procMounts) {
      const abs = path.resolve(p);
      if (classifyLinuxMountLocal(procMounts, abs) === true) {
        return { status: 'local', source, fstype: fstypeForPath(procMounts, abs) ?? undefined };
      }
    }
  }
  return { status: 'not-local', source };
}

/**
 * Boolean df probe (the spawn lane's historical shape). FAIL-CLOSED: anything
 * not positively confirmable as local (including a failed probe) is false.
 */
export function probeDfHostLocal(p: string, timeoutMs = 3000): boolean {
  return probeDfHostLocalDetailed(p, timeoutMs).status === 'local';
}

// ── Atomic file write (temp + rename) ────────────────────────────────────

/**
 * Write `body` to `filePath` atomically via temp+rename (same filesystem).
 * The temp file is opened O_CREAT|O_EXCL with the given mode; on any error the
 * temp is best-effort removed (via the SafeFsExecutor funnel) and the error
 * rethrown.
 */
export function atomicWriteFileSync(
  filePath: string,
  body: string,
  opts: { mode?: number; operation: string },
): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    const fd = fs.openSync(tmp, 'wx', opts.mode ?? 0o600);
    fs.writeSync(fd, body);
    fs.closeSync(fd);
    fs.renameSync(tmp, filePath); // atomic on the same filesystem
  } catch (err) {
    try {
      SafeFsExecutor.safeUnlinkSync(tmp, { operation: `${opts.operation}:cleanup-tmp` });
    } catch {
      /* @silent-fallback-ok: best-effort tmp cleanup — the original error is rethrown */
    }
    throw err;
  }
}

// ── Exclusive lock primitive (O_CREAT|O_EXCL) ────────────────────────────

export type LockTakeResult =
  | { ok: true; fd: number }
  | {
      ok: false;
      reason: 'held' | 'error';
      /**
       * The errno of the failure, surfaced ONLY on `reason: 'error'`.
       *
       * WHY: callers need to distinguish a TRANSIENT failure (worth polling) from a
       * PERMANENT one (never worth polling). An unwritable rendezvous directory reports
       * EACCES/EPERM and will not become writable by being asked twelve more times, but
       * without the code every error looked alike and was waited out on the contention
       * path. Purely additive — `reason` is unchanged, so existing callers behave exactly
       * as before.
       */
      code?: string;
    };

/**
 * ONE attempt to take the exclusive lock at `lockPath` (O_CREAT|O_EXCL) and
 * stamp `record` into it. Returns the open fd on success; `held` when another
 * process holds it; `error` on any other failure (the caller decides its own
 * fail direction — the core never does).
 */
export function tryTakeLockOnce(lockPath: string, record: string): LockTakeResult {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600); // O_CREAT|O_EXCL
    fs.writeSync(fd, record);
    return { ok: true, fd };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* @silent-fallback-ok: closing a maybe-invalid fd during error unwind is benign */
      }
    }
    if (e.code === 'EEXIST') return { ok: false, reason: 'held' };
    return { ok: false, reason: 'error', ...(e.code ? { code: e.code } : {}) };
  }
}

/** Release the lock taken by `tryTakeLockOnce`. Idempotent, never throws. */
export function releaseLock(lockPath: string, fd: number | null, operation: string): void {
  if (fd !== null) {
    try {
      fs.closeSync(fd);
    } catch {
      /* @silent-fallback-ok: closing an already-closed/invalid fd on lock-release is benign */
    }
  }
  try {
    SafeFsExecutor.safeUnlinkSync(lockPath, { operation });
  } catch {
    /* @silent-fallback-ok: a missing lock on release is fine — release is idempotent */
  }
}

/**
 * LEGACY spawn-lane lock reclaim — remove the lock file when its recorded
 * holder pid is dead (or the record is unparseable). Preserved BUG-FOR-BUG
 * from HostSpawnSemaphore.reclaimStaleLock so the extraction changes nothing
 * about spawn behavior (the golden test pins it).
 *
 * KNOWN DEFECTS (surfaced by the test-runner-concurrency-bound §2.1 review;
 * the fix is the tracked spawn-lane back-port, NOT this extraction):
 *  - non-atomic unlink-then-recreate: two contenders can both observe a dead
 *    lock, both unlink, both enter — a holders row can be lost to
 *    last-write-wins;
 *  - torn-read hazard: the lock is created then written in TWO steps, so a
 *    contender can read an empty just-created lock, hit the parse catch, and
 *    unlink a LIVE lock;
 *  - `{pid, at}` carries no hostname and reclaim is not df-gated: on a synced
 *    home a peer machine pid-probes a foreign, locally-meaningless pid.
 * The TEST lane does NOT use this function at all (age-reclaim-only, §2.4).
 */
export function legacyPidDeathLockReclaim(
  lockPath: string,
  pidAlive: (pid: number) => boolean,
): boolean {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8');
    const obj = JSON.parse(raw);
    const pid = typeof obj?.pid === 'number' ? obj.pid : null;
    if (pid !== null && pidAlive(pid)) return false; // live holder — wait
    // Dead (or unparseable) lock holder — reclaim.
    SafeFsExecutor.safeUnlinkSync(lockPath, { operation: 'hostSemaphoreCore.legacyPidDeathLockReclaim' });
    return true;
  } catch {
    // @silent-fallback-ok: a read/parse failure on the lock means we couldn't
    // confirm a live holder; treat as reclaimable so a corrupt lock can't wedge
    // the cap permanently. The O_EXCL re-create still races safely.
    try {
      SafeFsExecutor.safeUnlinkSync(lockPath, {
        operation: 'hostSemaphoreCore.legacyPidDeathLockReclaim:corrupt',
      });
      return true;
    } catch {
      // @silent-fallback-ok: couldn't remove the corrupt lock (a race with
      // another reclaimer) — report not-reclaimed; the caller waits + retries.
      return false;
    }
  }
}

// ── Prune-dead pass with a parameterized ReclaimPolicy ───────────────────

export interface ReclaimContext {
  nowMs: number;
  hostname: string;
  pidAlive: (pid: number) => boolean;
  /** df-confirmed host-local? Policies that reclaim MUST gate on this. */
  dfLocal: boolean;
}

/**
 * Per-row reclaim decision. Return true ⇒ the row is RECLAIMED (dropped from
 * the holders set). The policy owns its own fail direction — the core applies
 * it mechanically.
 */
export type HolderReclaimPolicy<Row> = (row: Row, ctx: ReclaimContext) => boolean;

/**
 * The prune-dead pass: drop rows that are not well-formed, then apply the
 * lane's ReclaimPolicy to each remaining row. Pure — no I/O.
 */
export function pruneHolders<Row>(
  rows: unknown[],
  isWellFormed: (r: unknown) => r is Row,
  policy: HolderReclaimPolicy<Row>,
  ctx: ReclaimContext,
): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    if (!isWellFormed(r)) continue; // drop garbage rows
    if (policy(r, ctx)) continue; // policy says reclaim
    out.push(r);
  }
  return out;
}
