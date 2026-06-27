/**
 * Integration — the /mcp/* routes over the real createRoutes pipeline + a real
 * DynamicMcpService (host primitives faked). Verifies the dark 503, the enabled
 * shapes, validation, and the C4-critical rule that the agent route NEVER honors a
 * caller-supplied nonce (it always acts as {kind:'agent'}).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { DynamicMcpService } from '../../src/core/DynamicMcpService.js';

const MCP_JSON = { mcpServers: { playwright: { command: 'npx' }, threadline: { command: 'node' } } };

function appWith(service: DynamicMcpService | null, stateDir: string) {
  const ctx = {
    config: { projectName: 'test', projectDir: '/tmp', stateDir, port: 0, dashboardPin: '424242', sessions: {} as unknown, scheduler: {} as unknown } as unknown,
    sessionManager: { listRunningSessions: () => [] } as unknown,
    state: { getJobState: () => null, getSession: () => null } as unknown,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    startTime: new Date(),
    dynamicMcpService: service,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('/mcp/* routes', () => {
  let dir: string;
  let restarts: number;

  const makeService = (over: Partial<Parameters<typeof DynamicMcpService.prototype.constructor>[0]> = {}, enabled = true, preapproved = true): DynamicMcpService =>
    new DynamicMcpService({
      projectDir: dir,
      enabled: () => enabled,
      config: () => ({ enabled: true, keepWarm: ['threadline'] }),
      restart: async () => { restarts++; return { ok: true }; },
      isPreapproved: () => preapproved,
      captureHeavyPids: () => [],
      reapPids: () => {},
      isMidToolUse: () => null,
      ...over,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mcproutes-'));
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(MCP_JSON));
    restarts = 0;
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/dynamic-mcp-routes.test.ts' });
  });

  it('503 when the service is absent', async () => {
    const r = await request(appWith(null, path.join(dir, ".instar"))).get('/mcp/session/5');
    expect(r.status).toBe(503);
  });

  it('503 when the service is disabled (dark)', async () => {
    const r = await request(appWith(makeService({}, /*enabled*/ false), path.join(dir, ".instar"))).get('/mcp/session/5');
    expect(r.status).toBe(503);
  });

  it('GET /mcp/session/:topicId returns the state shape when enabled', async () => {
    const r = await request(appWith(makeService(), path.join(dir, ".instar"))).get('/mcp/session/5');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, topicId: 5, servers: ['threadline'], preapproved: true });
  });

  it('GET with a non-numeric topicId ⇒ 400', async () => {
    const r = await request(appWith(makeService(), path.join(dir, ".instar"))).get('/mcp/session/abc');
    expect(r.status).toBe(400);
  });

  it('POST /mcp/load (preapproved) ⇒ 200 applied + a restart happened', async () => {
    const svc = makeService();
    const r = await request(appWith(svc, path.join(dir, ".instar"))).post('/mcp/load').send({ topicId: 5, server: 'playwright' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 'applied' });
    expect(restarts).toBe(1);
  });

  it('POST /mcp/load (NOT preapproved) ⇒ 202 needs-approval, NO restart', async () => {
    const r = await request(appWith(makeService({}, true, /*preapproved*/ false), path.join(dir, ".instar")))
      .post('/mcp/load').send({ topicId: 5, server: 'playwright' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('needs-approval');
    expect(r.body.nonce).toBeTruthy();
    expect(restarts).toBe(0);
  });

  it('[C4] a caller-supplied nonce in the body does NOT authorize over the Bearer route', async () => {
    // Even handing the route a (here arbitrary) nonce, the agent route acts as
    // {kind:'agent'} — so a not-preapproved change still returns needs-approval.
    const r = await request(appWith(makeService({}, true, false), path.join(dir, ".instar")))
      .post('/mcp/load').send({ topicId: 5, server: 'playwright', nonce: 'anything' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('needs-approval');
    expect(restarts).toBe(0);
  });

  it('POST /mcp/load with a missing server ⇒ 400', async () => {
    const r = await request(appWith(makeService(), path.join(dir, ".instar"))).post('/mcp/load').send({ topicId: 5 });
    expect(r.status).toBe(400);
  });

  it('POST /mcp/offload conservatively aborts in v1 (mid-tool-use unknown) ⇒ 409 aborted', async () => {
    const svc = makeService();
    // load first so there is something to offload
    await request(appWith(svc, path.join(dir, ".instar"))).post('/mcp/load').send({ topicId: 5, server: 'playwright' });
    const r = await request(appWith(svc, path.join(dir, ".instar"))).post('/mcp/offload').send({ topicId: 5, server: 'playwright' });
    expect(r.status).toBe(409);
    expect(r.body.status).toBe('aborted');
  });

  describe('POST /mcp/approve — operator-authenticated (PIN-gated) approval', () => {
    const PIN = '424242';

    it('503 when the feature is disabled', async () => {
      const r = await request(appWith(makeService({}, false), path.join(dir, ".instar")))
        .post('/mcp/approve').send({ topicId: 5, server: 'playwright', nonce: 'x', pin: PIN });
      expect(r.status).toBe(503);
    });

    it('requires the operator PIN (no pin ⇒ 403, the agent cannot self-approve)', async () => {
      const r = await request(appWith(makeService({}, true, false), path.join(dir, ".instar")))
        .post('/mcp/approve').send({ topicId: 5, server: 'playwright', nonce: 'x' });
      expect(r.status).toBe(403);
    });

    it('a WRONG pin ⇒ 403', async () => {
      const r = await request(appWith(makeService({}, true, false), path.join(dir, ".instar")))
        .post('/mcp/approve').send({ topicId: 5, server: 'playwright', nonce: 'x', pin: 'wrong' });
      expect(r.status).toBe(403);
    });

    it('valid PIN + the real nonce from a needs-approval ⇒ 200 applied (the round trip)', async () => {
      const svc = makeService({}, true, /*preapproved*/ false); // interactive, not preapproved
      const app = appWith(svc, path.join(dir, ".instar"));
      // 1) the agent (Bearer) requests a load → needs-approval + a server-minted nonce
      const need = await request(app).post('/mcp/load').send({ topicId: 5, server: 'playwright' });
      expect(need.status).toBe(202);
      const nonce = need.body.nonce as string;
      expect(nonce).toBeTruthy();
      // 2) the operator (PIN) approves with that nonce → the load completes
      const ok = await request(app).post('/mcp/approve').send({ topicId: 5, server: 'playwright', nonce, pin: PIN });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, status: 'applied' });
    });

    it('valid PIN but a WRONG nonce ⇒ 403 needs-approval (the approval did not take)', async () => {
      const svc = makeService({}, true, false);
      const app = appWith(svc, path.join(dir, ".instar"));
      await request(app).post('/mcp/load').send({ topicId: 5, server: 'playwright' }); // mint a real nonce
      const r = await request(app).post('/mcp/approve').send({ topicId: 5, server: 'playwright', nonce: 'FORGED', pin: PIN });
      expect(r.status).toBe(403);
      expect(r.body.status).toBe('needs-approval');
    });
  });
});
