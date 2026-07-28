/**
 * Integration tests for the Slack registration routes (Phase 1) behind the real router:
 *   POST /permissions/registrations/register | approve | deny
 *   GET  /permissions/registrations/pending
 * Spec: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.3.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string | null = null;

function ctxWith(stateDir: string): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir, port: 0, users: [], sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(stateDir: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(stateDir)));
  return app;
}

afterEach(() => {
  if (tmp) {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/slack-registration-routes.test.ts' });
    tmp = null;
  }
});

describe('Slack registration routes (integration)', () => {
  it('admin register creates a user with the role', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reg-routes-'));
    const app = appWith(tmp);
    const res = await request(app)
      .post('/permissions/registrations/register')
      .send({ slackUserId: 'U_SARAH', displayName: 'Sarah', role: 'contributor' });
    expect(res.status).toBe(200);
    expect(res.body.registered).toBe(true);
    expect(res.body.profile.orgRole).toBe('contributor');
    expect(res.body.profile.slackUserId).toBe('U_SARAH');
  });

  it('rejects an invalid role with 400', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reg-routes-'));
    const res = await request(appWith(tmp))
      .post('/permissions/registrations/register')
      .send({ slackUserId: 'U_X', displayName: 'X', role: 'superadmin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid role/);
  });

  it('lists a seeded pending request and approves it', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reg-routes-'));
    // Seed a pending entry (in production this is written by the gate when an
    // unregistered user makes a directed request).
    fs.writeFileSync(
      path.join(tmp, 'slack-pending-registrations.json'),
      JSON.stringify([{ slackUserId: 'U_MAYA', displayName: 'Maya', requestedAt: new Date().toISOString() }]) + '\n',
    );
    const app = appWith(tmp);

    const pending = await request(app).get('/permissions/registrations/pending');
    expect(pending.status).toBe(200);
    expect(pending.body.pending).toHaveLength(1);
    expect(pending.body.pending[0].slackUserId).toBe('U_MAYA');

    const approve = await request(app)
      .post('/permissions/registrations/approve')
      .send({ slackUserId: 'U_MAYA', role: 'member' });
    expect(approve.status).toBe(200);
    expect(approve.body.profile.orgRole).toBe('member');
    expect(approve.body.profile.name).toBe('Maya');

    const after = await request(app).get('/permissions/registrations/pending');
    expect(after.body.pending).toHaveLength(0);
  });

  it('deny drops a seeded pending request', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reg-routes-'));
    fs.writeFileSync(
      path.join(tmp, 'slack-pending-registrations.json'),
      JSON.stringify([{ slackUserId: 'U_GHOST', displayName: 'Ghost', requestedAt: new Date().toISOString() }]) + '\n',
    );
    const app = appWith(tmp);
    const deny = await request(app).post('/permissions/registrations/deny').send({ slackUserId: 'U_GHOST' });
    expect(deny.status).toBe(200);
    expect(deny.body.denied).toBe(true);
    const after = await request(app).get('/permissions/registrations/pending');
    expect(after.body.pending).toHaveLength(0);
  });
});
