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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DP_COMPLETION_EVALUATE, DP_EXTERNAL_HOG_KILL_LEAVE } from '../../src/data/provenanceCoverage.js';
import { getDecisionQualityRecorder } from '../../src/core/decisionQualityTypes.js';
import type { DecisionQualityRecorderImpl } from '../../src/core/DecisionQualityRecorderImpl.js';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';

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
      provenance: { uniformSeam: { enabled: true, dryRun: false } },
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
    expect(res.body.censusDebt.wiredButNoGrader).toEqual([]);
    // Pending-tracker adjudication is alive on the production init path: BOTH
    // buckets are always surfaced (a peer-minted tracker must be separable from a
    // genuinely-deleted one, never collapsed into one false "dead" list).
    expect(Array.isArray(res.body.censusDebt.pendingRefDead)).toBe(true);
    expect(Array.isArray(res.body.censusDebt.pendingRefUnverifiable)).toBe(true);
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

  it('run-end realcheck binding produces a non-zero graded count on the live read surface', async () => {
    const topicId = '99117';
    const registered = await request(app).post('/autonomous/register').set(auth()).send({
      topicId,
      condition: 'decision-quality live binding',
      workDir: tmpDir,
      startedAt: new Date().toISOString(),
    });
    expect(registered.status).toBe(200);
    const runId = String(registered.body.runId);
    const correlationId = 'd-e2e-realcheck-00000000-0000-4000-8000-000000000117';
    expect(new AutonomousRunStore(stateDir).recordDecisionCorrelation(topicId, runId, 'completion', correlationId)).toBe(true);

    const recorder = getDecisionQualityRecorder() as DecisionQualityRecorderImpl | null;
    expect(recorder).not.toBeNull();
    recorder!.recordSettlement({
      correlationId,
      mintedBy: 'router',
      enrolled: true,
      provenance: {
        decisionPoint: DP_COMPLETION_EVALUATE,
        context: { transcriptHash: 'e2e' },
        optionsPresented: ['met', 'not-met'],
        promptId: 'completion-evaluate-v1',
      },
      settledAttempt: { model: 'gpt-5.5', framework: 'codex-cli', usage: { inputTokens: 4, outputTokens: 1 } },
      verdictClass: 'met',
      mintedAtMs: Date.now() - 10,
      settledAtMs: Date.now(),
    } as never);

    const ended = await request(app).post(`/autonomous/${topicId}/run-end`).set(auth()).send({
      reason: 'met', runId, met: true, realcheck: { configured: true, outcome: 'pass', exitCode: 0 },
    });
    expect(ended.status).toBe(200);
    expect(ended.body.realcheckAnnotation).toBe('annotated-right');

    const conflict = await request(app).post(`/autonomous/${topicId}/run-end`).set(auth()).send({
      reason: 'replayed-opposite', runId, met: true, realcheck: { configured: true, outcome: 'fail', exitCode: 1 },
    });
    expect(conflict.body.realcheckAnnotation).toBe('conflicting-observation');

    const invalid = await request(app).post(`/autonomous/${topicId}/run-end`).set(auth()).send({
      reason: 'replayed-malformed', runId, met: true, realcheck: { configured: true, outcome: 'garbage' },
    });
    expect(invalid.body.realcheckPayloadInvalid).toBe(true);
    expect(invalid.body.realcheckAnnotation).toBe('skipped-terminal-record');

    const failTopicId = '99118';
    const failRegistered = await request(app).post('/autonomous/register').set(auth()).send({
      topicId: failTopicId,
      condition: 'decision-quality live failed-check binding',
      workDir: tmpDir,
      startedAt: new Date().toISOString(),
    });
    const failRunId = String(failRegistered.body.runId);
    const failCorrelationId = 'd-e2e-realcheck-00000000-0000-4000-8000-000000000118';
    expect(new AutonomousRunStore(stateDir).recordDecisionCorrelation(failTopicId, failRunId, 'completion', failCorrelationId)).toBe(true);
    recorder!.recordSettlement({
      correlationId: failCorrelationId,
      mintedBy: 'router',
      enrolled: true,
      provenance: {
        decisionPoint: DP_COMPLETION_EVALUATE,
        context: { transcriptHash: 'e2e-fail' },
        optionsPresented: ['met', 'not-met'],
        promptId: 'completion-evaluate-v1',
      },
      settledAttempt: { model: 'gpt-5.5', framework: 'codex-cli', usage: { inputTokens: 4, outputTokens: 1 } },
      verdictClass: 'met',
      mintedAtMs: Date.now() - 10,
      settledAtMs: Date.now(),
    } as never);
    const failedCheck = await request(app).post(`/autonomous/${failTopicId}/run-end`).set(auth()).send({
      reason: 'realcheck-fail', runId: failRunId, terminal: false, met: true,
      realcheck: { configured: true, outcome: 'fail', exitCode: 1 },
    });
    expect(failedCheck.body).toMatchObject({ terminal: false, realcheckAnnotation: 'annotated-wrong' });
    expect(new AutonomousRunStore(stateDir).getRecord(failTopicId)?.status).toBe('active');

    const view = await request(app).get('/decision-quality?sinceHours=24').set(auth());
    const point = (view.body.points as Array<any>).find((p) => p.decisionPoint === DP_COMPLETION_EVALUATE);
    expect(point.outcomesKnown).toBeGreaterThan(0);
    expect(point.gradeDistribution.right).toBeGreaterThan(0);
    expect(point.gradeDistribution.wrong).toBeGreaterThan(0);
  });

  it('a realcheck receipt write failure is named and cannot prevent terminalization', async () => {
    const topicId = '99119';
    const registered = await request(app).post('/autonomous/register').set(auth()).send({
      topicId, condition: 'receipt failure containment', workDir: tmpDir, startedAt: new Date().toISOString(),
    });
    const runId = String(registered.body.runId);
    const correlationId = 'd-e2e-realcheck-00000000-0000-4000-8000-000000000119';
    expect(new AutonomousRunStore(stateDir).recordDecisionCorrelation(topicId, runId, 'completion', correlationId)).toBe(true);
    const updateSpy = vi.spyOn(AutonomousRunStore.prototype, 'update');
    updateSpy.mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    const ended = await request(app).post(`/autonomous/${topicId}/run-end`).set(auth()).send({
      reason: 'met', runId, met: true, realcheck: { configured: true, outcome: 'pass', exitCode: 0 },
    });
    updateSpy.mockRestore();
    expect(ended.status).toBe(200);
    expect(ended.body.realcheckAnnotation).toBe('observation-persist-error');
    expect(new AutonomousRunStore(stateDir).getRecord(topicId)?.status).toBe('ended');
  });

  it('requires a bearer token (401 without one)', async () => {
    const res = await request(app).get('/decision-quality');
    expect(res.status).toBe(401);
  });
});
