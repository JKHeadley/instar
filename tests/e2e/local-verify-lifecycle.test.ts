// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 lifecycle test for local-verify (spec docs/specs/local-verify-merge-authority.md §2):
 * the service is built through buildLocalVerifyService, the same function
 * server.ts calls, booted, and served through the real routes. Proves the
 * feature is alive (200, not 503) when enabled on a source checkout, and
 * inert (503) when disabled or off a source checkout.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildLocalVerifyService } from '../../src/localVerify/localVerifyWiring.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'localVerify', 'runVerifyMain.js');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-lifecycle.test.ts' }); });

function sourceCheckout(): { home: string; stateDir: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvlife-')));
  dirs.push(home);
  fs.mkdirSync(path.join(home, '.git'));
  fs.mkdirSync(path.join(home, 'scripts'));
  fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// stand-in\n');
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(stateDir);
  return { home, stateDir };
}

function ctx(stateDir: string, localVerify: RouteContext['localVerify']): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify,
    startTime: new Date(),
  } as never;
}

function serve(c: RouteContext) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(c));
  return a;
}

describe('local-verify lifecycle (production wiring)', () => {
  it('the built dist ships the child entry the server spawns', () => {
    expect(fs.existsSync(DIST_ENTRY)).toBe(true);
  });

  it('enabled on a source checkout: built, booted, and alive over HTTP (200)', async () => {
    const { home, stateDir } = sourceCheckout();
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    });
    expect(built.reason).toBeNull();
    expect(built.service).not.toBeNull();
    await built.service!.boot();
    const r = await request(serve(ctx(stateDir, built.service))).get('/local-verify');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ queue: [], inFlight: null, blocked: false, records: 0 });
    built.service!.shutdown();
  });

  it('disabled, off a source checkout, or with no GitHub login: not built, routes 503', async () => {
    const { home, stateDir } = sourceCheckout();
    const base = { expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm', mainEntry: DIST_ENTRY };
    expect(buildLocalVerifyService({ ...base, config: undefined }).reason).toBe('disabled');
    expect(buildLocalVerifyService({ ...base, config: { enabled: false } }).reason).toBe('disabled');
    expect(buildLocalVerifyService({ ...base, config: { enabled: true }, repoPath: os.tmpdir() }).reason).toBe('no-source-checkout');
    expect(buildLocalVerifyService({ ...base, config: { enabled: true }, expectedGhLogin: '' }).reason).toBe('no-gh-login');
    expect(buildLocalVerifyService({ ...base, config: { enabled: true }, mainEntry: path.join(home, 'missing.js') }).reason).toBe('no-entry');
    const r = await request(serve(ctx(stateDir, null))).get('/local-verify');
    expect(r.status).toBe(503);
  });
});
