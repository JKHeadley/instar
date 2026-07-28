import { describe, expect, it } from 'vitest';
import { parseMaturationContract } from '../../src/core/featureRolloutScan.js';

describe('parseMaturationContract', () => {
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
