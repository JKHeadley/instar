/**
 * Tier-2 integration coverage for the ownership-gated-spawn route surface
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.5 + §3.8) through
 * a REAL booted AgentServer (global auth middleware live):
 *
 *  - GET /pool/duplicate-reconciler — 503 when the layer is absent; 200 with
 *    the three watcher status sub-objects + auditLocations when real instances
 *    are wired; wiring integrity (the route serves the LIVE instances).
 *  - GET /pool/ownership-view — 400 without key; 503 without a registry; 200
 *    record fields from THIS machine's own registry read.
 *  - GET /judgment-provenance — 503 when the log is absent; 200 with REDACTED
 *    rows only (no contextFull field ever crosses the surface).
 *
 * Harness mirrors tests/integration/autonomous-liveness-routes.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SpawnAdmission, type SpawnAdmissionDeps } from '../../src/core/SpawnAdmission.js';
import { OwnerDarkLadder } from '../../src/core/OwnerDarkLadder.js';
import { DuplicateSessionReconciler, type ReconcilerDeps } from '../../src/monitoring/DuplicateSessionReconciler.js';
import { JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import { BoundedJsonlAudit } from '../../src/core/BoundedJsonlAudit.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-dup-reconciler-routes';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

function baseConfig(tmpDir: string, stateDir: string): InstarConfig {
  return {
    projectName: 'dup-reconciler-routes', projectDir: tmpDir, stateDir, port: 0,
    authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], updates: {}, monitoring: {},
  } as unknown as InstarConfig;
}

function mkTmp(): { tmpDir: string; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-reconciler-routes-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  return { tmpDir, stateDir };
}

/** A live SpawnAdmission over inert deps (dry-run posture, real instance). */
function liveSpawnAdmission(journalDir: string): SpawnAdmission {
  const deps: SpawnAdmissionDeps = {
    selfMachineId: () => 'machine-A',
    poolStage: () => 'live',
    readOwnership: () => null,
    isMachineAlive: () => true,
    durableCustodyLive: () => false,
    journal: () => {},
    raiseAttention: () => {},
    log: () => {},
  };
  void journalDir;
  return new SpawnAdmission({ enabled: true, dryRun: true }, deps);
}

function liveLadder(stateDir: string): OwnerDarkLadder {
  return new OwnerDarkLadder(undefined, {
    isMachineAlive: () => true,
    sendNotice: async () => true,
    topicHistoryHasRecentNotice: () => false,
    journal: new BoundedJsonlAudit({ file: path.join(stateDir, 'logs', 'owner-dark-ladder.jsonl') }),
    log: () => {},
  });
}

function liveReconciler(stateDir: string): DuplicateSessionReconciler {
  const deps: ReconcilerDeps = {
    selfMachineId: () => 'machine-A',
    holdsLease: () => true,
    substrateReady: () => ({ ready: false, reason: 'in-memory ownership store (test)' }),
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
  return new DuplicateSessionReconciler(
    {
      enabled: true, dryRun: true, reconcilerTickMs: 60_000, maxReconcilesPerTick: 3,
      maxConvergenceWritesPerTick: 5, echoConfirmTicks: 4, breakerThreshold: 3, breakerWindowMs: 86_400_000,
    },
    deps,
  );
}

describe('ownership-gated-spawn routes (integration)', () => {
  describe('DARK — layer not wired', () => {
    let tmpDir: string; let server: AgentServer;
    let app: ReturnType<AgentServer['getApp']>;

    beforeAll(async () => {
      const t = mkTmp(); tmpDir = t.tmpDir;
      server = new AgentServer({
        config: baseConfig(tmpDir, t.stateDir),
        sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
        state: new StateManager(t.stateDir),
        // duplicateReconciler / ownerDarkLadder / spawnAdmission /
        // judgmentProvenance / sessionOwnershipRegistry deliberately OMITTED.
      });
      await server.start();
      app = server.getApp();
    });
    afterAll(async () => {
      await server.stop();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/duplicate-reconciler-routes.test.ts' });
    });

    it('401 without a Bearer token on all three routes', async () => {
      expect((await request(app).get('/pool/duplicate-reconciler')).status).toBe(401);
      expect((await request(app).get('/pool/ownership-view?key=1')).status).toBe(401);
      expect((await request(app).get('/judgment-provenance')).status).toBe(401);
    });

    it('GET /pool/duplicate-reconciler → 503 when neither watcher is constructed', async () => {
      const res = await request(app).get('/pool/duplicate-reconciler').set(auth());
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('not constructed');
    });

    it('GET /pool/ownership-view → 400 without key (validated before the 503)', async () => {
      const res = await request(app).get('/pool/ownership-view').set(auth());
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('key');
    });

    it('GET /pool/ownership-view?key=… → 503 without a registry', async () => {
      const res = await request(app).get('/pool/ownership-view').query({ key: '777' }).set(auth());
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('session pool not available');
    });

    it('GET /judgment-provenance → 503 when the log is absent', async () => {
      const res = await request(app).get('/judgment-provenance').set(auth());
      expect(res.status).toBe(503);
      expect(res.body.error).toContain('not constructed');
    });
  });

  describe('LIVE — real instances wired', () => {
    let tmpDir: string; let stateDir: string; let server: AgentServer;
    let app: ReturnType<AgentServer['getApp']>;
    let spawnAdmission: SpawnAdmission;
    let provenance: JudgmentProvenanceLog;
    let decisionId: string | null;

    beforeAll(async () => {
      const t = mkTmp(); tmpDir = t.tmpDir; stateDir = t.stateDir;

      spawnAdmission = liveSpawnAdmission(stateDir);

      provenance = new JudgmentProvenanceLog({ dir: path.join(stateDir, 'state', 'judgment-provenance') });
      decisionId = provenance.recordDecision({
        component: 'SpawnAdmission',
        decisionPoint: 'may-this-machine-spawn-for-this-topic',
        context: { sessionKey: '777', callsite: 'telegram-cold-spawn', fullDetail: 'machine-local-context' },
        optionsPresented: ['spawn', 'forward'],
        decision: 'spawn',
        reason: 'test decision',
        floor: 'admission-table-a-e',
        fallbackRung: 'deterministic',
      });
      await provenance.flush();

      const store = new InMemorySessionOwnershipStore();
      store.casWrite({
        sessionKey: '777', ownerMachineId: 'machine-B', ownershipEpoch: 3, status: 'active',
        nonce: 'n1', timestamp: Date.now(), updatedAt: new Date().toISOString(),
      });
      const registry = new SessionOwnershipRegistry({ store, seenNonce: () => false, recordNonce: () => {} });

      server = new AgentServer({
        config: baseConfig(tmpDir, stateDir),
        sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
        state: new StateManager(stateDir),
        duplicateReconciler: liveReconciler(stateDir),
        ownerDarkLadder: liveLadder(stateDir),
        spawnAdmission,
        judgmentProvenance: provenance,
        sessionOwnershipRegistry: registry,
      });
      await server.start();
      app = server.getApp();
    });
    afterAll(async () => {
      await server.stop();
      await provenance.close();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/duplicate-reconciler-routes.test.ts' });
    });

    it('GET /pool/duplicate-reconciler → 200 with the three status sub-objects + auditLocations', async () => {
      const res = await request(app).get('/pool/duplicate-reconciler').set(auth());
      expect(res.status).toBe(200);
      // reconciler: the REAL status() shape (substrate gate honest about in-memory store).
      expect(res.body.reconciler).toMatchObject({ enabled: true, dryRun: true });
      expect(res.body.reconciler.substrate).toMatchObject({ ready: false });
      // ownerDarkLadder: counters + config from the real instance.
      expect(res.body.ownerDarkLadder.openEpisodes).toEqual([]);
      expect(res.body.ownerDarkLadder.counters).toHaveProperty('encounters', 0);
      expect(res.body.ownerDarkLadder.config).toHaveProperty('noticeCooldownMs');
      // spawnAdmission: the dry-run posture is reported honestly.
      expect(res.body.spawnAdmission.mode).toBe('dry-run');
      expect(res.body.spawnAdmission.enforceBlockedBy).toBe('dry-run');
      expect(res.body.spawnAdmission.counters).toHaveProperty('admitted');
      // The audit pointer names both journals.
      expect(res.body.auditLocations).toEqual(['logs/duplicate-reconciler.jsonl', 'logs/owner-dark-ladder.jsonl']);
    });

    it('wiring integrity: the route serves the LIVE SpawnAdmission instance (a real admit mutates counters)', async () => {
      const before = (await request(app).get('/pool/duplicate-reconciler').set(auth())).body.spawnAdmission.counters.admitted;
      const d = spawnAdmission.admit({ sessionKey: '999', callsite: 'telegram-cold-spawn' });
      expect(d.allow).toBe(true); // unowned row — admit
      const after = (await request(app).get('/pool/duplicate-reconciler').set(auth())).body.spawnAdmission.counters.admitted;
      expect(after).toBe(before + 1);
    });

    it('GET /pool/ownership-view?key=777 → 200 with THIS machine\'s own record fields', async () => {
      const res = await request(app).get('/pool/ownership-view').query({ key: '777' }).set(auth());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: '777', owner: 'machine-B', epoch: 3, status: 'active' });
    });

    it('GET /pool/ownership-view on an unknown key → 200 with the honest empty shape', async () => {
      const res = await request(app).get('/pool/ownership-view').query({ key: 'no-such-key' }).set(auth());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: 'no-such-key', owner: null, epoch: 0, status: null });
    });

    it('GET /judgment-provenance → 200 with REDACTED rows (contextFull NEVER crosses)', async () => {
      const res = await request(app).get('/judgment-provenance').set(auth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.rows)).toBe(true);
      expect(res.body.rows.length).toBeGreaterThanOrEqual(1);
      const row = res.body.rows.find((r: { id: string }) => r.id === decisionId);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('contextFull');
      expect(typeof row.contextRedacted).toBe('string');
      expect(row.decision).toBe('spawn');
      expect(row.fallbackRung).toBe('deterministic');
      // No row on the surface carries the machine-local field.
      for (const r of res.body.rows) expect(r).not.toHaveProperty('contextFull');
      // The status block rides along.
      expect(res.body.status.counters.decisionsWritten).toBeGreaterThanOrEqual(1);
    });

    it('GET /judgment-provenance honors ?limit', async () => {
      // Write a second row so limit=1 actually clamps.
      provenance.recordDecision({
        component: 'DuplicateSessionReconciler', decisionPoint: 'which-duplicate-survives',
        context: { key: 'telegram:777' }, optionsPresented: ['owner-copy-survives', 'escalate-to-attention'],
        decision: 'escalate:test', reason: 'r', floor: 'f', fallbackRung: 'deterministic',
      });
      await provenance.flush();
      const res = await request(app).get('/judgment-provenance').query({ limit: '1' }).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.rows.length).toBe(1);
    });
  });
});
