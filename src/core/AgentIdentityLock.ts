/**
 * AgentIdentityLock — the one lock every agent-identity MUTATION on a machine takes.
 *
 * Spec: docs/specs/a2a-single-agent-identity.md §1.2 ("The identity lock").
 *
 * Shared by adoption (§1.2), the operator CLI (§1.4), the legacy-mirror repair (§1.5) and
 * `instar join`. Two processes can never both hold it:
 *   - creation is O_EXCL (`wx`), stamped with pid + that process's START TIME (pids are
 *     reused; the pair is not);
 *   - a lock is STALE when that pair no longer matches a live process AND it is older than
 *     60 s, or after a 10-min ceiling regardless;
 *   - a stale lock is broken by RENAMING it to a unique name (only one breaker's rename
 *     succeeds), after which creation goes through O_EXCL again;
 *   - a waiter retries for up to 30 s, then refuses `identity-locked`.
 *
 * No key material ever passes through here — the lock file carries a pid and timestamps.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';

export const IDENTITY_LOCK_FILE = 'identity.lock';
export const IDENTITY_LOCK_STALE_MS = 60_000;
export const IDENTITY_LOCK_CEILING_MS = 10 * 60_000;
export const IDENTITY_LOCK_WAIT_MS = 30_000;

export class IdentityLockedError extends Error {
  readonly code = 'identity-locked';
  readonly holderPid: number | null;
  constructor(holderPid: number | null) {
    super(
      `Another process is changing this machine's agent identity (pid ${holderPid ?? 'unknown'}); ` +
        'waited 30 s and gave up. Retry once it has finished.',
    );
    this.name = 'IdentityLockedError';
    this.holderPid = holderPid;
  }
}

export interface IdentityLockHandle {
  readonly path: string;
  release(): void;
}

export interface IdentityLockDeps {
  now?: () => number;
  pid?: number;
  /** This process's start time (ms epoch), stamped into the lock. Default: derived from `process.uptime()`. */
  processStartMs?: number;
  /** Is this pid alive? Injected for tests (default: `process.kill(pid, 0)`). */
  isPidAlive?: (pid: number) => boolean;
  /**
   * The start time (ms epoch) of a LIVE pid, or null when it cannot be read. Injected for
   * tests (default: `ps -o lstart=`). Null means "cannot tell" and the pid's liveness alone
   * decides — never a reason to break a lock early.
   */
  processStartOf?: (pid: number) => number | null;
  /** Sleep between retries (default: a short synchronous wait). Injected for tests. */
  sleepMs?: (ms: number) => void;
  waitMs?: number;
  staleMs?: number;
  ceilingMs?: number;
}

interface LockStamp {
  pid?: number;
  startedAt?: string;
  at?: string;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // @silent-fallback-ok — kill(pid, 0) throwing ESRCH means dead; EPERM means alive-but-not-ours. Both are the answer, not a degrade.
    // EPERM means the process exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `ps -o lstart=` for one pid; null when unavailable (Windows, ps missing, pid gone). */
function defaultProcessStartOf(pid: number): number | null {
  try {
    // Funneled through the sync-op marker: a 2 s-bounded `ps` on a lock-contention path only
    // (never on a cadence), so the in-flight marker can tell this block from a sleep.
    const out = withSyncOp(() => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    // @silent-fallback-ok — an unreadable process start time means "cannot tell", which isLockStale treats as NOT stale (the safe direction: never break a live holder's lock).
    return null;
  }
}

function defaultSleepMs(ms: number): void {
  const until = Date.now() + ms;
  // A short synchronous wait: the lock is only ever held for one identity write (ms, not s),
  // and the callers (CLI, boot repair, adoption tick) are not latency-sensitive.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, until - Date.now()));
}

type FullDeps = Required<Pick<IdentityLockDeps, 'now' | 'pid' | 'processStartMs' | 'isPidAlive' | 'processStartOf' | 'staleMs' | 'ceilingMs'>>;

/**
 * Is the lock stamped `stamp`, aged `ageMs`, stale? Pure — exported so the rule is testable
 * without a filesystem.
 */
export function isLockStale(stamp: LockStamp, ageMs: number, deps: Pick<FullDeps, 'isPidAlive' | 'processStartOf' | 'staleMs' | 'ceilingMs'>): boolean {
  if (ageMs >= deps.ceilingMs) return true; // the ceiling: pids are reused, clocks drift
  if (ageMs < deps.staleMs) return false; // too young to judge, whatever the pid says
  const pid = typeof stamp.pid === 'number' ? stamp.pid : null;
  if (pid === null) return true; // no pid to be alive
  if (!deps.isPidAlive(pid)) return true;
  // The pid is alive — but is it the SAME process? Compare start times when both are known.
  const stampedStart = typeof stamp.startedAt === 'string' ? Date.parse(stamp.startedAt) : NaN;
  const liveStart = deps.processStartOf(pid);
  if (!Number.isFinite(stampedStart) || liveStart === null) return false; // cannot tell → not stale
  return Math.abs(liveStart - stampedStart) > 5_000; // a different process reused the pid
}

/**
 * Try ONCE to take the lock. Returns a handle, `{holderPid}` when a live holder has it, or
 * breaks a stale lock and retries the create.
 */
function tryAcquire(lockPath: string, deps: FullDeps): IdentityLockHandle | { holderPid: number | null } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const stamp: LockStamp = { pid: deps.pid, startedAt: new Date(deps.processStartMs).toISOString(), at: new Date(deps.now()).toISOString() };
  try {
    fs.writeFileSync(lockPath, JSON.stringify(stamp), { flag: 'wx', mode: 0o600 });
    return {
      path: lockPath,
      release: () => {
        try {
          // Release only OUR lock: a lock file whose pid is not ours belongs to a later holder.
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockStamp;
          if (cur.pid !== deps.pid) return;
          SafeFsExecutor.safeUnlinkSync(lockPath, { operation: 'src/core/AgentIdentityLock.ts:release' });
        } catch {
          /* already gone */
        }
      },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Someone holds it. Read the stamp (or fall back to the file's mtime).
  let cur: LockStamp = {};
  let ageMs: number;
  try {
    cur = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockStamp;
    const at = typeof cur.at === 'string' ? Date.parse(cur.at) : NaN;
    ageMs = Number.isFinite(at) ? deps.now() - at : Number.POSITIVE_INFINITY;
  } catch {
    try {
      ageMs = deps.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      // The holder released between our create and our read — retry the create.
      return tryAcquire(lockPath, deps);
    }
  }
  const holderPid = typeof cur.pid === 'number' ? cur.pid : null;
  if (!isLockStale(cur, ageMs, deps)) return { holderPid };

  // Stale: break it by rename-to-unique. Exactly one breaker's rename succeeds; the losers see
  // ENOENT and simply retry the exclusive create, which the winner may already have won.
  const broken = `${lockPath}.stale-${deps.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(lockPath, broken);
    try {
      SafeFsExecutor.safeUnlinkSync(broken, { operation: 'src/core/AgentIdentityLock.ts:break-stale' });
    } catch {
      /* a leftover broken-lock file is inert */
    }
  } catch {
    /* another breaker won the rename; fall through to the retry */
  }
  return tryAcquire(lockPath, deps);
}

/**
 * Acquire the identity lock for `stateDir`, waiting up to `waitMs` (default 30 s).
 * @throws IdentityLockedError when a live holder keeps it for the whole wait.
 */
export function acquireIdentityLock(stateDir: string, deps: IdentityLockDeps = {}): IdentityLockHandle {
  const now = deps.now ?? Date.now;
  const full: FullDeps = {
    now,
    pid: deps.pid ?? process.pid,
    processStartMs: deps.processStartMs ?? Math.round(Date.now() - process.uptime() * 1000),
    isPidAlive: deps.isPidAlive ?? defaultIsPidAlive,
    processStartOf: deps.processStartOf ?? defaultProcessStartOf,
    staleMs: deps.staleMs ?? IDENTITY_LOCK_STALE_MS,
    ceilingMs: deps.ceilingMs ?? IDENTITY_LOCK_CEILING_MS,
  };
  const sleep = deps.sleepMs ?? defaultSleepMs;
  const waitMs = deps.waitMs ?? IDENTITY_LOCK_WAIT_MS;
  const lockPath = path.join(stateDir, IDENTITY_LOCK_FILE);
  const deadline = now() + waitMs;
  let lastHolder: number | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = tryAcquire(lockPath, full);
    if ('release' in r) return r;
    lastHolder = r.holderPid;
    if (now() >= deadline) throw new IdentityLockedError(lastHolder);
    sleep(Math.min(250, Math.max(1, deadline - now())));
  }
}

/** Run `fn` under the identity lock; always releases. */
export function withIdentityLock<T>(stateDir: string, fn: () => T, deps: IdentityLockDeps = {}): T {
  const h = acquireIdentityLock(stateDir, deps);
  try {
    return fn();
  } finally {
    h.release();
  }
}
