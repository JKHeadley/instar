/**
 * UnionReader — the no-clobber union merge rule + the SOUND last-writer-witness
 * concurrency detector (WS2 replicated-store foundation, Component 6 / build-order
 * step 4, §7.2).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §7.2 (the union
 * merge rule + the concurrency detector that closes BLOCKER-4), §9 (N-machine
 * convergence — a version SET, never N-choose-2 pairwise conflicts), §12 #5 (the
 * adversarial-clock err-direction invariant), §14 (the provable err-toward-flag
 * decision).
 *
 * PURE LOGIC. Imports ONLY the HLC primitive + node:crypto (for the stable
 * conflictId hash). No fs, no Date, no network. Every function is a pure function
 * of its inputs — so the load-bearing BLOCKER-4 detector is unit-testable against
 * an adversarial clock layout (§12 #5).
 *
 * THE BLOCKER-4 PRIMITIVE (the load-bearing reason this module exists). Plain
 * `HybridLogicalClock.compare` is a TOTAL order: it NEVER returns "concurrent",
 * so it is UNSOUND as a concurrency test in BOTH directions — it over-flags
 * sequential edits AND silently HLC-resolves (clobbers) a genuinely concurrent
 * pair. We never use `compare(w2.hlc, w1.hlc)` to decide concurrency. Instead we
 * use the **last-writer-witness**: a record carries `observed` = the HLC the
 * author had ALREADY merged for THIS recordKey before writing. W2 is
 * sequential-after W1 IFF `compare(w2.observed, w1.hlc) >= 0` (W2's author
 * provably saw ≥ W1). A missing/below witness CANNOT prove W2 saw W1 ⇒ FLAG.
 * The only path to "sequential" is a POSITIVE witness — the error direction is
 * always toward flag, never toward silent clobber.
 */

import { createHash } from 'node:crypto';

import {
  HybridLogicalClock,
  serializeHlcKey,
  type HlcTimestamp,
} from './HybridLogicalClock.js';
import type { ReplicatedEnvelope } from './ReplicatedRecordEnvelope.js';

// ───────────────────────────────────────────────────────────────────────────
// Impact tiers (§7.2)
// ───────────────────────────────────────────────────────────────────────────

/**
 * A store's impact tier governs the CONCURRENT-edit behavior (§7.2):
 *  - `high` (preferences, relationships): APPEND-BOTH-AND-FLAG — both versions
 *    preserved, ONE deduped conflict, never a silent overwrite.
 *  - `low` (scores, manifests): field-level HLC-wins WITH a divergence flag —
 *    the latest HLC wins but the overwrite is FLAGGED, never silent.
 * A store declares its tier at registration; the union reader looks it up per
 * read. There is no third "silent" tier by construction — every concurrent
 * resolution is surfaced.
 */
export type ImpactTier = 'high' | 'low';

// ───────────────────────────────────────────────────────────────────────────
// One origin's record for a recordKey
// ───────────────────────────────────────────────────────────────────────────

/**
 * One origin's current record for a recordKey, as the union reader sees it. The
 * `envelope` carries the load-bearing `hlc` (the total order), `op` (put/delete
 * tombstone), `origin` (author machine id — preserved end-to-end so rollback is
 * a real un-merge, §7.1), and the `observed` witness (§7.2). `data` is the
 * store-specific portion (envelope fields stripped).
 */
export interface OriginRecord {
  origin: string;
  envelope: ReplicatedEnvelope;
  data: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────────
// The witness detector (§7.2 — closes BLOCKER-4)
// ───────────────────────────────────────────────────────────────────────────

/** The verdict for a PAIR of records on the same recordKey from different origins. */
export type WitnessVerdict = 'sequential-after' | 'concurrent';

/**
 * Classify a PAIR (w1, w2) on the SAME recordKey from DIFFERENT origins (§7.2).
 *
 * Returns `'sequential-after'` ONLY when w2 provably saw w1 — i.e. w2 carries an
 * `observed` witness AND `compare(w2.observed, w1.hlc) >= 0` (w2's author had
 * already merged w1's version-or-later before writing). EVERY other case is
 * `'concurrent'` ⇒ FLAG:
 *   - w2.observed absent → cannot prove w2 saw w1 → concurrent.
 *   - w2.observed below w1.hlc → w2's author had NOT yet seen w1 → concurrent.
 *
 * PROVABLE err-toward-flag (§7.2 / §12 #5): a clock arranged to make w1/w2
 * `compare` cleanly (one appears strictly later by wall clock) CANNOT make
 * `observed >= the-other.hlc` true unless the author genuinely merged it first.
 * The WITNESS, not the wall clock, decides — and the error is always toward flag.
 *
 * This function deliberately NEVER consults `compare(w1.hlc, w2.hlc)` to decide
 * concurrency — that scalar comparison is the unsound test §7.2 replaces.
 */
export function classifyPair(w1: ReplicatedEnvelope, w2: ReplicatedEnvelope): WitnessVerdict {
  const witness = w2.observed;
  // No witness ⇒ we cannot prove w2 saw w1 ⇒ concurrent (the safe direction).
  if (witness === undefined) return 'concurrent';
  // w2 saw w1 IFF its observed witness for this key is ≥ w1's hlc.
  return HybridLogicalClock.compare(witness, w1.hlc) >= 0 ? 'sequential-after' : 'concurrent';
}

/**
 * Is the SET of distinct-origin records for one recordKey mutually sequential
 * (i.e. a clean linear edit history with a single defensible winner), or are at
 * least two of them concurrent (⇒ FLAG)? Returns `{ concurrent: false, winner }`
 * for a clean chain (the HLC-max record whose author witness-chains over the
 * others), or `{ concurrent: true, versions }` for the version SET to preserve.
 *
 * N-machine correctness (§9): N concurrent edits to one key produce ONE conflict
 * with all N in the version set — NOT N-choose-2 pairwise conflicts. We compute
 * the HLC-max candidate, then verify it is sequential-after EVERY other origin's
 * record (its author provably saw them all). If any other origin is concurrent
 * with the candidate, the whole set is concurrent.
 *
 * Err-toward-flag is structural: the candidate is "the winner" ONLY when it
 * witness-dominates every peer; one missing/below witness collapses the verdict
 * to concurrent.
 */
export function classifyOriginSet(
  records: OriginRecord[],
): { concurrent: false; winner: OriginRecord } | { concurrent: true; versions: OriginRecord[] } {
  if (records.length === 1) return { concurrent: false, winner: records[0] };

  // The HLC-max record is the ONLY candidate that could be the clean winner (a
  // sequential chain's last writer is HLC-max). compare is a total order, so the
  // max is unique and deterministic across the pool.
  let candidate = records[0];
  for (let i = 1; i < records.length; i++) {
    if (HybridLogicalClock.compare(records[i].envelope.hlc, candidate.envelope.hlc) > 0) {
      candidate = records[i];
    }
  }

  // The candidate is the clean winner ONLY if its author provably saw EVERY other
  // origin's record (witness-dominates the whole set). One concurrent peer ⇒ flag.
  for (const other of records) {
    if (other.origin === candidate.origin) continue;
    if (classifyPair(other.envelope, candidate.envelope) !== 'sequential-after') {
      // The candidate did NOT provably see `other` ⇒ they are concurrent ⇒ the
      // WHOLE set is a conflict (all versions preserved, §9). Sorting the version
      // set deterministically keeps conflictId stable.
      return { concurrent: true, versions: sortVersions(records) };
    }
  }
  return { concurrent: false, winner: candidate };
}

/** Deterministic version ordering (by HLC key) for a stable conflictId + display. */
function sortVersions(records: OriginRecord[]): OriginRecord[] {
  return [...records].sort((a, b) => HybridLogicalClock.compare(a.envelope.hlc, b.envelope.hlc));
}

// ───────────────────────────────────────────────────────────────────────────
// Stable conflict id (§7.2 — idempotent on (recordKey, version-set))
// ───────────────────────────────────────────────────────────────────────────

/**
 * A stable, deterministic conflict id = `hash(recordKey, sorted version-set)`
 * (§7.2). Idempotent on `(recordKey, version-set)`: re-discovering the SAME
 * unresolved conflict yields the SAME id, so append-both never appends a third
 * copy and the attention surface dedupes on it. The version set is sorted by HLC
 * key first so the id is independent of origin iteration order (N-machine safe).
 */
export function conflictId(recordKey: string, versions: HlcTimestamp[]): string {
  const sortedKeys = [...versions]
    .sort((a, b) => HybridLogicalClock.compare(a, b))
    .map((h) => serializeHlcKey(h));
  const h = createHash('sha256');
  h.update(recordKey);
  h.update(' ');
  h.update(sortedKeys.join(''));
  return h.digest('hex').slice(0, 32);
}

// ───────────────────────────────────────────────────────────────────────────
// The union merge rule (§7.2 — the no-clobber discipline)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The per-recordKey union result (§7.2):
 *  - `value` — the resolved winning record, or null when the key resolves to "no
 *    record" (every origin's latest is a delete tombstone, or there are no
 *    origins). For a HIGH-impact unresolved conflict `value` is null (neither
 *    version clobbers the other — both are preserved in `conflict.versions` for
 *    the operator to resolve). For a LOW-impact divergence the HLC-winner is the
 *    `value` and `divergenceFlag` is set.
 *  - `conflict` — a ConflictRecord when a HIGH-impact concurrent divergence was
 *    detected (append-both-and-flag), else null.
 *  - `divergenceFlag` — true when a LOW-impact concurrent overwrite occurred (the
 *    HLC-winner won but the overwrite is FLAGGED, never silent).
 */
export interface UnionResult {
  recordKey: string;
  value: OriginRecord | null;
  conflict: ConflictDescriptor | null;
  divergenceFlag: boolean;
}

/**
 * The conflict descriptor the union reader EMITS (the pure, content-addressed
 * shape). The durable lifecycle (recurrence count, forced-resolution flag,
 * first-seen timestamp, resolution) lives in ConflictStore — this is the
 * detection-time fact: the stable id + the preserved version SET. `versions`
 * carries every concurrent origin's record (a SET, §9 — never just a pair).
 */
export interface ConflictDescriptor {
  conflictId: string;
  recordKey: string;
  versions: OriginRecord[];
}

/**
 * The no-clobber union merge for one recordKey (§7.2). `perOrigin` is the set of
 * distinct-origin current records for the key (own + every non-dropped peer
 * namespace; the caller has already excluded a rolled-back origin, §7.4). `tier`
 * is the store's impact tier.
 *
 * Rules (§7.2):
 *  - 0 origins ⇒ no record.
 *  - 1 origin ⇒ return it (a delete tombstone resolves to "no record" for the
 *    value, but is still the authoritative latest).
 *  - multiple origins, provably SEQUENTIAL (witness-dominated clean chain) ⇒ the
 *    HLC-winner wins, no conflict, no divergence flag (a normal edit history).
 *  - multiple origins, CONCURRENT ⇒ tier-dependent:
 *    - high ⇒ APPEND-BOTH-AND-FLAG: value=null (neither clobbers), conflict set.
 *    - low ⇒ HLC-wins WITH divergenceFlag=true (winner returned, overwrite flagged).
 *
 * A delete tombstone participates in the merge as a normal HLC-positioned record
 * (so a concurrent delete↔put is a real conflict / divergence, never a silent
 * resurrection or silent loss). When the resolved winner is a delete, `value`
 * resolves to null (the key is deleted) but the winning RECORD is still returned
 * via the conflict/divergence path so the caller can see WHY.
 */
export function readUnion(recordKey: string, perOrigin: OriginRecord[], tier: ImpactTier): UnionResult {
  if (perOrigin.length === 0) {
    return { recordKey, value: null, conflict: null, divergenceFlag: false };
  }
  if (perOrigin.length === 1) {
    const only = perOrigin[0];
    return {
      recordKey,
      value: only.envelope.op === 'delete' ? null : only,
      conflict: null,
      divergenceFlag: false,
    };
  }

  const verdict = classifyOriginSet(perOrigin);
  if (!verdict.concurrent) {
    const winner = verdict.winner;
    return {
      recordKey,
      value: winner.envelope.op === 'delete' ? null : winner,
      conflict: null,
      divergenceFlag: false,
    };
  }

  // CONCURRENT divergence.
  const versions = verdict.versions;
  if (tier === 'high') {
    // APPEND-BOTH-AND-FLAG: neither version clobbers the other (value=null), the
    // conflict is surfaced for operator resolution (§7.3). A replicated record
    // NEVER clobbers a divergent local record — this is the core invariant.
    return {
      recordKey,
      value: null,
      conflict: {
        conflictId: conflictId(recordKey, versions.map((v) => v.envelope.hlc)),
        recordKey,
        versions,
      },
      divergenceFlag: false,
    };
  }

  // LOW-impact: HLC-wins WITH a divergence flag — the latest HLC wins but the
  // overwrite is FLAGGED (never silent). The HLC-winner is the version-set max.
  let winner = versions[0];
  for (const v of versions) {
    if (HybridLogicalClock.compare(v.envelope.hlc, winner.envelope.hlc) > 0) winner = v;
  }
  return {
    recordKey,
    value: winner.envelope.op === 'delete' ? null : winner,
    conflict: null,
    divergenceFlag: true,
  };
}
