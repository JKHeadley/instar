// Unit tests for the rate-limit (server-side throttle) detection predicate.
// Both sides of the decision boundary, using the EXACT rendered strings from
// the user's live screenshot and the Claude Code error reference (the fixtures
// are the spec's "verify against real APIs" anchor).

import { describe, it, expect } from 'vitest';
import {
  detectRateLimited,
  THROTTLE_PATTERNS,
  USAGE_LIMIT_PATTERNS,
  RETRY_SPINNER_PATTERN,
} from '../../src/monitoring/rateLimitDetection.js';

// Exact rendered strings (fixtures).
const THROTTLE_SCREENSHOT =
  'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';
const THROTTLE_529 = 'API Error: Repeated 529 Overloaded errors. The API is at capacity.';
const USAGE_WEEKLY = "You've hit your weekly limit · resets Mon 12:00am";
const USAGE_SESSION = "You've hit your session limit · resets 3:45pm (America/Los_Angeles)";
const RETRY_SPINNER = 'Retrying in 7s · attempt 3/10';
const GENERIC_500 = 'API Error: 500 Internal server error. This is a server-side issue.';

function pane(...lines: string[]): string {
  return lines.join('\n');
}

describe('detectRateLimited', () => {
  // ─── Fires (true) ───

  it('fires on the exact throttle string from the screenshot', () => {
    expect(detectRateLimited(pane('❯ doing work', THROTTLE_SCREENSHOT, '❯ '))).toBe(true);
  });

  it('fires on the 529 overloaded form', () => {
    expect(detectRateLimited(pane(THROTTLE_529, '❯ '))).toBe(true);
  });

  it('fires on the "not your usage limit" anchor alone', () => {
    expect(detectRateLimited('something (not your usage limit) happened')).toBe(true);
  });

  // ─── Does NOT fire (false) ───

  it('does NOT fire on a usage/plan limit (weekly)', () => {
    expect(detectRateLimited(pane(USAGE_WEEKLY, '❯ '))).toBe(false);
  });

  it('does NOT fire on a usage/plan limit (session, with reset time)', () => {
    expect(detectRateLimited(pane(USAGE_SESSION, '❯ '))).toBe(false);
  });

  it('does NOT fire on a generic 500 API error', () => {
    expect(detectRateLimited(pane(GENERIC_500, '❯ '))).toBe(false);
  });

  it('does NOT fire while the retry spinner is still showing (framework owns it)', () => {
    expect(detectRateLimited(pane(THROTTLE_SCREENSHOT, RETRY_SPINNER))).toBe(false);
  });

  it('tolerates middot/encoding drift around the spinner separator', () => {
    expect(detectRateLimited(pane(THROTTLE_SCREENSHOT, 'Retrying in 5s  attempt 2/10'))).toBe(false);
  });

  it('is conservative: a stray reset line suppresses (treats as usage domain)', () => {
    expect(detectRateLimited(pane(THROTTLE_SCREENSHOT, 'next window resets 7pm'))).toBe(false);
  });

  it('returns false for empty / null / undefined', () => {
    expect(detectRateLimited('')).toBe(false);
    expect(detectRateLimited(null)).toBe(false);
    expect(detectRateLimited(undefined)).toBe(false);
  });

  it('only inspects recent lines (old throttle scrolled away is ignored)', () => {
    const old = pane(THROTTLE_SCREENSHOT, ...Array(30).fill('continued working fine'), '❯ ');
    expect(detectRateLimited(old)).toBe(false);
  });

  // ─── Pattern sanity ───

  it('pattern arrays are non-empty and the screenshot matches a throttle pattern', () => {
    expect(THROTTLE_PATTERNS.length).toBeGreaterThan(0);
    expect(USAGE_LIMIT_PATTERNS.length).toBeGreaterThan(0);
    expect(THROTTLE_PATTERNS.some(p => p.test(THROTTLE_SCREENSHOT))).toBe(true);
    expect(RETRY_SPINNER_PATTERN.test('retrying in 12')).toBe(true);
  });
});
