// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Doorway/Model Knowledge Registry
 * `GET /doorways` route (docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md §D5 / Tier 3).
 *
 * Per TESTING-INTEGRITY-SPEC this is the single most important test for a route feature: is it
 * ALIVE on the production init path (200, NOT 503) when the registry is present? It boots the
 * REAL AgentServer (the same factory server.ts uses) and proves:
 *   (a) SOURCE-CARRYING agent (manifest present): GET /doorways → 200 scanState:"never-run"
 *       BEFORE any scan (honest-empty, NOT 503), and 200 merged AFTER a scan-state exists.
 *   (b) NON-instar-source agent (no manifest): GET /doorways → 503 registry-unavailable-no-instar-source.
 *   (c) the route requires Bearer auth (401 without a token) — the always-mounted-under-global-auth proof.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function baseConfig(stateDir: string, projectDir: string, auth: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

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

describe('Doorway registry E2E (feature is alive): GET /doorways 200-not-503 / 503 / 401', () => {
  let tmpDir: string;
  const AUTH = 'test-e2e-doorways';

  let sourceServer: AgentServer;
  let sourceApp: express.Express;
  let sourceStateDir: string;

  let bareServer: AgentServer;
  let bareApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorway-e2e-'));

    // (a) SOURCE-CARRYING agent: projectDir carries the canonical manifest under scripts/.
    const sourceProjectDir = path.join(tmpDir, 'source-proj');
    fs.mkdirSync(path.join(sourceProjectDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(sourceProjectDir, 'scripts', 'model-registry-freshness.manifest.json'), JSON.stringify(MANIFEST));
    sourceStateDir = mkStateDir(tmpDir, 'source-state');
    sourceServer = new AgentServer({
      config: baseConfig(sourceStateDir, sourceProjectDir, AUTH),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(sourceStateDir),
    });
    await sourceServer.start();
    sourceApp = sourceServer.getApp();

    // (b) NON-instar-source agent: projectDir has NO manifest.
    const bareProjectDir = path.join(tmpDir, 'bare-proj');
    fs.mkdirSync(bareProjectDir, { recursive: true });
    const bareStateDir = mkStateDir(tmpDir, 'bare-state');
    bareServer = new AgentServer({
      config: baseConfig(bareStateDir, bareProjectDir, AUTH),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(bareStateDir),
    });
    await bareServer.start();
    bareApp = bareServer.getApp();
  });

  afterAll(async () => {
    await sourceServer?.stop();
    await bareServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/doorway-registry-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) SOURCE-CARRYING: GET /doorways is ALIVE — 200 scanState:"never-run" before any scan (NOT 503)', async () => {
    const res = await request(sourceApp).get('/doorways').set(auth());
    expect(res.status).toBe(200); // the alive proof — NOT 503
    expect(res.body.scanState).toBe('never-run');
    const cc = res.body.doorways.find((d: { doorId: string }) => d.doorId === 'claude-code');
    expect(cc).toBeDefined();
    expect(cc.topModels[0].id).toBe('claude-opus-4-8');
    expect(cc.reachable).toBeNull();
    expect(cc.probeStatus).toBe('never-scanned');
  });

  it('(a2) SOURCE-CARRYING: 200 merged view after a scan-state exists', async () => {
    fs.mkdirSync(path.join(sourceStateDir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceStateDir, 'state', 'doorway-scan.json'),
      JSON.stringify({ schemaVersion: 1, lastScanAt: '2026-07-04T10:00:00.000Z', doorways: [{ id: 'claude-code', probeStatus: 'ok', lastScannedAt: '2026-07-04T10:00:00.000Z' }] }),
    );
    const res = await request(sourceApp).get('/doorways').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.scanState).toBe('scanned');
    const cc = res.body.doorways.find((d: { doorId: string }) => d.doorId === 'claude-code');
    expect(cc.reachable).toBe(true);
    expect(cc.probeStatus).toBe('ok');
  });

  it('(b) NON-instar-source: GET /doorways → 503 registry-unavailable-no-instar-source', async () => {
    const res = await request(bareApp).get('/doorways').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('registry-unavailable-no-instar-source');
  });

  it('(c) the route requires Bearer auth (401 without a token)', async () => {
    expect((await request(sourceApp).get('/doorways')).status).toBe(401);
  });
});
