/**
 * Unit tests — a grok weekly-pool wall must not read as a generic crash
 * (round-19).
 *
 * THE DEFECT: the adapter types weekly-pool exhaustion as a terminal
 * QuotaError, and `classifyReviewFailure` then re-derived a class by
 * string-matching the message, discarding the type. Measured by a reviewer: the
 * two wordings grok's own regex was written for both round-tripped to `error` —
 * indistinguishable from a missing binary — while "rate limit exceeded"
 * correctly produced `rate-limited`. That last case is the control proving the
 * function CAN say something else, which is what made the negative meaningful.
 *
 * Why it matters operationally: the invisible weekly pool is the one stall
 * class this spec calls unique to grok. Reported as a generic error, nothing
 * marks the family terminal, so the next review retries into the same wall —
 * each attempt costing a ceiling slot until the refusal reads "N runs / 0
 * tokens" having spent nothing.
 */

import { describe, it, expect } from 'vitest';
import { classifyReviewFailure } from '../../src/core/crossModelReviewer.js';

class QuotaError extends Error {}
class RateLimitError extends Error {}

describe('classifyReviewFailure — type before message', () => {
  it('a typed QuotaError is a weekly-pool wall regardless of its wording', () => {
    // The type is the reliable signal; the message is vendor prose that can
    // change without notice. A wall whose wording drifts must still classify.
    expect(classifyReviewFailure(new QuotaError('anything at all'))).toBe('weekly-pool-exhausted');
  });

  it('the two real observed wordings no longer read as a generic error', () => {
    for (const m of [
      'Error: weekly limit reached for your plan',
      'Error: you are out of usage for this week',
    ]) {
      expect(classifyReviewFailure(new Error(m)), m).toBe('weekly-pool-exhausted');
    }
  });

  it('CONTROL: a genuine crash still classifies as a generic error', () => {
    // Without this the assertions above would be satisfied by a classifier
    // that called everything a quota wall — which would suppress real crashes.
    expect(classifyReviewFailure(new Error('boom: unexpected crash'))).toBe('error');
  });

  it('CONTROL: rate limiting stays distinct from the weekly wall', () => {
    // These are operationally different: a rate limit clears on its own, a
    // weekly wall does not. Collapsing them would restore the ambiguity this
    // fix removes, in the other direction.
    expect(classifyReviewFailure(new RateLimitError('slow down'))).toBe('rate-limited');
    expect(classifyReviewFailure(new Error('Error: rate limit exceeded'))).toBe('rate-limited');
  });

  it('CONTROL: a timeout is still a timeout', () => {
    expect(classifyReviewFailure(new Error('the call timed out'))).toBe('timeout');
  });
});
