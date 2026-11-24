/** Secret-free attribution only. This module cannot authorize a send or retry. */
import type { OriginCapacityRefusalCause } from './OriginEgressCapacity.js';
export const CAPACITY_CAUSES: readonly OriginCapacityRefusalCause[] = Object.freeze([
  'owner-closed', 'owner-not-ready', 'lease-not-held', 'account-unknown', 'owner-check-failed', 'rate-window-full',
  'grant-expired', 'wrong-owner', 'unknown-grant', 'already-consumed', 'grant-mismatch', 'consume-refused',
  'legacy-unexplained', 'ipc-timeout', 'ipc-unavailable', 'ipc-protocol',
]);
export interface CapacityEvidence {
  version: 1; authority: 'direct' | 'ipc' | 'legacy'; stage: 'reserve' | 'consume' | 'pre-network' | 'network-start';
  cause: OriginCapacityRefusalCause | null; ownerVerdict: 'granted' | 'consumed' | 'refused' | 'unknown';
  reserveOwnerDecidedAtMs?: number; consumeOwnerDecidedAtMs?: number;
  reserveStartedAtMs: number | null; reserveEndedAtMs: number | null; consumeStartedAtMs: number | null;
  consumeEndedAtMs: number | null; checkedAtMs: number | null; grantExpiresAtMs: number | null;
  reserveDurationMs: number | null; consumeDurationMs: number | null;
  remainingAtReserveMs: number | null; remainingAtConsumeMs: number | null;
  clockUncertain: boolean; explanation: 'complete' | 'legacy-unexplained' | 'invalid';
}
export type StoredCapacityEvidence = CapacityEvidence | { version: 1; explanation: 'invalid' };
const epochs = ['reserveStartedAtMs', 'reserveEndedAtMs', 'consumeStartedAtMs', 'consumeEndedAtMs', 'checkedAtMs', 'grantExpiresAtMs'] as const;
const durations = ['reserveDurationMs', 'consumeDurationMs'] as const;
const remaining = ['remainingAtReserveMs', 'remainingAtConsumeMs'] as const;
const keys = ['version', 'authority', 'stage', 'cause', 'ownerVerdict', ...epochs, ...durations, ...remaining, 'clockUncertain', 'explanation'].sort();
export function sanitizeCapacityEvidence(input: unknown): StoredCapacityEvidence {
  const invalid = (): StoredCapacityEvidence => ({ version: 1, explanation: 'invalid' });
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
    const x = input as CapacityEvidence;
    const ownerTimes = ['reserveOwnerDecidedAtMs', 'consumeOwnerDecidedAtMs'] as const;
    const present = ownerTimes.filter(key => Object.hasOwn(x, key));
    if (present.some(key => !Number.isSafeInteger(x[key]) || x[key]! < 0)) return invalid();
    if (Object.keys(x).sort().join(',') !== [...keys, ...present].sort().join(',') || x.version !== 1 ||
      !['direct', 'ipc', 'legacy'].includes(x.authority) || !['reserve', 'consume', 'pre-network', 'network-start'].includes(x.stage) ||
      !['granted', 'consumed', 'refused', 'unknown'].includes(x.ownerVerdict) ||
      !['complete', 'legacy-unexplained', 'invalid'].includes(x.explanation) || typeof x.clockUncertain !== 'boolean' ||
      !(x.cause === null || CAPACITY_CAUSES.includes(x.cause))) return invalid();
    for (const k of epochs) if (x[k] !== null && (!Number.isSafeInteger(x[k]) || x[k]! < 0)) return invalid();
    for (const k of [...durations, ...remaining]) if (x[k] !== null && (!Number.isFinite(x[k]) || Math.abs(x[k]!) > Number.MAX_SAFE_INTEGER)) return invalid();
    for (const k of durations) if (x[k] !== null && x[k]! < 0) return invalid();
    if (x.stage === 'network-start' && (x.ownerVerdict !== 'consumed' || x.cause !== null)) return invalid();
    if (x.cause === 'rate-window-full' && x.stage !== 'reserve') return invalid();
    if (x.ownerVerdict === 'refused' && x.cause === null) return invalid();
    const json = JSON.stringify(x); if (Buffer.byteLength(json) > 4096) return invalid();
    return JSON.parse(json) as CapacityEvidence;
  } catch { return invalid(); }
}
export function newCapacityEvidence(authority: CapacityEvidence['authority']): CapacityEvidence {
  return { version: 1, authority, stage: 'reserve', cause: null, ownerVerdict: 'unknown',
    reserveStartedAtMs: null, reserveEndedAtMs: null, consumeStartedAtMs: null, consumeEndedAtMs: null,
    checkedAtMs: null, grantExpiresAtMs: null, reserveDurationMs: null, consumeDurationMs: null,
    remainingAtReserveMs: null, remainingAtConsumeMs: null, clockUncertain: false, explanation: 'complete' };
}
