/**
 * SemanticMemory — Entity-relationship knowledge store with FTS5 + vector hybrid search.
 *
 * A typed, confidence-tracked knowledge graph stored in SQLite. Entities
 * represent knowledge (facts, people, projects, tools, patterns, decisions,
 * lessons) and edges represent relationships between them.
 *
 * Key features:
 *   - FTS5 full-text search with multi-signal ranking
 *   - Optional vector similarity search via sqlite-vec (Phase 5)
 *   - Hybrid scoring: FTS5 keyword + vector cosine similarity
 *   - Exponential confidence decay (lessons decay slower than facts)
 *   - BFS graph traversal with cycle detection
 *   - Export/import for portability
 *   - Formatted context generation for session injection
 *   - Graceful degradation: works FTS5-only when vectors unavailable
 *
 * Uses the same better-sqlite3 pattern as MemoryIndex and TopicMemory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type {
  MemoryEntity,
  MemoryEdge,
  ScoredEntity,
  ConnectedEntity,
  DecayReport,
  ImportReport,
  SemanticMemoryStats,
  SemanticMemoryConfig,
  SemanticSearchOptions,
  ExploreOptions,
  EntityType,
  RelationType,
  MemoryEvidence,
  MemoryEvidenceKind,
  EvidenceProducerId,
  EvidencePrivacyTier,
} from '../core/types.js';
import type { PrivacyScopeType } from '../core/types.js';
import {
  DEFAULT_EVIDENCE_CAP_PER_ENTITY,
  MAX_EVIDENCE_CAP_PER_ENTITY,
  MAX_EVIDENCE_NOTE_BYTES,
  MAX_SUPERSEDES_DEPTH,
} from '../core/types.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';
import { VectorSearch } from './VectorSearch.js';
import { buildPrivacySqlFilter } from '../utils/privacy.js';
import {
  isEntityVisibleAtScope as rendererIsEntityVisibleAtScope,
  isEvidenceVisibleAtScope as rendererIsEvidenceVisibleAtScope,
} from './EvidenceRenderer.js';
import { NativeModuleHealer } from './NativeModuleHealer.js';

// Dynamic import for better-sqlite3 (optional dependency)
type Database = import('better-sqlite3').Database;

/**
 * Structural shape of the RemediationContext that W-4's `invokeFromRemediator`
 * accepts. Mirrored here (rather than imported from `src/remediation/`) to keep
 * `src/memory/*` independent of the remediation tree — installs with a partial
 * CLI surface that omit the remediation module continue to work, and the
 * existing in-line corruption-recovery path inside `open()` stays intact.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A3 (capability token), §A4 (abort signal),
 * §A57 (Tier-2 W-4 wrapper).
 */
export interface SemanticMemoryRemediatorContext {
  attemptId: string;
  runbookId: string;
  auditToken: Buffer;
  abortSignal: AbortSignal;
  expiresAt: number;
  monotonicDeadline: bigint;
  hmac?: Buffer;
  // lockHandle is intentionally `unknown` — surfaces never inspect it.
  lockHandle: unknown;
}

/**
 * Result returned by `SemanticMemory.invokeFromRemediator` — mirrors
 * `RemediatorExecutionResult` in the remediation tree without importing it.
 */
export interface SemanticMemoryRemediatorResult {
  outcome: 'success' | 'failure';
  details: Record<string, unknown>;
}

/**
 * Optional capability-leaf vault for §A3 HMAC verification. Same structural
 * shape as `CapabilityLeafKeyVault` in `src/remediation/RemediationContext.ts`.
 */
export interface SemanticMemoryCapabilityLeafKeyVault {
  deriveLeafKey(context: 'capability', scopeId: string): Buffer;
}

/**
 * Strip FTS5 special syntax characters from a query.
 * Prevents query manipulation via AND, OR, NOT, NEAR, *, column filters.
 */
function sanitizeFts5Query(query: string): string {
  return query
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .replace(/[*:"^{}().$@#!~`?\\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class SemanticMemory {
  /**
   * W-4 / §A57 — process-wide registry of active SemanticMemory instances.
   * The `db-corruption` runbook surfaceCallable resolves a target instance
   * by `dbPath` (preferred) or, failing that, by the registered "active"
   * instance set explicitly via `setActiveInstance()`. Construction does
   * NOT auto-register — callers (server bootstrap, CLI subcommands) opt in
   * explicitly so partial CLI surfaces aren't accidentally targeted by a
   * Remediator dispatch.
   */
  private static readonly _instancesByPath = new Map<string, SemanticMemory>();
  private static _activeInstance: SemanticMemory | null = null;
  private static _remediatorKeyVault: SemanticMemoryCapabilityLeafKeyVault | null =
    null;

  /**
   * Register this instance as a candidate target for Remediator dispatch.
   * Keyed by config.dbPath. Multiple registrations of the same path replace
   * the prior entry — the most recent `open()` site owns the path.
   */
  static registerInstance(instance: SemanticMemory): void {
    SemanticMemory._instancesByPath.set(instance.config.dbPath, instance);
  }

  /** Remove an instance from the registry (mirror of registerInstance). */
  static unregisterInstance(instance: SemanticMemory): void {
    if (
      SemanticMemory._instancesByPath.get(instance.config.dbPath) === instance
    ) {
      SemanticMemory._instancesByPath.delete(instance.config.dbPath);
    }
    if (SemanticMemory._activeInstance === instance) {
      SemanticMemory._activeInstance = null;
    }
  }

  /**
   * Mark an instance as the "active" target for Remediator dispatch when
   * the ctx does not specify a dbPath. Server bootstrap calls this with
   * the primary memory store.
   */
  static setActiveInstance(instance: SemanticMemory | null): void {
    SemanticMemory._activeInstance = instance;
  }

  /**
   * Optionally wire a capability-leaf key vault so `invokeFromRemediator`
   * can verify ctx HMAC per §A3. Test helpers and partial CLI surfaces
   * may leave this unset, in which case ctx HMAC is not verified (the
   * surface still acts on the call — matches W-1 behaviour where the
   * keyVault is also optional).
   */
  static setRemediatorKeyVault(
    keyVault: SemanticMemoryCapabilityLeafKeyVault | null,
  ): void {
    SemanticMemory._remediatorKeyVault = keyVault;
  }

  /** Reset all class-level state. Test-only. */
  static resetForTesting(): void {
    SemanticMemory._instancesByPath.clear();
    SemanticMemory._activeInstance = null;
    SemanticMemory._remediatorKeyVault = null;
  }

  /**
   * Public read of the active Remediator-target instance. Used by the W-4
   * runbook's verify() to inspect db.mode + integrity post-recovery.
   */
  static getActiveInstanceForRemediator(): SemanticMemory | null {
    return SemanticMemory._activeInstance;
  }

  /**
   * §A3 — verify the HMAC on a Remediator-supplied ctx. Mirrors the
   * canonical body layout in `src/remediation/RemediationContext.ts`. We
   * inline rather than import to keep `src/memory/*` independent of the
   * remediation tree. Returns `true` only when the keyVault is wired AND
   * the HMAC verifies; an unwired keyVault returns `true` (call is
   * permitted) but the audit tail records `hmac-unverified` so it's clear
   * the call came in without §A3 enforcement.
   */
  private static verifyCtxHmac(
    ctx: SemanticMemoryRemediatorContext,
    keyVault: SemanticMemoryCapabilityLeafKeyVault,
  ): boolean {
    if (!Buffer.isBuffer(ctx.hmac) || ctx.hmac.length === 0) return false;
    if (typeof ctx.runbookId !== 'string' || ctx.runbookId.length === 0) {
      return false;
    }
    let leaf: Buffer;
    try {
      leaf = keyVault.deriveLeafKey('capability', ctx.runbookId);
    } catch {
      return false;
    }
    const HMAC_TAG = Buffer.from('instar-f8-ctx-v1\x00', 'utf-8');
    const writeStr = (s: string): Buffer => {
      const body = Buffer.from(s, 'utf-8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length, 0);
      return Buffer.concat([len, body]);
    };
    const expiresAtBuf = Buffer.alloc(8);
    expiresAtBuf.writeBigUInt64BE(
      BigInt(Math.max(0, Math.floor(ctx.expiresAt))),
      0,
    );
    const monoBuf = Buffer.alloc(8);
    const mono =
      typeof ctx.monotonicDeadline === 'bigint' && ctx.monotonicDeadline >= 0n
        ? ctx.monotonicDeadline
        : 0n;
    monoBuf.writeBigUInt64BE(mono, 0);
    const body = Buffer.concat([
      HMAC_TAG,
      writeStr(ctx.attemptId),
      writeStr(ctx.runbookId),
      expiresAtBuf,
      monoBuf,
    ]);
    const expected = crypto.createHmac('sha256', leaf).update(body).digest();
    if (expected.length !== ctx.hmac.length) return false;
    try {
      return crypto.timingSafeEqual(expected, ctx.hmac);
    } catch {
      return false;
    }
  }

  /**
   * W-4 surface entry point — the Remediator-orchestrated parallel path
   * to the in-line corruption-recovery logic inside `open()`. The legacy
   * in-line entry point remains the canonical safety net for direct-
   * construction paths; this static method is what the `db-corruption`
   * runbook surfaceCallable invokes.
   *
   * SELF-HEALING-REMEDIATOR-V2-SPEC §A3 (HMAC), §A4 (abort), §A9
   * (durability assertion done by runbook.verify), §A34 (surface entry
   * point is real and live — this method wraps the actually-implemented
   * quarantine + JSONL-rebuild path on lines 178-243 of this file).
   */
  static async invokeFromRemediator(
    ctx: SemanticMemoryRemediatorContext,
    overrides?: {
      instance?: SemanticMemory;
      keyVault?: SemanticMemoryCapabilityLeafKeyVault | null;
    },
  ): Promise<SemanticMemoryRemediatorResult> {
    // §A3: verify HMAC if a keyVault is wired AND ctx claims an HMAC.
    const keyVault =
      overrides?.keyVault === undefined
        ? SemanticMemory._remediatorKeyVault
        : overrides.keyVault;
    let hmacVerified: 'verified' | 'unverified-no-vault' | 'rejected' =
      'unverified-no-vault';
    if (keyVault) {
      if (ctx.hmac === undefined) {
        hmacVerified = 'unverified-no-vault';
      } else if (SemanticMemory.verifyCtxHmac(ctx, keyVault)) {
        hmacVerified = 'verified';
      } else {
        console.warn(
          `[SemanticMemory] remediation.surface.invalid-context ` +
            `runbookId=${ctx.runbookId} attemptId=${ctx.attemptId} — ` +
            `refusing orchestrated path (in-line path still applies on next open())`,
        );
        return {
          outcome: 'failure',
          details: {
            reason: 'invalid-context',
            attemptId: ctx.attemptId,
          },
        };
      }
    }

    if (ctx.abortSignal.aborted) {
      return {
        outcome: 'failure',
        details: {
          reason: 'aborted-before-start',
          attemptId: ctx.attemptId,
        },
      };
    }

    const instance =
      overrides?.instance ?? SemanticMemory._activeInstance ?? null;
    if (!instance) {
      return {
        outcome: 'failure',
        details: {
          reason: 'no-active-instance',
          attemptId: ctx.attemptId,
        },
      };
    }

    return instance._invokeFromRemediatorInternal(ctx, hmacVerified);
  }

  /**
   * Instance-scoped corruption-recovery driver. Closes the current handle
   * (if any), reopens via `open()` — which runs integrity_check, probe-
   * read, and auto-quarantine + JSONL rebuild on detection. Returns a
   * structured result the runbook surfaceCallable hands back.
   */
  private async _invokeFromRemediatorInternal(
    ctx: SemanticMemoryRemediatorContext,
    hmacVerified: 'verified' | 'unverified-no-vault' | 'rejected',
  ): Promise<SemanticMemoryRemediatorResult> {
    const started = Date.now();
    const dbPath = this.config.dbPath;
    try {
      // Close any existing handle so the re-open path runs integrity_check
      // on the on-disk file from a clean state.
      try {
        this.close();
      } catch {
        // @silent-fallback-ok — close() may throw if the handle is already
        // mid-corrupt; we proceed to re-open which is the recovery path.
      }

      if (ctx.abortSignal.aborted) {
        return {
          outcome: 'failure',
          details: {
            reason: 'aborted-after-close',
            attemptId: ctx.attemptId,
            dbPath,
          },
        };
      }

      // The reopen path is the actual recovery — see `open()` lines 178-243.
      // It detects corruption via integrity_check + probe-read, quarantines
      // the corrupt file, and auto-rebuilds from JSONL. The `_lastRecoveryRebuilt`
      // flag is set true by `open()` exactly when the rebuild path ran.
      await this.open();
      const rebuildRan = this._lastRecoveryRebuilt;

      // Post-open assertion: integrity_check must now pass. This is the
      // surface-side liveness check; the runbook.verify() does the §A9
      // durability assertion on top of this.
      let integrityOk = false;
      let integrityValue: string = 'unknown';
      try {
        const db = this.db;
        if (db) {
          const result = db.pragma('integrity_check') as Array<{
            integrity_check: string;
          }>;
          integrityValue = result[0]?.integrity_check ?? 'unknown';
          integrityOk = integrityValue === 'ok';
        }
      } catch (err) {
        return {
          outcome: 'failure',
          details: {
            reason: 'post-recover-integrity-check-threw',
            attemptId: ctx.attemptId,
            dbPath,
            error: err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - started,
            hmacVerified,
          },
        };
      }

      if (!integrityOk) {
        return {
          outcome: 'failure',
          details: {
            reason: 'post-recover-integrity-check-not-ok',
            attemptId: ctx.attemptId,
            dbPath,
            integrityValue,
            elapsedMs: Date.now() - started,
            hmacVerified,
          },
        };
      }

      return {
        outcome: 'success',
        details: {
          attemptId: ctx.attemptId,
          dbPath,
          rebuiltFromJsonl: rebuildRan,
          integrityValue,
          elapsedMs: Date.now() - started,
          hmacVerified,
        },
      };
    } catch (err) {
      return {
        outcome: 'failure',
        details: {
          reason: 'recover-threw',
          attemptId: ctx.attemptId,
          dbPath,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - started,
          hmacVerified,
        },
      };
    }
  }

  /**
   * §A9 durability assertion helper. Returns the persistence mode of the
   * underlying db file. For better-sqlite3 instances opened against a real
   * filesystem path this is `'durable'`; opened against `:memory:` it is
   * `'in-memory'`. The `db-corruption` runbook's verify() asserts
   * `mode === 'durable'` per §A9 — falling back to in-memory is "live but
   * lossy" and triggers a `DURABILITY_DEGRADED` event.
   */
  getDurabilityMode(): 'durable' | 'in-memory' | 'closed' {
    if (!this.db) return 'closed';
    if (this.config.dbPath === ':memory:') return 'in-memory';
    return 'durable';
  }

  /** Internal — accessor for the configured dbPath. Used by the W-4 runbook. */
  getDbPath(): string {
    return this.config.dbPath;
  }

  /**
   * §A9 durability assertion helper for the W-4 runbook's verify() step.
   * Returns the raw `integrity_check` string ('ok' on success). Throws if
   * the db is closed or pragma throws — the caller maps the throw to
   * `verify-inconclusive` per §A21.
   */
  runIntegrityCheckForRemediator(): string {
    const db = this.db;
    if (!db) {
      throw new Error('SemanticMemory.db is closed');
    }
    const result = db.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    return result[0]?.integrity_check ?? 'unknown';
  }

  private db: Database | null = null;
  private readonly config: SemanticMemoryConfig;
  private embeddingProvider: EmbeddingProvider | null = null;
  private vectorSearch: VectorSearch | null = null;
  private _vectorAvailable = false;
  private jsonlPath: string;
  /** Set after corruption auto-recovery — caller should reimport from JSONL */
  private _needsRebuild = false;
  /** §A57 W-4 — set true when the most recent `open()` ran the JSONL rebuild
   *  path (i.e., a corruption event was observed + recovered). The runbook's
   *  surfaceCallable reads this to record whether recovery actually fired. */
  private _lastRecoveryRebuilt = false;
  /** When true, `remember()` skips its own JSONL append (the wrapping
   *  `rememberWithEvidence` will emit a consolidated action instead). */
  private _suppressRememberJournal = false;
  /** Last full entity payload captured by `remember()` — read by
   *  `rememberWithEvidence` to build a full-fidelity JSONL action. */
  private _lastRememberedEntity: Record<string, unknown> | null = null;

  constructor(config: SemanticMemoryConfig) {
    this.config = config;
    // JSONL append log lives alongside the database — source of truth for disaster recovery
    this.jsonlPath = config.dbPath.replace(/\.db$/, '.jsonl');
  }

  /**
   * Whether hybrid vector search is active (sqlite-vec loaded + embeddings table created).
   */
  get vectorSearchAvailable(): boolean {
    return this._vectorAvailable;
  }

  /**
   * Attach an EmbeddingProvider to enable hybrid search.
   * Must be called BEFORE open() for full effect, but can be called after
   * to enable vector search on an already-open database.
   */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
    this.vectorSearch = new VectorSearch({
      tableName: 'entity_embeddings',
      dimensions: provider.dimensions,
    });

    // If DB is already open, try to wire up vector search now
    if (this.db) {
      this.initVectorSearch();
    }
  }

  private initVectorSearch(): void {
    if (!this.db || !this.embeddingProvider || !this.vectorSearch) return;

    const loaded = this.embeddingProvider.loadVecExtension(this.db);
    if (loaded) {
      this.vectorSearch.createTable(this.db);
      this._vectorAvailable = true;
    }
  }

  /**
   * Async initialization for vector search.
   * Loads sqlite-vec module, then wires up the extension and creates tables.
   * Call this after open() and setEmbeddingProvider() for full hybrid search.
   */
  async initializeVectorSearch(): Promise<boolean> {
    if (!this.db || !this.embeddingProvider || !this.vectorSearch) return false;

    const vecAvailable = await this.embeddingProvider.loadVecModule();
    if (!vecAvailable) return false;

    this.initVectorSearch();
    return this._vectorAvailable;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.db) return;

    // W-4 — reset the per-open recovery flag so a fresh open() that doesn't
    // trip corruption recovery reports `rebuiltFromJsonl: false`.
    this._lastRecoveryRebuilt = false;

    // Ensure parent directory exists
    const dbDir = path.dirname(this.config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Resolve the better-sqlite3 constructor through NativeModuleHealer.
    // better-sqlite3 loads its native binding at module-load time, so a
    // NODE_MODULE_VERSION mismatch throws inside `await import(...)`. The
    // healer rebuilds better-sqlite3 synchronously and retries once. See PROP-399.
    const constructor = await NativeModuleHealer.openWithHeal('SemanticMemory', async () => {
      let BetterSqlite3: any;
      try {
        BetterSqlite3 = await import('better-sqlite3');
      } catch (importErr) {
        // Preserve NODE_MODULE_VERSION errors so openWithHeal can detect them.
        // Other errors (e.g. module not installed) get the original user-friendly message.
        if (NativeModuleHealer.isNodeModuleVersionError(importErr)) throw importErr;
        throw new Error(
          'SemanticMemory requires better-sqlite3. Run: npm install better-sqlite3'
        );
      }
      return BetterSqlite3.default || BetterSqlite3;
    });

    this.db = constructor(this.config.dbPath) as Database;

    // Integrity check — auto-recover from corruption (JSONL is source of truth).
    // Corrupt DBs are quarantined (renamed) not deleted, and a marker file is written
    // so operators can notice the recovery after the fact.
    if (fs.existsSync(this.config.dbPath) && fs.statSync(this.config.dbPath).size > 0) {
      try {
        const result = this.db!.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (result[0]?.integrity_check !== 'ok') {
          this.quarantineCorruptDb(`integrity_check=${result[0]?.integrity_check}`);
          this.db = constructor(this.config.dbPath) as Database;
          this._needsRebuild = true;
        }
      } catch (err) {
        this.quarantineCorruptDb(`pragma threw: ${(err as Error).message}`);
        this.db = constructor(this.config.dbPath) as Database;
        this._needsRebuild = true;
      }

      // Secondary probe: integrity_check can miss torn interior pages that aren't
      // reachable from the B-tree schema walk. A probe read on existing tables catches these.
      if (!this._needsRebuild) {
        try {
          const tables = this.db!.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'fts%' AND name NOT LIKE 'sqlite%'"
          ).all() as Array<{ name: string }>;
          for (const t of tables) {
            this.db!.prepare(`SELECT * FROM "${t.name}" LIMIT 100`).all();
          }
        } catch (err) {
          this.quarantineCorruptDb(`probe read failed: ${(err as Error).message}`);
          this.db = constructor(this.config.dbPath) as Database;
          this._needsRebuild = true;
        }
      }
    }

    this.db!.pragma('journal_mode = WAL');
    this.db!.pragma('busy_timeout = 5000');
    this.db!.pragma('foreign_keys = ON');

    this.createSchema();
    this.migrateIfNeeded();

    // Initialize vector search if embedding provider is attached
    this.initVectorSearch();

    // Auto-rebuild from JSONL after corruption recovery
    if (this._needsRebuild) {
      const maxBytes = this.config.autoRebuildMaxBytes ?? 50 * 1024 * 1024;
      if (fs.existsSync(this.jsonlPath)) {
        const jsonlSize = fs.statSync(this.jsonlPath).size;
        if (maxBytes > 0 && jsonlSize > maxBytes) {
          console.warn(
            `[SemanticMemory] JSONL too large for synchronous rebuild ` +
            `(${(jsonlSize / 1024 / 1024).toFixed(1)} MB, limit ${(maxBytes / 1024 / 1024).toFixed(0)} MB). ` +
            `Starting with empty DB — rebuild manually via importFromJsonl().`
          );
          this.writeSkippedRebuildMarker(jsonlSize, maxBytes);
        } else {
          const result = this.importFromJsonl(this.jsonlPath);
          console.log(`[SemanticMemory] Auto-rebuilt from JSONL: ${result.entities} entities, ${result.edges} edges reimported`);
        }
      } else {
        console.warn('[SemanticMemory] No JSONL log found for rebuild — starting fresh');
      }
      this._needsRebuild = false;
      // W-4 — flag the recovery so the Remediator-orchestrated path can
      // distinguish "open() completed normally" from "open() ran recovery".
      this._lastRecoveryRebuilt = true;
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Checkpoint the WAL file. Call after sleep/wake to flush stale WAL locks.
   * Uses PASSIVE mode (non-blocking) — safe to call at any time.
   */
  checkpoint(): void {
    if (this.db) {
      try { this.db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* non-critical */ }
    }
  }

  private ensureOpen(): Database {
    if (!this.db) throw new Error('Database not open. Call open() first.');
    return this.db;
  }

  /**
   * Move a corrupt DB aside (rename, not delete) and drop a marker file so
   * operators can notice the auto-recovery. JSONL is source of truth, but
   * keeping the corrupt file enables forensic analysis (did WAL tear? disk full?).
   */
  private quarantineCorruptDb(reason: string): void {
    const ts = Date.now();
    const dir = path.dirname(this.config.dbPath);
    const base = path.basename(this.config.dbPath);
    const corruptPath = `${this.config.dbPath}.corrupt.${ts}`;
    const markerPath = path.join(dir, `${base}.corrupt-recovery.${ts}.marker.json`);

    console.warn(`[SemanticMemory] Database corrupt (${reason}) — quarantining to ${corruptPath} and rebuilding`);

    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;

    try {
      if (fs.existsSync(this.config.dbPath)) {
        fs.renameSync(this.config.dbPath, corruptPath);
      }
    } catch (err) {
      // If rename fails (cross-device, permissions), fall back to delete so the rebuild can proceed.
      console.warn(`[SemanticMemory] Could not quarantine corrupt DB (${(err as Error).message}) — falling back to delete`);
      try { SafeFsExecutor.safeUnlinkSync(this.config.dbPath, { operation: 'SemanticMemory.quarantineCorruptDb' }); } catch { /* already gone */ }
    }

    // WAL/SHM are always removed — they're tied to the now-quarantined main file
    // and keeping them around would confuse a fresh DB opened at the same path.
    for (const ext of ['-wal', '-shm']) {
      try { SafeFsExecutor.safeUnlinkSync(this.config.dbPath + ext, { operation: 'SemanticMemory.quarantineCorruptDb:sidecar' }); } catch { /* may not exist */ }
    }

    // Drop a marker file so operators / monitoring can detect the auto-recovery
    // without tailing server logs. Safe to overwrite; safe to ignore if disk full.
    try {
      const marker = {
        event: 'semantic_memory.auto_recovery',
        timestamp: new Date(ts).toISOString(),
        dbPath: this.config.dbPath,
        quarantinedTo: fs.existsSync(corruptPath) ? corruptPath : null,
        reason,
      };
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
    } catch {
      // @silent-fallback-ok: marker is a hint for operators; recovery itself already succeeded
    }
  }

  private writeSkippedRebuildMarker(jsonlSize: number, maxBytes: number): void {
    const ts = Date.now();
    const dir = path.dirname(this.config.dbPath);
    const base = path.basename(this.config.dbPath);
    const markerPath = path.join(dir, `${base}.skipped-rebuild.${ts}.marker.json`);
    try {
      fs.writeFileSync(markerPath, JSON.stringify({
        event: 'semantic_memory.skipped_rebuild',
        timestamp: new Date(ts).toISOString(),
        dbPath: this.config.dbPath,
        jsonlPath: this.jsonlPath,
        jsonlSizeBytes: jsonlSize,
        maxAllowedBytes: maxBytes,
        action: 'Started with empty DB — operator should run importFromJsonl() manually',
      }, null, 2));
    } catch {
      // @silent-fallback-ok: marker is advisory
    }
  }

  // ─── JSONL Append Log ─────────────────────────────────────────

  /**
   * Append a mutation record to the JSONL log.
   * This is the source of truth for disaster recovery — if semantic.db
   * is lost, the JSONL can reconstruct the full knowledge graph.
   *
   * Actions: remember, connect, forget, verify, supersede, update, import
   */
  private appendToJournal(action: string, data: Record<string, unknown>): void {
    try {
      const entry = JSON.stringify({ action, timestamp: new Date().toISOString(), ...data });
      fs.appendFileSync(this.jsonlPath, entry + '\n');
    } catch {
      // @silent-fallback-ok: JSONL write failure is non-fatal — DB is still the primary query layer
    }
  }

  // ─── Schema ─────────────────────────────────────────────────────

  private createSchema(): void {
    const db = this.ensureOpen();

    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        last_verified TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        expires_at TEXT,
        source TEXT NOT NULL,
        source_session TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        domain TEXT,
        owner_id TEXT,
        privacy_scope TEXT DEFAULT 'shared-project'
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        context TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(from_id, to_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_confidence ON entities(confidence);
      CREATE INDEX IF NOT EXISTS idx_entities_domain ON entities(domain);
      CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source);

      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name,
        content,
        tags,
        content='entities',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS in sync with entities table
      CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name, content, tags)
        VALUES (new.rowid, new.name, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, tags)
        VALUES ('delete', old.rowid, old.name, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, tags)
        VALUES ('delete', old.rowid, old.name, old.content, old.tags);
        INSERT INTO entities_fts(rowid, name, content, tags)
        VALUES (new.rowid, new.name, new.content, new.tags);
      END;

      CREATE TABLE IF NOT EXISTS entity_evidence (
        evidence_id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        path TEXT,
        line_start INTEGER,
        line_end INTEGER,
        lines TEXT,
        weight REAL,
        confidence REAL,
        privacy_tier TEXT,
        note TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_entity_evidence_entity ON entity_evidence(entity_id);
      CREATE INDEX IF NOT EXISTS idx_entity_evidence_source ON entity_evidence(kind, source_id);
    `);

    // Foreign keys must be ON for the entity_evidence ON DELETE CASCADE to fire.
    // open() sets the pragma; assert it here so a future caller that forgets
    // the pragma fails loud rather than silently leaking orphan rows.
    const fk = db.pragma('foreign_keys', { simple: true }) as number;
    if (fk !== 1) {
      throw new Error(
        'SemanticMemory.createSchema: PRAGMA foreign_keys is OFF — entity_evidence cascade-delete will silently fail. open() must set it ON.',
      );
    }
  }

  /**
   * Migrate existing databases to add privacy columns.
   * Safe to call repeatedly — checks for column existence first.
   */
  private migrateIfNeeded(): void {
    const db = this.ensureOpen();

    // Check if owner_id column exists
    const columns = db.prepare("PRAGMA table_info(entities)").all() as { name: string }[];
    const columnNames = columns.map(c => c.name);

    if (!columnNames.includes('owner_id')) {
      db.exec(`
        ALTER TABLE entities ADD COLUMN owner_id TEXT;
        ALTER TABLE entities ADD COLUMN privacy_scope TEXT DEFAULT 'shared-project';
      `);
    }

    // Always ensure indexes exist (safe for both fresh and migrated DBs)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
      CREATE INDEX IF NOT EXISTS idx_entities_privacy ON entities(privacy_scope);
    `);
  }

  // ─── Entity CRUD ────────────────────────────────────────────────

  /**
   * Store a knowledge entity. Returns the generated UUID.
   */
  remember(input: {
    type: EntityType;
    name: string;
    content: string;
    confidence: number;
    lastVerified: string;
    source: string;
    sourceSession?: string;
    tags: string[];
    domain?: string;
    expiresAt?: string;
    ownerId?: string;
    privacyScope?: PrivacyScopeType;
  }): string {
    const db = this.ensureOpen();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, expires_at, source, source_session, tags, domain, owner_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type,
      input.name,
      input.content,
      input.confidence,
      now,
      input.lastVerified,
      now,
      input.expiresAt ?? null,
      input.source,
      input.sourceSession ?? null,
      JSON.stringify(input.tags),
      input.domain ?? null,
      input.ownerId ?? null,
      input.privacyScope ?? 'shared-project',
    );

    // Dual-write to JSONL append log. The flag lets `rememberWithEvidence`
    // suppress this and emit a single consolidated action carrying both the
    // entity and the evidence payload.
    if (!this._suppressRememberJournal) {
      this.appendToJournal('remember', {
        entity: {
          id, type: input.type, name: input.name, content: input.content,
          confidence: input.confidence, createdAt: now, lastVerified: input.lastVerified,
          lastAccessed: now, expiresAt: input.expiresAt ?? null,
          source: input.source, sourceSession: input.sourceSession ?? null,
          tags: input.tags, domain: input.domain ?? null,
          ownerId: input.ownerId ?? null, privacyScope: input.privacyScope ?? 'shared-project',
        },
      });
    }
    this._lastRememberedEntity = {
      id, type: input.type, name: input.name, content: input.content,
      confidence: input.confidence, createdAt: now, lastVerified: input.lastVerified,
      lastAccessed: now, expiresAt: input.expiresAt ?? null,
      source: input.source, sourceSession: input.sourceSession ?? null,
      tags: input.tags, domain: input.domain ?? null,
      ownerId: input.ownerId ?? null, privacyScope: input.privacyScope ?? 'shared-project',
    };

    // Generate embedding asynchronously (fire-and-forget for write performance)
    if (this._vectorAvailable && this.embeddingProvider && this.vectorSearch) {
      const embeddingText = `${input.name} ${input.content}`;
      this.embeddingProvider.embed(embeddingText).then(embedding => {
        if (this.db && this.vectorSearch) {
          this.vectorSearch.upsert(this.db, id, embedding);
        }
      }).catch(() => { // @silent-fallback-ok: embedding failure is non-fatal, FTS5 search still works
      });
    }

    return id;
  }

  /**
   * Store a knowledge entity AND generate its embedding synchronously.
   * Use this when you need the embedding to be available immediately
   * (e.g., during migration or when testing search after insert).
   */
  async rememberWithEmbedding(input: {
    type: EntityType;
    name: string;
    content: string;
    confidence: number;
    lastVerified: string;
    source: string;
    sourceSession?: string;
    tags: string[];
    domain?: string;
    expiresAt?: string;
    ownerId?: string;
    privacyScope?: PrivacyScopeType;
  }): Promise<string> {
    const id = this.remember(input);

    // Wait for embedding to be generated and stored
    if (this._vectorAvailable && this.embeddingProvider && this.vectorSearch) {
      const db = this.ensureOpen();
      const embeddingText = `${input.name} ${input.content}`;
      const embedding = await this.embeddingProvider.embed(embeddingText);
      this.vectorSearch.upsert(db, id, embedding);
    }

    return id;
  }

  /**
   * Retrieve an entity by ID, including its connections.
   * Updates lastAccessed on read.
   */
  recall(id: string): { entity: MemoryEntity; connections: ConnectedEntity[] } | null {
    const db = this.ensureOpen();

    const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
    if (!row) return null;

    // Update lastAccessed
    const now = new Date().toISOString();
    db.prepare('UPDATE entities SET last_accessed = ? WHERE id = ?').run(now, id);

    const entity = rowToEntity({ ...row, last_accessed: now });

    // Get connections (both outgoing and incoming)
    const connections = this.getConnections(db, id);

    return { entity, connections };
  }

  /**
   * Delete an entity and all its edges.
   */
  forget(id: string, _reason?: string): void {
    const db = this.ensureOpen();

    // Delete edges first (both directions)
    db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?').run(id, id);
    // Delete embedding if vector search is active
    if (this._vectorAvailable && this.vectorSearch) {
      this.vectorSearch.delete(db, id);
    }
    // Delete entity
    db.prepare('DELETE FROM entities WHERE id = ?').run(id);

    // Dual-write to JSONL
    this.appendToJournal('forget', { entityId: id, reason: _reason ?? null });
  }

  // ─── Evidence (WikiClaim-shape provenance) ─────────────────────
  //
  // See docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md.
  //
  // Phase 1 ships the schema, the typed API, and the policy gates
  // (per-producer kind allowlist, narrowing-only privacy tier, evidence cap,
  // supersedes-cycle bound, note-byte cap). Producer integration into
  // EvolutionManager / DispatchExecutor / DecisionJournal lands in Phase 2-3.

  /**
   * Atomic create-with-evidence. Equivalent to `remember()` followed by
   * `addEvidence()`, but in one better-sqlite3 transaction so a producer
   * crash mid-call cannot leave an orphan entity.
   */
  rememberWithEvidence(
    input: Parameters<typeof this.remember>[0],
    evidence: MemoryEvidence[],
    producer: EvidenceProducerId,
  ): string {
    const db = this.ensureOpen();
    this.assertProducerKindsAllowed(producer, evidence);
    if (evidence.length > this.evidenceCapPerEntity()) {
      throw new EvidencePolicyError(
        `evidence array exceeds per-entity cap (${this.evidenceCapPerEntity()})`,
      );
    }
    return db.transaction(() => {
      this._suppressRememberJournal = true;
      let id: string;
      try {
        id = this.remember(input);
      } finally {
        this._suppressRememberJournal = false;
      }
      const writerScope = input.privacyScope ?? 'shared-project';
      this.insertEvidenceRows(id, evidence, writerScope);
      // Emit a single consolidated JSONL action with the FULL entity payload
      // (not just the id) so JSONL replay can reconstruct without
      // referencing a non-existent prior `remember` action.
      this.appendToJournal('rememberWithEvidence', {
        entity: this._lastRememberedEntity ?? { id },
        evidence: evidence.map((e) => ({ ...e })),
        producer,
      });
      this._lastRememberedEntity = null;
      return id;
    })();
  }

  /**
   * Append one or more evidence entries to an existing entity. When called
   * with an array, all rows are inserted inside a single better-sqlite3
   * transaction so a partial-write crash cannot leave half the rows landed.
   */
  addEvidence(
    entityId: string,
    evidence: MemoryEvidence | MemoryEvidence[],
    producer: EvidenceProducerId,
  ): void {
    const db = this.ensureOpen();
    const list = Array.isArray(evidence) ? evidence : [evidence];
    if (list.length === 0) return;
    this.assertProducerKindsAllowed(producer, list);

    const entityRow = db
      .prepare('SELECT privacy_scope FROM entities WHERE id = ?')
      .get(entityId) as { privacy_scope: string | null } | undefined;
    if (!entityRow) {
      throw new EvidencePolicyError(`entity ${entityId} not found`);
    }
    const writerScope = (entityRow.privacy_scope ?? 'shared-project') as PrivacyScopeType;

    db.transaction(() => {
      const existingCount = db
        .prepare('SELECT COUNT(*) AS n FROM entity_evidence WHERE entity_id = ?')
        .get(entityId) as { n: number };
      if (existingCount.n + list.length > this.evidenceCapPerEntity()) {
        throw new EvidencePolicyError(
          `evidence cap exceeded for entity ${entityId} (cap ${this.evidenceCapPerEntity()})`,
        );
      }
      this.insertEvidenceRows(entityId, list, writerScope);
      this.appendToJournal('addEvidence', { entityId, evidence: list, producer });
    })();
  }

  /**
   * Read evidence for an entity, filtered by viewer scope. Producers may
   * have written `privacyTier` more restrictive than the entity's own
   * `privacyScope`; we filter at read time so the renderer is the single
   * privacy-enforcement point.
   */
  getEvidence(entityId: string, viewerScope: PrivacyScopeType): MemoryEvidence[] {
    const db = this.ensureOpen();
    const rows = db
      .prepare('SELECT * FROM entity_evidence WHERE entity_id = ? ORDER BY updated_at DESC')
      .all(entityId) as EvidenceRow[];
    return rows
      .map(rowToEvidence)
      .filter((e) => isEvidenceVisibleAtScope(e.privacyTier, viewerScope));
  }

  /**
   * Inverse query: which entities cite this `(kind, sourceId)`? Filtered by
   * BOTH the entity's own privacyScope AND the citing evidence row's
   * privacyTier — per spec § Storage and Privacy line 316, no leak via
   * inverse query at any (viewerScope × evidence tier × entity scope)
   * combination.
   */
  findCitations(
    ref: { kind: MemoryEvidenceKind; sourceId: string },
    viewerScope: PrivacyScopeType,
  ): MemoryEntity[] {
    const db = this.ensureOpen();
    const rows = db
      .prepare(
        `SELECT ent.*, ev.privacy_tier AS ev_privacy_tier FROM entity_evidence ev
         JOIN entities ent ON ent.id = ev.entity_id
         WHERE ev.kind = ? AND ev.source_id = ?`,
      )
      .all(ref.kind, ref.sourceId) as Array<EntityRow & { ev_privacy_tier: string | null }>;
    const seen = new Set<string>();
    const results: MemoryEntity[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const entityScope = (row.privacy_scope ?? 'shared-project') as PrivacyScopeType;
      if (!isEntityVisibleAtScope(entityScope, viewerScope)) continue;
      const evTier = (row.ev_privacy_tier ?? undefined) as EvidencePrivacyTier | undefined;
      if (!isEvidenceVisibleAtScope(evTier, viewerScope)) continue;
      seen.add(row.id);
      results.push(rowToEntity(row));
    }
    return results;
  }

  /**
   * Eager variant of `recall()` (without `connections`). Returns the entity
   * with its evidence array attached, viewer-scope filtered.
   */
  getEntityWithEvidence(
    entityId: string,
    viewerScope: PrivacyScopeType,
  ): (MemoryEntity & { evidence: MemoryEvidence[] }) | null {
    const db = this.ensureOpen();
    const row = db
      .prepare('SELECT * FROM entities WHERE id = ?')
      .get(entityId) as EntityRow | undefined;
    if (!row) return null;
    const entityScope = (row.privacy_scope ?? 'shared-project') as PrivacyScopeType;
    if (!isEntityVisibleAtScope(entityScope, viewerScope)) return null;
    const entity = rowToEntity(row);
    const evidence = this.getEvidence(entityId, viewerScope);
    return { ...entity, evidence };
  }

  // ─── Evidence helpers (private) ────────────────────────────────

  private evidenceCapPerEntity(): number {
    const configured = (this.config as SemanticMemoryConfig & { evidenceCapPerEntity?: number })
      .evidenceCapPerEntity;
    if (typeof configured === 'number') {
      return Math.max(0, Math.min(configured, MAX_EVIDENCE_CAP_PER_ENTITY));
    }
    return DEFAULT_EVIDENCE_CAP_PER_ENTITY;
  }

  private assertProducerKindsAllowed(
    producer: EvidenceProducerId,
    list: readonly MemoryEvidence[],
  ): void {
    const allowed = PRODUCER_KIND_ALLOWLIST[producer];
    if (!allowed) {
      throw new EvidencePolicyError(`unknown producer ${producer}`);
    }
    for (const e of list) {
      if (!allowed.has(e.kind)) {
        throw new EvidencePolicyError(
          `producer ${producer} cannot write evidence kind ${e.kind}`,
        );
      }
      if (typeof e.note === 'string' && Buffer.byteLength(e.note, 'utf8') > MAX_EVIDENCE_NOTE_BYTES) {
        throw new EvidencePolicyError(
          `evidence note exceeds ${MAX_EVIDENCE_NOTE_BYTES} bytes`,
        );
      }
    }
  }

  private insertEvidenceRows(
    entityId: string,
    list: readonly MemoryEvidence[],
    writerScope: PrivacyScopeType,
  ): void {
    const db = this.ensureOpen();
    const stmt = db.prepare(
      `INSERT INTO entity_evidence (
        evidence_id, entity_id, kind, source_id, path, line_start, line_end, lines,
        weight, confidence, privacy_tier, note, updated_at
      ) VALUES (
        @evidence_id, @entity_id, @kind, @source_id, @path, @line_start, @line_end, @lines,
        @weight, @confidence, @privacy_tier, @note, @updated_at
      )`,
    );
    for (const ev of list) {
      this.assertEvidenceShape(ev);
      assertNarrowingOnly(writerScope, ev.privacyTier);
      if (ev.kind === 'supersedes-evidence') {
        this.assertSupersedesAcyclic(entityId, ev.sourceId);
      }
      const lines =
        ev.lines ??
        (typeof ev.lineStart === 'number'
          ? typeof ev.lineEnd === 'number' && ev.lineEnd !== ev.lineStart
            ? `${ev.lineStart}-${ev.lineEnd}`
            : `${ev.lineStart}`
          : null);
      stmt.run({
        evidence_id: crypto.randomUUID(),
        entity_id: entityId,
        kind: ev.kind,
        source_id: ev.sourceId,
        path: ev.path ?? null,
        line_start: ev.lineStart ?? null,
        line_end: ev.lineEnd ?? null,
        lines,
        weight: typeof ev.weight === 'number' ? ev.weight : null,
        confidence: typeof ev.confidence === 'number' ? ev.confidence : null,
        privacy_tier: ev.privacyTier ?? null,
        note: ev.note ?? null,
        updated_at: ev.updatedAt,
      });
    }
  }

  private assertEvidenceShape(ev: MemoryEvidence): void {
    if (!ev.sourceId || ev.sourceId.length === 0) {
      throw new EvidencePolicyError('evidence.sourceId is required');
    }
    if (typeof ev.weight === 'number' && (ev.weight < 0 || ev.weight > 1)) {
      throw new EvidencePolicyError('evidence.weight must be in [0, 1]');
    }
    if (typeof ev.confidence === 'number' && (ev.confidence < 0 || ev.confidence > 1)) {
      throw new EvidencePolicyError('evidence.confidence must be in [0, 1]');
    }
    if (!ev.updatedAt || isNaN(Date.parse(ev.updatedAt))) {
      throw new EvidencePolicyError('evidence.updatedAt must be a valid ISO 8601 timestamp');
    }
  }

  /**
   * Bounded defenses for `kind:'supersedes-evidence'`:
   * 1. The supersedes-evidence row's `sourceId` MUST NOT equal the entity's
   *    own id — that's a self-loop with no useful semantics.
   * 2. The total count of supersedes-evidence rows on this entity MUST stay
   *    under MAX_SUPERSEDES_DEPTH. This bounds chain length without
   *    requiring a parent-pointer column (the spec leaves the chain shape
   *    underspecified; bounding count is the conservative defense).
   */
  private assertSupersedesAcyclic(entityId: string, supersededSourceId: string): void {
    if (supersededSourceId === entityId) {
      throw new EvidencePolicyError(
        `supersedes-evidence cycle detected: sourceId equals entity id`,
      );
    }
    const db = this.ensureOpen();
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM entity_evidence
         WHERE entity_id = ? AND kind = 'supersedes-evidence'`,
      )
      .get(entityId) as { n: number };
    if (count.n >= MAX_SUPERSEDES_DEPTH) {
      throw new EvidencePolicyError(
        `supersedes-evidence depth ${count.n} >= ${MAX_SUPERSEDES_DEPTH} on entity ${entityId}`,
      );
    }
  }

  // ─── User-Scoped Queries ────────────────────────────────────────

  /**
   * Get all entities owned by a specific user.
   * Used for GDPR data export (/mydata).
   */
  getEntitiesByUser(userId: string): MemoryEntity[] {
    const db = this.ensureOpen();
    const rows = db.prepare('SELECT * FROM entities WHERE owner_id = ?').all(userId) as EntityRow[];
    return rows.map(rowToEntity);
  }

  /**
   * Delete all entities owned by a specific user and their associated edges.
   * Used for GDPR data erasure (/forget).
   * Returns the number of entities deleted.
   */
  deleteEntitiesByUser(userId: string): number {
    const db = this.ensureOpen();

    // Get IDs of entities to delete
    const ids = db.prepare('SELECT id FROM entities WHERE owner_id = ?').all(userId) as { id: string }[];

    if (ids.length === 0) return 0;

    const deleteEdges = db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?');
    const deleteEntity = db.prepare('DELETE FROM entities WHERE id = ?');

    const runDeletion = db.transaction(() => {
      for (const { id } of ids) {
        deleteEdges.run(id, id);
        if (this._vectorAvailable && this.vectorSearch) {
          this.vectorSearch.delete(db, id);
        }
        deleteEntity.run(id);
      }
    });

    runDeletion();
    return ids.length;
  }

  // ─── Edge CRUD ──────────────────────────────────────────────────

  /**
   * Create a relationship between two entities.
   * Returns the edge ID. Silently returns existing edge ID if duplicate.
   */
  connect(
    fromId: string,
    toId: string,
    relation: RelationType,
    context?: string,
    weight: number = 1.0,
  ): string {
    const db = this.ensureOpen();

    // Check for existing edge with same (from, to, relation)
    const existing = db.prepare(
      'SELECT id FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?'
    ).get(fromId, toId, relation) as { id: string } | undefined;

    if (existing) return existing.id;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO edges (id, from_id, to_id, relation, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromId, toId, relation, weight, context ?? null, now);

    // Dual-write to JSONL
    this.appendToJournal('connect', {
      edge: { id, fromId, toId, relation, weight, context: context ?? null, createdAt: now },
    });

    return id;
  }

  // ─── Lookup ─────────────────────────────────────────────────────

  /**
   * Find an entity by its exact source key.
   * Used for deduplication during migration.
   */
  findBySource(source: string): MemoryEntity | null {
    const db = this.ensureOpen();
    const row = db.prepare('SELECT * FROM entities WHERE source = ?').get(source) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  // ─── Search ─────────────────────────────────────────────────────

  /**
   * Full-text search with multi-signal ranking.
   *
   * Without vector search:
   *   Score = (fts5_rank * 0.5) + (confidence * 0.3) + (access * 0.1) + (recency * 0.1)
   *
   * With vector search (hybrid mode):
   *   Score = (fts5_rank * 0.4) + (confidence * 0.3) + (access * 0.1) + (vector_sim * 0.2)
   */
  search(query: string, options?: SemanticSearchOptions): ScoredEntity[] {
    const db = this.ensureOpen();

    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    const limit = options?.limit ?? 20;

    // ─── FTS5 results ─────────────────────────────────────────
    let sql = `
      SELECT e.*, entities_fts.rank as fts_rank
      FROM entities_fts
      JOIN entities e ON e.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
    `;

    const params: (string | number)[] = [sanitized];

    if (options?.types && options.types.length > 0) {
      const placeholders = options.types.map(() => '?').join(',');
      sql += ` AND e.type IN (${placeholders})`;
      params.push(...options.types);
    }

    if (options?.domain) {
      sql += ` AND e.domain = ?`;
      params.push(options.domain);
    }

    if (options?.minConfidence !== undefined) {
      sql += ` AND e.confidence >= ?`;
      params.push(options.minConfidence);
    }

    // Privacy filtering: if userId is provided, filter by visibility
    if (options?.userId) {
      const privacyFilter = buildPrivacySqlFilter(options.userId, {
        ownerColumn: 'e.owner_id',
        scopeColumn: 'e.privacy_scope',
      });
      sql += ` AND ${privacyFilter.clause}`;
      params.push(...privacyFilter.params);
    }

    sql += ` ORDER BY entities_fts.rank LIMIT ?`;
    params.push(limit * 3); // Fetch extra for re-ranking

    const rows = db.prepare(sql).all(...params) as (EntityRow & { fts_rank: number })[];

    // ─── Vector results (if available) ────────────────────────
    // vectorScores is populated asynchronously via searchHybrid() for callers
    // that need vector scoring. For synchronous search(), we use cached scores
    // from _lastVectorScores if searchHybrid was recently called.
    const vectorScores = this._lastVectorScores;
    const useVectors = this._vectorAvailable && vectorScores !== null && vectorScores.size > 0;

    // ─── Merge & re-rank ──────────────────────────────────────
    const now = Date.now();
    const entityMap = new Map<string, ScoredEntity>();

    for (const row of rows) {
      const entity = rowToEntity(row);
      const ftsScore = 1 / (1 + Math.abs(row.fts_rank));

      const daysSinceAccessed = (now - new Date(entity.lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
      const accessScore = Math.exp(-0.01 * daysSinceAccessed);

      let score: number;
      if (useVectors) {
        const vecSim = vectorScores.get(entity.id) ?? 0;
        score =
          ftsScore * 0.4 +
          entity.confidence * 0.3 +
          accessScore * 0.1 +
          vecSim * 0.2;
      } else {
        const daysSinceVerified = (now - new Date(entity.lastVerified).getTime()) / (1000 * 60 * 60 * 24);
        const recencyScore = Math.exp(-0.02 * daysSinceVerified);
        score =
          ftsScore * 0.5 +
          entity.confidence * 0.3 +
          accessScore * 0.1 +
          recencyScore * 0.1;
      }

      entityMap.set(entity.id, { ...entity, score });
    }

    // If vectors are available, also add vector-only hits (entities found by
    // semantic similarity but missed by FTS5 keyword matching)
    if (useVectors && vectorScores) {
      vectorScores.forEach((vecSim, id) => {
        if (!entityMap.has(id)) {
          const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
          if (row) {
            const entity = rowToEntity(row);

            // Apply type/domain/confidence filters
            if (options?.types && options.types.length > 0 && !options.types.includes(entity.type)) return;
            if (options?.domain && entity.domain !== options.domain) return;
            if (options?.minConfidence !== undefined && entity.confidence < options.minConfidence) return;

            const daysSinceAccessed = (now - new Date(entity.lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
            const accessScore = Math.exp(-0.01 * daysSinceAccessed);

            // Vector-only result: no FTS score, so it contributes 0 for text signal
            const score =
              0 +                       // ftsScore * 0.4 = 0 (no keyword match)
              entity.confidence * 0.3 +
              accessScore * 0.1 +
              vecSim * 0.2;

            entityMap.set(entity.id, { ...entity, score });
          }
        }
      });
    }

    const scored = Array.from(entityMap.values());
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // Cached vector scores from the most recent searchHybrid() call
  private _lastVectorScores: Map<string, number> | null = null;

  /**
   * Hybrid search — runs both FTS5 and vector KNN, then merges results.
   * This is the recommended search method when vector search is available.
   *
   * Falls back to FTS5-only search when vectors are not available.
   */
  async searchHybrid(query: string, options?: SemanticSearchOptions): Promise<ScoredEntity[]> {
    if (!this._vectorAvailable || !this.embeddingProvider || !this.vectorSearch) {
      // Graceful degradation: fall back to FTS5-only
      return this.search(query, options);
    }

    const db = this.ensureOpen();
    const limit = options?.limit ?? 20;

    // Generate query embedding
    const queryEmbedding = await this.embeddingProvider.embed(query);

    // Run vector KNN search
    const vecResults = this.vectorSearch.search(db, queryEmbedding, limit * 3);

    // Build vector score map for the search() method to use
    this._lastVectorScores = new Map<string, number>();
    for (const result of vecResults) {
      this._lastVectorScores.set(result.id, result.similarity);
    }

    // Run the combined search (which now picks up vector scores)
    const results = this.search(query, options);

    // Clear cached scores
    this._lastVectorScores = null;

    return results;
  }

  /**
   * Batch-embed all entities that are missing embeddings.
   * Used for migration when enabling vector search on an existing database.
   *
   * @returns Number of entities embedded
   */
  async embedAllEntities(
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    if (!this._vectorAvailable || !this.embeddingProvider || !this.vectorSearch) {
      return 0;
    }

    const db = this.ensureOpen();
    const missingIds = this.vectorSearch.findMissingEmbeddings(db, 'entities');

    if (missingIds.length === 0) return 0;

    let done = 0;
    const batchSize = 32;

    for (let i = 0; i < missingIds.length; i += batchSize) {
      const batchIds = missingIds.slice(i, i + batchSize);
      const batchTexts: string[] = [];

      for (const id of batchIds) {
        const row = db.prepare('SELECT name, content FROM entities WHERE id = ?')
          .get(id) as { name: string; content: string } | undefined;
        if (row) {
          batchTexts.push(`${row.name} ${row.content}`);
        } else {
          batchTexts.push('');
        }
      }

      const embeddings = await this.embeddingProvider.embedBatch(batchTexts);

      const items = batchIds.map((id, idx) => ({
        id,
        embedding: embeddings[idx],
      }));

      this.vectorSearch.upsertBatch(db, items);
      done += batchIds.length;

      if (onProgress) {
        onProgress(done, missingIds.length);
      }
    }

    return done;
  }

  // ─── Confidence Decay ───────────────────────────────────────────

  /**
   * Apply exponential confidence decay to all entities.
   * formula: new_confidence = confidence * exp(-0.693 * days_since_verified / half_life)
   */
  decayAll(): DecayReport {
    const db = this.ensureOpen();

    const rows = db.prepare('SELECT * FROM entities').all() as EntityRow[];
    const now = Date.now();

    let decayed = 0;
    let expired = 0;
    let minConf = Infinity;
    let maxConf = -Infinity;
    let sumConf = 0;

    const update = db.prepare('UPDATE entities SET confidence = ? WHERE id = ?');
    const del = db.prepare('DELETE FROM entities WHERE id = ?');
    const delEdges = db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?');

    const runDecay = db.transaction(() => {
      for (const row of rows) {
        const halfLife = row.type === 'lesson'
          ? this.config.lessonDecayHalfLifeDays
          : this.config.decayHalfLifeDays;

        const daysSinceVerified = (now - new Date(row.last_verified).getTime()) / (1000 * 60 * 60 * 24);
        const newConfidence = row.confidence * Math.exp(-0.693 * daysSinceVerified / halfLife);

        // Check hard expiry
        if (row.expires_at && new Date(row.expires_at).getTime() < now) {
          delEdges.run(row.id, row.id);
          // Clean up embedding if vector search active
          if (this._vectorAvailable && this.vectorSearch) {
            this.vectorSearch.delete(db, row.id);
          }
          del.run(row.id);
          expired++;
          continue;
        }

        if (Math.abs(newConfidence - row.confidence) > 0.001) {
          update.run(newConfidence, row.id);
          decayed++;
          minConf = Math.min(minConf, newConfidence);
          maxConf = Math.max(maxConf, newConfidence);
          sumConf += newConfidence;
        } else {
          minConf = Math.min(minConf, row.confidence);
          maxConf = Math.max(maxConf, row.confidence);
          sumConf += row.confidence;
        }
      }
    });

    runDecay();

    const activeCount = rows.length - expired;

    return {
      entitiesProcessed: rows.length,
      entitiesDecayed: decayed,
      entitiesExpired: expired,
      minConfidence: activeCount > 0 ? minConf : 0,
      maxConfidence: activeCount > 0 ? maxConf : 0,
      avgConfidence: activeCount > 0 ? sumConf / activeCount : 0,
    };
  }

  // ─── Verify ─────────────────────────────────────────────────────

  /**
   * Re-verify an entity, refreshing lastVerified and optionally updating confidence.
   */
  verify(id: string, newConfidence?: number): void {
    const db = this.ensureOpen();
    const now = new Date().toISOString();

    if (newConfidence !== undefined) {
      db.prepare('UPDATE entities SET last_verified = ?, confidence = ? WHERE id = ?')
        .run(now, newConfidence, id);
    } else {
      db.prepare('UPDATE entities SET last_verified = ? WHERE id = ?')
        .run(now, id);
    }

    // Dual-write to JSONL
    this.appendToJournal('verify', { entityId: id, confidence: newConfidence ?? null });
  }

  // ─── Supersede ──────────────────────────────────────────────────

  /**
   * Mark an entity as superseded by a newer one.
   * Creates a 'supersedes' edge and lowers the old entity's confidence.
   */
  supersede(oldId: string, newId: string, reason?: string): void {
    const db = this.ensureOpen();

    // Create supersedes edge (new -> old) — connect() already journals the edge
    this.connect(newId, oldId, 'supersedes', reason);

    // Lower old entity's confidence by half
    const old = db.prepare('SELECT confidence FROM entities WHERE id = ?').get(oldId) as { confidence: number } | undefined;
    if (old) {
      const newConf = old.confidence * 0.5;
      db.prepare('UPDATE entities SET confidence = ? WHERE id = ?')
        .run(newConf, oldId);

      // Dual-write to JSONL
      this.appendToJournal('supersede', { oldId, newId, newConfidence: newConf, reason: reason ?? null });
    }
  }

  // ─── Graph Traversal ───────────────────────────────────────────

  /**
   * BFS graph traversal from a starting entity.
   * Returns all reachable entities (excluding the start) up to maxDepth.
   */
  explore(startId: string, options?: ExploreOptions): MemoryEntity[] {
    const db = this.ensureOpen();
    const maxDepth = options?.maxDepth ?? 2;
    const relations = options?.relations;
    const minWeight = options?.minWeight ?? 0;

    const visited = new Set<string>([startId]);
    const result: MemoryEntity[] = [];
    let frontier = [startId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        // Get outgoing edges
        let outgoing = db.prepare('SELECT * FROM edges WHERE from_id = ?').all(nodeId) as EdgeRow[];
        // Get incoming edges
        let incoming = db.prepare('SELECT * FROM edges WHERE to_id = ?').all(nodeId) as EdgeRow[];

        // Filter by relation type
        if (relations) {
          outgoing = outgoing.filter(e => relations.includes(e.relation as RelationType));
          incoming = incoming.filter(e => relations.includes(e.relation as RelationType));
        }

        // Filter by weight
        if (minWeight > 0) {
          outgoing = outgoing.filter(e => e.weight >= minWeight);
          incoming = incoming.filter(e => e.weight >= minWeight);
        }

        // Process outgoing: neighbor is the "to" end
        for (const edge of outgoing) {
          if (!visited.has(edge.to_id)) {
            visited.add(edge.to_id);
            const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(edge.to_id) as EntityRow | undefined;
            if (row) {
              result.push(rowToEntity(row));
              nextFrontier.push(edge.to_id);
            }
          }
        }

        // Process incoming: neighbor is the "from" end
        for (const edge of incoming) {
          if (!visited.has(edge.from_id)) {
            visited.add(edge.from_id);
            const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(edge.from_id) as EntityRow | undefined;
            if (row) {
              result.push(rowToEntity(row));
              nextFrontier.push(edge.from_id);
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    return result;
  }

  // ─── Stale Detection ───────────────────────────────────────────

  /**
   * Find entities that are stale (low confidence or old).
   */
  findStale(options?: {
    maxConfidence?: number;
    olderThan?: string;
    limit?: number;
  }): MemoryEntity[] {
    const db = this.ensureOpen();
    const limit = options?.limit ?? 50;

    let sql = 'SELECT * FROM entities WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.maxConfidence !== undefined) {
      sql += ' AND confidence <= ?';
      params.push(options.maxConfidence);
    }

    if (options?.olderThan) {
      sql += ' AND last_verified < ?';
      params.push(options.olderThan);
    }

    sql += ' ORDER BY confidence ASC, last_verified ASC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as EntityRow[];
    return rows.map(rowToEntity);
  }

  // ─── Export / Import ───────────────────────────────────────────

  /**
   * Export all entities and edges as a JSON-serializable structure.
   */
  export(): { entities: MemoryEntity[]; edges: MemoryEdge[] } {
    const db = this.ensureOpen();

    const entityRows = db.prepare('SELECT * FROM entities').all() as EntityRow[];
    const edgeRows = db.prepare('SELECT * FROM edges').all() as EdgeRow[];

    return {
      entities: entityRows.map(rowToEntity),
      edges: edgeRows.map(rowToEdge),
    };
  }

  /**
   * Import entities and edges, skipping duplicates by ID.
   */
  import(data: { entities: MemoryEntity[]; edges: MemoryEdge[] }): ImportReport {
    const db = this.ensureOpen();

    let entitiesImported = 0;
    let edgesImported = 0;
    let entitiesSkipped = 0;
    let edgesSkipped = 0;

    const insertEntity = db.prepare(`
      INSERT INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, expires_at, source, source_session, tags, domain, owner_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEdge = db.prepare(`
      INSERT INTO edges (id, from_id, to_id, relation, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const checkEntity = db.prepare('SELECT id FROM entities WHERE id = ?');
    const checkEdge = db.prepare('SELECT id FROM edges WHERE id = ?');

    const runImport = db.transaction(() => {
      for (const entity of data.entities) {
        if (checkEntity.get(entity.id)) {
          entitiesSkipped++;
          continue;
        }

        insertEntity.run(
          entity.id,
          entity.type,
          entity.name,
          entity.content,
          entity.confidence,
          entity.createdAt,
          entity.lastVerified,
          entity.lastAccessed,
          entity.expiresAt ?? null,
          entity.source,
          entity.sourceSession ?? null,
          JSON.stringify(entity.tags),
          entity.domain ?? null,
          entity.ownerId ?? null,
          entity.privacyScope ?? 'shared-project',
        );
        entitiesImported++;
      }

      for (const edge of data.edges) {
        if (checkEdge.get(edge.id)) {
          edgesSkipped++;
          continue;
        }

        insertEdge.run(
          edge.id,
          edge.fromId,
          edge.toId,
          edge.relation,
          edge.weight,
          edge.context ?? null,
          edge.createdAt,
        );
        edgesImported++;
      }
    });

    runImport();

    // Journal all successfully imported items (count-based — we know exactly how many were new)
    if (entitiesImported > 0 || edgesImported > 0) {
      this.appendToJournal('import', {
        entitiesImported, edgesImported, entitiesSkipped, edgesSkipped,
      });
    }

    return { entitiesImported, edgesImported, entitiesSkipped, edgesSkipped };
  }

  // ─── JSONL Rebuild (Disaster Recovery) ─────────────────────────

  /**
   * Import entities and edges from the JSONL append log.
   * Replays all 'remember' and 'connect' actions, skipping duplicates.
   * Applies 'forget' actions to remove deleted entities.
   * Returns the number of entities and edges recovered.
   *
   * Follows TopicMemory's resilience pattern: JSONL is source of truth,
   * SQLite is derived query layer that can be rebuilt at any time.
   */
  importFromJsonl(jsonlPath?: string): { entities: number; edges: number; forgotten: number } {
    const db = this.ensureOpen();
    const logPath = jsonlPath ?? this.jsonlPath;

    if (!fs.existsSync(logPath)) return { entities: 0, edges: 0, forgotten: 0 };

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    let entities = 0;
    let edges = 0;
    let forgotten = 0;

    const insertEntity = db.prepare(`
      INSERT OR IGNORE INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, expires_at, source, source_session, tags, domain, owner_id, privacy_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges (id, from_id, to_id, relation, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteEntity = db.prepare('DELETE FROM entities WHERE id = ?');
    const deleteEdges = db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?');

    const updateVerify = db.prepare('UPDATE entities SET last_verified = ?, confidence = COALESCE(?, confidence) WHERE id = ?');

    const runReplay = db.transaction(() => {
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          switch (entry.action) {
            case 'remember': {
              const e = entry.entity;
              if (!e?.id) break;
              const result = insertEntity.run(
                e.id, e.type, e.name, e.content, e.confidence,
                e.createdAt, e.lastVerified, e.lastAccessed,
                e.expiresAt ?? null, e.source, e.sourceSession ?? null,
                JSON.stringify(e.tags ?? []), e.domain ?? null,
                e.ownerId ?? null, e.privacyScope ?? 'shared-project',
              );
              if (result.changes > 0) entities++;
              break;
            }

            case 'connect': {
              const edge = entry.edge;
              if (!edge?.id) break;
              const result = insertEdge.run(
                edge.id, edge.fromId, edge.toId, edge.relation,
                edge.weight ?? 1.0, edge.context ?? null, edge.createdAt,
              );
              if (result.changes > 0) edges++;
              break;
            }

            case 'forget': {
              const id = entry.entityId;
              if (!id) break;
              deleteEdges.run(id, id);
              const result = deleteEntity.run(id);
              if (result.changes > 0) forgotten++;
              break;
            }

            case 'verify': {
              const id = entry.entityId;
              if (!id) break;
              updateVerify.run(entry.timestamp, entry.confidence ?? null, id);
              break;
            }

            case 'supersede': {
              // supersede journals are informational — the actual connect + confidence
              // update are replayed from their own journal entries
              break;
            }
          }
        } catch { /* @silent-fallback-ok — skip corrupted JSONL lines */ }
      }
    });

    runReplay();

    // Rebuild FTS5 index to match recovered data
    try {
      db.exec(`INSERT INTO entities_fts(entities_fts) VALUES ('rebuild')`);
    } catch { /* @silent-fallback-ok — FTS rebuild non-critical */ }

    return { entities, edges, forgotten };
  }

  /**
   * Full rebuild — drop all entities and edges, rebuild from JSONL.
   * This is the nuclear option for disaster recovery.
   *
   * Preserves the JSONL log (source of truth) and rebuilds SQLite from it.
   */
  rebuild(jsonlPath?: string): { entities: number; edges: number; forgotten: number } {
    const db = this.ensureOpen();

    db.exec('DELETE FROM edges');
    db.exec('DELETE FROM entities');
    db.exec(`INSERT INTO entities_fts(entities_fts) VALUES ('rebuild')`);

    // Delete vector embeddings if available (they'll be regenerated)
    if (this._vectorAvailable) {
      try {
        db.exec('DELETE FROM entity_embeddings');
      } catch { /* @silent-fallback-ok — vector table may not exist */ }
    }

    return this.importFromJsonl(jsonlPath);
  }

  /**
   * Write a full JSON snapshot to disk for periodic backup.
   * This is a point-in-time export that complements the JSONL append log.
   */
  writeSnapshot(snapshotPath?: string): { path: string; entities: number; edges: number; sizeBytes: number } {
    const data = this.export();
    const outPath = snapshotPath ?? this.config.dbPath.replace(/\.db$/, '-snapshot.json');

    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(outPath, json, 'utf-8');

    return {
      path: outPath,
      entities: data.entities.length,
      edges: data.edges.length,
      sizeBytes: Buffer.byteLength(json),
    };
  }

  // ─── Statistics ─────────────────────────────────────────────────

  /**
   * Get aggregate statistics about the memory store.
   */
  stats(): SemanticMemoryStats {
    const db = this.ensureOpen();

    const entityCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number }).cnt;
    const edgeCount = (db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt;

    // Count by type
    const typeCounts = db.prepare('SELECT type, COUNT(*) as cnt FROM entities GROUP BY type').all() as { type: string; cnt: number }[];
    const entityCountsByType: Record<string, number> = {};
    for (const row of typeCounts) {
      entityCountsByType[row.type] = row.cnt;
    }

    // Avg confidence
    const avgRow = db.prepare('SELECT AVG(confidence) as avg FROM entities').get() as { avg: number | null };
    const avgConfidence = avgRow.avg ?? 0;

    // Stale count
    const staleCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities WHERE confidence < ?').get(this.config.staleThreshold) as { cnt: number }).cnt;

    // DB file size
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(this.config.dbPath).size;
    } catch {
      // File may not exist yet  @silent-fallback-ok: stat before DB fully flushed
    }

    // Vector search stats
    let embeddingCount = 0;
    if (this._vectorAvailable && this.vectorSearch) {
      try {
        embeddingCount = this.vectorSearch.count(db);
      } catch { // @silent-fallback-ok: vec0 table may not be queryable, report 0 embeddings
      }
    }

    return {
      totalEntities: entityCount,
      totalEdges: edgeCount,
      entityCountsByType: entityCountsByType as Record<EntityType, number>,
      avgConfidence: Math.round(avgConfidence * 100) / 100, // Round to 2 decimal places
      staleCount,
      dbSizeBytes,
      vectorSearchAvailable: this._vectorAvailable,
      embeddingCount,
    };
  }

  // ─── Context Generation ─────────────────────────────────────────

  /**
   * Generate formatted markdown context for a query, suitable for session injection.
   * Returns empty string if no relevant entities found.
   */
  getRelevantContext(
    query: string,
    options?: { maxTokens?: number; limit?: number; userId?: string },
  ): string {
    const maxTokens = options?.maxTokens ?? 2000;
    const limit = options?.limit ?? 10;

    const results = this.search(query, { limit, userId: options?.userId });
    if (results.length === 0) return '';

    const lines: string[] = [];
    let estimatedTokens = 0;

    for (const entity of results) {
      const entry = `### ${entity.name} (${entity.type})\n${entity.content}\n`;
      // Rough token estimate: ~0.75 tokens per word
      const entryTokens = entry.split(/\s+/).length / 0.75;

      if (estimatedTokens + entryTokens > maxTokens) break;

      lines.push(entry);
      estimatedTokens += entryTokens;
    }

    return lines.join('\n');
  }

  // ─── Private Helpers ───────────────────────────────────────────

  private getConnections(db: Database, entityId: string): ConnectedEntity[] {
    const connections: ConnectedEntity[] = [];

    // Outgoing edges — use explicit column aliases to avoid JOIN collisions
    const outgoing = db.prepare(`
      SELECT
        e.id as edge_id, e.from_id, e.to_id, e.relation, e.weight,
        e.context as edge_context, e.created_at as edge_created_at,
        ent.id as ent_id, ent.type, ent.name, ent.content, ent.confidence,
        ent.created_at as ent_created_at, ent.last_verified, ent.last_accessed,
        ent.expires_at, ent.source, ent.source_session, ent.tags, ent.domain,
        ent.owner_id, ent.privacy_scope
      FROM edges e
      JOIN entities ent ON ent.id = e.to_id
      WHERE e.from_id = ?
    `).all(entityId) as JoinRow[];

    for (const row of outgoing) {
      connections.push({
        entity: joinRowToEntity(row),
        edge: joinRowToEdge(row),
        direction: 'outgoing',
      });
    }

    // Incoming edges
    const incoming = db.prepare(`
      SELECT
        e.id as edge_id, e.from_id, e.to_id, e.relation, e.weight,
        e.context as edge_context, e.created_at as edge_created_at,
        ent.id as ent_id, ent.type, ent.name, ent.content, ent.confidence,
        ent.created_at as ent_created_at, ent.last_verified, ent.last_accessed,
        ent.expires_at, ent.source, ent.source_session, ent.tags, ent.domain,
        ent.owner_id, ent.privacy_scope
      FROM edges e
      JOIN entities ent ON ent.id = e.from_id
      WHERE e.to_id = ?
    `).all(entityId) as JoinRow[];

    for (const row of incoming) {
      connections.push({
        entity: joinRowToEntity(row),
        edge: joinRowToEdge(row),
        direction: 'incoming',
      });
    }

    return connections;
  }
}

// ─── Row Types ──────────────────────────────────────────────────

interface EntityRow {
  id: string;
  type: string;
  name: string;
  content: string;
  confidence: number;
  created_at: string;
  last_verified: string;
  last_accessed: string;
  expires_at: string | null;
  source: string;
  source_session: string | null;
  tags: string;
  domain: string | null;
  owner_id: string | null;
  privacy_scope: string | null;
  rowid?: number;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  weight: number;
  context: string | null;
  created_at: string;
}

interface EvidenceRow {
  evidence_id: string;
  entity_id: string;
  kind: string;
  source_id: string;
  path: string | null;
  line_start: number | null;
  line_end: number | null;
  lines: string | null;
  weight: number | null;
  confidence: number | null;
  privacy_tier: string | null;
  note: string | null;
  updated_at: string;
}

function rowToEvidence(row: EvidenceRow): MemoryEvidence {
  const ev: MemoryEvidence = {
    kind: row.kind as MemoryEvidenceKind,
    sourceId: row.source_id,
    updatedAt: row.updated_at,
  };
  if (row.path !== null) ev.path = row.path;
  if (row.line_start !== null) ev.lineStart = row.line_start;
  if (row.line_end !== null) ev.lineEnd = row.line_end;
  if (row.lines !== null) ev.lines = row.lines;
  if (row.weight !== null) ev.weight = row.weight;
  if (row.confidence !== null) ev.confidence = row.confidence;
  if (row.privacy_tier !== null) ev.privacyTier = row.privacy_tier as EvidencePrivacyTier;
  if (row.note !== null) ev.note = row.note;
  return ev;
}

/**
 * Per-producer allowlist of evidence kinds. Mismatches reject with
 * EvidencePolicyError. Cross-process spoofing is NOT in the threat model
 * — the producer is a process-internal symbol the calling subsystem passes.
 */
const PRODUCER_KIND_ALLOWLIST: Record<EvidenceProducerId, ReadonlySet<MemoryEvidenceKind>> = {
  EvolutionManager: new Set(['feedback', 'pattern-entity', 'supersedes-evidence']),
  DispatchExecutor: new Set(['pattern-entity', 'job-run', 'ledger-entry']),
  DecisionJournal: new Set(['message', 'commit', 'ledger-entry', 'session']),
  LearnSkill: new Set(['message', 'session']),
  // Spec § Producers line 229: `manual` is for `external-url` only and
  // additionally requires entity owner == caller user. The owner check
  // requires caller-identity threading (Phase 2 producer integration),
  // documented as a tracked deferral in the side-effects artifact.
  manual: new Set(['external-url']),
};

export class EvidencePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidencePolicyError';
  }
}

/**
 * Evidence-level privacy ordering. Used by the write-time
 * `assertNarrowingOnly` invariant. Mirrors EvidenceRenderer's local copy
 * (which owns the READ path); kept here so the write-side check has no
 * module-cycle dependency on the renderer.
 */
const EVIDENCE_TIER_ORDER: Record<EvidencePrivacyTier, number> = {
  'public': 0,
  'shared-project': 1,
  'private': 2,
  'sensitive': 3,
};

/** Map an entity scope onto the comparable evidence-tier scale. */
function entityScopeToTierOrdinal(scope: PrivacyScopeType): number {
  switch (scope) {
    case 'shared-project':
      return EVIDENCE_TIER_ORDER['shared-project'];
    case 'shared-topic':
      // No 'shared-topic' in the evidence vocabulary; conservative-map to
      // 'private' so a topic-scope entity cannot accept wider-than-private
      // evidence tiers.
      return EVIDENCE_TIER_ORDER['private'];
    case 'private':
      return EVIDENCE_TIER_ORDER['private'];
  }
}

/**
 * Visibility predicates are owned by EvidenceRenderer (the single
 * privacy-enforcement helper per spec § Storage and Privacy line 315).
 * SemanticMemory's read paths delegate to those exports so the filter
 * rule lives in exactly one place. Local aliases keep the call-site shape.
 */
const isEntityVisibleAtScope = rendererIsEntityVisibleAtScope;
const isEvidenceVisibleAtScope = rendererIsEvidenceVisibleAtScope;

/**
 * Narrowing-only constraint: an evidence entry's `privacyTier` may be equal
 * to or MORE restrictive than its entity's `privacyScope`, never less. This
 * stops a producer from publishing an evidence row at a wider visibility
 * than the entity it cites.
 */
function assertNarrowingOnly(
  entityScope: PrivacyScopeType,
  evidenceTier: EvidencePrivacyTier | undefined,
): void {
  if (evidenceTier === undefined) return; // inherits entity scope; safe
  if (EVIDENCE_TIER_ORDER[evidenceTier] < entityScopeToTierOrdinal(entityScope)) {
    throw new EvidencePolicyError(
      `evidence privacyTier '${evidenceTier}' is wider than entity privacyScope '${entityScope}' (narrowing-only)`,
    );
  }
}

/** Row from a JOIN query with explicit column aliases */
interface JoinRow {
  edge_id: string;
  from_id: string;
  to_id: string;
  relation: string;
  weight: number;
  edge_context: string | null;
  edge_created_at: string;
  ent_id: string;
  type: string;
  name: string;
  content: string;
  confidence: number;
  ent_created_at: string;
  last_verified: string;
  last_accessed: string;
  expires_at: string | null;
  source: string;
  source_session: string | null;
  tags: string;
  domain: string | null;
  owner_id: string | null;
  privacy_scope: string | null;
}

// ─── Converters ─────────────────────────────────────────────────

function rowToEntity(row: EntityRow): MemoryEntity {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastVerified: row.last_verified,
    lastAccessed: row.last_accessed,
    expiresAt: row.expires_at ?? undefined,
    source: row.source,
    sourceSession: row.source_session ?? undefined,
    tags: JSON.parse(row.tags),
    domain: row.domain ?? undefined,
    ownerId: row.owner_id ?? undefined,
    privacyScope: (row.privacy_scope as PrivacyScopeType) ?? undefined,
  };
}

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as RelationType,
    weight: row.weight,
    context: row.context ?? undefined,
    createdAt: row.created_at,
  };
}

/** Convert a JOIN row (with explicit aliases) to a MemoryEntity */
function joinRowToEntity(row: JoinRow): MemoryEntity {
  return {
    id: row.ent_id,
    type: row.type as EntityType,
    name: row.name,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.ent_created_at,
    lastVerified: row.last_verified,
    lastAccessed: row.last_accessed,
    expiresAt: row.expires_at ?? undefined,
    source: row.source,
    sourceSession: row.source_session ?? undefined,
    tags: JSON.parse(row.tags),
    domain: row.domain ?? undefined,
    ownerId: row.owner_id ?? undefined,
    privacyScope: (row.privacy_scope as PrivacyScopeType) ?? undefined,
  };
}

/** Convert a JOIN row (with explicit aliases) to a MemoryEdge */
function joinRowToEdge(row: JoinRow): MemoryEdge {
  return {
    id: row.edge_id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as RelationType,
    weight: row.weight,
    context: row.edge_context ?? undefined,
    createdAt: row.edge_created_at,
  };
}
