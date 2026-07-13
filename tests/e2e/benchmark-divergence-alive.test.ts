// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Benchmark-Divergence
 * Detector (benchmark-divergence-detector FD10/FD13): GET /benchmark-divergence,
 * POST /benchmark-divergence/analyze, GET /benchmark-divergence/rollup-aggregates.
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the same path
 * server.ts uses). Two boots prove BOTH sides of the ship posture:
 *   - a dev-agent boot (`developmentAgent: true`) answers 200, not a 503-stub —
 *     AgentServer self-constructed the analyzer + substrate;
 *   - a fleet boot (dark) answers 503 on every route.
 * Plus the stage-2 liveness proof: a REAL settlement + annotate through the
 * production seam (the module singletons AgentServer installed) lands a
 * by_model row served back through the live HTTP surface.
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
import { getDecisionQualityRecorder } from '../../src/core/decisionQualityTypes.js';
import { annotateDecisionOutcome, type DecisionQualityRecorderImpl } from '../../src/core/DecisionQualityRecorderImpl.js';
import { HOG_SUSTAINED_RIGHT_RULE_ID } from '../../src/monitoring/ExternalHogDecisionStore.js';
import { DECISION_GRADING_COMPONENT } from '../../src/core/decisionGradingPass.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function makeConfig(tmpDir: string, stateDir: string, auth: string, developmentAgent: boolean): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    developmentAgent,
    // The stage-2 write rides the METER's seam: live + non-dry so the real
    // settlement/annotate below produces durable by_model rows (FD13).
    provenance: { uniformSeam: { dryRun: false } },
    benchmarkDivergence: { dryRun: true },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

describe('Benchmark-Divergence E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-benchmark-divergence';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-divergence-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    server = new AgentServer({
      config: makeConfig(tmpDir, stateDir, AUTH, true),
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/benchmark-divergence-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /benchmark-divergence is alive (200, not 503) with the frozen envelope', async () => {
    const res = await request(app).get('/benchmark-divergence').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.enabled).toBe(true); // the dev-gate resolved the detector LIVE
    expect(res.body.dryRun).toBe(true); // FD13 — dryRun default even on dev
    expect(res.body.analyzer).toMatchObject({ isHolder: true, stale: false }); // single-machine counts as holder
    // The mirror honestly reports its pre-pull absent state (never a throw).
    expect(res.body.mirror).toMatchObject({ present: false, stale: true });
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.summary.unanalyzedLoss).toEqual({ byMachine: {} });
  });

  it('POST /benchmark-divergence/analyze is alive and honors dryRun (would-analyze, ZERO durable writes)', async () => {
    const res = await request(app).post('/benchmark-divergence/analyze').set(auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(typeof res.body.wouldUpsert).toBe('number');
    // Zero detector-owned durable writes: the findings surface stays empty.
    const read = await request(app).get('/benchmark-divergence').set(auth());
    expect(read.body.findings).toHaveLength(0);
  });

  it('a REAL settlement + annotate through the production seam lands a by_model row served over live HTTP', async () => {
    // The seam AgentServer installed at boot (the router's settlement recorder).
    const recorder = getDecisionQualityRecorder() as DecisionQualityRecorderImpl | null;
    expect(recorder).not.toBeNull(); // wiring integrity: not a no-op
    const settledAtMs = Date.now() - 3 * 86_400_000; // a matured day
    recorder!.recordSettlement({
      correlationId: 'd-e2e-bench-1',
      mintedBy: 'router',
      enrolled: true,
      provenance: {
        decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
        context: { commandHash: 'abc' },
        optionsPresented: ['kill', 'leave'],
        promptId: 'hog-classify-v1',
      },
      settledAttempt: { model: 'gpt-5.5', framework: 'codex-cli', usage: { inputTokens: 5, outputTokens: 2 } },
      verdictClass: 'kill',
      mintedAtMs: settledAtMs - 100,
      settledAtMs,
    } as never);
    const annotated = annotateDecisionOutcome({
      correlationId: 'd-e2e-bench-1',
      ruleId: HOG_SUSTAINED_RIGHT_RULE_ID,
      gradedBy: { component: DECISION_GRADING_COMPONENT },
      grade: 'right',
      decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
    });
    expect(annotated.applied).toBe(true);

    const day = new Date(settledAtMs).toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/benchmark-divergence/rollup-aggregates?fromDay=${day}&toDay=${day}`)
      .set(auth());
    expect(res.status).toBe(200);
    const row = (res.body.rows as Array<Record<string, unknown>>).find(
      (r) => r.decisionPointId === DP_EXTERNAL_HOG_KILL_LEAVE && r.model === 'gpt-5.5',
    );
    expect(row).toBeDefined(); // the stage-2 chokepoint wrote the parallel table
    expect(row).toMatchObject({ day, rightN: 1, decidedTotal: 1, promptId: 'hog-classify-v1' });
  });

  it('requires a bearer token (401 without one)', async () => {
    const res = await request(app).get('/benchmark-divergence');
    expect(res.status).toBe(401);
  });
});

describe('Benchmark-Divergence E2E dark boot (fleet posture)', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-benchmark-divergence-dark';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-divergence-e2e-dark-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    server = new AgentServer({
      config: makeConfig(tmpDir, stateDir, AUTH, false), // NOT a dev agent ⇒ dark
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/benchmark-divergence-alive.test.ts' });
  });

  it('all three routes answer 503 on a fleet (dark) install — never a half-built surface', async () => {
    const auth = { Authorization: `Bearer ${AUTH}` };
    expect((await request(app).get('/benchmark-divergence').set(auth)).status).toBe(503);
    expect((await request(app).post('/benchmark-divergence/analyze').set(auth).send({})).status).toBe(503);
    expect((await request(app).get('/benchmark-divergence/rollup-aggregates?fromDay=2026-07-01&toDay=2026-07-02').set(auth)).status).toBe(503);
  });
});
