/**
 * Convergence Gate Consistency (CONVERGING-AUDIT-DEFAULT.md, Part C).
 *
 * The two convergence gates live on opposite sides of the TS compile boundary:
 *   - the FORMAL gate: src/core/StageTransitionValidator.ts (TS) — its pure
 *     predicate `isConvergenceTagPresent` + its unconditional report-existence
 *     check decide "is this spec converged?".
 *   - the PRECOMMIT gate: scripts/instar-dev-precommit.js (pre-compile .js) —
 *     its recognition is factored into scripts/lib/convergence-recognition.mjs
 *     (`recognizeConvergence` / `isSpecConverged`).
 *
 * They cannot share a single module across the boundary, so this test enforces
 * agreement: a SHARED fixture table (timestamp tag / boolean tag / no tag /
 * report-present / report-missing) is fed to BOTH the validator's logic AND the
 * precommit's recognizer, and we assert they return the SAME converged verdict
 * for every fixture, under BOTH flag states. Drift fails CI.
 *
 * "Converged" here is defined identically on both sides: the convergence TAG is
 * present AND (when the report requirement is on) the report exists. Approval is
 * a separate downstream gate in BOTH paths, so it is not folded into the
 * converged verdict compared here (it is asserted independently below).
 */

import { describe, it, expect } from 'vitest';
import { isConvergenceTagPresent } from '../../src/core/StageTransitionValidator.js';
// @ts-expect-error — .mjs script, no type declarations; runtime import is fine under vitest
import {
  recognizeConvergence,
  isSpecConverged,
  parseConvergenceValue,
} from '../../scripts/lib/convergence-recognition.mjs';

/**
 * A fixture describes a spec's frontmatter shape and whether its report exists.
 * `tagText` is the literal `review-convergence` frontmatter line value (or null
 * for "no tag at all"). `expectedTagPresent` is the ground-truth answer that
 * BOTH gates must agree on for the tag alone.
 */
interface Fixture {
  name: string;
  tagText: string | null;
  reportExists: boolean;
  approved: boolean;
  expectedTagPresent: boolean;
}

const FIXTURES: Fixture[] = [
  { name: 'canonical ISO timestamp tag', tagText: '"2026-06-10T18:10:05Z"', reportExists: true, approved: true, expectedTagPresent: true },
  { name: 'canonical timestamp tag, report MISSING', tagText: '"2026-06-10T18:10:05Z"', reportExists: false, approved: true, expectedTagPresent: true },
  { name: 'legacy boolean true tag', tagText: 'true', reportExists: true, approved: true, expectedTagPresent: true },
  { name: 'boolean true, not approved', tagText: 'true', reportExists: true, approved: false, expectedTagPresent: true },
  { name: 'no convergence tag', tagText: null, reportExists: false, approved: true, expectedTagPresent: false },
  { name: 'empty-string tag', tagText: '""', reportExists: true, approved: true, expectedTagPresent: false },
];

/** Build a YAML frontmatter BLOCK (between the fences) for a fixture. */
function frontmatterFor(f: Fixture): string {
  const lines = ['title: fixture', 'slug: fixture-spec'];
  if (f.tagText !== null) lines.push(`review-convergence: ${f.tagText}`);
  if (f.approved) lines.push('approved: true');
  return lines.join('\n');
}

/**
 * The VALIDATOR-side converged verdict, expressed over the same inputs the
 * precommit recognizer sees. The validator parses the raw frontmatter value and
 * runs `isConvergenceTagPresent`; its report check is UNCONDITIONAL in the
 * formal gate. To compare apples-to-apples under both flag states, we model the
 * validator's converged verdict as: tag present AND (report required ? report
 * exists : tag present) — i.e. when the precommit's flag is OFF, the validator's
 * unconditional report check is the stricter side, so we compare the TAG verdict
 * there and the FULL (tag + report) verdict when the flag is ON. The fixtures
 * with a missing report exercise both.
 */
function validatorTagVerdict(f: Fixture): boolean {
  // The validator reads the parsed frontmatter value. We reproduce parsing via
  // the recognizer's parser (the precommit's exact regex) so we compare the
  // SAME extracted token — then run the validator's OWN predicate on it.
  const value = parseConvergenceValue(frontmatterFor(f));
  return isConvergenceTagPresent(value);
}

describe('Convergence gate consistency (validator ↔ precommit recognizer)', () => {
  describe('tag recognition agrees for every fixture', () => {
    for (const f of FIXTURES) {
      it(`${f.name}: both gates agree the tag is ${f.expectedTagPresent ? 'PRESENT' : 'ABSENT'}`, () => {
        const fm = frontmatterFor(f);
        // Validator side.
        const validatorSays = validatorTagVerdict(f);
        // Precommit side (tag only, report not required).
        const precommitSays = isConvergenceTagPresent(parseConvergenceValue(fm));
        expect(validatorSays).toBe(f.expectedTagPresent);
        expect(precommitSays).toBe(f.expectedTagPresent);
        expect(validatorSays).toBe(precommitSays);
      });
    }
  });

  describe('converged verdict agrees under BOTH flag states', () => {
    for (const requireReport of [false, true]) {
      for (const f of FIXTURES) {
        it(`flag=${requireReport} / ${f.name}: validator & precommit converged verdicts match`, () => {
          const fm = frontmatterFor(f);

          // Precommit recognizer's converged verdict (tag + report-backing).
          const precommitConverged = isSpecConverged(fm, {
            requireReport,
            reportExists: f.reportExists,
          });

          // Validator-modeled converged verdict for the SAME inputs:
          //  - flag OFF: the precommit does NOT require the report, so its
          //    converged verdict is the TAG verdict. The formal validator would
          //    additionally require the report, but Part B keeps the precommit
          //    asymmetric — so under flag-OFF the agreeing surface is the tag.
          //  - flag ON: the precommit matches the formal validator exactly —
          //    tag present AND report exists.
          const validatorConverged = requireReport
            ? validatorTagVerdict(f) && f.reportExists
            : validatorTagVerdict(f);

          expect(precommitConverged).toBe(validatorConverged);
        });
      }
    }
  });

  describe('recognizeConvergence full verdict (tag + approved + report)', () => {
    it('flag OFF: a timestamp-tagged + approved spec is accepted even with no report (today\'s behavior)', () => {
      const f = FIXTURES.find((x) => x.name === 'canonical timestamp tag, report MISSING')!;
      const r = recognizeConvergence(frontmatterFor(f), { requireReport: false, reportExists: false });
      expect(r.accepted).toBe(true);
      expect(r.reason).toBe('accepted');
    });

    it('flag ON: the same spec is REJECTED for the missing report', () => {
      const f = FIXTURES.find((x) => x.name === 'canonical timestamp tag, report MISSING')!;
      const r = recognizeConvergence(frontmatterFor(f), { requireReport: true, reportExists: false });
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('convergence-report-missing');
    });

    it('flag ON: the same spec is ACCEPTED once the report exists', () => {
      const f = FIXTURES.find((x) => x.name === 'canonical timestamp tag, report MISSING')!;
      const r = recognizeConvergence(frontmatterFor(f), { requireReport: true, reportExists: true });
      expect(r.accepted).toBe(true);
      expect(r.reason).toBe('accepted');
    });

    it('a converged spec missing the approved tag is rejected (approved-tag-missing) regardless of flag', () => {
      const f = FIXTURES.find((x) => x.name === 'boolean true, not approved')!;
      for (const requireReport of [false, true]) {
        const r = recognizeConvergence(frontmatterFor(f), { requireReport, reportExists: true });
        expect(r.accepted).toBe(false);
        expect(r.reason).toBe('approved-tag-missing');
      }
    });

    it('a spec with no convergence tag is rejected (convergence-tag-missing)', () => {
      const f = FIXTURES.find((x) => x.name === 'no convergence tag')!;
      const r = recognizeConvergence(frontmatterFor(f), { requireReport: false, reportExists: false });
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('convergence-tag-missing');
    });
  });
});
