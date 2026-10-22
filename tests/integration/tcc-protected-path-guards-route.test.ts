// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-2 integration — the TCC-protected path guard's row on the REAL
 * `GET /guards` route (createRoutes + authMiddleware), driven by the REAL
 * boot sequence the server uses: run the detection, register the getter
 * under TCC_GUARD_KEY, serve the inventory. Covers: the row exists with the
 * manifest's always-on/load-bearing metadata; a clean check reads
 * on-confirmed; a failed check reads verdictUnknown (on-blind, never green);
 * an unregistered guard reads `missing` (reconciliation, not omission);
 * Bearer-gated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  runTccProtectedPathDetection,
  tccGuardStatus,
  TCC_GUARD_KEY,
  type TccAttentionItemInput,
} from '../../src/core/TccProtectedPathGuard.js';

const AUTH = 'tcc-guards-route-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

let home: string;
let stateDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tcc-guards-route-'));
  fs.mkdirSync(path.join(home, 'Documents', 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
  stateDir = path.join(home, 'Projects', 'agent', '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ monitoring: {}, scheduler: { enabled: true } }));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/tcc-protected-path-guards-route.test.ts' });
});

function ctxFor(registry: GuardRegistry): RouteContext {
  return {
    config: {
      projectName: 'tcc-guards', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH, monitoring: {}, sessions: {} as unknown, scheduler: {} as unknown,
    } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
    guardRegistry: registry,
    meshSelfId: 'm-self',
  } as unknown as RouteContext;
}

function appWith(registry: GuardRegistry): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctxFor(registry)));
  return app;
}

type GuardRow = { key: string; effective: string; kind?: string; loadBearing?: boolean; runtime?: Record<string, unknown>; manifest?: Record<string, unknown> };
const rowOf = (body: { guards: GuardRow[] }) => body.guards.find((g) => g.key === TCC_GUARD_KEY);

describe('GET /guards — TCC-protected path guard row', () => {
  it('is Bearer-gated', async () => {
    const app = appWith(new GuardRegistry());
    expect((await request(app).get('/guards')).status).toBe(401);
  });

  it('after the real boot sequence on a SAFE macOS path: row present, on-confirmed, always-on, load-bearing', async () => {
    const registry = new GuardRegistry();
    const result = await runTccProtectedPathDetection({
      projectDir: path.dirname(stateDir), stateDir, platform: 'darwin', homeDir: home,
      emitAttention: async () => { throw new Error('must not emit for a safe path'); },
    });
    registry.register(TCC_GUARD_KEY, () => tccGuardStatus(result));
    const res = await request(appWith(registry)).get('/guards').set(auth());
    expect(res.status).toBe(200);
    const row = rowOf(res.body);
    expect(row).toBeDefined();
    expect(row!.effective).toBe('on-confirmed');
    expect(row!.runtime?.enabled).toBe(true);
    expect(row!.runtime?.lastTickAt).toBe(result.checkedAt);
    expect(String((row as { criticalPath?: string }).criticalPath)).toContain('TCC grant withdrawal');
    expect(JSON.stringify(row)).toContain('"loadBearing":true');
  });

  it('after the real boot sequence on a PROTECTED macOS path: the item fires once and the row is still on-confirmed (the guard works; the finding rides attention)', async () => {
    const protectedProject = path.join(home, 'Documents', 'Projects', 'inspec');
    const protectedState = path.join(protectedProject, '.instar');
    fs.mkdirSync(protectedState, { recursive: true });
    const emitted: TccAttentionItemInput[] = [];
    const registry = new GuardRegistry();
    const result = await runTccProtectedPathDetection({
      projectDir: protectedProject, stateDir: protectedState, platform: 'darwin', homeDir: home,
      emitAttention: async (item) => { emitted.push(item); },
    });
    registry.register(TCC_GUARD_KEY, () => tccGuardStatus(result));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].priority).toBe('HIGH');
    const res = await request(appWith(registry)).get('/guards').set(auth());
    expect(res.status).toBe(200);
    expect(rowOf(res.body)!.effective).toBe('on-confirmed');
  });

  it('a failed CLASSIFICATION reads on-blind (verdictUnknown) — louder, never green; a failed SINK does not blind the row', async () => {
    const protectedProject = path.join(home, 'Documents', 'Projects', 'codey');
    fs.mkdirSync(path.join(protectedProject, '.instar'), { recursive: true });
    const registry = new GuardRegistry();
    const result = await runTccProtectedPathDetection({
      projectDir: protectedProject, stateDir: path.join(protectedProject, '.instar'), platform: 'darwin', homeDir: home,
      emitAttention: async () => { throw new Error('attention sink down'); },
    });
    expect(result.emitError).toBe('attention sink down');
    registry.register(TCC_GUARD_KEY, () => tccGuardStatus(result));
    const sinkRes = await request(appWith(registry)).get('/guards').set(auth());
    expect(rowOf(sinkRes.body)!.effective).toBe('on-confirmed');
    registry.register(TCC_GUARD_KEY, () => tccGuardStatus({ ...result, error: 'classification failed' }));
    const res = await request(appWith(registry)).get('/guards').set(auth());
    const row = rowOf(res.body)!;
    expect(row.effective).toBe('on-blind');
    expect(row.runtime?.verdictUnknown).toBe(true);
    expect(String(row.runtime?.verdictUnknownReason)).toContain('classification failed');
  });

  it('never registered (a boot that skipped the guard) reads `missing` — reconciliation against the manifest, not silence', async () => {
    const res = await request(appWith(new GuardRegistry())).get('/guards').set(auth());
    expect(res.status).toBe(200);
    expect(rowOf(res.body)!.effective).toBe('missing');
  });

  it('on Linux the row exists and is on-confirmed with no finding (the guard runs; the check is not applicable)', async () => {
    const registry = new GuardRegistry();
    const result = await runTccProtectedPathDetection({
      projectDir: path.join(home, 'Documents', 'Projects', 'agent'), stateDir, platform: 'linux', homeDir: home,
      emitAttention: async () => { throw new Error('must not emit on linux'); },
    });
    expect(result.applicable).toBe(false);
    registry.register(TCC_GUARD_KEY, () => tccGuardStatus(result));
    const res = await request(appWith(registry)).get('/guards').set(auth());
    expect(rowOf(res.body)!.effective).toBe('on-confirmed');
  });
});
