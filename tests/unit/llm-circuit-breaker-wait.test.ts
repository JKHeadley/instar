import { describe, it, expect } from 'vitest';
import {
  LlmCircuitBreaker,
  classifyRateLimit,
  LlmCircuitOpenError,
  RateLimitError,
} from '../../src/core/LlmCircuitBreaker.js';
import { CircuitBreakingIntelligenceProvider as CBProvider } from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import type {
  IntelligenceProvider,
  IntelligenceOptions,
} from '../../src/core/types.js';

/**
 * Deterministic fake clock + sleep. `sleep` ADVANCES the clock by the requested
 * ms then resolves, so acquireOrWait timing is fully deterministic — no real
 * waiting. Records every sleep duration for assertions.
 */
function makeClock(start = 0) {
  let t = start;
  let slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
    get sleepCalls() {
      return slept;
    },
    get totalSlept() {
      return slept.reduce((a, b) => a + b, 0);
    },
    resetSleeps: () => {
      slept = [];
    },
  };
}

class FakeProvider implements IntelligenceProvider {
  public calls = 0;
  public shouldThrow: Error | null = null;
  async evaluate(_prompt: string, _options?: IntelligenceOptions): Promise<string> {
    void _prompt;
    void _options;
    this.calls++;
    if (this.shouldThrow) throw this.shouldThrow;
    return 'ok';
  }
}

describe('classifyRateLimit', () => {
  it('parses "retry-after: 30" → 30000ms', () => {
    const c = classifyRateLimit('Claude CLI error: 429 retry-after: 30');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(30_000);
  });

  it('parses "retry after 30 seconds" → 30000ms', () => {
    const c = classifyRateLimit('rate limit hit, retry after 30 seconds');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(30_000);
  });

  it('parses "resets in 45s" → 45000ms', () => {
    const c = classifyRateLimit('usage limit — resets in 45s');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(45_000);
  });

  it('parses "try again in 2 minutes" → 120000ms', () => {
    const c = classifyRateLimit('Too many requests. Try again in 2 minutes.');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(120_000);
  });

  it('parses "resets in 3m" → 180000ms', () => {
    const c = classifyRateLimit('quota exceeded, resets in 3m');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(180_000);
  });

  // Gemini phrasing: "your quota will reset AFTER Ns" (not "in Ns"). Before the
  // (?:in|after) fix this failed to parse → the breaker fell back to the blunt
  // 15-min DEFAULT_OPEN_MS, turning an 8s provider reset into a 900s global
  // pause (observed live on the gemini-cli agent, 2026-06-03).
  it('parses Gemini "quota will reset after 8s" → 8000ms', () => {
    const c = classifyRateLimit('You have exhausted your capacity on this model. Your quota will reset after 8s.');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(8_000);
  });

  it('parses "reset after 5 minutes" → 300000ms', () => {
    const c = classifyRateLimit('quota exhausted — reset after 5 minutes');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(300_000);
  });

  it('treats a plain 429 as a limit with no retryAfterMs', () => {
    const c = classifyRateLimit('HTTP 429 returned');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBeUndefined();
  });

  it('returns isLimit false for non-limit text', () => {
    const c = classifyRateLimit('Some unrelated parse error occurred');
    expect(c.isLimit).toBe(false);
    expect(c.retryAfterMs).toBeUndefined();
  });

  it('returns isLimit false for null/empty', () => {
    expect(classifyRateLimit(null).isLimit).toBe(false);
    expect(classifyRateLimit('').isLimit).toBe(false);
    expect(classifyRateLimit(undefined).isLimit).toBe(false);
  });

  it('clamps an absurdly large retry-after to the 15min max', () => {
    const c = classifyRateLimit('rate limit, retry-after: 99999 seconds');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(15 * 60 * 1000);
  });

  it('clamps a sub-second retry-after up to the 1s min', () => {
    const c = classifyRateLimit('rate limit, retry after 0.1 seconds');
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(1000);
  });

  it('is a superset of isRateLimitError (same phrases/402/quota)', () => {
    expect(classifyRateLimit('out of credit').isLimit).toBe(true);
    expect(classifyRateLimit('payment required 402').isLimit).toBe(true);
    expect(classifyRateLimit('insufficient quota').isLimit).toBe(true);
  });
});

describe('LlmCircuitBreaker.onRateLimited with retryAfterMs', () => {
  it('uses a shortened window and admits a probe after retryAfterMs', () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 15 * 60 * 1000, now: clock.now });
    // 60s retry-after → window shortened to 60s (within [30s, 15min]).
    breaker.onRateLimited('429', 60_000);
    expect(breaker.status().state).toBe('open');

    // Refuses during the window.
    clock.advance(59_000);
    expect(breaker.acquire().allow).toBe(false);

    // Admits a probe exactly after retryAfterMs (60s), NOT the full 15min.
    clock.advance(1_000);
    const gate = breaker.acquire();
    expect(gate.allow).toBe(true);
    expect(gate.probe).toBe(true);
  });

  it('floors the window to min(30s, openMs) for a tiny retry-after', () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 15 * 60 * 1000, now: clock.now });
    breaker.onRateLimited('429', 5_000); // floored to 30s
    clock.advance(29_000);
    expect(breaker.acquire().allow).toBe(false);
    clock.advance(1_000);
    expect(breaker.acquire().allow).toBe(true);
  });

  it('falls back to the flat default window without retryAfterMs', () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 1000, now: clock.now });
    breaker.onRateLimited('429');
    clock.advance(999);
    expect(breaker.acquire().allow).toBe(false);
    clock.advance(1);
    expect(breaker.acquire().allow).toBe(true);
  });

  it('resets the per-trip window on a clean close (onResolved)', () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 15 * 60 * 1000, now: clock.now });
    breaker.onRateLimited('429', 60_000); // shorten to 60s
    clock.advance(60_000);
    breaker.acquire(); // half-open probe
    breaker.onResolved(); // close + reset currentOpenMs to openMs
    // Next trip with no hint must use the full default window again.
    breaker.onRateLimited('429');
    clock.advance(14 * 60 * 1000);
    expect(breaker.acquire().allow).toBe(false); // still inside 15min
    clock.advance(60 * 1000);
    expect(breaker.acquire().allow).toBe(true);
  });

  // End-to-end regression for the live Gemini over-pause: the real provider
  // message must classify AND shorten the window. Before the (?:in|after) parse
  // fix, retryAfterMs was undefined → 900s pause; now it floors to 30s and the
  // agent recovers in ~30s instead of 15 minutes.
  it('Gemini "quota will reset after 8s" recovers in ~30s, NOT the blunt 15min', () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 15 * 60 * 1000, now: clock.now });
    const msg = 'Gemini CLI exited 1 — Your quota will reset after 8s.';
    const c = classifyRateLimit(msg);
    expect(c.isLimit).toBe(true);
    expect(c.retryAfterMs).toBe(8_000); // parsed (the fix); was undefined before
    breaker.onRateLimited(msg, c.retryAfterMs); // 8s floored to the 30s minimum
    clock.advance(29_000);
    expect(breaker.acquire().allow).toBe(false); // still inside the floored 30s
    clock.advance(2_000);
    expect(breaker.acquire().allow).toBe(true); // recovered ~30s, not 900s
  });
});

describe('LlmCircuitBreaker.acquireOrWait', () => {
  it('returns allow immediately when closed (no sleep)', async () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ now: clock.now, sleep: clock.sleep });
    const gate = await breaker.acquireOrWait(10_000);
    expect(gate.allow).toBe(true);
    expect(clock.sleepCalls.length).toBe(0);
  });

  it('returns allow immediately when disabled (passthrough, no sleep)', async () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ enabled: false, now: clock.now, sleep: clock.sleep });
    breaker.onRateLimited('429'); // no-op when disabled
    const gate = await breaker.acquireOrWait(10_000);
    expect(gate.allow).toBe(true);
    expect(clock.sleepCalls.length).toBe(0);
  });

  it('waits ~window then returns allow:true when it becomes available in time', async () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 5_000, now: clock.now, sleep: clock.sleep });
    breaker.onRateLimited('429'); // open for 5s
    const gate = await breaker.acquireOrWait(10_000);
    expect(gate.allow).toBe(true);
    expect(gate.probe).toBe(true); // it became the half-open probe
    expect(clock.totalSlept).toBeGreaterThanOrEqual(5_000);
    expect(clock.totalSlept).toBeLessThan(10_000);
  });

  it('returns allow:false at the deadline when window is longer than maxWait', async () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 60_000, now: clock.now, sleep: clock.sleep });
    breaker.onRateLimited('429'); // open for 60s
    const start = clock.now();
    const gate = await breaker.acquireOrWait(5_000); // willing to wait only 5s
    expect(gate.allow).toBe(false);
    // Bounded: total elapsed must not exceed maxWait.
    expect(clock.now() - start).toBeLessThanOrEqual(5_000);
  });

  it('admits exactly one probe under a concurrent herd; the loser polls until close', async () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({
      openMs: 1_000,
      probePollMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });
    breaker.onRateLimited('429'); // open for 1s

    let probeCount = 0;
    const p1 = breaker.acquireOrWait(10_000);
    const p2 = breaker.acquireOrWait(10_000);

    // Drive the breaker: once a half-open probe is admitted, resolve it so the
    // loser can re-acquire on a closed breaker. Counts probes admitted.
    let guard = 0;
    while (breaker.status().state !== 'closed' && guard < 1000) {
      await Promise.resolve();
      if (breaker.status().state === 'half-open' && probeCount === 0) {
        probeCount++;
        breaker.onResolved();
      }
      guard++;
    }

    const [g1, g2] = await Promise.all([p1, p2]);

    // Exactly one probe was admitted to the provider.
    expect(probeCount).toBe(1);
    // Both eventually proceed.
    expect(g1.allow).toBe(true);
    expect(g2.allow).toBe(true);
    // One was the probe (probe:true), the other acquired on the now-closed
    // breaker (probe:false).
    const probeFlags = [g1.probe, g2.probe].sort();
    expect(probeFlags).toEqual([false, true]);
  });

  it('loser keeps waiting until its bounded deadline if the probe reopens the breaker', async () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({
      openMs: 1_000,
      probePollMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });
    breaker.onRateLimited('429');

    // First caller becomes the probe.
    const winner = await breaker.acquireOrWait(10_000);
    expect(winner.allow).toBe(true);
    expect(winner.probe).toBe(true);

    // Probe fails as a rate-limit → reopens. A short-deadline waiter gives up.
    breaker.onRateLimited('429'); // reopen for another 1s
    const loser = await breaker.acquireOrWait(500);
    expect(loser.allow).toBe(false);
  });
});

describe('CircuitBreakingIntelligenceProvider rate-limit wait policy', () => {
  function openBreaker() {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 60_000, now: clock.now, sleep: clock.sleep });
    breaker.onRateLimited('429'); // open for 60s
    return { clock, breaker };
  }

  it('throws immediately when no rateLimitWaitMs is set (best-effort, no wait)', async () => {
    const { breaker, clock } = openBreaker();
    const provider = new FakeProvider();
    const cb = new CBProvider(provider, breaker);
    await expect(cb.evaluate('hi')).rejects.toThrow(LlmCircuitOpenError);
    expect(provider.calls).toBe(0);
    expect(clock.sleepCalls.length).toBe(0); // no wait
  });

  it('waits (bounded) and proceeds when rateLimitWaitMs >= window', async () => {
    const { breaker } = openBreaker();
    const provider = new FakeProvider();
    const cb = new CBProvider(provider, breaker);
    // Window 60s; willing to wait 120s → acquires the probe and calls.
    const res = await cb.evaluate('hi', { rateLimitWaitMs: 120_000 });
    expect(res).toBe('ok');
    expect(provider.calls).toBe(1);
  });

  it('still throws when rateLimitWaitMs is shorter than the window', async () => {
    const { breaker } = openBreaker();
    const provider = new FakeProvider();
    const cb = new CBProvider(provider, breaker);
    await expect(cb.evaluate('hi', { rateLimitWaitMs: 5_000 })).rejects.toThrow(
      LlmCircuitOpenError,
    );
    expect(provider.calls).toBe(0);
  });

  it('passes the parsed retryAfterMs through to onRateLimited on a fresh limit', async () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({
      openMs: 15 * 60 * 1000,
      now: clock.now,
      sleep: clock.sleep,
    });
    const provider = new FakeProvider();
    provider.shouldThrow = new Error('Claude CLI error: rate limit retry-after: 45');
    const cb = new CBProvider(provider, breaker);
    await expect(cb.evaluate('hi')).rejects.toThrow(RateLimitError);
    // Window should be shortened to 45s, not the full 15min.
    clock.advance(44_000);
    expect(breaker.acquire().allow).toBe(false);
    clock.advance(1_000);
    expect(breaker.acquire().allow).toBe(true);
  });

  it('is byte-identical for non-rate-limit errors (closes breaker, rethrows original)', async () => {
    const clock = makeClock(0);
    const breaker = new LlmCircuitBreaker({ openMs: 60_000, now: clock.now, sleep: clock.sleep });
    const provider = new FakeProvider();
    const original = new Error('some parse error');
    provider.shouldThrow = original;
    const cb = new CBProvider(provider, breaker);
    await expect(cb.evaluate('hi')).rejects.toBe(original);
    expect(breaker.status().state).toBe('closed');
  });
});

describe('module exports', () => {
  it('classifyRateLimit and CircuitBreakingIntelligenceProvider resolve', () => {
    expect(typeof classifyRateLimit).toBe('function');
    expect(typeof CBProvider).toBe('function');
  });
});
