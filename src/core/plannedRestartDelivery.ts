import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VERIFY_RESTART_HOLD_MS = 3 * 60 * 60_000;
// Allow one additional hour for a consumer to deliver a verified deferral.
export const PLANNED_RESTART_DELIVERY_MS = VERIFY_RESTART_HOLD_MS + 60 * 60_000;
export const FUTURE_CLOCK_SKEW_MS = 5_000;

export interface PlannedRestartFlag {
  requestedAt?: string;
  plannedRestart?: boolean;
  /** Explicit operator forceRestart already bypasses the updater's own holds. */
  bypassHolds?: boolean;
  expiresAt?: string;
}

export const plannedRestartDeferralPath = (requestDir: string) =>
  path.join(requestDir, 'restart-local-verify-deferred.json');

export const plannedRestartRequestKey = (request: PlannedRestartFlag) =>
  crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');

/** Only a request actually deferred for verification gets the extended TTL. */
export function hasPlannedRestartDeliveryProof(requestDir: string, request: PlannedRestartFlag | null, now: number = Date.now()): boolean {
  if (!request || typeof request !== 'object' || request.plannedRestart !== true || typeof request.requestedAt !== 'string') return false;
  const at = Date.parse(request.requestedAt);
  if (!Number.isFinite(at) || at > now + FUTURE_CLOCK_SKEW_MS || now - at > PLANNED_RESTART_DELIVERY_MS) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(plannedRestartDeferralPath(requestDir), 'utf8')) as Record<string, unknown>;
    return marker?.requestKey === plannedRestartRequestKey(request)
      && typeof marker.deferredAt === 'number' && Number.isFinite(marker.deferredAt)
      && marker.deferredAt >= at - FUTURE_CLOCK_SKEW_MS && marker.deferredAt <= now + FUTURE_CLOCK_SKEW_MS;
  } catch {
    // @silent-fallback-ok — no readable proof means the original one-hour TTL applies.
    return false;
  }
}
