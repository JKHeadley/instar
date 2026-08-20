/**
 * IDs with executable blind-input cases in
 * tests/unit/checker-blind-input-ratchet.test.ts.
 *
 * This is coverage, never the denominator. The denominator is recursively
 * derived from production code by checker-blind-input-ratchet.mjs.
 */
export const BLIND_INPUT_CASE_IDS = Object.freeze([
  'detector:src/monitoring/HumanAsDetectorLog.ts',
  'probe:src/monitoring/probes/GuardPostureProbe.ts',
  'reviewer:src/core/reviewers/standards-conformance.ts',
  'script:scripts/lint-checker-blind-input-coverage.mjs',
  'script:scripts/lint-llm-attribution.js',
]);
