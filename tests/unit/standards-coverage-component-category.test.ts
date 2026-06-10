/**
 * Tier 1 (unit) wiring test — the StandardsCoverageEnrichment component is registered
 * under category 'job' (cartographer-conformance-audit spec #3). The dark LLM-enrichment
 * path routes by category; a missing entry would silently fall back to the default
 * framework (spending Anthropic quota) instead of the operator-chosen off-Claude one.
 * A registry entry + this assertion is the structural guard (Structure > Willpower).
 */
import { describe, it, expect } from 'vitest';
import { categoryForComponent, knownComponents } from '../../src/core/componentCategories.js';

describe('componentCategories — StandardsCoverageEnrichment wiring (spec #3)', () => {
  it('StandardsCoverageEnrichment resolves to category "job"', () => {
    expect(categoryForComponent('StandardsCoverageEnrichment')).toBe('job');
  });

  it('is present in the known-components registry', () => {
    expect(knownComponents()).toContain('StandardsCoverageEnrichment');
  });

  it('a call-site "/segment" suffix still resolves to job', () => {
    expect(categoryForComponent('StandardsCoverageEnrichment/D')).toBe('job');
  });
});
