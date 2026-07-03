/**
 * Unit (Tier 1) — PARITY: scripts/lib/defect-class-registry.mjs ≡ the pure
 * functions of src/core/DefectClassRegistry.ts (validateRegistry, deriveClassData,
 * computeEscalation + constants).
 *
 * The .mjs mirror lets the CI lint run on a fresh checkout with NO build step.
 * This test pins the mirror equal to the canonical TS for the same inputs, so a
 * behavior change to one without the other fails CI (Structure > Willpower).
 */

import { describe, it, expect } from 'vitest';
import {
  validateRegistry as tsValidate,
  deriveClassData as tsDerive,
  computeEscalation as tsEscalate,
  DEFAULT_SPREAD_N,
  DEFAULT_SINGLE_K,
  DEFAULT_GAP_MAX_AGE_DAYS,
  type DecisionDeclaration,
  type DerivedClassData,
} from '../../src/core/DefectClassRegistry.js';
// @ts-expect-error — .mjs mirror, no type declarations; runtime import is fine under vitest
import * as mjs from '../../scripts/lib/defect-class-registry.mjs';

/** Normalize a Map<string, DerivedClassData> to a stable, comparable shape. */
function mapToObj(m: Map<string, DerivedClassData>): Record<string, DerivedClassData> {
  const out: Record<string, DerivedClassData> = {};
  for (const [k, v] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) out[k] = v;
  return out;
}

const REGISTRIES: unknown[] = [
  { version: 1, classes: [] },
  'not-an-object',
  { classes: 'nope' },
  {
    version: 1,
    classes: [
      { id: 'good-class', description: 'd', includes: ['a'], excludes: ['b'], canonicalExamples: [], status: 'confirmed', severity: 'normal', closureStandard: null, instanceCount: 0, evidenceCountAtLastAck: 0, proposalId: null },
      { id: 'good-class', description: 'dup', includes: ['a'], excludes: ['b'], canonicalExamples: [], status: 'confirmed', severity: 'critical', closureStandard: null, instanceCount: 0, evidenceCountAtLastAck: 0, proposalId: null },
    ],
  },
  {
    version: 1,
    classes: [
      { id: 'unconf', description: 'd', includes: ['a'], excludes: ['b'], canonicalExamples: [], status: 'unconfirmed', severity: 'normal', closureStandard: null, instanceCount: 0, evidenceCountAtLastAck: 0, proposalId: null },
    ],
  },
];

const DECLARATION_SETS: DecisionDeclaration[][] = [
  [],
  [
    { defectClass: 'x', closure: 'guard', prNumber: 5, component: 'A', source: 'a.json' },
    { defectClass: 'x', closure: 'guard', prNumber: 5, component: 'A', source: 'b.json' },
    { defectClass: 'x', closure: 'gap', prNumber: 7, component: 'B', source: 'c.json' },
    { defectClass: 'y', closure: 'guard', component: 'A', source: 'd.json' },
    { defectClass: 'y', closure: 'guard', component: 'A', source: 'e.json' },
  ],
];

const ESCALATION_CASES: Array<[{ severity: 'critical' | 'normal'; evidenceCountAtLastAck: number }, Partial<DerivedClassData>, { spreadN?: number; singleK?: number }]> = [
  [{ severity: 'critical', evidenceCountAtLastAck: 0 }, { dedupedCount: 1, componentCount: 1, maxSingleComponentCount: 1 }, {}],
  [{ severity: 'normal', evidenceCountAtLastAck: 0 }, { dedupedCount: 3, componentCount: 2, maxSingleComponentCount: 2 }, {}],
  [{ severity: 'normal', evidenceCountAtLastAck: 0 }, { dedupedCount: 2, componentCount: 1, maxSingleComponentCount: 2, hasOpenGap: true }, {}],
  [{ severity: 'normal', evidenceCountAtLastAck: 0 }, { dedupedCount: 5, componentCount: 1, maxSingleComponentCount: 5 }, {}],
  [{ severity: 'normal', evidenceCountAtLastAck: 3 }, { dedupedCount: 3, componentCount: 2, maxSingleComponentCount: 2 }, {}],
  [{ severity: 'normal', evidenceCountAtLastAck: 0 }, { dedupedCount: 2, componentCount: 2, maxSingleComponentCount: 1 }, { spreadN: 2 }],
];

function fullDerived(o: Partial<DerivedClassData>): DerivedClassData {
  return { dedupedCount: 0, componentCount: 0, maxSingleComponentCount: 0, hasOpenGap: false, prs: [], components: [], ...o };
}

describe('registry mirror parity', () => {
  it('exports the same constants', () => {
    expect(mjs.DEFAULT_SPREAD_N).toBe(DEFAULT_SPREAD_N);
    expect(mjs.DEFAULT_SINGLE_K).toBe(DEFAULT_SINGLE_K);
    expect(mjs.DEFAULT_GAP_MAX_AGE_DAYS).toBe(DEFAULT_GAP_MAX_AGE_DAYS);
  });

  it('validateRegistry agrees on every registry shape', () => {
    for (const reg of REGISTRIES) {
      expect(mjs.validateRegistry(reg)).toEqual(tsValidate(reg));
    }
  });

  it('deriveClassData agrees on every declaration set', () => {
    for (const decls of DECLARATION_SETS) {
      expect(mapToObj(mjs.deriveClassData(decls))).toEqual(mapToObj(tsDerive(decls)));
    }
  });

  it('computeEscalation agrees on every case (incl. reason strings)', () => {
    for (const [entry, derived, thresholds] of ESCALATION_CASES) {
      const d = fullDerived(derived);
      expect(mjs.computeEscalation(entry, d, thresholds)).toEqual(tsEscalate(entry, d, thresholds));
    }
  });
});
