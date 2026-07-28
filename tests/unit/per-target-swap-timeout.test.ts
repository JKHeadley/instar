/**
 * Unit tests for the PER-TARGET failure-swap timeout
 * (docs/specs/per-target-swap-timeout-spec.md — fixes gemini-swap-timeout).
 *
 * Covers the spec's test plan:
 *  - resolveSwapCap contract: per-framework valid value used; present-but-INVALID
 *    (0, -1, NaN, Infinity, "18000" string) FALLS THROUGH to global (not no-cap,
 *    not immediate-fire); unknown key → global; unset map → global; global
 *    ≤0/unset → undefined; clamp to maxCap; invalid maxCap → 120s default.
 *  - The gemini fix: an 8.5s-latency target with an 18s per-target cap SUCCEEDS
 *    (previously killed at the 5s global); regression without the map → killed at 5s.
 *  - FD6 total budget: clamps each IN-FLIGHT attempt (worst-case tail ≤ budget);
 *    falls closed when remaining ≤ 250ms; UNSET → no enforcement; invalid → unset;
 *    a sub-250ms budget disables swapping fail-SAFE; bounds an un-capped attempt.
 *  - FD7 timer hygiene: a fast success clears the pending timeout timer.
 *  - Wiring: router opts carry all three new fields; server threads them from config.
 *  - Unknown-key hygiene: a stray byFramework key warns once and has no effect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { IntelligenceRouter, resolveSwapCap } from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const GATING: IntelligenceOptions = { attribution: { component: 'ExternalOperationGate', gating: true } };

function throwingProvider(msg = 'down'): IntelligenceProvider {
  return { async evaluate() { throw new Error(msg); } };
}

/** A provider that NEVER resolves — a slow-but-not-erroring target. Records the timeoutMs it saw. */
function slowProvider(): IntelligenceProvider & { sawTimeoutMs: number | undefined; called: boolean } {
  return {
    sawTimeoutMs: undefined,
    called: false,
    evaluate(this: { sawTimeoutMs?: number; called: boolean }, _p: string, opts?: IntelligenceOptions) {
      this.called = true;
      this.sawTimeoutMs = opts?.timeoutMs;
      return new Promise<string>(() => { /* hang forever */ });
    },
  };
}

/** A provider that resolves after `latencyMs` (fake-timer setTimeout). Records the timeoutMs it saw. */
function latencyProvider(label: string, latencyMs: number): IntelligenceProvider & { sawTimeoutMs: number | undefined } {
  return {
    sawTimeoutMs: undefined,
    evaluate(this: { sawTimeoutMs?: number }, _p: string, opts?: IntelligenceOptions) {
      this.sawTimeoutMs = opts?.timeoutMs;
      return new Promise<string>((res) => { setTimeout(() => res(label), latencyMs); });
    },
  };
}

describe('resolveSwapCap — exact contract (FD5/FD7)', () => {
  const BY: Partial<Record<IntelligenceFramework, number>> = { 'gemini-cli': 18000 };

  it('a VALID per-framework value is used for that target', () => {
    expect(resolveSwapCap('gemini-cli', 5000, BY, undefined)).toBe(18000);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['string "18000"', '18000' as unknown as number],
  ])('a present-but-INVALID per-framework value (%s) FALLS THROUGH to the global — never no-cap, never 0ms', (_name, bad) => {
    const by = { 'gemini-cli': bad } as Partial<Record<IntelligenceFramework, number>>;
    expect(resolveSwapCap('gemini-cli', 5000, by, undefined)).toBe(5000);
  });

  it('a target NOT in the map falls through to the global', () => {
    expect(resolveSwapCap('codex-cli', 5000, BY, undefined)).toBe(5000);
  });

  it('unset map → global; global unset → undefined (no cap, today\'s behavior)', () => {
    expect(resolveSwapCap('gemini-cli', 5000, undefined, undefined)).toBe(5000);
    expect(resolveSwapCap('gemini-cli', undefined, undefined, undefined)).toBeUndefined();
  });

  it('global ≤0 (invalid) with no per-framework value → undefined (no cap)', () => {
    expect(resolveSwapCap('gemini-cli', 0, undefined, undefined)).toBeUndefined();
    expect(resolveSwapCap('gemini-cli', -5, undefined, undefined)).toBeUndefined();
  });

  it('an INVALID per-framework value with an unset/invalid global → undefined (falls through the whole chain)', () => {
    const by = { 'gemini-cli': 0 } as Partial<Record<IntelligenceFramework, number>>;
    expect(resolveSwapCap('gemini-cli', undefined, by, undefined)).toBeUndefined();
    expect(resolveSwapCap('gemini-cli', 0, by, undefined)).toBeUndefined();
  });

  it('the resolved cap is clamped to maxCap (per-attempt clamp)', () => {
    const by = { 'codex-cli': 500000 } as Partial<Record<IntelligenceFramework, number>>;
    expect(resolveSwapCap('codex-cli', 5000, by, 120000)).toBe(120000);
    // global route clamps too
    expect(resolveSwapCap('pi-cli', 300000, undefined, 120000)).toBe(120000);
  });

  it('an INVALID maxCap (0 / NaN / negative) → the 120s default clamp', () => {
    const by = { 'codex-cli': 500000 } as Partial<Record<IntelligenceFramework, number>>;
    expect(resolveSwapCap('codex-cli', 5000, by, 0)).toBe(120000);
    expect(resolveSwapCap('codex-cli', 5000, by, NaN)).toBe(120000);
    expect(resolveSwapCap('codex-cli', 5000, by, -1)).toBe(120000);
    // a valid small value below the default is NOT clamped
    expect(resolveSwapCap('gemini-cli', 5000, { 'gemini-cli': 18000 }, undefined)).toBe(18000);
  });
});

describe('the gemini fix — per-target cap gives a slow-but-honest target its measured time', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('an 8.5s-latency gemini target with an 18s per-target cap SUCCEEDS (was killed at the 5s global)', async () => {
    const gemini = latencyProvider('gemini', 8500);
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['gemini-cli'] }),
      buildProvider: (fw) => (fw === 'gemini-cli' ? gemini : null),
      swapAttemptTimeoutMs: 5000,
      swapAttemptTimeoutMsByFramework: { 'gemini-cli': 18000 },
    });
    const p = router.evaluate('x', GATING);
    await vi.advanceTimersByTimeAsync(8500);
    expect(await p).toBe('gemini');
    // the PER-TARGET cap (not the 5s global) flowed through as the provider timeoutMs
    expect(gemini.sawTimeoutMs).toBe(18000);
  });

  it('REGRESSION: with no per-framework map the same target is killed at the 5s global (today\'s behavior)', async () => {
    const gemini = latencyProvider('gemini', 8500);
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['gemini-cli'] }),
      buildProvider: (fw) => (fw === 'gemini-cli' ? gemini : null),
      swapAttemptTimeoutMs: 5000,
    });
    const p = router.evaluate('x', GATING);
    const rejection = expect(p).rejects.toThrow('claude down');
    await vi.advanceTimersByTimeAsync(5001);
    await rejection; // gemini abandoned at 5s → no targets left → original error rethrows
    expect(gemini.sawTimeoutMs).toBe(5000);
  });
});

describe('FD6 total swap budget (swapTotalBudgetMs)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Date.now is faked by vi.useFakeTimers and advances with advanceTimersByTimeAsync,
  // giving a deterministic stand-in for the monotonic clock in tests.
  const fakeMonotonic = () => Date.now();

  it('the budget clamps an IN-FLIGHT attempt: an attempt admitted under a smaller remainder gets min(cap, remaining)', async () => {
    const codex = slowProvider();
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw) => (fw === 'codex-cli' ? codex : null),
      swapAttemptTimeoutMs: 5000,
      swapAttemptTimeoutMsByFramework: { 'codex-cli': 45000 },
      swapTotalBudgetMs: 10000,
      monotonicNow: fakeMonotonic,
    });
    const p = router.evaluate('x', GATING);
    const rejection = expect(p).rejects.toThrow('claude down');
    await vi.advanceTimersByTimeAsync(10001);
    await rejection;
    // NOT the full 45s per-target cap — clamped to the 10s budget remainder.
    expect(codex.sawTimeoutMs).toBe(10000);
  });

  it('worst-case swap-tail latency is literally ≤ swapTotalBudgetMs across multiple attempts', async () => {
    const slow1 = slowProvider();
    const slow2 = slowProvider();
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli', 'gemini-cli'] }),
      buildProvider: (fw) => (fw === 'codex-cli' ? slow1 : fw === 'gemini-cli' ? slow2 : null),
      swapAttemptTimeoutMs: 5000,
      swapTotalBudgetMs: 6000,
      monotonicNow: fakeMonotonic,
    });
    let settledAt: number | undefined;
    const start = Date.now();
    const p = router.evaluate('x', GATING).catch(() => { settledAt = Date.now(); });
    // attempt 1: cap = min(5000, 6000) = 5000; attempt 2: remaining 1000 → cap 1000.
    await vi.advanceTimersByTimeAsync(6001);
    await p;
    expect(slow1.sawTimeoutMs).toBe(5000);
    expect(slow2.sawTimeoutMs).toBe(1000); // the in-flight clamp, not the full 5s cap
    expect(settledAt! - start).toBeLessThanOrEqual(6000 + 1); // tail ≤ budget
  });

  it('falls closed when the remaining budget is ≤ the 250ms floor — a viable later target is NOT admitted', async () => {
    const slow = slowProvider();
    const fast = { calls: 0, async evaluate() { this.calls++; return 'pi'; } };
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli', 'pi-cli'] }),
      buildProvider: (fw) =>
        fw === 'codex-cli' ? slow : fw === 'pi-cli' ? (fast as unknown as IntelligenceProvider) : null,
      swapAttemptTimeoutMs: 5000,
      swapTotalBudgetMs: 5200, // attempt 1 burns 5000 → remaining 200 ≤ 250 → stop
      monotonicNow: fakeMonotonic,
    });
    const p = router.evaluate('x', GATING);
    const rejection = expect(p).rejects.toThrow('claude down');
    await vi.advanceTimersByTimeAsync(5201);
    await rejection;
    expect(fast.calls).toBe(0); // loop fell closed instead of admitting a 200ms attempt
  });

  it('REGRESSION: budget UNSET → no enforcement; tail identical to per-cap-only behavior', async () => {
    const slow1 = slowProvider();
    const slow2 = slowProvider();
    const fast = { calls: 0, async evaluate() { this.calls++; return 'pi'; } };
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli', 'gemini-cli', 'pi-cli'] }),
      buildProvider: (fw) =>
        fw === 'codex-cli' ? slow1 : fw === 'gemini-cli' ? slow2 : fw === 'pi-cli' ? (fast as unknown as IntelligenceProvider) : null,
      swapAttemptTimeoutMs: 5000,
      // swapTotalBudgetMs deliberately UNSET
      monotonicNow: fakeMonotonic,
    });
    const p = router.evaluate('x', GATING);
    await vi.advanceTimersByTimeAsync(10001); // 2 × 5s abandonments, then pi serves
    expect(await p).toBe('pi');
    expect(slow1.sawTimeoutMs).toBe(5000);
    expect(slow2.sawTimeoutMs).toBe(5000); // full cap — no budget clamp
    expect(fast.calls).toBe(1);
  });

  it('an INVALID budget (0 / NaN / negative) is treated as unset — no enforcement', async () => {
    for (const bad of [0, NaN, -100]) {
      const slow = slowProvider();
      const fast = { async evaluate() { return 'pi'; } };
      const router = new IntelligenceRouter({
        defaultProvider: throwingProvider('claude down'),
        defaultFramework: 'claude-code',
        resolveConfig: () => ({ failureSwap: ['codex-cli', 'pi-cli'] }),
        buildProvider: (fw) =>
          fw === 'codex-cli' ? slow : fw === 'pi-cli' ? (fast as unknown as IntelligenceProvider) : null,
        swapAttemptTimeoutMs: 5000,
        swapTotalBudgetMs: bad,
        monotonicNow: fakeMonotonic,
      });
      const p = router.evaluate('x', GATING);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await p).toBe('pi'); // no budget stop — the swap proceeded past the slow target
      expect(slow.sawTimeoutMs).toBe(5000); // no budget clamp on the attempt either
    }
  });

  it('a sub-250ms budget passes validation but disables swapping on the FIRST attempt (fail-SAFE, never fail-open)', async () => {
    const slow = slowProvider();
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw) => (fw === 'codex-cli' ? slow : null),
      swapAttemptTimeoutMs: 5000,
      swapTotalBudgetMs: 200, // valid (>0) but below the 250ms floor
      monotonicNow: fakeMonotonic,
    });
    await expect(router.evaluate('x', GATING)).rejects.toThrow('claude down');
    expect(slow.called).toBe(false); // no attempt was admitted at all
  });

  it('the budget bounds even an UN-capped attempt (global unset ⇒ cap = remaining budget)', async () => {
    const slow = slowProvider();
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw) => (fw === 'codex-cli' ? slow : null),
      // no swapAttemptTimeoutMs at all (legacy unbounded router construction)
      swapTotalBudgetMs: 3000,
      monotonicNow: fakeMonotonic,
    });
    const p = router.evaluate('x', GATING);
    const rejection = expect(p).rejects.toThrow('claude down');
    await vi.advanceTimersByTimeAsync(3001);
    await rejection;
    expect(slow.sawTimeoutMs).toBe(3000); // the budget remainder became the attempt cap
  });
});

describe('FD7 timer hygiene — the timeout timer is cleared on settle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a fast swap success leaves NO pending timer (no leak per call)', async () => {
    const fast = { async evaluate() { return 'codex'; } };
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw) => (fw === 'codex-cli' ? (fast as unknown as IntelligenceProvider) : null),
      swapAttemptTimeoutMs: 5000,
    });
    expect(await router.evaluate('x', GATING)).toBe('codex');
    // Before FD7 a pending 5s reject timer leaked here on every fast success.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('wiring — router opts carry the three new fields; server threads them from config', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('all three fields take effect end-to-end through the router opts (maxCap clamps a per-target cap)', async () => {
    const slow = slowProvider();
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude down'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['gemini-cli'] }),
      buildProvider: (fw) => (fw === 'gemini-cli' ? slow : null),
      swapAttemptTimeoutMs: 5000,
      swapAttemptTimeoutMsByFramework: { 'gemini-cli': 300000 }, // typo'd huge cap
      swapAttemptTimeoutMsMax: 7000, // clamp wins
      swapTotalBudgetMs: 40000,
      monotonicNow: () => Date.now(),
    });
    const p = router.evaluate('x', GATING);
    const rejection = expect(p).rejects.toThrow('claude down');
    await vi.advanceTimersByTimeAsync(7001);
    await rejection;
    expect(slow.sawTimeoutMs).toBe(7000); // clamped, not 300000
  });

  it('server.ts threads all three fields from config.intelligence into the router opts', () => {
    const src = readFileSync(join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(src).toContain('swapAttemptTimeoutMsByFramework: config.intelligence?.swapAttemptTimeoutMsByFramework');
    expect(src).toContain('swapAttemptTimeoutMsMax: config.intelligence?.swapAttemptTimeoutMsMax');
    expect(src).toContain('swapTotalBudgetMs: config.intelligence?.swapTotalBudgetMs');
  });
});

describe('unknown-key hygiene', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a stray byFramework key warns ONCE and has no effect (targets fall through to the global)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fast = { async evaluate() { return 'codex'; } };
      const router = new IntelligenceRouter({
        defaultProvider: throwingProvider('claude down'),
        defaultFramework: 'claude-code',
        resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
        buildProvider: (fw) => (fw === 'codex-cli' ? (fast as unknown as IntelligenceProvider) : null),
        swapAttemptTimeoutMs: 5000,
        swapAttemptTimeoutMsByFramework: { 'cursor-cli': 10000 } as never,
      });
      expect(await router.evaluate('x', GATING)).toBe('codex');
      expect(await router.evaluate('x', GATING)).toBe('codex'); // second swap pass
      const unknownKeyWarns = warn.mock.calls.filter((c) => String(c[0]).includes("unknown framework key 'cursor-cli'"));
      expect(unknownKeyWarns).toHaveLength(1); // once, not per call
    } finally {
      warn.mockRestore();
    }
  });
});
