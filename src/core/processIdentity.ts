/**
 * processIdentity — prove a recorded pid is still the process that recorded it.
 *
 * A pid alone is not identity: once the recorded process exits, the kernel can
 * hand the same number to any unrelated process (a `claude -p` builder, a test
 * run). Every automatic kill path that works from a pid it wrote down earlier
 * (the lifeline lock and startup marker, the orphan reaper's SIGKILL
 * escalation) records the process START TIME beside the pid and signals only
 * when the live process at that pid still has that start time. Where identity
 * cannot be proven, callers do not signal.
 */

import { spawnSync } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';

/**
 * Start time of a live pid in epoch ms (1 s resolution, from `ps -o lstart=`),
 * or null when nothing runs at that pid or ps cannot say.
 */
export function processStartMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = withSyncOp(() => spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      timeout: 3000,
      env: { ...process.env, LC_ALL: 'C' },
    })).stdout ?? '';
    const t = Date.parse(out.trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    // @silent-fallback-ok — unreadable means unproven, which never signals
    return null;
  }
}

/** The identity fields a process records about itself next to its pid. */
export function ownProcessIdentity(): { pid: number; procStart: number | null } {
  return { pid: process.pid, procStart: processStartMs(process.pid) };
}

/**
 * - `same`: the live process at `pid` has the recorded start time — the recorder itself.
 * - `gone`: nothing runs at `pid` — confirmed by an existence probe (ESRCH),
 *   never inferred from a failed or unreadable start-time lookup.
 * - `reused`: the live process started after the record was written, so it
 *   cannot be the recorder (the pid was reused).
 * - `unproven`: alive, but no recorded start time to compare (legacy record) or
 *   a mismatch that timing cannot settle, or the start time could not be read
 *   (ps denied, timed out, unparseable) while the pid may still be alive.
 *   Never signal on this, and never treat it as a free lock.
 */
export type RecordedProcessVerdict = 'same' | 'gone' | 'reused' | 'unproven';

export function checkRecordedProcess(record: { pid?: unknown; procStart?: unknown; startedAt?: unknown }): RecordedProcessVerdict {
  const pid = record.pid;
  if (typeof pid !== 'number') return 'unproven';
  const liveStart = processStartMs(pid);
  if (liveStart === null) return pidExists(pid) ? 'unproven' : 'gone';
  if (typeof record.procStart === 'number' && record.procStart === liveStart) return 'same';
  // The recorder was alive when it wrote the record, and two live processes
  // never share a pid — so a process that started after the write (beyond the
  // 1 s resolution of lstart) is a different one.
  const writtenAt = typeof record.startedAt === 'string' ? Date.parse(record.startedAt) : NaN;
  if (Number.isFinite(writtenAt) && liveStart > writtenAt + 2000) return 'reused';
  return 'unproven';
}

/**
 * False only when the kernel confirms nothing runs at `pid` (ESRCH). Any other
 * outcome — alive, EPERM (alive but not ours), a non-integer pid — is treated
 * as possibly alive.
 */
function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}
