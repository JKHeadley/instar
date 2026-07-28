/**
 * Unit (Tier 1) — PARITY: scripts/lib/class-closure-grader.mjs ≡ the exported
 * StandardsEnforcementAuditor grader (classifyFileGuard + gradeGuardCitation).
 *
 * The .mjs is a self-contained MIRROR (the CI lint runs on a fresh checkout with
 * no build step and cannot import the TS from dist/). This test pins the two
 * implementations byte-equal for the same inputs over the REAL repo checkout, so
 * they cannot silently drift (Structure > Willpower — the grader's own comment
 * names this test).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyFileGuard as tsClassify,
  gradeGuardCitation as tsGrade,
} from '../../src/core/StandardsEnforcementAuditor.js';
// @ts-expect-error — .mjs script, no type declarations; runtime import is fine under vitest
import { classifyFileGuard as mjsClassify, gradeGuardCitation as mjsGrade } from '../../scripts/lib/class-closure-grader.mjs';

const REPO = process.cwd();

const FILE_REFS = [
  'tests/unit/class-closure-grader.test.ts',
  'src/core/DefectClassRegistry.ts',
  'scripts/lint-guard-manifest.js',
  'scripts/class-closure-lint.mjs',
  'docs/specs/class-closure-gate.md',
  'docs/defect-classes.json',
  'no-direct-thing.js',
  'src/server/routes.ts',
  '.husky/pre-commit',
];

const CITATIONS = [
  'src/core/DefectClassRegistry.ts',
  'docs/specs/class-closure-gate.md',
  'scripts/does-not-exist.mjs',
  'tests/unit/class-closure-grader.test.ts',
  'GET /guards',
  'POST /nonexistent-route-xyz',
  'validateRegistry',
  'aSymbolThatDefinitelyDoesNotExistAnywhere12345',
];

describe('grader parity — classifyFileGuard', () => {
  for (const ref of FILE_REFS) {
    it(`agrees on "${ref}"`, () => {
      expect(mjsClassify(ref)).toBe(tsClassify(ref));
    });
  }
});

describe('grader parity — gradeGuardCitation (over the real repo checkout)', () => {
  for (const citation of CITATIONS) {
    it(`agrees on "${citation}"`, () => {
      expect(mjsGrade(REPO, citation)).toEqual(tsGrade(REPO, citation));
    });
  }
});
