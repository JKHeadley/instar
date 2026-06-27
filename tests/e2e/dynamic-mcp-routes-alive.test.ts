// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * E2E "feature is alive" for the Dynamic MCP Lifecycle routes
 * (DYNAMIC-MCP-LIFECYCLE-SPEC §Testing "E2E"). Boots the REAL AgentServer on the
 * production init path and proves:
 *   - with `sessions.dynamicMcp.enabled:true`, AgentServer actually constructs +
 *     wires DynamicMcpService into the route context (NOT null) → GET /mcp/session
 *     returns 200 with the real lean-baseline shape (the wiring is not dead code);
 *   - the route is Bearer-auth-gated (401 without a token);
 *   - a DISABLED boot 503-stubs the route (the dark default).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MCP_JSON = { mcpServers: { playwright: { command: 'npx' }, threadline: { command: 'node' } } };

function mockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function buildConfig(tmpDir: string, stateDir: string, project: string, dynamicMcpEnabled: boolean): InstarConfig {
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.mcp.json'), JSON.stringify(MCP_JSON));
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: project }));
  return {
    projectName: project, projectDir: tmpDir, stateDir, port: 0, authToken: 'placeholder',
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: {
      claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000,
      ...(dynamicMcpEnabled ? { dynamicMcp: { enabled: true, keepWarm: ['threadline'] } } : {}),
    },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
}

describe('/mcp/* routes E2E (alive on the real AgentServer boot)', () => {
  const PROJECT = 'e2e-dynmcp';
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;
  let token: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynmcp-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    const config = buildConfig(tmpDir, stateDir, PROJECT, /*enabled*/ true);
    server = new AgentServer({
      config,
      sessionManager: mockSessionManager() as never,
      state: new StateManager(stateDir),
    } as never);
    await server.start();
    app = server.getApp();
    token = 'placeholder';
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/dynamic-mcp-routes-alive.test.ts' });
  });

  it('GET /mcp/session/:topicId is ALIVE (200, real shape) — the service is wired at boot, not null', async () => {
    const res = await request(app).get('/mcp/session/5').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, topicId: 5, servers: ['threadline'] });
  });

  it('is Bearer-auth-gated (401 without a token)', async () => {
    const res = await request(app).get('/mcp/session/5');
    expect(res.status).toBe(401);
  });

  it('POST /mcp/load is registered (not 404) and reachable with auth', async () => {
    const res = await request(app).post('/mcp/load').set('Authorization', `Bearer ${token}`).send({ topicId: 5, server: 'playwright' });
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(503); // enabled boot ⇒ not dark
  });
});

describe('/mcp/* routes E2E (503 on a DISABLED boot — the dark default)', () => {
  const PROJECT = 'e2e-dynmcp-dark';
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;
  let token: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynmcp-e2e-dark-'));
    const stateDir = path.join(tmpDir, '.instar');
    const config = buildConfig(tmpDir, stateDir, PROJECT, /*enabled*/ false);
    server = new AgentServer({
      config,
      sessionManager: mockSessionManager() as never,
      state: new StateManager(stateDir),
    } as never);
    await server.start();
    app = server.getApp();
    token = 'placeholder';
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/dynamic-mcp-routes-alive.test.ts' });
  });

  it('GET /mcp/session/:topicId 503s when dynamicMcp is disabled', async () => {
    const res = await request(app).get('/mcp/session/5').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
  });
});
