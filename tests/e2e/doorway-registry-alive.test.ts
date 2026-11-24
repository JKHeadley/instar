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
 *   (d) a real signed package feeds both HTTP readers even with a conflicting checkout manifest.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readVerifiedPackagedCatalog } from '../../src/core/VerifiedPackagedCatalog.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
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

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGED_REVIEW_DATE = '2026-07-01';
const PACKAGED_MODEL = 'claude-packaged-fixture';

function createPackagedFixture(tmpDir: string, status: 'verified' | 'unavailable' | 'tampered') {
  const root = path.join(tmpDir, `install-${status}`);
  for (const dir of ['.instar-release-keys', 'src/scaffold/keys', 'scripts']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(root, '.instar-release-keys/private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'src/scaffold/keys/instar-release-pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  const pin = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

  const catalogPath = path.join(root, 'scripts/model-registry-freshness.manifest.json');
  if (status !== 'unavailable') {
    fs.writeFileSync(catalogPath, JSON.stringify({
      ...MANIFEST,
      lastReviewedAt: PACKAGED_REVIEW_DATE,
      doors: {
        'claude-code': { ...MANIFEST.doors['claude-code'], topModels: [{ id: PACKAGED_MODEL }] },
      },
    }));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/sign-instar-lockfile.mjs'), path.join(root, 'scripts/sign-instar-lockfile.mjs'));
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  execFileSync(process.execPath, ['scripts/sign-instar-lockfile.mjs', '--quiet'], {
    cwd: root,
    env: { ...process.env, INSTAR_RELEASE_PRIVATE_KEY_PEM: '', INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH: '' },
  });
  if (status === 'tampered') fs.writeFileSync(catalogPath, JSON.stringify(MANIFEST));
  return { root, pin };
}

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

  it.each(['verified', 'unavailable', 'tampered', 'scheduled'] as const)(
    'reads the same packaged catalog for both HTTP consumers when verification is %s',
    async status => {
      const stateDir = mkStateDir(tmpDir, `packaged-${status}`);
      const projectDir = path.join(tmpDir, 'checkout-shadow');
      fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'scripts', 'model-registry-freshness.manifest.json'), JSON.stringify(MANIFEST));
      const fixtureDir = status === 'scheduled' ? path.join(tmpDir, 'scheduler-history-fixture') : tmpDir;
      const { root, pin } = createPackagedFixture(fixtureDir, status === 'scheduled' ? 'verified' : status);
      const timestamp = new Date().toISOString();
      if (status === 'verified' || status === 'scheduled') {
        fs.writeFileSync(path.join(stateDir, 'state', 'doorway-scan.json'), JSON.stringify({
          schemaVersion: 1, lastScanAt: timestamp,
          doorways: [{ id: 'claude-code', probeStatus: 'ok', lastScannedAt: timestamp }],
        }));
      }
      const config = {
        ...baseConfig(stateDir, projectDir, AUTH),
        maintenance: { doorwayScan: { packagedRegistryEnabled: true } },
        capabilityRegistry: { enabled: true },
      };
      const state = new StateManager(stateDir);
      const sessionManager = createMockSessionManager() as never;
      const scheduler = status === 'scheduled' ? new JobScheduler(config.scheduler, sessionManager, state, stateDir) : undefined;
      const historyRead = scheduler && vi.spyOn(scheduler, 'readScheduledDoorwayHistory').mockImplementation(ids => {
        expect(ids).toEqual(['claude-code']);
        return {
          machineId: 'fixture-mac', historyTruncated: false,
          latestRun: { runId: 'fixture-run', startedAt: timestamp, outcome: 'timeout' },
          doors: {
            'claude-code': {
              freshness: 'unknown', reachable: null,
              latestAttempt: { runId: 'fixture-run', startedAt: timestamp, outcome: 'timeout' },
              lastObservation: null,
            },
          },
        };
      });
      const server = new AgentServer({
        config, sessionManager, state, scheduler,
        readPackagedDoorwayCatalog: version => {
          expect(version).toBe('0.0.0');
          return readVerifiedPackagedCatalog(root, version, pin);
        },
      });
      try {
        await server.start();
        const app = server.getApp();
        const doorways = await request(app).get('/doorways').set(auth());
        const capabilities = await request(app).get('/capability-registry').set(auth());
        if (status === 'scheduled') {
          expect(doorways.status).toBe(200);
          expect(doorways.body.doorways[0].reachable).toBe(true);
          expect(doorways.body.scheduledEvidence).toMatchObject({
            machineId: 'fixture-mac', latestRun: { outcome: 'timeout' },
            doors: { 'claude-code': { freshness: 'unknown', reachable: null } },
          });
          expect(capabilities.status).toBe(200);
          expect(capabilities.body.scanState).toBe('source-unavailable');
          expect(historyRead).toHaveBeenCalledTimes(2);
          expect(capabilities.body.capabilities).toEqual([
            { kind: 'failure', machineId: 'fixture-mac', reason: 'source-unavailable' },
          ]);
        } else if (status === 'verified') {
          expect(doorways.status).toBe(200);
          expect(doorways.body.doorways[0].topModels.map((model: { id: string }) => model.id)).toEqual([PACKAGED_MODEL]);
          expect(doorways.body.doorways[0].reachable).toBe(true);
          expect(capabilities.status).toBe(200);
          expect(capabilities.body.capabilities).toEqual(expect.arrayContaining([
            expect.objectContaining({
              entry: expect.objectContaining({
                capabilityId: `models:claude-code/${PACKAGED_MODEL}`,
                sourceDetail: 'doorway-manifest',
                evidence: { manifestVerifiedAt: PACKAGED_REVIEW_DATE, doorwayScanAt: expect.any(String) },
              }),
            }),
          ]));
          expect(JSON.stringify(capabilities.body.capabilities)).not.toContain('claude-opus-4-8');
        } else {
          expect(doorways.status).toBe(503);
          expect(capabilities.status).toBe(503);
          expect(doorways.body.code).toBe(status === 'tampered'
            ? 'registry-packaged-catalog-invalid' : 'registry-packaged-catalog-unavailable');
          expect(doorways.body.reason).toBe(status === 'tampered' ? 'catalog-digest-mismatch' : 'catalog-digest-absent');
          expect(capabilities.body.reason).toBe(doorways.body.reason);
        }
      } finally {
        await server.stop();
      }
    },
  );
});
