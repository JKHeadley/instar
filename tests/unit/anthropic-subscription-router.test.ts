/**
 * Unit tests for AnthropicSubscriptionRouter + InteractivePoolIntelligenceProvider
 * — the intelligence-funnel half of the June-15 interactive-only wiring.
 *
 * Covers BOTH sides of every decision boundary (Testing Integrity Standard):
 * credit unknown / above margin / at margin; auto vs force; primary success
 * vs failure (fallback + degrade); pool errors loud in force mode; the
 * pool provider's option mapping and its no-onUsage contract.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AnthropicSubscriptionRouter,
  type SubscriptionRouteInfo,
  type SubscriptionDegradeInfo,
} from '../../src/core/AnthropicSubscriptionRouter.js';
import { InteractivePoolIntelligenceProvider } from '../../src/core/InteractivePoolIntelligenceProvider.js';
import { decideSdkVsSubscription } from '../../src/providers/costAwareRouting.js';
import { CapabilityFlag } from '../../src/providers/capabilities.js';
import type { ProviderAdapter } from '../../src/providers/registry.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import {
  setClaudeForbidden,
  clearClaudeForbidden,
} from '../../src/core/claudeForbiddenGuard.js';
import type { AgentSdkCreditSnapshot } from '../../src/providers/primitives/observability/usageMeterProvider.js';

afterEach(() => clearClaudeForbidden());

function snapshot(remaining: number, total = 200): AgentSdkCreditSnapshot {
  return { remainingUsd: remaining, totalUsd: total, resetsAt: '2026-07-01T00:00:00Z', overageEnabled: false };
}

function provider(name: string, impl?: (p: string) => Promise<string>): IntelligenceProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    evaluate: vi.fn(async (prompt: string) => {
      calls.push(prompt);
      if (impl) return impl(prompt);
      return `${name}:ok`;
    }),
  };
}

describe('decideSdkVsSubscription (shared pure decision)', () => {
  it('null snapshot → subscription floor', () => {
    expect(decideSdkVsSubscription(null, 0.1).path).toBe('subscription');
  });
  it('at/below margin → subscription floor', () => {
    expect(decideSdkVsSubscription(snapshot(20, 200), 0.1).path).toBe('subscription');
    expect(decideSdkVsSubscription(snapshot(5, 200), 0.1).path).toBe('subscription');
  });
  it('above margin → sdk-credit', () => {
    expect(decideSdkVsSubscription(snapshot(21, 200), 0.1).path).toBe('sdk-credit');
    expect(decideSdkVsSubscription(snapshot(200, 200), 0.1).path).toBe('sdk-credit');
  });
});

describe('AnthropicSubscriptionRouter — auto mode', () => {
  it('routes to the SDK path when credit is healthy', async () => {
    const headless = provider('headless');
    const pool = provider('pool');
    const routes: SubscriptionRouteInfo[] = [];
    const router = new AnthropicSubscriptionRouter({
      headless,
      pool,
      mode: 'auto',
      readSdkCredit: async () => snapshot(150),
      onRoute: (i) => routes.push(i),
    });
    expect(await router.evaluate('judge this')).toBe('headless:ok');
    expect(pool.evaluate).not.toHaveBeenCalled();
    expect(routes[0]?.path).toBe('sdk-credit');
  });

  it('routes to the subscription pool when credit state is unknown (null)', async () => {
    const headless = provider('headless');
    const pool = provider('pool');
    const router = new AnthropicSubscriptionRouter({
      headless,
      pool,
      mode: 'auto',
      readSdkCredit: async () => null,
    });
    expect(await router.evaluate('judge this')).toBe('pool:ok');
    expect(headless.evaluate).not.toHaveBeenCalled();
  });

  it('routes to the subscription pool at/below the safety margin', async () => {
    const headless = provider('headless');
    const pool = provider('pool');
    const router = new AnthropicSubscriptionRouter({
      headless,
      pool,
      mode: 'auto',
      readSdkCredit: async () => snapshot(10, 200),
    });
    expect(await router.evaluate('x')).toBe('pool:ok');
  });

  it('falls back ONCE to the other path on primary failure, reporting degrade', async () => {
    const headless = provider('headless', async () => {
      throw new Error('claude -p exploded');
    });
    const pool = provider('pool');
    const degrades: SubscriptionDegradeInfo[] = [];
    const routes: SubscriptionRouteInfo[] = [];
    const router = new AnthropicSubscriptionRouter({
      headless,
      pool,
      mode: 'auto',
      readSdkCredit: async () => snapshot(150),
      onRoute: (i) => routes.push(i),
      onDegrade: (i) => degrades.push(i),
    });
    expect(await router.evaluate('x', { attribution: { component: 'PromptGate' } })).toBe('pool:ok');
    expect(degrades).toHaveLength(1);
    expect(degrades[0]).toMatchObject({ from: 'sdk-credit', to: 'subscription-pool', component: 'PromptGate' });
    expect(routes.map((r) => r.path)).toEqual(['sdk-credit', 'subscription-pool']);
  });

  it('propagates the fallback error when BOTH paths fail (loud, not silent)', async () => {
    const headless = provider('headless', async () => {
      throw new Error('sdk path down');
    });
    const pool = provider('pool', async () => {
      throw new Error('pool also down');
    });
    const router = new AnthropicSubscriptionRouter({
      headless,
      pool,
      mode: 'auto',
      readSdkCredit: async () => snapshot(150),
    });
    await expect(router.evaluate('x')).rejects.toThrow('pool also down');
  });
});

describe('AnthropicSubscriptionRouter — force mode', () => {
  it('always routes to the pool, never touching the SDK path', async () => {
    const headless = provider('headless');
    const pool = provider('pool');
    const routes: SubscriptionRouteInfo[] = [];
    const router = new AnthropicSubscriptionRouter({
      headless,
      pool,
      mode: 'force',
      readSdkCredit: async () => snapshot(200), // healthy pot must NOT matter
      onRoute: (i) => routes.push(i),
    });
    expect(await router.evaluate('x')).toBe('pool:ok');
    expect(headless.evaluate).not.toHaveBeenCalled();
    expect(routes[0]).toMatchObject({ path: 'subscription-pool', reason: 'forced-subscription-mode' });
  });

  it('pool failures are LOUD — no silent SDK fallback in force mode', async () => {
    const headless = provider('headless');
    const pool = provider('pool', async () => {
      throw new Error('pool allocate timeout');
    });
    const router = new AnthropicSubscriptionRouter({
      headless,
      pool,
      mode: 'force',
      readSdkCredit: async () => snapshot(200),
    });
    await expect(router.evaluate('x')).rejects.toThrow('pool allocate timeout');
    expect(headless.evaluate).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range safetyMarginFraction at construction', () => {
    expect(
      () =>
        new AnthropicSubscriptionRouter({
          headless: provider('h'),
          pool: provider('p'),
          mode: 'auto',
          readSdkCredit: async () => null,
          safetyMarginFraction: 1.5,
        }),
    ).toThrow(/safetyMarginFraction/);
  });
});

function fakePoolAdapter(
  evaluate: (prompt: string, options?: unknown) => Promise<{ text: string; usage: null }>,
): ProviderAdapter {
  return {
    id: 'anthropic-interactive-pool' as ProviderAdapter['id'],
    capabilities: {} as ProviderAdapter['capabilities'],
    primitive(cap: CapabilityFlag): unknown {
      if (cap === CapabilityFlag.OneShotCompletion) {
        return { capability: CapabilityFlag.OneShotCompletion, evaluate };
      }
      throw new Error(`unexpected capability: ${cap}`);
    },
  };
}

describe('InteractivePoolIntelligenceProvider', () => {
  it('returns the pool one-shot text and maps timeout/model options', async () => {
    const seen: unknown[] = [];
    const adapter = fakePoolAdapter(async (_p, options) => {
      seen.push(options);
      return { text: 'pool answer', usage: null };
    });
    const provider = new InteractivePoolIntelligenceProvider(adapter);
    const out = await provider.evaluate('judge', { model: 'fast', timeoutMs: 5_000 });
    expect(out).toBe('pool answer');
    expect(seen[0]).toMatchObject({ model: 'fast', timeoutMs: 5_000 });
  });

  it('NEVER invokes onUsage (pool cannot report per-call tokens — absent is honest)', async () => {
    const adapter = fakePoolAdapter(async () => ({ text: 'ok', usage: null }));
    const provider = new InteractivePoolIntelligenceProvider(adapter);
    const onUsage = vi.fn();
    await provider.evaluate('x', { onUsage });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('propagates pool errors loudly', async () => {
    const adapter = fakePoolAdapter(async () => {
      throw new Error('did not reach ready state in 30s');
    });
    const provider = new InteractivePoolIntelligenceProvider(adapter);
    await expect(provider.evaluate('x')).rejects.toThrow('ready state');
  });

  it('refuses construction on a codex-only agent (claudeForbidden parity)', () => {
    setClaudeForbidden('codex-only test');
    expect(() => new InteractivePoolIntelligenceProvider(fakePoolAdapter(async () => ({ text: '', usage: null })))).toThrow(
      /forbidden/i,
    );
  });
});
