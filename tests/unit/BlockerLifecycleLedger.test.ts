import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockerLifecycleLedger, percentile } from '../../src/monitoring/BlockerLifecycleLedger.js';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { sqliteRegistrySize } from '../../src/core/SqliteRegistry.js';

describe('BlockerLifecycleLedger', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(dir => SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'tests/unit/BlockerLifecycleLedger.test.ts',
  })));

  it('is idempotent by origin, factor, and source event', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-')); dirs.push(dir);
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db') });
    const row = { origin: 'machine-a', factor: 'clear-latency' as const, sourceEventId: 'clear-1',
      observedAtMs: 10_000, latencyMs: 25, outcome: 'observed' as const };
    expect(ledger.record(row, true)).toBe(true);
    expect(ledger.record(row, true)).toBe(true);
    expect(ledger.values('clear-latency', 0)).toEqual([{ observedAtMs: 10_000, latencyMs: 25, outcome: 'observed' }]);
    expect(ledger.counters()).toMatchObject({ inserted: 1, deduped: 1, reconciled: 1 });
    ledger.close();
  });

  it('uses nearest-rank percentiles', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
  });

  it('stores maturation observations and one immutable evaluation per feature slot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-')); dirs.push(dir);
    const now = 2_000_000_000_000;
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db'), now: () => now });
    expect(ledger.recordMaturationObservation({ origin: 'm1', featureId: 'feature-a', metricId: 'coverage',
      source: 'blocker-summary', sourceRef: 'clear-latency.coverage', observedAtMs: now,
      value: 0.99, samples: 100 })).toBe(true);
    expect(ledger.maturationObservations('m1', now - 1)).toHaveLength(1);
    const row = { origin: 'm1', featureId: 'feature-a', rung: 'dark', dueSlotMs: now,
      evaluatedAtMs: now, status: 'ready' as const, passingMetrics: 1, totalMetrics: 1,
      minNormalizedMargin: 0.01, contractHash: 'abc', newestEvidenceAtMs: now };
    expect(ledger.recordMaturationEvaluation(row)).toBe(true);
    expect(ledger.recordMaturationEvaluation({ ...row, status: 'hold' })).toBe(true);
    expect(ledger.maturationEvaluations('m1', now - 1)).toEqual([expect.objectContaining({ status: 'ready', featureId: 'feature-a' })]);
    ledger.close();
  });

  it('rejects invalid and future maturation observations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-')); dirs.push(dir);
    const now = 2_000_000_000_000;
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db'), now: () => now });
    expect(ledger.recordMaturationObservation({ origin: 'm1', featureId: 'bad id', metricId: 'm',
      source: 'blocker-summary', sourceRef: 'x', observedAtMs: now, value: 1, samples: 1 })).toBe(false);
    expect(ledger.recordMaturationObservation({ origin: 'm1', featureId: 'ok', metricId: 'm',
      source: 'blocker-summary', sourceRef: 'x', observedAtMs: now + 300_001, value: 1, samples: 1 })).toBe(false);
    ledger.close();
  });

  it('records the deliverable-completion count factor with idempotent source identity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-count-')); dirs.push(dir);
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db') });
    const row = { origin: 'machine-a', factor: 'deliverable-completion' as const,
      sourceEventId: 'throughput-v1:completion:opaque', observedAtMs: 20_000,
      latencyMs: null, outcome: 'observed' as const };
    expect(ledger.record(row, true)).toBe(true);
    expect(ledger.record(row, true)).toBe(true);
    expect(ledger.values('deliverable-completion', 0)).toEqual([
      { observedAtMs: 20_000, latencyMs: null, outcome: 'observed' },
    ]);
    expect(ledger.counters()).toMatchObject({ inserted: 1, deduped: 1 });
    ledger.close();
  });

  it('migrates the existing two-factor table in place without losing rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-migrate-')); dirs.push(dir);
    const dbPath = path.join(dir, 'ledger.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE blocker_lifecycle_metrics (
      origin TEXT NOT NULL,
      factor TEXT NOT NULL CHECK (factor IN ('request-to-persist','clear-latency')),
      source_event_id TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      latency_ms REAL,
      outcome TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(origin, factor, source_event_id)
    ); CREATE INDEX idx_blocker_lifecycle_window ON blocker_lifecycle_metrics(factor, observed_at_ms);`);
    db.prepare(`INSERT INTO blocker_lifecycle_metrics
      (origin,factor,source_event_id,observed_at_ms,latency_ms,outcome)
      VALUES (?,?,?,?,?,?)`).run('machine-a', 'clear-latency', 'legacy', 10_000, 12, 'observed');
    db.close();
    const ledger = new BlockerLifecycleLedger({ dbPath });
    expect(ledger.values('clear-latency', 0)).toEqual([
      { observedAtMs: 10_000, latencyMs: 12, outcome: 'observed' },
    ]);
    expect(ledger.record({ origin: 'machine-a', factor: 'deliverable-completion', sourceEventId: 'new',
      observedAtMs: 20_000, latencyMs: null, outcome: 'observed' }, true)).toBe(true);
    expect(ledger.values('deliverable-completion', 0)).toHaveLength(1);
    ledger.close();
    const inspect = new Database(dbPath, { readonly: true });
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_blocker_lifecycle_window'").get())
      .toEqual({ name: 'idx_blocker_lifecycle_window' });
    expect(inspect.prepare('SELECT origin,factor,source_event_id,observed_at_ms,latency_ms,outcome,schema_version FROM blocker_lifecycle_metrics WHERE source_event_id=?').get('legacy'))
      .toEqual({ origin: 'machine-a', factor: 'clear-latency', source_event_id: 'legacy',
        observed_at_ms: 10_000, latency_ms: 12, outcome: 'observed', schema_version: 1 });
    inspect.close();
  });

  it('closes and unregisters the SQLite handle when schema migration fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-ledger-bad-migrate-')); dirs.push(dir);
    const dbPath = path.join(dir, 'ledger.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE blocker_lifecycle_metrics (
      origin TEXT NOT NULL, factor TEXT NOT NULL CHECK (factor IN ('request-to-persist','clear-latency')),
      source_event_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, latency_ms REAL, outcome TEXT NOT NULL
    )`);
    db.close();
    const before = sqliteRegistrySize();
    const ledger = new BlockerLifecycleLedger({ dbPath });
    expect(ledger.available()).toBe(false);
    expect(sqliteRegistrySize()).toBe(before);
    ledger.close();
  });
});
