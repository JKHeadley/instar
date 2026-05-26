/**
 * featureRollout — pure rollout-stage logic for the Graduated Feature Rollout
 * standard (GRADUATED-FEATURE-ROLLOUT-SPEC §4.2-4.3). No I/O, no tracker, no
 * config reads — just the deterministic mapping the reconciler/driver depend on,
 * so every rule is unit-testable in isolation.
 *
 * THE safety invariant: the rollout stage is DERIVED from observing the feature's
 * config flag + its shipped default — it is NEVER computed from anything the
 * driver could write. A feature can only reach `default-on` when its shipped
 * ConfigDefaults default is enabled (a human code change), so the driver can
 * never silently promote a feature.
 */

import type { RolloutStage, InitiativePhaseStatus } from './InitiativeTracker.js';

/** Observed flag state for a ships-staged feature, read from live config +
 *  the shipped ConfigDefaults default. All fields are observations, never writes. */
export interface RolloutFlagObservation {
  /** `flagPath.enabled` in the agent's live config. */
  flagEnabled?: boolean;
  /** `flagPath.dryRun` in the agent's live config. */
  flagDryRun?: boolean;
  /** The SHIPPED ConfigDefaults default for `flagPath.enabled` — true ⇒ the
   *  feature is on for all new agents = default-on. Source-of-truth for the
   *  terminal stage; a human flipping it (code change) is the only way here. */
  defaultEnabled?: boolean;
}

/** The rollout phases of a ships-staged track, in order. `dark` is the implicit
 *  pre-phase (feature present but off) — not a phase entry. */
export const ROLLOUT_PHASE_IDS = ['dry-run', 'live', 'default-on'] as const;
export type RolloutPhaseId = (typeof ROLLOUT_PHASE_IDS)[number];

/**
 * Derive the rollout stage from observation alone.
 *  - shipped default enabled ⇒ `default-on` (terminal; only a code change reaches it)
 *  - flag not enabled ⇒ `dark`
 *  - enabled + dryRun ⇒ `dry-run`
 *  - enabled + not dryRun ⇒ `live`
 */
export function deriveRolloutStage(obs: RolloutFlagObservation): RolloutStage {
  if (obs.defaultEnabled === true) return 'default-on';
  if (obs.flagEnabled !== true) return 'dark';
  if (obs.flagDryRun === true) return 'dry-run';
  return 'live';
}

/**
 * Phase statuses for an observed stage. CRITICAL (spec §4.3): at `default-on`
 * the final phase is left `in-progress`, NOT `done` — the reconciler archives
 * the track instead of letting all-phases-`done` flip the initiative to the
 * immutable terminal `completed`/`succeeded` state (which would block a later
 * regression from reopening it).
 */
export function rolloutPhaseStatuses(stage: RolloutStage): Record<RolloutPhaseId, InitiativePhaseStatus> {
  switch (stage) {
    case 'dark':
      return { 'dry-run': 'pending', live: 'pending', 'default-on': 'pending' };
    case 'dry-run':
      return { 'dry-run': 'in-progress', live: 'pending', 'default-on': 'pending' };
    case 'live':
      return { 'dry-run': 'done', live: 'in-progress', 'default-on': 'pending' };
    case 'default-on':
      // NOT all-done: live done, default-on intentionally left in-progress.
      // The reconciler sets initiative.status = 'archived' (reopenable).
      return { 'dry-run': 'done', live: 'done', 'default-on': 'in-progress' };
  }
}

/** True when the observed stage means the track should be archived (reopenable),
 *  not driven to completion. */
export function shouldArchiveAtStage(stage: RolloutStage): boolean {
  return stage === 'default-on';
}

/** Stage ordering for detecting forward progress vs regression. */
const STAGE_ORDER: Record<RolloutStage, number> = { dark: 0, 'dry-run': 1, live: 2, 'default-on': 3 };

/** True when `to` is earlier than `from` — a regression (e.g. default-on → live
 *  after a revert). The reconciler writes `pipelineStage:'regressed'` + reactivates. */
export function isRegression(from: RolloutStage, to: RolloutStage): boolean {
  return STAGE_ORDER[to] < STAGE_ORDER[from];
}
