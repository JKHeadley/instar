// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for Secret Drop store-first
 * durable persistence (docs/specs/secret-drop-store-first.md).
 *
 * This is the production failure, reproduced for real: a secret submitted to
 * one server process must survive a full server restart and be retrievable
 * from the NEXT process. Boots the REAL AgentServer (same path server.ts
 * uses), submits through the real form flow, then stops the server, boots a
 * SECOND AgentServer on the same stateDir, and retrieves — the in-memory
 * `received` map is gone with the first process; only the store-first durable
 * copy can serve the value. Exactly the auto-update-restart churn that kept
 * losing operator secrets (topic 13481, "MANY MANY TIMES").
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

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Secret Drop store-first E2E lifecycle (survives a real server restart)', () => {
  let tmpDir: string;
  let stateDir: string;
  const AUTH = 'test-e2e-store-first';

  function makeConfig(): InstarConfig {
    return {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
      // forceFileKey: tests must never touch the machine-global keychain entry
      // (2026-06-05 incident). The MasterKeyManager VITEST guard enforces this
      // structurally; the explicit flag documents intent.
      secrets: { forceFileKey: true },
    } as InstarConfig;
  }

  async function bootServer(): Promise<{ server: AgentServer; app: express.Express }> {
    const server = new AgentServer({
      config: makeConfig(),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
    });
    await server.start();
    return { server, app: server.getApp() };
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-first-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/secret-drop-store-first-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('a submitted secret survives a full server restart and is retrievable from the next process', async () => {
    // ── Process 1: request a drop and submit through the real form flow ──
    // No topicId: the Telegram-confirm + agent-nudge flows it gates are out of
    // this feature's scope (topicId persistence is pinned at integration tier),
    // and the nudge would spawn a session this harness deliberately mocks away.
    const first = await bootServer();
    let token: string;
    try {
      const reqRes = await request(first.app)
        .post('/secrets/request')
        .set(auth())
        .send({ label: 'Restart Survivor', fields: [{ name: 'apiKey', label: 'API Key' }] });
      expect(reqRes.status).toBe(201);
      token = reqRes.body.token as string;

      const formRes = await request(first.app).get(`/secrets/drop/${token}`);
      expect(formRes.status).toBe(200);
      const csrf = /name="_csrf" value="([^"]+)"/.exec(formRes.text)?.[1];
      expect(csrf).toBeTruthy();

      const submitRes = await request(first.app)
        .post(`/secrets/drop/${token}`)
        .send({ _csrf: csrf, apiKey: 'sk-survives-restart' });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.ok).toBe(true);
    } finally {
      // ── The churn: the first process (and its in-memory `received` map) dies ──
      await first.server.stop();
    }

    // ── Process 2: a fresh AgentServer on the same stateDir ──
    const second = await bootServer();
    try {
      // Peek first — alive (200) from the durable copy, and non-destructive.
      const peek = await request(second.app).post(`/secrets/retrieve/${token}`).set(auth());
      expect(peek.status).toBe(200);
      expect(peek.body.values).toEqual({ apiKey: 'sk-survives-restart' });
      expect(peek.body.consumed).toBe(false);

      // Consume — returns the value and deletes the durable copy.
      const consume = await request(second.app).post(`/secrets/retrieve/${token}?consume=true`).set(auth());
      expect(consume.status).toBe(200);
      expect(consume.body.values).toEqual({ apiKey: 'sk-survives-restart' });
      expect(consume.body.consumed).toBe(true);

      // Fully gone afterwards — one-time semantics hold across the restart.
      const after = await request(second.app).post(`/secrets/retrieve/${token}`).set(auth());
      expect(after.status).toBe(404);
    } finally {
      await second.server.stop();
    }
  }, 60_000); // two real AgentServer boots + stops

  it('the retrieve route requires Bearer auth', async () => {
    const { server, app } = await bootServer();
    try {
      const res = await request(app).post('/secrets/retrieve/some-token');
      expect(res.status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});
