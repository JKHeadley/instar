/**
 * Non-authoritative, measure-only blocker lifecycle telemetry.
 * CommitmentTracker remains the sole state authority; every method here is
 * fail-soft and no caller may branch commitment behavior on its result.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';

export type BlockerFactor = 'request-to-persist' | 'clear-latency';
export type BlockerOutcome = 'observed' | 'legacy-missing-start' | 'clock-regression-or-implausible';

export interface BlockerMetricRecord {
  origin: string;
  factor: BlockerFactor;
  sourceEventId: string;
  observedAtMs: number;
  latencyMs: number | null;
  outcome: BlockerOutcome;
}

export interface BlockerLedgerCounters {
  attempted: number;
  inserted: number;
  deduped: number;
  failed: number;
  queueOverflow: number;
  reconciled: number;
}

export class BlockerLifecycleLedger {
  private db: BetterSqliteDatabase | null = null;
  private unregisterSqlite: (() => void) | null = null;
  private queue: BlockerMetricRecord[] = [];
  private draining = false;
  private readonly countersState: BlockerLedgerCounters = {
    attempted: 0, inserted: 0, deduped: 0, failed: 0, queueOverflow: 0, reconciled: 0,
  };

  constructor(private readonly opts: { dbPath: string; now?: () => number }) {
    try {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
      this.db = new Database(opts.dbPath);
      this.unregisterSqlite = registerSqliteHandle(() => this.db?.close());
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 25');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS blocker_lifecycle_metrics (
          origin TEXT NOT NULL,
          factor TEXT NOT NULL CHECK (factor IN ('request-to-persist','clear-latency')),
          source_event_id TEXT NOT NULL,
          observed_at_ms INTEGER NOT NULL,
          latency_ms REAL,
          outcome TEXT NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(origin, factor, source_event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_blocker_lifecycle_window
          ON blocker_lifecycle_metrics(factor, observed_at_ms);
      `);
    } catch { // @silent-fallback-ok — availability is exposed as 503/guard degradation
      this.db = null;
    }
  }

  available(): boolean { return this.db !== null; }
  counters(): BlockerLedgerCounters { return { ...this.countersState }; }

  enqueue(record: BlockerMetricRecord): void {
    this.countersState.attempted++;
    if (this.queue.length >= 256) {
      this.countersState.queueOverflow++;
      this.countersState.failed++;
      return;
    }
    this.queue.push({ ...record });
    if (!this.draining) {
      this.draining = true;
      setImmediate(() => this.drain());
    }
  }

  /** Synchronous idempotent path used by bounded reconciliation. */
  record(record: BlockerMetricRecord, reconciled = false): boolean {
    if (reconciled) this.countersState.attempted++;
    return this.insert(record, reconciled);
  }

  has(origin: string, factor: BlockerFactor, sourceEventId: string): boolean {
    if (!this.db) return false;
    try {
      return !!this.db.prepare(`SELECT 1 FROM blocker_lifecycle_metrics
        WHERE origin=? AND factor=? AND source_event_id=?`).get(origin, factor, sourceEventId);
    } catch { /* @silent-fallback-ok — false is reconciler-visible absence */ return false; }
  }

  values(factor: BlockerFactor, sinceMs: number): Array<{ observedAtMs: number; latencyMs: number | null; outcome: string }> {
    if (!this.db) return [];
    try {
      return this.db.prepare(`SELECT observed_at_ms AS observedAtMs, latency_ms AS latencyMs, outcome
        FROM blocker_lifecycle_metrics WHERE factor=? AND observed_at_ms>=? ORDER BY observed_at_ms`)
        .all(factor, Math.round(sinceMs)) as Array<{ observedAtMs: number; latencyMs: number | null; outcome: string }>;
    } catch { /* @silent-fallback-ok — empty read pairs with degraded guard counters */ return []; }
  }

  prune(): number {
    if (!this.db) return 0;
    try {
      const cutoff = (this.opts.now?.() ?? Date.now()) - 90 * 86_400_000;
      const old = this.db.prepare(`DELETE FROM blocker_lifecycle_metrics WHERE rowid IN
        (SELECT rowid FROM blocker_lifecycle_metrics WHERE observed_at_ms<? LIMIT 1000)`).run(cutoff).changes;
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM blocker_lifecycle_metrics').get() as { n: number }).n;
      const excess = Math.max(0, count - 250_000);
      const cap = excess > 0 ? this.db.prepare(`DELETE FROM blocker_lifecycle_metrics WHERE rowid IN
        (SELECT rowid FROM blocker_lifecycle_metrics ORDER BY observed_at_ms LIMIT ?)`).run(Math.min(1000, excess)).changes : 0;
      return old + cap;
    } catch { /* @silent-fallback-ok — pruning retries on the next bounded pass */ return 0; }
  }

  close(): void {
    this.unregisterSqlite?.();
    this.unregisterSqlite = null;
    try { this.db?.close(); } catch { /* @silent-fallback-ok — close is best-effort */ }
    this.db = null;
  }

  private drain(): void {
    try {
      let n = 0;
      while (this.queue.length > 0 && n < 64) {
        const record = this.queue.shift()!;
        this.insert(record, false);
        n++;
      }
    } finally {
      if (this.queue.length > 0) setImmediate(() => this.drain());
      else this.draining = false;
    }
  }

  private insert(record: BlockerMetricRecord, reconciled: boolean): boolean {
    if (!this.db) { this.countersState.failed++; return false; }
    try {
      const info = this.db.prepare(`INSERT OR IGNORE INTO blocker_lifecycle_metrics
        (origin,factor,source_event_id,observed_at_ms,latency_ms,outcome,schema_version)
        VALUES (?,?,?,?,?,?,1)`).run(
          record.origin, record.factor, record.sourceEventId, Math.round(record.observedAtMs),
          record.latencyMs === null ? null : Math.max(0, record.latencyMs), record.outcome,
        );
      if (info.changes > 0) {
        this.countersState.inserted++;
        if (reconciled) this.countersState.reconciled++;
      } else this.countersState.deduped++;
      return true;
    } catch { // @silent-fallback-ok — failed counter/guard status exposes insert degradation
      this.countersState.failed++;
      return false;
    }
  }
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}
