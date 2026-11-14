/**
 * Integration — correction meaning grouping over the real routes (spec:
 * docs/specs/correction-meaning-grouping.md). Tier 2: the REAL inline
 * routes in createRoutes(), behind the real authMiddleware, a real
 * CorrectionLedger, and a JevCorrectionGrouper whose only fake is the
 * TypeSafe HTTP call.
 *
 * Covers: POST /corrections/analyze reports the grouping it ran and groups
 * reworded records; GET /corrections/groups serves the same groups from cached
 * verdicts with no model call, never serving raw `learning`; with no grouper
 * installed both fall back to word overlap; 503 without a ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  buildJevCorrectionGrouper,
  installJevCorrectionGrouper,
  GROUPING_MODEL,
} from '../../src/core/JevCorrectionGrouping.js';

const AUTH = 'cmg-routes-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

function ctxFor(stateDir: string, ledger: CorrectionLedger | null): RouteContext {
  return {
    config: {
      projectName: 'cmg', projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: AUTH,
      monitoring: { correctionLearning: { enabled: !!ledger } },
      sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, correctionLedger: ledger, startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

/** P(same) is high only when both notes mention "constitution". */
function fakeTypeSafe() {
  let calls = 0;
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    calls++;
    const { state } = JSON.parse(init.body) as { state: string };
    const both = state.split('\n').every((l) => /constitution/i.test(l));
    const p = both ? 0.96 : 0.04;
    const a = { choice: both ? 'same' : 'different', probabilities: { same: p, related: 0, different: 1 - p, cannot_tell: 0 } };
    return { ok: true, status: 200, json: async () => ({ model: GROUPING_MODEL, answers: { same: a, same_rev: a } }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('correction meaning grouping — routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let ledger: CorrectionLedger | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmg-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const learnings = [
      'Require approval only for constitution changes.',
      'Only ask me to approve changes to the constitution.',
      'Use plain language and say whether you are acting or asking.',
    ];
    learnings.forEach((learning, i) => ledger!.record({
      kind: 'user-preference', learning, scrubbedSummary: `summary ${i}`, deterministicWeight: 3,
      topicId: 7, sessionId: `s${i}`, detectedAt: `2026-05-0${i + 1}T10:00:00Z`,
    }));
  });

  afterEach(() => {
    installJevCorrectionGrouper(null);
    ledger?.close();
    ledger = null;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/correction-meaning-grouping-routes.test.ts:afterEach' });
  });

  it('analyze groups reworded records by meaning and reports the grouping run; groups serves it from the cache', async () => {
    const ts = fakeTypeSafe();
    installJevCorrectionGrouper(buildJevCorrectionGrouper({
      readLiveConfig: () => ({ enabled: true }), readSecret: () => 'key', stateDir, fetchImpl: ts.fetchImpl,
    }));
    const app = appWith(ctxFor(stateDir, ledger));

    const analyzed = await request(app).post('/corrections/analyze').set(auth());
    expect(analyzed.status).toBe(200);
    expect(analyzed.body.grouping.mode).toBe('meaning');
    expect(analyzed.body.grouping.sameEdges).toBe(1);
    expect(analyzed.body.analysis.groups).toBe(1);
    expect(analyzed.body.analysis.largestGroup).toBe(2);
    // Two records is below minSupport 4: nothing crosses (the gate is unchanged).
    expect(analyzed.body.analysis.crossed).toBe(0);
    const callsAfterAnalyze = ts.calls();
    expect(callsAfterAnalyze).toBeGreaterThan(0);

    const groups = await request(app).get('/corrections/groups').set(auth());
    expect(groups.status).toBe(200);
    expect(groups.body.mode).toBe('meaning');
    expect(groups.body.groupCount).toBe(1);
    expect(groups.body.groups[0].records.map((r: { scrubbedSummary: string }) => r.scrubbedSummary).sort()).toEqual(['summary 0', 'summary 1']);
    expect(JSON.stringify(groups.body)).not.toContain('constitution');
    expect(ts.calls()).toBe(callsAfterAnalyze); // read surface makes no model calls
  });

  it('without a grouper both routes fall back to word overlap', async () => {
    const app = appWith(ctxFor(stateDir, ledger));
    const analyzed = await request(app).post('/corrections/analyze').set(auth());
    expect(analyzed.body.grouping).toEqual({ mode: 'words', reason: 'disabled' });
    expect(analyzed.body.analysis.groups).toBe(0);
    const groups = await request(app).get('/corrections/groups').set(auth());
    expect(groups.body.mode).toBe('words');
    expect(groups.body.groupCount).toBe(0);
  });

  it('503 without a ledger, 401 without a token', async () => {
    const app = appWith(ctxFor(stateDir, null));
    expect((await request(app).get('/corrections/groups').set(auth())).status).toBe(503);
    expect((await request(app).get('/corrections/groups')).status).toBe(401);
  });
});
