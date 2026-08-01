/**
 * Source-reported measurement state for recurring instruments.
 *
 * This is deliberately not a generic "dark instrument detector". Repeatedly
 * equal outcomes cannot distinguish a healthy empty-conflict register from a
 * canary that maps every transport state to failure. The source owns that
 * semantic distinction; the scheduler only validates and preserves its report.
 */

export const INSTRUMENT_ASSESSMENT_MARKER = 'INSTAR_INSTRUMENT_ASSESSMENT=';

export interface InstrumentAssessment {
  /** Whether this run produced any real measurement. */
  status: 'assessed' | 'unassessable';
  /** A verdict exists only when the run was assessed. */
  verdict: 'pass' | 'fail' | 'none';
  /** Stable source-owned explanation, suitable for operator surfaces. */
  reason: string;
  /** Full candidate population for this run. */
  populationSize: number;
  /** Common measured cohort used for the verdict. */
  sampleSize: number;
  /** Candidates that could not be measured. */
  excludedSampleSize: number;
  /** Source-owned exclusion categories whose counts sum to excludedSampleSize. */
  exclusions: Record<string, number>;
  /** sampleSize / populationSize, or 0 for an empty population. */
  sampleCoverage: number;
}

export function parseInstrumentAssessment(output: string): InstrumentAssessment | null {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find(candidate => candidate.startsWith(INSTRUMENT_ASSESSMENT_MARKER));
  if (!line) return null;

  let value: unknown;
  try {
    value = JSON.parse(line.slice(INSTRUMENT_ASSESSMENT_MARKER.length));
  } catch {
    // @silent-fallback-ok — malformed source claims carry no authority and are
    // deliberately treated exactly like an absent optional assessment marker.
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.status !== 'assessed' && row.status !== 'unassessable') return null;
  if (row.verdict !== 'pass' && row.verdict !== 'fail' && row.verdict !== 'none') return null;
  if (row.status === 'assessed' && row.verdict === 'none') return null;
  if (row.status === 'unassessable' && row.verdict !== 'none') return null;
  if (typeof row.reason !== 'string' || row.reason.trim().length === 0) return null;

  const populationSize = nonNegativeInteger(row.populationSize);
  const sampleSize = nonNegativeInteger(row.sampleSize);
  const excludedSampleSize = nonNegativeInteger(row.excludedSampleSize);
  if (populationSize === null || sampleSize === null || excludedSampleSize === null) return null;
  if (sampleSize + excludedSampleSize !== populationSize) return null;
  if (row.status === 'assessed' && sampleSize === 0) return null;
  if (row.status === 'unassessable' && sampleSize !== 0) return null;

  if (!row.exclusions || typeof row.exclusions !== 'object' || Array.isArray(row.exclusions)) return null;
  const exclusions: Record<string, number> = {};
  for (const [key, count] of Object.entries(row.exclusions as Record<string, unknown>)) {
    if (!key.trim()) return null;
    const parsed = nonNegativeInteger(count);
    if (parsed === null) return null;
    exclusions[key] = parsed;
  }
  if (Object.values(exclusions).reduce((sum, count) => sum + count, 0) !== excludedSampleSize) return null;

  const expectedCoverage = populationSize > 0 ? sampleSize / populationSize : 0;
  if (typeof row.sampleCoverage !== 'number' || !Number.isFinite(row.sampleCoverage)) return null;
  if (Math.abs(row.sampleCoverage - expectedCoverage) > Number.EPSILON * 8) return null;

  return {
    status: row.status,
    verdict: row.verdict,
    reason: row.reason,
    populationSize,
    sampleSize,
    excludedSampleSize,
    exclusions,
    sampleCoverage: row.sampleCoverage,
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
