/**
 * Tier 1 (unit) test for the additive `appliedThrough` parser field
 * (cartographer-conformance-audit spec #3, Part A). Asserts the parser captures the
 * `**Applied through.**` line on articles that have one, leaves it undefined on
 * articles that don't, keeps the existing Rule/In-practice extraction intact, and
 * that the existing canary stays green over the real registry.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  parseStandardsRegistry,
  parseStandardsRegistryDetailed,
  loadStandardsRegistry,
  runRegistryCanary,
} from '../../src/core/StandardsRegistryParser.js';
import { extractEnforcementRefs } from '../../src/core/StandardEnforcementExtractor.js';

const REGISTRY_PATH = path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md');

describe('StandardsRegistryParser — appliedThrough field (spec #3)', () => {
  it('captures the **Applied through.** line when present', () => {
    const md = [
      '## Building',
      '',
      '### Guarded Standard',
      '**Rule.** Always guard.',
      '**In practice.** A gate holds it.',
      '**Applied through.** Enforced by `tests/unit/x.test.ts` and `B16_MARKER`.',
      '',
    ].join('\n');
    const [a] = parseStandardsRegistry(md);
    expect(a.name).toBe('Guarded Standard');
    expect(a.rule).toBe('Always guard.');
    expect(a.inPractice).toBe('A gate holds it.');
    expect(a.appliedThrough).toBe('Enforced by `tests/unit/x.test.ts` and `B16_MARKER`.');
  });

  it('leaves appliedThrough undefined when the line is absent', () => {
    const md = [
      '## Building',
      '',
      '### Bare Standard',
      '**Rule.** Just a rule.',
      '',
    ].join('\n');
    const [a] = parseStandardsRegistry(md);
    expect(a.name).toBe('Bare Standard');
    expect(a.rule).toBe('Just a rule.');
    expect(a.appliedThrough).toBeUndefined();
  });

  it('captures allowlisted enforcement BLOCKS without importing provenance or unknown sections', () => {
    const md = [
      '## Building',
      '',
      '### Framework Floor',
      '**Rule.** Work everywhere.',
      '**In practice.** The rule has a continuation:',
      '- runtime paths stay portable.',
      '**Enforced by (structure, not willpower).** Three layers:',
      '- compiler `src/core/frameworkSessionLaunch.ts`.',
      '- ratchet `tests/unit/framework-agnosticism.test.ts`.',
      '**Earned from.** Incident `docs/postmortems/not-a-guard.md`.',
      '**Mystery evidence.** `tests/unit/must-not-be-imported.test.ts`.',
      '',
    ].join('\n');

    const { articles, diagnostics } = parseStandardsRegistryDetailed(md);
    const [article] = articles;
    expect(article.inPractice).toContain('runtime paths stay portable');
    expect(article.enforcementSections).toEqual([{
      heading: 'Enforced by (structure, not willpower)',
      text: expect.stringContaining('tests/unit/framework-agnosticism.test.ts'),
    }]);

    const refs = extractEnforcementRefs(article);
    expect(refs.files).toEqual([
      'src/core/frameworkSessionLaunch.ts',
      'tests/unit/framework-agnosticism.test.ts',
    ]);
    expect(refs.files).not.toContain('docs/postmortems/not-a-guard.md');
    expect(refs.files).not.toContain('tests/unit/must-not-be-imported.test.ts');

    expect(diagnostics.enforcementScope.recognizedHeadings).toContain('Enforced by (structure, not willpower)');
    expect(diagnostics.enforcementScope.excludedProvenanceHeadings).toContain('Earned from');
    expect(diagnostics.enforcementScope.capturedSections).toBe(1);
    expect(diagnostics.enforcementScope.unrecognizedSections).toEqual([
      'Building › Framework Floor › Mystery evidence',
    ]);
  });

  it('captures singular and plural Full spec aliases as spec-only enforcement inputs', () => {
    const md = [
      '## Building',
      '### Singular',
      '**Rule.** r.',
      '**Full spec.** `docs/specs/singular.md`.',
      '### Plural',
      '**Rule.** r.',
      '**Full specs.** `docs/specs/a.md`, `docs/specs/b.md`.',
    ].join('\n');
    const articles = parseStandardsRegistry(md);

    expect(extractEnforcementRefs(articles[0]).files).toEqual(['docs/specs/singular.md']);
    expect(extractEnforcementRefs(articles[1]).files).toEqual(['docs/specs/a.md', 'docs/specs/b.md']);
  });

  it('the real registry has SOME articles carrying an appliedThrough line', () => {
    const articles = loadStandardsRegistry(REGISTRY_PATH);
    const withApplied = articles.filter((a) => typeof a.appliedThrough === 'string' && a.appliedThrough.length > 0);
    // The constitution declares enforcement on many articles — at least several.
    expect(withApplied.length).toBeGreaterThanOrEqual(5);
  });

  it('the existing canary stays green over the real registry (field is additive, non-breaking)', () => {
    const canary = runRegistryCanary(loadStandardsRegistry(REGISTRY_PATH));
    expect(canary.ok).toBe(true);
    expect(canary.failures).toEqual([]);
  });
});
