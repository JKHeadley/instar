/**
 * Integration tests for the NON-GATING failure-swap wired through a production-shaped
 * router + the GET /intelligence/routing surface (docs/specs/nongating-failure-swap.md).
 *
 * The feature is runtime behavior (not a new route), so this exercises:
 *  1. REGRESSION: GET /intelligence/routing is UNCHANGED by the feature (it changes runtime
 *     swap behavior, never framework RESOLUTION) — the computed default still resolves as before.
 *  2. BEHAVIOR: a real non-gating call through a router wired exactly like the server construction
 *     site (computed default + nonGatingFailureSwap enabled) SWAPS when the primary invocation
 *     fails, instead of hard-erroring — and with { enabled:false } it keeps today's behavior.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import { resolveInternalFrameworkDefault } from '../../src/core/internalFrameworkDefault.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const NON_GATING: IntelligenceOptions = { attribution: { component: 'TopicIntentExtractor' } };

function okProvider(label: string): IntelligenceProvider & { calls: number } {
  return {
    calls: 0,
    async evaluate() { this.calls++; return label; },
  } as IntelligenceProvider & { calls: number };
}
function invocationFailProvider(msg = 'codex exec failed'): IntelligenceProvider {
  return { async evaluate() { throw new Error(msg); } };
}

function ctxWith(intelligence: IntelligenceProvider | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    intelligence,
    startTime: new Date(),
  } as unknown as RouteContext;
}
function appWith(intelligence: IntelligenceProvider | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(intelligence)));
  return app;
}

/**
 * Router wired like the server construction site (§4.6 computed default) PLUS the
 * nonGatingFailureSwap field. `providers` overrides the built off-Claude providers so a
 * test can make the primary fail.
 */
function productionShapedRouter(opts: {
  activeSet: IntelligenceFramework[];
  providers?: Partial<Record<IntelligenceFramework, IntelligenceProvider>>;
  nonGatingEnabled: boolean;
}): IntelligenceRouter {
  const computedDefault = resolveInternalFrameworkDefault(opts.activeSet);
  const built: Partial<Record<IntelligenceFramework, IntelligenceProvider>> = {
    'codex-cli': okProvider('codex'),
    'pi-cli': okProvider('pi'),
    'gemini-cli': okProvider('gemini'),
    ...(opts.providers ?? {}),
  };
  return new IntelligenceRouter({
    defaultProvider: okProvider('claude'),
    defaultFramework: 'claude-code',
    resolveConfig: () => computedDefault,
    buildProvider: (fw) => built[fw] ?? null,
    swapAttemptTimeoutMs: 5000,
    nonGatingFailureSwap: { enabled: opts.nonGatingEnabled },
  });
}

describe('non-gating failure-swap — routing surface regression (integration)', () => {
  it('GET /intelligence/routing is UNCHANGED by the feature (resolution, not swap)', async () => {
    const router = productionShapedRouter({ activeSet: ['codex-cli', 'gemini-cli', 'claude-code'], nonGatingEnabled: true });
    const res = await request(appWith(router)).get('/intelligence/routing');
    expect(res.status).toBe(200);
    const byComponent = (name: string) => res.body.components.find((c: any) => c.component === name);
    // Same resolution as the base provider-fallback policy — the non-gating swap does not move it.
    expect(byComponent('PresenceProxy')).toMatchObject({ category: 'sentinel', framework: 'codex-cli' });
    expect(byComponent('TopicIntentExtractor')).toMatchObject({ framework: 'codex-cli', available: true });
    expect(res.body.coverage.routedOffDefault).toBeGreaterThan(0);
  });
});

describe('non-gating failure-swap — behavior through a production-shaped router (integration)', () => {
  it('non-gating primary invocation failure SWAPS to the next active off-Claude framework', async () => {
    const pi = okProvider('pi');
    const router = productionShapedRouter({
      activeSet: ['codex-cli', 'pi-cli', 'gemini-cli', 'claude-code'],
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGatingEnabled: true,
    });
    const result = await router.evaluate('classify this', NON_GATING);
    expect(result).toBe('pi'); // served by the swap instead of hard-erroring (the 28% class)
    expect(pi.calls).toBe(1);
  });

  it('with { enabled:false } the same non-gating failure hard-errors (today\'s behavior)', async () => {
    const pi = okProvider('pi');
    const router = productionShapedRouter({
      activeSet: ['codex-cli', 'pi-cli', 'gemini-cli', 'claude-code'],
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGatingEnabled: false,
    });
    await expect(router.evaluate('classify this', NON_GATING)).rejects.toThrow('codex exec failed');
    expect(pi.calls).toBe(0);
  });
});
