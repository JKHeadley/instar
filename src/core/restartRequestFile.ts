import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hasPlannedRestartDeliveryProof, type PlannedRestartFlag } from './plannedRestartDelivery.js';
import lockfile from 'proper-lockfile';
import { SafeFsExecutor } from './SafeFsExecutor.js';

/** Serialize restart publishers and conditional retirement on the same host. */
export function withRestartRequestFile<T>(flagPath: string, change: () => T): T {
  const release = lockfile.lockSync(flagPath, { realpath: false });
  try {
    return change();
  } finally {
    release();
  }
}

export function restartRequestMarkerPath(flagPath: string, raw: string, kind: 'deferred' | 'timeout'): string {
  const digest = createHash('sha256').update(raw).digest('hex');
  return `${flagPath}.admission-${kind}-${digest}`;
}

export function removeRestartRequestMarkers(flagPath: string, raw: string): void {
  for (const kind of ['deferred', 'timeout'] as const) {
    const marker = restartRequestMarkerPath(flagPath, raw, kind);
    if (!fs.existsSync(marker)) continue;
    try {
      SafeFsExecutor.safeUnlinkSync(marker, { operation: 'restartRequestFile:remove-marker' });
    } catch (error) {
      console.warn('[planned restart] Could not remove an obsolete marker:', error);
    }
  }
}

/** Publish while the caller holds the request lock. */
export function replaceRestartRequestFile(flagPath: string, raw: string, previous: string | null): void {
  SafeFsExecutor.atomicWriteFileSync(flagPath, raw, { operation: 'restartRequestFile:publish', mode: 0o600 });
  if (previous !== null && previous !== raw) removeRestartRequestMarkers(flagPath, previous);
}

export function publishRestartRequestFile(flagPath: string, raw: string): boolean {
  return withRestartRequestFile(flagPath, () => publishRestartRequestUnderLock(flagPath, raw, readRestartRequestFile(flagPath)).published);
}

/** Read the exact request bytes. Missing is distinct from a read failure. */
export function readRestartRequestFile(flagPath: string): string | null {
  try {
    return fs.readFileSync(flagPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Claim or discard only the exact active request observed by the caller. */
export function removeActiveRestartRequestFile(flagPath: string, raw: string): boolean {
  try {
    return withRestartRequestFile(flagPath, () => {
      if (readRestartRequestFile(flagPath) !== raw ||
          fs.existsSync(restartRequestMarkerPath(flagPath, raw, 'timeout'))) return false;
      SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'restartRequestFile:remove-active' });
      removeRestartRequestMarkers(flagPath, raw);
      return true;
    });
  } catch (error) {
    // @silent-fallback-ok: log the failure and leave the current request unclaimed.
    console.warn('[planned restart] Could not claim the current request:', error);
    return false;
  }
}

/** Async publishers can wait briefly for contention without blocking the process. */
export async function withRestartRequestFileAsync<T>(flagPath: string, change: () => T): Promise<T> {
  const release = await lockfile.lock(flagPath, {
    realpath: false,
    retries: { retries: 6, factor: 2, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    return change();
  } finally {
    await release();
  }
}

interface RestartRequestOrder {
  requestedAt: number;
  expiresAt: number | null;
  targetVersion: string | null;
  bypassHolds: boolean;
  withdrawable: boolean;
  record: PlannedRestartFlag;
}

function requestOrder(raw: string): RestartRequestOrder | null {
  try {
    const request = JSON.parse(raw) as (PlannedRestartFlag & { targetVersion?: unknown; requestedBy?: unknown }) | null;
    if (!request) return null;
    return {
      requestedAt: typeof request.requestedAt === 'string' ? Date.parse(request.requestedAt) : NaN,
      expiresAt: typeof request.expiresAt === 'string' ? Date.parse(request.expiresAt) : null,
      targetVersion: typeof request.targetVersion === 'string' && request.targetVersion ? request.targetVersion : null,
      bypassHolds: request.bypassHolds === true,
      withdrawable: request.requestedBy === 'role-change',
      record: request,
    };
  } catch {
    // @silent-fallback-ok: legacy or malformed bytes carry no reliable ordering evidence.
    return null;
  }
}

function activeRequestOrder(flagPath: string, current: string, now = Date.now()): RestartRequestOrder | null {
  if (fs.existsSync(restartRequestMarkerPath(flagPath, current, 'timeout'))) return null;
  const active = requestOrder(current);
  if (!active) return null;
  const withinTtl = active.expiresAt === null || active.expiresAt >= now;
  return withinTtl || hasPlannedRestartDeliveryProof(path.dirname(flagPath), active.record, now) ? active : null;
}

function keepCurrentRequest(active: RestartRequestOrder, incoming: RestartRequestOrder | null): boolean {
  if (!incoming) return active.targetVersion !== null;
  if (Boolean(active.targetVersion) !== Boolean(incoming.targetVersion)) return active.targetVersion !== null;
  if (active.targetVersion && active.targetVersion === incoming.targetVersion && active.bypassHolds !== incoming.bypassHolds) {
    return active.bypassHolds;
  }
  // A role-change request can be withdrawn. It cannot satisfy a durable restart obligation.
  if (active.withdrawable !== incoming.withdrawable) return !active.withdrawable;
  // Keep the current owner on a timestamp tie. A later lock acquisition proves no newer intent.
  return active.requestedAt >= incoming.requestedAt;
}

type RestartPublication =
  | { published: true }
  | { published: false; targetVersion: string | null };

/** Compare live obligations and capture the outcome while holding the publication lock. */
export function publishRestartRequestUnderLock(flagPath: string, raw: string, current: string | null): RestartPublication {
  const active = current === null ? null : activeRequestOrder(flagPath, current);
  if (active && keepCurrentRequest(active, requestOrder(raw))) {
    return { published: false, targetVersion: active.targetVersion };
  }
  replaceRestartRequestFile(flagPath, raw, current);
  return { published: true };
}

export async function publishRestartRequestFileAsync(flagPath: string, raw: string): Promise<RestartPublication> {
  const publish = () => publishRestartRequestUnderLock(flagPath, raw, readRestartRequestFile(flagPath));
  try {
    return withRestartRequestFile(flagPath, publish);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
    return await withRestartRequestFileAsync(flagPath, publish);
  }
}

export function pendingUpdateRestartTarget(flagPath: string, raw: string | null, now = Date.now()): string | null {
  return raw === null ? null : activeRequestOrder(flagPath, raw, now)?.targetVersion ?? null;
}
