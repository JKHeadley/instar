// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" test for the writer-agnostic replication reconciler
 * (docs/specs/statesync-writer-agnostic-reconciler.md). Modelled on ws24-knowledge-alive:
 * boots the REAL AgentServer and constructs the reconciler the way server.ts does when the
 * coherence journal is live — real CoherenceJournal + ReplicatedKindRegistry + persisted
 * HLC + clock pointer + ReplicatedRecordEmitter + ReplicatedPeerStreamReader + the
 * production seams (buildReconcilerSeams) — then proves:
 *   (a) JOURNAL LIVE: GET /state/reconcile → 200 with `seeded:true` after a forced tick, and
 *       the record written to the store file actually reached the journal.
 *   (b) JOURNAL DARK (reconciler not constructed): GET /state/reconcile → 503.
 *   (c) the route requires Bearer auth.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedKindRegistry, type StateSyncStores } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReconciler } from '../../src/core/ReplicatedStoreReconciler.js';
import { buildReconcilerSeams, makeGitCarriedProbe } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { writeClockPointer } from '../../src/core/DeletionIntentLog.js';
import { HybridLogicalClock, type HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { PREF_KIND_REGISTRATION } from '../../src/core/PreferencesReplicatedStore.js';
import { RELATIONSHIP_KIND_REGISTRATION } from '../../src/core/RelationshipsReplicatedStore.js';
import { KNOWLEDGE_KIND_REGISTRATION, KNOWLEDGE_STORE_KEY, deriveKnowledgeRecordKey } from '../../src/core/KnowledgeReplicatedStore.js';
import { USER_KIND_REGISTRATION } from '../../src/core/UserRegistryReplicatedStore.js';
import { LEARNING_KIND_REGISTRATION } from '../../src/core/LearningsReplicatedStore.js';
import { EVOLUTION_ACTION_KIND_REGISTRATION } from '../../src/core/EvolutionActionsReplicatedStore.js';
import { KnowledgeManager } from '../../src/knowledge/KnowledgeManager.js';
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

const MACHINE = 'm_alive';

describe('Writer-agnostic reconciler E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  const AUTH = 'test-e2e-reconcile';

  let liveServer: AgentServer;
  let liveApp: express.Express;
  let journal: CoherenceJournal;
  let reconciler: ReplicatedStoreReconciler;
  let liveStateDir: string;

  let darkServer: AgentServer;
  let darkApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-alive-'));

    // LIVE: the server.ts construction sequence (journal → registry → clock + pointer →
    // reader → emitter → reconciler over the production seams).
    liveStateDir = mkStateDir(tmpDir, 'live');
    const registry = new ReplicatedKindRegistry();
    for (const r of [PREF_KIND_REGISTRATION, RELATIONSHIP_KIND_REGISTRATION, KNOWLEDGE_KIND_REGISTRATION, USER_KIND_REGISTRATION, LEARNING_KIND_REGISTRATION, EVOLUTION_ACTION_KIND_REGISTRATION]) {
      registry.register(r);
    }
    journal = new CoherenceJournal({ stateDir: liveStateDir, machineId: MACHINE, flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(registry);
    const reader = new ReplicatedPeerStreamReader({ stateDir: liveStateDir, registry, selfMachineId: MACHINE });
    const hlcPath = path.join(liveStateDir, 'state', 'coherence-journal', `hlc-${MACHINE}.json`);
    const clock = new HybridLogicalClock({
      node: MACHINE,
      now: () => Date.now(),
      persist: {
        load: () => { try { return JSON.parse(fs.readFileSync(hlcPath, 'utf-8')) as HlcTimestamp; } catch { return null; } },
        save: (t) => { fs.mkdirSync(path.dirname(hlcPath), { recursive: true }); fs.writeFileSync(hlcPath, JSON.stringify(t)); },
      },
    });
    writeClockPointer(liveStateDir, hlcPath);
    const stores: StateSyncStores = { knowledge: { enabled: true } };
    const emitter = new ReplicatedRecordEmitter({
      journal, clock, registry, origin: MACHINE, stores: () => stores,
      loadWitness: (store, rk) => reader.loadWitness(store, rk),
    });
    reconciler = new ReplicatedStoreReconciler({
      emitter,
      reader: { loadOwnOriginRecordsAsync: (store) => reader.loadOwnOriginRecordsAsync(store) },
      registry,
      origin: MACHINE,
      stores: () => stores,
      seams: buildReconcilerSeams({
        stateDir: liveStateDir,
        relationshipsDir: path.join(liveStateDir, 'relationships'),
        evolution: { listLearnings: () => [], listActions: () => [] },
      }),
      // The production probe: tmpDir is not a git work tree ⇒ every store is local.
      gitCarried: makeGitCarriedProbe({ cwd: tmpDir, gitSyncActive: () => false }),
      config: () => ({}),
    });
    reconciler.start(); // first tick is 90 s out — the test forces one below

    // A record written by "the CLI" (a manager instance with no emitter).
    new KnowledgeManager(liveStateDir).ingest('body', { title: 'Alive Check', url: 'https://example.com/alive', type: 'doc' });

    liveServer = new AgentServer({
      config: baseConfig(liveStateDir, tmpDir, AUTH),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(liveStateDir),
      replicatedRecordEmitter: emitter,
      replicatedStoreReconciler: reconciler,
    });
    await liveServer.start();
    liveApp = liveServer.getApp();

    // DARK: the coherence journal is dark ⇒ server.ts never constructs the reconciler.
    const darkStateDir = mkStateDir(tmpDir, 'dark');
    darkServer = new AgentServer({
      config: baseConfig(darkStateDir, tmpDir, AUTH),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(darkStateDir),
    });
    await darkServer.start();
    darkApp = darkServer.getApp();
  });

  afterAll(async () => {
    reconciler?.stop();
    await liveServer?.stop();
    await darkServer?.stop();
    try { journal?.close(); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/ws2-reconciler-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) LIVE: GET /state/reconcile → 200, seeded:true after a forced tick, and the file record reached the journal', async () => {
    const before = await request(liveApp).get('/state/reconcile').set(auth());
    expect(before.status).toBe(200);
    expect(before.body.stores[KNOWLEDGE_STORE_KEY].seeded).toBe(false);
    expect(before.body.lastTickAt).toBeNull();

    await reconciler.tick();

    const res = await request(liveApp).get('/state/reconcile').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.lastTickAt).not.toBeNull();
    const kb = res.body.stores[KNOWLEDGE_STORE_KEY];
    expect(kb.seeded).toBe(true);
    expect(kb.gitCarried).toBe(false);
    expect(kb.emittedPuts).toBe(1);
    expect(kb.lastError).toBeNull();
    // Dark stores stay unread.
    expect(res.body.stores.userRegistry.seeded).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('Alive Check');

    journal.flush();
    const own = await new ReplicatedPeerStreamReader({ stateDir: liveStateDir, registry: (() => { const r = new ReplicatedKindRegistry(); r.register(KNOWLEDGE_KIND_REGISTRATION); return r; })(), selfMachineId: MACHINE })
      .loadOwnOriginRecordsAsync(KNOWLEDGE_STORE_KEY);
    expect(own.get(deriveKnowledgeRecordKey('Alive Check', 'https://example.com/alive', 'doc')!)?.op).toBe('put');
  });

  it('(b) DARK: GET /state/reconcile → 503 when the reconciler is not constructed', async () => {
    const res = await request(darkApp).get('/state/reconcile').set(auth());
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('reconciler-not-constructed');
  });

  it('(c) the route requires Bearer auth', async () => {
    expect((await request(liveApp).get('/state/reconcile')).status).toBe(401);
  });
});
