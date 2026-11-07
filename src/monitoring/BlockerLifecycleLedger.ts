/**
 * Non-authoritative, measure-only blocker lifecycle telemetry.
 * CommitmentTracker remains the sole state authority; every method here is
 * fail-soft and no caller may branch commitment behavior on its result.
 */
import fs from 'node:fs';
import type { MaturationEvaluationContract } from '../core/InitiativeTracker.js';
import { measurementContractHash, validArchivedContract, validGenericMeasurement, type MeasurementContractVersions } from './MeasurementContractVersion.js';
import { projectMaturationOutcome } from './MaturationOutcome.js';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';

export type BlockerFactor = 'request-to-persist' | 'clear-latency' | 'deliverable-completion';
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

export type MaturationMetricSource = 'blocker-summary' | 'blocker-trend' | 'feature-summary';
export type MaturationEvaluationStatus = 'ready' | 'hold' | 'stale-evidence' | 'insufficient-evidence' | 'missing-contract' | 'invalid-contract' | 'missed-cadence';

export interface MaturationMetricObservation {
  origin: string; featureId: string; metricId: string; source: MaturationMetricSource;
  sourceRef: string; observedAtMs: number; value: number; samples: number;
  descriptorVersion?: number; benchmarkRef?: string;
}

export interface MaturationEvaluationRecord {
  origin: string; featureId: string; rung: string | null; dueSlotMs: number; evaluatedAtMs: number;
  status: MaturationEvaluationStatus; passingMetrics: number; totalMetrics: number;
  minNormalizedMargin: number | null; contractHash: string; newestEvidenceAtMs: number | null;
  additionalMissedSlots?: number;
}

export class BlockerLifecycleLedger {
  private db: BetterSqliteDatabase | null = null;
  private archiveReady = false;
  private unregisterSqlite: (() => void) | null = null;
  private queue: BlockerMetricRecord[] = [];
  private draining = false;
  private readonly countersState: BlockerLedgerCounters = {
    attempted: 0, inserted: 0, deduped: 0, failed: 0, queueOverflow: 0, reconciled: 0,
  };

  constructor(private readonly opts: { dbPath: string; now?: () => number }) {
    let opened: BetterSqliteDatabase | null = null;
    try {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
      opened = new Database(opts.dbPath);
      this.db = opened;
      this.unregisterSqlite = registerSqliteHandle(() => opened?.close());
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 25');
      this.ensureSchema();
      this.ensureMeasurementArchive();
    } catch { // @silent-fallback-ok — availability is exposed as 503/guard degradation
      this.unregisterSqlite?.();
      this.unregisterSqlite = null;
      try { opened?.close(); } catch { /* @silent-fallback-ok — constructor already degrades unavailable */ }
      this.db = null;
    }
  }

  private ensureSchema(): void {
    if (!this.db) return;
    const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='blocker_lifecycle_metrics'")
      .get() as { sql?: string } | undefined;
    if (existing?.sql && !existing.sql.includes('deliverable-completion')) {
      this.db.transaction(() => {
        this.db!.exec(`
          DROP INDEX IF EXISTS idx_blocker_lifecycle_window;
          ALTER TABLE blocker_lifecycle_metrics RENAME TO blocker_lifecycle_metrics_v1;
          CREATE TABLE blocker_lifecycle_metrics (
            origin TEXT NOT NULL,
            factor TEXT NOT NULL CHECK (factor IN ('request-to-persist','clear-latency','deliverable-completion')),
            source_event_id TEXT NOT NULL,
            observed_at_ms INTEGER NOT NULL,
            latency_ms REAL,
            outcome TEXT NOT NULL,
            schema_version INTEGER NOT NULL DEFAULT 1,
            UNIQUE(origin, factor, source_event_id)
          );
          INSERT INTO blocker_lifecycle_metrics
            (origin,factor,source_event_id,observed_at_ms,latency_ms,outcome,schema_version)
            SELECT origin,factor,source_event_id,observed_at_ms,latency_ms,outcome,schema_version
            FROM blocker_lifecycle_metrics_v1;
          DROP TABLE blocker_lifecycle_metrics_v1;
        `);
      })();
    }
    const maturation = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='maturation_evaluations'")
      .get() as { sql?: string } | undefined;
    if (maturation?.sql && /rung\s+TEXT\s+NOT\s+NULL/i.test(maturation.sql)) {
      this.db.transaction(() => this.db!.exec(`
        DROP INDEX IF EXISTS idx_maturation_evaluation_trend;
        ALTER TABLE maturation_evaluations RENAME TO maturation_evaluations_v1;
        CREATE TABLE maturation_evaluations (
          origin TEXT NOT NULL, feature_id TEXT NOT NULL, rung TEXT,
          due_slot_ms INTEGER NOT NULL, evaluated_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
          passing_metrics INTEGER NOT NULL, total_metrics INTEGER NOT NULL,
          min_normalized_margin REAL, contract_hash TEXT NOT NULL, newest_evidence_at_ms INTEGER,
          additional_missed_slots INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL DEFAULT 2,
          UNIQUE(origin,feature_id,due_slot_ms)
        );
        INSERT INTO maturation_evaluations
          SELECT origin,feature_id,rung,due_slot_ms,evaluated_at_ms,status,passing_metrics,total_metrics,
            min_normalized_margin,contract_hash,newest_evidence_at_ms,additional_missed_slots,2
          FROM maturation_evaluations_v1;
        DROP TABLE maturation_evaluations_v1;
      `))();
    }
    const observations = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='maturation_metric_observations'")
      .get() as { sql?: string } | undefined;
    if (observations?.sql && !observations.sql.includes('feature-summary')) {
      this.db.transaction(() => this.db!.exec(`
        DROP INDEX IF EXISTS idx_maturation_observation_latest;
        ALTER TABLE maturation_metric_observations RENAME TO maturation_metric_observations_v1;
        CREATE TABLE maturation_metric_observations (
          origin TEXT NOT NULL, feature_id TEXT NOT NULL, metric_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('blocker-summary','blocker-trend','feature-summary')),
          source_ref TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, value REAL NOT NULL,
          samples INTEGER NOT NULL, descriptor_version INTEGER NOT NULL DEFAULT 1,
          benchmark_ref TEXT, schema_version INTEGER NOT NULL DEFAULT 2,
          UNIQUE(origin,feature_id,metric_id,source,source_ref,observed_at_ms)
        );
        INSERT INTO maturation_metric_observations
          SELECT origin,feature_id,metric_id,source,source_ref,observed_at_ms,value,samples,
            descriptor_version,benchmark_ref,2 FROM maturation_metric_observations_v1;
        DROP TABLE maturation_metric_observations_v1;
      `))();
    }
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS blocker_lifecycle_metrics (
          origin TEXT NOT NULL,
          factor TEXT NOT NULL CHECK (factor IN ('request-to-persist','clear-latency','deliverable-completion')),
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
          source TEXT NOT NULL CHECK (source IN ('blocker-summary','blocker-trend','feature-summary')),
          source_ref TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, value REAL NOT NULL,
          samples INTEGER NOT NULL, descriptor_version INTEGER NOT NULL DEFAULT 1,
          benchmark_ref TEXT, schema_version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(origin,feature_id,metric_id,source,source_ref,observed_at_ms)
        );
        CREATE INDEX IF NOT EXISTS idx_maturation_observation_latest ON maturation_metric_observations
          (origin,feature_id,metric_id,source,source_ref,observed_at_ms DESC);
        CREATE TABLE IF NOT EXISTS maturation_evaluations (
          origin TEXT NOT NULL, feature_id TEXT NOT NULL, rung TEXT,
          due_slot_ms INTEGER NOT NULL, evaluated_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
          passing_metrics INTEGER NOT NULL, total_metrics INTEGER NOT NULL,
          min_normalized_margin REAL, contract_hash TEXT NOT NULL, newest_evidence_at_ms INTEGER,
          additional_missed_slots INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL DEFAULT 1,
          UNIQUE(origin,feature_id,due_slot_ms)
        );
        CREATE INDEX IF NOT EXISTS idx_maturation_evaluation_trend ON maturation_evaluations
          (origin,feature_id,due_slot_ms DESC);
      `);
  }

  private ensureMeasurementArchive(): boolean {
    if (!this.db) return false;
    if (this.archiveReady) return true;
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS maturation_contract_versions (
        origin TEXT NOT NULL, feature_id TEXT NOT NULL, contract_hash TEXT NOT NULL, contract_json TEXT NOT NULL,
        first_archived_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL,
        PRIMARY KEY(origin,feature_id,contract_hash));
        CREATE INDEX IF NOT EXISTS idx_maturation_contract_seen ON maturation_contract_versions(last_seen_at_ms);
        CREATE TABLE IF NOT EXISTS maturation_baseline_pins (
          origin TEXT NOT NULL, feature_id TEXT NOT NULL, contract_hash TEXT NOT NULL, metric_id TEXT NOT NULL,
          observed_at_ms INTEGER NOT NULL, source TEXT NOT NULL, source_ref TEXT NOT NULL, descriptor_version INTEGER NOT NULL,
          last_seen_at_ms INTEGER NOT NULL,
          PRIMARY KEY(origin,feature_id,contract_hash,metric_id));
        CREATE INDEX IF NOT EXISTS idx_maturation_pin_observation ON maturation_baseline_pins
          (origin,feature_id,metric_id,observed_at_ms,source,source_ref,descriptor_version,last_seen_at_ms);
        CREATE INDEX IF NOT EXISTS idx_maturation_pin_seen ON maturation_baseline_pins(last_seen_at_ms);
        CREATE TABLE IF NOT EXISTS maturation_archive_usage (id INTEGER PRIMARY KEY CHECK(id=1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL);
        INSERT OR IGNORE INTO maturation_archive_usage SELECT 1,COUNT(*),COALESCE(SUM(length(CAST(contract_json AS BLOB))),0) FROM maturation_contract_versions;
        CREATE TRIGGER IF NOT EXISTS maturation_archive_capacity BEFORE INSERT ON maturation_contract_versions
          WHEN NOT EXISTS (SELECT 1 FROM maturation_contract_versions WHERE origin=NEW.origin AND feature_id=NEW.feature_id AND contract_hash=NEW.contract_hash)
          BEGIN SELECT CASE WHEN (SELECT rows>=8192 OR bytes+length(CAST(NEW.contract_json AS BLOB))>67108864 FROM maturation_archive_usage WHERE id=1)
            OR (SELECT COUNT(*) FROM maturation_contract_versions WHERE origin=NEW.origin AND feature_id=NEW.feature_id)>=256
            THEN RAISE(ABORT,'Measurement archive capacity exhausted') END; END;
        CREATE TRIGGER IF NOT EXISTS maturation_archive_insert AFTER INSERT ON maturation_contract_versions
          BEGIN UPDATE maturation_archive_usage SET rows=rows+1,bytes=bytes+length(CAST(NEW.contract_json AS BLOB)) WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS maturation_archive_delete AFTER DELETE ON maturation_contract_versions
          BEGIN UPDATE maturation_archive_usage SET rows=rows-1,bytes=bytes-length(CAST(OLD.contract_json AS BLOB)) WHERE id=1; END;`);
      this.archiveReady = true; return true;
    } catch { /* @silent-fallback-ok — archive failure remains separate from ordinary telemetry availability */ return false; }
  }

  /** Immutable hash/body archive. Baseline declarations alone never create pins. */
  archiveMaturationContract(origin: string, featureId: string, contract: MaturationEvaluationContract): boolean {
    if (!validArchivedContract(contract) || ('subject' in contract && !validGenericMeasurement(contract,featureId)) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(origin) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(featureId) || !this.ensureMeasurementArchive()) return false;
    const now = this.opts.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now <= 0) return false;
    const hash = measurementContractHash(contract); const body = JSON.stringify(contract);
    try {
      this.db!.transaction(() => {
        const existing = this.db!.prepare(`SELECT contract_json AS body FROM maturation_contract_versions
          WHERE origin=? AND feature_id=? AND contract_hash=?`).get(origin, featureId, hash) as { body: string } | undefined;
        if (existing && existing.body !== body) throw new Error('Inconsistent immutable measurement definition');
        this.db!.prepare(`INSERT INTO maturation_contract_versions VALUES (?,?,?,?,?,?)
          ON CONFLICT(origin,feature_id,contract_hash) DO UPDATE SET last_seen_at_ms=MAX(last_seen_at_ms,excluded.last_seen_at_ms)`)
          .run(origin, featureId, hash, body, now, now);
        // Retention is not corroboration. A later tie must remain visible while
        // this exact current definition still refers to its established baseline.
        this.db!.prepare(`UPDATE maturation_baseline_pins SET last_seen_at_ms=MAX(last_seen_at_ms,?)
          WHERE origin=? AND feature_id=? AND contract_hash=?`).run(now, origin, featureId, hash);
        const proof = projectMaturationOutcome(contract, origin, featureId, now,
          (id, at) => this.maturationObservation(origin, featureId, id, at));
        for (const metric of proof.metrics) {
          if (metric.baseline.state !== 'verified') continue;
          this.db!.prepare(`INSERT INTO maturation_baseline_pins VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(origin,feature_id,contract_hash,metric_id) DO UPDATE SET last_seen_at_ms=MAX(last_seen_at_ms,excluded.last_seen_at_ms)`)
            .run(origin, featureId, hash, metric.id, metric.baseline.observedAtMs, metric.source, metric.sourceRef, metric.descriptorVersion, now);
        }
      })();
      return true;
    } catch { /* @silent-fallback-ok — false prevents fully recorded ready claims, never ordinary service */ return false; }
  }

  /** Only requested current/history hashes, newest first. Missing and omitted differ. */
  maturationContractVersions(origin: string, featureId: string, hashes: string[]): MeasurementContractVersions {
    const requested = [...new Set(hashes)].slice(0, 129);
    const result: MeasurementContractVersions = { available: false, requested: requested.length, missing: [], omitted: [], unreadable: [], rows: [] };
    if (!this.db || !this.archiveReady) return result;
    try {
      let bytes = 0;
      for (const hash of requested) {
        const row = this.db.prepare(`SELECT contract_json AS body,first_archived_at_ms AS firstArchivedAtMs,
          last_seen_at_ms AS lastSeenAtMs FROM maturation_contract_versions WHERE origin=? AND feature_id=? AND contract_hash=?`)
          .get(origin, featureId, hash) as { body: string; firstArchivedAtMs: number; lastSeenAtMs: number } | undefined;
        if (!row) { result.missing.push(hash); continue; }
        let contract: unknown;
        try { contract = JSON.parse(row.body); } catch { result.unreadable.push(hash); continue; /* @silent-fallback-ok — malformed stored JSON is an explicit gap */ }
        if (!validArchivedContract(contract) || ('subject' in contract && !validGenericMeasurement(contract,featureId)) || measurementContractHash(contract) !== hash ||
            !Number.isSafeInteger(row.firstArchivedAtMs) || row.firstArchivedAtMs <= 0 || !Number.isSafeInteger(row.lastSeenAtMs) || row.lastSeenAtMs < row.firstArchivedAtMs) {
          result.unreadable.push(hash); continue;
        }
        const version = { hash, firstArchivedAtMs: row.firstArchivedAtMs, lastSeenAtMs: row.lastSeenAtMs, contract };
        const size = Buffer.byteLength(JSON.stringify(version));
        if (bytes + size > 32 * 1024) { result.omitted.push(hash); continue; }
        result.rows.push(version); bytes += size;
      }
      result.available = true; return result;
    } catch { /* @silent-fallback-ok — whole read failure returns no partial certification */ return { ...result, available: false, rows: [], missing: [], omitted: [], unreadable: [] }; }
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

  /** Exact baseline, or latest overall metric observation. This indexed read
   * cannot lose a baseline to the global recent-observations row limit. */
  maturationObservation(origin: string, featureId: string, metricId: string, observedAtMs?: number): MaturationMetricObservation | null {
    if (!this.db) return null;
    try {
      const exact = observedAtMs !== undefined;
      const rows = this.db.prepare(`SELECT origin,feature_id AS featureId,metric_id AS metricId,source,
        source_ref AS sourceRef,observed_at_ms AS observedAtMs,value,samples,
        descriptor_version AS descriptorVersion,benchmark_ref AS benchmarkRef
        FROM maturation_metric_observations WHERE origin=? AND feature_id=? AND metric_id=?
        ${exact ? 'AND observed_at_ms=?' : ''} ORDER BY observed_at_ms DESC LIMIT 2`)
        .all(...(exact ? [origin, featureId, metricId, observedAtMs] : [origin, featureId, metricId])) as MaturationMetricObservation[];
      // Different source refs can legally share a metric/time. Do not select
      // whichever row SQLite returns first as proof of an unambiguous value.
      if (rows[1] && rows[1].observedAtMs === rows[0].observedAtMs) return null;
      return rows[0] ?? null;
    } catch { /* @silent-fallback-ok — unavailable baseline/current proof is explicit in outcome evidence */ return null; }
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

  /** Bounded exact-subject history; null is a read failure, never zero data. */
  maturationMetricHistory(origin: string, featureId: string, metricId: string, sinceMs: number) {
    if (!this.db) return null;
    try {
      const args = [origin, featureId, metricId, Math.round(sinceMs)];
      const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM maturation_metric_observations
        WHERE origin=? AND feature_id=? AND metric_id=? AND observed_at_ms>=?`).get(...args) as { n: number }).n;
      const rows = this.db.prepare(`SELECT origin,feature_id AS featureId,metric_id AS metricId,source,
        source_ref AS sourceRef,observed_at_ms AS observedAtMs,value,samples,descriptor_version AS descriptorVersion
        FROM maturation_metric_observations WHERE origin=? AND feature_id=? AND metric_id=? AND observed_at_ms>=?
        ORDER BY observed_at_ms DESC,source,source_ref,descriptor_version LIMIT 96`).all(...args) as MaturationMetricObservation[];
      const ambiguousTimes = (this.db.prepare(`SELECT observed_at_ms AS at FROM maturation_metric_observations
        WHERE origin=? AND feature_id=? AND metric_id=? AND observed_at_ms>=?
        GROUP BY observed_at_ms HAVING COUNT(*)>1 ORDER BY observed_at_ms DESC LIMIT 96`).all(...args) as Array<{ at: number }>).map(r => r.at);
      return { total, rows, ambiguousTimes };
    } catch { /* @silent-fallback-ok — null history is an explicit unavailable read */ return null; }
  }

  maturationEvaluationHistory(origin: string, featureId: string, sinceMs: number) {
    if (!this.db) return null;
    try {
      const args = [origin, featureId, Math.round(sinceMs)];
      const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM maturation_evaluations
        WHERE origin=? AND feature_id=? AND due_slot_ms>=?`).get(...args) as { n: number }).n;
      const rows = this.db.prepare(`SELECT origin,feature_id AS featureId,rung,due_slot_ms AS dueSlotMs,
        evaluated_at_ms AS evaluatedAtMs,status,passing_metrics AS passingMetrics,total_metrics AS totalMetrics,
        min_normalized_margin AS minNormalizedMargin,contract_hash AS contractHash,
        newest_evidence_at_ms AS newestEvidenceAtMs,additional_missed_slots AS additionalMissedSlots
        FROM maturation_evaluations WHERE origin=? AND feature_id=? AND due_slot_ms>=?
        ORDER BY due_slot_ms DESC,evaluated_at_ms DESC,contract_hash LIMIT 128`).all(...args) as MaturationEvaluationRecord[];
      return { total, rows };
    } catch { /* @silent-fallback-ok — null history is an explicit unavailable read */ return null; }
  }

  /** A failed archive cannot leave an already-recorded ready slot certified.
   * Preserve its identity/times, conservatively retract only its ready verdict. */
  retractMaturationReady(origin: string, featureId: string, dueSlotMs: number): boolean {
    if (!this.db) return false;
    try {
      this.db.prepare(`UPDATE maturation_evaluations SET status='insufficient-evidence',passing_metrics=0,min_normalized_margin=NULL
        WHERE origin=? AND feature_id=? AND due_slot_ms=? AND status='ready'`).run(origin, featureId, dueSlotMs);
      return true;
    } catch { /* @silent-fallback-ok — service read overlay also holds the current slot if durable retraction fails */ return false; }
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
      // If archive storage is unavailable, leave observations intact rather than delete potential baselines.
      if (!this.ensureMeasurementArchive()) return old + cap;
      const archiveCutoff = (this.opts.now?.() ?? Date.now()) - 180 * 86_400_000;
      const expiredPins = this.db.prepare(`DELETE FROM maturation_baseline_pins WHERE rowid IN
        (SELECT rowid FROM maturation_baseline_pins WHERE last_seen_at_ms<? LIMIT 1000)`).run(archiveCutoff).changes;
      const expiredVersions = this.db.prepare(`DELETE FROM maturation_contract_versions WHERE rowid IN
        (SELECT v.rowid FROM maturation_contract_versions v WHERE last_seen_at_ms<? AND NOT EXISTS
          (SELECT 1 FROM maturation_baseline_pins p WHERE p.origin=v.origin AND p.feature_id=v.feature_id AND p.contract_hash=v.contract_hash) LIMIT 1000)`).run(archiveCutoff).changes;
      const observations = this.db.prepare(`DELETE FROM maturation_metric_observations WHERE rowid IN
        (SELECT o.rowid FROM maturation_metric_observations o WHERE observed_at_ms<? AND NOT EXISTS
          (SELECT 1 FROM maturation_baseline_pins p WHERE p.origin=o.origin AND p.feature_id=o.feature_id
           AND p.metric_id=o.metric_id AND p.observed_at_ms=o.observed_at_ms AND p.last_seen_at_ms>=?) LIMIT 1000)`)
        .run(maturationCutoff, archiveCutoff).changes;
      const evaluations = this.db.prepare(`DELETE FROM maturation_evaluations WHERE rowid IN
        (SELECT rowid FROM maturation_evaluations WHERE due_slot_ms<? LIMIT 1000)`).run(maturationCutoff).changes;
      return old + cap + expiredPins + expiredVersions + observations + evaluations;
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
    if (!['request-to-persist', 'clear-latency', 'deliverable-completion'].includes(record.factor) ||
        !['observed', 'legacy-missing-start', 'clock-regression-or-implausible'].includes(record.outcome) ||
        (record.factor === 'deliverable-completion' && (record.outcome !== 'observed' || record.latencyMs !== null))) {
      this.countersState.failed++;
      return false;
    }
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
