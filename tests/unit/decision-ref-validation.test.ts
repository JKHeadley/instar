import { describe, expect, it } from 'vitest';
import { isPlausibleDecisionRef } from '../../src/server/routes.js';

describe('decision-quality advisory reference validation', () => {
  it('accepts the production mesh and single-machine correlation-id shapes', () => {
    expect(isPlausibleDecisionRef('d-m_03b30f-00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isPlausibleDecisionRef('d-00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isPlausibleDecisionRef('b-m_03b30f-00000000-0000-4000-8000-000000000001')).toBe(true);
  });

  it('rejects malformed, injected, and unbounded references', () => {
    expect(isPlausibleDecisionRef('d-m_03b30f-not-a-uuid')).toBe(false);
    expect(isPlausibleDecisionRef('d-m_03b30f-00000000-0000-4000-8000-000000000001;drop')).toBe(false);
    expect(isPlausibleDecisionRef(`d-${'m'.repeat(65)}-00000000-0000-4000-8000-000000000001`)).toBe(false);
  });
});
