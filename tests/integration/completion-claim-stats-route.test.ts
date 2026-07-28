/**
 * Tier-2 integration tests for `GET /completion-claim/stats`.
 *
 * Why this route exists: `CompletionClaimVerifier.stats()` shipped with the verifier
 * and was called by NO route. `docs/specs/claim-verification-sentinel.md` declares
 * `rollout-disposition: active` with `rollout-evidence-type: endpoint` and a
 * `classified-completion-claims >= 1` graduation criterion — and pointed at
 * `/completion-claim-verification/stats`, a prefix that does not exist. So the
 * feature ran in dryRun with its own graduation evidence unreadable, which means it
 * could never graduate and nothing would have surfaced that.
 *
 * The audit route (`/completion-claim/audit`) was live and recording the whole time,
 * so this is specifically the *counters* surface, not the feature.
 *
 * Covers:
 *   - 503 when the verifier is absent (feature disabled) — matches the audit route
 *   - 200 + the raw counters when present
 *   - the spec's metric name is surfaced and mirrors the internal counter
 *   - the route is read-only (it must not mutate counters)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'ccstats-test-' + Math.random().toString(36).slice(2, 8);
let AUTH = '';
let tmpDir = '';

function statsFixture(classifiedTurns: number) {
  return {
    candidateTurns: classifiedTurns + 3,
    classifiedTurns,
    noClaimTurns: 2,
    invalidOutputTurns: 0,
    providerUnavailableTurns: 1,
    flaggedTurns: 0,
    duplicateTurns: 0,
    falsePositiveDispositions: 0,
    falseNegativeDispositions: 0,
    canaryDriftSignals: 0,
    generalAdmittedTurns: 4,
    generalClaims: 6,
    protectedCueGaps: 0,
    coverageIncompleteTurns: 1,
    corpusDrops: 0,
    retentionFailures: 0,
    verdicts: { 'uncorroborated-unknown': 3 },
    generalVerdicts: { unverifiable: 5 },
    refutedByCriticality: {},
    unverifiableByCriticality: { high: 2 },
    updatedAt: '2026-07-27T17:46:20.971Z',
  };
}

function buildCtx(verifier: unknown): RouteContext {
  return {
    config: {
      projectName: PROJECT_NAME,
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      port: 0,
      authToken: AUTH,
    } as never,
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
    completionClaimVerifier: verifier,
  } as unknown as RouteContext;
}

function app(verifier: unknown) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(buildCtx(verifier)));
  return a;
}

describe('GET /completion-claim/stats', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstats-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });

  afterEach(() => {
    deleteAgentToken(PROJECT_NAME);
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true,
      operation: 'tests/integration/completion-claim-stats-route.test.ts',
    });
  });

  it('503s when the verifier is absent, matching the audit route', async () => {
    const res = await request(app(null))
      .get('/completion-claim/stats')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it('returns the raw counters when the verifier is present', async () => {
    const res = await request(app({ stats: () => statsFixture(7) }))
      .get('/completion-claim/stats')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.stats.classifiedTurns).toBe(7);
    expect(res.body.stats.candidateTurns).toBe(10);
    expect(res.body.scope).toBe('local');
  });

  it("surfaces the spec's graduation metric name, mirroring the internal counter", async () => {
    // The spec's criterion is `classified-completion-claims >= 1`. A rollout check
    // should not have to know that the internal field is `classifiedTurns`.
    const res = await request(app({ stats: () => statsFixture(4) }))
      .get('/completion-claim/stats')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.body['classified-completion-claims']).toBe(4);
    expect(res.body['classified-completion-claims']).toBe(res.body.stats.classifiedTurns);
  });

  it('reports zero honestly rather than omitting the metric', async () => {
    // A dark feature that has classified nothing must read as 0, not as absent —
    // absent is indistinguishable from "the endpoint does not work", which is the
    // exact condition this route was added to end.
    const res = await request(app({ stats: () => statsFixture(0) }))
      .get('/completion-claim/stats')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body['classified-completion-claims']).toBe(0);
  });

  it('is read-only — reading stats must not mutate the verifier', async () => {
    let calls = 0;
    const verifier = {
      stats: () => { calls += 1; return statsFixture(2); },
      // Any mutation entry point being touched by a GET would be a defect.
      recordDisposition: () => { throw new Error('stats route must not record dispositions'); },
      recordCanaryDrift: () => { throw new Error('stats route must not record drift'); },
    };
    const res = await request(app(verifier))
      .get('/completion-claim/stats')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});
