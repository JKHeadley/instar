import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockerLifecycleLedger, percentile } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

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
});
