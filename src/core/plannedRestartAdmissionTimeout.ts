import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const ADMISSION_WAIT_MS = 15 * 60_000;

function requestDigest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function timeoutMarker(flagPath: string, raw: string): string {
  return `${flagPath}.admission-timeout-${requestDigest(raw)}`;
}

export function restartAdmissionTimedOut(flagPath: string, raw: string): boolean {
  return fs.existsSync(timeoutMarker(flagPath, raw));
}

/** Record the timeout without modifying the request path shared with other processes. */
export function markRestartAdmissionTimeout(flagPath: string, raw: string, requestedAt: unknown): boolean {
  const requestedAtMs = typeof requestedAt === 'string' ? Date.parse(requestedAt) : NaN;
  const now = Date.now();
  if (Number.isFinite(requestedAtMs) && requestedAtMs <= now && now - requestedAtMs < ADMISSION_WAIT_MS) return false;

  try {
    if (fs.readFileSync(flagPath, 'utf8') === raw) {
      SafeFsExecutor.atomicWriteFileSync(timeoutMarker(flagPath, raw), 'timed out\n',
        { operation: 'plannedRestartAdmissionTimeout:mark', mode: 0o600 });
    }
  } catch (error) {
    console.warn('[planned restart] Could not record admission timeout:', error);
  }
  return true;
}
