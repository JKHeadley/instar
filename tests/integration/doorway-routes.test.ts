// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration test — `GET /doorways` through the real Express `createRoutes` pipeline
 * (docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md §D5 / Tier 2). Proves the D5 two-state
 * status contract over HTTP:
 *   - never-run → 200 with scanState:"never-run" + canonical topModels (asserted NOT 503);
 *   - scan-state present → 200 merged view;
 *   - canonical manifest absent → 503 code:"registry-unavailable-no-instar-source";
 *   - canonical manifest corrupt → 503 code:"registry-corrupt".
 * (401-without-Bearer is proven in the Tier-3 e2e via the real AgentServer auth middleware — the
 *  createRoutes harness intentionally mounts without auth so route logic is exercised directly.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MANIFEST = {
  registrySchemaVersion: 2,
  stalenessWindowDays: 45,
  enforcement: 'report',
  doors: {
    'claude-code': {
      name: 'Claude Code CLI',
      status: 'alive',
      probe: { kind: 'cli-version', bin: 'claude', metered: false },
      topModels: [{ id: 'claude-opus-4-8', role: 'capable-anthropic', frontier: true, pricing: null, verifiedAt: 'carried-over-from-allowlist' }],
    },
  },
  candidateDoorways: ['claude-code'],
};

function ctxFor(projectDir: string, stateDir: string): RouteContext {
  return {
    config: { projectName: 'echo', projectDir, stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appFor(projectDir: string, stateDir: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxFor(projectDir, stateDir)));
  return app;
}

describe('GET /doorways — D5 two-state status contract (integration)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorway-int-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/doorway-routes.test.ts' });
  });

  function mkAgent(name: string, opts: { manifest?: unknown; scanState?: unknown } = {}): { projectDir: string; stateDir: string } {
    const projectDir = path.join(tmp, name);
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    if (opts.manifest !== undefined) {
      fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'scripts', 'model-registry-freshness.manifest.json'),
        typeof opts.manifest === 'string' ? opts.manifest : JSON.stringify(opts.manifest),
      );
    }
    if (opts.scanState !== undefined) {
      fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'state', 'doorway-scan.json'), JSON.stringify(opts.scanState));
    }
    return { projectDir, stateDir };
  }

  it('never-run → 200 with scanState:"never-run" + canonical topModels (NOT 503)', async () => {
    const { projectDir, stateDir } = mkAgent('never-run', { manifest: MANIFEST });
    const res = await request(appFor(projectDir, stateDir)).get('/doorways');
    expect(res.status).toBe(200);
    expect(res.body.scanState).toBe('never-run');
    const cc = res.body.doorways.find((d: { doorId: string }) => d.doorId === 'claude-code');
    expect(cc.reachable).toBeNull();
    expect(cc.probeStatus).toBe('never-scanned');
    expect(cc.topModels[0].id).toBe('claude-opus-4-8');
  });

  it('scan-state present → 200 merged view', async () => {
    const { projectDir, stateDir } = mkAgent('scanned', {
      manifest: MANIFEST,
      scanState: {
        schemaVersion: 1,
        lastScanAt: '2026-07-04T10:00:00.000Z',
        doorways: [{ id: 'claude-code', probeStatus: 'ok', lastScannedAt: '2026-07-04T10:00:00.000Z' }],
      },
    });
    const res = await request(appFor(projectDir, stateDir)).get('/doorways');
    expect(res.status).toBe(200);
    expect(res.body.scanState).toBe('scanned');
    const cc = res.body.doorways.find((d: { doorId: string }) => d.doorId === 'claude-code');
    expect(cc.reachable).toBe(true);
    expect(cc.probeStatus).toBe('ok');
  });

  it('canonical manifest absent → 503 code:"registry-unavailable-no-instar-source"', async () => {
    const { projectDir, stateDir } = mkAgent('no-manifest'); // no manifest written
    const res = await request(appFor(projectDir, stateDir)).get('/doorways');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('registry-unavailable-no-instar-source');
  });

  it('canonical manifest corrupt → 503 code:"registry-corrupt"', async () => {
    const { projectDir, stateDir } = mkAgent('corrupt', { manifest: '{ not valid json ' });
    const res = await request(appFor(projectDir, stateDir)).get('/doorways');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('registry-corrupt');
  });
});
