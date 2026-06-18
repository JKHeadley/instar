/**
 * detectRawTextRequestToOperator — the arm-2 backstop signal (ws52-operator-tap-not-text
 * Part C). High-precision: fires on imperative-to-operator asks for raw technical text,
 * NOT on the agent explaining/quoting. Tests pin both sides (incl. the false-positive
 * guards the adversarial/lessons reviewers required).
 */
import { describe, it, expect } from 'vitest';
import { detectRawTextRequestToOperator } from '../../src/core/rawTextRequestDetector.js';

describe('detectRawTextRequestToOperator — DETECTED (imperative asks)', () => {
  it('“paste this JSON into the form”', () => {
    expect(detectRawTextRequestToOperator('Now paste this JSON into the Authorities box.').detected).toBe(true);
  });
  it('“fill in your fingerprint”', () => {
    expect(detectRawTextRequestToOperator('Fill in your fingerprint in both boxes.').detected).toBe(true);
  });
  it('“copy the authorities block below”', () => {
    expect(detectRawTextRequestToOperator('Copy the authorities block below, then tap Issue.').detected).toBe(true);
  });
  it('“run this curl command”', () => {
    expect(detectRawTextRequestToOperator('Please run this curl command in a terminal.').detected).toBe(true);
  });
});

describe('detectRawTextRequestToOperator — NOT detected (the false-positive guards)', () => {
  it('the agent EXPLAINING the feature (no imperative ask)', () => {
    expect(detectRawTextRequestToOperator(
      'The old form required pasting JSON, which was the bug — the new card is one tap.',
    ).detected).toBe(false);
  });
  it('answering "what is my fingerprint?" (informational, not an ask to paste)', () => {
    expect(detectRawTextRequestToOperator(
      'Your routing fingerprint is 63b1dbb2… — that is what peers use to reach you.',
    ).detected).toBe(false);
  });
  it('a normal conversational reply', () => {
    expect(detectRawTextRequestToOperator('Got it — the deploy landed and the proof is ready for your tap.').detected).toBe(false);
  });
  it('discussing the standard itself', () => {
    expect(detectRawTextRequestToOperator(
      'The new rule blocks any screen that needs the operator to paste raw text like JSON.',
    ).detected).toBe(false);
  });
  it('empty / undefined', () => {
    expect(detectRawTextRequestToOperator('').detected).toBe(false);
    expect(detectRawTextRequestToOperator(undefined as unknown as string).detected).toBe(false);
  });
});
