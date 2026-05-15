/**
 * Tests for the capability-honesty marker canary.
 */

import { describe, it, expect } from 'vitest';
import { runCapabilityHonestyCanary } from '../../../../src/providers/canary/capabilityHonestyCanary.js';

describe('runCapabilityHonestyCanary', () => {
  it('passes when all three adapter stub factories produce detectable stubs', () => {
    const result = runCapabilityHonestyCanary();
    expect(result.status).toBe('pass');
    expect(result.details.headlessStubDetected).toBe(true);
    expect(result.details.poolStubDetected).toBe(true);
    expect(result.details.codexStubDetected).toBe(true);
    expect(result.details.realPrimitiveCorrectlyNotDetected).toBe(true);
    expect(result.details.markerReadDidNotThrow).toBe(true);
  });

  it('is fast — runs synchronously, no I/O', () => {
    const start = Date.now();
    runCapabilityHonestyCanary();
    const elapsed = Date.now() - start;
    // Should complete in well under 50ms; allow margin for slow CI.
    expect(elapsed).toBeLessThan(500);
  });
});
