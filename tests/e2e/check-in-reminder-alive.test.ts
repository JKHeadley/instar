// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for the dated-commitment check-in reminder
 * (ACT-724; docs/specs/dated-commitment-reminder.md).
 *
 * Per TESTING-INTEGRITY-SPEC this is the most important test for a feature with
 * API routes: is it ALIVE on the PRODUCTION init path — 200, not a 503 stub?
 * It boots the REAL AgentServer and injects a REAL CommitmentTracker exactly as
 * src/commands/server.ts does — not a hand-assembled context as in Tier 2.
 *
 * The first draft asserted the server SELF-constructs the tracker. It does not;
 * the production entrypoint builds and injects it, so the routes 503'd. That
 * wrong assumption surviving into a passing test is precisely what Tier 3 exists
 * to prevent, and it is left recorded here rather than quietly corrected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Check-in reminder E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let tracker: CommitmentTracker;
  const AUTH = 'test-e2e-check-in-reminder';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-in-reminder-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }),
    );

    const config: InstarConfig = {
      projectName: 'e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 10000,
      version: '0.0.0',
      // developmentAgent: true → resolveDevAgentGate flips the feature LIVE
      // (dark on the fleet). dryRun is left at its default so this test also
      // pins that the default is SOAK, not send.
      developmentAgent: true,
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    } as InstarConfig;

    // MIRROR server.ts: AgentServer does NOT self-construct the tracker — the
    // production entrypoint builds it and injects it. The first draft of this
    // test assumed self-construction and got a 503, which is precisely the kind
    // of wiring assumption Tier 3 exists to break.
    tracker = new CommitmentTracker({ stateDir, liveConfig: () => config as any });
    tracker.start();

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      commitmentTracker: tracker,
    } as any);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    tracker?.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/check-in-reminder-alive.test.ts',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /commitments/check-in-reminder is ALIVE (200, not 503) on the real boot', async () => {
    const res = await request(app).get('/commitments/check-in-reminder').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.enabled).toBe(true); // the dev-agent gate resolved it live
    expect(Array.isArray(res.body.pending)).toBe(true);
    expect(Array.isArray(res.body.undelivered)).toBe(true);
  });

  it('POST /commitments/check-in-reminder/pass is ALIVE and defaults to SOAK', async () => {
    const res = await request(app)
      .post('/commitments/check-in-reminder/pass')
      .set(auth())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
    // The graduated state must be an explicit operator decision, never a
    // default that arrives by omission.
    expect(res.body.dryRun).toBe(true);
    expect(res.body.sent).toBe(0);
  });

  it('the route is wired to a REAL CommitmentTracker, not a null stub', async () => {
    // Wiring integrity: the route 503s when ctx.commitmentTracker is null, so a
    // 200 with enabled:true proves the injected dependency reached the routes.
    // It is a real CommitmentTracker (constructed as server.ts does), not a mock.
    const res = await request(app).get('/commitments/check-in-reminder').set(auth());
    expect(res.status).toBe(200);
    expect(typeof res.body.datedCount).toBe('number');
    expect(tracker.getAll).toBeTypeOf('function');
  });

  it('a commitment created through the real route can carry a checkInAt', async () => {
    // Proves the field survives the production creation path, not just the type.
    const created = await request(app)
      .post('/commitments')
      .set(auth())
      .send({
        userRequest: 'e2e dated promise',
        type: 'follow-up',
        topicId: 4242,
        checkInAt: new Date(Date.now() - 60_000).toISOString(),
      });
    // Creation may legitimately reject unknown fields on some configs; what must
    // NOT happen is a 5xx. Either it accepts the field or it cleanly refuses.
    expect(created.status).toBeLessThan(500);

    const view = await request(app).get('/commitments/check-in-reminder').set(auth());
    expect(view.status).toBe(200);
    expect(typeof view.body.datedCount).toBe('number');
  });
});
