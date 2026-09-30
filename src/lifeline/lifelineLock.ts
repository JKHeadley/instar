/**
 * The lifeline's single-instance lock (`state/lifeline.lock`).
 *
 * The lock records `{ pid, startedAt, procStart }`. `procStart` (the holder's
 * process start time, see core/processIdentity) is what lets a later lifeline
 * prove the live process at `pid` is still the holder before signalling it —
 * a pid on its own may by then belong to any unrelated process.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { checkRecordedProcess, ownProcessIdentity } from '../core/processIdentity.js';

/**
 * Acquire an exclusive lock file to prevent multiple lifeline instances.
 * Returns true if lock acquired, false if another instance holds it.
 *
 * Cases:
 * 1. No lock file → acquire immediately
 * 2. Lock holder dead, or its pid now belongs to a process that started after
 *    the lock was written (pid reuse) → take over WITHOUT signalling anything
 * 3. Lock holder alive and PROVEN to be the recorded holder (same start time)
 *    → check age. If it has held the lock >5 minutes and is zombie/stopped or
 *    wedged sleeping (post-sleep/wake), terminate it and take over. This
 *    prevents permanently stuck lifelines from blocking new instances.
 * 4. Holder alive but identity unproven (legacy lock without `procStart`) →
 *    respect the lock and never signal: that pid may be someone else's process.
 */
export function acquireLockFile(lockPath: string): boolean {
  try {
    // Check if lock file exists and if the PID is still alive
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf-8');
      const data = JSON.parse(raw);
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
          //   2. Sleeping (S) for >5 min without responding to SIGTERM —
          //      observed in the 2026-05-20 b2lead-insights incident: the
          //      previous lifeline received SIGTERM via the CLI's pkill
          //      fallback path and went to 'S' state but never exited,
          //      holding the lock for >5 min until manual SIGKILL.
          //   3. A live, healthy lifeline (R/S < 5 min) — DON'T touch it.
          if (!data.startedAt) return false;
          const lockAge = Date.now() - new Date(data.startedAt).getTime();
          const fiveMinutes = 5 * 60_000;
          if (lockAge <= fiveMinutes) {
            // Lock is fresh — another lifeline is running
            return false;
          }
          const procInfo = spawnSync('/bin/ps', ['-p', String(data.pid), '-o', 'stat='], {
            encoding: 'utf-8', timeout: 3000,
          }).stdout?.trim() ?? '';

          // Z (zombie) / T (stopped) — always recoverable.
          const isZombieOrStopped = procInfo.includes('Z') || procInfo.includes('T');

          // Sustained 'S' for 5+ min after the lock write with no progress is
          // the wedged state we observed: a healthy lifeline writes the lock
          // and starts running tasks within seconds, leaving 'R' or short 'S'
          // bursts.
          const isWedgedSleeping = /^S/i.test(procInfo);

          if (isZombieOrStopped) {
            console.log(`[Lifeline] Lock holder PID ${data.pid} is zombie/stopped (state: ${procInfo}) — taking over`);
            try { process.kill(data.pid, 'SIGKILL'); } catch { /* ignore */ }
          } else if (isWedgedSleeping) {
            // Try SIGTERM with a short grace window, then SIGKILL.
            console.log(`[Lifeline] Lock holder PID ${data.pid} sleeping >5min after lock write (state: ${procInfo}) — sending SIGTERM`);
            try { process.kill(data.pid, 'SIGTERM'); } catch { /* ignore */ }
            // Synchronously poll for exit up to 3s, then SIGKILL.
            const killDeadline = Date.now() + 3000;
            while (Date.now() < killDeadline && checkRecordedProcess(data) === 'same') {
              spawnSync('/bin/sleep', ['0.25'], { timeout: 500 });
            }
            // Re-prove identity before escalating: the holder may have exited
            // during the grace window and its pid been reused.
            if (checkRecordedProcess(data) === 'same') {
              console.log(`[Lifeline] PID ${data.pid} survived SIGTERM grace — SIGKILL`);
              try { process.kill(data.pid, 'SIGKILL'); } catch { /* ignore */ }
            }
          } else {
            // Process is alive and not a zombie — another lifeline is truly running
            return false;
          }
        }
      }
    }

    // Write our PID and start time
    const tmpPath = `${lockPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ ...ownProcessIdentity(), startedAt: new Date().toISOString() }));
    fs.renameSync(tmpPath, lockPath);
    return true;
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
