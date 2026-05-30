/**
 * Unit tests for the UnjustifiedStopGate circuit breaker.
 *
 * The breaker is the CLI-provider reality fix: a `claude -p` judgment call takes
 * ~5-6s but the client budget is ~2s, so subscription agents time out on EVERY
 * stop event — wastefully spawning+killing a claude subprocess each time and
 * flooding /health with one degradation per stop. After `breakerThreshold`
 * consecutive provider failures (timeout / llmUnavailable) the breaker opens:
 * evaluate() fails open IMMEDIATELY without calling the provider, for
 * `breakerCooldownMs`, then retries (half-open). A reachable provider resets it.
 */
import { describe, it, expect } from 'vitest';
import { UnjustifiedStopGate, type EvaluateInput } from '../../src/core/UnjustifiedStopGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const INPUT: EvaluateInput = {
  evidenceMetadata: { artifacts: [] } as never,
  untrustedContent: { stopReason: 'done' } as never,
};

/** A provider that always throws (→ llmUnavailable), counting calls. */
function throwingProvider(): { provider: IntelligenceProvider; calls: () => number } {
  let calls = 0;
  return {
    provider: { evaluate: async () => { calls += 1; throw new Error('provider down'); } },
    calls: () => calls,
  };
}

/** A mutable clock for deterministic cooldown testing. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('UnjustifiedStopGate circuit breaker', () => {
  it('opens after breakerThreshold consecutive provider failures and stops calling the provider', async () => {
    const { provider, calls } = throwingProvider();
    const c = clock();
    const gate = new UnjustifiedStopGate({
      intelligence: provider,
      breakerThreshold: 3,
      breakerCooldownMs: 60_000,
      now: c.now,
    });

    // First 3 calls hit the provider (and fail-open with llmUnavailable).
    for (let i = 0; i < 3; i++) {
      const r = await gate.evaluate(INPUT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe('llmUnavailable');
    }
    expect(calls()).toBe(3);
    expect(gate.breakerState().open).toBe(true);

    // Breaker now open: the next calls short-circuit to breakerOpen and DON'T
    // touch the provider (no wasteful subprocess spawn).
    for (let i = 0; i < 5; i++) {
      const r = await gate.evaluate(INPUT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe('breakerOpen');
    }
    expect(calls()).toBe(3); // unchanged — provider not called while open
  });

  it('retries (half-open) after the cooldown elapses', async () => {
    const { provider, calls } = throwingProvider();
    const c = clock();
    const gate = new UnjustifiedStopGate({
      intelligence: provider, breakerThreshold: 2, breakerCooldownMs: 10_000, now: c.now,
    });

    await gate.evaluate(INPUT);
    await gate.evaluate(INPUT); // breaker opens here
    expect(gate.breakerState().open).toBe(true);
    expect(calls()).toBe(2);

    // Still within cooldown → short-circuit, no provider call.
    c.advance(9_999);
    expect((await gate.evaluate(INPUT) as { failure: { kind: string } }).failure.kind).toBe('breakerOpen');
    expect(calls()).toBe(2);

    // Cooldown elapsed → the gate retries the provider (half-open).
    c.advance(2);
    await gate.evaluate(INPUT);
    expect(calls()).toBe(3); // provider called again after cooldown
  });

  it('a reachable provider resets the breaker (consecutive failures cleared)', async () => {
    let down = true;
    let calls = 0;
    const provider: IntelligenceProvider = {
      evaluate: async () => {
        calls += 1;
        if (down) throw new Error('down');
        return JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_COMPLETION', evidence_pointer: {}, rationale: 'ok' });
      },
    };
    const c = clock();
    const gate = new UnjustifiedStopGate({ intelligence: provider, breakerThreshold: 3, now: c.now });

    await gate.evaluate(INPUT); // fail 1
    await gate.evaluate(INPUT); // fail 2 (not yet open)
    expect(gate.breakerState().open).toBe(false);
    expect(gate.breakerState().consecutiveFailures).toBe(2);

    // Provider recovers → a reachable response resets the counter.
    down = false;
    await gate.evaluate(INPUT);
    expect(gate.breakerState().consecutiveFailures).toBe(0);

    // Now two MORE failures shouldn't trip the breaker (counter was reset).
    down = true;
    await gate.evaluate(INPUT);
    await gate.evaluate(INPUT);
    expect(gate.breakerState().open).toBe(false); // only 2 since reset, threshold is 3
  });

  it('breakerThreshold=0 disables the breaker (never short-circuits)', async () => {
    const { provider, calls } = throwingProvider();
    const gate = new UnjustifiedStopGate({ intelligence: provider, breakerThreshold: 0, now: clock().now });
    for (let i = 0; i < 6; i++) {
      const r = await gate.evaluate(INPUT);
      if (!r.ok) expect(r.failure.kind).toBe('llmUnavailable'); // never breakerOpen
    }
    expect(calls()).toBe(6); // every call hit the provider — breaker disabled
    expect(gate.breakerState().open).toBe(false);
  });

  it('a real timeout also counts toward the breaker', async () => {
    let calls = 0;
    const slow: IntelligenceProvider = {
      evaluate: async () => { calls += 1; await new Promise((r) => setTimeout(r, 200)); return 'late'; },
    };
    const gate = new UnjustifiedStopGate({
      intelligence: slow, clientTimeoutMs: 30, breakerThreshold: 2, now: clock().now,
    });
    const r1 = await gate.evaluate(INPUT);
    if (!r1.ok) expect(r1.failure.kind).toBe('timeout');
    await gate.evaluate(INPUT); // 2nd timeout → opens
    expect(gate.breakerState().open).toBe(true);
    const r3 = await gate.evaluate(INPUT);
    if (!r3.ok) expect(r3.failure.kind).toBe('breakerOpen');
    expect(calls).toBe(2); // 3rd call short-circuited (no provider call)
  });
});
