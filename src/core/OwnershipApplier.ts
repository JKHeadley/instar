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
/** One entry as returned by the reader. `ts`/`seq` are the cursor key fields. */
export type PlacementReaderEntry = {
  topic?: number;
  machine: string;
  data: Record<string, unknown>;
  source?: string;
  /** Cursor key fields — present on CoherenceJournalReader entries. */
  ts?: string;
  seq?: number;
};

export interface PlacementReader {
  query(opts: { kind?: string; limit?: number; topic?: number; cursor?: string }): {
    entries: PlacementReaderEntry[];
  };
  /**
   * Opaque keyset cursor for the LAST entry of a page (see CoherenceJournalReader).
   * OPTIONAL so an older caller / test fake still type-checks — when absent the
   * applier reads a single page (the pre-paging behavior) and says so in the log
   * rather than silently under-scanning.
   */
  cursorFor?(entry: PlacementReaderEntry, isPlacement: boolean): string;
}

export interface OwnershipApplierDeps {
  /** Reads replicated + own placement entries (CoherenceJournalReader). */
  reader: PlacementReader;
  /** The SAME durable store the SessionOwnershipRegistry reads — so a materialized
   *  record is immediately visible to owner-resolution / routing. */
  store: SessionOwnershipStore;
  /**
   * This machine's mesh id — used ONLY for the SELF-vs-peer log label, never for
   * materialization (every placement is adopted regardless of owner). Accepts a
   * **late-bound getter** so a caller can wire the applier before `_meshSelfId` is
   * resolved without capturing a stale `null` (the boot-ordering hazard this fix closes);
   * a plain string still works for callers/tests that already have the id.
   */
  selfMachineId: string | (() => string | null | undefined);
  /** Max placement entries to request PER PAGE (the reader clamps to its own cap). Default 1000. */
  scanLimit?: number;
  /**
   * Max placement PAGES to walk per tick (bounded cost).
   *
   * Why paging exists at all: a `topic-placement` query is ordered EPOCH-DESCENDING
   * (CoherenceJournalReader.compareKey), then paged at the reader's cap (500). So a
   * single page is "the 500 HIGHEST-EPOCH rows", NOT the 500 most recent — a topic
   * with a LOW ownership epoch (a young topic, handed over once or twice) falls off
   * the bottom of page 1 as soon as the journal accumulates 500 higher-epoch rows,
   * and the cutoff only RISES as the journal grows. Such a topic was then never
   * materialized, so its owner machine held no ownership record, so the drain
   * refused `not-owner` forever and a pinned cross-machine transfer could never
   * land (observed live 2026-09-05: 33 of 150 topics visible; a real 4-hour
   * deadlock). The applier needs cross-topic COMPLETENESS, so it must page.
   *
   * Default 40 pages — at the reader's 500-row cap that is 20k placement rows,
   * far above the journal's retention bound, while still being a hard ceiling
   * so a corrupt/at-scale journal can never make a tick unbounded.
   */
  maxScanPages?: number;
  /**
   * Cross-machine convergence (Fix #3): the set of KNOWN machine ids, used to
   * validate a replicated `transferring` entry's `transferTo` before materializing
   * it — a target-less / unknown-machine `transferring` is DOWNGRADED to `active(owner)`
   * (never materialized as an un-claimable, permanently-stuck record). Absent ⇒ no
   * validation (single-machine / older caller) — the entry is materialized as-is.
   */
  knownMachines?: () => Set<string>;
  /**
   * Epoch fence (Fix #3 / Finding SE2): reject a materialization whose epoch jumps
   * more than this many steps over the local epoch — a corrupt `epoch=2^53` can no
   * longer wedge a topic forever. Default 1e9 (generous; real epochs advance by 1-2).
   */
  maxEpochJump?: number;
  /**
   * Timestamp clamp tolerance (Fix #3 / Finding SE8): a carried `transferring`
   * `timestamp` that is in the future beyond this many ms is floored to the
   * receiver's now; one implausibly far in the past is capped. Bounds the
   * deadline/age-backstop inputs so a corrupt peer can't defeat recovery. Default 5min.
   */
  timestampSkewToleranceMs?: number;
  logger?: (msg: string) => void;
  now?: () => number;
}

export interface OwnershipApplyResult {
  /** Distinct topics that had a placement entry this tick. */
  examined: number;
  /** Topics whose local ownership record was advanced from a (newer) placement. */
  materialized: number;
  /** Placement pages actually walked this tick (observability — 1 when unpaged). */
  pagesScanned?: number;
  /** True when the page ceiling stopped the walk before the stream was exhausted. */
  pageCeilingHit?: boolean;
  /** True when the reader exposes no cursor, so only a single page could be read. */
  pagingUnavailable?: boolean;
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

  /** Resolve the (possibly late-bound) self machine id at tick time, for the log label only. */
  private resolveSelf(): string | null | undefined {
    const s = this.d.selfMachineId;
    return typeof s === 'function' ? s() : s;
  }

  /**
   * One pass: adopt the highest-epoch placement per topic into the local store.
   * Returns counts for observability. Never throws — a read/parse failure degrades
   * to "materialized fewer this tick", never a crash on the routing-adjacent path.
   */
  tick(): OwnershipApplyResult {
    let examined = 0;
    let materialized = 0;
    let pagesScanned = 0;
    let pageCeilingHit = false;
    let pagingUnavailable = false;
    try {
      // Collapse to the highest-epoch placement per topic across own + replica streams.
      // Fix #3: carry the handoff fields (status/transferTo/timestamp/drainInFlight) so the
      // target materializes the `transferring` intermediate, not just `active`.
      type Best = {
        owner: string; epoch: number; streamOwner: string;
        status: 'active' | 'transferring'; transferTo?: string;
        timestamp?: number; drainInFlight?: boolean;
      };
      const bestByTopic = new Map<string, Best>();

      const pageLimit = this.d.scanLimit ?? 1000;
      // A non-finite bound must NEVER silently mean "scan nothing": `Math.max(1, NaN)`
      // is NaN, `page < NaN` is false, and the walk would run ZERO pages, materialize
      // nothing, and log nothing — the exact silent under-scan this change exists to
      // eliminate. A config-derived number is precisely how NaN arrives, so fall back
      // to the default rather than trusting the arithmetic (same guard shape as the
      // `Number.isFinite(rawLimit)` check on the journal read route).
      const rawMaxPages = this.d.maxScanPages;
      const maxPages = Number.isFinite(rawMaxPages) ? Math.max(1, Math.floor(rawMaxPages as number)) : 40;
      let cursor: string | undefined;
      let seenCursor: string | undefined;

      // Walk EVERY page, not just the first. The placement order is epoch-DESC, so
      // page 1 is the highest-epoch rows — a low-epoch topic lives on a LATER page.
      // Termination is driven by an EMPTY page, never by a short page: the reader
      // clamps `limit` to its own cap (500), so `entries.length < pageLimit` is true
      // on a FULL page whenever pageLimit > 500 and would stop the walk after page 1
      // — reproducing the very bug this loop fixes.
      //
      // The ceiling is checked at the TOP of the walk, not at the bottom: it must mean
      // "the cap stopped a walk that still had somewhere to go", never "the walk happened
      // to finish on its last allowed page". Flagging it at the bottom mis-reports a
      // COMPLETE scan as incomplete whenever the row count is an exact multiple of the
      // page size — a false alarm in the very observability surface this change adds.
      for (;;) {
        if (pagesScanned >= maxPages) {
          // The page budget is spent. Do NOT assume that means the scan was incomplete:
          // when the row count is an exact multiple of the page size the walk has in fact
          // finished, and flagging it would print "INCOMPLETE — some topics may not be
          // materialized" on a COMPLETE scan (a false alarm in the very observability
          // surface this change adds). One bounded probe with the live cursor answers it
          // exactly, and only in the rare ceiling case — so the honest answer costs at
          // most one extra query, never a per-tick cost.
          if (cursor) {
            let remaining = 1; // unknown → assume more (the safe direction: report incomplete)
            try {
              remaining = this.d.reader.query({ kind: 'topic-placement', limit: pageLimit, cursor }).entries.length;
            } catch { /* @silent-fallback-ok — NOT silent: `remaining` stays 1, so the ceiling is reported rather than hidden */ }
            if (remaining > 0) {
              pageCeilingHit = true;
              this.log(`page ceiling (${maxPages}) reached with more placements still unread — the scan was INCOMPLETE; raise maxScanPages if this recurs`);
            }
          }
          break;
        }
        const page = pagesScanned; // 0-based index of the page about to be read
        const res = this.d.reader.query({
          kind: 'topic-placement',
          limit: pageLimit,
          ...(cursor ? { cursor } : {}),
        });
        pagesScanned++;
        const entries = res.entries;
        if (entries.length === 0) break;

        for (const e of entries) {
          if (e.topic == null) continue;
          const owner = typeof e.data.owner === 'string' ? e.data.owner : '';
          const epoch = typeof e.data.epoch === 'number' ? e.data.epoch : Number(e.data.epoch);
          if (!owner || !Number.isFinite(epoch) || epoch <= 0) continue;
          const key = String(e.topic);
          const cur = bestByTopic.get(key);
          const cand: Best = {
            owner, epoch, streamOwner: e.machine,
            status: e.data.status === 'transferring' ? 'transferring' : 'active',
            transferTo: typeof e.data.transferTo === 'string' ? e.data.transferTo : undefined,
            timestamp: typeof e.data.timestamp === 'number' && Number.isFinite(e.data.timestamp) ? e.data.timestamp : undefined,
            drainInFlight: e.data.drainInFlight === true ? true : undefined,
          };
          if (!cur || epoch > cur.epoch) {
            bestByTopic.set(key, cand);
          } else if (epoch === cur.epoch && cur.streamOwner !== cur.owner && cand.streamOwner === cand.owner) {
            // Owner-anchored equal-epoch tie-break (Finding SE6): prefer the entry whose
            // stream-owner == entry.owner (a `transferring` from the true owner is canonical),
            // never iteration order.
            bestByTopic.set(key, cand);
          }
        }

        // Advance the keyset cursor to the last entry of this page.
        if (typeof this.d.reader.cursorFor !== 'function') {
          // No cursor support (older caller / narrow fake) → single page, said out
          // loud. NEVER a silent under-scan: an unpaged applier is the deadlock bug.
          pagingUnavailable = true;
          this.log('paging unavailable (reader exposes no cursorFor) — scanned a SINGLE page; low-epoch topics may not be materialized');
          break;
        }
        let next: string | undefined;
        try {
          next = this.d.reader.cursorFor(entries[entries.length - 1], true);
        } catch (err) {
          this.log(`cursor build failed on page ${page + 1} — stopping the walk: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
        // A cursor that does not ADVANCE would loop forever — stop instead.
        if (!next || next === seenCursor) {
          this.log(`cursor did not advance on page ${page + 1} — stopping the walk`);
          break;
        }
        seenCursor = next;
        cursor = next;
      }
      examined = bestByTopic.size;

      const known = this.d.knownMachines?.();
      const maxEpochJump = this.d.maxEpochJump ?? 1e9;
      const skewTol = this.d.timestampSkewToleranceMs ?? 5 * 60 * 1000;

      for (const [sessionKey, best] of bestByTopic) {
        const local = this.d.store.read(sessionKey);
        const localEpoch = local?.ownershipEpoch ?? 0;
        if (best.epoch <= localEpoch) continue; // not newer → nothing to adopt (fast-forward only)
        // Epoch fence (Finding SE2): a corrupt huge epoch jump can't wedge a topic forever.
        if (best.epoch - localEpoch > maxEpochJump) {
          this.log(`epoch-fence: refusing topic ${sessionKey} epoch ${best.epoch} (local ${localEpoch}, jump > ${maxEpochJump})`);
          continue;
        }
        const now = this.now();
        // Resolve the materialized status. A `transferring` entry whose `transferTo` is
        // target-less / unknown / == owner is DOWNGRADED to active(owner) — never materialized
        // as an un-claimable permanently-stuck record (Findings AD3/SE1).
        let status: 'active' | 'transferring' = 'active';
        let transferTo: string | undefined;
        let drainInFlight: boolean | undefined;
        let timestamp = now;
        if (best.status === 'transferring') {
          const t = best.transferTo;
          const validTarget = !!t && t !== best.owner && (!known || known.has(t));
          if (validTarget) {
            status = 'transferring';
            transferTo = t;
            drainInFlight = best.drainInFlight === true ? true : undefined;
            // Carry the producer's `timestamp` (drain-grace + convergence deadline key on it),
            // CLAMPED on receive (Finding SE8): future-beyond-skew → floor to now;
            // implausibly-far-past → cap; in-bounds → preserve verbatim (AD2 drain timing).
            const carried = best.timestamp;
            if (typeof carried === 'number' && Number.isFinite(carried)) {
              const maxPastMs = 24 * 60 * 60 * 1000;
              if (carried > now + skewTol) timestamp = now;
              else if (carried < now - maxPastMs) timestamp = now - maxPastMs;
              else timestamp = carried;
            }
          } else {
            this.log(`transferring→active downgrade for topic ${sessionKey}: invalid transferTo ${JSON.stringify(t)}`);
          }
        }
        const rec: SessionOwnershipRecord = {
          sessionKey,
          ownerMachineId: best.owner,
          ownershipEpoch: best.epoch,
          status,
          ...(transferTo ? { transferTo } : {}),
          ...(drainInFlight ? { drainInFlight } : {}),
          // Adoption nonce keyed on (owner, epoch) — the same ordering identity the
          // journal uses; never a local action nonce.
          nonce: `applier:${best.owner}:${best.epoch}`,
          timestamp,
          updatedAt: new Date(now).toISOString(),
        };
        const r = this.d.store.casWrite(rec);
        if (r.ok) {
          materialized++;
          const self = this.resolveSelf();
          this.log(
            `materialized topic ${sessionKey} → owner ${best.owner} @epoch ${best.epoch}` +
              (self && best.owner === self
                ? ' (SELF — this machine now serves it)'
                : self
                  ? ' (peer — route forwards there)'
                  : ''),
          );
        }
      }
    } catch (err) {
      // NOT silent: logged. The applier is best-effort replication; a failure means
      // this tick adopted fewer records — the next tick (or the reconciler) converges.
      this.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      examined,
      materialized,
      pagesScanned,
      ...(pageCeilingHit ? { pageCeilingHit: true } : {}),
      ...(pagingUnavailable ? { pagingUnavailable: true } : {}),
    };
  }
}
