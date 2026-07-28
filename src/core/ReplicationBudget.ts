/**
 * ReplicationBudget — Component 7 bounds (WS2 replicated-store foundation, §8 +
 * §8.1 Phase C).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §8 (per-store /
 * per-record-class bounds, replication rate cap with COALESCING, the AGGREGATE
 * journal budget that caps TOTAL bytes/sec across ALL kinds with proportional
 * fair-share throttle, the sustained-failure breaker, the dark-peer accumulation
 * bound + tombstone horizon forced full-snapshot re-join), §8.1 (Phase C: budgets
 * = per-peer allowance × live online-peer count, hard pool-wide ceiling,
 * hysteresis on the multiplier — NOT a 2-machine constant).
 *
 * PURE-ish: the clock is injected so the token buckets + hysteresis are
 * unit-testable across simulated windows. No fs, no Date directly, no network.
 *
 * The ANTI-STARVATION invariant (§8): a flood on kind A must NOT consume kind B's
 * replication share. The aggregate budget caps total bytes/sec; when pressured,
 * per-kind caps throttle PROPORTIONALLY (fair-share) and the throttle is SURFACED
 * in degradation (never a silent stall). A test enforces the budget ACROSS kinds.
 */

import { HybridLogicalClock, type HlcTimestamp } from './HybridLogicalClock.js';
import type { KindRetention, RateCapConfig } from './CoherenceJournal.js';

// ───────────────────────────────────────────────────────────────────────────
// Per-kind bounds defaults (§8) — extended per replicated kind
// ───────────────────────────────────────────────────────────────────────────

/**
 * The per-replicated-kind bounds a concrete store (WS2.1+) ships when it
 * registers its kind (§8): a `retention` window (maxFileBytes + rotateKeep) AND a
 * token-bucket rate cap. The foundation provides the SHAPE + conservative
 * defaults; a store overrides per kind. These extend the journal's existing
 * DEFAULT_RETENTION / DEFAULT_RATE_CAP machinery — same types, applied to the
 * replicated kind's own stream.
 */
export interface ReplicatedKindBounds {
  retention: KindRetention;
  rateCap: RateCapConfig;
}

/** Conservative default bounds for a replicated kind that does not override them.
 *  A high-write store (preferences) should ship a tighter window; this is the
 *  bounded fallback so a kind is NEVER unbounded. */
export const DEFAULT_REPLICATED_KIND_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 8 * 1024 * 1024, rotateKeep: 4 },
  rateCap: { capacity: 100, refillPerSec: 50 },
};

// ───────────────────────────────────────────────────────────────────────────
// Coalescing replicator (§8 — replicate the LATEST state per recordKey/interval)
// ───────────────────────────────────────────────────────────────────────────

/** One coalesced pending replication: the LATEST record for a recordKey within
 *  the current interval (a burst on one key collapses to one record). */
export interface CoalescedRecord {
  recordKey: string;
  /** The opaque serialized record line (the journal entry to replicate). */
  line: string;
  /** Bytes the line would consume (for the budget accounting). */
  bytes: number;
  /** The HLC of the latest record (for last-wins coalescing within the interval). */
  hlc: HlcTimestamp;
}

/**
 * CoalescingReplicator — collapses a burst of edits to one recordKey into ONE
 * replicated record per interval (§8 coalescing). `stage(recordKey, line, bytes,
 * hlc)` keeps only the HLC-LATEST per key; `drain()` emits the coalesced set and
 * clears the buffer for the next interval. Per replicated kind (one instance per
 * kind), so a chatty kind cannot starve another — the aggregate budget below is
 * the cross-kind guard.
 */
export class CoalescingReplicator {
  private pending = new Map<string, CoalescedRecord>();

  /** Stage a write; keeps only the HLC-latest per recordKey within the interval. */
  stage(recordKey: string, line: string, bytes: number, hlc: HlcTimestamp): void {
    const prev = this.pending.get(recordKey);
    if (prev && HybridLogicalClock.compare(hlc, prev.hlc) <= 0) return; // older or equal — keep the newer.
    this.pending.set(recordKey, { recordKey, line, bytes, hlc });
  }

  /** The number of distinct keys currently coalesced (for observability). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** The total bytes the coalesced set would replicate this interval. */
  pendingBytes(): number {
    let n = 0;
    for (const r of this.pending.values()) n += r.bytes;
    return n;
  }

  /** Emit + clear the coalesced set (the LATEST per key). */
  drain(): CoalescedRecord[] {
    const out = [...this.pending.values()];
    this.pending.clear();
    return out;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Phase-C budget scaling (§8.1) — per-peer allowance × online-peer count
// ───────────────────────────────────────────────────────────────────────────

/** Phase-C budget config (§8.1). */
export interface PhaseCBudgetConfig {
  /** Per-peer byte allowance (the unit scaled by online-peer count). */
  perPeerBytes: number;
  /** Hard pool-wide ceiling — the scaled budget is clamped here (protects a single
   *  machine's disk/CPU regardless of pool size). */
  hardCeilingBytes: number;
  /** Hysteresis: the effective online-peer MULTIPLIER only RISES after the higher
   *  peer count has been observed for `hysteresisRiseMs`; it falls immediately
   *  (shrinking the budget on a real peer loss is the safe direction). A transient
   *  peer-count SPIKE does not instantly widen the budget. */
  hysteresisRiseMs: number;
}

/**
 * Compute the Phase-C aggregate budget (§8.1): `min(perPeerBytes ×
 * effectivePeerCount, hardCeilingBytes)`. NOT a 2-machine constant — a 5-machine
 * pool gets a proportionally larger budget, bounded by the hard ceiling.
 *
 * The `effectivePeerCount` is the HYSTERESIS-damped online count (computed by
 * PhaseCBudgetController below); this pure helper just applies the formula so it
 * is independently testable.
 */
export function phaseCBudget(perPeerBytes: number, effectivePeerCount: number, hardCeilingBytes: number): number {
  const scaled = perPeerBytes * Math.max(0, effectivePeerCount);
  return Math.min(scaled, hardCeilingBytes);
}

/**
 * PhaseCBudgetController — tracks the live online-peer count with hysteresis on
 * the multiplier (§8.1). A RISE in peer count only takes effect after it has held
 * for `hysteresisRiseMs` (a transient spike does not widen the budget); a FALL
 * takes effect immediately (shrink-on-loss is safe). `currentBudget()` returns the
 * live aggregate byte budget.
 */
export class PhaseCBudgetController {
  private readonly cfg: PhaseCBudgetConfig;
  private readonly now: () => number;
  private effectivePeerCount = 0;
  /** Seeded on the first observation — there is no prior narrower budget to
   *  protect at bootstrap, so the first count takes effect immediately; only a
   *  SUBSEQUENT rise is hysteresis-gated. */
  private seeded = false;
  /** A pending higher count + when it was first observed (for the rise hysteresis). */
  private pendingRise: { count: number; since: number } | null = null;

  constructor(cfg: PhaseCBudgetConfig, now: () => number) {
    this.cfg = cfg;
    this.now = now;
  }

  /** Feed the live online-peer count (from the capacity heartbeat). Applies the
   *  rise-hysteresis / immediate-fall policy and returns the effective count. */
  observePeerCount(online: number): number {
    const t = this.now();
    // First observation seeds the baseline immediately (no prior budget to widen).
    if (!this.seeded) {
      this.seeded = true;
      this.effectivePeerCount = online;
      return this.effectivePeerCount;
    }
    if (online < this.effectivePeerCount) {
      // Immediate fall — shrinking the budget on a real peer loss is safe.
      this.effectivePeerCount = online;
      this.pendingRise = null;
      return this.effectivePeerCount;
    }
    if (online === this.effectivePeerCount) {
      this.pendingRise = null;
      return this.effectivePeerCount;
    }
    // online > effective — gate the rise behind hysteresis.
    if (!this.pendingRise || this.pendingRise.count !== online) {
      this.pendingRise = { count: online, since: t };
      return this.effectivePeerCount;
    }
    if (t - this.pendingRise.since >= this.cfg.hysteresisRiseMs) {
      this.effectivePeerCount = online;
      this.pendingRise = null;
    }
    return this.effectivePeerCount;
  }

  /** The current effective (hysteresis-damped) online-peer count. */
  getEffectivePeerCount(): number {
    return this.effectivePeerCount;
  }

  /** The current aggregate byte budget (§8.1). */
  currentBudget(): number {
    return phaseCBudget(this.cfg.perPeerBytes, this.effectivePeerCount, this.cfg.hardCeilingBytes);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Aggregate journal budget (§8) — fair-share cross-kind throttle
// ───────────────────────────────────────────────────────────────────────────

/** A per-kind throttle verdict (§8). When the aggregate budget is pressured, each
 *  kind's allowance is its FAIR SHARE of the budget; an over-share request is
 *  throttled (deferred to the next interval) and the throttle is surfaced. */
export interface AggregateThrottleResult {
  /** The bytes admitted this interval for the kind. */
  admittedBytes: number;
  /** The bytes deferred (throttled) — coalesced to the next interval, never dropped. */
  throttledBytes: number;
  /** True iff this kind was throttled (surfaced in degradation; never silent). */
  throttled: boolean;
}

/** Degradation surface for the aggregate budget (§8 — never a silent stall). */
export interface AggregateBudgetDegradation {
  /** Intervals in which at least one kind was throttled. */
  throttledIntervals: number;
  /** Total bytes deferred across all kinds (cumulative). */
  totalThrottledBytes: number;
  /** Per-kind cumulative throttled bytes (so a starving kind is visible). */
  perKindThrottledBytes: Record<string, number>;
}

/**
 * AggregateJournalBudget — the cross-kind anti-starvation guard (§8). Each
 * interval, the controller admits each kind's pending bytes up to its FAIR SHARE
 * of the live aggregate budget; an over-share request is throttled (the surplus
 * defers to the next interval, never dropped — coalescing already collapsed it to
 * the latest state). The fair share is `budget / activeKindCount`, with UNUSED
 * share from quiet kinds redistributed to the others (so a single chatty kind on
 * an otherwise-idle pool still gets the whole budget — fair, not wasteful), but
 * NEVER beyond a kind's own pending demand and never letting one kind exceed the
 * aggregate while another has unserved demand.
 *
 * The §12 #9/#15 invariant: a flood on kind A is capped at its fair share when
 * kind B also has demand — B keeps its share; A's surplus is deferred + surfaced.
 */
export class AggregateJournalBudget {
  private readonly degradation: AggregateBudgetDegradation = {
    throttledIntervals: 0,
    totalThrottledBytes: 0,
    perKindThrottledBytes: {},
  };

  /**
   * Allocate the live aggregate `budgetBytes` across the kinds' pending demands
   * for ONE interval. Returns per-kind throttle verdicts. Fair-share with
   * redistribution of unused share, bounded by each kind's demand and the
   * aggregate.
   */
  allocate(budgetBytes: number, demand: Record<string, number>): Record<string, AggregateThrottleResult> {
    const kinds = Object.keys(demand).filter((k) => demand[k] > 0);
    const out: Record<string, AggregateThrottleResult> = {};
    for (const k of Object.keys(demand)) {
      out[k] = { admittedBytes: 0, throttledBytes: 0, throttled: false };
    }
    if (kinds.length === 0 || budgetBytes <= 0) {
      // Everything is throttled if there is demand but no budget.
      let anyThrottled = false;
      for (const k of kinds) {
        out[k] = { admittedBytes: 0, throttledBytes: demand[k], throttled: true };
        this.degradation.perKindThrottledBytes[k] = (this.degradation.perKindThrottledBytes[k] ?? 0) + demand[k];
        this.degradation.totalThrottledBytes += demand[k];
        anyThrottled = true;
      }
      if (anyThrottled) this.degradation.throttledIntervals++;
      return out;
    }

    // Iterative fair-share with redistribution: repeatedly hand each
    // not-yet-satisfied kind an EQUAL slice of the remaining budget, capping at its
    // remaining demand; surplus from a kind that fit under its slice spills to the
    // others. Bounded by kinds.length iterations (each pass satisfies ≥1 kind or
    // exhausts the budget). This guarantees no kind exceeds the aggregate while
    // another has unserved demand (the anti-starvation invariant).
    let remainingBudget = budgetBytes;
    const remainingDemand = new Map<string, number>(kinds.map((k) => [k, demand[k]]));
    let active = [...kinds];
    let guard = active.length + 1;
    while (active.length > 0 && remainingBudget > 0 && guard-- > 0) {
      const share = remainingBudget / active.length;
      const stillActive: string[] = [];
      for (const k of active) {
        const want = remainingDemand.get(k)!;
        const grant = Math.min(want, share);
        out[k].admittedBytes += grant;
        remainingDemand.set(k, want - grant);
        remainingBudget -= grant;
        if (want - grant > 0) stillActive.push(k); // still has demand under its share.
      }
      // If no progress was possible (every active kind already at its share), stop.
      if (stillActive.length === active.length && share <= 0) break;
      active = stillActive;
    }

    let anyThrottled = false;
    for (const k of kinds) {
      const left = remainingDemand.get(k) ?? 0;
      if (left > 0) {
        out[k].throttledBytes = left;
        out[k].throttled = true;
        this.degradation.perKindThrottledBytes[k] = (this.degradation.perKindThrottledBytes[k] ?? 0) + left;
        this.degradation.totalThrottledBytes += left;
        anyThrottled = true;
      }
    }
    if (anyThrottled) this.degradation.throttledIntervals++;
    return out;
  }

  /** The cumulative degradation surface (§8 — surfaced, never a silent stall). */
  getDegradation(): AggregateBudgetDegradation {
    return {
      throttledIntervals: this.degradation.throttledIntervals,
      totalThrottledBytes: this.degradation.totalThrottledBytes,
      perKindThrottledBytes: { ...this.degradation.perKindThrottledBytes },
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tombstone-horizon guard (§8 — forced full-snapshot re-join, §12 #13)
// ───────────────────────────────────────────────────────────────────────────

/** The re-join verdict for a recovering dark peer (§8). */
export type RejoinVerdict =
  | { mode: 'tail'; fromSeq: number }
  | { mode: 'full-snapshot'; reason: 'beyond-tombstone-horizon' | 'below-oldest-retained' };

/**
 * Decide how a recovering peer re-joins a kind's stream (§8 dark-peer accumulation
 * bound + tombstone horizon). If the peer's last-held seq is below the holder's
 * `oldestRetainedSeq` (the tombstone for a delete may have rotated out), a stale
 * tail would risk delete-resurrection — so the peer is FORCED to a full
 * single-origin snapshot re-join (§6.5 delete-resurrection guard). Otherwise a
 * normal seq tail from `lastHeldSeq` is safe.
 *
 * PURE: a function of the seqs — independently testable (§12 #13).
 */
export function rejoinVerdict(lastHeldSeq: number, oldestRetainedSeq: number): RejoinVerdict {
  // The peer's next-needed seq has rotated out of the holder's retained window ⇒
  // a tail would skip the gap (incl. possibly a delete tombstone) ⇒ force a full
  // snapshot re-join (the delete-resurrection guard).
  if (lastHeldSeq + 1 < oldestRetainedSeq) {
    return { mode: 'full-snapshot', reason: 'below-oldest-retained' };
  }
  return { mode: 'tail', fromSeq: lastHeldSeq };
}
