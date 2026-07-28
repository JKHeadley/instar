/**
 * Unit tests — LlmCircuitBreaker + isRateLimitError.
 *
 * Covers both sides of every decision boundary: the rate-limit classifier
 * (true language vs. unrelated errors) and the breaker state machine
 * (closed → open → half-open → {closed | open}), the single-probe invariant,
 * the disabled passthrough, and re-extension on a failed probe.
 */

import { describe, it, expect } from 'vitest';
import {
  LlmCircuitBreaker,
  isRateLimitError,
} from '../../src/core/LlmCircuitBreaker.js';

describe('isRateLimitError', () => {
  const positives = [
    'Claude CLI error: Command failed — 429 Too Many Requests',
    'Anthropic API error: rate_limit_error',
    'You have hit your rate limit. Please try again later.',
    'Claude AI usage limit reached. Your limit will reset at 3pm.',
    'usage_limit exceeded for this account',
    'quota exceeded',
    'Insufficient quota to complete the request',
    'Your credit balance is too low to run this request',
    'out of credit',
    'Payment Required',
    'HTTP 402',
    'You have exceeded your monthly usage limit',
    'spending limit reached for this billing period',
  ];
  for (const msg of positives) {
    it(`classifies as rate-limit: "${msg.slice(0, 40)}…"`, () => {
      expect(isRateLimitError(msg)).toBe(true);
    });
  }

  const negatives = [
    'Claude CLI error: Command failed: ETIMEDOUT',
    'Claude CLI error: spawn ENOENT',
    'Failed to parse JSON response',
    'Command failed with exit code 1',
    'Network error: ECONNRESET',
    'some unrelated stderr noise',
    '',
    undefined,
    null,
  ];
  for (const msg of negatives) {
    it(`does NOT classify as rate-limit: "${String(msg).slice(0, 40)}"`, () => {
      expect(isRateLimitError(msg as string | null | undefined)).toBe(false);
    });
  }
});

describe('LlmCircuitBreaker — state machine', () => {
  function makeBreaker(openMs = 1000) {
    let nowMs = 1_000_000;
    const breaker = new LlmCircuitBreaker({
      openMs,
      now: () => nowMs,
      log: () => {}, // silence
    });
    return {
      breaker,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('starts closed and admits calls without a probe', () => {
    const { breaker } = makeBreaker();
    const d = breaker.acquire();
    expect(d.allow).toBe(true);
    expect(d.probe).toBe(false);
    expect(breaker.status().state).toBe('closed');
  });

  it('opens on a rate-limit and blocks subsequent calls within the window', () => {
    const { breaker } = makeBreaker(1000);
    breaker.onRateLimited('429 Too Many Requests');
    const status = breaker.status();
    expect(status.state).toBe('open');
    expect(status.tripCount).toBe(1);
    expect(status.retryAfterMs).toBeGreaterThan(0);

    const d = breaker.acquire();
    expect(d.allow).toBe(false);
    expect(d.probe).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
  });

  it('admits exactly one probe after the window elapses; concurrent callers stay blocked', () => {
    const { breaker, advance } = makeBreaker(1000);
    breaker.onRateLimited('rate limit');
    advance(1000); // window elapsed

    const first = breaker.acquire();
    expect(first.allow).toBe(true);
    expect(first.probe).toBe(true);
    expect(breaker.status().state).toBe('half-open');

    // A second caller arrives before the probe resolves → blocked.
    const second = breaker.acquire();
    expect(second.allow).toBe(false);
    expect(second.probe).toBe(false);
  });

  it('a successful probe closes the breaker', () => {
    const { breaker, advance } = makeBreaker(1000);
    breaker.onRateLimited('rate limit');
    advance(1000);
    const probe = breaker.acquire();
    expect(probe.probe).toBe(true);

    breaker.onResolved(); // probe succeeded
    expect(breaker.status().state).toBe('closed');
    expect(breaker.acquire().allow).toBe(true);
  });

  it('a still-limited probe re-opens for another full window (trip count increments)', () => {
    const { breaker, advance } = makeBreaker(1000);
    breaker.onRateLimited('rate limit');
    advance(1000);
    breaker.acquire(); // probe admitted

    breaker.onRateLimited('rate limit again'); // probe still hit the limit
    const status = breaker.status();
    expect(status.state).toBe('open');
    expect(status.tripCount).toBe(2);
    expect(breaker.acquire().allow).toBe(false); // re-blocked
  });

  it('onResolved while already closed is a no-op', () => {
    const { breaker } = makeBreaker();
    breaker.onResolved();
    expect(breaker.status().state).toBe('closed');
    expect(breaker.acquire().allow).toBe(true);
  });

  it('reset() returns an open breaker to closed', () => {
    const { breaker } = makeBreaker();
    breaker.onRateLimited('rate limit');
    expect(breaker.status().state).toBe('open');
    breaker.reset();
    expect(breaker.status().state).toBe('closed');
    expect(breaker.acquire().allow).toBe(true);
  });

  it('when disabled, the breaker is a passthrough even after a rate-limit', () => {
    let nowMs = 0;
    const breaker = new LlmCircuitBreaker({ enabled: false, now: () => nowMs, log: () => {} });
    breaker.onRateLimited('429');
    const d = breaker.acquire();
    expect(d.allow).toBe(true);
    expect(d.probe).toBe(false);
    expect(breaker.status().enabled).toBe(false);
  });

  it('configure() can flip enabled and tune openMs at runtime', () => {
    const { breaker } = makeBreaker(1000);
    breaker.configure({ enabled: false });
    breaker.onRateLimited('429');
    expect(breaker.acquire().allow).toBe(true); // disabled → passthrough
    breaker.configure({ enabled: true });
    breaker.onRateLimited('429');
    expect(breaker.acquire().allow).toBe(false); // re-enabled → blocks
  });
});
