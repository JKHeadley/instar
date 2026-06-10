/**
 * Tier 1 (unit) tests for StandardEnforcementExtractor (cartographer-conformance-audit
 * spec #3, Part A). Pure extraction: a fixture article naming a test file + a route +
 * a CONSTANT_CASE marker + a PascalCase class yields exactly those refs; bare prose
 * with no enforcement shape yields none; a `#123` PR ref is provenance, not a guard.
 */
import { describe, it, expect } from 'vitest';
import {
  extractEnforcementRefs,
  flattenRefs,
  hasAnyRef,
} from '../../src/core/StandardEnforcementExtractor.js';
import type { StandardArticle } from '../../src/core/StandardsRegistryParser.js';

function article(over: Partial<StandardArticle>): StandardArticle {
  return { family: 'Building', name: 'X', rule: 'r', inPractice: '', ...over };
}

describe('StandardEnforcementExtractor', () => {
  it('pulls file, route, marker, and class refs from prose', () => {
    const a = article({
      inPractice: 'A forward ratchet (`tests/unit/no-silent-llm-fallback.test.ts`) fails CI.',
      appliedThrough:
        'Enforced by `B16_UNVERIFIED_WALL` in `MessagingToneGate`; the route `POST /spec/conformance-check`; lint `scripts/lint-foo.js`.',
    });
    const refs = extractEnforcementRefs(a);
    expect(refs.files).toContain('tests/unit/no-silent-llm-fallback.test.ts');
    expect(refs.files).toContain('scripts/lint-foo.js');
    expect(refs.routes).toContain('POST /spec/conformance-check');
    expect(refs.markers).toContain('B16_UNVERIFIED_WALL');
    expect(refs.markers).toContain('MessagingToneGate');
  });

  it('returns zero refs for bare prose with no enforcement shape', () => {
    const a = article({ inPractice: 'Deferral feels harmless because it still remembers; the cost lands on a successor.' });
    const refs = extractEnforcementRefs(a);
    expect(refs.files).toEqual([]);
    expect(refs.routes).toEqual([]);
    expect(refs.markers).toEqual([]);
    expect(hasAnyRef(refs)).toBe(false);
  });

  it('does NOT treat a #123 PR/issue ref as an enforcement reference', () => {
    const a = article({ appliedThrough: 'The operator-identity binding (PR #897). Incident: CMT-1125.' });
    const refs = extractEnforcementRefs(a);
    expect(refs.files).toEqual([]);
    expect(refs.routes).toEqual([]);
    // #897 / CMT-1125 are NOT CONSTANT_CASE-with-underscore markers nor backticked classes.
    expect(refs.markers).toEqual([]);
  });

  it('only counts file paths under known enforcement prefixes (not arbitrary .md mentions)', () => {
    const a = article({
      inPractice: 'See `README.md` and `random.json`, but the guard is `src/core/PrincipalGuard.ts`.',
    });
    const refs = extractEnforcementRefs(a);
    expect(refs.files).toEqual(['src/core/PrincipalGuard.ts']); // README.md / random.json excluded (no enforcement prefix)
  });

  it('resolves a `.member` symbol to its base class name', () => {
    const a = article({ inPractice: 'Route gating LLM calls through `IntelligenceRouter.failureSwap`.' });
    const refs = extractEnforcementRefs(a);
    expect(refs.markers).toContain('IntelligenceRouter');
  });

  it('is deterministic and sorted (same input → byte-identical refs)', () => {
    const a = article({
      appliedThrough: 'Guards: `scripts/b.js`, `scripts/a.js`, `ZZZ_MARKER`, `AAA_MARKER`.',
    });
    const r1 = extractEnforcementRefs(a);
    const r2 = extractEnforcementRefs(a);
    expect(r1).toEqual(r2);
    expect(r1.files).toEqual(['scripts/a.js', 'scripts/b.js']); // sorted
    expect(r1.markers).toEqual(['AAA_MARKER', 'ZZZ_MARKER']);   // sorted
  });

  it('a too-short marker (one char before the underscore) is NOT swept up', () => {
    // The marker regex requires >=3 chars before the first underscore (e.g. B16_) so
    // it can't false-match prose like "X_Y". A 1-char prefix must NOT match.
    const a = article({ appliedThrough: 'Mentions `A_B` and the real `B16_UNVERIFIED_WALL`.' });
    const refs = extractEnforcementRefs(a);
    expect(refs.markers).toContain('B16_UNVERIFIED_WALL');
    expect(refs.markers).not.toContain('A_B');
  });

  it('flattenRefs produces a typed guard list', () => {
    const a = article({ appliedThrough: 'Guard `tests/unit/x.test.ts`, route `GET /y`, marker `ZZZ_MARK`.' });
    const flat = flattenRefs(extractEnforcementRefs(a));
    expect(flat).toEqual(
      expect.arrayContaining([
        { ref: 'tests/unit/x.test.ts', kind: 'file' },
        { ref: 'GET /y', kind: 'route' },
        { ref: 'ZZZ_MARK', kind: 'marker' },
      ]),
    );
  });
});
