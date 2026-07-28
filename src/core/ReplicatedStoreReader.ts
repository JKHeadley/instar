/**
 * ReplicatedStoreReader — the LOWEST store-access primitive, the single funnel
 * every replicated-store read routes through so no caller can bypass the
 * no-clobber union rule (WS2 replicated-store foundation, Component 6 / §7.2).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §7.1 (namespaced
 * per-origin storage), §7.2 (the union of local + replicated state computed at the
 * LOWEST primitive — enforced by a wiring-integrity test, §12 #11), §7.4 (a
 * dropped origin is excluded from the union LIVE), §11 (machine-local-by-design:
 * computed from the local own + local replica namespaces, no cross-machine call
 * on the read path).
 *
 * THE BYPASS-PROOF FUNNEL. A store's materialized replicated state is the UNION
 * over every participating origin namespace: the own stream + each non-dropped
 * peer replica. This reader is the ONE place that composes that union (via
 * UnionReader.readUnion) — a consumer store reads THROUGH it, never around it. The
 * wiring-integrity test asserts the reader's seams are dependency-injected and not
 * null / not no-ops.
 *
 * PURE-ish: all I/O is the injected `loadOriginRecords` seam (the real wiring reads
 * the CoherenceJournal own stream + the peers/ replica streams for the store's
 * kind(s)). The reader itself only composes + merges + records conflicts —
 * bounded, no fs, no Date directly.
 */

import type { ReplicatedKindRegistry } from './ReplicatedRecordEnvelope.js';
import {
  readUnion,
  type ImpactTier,
  type OriginRecord,
  type UnionResult,
} from './UnionReader.js';
import type { ConflictStore } from './ConflictStore.js';
import type { DroppedOriginRegistry } from './RollbackUnmerge.js';
import type { StateSyncStores } from './ReplicatedRecordEnvelope.js';

/** The seams the reader needs (DI'd so the wiring-integrity test can assert they
 *  are real, never null/no-op). */
export interface ReplicatedStoreReaderSeams {
  /** The replicated-kind registry — the reader serves ONLY registered stores. */
  registry: ReplicatedKindRegistry;
  /** The per-store stateSync flags (a store read is a no-op when its store is not
   *  enabled — the dark-by-default posture). */
  stores: StateSyncStores | undefined;
  /** The store's impact tier (high/low) — governs concurrent-edit behavior. A
   *  store declares its tier at registration; the default is HIGH (the
   *  conservative side — append-both-and-flag never silently clobbers). */
  tierOf: (store: string) => ImpactTier;
  /**
   * Load EVERY origin's current record for (store, recordKey) — the own stream +
   * each peer replica namespace, keyed by origin (one record per origin, the
   * latest by HLC). This is the per-origin materialization the union merges. The
   * real wiring reads the CoherenceJournal own stream + the peers/ replica files
   * for the store's kind(s); a single-machine install returns only the own
   * origin (so the union is a strict no-op = that one record).
   */
  loadOriginRecords: (store: string, recordKey: string) => OriginRecord[];
  /** Enumerate every recordKey the store currently holds across all origins (for
   *  readAll). The real wiring scans the own + replica streams. */
  listRecordKeys: (store: string) => string[];
  /** The durable un-merged (store, origin) set — a dropped origin is excluded
   *  from the union LIVE (§7.4). */
  droppedOrigins: DroppedOriginRegistry;
  /** The conflict ledger — a HIGH-impact concurrent divergence is recorded here
   *  (idempotent on the stable conflictId). */
  conflictStore: ConflictStore;
}

// RULE 3: EXEMPT — this is NOT a state-detector. ReplicatedStoreReader is a
// pure store-access funnel that composes the no-clobber union over already-loaded
// per-origin records (via the injected loadOriginRecords seam). It does not parse
// provider/CLI output, does not detect external/environment state, and has no
// signature-matching that could drift across providers — it merely merges
// in-memory records by HLC + the witness rule. The "*Reader" name matches the
// Rule-3 pattern heuristic but the substance is a deterministic in-memory merge.
export class ReplicatedStoreReader {
  private readonly seams: ReplicatedStoreReaderSeams;

  constructor(seams: ReplicatedStoreReaderSeams) {
    // Wiring-integrity preconditions (§12 #11): the seams MUST be real, not null.
    if (!seams) throw new Error('ReplicatedStoreReader: seams are required');
    if (!seams.registry) throw new Error('ReplicatedStoreReader: registry seam is required (not null)');
    if (typeof seams.loadOriginRecords !== 'function') throw new Error('ReplicatedStoreReader: loadOriginRecords seam must be a function (not a no-op)');
    if (typeof seams.listRecordKeys !== 'function') throw new Error('ReplicatedStoreReader: listRecordKeys seam must be a function (not a no-op)');
    if (!seams.droppedOrigins) throw new Error('ReplicatedStoreReader: droppedOrigins seam is required (not null)');
    if (!seams.conflictStore) throw new Error('ReplicatedStoreReader: conflictStore seam is required (not null)');
    if (typeof seams.tierOf !== 'function') throw new Error('ReplicatedStoreReader: tierOf seam must be a function');
    this.seams = seams;
  }

  /** Is this store registered + enabled (so a read is non-dark)? A read on an
   *  unregistered or disabled store returns a strict no-op (no record). */
  private isLive(store: string): boolean {
    if (!this.seams.registry.getByStore(store)) return false;
    return this.seams.stores?.[store]?.enabled === true;
  }

  /**
   * Read one recordKey through the union (§7.2). Returns the no-clobber union
   * result: the resolved value, a conflict descriptor (HIGH-impact concurrent),
   * or a divergence flag (LOW-impact concurrent). A HIGH-impact conflict is
   * RECORDED in the conflict ledger (idempotent) as a side-effect so it is
   * surfaced for operator resolution — the read NEVER clobbers a divergent record.
   *
   * Live-recompute (§7.4): the dropped-origin set is consulted HERE, so a
   * rolled-back origin is excluded from the union instantly with no rewrite.
   */
  read(store: string, recordKey: string): UnionResult {
    if (!this.isLive(store)) {
      return { recordKey, value: null, conflict: null, divergenceFlag: false };
    }
    const dropped = this.seams.droppedOrigins.droppedOrigins(store);
    const all = this.seams.loadOriginRecords(store, recordKey);
    // §7.4 LIVE exclusion: drop any rolled-back origin from the participating set.
    const participating = dropped.size === 0 ? all : all.filter((r) => !dropped.has(r.origin));
    const result = readUnion(recordKey, participating, this.seams.tierOf(store));
    if (result.conflict) {
      // Record the HIGH-impact conflict (idempotent on its stable id; raises ONE
      // deduped attention item). The read returns value=null (neither version
      // clobbers) — the operator resolves it.
      this.seams.conflictStore.recordConflict(store, result.conflict);
    }
    return result;
  }

  /** Read every recordKey the store holds, as a recordKey → UnionResult map (§7.2).
   *  Conflicts are recorded as a side-effect (same as read). Bounded by the live
   *  key count. */
  readAll(store: string): Map<string, UnionResult> {
    const out = new Map<string, UnionResult>();
    if (!this.isLive(store)) return out;
    for (const recordKey of this.seams.listRecordKeys(store)) {
      out.set(recordKey, this.read(store, recordKey));
    }
    return out;
  }
}
