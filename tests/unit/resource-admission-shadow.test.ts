import { describe, expect, it } from 'vitest';
import { calibrateStartupMemory, compareResourceAdmission } from '../../src/monitoring/ResourceAdmissionShadow.js';

describe('resource admission shadow calibration', () => {
  const trace = {
    isolated: true, createdAtMs: 100, readyAtMs: 115, windowEndMs: 140,
    points: [
      { atMs: 100, processTreeResidentBytes: 10, hostAvailableBytes: 100 },
      { atMs: 120, processTreeResidentBytes: 24, hostAvailableBytes: 82 },
      { atMs: 140, processTreeResidentBytes: 16, hostAvailableBytes: 91 },
    ],
  };

  it('keeps existing memory in the total demand and measures incremental growth separately', () => {
    expect(calibrateStartupMemory(trace)).toEqual({
      peakResidentBytes: 24, peakGrowthBytes: 14, attributionErrorBytes: 4, minimumAvailableBytes: 82,
    });
    expect(calibrateStartupMemory({ ...trace, isolated: false })).toBeUndefined();
    expect(calibrateStartupMemory({ ...trace, points: trace.points.slice(0, 2) })).toBeUndefined();
  });

  it('holds a prediction when attribution error can change the outcome', () => {
    const result = compareResourceAdmission({
      nowMs: 100, maxSampleAgeMs: 10,
      sample: { capturedAtMs: 95, nativePressure: 'normal', availableBytes: 30 },
      calibratedDemandBytes: 24, recoveryReserveBytes: 5,
      startupAccounting: { sampleCapturedAtMs: 95, remainingGrowthBytes: 0, errorBoundBytes: 4 },
    });
    expect(result).toEqual({ verdict: 'unknown', reason: 'attribution-error-can-change-verdict' });
  });
});
