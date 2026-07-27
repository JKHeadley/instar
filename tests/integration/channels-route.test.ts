/**
 * Tier-2 integration test for `GET /channels` — the channel registry's read surface.
 *
 * WHY THIS FILE EXISTS, specifically. While building this feature I ran the mandatory refusal step
 * against the ROUTE rather than the module: I replaced its channel list with an empty one and re-ran
 * the unit suite. All 19 tests passed. The module was thoroughly guarded and the WIRING was not — so
 * the route could have silently served zero channels and every test would have agreed it was fine.
 *
 * That is the same defect the registry exists to prevent, one layer up: a surface reporting nothing
 * wrong because it was asked nothing. The unit tests prove the resolver cannot lose a channel; these
 * prove the ROUTE actually asks it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'channels-route-test-' + Math.random().toString(36).slice(2, 8);
let AUTH = '';

function buildCtx(tmpDir: string, over: Record<string, unknown> = {}): RouteContext {
  return {
    config: {
      projectName: PROJECT_NAME, projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: AUTH,
    } as never,
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
    ...over,
  } as unknown as RouteContext;
}

function mount(tmpDir: string, over: Record<string, unknown> = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(buildCtx(tmpDir, over)));
  return app;
}

describe('GET /channels (integration — the wiring, not just the resolver)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-route-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    AUTH = generateAgentToken(PROJECT_NAME);
  });
  afterEach(() => {
    try { deleteAgentToken(PROJECT_NAME); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true, operation: 'tests/integration/channels-route.test.ts:cleanup',
    });
  });

  it('REGRESSION: the route serves EVERY code-defined channel — an emptied registry fails here', async () => {
    // The assertion my unit suite could not make. If the route stops asking the registry, this breaks.
    const res = await request(mount(tmpDir)).get('/channels').set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.channels.map((c: { id: string }) => c.id).sort())
      .toEqual(['a2a-telegram', 'mutual-ssh', 'peer-http', 'threadline-relay', 'user-slack', 'user-telegram']);
    expect(res.body.summary.total).toBe(6);
  });

  /**
   * Pins the AUDIENCE PARTITION, not just the count.
   *
   * The test above is satisfied by any six ids. Without this one, a change that dropped the user
   * channels would be "fixed" by editing the list back down to four — the same edit that hides the
   * loss. Asserting BOTH audiences are present means removing a whole audience fails as a removal
   * rather than as an arithmetic disagreement.
   */
  it('REGRESSION: both audiences are served — peer channels AND the operator-facing ones', async () => {
    const res = await request(mount(tmpDir)).get('/channels').set('Authorization', `Bearer ${AUTH}`);

    const byAudience = (a: string) =>
      res.body.channels.filter((c: { audience: string }) => c.audience === a)
        .map((c: { id: string }) => c.id).sort();

    expect(byAudience('peer')).toEqual(['a2a-telegram', 'mutual-ssh', 'peer-http', 'threadline-relay']);
    expect(byAudience('user')).toEqual(['user-slack', 'user-telegram']);
    // Every row must declare one; an untagged channel is not a third state, it is a bug.
    for (const c of res.body.channels) expect(['peer', 'user']).toContain(c.audience);
  });

  it('every row carries purpose, when-preferred, cost and evidence — the operator-facing columns', async () => {
    const res = await request(mount(tmpDir)).get('/channels').set('Authorization', `Bearer ${AUTH}`);
    for (const c of res.body.channels) {
      expect(c.purpose?.length, `${c.id} purpose`).toBeGreaterThan(0);
      expect(c.whenPreferred?.length, `${c.id} whenPreferred`).toBeGreaterThan(0);
      expect(c.cost?.length, `${c.id} cost`).toBeGreaterThan(0);
      expect(c.detail?.length, `${c.id} detail`).toBeGreaterThan(0);
      expect(typeof c.state).toBe('string');
    }
  });

  it('with NO relay client, threadline reports not-configured rather than working', async () => {
    // The failure direction that matters: absent infrastructure must never read as healthy.
    const res = await request(mount(tmpDir)).get('/channels').set('Authorization', `Bearer ${AUTH}`);
    const relay = res.body.channels.find((c: { id: string }) => c.id === 'threadline-relay');
    expect(relay.state).toBe('not-configured');
    expect(res.body.summary.working).toBe(0);
  });

  it('with a DISCONNECTED relay client, it reports broken — the incident state', async () => {
    const res = await request(mount(tmpDir, { threadlineRelayClient: { connectionState: 'disconnected' } }))
      .get('/channels').set('Authorization', `Bearer ${AUTH}`);
    const relay = res.body.channels.find((c: { id: string }) => c.id === 'threadline-relay');
    expect(relay.state).toBe('broken');
    expect(relay.detail).toContain('connected=false');
  });

  it('with a CONNECTED relay client, it reports working — the surface discriminates', async () => {
    // Dead-check: every assertion above would pass against a route stuck on "not working".
    const res = await request(mount(tmpDir, { threadlineRelayClient: { connectionState: 'connected' } }))
      .get('/channels').set('Authorization', `Bearer ${AUTH}`);
    const relay = res.body.channels.find((c: { id: string }) => c.id === 'threadline-relay');
    expect(relay.state).toBe('working');
    expect(res.body.summary.working).toBeGreaterThan(0);
  });

  /**
   * NOT a test that this route checks a bearer itself — it does not, and should not.
   *
   * I wrote that assertion first and it failed with `expected 200 to be 401`. Checking rather than
   * assuming: auth is applied as APP-LEVEL middleware (`AgentServer.ts` mounts
   * `authMiddleware(...)` across the whole app), and the comparable read route
   * `/capability-registry` relies on exactly the same mechanism with no per-handler check. This
   * harness mounts `createRoutes` alone, so app middleware is absent by construction — the 200 was a
   * property of the test rig, not of the route.
   *
   * Recording it rather than deleting the test: "the handler has no auth code" is a real fact a
   * future reader might otherwise mistake for a hole. What IS asserted here is that this route did
   * not opt OUT of the shared gate, which is the only failure mode available to it.
   */
  it('does not bypass the shared auth gate (no route-level auth opt-out)', async () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server/routes.ts'),
      'utf-8',
    );
    const handler = src.slice(src.indexOf("router.get('/channels'"));
    const body = handler.slice(0, handler.indexOf('\n  });'));
    // Routes that deliberately escape the app gate say so explicitly; this one must not.
    expect(body).not.toMatch(/skipAuth|noAuth|publicRoute/);
  });
});
