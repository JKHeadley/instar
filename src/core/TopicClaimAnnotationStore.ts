/**
 * TopicClaimAnnotationStore — the NEW replicated record kind U4.2 introduces
 * (`topic-claim-annotation`, spec docs/specs/u4-2-stale-owner-release.md §2.4,
 * R-r3-1/R-r3-2). It carries the three pieces of stale-owner-release state that
 * must SURVIVE the claimer role (the serving lease) moving between machines:
 *
 *   1. the claim-time PIN SUSPENSION (a stale-owner claim suspends the topic's
 *      pin rather than leaving pin↔owner divergence for the reconciler to
 *      fight — U4.1's `pinState` derives `suspended-pending-owner-return` from
 *      this at READ time; the pin record itself is NEVER written),
 *   2. the per-topic CLAIM BUDGET + widening backoff (R-r2-4: a machine-local
 *      budget would reset to zero on every lease move — under exactly the
 *      flapping conditions the budget exists to bound),
 *   3. the operator's DECLINED-DEMOTE pin ("A Refusal Stays a Refusal" must
 *      survive the refusal's audience changing machines).
 *
 * DESIGN INVARIANTS (both are the reason this kind exists — R-r3-1/R-r3-2):
 *   - It is deliberately NOT ownership state. It can never answer or fence
 *     ownership; the existing SessionOwnershipRecord stays SCHEMA-UNCHANGED.
 *     Riding the ownership record was grounded as unshippable: the
 *     topic-placement receive-validation strictly rejects unknown fields (a
 *     pre-U4.2 peer would suspect-halt the claimant's ENTIRE placement stream)
 *     and OwnershipApplier is a whitelist materializer that silently drops
 *     unknown fields. A new registered KIND is additive: peers that don't
 *     register it simply never sync it — no unknown-FIELD surface at all.
 *   - It is epoch-INDEPENDENT: ordered by its own HLC via the generic envelope
 *     (exactly like `topic-pin-record`), never an ownership CAS transition. A
 *     suspension/budget/refusal write MUST NOT bump `ownershipEpoch` — that
 *     would fence a live owner's sends the moment the §2.3 emission fence is
 *     wired, and contradicts §2.2.1's records-written-only-on-claim/release-
 *     transitions rule.
 *
 * recordKey = `${topic}:${episodeId}` (spec §2.4 — keyed topic + episodeId).
 * The merged PER-TOPIC read picks the highest-HLC record across that topic's
 * episode records (skew-proof; the same HLC-highest-wins discipline as pins).
 *
 * Rollback tolerance (spec §5): lingering records are INERT derived state —
 * readers that don't consult them lose nothing; the suspension is cleared by
 * the next operator re-pin (a fresher pin HLC wins at the effectivePins read).
 */

import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import { compareHlc } from './TopicPinReplicatedStore.js';

/** The JournalKind string this store rides (dual-registry dynamic half; the
 *  static half is CoherenceJournal.JOURNAL_KINDS, which lists it too). */
export const TOPIC_CLAIM_ANNOTATION_KIND = 'topic-claim-annotation';
/** The store key used by the emitter dark-gate + getByStore wiring. */
export const TOPIC_CLAIM_ANNOTATION_STORE_KEY = 'topicClaimAnnotations';

/** Machine-id charset clamp (consistent with topic-pin-record). */
const MACHINE_ID_RE = /^[\w-]{1,64}$/;
/** Episode-id charset clamp — plain token, never path-shaped (jail discipline). */
const EPISODE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The store-owned fields (for the registry's unknown-field counting). */
const CLAIM_ANNOTATION_KNOWN_FIELDS = [
  'topic',
  'episodeId',
  'suspended',
  'claimedBy',
  'claimCount',
  'backoffUntilMs',
  'declinedDemote',
  'deletedAt',
] as const;

/** recordKey = `${topic}:${episodeId}` — per-(topic, episode) identity. */
export function deriveClaimAnnotationRecordKey(topic: number | string, episodeId: string): string | null {
  const n = typeof topic === 'number' ? topic : Number(topic);
  if (!Number.isFinite(n)) return null;
  if (!EPISODE_ID_RE.test(episodeId)) return null;
  return `${n}:${episodeId}`;
}

export const topicClaimAnnotationStoreSchema: StoreFieldSchema = {
  knownFields: CLAIM_ANNOTATION_KNOWN_FIELDS as unknown as ReadonlyArray<string>,
  pathSensitiveFields: ['claimedBy', 'episodeId'],
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    if (raw.op === 'delete') {
      // Tombstone (e.g. an explicit annotation clear): only deletedAt is a legal
      // store field; recordKey + hlc + op (envelope) carry the suppression.
      const deletedAt = typeof raw.deletedAt === 'string' ? raw.deletedAt : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt') continue;
        if ((CLAIM_ANNOTATION_KNOWN_FIELDS as ReadonlyArray<string>).includes(k)) ctx.countDroppedField();
      }
      return deletedAt !== undefined ? { deletedAt } : {};
    }
    // PUT — strict type clamps. A malformed field rejects the WHOLE record
    // (quarantined by the envelope machinery, never a silent partial accept).
    const topic = typeof raw.topic === 'number' && Number.isFinite(raw.topic) ? raw.topic : null;
    if (topic === null) return null;
    if (typeof raw.episodeId !== 'string' || !EPISODE_ID_RE.test(raw.episodeId)) return null;
    if (typeof raw.suspended !== 'boolean') return null;
    if (raw.claimedBy !== undefined && (typeof raw.claimedBy !== 'string' || !MACHINE_ID_RE.test(raw.claimedBy))) return null;
    const claimCount = typeof raw.claimCount === 'number' && Number.isFinite(raw.claimCount) && raw.claimCount >= 0
      ? Math.floor(raw.claimCount)
      : null;
    if (claimCount === null) return null;
    if (raw.backoffUntilMs !== undefined && (typeof raw.backoffUntilMs !== 'number' || !Number.isFinite(raw.backoffUntilMs))) return null;
    if (raw.declinedDemote !== undefined && typeof raw.declinedDemote !== 'boolean') return null;
    return {
      topic,
      episodeId: raw.episodeId,
      suspended: raw.suspended,
      ...(raw.claimedBy !== undefined ? { claimedBy: raw.claimedBy } : {}),
      claimCount,
      ...(raw.backoffUntilMs !== undefined ? { backoffUntilMs: raw.backoffUntilMs } : {}),
      ...(raw.declinedDemote !== undefined ? { declinedDemote: raw.declinedDemote } : {}),
    };
  },
};

/** Dual-registry registration (mirrors TOPIC_PIN_KIND_REGISTRATION). Registration
 *  is INERT — emission stays gated behind the staleOwnerRelease feature flag. */
export const TOPIC_CLAIM_ANNOTATION_KIND_REGISTRATION = {
  kind: TOPIC_CLAIM_ANNOTATION_KIND,
  store: TOPIC_CLAIM_ANNOTATION_STORE_KEY,
  schema: topicClaimAnnotationStoreSchema,
} as const;

export function topicClaimAnnotationContributingKinds(): string[] {
  return [TOPIC_CLAIM_ANNOTATION_KIND];
}

/** The inputs a claim-annotation PUT carries. */
export interface ClaimAnnotationPutInput {
  topic: number;
  episodeId: string;
  /** Pin suspension active for this claim episode (claim landed). */
  suspended: boolean;
  /** The claiming machine (for the returning owner's teardown disclosure). */
  claimedBy?: string;
  /** Per-topic cumulative claim-attempt count (the replicated budget). */
  claimCount: number;
  /** Widening-backoff floor: no further claim attempt before this epoch-ms. */
  backoffUntilMs?: number;
  /** The operator's durable "no" for this episode (declined demote). */
  declinedDemote?: boolean;
}

/** Build a PUT record's data (the emitter-supplied envelope inputs pattern). */
export function buildClaimAnnotationPut(input: ClaimAnnotationPutInput) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => {
    const recordKey = deriveClaimAnnotationRecordKey(input.topic, input.episodeId);
    if (recordKey === null) return null;
    if (input.claimedBy !== undefined && !MACHINE_ID_RE.test(input.claimedBy)) return null;
    if (!Number.isFinite(input.claimCount) || input.claimCount < 0) return null;
    return {
      topic: input.topic,
      episodeId: input.episodeId,
      suspended: input.suspended,
      ...(input.claimedBy !== undefined ? { claimedBy: input.claimedBy } : {}),
      claimCount: Math.floor(input.claimCount),
      ...(input.backoffUntilMs !== undefined ? { backoffUntilMs: input.backoffUntilMs } : {}),
      ...(input.declinedDemote !== undefined ? { declinedDemote: input.declinedDemote } : {}),
      recordKey,
      hlc,
      op: 'put' as ReplicatedOp,
      origin,
      ...(observed !== undefined ? { observed } : {}),
    };
  };
}

/** Build a TOMBSTONE (clear-annotation) record's data. */
export function buildClaimAnnotationTombstone(topic: number, episodeId: string, deletedAt: string) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => {
    const recordKey = deriveClaimAnnotationRecordKey(topic, episodeId);
    if (recordKey === null) return null;
    return {
      deletedAt,
      recordKey,
      hlc,
      op: 'delete' as ReplicatedOp,
      origin,
      ...(observed !== undefined ? { observed } : {}),
    };
  };
}

/** The merged per-topic view of the claim annotations (READ-ONLY, advisory-
 *  derived state — never ownership, never a fence). */
export interface MergedClaimAnnotation {
  topic: number;
  /** The winning (highest-HLC) episode for this topic. */
  episodeId: string;
  suspended: boolean;
  claimedBy?: string;
  claimCount: number;
  backoffUntilMs?: number;
  declinedDemote: boolean;
  origin: string;
  /** The winning HLC — effectivePins() orders the operator's re-pin against this
   *  (a fresher pin HLC clears the suspension: the operator's newer statement wins). */
  hlc: HlcTimestamp;
}

/**
 * Collapse replicated `topic-claim-annotation` entries to ONE merged annotation
 * per topic: highest-HLC record per recordKey first (put OR delete), then the
 * highest-HLC surviving PUT per TOPIC wins (an episode's tombstone removes that
 * episode's record; a newer episode's record supersedes an older episode's).
 * Input entries are already envelope-validated records.
 */
export function mergeUnionToClaimAnnotations(
  entries: Array<{ data: Record<string, unknown>; origin: string }>,
): Map<number, MergedClaimAnnotation> {
  // Pass 1: highest-HLC record per recordKey (per topic+episode).
  const winnerByKey = new Map<string, { data: Record<string, unknown>; origin: string; hlc: HlcTimestamp }>();
  for (const e of entries) {
    const hlc = e.data.hlc as HlcTimestamp | undefined;
    const recordKey = typeof e.data.recordKey === 'string' ? e.data.recordKey : null;
    if (!hlc || recordKey === null) continue;
    const cur = winnerByKey.get(recordKey);
    if (!cur || compareHlc(hlc, cur.hlc) > 0) winnerByKey.set(recordKey, { data: e.data, origin: e.origin, hlc });
  }
  // Pass 2: per TOPIC, the highest-HLC surviving PUT wins.
  const out = new Map<number, MergedClaimAnnotation>();
  for (const w of winnerByKey.values()) {
    if (w.data.op === 'delete') continue;
    const topic = typeof w.data.topic === 'number' ? w.data.topic : NaN;
    const episodeId = typeof w.data.episodeId === 'string' ? w.data.episodeId : '';
    if (!Number.isFinite(topic) || !EPISODE_ID_RE.test(episodeId)) continue;
    const cur = out.get(topic);
    if (cur && compareHlc(w.hlc, cur.hlc) <= 0) continue;
    out.set(topic, {
      topic,
      episodeId,
      suspended: w.data.suspended === true,
      ...(typeof w.data.claimedBy === 'string' ? { claimedBy: w.data.claimedBy } : {}),
      claimCount: typeof w.data.claimCount === 'number' && Number.isFinite(w.data.claimCount) ? w.data.claimCount : 0,
      ...(typeof w.data.backoffUntilMs === 'number' && Number.isFinite(w.data.backoffUntilMs)
        ? { backoffUntilMs: w.data.backoffUntilMs }
        : {}),
      declinedDemote: w.data.declinedDemote === true,
      origin: w.origin,
      hlc: w.hlc,
    });
  }
  return out;
}

/**
 * §2.4 — the ONE comparison authority for "does a live claim suspension exclude
 * this pin?". A pin whose HLC is NOT strictly newer than the live suspension is
 * `suspended-pending-owner-return`; a later operator re-pin carries a fresher
 * HLC and WINS (the operator's newer statement clears the suspension).
 *
 * Shared by OwnershipReconciler.effectivePins() (the reconciler never fights the
 * claim) AND the SessionReaper closeout's pin-conflict veto wiring (§2.3
 * returning-owner teardown: a SUSPENDED pin is not "the reconciler bringing the
 * topic back", so it must not veto the returned owner's closeout — otherwise a
 * claimed pinned topic's session would linger on the returned owner forever).
 */
export function claimSuspensionExcludesPin(
  pinHlc: HlcTimestamp,
  suspension: { suspended: boolean; hlc: HlcTimestamp } | null | undefined,
): boolean {
  if (!suspension || suspension.suspended !== true) return false;
  return compareHlc(pinHlc, suspension.hlc) <= 0;
}
