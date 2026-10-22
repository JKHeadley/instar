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
import { buildLocalVerifyService, buildStatusReconciler, installedSafeMergePath, loadSafeMergeFloor } from '../../src/localVerify/localVerifyWiring.js';
import type { GhRunner } from '../../src/localVerify/reconcilerSeams.js';
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

function ctx(stateDir: string, localVerify: RouteContext['localVerify'], localVerifyStatus: RouteContext['localVerifyStatus'] = null): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify, localVerifyStatus,
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
  it('loads safe-merge from the installed package, not the working checkout', async () => {
    expect(installedSafeMergePath()).toBe(path.join(ROOT, 'scripts', 'safe-merge.mjs'));
    // A checkout holding an older safe-merge (no ACTIONS_FLOOR_CONTEXTS) is never consulted.
    const { home } = sourceCheckout();
    fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), 'export const REQUIRED_CONTEXTS_FLOOR = [];\n');
    expect(await loadSafeMergeFloor(path.join(home, 'scripts', 'safe-merge.mjs'))).toBeNull();
    expect(await loadSafeMergeFloor()).not.toBeNull();
  });

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

  it('the status loop loads safe-merge\'s REAL evaluator + floor from the source checkout (one implementation)', async () => {
    const f = await loadSafeMergeFloor();
    expect(f).not.toBeNull();
    expect(typeof f!.evaluate).toBe('function');
    expect(f!.actionsFloor.map((c) => c.context)).toEqual(expect.arrayContaining(['Type Check', 'Build', 'eli16']));
    expect(f!.actionsFloor.some((c) => c.context === 'instar/local-verify')).toBe(false);
    expect(f!.actionsFloor.length).toBeGreaterThan(6); // the pinned classic contexts are included
    expect(typeof f!.approverAcceptance).toBe('function');
  });

  it('status loop built through the production wiring: alive over HTTP (200), boots a pass, posts nothing in dry-run', async () => {
    const { home, stateDir } = sourceCheckout();
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    });
    await built.service!.boot();
    const posted: string[][] = [];
    const gh: GhRunner = async (args) => {
      if (args.includes('POST')) { posted.push(args); return { ok: true, stdout: '{}' }; }
      if (args[0] === 'pr') return { ok: true, stdout: '[]' };
      // The main head read fails here on purpose: a readable head would start a REAL verify child.
      return { ok: false, status: 404, stderr: 'HTTP 404' }; // settings unreadable ⇒ check treated as required, floor actions
    };
    const st = await buildStatusReconciler({
      repo: 'JKHeadley/instar', repoPath: home, stateDir, machineId: 'm_e2e', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      service: built.service, localVerifyEnabled: () => true, postStatuses: () => false, configFloor: () => 'local', watcherRepo: () => 'JKHeadley/instar',
      lease: { holdsLease: () => true, leaseEpoch: () => 0, leaseHolder: () => 'm_e2e' },
      gh, floorExports: (await loadSafeMergeFloor())!,
    });
    expect(st.reason).toBeNull();
    const pass = await st.reconciler!.pass();
    expect(pass.outcome).toBe('ok'); // unreadable settings never stop the pass (check treated as required)
    const r = await request(serve(ctx(stateDir, built.service, st.reconciler))).get('/local-verify/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'dry-run', floor: { configured: 'local', effective: 'actions', reason: 'settings-unreadable', checkRequired: true }, takeoverFloorCheck: 'not-built', lastPass: { outcome: 'ok' }, passBackoff: null, settingsReadable: false });
    expect(built.service!.snapshot().inFlight).toBeNull();
    expect(posted).toEqual([]);
    built.service!.shutdown();
  });

  it('status loop needs a source checkout and a GitHub login, and uses the installed safe-merge; route 503 when absent', async () => {
    const { home, stateDir } = sourceCheckout();
    const base = {
      repo: 'JKHeadley/instar', repoPath: home, stateDir, machineId: 'm', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: null, service: null,
      localVerifyEnabled: () => false, postStatuses: () => false, configFloor: () => 'actions' as const, watcherRepo: () => 'JKHeadley/instar',
      lease: { holdsLease: () => true, leaseEpoch: () => 0, leaseHolder: () => 'm' },
    };
    expect((await buildStatusReconciler({ ...base, repoPath: os.tmpdir() })).reason).toBe('no-source-checkout');
    expect((await buildStatusReconciler({ ...base, expectedGhLogin: '' })).reason).toBe('no-gh-login');
    // The checkout's stand-in safe-merge exports nothing, but the loop loads the
    // installed safe-merge, so it is built.
    expect((await buildStatusReconciler(base)).reason).toBeNull();
    expect((await request(serve(ctx(stateDir, null, null))).get('/local-verify/status')).status).toBe(503);
  });
});
