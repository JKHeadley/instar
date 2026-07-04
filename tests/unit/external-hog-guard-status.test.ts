import { describe, it, expect } from 'vitest';
import { externalHogEffectiveState } from '../../src/monitoring/ExternalHogGuardStatus.js';

/**
 * ExternalHogGuardStatus — the §8 guard-posture rule (CMT-1901): posture reflects VERIFIED
 * kill-capability, never a config wish. on-confirmed ONLY when enabled && !dryRun && marker-valid.
 */
const S = externalHogEffectiveState;

describe('externalHogEffectiveState', () => {
  it('off when not enabled', () => {
    expect(S({ enabled: false, dryRun: false, markerValid: true, samplerDead: false })).toBe('off');
  });
  it('on-confirmed ONLY when enabled && !dryRun && marker-valid (actually kill-capable)', () => {
    expect(S({ enabled: true, dryRun: false, markerValid: true, samplerDead: false })).toBe('on-confirmed');
  });
  it('the honesty rule: config.dryRun:false + marker-absent reads on-dry-run, NEVER on-confirmed', () => {
    expect(S({ enabled: true, dryRun: false, markerValid: false, samplerDead: false })).toBe('on-dry-run');
  });
  it('dryRun:true (watch-only soak) reads on-dry-run even with a valid marker', () => {
    expect(S({ enabled: true, dryRun: true, markerValid: true, samplerDead: false })).toBe('on-dry-run');
  });
  it('a dead sampler degrades to on-stale (the feature is blind), overriding the config posture', () => {
    expect(S({ enabled: true, dryRun: false, markerValid: true, samplerDead: true })).toBe('on-stale');
    expect(S({ enabled: true, dryRun: true, markerValid: false, samplerDead: true })).toBe('on-stale');
  });
});
