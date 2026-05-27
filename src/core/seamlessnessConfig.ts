/**
 * Cross-Machine Seamlessness — config resolution + invariant validation.
 *
 * Spec: docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §9 (Tunability).
 *
 * Resolves the optional `multiMachine` seamlessness knobs to concrete values
 * with sane 2-machine-personal-use defaults, auto-derives the standby pull
 * cadence, and enforces the cross-knob invariants. A violating config is
 * REJECTED with a clear message rather than degrading silently — so a user
 * widening `ingressHeartbeatMs` (which widens `leaseTtlMs`) cannot quietly
 * invalidate the RPO bound the spec promises (§3).
 */

import type { MultiMachineConfig } from './types.js';

/**
 * The mesh protocol version this build speaks. A machine below this version
 * is ineligible for the awake lease during a seamless handoff (spec §11
 * partial-migration safety). Bump only on a breaking coordination change.
 */
export const SEAMLESSNESS_PROTOCOL_VERSION = 1;

/** Fully-resolved seamlessness knobs (every field concrete). */
export interface ResolvedSeamlessnessConfig {
  ingressHeartbeatMs: number;
  registrySyncDebounceMs: number;
  standbyPullIntervalMs: number;
  failoverThresholdMs: number;
  leaseTtlMs: number;
  liveTailTransport: 'tunnel' | 'git';
  liveTailMaxStalenessMs: number;
  liveTailPushRateMs: number;
  liveTailOutOfOrderTimeoutMs: number;
  liveTailMaxBytesPerTopic: number;
  handoffAckTimeoutMs: number;
  minHandoffIntervalMs: number;
  splitBrainEscalationCooldownMs: number;
  handoffBar: 'near-instant' | 'relaxed';
  maxProcessingMs: number;
  protocolVersion: number;
}

export class SeamlessnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeamlessnessConfigError';
  }
}

/**
 * Resolve the failover threshold (ms) from the existing config field.
 * `failoverTimeoutMinutes` is the canonical knob; default 15 min.
 * Nullish-coalescing (not ||) so an explicit 0 isn't clobbered — but 0 is
 * itself invalid and caught by validation.
 */
export function resolveFailoverThresholdMs(mm?: MultiMachineConfig): number {
  const minutes = mm?.failoverTimeoutMinutes ?? 15;
  return minutes * 60_000;
}

/**
 * Resolve all seamlessness knobs to concrete values. Auto-derives
 * `standbyPullIntervalMs` (failoverThresholdMs/4) and the tail/lease-linked
 * defaults. Does NOT validate — call validateSeamlessnessInvariants() after.
 */
export function resolveSeamlessnessConfig(mm?: MultiMachineConfig): ResolvedSeamlessnessConfig {
  const failoverThresholdMs = resolveFailoverThresholdMs(mm);
  const ingressHeartbeatMs = mm?.ingressHeartbeatMs ?? 30_000;
  const leaseTtlMs = mm?.leaseTtlMs ?? 2 * ingressHeartbeatMs;
  const liveTailMaxStalenessMs = mm?.liveTailMaxStalenessMs ?? 5_000;

  return {
    ingressHeartbeatMs,
    registrySyncDebounceMs: mm?.registrySyncDebounceMs ?? 10_000,
    // Auto-derive to satisfy BOTH bounds at once: < failoverThresholdMs/3 AND
    // < leaseTtlMs. At default ratios failoverThresholdMs (15min) ≫ leaseTtlMs
    // (60s), so the binding bound is leaseTtlMs — the spec's bare /4 heuristic
    // would violate the leaseTtl invariant it also mandates. We pick safely
    // under both: min(failoverThresholdMs/4, leaseTtlMs/2).
    standbyPullIntervalMs:
      mm?.standbyPullIntervalMs ??
      Math.min(Math.floor(failoverThresholdMs / 4), Math.floor(leaseTtlMs / 2)),
    failoverThresholdMs,
    leaseTtlMs,
    liveTailTransport: mm?.liveTailTransport ?? 'tunnel',
    liveTailMaxStalenessMs,
    liveTailPushRateMs: mm?.liveTailPushRateMs ?? liveTailMaxStalenessMs,
    liveTailOutOfOrderTimeoutMs: mm?.liveTailOutOfOrderTimeoutMs ?? leaseTtlMs,
    liveTailMaxBytesPerTopic: mm?.liveTailMaxBytesPerTopic ?? 256 * 1024,
    handoffAckTimeoutMs: mm?.handoffAckTimeoutMs ?? 5_000,
    minHandoffIntervalMs: mm?.minHandoffIntervalMs ?? 60_000,
    splitBrainEscalationCooldownMs: mm?.splitBrainEscalationCooldownMs ?? 5 * 60_000,
    handoffBar: mm?.handoffBar ?? 'near-instant',
    maxProcessingMs: mm?.maxProcessingMs ?? 5 * 60_000,
    protocolVersion: mm?.protocolVersion ?? SEAMLESSNESS_PROTOCOL_VERSION,
  };
}

/**
 * Validate the cross-knob invariants (spec §9). Returns the list of
 * violations (empty = valid). Callers that want hard-rejection use
 * assertSeamlessnessInvariants().
 *
 * Invariants:
 *  1. standbyPullIntervalMs < failoverThresholdMs / 3
 *     — a standby must pull often enough to notice a dead holder well
 *       before the failover threshold, or failover races stale data.
 *  2. standbyPullIntervalMs < leaseTtlMs
 *     — a standby must refresh its git-committed epoch view at least once
 *       per lease lifetime, or it decides max(tunnel,git) on a stale git floor.
 *  3. liveTailPushRateMs ≤ liveTailMaxStalenessMs
 *     — the holder must push tail flushes at least as often as the RPO bound,
 *       or the promised RPO is unachievable.
 *  Plus basic positivity (a 0/negative cadence is never valid).
 */
export function validateSeamlessnessInvariants(c: ResolvedSeamlessnessConfig): string[] {
  const errors: string[] = [];

  const positives: Array<[keyof ResolvedSeamlessnessConfig, number]> = [
    ['ingressHeartbeatMs', c.ingressHeartbeatMs],
    ['registrySyncDebounceMs', c.registrySyncDebounceMs],
    ['standbyPullIntervalMs', c.standbyPullIntervalMs],
    ['failoverThresholdMs', c.failoverThresholdMs],
    ['leaseTtlMs', c.leaseTtlMs],
    ['liveTailMaxStalenessMs', c.liveTailMaxStalenessMs],
    ['liveTailPushRateMs', c.liveTailPushRateMs],
    ['handoffAckTimeoutMs', c.handoffAckTimeoutMs],
  ];
  for (const [name, value] of positives) {
    if (!(value > 0)) errors.push(`multiMachine.${String(name)} must be > 0 (got ${value})`);
  }

  if (c.standbyPullIntervalMs >= c.failoverThresholdMs / 3) {
    errors.push(
      `multiMachine.standbyPullIntervalMs (${c.standbyPullIntervalMs}ms) must be < failoverThresholdMs/3 ` +
      `(${Math.floor(c.failoverThresholdMs / 3)}ms) so a standby notices a dead holder before the failover threshold.`,
    );
  }
  if (c.standbyPullIntervalMs >= c.leaseTtlMs) {
    errors.push(
      `multiMachine.standbyPullIntervalMs (${c.standbyPullIntervalMs}ms) must be < leaseTtlMs ` +
      `(${c.leaseTtlMs}ms) so a standby refreshes its git-committed epoch view at least once per lease lifetime.`,
    );
  }
  if (c.liveTailPushRateMs > c.liveTailMaxStalenessMs) {
    errors.push(
      `multiMachine.liveTailPushRateMs (${c.liveTailPushRateMs}ms) must be ≤ liveTailMaxStalenessMs ` +
      `(${c.liveTailMaxStalenessMs}ms) so the promised RPO bound is achievable.`,
    );
  }

  return errors;
}

/**
 * Resolve + validate in one step, throwing SeamlessnessConfigError on any
 * invariant violation. Use at server startup so a bad config is rejected
 * loudly rather than degrading silently.
 */
export function assertSeamlessnessInvariants(mm?: MultiMachineConfig): ResolvedSeamlessnessConfig {
  const resolved = resolveSeamlessnessConfig(mm);
  const errors = validateSeamlessnessInvariants(resolved);
  if (errors.length > 0) {
    throw new SeamlessnessConfigError(
      `Invalid multiMachine seamlessness config — refusing to start:\n` +
      errors.map((e) => `  • ${e}`).join('\n'),
    );
  }
  return resolved;
}
