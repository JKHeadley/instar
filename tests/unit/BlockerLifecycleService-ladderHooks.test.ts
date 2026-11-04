/** D7 gets more subjects, not a new rule (feature-maturation-ladder §6). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';
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
  const tracker = Object.assign(new EventEmitter(), { getAll: () => [] }) as never;
  const svc = new BlockerLifecycleService(tracker, ledger, 'm1', () => now);
  services.push(svc);
  return { svc, ledger };
}
const contract = (ref: string) => ({ cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'ran', source: 'feature-summary' as const, sourceRef: ref, direction: 'at-least' as const, threshold: 2, minSamples: 1 }] });
const subject = (id: string, ref: string) => ({ id, title: id, rollout: { flagPath: id, stage: 'live', maturationEvaluation: contract(ref) } }) as unknown as Initiative;

describe('BlockerLifecycleService ladder hooks', () => {
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
