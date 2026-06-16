/**
 * Integration tests for the provider-fallback DEFAULT POLICY surfaced through
 * GET /intelligence/routing (docs/specs/provider-fallback-default-policy.md §7).
 *
 * Exercises the real Express route over a real IntelligenceRouter wired with the
 * COMPUTED DEFAULT (no operator componentFrameworks). On a codex-active agent the
 * sentinel/gate/reflector components resolve to the first active off-Claude framework
 * (codex-cli), while `job` stays on the agent default — and a claude-only agent is a
 * no-op (everything stays on the default framework).
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import { resolveInternalFrameworkDefault } from '../../src/core/internalFrameworkDefault.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

function fakeProvider(label: string): IntelligenceProvider {
  return { async evaluate() { return label; } };
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
 * Router wired exactly like the server construction site (§4.6): operator did NOT set
 * componentFrameworks, so resolveConfig returns the computed default for the given
 * active-set. providers built for off-Claude frameworks are available.
 */
function routerWithComputedDefault(activeSet: IntelligenceFramework[]): IntelligenceRouter {
  const computedDefault = resolveInternalFrameworkDefault(activeSet);
  const built: Partial<Record<IntelligenceFramework, IntelligenceProvider>> = {
    'codex-cli': fakeProvider('codex'),
    'gemini-cli': fakeProvider('gemini'),
  };
  return new IntelligenceRouter({
    defaultProvider: fakeProvider('claude'),
    defaultFramework: 'claude-code',
    resolveConfig: () => computedDefault,
    buildProvider: (fw) => built[fw] ?? null,
    swapAttemptTimeoutMs: 5000,
  });
}

describe('GET /intelligence/routing — provider-fallback default policy (integration)', () => {
  it('codex-active agent: sentinel/gate/reflector → codex-cli; job → agent default', async () => {
    const router = routerWithComputedDefault(['codex-cli', 'gemini-cli', 'claude-code']);
    const res = await request(appWith(router)).get('/intelligence/routing');
    expect(res.status).toBe(200);
    expect(res.body.defaultFramework).toBe('claude-code');

    const byComponent = (name: string) =>
      res.body.components.find((c: any) => c.component === name);

    // a sentinel, a gate, and a reflector all route to the first active off-Claude fw.
    expect(byComponent('PresenceProxy')).toMatchObject({ category: 'sentinel', framework: 'codex-cli', available: true });
    expect(byComponent('PromptGate')).toMatchObject({ category: 'gate', framework: 'codex-cli', available: true });
    expect(byComponent('JobReflector')).toMatchObject({ category: 'reflector', framework: 'codex-cli', available: true });

    // a `job` component STAYS on the agent default (job is EXCLUDED from the default).
    const sweep = byComponent('CartographerSweep');
    expect(sweep).toMatchObject({ category: 'job', framework: 'claude-code' });

    expect(res.body.coverage.routedOffDefault).toBeGreaterThan(0);
  });

  it('claude-only agent: computed default is a no-op — everything stays on claude-code', async () => {
    const router = routerWithComputedDefault(['claude-code']);
    const res = await request(appWith(router)).get('/intelligence/routing');
    expect(res.status).toBe(200);
    const sentinel = res.body.components.find((c: any) => c.component === 'PresenceProxy');
    expect(sentinel).toMatchObject({ category: 'sentinel', framework: 'claude-code' });
    expect(res.body.coverage.routedOffDefault).toBe(0);
  });

  it('codex-missing agent: primary falls to the next active link (gemini), not claude', async () => {
    const router = routerWithComputedDefault(['gemini-cli', 'claude-code']);
    const res = await request(appWith(router)).get('/intelligence/routing');
    expect(res.status).toBe(200);
    const sentinel = res.body.components.find((c: any) => c.component === 'PresenceProxy');
    expect(sentinel).toMatchObject({ category: 'sentinel', framework: 'gemini-cli', available: true });
  });
});
