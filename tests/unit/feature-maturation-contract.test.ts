import { describe, expect, it } from 'vitest';
import { parseMaturationContract } from '../../src/core/featureRolloutScan.js';

describe('parseMaturationContract', () => {
  it('preserves declared outcome metadata and rejects malformed opted-in baselines', () => {
    const contract = { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'coverage', source: 'blocker-summary', sourceRef: 'clear-latency.coverage', direction: 'at-least', threshold: 0.95, minSamples: 10 }],
      outcome: { statement: 'More complete clear telemetry', owner: 'clear-owner', method: 'Completed clear coverage', version: 'v1', outcomeMetricIds: ['coverage'], qualityMetricIds: ['coverage'], baseline: { origin: 'm1', points: [{ id: 'coverage', observedAtMs: 1_000, descriptorVersion: 1, value: 0.8, samples: 20 }] } } };
    expect(parseMaturationContract(JSON.stringify(contract))).toMatchObject({ ok: true, contract: { outcome: contract.outcome } });
    contract.outcome.baseline.points[0].id = 'other';
    expect(parseMaturationContract(JSON.stringify(contract))).toEqual({ ok: false, error: 'invalid-shape' });
  });

  it('accepts the closed blocker source registry', () => {
    const result = parseMaturationContract(JSON.stringify({ cadenceHours: 6, evidenceMaxAgeHours: 12,
      metrics: [{ id: 'coverage', source: 'blocker-summary', sourceRef: 'clear-latency.coverage',
        direction: 'at-least', threshold: 0.95, minSamples: 10 }] }));
    expect(result).toMatchObject({ ok: true, contract: { cadenceHours: 6 } });
  });

  it('rejects malformed cadence and reserved producer refs', () => {
    expect(parseMaturationContract('{')).toEqual({ ok: false, error: 'invalid-json' });
    expect(parseMaturationContract(JSON.stringify({ cadenceHours: 1, evidenceMaxAgeHours: 2, metrics: [] })))
      .toEqual({ ok: false, error: 'invalid-shape' });
    expect(parseMaturationContract(JSON.stringify({ cadenceHours: 6, evidenceMaxAgeHours: 12,
      metrics: [{ id: 'quality', source: 'decision-quality', sourceRef: 'foo', direction: 'at-least', threshold: 1, minSamples: 1 }] })))
      .toEqual({ ok: false, error: 'invalid-shape' });
  });
});
