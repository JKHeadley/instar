/**
 * WorkingSetArtifactManager — the durable, own-origin store of interactive working-set
 * artifact rows (spec: intelligent-working-set-lazy-sync.md, Layer 1). It is the literal
 * analog of `KnowledgeManager` (the local catalog the KnowledgeReplicatedStore rides): it
 * holds THIS machine's per-topic record of files the agent wrote INTERACTIVELY under the
 * `.instar/` jail — the case `WorkingSetManifest.computeWorkingSet` misses — and feeds:
 *   (a) the `ReplicatedStoreReader`'s loadOriginRecords/listRecordKeys (own-origin
 *       materialization the union reader merges against peer replicas), and
 *   (b) `computeWorkingSet`'s new `ready`-row source (component 3).
 *
 * It stores OWN-ORIGIN rows only (producerMachineId === this machine). Peer replicas are
 * NOT stored here — they arrive via the replicated journal and surface through the union
 * reader (read-only, advisory, never clobbering a local file). Row identity is
 * (topicId, relPath, producerMachineId); a re-record of the same triple UPSERTS.
 *
 * Row lifecycle (spec §64): `pendingHash` (recorded, hash deferred) → `ready(contentHash)`
 * (hashed, fetch-eligible) → terminal `tooLarge` / `secretFlagged`. ONLY `ready` rows are
 * returned by getReadyRows() — the fetch-nomination source (the serve-boundary hash-verify
 * remains the authority). Tombstone is OWNER-ONLY (a row is always this machine's, so a
 * local tombstone is legitimate; the replicated tombstone builder re-checks origin ===
 * producer). GC purges rows older than the record TTL (default 30d).
 *
 * Durable + atomic (tmp+rename), mirroring KnowledgeManager. The emit seam is best-effort:
 * a record/tombstone fires the replication emitter when wired (dark by default), else no-op.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A locally-held working-set artifact row (own-origin). */
export interface WorkingSetArtifactLocalRow {
  topicId: number;
  relPath: string;
  contentHash: string | null;
  /** ISO-8601 of the last write that produced/updated this row. */
  lastWrittenAt: string;
  producerMachineId: string;
  /** pendingHash | ready | tooLarge | secretFlagged */
  state: string;
  /** ISO-8601 when this row was first recorded — GC anchor (record TTL). */
  recordedAt: string;
}

interface WorkingSetArtifactCatalog {
  rows: WorkingSetArtifactLocalRow[];
}

/** The replication emit seam — fired on a record (put) / tombstone (delete). Best-effort;
 *  wired ONLY when `multiMachine.stateSync.workingSetArtifact.enabled` (dark by default). */
export interface WorkingSetArtifactReplicationEmitter {
  emitPut(row: WorkingSetArtifactLocalRow): void;
  emitDelete(row: { topicId: number; relPath: string; producerMachineId: string; deletedAt: string }): void;
}

export interface RecordArtifactInput {
  topicId: number;
  relPath: string;
  producerMachineId: string;
  /** Defaults to 'pendingHash' — hashing is deferred to the serve boundary / async worker. */
  state?: string;
  contentHash?: string | null;
  /** ISO-8601; defaults to nowIso (injectable for tests). */
  lastWrittenAt?: string;
}

/** The valid row states (mirrors WORKING_SET_ARTIFACT_STATES in the replicated store). */
const VALID_STATES = new Set(['pendingHash', 'ready', 'tooLarge', 'secretFlagged']);

/** Default record TTL for GC — distinct from the engine's 7d pending-pull TTL (spec F3). */
export const DEFAULT_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class WorkingSetArtifactManager {
  private readonly dir: string;
  private readonly catalogPath: string;
  private replication: WorkingSetArtifactReplicationEmitter | null = null;
  /** Injectable clock (tests) — returns ISO-8601. */
  private readonly nowIso: () => string;

  constructor(stateDir: string, nowIso: () => string = () => new Date().toISOString()) {
    this.dir = path.join(stateDir, 'working-set');
    this.catalogPath = path.join(this.dir, 'artifacts.json');
    this.nowIso = nowIso;
  }

  /** Wire the replication emitter (dark by default — only attached when stateSync enabled). */
  setReplicationEmitter(emitter: WorkingSetArtifactReplicationEmitter | null): void {
    this.replication = emitter;
  }

  /**
   * Upsert a row keyed (topicId, relPath, producerMachineId). A re-record of the same triple
   * updates lastWrittenAt/state/contentHash + preserves the original recordedAt (the GC
   * anchor). Returns the stored row. Fires the emit seam (put) best-effort.
   */
  record(input: RecordArtifactInput): WorkingSetArtifactLocalRow {
    const state = input.state && VALID_STATES.has(input.state) ? input.state : 'pendingHash';
    const lastWrittenAt = input.lastWrittenAt ?? this.nowIso();
    const catalog = this.loadCatalog();
    const existing = catalog.rows.find(
      (r) => r.topicId === input.topicId && r.relPath === input.relPath && r.producerMachineId === input.producerMachineId,
    );
    let row: WorkingSetArtifactLocalRow;
    if (existing) {
      existing.state = state;
      existing.lastWrittenAt = lastWrittenAt;
      existing.contentHash = input.contentHash ?? existing.contentHash ?? null;
      row = existing;
    } else {
      row = {
        topicId: input.topicId,
        relPath: input.relPath,
        contentHash: input.contentHash ?? null,
        lastWrittenAt,
        producerMachineId: input.producerMachineId,
        state,
        recordedAt: this.nowIso(),
      };
      catalog.rows.push(row);
    }
    this.saveCatalog(catalog);
    try { this.replication?.emitPut(row); } catch { /* @silent-fallback-ok: best-effort replication emit (dark by default); a failed emit is re-driven by the store's own reconcile, never a data-loss fallback */ }
    return row;
  }

  /**
   * Transition a pendingHash row to ready(contentHash) (or to a terminal tooLarge/secretFlagged).
   * A no-op if the row is absent. Fires the emit seam (put) on a real transition.
   */
  setState(topicId: number, relPath: string, producerMachineId: string, state: string, contentHash?: string | null): boolean {
    if (!VALID_STATES.has(state)) return false;
    const catalog = this.loadCatalog();
    const row = catalog.rows.find(
      (r) => r.topicId === topicId && r.relPath === relPath && r.producerMachineId === producerMachineId,
    );
    if (!row) return false;
    row.state = state;
    if (contentHash !== undefined) row.contentHash = contentHash;
    this.saveCatalog(catalog);
    try { this.replication?.emitPut(row); } catch { /* @silent-fallback-ok: best-effort replication emit (dark by default); a failed emit is re-driven by the store's own reconcile, never a data-loss fallback */ }
    return true;
  }

  /**
   * Owner-only tombstone: remove the row (topicId, relPath, producerMachineId) and fire the
   * replicated tombstone. A row held here is always THIS machine's (own-origin), so a local
   * tombstone is legitimate; the replicated tombstone builder re-checks origin === producer.
   * Returns true if a row was removed.
   */
  tombstone(topicId: number, relPath: string, producerMachineId: string): boolean {
    const catalog = this.loadCatalog();
    const before = catalog.rows.length;
    catalog.rows = catalog.rows.filter(
      (r) => !(r.topicId === topicId && r.relPath === relPath && r.producerMachineId === producerMachineId),
    );
    if (catalog.rows.length === before) return false;
    this.saveCatalog(catalog);
    try {
      this.replication?.emitDelete({ topicId, relPath, producerMachineId, deletedAt: this.nowIso() });
    } catch { /* @silent-fallback-ok: best-effort replication emit (dark by default); a failed emit is re-driven by the store's own reconcile, never a data-loss fallback */ }
    return true;
  }

  /** All own rows for a topic (any state). */
  getRowsForTopic(topicId: number): WorkingSetArtifactLocalRow[] {
    return this.loadCatalog().rows.filter((r) => r.topicId === topicId);
  }

  /** Own `ready` rows for a topic — the fetch-nomination source (spec §64: only ready nominates). */
  getReadyRows(topicId: number): WorkingSetArtifactLocalRow[] {
    return this.loadCatalog().rows.filter((r) => r.topicId === topicId && r.state === 'ready');
  }

  /** All own rows (every topic) — the union reader's listRecordKeys source. */
  getAllRows(): WorkingSetArtifactLocalRow[] {
    return this.loadCatalog().rows;
  }

  /**
   * GC: purge rows whose recordedAt is older than ttlMs. Returns the count purged. A purge is
   * a LOCAL cleanup (not a tombstone — an expired own row is simply forgotten; a peer's copy
   * ages out under its own TTL). Injectable `nowMs` for tests.
   */
  gc(ttlMs: number = DEFAULT_RECORD_TTL_MS, nowMs: number = Date.now()): number {
    const catalog = this.loadCatalog();
    const before = catalog.rows.length;
    catalog.rows = catalog.rows.filter((r) => {
      const age = nowMs - Date.parse(r.recordedAt ?? '');
      return !(Number.isFinite(age) && age > ttlMs);
    });
    const purged = before - catalog.rows.length;
    if (purged > 0) this.saveCatalog(catalog);
    return purged;
  }

  // ── persistence (atomic tmp+rename, mirrors KnowledgeManager) ─────────────────
  private loadCatalog(): WorkingSetArtifactCatalog {
    if (!fs.existsSync(this.catalogPath)) return { rows: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.catalogPath, 'utf-8'));
      return Array.isArray(parsed?.rows) ? { rows: parsed.rows as WorkingSetArtifactLocalRow[] } : { rows: [] };
    } catch {
      // @silent-fallback-ok: a corrupt/unreadable catalog reads as empty (documented contract) — the
      // agent re-records artifacts on the next write; never throws into a caller, never loses live data.
      return { rows: [] };
    }
  }

  private saveCatalog(catalog: WorkingSetArtifactCatalog): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    const tmpPath = `${this.catalogPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(catalog, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.catalogPath);
  }
}
