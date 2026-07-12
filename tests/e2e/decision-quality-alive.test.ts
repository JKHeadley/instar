// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the LLM-Decision Quality
 * Meter read + grade surfaces (llm-decision-quality-meter §5.5): GET
 * /decision-quality and POST /decision-quality/grade-pass.
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for a feature with
 * API routes — is it ALIVE on the production init path (200, not 404/503)? This
 * boots the REAL AgentServer (same path server.ts uses) on a SINGLE-MACHINE
 * config with `developmentAgent: true` so the seam gate resolves LIVE — proving
 * AgentServer self-constructs the FeatureMetricsLedger quality substrate and
 * the routes answer 200, NOT a 503-stub. (This is exactly the tier where the
 * mesh-block substrate-construction bug FD9 fixes would have surfaced.)
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
import { DP_EXTERNAL_HOG_KILL_LEAVE } from '../../src/data/provenanceCoverage.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Decision-Quality E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-decision-quality';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-quality-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      // developmentAgent: true → resolveDevAgentGate flips the uniformSeam LIVE
      // (dark on the fleet) so the routes are alive on this single-machine boot.
      developmentAgent: true,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/decision-quality-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /decision-quality is alive (200, not 503) with the real shape', async () => {
    const res = await request(app).get('/decision-quality?sinceHours=24').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.gate.enabled).toBe(true); // the dev-gate resolved the seam LIVE
    expect(Array.isArray(res.body.points)).toBe(true);
    // Census debt is surfaced even with zero decisions (the backlog is always visible).
    expect(res.body.censusDebt.wired).toBeGreaterThanOrEqual(3);
    expect(res.body.censusDebt.pending).toBeGreaterThan(0);
    expect(res.body.rejections).toEqual({ enumInvalid: 0, rungMismatch: 0, ownerMismatch: 0, unknownDecisionPoint: 0 });
    // The three first-customer WIRED points are present in the census surface.
    const wiredPoints = (res.body.points as Array<any>).map((p) => p.decisionPoint);
    expect(wiredPoints).toContain(DP_EXTERNAL_HOG_KILL_LEAVE);
  });

  it('POST /decision-quality/grade-pass is alive (200, not 503) and returns the { graded, byRule, cursors } contract', async () => {
    const res = await request(app).post('/decision-quality/grade-pass').set(auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(typeof res.body.graded).toBe('number');
    expect(res.body.graded).toBe(0); // no evidence yet, but the surface is ALIVE
    expect(typeof res.body.byRule).toBe('object');
    expect(typeof res.body.cursors).toBe('object');
    // The quality substrate DB the routes read was actually created on disk by prod init.
    expect(fs.existsSync(path.join(stateDir, 'server-data', 'feature-metrics.db'))).toBe(true);
  });

  it('requires a bearer token (401 without one)', async () => {
    const res = await request(app).get('/decision-quality');
    expect(res.status).toBe(401);
  });
});
