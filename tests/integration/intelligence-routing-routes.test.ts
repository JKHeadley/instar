/**
 * Integration tests for GET /intelligence/routing (per-component framework routing, B1).
 * Spec: docs/specs/per-component-framework-routing.md.
 *
 * Exercises the real Express route over a real IntelligenceRouter: 200 + the resolved
 * routing map when a router is wired (and a config routes sentinels off the default),
 * 503 when intelligence is null OR is a plain provider (not a router).
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
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

function routerRoutingSentinelsToCodex(): IntelligenceRouter {
  return new IntelligenceRouter({
    defaultProvider: fakeProvider('claude'),
    defaultFramework: 'claude-code',
    resolveConfig: () => ({ categories: { sentinel: 'codex-cli' } }),
    buildProvider: () => fakeProvider('codex'),
  });
}

describe('GET /intelligence/routing (integration)', () => {
  it('returns 200 + the resolved routing map when a router is wired', async () => {
    const res = await request(appWith(routerRoutingSentinelsToCodex())).get('/intelligence/routing');
    expect(res.status).toBe(200);
    expect(res.body.defaultFramework).toBe('claude-code');
    expect(Array.isArray(res.body.components)).toBe(true);
    const presence = res.body.components.find((c: any) => c.component === 'PresenceProxy');
    expect(presence).toMatchObject({ category: 'sentinel', framework: 'codex-cli', available: true });
    const reflector = res.body.components.find((c: any) => c.component === 'JobReflector');
    expect(reflector.framework).toBe('claude-code'); // not a sentinel ⇒ default
    expect(res.body.coverage.routedOffDefault).toBeGreaterThan(0);
  });

  it('returns 503 when intelligence is null', async () => {
    const res = await request(appWith(null)).get('/intelligence/routing');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/intelligence router unavailable/i);
  });

  it('returns 503 when intelligence is a plain provider (not a router)', async () => {
    const res = await request(appWith(fakeProvider('claude'))).get('/intelligence/routing');
    expect(res.status).toBe(503);
  });
});
