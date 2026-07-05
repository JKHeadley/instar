/**
 * Integration tests for GET /intelligence/routing/chains — the read-only nature-axis
 * routing MAP surface (FD11 readable canary, docs/specs/nature-axis-routing.md).
 *
 * Exercises the real Express route over a real IntelligenceRouter:
 *  - 200 + the full routing map (the Tier-3 "feature is alive" test — the single most
 *    important test: the route returns the map, not 503, when mounted in the server path);
 *  - the `?trace=<component>` drill-down + a 404 for an unknown component;
 *  - 503 when intelligence is null OR a plain provider (not a router) — the sibling shape;
 *  - PURITY: the route performs no writes and mutates no config across calls.
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

describe('GET /intelligence/routing/chains (integration)', () => {
  it('returns 200 + the full routing map when a router is wired (alive test)', async () => {
    const res = await request(appWith(routerRoutingSentinelsToCodex())).get('/intelligence/routing/chains');
    expect(res.status).toBe(200);
    expect(res.body.defaultFramework).toBe('claude-code');
    // Doors + the four chains are present.
    expect(res.body.doors.cli).toEqual(expect.arrayContaining(['claude-code', 'codex-cli', 'pi-cli', 'gemini-cli']));
    expect(res.body.doors.metered).toEqual(expect.arrayContaining(['gemini-api', 'openrouter-api', 'groq-api']));
    expect(Array.isArray(res.body.chains)).toBe(true);
    expect(res.body.chains.map((c: any) => c.chain)).toEqual(['FAST', 'SORT', 'JUDGE', 'WRITE']);

    // A known critical gate resolves to its JUDGE chain with concrete model ids + flags.
    const tone = res.body.components.find((c: any) => c.component === 'MessagingToneGate');
    expect(tone).toMatchObject({ nature: 'B', chain: 'JUDGE', criticalGate: true, untrustedInput: true });
    expect(tone.enforcedFramework).toBe('claude-code'); // gate category ⇒ default framework here
    expect(tone.route.length).toBeGreaterThan(0);
    expect(tone.route[0]).toHaveProperty('modelId');
    expect(tone.route[0]).toHaveProperty('door');

    // A sentinel routed off default reflects the live enforced framework.
    const presence = res.body.components.find((c: any) => c.component === 'PresenceProxy');
    expect(presence.enforcedFramework).toBe('codex-cli');
  });

  it('supports ?trace=<component> and 404s an unknown component', async () => {
    const app = appWith(routerRoutingSentinelsToCodex());
    const ok = await request(app).get('/intelligence/routing/chains?trace=MessagingToneGate');
    expect(ok.status).toBe(200);
    expect(ok.body.trace.component).toBe('MessagingToneGate');
    expect(ok.body.trace.chain).toBe('JUDGE');

    const missing = await request(app).get('/intelligence/routing/chains?trace=__nope__');
    expect(missing.status).toBe(404);
  });

  it('returns 503 when intelligence is null', async () => {
    const res = await request(appWith(null)).get('/intelligence/routing/chains');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/intelligence router unavailable/i);
  });

  it('returns 503 when intelligence is a plain provider (not a router)', async () => {
    const res = await request(appWith(fakeProvider('claude'))).get('/intelligence/routing/chains');
    expect(res.status).toBe(503);
  });

  it('is PURE — the legacy route is unchanged and repeated calls are byte-identical (no writes)', async () => {
    const app = appWith(routerRoutingSentinelsToCodex());
    // The legacy route still returns its own (different) shape — not broken.
    const legacy = await request(app).get('/intelligence/routing');
    expect(legacy.status).toBe(200);
    expect(legacy.body).not.toHaveProperty('chains'); // legacy view is untouched

    // The map route is deterministic across calls (no mutation of shared state).
    const a = await request(app).get('/intelligence/routing/chains');
    const b = await request(app).get('/intelligence/routing/chains');
    expect(a.body).toEqual(b.body);
  });
});
