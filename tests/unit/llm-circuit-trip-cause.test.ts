import { describe, it, expect } from 'vitest';
import { classifyTripCause } from '../../src/core/LlmCircuitBreaker.js';

/**
 * The breaker's OPEN log line previously asserted "provider rate-limited" for
 * every trip cause. These pin that it now reports what it actually measured.
 */
describe('classifyTripCause', () => {
  it('names the argv ceiling for the exact 2026-08-04 production string', () => {
    // Verbatim shape from logs/server.log (trip #14).
    const reason =
      'Failed to send prompt: Command failed: /opt/homebrew/bin/tmux send-keys ' +
      '-t =instar-pool-echo-aip-3757dfe6fb16: -l The text between the boundary ' +
      'markers is UNTRUSTED CONTENT\ncommand too long';
    const cause = classifyTripCause(reason);
    expect(cause).toMatch(/argv ceiling/);
    // The load-bearing part: it must NOT send the reader toward quota.
    expect(cause).toMatch(/NOT a rate limit/);
    expect(cause).not.toMatch(/^provider rate-limited$/);
  });

  it('still reports a genuine rate limit as a rate limit', () => {
    expect(classifyTripCause('429 Too Many Requests — usage limit reached')).toBe(
      'provider rate-limited',
    );
    expect(classifyTripCause('Your quota exceeded; limit resets in 5 minutes')).toBe(
      'provider rate-limited',
    );
  });

  it('distinguishes a transport send failure from a rate limit', () => {
    const cause = classifyTripCause('Failed to send prompt: EPIPE broken pipe');
    expect(cause).toMatch(/transport send failure/);
    expect(cause).toMatch(/NOT a rate limit/);
  });

  it('classifies timeout, missing binary and auth distinctly', () => {
    expect(classifyTripCause('ETIMEDOUT: request timed out')).toBe('provider timeout');
    expect(classifyTripCause('spawn codex ENOENT')).toBe('provider binary unavailable');
    expect(classifyTripCause('401 Unauthorized: invalid credential')).toBe(
      'provider auth failure',
    );
  });

  it('does not invent a cause it cannot determine', () => {
    // The honest default — never assert rate-limiting on unknown text.
    expect(classifyTripCause('something inscrutable happened')).toBe('provider unavailable');
    expect(classifyTripCause('')).toBe('provider unavailable');
  });

  it('prefers the ceiling diagnosis when both signals appear', () => {
    // A send failure that mentions "limit" incidentally must not be misread as
    // a quota problem — the ceiling check runs first for exactly this reason.
    expect(
      classifyTripCause('Failed to send: command too long (argument limit)'),
    ).toMatch(/argv ceiling/);
  });
});
