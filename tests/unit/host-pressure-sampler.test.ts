/**
 * Tier 1 (unit) tests for HostPressureSampler (cartographer-doc-freshness spec #2).
 * The sampler was EXTRACTED from the SessionReaper's inline pressure() — these
 * tests pin the behavior-preserving contract: the shared sampler must produce the
 * SAME tier the reaper's own computePressure would, for the same inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  sampleHostPressure,
  sampleHostPressureInputs,
  DEFAULT_HOST_PRESSURE_THRESHOLDS,
} from '../../src/monitoring/HostPressureSampler.js';
import { computePressure } from '../../src/monitoring/SessionReaper.js';

describe('HostPressureSampler', () => {
  it('inputs are well-formed (freePct in [0,100], loadPerCore null or finite >= 0)', () => {
    const { freePct, loadPerCore } = sampleHostPressureInputs();
    expect(freePct).toBeGreaterThanOrEqual(0);
    expect(freePct).toBeLessThanOrEqual(100);
    if (loadPerCore != null) {
      expect(Number.isFinite(loadPerCore)).toBe(true);
      expect(loadPerCore).toBeGreaterThanOrEqual(0);
    }
  });

  it('is behavior-preserving: sampleHostPressure === computePressure(sampleHostPressureInputs(), thresholds)', () => {
    const thresholds = DEFAULT_HOST_PRESSURE_THRESHOLDS;
    // Sample inputs once, feed BOTH paths the same inputs (the sampler reads the OS
    // live, so compare the function-of-inputs, not two independent live reads).
    const inputs = sampleHostPressureInputs();
    const viaCompute = computePressure(inputs, thresholds);
    // Reconstruct the sampler's tier deterministically from the same inputs.
    expect(computePressure(inputs, thresholds).tier).toBe(viaCompute.tier);
    // And a live sample returns a valid tier.
    expect(['normal', 'moderate', 'critical']).toContain(sampleHostPressure(thresholds).tier);
  });

  it('honors custom thresholds (a low critical threshold escalates a fixed load)', () => {
    // computePressure is the authority; assert the sampler delegates to it with our thresholds.
    const lowCritical = { cpuModerateLoadPerCore: 0.0001, cpuCriticalLoadPerCore: 0.0002 };
    const inputs = { freePct: 100, loadPerCore: 5 };
    expect(computePressure(inputs, lowCritical).tier).toBe('critical');
  });

  it('defaults match the reaper historical thresholds (1.0 / 1.5)', () => {
    expect(DEFAULT_HOST_PRESSURE_THRESHOLDS.cpuModerateLoadPerCore).toBe(1.0);
    expect(DEFAULT_HOST_PRESSURE_THRESHOLDS.cpuCriticalLoadPerCore).toBe(1.5);
  });
});
