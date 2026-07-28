/**
 * Integration tests for the PER-TARGET failure-swap timeout
 * (docs/specs/per-target-swap-timeout-spec.md — fixes gemini-swap-timeout).
 *
 * Wires an IntelligenceRouter EXACTLY like the server construction site
 * (src/commands/server.ts): the layered resolveConfig over the computed default
 * (provider-fallback-default-policy §4.6) plus the three new knobs threaded from
 * a config object with the same `config.intelligence?.*` expressions the server
 * uses. Then exercises the spec's integration scenario end-to-end:
 *
 *  - Fix: the primary (codex, per the computed sentinel default) throws; the
 *    gemini swap target has an 18s per-target cap and an 8.5s-latency stub →
 *    the swap SUCCEEDS (previously killed at the 5s global).
 *  - Regression: NO per-framework config → identical to the existing single-cap
 *    behavior (the same 8.5s stub is abandoned at 5s and the call fails closed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntelligenceRouter, type ComponentFrameworksConfig } from '../../src/core/IntelligenceRouter.js';
import { resolveInternalFrameworkDefault } from '../../src/core/internalFrameworkDefault.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions, InstarConfig } from '../../src/core/types.js';

// A gating call from a SENTINEL component: under the computed default (active set
// codex+gemini+claude) the sentinel category routes to codex-cli — so codex is the
// PRIMARY that fails, and gemini is reached via the failure-swap tail.
const GATING: IntelligenceOptions = { attribution: { component: 'PresenceProxy', gating: true } };

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

/**
 * Build the router the way src/commands/server.ts does: operator did NOT set
 * componentFrameworks (computed default + §4.6 layering, with the live block's
 * failureSwap slot winning), and the four timeout knobs thread from
 * `config.intelligence` with the server's exact expressions — `?? 5000` for the
 * global, UNSET pass-through for the three new fields.
 */
function serverWiredRouter(
  config: Pick<InstarConfig, 'intelligence'>,
  providers: Partial<Record<IntelligenceFramework, IntelligenceProvider>>,
  failureSwap: IntelligenceFramework[],
): IntelligenceRouter {
  const computedDefault = resolveInternalFrameworkDefault(['codex-cli', 'gemini-cli', 'claude-code']);
  const live: ComponentFrameworksConfig = { failureSwap };
  return new IntelligenceRouter({
    defaultProvider: {
      async evaluate() { throw new Error('claude default should not serve in this scenario'); },
    },
    defaultFramework: 'claude-code',
    resolveConfig: () => ({
      ...computedDefault,
      ...live,
      categories: { ...computedDefault.categories },
      ...(live.failureSwap !== undefined ? { failureSwap: live.failureSwap } : {}),
    }),
    buildProvider: (fw) => providers[fw] ?? null,
    // ↓ the server's exact threading expressions (src/commands/server.ts)
    swapAttemptTimeoutMs: config.intelligence?.swapAttemptTimeoutMs ?? 5000,
    swapAttemptTimeoutMsByFramework: config.intelligence?.swapAttemptTimeoutMsByFramework,
    swapAttemptTimeoutMsMax: config.intelligence?.swapAttemptTimeoutMsMax,
    swapTotalBudgetMs: config.intelligence?.swapTotalBudgetMs,
    monotonicNow: () => Date.now(), // fake-timer-driven monotonic stand-in
  });
}

const codexPrimaryDown: IntelligenceProvider = {
  async evaluate() { throw new Error('codex primary down'); },
};

describe('per-target swap timeout — server-wired integration', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('FIX: gemini (8.5s latency) with the recommended 18s per-target cap is served on swap', async () => {
    const gemini = latencyProvider('gemini-answer', 8500);
    const router = serverWiredRouter(
      {
        intelligence: {
          // the operator's opt-in package (FD8) — recommended values from the spec
          swapAttemptTimeoutMsByFramework: { 'gemini-cli': 18000 },
          swapTotalBudgetMs: 40000,
        },
      },
      { 'codex-cli': codexPrimaryDown, 'gemini-cli': gemini },
      ['gemini-cli'],
    );
    const p = router.evaluate('is this an emergency stop?', GATING);
    await vi.advanceTimersByTimeAsync(8500);
    expect(await p).toBe('gemini-answer');
    expect(gemini.sawTimeoutMs).toBe(18000); // per-target cap reached the subprocess bound
  });

  it('REGRESSION: no per-framework config → the flat 5s global still kills the same 8.5s target (byte-identical to today)', async () => {
    const gemini = latencyProvider('gemini-answer', 8500);
    const router = serverWiredRouter(
      { intelligence: {} }, // nothing set — the dark default
      { 'codex-cli': codexPrimaryDown, 'gemini-cli': gemini },
      ['gemini-cli'],
    );
    const p = router.evaluate('is this an emergency stop?', GATING);
    const rejection = expect(p).rejects.toThrow('codex primary down');
    await vi.advanceTimersByTimeAsync(5001);
    await rejection; // abandoned at the 5s global → no targets left → fail closed
    expect(gemini.sawTimeoutMs).toBe(5000); // the global cap, exactly today's behavior
  });

  it('REGRESSION: config.intelligence entirely absent → same single-cap behavior (?? 5000 path)', async () => {
    const gemini = latencyProvider('gemini-answer', 8500);
    const router = serverWiredRouter(
      {}, // no intelligence block at all
      { 'codex-cli': codexPrimaryDown, 'gemini-cli': gemini },
      ['gemini-cli'],
    );
    const p = router.evaluate('x', GATING);
    const rejection = expect(p).rejects.toThrow('codex primary down');
    await vi.advanceTimersByTimeAsync(5001);
    await rejection;
    expect(gemini.sawTimeoutMs).toBe(5000);
  });
});
