import { describe, expect, it } from 'vitest';
import { measurementCoverage, type CoverageMember } from '../../src/monitoring/MeasurementCoverage.js';
const now = Date.parse('2026-11-06T01:00:00Z');
const item = (kind: CoverageMember['kind'], id: string, subjects: string[] = []): CoverageMember => ({ kind, id, title: id, sources: ['independent-owner'], subjects });
const proof = { declaration: 'declared' as const, enrollmentKnown: true, subjectKnown: true, evidence: { state: 'verified', metrics: [{ baseline: { state: 'verified' }, current: { state: 'verified' } }] } };
describe('independent measurement coverage', () => {
  it('retains unregistered default-on features, decisions, disabled jobs and parent/child efforts', () => {
    const members = [item('feature', 'default-on'), item('decision', 'unreviewed'), { ...item('job', 'disabled'), posture: 'disabled' }, item('effort', 'parent'), { ...item('effort', 'child'), parentId: 'parent' }];
    const v = measurementCoverage('m1', now, members, [{ name: 'owners', ok: true }], () => proof);
    expect(v.rows).toHaveLength(5); expect(v.counts.effort.total).toBe(2);
    expect(v.rows.every(r => r.state === 'not-linked')).toBe(true);
    expect(v.rows.find(r => r.id === 'child')?.parentId).toBe('parent');
  });
  it('uses exact explicit links, reports ambiguity and never transfers child proof to a parent', () => {
    const v = measurementCoverage('m1', now, [item('effort', 'parent'), { ...item('effort', 'child', ['s']), parentId: 'parent' }, item('feature', 'ambiguous', ['s', 'other'])], [], () => proof);
    expect(v.rows.map(r => [r.id, r.state])).toEqual([['ambiguous', 'ambiguous'], ['child', 'corroborated'], ['parent', 'not-linked']]);
    expect(v.sourcesComplete).toBe(false);
  });
  it('keeps declaration, missing, invalid, stale, unavailable and sampled proof separate', () => {
    for (const state of ['missing-contract', 'invalid-contract', 'stale', 'unavailable', 'insufficient-samples', 'mismatch']) {
      const p = { declaration: 'declared' as const, enrollmentKnown: true, subjectKnown: true, evidence: { state, metrics: [{ baseline: { state: 'verified' }, current: { state } }] } };
      const v = measurementCoverage('m1', now, [item('feature', 'x', ['s'])], [{ name: 'x', ok: false, reason: 'offline' }], () => p);
      expect(v.rows[0].state).toBe(state === 'mismatch' ? 'incompatible' : state);
      expect(v.sourcesComplete).toBe(false);
    }
    expect(measurementCoverage('m1', now, [item('feature', 'x', ['s'])], [], () => { throw Error('offline'); }).rows[0].state).toBe('unavailable');
  });
  it('retains graduated declarations when current D7 enrollment is absent', () => {
    const v = measurementCoverage('m1', now, [item('feature', 'graduated', ['old'])], [], () => ({ ...proof, subjectKnown: false }));
    expect(v.rows[0].declaration).toBe('declared'); expect(v.rows[0].state).toBe('inactive');
  });
  it('memoizes shared subject evidence once across namespace rows', () => {
    let calls = 0;
    measurementCoverage('m1', now, [item('feature', 'flag', ['s']), item('effort', 'effort', ['s'])], [], () => { calls++; return proof; });
    expect(calls).toBe(1);
  });
  it('counts all rows before clipping and gives every kind a display turn', () => {
    const members = [...Array.from({ length: 4000 }, (_, i) => item('feature', `flag-${i}`)), item('job', 'j'), item('decision', 'd'), item('effort', 'e'), item('capability', 'c')];
    const v = measurementCoverage('m1', now, members, [], () => null, { maxRows: 8, maxBytes: 8192 });
    expect(v.counts.feature.total).toBe(4000); expect(v.omittedRows).toBe(3996);
    expect(new Set(v.rows.map(r => r.kind)).size).toBe(5);
    expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThan(8192);
  });
  it('deduplicates identical kind/id sources without collapsing namespaces or ambiguous links', () => {
    const a = item('feature', 'same', ['a']);
    const v = measurementCoverage('m1', now, [a, { ...a, sources: ['second'], subjects: ['b'] }, item('job', 'same')], [], () => proof);
    expect(v.counts.feature.total).toBe(1); expect(v.counts.job.total).toBe(1);
    expect(v.rows.find(r => r.kind === 'feature')?.state).toBe('ambiguous');
  });
});

describe('coverage pool validation', () => {
  it('refuses unsupported, foreign, future, stale and inconsistent count payloads', async () => {
    const { validMeasurementCoverage } = await import('../../src/monitoring/MeasurementCoverage.js');
    const v = measurementCoverage('m1', now, [item('feature', 'x')], [{ name: 'owner', ok: true }], () => null);
    expect(validMeasurementCoverage(v, 'm1', now)).toBe(true);
    expect(validMeasurementCoverage(v, 'other', now)).toBe(false);
    expect(validMeasurementCoverage(v, 'm1', now + 121000)).toBe(false);
    expect(validMeasurementCoverage(v, 'm1', now - 6000)).toBe(false);
    expect(validMeasurementCoverage({ schema: 'maturation-board/1' }, 'm1', now)).toBe(false);
    const contradictory = structuredClone(v); contradictory.rows[0].state = 'corroborated'; contradictory.counts.feature.states['not-linked'] = 0; contradictory.counts.feature.states.corroborated = 1;
    expect(validMeasurementCoverage(contradictory, 'm1', now)).toBe(false);
    const bad = structuredClone(v); bad.counts.feature.total++;
    expect(validMeasurementCoverage(bad, 'm1', now)).toBe(false);
    const dup = structuredClone(v); dup.rows.push(dup.rows[0]); dup.counts.feature.total++; dup.counts.feature.states['not-linked']++;
    expect(validMeasurementCoverage(dup, 'm1', now)).toBe(false);
  });
});
