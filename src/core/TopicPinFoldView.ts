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
  /** Optional observed pool-relative physical-time floor (heartbeat median). */
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
      const poolReference = this.d.poolReference?.();
      const received = clock.receive(hlc, poolReference !== undefined ? { poolReference } : {});
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
  } {
    let quarantined = 0;
    try { quarantined = this.d.quarantine.all().length; } catch { /* best-effort */ }
    return {
      lastFoldAt: this.lastFoldAtMs ? new Date(this.lastFoldAtMs).toISOString() : null,
      totalFolds: this.totalFolds,
      lastScannedBytes: this.lastScannedBytes,
      recordKeys: this.winners.size,
      truncationEpisodeOpen: this.truncationEpisodeOpen,
      quarantined,
    };
  }
}
