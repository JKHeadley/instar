import { describe, expect, it } from 'vitest';
import { validateCanonicalPipelineRuntimeEvidence, type CanonicalPipelineRuntimeEvidence } from '../../src/core/canonicalPipelineRuntimeEvidence.js';

const healthy: CanonicalPipelineRuntimeEvidence = {
  consumerConstructed: true, cadenceEnabled: true, productionConsumerAdapter: true, authoritativeReadBack: true,
  attemptedDeliveries: 2, uniqueWorkRows: 1, uniqueArtifactLinks: 1, progressMetricBefore: 0, progressMetricAfter: 1,
};

describe('canonical pipeline runtime evidence guard', () => {
  it('accepts constructed, cadenced, idempotent, progressing real wiring', () => {
    expect(validateCanonicalPipelineRuntimeEvidence(healthy)).toEqual([]);
  });

  it.each([
    ['dead/unconstructed consumer', { consumerConstructed: false }, 'consumer-unconstructed'],
    ['disabled cadence', { cadenceEnabled: false }, 'cadence-disabled'],
    ['ineffective idempotency', { uniqueWorkRows: 2 }, 'ineffective-idempotency'],
    ['missing progress metric', { progressMetricAfter: null }, 'missing-progress-metric'],
    ['fake wiring', { productionConsumerAdapter: false }, 'fake-wiring'],
  ])('rejects %s as runtime evidence, separate from structural lint', (_label, patch, failure) => {
    expect(validateCanonicalPipelineRuntimeEvidence({ ...healthy, ...patch })).toContain(failure);
  });
});
