/**
 * Unit (Tier 1) — DefectClassRegistry pure logic (docs/specs/class-closure-gate.md).
 *
 * Covers the three decision surfaces of the class registry, BOTH sides of every
 * boundary:
 *   - validateRegistry: accept the seeded registry; reject missing severity, an
 *     unconfirmed class with no nearestExistingClass, a duplicate id, a bad id charset.
 *   - deriveClassData: dedup by PR (two decls same PR → count 1), per-component max,
 *     hasOpenGap.
 *   - computeEscalation: every arm (critical-1, spread, gap-plus, single-component),
 *     seeded-closed suppression (no new evidence), and the newEvidence gate.
 *   - gapOpenPastMaxAge: below vs past the ceiling.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateRegistry,
  deriveClassData,
  computeEscalation,
  gapOpenPastMaxAge,
  type DecisionDeclaration,
  type DefectClassEntry,
  type DerivedClassData,
} from '../../src/core/DefectClassRegistry.js';

function validClass(overrides: Partial<DefectClassEntry> = {}): DefectClassEntry {
  return {
    id: 'fixture-class',
    description: 'a fixture class',
    includes: ['x'],
    excludes: ['y'],
    canonicalExamples: [],
    status: 'confirmed',
    severity: 'normal',
    closureStandard: null,
    closureStandardEnforcement: null,
    instanceCount: 0,
    escalatedAt: null,
    evidenceCountAtLastAck: 0,
    proposalId: null,
    ...overrides,
  };
}

function decl(overrides: Partial<DecisionDeclaration>): DecisionDeclaration {
  return {
    defectClass: 'x',
    closure: 'guard',
    source: 'entry.json',
    ...overrides,
  };
}

describe('validateRegistry', () => {
  it('accepts the seeded on-disk registry (docs/defect-classes.json)', () => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'docs', 'defect-classes.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    const v = validateRegistry(parsed);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('rejects a class missing severity', () => {
    const bad = { version: 1, classes: [validClass()] } as Record<string, unknown>;
    delete (bad.classes as DefectClassEntry[])[0].severity;
    const v = validateRegistry(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('severity invalid');
  });

  it('rejects an unconfirmed class with no nearestExistingClass', () => {
    const v = validateRegistry({ version: 1, classes: [validClass({ status: 'unconfirmed' })] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('unconfirmed but has no nearestExistingClass');
  });

  it('accepts an unconfirmed class WHEN it carries nearestExistingClass', () => {
    const v = validateRegistry({
      version: 1,
      classes: [validClass({ status: 'unconfirmed', nearestExistingClass: 'fixture-class' })],
    });
    expect(v.ok).toBe(true);
  });

  it('rejects a duplicate class id', () => {
    const v = validateRegistry({ version: 1, classes: [validClass(), validClass()] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('duplicate');
  });

  it('rejects a bad id charset', () => {
    const v = validateRegistry({ version: 1, classes: [validClass({ id: 'Bad_Id!' })] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('must match');
  });
});

describe('deriveClassData', () => {
  it('dedups by PR number — two decls citing the same PR count ONCE', () => {
    const d = deriveClassData([
      decl({ prNumber: 5, component: 'A', source: 'a.json' }),
      decl({ prNumber: 5, component: 'A', source: 'b.json' }),
    ]);
    expect(d.get('x')!.dedupedCount).toBe(1);
    expect(d.get('x')!.prs).toEqual([5]);
  });

  it('computes per-component max + component count', () => {
    const d = deriveClassData([
      decl({ prNumber: 1, component: 'A', source: 'a.json' }),
      decl({ prNumber: 2, component: 'A', source: 'b.json' }),
      decl({ prNumber: 3, component: 'B', source: 'c.json' }),
    ]);
    const x = d.get('x')!;
    expect(x.dedupedCount).toBe(3);
    expect(x.componentCount).toBe(2);
    expect(x.maxSingleComponentCount).toBe(2); // A has 2 distinct PRs
    expect(x.components).toEqual(['A', 'B']);
  });

  it('falls back to source filename as the dedup key when prNumber is absent', () => {
    const d = deriveClassData([
      decl({ component: 'A', source: 'a.json' }),
      decl({ component: 'A', source: 'b.json' }),
    ]);
    expect(d.get('x')!.dedupedCount).toBe(2); // distinct sources → 2
  });

  it('flags hasOpenGap when any declaration is a gap', () => {
    const withGap = deriveClassData([decl({ prNumber: 1, closure: 'gap' })]);
    expect(withGap.get('x')!.hasOpenGap).toBe(true);
    const withoutGap = deriveClassData([decl({ prNumber: 1, closure: 'guard' })]);
    expect(withoutGap.get('x')!.hasOpenGap).toBe(false);
  });
});

describe('computeEscalation', () => {
  const D = (o: Partial<DerivedClassData>): DerivedClassData => ({
    dedupedCount: 0,
    componentCount: 0,
    maxSingleComponentCount: 0,
    hasOpenGap: false,
    prs: [],
    components: [],
    ...o,
  });

  it('critical class escalates at 1 new instance', () => {
    const v = computeEscalation(
      { severity: 'critical', evidenceCountAtLastAck: 0 },
      D({ dedupedCount: 1, componentCount: 1, maxSingleComponentCount: 1 }),
    );
    expect(v.shouldEscalate).toBe(true);
    expect(v.arm).toBe('critical-1');
  });

  it('normal class escalates on ≥3 across ≥2 components (spread)', () => {
    const v = computeEscalation(
      { severity: 'normal', evidenceCountAtLastAck: 0 },
      D({ dedupedCount: 3, componentCount: 2, maxSingleComponentCount: 2 }),
    );
    expect(v.shouldEscalate).toBe(true);
    expect(v.arm).toBe('spread');
  });

  it('normal class escalates on ≥2 + an open gap (gap-plus)', () => {
    const v = computeEscalation(
      { severity: 'normal', evidenceCountAtLastAck: 0 },
      D({ dedupedCount: 2, componentCount: 1, maxSingleComponentCount: 2, hasOpenGap: true }),
    );
    expect(v.shouldEscalate).toBe(true);
    expect(v.arm).toBe('gap-plus');
  });

  it('normal class escalates on ≥5 within one component (single-component)', () => {
    const v = computeEscalation(
      { severity: 'normal', evidenceCountAtLastAck: 0 },
      D({ dedupedCount: 5, componentCount: 1, maxSingleComponentCount: 5 }),
    );
    expect(v.shouldEscalate).toBe(true);
    expect(v.arm).toBe('single-component');
  });

  it('normal class does NOT escalate when no arm crosses (below every threshold)', () => {
    const v = computeEscalation(
      { severity: 'normal', evidenceCountAtLastAck: 0 },
      D({ dedupedCount: 2, componentCount: 2, maxSingleComponentCount: 1 }),
    );
    expect(v.shouldEscalate).toBe(false);
    expect(v.arm).toBeNull();
    expect(v.newEvidence).toBe(true); // there IS new evidence, just no arm crossed
  });

  it('seeded-closed suppression: no escalation when derived ≤ ack baseline', () => {
    const v = computeEscalation(
      { severity: 'normal', evidenceCountAtLastAck: 3 },
      D({ dedupedCount: 3, componentCount: 2, maxSingleComponentCount: 2 }),
    );
    expect(v.shouldEscalate).toBe(false);
    expect(v.newEvidence).toBe(false);
  });

  it('a seeded CRITICAL class does not re-fire on backfilled evidence (ack gate)', () => {
    const suppressed = computeEscalation(
      { severity: 'critical', evidenceCountAtLastAck: 2 },
      D({ dedupedCount: 2, componentCount: 1, maxSingleComponentCount: 2 }),
    );
    expect(suppressed.shouldEscalate).toBe(false);
    const reraise = computeEscalation(
      { severity: 'critical', evidenceCountAtLastAck: 2 },
      D({ dedupedCount: 3, componentCount: 1, maxSingleComponentCount: 3 }),
    );
    expect(reraise.shouldEscalate).toBe(true);
    expect(reraise.arm).toBe('critical-1');
  });

  it('respects tunable thresholds (spreadN / singleK)', () => {
    const v = computeEscalation(
      { severity: 'normal', evidenceCountAtLastAck: 0 },
      D({ dedupedCount: 2, componentCount: 2, maxSingleComponentCount: 1 }),
      { spreadN: 2 },
    );
    expect(v.shouldEscalate).toBe(true);
    expect(v.arm).toBe('spread');
  });
});

describe('gapOpenPastMaxAge', () => {
  const now = Date.parse('2026-07-03T00:00:00Z');
  it('is false for a gap opened within the ceiling', () => {
    expect(gapOpenPastMaxAge('2026-06-20T00:00:00Z', now, 45)).toBe(false);
  });
  it('is true for a gap opened past the ceiling', () => {
    expect(gapOpenPastMaxAge('2026-05-01T00:00:00Z', now, 45)).toBe(true);
  });
  it('is false (never throws) on an unparseable date', () => {
    expect(gapOpenPastMaxAge('not-a-date', now, 45)).toBe(false);
  });
});
