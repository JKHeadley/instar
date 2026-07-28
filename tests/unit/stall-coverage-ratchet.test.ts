/**
 * THE stall-coverage CI ratchet (docs/specs/framework-stall-coverage-matrix.md
 * §3.2 callsite 1 — the primary enforcement).
 *
 * Runs the hermetic validator against the REAL repo on every push (this file
 * lives in the whole-tree push suite): a matrix file exists for every
 * REQUIRED_MATRIX_FRAMEWORKS member, every matrix passes every hermetic rule,
 * the spec §2.1 table mirrors the class registry, and the sentinel-kind join
 * table maps onto canonical class ids. A canonical class addition or a renamed
 * detector symbol turns the affected matrices red on the NEXT PUSH unless the
 * same PR ran the codemod — matrices cannot rot between onboardings.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateAllStallMatrices,
  validateSpecTableAgreement,
} from '../../src/core/stallCoverageValidator.js';
import {
  REQUIRED_MATRIX_FRAMEWORKS,
  STALL_CLASSES,
  SENTINEL_KIND_TO_STALL_CLASS,
} from '../../src/data/stall-classes.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('stall-coverage CI ratchet (real repo)', () => {
  it('every required framework has a matrix file and every matrix passes hermetic validation', () => {
    const set = validateAllStallMatrices({ repoRoot });

    // Set-level issues (matrix-file-missing) — deleting a matrix is a red build.
    expect(set.issues).toEqual([]);

    const validated = new Set(set.results.map((r) => r.framework));
    for (const fw of REQUIRED_MATRIX_FRAMEWORKS) {
      expect(validated.has(fw), `matrix for '${fw}' was not validated`).toBe(true);
    }

    // Zero issues across all matrices — print the full issue list on failure,
    // with the one-command fix for the class-growth case (spec §3.4).
    const allIssues = set.results.flatMap((r) =>
      r.issues.map((i) => `${r.framework}: [${i.rule}] ${i.message}`),
    );
    const fixHint = allIssues.some((i) => i.includes('class-row-missing'))
      ? ' — FIX: a canonical class was added without seeding existing matrices; run `node scripts/stall-class-codemod.mjs` and commit the seeded rows. For other rules, update the named matrix row.'
      : '';
    expect(allIssues, `stall-coverage ratchet violations${fixHint}`).toEqual([]);
    expect(set.valid).toBe(true);

    for (const r of set.results) {
      expect(r.rowCount).toBe(STALL_CLASSES.length);
      expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // Spec §3.2: every canonical row carries the presence-only marker so no
      // downstream surface can present `covered` as semantically proven.
      expect(r.rows.length).toBe(STALL_CLASSES.length);
      for (const row of r.rows) {
        expect(row.mechanicallyVerified).toBe('presence-only');
      }
    }
  });

  it('the spec §2.1 table mirrors the class registry (prose and code cannot drift)', () => {
    const agreement = validateSpecTableAgreement({ repoRoot });
    expect(agreement.issues.map((i) => `[${i.rule}] ${i.message}`)).toEqual([]);
    expect(agreement.valid).toBe(true);
  });

  it('every SENTINEL_KIND_TO_STALL_CLASS value is a canonical class id', () => {
    const canonical = new Set(STALL_CLASSES.map((c) => c.id));
    for (const [kind, classId] of Object.entries(SENTINEL_KIND_TO_STALL_CLASS)) {
      expect(canonical.has(classId), `kind '${kind}' maps to non-canonical class '${classId}'`).toBe(
        true,
      );
    }
  });
});
