/**
 * ScopeAccretionCorroboration — Tier 1 (spec: autonomous-scope-accretion-
 * completion.md §2.5 R21/R32/R33/R34).
 *
 * Covers BOTH sides of every clearing boundary: the exact merged-PR predicate
 * (own file never corroborates itself; docs-only PR never corroborates a spec;
 * ≥10 non-docs changed lines floor); the spec report+ceremony arm (report file
 * alone is NOT enough — the server-recorded conformance invocation must fall in
 * the run window); the local-git positive-only shortcut; the negative-TTL skip;
 * gh failure → degraded (fail toward keep-working, never a false clear).
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  mergedPrSatisfiesPredicate,
  resolveCorroboration,
  specSlugFromPath,
  type CorroborationDeps,
  type MergedPr,
} from '../../src/core/ScopeAccretionCorroboration.js';
import type { AccretedArtifact } from '../../src/core/ScopeAccretionSweep.js';

const SPEC = 'docs/specs/my-feature.md';

function art(p: string, root = '/repo'): AccretedArtifact {
  return { path: p, root, cls: 'deliverable', deleted: false, committed: true };
}

function deps(overrides: Partial<CorroborationDeps> = {}): CorroborationDeps {
  return {
    runGh: () => '[]',
    readGit: () => '',
    fsExists: () => false,
    conformanceInvocationsInWindow: () => 0,
    ...overrides,
  };
}

function input(artifacts: AccretedArtifact[], overrides: Record<string, unknown> = {}) {
  return {
    artifacts,
    alreadyCorroborated: {},
    negativeCached: new Set<string>(),
    startedAt: '2026-07-01T00:00:00Z',
    workDir: '/repo',
    artifactStartShas: { [path.resolve('/repo')]: 'aaaa111' },
    ...overrides,
  } as Parameters<typeof resolveCorroboration>[0];
}

describe('mergedPrSatisfiesPredicate (R33 — defined exactly)', () => {
  const prWith = (files: Array<[string, number]>): MergedPr => ({
    number: 42,
    files: files.map(([p, lines]) => ({ path: p, additions: lines, deletions: 0 })),
  });

  it('clears: artifact path + ≥1 non-docs path with ≥10 combined changed lines', () => {
    expect(mergedPrSatisfiesPredicate(prWith([[SPEC, 300], ['src/core/Feature.ts', 12]]), SPEC, false)).toBe(true);
  });
  it("an artifact's own file NEVER corroborates itself", () => {
    expect(mergedPrSatisfiesPredicate(prWith([[SPEC, 500]]), SPEC, false)).toBe(false);
  });
  it('a docs-only PR NEVER corroborates a spec', () => {
    expect(mergedPrSatisfiesPredicate(prWith([[SPEC, 300], ['docs/audits/other.md', 200]]), SPEC, false)).toBe(false);
  });
  it('a trivial non-docs edit under the 10-line floor does not clear', () => {
    expect(mergedPrSatisfiesPredicate(prWith([[SPEC, 300], ['src/x.ts', 4]]), SPEC, false)).toBe(false);
  });
  it('a PR not containing the artifact never clears, however big', () => {
    expect(mergedPrSatisfiesPredicate(prWith([['src/x.ts', 900]]), SPEC, false)).toBe(false);
  });
  it('own-file rule RELAXED for a doc whose deliverable IS the doc (audit/runbook/incident/script)', () => {
    expect(mergedPrSatisfiesPredicate(prWith([['docs/audits/mesh-audit.md', 40]]), 'docs/audits/mesh-audit.md', true)).toBe(true);
  });
});

describe('the spec report+ceremony arm (R32)', () => {
  it('report file + an IN-WINDOW server-recorded conformance invocation → cleared', () => {
    const res = resolveCorroboration(
      input([art(SPEC)]),
      deps({
        fsExists: (p) => p.endsWith('docs/specs/reports/my-feature-convergence.md'),
        conformanceInvocationsInWindow: (slug) => (slug === 'my-feature' ? 2 : 0),
      }),
    );
    expect(res.cleared[SPEC]).toMatchObject({ by: 'ceremony-report' });
  });

  it('a forged report WITHOUT a server ceremony record does NOT clear (falls to gh, stays negative)', () => {
    const res = resolveCorroboration(
      input([art(SPEC)]),
      deps({
        fsExists: (p) => p.endsWith('-convergence.md'),
        conformanceInvocationsInWindow: () => 0,
      }),
    );
    expect(res.cleared[SPEC]).toBeUndefined();
    expect(res.newNegatives).toContain(SPEC);
  });

  it('specSlugFromPath derives the slug from the basename', () => {
    expect(specSlugFromPath('docs/specs/my-feature.md')).toBe('my-feature');
  });
});

describe('the local-git positive-only shortcut (R34)', () => {
  it('a path verifiably landed on origin/main → cleared without gh', () => {
    let ghCalled = false;
    const res = resolveCorroboration(
      input([art(SPEC)]),
      deps({
        readGit: (args) => (args.join(' ').includes('..origin/main') ? 'abc123 landed it\n' : ''),
        runGh: () => {
          ghCalled = true;
          return '[]';
        },
      }),
    );
    expect(res.cleared[SPEC]).toMatchObject({ by: 'local-git-origin-main' });
    expect(ghCalled).toBe(false);
  });

  it('local-git ABSENCE never refuses — it falls through to the gh authority', () => {
    const merged: MergedPr[] = [{ number: 7, files: [{ path: SPEC, additions: 10, deletions: 0 }, { path: 'src/f.ts', additions: 30, deletions: 2 }] }];
    const res = resolveCorroboration(
      input([art(SPEC)]),
      deps({
        readGit: () => '',
        runGh: () => JSON.stringify(merged.map((m) => ({ number: m.number, files: m.files }))),
      }),
    );
    expect(res.cleared[SPEC]).toMatchObject({ by: 'merged-pr', detail: '#7' });
  });

  it('a local-git ERROR falls through silently (positive-only, never used to refuse)', () => {
    const res = resolveCorroboration(
      input([art(SPEC)]),
      deps({
        readGit: () => {
          throw new Error('no origin/main here');
        },
        runGh: () => '[]',
      }),
    );
    expect(res.cleared[SPEC]).toBeUndefined();
  });
});

describe('cost discipline (R22)', () => {
  it('a fresh negative-TTL entry skips the external query entirely', () => {
    let ghCalled = 0;
    const res = resolveCorroboration(
      input([art(SPEC)], { negativeCached: new Set([SPEC]) }),
      deps({
        runGh: () => {
          ghCalled++;
          return '[]';
        },
      }),
    );
    expect(ghCalled).toBe(0);
    expect(res.cleared[SPEC]).toBeUndefined();
    expect(res.newNegatives).toHaveLength(0); // no re-stamp while the TTL holds
  });

  it('gh runs ONCE (batched) per evaluation across many artifacts', () => {
    let ghCalled = 0;
    resolveCorroboration(
      input([art('docs/specs/a.md'), art('docs/specs/b.md'), art('docs/specs/c.md')]),
      deps({
        runGh: () => {
          ghCalled++;
          return '[]';
        },
      }),
    );
    expect(ghCalled).toBe(1);
  });

  it('a gh failure leaves artifacts uncorroborated + degraded:true and stamps NO negatives (fail toward keep-working)', () => {
    const res = resolveCorroboration(
      input([art(SPEC)]),
      deps({
        runGh: () => {
          throw new Error('network down');
        },
      }),
    );
    expect(res.degraded).toBe(true);
    expect(res.cleared[SPEC]).toBeUndefined();
    expect(res.newNegatives).toHaveLength(0);
  });

  it('already-corroborated artifacts are skipped entirely (monotone)', () => {
    let ghCalled = 0;
    const res = resolveCorroboration(
      input([art(SPEC)], { alreadyCorroborated: { [SPEC]: { by: 'merged-pr' } } }),
      deps({
        runGh: () => {
          ghCalled++;
          return '[]';
        },
      }),
    );
    expect(ghCalled).toBe(0);
    expect(res.newNegatives).toHaveLength(0);
    expect(Object.keys(res.cleared)).toHaveLength(0);
  });
});
