/**
 * Integration (Tier 2) for the Autonomous Completion Discipline signal extension on
 * POST /autonomous/evaluate-stop and POST /autonomous/evaluate-completion.
 * Spec: docs/specs/AUTONOMOUS-COMPLETION-DISCIPLINE.md §2b.4 / §5.
 *
 * Mounts the REAL router (createRoutes) with a minimal RouteContext, and verifies:
 *   - the optional `signals` (+ `stopKind`) body is parsed and passed through;
 *   - a NO-signals body behaves exactly as before (backward-compat route test);
 *   - `p13ProtocolVersion` is stamped on EVERY response (block, allow, AND 503/error);
 *   - `classifiedBlocker` is returned on a `stopKind:'hard-blocker'` request.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { P13_PROTOCOL_VERSION } from '../../src/core/CompletionEvaluator.js';

function appWith(completionEvaluator: unknown): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    completionEvaluator,
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    stateDir: '/tmp',
  };
  app.use(createRoutes(ctx));
  return app;
}

describe('POST /autonomous/evaluate-stop — signal passthrough + protocol stamp', () => {
  it('parses signals + stopKind and passes them to evaluateStopRationale', async () => {
    let seenTail = '';
    let seenSignals: any;
    const app = appWith({
      async evaluateStopRationale(tail: string, signals: unknown) {
        seenTail = tail; seenSignals = signals;
        return { stopAllowed: false, guidance: 'milestone is not a stop', classifiedBlocker: 'buildable' };
      },
    });
    const res = await request(app).post('/autonomous/evaluate-stop').send({
      transcriptTail: 'this is a clean milestone',
      stopKind: 'hard-blocker',
      signals: { completionConditionMet: false, uncheckedTaskCount: 3, taskStructure: 'has-tasks', milestoneRationalizationDetected: true, injectionSuspected: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.stopAllowed).toBe(false);
    expect(res.body.p13ProtocolVersion).toBe(P13_PROTOCOL_VERSION);
    expect(res.body.classifiedBlocker).toBe('buildable');
    expect(seenTail).toBe('this is a clean milestone');
    expect(seenSignals).toMatchObject({ uncheckedTaskCount: 3, milestoneRationalizationDetected: true, stopKind: 'hard-blocker' });
  });

  it('stamps p13ProtocolVersion on an ALLOW verdict too', async () => {
    const app = appWith({
      async evaluateStopRationale() { return { stopAllowed: true, guidance: '' }; },
    });
    const res = await request(app).post('/autonomous/evaluate-stop').send({ transcriptTail: 'opened PR #9' });
    expect(res.status).toBe(200);
    expect(res.body.stopAllowed).toBe(true);
    expect(res.body.p13ProtocolVersion).toBe(P13_PROTOCOL_VERSION);
  });

  it('NO signals body → undefined signals (backward-compat) + still stamps the version', async () => {
    let seenSignals: unknown = 'SENTINEL';
    const app = appWith({
      async evaluateStopRationale(_tail: string, signals: unknown) { seenSignals = signals; return { stopAllowed: true, guidance: '' }; },
    });
    const res = await request(app).post('/autonomous/evaluate-stop').send({ transcriptTail: 'x' });
    expect(res.status).toBe(200);
    expect(seenSignals).toBeUndefined();
    expect(res.body.p13ProtocolVersion).toBe(P13_PROTOCOL_VERSION);
  });

  it('an empty {signals:{}} body still yields undefined signals (no spurious objective block)', async () => {
    let seenSignals: unknown = 'SENTINEL';
    const app = appWith({
      async evaluateStopRationale(_tail: string, signals: unknown) { seenSignals = signals; return { stopAllowed: true, guidance: '' }; },
    });
    await request(app).post('/autonomous/evaluate-stop').send({ transcriptTail: 'x', signals: {} });
    expect(seenSignals).toBeUndefined();
  });

  it('503 (no evaluator) STILL carries p13ProtocolVersion (so a new hook tells old-server from timed-out)', async () => {
    const app = appWith(null);
    const res = await request(app).post('/autonomous/evaluate-stop').send({ transcriptTail: 'x' });
    expect(res.status).toBe(503);
    expect(res.body.p13ProtocolVersion).toBe(P13_PROTOCOL_VERSION);
  });

  it('500 (evaluator throws) STILL carries p13ProtocolVersion', async () => {
    const app = appWith({
      async evaluateStopRationale() { throw new Error('boom'); },
    });
    const res = await request(app).post('/autonomous/evaluate-stop').send({ transcriptTail: 'x' });
    expect(res.status).toBe(500);
    expect(res.body.p13ProtocolVersion).toBe(P13_PROTOCOL_VERSION);
  });
});

describe('POST /autonomous/evaluate-completion — signal passthrough (folded P13)', () => {
  it('parses signals and passes them to evaluate (the folded milestone scrutiny)', async () => {
    let seenSignals: any;
    const app = appWith({
      async evaluate(_c: string, _t: string, signals: unknown) { seenSignals = signals; return { met: false, reason: 'not yet' }; },
    });
    const res = await request(app).post('/autonomous/evaluate-completion').send({
      condition: 'all tests pass',
      transcriptTail: 'this is a clean milestone',
      signals: { uncheckedTaskCount: 2, milestoneRationalizationDetected: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.met).toBe(false);
    expect(seenSignals).toMatchObject({ uncheckedTaskCount: 2, milestoneRationalizationDetected: true });
  });

  it('NO signals body behaves exactly as today (undefined signals)', async () => {
    let seenSignals: unknown = 'SENTINEL';
    const app = appWith({
      async evaluate(_c: string, _t: string, signals: unknown) { seenSignals = signals; return { met: true, reason: 'done' }; },
    });
    const res = await request(app).post('/autonomous/evaluate-completion').send({ condition: 'x', transcriptTail: 'y' });
    expect(res.status).toBe(200);
    expect(res.body.met).toBe(true);
    expect(seenSignals).toBeUndefined();
  });

  it('400 when condition is missing (unchanged)', async () => {
    const app = appWith({ async evaluate() { return { met: true, reason: '' }; } });
    const res = await request(app).post('/autonomous/evaluate-completion').send({ transcriptTail: 'y' });
    expect(res.status).toBe(400);
  });
});
