/**
 * Resilient Degradation Ladder (docs/specs/resilient-degradation-ladder.md) — the
 * path-dependent ladder in IntelligenceRouter. Both sides of each decision boundary.
 */
import { describe, it, expect } from 'vitest';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const LADDER = {
  gatingLadderBudgetMs: 6000,
  backoffEnabled: true,
  backoff: { baseMs: 100, factor: 2, maxAttempts: 3, ceilingMs: 800, maxWaitMs: 60000 },
};
function rle(msg = 'rate limited'): Error {
  const e = new Error(msg);
  e.name = 'RateLimitError';
  return e;
}
const DEFERRABLE: IntelligenceOptions = { attribution: { component: 'Sentinel', deferrable: true } };
const GATING: IntelligenceOptions = { attribution: { component: 'Gate', gating: true } };

describe('Resilient Degradation Ladder — IntelligenceRouter', () => {
  it('deferrable backoff: retries the SAME provider on a rate-limit (sets rateLimitWaitMs) and succeeds', async () => {
    let calls = 0;
    const primary: IntelligenceProvider = {
      async evaluate(_p: string, opts?: IntelligenceOptions) {
        calls++;
        if (calls === 1) throw rle(); // first attempt rate-limited
        expect(opts?.rateLimitWaitMs).toBeGreaterThan(0); // backoff set the wait
        return 'ok-after-backoff';
      },
    };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({}), buildProvider: () => null, ladder: LADDER,
    });
    expect(await router.evaluate('x', DEFERRABLE)).toBe('ok-after-backoff');
    expect(calls).toBe(2);
  });

  it('deferrable backoff exhausted → framework-swap', async () => {
    const primary: IntelligenceProvider = { async evaluate() { throw rle(); } }; // always rate-limited
    const swap: IntelligenceProvider = { async evaluate() { return 'swap-result'; } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw: IntelligenceFramework) => (fw === 'codex-cli' ? swap : null),
      ladder: LADDER,
    });
    expect(await router.evaluate('x', DEFERRABLE)).toBe('swap-result');
  });

  it('gating: NO backoff — fails closed without retrying the primary', async () => {
    let calls = 0;
    const primary: IntelligenceProvider = { async evaluate() { calls++; throw rle(); } };
    const swap: IntelligenceProvider = { async evaluate() { throw new Error('swap down'); } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw: IntelligenceFramework) => (fw === 'codex-cli' ? swap : null),
      ladder: LADDER,
    });
    await expect(router.evaluate('x', GATING)).rejects.toThrow();
    expect(calls).toBe(1); // gating did NOT backoff-retry the primary
  });

  it('gating budget consumed → stops swapping (fail closed) before trying all targets', async () => {
    const primary: IntelligenceProvider = { async evaluate() { throw rle(); } };
    const slowSwap: IntelligenceProvider = {
      async evaluate() { await new Promise((r) => setTimeout(r, 25)); throw new Error('slow swap down'); },
    };
    const second = { reached: false, async evaluate() { this.reached = true; return 'should-not-run'; } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli', 'gemini-cli'] }),
      buildProvider: (fw: IntelligenceFramework) =>
        fw === 'codex-cli' ? slowSwap : fw === 'gemini-cli' ? (second as unknown as IntelligenceProvider) : null,
      ladder: { ...LADDER, gatingLadderBudgetMs: 5 }, // tiny budget — consumed by the first slow swap
    });
    await expect(router.evaluate('x', GATING)).rejects.toThrow();
    expect(second.reached).toBe(false); // budget consumed → second swap target not attempted
  });

  it("non-gating non-deferrable: today's behavior — throws, no backoff, no swap", async () => {
    let calls = 0;
    const primary: IntelligenceProvider = { async evaluate() { calls++; throw rle(); } };
    const swap = { reached: false, async evaluate() { this.reached = true; return 'x'; } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: () => swap as unknown as IntelligenceProvider, ladder: LADDER,
    });
    await expect(router.evaluate('x', { attribution: { component: 'X' } })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(swap.reached).toBe(false); // no swap for a plain advisory call
  });

  it('gating dominates deferrable: a gating+deferrable call gets NO backoff', async () => {
    let calls = 0;
    const primary: IntelligenceProvider = { async evaluate() { calls++; throw rle(); } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({}), buildProvider: () => null, ladder: LADDER,
    });
    await expect(
      router.evaluate('x', { attribution: { component: 'X', gating: true, deferrable: true } }),
    ).rejects.toThrow();
    expect(calls).toBe(1); // gating dominates → no backoff retry
  });

  it('backoff only on a rate-limit: a HARD error skips backoff and goes to swap', async () => {
    let calls = 0;
    const primary: IntelligenceProvider = { async evaluate() { calls++; throw new Error('hard failure'); } };
    const swap: IntelligenceProvider = { async evaluate() { return 'swap'; } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw: IntelligenceFramework) => (fw === 'codex-cli' ? swap : null),
      ladder: LADDER,
    });
    expect(await router.evaluate('x', DEFERRABLE)).toBe('swap');
    expect(calls).toBe(1); // no backoff retries on a non-rate-limit error
  });

  it('ladder absent ⇒ exactly today behavior (deferrable call just throws, no backoff)', async () => {
    let calls = 0;
    const primary: IntelligenceProvider = { async evaluate() { calls++; throw rle(); } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({}), buildProvider: () => null, // no ladder
    });
    await expect(router.evaluate('x', DEFERRABLE)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('Resilient Degradation Ladder — never-silent hooks (§4)', () => {
  it('onResolved fires on a successful call with (component, framework)', async () => {
    const resolved: Array<[string, string]> = [];
    const primary: IntelligenceProvider = { async evaluate() { return 'ok'; } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({}), buildProvider: () => null,
      onResolved: (c, f) => resolved.push([c, f]),
    });
    await router.evaluate('x', { attribution: { component: 'Comp' } });
    expect(resolved).toEqual([['Comp', 'claude-code']]);
  });

  it('onHeuristicFallthrough fires when a NON-gating call exhausts (caller will use its heuristic)', async () => {
    const fell: Array<[string, string]> = [];
    const primary: IntelligenceProvider = { async evaluate() { throw new Error('down'); } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({}), buildProvider: () => null,
      onHeuristicFallthrough: (c, f) => fell.push([c, f]),
    });
    await expect(router.evaluate('x', { attribution: { component: 'Adv' } })).rejects.toThrow();
    expect(fell).toEqual([['Adv', 'claude-code']]);
  });

  it('onHeuristicFallthrough does NOT fire for a GATING call (fail closed is not a heuristic)', async () => {
    const fell: Array<[string, string]> = [];
    const primary: IntelligenceProvider = { async evaluate() { throw new Error('down'); } };
    const swap: IntelligenceProvider = { async evaluate() { throw new Error('swap down'); } };
    const router = new IntelligenceRouter({
      defaultProvider: primary, defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw: IntelligenceFramework) => (fw === 'codex-cli' ? swap : null),
      onHeuristicFallthrough: (c, f) => fell.push([c, f]),
    });
    await expect(router.evaluate('x', GATING)).rejects.toThrow();
    expect(fell).toEqual([]); // gating → fail closed, never a heuristic-fallthrough
  });
});
