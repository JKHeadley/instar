/**
 * Integration tests — GET /preferences/session-context (Correction & Preference
 * Learning Sentinel, Slice 1a).
 *
 * Tier 2 of the Testing Integrity Standard. Exercises the REAL production path:
 * the inline /preferences route in createRoutes(), mounted behind the real
 * authMiddleware (so the 401 path is exercised the same way production wires
 * it), backed by file-based state via PreferencesManager.
 *
 * Covers:
 *   - 401 without a bearer token
 *   - 503 when the feature is disabled (monitoring.correctionLearning.enabled !== true)
 *   - 200 with the structured block when enabled + preferences exist
 *   - { present: false } when enabled but no preferences yet
 *   - serves ONLY learning + metadata (no raw extras like dedupeKey leak)
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
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-prefs-bearer';

function ctxFor(stateDir: string, correctionLearningEnabled: boolean): RouteContext {
  return {
    config: {
      projectName: 'prefs-test',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      monitoring: { correctionLearning: { enabled: correctionLearningEnabled, maxInjectedPreferencesBytes: 4000 } },
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(stateDir: string, enabled: boolean): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH_TOKEN));
  app.use('/', createRoutes(ctxFor(stateDir, enabled)));
  return app;
}

describe('GET /preferences/session-context (integration, real createRoutes + authMiddleware)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/preferences-routes.test.ts:afterEach' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  it('401 without a bearer token', async () => {
    const app = appWith(stateDir, true);
    const res = await request(app).get('/preferences/session-context');
    expect(res.status).toBe(401);
  });

  it('503 when the feature is disabled', async () => {
    const app = appWith(stateDir, false);
    const res = await request(app).get('/preferences/session-context').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('correction-learning disabled');
  });

  it('200 with { present: false } when enabled but no preferences exist', async () => {
    const app = appWith(stateDir, true);
    const res = await request(app).get('/preferences/session-context').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(false);
    expect(res.body.block).toBe('');
    expect(res.body.count).toBe(0);
  });

  it('200 with a structured block when enabled + preferences exist', async () => {
    // Write a preference via the ONLY writer, then serve it through the route.
    new PreferencesManager(stateDir).recordPreference({
      learning: 'Lead with the one action, no preamble.',
      dedupeKey: 'user-preference:lead-action',
      confidence: 0.85,
    });

    const app = appWith(stateDir, true);
    const res = await request(app).get('/preferences/session-context').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.block).toContain('Lead with the one action, no preamble.');
    expect(res.body.block).toContain("<auto-learned-preference src='correction-loop'>");
  });

  it('serves only learning + metadata — no raw extras (dedupeKey/provenance never leak)', async () => {
    new PreferencesManager(stateDir).recordPreference({
      learning: 'Plainer language, please.',
      dedupeKey: 'user-preference:secret-dedupe-marker',
      confidence: 0.7,
    });

    const app = appWith(stateDir, true);
    const res = await request(app).get('/preferences/session-context').set(auth());
    const serialized = JSON.stringify(res.body);
    expect(serialized).toContain('Plainer language, please.');
    // Internal dedupeKey must not appear anywhere in the served payload.
    expect(serialized).not.toContain('secret-dedupe-marker');
  });
});
