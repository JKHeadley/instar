/**
 * ExternalHogGuardStatus — the guard-posture state of the External-Hog sentinel
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §1/§8).
 *
 * The posture must reflect VERIFIED kill-capability, NOT a config wish (the `/guards` honesty
 * rule): `on-confirmed` ONLY when the feature is actually kill-capable (enabled && !dryRun && a
 * VALID PIN armed marker). The reachable `config.dryRun:false` + marker-absent state reads
 * `on-dry-run` (v1 maps the deferred `armed-pending` → `on-dry-run`), never `on-confirmed`. A
 * dead sampler degrades to `on-stale` (§1) — NOT config-only. Pure function.
 */

import type { GuardEffectiveState } from './guardPostureView.js';

export interface ExternalHogGuardInput {
  /** The resolved `enabled` (dev-gate resolved). */
  readonly enabled: boolean;
  readonly dryRun: boolean;
  /** Is the PIN armed marker currently VALID (armEpoch > lastDisarmEpoch)? */
  readonly markerValid: boolean;
  /** Is the sampler heartbeat stale past the sampler-dead threshold (§1)? */
  readonly samplerDead: boolean;
}

/**
 * Map the live external-hog state to a guard-posture effective state.
 *  - not enabled            → `off`
 *  - sampler dead           → `on-stale`   (the §1 liveness degradation; feature is blind)
 *  - enabled && !dryRun && marker-valid → `on-confirmed` (actually kill-capable)
 *  - otherwise (dryRun OR no valid marker) → `on-dry-run` (watch-only / armed-pending)
 */
export function externalHogEffectiveState(input: ExternalHogGuardInput): GuardEffectiveState {
  if (input.enabled !== true) return 'off';
  if (input.samplerDead === true) return 'on-stale';
  if (input.dryRun === false && input.markerValid === true) return 'on-confirmed';
  return 'on-dry-run';
}
