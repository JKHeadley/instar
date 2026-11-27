// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for docs/specs/threadline-http-peer-trust.md, on the
 * production init path: the REAL AgentServer with a real HandshakeManager (as server.ts
 * builds it from ThreadlineBootstrap) and a default config.
 *   - the direct peer routes are CLOSED (404) by default, before any processing;
 *   - the public health card still answers;
 *   - the authed /health detail carries threadline.httpPeerTrust;
 *   - the owner's pairing-removal route is alive and needs the bearer token.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HandshakeManager } from '../../src/threadline/HandshakeManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';

describe('Threadline HTTP peer trust E2E (feature is alive)', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-http-peer-trust';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-peer-trust-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    server = new AgentServer({
      config, sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir), handshakeManager: new HandshakeManager(stateDir, 'e2e'),
    } as never);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline-http-peer-trust-alive.test.ts' });
  });

  it('closes every direct peer route by default, without the bearer token being involved', async () => {
    const hello = { agent: 'x', identityPub: '00'.repeat(32), ephemeralPub: '00'.repeat(32), nonce: 'n' };
    expect((await request(app).post('/threadline/handshake/hello').send(hello)).status).toBe(404);
    expect((await request(app).post('/threadline/handshake/confirm').send({ agent: 'x', challengeResponse: '00' })).status).toBe(404);
    expect((await request(app).post('/threadline/messages/receive').send({})).status).toBe(404);
    expect((await request(app).post('/threadline/threads/backfill').send({})).status).toBe(404);
    expect((await request(app).get('/threadline/blobs/abc')).status).toBe(404);
  });

  it('keeps the public health card alive', async () => {
    expect((await request(app).get('/threadline/health')).status).toBe(200);
  });

  it('serves the admission counters on the authed /health only', async () => {
    const authed = await request(app).get('/health').set({ Authorization: `Bearer ${AUTH}` });
    expect(authed.status).toBe(200);
    expect(authed.body.threadline?.httpPeerTrust).toMatchObject({ refusedNotTrusted: expect.any(Number), admitted: expect.any(Number) });
    const open = await request(app).get('/health');
    expect(open.body.threadline?.httpPeerTrust).toBeUndefined();
  });

  it("the owner's pairing-removal route is alive and bearer-gated", async () => {
    expect((await request(app).delete('/threadline/pairings/nobody')).status).toBe(401);
    expect((await request(app).delete('/threadline/pairings/nobody').set({ Authorization: `Bearer ${AUTH}` })).status).toBe(404);
  });
});
