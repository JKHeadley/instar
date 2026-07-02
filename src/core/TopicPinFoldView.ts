/**
 * TopicPinFoldView — the STATEFUL answer-complete advisory-pin read
 * (U4.1 §2C, docs/specs/u4-1-pin-persistence.md; R-r2-3 / R-r2-1 / R-r3-1 /
 * R-r3-2).
 *
 * Replaces the `query({ kind: 'topic-pin-record', limit: 2000 })` newest-tail
 * read (silently clamped to 500 by `READER_MAX_LIMIT`) with:
 *
 *  1. A BOOT-TIME FULL-STREAM FOLD over every retained `topic-pin-record`
 *     entry — active file + archives, own stream AND every peer-replica
 *     stream — into a per-key latest map by HLC (tombstone-respecting: a
 *     winning delete stays in the map so a late-arriving OLDER put can never
 *     resurrect the pin).
 *  2. An INCREMENTAL OFFSET-TRACKED TAIL after boot: each refresh re-scans
 *     only appended bytes (TokenLedgerPoller pattern); an unchanged journal
 *     costs zero re-read; re-scans are idempotent (same records → same
 *     winners).
 *  3. The HLC SKEW GATE (fixes defect 6; R-r2-1): every record HLC passes
 *     through the existing `HybridLogicalClock.receive()` contract (clamped
 *     maxDriftMs). A future-skewed record is REJECTED FROM THE FOLD — never
 *     merged, never able to win `compareHlc` — and quarantined STICKILY +
 *     DURABLY via TopicPinSkewQuarantine (R-r3-2: the moving wall-clock
 *     reference must never silently un-quarantine it). The fold-side gate is
 *     the SOLE skew-exclusion authority (R-r3-1) — the JournalSyncApplier
 *     deliberately ACCEPTS-AND-PERSISTS a skewed record, because its only
 *     per-entry refusal path would suspect-halt the peer's ENTIRE stream.
 *  4. The FOLD BYTE-GUARD (`ws13FoldMaxBytes`, R-r3-3): on breach the fold
 *     reads newest-first up to the budget and LOUDLY escalates (ONE deduped
 *     `u41:pin-fold-truncated` item naming the unfolded ranges) — never a
 *     silent truncation. The episode closes when a full fold completes
 *     within budget.
 *
 * Read-only over journal bytes; it actuates NOTHING (consumers are wired via
 * server.ts closures exactly like the old tail read — the actuation-ban lint
 * posture is unchanged).
 */

import { HybridLogicalClock, coerceHlc, type HlcTimestamp } from './HybridLogicalClock.js';
import { compareHlc, isValidPinMachineId, type MergedReplicatedPin } from './TopicPinReplicatedStore.js';
import type { PinFoldOffsets, PinFoldResult } from './CoherenceJournalReader.js';
import type { TopicPinSkewQuarantine } from './TopicPinSkewQuarantine.js';
import type { TopicPlacement } from './PlacementExecutor.js';

/**
 * The pool-relative physical-time floor for the skew gate (foundation spec
 * §3.4; fb-1d51e996-0a3): `max(now, freshest clock-OK peer heartbeat
 * self-stamp)`. `receive()` deliberately never consults `now()` itself — its
 * reference is `max(last.physical, poolReference)` — so the CALLER must supply
 * a floor that MOVES with wall time. Without one, a quiet fold clock's
 * `last.physical` freezes at its construction seed (server boot) and every
 * honest record authored more than `maxDriftMs` later is falsely quarantined
 * as "skew-ahead" — STICKILY, by design. Pins are rare operator events, so the
 * pin stream is almost always quiet: the frozen reference killed pin
 * replication between long-running servers (live-reproduced 2026-07-02).
 *
 * Pool-relative, per §3.4: a receiver whose own NTP lags must not quarantine a
 * legitimately-ahead peer, so the freshest self-reported heartbeat stamp of
 * each clock-OK peer raises the floor above a slow local `now()`. A peer whose
 * clock the registry's skew FSM already distrusts (`clockSkewStatus !== 'ok'`)
 * NEVER raises the floor — a suspect clock must not widen the acceptance
 * window. `now()` participates only as a FLOOR inside the max (§3.4 forbids
 * the BARE local now() AS the reference — a floor can only raise the
 * reference, never cause a false rejection). Degenerate case (single machine /
 * no peers): `now()` alone — the pool is self.
 */
export function poolReferenceFromCapacities(
  nowMs: number,
  capacities: Array<{ clockSkewStatus?: string; selfReportedLastSeen?: string }>,
): number {
  let ref = nowMs;
  for (const c of capacities) {
    if (c.clockSkewStatus !== 'ok') continue; // a suspect clock never raises the floor
    const t = c.selfReportedLastSeen ? Date.parse(c.selfReportedLastSeen) : Number.NaN;
    if (Number.isFinite(t) && t > ref) ref = t;
  }
  return ref;
}

/** The reader seam (CoherenceJournalReader.foldPinRecords — injectable for tests). */
export interface PinFoldReader {
  foldPinRecords(opts: { priorOffsets?: PinFoldOffsets; maxBytes?: number }): PinFoldResult;
}

export interface TopicPinFoldViewDeps {
  reader: PinFoldReader;
  quarantine: TopicPinSkewQuarantine;
  /** This machine's mesh id (late-bound; used as the fold clock's node id). */
  selfNode: () => string | null;
  /** The clamped HLC drift ceiling (§2C reuses the existing knob — no new key). */
  maxDriftMs?: number;
  /** ws13FoldMaxBytes, read live (default 64MB upstream). */
  foldMaxBytes?: () => number;
  /** Observed pool-relative physical-time floor for the skew gate (§3.4 —
   *  `poolReferenceFromCapacities` in production). The fold ALWAYS floors the
   *  reference at its own `now()` regardless (fb-1d51e996-0a3: a missing dep
   *  must never re-freeze the reference at the fold clock's boot seed); this
   *  dep adds the pool-relative part (clock-OK peer heartbeat stamps) so a
   *  slow LOCAL clock doesn't falsely quarantine an ahead-but-honest peer. */
  poolReference?: () => number | undefined;
  now?: () => number;
  /** Fired ONCE per newly-quarantined record (upstream dedupes per-origin, P17). */
  onSkewQuarantined?: (rec: { key: string; hlc: HlcTimestamp; origin: string }) => void;
  /** Fired ONCE per truncation EPISODE (byte-guard breach) with the unfolded ranges. */
  onFoldTruncated?: (unfolded: Array<{ file: string; fromByte: number; toByte: number }>) => void;
  /** Fired when a full fold completes within budget after a breach (episode close). */
  onFoldRecovered?: () => void;
  log?: (msg: string) => void;
}

export class TopicPinFoldView {
  private readonly d: TopicPinFoldViewDeps;
  /** Per-key HLC winner (puts AND tombstones — tombstone-respecting by construction). */
  private readonly winners = new Map<string, { data: Record<string, unknown>; origin: string; hlc: HlcTimestamp }>();
  private offsets: PinFoldOffsets = {};
  private clock: HybridLogicalClock | null = null;
  private truncationEpisodeOpen = false;
  private lastFoldAtMs = 0;
  private lastScannedBytes = 0;
  private totalFolds = 0;

  constructor(deps: TopicPinFoldViewDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private foldClock(): HybridLogicalClock {
    if (!this.clock) {
      this.clock = new HybridLogicalClock({
        node: this.d.selfNode() ?? 'pin-fold',
        now: this.d.now ?? Date.now,
        ...(this.d.maxDriftMs !== undefined ? { maxDriftMs: this.d.maxDriftMs } : {}),
      });
    }
    return this.clock;
  }

  /**
   * Fold newly-appended journal bytes into the winner map. The FIRST call is
   * the boot-time full-stream fold (offsets start empty); later calls are the
   * incremental offset-tracked tail. Never throws (a fold fault leaves the
   * last-good map serving — the next refresh retries).
   */
  refresh(): void {
    let res: PinFoldResult;
    try {
      res = this.d.reader.foldPinRecords({
        priorOffsets: this.offsets,
        ...(this.d.foldMaxBytes ? { maxBytes: this.d.foldMaxBytes() } : {}),
      });
    } catch (err) {
      this.d.log?.(`[TopicPinFoldView] fold failed (serving last-good map): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.offsets = res.offsets;
    this.lastFoldAtMs = this.now();
    this.lastScannedBytes = res.scannedBytes;
    this.totalFolds++;

    const clock = this.foldClock();
    // fb-1d51e996-0a3 (§3.4): ONE moving, pool-relative reference per refresh.
    // receive()'s reference is max(last.physical, poolReference) and NEVER the
    // bare now() — so without this floor a quiet fold clock freezes at its
    // construction seed and falsely skew-quarantines (stickily) every honest
    // record authored > maxDriftMs later. now() is the floor; the wired dep
    // raises it with clock-OK peer heartbeat stamps (pool-relative). A faulty
    // dep degrades to the now() floor — never back to the frozen reference.
    let observedPool = 0;
    try { observedPool = this.d.poolReference?.() ?? 0; } catch { /* @silent-fallback-ok — the now() floor stands; a dep fault must not re-freeze the gate or fail the fold */ }
    const poolReference = Math.max(this.now(), Number.isFinite(observedPool) ? observedPool : 0);
    for (const entry of res.entries) {
      const recordKey = typeof entry.data.recordKey === 'string' ? entry.data.recordKey : null;
      if (recordKey === null) continue;
      let hlc: HlcTimestamp;
      try {
        hlc = coerceHlc(entry.data.hlc);
      } catch {
        continue; // malformed hlc — schema-reject class, never a winner
      }
      // Sticky exclusion FIRST (R-r3-2): a quarantined (key, hlc) stays excluded
      // regardless of clock progress — the moving receive() reference must never
      // silently re-admit it.
      if (this.d.quarantine.has(recordKey, hlc)) continue;
      // The skew gate (R-r2-1): the existing receive() contract. Rejection ⇒
      // durable quarantine + loud (deduped upstream) escalation; NEVER merged.
      const received = clock.receive(hlc, { poolReference });
      if (received.rejected) {
        const newlyAdded = this.d.quarantine.add({ key: recordKey, hlc, origin: entry.origin });
        if (newlyAdded) {
          this.d.log?.(`[TopicPinFoldView] skew-quarantined pin record key=${recordKey} origin=${entry.origin} (physical ${hlc.physical} > reference ${received.reference} + ${received.maxDriftMs}ms)`);
          try { this.d.onSkewQuarantined?.({ key: recordKey, hlc, origin: entry.origin }); } catch { /* escalation is observability — never gates the fold */ }
        }
        continue;
      }
      const cur = this.winners.get(recordKey);
      if (!cur || compareHlc(hlc, cur.hlc) > 0) {
        this.winners.set(recordKey, { data: entry.data, origin: entry.origin, hlc });
        // Honest supersession (R-r3-2): a newer honest record makes older
        // quarantined entries for the key dead by ordering — prune them.
        try { this.d.quarantine.pruneSuperseded(recordKey, hlc); } catch { /* prune is hygiene — never gates */ }
      }
    }

    // Byte-guard episode (R-r3-3): raise ONCE per episode; close on a clean full fold.
    if (res.truncated) {
      if (!this.truncationEpisodeOpen) {
        this.truncationEpisodeOpen = true;
        try { this.d.onFoldTruncated?.(res.unfolded); } catch { /* escalation never gates */ }
      }
    } else if (this.truncationEpisodeOpen) {
      this.truncationEpisodeOpen = false;
      try { this.d.onFoldRecovered?.(); } catch { /* episode close is observability */ }
    }
  }

  /**
   * The merged advisory pins (the §2C second pass — mirrors
   * `mergeUnionToPins`): a winning tombstone or `pinned:false` put yields NO
   * pin; a valid winning put yields one advisory pin carrying its HLC.
   */
  pins(): Map<number, MergedReplicatedPin> {
    const out = new Map<number, MergedReplicatedPin>();
    for (const [recordKey, w] of this.winners) {
      if (w.data.op === 'delete') continue;
      if (w.data.pinned !== true) continue;
      const topic = Number(recordKey);
      if (!Number.isFinite(topic)) continue;
      if (!isValidPinMachineId(w.data.preferredMachine)) continue;
      out.set(topic, { topic, preferredMachine: w.data.preferredMachine, pinned: true, origin: w.origin, hlc: w.hlc });
    }
    return out;
  }

  /** The fold pin as placement metadata for NEW placements (§2D seeding): the
   *  hard-pin path handles an offline target honestly (queued, never re-routed),
   *  so the pin is surfaced whenever a valid winner exists. */
  asTopicMetadata(sessionKey: string): TopicPlacement | undefined {
    const topic = Number(sessionKey);
    if (!Number.isFinite(topic)) return undefined;
    const pin = this.pins().get(topic);
    return pin ? { preferredMachine: pin.preferredMachine, pinned: true } : undefined;
  }

  /**
   * §2D placement seeding with the FULL local-vs-replicated resolution (the
   * N3 rule at the placement door): the LOCAL pin and the fold winner compare
   * by HLC — a stale local pin never masks a fresher replicated move-intent,
   * and a fresher replicated TOMBSTONE suppresses a stale local pin (the
   * defect-2 fix applied to NEW placements, not just the reconciler). A local
   * pin without an HLC uses the documented `updatedAt` fallback derivation.
   */
  effectiveTopicMetadata(
    sessionKey: string,
    local: { preferredMachine: string; pinned: boolean; updatedAt: string; hlc?: HlcTimestamp } | null,
  ): TopicPlacement | undefined {
    const localMeta: TopicPlacement | undefined = local
      ? { preferredMachine: local.preferredMachine, pinned: local.pinned }
      : undefined;
    const topic = Number(sessionKey);
    const winner = Number.isFinite(topic) ? this.winners.get(String(topic)) : undefined;
    if (!winner) return localMeta;
    const localHlc: HlcTimestamp | null = local
      ? (local.hlc ?? { physical: Date.parse(local.updatedAt) || 0, logical: 0, node: '' })
      : null;
    if (localHlc && compareHlc(localHlc, winner.hlc) >= 0) return localMeta; // local is newer-or-equal
    // The fold winner is newer: a tombstone / pinned:false resolves to NO pin
    // (a stale local pin must not resurrect a cleared one); a valid put wins.
    if (winner.data.op === 'delete' || winner.data.pinned !== true) return undefined;
    if (!isValidPinMachineId(winner.data.preferredMachine)) return localMeta;
    return { preferredMachine: winner.data.preferredMachine, pinned: true };
  }

  /**
   * Force the NEXT refresh to be a full-stream re-fold (offsets + winners
   * cleared). Used by the explicit per-record re-admission surface (R-r4-1):
   * a re-admitted record's bytes were already consumed by the incremental
   * tail, so only a full re-fold can bring it back into the comparison.
   */
  resetFold(): void {
    this.offsets = {};
    this.winners.clear();
  }

  /** Read-only observability (route/status surfaces). */
  status(): {
    lastFoldAt: string | null;
    totalFolds: number;
    lastScannedBytes: number;
    recordKeys: number;
    truncationEpisodeOpen: boolean;
    quarantined: number;
    skewReference: number;
  } {
    let quarantined = 0;
    try { quarantined = this.d.quarantine.all().length; } catch { /* best-effort */ }
    // The LIVE skew-gate floor a refresh would use right now (fb-1d51e996-0a3
    // diagnosability: a frozen reference is visible on GET /pool/pin-quarantine
    // instead of only in a quarantine log line after the damage).
    let skewReference = this.now();
    try {
      const observed = this.d.poolReference?.() ?? 0;
      if (Number.isFinite(observed) && observed > skewReference) skewReference = observed;
    } catch { /* @silent-fallback-ok — observability read; the now() floor stands */ }
    return {
      lastFoldAt: this.lastFoldAtMs ? new Date(this.lastFoldAtMs).toISOString() : null,
      totalFolds: this.totalFolds,
      lastScannedBytes: this.lastScannedBytes,
      recordKeys: this.winners.size,
      truncationEpisodeOpen: this.truncationEpisodeOpen,
      quarantined,
      skewReference,
    };
  }
}
