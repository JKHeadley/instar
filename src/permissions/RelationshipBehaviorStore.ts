/**
 * RelationshipBehaviorStore — the durable, deterministic behavioral baseline per
 * principal (Pillar 3, §7.1). This is the substrate the RelationshipAnomalyScorer
 * reads to answer "does this request feel like THEM?".
 *
 * Why a dedicated store (vs reusing RelationshipManager):
 *   RelationshipManager is generic, cross-platform relationship memory (themes,
 *   notes, a free-text communicationStyle). It has no structured per-request history
 *   — no action-tier histogram, no time-of-day distribution, no message-shape stats
 *   — which is exactly what a CHEAP, DETERMINISTIC anomaly baseline needs. Rather
 *   than retrofit privacy-sensitive structured tracking onto the generic manager,
 *   this module keeps a small, Slack-permission-scoped, privacy-respecting baseline:
 *   SHAPE only (which action labels, what tier, what hour, how long the message was),
 *   NEVER message content. The seam mirrors the rest of the permissions module — it
 *   depends on nothing in core; the gate/observer inject it.
 *
 * Privacy: we store action LABELS, tier counts, hour-of-day counts, and coarse
 * message-length stats. We do NOT store message text, topics, or any free text.
 *
 * State category: `slack-relationship-baselines` (state-coherence-registry.json).
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §7.1–7.2, §7.6.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A single recorded interaction's SHAPE (never content). */
export interface BehaviorObservation {
  /** Action label from the intent classifier (e.g. 'read', 'prod-deploy'). */
  action: string;
  /** Sensitivity tier 0..4. */
  tier: number;
  /** Local hour-of-day 0..23 the request arrived. */
  hour: number;
  /** Message length in characters (coarse style signal). */
  length: number;
  /** Whether the message carried urgency/pressure language (cheap style signal). */
  urgent: boolean;
}

/**
 * A time-bucketed slice of a principal's history (poisoning-resistance, Phase-3
 * follow-ups #2/#3b). One bucket per rolling window (`bucketMs`, default 1 day).
 * Holds the SAME SHAPE counts as the cumulative profile, scoped to a window — so
 * the scorer can apply recency/decay weighting (a RECENT attacker burst can't durably
 * dominate the histogram) and the store can enforce a per-window observation-rate cap
 * (one session can't hammer the histogram to reshape it).
 *
 * Buckets are ADDITIVE: the cumulative `actionCounts`/`tierCounts`/`hourCounts`/length
 * sums on the profile are kept in lock-step so an old reader (or a downgrade) still sees
 * the same numbers it always did. A profile written before this hardening simply has no
 * `buckets` field and degrades to its cumulative form everywhere.
 */
export interface BehaviorBucket {
  /** Window start (epoch ms, floored to the bucket boundary) — drives decay weighting. */
  startMs: number;
  /** Observations recorded in this window (drives the per-window rate cap). */
  count: number;
  actionCounts: Record<string, number>;
  tierCounts: number[];
  hourCounts: number[];
  lengthSum: number;
  lengthSqSum: number;
  urgentCount: number;
}

/**
 * The aggregated, privacy-respecting baseline for one principal. All counts; no
 * content. Persisted as JSON; cheap to read and update.
 */
export interface PrincipalBehaviorProfile {
  slackUserId: string;
  /** Total observations recorded — the DEPTH of the baseline (drives confidence). */
  interactionCount: number;
  /** Count per action label — the principal's normal repertoire. */
  actionCounts: Record<string, number>;
  /** Count per sensitivity tier (index 0..4). */
  tierCounts: number[];
  /** Count per local hour-of-day (index 0..23) — the principal's normal rhythm. */
  hourCounts: number[];
  /** Running mean + count of message length, for a coarse style baseline (Welford-free, count-weighted). */
  lengthSum: number;
  lengthSqSum: number;
  /** How often this principal uses urgency language at baseline (0..1 derived from count). */
  urgentCount: number;
  /** First / last observation ISO timestamps. */
  firstSeen: string;
  lastSeen: string;
  /**
   * OPTIONAL time-bucketed history (poisoning-resistance #2/#3b). Newest bucket last.
   * Absent on a pre-hardening profile — the scorer degrades to the cumulative counts.
   * When present, the cumulative counts above remain the exact sum of all buckets'
   * counts (backward-compat invariant), so old readers are unaffected.
   */
  buckets?: BehaviorBucket[];
}

/** Recording knobs for the rate-cap (#3b) + decay bucket sizing (#2). All optional. */
export interface BehaviorStoreOptions {
  /**
   * Length of one decay/rate-cap bucket window (ms). Default 1 day. The recency-decay
   * weighting (applied at scoring time) and the per-window observation cap are both
   * keyed off this window.
   */
  bucketMs?: number;
  /**
   * Per-principal observation-rate cap (#3b): the MAX observations RECORDED into a
   * single bucket window. Excess observations in the window are DROPPED (logged via
   * `onCapDrop`), not recorded — so one session can't hammer the histogram to reshape
   * it. Default 50/day. Set to a falsy/non-positive value to disable the cap.
   */
  maxObservationsPerWindow?: number;
  /** Cap how many buckets are retained (bounds file growth). Default 90 (≈90 days). */
  maxBuckets?: number;
  /** Best-effort callback when an observation is dropped by the rate cap (for logging). */
  onCapDrop?: (slackUserId: string, windowStartMs: number, droppedCount: number) => void;
}

function emptyProfile(slackUserId: string, now: string): PrincipalBehaviorProfile {
  return {
    slackUserId,
    interactionCount: 0,
    actionCounts: {},
    tierCounts: [0, 0, 0, 0, 0],
    hourCounts: new Array(24).fill(0),
    lengthSum: 0,
    lengthSqSum: 0,
    urgentCount: 0,
    firstSeen: now,
    lastSeen: now,
    buckets: [],
  };
}

function emptyBucket(startMs: number): BehaviorBucket {
  return {
    startMs,
    count: 0,
    actionCounts: {},
    tierCounts: [0, 0, 0, 0, 0],
    hourCounts: new Array(24).fill(0),
    lengthSum: 0,
    lengthSqSum: 0,
    urgentCount: 0,
  };
}

export const DEFAULT_BUCKET_MS = 24 * 60 * 60 * 1000; // 1 day
export const DEFAULT_MAX_OBSERVATIONS_PER_WINDOW = 50;
export const DEFAULT_MAX_BUCKETS = 90;

/** Validate a slackUserId for safe use as a filename key (prevents path traversal). */
function isSafeKey(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export class RelationshipBehaviorStore {
  private readonly file: string;
  private readonly now: () => string;
  private readonly bucketMs: number;
  private readonly maxObservationsPerWindow: number;
  private readonly maxBuckets: number;
  private readonly onCapDrop?: (slackUserId: string, windowStartMs: number, droppedCount: number) => void;

  constructor(
    stateDir: string,
    now: () => string = () => new Date().toISOString(),
    options: BehaviorStoreOptions = {},
  ) {
    /* state-registry: slack-relationship-baselines */
    this.file = path.join(stateDir, 'slack-relationship-baselines.json');
    this.now = now;
    // Nullish-coalescing (not ||) so a deliberate 0 disables the cap (per Dawn key-pattern).
    this.bucketMs = options.bucketMs && options.bucketMs > 0 ? options.bucketMs : DEFAULT_BUCKET_MS;
    this.maxObservationsPerWindow =
      options.maxObservationsPerWindow ?? DEFAULT_MAX_OBSERVATIONS_PER_WINDOW;
    this.maxBuckets = options.maxBuckets && options.maxBuckets > 0 ? options.maxBuckets : DEFAULT_MAX_BUCKETS;
    this.onCapDrop = options.onCapDrop;
  }

  /** The bucket-window length (ms) this store records into — read by the scorer for decay. */
  get bucketWindowMs(): number {
    return this.bucketMs;
  }

  get path(): string {
    return this.file;
  }

  /**
   * Record an observation for a principal, growing their baseline. Best-effort:
   * a write failure is swallowed (this is observe-only infra; it must never break
   * the message path). No-op for an unsafe key (defensive).
   */
  record(slackUserId: string, obs: BehaviorObservation): void {
    if (!slackUserId || !isSafeKey(slackUserId)) return;
    try {
      const all = this.readAll();
      const now = this.now();
      const nowMs = Date.parse(now);
      const prof = all[slackUserId] ?? emptyProfile(slackUserId, now);

      // ── #3b: per-window observation-rate cap ──────────────────────────────────────
      // Resolve the current bucket. If recording this observation would exceed the
      // per-window cap, DROP it (log via onCapDrop) — the cumulative counts are NOT
      // touched either, so the buckets-sum invariant holds and the cap actually bites.
      const bucket = this.currentBucket(prof, nowMs);
      if (
        this.maxObservationsPerWindow > 0 &&
        bucket.count >= this.maxObservationsPerWindow
      ) {
        // Over the cap for this window — drop, don't record. lastSeen is intentionally
        // NOT advanced for a dropped observation (a dropped obs is not "an interaction").
        try {
          this.onCapDrop?.(slackUserId, bucket.startMs, 1);
        } catch {
          /* logging must never break the path */
        }
        all[slackUserId] = prof; // persist any bucket pruning done while resolving
        this.writeAll(all);
        return;
      }

      const tier = Math.max(0, Math.min(4, Math.floor(obs.tier)));
      const hour = Math.max(0, Math.min(23, Math.floor(obs.hour)));
      const len = Math.max(0, Math.floor(obs.length));

      // Cumulative counts (backward-compat — old readers see the same numbers).
      prof.interactionCount += 1;
      prof.actionCounts[obs.action] = (prof.actionCounts[obs.action] ?? 0) + 1;
      prof.tierCounts[tier] = (prof.tierCounts[tier] ?? 0) + 1;
      prof.hourCounts[hour] = (prof.hourCounts[hour] ?? 0) + 1;
      prof.lengthSum += len;
      prof.lengthSqSum += len * len;
      if (obs.urgent) prof.urgentCount += 1;
      prof.lastSeen = now;

      // Time-bucketed counts (kept in lock-step with the cumulative totals).
      bucket.count += 1;
      bucket.actionCounts[obs.action] = (bucket.actionCounts[obs.action] ?? 0) + 1;
      bucket.tierCounts[tier] = (bucket.tierCounts[tier] ?? 0) + 1;
      bucket.hourCounts[hour] = (bucket.hourCounts[hour] ?? 0) + 1;
      bucket.lengthSum += len;
      bucket.lengthSqSum += len * len;
      if (obs.urgent) bucket.urgentCount += 1;

      all[slackUserId] = prof;
      this.writeAll(all);
    } catch {
      // Observe-only baseline must NEVER break the message path.
    }
  }

  /**
   * Resolve (and lazily migrate) the bucket covering `nowMs`, pruning to `maxBuckets`.
   * Backfills a missing `buckets` array on a pre-hardening profile WITHOUT moving its
   * cumulative counts into a bucket (those counts predate bucketing and have unknown
   * timestamps — they keep weight as the un-decayable "legacy" base; see the scorer's
   * decay logic). New observations land in fresh, timestamped buckets.
   */
  private currentBucket(prof: PrincipalBehaviorProfile, nowMs: number): BehaviorBucket {
    if (!Array.isArray(prof.buckets)) prof.buckets = [];
    const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
    const start = Math.floor(ms / this.bucketMs) * this.bucketMs;
    let bucket = prof.buckets.find((b) => b.startMs === start);
    if (!bucket) {
      bucket = emptyBucket(start);
      prof.buckets.push(bucket);
      prof.buckets.sort((a, b) => a.startMs - b.startMs);
      // Prune oldest buckets beyond the retention bound (file-growth guard).
      if (prof.buckets.length > this.maxBuckets) {
        prof.buckets.splice(0, prof.buckets.length - this.maxBuckets);
      }
    }
    return bucket;
  }

  /** The current baseline for a principal, or undefined if none recorded yet. */
  profileFor(slackUserId: string | undefined): PrincipalBehaviorProfile | undefined {
    if (!slackUserId || !isSafeKey(slackUserId)) return undefined;
    try {
      return this.readAll()[slackUserId];
    } catch {
      return undefined;
    }
  }

  /** All profiles (for the read route / inspection). */
  all(): Record<string, PrincipalBehaviorProfile> {
    try {
      return this.readAll();
    } catch {
      return {};
    }
  }

  private readAll(): Record<string, PrincipalBehaviorProfile> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, PrincipalBehaviorProfile>;
    } catch {
      return {};
    }
  }

  private writeAll(all: Record<string, PrincipalBehaviorProfile>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Atomic-ish write: temp + rename so a crash can't truncate the baseline file.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}

// ── Derived baseline metrics (pure helpers; used by the scorer + tests) ──────────

/** Mean message length, or undefined when there is no data. */
export function meanLength(prof: PrincipalBehaviorProfile): number | undefined {
  return prof.interactionCount > 0 ? prof.lengthSum / prof.interactionCount : undefined;
}

/** Population standard deviation of message length, or undefined when <2 samples. */
export function stdLength(prof: PrincipalBehaviorProfile): number | undefined {
  if (prof.interactionCount < 2) return undefined;
  const mean = prof.lengthSum / prof.interactionCount;
  const variance = prof.lengthSqSum / prof.interactionCount - mean * mean;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/** Fraction of baseline interactions in a given hour (0..1). */
export function hourFraction(prof: PrincipalBehaviorProfile, hour: number): number {
  if (prof.interactionCount <= 0) return 0;
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  return (prof.hourCounts[h] ?? 0) / prof.interactionCount;
}

/** Baseline calendar age in milliseconds (now − firstSeen), or 0 when unknown. */
export function baselineAgeMs(prof: PrincipalBehaviorProfile, nowMs: number): number {
  const first = Date.parse(prof.firstSeen);
  if (!Number.isFinite(first) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, nowMs - first);
}

// ── Recency / decay weighting (poisoning-resistance #2) ──────────────────────────
// A RECENT burst of attacker-controlled observations must not durably dominate the
// histogram, while genuine long-standing behavior keeps weight. We sum the per-bucket
// counts weighted by an exponential decay on bucket AGE (newer buckets weigh ~1.0,
// older buckets fade with a configurable half-life). The "legacy" cumulative counts on
// a pre-hardening profile (no buckets, or counts that predate bucketing) are treated as
// an UN-decayable established base — they keep full weight, so an existing baseline
// degrades gracefully and old long-standing behavior is never erased.

/**
 * The decayed-effective SHAPE view a scorer should read instead of raw cumulative
 * counts. Same fields as the profile, but every count is the decay-weighted sum across
 * buckets PLUS the legacy (pre-bucketing) base at full weight.
 */
export interface DecayedProfileView {
  effectiveCount: number;
  actionCounts: Record<string, number>;
  tierCounts: number[];
  hourCounts: number[];
  lengthSum: number;
  lengthSqSum: number;
  urgentCount: number;
}

export interface DecayOptions {
  /** Now (epoch ms) — drives bucket age. */
  nowMs: number;
  /** One bucket window length (ms). Must match the store's bucketMs. */
  bucketMs: number;
  /** Decay half-life in bucket-windows. Default 30 (≈30 days at a 1-day bucket). */
  halfLifeWindows?: number;
}

/**
 * Compute the decay-weighted effective baseline. The legacy base = cumulative totals
 * MINUS the sum of all buckets (i.e. the part of history that predates bucketing). That
 * base keeps full weight (weight 1.0); each bucket is weighted by 0.5^(ageWindows/halfLife).
 *
 * A profile with no buckets → its entire cumulative form is the legacy base at full
 * weight → the decayed view equals the cumulative view (perfect backward-compat). A
 * fully-bucketed profile decays purely on bucket age.
 */
export function decayedView(prof: PrincipalBehaviorProfile, opts: DecayOptions): DecayedProfileView {
  const halfLife = opts.halfLifeWindows && opts.halfLifeWindows > 0 ? opts.halfLifeWindows : 30;
  const bucketMs = opts.bucketMs && opts.bucketMs > 0 ? opts.bucketMs : DEFAULT_BUCKET_MS;
  const buckets = Array.isArray(prof.buckets) ? prof.buckets : [];

  const view: DecayedProfileView = {
    effectiveCount: 0,
    actionCounts: {},
    tierCounts: [0, 0, 0, 0, 0],
    hourCounts: new Array(24).fill(0),
    lengthSum: 0,
    lengthSqSum: 0,
    urgentCount: 0,
  };

  // ── Legacy (pre-bucketing) base: cumulative totals minus what the buckets hold ──
  // Kept at full weight so old established behavior is never decayed away.
  const bucketedCount = buckets.reduce((s, b) => s + b.count, 0);
  const legacyCount = Math.max(0, prof.interactionCount - bucketedCount);
  if (legacyCount > 0 && prof.interactionCount > 0) {
    // Reconstruct the legacy base by subtracting bucket sums from cumulative sums.
    const legacyActions: Record<string, number> = { ...prof.actionCounts };
    const legacyTiers = prof.tierCounts.slice();
    const legacyHours = prof.hourCounts.slice();
    let legacyLenSum = prof.lengthSum;
    let legacyLenSq = prof.lengthSqSum;
    let legacyUrgent = prof.urgentCount;
    for (const b of buckets) {
      for (const [a, c] of Object.entries(b.actionCounts)) {
        legacyActions[a] = (legacyActions[a] ?? 0) - c;
      }
      for (let t = 0; t < 5; t++) legacyTiers[t] = (legacyTiers[t] ?? 0) - (b.tierCounts[t] ?? 0);
      for (let h = 0; h < 24; h++) legacyHours[h] = (legacyHours[h] ?? 0) - (b.hourCounts[h] ?? 0);
      legacyLenSum -= b.lengthSum;
      legacyLenSq -= b.lengthSqSum;
      legacyUrgent -= b.urgentCount;
    }
    accumulate(view, 1.0, {
      count: legacyCount,
      actionCounts: legacyActions,
      tierCounts: legacyTiers,
      hourCounts: legacyHours,
      lengthSum: Math.max(0, legacyLenSum),
      lengthSqSum: Math.max(0, legacyLenSq),
      urgentCount: Math.max(0, legacyUrgent),
      startMs: 0,
    });
  }

  // ── Decayed buckets ──
  for (const b of buckets) {
    const ageWindows = Math.max(0, (opts.nowMs - b.startMs) / bucketMs);
    const weight = Math.pow(0.5, ageWindows / halfLife);
    accumulate(view, weight, b);
  }

  return view;
}

function accumulate(view: DecayedProfileView, weight: number, b: BehaviorBucket): void {
  view.effectiveCount += b.count * weight;
  for (const [a, c] of Object.entries(b.actionCounts)) {
    if (c > 0) view.actionCounts[a] = (view.actionCounts[a] ?? 0) + c * weight;
  }
  for (let t = 0; t < 5; t++) view.tierCounts[t] += (b.tierCounts[t] ?? 0) * weight;
  for (let h = 0; h < 24; h++) view.hourCounts[h] += (b.hourCounts[h] ?? 0) * weight;
  view.lengthSum += b.lengthSum * weight;
  view.lengthSqSum += b.lengthSqSum * weight;
  view.urgentCount += b.urgentCount * weight;
}

/** Mean message length from a decayed view, or undefined when there is no weight. */
export function decayedMeanLength(view: DecayedProfileView): number | undefined {
  return view.effectiveCount > 0 ? view.lengthSum / view.effectiveCount : undefined;
}

/** Population std of message length from a decayed view, or undefined when <2 effective. */
export function decayedStdLength(view: DecayedProfileView): number | undefined {
  if (view.effectiveCount < 2) return undefined;
  const mean = view.lengthSum / view.effectiveCount;
  const variance = view.lengthSqSum / view.effectiveCount - mean * mean;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/** Fraction of decayed interactions in a given hour (0..1). */
export function decayedHourFraction(view: DecayedProfileView, hour: number): number {
  if (view.effectiveCount <= 0) return 0;
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  return (view.hourCounts[h] ?? 0) / view.effectiveCount;
}

// ── Bridge to the simpler BaselineProvider interface ─────────────────────────────
// Lets the existing HeuristicAnomalyScorer (which speaks `PrincipalBaseline`) read the
// durable store instead of staying inert with no baselines. The richer signals live in
// RelationshipAnomalyScorer; this bridge keeps the placeholder scorer wired-and-real.

import type { BaselineProvider, PrincipalBaseline } from './AnomalyScorer.js';
import type { Principal } from './types.js';

export class StoreBaselineProvider implements BaselineProvider {
  constructor(private readonly store: RelationshipBehaviorStore) {}

  baselineFor(principal: Principal): PrincipalBaseline | undefined {
    const prof = this.store.profileFor(principal.slackUserId);
    if (!prof) return undefined;
    return {
      typicalActions: Object.keys(prof.actionCounts),
      interactionCount: prof.interactionCount,
    };
  }
}
