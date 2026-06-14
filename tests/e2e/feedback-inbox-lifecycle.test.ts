// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test — feedback-inbox receiver
 * persistence (feedback-factory-migration Q2b, Option-B receiving end).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses)
 * and proves, on the production init path:
 *   1. DARK by default: with no feedbackFactory config the route 503s (deny-safe).
 *   2. ALIVE when enabled: with receiverPersistence enabled + the Blob token env +
 *      a real (fake-protocol) Blob server, GET /feedback-inbox/status returns 200.
 *   3. Bearer-gated: no token → 401.
 *   4. WIRING INTEGRITY: the booted drainer delegates to the REAL JsonlFeedbackStore
 *      — a seeded inbox blob ends up as a durable row in the store's on-disk JSONL
 *      under the production default dataDir, and the status counters reflect it.
 *      (Not a no-op: the file content is asserted, not just the counter.)
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
import { FakeBlobServer } from '../integration/feedback-inbox-pipeline.test.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

const AUTH = 'test-e2e-feedback-inbox';
const TOKEN_ENV = 'FEEDBACK_INBOX_BLOB_TOKEN_E2E_TEST';

function baseConfig(tmpDir: string, stateDir: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

function mkStateDir(): { tmpDir: string; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-inbox-e2e-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return { tmpDir, stateDir };
}

describe('feedback-inbox E2E — dark by default', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;

  beforeAll(async () => {
    const dirs = mkStateDir();
    tmpDir = dirs.tmpDir;
    const config = baseConfig(tmpDir, dirs.stateDir); // NO feedbackFactory config
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(dirs.stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/feedback-inbox-lifecycle.test.ts' });
  });

  it('GET /feedback-inbox/status is Bearer-gated and 503s when dark', async () => {
    expect((await request(app).get('/feedback-inbox/status')).status).toBe(401);
    const res = await request(app).get('/feedback-inbox/status').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('feedback-inbox');
  });
});

describe('feedback-inbox E2E — alive when enabled (production init path + real wiring)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let blob: FakeBlobServer;

  beforeAll(async () => {
    blob = new FakeBlobServer();
    await blob.start();
    // Seed an inbox object BEFORE boot — the drainer's priming pass must ingest it.
    blob.seed('inbox/fb-e2e-1-s0.json', JSON.stringify({
      feedbackId: 'fb-e2e-1', title: 'e2e title', description: 'a sufficiently long description', type: 'bug', verified: true,
    }));

    const dirs = mkStateDir();
    tmpDir = dirs.tmpDir;
    stateDir = dirs.stateDir;
    process.env[TOKEN_ENV] = 'e2e-blob-token';
    const config = {
      ...baseConfig(tmpDir, stateDir),
      feedbackFactory: {
        receiverPersistence: {
          enabled: true,
          blobTokenEnv: TOKEN_ENV,
          blobApiBase: blob.baseUrl,
          pollIntervalMs: 60_000, // priming pass covers the test; no fast loop needed
        },
      },
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await blob.stop();
    delete process.env[TOKEN_ENV];
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/feedback-inbox-lifecycle.test.ts' });
  });

  it('GET /feedback-inbox/status is ALIVE (200, not 503) on the production init path', async () => {
    const res = await request(app).get('/feedback-inbox/status').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ running: true, prefix: 'inbox/' });
  });

  it('WIRING INTEGRITY: the seeded blob lands as a durable row in the real on-disk store', async () => {
    // The priming drain runs at start(); poll briefly for it to complete.
    const storeFile = path.join(stateDir, 'state', 'feedback-factory', 'store', 'feedback.jsonl');
    let content = '';
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(storeFile)) {
        content = fs.readFileSync(storeFile, 'utf8');
        if (content.includes('fb-e2e-1')) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // The REAL durable artifact — not a counter, the row itself, at the production default path.
    expect(content).toContain('fb-e2e-1');
    const row = JSON.parse(content.trim().split('\n').find((l) => l.includes('fb-e2e-1'))!);
    expect(row).toMatchObject({ feedbackId: 'fb-e2e-1', title: 'e2e title', status: 'unprocessed' });

    // Inbox cleared after the durable commit; counters agree.
    expect(blob.count('inbox/')).toBe(0);
    const status = await request(app).get('/feedback-inbox/status').set({ Authorization: `Bearer ${AUTH}` });
    expect(status.body.drained).toBeGreaterThanOrEqual(1);
    expect(status.body.lastDrainAt).toBeTruthy();
  });

  it('/capabilities surfaces the feature as enabled (Agent Awareness wiring)', async () => {
    const res = await request(app).get('/capabilities').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    const cap = res.body.capabilities?.feedbackInbox ?? res.body.feedbackInbox;
    expect(JSON.stringify(res.body)).toContain('/feedback-inbox/status');
    if (cap) expect(cap.enabled).toBe(true);
  });
});
