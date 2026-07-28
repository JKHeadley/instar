/**
 * Route-level test for POST /health/degradations/mark-reported (PR0c —
 * context-death-pitfall-prevention spec). Mirrors the buildApp pattern
 * used elsewhere in tests/unit/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { Router } from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  const router = Router();

  router.post('/health/degradations/mark-reported', (req, res) => {
    const reporter = DegradationReporter.getInstance();
    const { feature, featurePattern } = req.body ?? {};
    if (typeof feature === 'string' && feature.length > 0) {
      const flipped = reporter.markReported(feature);
      res.json({ flipped });
      return;
    }
    if (typeof featurePattern === 'string' && featurePattern.length > 0) {
      let re: RegExp;
      try {
        re = new RegExp(featurePattern);
      } catch (err) {
        res.status(400).json({
          error: 'invalid featurePattern',
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const flipped = reporter.markReported(re);
      res.json({ flipped });
      return;
    }
    res.status(400).json({ error: 'feature or featurePattern required' });
  });

  app.use(router);
  return app;
}

describe('POST /health/degradations/mark-reported', () => {
  let tmpDir: string;

  beforeEach(() => {
    DegradationReporter.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-reported-route-'));
    const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: tmpDir, agentName: 't', instarVersion: '0' });
    reporter.report({
      feature: 'unjustifiedStopGate.timeout',
      primary: 'p',
      fallback: 'f',
      reason: 'r',
      impact: 'i',
    });
    reporter.report({
      feature: 'unjustifiedStopGate.malformed',
      primary: 'p',
      fallback: 'f',
      reason: 'r',
      impact: 'i',
    });
  });

  afterEach(() => {
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/routes-degradations-mark-reported.test.ts:83' });
  });

  it('flips by exact feature name', async () => {
    const res = await request(buildApp())
      .post('/health/degradations/mark-reported')
      .send({ feature: 'unjustifiedStopGate.timeout' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flipped: 1 });
  });

  it('flips multiple via featurePattern regex', async () => {
    const res = await request(buildApp())
      .post('/health/degradations/mark-reported')
      .send({ featurePattern: '^unjustifiedStopGate\\.' });
    expect(res.status).toBe(200);
    expect(res.body.flipped).toBe(2);
  });

  it('returns 400 when neither feature nor featurePattern is provided', async () => {
    const res = await request(buildApp())
      .post('/health/degradations/mark-reported')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid featurePattern regex', async () => {
    const res = await request(buildApp())
      .post('/health/degradations/mark-reported')
      .send({ featurePattern: '[unterminated' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid featurePattern/);
  });

  it('idempotent: re-flipping returns 0', async () => {
    const app = buildApp();
    await request(app)
      .post('/health/degradations/mark-reported')
      .send({ feature: 'unjustifiedStopGate.timeout' });
    const second = await request(app)
      .post('/health/degradations/mark-reported')
      .send({ feature: 'unjustifiedStopGate.timeout' });
    expect(second.body.flipped).toBe(0);
  });
});
