/**
 * The known-red canary (docs/specs/local-verify-borrowed-unit-slices.md, F). `main` is almost always
 * green, which cannot show a helper reporting green for a file that really fails. So every shadow
 * run adds one canary slice of seeded fixture files with known outcomes. The helper is not told
 * which slice is the canary. Its false-green rate on the canary is reported separately.
 *
 * The fixtures live under tests/fixtures/borrowed-canary/, which the inventory excludes
 * (`tests/fixtures/**`) and the unit config does not include, so the normal unit lane never runs them.
 */
import { BORROWED_CANARY_DIR } from './borrowedEligibility.js';

export interface CanaryExpectation { passed: number; failed: number; skipped: number; todo: number }

export const BORROWED_CANARY: Readonly<Record<string, CanaryExpectation>> = Object.freeze({
  [`${BORROWED_CANARY_DIR}canary-pass.test.ts`]: { passed: 2, failed: 0, skipped: 0, todo: 0 },
  [`${BORROWED_CANARY_DIR}canary-assertion-fail.test.ts`]: { passed: 1, failed: 1, skipped: 0, todo: 0 },
  // An error thrown while the file loads: vitest reports the file failed with no assertions (one failure).
  [`${BORROWED_CANARY_DIR}canary-thrown-error.test.ts`]: { passed: 0, failed: 1, skipped: 0, todo: 0 },
  // Its test passes; the unhandled rejection is a slice-level error (unhandledErrors > 0).
  [`${BORROWED_CANARY_DIR}canary-unhandled-rejection.test.ts`]: { passed: 1, failed: 0, skipped: 0, todo: 0 },
  [`${BORROWED_CANARY_DIR}canary-skips.test.ts`]: { passed: 1, failed: 0, skipped: 1, todo: 1 },
});

export const BORROWED_CANARY_FILES: readonly string[] = Object.freeze(Object.keys(BORROWED_CANARY).sort());
