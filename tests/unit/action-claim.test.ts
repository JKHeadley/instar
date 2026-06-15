/**
 * action-claim classifier (FD2 high-precision + FD4 tense rule). Both sides of the
 * decision boundary with realistic inputs.
 */
import { describe, it, expect } from 'vitest';
import { classifyActionClaim } from '../../src/core/action-claim.js';

describe('classifyActionClaim — concrete future-action claims (A1)', () => {
  it('catches the founding incident "Relaunching now" (present-progressive → A1)', () => {
    const r = classifyActionClaim('Relaunching now — expect a ~30s gap.');
    expect(r.isActionClaim).toBe(true);
    expect(r.claim?.normalizedClaimVerb).toBe('relaunch');
  });

  it('catches first-person near-future forms', () => {
    for (const [text, verb] of [
      ["I'll restart the server.", 'restart'],
      ['I will push the change now.', 'push'],
      ["I'm going to deploy this.", 'deploy'],
      ['Let me rebase on main.', 'rebase'],
      ['About to merge it.', 'merge'],
      ["I'll fix the failing test.", 'fix'],
    ] as const) {
      const r = classifyActionClaim(text);
      expect(r.isActionClaim, text).toBe(true);
      expect(r.claim?.normalizedClaimVerb, text).toBe(verb);
    }
  });

  it('normalizes participle forms to the canonical lemma (dedupe anchor)', () => {
    expect(classifyActionClaim("I'm restarting it").claim?.normalizedClaimVerb).toBe('restart');
    expect(classifyActionClaim('pushing it now').claim?.normalizedClaimVerb).toBe('push');
    expect(classifyActionClaim('redeploying the worker now').claim?.normalizedClaimVerb).toBe('redeploy');
  });
});

describe('classifyActionClaim — NOT a claim (fail toward not-registering)', () => {
  it('ignores vague/filler intent (no concrete verb)', () => {
    for (const text of [
      "I'll take a look.",
      "I'll keep that in mind.",
      'Let me think about it.',
      "I'll get back to you.",
      'Working on it now.',
    ]) {
      expect(classifyActionClaim(text).isActionClaim, text).toBe(false);
    }
  });

  it('ignores PAST-tense completed claims (descoped A2 class)', () => {
    for (const text of [
      'I relaunched the server.',
      'Pushed the change.',
      'Already merged it.',
      'I fixed the test and redeployed.',
    ]) {
      expect(classifyActionClaim(text).isActionClaim, text).toBe(false);
    }
  });

  it('ignores a QUOTED verb (someone quoting, not asserting)', () => {
    expect(classifyActionClaim('The doc says "restarting now" is the wrong move.').isActionClaim).toBe(false);
    expect(classifyActionClaim('You asked why I said `pushing it`.').isActionClaim).toBe(false);
  });

  it('ignores commands/questions/third-person TO or ABOUT others (Phase-5 finding)', () => {
    for (const text of [
      'You should restart the server when you get a chance.',
      'Let me know if you want me to restart it.',
      'Can you push the change?',
      'Did you restart it?',
      'Please merge the PR.',
      'He is deploying it.',
      'The script reverts the change automatically.',
      'We can deploy this later.',
    ]) {
      expect(classifyActionClaim(text).isActionClaim, text).toBe(false);
    }
  });

  it('still catches a sentence-initial participle after a boundary', () => {
    expect(classifyActionClaim('Done with the fix. Relaunching now.').isActionClaim).toBe(true);
    expect(classifyActionClaim('Done with the fix. Relaunching now.').claim?.normalizedClaimVerb).toBe('relaunch');
  });

  it('handles empty / non-string input', () => {
    expect(classifyActionClaim('').isActionClaim).toBe(false);
    // @ts-expect-error — total over bad input
    expect(classifyActionClaim(null).isActionClaim).toBe(false);
  });
});
