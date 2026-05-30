/**
 * Wiring-integrity tests — Correction & Preference Learning Sentinel, Slice 1a.
 *
 * The Testing Integrity Standard requires a wiring-integrity test for every
 * dependency-injected / structurally-load-bearing component. For Slice 1a the
 * two structural guarantees are:
 *
 *   1. recordPreference() is the ONLY writer to .instar/preferences.json — the
 *      file is created lazily on first write, and an external mutation (a
 *      direct fs write) is the ONLY other way content lands on disk (which the
 *      loop never does). We pin that PreferencesManager itself never writes on
 *      a pure read path, and that the write path is atomic (no partial file).
 *   2. The route is gated correctly: 503 when monitoring.correctionLearning
 *      .enabled !== true, 200 otherwise — verified directly against the route
 *      gate logic (the config flag is the single source of truth).
 *
 * These complement the unit (logic) and integration (HTTP) tiers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'wiring-token';

function ctxFor(stateDir: string, correctionLearning: unknown): RouteContext {
  return {
    config: {
      projectName: 'wiring', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH_TOKEN, monitoring: { correctionLearning },
      sessions: {} as any, scheduler: {} as any,
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

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('Preferences wiring integrity (Slice 1a)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-wiring-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/preferences-wiring-integrity.test.ts:afterEach' });
  });

  describe('recordPreference is the only writer', () => {
    it('a pure read path never creates or mutates the file', () => {
      const mgr = new PreferencesManager(stateDir);
      mgr.read();
      mgr.sessionContext();
      expect(fs.existsSync(mgr.getPath())).toBe(false);
    });

    it('the file appears on disk only after recordPreference()', () => {
      const mgr = new PreferencesManager(stateDir);
      expect(fs.existsSync(mgr.getPath())).toBe(false);
      mgr.recordPreference({ learning: 'x', dedupeKey: 'k:1' });
      expect(fs.existsSync(mgr.getPath())).toBe(true);
    });

    it('the on-disk file is always valid JSON after a write (atomic, no partial)', () => {
      const mgr = new PreferencesManager(stateDir);
      for (let i = 0; i < 25; i++) mgr.recordPreference({ learning: `learning ${i}`, dedupeKey: `k:${i % 5}` });
      const raw = fs.readFileSync(mgr.getPath(), 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed.preferences)).toBe(true);
      // 5 distinct dedupeKeys → exactly 5 entries (upsert, not append)
      expect(parsed.preferences).toHaveLength(5);
    });
  });

  describe('route gate is keyed solely on monitoring.correctionLearning.enabled', () => {
    it('503 when undefined', async () => {
      const res = await request(appWith(ctxFor(stateDir, undefined))).get('/preferences/session-context');
      expect(res.status).toBe(503);
    });

    it('503 when { enabled: false }', async () => {
      const res = await request(appWith(ctxFor(stateDir, { enabled: false }))).get('/preferences/session-context');
      expect(res.status).toBe(503);
    });

    it('503 when enabled is a truthy non-true value (strict === true gate)', async () => {
      const res = await request(appWith(ctxFor(stateDir, { enabled: 'yes' }))).get('/preferences/session-context');
      expect(res.status).toBe(503);
    });

    it('200 only when { enabled: true }', async () => {
      const res = await request(appWith(ctxFor(stateDir, { enabled: true }))).get('/preferences/session-context');
      expect(res.status).toBe(200);
    });
  });
});
