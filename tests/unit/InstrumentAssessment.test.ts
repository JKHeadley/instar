import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_ASSESSMENT_MARKER,
  parseInstrumentAssessment,
} from '../../src/core/InstrumentAssessment.js';

describe('source-reported instrument assessment', () => {
  it('accepts a coherent partial-coverage assessment', () => {
    const value = {
      status: 'assessed',
      verdict: 'pass',
      reason: 'one peer answered the typed contract; one was unavailable',
      populationSize: 2,
      sampleSize: 1,
      excludedSampleSize: 1,
      exclusions: { unavailable: 1 },
      sampleCoverage: 0.5,
    };

    expect(parseInstrumentAssessment(
      `diagnostic\n${INSTRUMENT_ASSESSMENT_MARKER}${JSON.stringify(value)}\n`,
    )).toEqual(value);
  });

  it('accepts an explicitly unassessable run without fabricating a verdict', () => {
    const value = {
      status: 'unassessable',
      verdict: 'none',
      reason: 'all registered peers were unavailable',
      populationSize: 2,
      sampleSize: 0,
      excludedSampleSize: 2,
      exclusions: { unavailable: 2 },
      sampleCoverage: 0,
    };

    expect(parseInstrumentAssessment(
      `${INSTRUMENT_ASSESSMENT_MARKER}${JSON.stringify(value)}`,
    )).toEqual(value);
  });

  it.each([
    { status: 'assessed', verdict: 'none', populationSize: 1, sampleSize: 1, excludedSampleSize: 0, exclusions: {}, sampleCoverage: 1 },
    { status: 'unassessable', verdict: 'pass', populationSize: 0, sampleSize: 0, excludedSampleSize: 0, exclusions: {}, sampleCoverage: 0 },
    { status: 'assessed', verdict: 'pass', populationSize: 2, sampleSize: 1, excludedSampleSize: 0, exclusions: {}, sampleCoverage: 0.5 },
    { status: 'assessed', verdict: 'pass', populationSize: 2, sampleSize: 1, excludedSampleSize: 1, exclusions: {}, sampleCoverage: 0.5 },
  ])('rejects incoherent source claims %#', (partial) => {
    const value = { reason: 'claim', ...partial };
    expect(parseInstrumentAssessment(
      `${INSTRUMENT_ASSESSMENT_MARKER}${JSON.stringify(value)}`,
    )).toBeNull();
  });

  it('does not infer darkness from ordinary repeated output', () => {
    expect(parseInstrumentAssessment('open conflicts: 0\nopen conflicts: 0')).toBeNull();
  });
});
