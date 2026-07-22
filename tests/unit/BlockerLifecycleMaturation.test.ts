import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import type { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('BlockerLifecycleService maturation evaluation', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(dir => SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'tests/unit/BlockerLifecycleMaturation.test.ts',
  })));

  it('evaluates every non-terminal rollout, including missing evidence and contract', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-service-')); dirs.push(dir);
    const now = 2_000_000_000_000;
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db'), now: () => now });
    const events = new EventEmitter() as EventEmitter & { getAll(): never[]; update(): Promise<boolean>; getBlockerEpisodeDropBuckets(): Record<string, never> };
    events.getAll = () => [];
    events.update = async () => true;
    events.getBlockerEpisodeDropBuckets = () => ({});
    const service = new BlockerLifecycleService(events as unknown as CommitmentTracker, ledger, 'm1', () => now);
    ledger.record({ origin: 'm1', factor: 'deliverable-completion', sourceEventId: 'completion-1',
      observedAtMs: now - 1_000, latencyMs: null, outcome: 'observed' }, true);
    const base = { title: 'x', description: 'x', status: 'active', phases: [], currentPhaseIndex: 0,
      lastTouchedAt: new Date(now).toISOString(), needsUser: false, blockers: [], links: [],
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), kind: 'task' } as const;
    const initiatives = [
      { ...base, id: 'with-contract', rollout: { flagPath: 'x', stage: 'dark', maturationEvaluation: {
        cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'coverage', source: 'blocker-summary',
          sourceRef: 'clear-latency.coverage', direction: 'at-least', threshold: 0.95, minSamples: 1 }],
      } } },
      { ...base, id: 'without-contract', rollout: { flagPath: 'y', stage: 'live' } },
      { ...base, id: 'completion-contract', rollout: { flagPath: 'c', stage: 'dark', maturationEvaluation: {
        cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'completion-rate', source: 'blocker-summary',
          sourceRef: 'deliverable-completion.averagePerDay', direction: 'at-least', threshold: 0, minSamples: 1 }],
      } } },
      { ...base, id: 'terminal', rollout: { flagPath: 'z', stage: 'default-on' } },
    ] as Initiative[];
    expect(service.evaluateMaturation(initiatives)).toMatchObject({ eligible: 3 });
    expect(ledger.maturationEvaluations('m1', now - 24 * 3_600_000).map(r => [r.featureId, r.status])).toEqual([
      ['completion-contract', 'ready'], ['with-contract', 'insufficient-evidence'], ['without-contract', 'missing-contract'],
    ]);
    const summary = service.localSummary(24) as { maturation: { eligible: number; evaluated: number } };
    expect(summary.maturation).toMatchObject({ eligible: 3, evaluated: 3 });
    service.close();
  });

  it('evaluates active and composed accounting with real projections and reports excluded without evaluating it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-accounting-')); dirs.push(dir);
    const now = 2_000_000_000_000;
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db'), now: () => now });
    const events = new EventEmitter() as EventEmitter & { getAll(): never[]; update(): Promise<boolean>; getBlockerEpisodeDropBuckets(): Record<string, never> };
    events.getAll = () => []; events.update = async () => true; events.getBlockerEpisodeDropBuckets = () => ({});
    const service = new BlockerLifecycleService(events as unknown as CommitmentTracker, ledger, 'm1', () => now);
    service.registerMaturationProjection('feedback-factory.completed-runs', () => ({ value: 2, samples: 2 }));
    service.registerMaturationProjection('claim-verification.classified-claims', () => ({ value: 0, samples: 1 }));
    const metric = { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'proof', source: 'feature-summary' as const,
      sourceRef: 'feedback-factory.completed-runs', direction: 'at-least' as const, threshold: 1, minSamples: 1 }] };
    const base = { title: 'x', description: 'x', status: 'active', phases: [], currentPhaseIndex: 0,
      lastTouchedAt: new Date(now).toISOString(), needsUser: false, blockers: [], links: [],
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), kind: 'task' } as const;
    const initiatives = [
      { ...base, id: 'active', rolloutAccounting: { disposition: 'active', sourcePrNumber: 1531, rung: 'dev-agent-live', maturationEvaluation: metric } },
      { ...base, id: 'composed', rolloutAccounting: { disposition: 'composed', sourcePrNumber: 1538, rung: null, ownerFeatureId: 'active', maturationEvaluation: metric } },
      { ...base, id: 'provider-unavailable-claim', rolloutAccounting: { disposition: 'active', sourcePrNumber: 1534, rung: 'test-agent-live', maturationEvaluation: {
        cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'classified', source: 'feature-summary',
          sourceRef: 'claim-verification.classified-claims', direction: 'at-least', threshold: 1, minSamples: 1 }],
      } } },
      { ...base, id: 'invalid-contract', rolloutAccounting: { disposition: 'composed', sourcePrNumber: 1538, rung: null,
        ownerFeatureId: 'active', maturationContractError: 'unknown-source-ref' } },
      { ...base, id: 'excluded', rolloutAccounting: { disposition: 'excluded', sourcePrNumber: 1532, rung: null, exclusionReason: 'docs-only' } },
    ] as Initiative[];
    expect(service.evaluateMaturation(initiatives)).toEqual({ eligible: 4, inserted: 4 });
    expect(ledger.maturationEvaluations('m1', now - 24 * 3_600_000).map(row => [row.featureId, row.rung, row.status])).toEqual([
      ['active', 'dev-agent-live', 'ready'], ['composed', null, 'ready'], ['invalid-contract', null, 'invalid-contract'],
      ['provider-unavailable-claim', 'test-agent-live', 'hold'],
    ]);
    const summary = service.localSummary(24) as { maturation: { accountingCounts: unknown; accounting: unknown[] } };
    expect(summary.maturation.accountingCounts).toEqual({ active: 2, composed: 2, excluded: 1 });
    expect(summary.maturation.accounting).toHaveLength(5);
    service.close();
  });

  it('migrates the existing D7 table to permit an honest null composed rung', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-migration-')); dirs.push(dir);
    const dbPath = path.join(dir, 'ledger.db');
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE maturation_evaluations (
      origin TEXT NOT NULL, feature_id TEXT NOT NULL, rung TEXT NOT NULL,
      due_slot_ms INTEGER NOT NULL, evaluated_at_ms INTEGER NOT NULL, status TEXT NOT NULL,
      passing_metrics INTEGER NOT NULL, total_metrics INTEGER NOT NULL,
      min_normalized_margin REAL, contract_hash TEXT NOT NULL, newest_evidence_at_ms INTEGER,
      additional_missed_slots INTEGER NOT NULL DEFAULT 0, schema_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(origin,feature_id,due_slot_ms));`);
    old.prepare(`INSERT INTO maturation_evaluations
      (origin,feature_id,rung,due_slot_ms,evaluated_at_ms,status,passing_metrics,total_metrics,contract_hash)
      VALUES ('m1','legacy','live',1,1,'ready',1,1,'old')`).run();
    old.close();
    const ledger = new BlockerLifecycleLedger({ dbPath, now: () => 2_000_000_000_000 });
    expect(ledger.recordMaturationEvaluation({ origin: 'm1', featureId: 'composed', rung: null,
      dueSlotMs: 2, evaluatedAtMs: 2, status: 'ready', passingMetrics: 1, totalMetrics: 1,
      minNormalizedMargin: 0, contractHash: 'new', newestEvidenceAtMs: 2 })).toBe(true);
    expect(ledger.maturationEvaluations('m1', 0).map(row => [row.featureId, row.rung])).toEqual([
      ['composed', null], ['legacy', 'live'],
    ]);
    ledger.close();
  });

  it('keeps legacy and accounted tracks in one consistent evaluation denominator', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-mixed-')); dirs.push(dir);
    const now = 2_000_000_000_000;
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db'), now: () => now });
    const events = new EventEmitter() as EventEmitter & { getAll(): never[]; update(): Promise<boolean>; getBlockerEpisodeDropBuckets(): Record<string, never> };
    events.getAll = () => []; events.update = async () => true; events.getBlockerEpisodeDropBuckets = () => ({});
    const service = new BlockerLifecycleService(events as unknown as CommitmentTracker, ledger, 'm1', () => now);
    const base = { title: 'x', description: 'x', status: 'active', phases: [], currentPhaseIndex: 0,
      lastTouchedAt: new Date(now).toISOString(), needsUser: false, blockers: [], links: [],
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), kind: 'task' } as const;
    const initiatives = [
      { ...base, id: 'accounted', rolloutAccounting: { disposition: 'active', sourcePrNumber: 1531, rung: 'test-agent-live' } },
      { ...base, id: 'legacy', rollout: { flagPath: 'legacy', stage: 'dark' } },
      { ...base, id: 'excluded', rolloutAccounting: { disposition: 'excluded', sourcePrNumber: 1532, rung: null } },
    ] as Initiative[];
    expect(service.evaluateMaturation(initiatives).eligible).toBe(2);
    const summary = service.localSummary(24) as { maturation: { eligible: number; evaluated: number; accounting: unknown[] } };
    expect(summary.maturation).toMatchObject({ eligible: 2, evaluated: 2 });
    expect(summary.maturation.accounting).toHaveLength(2);
    service.close();
  });

  it('migrates feature-summary observation CHECK constraints without losing rows or the latest index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-observation-migration-')); dirs.push(dir);
    const dbPath = path.join(dir, 'ledger.db');
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE maturation_metric_observations (
      origin TEXT NOT NULL, feature_id TEXT NOT NULL, metric_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('blocker-summary','blocker-trend')),
      source_ref TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, value REAL NOT NULL,
      samples INTEGER NOT NULL, descriptor_version INTEGER NOT NULL DEFAULT 1,
      benchmark_ref TEXT, schema_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(origin,feature_id,metric_id,source,source_ref,observed_at_ms));
      CREATE INDEX idx_maturation_observation_latest ON maturation_metric_observations
        (origin,feature_id,metric_id,source,source_ref,observed_at_ms DESC);`);
    old.prepare(`INSERT INTO maturation_metric_observations
      (origin,feature_id,metric_id,source,source_ref,observed_at_ms,value,samples,descriptor_version,benchmark_ref)
      VALUES ('m1','legacy','coverage','blocker-summary','clear-latency.coverage',1,0.9,4,7,'bench')`).run();
    old.close();
    const now = 2_000_000_000_000;
    const ledger = new BlockerLifecycleLedger({ dbPath, now: () => now });
    expect(ledger.recordMaturationObservation({ origin: 'm1', featureId: 'feature', metricId: 'runs',
      source: 'feature-summary', sourceRef: 'feedback-factory.completed-runs', observedAtMs: now,
      value: 1, samples: 1 })).toBe(true);
    const rows = ledger.maturationObservations('m1', 0);
    expect(rows.find(row => row.featureId === 'legacy')).toMatchObject({ value: 0.9, samples: 4, descriptorVersion: 7, benchmarkRef: 'bench' });
    ledger.close();
    const check = new Database(dbPath, { readonly: true });
    expect((check.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='maturation_metric_observations'").get() as { sql: string }).sql)
      .toContain("'feature-summary'");
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_maturation_observation_latest'").get()).toBeTruthy();
    check.close();
  });
});
