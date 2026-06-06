/**
 * Integration tests for POST /agent-readiness/score (EXO 3.0 task-decomposition
 * matrix). Tier-2 of the Testing Integrity Standard: the route over the real
 * HTTP pipeline via supertest + a minimal RouteContext.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';

function createMinimalContext(): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
  } as any;
}

describe('POST /agent-readiness/score (integration)', () => {
  let app: express.Express;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(createMinimalContext()));
  });

  it('400s when neither task nor workflow is provided', async () => {
    const res = await request(app).post('/agent-readiness/score').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/task|workflow/);
  });

  it('scores a coordination-dominant task as deploy-agent', async () => {
    const res = await request(app).post('/agent-readiness/score').send({
      task: { description: 'Route invoices, schedule approvals, track status, compile a report, notify owners. Standardized.' },
    });
    expect(res.status).toBe(200);
    expect(res.body.recommendation).toBe('deploy-agent');
    expect(res.body.overallReadiness).toBeGreaterThanOrEqual(75);
  });

  it('scores a judgment-dominant task as human-led', async () => {
    const res = await request(app).post('/agent-readiness/score').send({
      task: { description: 'Negotiate a sensitive partnership, resolve ambiguity, navigate the relationship, make a strategic call with no playbook.' },
    });
    expect(res.status).toBe(200);
    expect(res.body.recommendation).toBe('human-led');
  });

  it('scores a workflow by its steps', async () => {
    const res = await request(app).post('/agent-readiness/score').send({
      workflow: { steps: ['Fetch record', 'Assign accounts', 'Schedule orientation', 'Update tracker'] },
    });
    expect(res.status).toBe(200);
    expect(res.body.overallReadiness).toBeGreaterThanOrEqual(55);
  });
});
