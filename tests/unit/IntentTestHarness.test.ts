/**
 * Unit tests for IntentTestHarness — the EXO 3.0 refusal + endorsement tests.
 * Covers both sides of every boundary: refused vs allowed, endorsed vs
 * not-endorsed (incl. the "silence is not endorsement" default), and the
 * canGovern() cheering-vs-governing check.
 */

import { describe, it, expect } from 'vitest';
import { IntentTestHarness } from '../../src/core/IntentTestHarness.js';
import type { ParsedOrgIntent } from '../../src/core/OrgIntentManager.js';

function intent(overrides: Partial<ParsedOrgIntent> = {}): ParsedOrgIntent {
  return {
    name: 'Test Org',
    constraints: [
      { text: 'Never wire funds to an unverified vendor', source: 'org-intent' },
      { text: 'Do not share customer data with third parties', source: 'org-intent' },
    ],
    goals: [
      { text: 'Grow customer trust', source: 'org-intent', specializable: true },
      { text: 'Ship reliable software quickly', source: 'org-intent', specializable: true },
    ],
    values: ['transparency', 'humane treatment of users'],
    tradeoffHierarchy: ['customer trust', 'speed'],
    raw: '',
    ...overrides,
  };
}

describe('IntentTestHarness.testRefusal', () => {
  it('refuses an action that matches a constraint', () => {
    const h = new IntentTestHarness(intent());
    const r = h.testRefusal('wire funds to an unverified vendor');
    expect(r.refused).toBe(true);
    expect(r.matchedConstraint).toMatch(/unverified vendor/);
  });

  it('refuses a paraphrase of a constraint (content-word overlap)', () => {
    const h = new IntentTestHarness(intent());
    const r = h.testRefusal('share customer data with third parties for ads');
    expect(r.refused).toBe(true);
    expect(r.matchedConstraint).toMatch(/customer data/);
  });

  it('does NOT refuse an action unrelated to any constraint', () => {
    const h = new IntentTestHarness(intent());
    const r = h.testRefusal('refactor the billing module for clarity');
    expect(r.refused).toBe(false);
  });
});

describe('IntentTestHarness.testEndorsement', () => {
  it('does not endorse a refused action', () => {
    const h = new IntentTestHarness(intent());
    const r = h.testEndorsement('wire funds to an unverified vendor');
    expect(r.endorsed).toBe(false);
    expect(r.reason).toMatch(/constraint/);
  });

  it('endorses an action that aligns with a goal and breaks no constraint', () => {
    const h = new IntentTestHarness(intent());
    const r = h.testEndorsement('ship reliable software for the release');
    expect(r.endorsed).toBe(true);
    expect(r.alignedWith).toMatch(/reliable software/);
  });

  it('endorses an action that aligns with a value', () => {
    const h = new IntentTestHarness(intent());
    const r = h.testEndorsement('improve transparency in our reporting');
    expect(r.endorsed).toBe(true);
    expect(r.alignedWith).toMatch(/transparency/);
  });

  it('does NOT endorse an action unrelated to every goal/value (silence is not endorsement)', () => {
    const h = new IntentTestHarness(intent());
    const r = h.testEndorsement('paint the office walls blue');
    expect(r.endorsed).toBe(false);
    expect(r.reason).toMatch(/aligns with no stated goal or value/);
  });
});

describe('IntentTestHarness.canGovern', () => {
  it('can govern when at least one constraint exists', () => {
    expect(new IntentTestHarness(intent()).canGovern()).toBe(true);
  });

  it('cannot govern (cheering, not governing) with zero constraints', () => {
    expect(new IntentTestHarness(intent({ constraints: [] })).canGovern()).toBe(false);
  });
});
