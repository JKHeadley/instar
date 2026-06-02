/**
 * Integration (Tier 2) for POST /autonomous/evaluate-stop — the P13 "The Stop
 * Reason Is the Work" guard route. Mounts the REAL router (createRoutes) with a
 * minimal RouteContext (only completionEvaluator + config), mirroring
 * commitments-patch-route.test.ts, and verifies the route is wired to
 * completionEvaluator.evaluateStopRationale and returns its verdict over HTTP.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';

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

describe('POST /autonomous/evaluate-stop (P13 guard route)', () => {
  it('returns the verdict from completionEvaluator.evaluateStopRationale (blocked)', async () => {
    const app = appWith({
      async evaluateStopRationale() {
        return { stopAllowed: false, guidance: 'P13: derive+document the standard and proceed, or build the artifact.' };
      },
    });
    const res = await request(app).post('/autonomous/evaluate-stop').send({ transcriptTail: 'I should stop and get your judgment on the approach.' });
    expect(res.status).toBe(200);
    expect(res.body.stopAllowed).toBe(false);
    expect(res.body.guidance).toMatch(/P13|derive|artifact/);
  });

  it('passes the transcriptTail through and returns stopAllowed:true', async () => {
    let seen = '';
    const app = appWith({
      async evaluateStopRationale(tail: string) { seen = tail; return { stopAllowed: true, guidance: '' }; },
    });
    const res = await request(app).post('/autonomous/evaluate-stop').send({ transcriptTail: 'opened PR #9 and handed it over for review' });
    expect(res.status).toBe(200);
    expect(res.body.stopAllowed).toBe(true);
    expect(seen).toBe('opened PR #9 and handed it over for review');
  });

  it('503 when no completion evaluator is configured (the hook treats this as permit — fail-open)', async () => {
    const app = appWith(null);
    const res = await request(app).post('/autonomous/evaluate-stop').send({ transcriptTail: 'x' });
    expect(res.status).toBe(503);
  });
});
