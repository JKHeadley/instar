/**
 * Integration tests for the Failure-Learning Loop HTTP routes (spec §4.5).
 *
 * Exercises the REAL production path: the inline /failures routes in
 * createRoutes(), wired to a real in-memory FailureLedger + AttributionEngine
 * via the route context (the same way AgentServer wires them). Covers:
 *  - 503-stub when disabled (ledger absent) — surface always exists
 *  - GET /failures + /analysis + /insights alive (200, not 503)
 *  - detail.full NEVER appears in any response (§4.8 redaction)
 *  - POST /failures requires X-Instar-Request, validates the initiative,
 *    stamps filedBy, stays one-tap (§4.2 #B / B6)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import { FailureAttributionEngine } from '../../src/monitoring/FailureAttributionEngine.js';

function minimalCtx(extra: Partial<RouteContext>): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
    ...extra,
  } as RouteContext;
}

function appWith(ledger: FailureLedger | null, engine: FailureAttributionEngine | null) {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(minimalCtx({ failureLedger: ledger, failureAttributionEngine: engine })));
  return app;
}

describe('Failure-Learning routes (integration, real createRoutes path)', () => {
  let ledger: FailureLedger;
  let engine: FailureAttributionEngine;
  let app: express.Express;

  beforeEach(() => {
    ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'testbox' });
    engine = new FailureAttributionEngine({
      getInitiative: (id) => (id === 'init-foo' ? { id: 'init-foo', parentProjectId: 'proj-1', specPath: 'docs/specs/foo.md' } : null),
      commitTouchedFiles: () => [],
    });
    app = appWith(ledger, engine);
  });
  afterEach(() => ledger.close());

  it('503-stubs every route when the feature is disabled (ledger absent)', async () => {
    const disabled = appWith(null, null);
    await request(disabled).get('/failures').expect(503);
    await request(disabled).get('/failures/analysis').expect(503);
    await request(disabled).post('/failures').set('X-Instar-Request', '1').expect(503);
  });

  it('GET /failures, /analysis, /insights are alive (200, not 503)', async () => {
    await request(app).get('/failures').expect(200);
    await request(app).get('/failures/analysis').expect(200);
    await request(app).get('/failures/insights').expect(200);
  });

  it('GET /failures never leaks detail.full (§4.8 redaction)', async () => {
    ledger.open({
      filedBy: 's1', source: 'bugfix-commit', severity: 'high',
      summary: 'boom', detail: { redacted: 'boom in <module>', full: 'boom in src/secret/Path.ts' },
      category: 'logic', initiativeId: 'init-foo', causeCommitOid: 'c1', attribution: 'automatic',
    });
    const res = await request(app).get('/failures').expect(200);
    expect(JSON.stringify(res.body)).not.toContain('secret/Path');
    expect(res.body.failures[0].detail).toEqual({ redacted: 'boom in <module>' });
    expect(res.body.failures[0].detail.full).toBeUndefined();
  });

  it('POST /failures requires the X-Instar-Request intent header (§4.2#B)', async () => {
    await request(app).post('/failures').send({ summary: 'x', initiativeId: 'init-foo' }).expect(403);
  });

  it('POST /failures rejects a nonexistent initiative (server-side validation, A2)', async () => {
    await request(app).post('/failures').set('X-Instar-Request', '1')
      .send({ summary: 'x', initiativeId: 'ghost' }).expect(400);
  });

  it('POST /failures records a one-tap diagnosis (never upgrades to automatic, B6) + stamps filedBy', async () => {
    const res = await request(app).post('/failures')
      .set('X-Instar-Request', '1').set('X-Instar-AgentId', 'echo')
      .send({ summary: 'flaky thing', initiativeId: 'init-foo', causeCommitOid: 'c9', severity: 'low' })
      .expect(201);
    expect(res.body.attribution).toBe('one-tap');
    expect(res.body.filedBy).toBe('echo');
    expect(res.body.initiativeId).toBe('init-foo');
    expect(res.body.projectId).toBe('proj-1');
    await request(app).get(`/failures/${res.body.id}`).expect(200);
  });

  it('GET /failures/:id 404s for an unknown id', async () => {
    await request(app).get('/failures/FAIL-testbox-999').expect(404);
  });
});

describe('POST /failures/analyze (closed-loop execution over HTTP)', () => {
  let ledger: FailureLedger;
  afterEach(() => ledger.close());

  it('discovers a thresholded insight and opens tracked items via the wired managers', async () => {
    ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' });
    // Seed a diverse concurrency cluster (4 sessions, 4 cause-commits).
    for (const [s, c] of [['sA', 'k1'], ['sB', 'k2'], ['sC', 'k3'], ['sD', 'k4']]) {
      ledger.open({ filedBy: s, source: 'bugfix-commit', severity: 'medium', summary: 'race',
        detail: { redacted: 'race', full: 'race' }, category: 'concurrency', initiativeId: 'init-foo',
        causeCommitOid: c, attribution: 'automatic', attributionConfidence: 0.9 });
    }
    const addAction = vi.fn(() => ({ id: 'ACT-1' }));
    const createInitiative = vi.fn(async (i: { id: string }) => ({ id: i.id }));
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(minimalCtx({
      failureLedger: ledger,
      failureAttributionEngine: null,
      evolution: { addAction } as never,
      initiativeTracker: { create: createInitiative } as never,
    })));

    const res = await request(app).post('/failures/analyze').set('X-Instar-Request', '1').expect(200);
    expect(res.body.analysis.insightsDiscovered).toHaveLength(1);
    expect(res.body.actedOn).toBe(1);
    expect(addAction).toHaveBeenCalledTimes(1);
    expect(createInitiative).toHaveBeenCalledTimes(1);

    const insights = await request(app).get('/failures/insights').expect(200);
    expect(insights.body.insights[0].status).toBe('acted-on');
  });
});

// Process Health tab route extensions (spec §3 / §4.3): ETag/304 diff-aware
// polling, before= keyset pagination validation, and the rollout block the tab
// reads to draw the maturation track.
describe('Process Health route extensions (ETag/304, before=, rollout)', () => {
  function appWithConfig(fl: unknown) {
    const ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' });
    const app = express();
    app.use(express.json());
    const ctx = minimalCtx({ failureLedger: ledger, failureAttributionEngine: null });
    (ctx.config as any).monitoring = { failureLearning: fl };
    app.use('/', createRoutes(ctx));
    return { app, ledger };
  }

  it('GET /failures returns an ETag and answers 304 to a matching If-None-Match', async () => {
    const { app, ledger } = appWithConfig({ enabled: true });
    try {
      const res = await request(app).get('/failures').expect(200);
      const etag = res.headers.etag;
      expect(etag).toBeTruthy();
      await request(app).get('/failures').set('If-None-Match', etag).expect(304);
    } finally {
      ledger.close();
    }
  });

  it('GET /failures and /failures/insights reject a non-ISO before= with 400', async () => {
    const { app, ledger } = appWithConfig({ enabled: true });
    try {
      await request(app).get('/failures?before=not-a-date').expect(400);
      await request(app).get('/failures/insights?before=not-a-date').expect(400);
      // A valid ISO timestamp is accepted.
      await request(app).get(`/failures?before=${encodeURIComponent(new Date().toISOString())}`).expect(200);
    } finally {
      ledger.close();
    }
  });

  it('GET /failures/analysis derives rollout.stage from the two failureLearning flags', async () => {
    const cases: Array<[unknown, string]> = [
      [undefined, 'dark'],
      [{ enabled: false }, 'dark'],
      [{ enabled: true }, 'capture-only'],
      [{ enabled: true, insightTelegramEscalation: true }, 'insight-push'],
    ];
    for (const [fl, expectedStage] of cases) {
      const { app, ledger } = appWithConfig(fl);
      try {
        const res = await request(app).get('/failures/analysis').expect(200);
        expect(res.body.rollout).toBeDefined();
        expect(res.body.rollout.stage).toBe(expectedStage);
        // The per-agent flag never yields the 4th "default-on" stage (tab draws it as future).
        expect(['dark', 'capture-only', 'insight-push']).toContain(res.body.rollout.stage);
      } finally {
        ledger.close();
      }
    }
  });
});
