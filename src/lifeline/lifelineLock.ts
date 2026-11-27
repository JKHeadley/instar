/**
 * The lifeline's single-instance lock (`state/lifeline.lock`).
 *
 * The lock records `{ pid, startedAt, procStart }`. `procStart` (the holder's
 * process start time, see core/processIdentity) is what lets a later lifeline
 * prove the live process at `pid` is still the holder before signalling it —
 * a pid on its own may by then belong to any unrelated process.
 *
 * A holder that writes `heartbeatMs` proves it is alive by touching the lock
 * file's mtime on that cadence (startLockHeartbeat). A stale mtime, not the
 * holder's `ps` state, is what marks it wedged: a healthy idle Node process
 * sits in `S` nearly all the time. The mtime rather than a rewritten field
 * keeps the content stable and leaves no window where the file is half-written.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { checkRecordedProcess, ownProcessIdentity } from '../core/processIdentity.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

/** How often a holder touches its lock. */
export const LOCK_HEARTBEAT_MS = 30_000;
/** A heartbeat this old, on a lock this old, marks the holder as wedged. */
const WEDGED_AFTER_MS = 5 * 60_000;
/**
 * Before acting on a stale heartbeat, wait out more than one heartbeat for it to
 * move. A Mac waking from sleep shows a stale mtime on a healthy holder until its
 * timer fires, so one look at the clock is not enough to signal anything.
 */
const SECOND_LOOK_MS = LOCK_HEARTBEAT_MS + 15_000;
const SECOND_LOOK_POLL_MS = 250;
const TAKEOVER_MUTEX_STALE_MS = 30_000;

export interface AcquireLockOptions {
  /** Overrides SECOND_LOOK_MS. */
  secondLookMs?: number;
  /** Test seam: runs immediately before the atomic create. */
  beforeCreate?: () => void;
}

function lockMtimeMs(lockPath: string): number | null {
  try { return fs.statSync(lockPath).mtimeMs; } catch { return null; }
}

/**
 * Create a file with its full content, failing if it exists. false means another
 * process got there first. A hard link never exposes an empty or partial file; a
 * filesystem without hard links falls back to an exclusive create.
 */
function createExclusive(target: string, content: string): boolean {
  const tmpPath = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content);
  try {
    fs.linkSync(tmpPath, target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    try {
      fs.writeFileSync(target, content, { flag: 'wx' });
      return true;
    } catch (fallbackErr) {
      if ((fallbackErr as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw fallbackErr;
    }
  } finally {
    try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/lifeline/lifelineLock.ts:createExclusive' }); } catch { /* @silent-fallback-ok: a leftover tmp file holds nothing */ }
  }
}

function createLockExclusive(lockPath: string): boolean {
  return createExclusive(lockPath, JSON.stringify({
    ...ownProcessIdentity(),
    startedAt: new Date().toISOString(),
    heartbeatMs: LOCK_HEARTBEAT_MS,
  }));
}

/** Blocks without a child process, and without trusting the wall clock. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a lock judged stale, as the one starter holding the takeover mutex. Two
 * starters can judge the same lock stale, and a second removal by path would delete
 * the first one's fresh lock, so a lock leaves only under the mutex and only while
 * its content is still what was judged. false means this starter lost.
 *
 * The mutex is held for a few file operations. One left by a starter that crashed
 * mid-takeover ages out, so it can never block every later start.
 */
function removeJudgedLock(lockPath: string, judgedRaw: string): boolean {
  const mutexPath = `${lockPath}.takeover`;
  const mine = String(process.pid);
  const unlinkMutex = () => SafeFsExecutor.safeUnlinkSync(mutexPath, { operation: 'src/lifeline/lifelineLock.ts:removeJudgedLock' });
  const mutexMtime = lockMtimeMs(mutexPath);
  if (mutexMtime !== null && Date.now() - mutexMtime > TAKEOVER_MUTEX_STALE_MS) {
    console.log('[Lifeline] Clearing a takeover mutex left by a crashed starter');
    unlinkMutex();
  }
  if (!createExclusive(mutexPath, mine)) return false;
  // A starter suspended past the age limit may no longer own this mutex.
  const release = () => {
    try { if (fs.readFileSync(mutexPath, 'utf-8') === mine) unlinkMutex(); } catch { /* @silent-fallback-ok: already gone */ }
  };
  try {
    let current: string;
    try {
      current = fs.readFileSync(lockPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true; // the holder released it
      throw err;
    }
    if (current !== judgedRaw) return false;
    SafeFsExecutor.safeUnlinkSync(lockPath, { operation: 'src/lifeline/lifelineLock.ts:removeJudgedLock' });
    return true;
  } finally {
    release();
  }
}

/**
 * Prove this process is alive by touching the lock's mtime. A tick that finds
 * another process's lock skips it rather than stopping: the holder never touches
 * a lock it does not own, and resumes if its own lock comes back. Returns the stop
 * function; quiesce calls it before anything that can wedge. The timer does not
 * hold the process open.
 */
export function startLockHeartbeat(lockPath: string, intervalMs: number = LOCK_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (data?.pid !== process.pid) return;
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch { /* @silent-fallback-ok: no lock to refresh this tick; a real outage shows as a stale heartbeat */ }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Acquire an exclusive lock file to prevent multiple lifeline instances.
 * Returns true if lock acquired, false if another instance holds it.
 *
 * Cases:
 * 1. No lock file → acquire immediately
 * 2. Lock holder dead, or its pid now belongs to a process that started after
 *    the lock was written (pid reuse) → take over WITHOUT signalling anything
 * 3. Lock holder alive and PROVEN to be the recorded holder (same start time)
 *    → check age. If it has held the lock >5 minutes and is zombie/stopped, or
 *    its heartbeat has stopped (still stopped after a second look), terminate it
 *    and take over. A holder from before heartbeats keeps the old test: sleeping.
 *    This prevents permanently stuck lifelines from blocking new instances.
 * 4. Holder alive but identity unproven (legacy lock without `procStart`) →
 *    respect the lock and never signal: that pid may be someone else's process.
 */
export function acquireLockFile(lockPath: string, options: AcquireLockOptions = {}): boolean {
  try {
    let judgedRaw: string | null = null;
    // Check if lock file exists and if the PID is still alive
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf-8');
      let data: Record<string, unknown> & { pid?: number; startedAt?: string; heartbeatMs?: number };
      try {
        data = JSON.parse(raw);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('lock content is not an object');
      } catch (parseErr) {
        // Unreadable names no process to signal. A young one may be mid-write; an
        // old one would otherwise block every later start for good.
        const mtime = lockMtimeMs(lockPath);
        if (mtime === null || Date.now() - mtime <= TAKEOVER_MUTEX_STALE_MS) throw parseErr;
        console.log('[Lifeline] Removing an unreadable lock left by a crash');
        data = {};
      }
      judgedRaw = raw;
      if (data.pid && typeof data.pid === 'number') {
        const identity = checkRecordedProcess(data);
        if (identity === 'gone') {
          console.log(`[Lifeline] Removing stale lock (PID ${data.pid} is dead)`);
        } else if (identity === 'reused') {
          console.log(`[Lifeline] Removing stale lock (PID ${data.pid} now belongs to a process started after the lock was written — not signalling it)`);
        } else if (identity === 'unproven') {
          // Alive, but nothing proves it is the process that wrote this lock.
          console.log(`[Lifeline] Lock PID ${data.pid} is alive but its identity is unproven — respecting the lock, not signalling`);
          return false;
        } else {
          // Proven to be the recorded holder — but is it actually functional?
          // We have three "stuck" states to detect:
          //   1. Zombie (Z) or stopped (T) — clearly dead-but-not-reaped.
          //   2. No sign of life for >5 min — observed in the 2026-05-20
          //      b2lead-insights incident: the previous lifeline received
          //      SIGTERM via the CLI's pkill fallback path and went to 'S'
          //      state but never exited, holding the lock for >5 min until
          //      manual SIGKILL.
          //   3. A live, healthy lifeline — DON'T touch it, however long it
          //      has held the lock.
          if (!data.startedAt) return false;
          const lockAge = Date.now() - new Date(data.startedAt as string).getTime();
          if (lockAge <= WEDGED_AFTER_MS) {
            // Lock is fresh — another lifeline is running
            return false;
          }
          const procInfo = spawnSync('/bin/ps', ['-p', String(data.pid), '-o', 'stat='], {
            encoding: 'utf-8', timeout: 3000,
          }).stdout?.trim() ?? '';

          // Z (zombie) / T (stopped) — always recoverable.
          const isZombieOrStopped = procInfo.includes('Z') || procInfo.includes('T');

          // A holder that heartbeats is wedged only when the heartbeat stopped,
          // whatever `ps` says. A holder from before heartbeats (no `heartbeatMs`)
          // keeps the state test, its only evidence, until it next restarts onto
          // this code.
          let isWedgedSleeping: boolean;
          if (typeof data.heartbeatMs === 'number') {
            isWedgedSleeping = false;
            if (!isZombieOrStopped) {
              const mtime = lockMtimeMs(lockPath);
              if (mtime === null || Date.now() - mtime <= WEDGED_AFTER_MS) return false;
              // Counted polls, not a wall-clock deadline: a clock jump or a sleep
              // right after a wake must not cut the look short.
              const polls = Math.ceil((options.secondLookMs ?? SECOND_LOOK_MS) / SECOND_LOOK_POLL_MS);
              for (let i = 0; i < polls; i++) {
                sleepSync(SECOND_LOOK_POLL_MS);
                if (lockMtimeMs(lockPath) !== mtime) return false;
              }
              isWedgedSleeping = true;
            }
          } else {
            isWedgedSleeping = /^S/i.test(procInfo);
          }

          if (isZombieOrStopped) {
            console.log(`[Lifeline] Lock holder PID ${data.pid} is zombie/stopped (state: ${procInfo}) — taking over`);
            try { process.kill(data.pid, 'SIGKILL'); } catch { /* ignore */ }
          } else if (isWedgedSleeping) {
            // Try SIGTERM with a short grace window, then SIGKILL.
            console.log(`[Lifeline] Lock holder PID ${data.pid} shows no sign of life >5min after lock write (state: ${procInfo}) — sending SIGTERM`);
            try { process.kill(data.pid, 'SIGTERM'); } catch { /* ignore */ }
            // Synchronously poll for exit up to 3s, then SIGKILL.
            const killDeadline = Date.now() + 3000;
            while (Date.now() < killDeadline && checkRecordedProcess(data) === 'same') {
              spawnSync('/bin/sleep', ['0.25'], { timeout: 500 });
            }
            // Re-prove identity before escalating: the holder may have exited
            // during the grace window and its pid been reused.
            const afterGrace = checkRecordedProcess(data);
            if (afterGrace === 'same') {
              console.log(`[Lifeline] PID ${data.pid} survived SIGTERM grace — SIGKILL`);
              try { process.kill(data.pid, 'SIGKILL'); } catch { /* ignore */ }
            } else if (afterGrace === 'unproven') {
              // Identity became unreadable while the pid is still there: the
              // holder may be alive — neither escalate nor take its lock.
              console.log(`[Lifeline] PID ${data.pid} identity unreadable after SIGTERM grace — respecting the lock, not signalling`);
              return false;
            }
          } else {
            // Process is alive and not a zombie — another lifeline is truly running
            return false;
          }
        }
      }
    }

    if (judgedRaw !== null && !removeJudgedLock(lockPath, judgedRaw)) return false;
    options.beforeCreate?.();
    return createLockExclusive(lockPath);
  } catch (err) {
    console.error(`[Lifeline] Lock acquisition failed: ${err}`);
    return false;
  }
}

export interface RecordedLifeline { pid: number; procStart?: unknown; startedAt?: unknown }

/**
 * The lifeline processes `lifeline restart` may signal: the lock holder (the
 * process actually wedging the respawn) and the startup-marker pid, each kept
 * ONLY while the live process at that pid is proven to be the one that wrote
 * the record (same start time). Legacy records without a start time, dead
 * pids and reused pids are dropped — they are never signalled.
 */
export function provenLifelineRecords(lockPath: string, marker: RecordedLifeline | null): RecordedLifeline[] {
  const records: RecordedLifeline[] = [];
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (typeof lock?.pid === 'number') records.push(lock);
  } catch { /* no lock file — nothing holds it */ }
  if (marker && typeof marker.pid === 'number') records.push(marker);
  const seen = new Set<number>();
  return records.filter((r) => {
    if (r.pid === process.pid || seen.has(r.pid)) return false;
    seen.add(r.pid);
    return checkRecordedProcess(r) === 'same';
  });
}
