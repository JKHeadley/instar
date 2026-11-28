/**
 * The restore marker (docs/specs/recommended-services.md, Real-problem events, `state-loss-risk`): a restore from a
 * local snapshot leaves this file, and the server reads it once at its next start. It holds only the time and the
 * snapshot id. Whoever reads it clears it, so one restore is one reading.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface RestoreMarker {
  at: string;
  snapshotId: string;
}

export function restoreMarkerFile(stateDir: string): string {
  return path.join(stateDir, 'state', 'restore-marker.json');
}

export function writeRestoreMarker(stateDir: string, snapshotId: string, now: () => Date = () => new Date()): void {
  const file = restoreMarkerFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at: now().toISOString(), snapshotId } satisfies RestoreMarker));
  fs.renameSync(tmp, file);
}

/** The marker, or null when there is none or it doesn't parse (a broken marker is not a restore). */
export function readRestoreMarker(stateDir: string): RestoreMarker | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(restoreMarkerFile(stateDir), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const { at, snapshotId } = raw as Record<string, unknown>;
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof snapshotId !== 'string') return null;
    return { at, snapshotId };
  } catch {
    return null; // @silent-fallback-ok — no file is the normal case: nothing was restored
  }
}

export function clearRestoreMarker(stateDir: string): void {
  SafeFsExecutor.safeRmSync(restoreMarkerFile(stateDir), { force: true, operation: 'src/core/restoreMarker.ts:clear' });
}
