// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Threadline
 * single-negotiator surface (THREADLINE-SINGLE-NEGOTIATOR-SPEC.md, CMT-1362).
 *
 * The single most important test for a feature with API routes (TESTING-
 * INTEGRITY-SPEC): is GET /threadline/negotiator actually alive on the real
 * AgentServer boot path (200, not 404/503), bearer-gated, reflecting config —
 * NOT a 503 stub? Boots the REAL AgentServer with a real ConversationStore wired
 * (mirroring the production server.ts boot, which constructs + injects it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return {
    listRunningSessions: () => [],
    getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
    getSession: () => null,
  };
}

describe('Threadline negotiator E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let conversationStore: ConversationStore;
  const AUTH = 'test-e2e-negotiator';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'negotiator-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    // Mirror production: the server constructs + injects the ConversationStore.
    conversationStore = new ConversationStore(stateDir);
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
      conversationStore,
    } as never);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline-negotiator-alive.test.ts' });
  });

  it('GET /threadline/negotiator is ALIVE (200, not 503/404) with bearer auth', async () => {
    const res = await request(app).get('/threadline/negotiator').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    // Ships dark by default — the gate is observe-only/off, but the route is live.
    expect(res.body.enabled).toBe(false);
    expect(Array.isArray(res.body.leases)).toBe(true);
    expect(res.body).toHaveProperty('counts');
  });

  it('is bearer-gated (401 without the token)', async () => {
    const res = await request(app).get('/threadline/negotiator');
    expect(res.status).toBe(401);
  });

  it('reflects real lease state from the wired ConversationStore', async () => {
    await conversationStore.acquireOrRenewLease(
      'thread-alive', { ownerSessionName: 'echo-topic-1', ownerMachineId: 'machine-a' }, { ttlMs: 90000 },
    );
    const res = await request(app).get('/threadline/negotiator').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.leases[0]).toMatchObject({ threadId: 'thread-alive', owner: 'echo-topic-1', epoch: 1 });
  });
});
