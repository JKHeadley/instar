/**
 * selfaction/policies.ts — CODE-CONSTANT default policies per controller
 * (companion §3) + load-time validation of sparse per-class config overrides
 * (malformed → code default + audit row; NEVER throw-in-admit — spec ADV6-3).
 *
 * Config defaults stay CODE-ONLY: config carries only sparse per-class
 * OVERRIDES under `intelligence.selfActionGovernor.classes.<id>.*`;
 * `migrateConfig` writes NOTHING (spec §Migration parity).
 */

import type { ControllerPolicy, TransitionRow } from './types.js';

// ── FD11-class illustrative defaults (companion §3 table) ───────────────────

/** Census fraction k for census-scaled relief total ceilings (≈15%). */
export const CENSUS_FRACTION_K = 0.15;

/**
 * ⚠ censusAbsoluteMax HARD CODE CEILING (companion §3): the session-cap-derived
 * value may only TIGHTEN below this, never widen it. Per-window absolute
 * maximum a census-scaled relief ceiling can ever reach.
 */
export const CENSUS_ABSOLUTE_MAX_HARD_CEILING = 400;
/** censusAbsoluteMax = min(hard ceiling, 4 × configured session cap). */
export const CENSUS_ABSOLUTE_MAX_SESSION_CAP_FACTOR = 4;

/** ⚠ Last-resort errored floor multiple (companion DC8-1: ≈3–5× the class's
 *  static floor per window). NOT config-overridable; reads NO config. */
export const LAST_RESORT_FLOOR_MULTIPLE = 4;

/** eternalSentinel rateFloorMs code floor (300,000 ms — companion §3). */
export const RATE_FLOOR_MS_CODE_FLOOR = 300_000;

/** Demote-alarm heal-exhaustion N (clean-cooldown windows). */
export const DEMOTE_EXHAUSTION_N = 3;

/** Eager-flush admission delta + debounce (companion §3 / FD14). */
export const EAGER_FLUSH_ADMISSION_DELTA = 10;
export const EAGER_FLUSH_DEBOUNCE_MS = 1_000;

/** emergencyDisable flip-episode latch window (10 min). */
export const FLIP_EPISODE_LATCH_WINDOW_MS = 10 * 60_000;

/** Errored-episode verbatim audit rows before window-aggregation (first-N). */
export const ERRORED_AUDIT_FIRST_N = 20;

/** Observe-limbo nudge: days past promotion-criterion-met (FD12). */
export const OBSERVE_LIMBO_DAYS = 30;

/** Principal volume-anomaly threshold: admits per (surface, 10-min window);
 *  re-arm after one clean window (companion DC8-2). */
export const PRINCIPAL_VOLUME_THRESHOLD = 30;
export const PRINCIPAL_VOLUME_WINDOW_MS = 10 * 60_000;

/** Distinct-target queue ceiling default (mirrors perTargetEvict.maxEntries). */
export const QUEUE_MAX_TARGETS_DEFAULT = 64;

/** Re-admission cap so drain can't thrash against live admits (spec ADV-m5). */
export const MAX_READMIT_CYCLES = 8;

/** Number of fixed buckets per sliding count window (O(buckets) memory). */
export const WINDOW_BUCKETS = 12;

// ── Exempt-lane membership (FD5 / companion §9): ENUMERATED code allowlists.
//    Adding a member requires the registry-declared `delegatedGiveUp`
//    authority; the ratchet fixture drives that cap to trip. ────────────────

/** Controllers permitted to claim the `respawn-recovery` unbounded lane. */
export const RESPAWN_RECOVERY_LANE_MEMBERS: ReadonlySet<string> = new Set([
  // The two sanctioned respawn-recovery emit paths (spec §session-respawn
  // splits). Give-up authority is delegated ENTIRELY to the named caps.
  'resume-queue-respawn', // delegatedGiveUp: ResumeQueue resurrection cap
  'liveness-reconciler-respawn', // delegatedGiveUp: AutonomousLivenessReconciler P19 breaker
]);

/** Controllers permitted to claim the `eternalSentinel` rate-floored lane
 *  (must match the registry entries carrying `eternalSentinel`). */
export const ETERNAL_SENTINEL_LANE_MEMBERS: ReadonlySet<string> = new Set([
  'liveness-heartbeat',
  'spend-stale-price-alert',
  'spend-door-dark-brakes',
  'spend-fallback-spike',
  'spend-recon-sweep',
]);

// ── Default policy table (companion §3; spec §Runtime policy schema table).
//    Registry-seeded ceilings (boundK / perTargetBoundK) + governor-supplied
//    operational fields. All conservative — bite only under sustained
//    pressure, and only when a class ENFORCES (fleet ships observe-only). ───

const COMMON = {
  queueMaxDepth: 4,
  queueMaxTargets: QUEUE_MAX_TARGETS_DEFAULT,
  perTargetEvict: { ttlMs: 60 * 60_000, maxEntries: 256 },
  breaker: { failThreshold: 5, cooldownMs: 5 * 60_000, flapWindowMs: 30 * 60_000 },
} as const;

export const GOVERNOR_DEFAULT_POLICIES: readonly ControllerPolicy[] = [
  {
    // The 2026-06-05 reaper (17,503 kills/day). Registry: boundK 5 / perTarget 5.
    controllerId: 'age-kill-backoff',
    actionVerb: 'age-kill',
    direction: 'relief',
    resource: 'hardware-bound',
    failDirection: 'open-audited',
    perTargetCountCeiling: 5,
    totalCountCeiling: 60, // static floor; census-scales to max(60, 15% of live sessions)
    windowMs: 60 * 60_000,
    rateBucket: { ratePerWindow: 120, windowMs: 60 * 60_000, refill: 'window' },
    censusScaled: true,
    ...COMMON,
  },
  {
    // External-hog kill breaker. Registry: boundK 3 / perTarget 3 (signature-keyed).
    controllerId: 'external-hog-kill-breaker',
    actionVerb: 'kill',
    direction: 'relief',
    resource: 'hardware-bound',
    failDirection: 'open-audited',
    perTargetCountCeiling: 3,
    totalCountCeiling: 60,
    windowMs: 60 * 60_000,
    rateBucket: { ratePerWindow: 60, windowMs: 60 * 60_000, refill: 'window' },
    censusScaled: true,
    ...COMMON,
  },
  {
    // Swap-thrash bound (~72/day incident). 8 / 45 min dwell; staleTtl 60s.
    controllerId: 'proactive-swap-monitor',
    actionVerb: 'account-swap',
    direction: 'amplifying',
    resource: 'pool-shared',
    failDirection: 'closed-queue',
    perTargetCountCeiling: 3,
    totalCountCeiling: 8,
    windowMs: 45 * 60_000,
    rateBucket: { ratePerWindow: 8, windowMs: 45 * 60_000, refill: 'window' },
    staleTtlMs: 60_000,
    ...COMMON,
  },
  {
    // PromiseBeacon progress heartbeat (P17-shaped notify).
    controllerId: 'promise-beacon-notify',
    actionVerb: 'beacon-notify',
    direction: 'neutral',
    resource: 'pool-shared',
    failDirection: 'open-coalesce',
    perTargetCountCeiling: 30,
    totalCountCeiling: 120,
    windowMs: 60 * 60_000,
    rateBucket: { ratePerWindow: 120, windowMs: 60 * 60_000, refill: 'window' },
    ...COMMON,
  },
  {
    // Sparse liveness line — a DECLARED eternal sentinel (rate-floored, never
    // count-bounded; FD7). Registry rateFloorMs: 3,600,000.
    controllerId: 'liveness-heartbeat',
    actionVerb: 'liveness-notify',
    direction: 'neutral',
    resource: 'hardware-bound',
    failDirection: 'open-coalesce',
    perTargetCountCeiling: Number.POSITIVE_INFINITY,
    totalCountCeiling: Number.POSITIVE_INFINITY,
    windowMs: 60 * 60_000,
    rateBucket: { ratePerWindow: Number.POSITIVE_INFINITY, windowMs: 60 * 60_000, refill: 'window' },
    eternalSentinel: { rateFloorMs: 60 * 60_000 },
    ...COMMON,
  },
  {
    // Crash-loop respawn (amplifying) — distinct from respawn-recovery.
    controllerId: 'respawn-crashloop',
    actionVerb: 'session-respawn',
    direction: 'amplifying',
    resource: 'hardware-bound',
    failDirection: 'closed-queue',
    perTargetCountCeiling: 3,
    totalCountCeiling: 10,
    windowMs: 30 * 60_000,
    rateBucket: { ratePerWindow: 10, windowMs: 30 * 60_000, refill: 'window' },
    ...COMMON,
  },
  {
    // ResumeQueue revival path — respawn-recovery lane: NO blocking bound
    // anywhere; fails OPEN; give-up is the ResumeQueue resurrection cap.
    controllerId: 'resume-queue-respawn',
    actionVerb: 'session-respawn',
    direction: 'relief',
    resource: 'hardware-bound',
    failDirection: 'open-unconditional',
    lane: 'respawn-recovery',
    delegatedGiveUp: 'ResumeQueue resurrection cap (maxResurrections per topic)',
    perTargetCountCeiling: Number.POSITIVE_INFINITY,
    totalCountCeiling: Number.POSITIVE_INFINITY,
    windowMs: 60 * 60_000,
    rateBucket: { ratePerWindow: Number.POSITIVE_INFINITY, windowMs: 60 * 60_000, refill: 'window' },
    ...COMMON,
  },
  {
    // AutonomousLivenessReconciler respawn — respawn-recovery lane.
    controllerId: 'liveness-reconciler-respawn',
    actionVerb: 'session-respawn',
    direction: 'relief',
    resource: 'hardware-bound',
    failDirection: 'open-unconditional',
    lane: 'respawn-recovery',
    delegatedGiveUp: 'AutonomousLivenessReconciler P19 respawn breaker',
    perTargetCountCeiling: Number.POSITIVE_INFINITY,
    totalCountCeiling: Number.POSITIVE_INFINITY,
    windowMs: 60 * 60_000,
    rateBucket: { ratePerWindow: Number.POSITIVE_INFINITY, windowMs: 60 * 60_000, refill: 'window' },
    ...COMMON,
  },
];

/** FD3 — conservative-but-generous default for an unpolicied controller
 *  (a NEW self-action inherits a bound by construction). */
export function defaultPolicyFor(controllerId: string, actionVerb = 'self-action'): ControllerPolicy {
  return {
    controllerId,
    actionVerb,
    direction: 'neutral',
    resource: 'hardware-bound',
    failDirection: 'open-coalesce',
    perTargetCountCeiling: 20,
    totalCountCeiling: 120,
    windowMs: 60 * 60_000,
    rateBucket: { ratePerWindow: 120, windowMs: 60 * 60_000, refill: 'window' },
    ...COMMON,
  };
}

/** The class's POLICY-FREE last-resort errored floor (per window). A hard code
 *  constant derived from the class's CODE-DEFAULT static floor — its evaluation
 *  path reads NO config, so a well-formed-but-vacuous override cannot widen it
 *  (spec ADV7-1/DC7-2). */
export function lastResortFloorPerWindow(controllerId: string): number {
  const codeDefault = GOVERNOR_DEFAULT_POLICIES.find((p) => p.controllerId === controllerId);
  const staticFloor =
    codeDefault && Number.isFinite(codeDefault.totalCountCeiling)
      ? codeDefault.totalCountCeiling
      : 60;
  return Math.max(1, Math.round(staticFloor * LAST_RESORT_FLOOR_MULTIPLE));
}

// ── Sparse per-class config override validation (LOAD-time, never in admit) ──

/** Override-able numeric fields (FD11). The last-resort floor is NOT here by
 *  design; censusAbsoluteMax is tighten-only and handled separately. */
const OVERRIDABLE_NUMERIC_FIELDS = new Set([
  'perTargetCountCeiling',
  'totalCountCeiling',
  'windowMs',
  'queueMaxDepth',
  'queueMaxTargets',
  'staleTtlMs',
]);

export type GovernorClassOverride = Partial<
  Pick<
    ControllerPolicy,
    | 'perTargetCountCeiling'
    | 'totalCountCeiling'
    | 'windowMs'
    | 'queueMaxDepth'
    | 'queueMaxTargets'
    | 'staleTtlMs'
  >
> & { mode?: 'observe' | 'enforce' };

export interface ResolvedPolicies {
  /** controllerId → effective policy (code default deep-merged with valid overrides). */
  policies: Map<string, ControllerPolicy>;
  /** controllerId → declared mode override ('observe' default when absent). */
  modeOverrides: Map<string, 'observe' | 'enforce'>;
  /** controllerId → true when any numeric override is active (posture rows). */
  overridden: Map<string, { ratio: number }>;
  /** Load-validation audit rows (malformed overrides → code default + row). */
  auditRows: TransitionRow[];
}

/**
 * Resolve effective policies from the code defaults + the sparse config
 * overrides block (`intelligence.selfActionGovernor.classes`). Malformed
 * values fall back to the code default with a `policy-override-invalid` audit
 * row — a throwing/invalid override can NEVER throw inside admit().
 */
export function resolvePolicies(
  classesConfig: unknown,
  nowIso: () => string = () => new Date().toISOString(),
): ResolvedPolicies {
  const policies = new Map<string, ControllerPolicy>();
  const modeOverrides = new Map<string, 'observe' | 'enforce'>();
  const overridden = new Map<string, { ratio: number }>();
  const auditRows: TransitionRow[] = [];

  for (const p of GOVERNOR_DEFAULT_POLICIES) {
    policies.set(p.controllerId, { ...p, rateBucket: { ...p.rateBucket }, breaker: { ...p.breaker }, perTargetEvict: { ...p.perTargetEvict } });
  }

  if (!classesConfig || typeof classesConfig !== 'object' || Array.isArray(classesConfig)) {
    if (classesConfig !== undefined && classesConfig !== null) {
      auditRows.push({
        ts: nowIso(),
        type: 'policy-override-invalid',
        detail: 'classes block is not an object — code defaults apply',
      });
    }
    return { policies, modeOverrides, overridden, auditRows };
  }

  for (const [controllerId, raw] of Object.entries(classesConfig as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      auditRows.push({
        ts: nowIso(),
        type: 'policy-override-invalid',
        controllerId,
        detail: 'override is not an object — code default applies',
      });
      continue;
    }
    const base = policies.get(controllerId) ?? defaultPolicyFor(controllerId);
    const merged: ControllerPolicy = { ...base, rateBucket: { ...base.rateBucket }, breaker: { ...base.breaker }, perTargetEvict: { ...base.perTargetEvict } };
    let anyNumericOverride = false;
    for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
      if (field === 'mode') {
        if (value === 'observe' || value === 'enforce') {
          modeOverrides.set(controllerId, value);
        } else {
          auditRows.push({
            ts: nowIso(),
            type: 'policy-override-invalid',
            controllerId,
            detail: `mode override ${String(value)} invalid — observe applies`,
          });
        }
        continue;
      }
      if (!OVERRIDABLE_NUMERIC_FIELDS.has(field)) {
        auditRows.push({
          ts: nowIso(),
          type: 'policy-override-invalid',
          controllerId,
          detail: `field ${field} is not overridable — ignored`,
        });
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        auditRows.push({
          ts: nowIso(),
          type: 'policy-override-invalid',
          controllerId,
          detail: `field ${field}=${String(value)} malformed — code default applies`,
        });
        continue;
      }
      // Exempt lanes keep their unbounded semantics — a count override on a
      // respawn-recovery lane member is refused (the lane has no blocking bound).
      if (merged.lane === 'respawn-recovery' && field !== 'windowMs') {
        auditRows.push({
          ts: nowIso(),
          type: 'policy-override-invalid',
          controllerId,
          detail: `field ${field} not overridable on the respawn-recovery lane — ignored`,
        });
        continue;
      }
      (merged as unknown as Record<string, number>)[field] = value;
      anyNumericOverride = true;
    }
    if (anyNumericOverride) {
      const def = GOVERNOR_DEFAULT_POLICIES.find((p) => p.controllerId === controllerId) ?? defaultPolicyFor(controllerId);
      const ratio =
        Number.isFinite(def.totalCountCeiling) && def.totalCountCeiling > 0 && Number.isFinite(merged.totalCountCeiling)
          ? merged.totalCountCeiling / def.totalCountCeiling
          : 1;
      overridden.set(controllerId, { ratio });
      auditRows.push({
        ts: nowIso(),
        type: 'policy-override-change',
        controllerId,
        detail: `numeric override active (totalCeiling ratio ${ratio.toFixed(2)})`,
      });
    }
    policies.set(controllerId, merged);
  }
  return { policies, modeOverrides, overridden, auditRows };
}

/** censusAbsoluteMax: min(hard code ceiling, 4× configured session cap) —
 *  session-cap-derived value may only TIGHTEN below the hard ceiling. */
export function censusAbsoluteMax(configuredSessionCap: number | undefined): number {
  const fromCap =
    typeof configuredSessionCap === 'number' && Number.isFinite(configuredSessionCap) && configuredSessionCap > 0
      ? configuredSessionCap * CENSUS_ABSOLUTE_MAX_SESSION_CAP_FACTOR
      : CENSUS_ABSOLUTE_MAX_HARD_CEILING;
  return Math.min(CENSUS_ABSOLUTE_MAX_HARD_CEILING, fromCap);
}
