import { createHash } from 'node:crypto';
import fs from 'node:fs';
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

export function publishRestartRequestFile(flagPath: string, raw: string): void {
  withRestartRequestFile(flagPath, () => replaceRestartRequestFile(flagPath, raw, readRestartRequestFile(flagPath)));
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

export function publishRestartRequestFileAsync(flagPath: string, raw: string): Promise<void> {
  return withRestartRequestFileAsync(flagPath, () => replaceRestartRequestFile(flagPath, raw, readRestartRequestFile(flagPath)));
}

export function pendingUpdateRestartTarget(flagPath: string, raw: string | null, now = Date.now()): string | null {
  if (raw === null || fs.existsSync(restartRequestMarkerPath(flagPath, raw, 'timeout'))) return null;
  try {
    const row = JSON.parse(raw) as { targetVersion?: unknown; expiresAt?: unknown } | null;
    if (!row || typeof row.targetVersion !== 'string' || !row.targetVersion) return null;
    return typeof row.expiresAt !== 'string' || Date.parse(row.expiresAt) > now ? row.targetVersion : null;
  } catch {
    return null;
  }
}
