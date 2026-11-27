import { describe, expect, it } from 'vitest';
import { parseMaturationOutcome, projectMaturationOutcome, validMaturationOutcomeDetail, type MaturationOutcomeContract } from '../../src/monitoring/MaturationOutcome.js';
import type { MaturationEvaluationContract } from '../../src/core/InitiativeTracker.js';
import type { MaturationMetricObservation } from '../../src/monitoring/BlockerLifecycleLedger.js';

const now = Date.parse('2026-11-05T12:00:00Z');
const baselineAt = now - 24 * 3_600_000;
const metric = { id: 'quality', source: 'feature-summary' as const, sourceRef: 'context-recovery.successful-recoveries', direction: 'at-least' as const, threshold: 0.95, minSamples: 20 };
const outcome = (): MaturationOutcomeContract => ({ statement: 'More successful recoveries without added harm', owner: 'recovery-owner', method: 'Recorded recovery outcomes', version: 'v1', outcomeMetricIds: ['quality'], qualityMetricIds: ['quality'], baseline: { origin: 'm1', points: [{ id: 'quality', observedAtMs: baselineAt, descriptorVersion: 1, value: 0.8, samples: 40 }] } });
const contract = (): MaturationEvaluationContract => ({ cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [metric], outcome: outcome() });
const row = (changes: Partial<MaturationMetricObservation> = {}): MaturationMetricObservation => ({ origin: 'm1', featureId: 'recovery', metricId: 'quality', source: metric.source, sourceRef: metric.sourceRef, observedAtMs: baselineAt, value: 0.8, samples: 40, descriptorVersion: 1, ...changes });
const project = (base: MaturationMetricObservation | null = row(), current: MaturationMetricObservation | null = row({ observedAtMs: now, value: 0.96 })) => projectMaturationOutcome(contract(), 'm1', 'recovery', now, (_id, at) => at === undefined ? current : base);

describe('recorded maturation outcomes', () => {
  it('requires complete unique baselines and real metric references', () => {
    expect(parseMaturationOutcome(outcome(), ['quality'])).not.toBeNull();
    const missing = outcome(); missing.baseline.points = [];
    expect(parseMaturationOutcome(missing, ['quality'])).toBeNull();
    const duplicate = outcome(); duplicate.baseline.points.push({ ...duplicate.baseline.points[0] });
    expect(parseMaturationOutcome(duplicate, ['quality', 'other'])).toBeNull();
    expect(parseMaturationOutcome({ ...outcome(), qualityMetricIds: ['invented'] }, ['quality'])).toBeNull();
    expect(parseMaturationOutcome({ ...outcome(), owner: ' ' }, ['quality'])).toBeNull();
    expect(parseMaturationOutcome({ ...outcome(), extra: 'not part of the contract' }, ['quality'])).toBeNull();
  });

  it.each([
    ['value', Number.NaN], ['samples', -1], ['samples', 1.5], ['observedAtMs', Number.MAX_SAFE_INTEGER], ['descriptorVersion', 0],
  ])('rejects unsafe baseline %s', (key, value) => {
    const o = outcome(); (o.baseline.points[0] as unknown as Record<string, unknown>)[key] = value;
    expect(parseMaturationOutcome(o, ['quality'])).toBeNull();
  });

  it('shows grounded numerical change and quality criteria, without claiming improvement', () => {
    const view = project();
    expect(view.state).toBe('verified');
    expect(view.metrics[0]).toMatchObject({ outcome: true, qualityGuard: true, comparisonAvailable: true,
      baseline: { state: 'verified', samples: 40 }, current: { state: 'verified', value: 0.96 }, criterion: { met: true } });
    expect(view.metrics[0].delta).toBeCloseTo(0.16);
    expect(view).not.toHaveProperty('improved');
  });

  it('does not trust an author-declared baseline value without an exact matching observation', () => {
    expect(project(row({ value: 0.2 })).metrics[0]).toMatchObject({ baseline: { state: 'mismatch' }, delta: null });
    expect(project(null).metrics[0]).toMatchObject({ baseline: { state: 'unavailable' }, delta: null });
    expect(project(row({ observedAtMs: baselineAt - 1 })).metrics[0].baseline.state).toBe('mismatch');
  });

  it.each([
    ['source', 'blocker-summary'], ['sourceRef', 'other'], ['descriptorVersion', 2], ['origin', 'm2'], ['featureId', 'other'], ['metricId', 'other'],
  ])('refuses incompatible baseline and current %s', (key, value) => {
    const mismatch = row({ [key]: value });
    expect(project(mismatch).metrics[0].baseline.state).toBe('mismatch');
    expect(project(row(), { ...mismatch, observedAtMs: now }).metrics[0]).toMatchObject({ current: { state: 'mismatch', value: null }, delta: null });
  });

  it('discloses stale, pre-baseline, future, insufficient and absent current evidence', () => {
    expect(project(row(), row({ observedAtMs: now - 13 * 3_600_000 })).metrics[0].current.state).toBe('stale');
    expect(project(row(), row({ observedAtMs: baselineAt - 1 })).metrics[0].current.state).toBe('before-baseline');
    expect(project(row(), row({ observedAtMs: now + 1 })).metrics[0].current.state).toBe('future');
    expect(project(row(), row({ observedAtMs: now, samples: 19 })).metrics[0].current.state).toBe('insufficient-samples');
    expect(project(row(), null).metrics[0].current.state).toBe('unavailable');
  });

  it('requires baseline sample floors too and keeps baseline origins local', () => {
    const c = contract(); c.outcome!.baseline.points[0].samples = 19;
    const v = projectMaturationOutcome(c, 'm1', 'recovery', now, (_id, at) => at === undefined ? row({ observedAtMs: now }) : row({ samples: 19 }));
    expect(v.metrics[0].baseline.state).toBe('insufficient-samples');
    c.outcome!.baseline.origin = 'm2';
    const reads: (number | undefined)[] = [];
    const foreign = projectMaturationOutcome(c, 'm1', 'recovery', now, (_id, at) => { reads.push(at); return row({ observedAtMs: now }); });
    expect(foreign.metrics[0].baseline.state).toBe('foreign-origin');
    expect(reads).toEqual([undefined]);
  });

  it('keeps missing legacy metadata explicit and contains owner read failures', () => {
    const c = contract(); delete c.outcome;
    expect(projectMaturationOutcome(c, 'm1', 'recovery', now, () => { throw new Error('unused'); }).state).toBe('missing-contract');
    expect(projectMaturationOutcome(contract(), 'm1', 'recovery', now, () => { throw new Error('unavailable'); }).metrics[0]).toMatchObject({ baseline: { state: 'unavailable' }, current: { state: 'unavailable' }, delta: null });
  });

  it('does not claim proof with an invalid clock or malformed persisted metric policy', () => {
    expect(projectMaturationOutcome(contract(), 'm1', 'recovery', Number.NaN, () => row()).state).toBe('unverified');
    const c = contract(); c.evidenceMaxAgeHours = Number.NaN;
    expect(projectMaturationOutcome(c, 'm1', 'recovery', now, () => row()).state).toBe('invalid-contract');
  });

  it('validates peer proof arithmetic, origin, sample floors and receiving-time freshness', () => {
    const detail = () => ({ featureId: 'recovery', subjectKnown: true, evidence: project() });
    expect(validMaturationOutcomeDetail(detail(), 'm1', now)).toBe(true);
    expect(validMaturationOutcomeDetail(detail(), 'm2', now)).toBe(false);
    expect(validMaturationOutcomeDetail(detail(), 'm1', now + 13 * 3_600_000)).toBe(false);
    const wrongDelta = detail(); wrongDelta.evidence.metrics[0].delta = 0.99;
    expect(validMaturationOutcomeDetail(wrongDelta, 'm1', now)).toBe(false);
    const lowSamples = detail(); lowSamples.evidence.metrics[0].current.samples = 19;
    expect(validMaturationOutcomeDetail(lowSamples, 'm1', now)).toBe(false);
    const future = { featureId: 'recovery', subjectKnown: true, evidence: projectMaturationOutcome(contract(), 'm1', 'recovery', now + 2,
      (_id, at) => at === undefined ? row({ observedAtMs: now + 1, value: 0.96 }) : row()) };
    expect(validMaturationOutcomeDetail(future, 'm1', now)).toBe(false);
    const futureBaseline = { featureId: 'recovery', subjectKnown: true, evidence: project(row(), null) };
    futureBaseline.evidence.metrics[0].baseline.observedAtMs = now + 1;
    expect(validMaturationOutcomeDetail(futureBaseline, 'm1', now)).toBe(false);
  });
});
