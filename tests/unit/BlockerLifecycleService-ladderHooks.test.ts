/** D7 gets more subjects, not a new rule (feature-maturation-ladder §6). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';
import type { MaturationEvaluationRecord } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
const services: BlockerLifecycleService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close?.();
  for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'BlockerLifecycleService-ladderHooks.test' });
});
function make(now = Date.parse('2026-11-03T00:00:00Z')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-ladder-'));
  roots.push(root);
  const ledger = new BlockerLifecycleLedger({ dbPath: path.join(root, 'x.db') });
  const tracker = Object.assign(new EventEmitter(), { getAll: () => [], getBlockerEpisodeDropBuckets: () => ({}) }) as never;
  const svc = new BlockerLifecycleService(tracker, ledger, 'm1', () => now);
  services.push(svc);
  return { svc, ledger };
}
const contract = (ref: string) => ({ cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'ran', source: 'feature-summary' as const, sourceRef: ref, direction: 'at-least' as const, threshold: 2, minSamples: 1 }] });
const subject = (id: string, ref: string) => ({ id, title: id, rollout: { flagPath: id, stage: 'live', maturationEvaluation: contract(ref) } }) as unknown as Initiative;

describe('BlockerLifecycleService ladder hooks', () => {
  it('distinguishes latest feature states from historical evaluation counts', () => {
    const { svc, ledger } = make();
    const at = Date.parse('2026-11-02T00:00:00Z');
    const row: MaturationEvaluationRecord = { origin: 'm1', featureId: 'one', rung: 'live',
      dueSlotMs: at, evaluatedAtMs: at + 100, status: 'hold', passingMetrics: 0,
      totalMetrics: 1, minNormalizedMargin: -0.5, contractHash: 'v1', newestEvidenceAtMs: at };
    expect(ledger.recordMaturationEvaluation(row)).toBe(true);
    expect(ledger.recordMaturationEvaluation({ ...row, dueSlotMs: at + 6 * 3_600_000, status: 'ready' })).toBe(true);
    const summary = svc.localSummary(48).maturation as Record<string, unknown>;
    expect(summary.byStatus).toMatchObject({ hold: 1, ready: 1 });
    expect(summary.latestByStatus).toMatchObject({ hold: 0, ready: 1 });
  });

  it('retains exact cadence times and exposes contract, rung and evidence gaps in the existing trend', () => {
    const { svc, ledger } = make();
    const start = Date.parse('2026-11-01T00:00:00Z');
    const base: MaturationEvaluationRecord = { origin: 'm1', featureId: 'one', rung: 'live',
      dueSlotMs: start, evaluatedAtMs: start + 1, status: 'hold', passingMetrics: 0,
      totalMetrics: 1, minNormalizedMargin: -0.5, contractHash: 'v1', newestEvidenceAtMs: start };
    const changes: Partial<MaturationEvaluationRecord>[] = [{}, { status: 'ready' },
      { contractHash: 'v2' }, { status: 'insufficient-evidence', newestEvidenceAtMs: null },
      {}, { rung: 'default-on' }, { status: 'missed-cadence', additionalMissedSlots: 7 }];
    changes.forEach((change, index) => expect(ledger.recordMaturationEvaluation({ ...base,
      dueSlotMs: start + index * 3_600_000, ...change })).toBe(true));
    const trend = svc.localTrend(7).maturation as { features: { evaluations: Record<string, unknown>[] }[] };
    const points = trend.features[0].evaluations;
    expect(points.map(p => p.sameEvaluationSeries)).toEqual([false, true, false, false, false, false, false]);
    expect(points[1]).toMatchObject({ day: '2026-11-01', dueAt: '2026-11-01T01:00:00.000Z',
      evaluatedAt: '2026-11-01T00:00:00.001Z', passingMetrics: 0, totalMetrics: 1 });
    expect(points[3].newestEvidenceAt).toBeNull();
    expect(points[6].additionalMissedSlots).toBe(7);
  });

  it('discloses omitted history instead of presenting a capped series as complete', () => {
    const { svc, ledger } = make();
    const start = Date.parse('2026-11-02T00:00:00Z');
    for (let index = 0; index < 95; index++) expect(ledger.recordMaturationEvaluation({
      origin: 'm1', featureId: 'one', rung: 'live', dueSlotMs: start + index * 1000,
      evaluatedAtMs: start + index * 1000, status: 'ready', passingMetrics: 1, totalMetrics: 1,
      minNormalizedMargin: 0, contractHash: 'v1', newestEvidenceAtMs: start,
    })).toBe(true);
    const trend = svc.localTrend(7).maturation as { features: { totalEvaluations: number; omittedEvaluations: number; evaluations: Record<string, unknown>[] }[] };
    expect(trend).toMatchObject({ totalFeatures: 1, omittedFeatures: 0, featureLimit: 512, evaluationLimit: 90 });
    expect(trend.features[0]).toMatchObject({ totalEvaluations: 95, omittedEvaluations: 5 });
    expect(trend.features[0].evaluations).toHaveLength(90);
    expect(trend.features[0].evaluations[0].sameEvaluationSeries).toBe(false);
    expect(trend.features[0].evaluations[0].dueAt).toBe('2026-11-02T00:00:05.000Z');
  });

  it('bounds the shared history bytes while retaining the newest evidence for every feature', () => {
    const { svc, ledger } = make();
    const start = Date.parse('2026-11-02T00:00:00Z');
    const rows: MaturationEvaluationRecord[] = [];
    for (let feature = 0; feature < 200; feature++) for (let index = 0; index < 8; index++) rows.push({
      origin: 'm1', featureId: `feature-${feature}`, rung: 'live', dueSlotMs: start + index * 1000,
      evaluatedAtMs: start + index * 1000, status: 'ready', passingMetrics: 1, totalMetrics: 1,
      minNormalizedMargin: 0, contractHash: 'a'.repeat(64), newestEvidenceAtMs: start,
    });
    vi.spyOn(ledger, 'maturationEvaluations').mockReturnValue(rows);
    const trend = svc.localTrend(7).maturation as { historyByteLimit: number; features: { totalEvaluations: number; omittedEvaluations: number; evaluations: { dueAt: string }[] }[] };
    expect(Buffer.byteLength(JSON.stringify(trend))).toBeLessThanOrEqual(trend.historyByteLimit);
    expect(trend.historyByteLimit).toBe(384 * 1024);
    expect(trend.features).toHaveLength(200);
    expect(trend.features.some(f => f.omittedEvaluations > 0)).toBe(true);
    for (const feature of trend.features) {
      expect(feature.evaluations.length).toBeGreaterThan(0);
      expect(feature.evaluations.at(-1)?.dueAt).toBe('2026-11-02T00:00:07.000Z');
      expect(feature.totalEvaluations).toBe(feature.omittedEvaluations + feature.evaluations.length);
    }
  });

  it('scores in-memory subjects by the same rule, both sides', () => {
    const { svc } = make();
    svc.registerMaturationProjection('a.good', () => ({ value: 5, samples: 5 }));
    svc.registerMaturationProjection('a.bad', () => ({ value: 1, samples: 5 }));
    svc.setMaturationHooks({ subjects: () => [subject('good', 'a.good'), subject('bad', 'a.bad'), subject('none', 'a.none')] });
    svc.evaluateMaturation([]);
    const rows = svc.maturationEvaluationRows(0);
    const by = Object.fromEntries(rows.map(r => [r.featureId, r.status]));
    expect(by).toEqual({ good: 'ready', bad: 'hold', none: 'insufficient-evidence' });
    expect(rows[0].contractHash).toBe(svc.maturationContractHash(contract(rows[0].featureId === 'bad' ? 'a.bad' : 'a.good')));
  });

  it('with no hooks, behaves as before', () => {
    const { svc } = make();
    svc.registerMaturationProjection('a.good', () => ({ value: 5, samples: 5 }));
    expect(svc.evaluateMaturation([subject('good', 'a.good')])).toMatchObject({ eligible: 1, inserted: 1 });
    expect(svc.maturationEvaluationRows(0)[0].status).toBe('ready');
  });

  it('reads the history and observations once a pass, however many subjects', () => {
    const { svc, ledger } = make();
    const evals = vi.spyOn(ledger, 'maturationEvaluations');
    const obs = vi.spyOn(ledger, 'maturationObservations');
    const many = Array.from({ length: 250 }, (_, i) => subject(`f${i}`, 'a.good'));
    svc.registerMaturationProjection('a.good', () => ({ value: 5, samples: 5 }));
    const started = Date.now();
    svc.evaluateMaturation(many);
    expect(evals).toHaveBeenCalledTimes(1);
    expect(obs).toHaveBeenCalledTimes(1);
    expect(svc.maturationEvaluationRows(0).filter(r => r.status === 'ready')).toHaveLength(250);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a read that never finishes cannot stop the scorer', async () => {
    vi.useFakeTimers();
    try {
      const { svc } = make();
      svc.setMaturationHooks({ prepare: () => new Promise<void>(() => undefined) });
      const pass = (svc as unknown as { runMaturationPass(list: () => Initiative[]): Promise<void> }).runMaturationPass(() => [subject('x', 'a.none')]);
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      await pass;
      expect(svc.maturationEvaluationRows(0).map(r => r.featureId)).toEqual(['x']);
    } finally { vi.useRealTimers(); }
  });

  it('readMaturationProjection returns null when a read throws or is unknown', () => {
    const { svc } = make();
    svc.registerMaturationProjection('a.throws', () => { throw new Error('x'); });
    expect(svc.readMaturationProjection('a.throws')).toBeNull();
    expect(svc.readMaturationProjection('a.unknown')).toBeNull();
  });
});
