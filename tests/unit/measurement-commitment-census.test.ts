import { describe, expect, it } from 'vitest';
import { readMeasurementCoverage, readMeasurementTargets } from '../../src/server/measurementCoverageRead.js';
import { measurementSourceRef, type GenericMeasurementContract } from '../../src/monitoring/MeasurementSubject.js';
import { validMeasurementCoverage } from '../../src/monitoring/MeasurementCoverage.js';

const now = Date.parse('2026-11-06T11:00:00Z');
function context(records: unknown[] = []) {
  return {
    config: {}, meshSelfId: 'm1',
    initiativeTracker: { list: () => [{ id: 'same', title: 'Existing initiative', status: 'active' }] },
    commitmentTracker: { getAll: () => records },
  };
}

describe('commitment inventory coverage', () => {
  it('keeps active and closed owner records separate from an identical initiative identifier', () => {
    const value = readMeasurementCoverage(context([
      { id: 'same', userRequest: 'Repair the corrective pipeline', status: 'pending' },
      { id: 'closed', userRequest: 'A completed promise', status: 'verified' },
    ]) as never, now);
    expect(value.sources).toContainEqual({ name: 'commitment-tracker', ok: true });
    expect(value.counts.effort.total).toBe(3);
    expect(value.rows.find(r => r.id === 'commitment:["m1","same"]')).toMatchObject({ kind: 'effort', title: 'Commitment same', posture: 'pending', subjects: [], state: 'not-linked', sources: ['commitment-tracker'] });
    expect(JSON.stringify(value)).not.toContain('Repair the corrective pipeline');
    expect(JSON.stringify(value)).not.toContain('A completed promise');
    expect(value.rows.find(r => r.id === 'commitment:["m1","closed"]')).toMatchObject({ posture: 'verified', state: 'not-linked' });
    expect(value.rows.find(r => r.id === 'same')?.sources).toEqual(['initiative-tracker']);
    expect(validMeasurementCoverage(value, 'm1', now)).toBe(true);
  });

  it('reports absent and failed trackers without erasing known initiative records', () => {
    for (const tracker of [undefined, { getAll: () => { throw Error('unreadable'); } }]) {
      const ctx = { ...context(), commitmentTracker: tracker } as never;
      const value = readMeasurementCoverage(ctx, now);
      expect(value.sources).toContainEqual({ name: 'commitment-tracker', ok: false, reason: 'unavailable' });
      expect(value.sourcesComplete).toBe(false);
      expect(value.rows.find(r => r.id === 'same')).toBeDefined();
    }
  });

  it('does not lend registered initiative measurement links to a same-named commitment', () => {
    const contract: GenericMeasurementContract = {
      subject: { kind: 'effort', key: 'same' }, cadenceHours: 6, evidenceMaxAgeHours: 12,
      metrics: [{ id: 'outcome', source: 'feature-summary', sourceRef: '', direction: 'at-least', threshold: 1, minSamples: 1 }, { id: 'quality', source: 'feature-summary', sourceRef: '', direction: 'at-most', threshold: 0, minSamples: 1 }],
      outcome: { statement: 'Recorded comparison', owner: 'test', method: 'isolated fixture', version: 'v1', outcomeMetricIds: ['outcome'], qualityMetricIds: ['quality'], baseline: { origin: 'm1', points: ['outcome', 'quality'].map(id => ({ id, observedAtMs: now - 1000, descriptorVersion: 1, value: 0, samples: 1 })) } },
    };
    for (const metric of contract.metrics) metric.sourceRef = measurementSourceRef(contract, metric.id);
    const ctx = { ...context([{ id: 'same', userRequest: 'Distinct commitment record', status: 'pending' }]), initiativeTracker: { list: () => [{ id: 'same', title: 'Measured initiative', status: 'active', measurement: contract }] } } as never;
    expect(readMeasurementTargets(ctx, now).get('same')).toBe('registered');
    const value = readMeasurementCoverage(ctx, now);
    expect(value.rows.find(r => r.id === 'same')?.subjects).toEqual(['same']);
    expect(value.rows.find(r => r.id === 'commitment:["m1","same"]')).toMatchObject({ subjects: [], state: 'not-linked' });
  });

  it('preserves the owner composite identity for equal commitment identifiers from different origins', () => {
    const value = readMeasurementCoverage(context([
      { id: 'CMT-1', originMachineId: 'm-a', userRequest: 'Private A', status: 'pending' },
      { id: 'CMT-1', originMachineId: 'm-b', userRequest: 'Private B', status: 'delivered' },
    ]) as never, now);
    expect(value.counts.effort.total).toBe(3);
    expect(value.rows.filter(r => r.sources.includes('commitment-tracker')).map(r => r.id)).toEqual(['commitment:["m-a","CMT-1"]', 'commitment:["m-b","CMT-1"]']);
    expect(JSON.stringify(value)).not.toContain('Private A');
    expect(JSON.stringify(value)).not.toContain('Private B');
  });

  it('retains totals and explicit omissions for a large owner inventory within the existing peer bound', () => {
    const value = readMeasurementCoverage(context(Array.from({ length: 4000 }, (_, i) => ({ id: `CMT-${i}`, userRequest: 'A long recorded promise '.repeat(20), status: 'pending' }))) as never, now);
    expect(value.counts.effort.total).toBe(4001);
    expect(value.omittedRows).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(128 * 1024);
    expect(value.rows.filter(r => r.sources.includes('commitment-tracker')).every(r => r.title.length <= 160)).toBe(true);
  });
});
