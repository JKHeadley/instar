/**
 * Canonical stall-class registry — the single source of truth for the
 * framework stall-coverage matrix standard.
 *
 * Spec: docs/specs/framework-stall-coverage-matrix.md (§2.1)
 *
 * Every framework session can stop in a bounded, enumerable set of ways.
 * This module enumerates that class space so no framework's recovery story
 * can silently omit a class its author never personally encountered
 * (drive-5 defect #9: the interrupted-conversation class was invisible
 * until it cost a 2h+ silent production stall).
 *
 * Rules (spec §2.1):
 * - Primary classes are strictly proximate-observable-state. Causes
 *   (host loss, own-server restart, …) are SECONDARY TAGS, never rows.
 * - Additive-only. Adding a class REQUIRES running the registry codemod
 *   (scripts/stall-class-codemod.mjs) in the same PR so every existing
 *   matrix gets a seeded `declared-gap (new-class, unreviewed)` row —
 *   otherwise the CI ratchet reds every stale matrix on the next push.
 * - The spec's §2.1 table MIRRORS this list; the CI ratchet asserts the
 *   two agree so prose and code cannot drift.
 */

import type { IntelligenceFramework } from '../core/intelligenceProviderFactory.js';

export interface StallClass {
  /** Canonical id — lowercase kebab, stable forever. */
  id: string;
  /** Human name. */
  name: string;
  /** Proximate observable state that books a stall into this class. */
  description: string;
  /** Instar version line the class was minted on. */
  sinceVersion: string;
}

/**
 * Classes v1 — mirrored by the spec table in
 * docs/specs/framework-stall-coverage-matrix.md §2.1.
 *
 * Classification precedence for ambiguous tails (first match wins,
 * descending signature specificity — spec §2.1):
 *   wedged-context > policy-rejection-loop > quota-wall >
 *   approval-prompt-wedge > context-window-wall > input-not-draining >
 *   mid-turn-interrupt
 */
export const STALL_CLASSES: readonly StallClass[] = [
  {
    id: 'clean-turn-end',
    name: 'Clean turn end',
    description: 'normal boundary; continuation machinery owns it',
    sinceVersion: '1.3',
  },
  {
    id: 'mid-turn-interrupt',
    name: 'Mid-turn interrupt',
    description:
      'session at an interrupted/resume prompt after its host or server died mid-turn (defect #9)',
    sinceVersion: '1.3',
  },
  {
    id: 'input-not-draining',
    name: 'Paused / input not draining',
    description:
      'session alive at idle prompt; delivered messages never start a turn (2026-06-03)',
    sinceVersion: '1.3',
  },
  {
    id: 'wedged-context',
    name: 'Wedged context',
    description:
      'transcript poisoned; every resume fast-fails (thinking-block, AUP loop signatures) — recovery is fresh-respawn, never nudge',
    sinceVersion: '1.3',
  },
  {
    id: 'policy-rejection-loop',
    name: 'Policy/content rejection loop',
    description:
      'every reply rejected; distinct signature from wedged-context, same terminal shape',
    sinceVersion: '1.3',
  },
  {
    id: 'quota-wall',
    name: 'Quota/rate-limit wall',
    description:
      'turn fails on limits; recovery is wait-or-swap; truthful state must surface',
    sinceVersion: '1.3',
  },
  {
    id: 'approval-prompt-wedge',
    name: 'Permission/approval prompt wedge',
    description:
      'blocked on an interactive prompt no remote user can answer',
    sinceVersion: '1.3',
  },
  {
    id: 'context-window-wall',
    name: 'Context-window wall',
    description: 'compact-in-place first, fresh-respawn fallback',
    sinceVersion: '1.3',
  },
] as const;

/** Classification precedence order for ambiguous tails (spec §2.1). */
export const STALL_CLASS_PRECEDENCE: readonly string[] = [
  'wedged-context',
  'policy-rejection-loop',
  'quota-wall',
  'approval-prompt-wedge',
  'context-window-wall',
  'input-not-draining',
  'mid-turn-interrupt',
] as const;

/**
 * Secondary (causal) tags v1 — annotations on a primary class row, never
 * rows of their own (spec §2.1: the mesh owns machine-loss recovery; the
 * framework's obligation for a cause is honest session state on return).
 */
export const STALL_SECONDARY_TAGS: readonly string[] = [
  'host-loss',
  'own-server-restart',
  'network-partition',
] as const;

/**
 * Frameworks that MUST carry a stall-coverage matrix file at
 * docs/frameworks/<framework>-stall-coverage.md (spec §2.1).
 *
 * Derived from the `IntelligenceFramework` union
 * (src/core/intelligenceProviderFactory.ts — the canonical declaration):
 * the compile-time exhaustiveness check below fails the build the moment a
 * framework is added to the union without being added here, so a framework
 * cannot exist in the type without a matrix file being CI-required on disk.
 */

export const REQUIRED_MATRIX_FRAMEWORKS = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'pi-cli',
] as const satisfies readonly IntelligenceFramework[];

// Exhaustiveness: if IntelligenceFramework gains a member missing from
// REQUIRED_MATRIX_FRAMEWORKS, `MissingFramework` is non-never and this
// assignment fails to compile (extend the array + run the codemod).
type CoveredFramework = (typeof REQUIRED_MATRIX_FRAMEWORKS)[number];
type MissingFramework = Exclude<IntelligenceFramework, CoveredFramework>;
const _requiredMatrixFrameworksExhaustive: MissingFramework extends never
  ? true
  : never = true;
void _requiredMatrixFrameworksExhaustive;

/**
 * Static mapping from existing sentinel-event / stuck-signature kinds to
 * canonical stall-class ids (spec §2.1). Existing emitters record KINDS,
 * not class ids — this table is the enabling artifact for any future join
 * (the §3.3 observability follow-up).
 *
 * Sources of the kind strings:
 * - ContextWedgeSentinel audit rows in logs/sentinel-events.jsonl
 *   (kind 'context-wedge').
 * - StuckSignatureClassifier's StuckKind union
 *   ('context-wedge' | 'policy-wedge' | 'rate-limited' |
 *    'context-too-long' | 'approval-prompt-waiting').
 */
export const SENTINEL_KIND_TO_STALL_CLASS: Readonly<Record<string, string>> = {
  'context-wedge': 'wedged-context',
  'policy-wedge': 'policy-rejection-loop',
  'rate-limited': 'quota-wall',
  'context-too-long': 'context-window-wall',
  'approval-prompt-waiting': 'approval-prompt-wedge',
} as const;
