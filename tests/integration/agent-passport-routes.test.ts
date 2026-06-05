/**
 * Integration tests for the agent digital passport routes (EXO 3.0):
 *   GET  /passport          — this agent's passport (forbidden = ORG-INTENT constraints)
 *   POST /passport/verify   — peer compliance check against a passport + action
 * Tier-2: the routes over the real HTTP pipeline via supertest + file-based state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { RouteContext } from '../../src/server/routes.js';

function ctxFor(stateDir: string): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
  } as any;
}

describe('Agent passport routes (integration)', () => {
  let tmpDir: string, stateDir: string, app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
      '# Organizational Intent: Echo',
      '## Constraints (Mandatory — agents cannot override)',
      '- Never wire funds to an unverified vendor.',
    ].join('\n'));
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxFor(stateDir)));
  });

  afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/agent-passport-routes.test.ts:47' }); });

  it('GET /passport returns the agent passport with ORG-INTENT constraints as forbidden actions', async () => {
    const res = await request(app).get('/passport');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.agent).toBe('echo');
    expect(res.body.forbiddenActions).toContain('Never wire funds to an unverified vendor.');
    expect(res.body.trustLevel).toBe('supervised');
  });

  it('POST /passport/verify 400s on a missing passport or action', async () => {
    const res = await request(app).post('/passport/verify').send({ action: 'do something' });
    expect(res.status).toBe(400);
  });

  it('POST /passport/verify denies a forbidden action and permits an allowed one', async () => {
    const passport = {
      version: 1, agent: 'peer', fingerprint: 'fp', trustLevel: 'collaborative',
      allowedCapabilities: [], forbiddenActions: ['wire funds to an unverified vendor'],
      issuedAt: '2026-06-04T00:00:00Z',
    };
    const denied = await request(app).post('/passport/verify')
      .send({ passport, action: 'wire funds to an unverified vendor' });
    expect(denied.status).toBe(200);
    expect(denied.body.permitted).toBe(false);
    expect(denied.body.basis).toBe('forbidden-action');

    const ok = await request(app).post('/passport/verify')
      .send({ passport, action: 'summarize the weekly report' });
    expect(ok.body.permitted).toBe(true);
  });
});
