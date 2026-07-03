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
 * Detailed df probe. Distinguishes a POSITIVE not-local classification from a
 * FAILED probe ('unknown') — the distinction the 2026-07-01 §1.2 root-cause
 * hinges on: the spawn lane memoizes a boolean, so a df TIMEOUT under load is
 * cached forever as "not local" and silently disables all reclaim for the
 * process lifetime. Consumers that cache MUST NOT cache an 'unknown' result.
 */
export function probeDfHostLocalDetailed(
  p: string,
  timeoutMs = 3000,
): { status: 'local' | 'not-local' | 'unknown'; source?: string } {
  let out: string;
  try {
    // lint-allow-sync-spawn: a bounded (3s) one-shot host-FS classification,
    // run once per cold start and cached by callers on SUCCESS only — never on
    // the hot acquire path.
    out = execFileSync('df', ['-P', p], { timeout: timeoutMs, encoding: 'utf-8' });
  } catch {
    // @silent-fallback-ok: df unavailable/timed out ⇒ we could not PROBE — the
    // caller must treat this as unknown (reclaim disabled this pass), never
    // cache it as a positive not-local classification.
    return { status: 'unknown' };
  }
  const lines = out.trim().split('\n');
  if (lines.length < 2) return { status: 'unknown' }; // unparseable → unknown
  const source = lines[1]?.trim().split(/\s+/)[0] ?? '';
  return { status: classifyDfSourceLocal(source) ? 'local' : 'not-local', source };
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
  | { ok: false; reason: 'held' | 'error' };

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
    return { ok: false, reason: 'error' };
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
