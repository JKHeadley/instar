import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import {
  AlignmentReviewer,
  GoalRealignmentIntake,
  PriorityLedger,
  type PriorityExtraction,
} from '../../src/monitoring/GoalRealignment.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'goal-realignment-route-token';

function ctxFor(stateDir: string, enabled: boolean | undefined, developmentAgent: boolean): RouteContext {
  return {
    config: {
      projectName: 'goal-realignment-routes',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      authToken: AUTH,
      developmentAgent,
      monitoring: {
        goalRealignment: {
          ...(enabled === undefined ? {} : { enabled }),
          dryRun: true,
          cadenceMinutes: 60,
          recencyDays: 7,
        },
      },
      sessions: {} as never,
      scheduler: {} as never,
    } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    feedbackAnomalyDetector: null,
    discoveryEvaluator: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use(createRoutes(ctx));
  return app;
}

describe('GET /goal-realignment (Phase 1 pull surface)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-realignment-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/goal-realignment-routes.test.ts:afterEach',
    });
  });

  it('is bearer-authenticated and 503 when the dev gate resolves dark', async () => {
    const dark = appWith(ctxFor(stateDir, undefined, false));
    expect((await request(dark).get('/goal-realignment')).status).toBe(401);
    const response = await request(dark)
      .get('/goal-realignment')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(response.status).toBe(503);
  });

  it('exposes ledger, candidate backlog, counters, and the latest dry-run verdict', async () => {
    const ledger = new PriorityLedger({ stateDir });
    const intake = new GoalRealignmentIntake({
      ledger,
      promptId: 'priority-v1',
      model: 'fast-test',
      extract: async (): Promise<PriorityExtraction> => ({
        classification: 'priority',
        normalizedPriority: 'Keep Phase 1 observable.',
        quote: 'keep Phase 1 observable',
        confidence: 0.98,
      }),
    });
    await intake.ingest({
      platform: 'telegram',
      topicId: 458,
      messageId: '200',
      senderUid: 'operator',
      operatorUid: 'operator',
      timestamp: '2026-07-27T18:00:00.000Z',
      text: 'Please keep Phase 1 observable.',
      forwarded: false,
    });
    const priorityId = ledger.listPriorities(458)[0].priorityId;
    const reviewer = new AlignmentReviewer({
      stateDir,
      ledger,
      dryRun: true,
      promptId: 'alignment-v1',
      model: 'fast-test',
      review: async () => JSON.stringify({
        verdict: 'drifting',
        confidence: 0.9,
        reason: 'The queue does not yet serve the priority.',
        unaddressedPriorityIds: [priorityId],
      }),
    });
    await reviewer.tick({
      topicId: 458,
      runId: 'run-1',
      focus: { goal: 'Unrelated cleanup', tasks: ['cleanup'] },
    });

    const response = await request(appWith(ctxFor(stateDir, undefined, true)))
      .get('/goal-realignment?topicId=458')
      .set('Authorization', `Bearer ${AUTH}`)
      .expect(200);

    expect(response.body).toMatchObject({
      enabled: true,
      dryRun: true,
      priorityLifetime: 'until-explicitly-superseded-or-confirmed-addressed',
      topics: [{
        topicId: 458,
        candidateInbox: { total: 1, pending: 0 },
        priorities: [{ priorityId, state: 'open' }],
        lastVerdict: { verdict: 'drifting', disposition: 'dry-run' },
        reviewCounters: { injected: 0, reviewed: 1 },
      }],
    });
  });

  it('rejects malformed topic filters', async () => {
    const response = await request(appWith(ctxFor(stateDir, true, false)))
      .get('/goal-realignment?topicId=not-a-number')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(response.status).toBe(400);
  });
});
