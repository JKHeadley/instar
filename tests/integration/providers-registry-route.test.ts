/**
 * Integration tests for GET /providers/registry — the real-registry
 * introspection surface for the June-15 live wiring (truth T1).
 *
 * Verifies the route is reachable through the full HTTP pipeline, reflects
 * the ACTUAL module-singleton registry (empty vs registered), and leaks
 * nothing beyond adapter ids + capability flag names (T-04).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { registry } from '../../src/providers/registry.js';
import { registerAnthropicAdapters } from '../../src/providers/bootRegistration.js';

function minimalCtx(): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as never, scheduler: {} as never },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, tokenLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

describe('GET /providers/registry (integration)', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(minimalCtx()));
  });

  afterAll(async () => {
    // Clean the module singleton so other suites in this worker see the
    // pre-test state (unregister is a no-op for absent ids).
    await registry.unregister('anthropic-headless' as never);
    await registry.unregister('anthropic-interactive-pool' as never);
  });

  it('returns 200 with an empty adapter list before registration (alive, not 503)', async () => {
    const res = await request(app).get('/providers/registry');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.adapters)).toBe(true);
    const ids = res.body.adapters.map((a: { id: string }) => a.id);
    expect(ids).not.toContain('anthropic-headless');
    expect(ids).not.toContain('anthropic-interactive-pool');
  });

  it('reflects real registration: both Anthropic adapters with capability flags', async () => {
    const result = await registerAnthropicAdapters({});
    expect(result.skippedReason).toBeUndefined();

    const res = await request(app).get('/providers/registry');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      (res.body.adapters as Array<{ id: string; capabilities: string[] }>).map((a) => [a.id, a]),
    );
    expect(byId['anthropic-headless']).toBeDefined();
    expect(byId['anthropic-interactive-pool']).toBeDefined();
    // Substantive payload: capability flags are real names, not empty.
    expect(byId['anthropic-headless']!.capabilities.length).toBeGreaterThan(0);
    expect(byId['anthropic-interactive-pool']!.capabilities).toContain('one-shot-completion');
    expect(res.body.count).toBeGreaterThanOrEqual(2);
  });

  it('leaks no secrets — payload is ids + capability names + policy flag only (T-04)', async () => {
    const res = await request(app).get('/providers/registry');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['adapters', 'count', 'routingPolicyInstalled']);
    const text = JSON.stringify(res.body);
    // No credential VALUES — capability NAMES legitimately contain words
    // like "credential-storage-provider"; what must never appear is an
    // actual secret (sk-ant-… key material) or env-style token values.
    expect(text).not.toMatch(/sk-ant-[a-zA-Z0-9-]/);
    expect(text).not.toMatch(/Bearer\s/);
  });
});
