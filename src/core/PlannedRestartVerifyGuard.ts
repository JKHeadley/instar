/**
 * Cross-process guard for planned server restarts while Local Verify owns a
 * full-suite child. Both consumers read the same durable in-flight marker;
 * a deferred request gets a bounded machine-local proof sidecar.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const VERIFY_RESTART_HOLD_MS = 3 * 60 * 60_000;
// Keep the request deliverable for one additional hour after the maximum hold.
// A consumer that wakes at the boundary must restart, not discard maintenance.
export const PLANNED_RESTART_DELIVERY_MS = VERIFY_RESTART_HOLD_MS + 60 * 60_000;
const PRE_SPAWN_HOLD_MS = 30_000;
const FUTURE_CLOCK_SKEW_MS = 5_000;

export interface PlannedRestartFlag {
  requestedAt?: string;
  plannedRestart?: boolean;
  /** Explicit operator forceRestart already bypasses the updater's own holds. */
  bypassHolds?: boolean;
  expiresAt?: string;
}

export interface PlannedRestartVerifyState {
  pending: boolean;
  pendingSinceMs: number | null;
  hold: boolean;
  holdUntilMs: number | null;
  /** This exact request actually waited for a verify and remains deliverable. */
  deferredDelivery?: boolean;
}

const deferredMarkerPath = (stateDir: string) => path.join(stateDir, 'state', 'restart-local-verify-deferred.json');
const requestKey = (request: PlannedRestartFlag) => crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // @silent-fallback-ok — ESRCH releases; EPERM/unknown preserves only the bounded hold.
    // EPERM means a live process we cannot signal. An unknown probe failure
    // also errs toward a bounded hold, never an unbounded one.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Pure decision on a caller-read request; no write or request consumption. */
export function plannedRestartVerifyState(
  stateDir: string,
  request: PlannedRestartFlag | null,
  now: number = Date.now(),
  pidExists: (pid: number) => boolean = processExists,
): PlannedRestartVerifyState {
  if (!request || typeof request !== 'object' || request.plannedRestart !== true) return { pending: false, pendingSinceMs: null, hold: false, holdUntilMs: null };
  const requestedAt = typeof request.requestedAt === 'string' ? Date.parse(request.requestedAt) : Number.NaN;
  const pendingSinceMs = Number.isFinite(requestedAt) && requestedAt <= now + FUTURE_CLOCK_SKEW_MS ? requestedAt : null;
  const fallback = { pending: true, pendingSinceMs, hold: false, holdUntilMs: null };
  if (request.bypassHolds === true) return fallback;
  // Both the request and the child marker must be recent. Otherwise a stale
  // request could keep deferring behind a succession of fresh children.
  if (pendingSinceMs === null || now - pendingSinceMs >= VERIFY_RESTART_HOLD_MS) return fallback;
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'local-verify', 'inflight.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    // @silent-fallback-ok — no readable in-flight marker means no live-run hold.
    return fallback;
  }
  if (!marker || typeof marker !== 'object') return fallback;
  const startedAt = marker.startedAt;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt > now + FUTURE_CLOCK_SKEW_MS) return fallback;
  const age = Math.max(0, now - startedAt);
  if (age >= VERIFY_RESTART_HOLD_MS || typeof marker.attemptToken !== 'string' || !marker.attemptToken) return fallback;
  const pid = marker.pid;
  const alive = pid === null
    ? age < PRE_SPAWN_HOLD_MS
    : typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pidExists(pid);
  return alive
    ? { pending: true, pendingSinceMs, hold: true, holdUntilMs: startedAt + VERIFY_RESTART_HOLD_MS }
    : fallback;
}

/** The verifier uses this to leave the slot free for a pending restart. */
export function readPlannedRestartVerifyState(
  stateDir: string,
  now: number = Date.now(),
  pidExists: (pid: number) => boolean = processExists,
): PlannedRestartVerifyState {
  let request: PlannedRestartFlag;
  try {
    request = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'restart-requested.json'), 'utf8')) as PlannedRestartFlag;
  } catch {
    // @silent-fallback-ok — absent or unreadable flag means no planned restart is pending.
    return { pending: false, pendingSinceMs: null, hold: false, holdUntilMs: null };
  }
  return {
    ...plannedRestartVerifyState(stateDir, request, now, pidExists),
    deferredDelivery: recentlyRequestedPlannedRestart(stateDir, request, now),
  };
}

/** Persist proof that this particular request actually encountered a live verify. */
export function markPlannedRestartDeferred(stateDir: string, request: PlannedRestartFlag, now: number = Date.now()): boolean {
  if (!plannedRestartVerifyState(stateDir, request, now).hold) return false;
  if (recentlyRequestedPlannedRestart(stateDir, request, now)) return true;
  // A newly observed run cannot retroactively make an already-expired flag
  // "deferred". Only proof written while the original TTL was live may extend it.
  const expiresAt = typeof request.expiresAt === 'string' ? Date.parse(request.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && now > expiresAt) return false;
  try {
    SafeFsExecutor.atomicWriteJsonSync(deferredMarkerPath(stateDir), {
      requestKey: requestKey(request), deferredAt: now,
    }, { operation: 'src/core/PlannedRestartVerifyGuard.ts:markPlannedRestartDeferred', mode: 0o600 });
    return true;
  } catch {
    // A failed persistence must not risk losing the maintenance request after
    // its original TTL. The consumer proceeds with the old restart behavior.
    console.warn('[PlannedRestartVerifyGuard] Could not persist restart deferral; proceeding with restart');
    // @silent-fallback-ok — fail open to the existing restart path and log the loss of the hold.
    return false;
  }
}

/** Only a request actually deferred for verification gets the extended TTL. */
export function recentlyRequestedPlannedRestart(stateDir: string, request: PlannedRestartFlag | null, now: number = Date.now()): boolean {
  if (!request || typeof request !== 'object' || request.plannedRestart !== true || typeof request.requestedAt !== 'string') return false;
  const at = Date.parse(request.requestedAt);
  if (!Number.isFinite(at) || at > now + FUTURE_CLOCK_SKEW_MS || now - at > PLANNED_RESTART_DELIVERY_MS) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(deferredMarkerPath(stateDir), 'utf8')) as Record<string, unknown>;
    return marker?.requestKey === requestKey(request)
      && typeof marker.deferredAt === 'number' && Number.isFinite(marker.deferredAt)
      && marker.deferredAt >= at - FUTURE_CLOCK_SKEW_MS && marker.deferredAt <= now + FUTURE_CLOCK_SKEW_MS;
  } catch {
    // @silent-fallback-ok — no readable proof means the original one-hour TTL applies.
    return false;
  }
}
