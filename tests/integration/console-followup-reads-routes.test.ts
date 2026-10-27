// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration (Tier 2) — the console follow-up reads over real HTTP
 * (docs/specs/console-features/people-settings.md):
 *   - GET /preferences through the real createRoutes + authMiddleware: 401 without the
 *     token, 503 when correction-learning is off, 200 with the structured entries (no
 *     violationPattern, credential scrubbed, origin = this machine).
 *   - GET /api/files/search through the real createFileRoutes: a name match, refusal of
 *     key material / a secret name / a symlink to a key / a folder outside the allowed
 *     paths, 400 without q, 404 while the viewer is off, and the root list's new
 *     `truncated` flag.
 *   - The console-only CSP from the real dashboardSecurityHeaders middleware.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware, dashboardSecurityHeaders } from '../../src/server/middleware.js';
import { createFileRoutes } from '../../src/server/fileRoutes.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-followup-bearer';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

function prefsApp(stateDir: string, enabled: boolean, meshSelfId?: string): express.Express {
  const ctx = {
    config: {
      projectName: 'followup-test', projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: AUTH,
      monitoring: { correctionLearning: { enabled, maxInjectedPreferencesBytes: 4000 } },
      sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(), meshSelfId,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

describe('GET /preferences (integration)', () => {
  let tmp: string;
  let stateDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-prefs-'));
    stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/console-followup-reads-routes.test.ts:prefs' }); });

  it('401 without the token; 503 when correction-learning is off', async () => {
    expect((await request(prefsApp(stateDir, true)).get('/preferences')).status).toBe(401);
    const off = await request(prefsApp(stateDir, false)).get('/preferences').set(auth());
    expect(off.status).toBe(503);
    expect(off.body.error).toContain('correction-learning disabled');
  });

  it('200 with structured entries: newest first, origin stamped, violationPattern never served, a credential scrubbed', async () => {
    const m = new PreferencesManager(stateDir);
    m.recordPreference({ learning: 'Lead with the short answer', dedupeKey: 'user-preference:a', confidence: 0.9, violationPattern: 'regex:operator-only-rule' } as any);
    m.recordPreference({ learning: 'Bench key is AKIAABCDEFGHIJKLMNOP for now', dedupeKey: 'user-preference:b', confidence: 0.6 } as any);
    const res = await request(prefsApp(stateDir, true, 'm_self')).get('/preferences').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, truncated: false, scope: 'local' });
    expect(res.body.entries).toHaveLength(2);
    for (const e of res.body.entries) {
      expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['confidence', 'dedupeCount', 'dedupeKey', 'learning', 'origin', 'recordedAt']));
      expect(e.origin).toBe('m_self');
      expect(e).not.toHaveProperty('violationPattern');
      expect(e).not.toHaveProperty('provenance');
    }
    expect(JSON.stringify(res.body)).not.toContain('operator-only-rule');
    expect(JSON.stringify(res.body)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(res.body.entries.find((e: { dedupeKey: string }) => e.dedupeKey === 'user-preference:b').textRedacted).toBe(true);
  });

  it('an empty store is an empty list, not an error', async () => {
    const res = await request(prefsApp(stateDir, true)).get('/preferences').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entries: [], total: 0, truncated: false });
    expect(res.body.entries[0]).toBeUndefined();
  });
});

describe('GET /api/files/search and the root list (integration)', () => {
  let dir: string;
  const appFor = (fileViewer: Record<string, unknown> = {}) => {
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(AUTH));
    app.use(createFileRoutes({ config: { projectDir: dir, dashboard: { fileViewer } } as any }));
    return app;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-files-'));
    fs.mkdirSync(path.join(dir, 'docs/deep'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'private'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/deep/plan-notes.md'), 'x');
    fs.writeFileSync(path.join(dir, 'private/plan-private.md'), 'x');
    fs.writeFileSync(path.join(dir, '.instar/identity.json'), '{"privateKey":"x"}');
    fs.writeFileSync(path.join(dir, '.instar/config.json'), '{"authToken":"x"}');
    fs.writeFileSync(path.join(dir, 'docs/.env'), 'SECRET=1');
    fs.writeFileSync(path.join(dir, 'docs/plan.pem'), 'x');
    fs.symlinkSync(path.join(dir, '.instar/identity.json'), path.join(dir, 'docs/plan-identity.json'));
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/console-followup-reads-routes.test.ts:files' }); });

  it('finds a name deep in the project; refuses without the token', async () => {
    expect((await request(appFor()).get('/api/files/search?q=plan')).status).toBe(401);
    const res = await request(appFor()).get('/api/files/search?q=PLAN').set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.query).toBe('PLAN');
    expect(res.body.results.map((r: { path: string }) => r.path).sort()).toEqual(['docs/deep/plan-notes.md', 'private/plan-private.md']);
    expect(res.body.truncated).toBe(false);
  });

  it('key material, secret names and a symlink to a key never appear', async () => {
    for (const q of ['identity', 'config', '.env', 'pem']) {
      const res = await request(appFor()).get(`/api/files/search?q=${encodeURIComponent(q)}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
    }
  });

  it('outside the allowed paths is never searched', async () => {
    const res = await request(appFor({ allowedPaths: ['docs/'] })).get('/api/files/search?q=plan').set(auth());
    expect(res.body.results.map((r: { path: string }) => r.path)).toEqual(['docs/deep/plan-notes.md']);
  });

  it('400 without q or with an over-long q; a limit caps and says truncated; 404 while the viewer is off', async () => {
    expect((await request(appFor()).get('/api/files/search').set(auth())).status).toBe(400);
    expect((await request(appFor()).get(`/api/files/search?q=${'a'.repeat(201)}`).set(auth())).status).toBe(400);
    const capped = await request(appFor()).get('/api/files/search?q=plan&limit=1').set(auth());
    expect(capped.body.results).toHaveLength(1);
    expect(capped.body.truncated).toBe(true);
    const off = await request(appFor({ enabled: false })).get('/api/files/search?q=plan').set(auth());
    expect(off.status).toBe(404);
    expect(off.body.error).toBe('file viewer is disabled');
  });

  it('the project-root list now says when it was cut at 500', async () => {
    const small = await request(appFor()).get('/api/files/list').set(auth());
    expect(small.body.truncated).toBeUndefined();
    for (let i = 0; i < 505; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), '');
    const big = await request(appFor()).get('/api/files/list').set(auth());
    expect(big.body.truncated).toBe(true);
    expect(big.body.totalEntries).toBeGreaterThan(500);
    expect(big.body.entries.length).toBeLessThanOrEqual(500);
  });
});

describe('dashboard CSP (integration)', () => {
  it('the console page allows blob: images; the legacy dashboard does not', async () => {
    const app = express();
    app.use(dashboardSecurityHeaders);
    app.get(/^\/dashboard.*/, (_req, res) => { res.send('ok'); });
    const consoleRes = await request(app).get('/dashboard/console/');
    expect(consoleRes.headers['content-security-policy']).toContain("img-src 'self' blob:");
    expect(consoleRes.headers['content-security-policy']).not.toContain('data:');
    const legacy = await request(app).get('/dashboard');
    expect(legacy.headers['content-security-policy']).not.toContain('img-src');
    expect(legacy.headers['content-security-policy']).not.toContain('blob:');
  });
});
