/**
 * selfaction/types.ts — the SelfActionGovernor contract types (Increment B of
 * docs/specs/unified-self-action-backpressure.md; the normative implementation
 * companion `unified-self-action-backpressure.companion.md` is the
 * implementation AUTHORITY — §1 terminology, §2 API contract, §3 policy schema).
 *
 * Constitution: "Capacity Safety — No Unbounded Self-Action" (the runtime arm
 * of the same contract the convergence ratchet proves at test time).
 */

/** Per-class direction — relief reduces the pressure it responds to. */
export type ControllerDirection = 'relief' | 'amplifying' | 'neutral';

/** Per-class protected-resource scope (companion §1, §3). */
export type ControllerResource = 'hardware-bound' | 'pool-shared';

/**
 * Per-class fail direction when the ENABLED governor's admit() throws
 * (companion §6 fail matrix). Relief classes are 'open-audited'.
 */
export type ControllerFailDirection = 'closed-queue' | 'open-coalesce' | 'open-audited' | 'open-unconditional';

/** Per-class mode (companion §1): observe records would-verdicts and always
 *  allows; enforce binds; demoted = enforce knocked back to observe by a
 *  level trigger (FD9 / runtime gate). */
export type GovernorClassMode = 'observe' | 'enforce' | 'demoted';

/** Admission origin (companion §1/§4). Ordinary handles stamp 'self'
 *  unconditionally; 'principal' exists only via the privileged API. */
export type AdmissionOrigin = 'self' | 'principal';

/**
 * The deciding layer named on every Admission (companion §2). 'admitted' is
 * the clean-allow value (every ceiling passed); the rest name the layer that
 * decided a non-clean verdict.
 */
export type SubMechanism =
  | 'admitted'
  | 'per-target-ceiling'
  | 'total-ceiling'
  | 'census-scale'
  | 'rate-bucket'
  | 'breaker'
  | 'stale-projection'
  | 'queue-full'
  | 'lane-floor'
  | 'observe-would-deny'
  | 'rehydrated-window'
  | 'disabled-passthrough'
  | 'errored-open'
  | 'principal-lane';

declare const AdmissionTokenBrand: unique symbol;

/**
 * Opaque capability token minted on 'allow' (companion §2, FD6). Bound
 * (controllerId, targetKey, classId, nonce), TTL'd; the runtime consume-once
 * at the protected sink is the AUTHORITY — this compile-time type is
 * defense-in-depth only.
 */
export interface AdmissionToken {
  readonly [AdmissionTokenBrand]?: true;
  /** Opaque id — sinks must never parse it; consume via the governor. */
  readonly id: string;
}

/** Three-way admission — never a silent drop (spec R3). Only 'allow' mints a token. */
export type Admission =
  | { outcome: 'allow'; token: AdmissionToken; reason: SubMechanism; detail?: string }
  | { outcome: 'coalesce'; reason: SubMechanism; detail?: string }
  | { outcome: 'queue'; reason: SubMechanism; retryAfterMs?: number; detail?: string };

/**
 * The canonical derived target (companion §1) — produced ONLY by a
 * controller's `deriveTargetKey(ctx)`; mirrors the deployed
 * `ExternalHogKillLedger` triple (key, classId, keyIsVolatile).
 */
export interface DerivedTarget {
  key: string;
  classId: string;
  keyIsVolatile: boolean;
}

/** Options accompanying an admit (queue fencing + drain re-validation seams). */
export interface AdmitOpts {
  /** The target's incarnation id where one exists (session uuid, pid) —
   *  captured at enqueue; drain REJECTS on fence mismatch (spec ADV5-4). */
  incarnation?: string;
  /** The controller's own eligibility predicate, re-run at drain BEFORE
   *  firing (is the session still over-age? the hog still hot?). */
  eligible?: () => boolean;
  /** Fired at drain when a queued intent is re-admitted (enforce path). */
  onAdmitted?: (token: AdmissionToken) => void;
  /** Drain fairness lane — interactive drains before jobs (spec DC5-1). */
  lane?: 'interactive' | 'job';
  /** Injected clock for tests (virtual-clock fixtures). */
  nowMs?: number;
}

/** Raw pressure reading — the DECISION lives inside the governor (spec SEC3). */
export interface PressureReading {
  value: number;
  asOf: number;
  confidence: 'high' | 'low';
}

/** Rate bucket policy (token bucket, fixed window). */
export interface RateBucketPolicy {
  ratePerWindow: number;
  windowMs: number;
  refill: 'window' | 'continuous';
}

/** P19 brakes policy. */
export interface BreakerPolicy {
  failThreshold: number;
  cooldownMs: number;
  flapWindowMs: number;
}

/** Per-target eviction policy (recency-aware — spec SC-m3). */
export interface PerTargetEvictPolicy {
  ttlMs: number;
  maxEntries: number;
}

/**
 * ControllerPolicy (companion §3). Defaults are CODE constants; config carries
 * sparse per-class overrides validated AT LOAD (malformed → code default +
 * audit row; never throw-in-admit).
 */
export interface ControllerPolicy {
  controllerId: string;
  actionVerb: string;
  direction: ControllerDirection;
  resource: ControllerResource;
  failDirection: ControllerFailDirection;
  perTargetCountCeiling: number;
  /** Static floor for the total ceiling; relief classes census-scale above it. */
  totalCountCeiling: number;
  /** The count window (fixed-bucket sliding; no epoch reset for relief). */
  windowMs: number;
  rateBucket: RateBucketPolicy;
  concurrencyCap?: number;
  breaker: BreakerPolicy;
  /** Pressure-reading freshness bound (amplifying classes). */
  staleTtlMs?: number;
  /** Per (controller, target) coalesced queue depth. */
  queueMaxDepth: number;
  /** Per controller DISTINCT-target queue ceiling (default 64). */
  queueMaxTargets: number;
  perTargetEvict: PerTargetEvictPolicy;
  /** Amplifying classes: RAW-reading callback only (spec SEC3). */
  amplifying?: { projectPressure?: () => PressureReading | null };
  /** Declared Eternal Sentinel — rate-floored, never count-bounded (FD7). */
  eternalSentinel?: { rateFloorMs: number };
  /** Census-scaled relief total ceiling (spec ADV5-2): applies when direction
   *  is 'relief' and the class is count-bound (not an exempt lane). */
  censusScaled?: boolean;
  /** Exempt-lane tag (FD5): 'respawn-recovery' fails OPEN unconditionally and
   *  is never queued/dead-lettered; membership is an enumerated allowlist. */
  lane?: 'respawn-recovery';
  /** Named external give-up authority for exempt-lane members (spec ADV5-3). */
  delegatedGiveUp?: string;
}

/** Principal entry surfaces (companion §4 — the enumerated allowlist). */
export type PrincipalSurface =
  | 'dashboard-pin-session'
  | 'message-sentinel-verified-sender'
  | 'mandate-verified-principal';

/** What the principal is doing — audit tag only. */
export interface ActionRef {
  actionVerb: string;
  target?: string;
}

/** Transitions-only audit row types (spec §Runtime telemetry — the builder's
 *  enumerated list; every notice contract's audit-location appears here). */
export type TransitionRowType =
  | 'breaker-open'
  | 'breaker-close'
  | 'non-convergence-trip'
  | 'class-enforce-flip'
  | 'policy-override-change'
  | 'policy-override-invalid'
  | 'emergency-disable-flip'
  | 'restart-shed'
  | 'enqueue-drop'
  | 'demote-latch'
  | 'repromote-latch'
  | 'dead-letter-shed'
  | 'state-reset'
  | 'rehydrate-anomaly'
  | 'census-clamp'
  | 'principal-volume-anomaly'
  | 'principal-admit'
  | 'observe-limbo'
  | 'errored-episode-open'
  | 'errored-episode-close'
  | 'errored-admit'
  | 'mint-collision'
  | 'auto-demote-pool-gate'
  | 'queue-drain-drop';

export interface TransitionRow {
  ts: string;
  type: TransitionRowType;
  controllerId?: string;
  detail?: string;
  /** Config-write principal where known ('unknown(file)' for a direct edit). */
  principal?: string;
}

/** The scrubbed per-class posture row served by GET /self-action-governor
 *  (no target identities, no absolute quota values — spec SEC6). */
export interface GovernorClassPosture {
  controllerId: string;
  actionVerb: string;
  direction: ControllerDirection;
  resource: ControllerResource;
  mode: GovernorClassMode;
  overridden: boolean;
  /** ceiling-vs-default ratio when a numeric override is active (spec SEC5-2). */
  ceilingVsDefaultRatio?: number;
  windowCount: number;
  counters: {
    admits: number;
    coalesces: number;
    queues: number;
    wouldDeny: number;
    denies: number;
    erroredOpens: number;
  };
  /** Deciding-sub-mechanism aggregate (class × sub-mechanism). */
  bySubMechanism: Record<string, number>;
  breakerOpen: boolean;
  demoted: boolean;
  queueDepth: number;
  queueDistinctTargets: number;
}

/** Attention item shape the governor emits (rides the P17 funnel via the
 *  injected attention seam — the ONLY path for operator notices). */
export interface GovernorAttentionItem {
  id: string;
  title: string;
  body: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext: string;
}

/** Six-notice severities per companion §8. */
export type GovernorNoticeKind =
  | 'demote-alarm'
  | 'dead-letter-shed'
  | 'errored-posture'
  | 'emergency-disable-flip'
  | 'principal-volume-page'
  | 'observe-limbo-nudge';
