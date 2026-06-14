// safe-git-allow: test file — tmpdir scratch dirs only.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for the replicated-store union /
 * conflict / rollback surface (multi-machine-replicated-store-foundation
 * §7.2/§7.3/§7.4). Per TESTING-INTEGRITY-SPEC the single most important test for a
 * feature with API routes: is it ALIVE on the production init path (200, not
 * 404/503)?
 *
 * This boots the REAL AgentServer (the same factory server.ts uses) with the
 * conflict ledger + dropped-origins registry WIRED — mirroring the production
 * construction in server.ts (where conflictStore/droppedOriginRegistry/
 * rollbackUnmerge are built next to the snapshot engine and passed to AgentServer).
 * It then exercises the full lifecycle end-to-end:
 *   (a) ENABLED: a conflict authored by the union reader (machine A vs B
 *       concurrent edit) is open + readable + resolvable over HTTP (200, real data).
 *   (b) DISABLED: the routes → 503.
 *   (c) ROLLBACK: un-merging an origin auto-resolves a conflict referencing it +
 *       drops it from the union LIVE (zero dangling refs), surfaced over HTTP.
 *   (d) the routes require Bearer auth.
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
import { ReplicatedKindRegistry, type StoreFieldSchema } from '../../src/core/ReplicatedRecordEnvelope.js';
import { SnapshotCache } from '../../src/core/StoreSnapshot.js';
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
function oRec(origin: string, h: HlcTimestamp, observed?: HlcTimestamp): OriginRecord {
  return { origin, envelope: { recordKey: 'pref-x', hlc: h, op: 'put', origin, ...(observed ? { observed } : {}) }, data: { v: origin } };
}

const passSchema: StoreFieldSchema = { knownFields: ['v'], validate: (raw) => ({ v: (raw as { v?: unknown }).v }) };

describe('replicated-store union/conflict/rollback E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  const AUTH = 'test-e2e-state-sync';

  let enabledServer: AgentServer;
  let enabledApp: express.Express;
  let conflictStore: ConflictStore;
  let rollback: RollbackUnmerge;
  let dropped: DroppedOriginRegistry;
  let reader: ReplicatedStoreReader;

  let disabledServer: AgentServer;
  let disabledApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-sync-e2e-'));

    // ENABLED: wire the conflict/rollback substrate exactly as server.ts does, with
    // a synthetic 'pref' store registered (the foundation ships the registry empty;
    // the E2E proves the path by registering a test kind, the Step-3 precedent).
    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    const enabledConfig = baseConfig(enabledStateDir, tmpDir, AUTH);
    const registry = new ReplicatedKindRegistry();
    registry.register({ kind: 'pref-record', store: 'pref', schema: passSchema });
    conflictStore = new ConflictStore({ stateDir: enabledStateDir, now: () => new Date() });
    dropped = new DroppedOriginRegistry({ stateDir: enabledStateDir });
    const snapshotCache = new SnapshotCache({ maxCachedSnapshots: 16, maxCacheBytes: 1024 * 1024 });
    rollback = new RollbackUnmerge(dropped, {
      peersDir: () => path.join(enabledStateDir, 'state', 'coherence-journal', 'peers'),
      kindsForStore: (store) => { const r = registry.getByStore(store); return r ? [r.kind] : []; },
      now: () => new Date(),
      dropSnapshotCacheForOrigin: (o) => snapshotCache.dropOrigin(o),
      autoResolveConflicts: (o) => conflictStore.autoResolveForDroppedOrigin(o),
    });
    // The union reader over a synthetic two-origin record set (machine A vs B,
    // concurrent ⇒ a real conflict). This is the per-origin materialization a
    // concrete store (WS2.1) will supply; here it is a fixed in-memory set.
    const records: OriginRecord[] = [
      oRec('m_A', hlc(100, 0, 'm_A')),
      oRec('m_B', hlc(999, 0, 'm_B'), hlc(50, 0, 'm_B')), // concurrent witness
    ];
    reader = new ReplicatedStoreReader({
      registry,
      stores: { pref: { enabled: true } },
      tierOf: () => 'high',
      loadOriginRecords: (store, key) => (store === 'pref' && key === 'pref-x' ? records.filter((r) => !dropped.droppedOrigins('pref').has(r.origin)) : []),
      listRecordKeys: () => ['pref-x'],
      droppedOrigins: dropped,
      conflictStore,
    });

    const enabledState = new StateManager(enabledStateDir);
    enabledServer = new AgentServer({
      config: enabledConfig,
      sessionManager: createMockSessionManager() as never,
      state: enabledState,
      conflictStore,
      rollbackUnmerge: rollback,
      droppedOriginRegistry: dropped,
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    // DISABLED: no conflict substrate wired → routes 503.
    const disabledStateDir = mkStateDir(tmpDir, 'disabled');
    const disabledConfig = baseConfig(disabledStateDir, tmpDir, AUTH);
    disabledServer = new AgentServer({
      config: disabledConfig,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(disabledStateDir),
    });
    await disabledServer.start();
    disabledApp = disabledServer.getApp();
  });

  afterAll(async () => {
    await enabledServer?.stop();
    await disabledServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/state-sync-union-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: a union-detected conflict is open + readable + resolvable over HTTP', async () => {
    // Author the conflict by reading through the union (machine A vs B concurrent).
    const u = reader.read('pref', 'pref-x');
    expect(u.conflict).not.toBeNull(); // append-both-and-flag — neither clobbers

    const list = await request(enabledApp).get('/state/conflicts').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    expect(list.body.open.length).toBe(1);
    const id = list.body.open[0].conflictId;

    // Operator resolves: designate machine A as the winner (§7.3).
    const resolve = await request(enabledApp).post('/state/resolve-conflict').set(auth()).send({ conflictId: id, winnerOrigin: 'm_A' });
    expect(resolve.status).toBe(200);
    expect(resolve.body.entry.resolution).toBe('operator-winner');

    const after = await request(enabledApp).get('/state/conflicts').set(auth());
    expect(after.body.open.length).toBe(0);
  });

  it('(b) DISABLED: the routes return 503', async () => {
    const a = await request(disabledApp).get('/state/conflicts').set(auth());
    expect(a.status).toBe(503);
    const b = await request(disabledApp).get('/state/quarantine').set(auth());
    expect(b.status).toBe(503);
  });

  it('(c) ROLLBACK: un-merging origin m_B auto-resolves its conflict + drops it from the union live', async () => {
    // Re-author a fresh conflict (the prior was operator-resolved).
    // Force a new conflict by recording one directly, then un-merge m_B.
    const u = reader.read('pref', 'pref-x'); // re-discovers (resolved ⇒ may not re-open; record fresh)
    // Record a guaranteed-fresh open conflict referencing m_B.
    const fresh = { conflictId: 'rollback-c1', recordKey: 'pref-y', versions: [oRec('m_A', hlc(1, 0, 'm_A')), oRec('m_B', hlc(2, 0, 'm_B'))] };
    conflictStore.recordConflict('pref', fresh);
    void u;

    // Un-merge m_B (§7.4) — auto-resolves the conflict + registers the drop.
    const res = rollback.unmergeOrigin('pref', 'm_B');
    expect(res.closedConflicts).toContain('rollback-c1');
    expect(dropped.isDropped('pref', 'm_B')).toBe(true);

    // The quarantine surface reports the dropped origin over HTTP.
    const q = await request(enabledApp).get('/state/quarantine').set(auth());
    expect(q.status).toBe(200);
    expect(q.body.droppedOrigins.some((d: { origin: string }) => d.origin === 'm_B')).toBe(true);

    // The union now resolves with ZERO refs to m_B (it reverts to m_A, the survivor).
    const after = reader.read('pref', 'pref-x');
    expect(after.value?.origin).toBe('m_A');
    expect(after.conflict).toBeNull();
  });

  it('(d) the routes require Bearer auth', async () => {
    expect((await request(enabledApp).get('/state/conflicts')).status).toBe(401);
    expect((await request(enabledApp).get('/state/quarantine')).status).toBe(401);
    expect((await request(enabledApp).post('/state/resolve-conflict').send({ conflictId: 'x', winnerOrigin: 'y' })).status).toBe(401);
  });
});
