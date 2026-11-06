import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { projectMaturationOutcome } from '../../src/monitoring/MaturationOutcome.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
const ledgers: BlockerLifecycleLedger[] = [];
afterEach(() => { for (const l of ledgers.splice(0)) l.close(); for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'MaturationOutcome-ledger.test' }); });
const now = Date.parse('2026-11-05T12:00:00Z');
const at = now - 86_400_000;
function make() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-ledger-')); roots.push(root);
  const ledger = new BlockerLifecycleLedger({ dbPath: path.join(root, 'x.db'), now: () => now }); ledgers.push(ledger); return ledger;
}
const baseline = { origin: 'm1', featureId: 'one', metricId: 'quality', source: 'feature-summary' as const, sourceRef: 'ladder.quality.abc', descriptorVersion: 1, observedAtMs: at, value: 0.2, samples: 40 };
const contract = { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'quality', source: baseline.source, sourceRef: baseline.sourceRef, direction: 'at-most' as const, threshold: 0.05, minSamples: 20 }],
  outcome: { statement: 'Fewer wrong decisions', owner: 'decision-owner', method: 'Recorded outcome grades', version: 'v1', outcomeMetricIds: ['quality'], qualityMetricIds: ['quality'], baseline: { origin: 'm1', points: [{ id: 'quality', observedAtMs: at, descriptorVersion: 1, value: 0.2, samples: 40 }] } } };

describe('exact recorded baseline proof', () => {
  it('does not lose a baseline behind noisy neighbors in the capped recent read', () => {
    const l = make(); expect(l.recordMaturationObservation(baseline)).toBe(true);
    for (let i = 0; i < 8200; i++) expect(l.recordMaturationObservation({ ...baseline, featureId: 'noise', observedAtMs: at + i + 1 })).toBe(true);
    expect(l.maturationObservations('m1', 0).some(r => r.featureId === 'one')).toBe(false);
    expect(l.maturationObservation('m1', 'one', 'quality', at)).toMatchObject(baseline);
    expect(l.recordMaturationObservation({ ...baseline, observedAtMs: now, value: 0.1 })).toBe(true);
    const evidence = projectMaturationOutcome(contract, 'm1', 'one', now, (id, time) => l.maturationObservation('m1', 'one', id, time));
    expect(evidence.state).toBe('verified');
    expect(evidence.metrics[0]).toMatchObject({ delta: -0.1, criterion: { met: false } });
  });

  it('refuses ambiguous exact and latest rows rather than picking a flattering source', () => {
    const l = make(); expect(l.recordMaturationObservation(baseline)).toBe(true);
    expect(l.recordMaturationObservation({ ...baseline, sourceRef: 'other', value: 0.9 })).toBe(true);
    expect(l.maturationObservation('m1', 'one', 'quality', at)).toBeNull();
    expect(l.maturationObservation('m1', 'one', 'quality')).toBeNull();
    expect(l.recordMaturationObservation({ ...baseline, observedAtMs: now, value: 0.1 })).toBe(true);
    expect(l.maturationObservation('m1', 'one', 'quality')).toMatchObject({ sourceRef: baseline.sourceRef, observedAtMs: now });
  });

  it('does not fall back to old compatible evidence after the latest source changes', () => {
    const l = make(); l.recordMaturationObservation(baseline);
    l.recordMaturationObservation({ ...baseline, observedAtMs: now - 1, value: 0.1 });
    l.recordMaturationObservation({ ...baseline, observedAtMs: now, sourceRef: 'changed', value: 0 });
    const evidence = projectMaturationOutcome(contract, 'm1', 'one', now, (id, time) => l.maturationObservation('m1', 'one', id, time));
    expect(evidence.metrics[0]).toMatchObject({ current: { state: 'mismatch', value: null }, delta: null });
  });
});
