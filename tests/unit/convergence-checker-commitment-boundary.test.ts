/**
 * Tier-1 tests for the ConvergenceChecker TS-side commitment_overreach
 * pattern — kept in lockstep with the shell template's regex (the same
 * word-boundary fix, live FPs 2026-06-06: "Mini promises" / "I promised"
 * matched the bare `i (promise...)` and blocked real status reports five
 * times in one day).
 */
import { describe, it, expect } from 'vitest';

import { checkConvergence } from '../../src/core/ConvergenceChecker.js';

function commitmentFlagged(content: string): boolean {
  return checkConvergence(content).issues.some((i) => i.category === 'commitment_overreach');
}

describe('ConvergenceChecker — commitment_overreach word boundaries', () => {
  it('does NOT flag the live false positives', () => {
    expect(commitmentFlagged('The laptop sees 460 of the Mini promises with full detail.')).toBe(false);
    expect(commitmentFlagged('Everything I promised earlier is done and verified.')).toBe(false);
    expect(commitmentFlagged('She promised to review the compromise proposal.')).toBe(false);
  });

  it('still flags real commitments', () => {
    expect(commitmentFlagged('I promise to deliver the report tomorrow.')).toBe(true);
    expect(commitmentFlagged('It will be done, I promise.')).toBe(true);
    expect(commitmentFlagged("I'll make sure this never happens again.")).toBe(true);
    expect(commitmentFlagged('You can count on me to follow up.')).toBe(true);
    expect(commitmentFlagged("From now on I'll lead with the action.")).toBe(true);
  });
});
