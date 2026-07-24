import { describe, expect, it } from 'vitest';
import { classifyCadenceLiveness } from '../../src/core/cadenceLiveness.js';

describe('classifyCadenceLiveness', () => {
  it('keeps absent and invalid first samples explicitly uninitialized', () => {
    expect(classifyCadenceLiveness(0, 1_000, 100)).toEqual({ state: 'uninitialized' });
    expect(classifyCadenceLiveness(Number.NaN, 1_000, 100)).toEqual({ state: 'uninitialized' });
    expect(classifyCadenceLiveness(900, Number.NaN, 100)).toEqual({ state: 'uninitialized' });
    expect(classifyCadenceLiveness(900, 1_000, Number.NaN)).toEqual({ state: 'uninitialized' });
    expect(classifyCadenceLiveness(900, 1_000, -1)).toEqual({ state: 'uninitialized' });
  });

  it('classifies both sides of the stale boundary', () => {
    expect(classifyCadenceLiveness(900, 1_000, 100)).toEqual({ state: 'healthy', ageMs: 100 });
    expect(classifyCadenceLiveness(899, 1_000, 100)).toEqual({ state: 'stale', ageMs: 101 });
  });

  it('clamps a backwards monotonic seam to a healthy zero-age sample', () => {
    expect(classifyCadenceLiveness(1_100, 1_000, 100)).toEqual({ state: 'healthy', ageMs: 0 });
  });
});
