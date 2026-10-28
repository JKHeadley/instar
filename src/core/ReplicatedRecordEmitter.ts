/**
 * ReplicatedRecordEmitter — the GENERIC journal-backed SEND emitter (WS2 send-side).
 *
 * Spec: docs/specs/WS2-SEND-SIDE-EMISSION-SPEC.md §4; the substrate it rides is
 * docs/specs/multi-machine-replicated-store-foundation.md §4 (the envelope +
 * flag-gated emission) and §7.2 (the `observed` last-writer-witness).
 *
 * THE GAP THIS CLOSES: every memory manager already calls an internal
 * `emitter.emitPut(record)` / `emitter.emitDelete(...)` hook on each write, behind a
 * `*ReplicationEmitter | null` seam — but server.ts never constructed the concrete
 * emitter those hooks call (it was deferred to "a later rollout stage" that never
 * came), so the hooks fired into a no-op and nothing reached the journal own-streams.
 * This class IS that concrete emitter; server.ts builds ONE and adapts it to each
 * manager's emit seam (a tiny per-store adapter that names the store's
 * `build*RecordData`).
 *
 * It is store-AGNOSTIC: `emit(store, recordKey, build)` resolves the store's journal
 * kind from the injected `ReplicatedKindRegistry`, gates on
 * `multiMachine.stateSync.<store>.enabled` (dark by default), stamps the HLC, derives
 * the `observed` witness, asks the store's builder for the disclosure-minimized
 * envelope `data`, and appends it via `CoherenceJournal.emitReplicatedRecord`. ONE
 * generic path serves all 7 kinds; the only per-store thing is the builder closure.
 *
 * SAFETY: NEVER throws into the caller (the manager hooks are best-effort). A disabled
 * store, an unregistered store, a degenerate (null) recordKey, a builder that returns
 * null or throws (e.g. a record over its per-entry byte cap) — every one is a counted
 * no-op, never an exception that would break the local write the agent is performing.
 * Emission is SINGLE-ORIGIN by construction: it stamps `origin = this machine` and the
 * journal writes only this machine's own stream (§6.1 anti-forgery holds end-to-end).
 */

import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { JournalEmitOutcome } from './CoherenceJournal.js';
import {
  isStoreEmissionEnabled,
  type ReplicatedKindRegistry,
  type StateSyncStores,
} from './ReplicatedRecordEnvelope.js';

/** The minimal journal seam the emitter needs (so it is unit-testable with a fake). */
export interface ReplicatedRecordEmitterJournal {
  /** Append a built replicated-record envelope `data` for `kind` (no-op when the
   *  kind is not a registered replicated kind; never throws). Returns what the journal
   *  did with it; a seam that returns nothing (a test fake predating the outcome)
   *  yields the `unconfirmed` emit outcome. */
  emitReplicatedRecord(kind: string, data: Record<string, unknown>): JournalEmitOutcome | void;
}

/** The minimal HLC seam (only `tick()` is needed on the author side). */
export interface ReplicatedRecordEmitterClock {
  /** Local-event advance — strictly greater than every prior tick/receive (§3.2.1). */
  tick(): HlcTimestamp;
}

/** A builder closure: produce the disclosure-minimized envelope `data` for this write
 *  given the freshly-ticked `hlc`, this machine's `origin`, and the `observed` witness
 *  (absent ⇒ no prior witness). Returns null to SKIP (a degenerate record with no
 *  stable identity surface). May THROW on an over-cap record — the emitter catches it. */
export type BuildRecordData = (
  hlc: HlcTimestamp,
  origin: string,
  observed: HlcTimestamp | undefined,
) => Record<string, unknown> | null;

/** The DI'd seams (asserted real, never null/no-op, by the wiring-integrity test). */
export interface ReplicatedRecordEmitterSeams {
  /** The journal append sink. */
  journal: ReplicatedRecordEmitterJournal;
  /** The author-side HLC clock (persisted; one per machine). */
  clock: ReplicatedRecordEmitterClock;
  /** The replicated-kind registry — resolves store → journal kind; the emitter only
   *  emits a registered store. */
  registry: ReplicatedKindRegistry;
  /** This machine's origin id (stamped on every emitted record — single-origin). */
  origin: string;
  /** The per-store stateSync flags (the dark-by-default gate). A getter so a live
   *  config flip is honored without reconstructing the emitter. */
  stores: () => StateSyncStores | undefined;
  /**
   * The last-writer-witness source (§7.2): the MAX HLC over every origin record this
   * machine CURRENTLY holds on disk for (store, recordKey) — own prior + applied
   * peers. Sound by construction: it can only witness a version provably on disk, so a
   * not-yet-pulled peer version is simply absent ⇒ the merge flags concurrent
   * (err-toward-flag), never a silent clobber. Returns undefined when none is held
   * (the first write of a key) ⇒ `observed` omitted. Best-effort; throwing is caught.
   */
  loadWitness: (store: string, recordKey: string) => HlcTimestamp | undefined;
  /** Optional structured logger (default no-op). */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** What one `emit` call did. `emitted` ⇔ the journal reported `accepted` (enqueued). */
export type EmitOutcome =
  | 'emitted'
  /** The journal seam returned nothing (a test fake predating outcomes): counted as
   *  emitted in the legacy stats, but never treated as confirmed acceptance. */
  | 'unconfirmed'
  | 'disabled'
  | 'skipped'
  | `dropped:${Exclude<JournalEmitOutcome, 'accepted'>}`
  | 'error';

export interface EmitResult {
  outcome: EmitOutcome;
  /** The HLC this emit ticked, present whenever the tick happened. */
  hlc?: HlcTimestamp;
}

export interface EmitOptions {
  /**
   * When present, REPLACES the witness read: the emit carries exactly this `observed`
   * (`null` ⇒ no witness, and no witness read at all). Used for a write discovered AFTER
   * the fact (the replicated-store reconciler): `observed` claims what the author had
   * seen when WRITING, and an out-of-process writer never saw peer records (they live
   * only in the journal replica streams), so the emit-time witness could make a stale
   * local write look sequential-after a newer peer version and silently win. With no
   * witness every peer version is concurrent ⇒ flagged (or, when byte-identical,
   * collapsed by the union), never silently superseded (§7.2 err-toward-flag).
   */
  observed?: HlcTimestamp | null;
}

/** One accepted own emit, reported to every registered observer. */
export interface EmittedRecordEvent {
  store: string;
  recordKey: string;
  op: 'put' | 'delete';
  hlc: HlcTimestamp;
  /** The exact built envelope `data` that was appended. */
  data: Record<string, unknown>;
}

/** Lifetime counters for observability (mirrors the journal's degradation style). */
export interface ReplicatedRecordEmitterStats {
  /** Records appended to the journal. */
  emitted: number;
  /** No-ops because the store was disabled (dark). */
  storeDisabled: number;
  /** No-ops because the recordKey was null/degenerate or the builder returned null. */
  skipped: number;
  /** Builder/journal throws caught (never propagated to the manager). */
  errors: number;
  /** The journal refused the record (rate cap, lock-out, schema, oversize, dedupe). */
  dropped: number;
  /** Emit observers that threw (caught; never affects the emit). */
  observerErrors: number;
}

export class ReplicatedRecordEmitter {
  private readonly seams: ReplicatedRecordEmitterSeams;
  private readonly stats: ReplicatedRecordEmitterStats = {
    emitted: 0,
    storeDisabled: 0,
    skipped: 0,
    errors: 0,
    dropped: 0,
    observerErrors: 0,
  };
  private readonly observers: Array<(ev: EmittedRecordEvent) => void> = [];

  constructor(seams: ReplicatedRecordEmitterSeams) {
    // Wiring-integrity preconditions: the seams MUST be real, not null/no-op.
    if (!seams) throw new Error('ReplicatedRecordEmitter: seams are required');
    if (!seams.journal || typeof seams.journal.emitReplicatedRecord !== 'function') {
      throw new Error('ReplicatedRecordEmitter: journal.emitReplicatedRecord seam must be a function (not a no-op)');
    }
    if (!seams.clock || typeof seams.clock.tick !== 'function') {
      throw new Error('ReplicatedRecordEmitter: clock.tick seam must be a function');
    }
    if (!seams.registry) throw new Error('ReplicatedRecordEmitter: registry seam is required (not null)');
    if (typeof seams.origin !== 'string' || seams.origin.length === 0) {
      throw new Error('ReplicatedRecordEmitter: origin must be a non-empty string');
    }
    if (typeof seams.stores !== 'function') throw new Error('ReplicatedRecordEmitter: stores seam must be a function');
    if (typeof seams.loadWitness !== 'function') throw new Error('ReplicatedRecordEmitter: loadWitness seam must be a function (not a no-op)');
    this.seams = seams;
  }

  /** The HLC clock this emitter ticks (the reconciler fences against the SAME instance). */
  get clock(): ReplicatedRecordEmitterClock {
    return this.seams.clock;
  }

  /**
   * Register an observer told about EVERY accepted own emit (in-process hook or
   * reconciler), synchronously, after the journal accepted it. Observer exceptions are
   * caught and counted. Returns an unsubscribe function.
   */
  addEmitObserver(fn: (ev: EmittedRecordEvent) => void): () => void {
    this.observers.push(fn);
    return () => {
      const i = this.observers.indexOf(fn);
      if (i >= 0) this.observers.splice(i, 1);
    };
  }

  /** Read-only stats (for observability + the wiring-integrity assertions). */
  getStats(): Readonly<ReplicatedRecordEmitterStats> {
    return { ...this.stats };
  }

  /**
   * Emit one replicated record for (store, recordKey). The single generic path for a
   * put OR a delete — the only difference is the `build` closure (a put builder vs a
   * tombstone builder). Never throws into the caller.
   *
   * Order (§4): dark gate → degenerate guard → witness → tick → build → append.
   */
  emit(store: string, recordKey: string | null | undefined, build: BuildRecordData, opts?: EmitOptions): EmitResult {
    let hlc: HlcTimestamp | undefined;
    try {
      // 1. Dark gate (the default). A disabled store emits NOTHING — a strict no-op.
      if (!isStoreEmissionEnabled(this.seams.stores(), store)) {
        this.stats.storeDisabled++;
        return { outcome: 'disabled' };
      }
      // 2. Only a registered store has a journal kind to ride.
      const reg = this.seams.registry.getByStore(store);
      if (!reg) {
        this.stats.skipped++;
        return { outcome: 'skipped' };
      }
      // 3. Degenerate guard — a null/empty recordKey has no stable identity surface.
      if (typeof recordKey !== 'string' || recordKey.length === 0) {
        this.stats.skipped++;
        return { outcome: 'skipped' };
      }
      // 4. Witness BEFORE the tick — the HLC this machine had already merged for the
      //    key (own prior + applied peers). Best-effort; a witness read fault degrades
      //    to "no witness" (flag-on-conflict, the safe direction), never a throw.
      //    An explicit `opts.observed` replaces the read (see EmitOptions).
      let observed: HlcTimestamp | undefined;
      if (opts && 'observed' in opts) {
        observed = opts.observed ?? undefined;
      } else {
        try {
          observed = this.seams.loadWitness(store, recordKey);
        } catch (e) { /* @silent-fallback-ok: a witness read fault degrades to no-witness ⇒ flag-on-conflict (the safe merge direction, §7.2); never blocks the emit. */
          observed = undefined;
          this.log('witness-read-failed', { store, error: (e as Error)?.message });
        }
      }
      // 5. Tick AFTER the witness so hlc > observed (a clean sequential position).
      hlc = this.seams.clock.tick();
      // 6. Build the disclosure-minimized envelope data (store-specific).
      const data = build(hlc, this.seams.origin, observed);
      if (data === null || data === undefined) {
        this.stats.skipped++;
        return { outcome: 'skipped', hlc };
      }
      // 7. Append. The journal validates + op-key-dedupes + enqueues (non-blocking).
      const journalOutcome = this.seams.journal.emitReplicatedRecord(reg.kind, data);
      if (journalOutcome === undefined) {
        this.stats.emitted++;
        return { outcome: 'unconfirmed', hlc };
      }
      if (journalOutcome !== 'accepted') {
        this.stats.dropped++;
        return { outcome: `dropped:${journalOutcome}`, hlc };
      }
      this.stats.emitted++;
      this.notify({ store, recordKey, op: data.op === 'delete' ? 'delete' : 'put', hlc, data });
      return { outcome: 'emitted', hlc };
    } catch (e) { /* @silent-fallback-ok: the manager's write must NEVER fail because replication did — a builder throw (e.g. over-cap) / journal fault is a counted no-op, surfaced via stats + the log, never propagated (Structure > Willpower: the safety is structural, not per-caller). */
      this.stats.errors++;
      this.log('emit-failed', { store, error: (e as Error)?.message });
      return { outcome: 'error', ...(hlc ? { hlc } : {}) };
    }
  }

  private notify(ev: EmittedRecordEvent): void {
    for (const fn of this.observers) {
      try {
        fn(ev);
      } catch (e) { /* @silent-fallback-ok: an observer is bookkeeping; its fault must never undo or fail an accepted emit. Counted + logged. */
        this.stats.observerErrors++;
        this.log('observer-failed', { store: ev.store, error: (e as Error)?.message });
      }
    }
  }

  private log(event: string, detail: Record<string, unknown>): void {
    this.seams.log?.(event, detail);
  }
}
