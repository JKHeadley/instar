// safe-git-allow: test file — tmpdir scratch dirs only.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for WS2.2 (learning-record — the SECOND
 * memory-family kind on the replicated-store foundation). Per TESTING-INTEGRITY-SPEC the
 * single most important test for a feature with API routes: is it ALIVE on the
 * production init path (200, not 404/503) when the flag is enabled?
 *
 * This boots the REAL AgentServer (the same factory server.ts uses) with the conflict
 * ledger + dropped-origins registry + rollback engine WIRED — mirroring the production
 * construction in server.ts — and registers the `learning-record` kind on the shared
 * registry. It then proves:
 *   (a) ENABLED (stateSync.learnings): a learning-record conflict authored by the union
 *       reader is open + readable + resolvable over HTTP (200, real data).
 *   (b) DISABLED: the /state/* routes → 503.
 *   (c) the routes require Bearer auth.
 *
 * The learning-record schema is the REAL one (learningRecordStoreSchema), so this also
 * proves the kind's strict type-clamped schema is the one the live registry serves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { RollbackUnmerge, DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  LEARNING_KIND_REGISTRATION,
  LEARNING_STORE_KEY,
  learningTierOf,
} from '../../src/core/LearningsReplicatedStore.js';
import type { OriginRecord } from '../../src/core/UnionReader.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
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

function hlc(p: number, l: number, n: string): HlcTimestamp { return { physical: p, logical: l, node: n }; }
function learn(origin: string, title: string, observed?: HlcTimestamp): OriginRecord {
  return {
    origin,
    envelope: { recordKey: 'lesson-x', hlc: hlc(title === 'plain' ? 100 : 999, 0, origin), op: 'put', origin, ...(observed ? { observed } : {}) },
    data: { title, category: 'infra', applied: false, source: { discoveredAt: '2026-06-01T00:00:00.000Z' } },
  };
}

describe('WS2.2 learning-record E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  const AUTH = 'test-e2e-ws22';

  let enabledServer: AgentServer;
  let enabledApp: express.Express;
  let reader: ReplicatedStoreReader;

  let disabledServer: AgentServer;
  let disabledApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws22-e2e-'));

    // ENABLED: wire the conflict/rollback substrate exactly as server.ts does, with the
    // REAL learning-record kind registered (the memory-family kind WS2.2 adds).
    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    const enabledConfig = baseConfig(enabledStateDir, tmpDir, AUTH);
    const registry = new ReplicatedKindRegistry();
    registry.register(LEARNING_KIND_REGISTRATION);
    const conflictStore = new ConflictStore({ stateDir: enabledStateDir, now: () => new Date() });
    const dropped = new DroppedOriginRegistry({ stateDir: enabledStateDir });
    const rollback = new RollbackUnmerge(dropped, {
      peersDir: () => path.join(enabledStateDir, 'state', 'coherence-journal', 'peers'),
      kindsForStore: (store) => { const r = registry.getByStore(store); return r ? [r.kind] : []; },
      now: () => new Date(),
      dropSnapshotCacheForOrigin: () => {},
      autoResolveConflicts: (o) => conflictStore.autoResolveForDroppedOrigin(o),
    });
    // Two concurrent learning records for the same lesson (the offline-then-rejoin
    // divergence) ⇒ a real append-both conflict.
    const records: OriginRecord[] = [
      learn('m_A', 'plain'),
      learn('m_B', 'refined', hlc(1, 0, 'm_B')), // concurrent witness
    ];
    reader = new ReplicatedStoreReader({
      registry,
      stores: { [LEARNING_STORE_KEY]: { enabled: true } },
      tierOf: learningTierOf,
      loadOriginRecords: (store, key) => (store === LEARNING_STORE_KEY && key === 'lesson-x' ? records.filter((r) => !dropped.droppedOrigins(store).has(r.origin)) : []),
      listRecordKeys: () => ['lesson-x'],
      droppedOrigins: dropped,
      conflictStore,
    });

    enabledServer = new AgentServer({
      config: enabledConfig,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(enabledStateDir),
      conflictStore,
      rollbackUnmerge: rollback,
      droppedOriginRegistry: dropped,
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    // DISABLED: no conflict substrate wired → routes 503.
    const disabledStateDir = mkStateDir(tmpDir, 'disabled');
    disabledServer = new AgentServer({
      config: baseConfig(disabledStateDir, tmpDir, AUTH),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(disabledStateDir),
    });
    await disabledServer.start();
    disabledApp = disabledServer.getApp();
  });

  afterAll(async () => {
    await enabledServer?.stop();
    await disabledServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/ws22-learnings-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: a learning-record conflict is open + readable + resolvable over HTTP (200)', async () => {
    // Author the conflict by reading through the union (machine A vs B concurrent).
    const u = reader.read(LEARNING_STORE_KEY, 'lesson-x');
    expect(u.conflict).not.toBeNull(); // append-both-and-flag — neither variant clobbers

    const list = await request(enabledApp).get('/state/conflicts').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    expect(list.body.open.length).toBe(1);
    const id = list.body.open[0].conflictId;

    const resolve = await request(enabledApp).post('/state/resolve-conflict').set(auth()).send({ conflictId: id, winnerOrigin: 'm_A' });
    expect(resolve.status).toBe(200);
    expect(resolve.body.entry.resolution).toBe('operator-winner');
  });

  it('(b) DISABLED: the /state/* routes return 503', async () => {
    expect((await request(disabledApp).get('/state/conflicts').set(auth())).status).toBe(503);
    expect((await request(disabledApp).get('/state/quarantine').set(auth())).status).toBe(503);
  });

  it('(c) the routes require Bearer auth', async () => {
    expect((await request(enabledApp).get('/state/conflicts')).status).toBe(401);
    expect((await request(enabledApp).get('/state/quarantine')).status).toBe(401);
  });
});
