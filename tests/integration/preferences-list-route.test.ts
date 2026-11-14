/**
 * Integration — GET /preferences (the dated, structured learned-preference list the
 * console Learned page reads). Real createRoutes() behind the real authMiddleware,
 * backed by the real file store.
 *   - 401 without the bearer token; 503 when correction learning is off
 *   - 200 with an empty list when nothing is learned yet
 *   - 200 with dated entries, newest first, origin = this machine when known
 *   - never serves violationPattern / provenance; scrubs a credential in the text
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { PreferencesManager, PREFERENCES_SCHEMA_VERSION } from '../../src/core/PreferencesManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-prefs-list-bearer';

function ctxFor(stateDir: string, enabled: boolean, meshSelfId?: string): RouteContext {
  return {
    config: {
      projectName: 'prefs-list-test', projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: AUTH_TOKEN,
      monitoring: { correctionLearning: { enabled, maxInjectedPreferencesBytes: 4000 } },
      sessions: {} as any, scheduler: {} as any,
    } as any,
    meshSelfId,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH_TOKEN));
  app.use('/', createRoutes(ctx));
  return app;
}

describe('GET /preferences (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-list-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/preferences-list-route.test.ts:afterEach' });
  });

  it('401 without a bearer token', async () => {
    const res = await request(appWith(ctxFor(stateDir, true))).get('/preferences');
    expect(res.status).toBe(401);
  });

  it('503 when correction learning is off', async () => {
    const res = await request(appWith(ctxFor(stateDir, false))).get('/preferences').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('correction-learning disabled');
  });

  it('200 with an empty list when nothing is learned yet', async () => {
    const res = await request(appWith(ctxFor(stateDir, true))).get('/preferences').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [], total: 0, truncated: false, scope: 'local' });
  });

  it('serves dated entries newest first, stamped with this machine', async () => {
    const pm = new PreferencesManager(stateDir);
    pm.recordPreference({ learning: 'Older lesson', dedupeKey: 'user-preference:old', confidence: 0.6, recordedAt: '2026-09-01T12:00:00.000Z' });
    pm.recordPreference({ learning: 'Newer lesson', dedupeKey: 'user-preference:new', confidence: 0.9, recordedAt: '2026-10-25T12:00:00.000Z' });
    const res = await request(appWith(ctxFor(stateDir, true, 'm_studio'))).get('/preferences').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.entries.map((e: { learning: string }) => e.learning)).toEqual(['Newer lesson', 'Older lesson']);
    expect(res.body.entries[0]).toEqual({ dedupeKey: 'user-preference:new', learning: 'Newer lesson', recordedAt: '2026-10-25T12:00:00.000Z', confidence: 0.9, dedupeCount: 1, origin: 'm_studio' });
  });

  it('never serves violationPattern or provenance, and scrubs a credential in the text', async () => {
    const key = 'AKIAABCDEFGHIJKLMNOP';
    fs.writeFileSync(path.join(stateDir, 'preferences.json'), JSON.stringify({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      preferences: [{ learning: `Use ${key} on the bench`, provenance: 'correction-loop', dedupeKey: 'k', recordedAt: '2026-10-25T12:00:00.000Z', confidence: 0.7, dedupeCount: 2, violationPattern: 'regex:private-rule' }],
    }));
    const res = await request(appWith(ctxFor(stateDir, true))).get('/preferences').set(auth());
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(key);
    expect(body).not.toContain('private-rule');
    expect(body).not.toContain('correction-loop');
    expect(res.body.entries[0].textRedacted).toBe(true);
    expect(res.body.entries[0].origin).toBeUndefined();
  });
});
