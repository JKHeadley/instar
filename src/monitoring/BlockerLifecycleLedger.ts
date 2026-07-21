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

export type MaturationMetricSource = 'blocker-summary' | 'blocker-trend';
export type MaturationEvaluationStatus = 'ready' | 'hold' | 'stale-evidence' | 'insufficient-evidence' | 'missing-contract' | 'missed-cadence';

export interface MaturationMetricObservation {
  origin: string; featureId: string; metricId: string; source: MaturationMetricSource;
  sourceRef: string; observedAtMs: number; value: number; samples: number;
  descriptorVersion?: number; benchmarkRef?: string;
}

export interface MaturationEvaluationRecord {
  origin: string; featureId: string; rung: string; dueSlotMs: number; evaluatedAtMs: number;
  status: MaturationEvaluationStatus; passingMetrics: number; totalMetrics: number;
  minNormalizedMargin: number | null; contractHash: string; newestEvidenceAtMs: number | null;
  additionalMissedSlots?: number;
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
        CREATE TABLE IF NOT EXISTS maturation_metric_observations (
          origin TEXT NOT NULL, feature_id TEXT NOT NULL, metric_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('blocker-summary','blocker-trend')),
          source_ref TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, value REAL NOT NULL,
          samples INTEGER NOT NULL, descriptor_version INTEGER NOT NULL DEFAULT 1,
          benchmark_ref TEXT, schema_version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(origin,feature_id,metric_id,source,source_ref,observed_at_ms)
        );
        CREATE INDEX IF NOT EXISTS idx_maturation_observation_latest ON maturation_metric_observations
          (origin,feature_id,metric_id,source,source_ref,observed_at_ms DESC);
        CREATE TABLE IF NOT EXISTS maturation_evaluations (
          origin TEXT NOT NULL, feature_id TEXT NOT NULL, rung TEXT NOT NULL,
          due_slot_ms INTEGER NOT NULL, evaluated_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
          passing_metrics INTEGER NOT NULL, total_metrics INTEGER NOT NULL,
          min_normalized_margin REAL, contract_hash TEXT NOT NULL, newest_evidence_at_ms INTEGER,
          additional_missed_slots INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(origin,feature_id,due_slot_ms)
        );
        CREATE INDEX IF NOT EXISTS idx_maturation_evaluation_trend ON maturation_evaluations
          (origin,feature_id,due_slot_ms DESC);
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

  recordMaturationObservation(record: MaturationMetricObservation): boolean {
    if (!this.db || !Number.isFinite(record.value) || !Number.isFinite(record.observedAtMs) ||
        !Number.isInteger(record.samples) || record.samples < 0 || record.samples > 100_000 ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(record.featureId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(record.metricId) ||
        record.sourceRef.length > 128 || (record.benchmarkRef?.length ?? 0) > 128) return false;
    const now = this.opts.now?.() ?? Date.now();
    if (record.observedAtMs < now - 90 * 86_400_000 || record.observedAtMs > now + 300_000) return false;
    try {
      this.db.prepare(`INSERT OR IGNORE INTO maturation_metric_observations
        (origin,feature_id,metric_id,source,source_ref,observed_at_ms,value,samples,descriptor_version,benchmark_ref)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(record.origin, record.featureId, record.metricId, record.source,
          record.sourceRef, Math.round(record.observedAtMs), record.value, record.samples,
          record.descriptorVersion ?? 1, record.benchmarkRef ?? null);
      return true;
    } catch { /* @silent-fallback-ok — false makes the failed observation write explicit to the caller */ return false; }
  }

  maturationObservations(origin: string, sinceMs: number): MaturationMetricObservation[] {
    if (!this.db) return [];
    try {
      return this.db.prepare(`SELECT origin,feature_id AS featureId,metric_id AS metricId,source,
        source_ref AS sourceRef,observed_at_ms AS observedAtMs,value,samples,
        descriptor_version AS descriptorVersion,benchmark_ref AS benchmarkRef
        FROM maturation_metric_observations WHERE origin=? AND observed_at_ms>=?
        ORDER BY observed_at_ms DESC LIMIT 8192`).all(origin, Math.round(sinceMs)) as MaturationMetricObservation[];
    } catch { /* @silent-fallback-ok — empty evidence fails maturation closed as insufficient evidence */ return []; }
  }

  recordMaturationEvaluation(record: MaturationEvaluationRecord): boolean {
    if (!this.db) return false;
    try {
      this.db.prepare(`INSERT OR IGNORE INTO maturation_evaluations
        (origin,feature_id,rung,due_slot_ms,evaluated_at_ms,status,passing_metrics,total_metrics,
         min_normalized_margin,contract_hash,newest_evidence_at_ms,additional_missed_slots)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(record.origin, record.featureId, record.rung,
          Math.round(record.dueSlotMs), Math.round(record.evaluatedAtMs), record.status,
          record.passingMetrics, record.totalMetrics, record.minNormalizedMargin, record.contractHash,
          record.newestEvidenceAtMs, record.additionalMissedSlots ?? 0);
      return true;
    } catch { /* @silent-fallback-ok — false makes the failed evaluation write explicit to the caller */ return false; }
  }

  maturationEvaluations(origin: string, sinceMs: number): MaturationEvaluationRecord[] {
    if (!this.db) return [];
    try {
      return this.db.prepare(`SELECT origin,feature_id AS featureId,rung,due_slot_ms AS dueSlotMs,
        evaluated_at_ms AS evaluatedAtMs,status,passing_metrics AS passingMetrics,total_metrics AS totalMetrics,
        min_normalized_margin AS minNormalizedMargin,contract_hash AS contractHash,
        newest_evidence_at_ms AS newestEvidenceAtMs,additional_missed_slots AS additionalMissedSlots
        FROM maturation_evaluations WHERE origin=? AND due_slot_ms>=?
        ORDER BY feature_id,due_slot_ms`).all(origin, Math.round(sinceMs)) as MaturationEvaluationRecord[];
    } catch { /* @silent-fallback-ok — empty history is surfaced as unevaluated/missed cadence */ return []; }
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
      const maturationCutoff = (this.opts.now?.() ?? Date.now()) - 90 * 86_400_000;
      const observations = this.db.prepare(`DELETE FROM maturation_metric_observations WHERE rowid IN
        (SELECT rowid FROM maturation_metric_observations WHERE observed_at_ms<? LIMIT 1000)`).run(maturationCutoff).changes;
      const evaluations = this.db.prepare(`DELETE FROM maturation_evaluations WHERE rowid IN
        (SELECT rowid FROM maturation_evaluations WHERE due_slot_ms<? LIMIT 1000)`).run(maturationCutoff).changes;
      return old + cap + observations + evaluations;
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
