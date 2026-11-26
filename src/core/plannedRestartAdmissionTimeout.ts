import fs from 'node:fs';
import {
  readRestartRequestFile, removeRestartRequestMarkers, restartRequestMarkerPath, withRestartRequestFile,
} from './restartRequestFile.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const ADMISSION_WAIT_MS = 15 * 60_000;

export function restartAdmissionTimedOut(flagPath: string, raw: string): boolean {
  return fs.existsSync(restartRequestMarkerPath(flagPath, raw, 'timeout'));
}

/**
 * The watcher and supervisor share the first deferral for these exact bytes.
 * A verification hold happens before this function and does not start the clock.
 */
export function markRestartAdmissionTimeout(flagPath: string, raw: string, now = Date.now()): boolean {
  try {
    return withRestartRequestFile(flagPath, () => {
      if (readRestartRequestFile(flagPath) !== raw) return false;
      if (restartAdmissionTimedOut(flagPath, raw)) return true;
      const startedPath = restartRequestMarkerPath(flagPath, raw, 'deferred');
      if (!fs.existsSync(startedPath)) {
        SafeFsExecutor.atomicWriteFileSync(startedPath, String(now),
          { operation: 'plannedRestartAdmissionTimeout:start', mode: 0o600 });
        return false;
      }
      const timestamp = fs.readFileSync(startedPath, 'utf8');
      const startedAt = /^\d+$/.test(timestamp) ? Number(timestamp) : NaN;
      if (!Number.isSafeInteger(startedAt) || now - startedAt < ADMISSION_WAIT_MS) return false;
      SafeFsExecutor.atomicWriteFileSync(restartRequestMarkerPath(flagPath, raw, 'timeout'), 'timed out\n',
        { operation: 'plannedRestartAdmissionTimeout:mark', mode: 0o600 });
      return true;
    });
  } catch (error) {
    console.warn('[planned restart] Could not record admission deferral:', error);
    return false;
  }
}

/** Called by the reporting server after surfacing the timeout. */
export function retireTimedOutRestartRequest(flagPath: string, raw: string): void {
  try {
    withRestartRequestFile(flagPath, () => {
      if (!restartAdmissionTimedOut(flagPath, raw) || readRestartRequestFile(flagPath) !== raw) return;
      SafeFsExecutor.safeUnlinkSync(flagPath, { operation: 'plannedRestartAdmissionTimeout:retire' });
      removeRestartRequestMarkers(flagPath, raw);
    });
  } catch (error) {
    console.warn('[planned restart] Could not retire the timed-out request:', error);
  }
}
