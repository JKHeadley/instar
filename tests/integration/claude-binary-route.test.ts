// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests — GET /sessions/claude-binary + POST /sessions/claude-binary/prune
 * (CMT-798) over the real Express router with a REAL SessionManager.
 *
 * Both sides of the availability boundary: a SessionManager carrying the
 * retainer → 200 with the Registry-First shape that reflects what the spawn
 * path did; a SessionManager that predates the feature (mock without the
 * method) → honest 503, never a 500.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/claude-binary-route.test.ts';

function fakeInstall(root: string, version: string): string {
  const pkgDir = path.join(root, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  const exe = path.join(pkgDir, 'bin', 'claude.exe');
  fs.writeFileSync(exe, `FAKE-CLAUDE-${version}\n`, { mode: 0o755 });
  const link = path.join(root, 'bin', 'claude');
  fs.symlinkSync(path.relative(path.dirname(link), exe), link);
  return link;
}

function ctxWith(sessionManager: unknown, projectDir: string): RouteContext {
  return {
    config: { projectName: 'test', projectDir, stateDir: path.join(projectDir, '.instar'), port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: sessionManager as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, tokenLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

describe('/sessions/claude-binary (integration)', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-route-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP }));

  it('GET returns the retainer status from a real SessionManager and reflects a real spawn-path resolution', async () => {
    const claude = fakeInstall(path.join(projectDir, 'fake-install'), '2.1.299');
    const sm = new SessionManager({
      tmuxPath: '/usr/bin/false', claudePath: claude, projectDir,
      maxSessions: 1, protectedSessions: [], completionPatterns: [],
    }, new StateManager(projectDir));
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(sm, projectDir)));

    const before = await request(app).get('/sessions/claude-binary');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: true, current: null, lastResolution: null, retained: [], lastError: null });
    expect(before.body.dir).toBe(path.join(projectDir, '.instar', 'state', 'claude-bin'));

    // What the spawn path does — then the route must say so.
    const launched = sm.resolveLaunchBinary('claude-code', claude);
    const after = await request(app).get('/sessions/claude-binary');
    expect(after.status).toBe(200);
    expect(after.body.current).toEqual({ key: '2.1.299', version: '2.1.299', path: launched });
    expect(after.body.lastResolution).toMatchObject({ source: 'retained', version: '2.1.299', copied: true, sourcePath: claude });
    expect(after.body.retained).toHaveLength(1);
    expect(after.body.retained[0]).toMatchObject({ key: '2.1.299', current: true });
    expect(after.body.counters).toEqual({ resolutions: 1, retained: 1, copies: 1, fallbacks: 0 });

    const prune = await request(app).post('/sessions/claude-binary/prune');
    expect(prune.status).toBe(200);
    expect(prune.body.keptCurrent).toEqual(['2.1.299']);
    expect(prune.body.removed).toEqual([]);
    const afterPrune = await request(app).get('/sessions/claude-binary');
    expect(afterPrune.body.lastPrune.at).toBe(prune.body.at);
  });

  it('GET reports enabled:false + reason when the off switch is set', async () => {
    const claude = fakeInstall(path.join(projectDir, 'fake-install'), '2.1.299');
    const sm = new SessionManager({
      tmuxPath: '/usr/bin/false', claudePath: claude, projectDir,
      maxSessions: 1, protectedSessions: [], completionPatterns: [],
      retainedClaudeBinary: { enabled: false },
    }, new StateManager(projectDir));
    const app = express();
    app.use('/', createRoutes(ctxWith(sm, projectDir)));
    expect(sm.resolveLaunchBinary('claude-code', claude)).toBe(claude);
    const res = await request(app).get('/sessions/claude-binary');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.lastResolution.reason).toBe('disabled');
  });

  it('a SessionManager without the feature → 503 (never a 500) on both routes', async () => {
    const app = express();
    app.use('/', createRoutes(ctxWith({ listRunningSessions: () => [] }, projectDir)));
    const get = await request(app).get('/sessions/claude-binary');
    expect(get.status).toBe(503);
    expect(get.body.error).toBe('claude-binary-retainer-unavailable');
    const post = await request(app).post('/sessions/claude-binary/prune');
    expect(post.status).toBe(503);
  });
});
