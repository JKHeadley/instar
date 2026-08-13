/**
 * Tier 1 (unit) — the six field headings introduced by the operator's 2026-08-12 rulings on the
 * Window-12 decision package must be DELIBERATELY CLASSIFIED, and classified as NOT enforcement.
 *
 * Why this test exists rather than a comment. The parser keeps closed lists of which bold field
 * headings mean what, and an unclassified heading is silently excluded from enforcement extraction.
 * The load-bearing property is the direction of the classification:
 *
 *   - `Fails` states what happens when an article's machinery is ABSENT.
 *   - `Judgment-bound` states that NO mechanical check exists for the article at all.
 *
 * If either were classified as ENFORCEMENT, an article's account of its own missing guard would be
 * scanned as evidence that a guard exists — an article grading itself "enforced" by describing its
 * own hole. That is the exact over-claim ruling 3 was raised against, inverted. The four provenance
 * headings carry the same risk in the milder form: an origin story is not a live check.
 *
 * The regression this guards is real and already happened once during the change that added these:
 * the headings were classified in the parser and NOT in `scripts/standards-coverage.mjs`, which
 * keeps a hand-copied mirror of the same lists — 62 sections went unrecognized against a zero
 * ceiling. The mirror check below is what makes that failure loud in a unit test rather than only at
 * CI time.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseStandardsRegistryDetailed,
  EXCLUDED_PROVENANCE_SECTION_HEADINGS,
  EXCLUDED_NARRATIVE_SECTION_HEADINGS,
  ENFORCEMENT_SECTION_HEADINGS,
} from '../../src/core/StandardsRegistryParser.js';

/** The four provenance labels rulings 4b/4c split out of `Earned from`. */
const NEW_PROVENANCE = [
  'Grounded in',
  'Provenance status',
  'Articulated during',
  'Ratified from operator policy',
] as const;

/** The two narrative labels from item 2 and ruling 3. */
const NEW_NARRATIVE = ['Fails', 'Judgment-bound'] as const;

describe('Window-14 field classification — the rulings\' new headings', () => {
  it('classifies the four new provenance headings as PROVENANCE', () => {
    for (const heading of NEW_PROVENANCE) {
      expect(EXCLUDED_PROVENANCE_SECTION_HEADINGS as readonly string[]).toContain(heading);
    }
  });

  it('classifies Fails and Judgment-bound as NARRATIVE', () => {
    for (const heading of NEW_NARRATIVE) {
      expect(EXCLUDED_NARRATIVE_SECTION_HEADINGS as readonly string[]).toContain(heading);
    }
  });

  it('classifies NONE of the six as enforcement — the load-bearing direction', () => {
    for (const heading of [...NEW_PROVENANCE, ...NEW_NARRATIVE]) {
      expect(ENFORCEMENT_SECTION_HEADINGS as readonly string[]).not.toContain(heading);
    }
  });

  it('does not scan a Fails or Judgment-bound line for enforcement refs', () => {
    // Both lines below name a real-looking guard path. If either heading were filed as
    // enforcement, the article would acquire an enforcement citation from its own admission
    // that it is unguarded.
    const md = [
      '## Building',
      '',
      '### Unguarded Standard',
      '**Rule.** Something that matters.',
      '**Fails.** If `src/core/SomeGate.ts` is absent, fail closed.',
      '**Judgment-bound.** No check exists; see `tests/unit/not-a-real-guard.test.ts`.',
      '',
    ].join('\n');
    const parsed = parseStandardsRegistryDetailed(md);
    const [article] = parsed.articles;
    expect(article.name).toBe('Unguarded Standard');
    expect(article.rule).toBe('Something that matters.');
    // The article parses, and neither line becomes an enforcement section.
    const enforcementHeadings = (article.enforcementSections ?? []).map((s) => s.heading);
    expect(enforcementHeadings).not.toContain('Fails');
    expect(enforcementHeadings).not.toContain('Judgment-bound');
    expect(article.appliedThrough).toBeUndefined();
  });

  it('leaves the real registry with zero unrecognized article sections', () => {
    const registry = fs.readFileSync(
      path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md'),
      'utf-8',
    );
    const parsed = parseStandardsRegistryDetailed(registry);
    expect(parsed.diagnostics?.enforcementScope.unrecognizedSections ?? []).toEqual([]);
  });

  it('keeps the coverage ratchet\'s mirrored lists in step with the parser', () => {
    // scripts/standards-coverage.mjs runs pre-compile and cannot import the TypeScript parser, so
    // it carries its own copy of these lists. Updating one and not the other is how this change
    // first failed CI. This assertion makes that divergence a unit-test failure.
    const ratchet = fs.readFileSync(
      path.join(process.cwd(), 'scripts/standards-coverage.mjs'),
      'utf-8',
    );
    for (const heading of [...NEW_PROVENANCE, ...NEW_NARRATIVE]) {
      expect(
        ratchet.includes(`'${heading}'`),
        `scripts/standards-coverage.mjs does not classify '${heading}' — the parser does, so the ` +
          `ratchet will count it as an unrecognized section against a zero ceiling`,
      ).toBe(true);
    }
  });
});
