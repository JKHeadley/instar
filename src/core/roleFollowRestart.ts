/**
 * A machine whose role changed restarts once, so the normal boot path builds what the new role
 * needs: the scheduler exists only on a machine awake at boot, and nothing else starts or stops
 * it (docs/specs/lease-scheduler-role-continuity.eli16.md). One tested path instead of a second way to
 * start. A durable timestamp bounds it, so a flapping lease cannot become a restart loop.
 */

import { readRestartRequestFile, removeActiveRestartRequestFile, publishRestartRequestUnderLock, withRestartRequestFileAsync } from './restartRequestFile.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { announceRestartRequested, announceRestartWithdrawn } from './restartRequestSignal.js';

export const ROLE_RESTART_MIN_INTERVAL_MS = 15 * 60_000;

export type RoleRestartDecision = 'restart' | 'same-as-boot' | 'not-applicable' | 'too-soon';

export function decideRoleRestart(input: {
  applies: boolean;
  bootAwake: boolean;
  nowAwake: boolean;
  lastRestartAtMs: number | null;
  nowMs: number;
}): RoleRestartDecision {
  if (!input.applies) return 'not-applicable';
  if (input.bootAwake === input.nowAwake) return 'same-as-boot';
  if (input.lastRestartAtMs !== null && input.nowMs - input.lastRestartAtMs < ROLE_RESTART_MIN_INTERVAL_MS) return 'too-soon';
  return 'restart';
}

export interface RoleRestartFiles {
  stateDir: string;
  now?: () => number;
  leaseEpoch?: number;
  machineId?: string;
  /** Re-checked after the lease wait, before the request is written: false means the role moved back and nothing is written. */
  stillNeeded?: () => boolean;
}

function stampPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'role-restart.json');
}

export interface RecentPromotion {
  id: string;
  at: number;
  verified: boolean;
  leaseEpoch: number | null;
}

/** A recent awake role-change request, including legacy stamps with unknown identity. */
export function readRecentPromotion(stateDir: string, now = Date.now(), live?: { leaseEpoch: number; machineId: string; holdsLease: boolean }): RecentPromotion | null {
  try {
    const row = JSON.parse(fs.readFileSync(stampPath(stateDir), 'utf-8')) as
      { at?: unknown; toAwake?: unknown; promotionId?: unknown; leaseEpoch?: unknown; machineId?: unknown; sweepCompletedAt?: unknown; leaseObservedAt?: unknown };
    if (row.toAwake !== true || typeof row.at !== 'number' || !Number.isFinite(row.at)
      || typeof row.sweepCompletedAt === 'number') return null;
    const hasId = typeof row.promotionId === 'string' && /^[a-f0-9-]{36}$/.test(row.promotionId);
    const epoch = typeof row.leaseEpoch === 'number' && Number.isSafeInteger(row.leaseEpoch) && row.leaseEpoch > 0
      ? row.leaseEpoch : null;
    const leaseObservedAt = typeof row.leaseObservedAt === 'number' && row.leaseObservedAt >= row.at
      ? row.leaseObservedAt
      : row.at;
    const verified = hasId && epoch !== null && !!live && live.holdsLease
      && live.leaseEpoch === epoch && row.machineId === live.machineId
      && now >= leaseObservedAt && now - leaseObservedAt <= 60 * 60_000;
    return { id: hasId ? row.promotionId as string : `legacy-${row.at}`, at: row.at, verified, leaseEpoch: epoch };
  } catch {
    // @silent-fallback-ok: a missing or unreadable promotion stamp cannot confer catch-up authority.
    return null;
  }
}

/** Consume only the promotion whose missed-work sweep finished. Later ordinary boots resume normal scheduling. */
export function markPromotionSweepComplete(stateDir: string, promotionId: string, now = Date.now()): void {
  const file = stampPath(stateDir);
  const row = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const rowId = typeof row.promotionId === 'string' ? row.promotionId : `legacy-${row.at}`;
  if (row.toAwake !== true || rowId !== promotionId || typeof row.sweepCompletedAt === 'number') return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...row, sweepCompletedAt: now }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

interface RoleRestartStamp {
  at?: unknown;
  roleRequestedAt?: unknown;
  toAwake?: unknown;
  carriedBy?: unknown;
  leaseEpoch?: unknown;
  machineId?: unknown;
  leaseObservedAt?: unknown;
  promotionId?: unknown;
}

function readRoleRestartStamp(stateDir: string): RoleRestartStamp | null {
  try {
    return JSON.parse(fs.readFileSync(stampPath(stateDir), 'utf-8')) as RoleRestartStamp | null;
  } catch {
    return null; // @silent-fallback-ok: no stamp yet is the normal first case
  }
}

function lastPublishedRoleRestart(stamp: RoleRestartStamp | null): number | null {
  // Older stamps predate the distinction and only recorded published role requests.
  const at = stamp?.roleRequestedAt === undefined ? stamp?.at : stamp.roleRequestedAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

export function readLastRoleRestart(stateDir: string): number | null {
  return lastPublishedRoleRestart(readRoleRestartStamp(stateDir));
}

/**
 * Ask for the same planned restart an update uses. The request goes first: if the stamp then
 * fails, the worst case is one more restart, and after any restart the role matches boot, so
 * that cannot loop. The other order could record a restart that was never asked for.
 */
export async function requestRoleRestart(files: RoleRestartFiles, toAwake: boolean): Promise<void> {
  const now = (files.now ?? Date.now)();
  const requestedAt = new Date(now).toISOString();
  const reason = toAwake ? 'this machine took the lease' : 'this machine gave up the lease';
  // planned-restart-keeps-lead §1 step 1: the lease holder extends its lease over the coming boot
  // BEFORE the request is visible to either consumer. Resolves at once when nothing is signed.
  await announceRestartRequested({ requestedBy: 'role-change', reason, requestedAt });
  if (files.stillNeeded && !files.stillNeeded()) return; // the role moved back while the lease was secured
  const dir = path.join(files.stateDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const flag = path.join(dir, 'restart-requested.json');
  const raw = JSON.stringify({
    requestedAt,
    requestedBy: 'role-change',
    reason,
    plannedRestart: true,
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    pid: process.pid,
  }, null, 2);
  await withRestartRequestFileAsync(flag, () => {
    if (files.stillNeeded && !files.stillNeeded()) return;
    const current = readRestartRequestFile(flag);
    const result = publishRestartRequestUnderLock(flag, raw, current);
    const carriedBy = !result.published && current !== null
      ? createHash('sha256').update(current).digest('hex')
      : null;
    const previous = readRoleRestartStamp(files.stateDir);
    const storeStamp = (stamp: RoleRestartStamp) => SafeFsExecutor.atomicWriteFileSync(
      stampPath(files.stateDir), JSON.stringify(stamp), { operation: 'roleFollowRestart:stamp', mode: 0o600 },
    );
    if (carriedBy && previous?.carriedBy === carriedBy && previous.toAwake === toAwake &&
        (!toAwake || (previous.leaseEpoch === (files.leaseEpoch ?? null) && previous.machineId === (files.machineId ?? null)))) {
      // Keep the promotion ID and original time while refreshing evidence of the same live epoch.
      const observedAt = typeof previous.leaseObservedAt === 'number' ? previous.leaseObservedAt : previous.at;
      if (toAwake && typeof observedAt === 'number' && now - observedAt >= 30 * 60_000) {
        storeStamp({ ...previous, leaseObservedAt: now });
      }
      return;
    }

    // A retained restart can carry promotion evidence, but if it disappears the
    // next role check must be free to publish. Only our own publication advances cooldown.
    const roleRequestedAt = result.published ? now : lastPublishedRoleRestart(previous);
    storeStamp({
      at: now, toAwake, roleRequestedAt, carriedBy,
      ...(toAwake ? { promotionId: randomUUID(), leaseEpoch: files.leaseEpoch ?? null, machineId: files.machineId ?? null, leaseObservedAt: now } : {}),
    });
  });
}

/**
 * Take back a role restart this process asked for and no longer needs. A planned restart can wait
 * a long time (a running Local Verify holds it). If the role returns to what it was at boot while
 * the request waits, the restart has nothing left to do: this process already has what its role
 * needs. Left in place, it ran anyway, ended the verify that started next, and left the lease
 * unrenewed for the length of a boot (seen on 2026-11-20: a machine that had the lease back ten
 * minutes was restarted for "this machine gave up the lease").
 *
 * Only a request written by this process for a role change is removed: an update's request, or
 * one from another writer, is never touched. Returns true when a request was withdrawn.
 */
export function withdrawRoleRestart(files: Pick<RoleRestartFiles, 'stateDir'>, pid: number = process.pid): boolean {
  const flag = path.join(files.stateDir, 'state', 'restart-requested.json');
  let raw: string;
  let row: { requestedBy?: unknown; pid?: unknown };
  try {
    raw = fs.readFileSync(flag, 'utf-8');
    row = JSON.parse(raw) as { requestedBy?: unknown; pid?: unknown };
  } catch {
    return false; // @silent-fallback-ok: no request (or one being written) means nothing to withdraw
  }
  if (!row || row.requestedBy !== 'role-change' || row.pid !== pid) return false;
  if (!removeActiveRestartRequestFile(flag, raw)) return false;
  announceRestartWithdrawn(); // the pending-restart renewal returns to the TTL at once
  return true;
}
