import { describe, expect, it } from 'vitest';
import { resolveCorrectionLearningMode } from '../../src/core/correctionLearningMode.js';

describe('failure-callout capture and preference-learning modes', () => {
  it('makes failure investigation available on an unchanged default agent without preference promotion', () => {
    expect(resolveCorrectionLearningMode({})).toEqual({
      preferencesEnabled: false, failureCalloutsEnabled: true,
      captureEnabled: true, failuresOnly: true,
    });
    expect(resolveCorrectionLearningMode({ monitoring: { correctionLearning: { enabled: false } } }))
      .toEqual(resolveCorrectionLearningMode({}));
  });

  it('preserves preference opt-in alongside failure capture', () => {
    expect(resolveCorrectionLearningMode({ monitoring: { correctionLearning: { enabled: true } } })).toEqual({
      preferencesEnabled: true, failureCalloutsEnabled: true,
      captureEnabled: true, failuresOnly: false,
    });
  });

  it('honors failure opt-out without turning off an independently enabled preference loop', () => {
    expect(resolveCorrectionLearningMode({ monitoring: {
      correctionLearning: { enabled: true }, failureCallouts: { enabled: false },
    } })).toEqual({
      preferencesEnabled: true, failureCalloutsEnabled: false,
      captureEnabled: true, failuresOnly: false,
    });
  });

  it('does not construct a capture pipeline when both features are off', () => {
    expect(resolveCorrectionLearningMode({ monitoring: { failureCallouts: { enabled: false } } })).toEqual({
      preferencesEnabled: false, failureCalloutsEnabled: false,
      captureEnabled: false, failuresOnly: true,
    });
  });
});
