/**
 * StoreSnapshot — single-origin snapshot-then-tail machinery (WS2 replicated-store
 * foundation, Component 4 / build-order step 3).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §6 (snapshot-then-
 * tail), §6.1 (single-origin anti-forgery), §6.2 (snapshot format + watermark
 * VECTOR), §6.3 (the cutover apply path), §6.4 (HLC demoted to SECONDARY dedup),
 * §6.5 (tombstone high-water seed), §6.6 (why a per-(origin,kind) seq-watermark
 * vector, not a scalar), §8.2 (snapshot-cache fixed ceiling).
 *
 * GENERIC foundation machinery ONLY — there is NO concrete store kind here
 * (preferences/relationships are later consumers, WS2.1+). Everything ships DARK
 * behind `multiMachine.stateSync.<store>.enabled` (default false); a single-machine
 * agent (no peers to pull from) is a strict no-op.
 *
 * This module is PURE LOGIC. The 67MB-class whole-store materialization happens OFF
 * the event loop in `storeSnapshotBuild.worker.ts` (the instar#1069 requirement,
 * mirroring CartographerSweepEngine / cartographerDetect.worker.ts) — this file
 * exports the pure `materializeSnapshot()` the worker dispatches to, plus the
 * non-worker cache/breaker/cutover seams that run on the main thread but do only
 * bounded, O(records-in-one-batch) work. No fs, no Date directly, no network.
 *
 * THE CORRECTNESS BORROW (§6.3): the whole no-gap/no-double-apply guarantee is
 * inherited from the EXISTING seq-contiguous transport. This module:
 *   1. builds a single-origin snapshot (origin === serving machine, §6.1),
 *   2. computes a per-(origin,kind) seq-watermark VECTOR from the entries that
 *      actually materialized (§6.2 — it cannot lie),
 *   3. seeds `PeerMeta.kinds[kind].lastHeldSeq = snapshotSeq` (§6.3 step 3),
 *   4. then TAILS via the UNCHANGED `buildServeBatch(kind, snapshotSeq, M)` — the
 *      existing applier seq-contiguity (lastHeldSeq+1) does the gap/dup work.
 * There is NO new gap-detection here. HLC is a SECONDARY dedup hint only (§6.4).
 */

import { Worker } from 'node:worker_threads';

import {
  HybridLogicalClock,
  coerceHlc,
  serializeHlcKey,
  type HlcTimestamp,
} from './HybridLogicalClock.js';

// ───────────────────────────────────────────────────────────────────────────
// Types — the snapshot format (§6.2) + the watermark VECTOR (§6.6)
// ───────────────────────────────────────────────────────────────────────────

/**
 * One materialized record in a single-origin snapshot (§6.2). Carries its `hlc`
 * (the merge total order), `op` (put/delete tombstone), `recordKey`, `origin`
 * (=== the serving machine, §6.1), and the opaque store-specific `data`. A delete
 * is a TOMBSTONE record (kept within the tombstone horizon, §6.5), never a physical
 * removal — so the apply path can resolve a delete↔put race deterministically.
 */
export interface SnapshotRecord {
  recordKey: string;
  hlc: HlcTimestamp;
  op: 'put' | 'delete';
  origin: string;
  /** The store-specific portion of the journal `data` (envelope fields stripped). */
  data: Record<string, unknown>;
}

/**
 * The per-(origin,kind) seq-watermark — a VECTOR component, not a scalar (§6.6).
 * `snapshotSeq` is the highest journal `seq` of an origin-M-authored entry that
 * materialized into the snapshot. It is THE TAIL CURSOR: the cutover seeds
 * `lastHeldSeq = snapshotSeq` then tails `buildServeBatch(kind, snapshotSeq, M)`.
 */
export interface SnapshotKindWatermark {
  /** The highest seq this snapshot materialized from for (origin, kind). */
  snapshotSeq: number;
}

/**
 * The snapshot's seq-watermark — a per-(origin,kind) VECTOR (§6.2 / §6.6). One
 * snapshot is single-origin, so `origin` is a scalar; the VECTOR is over the
 * contributing KINDS (a store may ride more than one journal kind). `maxHlc` is
 * SECONDARY (§6.4): an idempotency/dedup hint at cutover, NEVER the tail cursor.
 */
export interface SnapshotWatermark {
  /** === the serving machine (single-origin, §6.1). */
  origin: string;
  /** Per contributing (origin, kind) stream: the highest seq materialized. */
  kinds: Record<string, SnapshotKindWatermark>;
  /** SECONDARY dedup hint only — the max HLC over all records (§6.4). */
  maxHlc: HlcTimestamp;
}

/**
 * A built single-origin snapshot of store S from origin M (§6.2): the CURRENT
 * materialized state (latest record per recordKey; deletes tombstoned), plus the
 * watermark vector. `deleteWatermarks` carries the per-recordKey deleted-keys
 * high-water SEED (§6.5) — the HLC of the highest delete the snapshot reflects per
 * key — so the receiver can seed its resurrection guard from the snapshot.
 */
export interface StoreSnapshot {
  /** The store key (config sub-key / advert suffix, e.g. 'pref'). */
  store: string;
  /** === the serving machine (single-origin invariant, §6.1). */
  origin: string;
  /** The materialized records (latest per recordKey, deletes tombstoned). */
  records: SnapshotRecord[];
  /** The per-(origin,kind) seq-watermark VECTOR + the secondary maxHlc (§6.2). */
  watermark: SnapshotWatermark;
  /**
   * The tombstone high-water SEED (§6.5): per recordKey that is currently a
   * tombstone in this snapshot, the HLC of that delete. A receiver seeds its
   * deleted-keys high-water from these so a stale pre-delete put cannot resurrect
   * the key even after the tombstone record itself rotates out.
   */
  deleteWatermarks: Record<string, HlcTimestamp>;
  /** Total serialized byte size — for the cache byte ceiling (§8.2). */
  sizeBytes: number;
  /**
   * True iff the materialization hit `maxSnapshotBytes` and DROPPED records while
   * keeping the full watermark (§6.3 boundedness). A truncated snapshot is a
   * SUB-WATERMARK GAP TRAP: it seeds `lastHeldSeq = snapshotSeq` but does NOT
   * contain every record at-or-below that seq, so the subsequent tail (which serves
   * only `seq > snapshotSeq`) would NEVER replay the dropped records — a silent gap
   * the seq-contiguity cannot catch (it starts above them). Therefore a truncated
   * snapshot is structurally REFUSED, never applied: `applySnapshotCutover` throws on
   * it and `StoreSnapshotEngine.serveSnapshot` returns `build-truncated` so the caller
   * falls back to a from-genesis tail (the safe, complete path). The flag travels ON
   * the snapshot (not just the serve-result envelope) so the refusal cannot be
   * bypassed by a consumer that consumes a bare `StoreSnapshot`.
   */
  truncated: boolean;
}

/**
 * The minimal journal-entry shape the materializer reads. Matches `JournalEntry`
 * (CoherenceJournal) but typed locally so this module stays import-light and the
 * worker can pass plain objects across the thread boundary. `data` must carry the
 * replicated-record envelope fields (recordKey/hlc/op/origin) — already validated
 * by the applier before they landed; the materializer re-narrows defensively.
 */
export interface RawJournalEntry {
  seq: number;
  ts: string;
  machine: string;
  kind: string;
  data: Record<string, unknown>;
}

/** Input to the (worker-dispatched) pure materializer. */
export interface MaterializeInput {
  /** The store key (advert suffix). */
  store: string;
  /** The single origin (=== serving machine, §6.1) this snapshot is built for. */
  origin: string;
  /**
   * The own-stream entries to materialize, keyed by journal kind. EVERY entry MUST
   * have `entry.machine === origin` (the §6.1 single-origin invariant) — the
   * materializer DROPS (counts) any cross-origin entry rather than trusting it, so
   * a buggy caller cannot smuggle a foreign-origin record into a single-origin
   * snapshot. Within a kind, order does not matter — the materializer resolves by
   * HLC-max per recordKey.
   */
  entriesByKind: Record<string, RawJournalEntry[]>;
  /**
   * The per-kind byte ceiling for the materialized snapshot. A materialization
   * that would exceed it is TRUNCATED deterministically (highest-seq-first kept)
   * and the result is flagged `truncated` — bounded, never an unbounded build
   * (instar#1069). 0/absent ⇒ no per-build truncation (the cache byte ceiling
   * still bounds what is RETAINED).
   */
  maxSnapshotBytes?: number;
}

/** Result of the pure materializer (what the worker posts back). */
export interface MaterializeResult {
  snapshot: StoreSnapshot;
  /** Count of entries dropped for `entry.machine !== origin` (anti-forgery, §6.1). */
  crossOriginDropped: number;
  /** Count of entries dropped for a malformed/missing envelope (defensive re-narrow). */
  malformedDropped: number;
  /** True iff the materialization hit `maxSnapshotBytes` and was truncated. */
  truncated: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Pure materializer (§6.1 + §6.2) — dispatched by the worker, OFF the event loop
// ───────────────────────────────────────────────────────────────────────────

/** Defensive re-narrow of one entry's envelope fields. Returns null to drop. */
function narrowEnvelope(
  data: Record<string, unknown>,
): { recordKey: string; hlc: HlcTimestamp; op: 'put' | 'delete'; origin: string } | null {
  const recordKey = data.recordKey;
  if (typeof recordKey !== 'string' || recordKey.length === 0) return null;
  const op = data.op;
  if (op !== 'put' && op !== 'delete') return null;
  const origin = data.origin;
  if (typeof origin !== 'string' || origin.length === 0) return null;
  let hlc: HlcTimestamp;
  try {
    hlc = coerceHlc(data.hlc);
  } catch {
    // @silent-fallback-ok: a malformed hlc on an entry that already passed the
    // applier's schema is a corrupt on-disk row; the materializer DROPS it
    // (counted as malformedDropped + surfaced in the result) rather than crashing
    // the whole snapshot build. The drop is the safe direction — a record with no
    // total-order position cannot participate in an HLC-max merge.
    return null;
  }
  return { recordKey, hlc, op, origin };
}

/**
 * Materialize a single-origin snapshot (§6.1 + §6.2). PURE — no I/O, no Date, no
 * network. This is the function the worker dispatches to (the heavy walk runs on
 * the worker thread).
 *
 * Algorithm:
 *  1. For every contributing kind, fold the own-stream entries into a per-recordKey
 *     LATEST record (HLC-max via HybridLogicalClock.compare). A cross-origin entry
 *     (`entry.machine !== origin`) is DROPPED + counted — the §6.1 anti-forgery
 *     invariant enforced at materialization, not trusted to the caller.
 *  2. Track the per-(origin,kind) `snapshotSeq` = the highest origin-authored
 *     `entry.seq` reflected (§6.2 — computed from what materialized, cannot lie).
 *  3. Track the per-recordKey delete high-water (§6.5) for the seed.
 *  4. Emit the materialized set (latest per key, deletes tombstoned) + the
 *     watermark vector + the secondary maxHlc.
 *
 * Boundedness (instar#1069): the per-key fold is O(entries); the result is the
 * live key count (≤ entries). `maxSnapshotBytes` deterministically truncates a
 * pathologically-large materialization (highest-seq-first kept).
 */
export function materializeSnapshot(input: MaterializeInput): MaterializeResult {
  const { store, origin, entriesByKind } = input;
  let crossOriginDropped = 0;
  let malformedDropped = 0;

  // recordKey → the winning (highest-HLC) record so far, plus the kind it rode +
  // the seq it came from (for the watermark vector + the delete high-water).
  const winners = new Map<string, { rec: SnapshotRecord }>();
  const kindWatermarks: Record<string, SnapshotKindWatermark> = {};
  const deleteWatermarks: Record<string, HlcTimestamp> = {};
  let maxHlc: HlcTimestamp | null = null;

  for (const [kind, entries] of Object.entries(entriesByKind)) {
    let snapshotSeq = 0;
    for (const entry of entries) {
      // §6.1 ANTI-FORGERY: a single-origin snapshot serves ONLY records the
      // serving machine authored. A cross-origin entry is dropped + counted —
      // never materialized into another origin's snapshot.
      if (entry.machine !== origin) {
        crossOriginDropped++;
        continue;
      }
      const env = narrowEnvelope(entry.data);
      if (env === null) {
        malformedDropped++;
        continue;
      }
      // origin field must also equal the serving machine (defense-in-depth: the
      // envelope `origin` is authoritative, but a row whose data.origin disagrees
      // with entry.machine is corrupt — drop it).
      if (env.origin !== origin) {
        crossOriginDropped++;
        continue;
      }

      // §6.2 watermark: the highest origin-authored seq reflected for this kind.
      if (typeof entry.seq === 'number' && Number.isFinite(entry.seq) && entry.seq > snapshotSeq) {
        snapshotSeq = entry.seq;
      }

      // Track the global max HLC (secondary dedup hint, §6.4).
      if (maxHlc === null || HybridLogicalClock.compare(env.hlc, maxHlc) > 0) {
        maxHlc = env.hlc;
      }

      // Store-specific data = the entry data minus the reserved envelope fields.
      const storeData = stripEnvelopeFields(entry.data);
      const rec: SnapshotRecord = {
        recordKey: env.recordKey,
        hlc: env.hlc,
        op: env.op,
        origin,
        data: storeData,
      };

      const prior = winners.get(env.recordKey);
      if (!prior || HybridLogicalClock.compare(env.hlc, prior.rec.hlc) > 0) {
        winners.set(env.recordKey, { rec });
      }

      // §6.5 delete high-water seed: per key, the highest-HLC delete reflected.
      if (env.op === 'delete') {
        const dw = deleteWatermarks[env.recordKey];
        if (!dw || HybridLogicalClock.compare(env.hlc, dw) > 0) {
          deleteWatermarks[env.recordKey] = env.hlc;
        }
      }
    }
    kindWatermarks[kind] = { snapshotSeq };
  }

  // A delete-watermark entry is only meaningful while the WINNING record for that
  // key is still the tombstone (a later put for the same key — a legitimate
  // re-create — supersedes it and clears the high-water seed; the always-on
  // receiver guard re-derives the live floor, §6.5 guard 1). Clear a seed whose
  // winner is now a put with a strictly-greater HLC.
  for (const [key, dw] of Object.entries(deleteWatermarks)) {
    const w = winners.get(key);
    if (w && w.rec.op === 'put' && HybridLogicalClock.compare(w.rec.hlc, dw) > 0) {
      delete deleteWatermarks[key];
    }
  }

  // Emit the materialized records (deterministic order: by recordKey for stable
  // serialization → stable cache key bytes).
  let records: SnapshotRecord[] = [...winners.values()]
    .map((w) => w.rec)
    .sort((a, b) => (a.recordKey < b.recordKey ? -1 : a.recordKey > b.recordKey ? 1 : 0));

  // Deterministic byte-bounded truncation (instar#1069): if the materialized set
  // exceeds maxSnapshotBytes, keep the highest-HLC records first and FLAG truncated.
  // We deliberately keep the FULL watermark (we do NOT lower snapshotSeq) — lowering
  // it to match the kept records is impossible to do correctly across a multi-kind
  // vector. Instead, `truncated` is a HARD REFUSAL signal, NOT a "partial is fine"
  // hint: StoreSnapshotEngine.serveSnapshot returns `build-truncated` (never caches
  // or serves it) and applySnapshotCutover THROWS on a truncated snapshot — so a
  // truncated build can never seed `lastHeldSeq` past the dropped records (the silent
  // sub-watermark gap trap). The caller falls back to a from-genesis tail; the real
  // fix is a store whose materialized state fits its bound (§8 retention).
  let truncated = false;
  const cap = input.maxSnapshotBytes ?? 0;
  if (cap > 0) {
    const full = Buffer.byteLength(JSON.stringify(records), 'utf-8');
    if (full > cap) {
      truncated = true;
      // Keep highest-HLC records until the cap; the rest are excluded from THIS
      // build. The caller treats `truncated` as "this store is too large to
      // snapshot under the current cap" — a bounded, surfaced condition, never a
      // silent partial.
      const byHlcDesc = [...records].sort((a, b) => HybridLogicalClock.compare(b.hlc, a.hlc));
      const kept: SnapshotRecord[] = [];
      let bytes = 2; // "[]"
      for (const r of byHlcDesc) {
        const rb = Buffer.byteLength(JSON.stringify(r), 'utf-8') + 1;
        if (kept.length > 0 && bytes + rb > cap) break;
        kept.push(r);
        bytes += rb;
      }
      records = kept.sort((a, b) => (a.recordKey < b.recordKey ? -1 : a.recordKey > b.recordKey ? 1 : 0));
    }
  }

  const watermark: SnapshotWatermark = {
    origin,
    kinds: kindWatermarks,
    maxHlc: maxHlc ?? { physical: 0, logical: 0, node: origin },
  };

  const sizeBytes = Buffer.byteLength(JSON.stringify(records), 'utf-8');
  const snapshot: StoreSnapshot = {
    store,
    origin,
    records,
    watermark,
    deleteWatermarks,
    sizeBytes,
    truncated,
  };

  return { snapshot, crossOriginDropped, malformedDropped, truncated };
}

/** The reserved replicated-record envelope field names (kept local to avoid a
 *  cyclic import with ReplicatedRecordEnvelope; asserted equal by a unit test). */
const RESERVED_ENVELOPE_FIELDS = ['recordKey', 'hlc', 'op', 'origin', 'observed'] as const;

/** Return the store-specific portion of a journal `data` (envelope fields stripped). */
function stripEnvelopeFields(data: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set<string>(RESERVED_ENVELOPE_FIELDS);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!reserved.has(k)) out[k] = v;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Snapshot cache — a FIXED-ceiling LRU ring (§8.2)
// ───────────────────────────────────────────────────────────────────────────

/** A cache key (§8.2): keyed by (origin, store, maxHlc). Deterministic string. */
export function snapshotCacheKey(origin: string, store: string, maxHlc: HlcTimestamp): string {
  return `${origin} ${store} ${serializeHlcKey(maxHlc)}`;
}

interface CacheEntry {
  key: string;
  snapshot: StoreSnapshot;
  /** Monotonic access tick for LRU (set on insert + on every get). */
  lastUsed: number;
}

/**
 * The snapshot cache — a FIXED-ceiling ring (§8.2), NOT pool-size-scaled. Bounded
 * by BOTH `maxCachedSnapshots` (count) AND `maxCacheBytes` (bytes), whichever
 * binds first; LRU eviction with a monotonic `cacheLossCounter` (mirroring the
 * quarantine ring's lossCounter). An evicted snapshot is just rebuilt on next
 * demand (breaker-gated, §6.3) — eviction is a recompute, never a correctness
 * loss; the counter makes the recompute visible in degradation.
 *
 * A stale entry (its source stream advanced past the cached maxHlc) is dropped on
 * the next put for the same (origin, store) — the cache key embeds maxHlc, so a
 * fresher build is a DIFFERENT key; `invalidateOlder` drops the superseded ones.
 */
export class SnapshotCache {
  private readonly maxCount: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, CacheEntry>();
  private clock = 0;
  private bytes = 0;
  private _cacheLossCounter = 0;

  constructor(opts: { maxCachedSnapshots: number; maxCacheBytes: number }) {
    if (!(opts.maxCachedSnapshots > 0)) throw new Error('SnapshotCache: maxCachedSnapshots must be > 0');
    if (!(opts.maxCacheBytes > 0)) throw new Error('SnapshotCache: maxCacheBytes must be > 0');
    this.maxCount = Math.floor(opts.maxCachedSnapshots);
    this.maxBytes = Math.floor(opts.maxCacheBytes);
  }

  /** Monotonic count of LRU evictions (§8.2 — surfaced in degradation). */
  get cacheLossCounter(): number {
    return this._cacheLossCounter;
  }

  /** Current live entry count. */
  get size(): number {
    return this.entries.size;
  }

  /** Current total cached bytes. */
  get byteSize(): number {
    return this.bytes;
  }

  /** Get a cached snapshot by key (refreshes its LRU position). */
  get(key: string): StoreSnapshot | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    e.lastUsed = ++this.clock;
    return e.snapshot;
  }

  /**
   * Put a freshly-built snapshot. Drops any STALE entry for the same (origin,
   * store) whose maxHlc is older than this one (the source stream advanced past
   * it, §8.2) — those are superseded, not LRU-evicted (no lossCounter bump). Then
   * enforces the count + byte ceilings via LRU eviction (lossCounter bumped).
   */
  put(snapshot: StoreSnapshot): void {
    const key = snapshotCacheKey(snapshot.origin, snapshot.store, snapshot.watermark.maxHlc);
    // Idempotent re-put: replace in place (refresh bytes + LRU).
    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.snapshot.sizeBytes;
      existing.snapshot = snapshot;
      existing.lastUsed = ++this.clock;
      this.bytes += snapshot.sizeBytes;
    } else {
      // Drop superseded entries for the same (origin, store) with an OLDER maxHlc.
      this.invalidateOlder(snapshot);
      this.entries.set(key, { key, snapshot, lastUsed: ++this.clock });
      this.bytes += snapshot.sizeBytes;
    }
    this.evictToBounds();
  }

  /** Drop cached entries for the same (origin, store) with a strictly-older maxHlc. */
  private invalidateOlder(fresh: StoreSnapshot): void {
    for (const [k, e] of this.entries) {
      if (e.snapshot.origin === fresh.origin && e.snapshot.store === fresh.store) {
        if (HybridLogicalClock.compare(e.snapshot.watermark.maxHlc, fresh.watermark.maxHlc) < 0) {
          this.bytes -= e.snapshot.sizeBytes;
          this.entries.delete(k);
          // NOT a loss — superseded by a fresher build for the same target, not
          // an LRU eviction. A subsequent demand uses the fresher entry.
        }
      }
    }
  }

  /** Evict LRU entries until BOTH the count and byte ceilings hold (§8.2). */
  private evictToBounds(): void {
    while (this.entries.size > this.maxCount || this.bytes > this.maxBytes) {
      // Find the LRU entry.
      let lru: CacheEntry | null = null;
      for (const e of this.entries.values()) {
        if (lru === null || e.lastUsed < lru.lastUsed) lru = e;
      }
      if (lru === null) break;
      this.bytes -= lru.snapshot.sizeBytes;
      this.entries.delete(lru.key);
      this._cacheLossCounter++;
    }
  }

  /** Iterate cached snapshots for a given (origin, store) — bounded by maxCount.
   *  Does NOT touch LRU (a read-only scan; the caller touches LRU on a real serve). */
  *entriesFor(origin: string, store: string): Iterable<StoreSnapshot> {
    for (const e of this.entries.values()) {
      if (e.snapshot.origin === origin && e.snapshot.store === store) yield e.snapshot;
    }
  }

  /** Drop ALL cached entries for an origin (the §7.4 rollback-unmerge hook). */
  dropOrigin(origin: string): void {
    for (const [k, e] of this.entries) {
      if (e.snapshot.origin === origin) {
        this.bytes -= e.snapshot.sizeBytes;
        this.entries.delete(k);
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Per-peer rebuild breaker (§6.3) — bounds snapshot-build storms
// ───────────────────────────────────────────────────────────────────────────

/** Options for the rebuild breaker (§6.3 minimum-rebuild window + frequency cap). */
export interface RebuildBreakerOptions {
  /** Minimum ms between actual rebuilds for one (peer, origin, store) — a flapping
   *  peer is served the CACHED snapshot within this window. Default 30s. */
  minRebuildIntervalMs?: number;
  /** Max rebuilds allowed within `windowMs` before the breaker trips. Default 5. */
  maxRebuildsPerWindow?: number;
  /** The rolling window for the frequency cap. Default 5min. */
  windowMs?: number;
  /** How long the breaker stays tripped once it fires. Default 1min. */
  cooldownMs?: number;
}

/** A rebuild decision (§6.3): allow a fresh build, or serve the cache / refuse. */
export type RebuildDecision =
  | { allow: true }
  | { allow: false; reason: 'within-min-interval' | 'breaker-open'; serveCache: boolean };

/**
 * Per-peer snapshot-build-frequency breaker (§6.3). Prevents rebuild storms from a
 * flapping peer: within `minRebuildIntervalMs` the cached snapshot is served; more
 * than `maxRebuildsPerWindow` actual rebuilds in `windowMs` trips a breaker that
 * stays open for `cooldownMs`. Bounded (No-Unbounded-Loops). PURE-ish: the clock
 * is injected so it is unit-testable across simulated windows.
 *
 * Keyed by (peer, origin, store) so one peer flapping on store A does not throttle
 * its store-B rebuilds, and two peers requesting the same snapshot are independent.
 */
export class SnapshotRebuildBreaker {
  private readonly minIntervalMs: number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  /** Per key: the recent rebuild timestamps (bounded by the window) + breaker state.
   *  `lastRebuildAt === null` means "never rebuilt" — distinct from a real now()=0
   *  timestamp, so the min-interval check is correct even when the clock starts at 0. */
  private readonly state = new Map<string, { rebuilds: number[]; openUntil: number; lastRebuildAt: number | null }>();

  constructor(opts: RebuildBreakerOptions & { now: () => number }) {
    this.minIntervalMs = opts.minRebuildIntervalMs ?? 30_000;
    this.maxPerWindow = opts.maxRebuildsPerWindow ?? 5;
    this.windowMs = opts.windowMs ?? 5 * 60_000;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now;
  }

  private keyOf(peer: string, origin: string, store: string): string {
    return `${peer} ${origin} ${store}`;
  }

  /**
   * Decide whether a fresh rebuild is allowed RIGHT NOW for (peer, origin, store).
   * Returns `{ allow: true }` to build; otherwise a refusal with `serveCache`
   * (true = serve the cached snapshot instead of building). This does NOT record
   * the rebuild — call `recordRebuild()` after an ACTUAL build completes, so a
   * cache-served request never counts against the frequency cap.
   */
  shouldRebuild(peer: string, origin: string, store: string): RebuildDecision {
    const key = this.keyOf(peer, origin, store);
    const now = this.now();
    const s = this.state.get(key);
    if (!s) return { allow: true };

    // Breaker open?
    if (s.openUntil > now) {
      return { allow: false, reason: 'breaker-open', serveCache: true };
    }

    // Minimum-rebuild window: within it, serve the cache.
    if (s.lastRebuildAt !== null && now - s.lastRebuildAt < this.minIntervalMs) {
      return { allow: false, reason: 'within-min-interval', serveCache: true };
    }

    // Frequency cap: prune the window, then check.
    const recent = s.rebuilds.filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxPerWindow) {
      // Trip the breaker.
      s.openUntil = now + this.cooldownMs;
      s.rebuilds = recent;
      this.state.set(key, s);
      return { allow: false, reason: 'breaker-open', serveCache: true };
    }

    return { allow: true };
  }

  /** Record that an actual rebuild completed for (peer, origin, store). */
  recordRebuild(peer: string, origin: string, store: string): void {
    const key = this.keyOf(peer, origin, store);
    const now = this.now();
    const s = this.state.get(key) ?? { rebuilds: [], openUntil: 0, lastRebuildAt: null };
    s.rebuilds = s.rebuilds.filter((t) => now - t < this.windowMs);
    s.rebuilds.push(now);
    s.lastRebuildAt = now;
    this.state.set(key, s);
  }

  /** Is the breaker currently open for (peer, origin, store)? (for tests/observability). */
  isOpen(peer: string, origin: string, store: string): boolean {
    const s = this.state.get(this.keyOf(peer, origin, store));
    return !!s && s.openUntil > this.now();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The cutover apply path (§6.3 + §6.4 + §6.5) — the receiver side
// ───────────────────────────────────────────────────────────────────────────

/**
 * The receiver-side seams the cutover needs from the existing applier — injected
 * so the cutover is unit-testable with in-memory fakes and never duplicates the
 * applier's seq-contiguity logic (§6.3: "rides the EXISTING seq transport"). The
 * real wiring binds these to JournalSyncApplier's PeerMeta + buildServeBatch.
 */
export interface CutoverApplierSeams {
  /**
   * Apply ONE materialized snapshot record into store S's (origin M) replicated
   * namespace via a per-recordKey HLC-max merge (§6.3 step 3). Returns whether the
   * record landed as the new winner (false = an already-present newer record was
   * not overwritten — idempotent). A `put` whose hlc is below the deleted-keys
   * high-water for its key is the receiver's resurrection-drop (§6.5 guard 1) and
   * returns false.
   */
  applySnapshotRecord(store: string, origin: string, rec: SnapshotRecord): boolean;
  /**
   * SEED, per contributing (origin, kind) stream, `PeerMeta.kinds[kind].lastHeldSeq
   * = snapshotSeq` (§6.3 step 3 — the load-bearing cursor placement). Idempotent:
   * re-seeding to the same seq is a no-op; the real applier never LOWERS a
   * lastHeldSeq it already advanced past (a re-cutover with a stale snapshot does
   * not rewind the cursor).
   */
  seedLastHeldSeq(origin: string, kind: string, snapshotSeq: number): void;
  /**
   * Seed the per-recordKey deleted-keys high-water from the snapshot (§6.5). The
   * receiver MERGES (HLC-max) — never lowers an existing high-water.
   */
  seedDeleteWatermark(store: string, origin: string, recordKey: string, hlc: HlcTimestamp): void;
  /**
   * Record an HLC-identity (recordKey, origin, hlc) as already-merged (the §6.4
   * SECONDARY dedup set). Returns whether the identity was NEW (false = already
   * seen ⇒ the caller drops the duplicate). This is a redundant safety net layered
   * ON the seq contiguity, never a substitute for it.
   */
  recordHlcIdentity(store: string, recordKey: string, origin: string, hlc: HlcTimestamp): boolean;
}

/** The verdict for one applied snapshot record (for the cutover result tally). */
export interface CutoverApplyTally {
  /** Records that landed as the new winner. */
  applied: number;
  /** Records skipped as an HLC-identity duplicate (the §6.4 secondary net). */
  dedupSkipped: number;
  /** Records the applier did not land (older than the present winner, or a
   *  resurrection drop — §6.5). */
  notWinner: number;
}

/**
 * Apply a single-origin snapshot at cutover (§6.3 steps 3–5 + §6.4 + §6.5). This
 * is the load-bearing seam: it (a) applies each record via HLC-max merge through
 * the injected applier, (b) seeds the deleted-keys high-water from the snapshot,
 * (c) seeds `lastHeldSeq = snapshotSeq` per contributing kind so the NEXT ordinary
 * tail is already in-contiguity, and (d) uses the §6.4 secondary HLC-identity set
 * as a belt-and-suspenders dedup.
 *
 * It does NOT do the tail — that is the UNCHANGED `buildServeBatch(kind,
 * snapshotSeq, M)` path the caller drives next. There is NO gap-detection here;
 * the seq contiguity already there does the work (§6.3 step 4).
 *
 * Idempotency (§6.3 step 5): re-running is safe — re-seeding the cursor to the
 * same snapshotSeq + re-applying is a per-recordKey HLC-max merge (an
 * already-present newer record is not overwritten) and the seq tail drops
 * at-or-below entries as duplicates.
 *
 * PURE-ish: all state mutation is funnelled through the injected seams.
 */
export function applySnapshotCutover(
  snapshot: StoreSnapshot,
  seams: CutoverApplierSeams,
): CutoverApplyTally {
  // STRUCTURAL REFUSAL of a truncated snapshot (the sub-watermark gap trap, §6.3):
  // a truncated snapshot seeds the full `snapshotSeq` but is MISSING records
  // at-or-below it, so seeding `lastHeldSeq = snapshotSeq` + tailing `seq >
  // snapshotSeq` would silently never replay them — a gap the seq-contiguity cannot
  // catch. A truncated snapshot must NEVER be applied; the caller falls back to a
  // from-genesis tail. We throw (a programmer error: serveSnapshot already refuses a
  // truncated build, so a truncated snapshot should never reach the cutover) rather
  // than silently under-seed — the loud, safe direction.
  if (snapshot.truncated) {
    throw new Error(
      `applySnapshotCutover: refusing a TRUNCATED snapshot for store="${snapshot.store}" origin="${snapshot.origin}" — ` +
      `applying it would seed lastHeldSeq past dropped records and create a silent sub-watermark gap. ` +
      `The caller must fall back to a from-genesis tail (StoreSnapshotEngine.serveSnapshot returns 'build-truncated').`,
    );
  }
  const tally: CutoverApplyTally = { applied: 0, dedupSkipped: 0, notWinner: 0 };

  // (b) Seed the deleted-keys high-water FIRST (§6.5) so a put record in the same
  // snapshot that is below a delete high-water is dropped as a resurrection by the
  // applier's guard during step (a).
  for (const [recordKey, hlc] of Object.entries(snapshot.deleteWatermarks)) {
    seams.seedDeleteWatermark(snapshot.store, snapshot.origin, recordKey, hlc);
  }

  // (a) Apply each materialized record via HLC-max merge, with the §6.4 secondary
  // HLC-identity dedup as a belt-and-suspenders net.
  for (const rec of snapshot.records) {
    const isNew = seams.recordHlcIdentity(snapshot.store, rec.recordKey, rec.origin, rec.hlc);
    if (!isNew) {
      tally.dedupSkipped++;
      continue;
    }
    const landed = seams.applySnapshotRecord(snapshot.store, snapshot.origin, rec);
    if (landed) tally.applied++;
    else tally.notWinner++;
  }

  // (c) Seed lastHeldSeq = snapshotSeq per contributing (origin, kind) stream —
  // the load-bearing cursor placement (§6.3 step 3) so the next tail is contiguous.
  for (const [kind, wm] of Object.entries(snapshot.watermark.kinds)) {
    seams.seedLastHeldSeq(snapshot.origin, kind, wm.snapshotSeq);
  }

  return tally;
}

/**
 * Compute the tail request cursor for a contributing (origin, kind) AFTER a
 * cutover (§6.3 step 4). The tail rides the UNCHANGED transport:
 * `buildServeBatch(kind, snapshotSeq, origin)`. This helper is the single place
 * that names the contract — the cursor is the snapshot's per-kind `snapshotSeq`,
 * NOTHING HLC-derived (HLC is demoted to secondary dedup, §6.4).
 */
export function tailCursorAfterCutover(snapshot: StoreSnapshot, kind: string): number {
  return snapshot.watermark.kinds[kind]?.snapshotSeq ?? 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Wire serialization (the mesh verb carries these) — bounded, validated
// ───────────────────────────────────────────────────────────────────────────

/** Validate + narrow an untrusted wire snapshot (the receiver side of the mesh
 *  verb). Returns null to REJECT the whole snapshot (single-origin violated, a
 *  malformed record, etc.) — the §6.1 anti-forgery + §6.2 format gate at the door.
 *  `expectedOrigin` is the AUTHENTICATED sender (the mesh layer proved it); a
 *  snapshot whose `origin` or any record `origin` disagrees is rejected wholesale
 *  (the cross-origin-snapshot attack, §6.1). */
export function validateWireSnapshot(raw: unknown, expectedOrigin: string): StoreSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.store !== 'string' || o.store.length === 0) return null;
  if (typeof o.origin !== 'string' || o.origin.length === 0) return null;
  // §6.1: single-origin — origin MUST equal the authenticated sender.
  if (o.origin !== expectedOrigin) return null;
  if (!Array.isArray(o.records)) return null;

  const records: SnapshotRecord[] = [];
  for (const r of o.records) {
    if (!r || typeof r !== 'object') return null;
    const rr = r as Record<string, unknown>;
    if (typeof rr.recordKey !== 'string' || rr.recordKey.length === 0) return null;
    if (rr.op !== 'put' && rr.op !== 'delete') return null;
    // §6.1 anti-forgery: EVERY record's origin MUST equal the serving machine. A
    // single foreign-origin record rejects the WHOLE snapshot (quarantined as
    // untrusted-origin by the caller) — never landed.
    if (rr.origin !== expectedOrigin) return null;
    let hlc: HlcTimestamp;
    try {
      hlc = coerceHlc(rr.hlc);
    } catch { /* @silent-fallback-ok: a malformed hlc on an UNTRUSTED wire record REJECTS the whole snapshot (return null → the caller quarantines it as untrusted-origin/malformed, §6.1) — the safe direction; nothing is silently defaulted or applied. */
      return null;
    }
    const data = rr.data && typeof rr.data === 'object' && !Array.isArray(rr.data)
      ? (rr.data as Record<string, unknown>)
      : {};
    records.push({ recordKey: rr.recordKey, hlc, op: rr.op, origin: expectedOrigin, data: stripEnvelopeFields(data) });
  }

  // Watermark.
  const wmRaw = o.watermark;
  if (!wmRaw || typeof wmRaw !== 'object') return null;
  const wm = wmRaw as Record<string, unknown>;
  if (wm.origin !== expectedOrigin) return null;
  const kindsRaw = wm.kinds;
  if (!kindsRaw || typeof kindsRaw !== 'object') return null;
  const kinds: Record<string, SnapshotKindWatermark> = {};
  for (const [k, v] of Object.entries(kindsRaw as Record<string, unknown>)) {
    const vv = v as Record<string, unknown>;
    if (!vv || typeof vv.snapshotSeq !== 'number' || !Number.isFinite(vv.snapshotSeq) || vv.snapshotSeq < 0) return null;
    kinds[k] = { snapshotSeq: vv.snapshotSeq };
  }
  let maxHlc: HlcTimestamp;
  try {
    maxHlc = coerceHlc(wm.maxHlc);
  } catch { /* @silent-fallback-ok: a malformed watermark maxHlc on an UNTRUSTED wire snapshot REJECTS the whole snapshot (return null) — the safe direction; never a silent default. */
    return null;
  }

  // Delete watermarks.
  const dwRaw = o.deleteWatermarks;
  const deleteWatermarks: Record<string, HlcTimestamp> = {};
  if (dwRaw && typeof dwRaw === 'object' && !Array.isArray(dwRaw)) {
    for (const [k, v] of Object.entries(dwRaw as Record<string, unknown>)) {
      try {
        deleteWatermarks[k] = coerceHlc(v);
      } catch { /* @silent-fallback-ok: a malformed delete-watermark hlc on an UNTRUSTED wire snapshot REJECTS the whole snapshot (return null) — the safe direction; never a silent default. */
        return null;
      }
    }
  }

  const sizeBytes = Buffer.byteLength(JSON.stringify(records), 'utf-8');
  // Preserve the truncated flag off the wire (a holder that built a truncated
  // snapshot must NOT have served it — serveSnapshot refuses build-truncated — but
  // we carry the flag honestly so applySnapshotCutover's structural refusal is the
  // backstop even against a buggy/old holder that serves one anyway).
  const truncated = o.truncated === true;
  return { store: o.store, origin: expectedOrigin, records, watermark: { origin: expectedOrigin, kinds, maxHlc }, deleteWatermarks, sizeBytes, truncated };
}

// ───────────────────────────────────────────────────────────────────────────
// StoreSnapshotEngine — orchestrates build OFF the event loop + cache + breaker
// ───────────────────────────────────────────────────────────────────────────

/** Result of a snapshot-serve request (§6.3): the snapshot + how it was produced. */
export type SnapshotServeResult =
  | { ok: true; snapshot: StoreSnapshot; source: 'built' | 'cache'; durationMs: number; truncated: false }
  | { ok: false; reason: 'breaker-open' | 'build-failed' | 'build-timeout' | 'no-entries' | 'build-truncated'; durationMs: number };

/** The seams the engine needs to LOAD a store's own-stream entries (injected so
 *  the engine is testable without touching disk; the real wiring reads the
 *  CoherenceJournal own streams for the contributing kinds). */
export interface SnapshotEngineSeams {
  /** Load the own-stream entries for (origin, store), keyed by contributing kind.
   *  The caller (real wiring) returns ONLY this machine's own entries (single-
   *  origin, §6.1); the materializer ALSO enforces it (drops cross-origin). */
  loadOwnEntries(store: string, origin: string): Record<string, RawJournalEntry[]>;
  /** Injected wall clock (ms) — for the breaker + duration. */
  now(): number;
}

/** Engine construction options. */
export interface StoreSnapshotEngineOptions {
  cache: SnapshotCache;
  breaker: SnapshotRebuildBreaker;
  seams: SnapshotEngineSeams;
  /** Per-build worker timeout (ms). Default 120s (mirrors CartographerSweepEngine). */
  buildTimeoutMs?: number;
  /** Worker heap ceiling (MB). Default 1536 (mirrors CartographerSweepEngine). */
  workerHeapMb?: number;
  /** The per-build snapshot byte ceiling passed to the materializer (deterministic
   *  truncation). Default 0 ⇒ no per-build truncation (cache byte ceiling still
   *  bounds retention). */
  maxSnapshotBytes?: number;
  /** Optional structured logger for build observability (default no-op). */
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** Test seam: run the materializer INLINE instead of spawning a worker (the unit
   *  tests assert the cache/breaker orchestration without a real thread). Default
   *  false ⇒ the real off-event-loop worker is spawned (the instar#1069 path). */
  runInline?: boolean;
}

/**
 * StoreSnapshotEngine — the §6.3 serve orchestrator. For a (peer, origin, store)
 * request it:
 *   1. asks the rebuild breaker whether a fresh build is allowed (a flapping peer
 *      is served the cached snapshot; a tripped breaker refuses — §6.3),
 *   2. on a build: loads the own-stream entries (single-origin), runs the
 *      materializer OFF THE EVENT LOOP in a worker thread (instar#1069), bounded
 *      by `buildTimeoutMs`, caches the result (LRU + cacheLossCounter, §8.2), and
 *      records the rebuild against the breaker,
 *   3. on a within-window / breaker-open decision: serves the cached snapshot if
 *      present, else refuses (the caller falls back / retries later).
 *
 * The HEAVY work (whole-store materialization) is the worker's; the engine itself
 * does only bounded orchestration on the main thread.
 */
export class StoreSnapshotEngine {
  private readonly cache: SnapshotCache;
  private readonly breaker: SnapshotRebuildBreaker;
  private readonly seams: SnapshotEngineSeams;
  private readonly buildTimeoutMs: number;
  private readonly workerHeapMb: number;
  private readonly maxSnapshotBytes: number;
  private readonly log: (event: string, detail: Record<string, unknown>) => void;
  private readonly runInline: boolean;

  constructor(opts: StoreSnapshotEngineOptions) {
    this.cache = opts.cache;
    this.breaker = opts.breaker;
    this.seams = opts.seams;
    this.buildTimeoutMs = opts.buildTimeoutMs ?? 120_000;
    this.workerHeapMb = opts.workerHeapMb ?? 1536;
    this.maxSnapshotBytes = opts.maxSnapshotBytes ?? 0;
    this.log = opts.log ?? (() => {});
    this.runInline = opts.runInline === true;
  }

  /** The snapshot cache (for observability / the rollback-unmerge dropOrigin hook). */
  getCache(): SnapshotCache {
    return this.cache;
  }

  /**
   * Serve a single-origin snapshot of (origin, store) to `peer` (§6.3). Builds off
   * the event loop, reuses the cache within the rebuild window, breaker-gated.
   */
  async serveSnapshot(peer: string, origin: string, store: string): Promise<SnapshotServeResult> {
    const started = this.seams.now();
    const decision = this.breaker.shouldRebuild(peer, origin, store);
    if (!decision.allow) {
      // Serve the cached snapshot if we have one (§6.3 flapping-peer reuse).
      if (decision.serveCache) {
        const cached = this.mostRecentCached(origin, store);
        if (cached) {
          return { ok: true, snapshot: cached, source: 'cache', durationMs: this.seams.now() - started, truncated: false };
        }
      }
      // No cache to serve + a tripped breaker ⇒ refuse (bounded; the caller retries).
      if (decision.reason === 'breaker-open') {
        return { ok: false, reason: 'breaker-open', durationMs: this.seams.now() - started };
      }
      // within-min-interval but no cache yet (first request in the window) — fall
      // through to a build (we have nothing to serve and the breaker is not open).
    }

    const entriesByKind = this.seams.loadOwnEntries(store, origin);
    const total = Object.values(entriesByKind).reduce((n, arr) => n + arr.length, 0);
    if (total === 0) {
      return { ok: false, reason: 'no-entries', durationMs: this.seams.now() - started };
    }

    const input: MaterializeInput = {
      store,
      origin,
      entriesByKind,
      ...(this.maxSnapshotBytes > 0 ? { maxSnapshotBytes: this.maxSnapshotBytes } : {}),
    };

    const built = await this.runBuild(input);
    if (!built.ok) {
      this.log('snapshot-build-failed', { store, origin, peer, reason: built.reason });
      return { ok: false, reason: built.reason, durationMs: this.seams.now() - started };
    }

    // STRUCTURAL REFUSAL of a truncated build (the sub-watermark gap trap, §6.3):
    // a truncated snapshot would seed lastHeldSeq past dropped records — a silent
    // gap. We do NOT cache it and do NOT serve it; the caller falls back to a
    // from-genesis tail (the complete path). We DO record the rebuild against the
    // breaker (a build happened — its cost is real, and an immediate retry would
    // re-truncate), and surface the condition loudly. The structural answer is the
    // store's per-kind retention bound (§8): a store whose materialized state
    // exceeds maxSnapshotBytes is mis-bounded and must shrink its window, not be
    // served a silent partial.
    if (built.result.truncated) {
      this.breaker.recordRebuild(peer, origin, store);
      this.log('snapshot-build-truncated', {
        store,
        origin,
        peer,
        recordCount: built.result.snapshot.records.length,
        sizeBytes: built.result.snapshot.sizeBytes,
      });
      return { ok: false, reason: 'build-truncated', durationMs: this.seams.now() - started };
    }

    this.cache.put(built.result.snapshot);
    this.breaker.recordRebuild(peer, origin, store);
    if (built.result.crossOriginDropped > 0) {
      this.log('snapshot-build-anomaly', {
        store,
        origin,
        crossOriginDropped: built.result.crossOriginDropped,
        malformedDropped: built.result.malformedDropped,
      });
    }
    return {
      ok: true,
      snapshot: built.result.snapshot,
      source: 'built',
      durationMs: this.seams.now() - started,
      truncated: false,
    };
  }

  /** The most-recent cached snapshot for (origin, store), if any. */
  private mostRecentCached(origin: string, store: string): StoreSnapshot | undefined {
    // The cache key embeds maxHlc; the cache.invalidateOlder already keeps only the
    // freshest per (origin, store). Scan for a match (bounded by maxCachedSnapshots).
    // We re-build the key from a probe is impossible (we don't know maxHlc), so we
    // scan — the cache holds at most maxCachedSnapshots entries.
    let best: StoreSnapshot | undefined;
    // SnapshotCache does not expose iteration; we add a helper there. Use it:
    for (const snap of this.cache.entriesFor(origin, store)) {
      if (!best || HybridLogicalClock.compare(snap.watermark.maxHlc, best.watermark.maxHlc) > 0) {
        best = snap;
      }
    }
    if (best) {
      // Touch its LRU position via a get on the canonical key.
      this.cache.get(snapshotCacheKey(best.origin, best.store, best.watermark.maxHlc));
    }
    return best;
  }

  /** Run the materializer — off the event loop (worker), or inline for tests. */
  private async runBuild(
    input: MaterializeInput,
  ): Promise<{ ok: true; result: MaterializeResult } | { ok: false; reason: 'build-failed' | 'build-timeout' }> {
    if (this.runInline) {
      try {
        return { ok: true, result: materializeSnapshot(input) };
      } catch {
        return { ok: false, reason: 'build-failed' };
      }
    }
    return this.runWorker(input);
  }

  /** Minimal env allowlist for a spawned worker — NEVER the parent process.env. */
  private workerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    return env;
  }

  /** Spawn the build worker, await its single message, bound by buildTimeoutMs. */
  private runWorker(
    input: MaterializeInput,
  ): Promise<{ ok: true; result: MaterializeResult } | { ok: false; reason: 'build-failed' | 'build-timeout' }> {
    const heapMb = this.workerHeapMb;
    const timeoutMs = this.buildTimeoutMs;
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        const workerUrl = new URL('./storeSnapshotBuild.worker.js', import.meta.url);
        worker = new Worker(workerUrl, {
          workerData: input,
          resourceLimits: { maxOldGenerationSizeMb: heapMb },
          env: this.workerEnv(),
        });
      } catch {
        resolve({ ok: false, reason: 'build-failed' });
        return;
      }
      let settled = false;
      const done = (r: { ok: true; result: MaterializeResult } | { ok: false; reason: 'build-failed' | 'build-timeout' }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => { /* best-effort reap */ });
        resolve(r);
      };
      const timer = setTimeout(() => done({ ok: false, reason: 'build-timeout' }), timeoutMs);
      worker.once('message', (msg: { ok: boolean; result?: MaterializeResult; error?: string }) => {
        if (msg.ok && msg.result) done({ ok: true, result: msg.result });
        else done({ ok: false, reason: 'build-failed' });
      });
      worker.once('error', () => done({ ok: false, reason: 'build-failed' }));
      worker.once('exit', () => { if (!settled) done({ ok: false, reason: 'build-failed' }); });
    });
  }
}
