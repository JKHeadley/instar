/**
 * POST + GET /gemini-loop/runs through the real createRoutes pipeline (need-gem-002).
 *  - 503 when the runner is not wired.
 *  - 409 'disabled' when the runner is wired but the feature flag is off.
 *  - 400 when goalPrompt is missing.
 *  - 202 {runId} on admission; GET /:id reflects the async result; GET lists runs.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { GeminiLoopRunner } from '../../src/monitoring/GeminiLoopRunner.js';
import { DEFAULT_DONE_SENTINEL } from '../../src/monitoring/GeminiLoopDriver.js';

function ctxWith(runner: GeminiLoopRunner | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
    geminiLoopRunner: runner,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(runner: GeminiLoopRunner | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(runner)));
  return app;
}

function makeRunner(enabled: boolean): GeminiLoopRunner {
  let n = 0;
  return new GeminiLoopRunner({
    config: {
      enabled,
      model: 'gemini-2.5-flash',
      maxTurns: 4,
      minTurnIntervalMs: 0,
      maxConcurrent: 1,
      maxRetainedRuns: 50,
    },
    // finishes in one turn via the sentinel — no real gemini
    spawn: async () => ({ exitCode: 0, stdout: `ok\n${DEFAULT_DONE_SENTINEL}`, stderr: '', truncated: false }),
    captureHandle: async () => 'handle-uuid',
    budgetGate: () => ({ ok: true }),
    genId: () => `run-${++n}`,
  });
}

describe('POST/GET /gemini-loop/runs (integration)', () => {
  it('returns 503 when the runner is not wired', async () => {
    const res = await request(appWith(null)).post('/gemini-loop/runs').send({ goalPrompt: 'x' });
    expect(res.status).toBe(503);
  });

  it('returns 409 disabled when the feature flag is off', async () => {
    const res = await request(appWith(makeRunner(false))).post('/gemini-loop/runs').send({ goalPrompt: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('disabled');
  });

  it('returns 400 when goalPrompt is missing', async () => {
    const res = await request(appWith(makeRunner(true))).post('/gemini-loop/runs').send({});
    expect(res.status).toBe(400);
  });

  it('admits a run (202 + runId), then the result is retrievable, and listed', async () => {
    const app = appWith(makeRunner(true));
    const start = await request(app).post('/gemini-loop/runs').send({ goalPrompt: 'do the thing' });
    expect(start.status).toBe(202);
    expect(start.body.runId).toBeTruthy();
    const runId = start.body.runId;

    // poll the result route until the async loop settles
    let rec: any;
    for (let i = 0; i < 20; i++) {
      const got = await request(app).get(`/gemini-loop/runs/${runId}`);
      expect(got.status).toBe(200);
      rec = got.body;
      if (rec.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rec.status).toBe('done');
    expect(rec.result.stopReason).toBe('done-sentinel');

    const list = await request(app).get('/gemini-loop/runs');
    expect(list.status).toBe(200);
    expect(list.body.runs.some((r: any) => r.runId === runId)).toBe(true);
  });

  it('returns 404 for an unknown runId', async () => {
    const res = await request(appWith(makeRunner(true))).get('/gemini-loop/runs/nope');
    expect(res.status).toBe(404);
  });
});
