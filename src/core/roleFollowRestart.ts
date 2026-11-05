/**
 * A machine whose role changed restarts once, so the normal boot path builds what the new role
 * needs: the scheduler exists only on a machine awake at boot, and nothing else starts or stops
 * it (docs/specs/lease-takeover-role-restart.md). One tested path instead of a second way to
 * start. A durable timestamp bounds it, so a flapping lease cannot become a restart loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
      { at?: unknown; toAwake?: unknown; promotionId?: unknown; leaseEpoch?: unknown; machineId?: unknown; sweepCompletedAt?: unknown };
    if (row.toAwake !== true || typeof row.at !== 'number' || !Number.isFinite(row.at)
      || typeof row.sweepCompletedAt === 'number') return null;
    const hasId = typeof row.promotionId === 'string' && /^[a-f0-9-]{36}$/.test(row.promotionId);
    const epoch = typeof row.leaseEpoch === 'number' && Number.isSafeInteger(row.leaseEpoch) && row.leaseEpoch > 0
      ? row.leaseEpoch : null;
    const verified = hasId && epoch !== null && !!live && live.holdsLease
      && live.leaseEpoch === epoch && row.machineId === live.machineId
      && now >= row.at && now - row.at <= 60 * 60_000;
    return { id: hasId ? row.promotionId as string : `legacy-${row.at}`, at: row.at, verified, leaseEpoch: epoch };
  } catch { return null; }
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

export function readLastRoleRestart(stateDir: string): number | null {
  try {
    const at = (JSON.parse(fs.readFileSync(stampPath(stateDir), 'utf-8')) as { at?: unknown }).at;
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  } catch {
    return null; // @silent-fallback-ok: no stamp yet is the normal first case
  }
}

/**
 * Ask for the same planned restart an update uses. The request goes first: if the stamp then
 * fails, the worst case is one more restart, and after any restart the role matches boot, so
 * that cannot loop. The other order could record a restart that was never asked for.
 */
export function requestRoleRestart(files: RoleRestartFiles, toAwake: boolean): void {
  const now = (files.now ?? Date.now)();
  const dir = path.join(files.stateDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const flag = path.join(dir, 'restart-requested.json');
  const tmp = `${flag}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    requestedAt: new Date(now).toISOString(),
    requestedBy: 'role-change',
    reason: toAwake ? 'this machine took the lease' : 'this machine gave up the lease',
    plannedRestart: true,
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    pid: process.pid,
  }, null, 2));
  fs.renameSync(tmp, flag);
  fs.writeFileSync(stampPath(files.stateDir), JSON.stringify({ at: now, toAwake, ...(toAwake ? { promotionId: randomUUID(), leaseEpoch: files.leaseEpoch ?? null, machineId: files.machineId ?? null } : {}) }));
}
