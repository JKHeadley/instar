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
  loadStandardsRegistry,
  runRegistryCanary,
} from '../../src/core/StandardsRegistryParser.js';

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
