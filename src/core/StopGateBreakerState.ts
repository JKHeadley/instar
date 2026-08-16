import { createHash, randomUUID } from 'node:crypto';
import { SUPPORTED_FRAMEWORKS } from './TopicFrameworksStore.js';

export interface StopGateBreakerState {
  breakerKey: string;
  consecutiveFailures: number;
  openUntil: number;
  probeLeaseUntil: number;
  probeToken: string | null;
  firstOpenedAt: number;
  suppressedCount: number;
  updatedAt: number;
}

export interface StopGateBreakerStateStore {
  loadBreakerState(breakerKey: string): StopGateBreakerState | null;
  recordBreakerFailure(input: {
    breakerKey: string;
    now: number;
    threshold: number;
    cooldownMs: number;
    probeToken?: string | null;
  }): StopGateBreakerState;
  tryAcquireBreakerProbe(input: {
    breakerKey: string;
    now: number;
    cooldownMs: number;
    leaseMs: number;
  }): { acquired: boolean; token: string | null; state: StopGateBreakerState };
  resetBreakerState(breakerKey: string, probeToken?: string | null): StopGateBreakerState;
  addBreakerSuppressions(breakerKey: string, count: number, now: number): void;
}

export function emptyStopGateBreakerState(breakerKey: string): StopGateBreakerState {
  return {
    breakerKey,
    consecutiveFailures: 0,
    openUntil: 0,
    probeLeaseUntil: 0,
    probeToken: null,
    firstOpenedAt: 0,
    suppressedCount: 0,
    updatedAt: 0,
  };
}

/** Clamp corrupt/future durable timestamps without turning clock rollback into an indefinite open. */
export function normalizeStopGateBreakerState(
  raw: StopGateBreakerState,
  now: number,
  cooldownMs: number,
  leaseMs: number,
): StopGateBreakerState {
  const finite = (n: number): number => Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const updatedAt = Math.min(finite(raw.updatedAt), now + cooldownMs);
  const effectiveNow = Math.max(now, updatedAt);
  return {
    breakerKey: raw.breakerKey,
    consecutiveFailures: finite(raw.consecutiveFailures),
    openUntil: Math.min(finite(raw.openUntil), effectiveNow + cooldownMs),
    probeLeaseUntil: Math.min(finite(raw.probeLeaseUntil), effectiveNow + leaseMs),
    probeToken: typeof raw.probeToken === 'string' && raw.probeToken.length <= 128 ? raw.probeToken : null,
    firstOpenedAt: Math.min(finite(raw.firstOpenedAt), effectiveNow),
    suppressedCount: finite(raw.suppressedCount),
    updatedAt,
  };
}

export function mintStopGateProbeToken(): string {
  return randomUUID();
}

export interface StopGateRoutingIdentity {
  defaultFramework?: string;
  gateCategoryFramework?: string;
  stopGateOverride?: string;
  failureSwap?: readonly string[];
}

/** Stable route identity: excludes release, machine, credential and request data by construction. */
export function stopGateBreakerKey(identity: StopGateRoutingIdentity): string {
  // Round-17 (integration): this hand-written set omitted 'grok-build', so a
  // grok-primary agent's route identity collapsed onto the SAME key as an
  // agent with no framework configured at all — an agent switching its
  // default to grok-build inherited the prior route's durable breaker state,
  // and a still-open breaker kept the Stop gate suppressed on what is
  // genuinely a different route. Derived from the canonical list so the next
  // framework cannot reintroduce the gap by omission.
  const frameworks = new Set<string>(SUPPORTED_FRAMEWORKS);
  const framework = (value: string | undefined): string | null =>
    value && frameworks.has(value) ? value : null;
  const failureSwap = [...new Set(identity.failureSwap ?? [])]
    .filter(value => frameworks.has(value))
    .slice(0, frameworks.size);
  const stable = {
    schema: 1,
    defaultFramework: framework(identity.defaultFramework),
    gateCategoryFramework: framework(identity.gateCategoryFramework),
    stopGateOverride: framework(identity.stopGateOverride),
    failureSwap,
  };
  return `unjustified-stop-gate:${createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;
}
