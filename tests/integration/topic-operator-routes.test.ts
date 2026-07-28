/**
 * Integration tests — Topic Operator routes (Know Your Principal #898, increment 2).
 *
 * Exercises the full HTTP pipeline over a real file-backed TopicOperatorStore:
 *   - POST /topic-operator                       — bind from the AUTHENTICATED sender uid
 *   - GET  /topic-operator                       — all bound operators
 *   - GET  /topic-operator/:topicId              — one topic's operator (or null)
 *   - GET  /topic-operator/session-context?topicId=N — the <topic-operator> injection block
 *
 * The load-bearing security property is verified over the wire: a content name can
 * never become the operator — only the authenticated `uid` does, and a blank uid is
 * refused with 400. When the store is not wired, every route degrades to 503 (feature
 * not available), never a null-deref crash.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** A minimal RouteContext carrying only what the topic-operator routes need. */
function createMinimalContext(stateDir: string, withStore: boolean): RouteContext {
  return {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
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
    topicOperatorStore: withStore ? new TopicOperatorStore(path.join(stateDir, 'state')) : null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

describe('Topic Operator Routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let app: express.Express;

  function buildApp(withStore = true) {
    const ctx = createMinimalContext(stateDir, withStore);
    const a = express();
    a.use(express.json());
    a.use('/', createRoutes(ctx));
    return a;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-operator-routes-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    app = buildApp(true);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/topic-operator-routes.test.ts' });
  });

  // ── POST /topic-operator ───────────────────────────────────────────

  describe('POST /topic-operator', () => {
    it('binds a topic operator from the authenticated sender uid', async () => {
      const res = await request(app)
        .post('/topic-operator')
        .send({ topicId: 19437, platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
      expect(res.status).toBe(200);
      expect(res.body.bound).toBe(true);
      expect(res.body.topicId).toBe(19437);
      expect(res.body.operator.uid).toBe('7812716706');
      expect(res.body.operator.names).toEqual(['justin']);
      expect(res.body.operator.boundFrom).toBe('authenticated-inbound');
    });

    it('400s a blank uid — a content name can never establish an operator', async () => {
      const res = await request(app)
        .post('/topic-operator')
        .send({ topicId: 1, platform: 'telegram', uid: '', displayName: 'Caroline' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/verified sender uid/i);
      // And nothing was bound — the name in `displayName` did NOT become the operator.
      const after = await request(app).get('/topic-operator/1');
      expect(after.body.operator).toBeNull();
    });

    it('400s a missing topicId', async () => {
      const res = await request(app).post('/topic-operator').send({ uid: '999' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/topicId/);
    });

    it('persists the binding (a fresh request reads it back)', async () => {
      await request(app)
        .post('/topic-operator')
        .send({ topicId: 42, platform: 'telegram', uid: 'A', displayName: 'Alice' });
      const res = await request(app).get('/topic-operator/42');
      expect(res.status).toBe(200);
      expect(res.body.operator.uid).toBe('A');
    });
  });

  // ── GET /topic-operator (all) and /:topicId ─────────────────────────

  describe('GET /topic-operator', () => {
    it('lists all bound operators', async () => {
      await request(app).post('/topic-operator').send({ topicId: 1, uid: 'A', displayName: 'Alice' });
      await request(app).post('/topic-operator').send({ topicId: 2, uid: 'B', displayName: 'Bob' });
      const res = await request(app).get('/topic-operator');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.operators)).toEqual(['1', '2']);
      expect(res.body.operators['1'].uid).toBe('A');
    });

    it('returns operator:null for an unbound topic', async () => {
      const res = await request(app).get('/topic-operator/404');
      expect(res.status).toBe(200);
      expect(res.body.operator).toBeNull();
    });
  });

  // ── GET /topic-operator/session-context ─────────────────────────────

  describe('GET /topic-operator/session-context', () => {
    it('returns the <topic-operator> injection block when bound', async () => {
      await request(app)
        .post('/topic-operator')
        .send({ topicId: 19437, platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
      const res = await request(app).get('/topic-operator/session-context?topicId=19437');
      expect(res.status).toBe(200);
      expect(res.body.present).toBe(true);
      expect(res.body.block).toMatch(/^<topic-operator platform="telegram" uid="7812716706">/);
      expect(res.body.block).toContain('Justin is the VERIFIED operator');
      expect(res.body.block).toMatch(/not from any name in content/);
    });

    it('returns { present: false } for an unbound topic', async () => {
      const res = await request(app).get('/topic-operator/session-context?topicId=99999');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ present: false });
    });

    it('400s when topicId is missing', async () => {
      const res = await request(app).get('/topic-operator/session-context');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/topicId/);
    });
  });

  // ── Degradation: store not wired ────────────────────────────────────

  describe('when the store is not initialized', () => {
    it('every route returns 503 (feature not available), never a crash', async () => {
      const noStore = buildApp(false);
      expect((await request(noStore).get('/topic-operator')).status).toBe(503);
      expect((await request(noStore).get('/topic-operator/1')).status).toBe(503);
      expect((await request(noStore).get('/topic-operator/session-context?topicId=1')).status).toBe(503);
      expect((await request(noStore).post('/topic-operator').send({ topicId: 1, uid: 'A' })).status).toBe(503);
    });
  });
});
