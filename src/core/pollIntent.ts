/**
 * B1 (multimachine-lease-poll-robustness, Decisions 4/5/6) — the cross-process
 * poll-intent file. The SERVER (which holds the fenced lease) writes its
 * lease-derived poll intent here on every role transition; the LIFELINE (a
 * separate process that owns the Telegram socket) reads it to decide whether to
 * poll (via decidePollAction). This is the bridge that makes poll-ownership
 * FOLLOW the lease at runtime instead of a static boot-time flag.
 *
 * Integrity (Decision 5): the record carries the writing server's `serverPid` +
 * `bootId` + `ts`. The lifeline IGNORES an intent (→ "no current opinion", null)
 * that is stale (older than a bound) or whose writer pid is dead — so a stale
 * `{shouldPoll:true}` left on disk after a crash can NOT resurrect a poller, and a
 * stale `{shouldPoll:false}` can NOT wrongly silence a live awake machine. The
 * server writes `{shouldPoll:false}` at boot (before its role is known), so the
 * default on-disk state is the safe one (mute). A graceful-shutdown mute is NOT
 * relied upon: a crashed/exited writer is covered by the consumer's dead-pid +
 * staleness gate (`effectivePollIntent` → null → the lifeline HOLDs).
 *
 * Threat model: local same-uid IPC (parity with TelegramPollOwnerLease) — never
 * network-reachable. Atomic write (tmp + rename) so the lifeline never reads a
 * torn record.
 */

import { writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PollIntentRecord {
  shouldPoll: boolean;
  leaseEpoch: number;
  role: 'awake' | 'standby';
  serverPid: number;
  bootId: string;
  /** epoch ms when written. */
  ts: number;
}

const FILE = 'telegram-poll-intent.json';

/** Absolute path to the intent file under a state dir (`.instar`). */
export function pollIntentPath(stateDir: string): string {
  return join(stateDir, FILE);
}

/** Atomic write (tmp + rename). Never throws to the caller's hot path — callers wrap. */
export function writePollIntent(stateDir: string, rec: PollIntentRecord): void {
  const p = pollIntentPath(stateDir);
  const tmp = `${p}.tmp.${rec.serverPid}`;
  writeFileSync(tmp, JSON.stringify(rec), 'utf8');
  renameSync(tmp, p);
}

/** Read + parse the intent record. Returns null on missing/corrupt. */
export function readPollIntent(stateDir: string): PollIntentRecord | null {
  const p = pollIntentPath(stateDir);
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8')) as PollIntentRecord;
    if (typeof rec?.shouldPoll !== 'boolean' || typeof rec?.serverPid !== 'number' || typeof rec?.ts !== 'number') {
      return null; // shape check — a partial/legacy record is "no opinion"
    }
    return rec;
  } catch {
    return null;
  }
}

export interface PollIntentFreshnessInputs {
  nowMs: number;
  /** Max age before the record is "no current opinion". */
  maxStaleMs: number;
  /** Is the writing server pid alive? (caller probes process liveness.) */
  serverPidAlive: boolean;
}

/**
 * The EFFECTIVE poll intent the lifeline should act on:
 *   - true / false  — a fresh, live-writer record's shouldPoll.
 *   - null          — "no current opinion": missing, stale (> maxStaleMs), or the
 *                     writing server pid is dead. decidePollAction treats null as
 *                     HOLD (never a surprise stop, never a blind start).
 *
 * Pure — the I/O (read + pid probe) is the caller's; this decides trust.
 */
export function effectivePollIntent(
  rec: PollIntentRecord | null,
  i: PollIntentFreshnessInputs,
): boolean | null {
  if (!rec) return null;
  if (!i.serverPidAlive) return null; // writer is dead → its opinion is stale
  if (i.nowMs - rec.ts > i.maxStaleMs) return null; // too old → no current opinion
  return rec.shouldPoll;
}

// ── lifeline-poll-active (B5 source — Decision 6) ───────────────────────────
// The LIFELINE (the process that actually owns the getUpdates socket) writes its
// REAL poll state here; B5's exactly-one-listener guard reads THIS (the truth),
// not the server's intent (a wish). Same local-same-uid IPC + atomic-write posture.

const POLL_ACTIVE_FILE = 'lifeline-poll-active.json';

export interface PollActiveRecord { pollingActive: boolean; pid: number; ts: number; }

export function pollActivePath(stateDir: string): string {
  return join(stateDir, POLL_ACTIVE_FILE);
}

export function writePollActive(stateDir: string, pollingActive: boolean): void {
  const p = pollActivePath(stateDir);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ pollingActive, pid: process.pid, ts: Date.now() } satisfies PollActiveRecord), 'utf8');
  renameSync(tmp, p);
}

export function readPollActive(stateDir: string): PollActiveRecord | null {
  const p = pollActivePath(stateDir);
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, 'utf8')) as PollActiveRecord;
    if (typeof rec?.pollingActive !== 'boolean' || typeof rec?.ts !== 'number') return null;
    return rec;
  } catch {
    return null;
  }
}

/** True iff a pid is alive (probe). Used to discount a crashed writer's record. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) {
    // EPERM = exists but not ours (still alive); ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
