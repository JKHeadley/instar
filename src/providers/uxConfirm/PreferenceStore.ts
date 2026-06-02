/**
 * PreferenceStore — sqlite-backed cache for Phase 5b's framework+model picks.
 *
 * Per `specs/provider-portability/10-suggest-and-confirm-ux.md`: when a
 * user confirms a framework+model pairing for a task pattern, the pick
 * sticks across future tasks of the same pattern. This is the storage.
 *
 * Cache key: (userId, taskPattern). One row per pair.
 * Value: framework + model + snapshot of state-at-cache-time that the
 * TriggerGate consults to decide whether the cached pick is still valid.
 *
 * Storage location: caller-supplied path. For application use, that's
 * `<stateDir>/framework-model-preferences.db`. For tests, ':memory:'.
 *
 * Threat model: drift-correction, not security boundary. A malicious
 * write to the cache would only result in the agent picking a different
 * framework+model — re-confirmed at first cost-shift / catalog-update
 * trigger anyway.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../../core/SqliteRegistry.js';
import fs from 'node:fs';
import path from 'node:path';

import type { CostStateSnapshot } from '../costAwareRouting.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'PROVISIONAL';

export interface FrameworkModelPreference {
  /** The framework slug (e.g. "claude-code", "codex-cli", "aider"). */
  framework: string;
  /** The model id (e.g. "opus-4.7", "gpt-5.3-codex", "deepseek-v4"). */
  model: string;
  /** ISO timestamp when the user confirmed this pick. */
  confirmedAt: string;
  /** Snapshot of cost state at confirm time. Consulted by TriggerGate. */
  costStateSnapshot: CostStateSnapshot;
  /** Catalog version at confirm time. Compared with current to detect bumps. */
  catalogVersionAtCache: string;
  /** Confidence the catalog reported for this pick at confirm time. */
  confidenceAtCache: ConfidenceLevel;
}

export interface PreferenceStoreOptions {
  /** Filesystem path for the sqlite db, or ':memory:' for tests. */
  dbPath: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PreferenceStore {
  private readonly db: BetterSqliteDatabase;
  private _unregisterSqlite?: () => void;

  constructor(options: PreferenceStoreOptions) {
    if (options.dbPath !== ':memory:') {
      const dir = path.dirname(options.dbPath);
      if (!fs.existsSync(dir)) {
        // RULE 3: EXEMPT — best-effort parent-dir creation for the sqlite
        // file. No state parsing; mkdirSync recursive is safe on all hosts.
        // safe-fs-allow: not destructive (mkdir, not rm).
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    // Close-on-exit registry (SqliteRegistry.ts). Registered after the db is open.
    this._unregisterSqlite = registerSqliteHandle(() => {
      try { this.db?.close(); } catch { /* already closed — fine */ }
    });
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS framework_model_preferences (
        user_id TEXT NOT NULL,
        task_pattern TEXT NOT NULL,
        framework TEXT NOT NULL,
        model TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        cost_state_snapshot_json TEXT NOT NULL,
        catalog_version_at_cache TEXT NOT NULL,
        confidence_at_cache TEXT NOT NULL,
        PRIMARY KEY (user_id, task_pattern)
      );
    `);
  }

  /** Read a cached preference. Returns null when none exists. */
  get(userId: string, taskPattern: string): FrameworkModelPreference | null {
    const row = this.db
      .prepare(
        `SELECT framework, model, confirmed_at, cost_state_snapshot_json,
                catalog_version_at_cache, confidence_at_cache
         FROM framework_model_preferences
         WHERE user_id = ? AND task_pattern = ?`,
      )
      .get(userId, taskPattern) as
      | {
          framework: string;
          model: string;
          confirmed_at: string;
          cost_state_snapshot_json: string;
          catalog_version_at_cache: string;
          confidence_at_cache: string;
        }
      | undefined;

    if (!row) return null;

    let costStateSnapshot: CostStateSnapshot;
    try {
      costStateSnapshot = JSON.parse(row.cost_state_snapshot_json) as CostStateSnapshot;
    } catch {
      // Corrupt row — treat as missing so the gate will re-ask.
      return null;
    }

    return {
      framework: row.framework,
      model: row.model,
      confirmedAt: row.confirmed_at,
      costStateSnapshot,
      catalogVersionAtCache: row.catalog_version_at_cache,
      confidenceAtCache: row.confidence_at_cache as ConfidenceLevel,
    };
  }

  /** Insert or replace a preference. */
  set(userId: string, taskPattern: string, preference: FrameworkModelPreference): void {
    this.db
      .prepare(
        `INSERT INTO framework_model_preferences
           (user_id, task_pattern, framework, model, confirmed_at,
            cost_state_snapshot_json, catalog_version_at_cache, confidence_at_cache)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, task_pattern) DO UPDATE SET
           framework = excluded.framework,
           model = excluded.model,
           confirmed_at = excluded.confirmed_at,
           cost_state_snapshot_json = excluded.cost_state_snapshot_json,
           catalog_version_at_cache = excluded.catalog_version_at_cache,
           confidence_at_cache = excluded.confidence_at_cache`,
      )
      .run(
        userId,
        taskPattern,
        preference.framework,
        preference.model,
        preference.confirmedAt,
        JSON.stringify(preference.costStateSnapshot),
        preference.catalogVersionAtCache,
        preference.confidenceAtCache,
      );
  }

  /** Remove the cached preference for one (user, pattern) pair. No-op if absent. */
  clear(userId: string, taskPattern: string): void {
    this.db
      .prepare(
        `DELETE FROM framework_model_preferences
         WHERE user_id = ? AND task_pattern = ?`,
      )
      .run(userId, taskPattern);
  }

  /** Remove every cached preference for a user. */
  clearAll(userId: string): void {
    this.db
      .prepare(`DELETE FROM framework_model_preferences WHERE user_id = ?`)
      .run(userId);
  }

  /** List all patterns this user has confirmed preferences for. */
  listPatterns(userId: string): ReadonlyArray<string> {
    const rows = this.db
      .prepare(
        `SELECT task_pattern FROM framework_model_preferences WHERE user_id = ? ORDER BY task_pattern`,
      )
      .all(userId) as Array<{ task_pattern: string }>;
    return rows.map((r) => r.task_pattern);
  }

  /** Close the underlying database connection. */
  close(): void {
    if (this._unregisterSqlite) { this._unregisterSqlite(); this._unregisterSqlite = undefined; }
    this.db.close();
  }
}
