/**
 * ConflictStore — the durable open-conflicts ledger + operator resolution path
 * (WS2 replicated-store foundation, §7.2 append-both lifecycle + §7.3 resolution
 * delegated UP).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §7.2 (idempotent
 * append-both on (recordKey, version-pair), ONE deduped attention item,
 * recurrence past a threshold → forced operator resolution), §7.3 (the operator
 * designates a winner / supplies a merged version; the foundation NEVER picks a
 * winner — Signal vs Authority), §7.4 (a conflictId whose version-pair referenced
 * a dropped origin auto-RESOLVES + its attention item closes).
 *
 * SIGNAL vs AUTHORITY (§11): this store DETECTS + records + surfaces conflicts; it
 * NEVER picks a winner. The one mutating authority — resolveConflict — is
 * operator-driven (the route is Bearer-authenticated upstream). Recording is
 * idempotent on the stable conflictId, so re-discovering the same unresolved
 * conflict never appends a third copy and the attention surface dedupes.
 *
 * Persistence: the open-conflicts ledger is a single JSON document written
 * atomically (SafeFsExecutor.atomicWriteJsonSync) to
 * `<stateDir>/state/state-sync/conflicts.json`, so it survives restarts +
 * compaction. Bounded: a per-store cap on simultaneously-open conflicts (oldest
 * evicted with a loss counter) keeps a flood from unbounded growth.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SafeFsExecutor } from './SafeFsExecutor.js';
import { serializeHlcKey, type HlcTimestamp } from './HybridLogicalClock.js';
import type { ConflictDescriptor, OriginRecord } from './UnionReader.js';

/** Default recurrence threshold past which an open conflict is forced to the
 *  operator (§7.2). The conflict re-surfaces past this many independent
 *  re-discoveries while still unresolved. */
export const DEFAULT_CONFLICT_RECURRENCE_THRESHOLD = 5;
/** Default cap on simultaneously-open conflicts in the ledger (bounded growth);
 *  oldest-first eviction with a loss counter on overflow. */
export const DEFAULT_MAX_OPEN_CONFLICTS = 500;

/** One open conflict's durable lifecycle record (§7.2/§7.3). */
export interface ConflictLedgerEntry {
  conflictId: string;
  store: string;
  recordKey: string;
  /** Each preserved version's (origin, hlc-key) — content-free routing facts +
   *  the total-order stamp, never the store payload (kept off the durable ledger;
   *  the live versions are re-derivable from the union reader). */
  versions: { origin: string; hlcKey: string }[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** Independent re-discoveries while unresolved — drives forced-resolution. */
  recurrenceCount: number;
  /** True once recurrenceCount crosses the threshold (§7.2). */
  forcedResolution: boolean;
  /** Set when the operator resolves (§7.3) or the rollback auto-resolves (§7.4). */
  resolved: boolean;
  resolvedAt?: string;
  resolution?: 'operator-winner' | 'operator-merged' | 'origin-dropped';
  /** The origin the operator designated as winner (operator-winner only). */
  winnerOrigin?: string;
}

/** What the operator supplies at /state/resolve-conflict (§7.3). EXACTLY ONE of
 *  winnerOrigin / mergedVersion — the foundation never picks; the operator does. */
export interface ConflictResolution {
  /** Designate an existing version (by its origin) as the winner. */
  winnerOrigin?: string;
  /** Supply a merged version (opaque store payload) — written as a normal record
   *  by the caller; this store only records that the conflict is resolved. */
  mergedVersion?: Record<string, unknown>;
}

/** The seams ConflictStore needs (DI'd so it is unit-testable without disk). */
export interface ConflictStoreSeams {
  /** Absolute path to the agent `.instar/` stateDir (the ledger lives under it). */
  stateDir: string;
  /** Injected wall clock (ISO timestamps). */
  now: () => Date;
  /** Optional: raise ONE deduped attention item for a conflict (caller wires the
   *  real attention queue; idempotent on conflictId by the caller). Signal-only. */
  raiseAttention?: (entry: ConflictLedgerEntry) => void;
  /** Optional structured logger (default no-op). */
  log?: (event: string, detail: Record<string, unknown>) => void;
  /** Optional fs read seam (tests); defaults to node:fs. */
  readFileSync?: (p: string) => string;
  existsSync?: (p: string) => boolean;
  /** Recurrence threshold + open cap overrides. */
  recurrenceThreshold?: number;
  maxOpenConflicts?: number;
}

interface LedgerDoc {
  version: 1;
  conflicts: ConflictLedgerEntry[];
  /** Monotonic count of open conflicts evicted by the bound (surfaced). */
  lossCounter: number;
}

export class ConflictStore {
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly raiseAttention?: (entry: ConflictLedgerEntry) => void;
  private readonly log: (event: string, detail: Record<string, unknown>) => void;
  private readonly readFileSync: (p: string) => string;
  private readonly existsSync: (p: string) => boolean;
  private readonly recurrenceThreshold: number;
  private readonly maxOpen: number;

  private doc: LedgerDoc;

  constructor(seams: ConflictStoreSeams) {
    this.stateDir = seams.stateDir;
    this.now = seams.now;
    this.raiseAttention = seams.raiseAttention;
    this.log = seams.log ?? (() => {});
    this.readFileSync = seams.readFileSync ?? ((p) => fs.readFileSync(p, 'utf-8'));
    this.existsSync = seams.existsSync ?? ((p) => fs.existsSync(p));
    this.recurrenceThreshold = seams.recurrenceThreshold ?? DEFAULT_CONFLICT_RECURRENCE_THRESHOLD;
    this.maxOpen = seams.maxOpenConflicts ?? DEFAULT_MAX_OPEN_CONFLICTS;
    this.doc = this.load();
  }

  private ledgerPath(): string {
    return path.join(this.stateDir, 'state', 'state-sync', 'conflicts.json');
  }

  private load(): LedgerDoc {
    const p = this.ledgerPath();
    if (!this.existsSync(p)) return { version: 1, conflicts: [], lossCounter: 0 };
    try {
      const raw = JSON.parse(this.readFileSync(p)) as Partial<LedgerDoc>;
      const conflicts = Array.isArray(raw.conflicts) ? raw.conflicts.filter(isLedgerEntry) : [];
      const lossCounter = typeof raw.lossCounter === 'number' && Number.isFinite(raw.lossCounter) ? raw.lossCounter : 0;
      return { version: 1, conflicts, lossCounter };
    } catch (err) {
      // @silent-fallback-ok: a corrupt/partially-written conflicts ledger degrades
      // to an EMPTY-but-usable ledger (the same as the missing-file path) rather
      // than throwing out of construction and bricking every union read. The
      // discard is logged with context ('conflict-ledger-corrupt'); a re-discovered
      // conflict re-records idempotently on its stable id, so nothing is lost
      // permanently — only the prior recurrence COUNT, the safe direction.
      this.log('conflict-ledger-corrupt', { error: err instanceof Error ? err.message : String(err) });
      return { version: 1, conflicts: [], lossCounter: 0 };
    }
  }

  private persist(): void {
    SafeFsExecutor.atomicWriteJsonSync(this.ledgerPath(), this.doc, {
      operation: 'conflict-store:persist',
    });
  }

  /**
   * Record a detected conflict (§7.2). IDEMPOTENT on the stable conflictId:
   *  - first sighting ⇒ append a new open entry + raise ONE attention item.
   *  - re-sighting of an unresolved conflict ⇒ bump recurrenceCount + lastSeenAt
   *    (NEVER a third copy); cross the threshold ⇒ forcedResolution=true + a
   *    re-surfaced attention item.
   *  - re-sighting of a RESOLVED conflict ⇒ no-op (it was decided; a fresh
   *    divergence would carry a DIFFERENT conflictId).
   * Returns the live ledger entry.
   */
  recordConflict(store: string, descriptor: ConflictDescriptor): ConflictLedgerEntry {
    const nowIso = this.now().toISOString();
    const existing = this.doc.conflicts.find((c) => c.conflictId === descriptor.conflictId);
    if (existing) {
      if (existing.resolved) return existing; // decided — never re-open the same id.
      existing.recurrenceCount++;
      existing.lastSeenAt = nowIso;
      // A pure recurrence-count bump is IN-MEMORY only — recordConflict fires on
      // EVERY union read of an open conflict, so persisting each one would be an
      // O(reads) disk write storm. The count is advisory (it drives forced-
      // resolution); losing the exact count across a restart is the safe direction
      // (already documented on load()). We persist ONLY on a real state TRANSITION:
      // the forced-resolution crossing below.
      if (!existing.forcedResolution && existing.recurrenceCount >= this.recurrenceThreshold) {
        existing.forcedResolution = true;
        this.log('conflict-forced-resolution', { conflictId: existing.conflictId, store, recurrence: existing.recurrenceCount });
        this.persist();
        this.raiseAttention?.(existing);
      }
      return existing;
    }

    const entry: ConflictLedgerEntry = {
      conflictId: descriptor.conflictId,
      store,
      recordKey: descriptor.recordKey,
      versions: descriptor.versions.map((v) => ({ origin: v.origin, hlcKey: serializeHlcKey(v.envelope.hlc) })),
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      recurrenceCount: 1,
      forcedResolution: false,
      resolved: false,
    };
    this.doc.conflicts.push(entry);
    this.evictToBound();
    this.persist();
    // ONE deduped attention item on first sighting (the caller dedupes on
    // conflictId; recurrence past the threshold re-surfaces above).
    this.raiseAttention?.(entry);
    return entry;
  }

  /** Evict oldest-first OPEN conflicts past the cap (bounded growth, §7.2). A
   *  resolved entry is retained briefly for audit but does not count toward the
   *  OPEN cap; the cap counts unresolved entries only. */
  private evictToBound(): void {
    const open = this.doc.conflicts.filter((c) => !c.resolved);
    if (open.length <= this.maxOpen) return;
    // Drop the oldest OPEN conflicts (by firstSeenAt) past the cap.
    open.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0));
    const dropCount = open.length - this.maxOpen;
    const drop = new Set(open.slice(0, dropCount).map((c) => c.conflictId));
    this.doc.conflicts = this.doc.conflicts.filter((c) => !drop.has(c.conflictId));
    this.doc.lossCounter += dropCount;
    this.log('conflict-ledger-evicted', { dropCount, lossCounter: this.doc.lossCounter });
  }

  /**
   * Resolve a conflict (§7.3 — the operator's authority, never the foundation's).
   * EXACTLY ONE of `winnerOrigin` / `mergedVersion` must be supplied. The store
   * records the resolution; the CALLER writes the operator's chosen/merged record
   * as a normal replicated record (it replicates like any other). Returns the
   * updated entry, or null if the conflictId is unknown.
   */
  resolveConflict(conflictId: string, resolution: ConflictResolution): ConflictLedgerEntry | null {
    const entry = this.doc.conflicts.find((c) => c.conflictId === conflictId);
    if (!entry) return null;
    if (entry.resolved) return entry; // idempotent — already decided.

    const hasWinner = typeof resolution.winnerOrigin === 'string' && resolution.winnerOrigin.length > 0;
    const hasMerged = resolution.mergedVersion !== undefined && resolution.mergedVersion !== null;
    if (hasWinner === hasMerged) {
      // Neither or both — the operator must pick exactly one path. Reject loudly
      // (a programmer/operator input error, surfaced — never a silent default).
      throw new Error('ConflictStore.resolveConflict: supply EXACTLY ONE of winnerOrigin / mergedVersion');
    }
    if (hasWinner && !entry.versions.some((v) => v.origin === resolution.winnerOrigin)) {
      throw new Error(`ConflictStore.resolveConflict: winnerOrigin "${resolution.winnerOrigin}" is not one of the conflict's versions`);
    }

    entry.resolved = true;
    entry.resolvedAt = this.now().toISOString();
    entry.resolution = hasWinner ? 'operator-winner' : 'operator-merged';
    if (hasWinner) entry.winnerOrigin = resolution.winnerOrigin;
    this.persist();
    this.log('conflict-resolved', { conflictId, resolution: entry.resolution });
    return entry;
  }

  /**
   * Auto-resolve every OPEN conflict whose version set referenced a dropped origin
   * (§7.4 rollback-unmerge). After an un-merge the dropped origin no longer
   * contributes, so a conflict that only existed BECAUSE of it ceases to exist —
   * we mark it resolved ('origin-dropped') and return the closed conflictIds so
   * the caller can close their attention items. Idempotent.
   *
   * Conservative correctness: we resolve a conflict iff REMOVING the dropped
   * origin's versions leaves AT MOST ONE remaining origin (so no concurrent pair
   * remains). A conflict among OTHER origins that merely also included the dropped
   * one stays open (the divergence between the survivors is real) — it will
   * re-record on the next union read with a fresh id over the surviving versions.
   */
  autoResolveForDroppedOrigin(droppedOrigin: string): string[] {
    const closed: string[] = [];
    for (const c of this.doc.conflicts) {
      if (c.resolved) continue;
      if (!c.versions.some((v) => v.origin === droppedOrigin)) continue;
      const survivors = c.versions.filter((v) => v.origin !== droppedOrigin);
      // Distinct surviving origins ≤ 1 ⇒ the conflict was created by the dropped
      // origin and no longer exists.
      const distinctSurvivors = new Set(survivors.map((v) => v.origin));
      if (distinctSurvivors.size <= 1) {
        c.resolved = true;
        c.resolvedAt = this.now().toISOString();
        c.resolution = 'origin-dropped';
        closed.push(c.conflictId);
      }
    }
    if (closed.length > 0) {
      this.persist();
      this.log('conflict-auto-resolved-origin-dropped', { droppedOrigin, closedCount: closed.length });
    }
    return closed;
  }

  /** Every open (unresolved) conflict (§7.3 dashboard surface). */
  listOpen(): ConflictLedgerEntry[] {
    return this.doc.conflicts.filter((c) => !c.resolved);
  }

  /** Every conflict (open + recently-resolved), for the audit surface. */
  listAll(): ConflictLedgerEntry[] {
    return [...this.doc.conflicts];
  }

  /** One conflict by id, or undefined. */
  getConflict(conflictId: string): ConflictLedgerEntry | undefined {
    return this.doc.conflicts.find((c) => c.conflictId === conflictId);
  }

  /** Monotonic count of open conflicts evicted by the bound (surfaced in degradation). */
  get lossCounter(): number {
    return this.doc.lossCounter;
  }
}

function isLedgerEntry(v: unknown): v is ConflictLedgerEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.conflictId === 'string' && typeof o.recordKey === 'string' && typeof o.store === 'string' && Array.isArray(o.versions);
}

/** Re-export the version-stamp helper so a caller serializing a resolution can
 *  produce the same hlc key shape the ledger stores. */
export { serializeHlcKey };
export type { HlcTimestamp, OriginRecord };
