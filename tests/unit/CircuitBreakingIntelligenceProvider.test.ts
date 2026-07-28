/**
 * Unit tests — CircuitBreakingIntelligenceProvider decorator.
 *
 * The key correctness property: when the breaker is open, the decorator MUST
 * NOT call the underlying provider (that is what stops the credit bleed — no
 * `claude -p` subprocess spawns). We assert that with a call-counting fake
 * inner provider, plus the trip/close/probe transitions and error typing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CircuitBreakingIntelligenceProvider,
  wrapIntelligenceWithCircuitBreaker,
} from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import {
  LlmCircuitBreaker,
  LlmCircuitOpenError,
  RateLimitError,
} from '../../src/core/LlmCircuitBreaker.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

class FakeProvider implements IntelligenceProvider {
  calls = 0;
  constructor(private behavior: () => Promise<string>) {}
  async evaluate(): Promise<string> {
    this.calls += 1;
    return this.behavior();
  }
}

describe('CircuitBreakingIntelligenceProvider', () => {
  let nowMs: number;
  let breaker: LlmCircuitBreaker;

  beforeEach(() => {
    nowMs = 1_000_000;
    breaker = new LlmCircuitBreaker({ openMs: 1000, now: () => nowMs, log: () => {} });
  });

  it('passes through when the breaker is closed', async () => {
    const inner = new FakeProvider(async () => 'OK');
    const provider = new CircuitBreakingIntelligenceProvider(inner, breaker);
    await expect(provider.evaluate('hi')).resolves.toBe('OK');
    expect(inner.calls).toBe(1);
  });

  it('trips the breaker and throws RateLimitError when the inner call hits a usage limit', async () => {
    const inner = new FakeProvider(async () => {
      throw new Error('Claude CLI error: 429 Too Many Requests — usage limit reached');
    });
    const provider = new CircuitBreakingIntelligenceProvider(inner, breaker);
    await expect(provider.evaluate('hi')).rejects.toBeInstanceOf(RateLimitError);
    expect(breaker.status().state).toBe('open');
    expect(inner.calls).toBe(1);
  });

  it('SHORT-CIRCUITS while open — does NOT call the inner provider (the actual fix)', async () => {
    const inner = new FakeProvider(async () => {
      throw new Error('429 rate limit');
    });
    const provider = new CircuitBreakingIntelligenceProvider(inner, breaker);

    // First call trips the breaker (1 inner call).
    await expect(provider.evaluate('a')).rejects.toBeInstanceOf(RateLimitError);
    expect(inner.calls).toBe(1);

    // Next several calls within the open window must NOT spawn the inner provider.
    for (let i = 0; i < 5; i++) {
      await expect(provider.evaluate('b')).rejects.toBeInstanceOf(LlmCircuitOpenError);
    }
    expect(inner.calls).toBe(1); // <-- zero additional subprocess spawns
  });

  it('admits one probe after the window and closes on a successful probe', async () => {
    let mode: 'limit' | 'ok' = 'limit';
    const inner = new FakeProvider(async () => {
      if (mode === 'limit') throw new Error('usage limit reached');
      return 'OK';
    });
    const provider = new CircuitBreakingIntelligenceProvider(inner, breaker);

    await expect(provider.evaluate('a')).rejects.toBeInstanceOf(RateLimitError); // opens
    nowMs += 1000; // window elapses
    mode = 'ok'; // provider recovered

    await expect(provider.evaluate('probe')).resolves.toBe('OK'); // probe succeeds → closes
    expect(breaker.status().state).toBe('closed');
    await expect(provider.evaluate('after')).resolves.toBe('OK');
  });

  it('re-throws a non-rate-limit error unchanged and keeps the breaker closed', async () => {
    const inner = new FakeProvider(async () => {
      throw new Error('Claude CLI error: Command failed: ETIMEDOUT');
    });
    const provider = new CircuitBreakingIntelligenceProvider(inner, breaker);
    await expect(provider.evaluate('hi')).rejects.toThrow('ETIMEDOUT');
    await expect(provider.evaluate('hi')).rejects.not.toBeInstanceOf(RateLimitError);
    expect(breaker.status().state).toBe('closed'); // unrelated error does not open
  });

  it('wrapIntelligenceWithCircuitBreaker is null-safe and never double-wraps', () => {
    expect(wrapIntelligenceWithCircuitBreaker(null)).toBeNull();
    expect(wrapIntelligenceWithCircuitBreaker(undefined)).toBeNull();
    const inner = new FakeProvider(async () => 'OK');
    const wrapped = wrapIntelligenceWithCircuitBreaker(inner);
    expect(wrapped).toBeInstanceOf(CircuitBreakingIntelligenceProvider);
    expect(wrapIntelligenceWithCircuitBreaker(wrapped)).toBe(wrapped); // idempotent
  });
});
