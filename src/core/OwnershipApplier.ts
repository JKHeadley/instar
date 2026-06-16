/**
 * OwnershipApplier — the cross-machine half of the transfer fix (spec
 * docs/specs/live-user-channel-proof-standard.md §7.2). It runs OFF the routing
 * hot path (on a periodic tick) and materializes durable local ownership records
 * from the REPLICATED coherence-journal placement entries, so the machine a topic
 * was transferred TO actually resolves itself (or the true owner) as the owner on
 * the next inbound message.
 *
 * The bug it closes (2026-06-15): /pool/transfer wrote the target's ownership into
 * the SOURCE machine's in-memory Map and emitted a placement entry to the journal.
 * The journal entry REPLICATES to peers (peers/<machineId>.topic-placement.jsonl),
 * but no one ever turned a replicated placement entry back into an ownership record
 * on the receiving machine — so the target's owner-resolution read null and the
 * router re-placed the topic locally instead of forwarding. This applier is exactly
 * that missing step.
 *
 * Correctness model: a placement entry carries (topic, owner, ownershipEpoch). The
 * applier takes the HIGHEST-epoch placement per topic across all streams (own +
 * peer replicas) and adopts it into the local durable store via the store's
 * fast-forward CAS — which lands ONLY if it strictly advances the local epoch. So
 * a stale replicated entry can never clobber a fresher local decision, and the
 * (topic, epoch) ordering is the same key the journal dedupes on. This adopts an
 * ALREADY-DECIDED ownership (a replication step), not a new FSM transition — hence
 * it writes the record directly rather than running place/claim actions.
 *
 * Split-brain: the applier does NOT independently re-solve lease split-brain (the
 * spec's narrowed claim). It adopts the highest-epoch placement; under a healthy
 * single-holder lease that is correct, and a genuine lease split-brain surfaces via
 * the existing lease-attention path. Lease-epoch fencing inside the placement entry
 * is a tracked follow-on (PlacementData does not yet carry leaseEpoch).
 */

import type { SessionOwnershipRecord } from './SessionOwnership.js';
import type { SessionOwnershipStore } from './SessionOwnershipRegistry.js';

/** The minimal slice of CoherenceJournalReader the applier needs (for testability). */
export interface PlacementReader {
  query(opts: { kind?: string; limit?: number; topic?: number }): {
    entries: Array<{ topic?: number; machine: string; data: Record<string, unknown>; source?: string }>;
  };
}

export interface OwnershipApplierDeps {
  /** Reads replicated + own placement entries (CoherenceJournalReader). */
  reader: PlacementReader;
  /** The SAME durable store the SessionOwnershipRegistry reads — so a materialized
   *  record is immediately visible to owner-resolution / routing. */
  store: SessionOwnershipStore;
  selfMachineId: string;
  /** Max placement entries to scan per tick (bounded cost). Default 1000. */
  scanLimit?: number;
  logger?: (msg: string) => void;
  now?: () => number;
}

export interface OwnershipApplyResult {
  /** Distinct topics that had a placement entry this tick. */
  examined: number;
  /** Topics whose local ownership record was advanced from a (newer) placement. */
  materialized: number;
}

export class OwnershipApplier {
  private readonly d: OwnershipApplierDeps;

  constructor(deps: OwnershipApplierDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private log(m: string): void {
    this.d.logger?.(`[ownership-applier] ${m}`);
  }

  /**
   * One pass: adopt the highest-epoch placement per topic into the local store.
   * Returns counts for observability. Never throws — a read/parse failure degrades
   * to "materialized fewer this tick", never a crash on the routing-adjacent path.
   */
  tick(): OwnershipApplyResult {
    let examined = 0;
    let materialized = 0;
    try {
      const res = this.d.reader.query({ kind: 'topic-placement', limit: this.d.scanLimit ?? 1000 });
      // Collapse to the highest-epoch placement per topic across own + replica streams.
      const bestByTopic = new Map<string, { owner: string; epoch: number }>();
      for (const e of res.entries) {
        if (e.topic == null) continue;
        const owner = typeof e.data.owner === 'string' ? e.data.owner : '';
        const epoch = typeof e.data.epoch === 'number' ? e.data.epoch : Number(e.data.epoch);
        if (!owner || !Number.isFinite(epoch) || epoch <= 0) continue;
        const key = String(e.topic);
        const cur = bestByTopic.get(key);
        if (!cur || epoch > cur.epoch) bestByTopic.set(key, { owner, epoch });
      }
      examined = bestByTopic.size;

      for (const [sessionKey, best] of bestByTopic) {
        const local = this.d.store.read(sessionKey);
        const localEpoch = local?.ownershipEpoch ?? 0;
        if (best.epoch <= localEpoch) continue; // not newer → nothing to adopt (fast-forward only)
        const now = this.now();
        const rec: SessionOwnershipRecord = {
          sessionKey,
          ownerMachineId: best.owner,
          ownershipEpoch: best.epoch,
          status: 'active',
          // Adoption nonce keyed on (owner, epoch) — the same ordering identity the
          // journal uses; never a local action nonce.
          nonce: `applier:${best.owner}:${best.epoch}`,
          timestamp: now,
          updatedAt: new Date(now).toISOString(),
        };
        const r = this.d.store.casWrite(rec);
        if (r.ok) {
          materialized++;
          this.log(
            `materialized topic ${sessionKey} → owner ${best.owner} @epoch ${best.epoch}` +
              (best.owner === this.d.selfMachineId ? ' (SELF — this machine now serves it)' : ' (peer — route forwards there)'),
          );
        }
      }
    } catch (err) {
      // NOT silent: logged. The applier is best-effort replication; a failure means
      // this tick adopted fewer records — the next tick (or the reconciler) converges.
      this.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { examined, materialized };
  }
}
