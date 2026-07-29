/**
 * Tier-2 integration test for `POST /intent/journal` — the agent-authored
 * decision write path.
 *
 * WHY THIS FILE EXISTS. The refusal that matters here lives at the ROUTE, not
 * in the validator. The validator is a pure function; it can be perfect while
 * the route never calls it, and the unit suite would still pass in full. That
 * is precisely what happened one feature earlier tonight — a module thoroughly
 * guarded, its wiring not, and nineteen green tests agreeing that a surface
 * serving nothing was fine.
 *
 * So: the unit tests prove the validator refuses. These prove the route ASKS it.
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

const PROJECT_NAME = 'decision-journal-route-' + Math.random().toString(36).slice(2, 8);
const SESSION = 'sess-route-test';
let AUTH = '';

function buildCtx(tmpDir: string): RouteContext {
  return {
    config: {
      projectName: PROJECT_NAME, projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: AUTH,
    } as never,
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
}

function mount(tmpDir: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(buildCtx(tmpDir)));
  return app;
}

describe('POST /intent/journal (integration — the wiring, not just the validator)', () => {
  let tmpDir: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-journal-route-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    AUTH = generateAgentToken(PROJECT_NAME);
    app = mount(tmpDir);
  });
  afterEach(() => {
    try { deleteAgentToken(PROJECT_NAME); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true, operation: 'tests/integration/decision-journal-route.test.ts:cleanup',
    });
  });

  const post = (body: unknown) =>
    request(app).post('/intent/journal').set('Authorization', `Bearer ${AUTH}`).send(body as object);

  it('REGRESSION: the ROUTE refuses a decision that names no principle', async () => {
    // If the route stops calling the validator, this returns 201 and breaks.
    const res = await post({ sessionId: SESSION, decision: 'Split the spec' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('missing-required');
    expect(res.body.missingFields).toContain('principle');
  });

  it('REGRESSION: the ROUTE refuses fields no reader consumes', async () => {
    // The literal submission from the incident that produced this feature.
    const res = await post({
      sessionId: SESSION,
      decision: 'Prune the run file at item-closure',
      principle: 'Structure > Willpower',
      reasoning: 'effort-based pruning measurably lost ground',
      checkedAgainst: 'northstar; tier-1 topic goal',
    });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('unknown-fields');
    expect(res.body.unknownFields).toEqual(['checkedAgainst', 'reasoning']);
  });

  it('REGRESSION: the ROUTE refuses confidence labels before they reach JSONL', async () => {
    const res = await post({
      sessionId: SESSION,
      decision: 'Record a confidence-bearing decision',
      principle: 'Contract matches computation',
      confidence: 'high',
    });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('invalid-field');
    expect(res.body.invalidFields).toEqual(['confidence']);
  });

  it('normalizes numeric confidence strings to stored numbers', async () => {
    const res = await post({
      sessionId: SESSION,
      decision: 'Record a numeric confidence',
      principle: 'Contract matches computation',
      confidence: '0.8',
    });

    expect(res.status).toBe(201);
    expect(res.body.confidence).toBe(0.8);
    expect(typeof res.body.confidence).toBe('number');
  });

  it('REGRESSION: a refused submission writes NOTHING', async () => {
    await post({ sessionId: SESSION, decision: 'no principle here' });
    await post({ sessionId: SESSION, decision: 'x', principle: 'p', bogus: 1 });

    const stats = await request(app)
      .get('/intent/journal/stats').set('Authorization', `Bearer ${AUTH}`);

    // A refusal that still recorded the row would be worse than no refusal:
    // the journal would carry entries the caller was told were rejected.
    expect(stats.body.count).toBe(0);
  });

  it('accepts a complete submission and records the principle', async () => {
    const res = await post({
      sessionId: SESSION,
      decision: 'Prune the run file at item-closure',
      principle: 'Structure > Willpower',
      context: 'effort-based pruning lost ground five times; closure-triggered worked twice',
    });

    expect(res.status).toBe(201);
    expect(res.body.principle).toBe('Structure > Willpower');

    const stats = await request(app)
      .get('/intent/journal/stats').set('Authorization', `Bearer ${AUTH}`);
    expect(stats.body.count).toBe(1);
    expect(stats.body.principledCount).toBe(1);
    expect(stats.body.unprincipledCount).toBe(0);
  });

  it('REGRESSION: /intent/journal/stats exposes the principled split', async () => {
    // The read surface has to carry the new counters or the honesty fix is
    // invisible to every consumer — a fixed module behind an unchanged surface.
    const stats = await request(app)
      .get('/intent/journal/stats').set('Authorization', `Bearer ${AUTH}`);

    expect(stats.status).toBe(200);
    expect(stats.body).toHaveProperty('principledCount');
    expect(stats.body).toHaveProperty('unprincipledCount');
  });

  it('the refusal message tells the caller where the content belongs', async () => {
    const res = await post({
      sessionId: SESSION, decision: 'd', principle: 'p', reasoning: 'r',
    });
    // A refusal that does not name the correct field just relocates the failure.
    expect(res.body.error).toMatch(/context/);
    expect(res.body.error).toMatch(/never read/i);
  });
});
