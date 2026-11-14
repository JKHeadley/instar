/**
 * A setup session stops and asks the person before accepting a provider's terms
 * (docs/specs/recommended-services.md, The agent owns setup).
 *
 * A live run on 2026-11-04 ticked TypeSafe's agreement, which includes binding arbitration,
 * and told no one: the shared rules covered charges and grants, not agreements.
 */
import { describe, expect, it } from 'vitest';
import { RULES, SETUP_RECIPES } from '../../src/recommended/recipes.js';

const AGREEMENT_RULE = /Their yes to this service is not a yes to the provider's terms\. Before you tick, click or sign anything that accepts terms of service, an agreement or a contract, stop and ask them/;

describe('a provider agreement waits for the person', () => {
  it('there is at least one recipe to check', () => {
    expect(SETUP_RECIPES.length).toBeGreaterThan(0);
  });

  it('every recipe stops and asks before accepting terms, saying what stands out', () => {
    for (const recipe of SETUP_RECIPES) {
      const brief = recipe.brief({ port: 1 });
      expect(brief, recipe.id).toMatch(AGREEMENT_RULE);
      expect(brief, recipe.id).toContain('binding arbitration');
      expect(brief, recipe.id).toContain('auto-renewal');
      expect(brief, recipe.id).toContain('ask for a yes or no');
      expect(brief, recipe.id).toContain('Only their yes in this conversation lets you accept');
      // A "not now" uses the existing hold, not a new path.
      expect(brief, recipe.id).toContain('If they say not now, hold as below');
      expect(brief, recipe.id).toContain(`/recommended-services/${recipe.service}/hold`);
    }
  });

  it('lives in the shared rules once, so a new recipe gets it without copying', () => {
    expect(RULES('any-service', 1)).toMatch(AGREEMENT_RULE);
    for (const recipe of SETUP_RECIPES) {
      const hits = recipe.brief({ port: 1 }).match(new RegExp(AGREEMENT_RULE.source, 'g')) ?? [];
      expect(hits, recipe.id).toHaveLength(1);
    }
  });

  it('does not turn a cookie banner into a question, or hand the person the reading', () => {
    for (const recipe of SETUP_RECIPES) {
      const brief = recipe.brief({ port: 1 });
      expect(brief, recipe.id).toContain('A banner that only sets cookie preferences is not an agreement');
      expect(brief, recipe.id).not.toMatch(/ask (the person|them) to (read|review|open) (the )?(terms|agreement|contract)/i);
    }
  });
});
