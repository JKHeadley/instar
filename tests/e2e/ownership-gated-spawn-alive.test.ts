// safe-fs-allow: test file — tmpdir scratch dirs only.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for ownership-gated spawn
 * (spec §3.5/§3.8). Per TESTING-INTEGRITY-SPEC the single most important test
 * for a feature with API routes: is it ALIVE on the production init path
 * (200, not 404/503) when constructed the way server.ts constructs it?
 *
 * This boots the REAL AgentServer (the same class server.ts instantiates) —
 * NOT a bare express router — so the REAL auth middleware and route mounting
 * are on the path (lesson: integration tests mounting createRoutes directly
 * bypassed the production auth middleware and missed two live bugs, PR #1295).
 *
 * Proves:
 *  (a) LIVE: GET /pool/duplicate-reconciler, GET /pool/ownership-view,
 *      GET /judgment-provenance → 200 through the real server, real Bearer.
 *  (b) The provenance route serves REDACTED rows through the real middleware
 *      stack (contextFull NEVER crosses HTTP).
 *  (c) Bearer auth enforced by the REAL middleware (401 without/with wrong).
 *  (d) DARK (fleet posture — none of the four wired): all three → 503, and
 *      the never-served provenance dir prefix denies through the file routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SpawnAdmission } from '../../src/core/SpawnAdmission.js';
import type { SpawnAdmissionDeps } from '../../src/core/SpawnAdmission.js';
import { OwnerDarkLadder } from '../../src/core/OwnerDarkLadder.js';
import { DuplicateSessionReconciler } from '../../src/monitoring/DuplicateSessionReconciler.js';
import type { ReconcilerDeps } from '../../src/monitoring/DuplicateSessionReconciler.js';
import { JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import { BoundedJsonlAudit } from '../../src/core/BoundedJsonlAudit.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-e2e-ownership-gated-spawn';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function baseConfig(stateDir: string, projectDir: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
}

function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

/** Real instances over inert deps — the Increment-1 dry-run posture server.ts wires. */
function liveInstances(stateDir: string) {
  const admissionDeps: SpawnAdmissionDeps = {
    selfMachineId: () => 'machine-A',
    poolStage: () => 'live',
    readOwnership: () => ({ owner: 'machine-A', epoch: 1, status: 'owned' }),
    isMachineAlive: () => true,
    durableCustodyLive: () => false,
    journal: () => {},
    raiseAttention: () => {},
    log: () => {},
  };
  const spawnAdmission = new SpawnAdmission({ enabled: true, dryRun: true }, admissionDeps);

  const ownerDarkLadder = new OwnerDarkLadder(undefined, {
    isMachineAlive: () => true,
    sendNotice: async () => true,
    topicHistoryHasRecentNotice: () => false,
    journal: new BoundedJsonlAudit({ file: path.join(stateDir, 'logs', 'owner-dark-ladder.jsonl') }),
    log: () => {},
  });

  const reconcilerDeps: ReconcilerDeps = {
    selfMachineId: () => 'machine-A',
    holdsLease: () => true,
    substrateReady: () => ({ ready: false, reason: 'in-memory ownership store (e2e)' }),
    errorEpisodeOpen: () => false,
    topicHasAuthorityInMotion: () => false,
    discoverCandidates: async () => ({ candidates: [] }),
    probeLiveCopy: async () => ({ ok: true, live: false }),
    readPin: () => null,
    readOwnershipViews: () => [],
    liveRunHosts: async () => [],
    casConverge: () => ({ ok: true }),
    peerEchoObserved: async () => true,
    armCloseout: () => {},
    raiseAttention: () => {},
    journal: new BoundedJsonlAudit({ file: path.join(stateDir, 'logs', 'duplicate-reconciler.jsonl') }),
    log: () => {},
  };
  const duplicateReconciler = new DuplicateSessionReconciler(
    {
      enabled: true, dryRun: true, reconcilerTickMs: 60_000, maxReconcilesPerTick: 3,
      maxConvergenceWritesPerTick: 5, echoConfirmTicks: 4, breakerThreshold: 3, breakerWindowMs: 86_400_000,
    },
    reconcilerDeps,
  );

  const judgmentProvenance = new JudgmentProvenanceLog({ dir: path.join(stateDir, 'state', 'judgment-provenance') });

  const sessionOwnershipRegistry = new SessionOwnershipRegistry({
    store: new InMemorySessionOwnershipStore(),
    seenNonce: () => false,
    recordNonce: () => {},
  });
  return { spawnAdmission, ownerDarkLadder, duplicateReconciler, judgmentProvenance, sessionOwnershipRegistry };
}

describe('ownership-gated spawn E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let liveServer: AgentServer;
  let liveApp: express.Express;
  let darkServer: AgentServer;
  let darkApp: express.Express;
  let decisionId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-alive-e2e-'));

    // LIVE: all four wired, mirroring server.ts's construction under the
    // dev-gate (Increment-1 dry-run posture — routes alive, behavior observe).
    const liveStateDir = mkStateDir(tmpDir, 'live');
    const inst = liveInstances(liveStateDir);
    decisionId = inst.judgmentProvenance.recordDecision({
      component: 'SpawnAdmission',
      decisionPoint: 'may-this-machine-spawn-for-this-topic',
      // A token-shaped value the credential scrubber MUST catch (sk-ant family)
      // — the probe for the §3.5 redaction invariant over the wire.
      context: { sessionKey: '777', callsite: 'telegram-cold-spawn', leaked: 'sk-ant-api03-e2eprobe0000000000000000000000000000000000000000' },
      optionsPresented: ['spawn', 'forward'],
      decision: 'spawn',
      reason: 'e2e alive-path decision',
      floor: 'admission-table-a-e',
      fallbackRung: 'deterministic',
    });
    await inst.judgmentProvenance.flush();
    liveServer = new AgentServer({
      config: baseConfig(liveStateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(liveStateDir),
      spawnAdmission: inst.spawnAdmission,
      ownerDarkLadder: inst.ownerDarkLadder,
      duplicateReconciler: inst.duplicateReconciler,
      judgmentProvenance: inst.judgmentProvenance,
      sessionOwnershipRegistry: inst.sessionOwnershipRegistry,
    });
    await liveServer.start();
    liveApp = liveServer.getApp();

    // DARK: the fleet posture — none of the four wired.
    const darkStateDir = mkStateDir(tmpDir, 'dark');
    darkServer = new AgentServer({
      config: baseConfig(darkStateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(darkStateDir),
    });
    await darkServer.start();
    darkApp = darkServer.getApp();
  });

  afterAll(async () => {
    await liveServer?.stop();
    await darkServer?.stop();
    if (tmpDir) SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/ownership-gated-spawn-alive.test.ts' });
  });

  // ── (a) alive on the production path ──────────────────────────────────

  it('GET /pool/duplicate-reconciler → 200 with all three watcher status blocks', async () => {
    const res = await request(liveApp).get('/pool/duplicate-reconciler').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.reconciler).toBeTruthy();
    expect(res.body.reconciler.dryRun).toBe(true);
    expect(res.body.reconciler.substrate.ready).toBe(false); // honest e2e posture
    expect(res.body.ownerDarkLadder).toBeTruthy();
    expect(res.body.spawnAdmission).toBeTruthy();
    expect(Array.isArray(res.body.auditLocations)).toBe(true);
  });

  it('GET /pool/ownership-view?key=777 → 200 with THIS machine\'s own record fields (honest empty shape for an unknown key)', async () => {
    const res = await request(liveApp).get('/pool/ownership-view?key=777').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('777');
    expect(res.body).toHaveProperty('owner');
    expect(res.body).toHaveProperty('epoch');
    expect(res.body).toHaveProperty('status');
  });

  it('GET /judgment-provenance → 200 with REDACTED rows (contextFull never crosses the real middleware stack)', async () => {
    const res = await request(liveApp).get('/judgment-provenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    const row = res.body.rows.find((r: { id: string }) => r.id === decisionId);
    expect(row).toBeTruthy();
    expect(row.component).toBe('SpawnAdmission');
    // Redaction invariant over the WIRE (§3.5): the raw machine-local context
    // object is omitted, and a token-shaped value never crosses unscrubbed.
    expect(row.contextFull).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-api03-e2eprobe');
    // The scrubbed summary still crosses (that's its purpose).
    expect(row.contextRedacted).toContain('telegram-cold-spawn');
  });

  // ── (c) real auth middleware ───────────────────────────────────────────

  it('the REAL auth middleware guards all three routes (401 bare, 403 wrong token)', async () => {
    for (const p of ['/pool/duplicate-reconciler', '/pool/ownership-view?key=1', '/judgment-provenance']) {
      const bare = await request(liveApp).get(p);
      expect(bare.status).toBe(401);
      // The production middleware distinguishes missing (401) from invalid (403).
      const wrong = await request(liveApp).get(p).set('Authorization', 'Bearer wrong-token');
      expect(wrong.status).toBe(403);
    }
  });

  // ── (d) dark fleet posture ─────────────────────────────────────────────

  it('DARK server (fleet posture): all three routes → 503, never a fabricated shape', async () => {
    for (const p of ['/pool/duplicate-reconciler', '/pool/ownership-view?key=1', '/judgment-provenance']) {
      const res = await request(darkApp).get(p).set('Authorization', `Bearer ${AUTH}`);
      expect(res.status).toBe(503);
    }
  });

  it('the provenance dir is NEVER served by the file routes, even on the live server (hardcoded deny)', async () => {
    const res = await request(liveApp)
      .get('/api/files/read?path=state/judgment-provenance/decisions.jsonl')
      .set('Authorization', `Bearer ${AUTH}`);
    // 403 (denied) — never 200. 404-route-absent is also acceptable only if the
    // file routes are unmounted in this construction; assert NOT 200 either way,
    // and when the route exists, the deny must be the explicit 403.
    expect(res.status).not.toBe(200);
    if (res.status !== 404) expect(res.status).toBe(403);
  });
});
