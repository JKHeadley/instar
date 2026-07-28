// safe-git-allow: test file — tmpdir scratch dirs only.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for WS2.6 (user-record + topic-operator-record —
 * the SECOND + THIRD PII kinds, completing the WS2 memory family). Per TESTING-INTEGRITY-SPEC the
 * single most important test for a feature with API routes: is it ALIVE on the production init
 * path (200, not 404/503) when the flag is enabled?
 *
 * Boots the REAL AgentServer (the same factory server.ts uses) with the conflict ledger +
 * dropped-origins registry + rollback engine WIRED — mirroring production — and registers BOTH WS2.6
 * kinds on the shared registry. Proves:
 *   (a) ENABLED: a user-record conflict (two divergent profiles for the same channel set) authored
 *       by the union reader is open + readable + resolvable over HTTP.
 *   (b) BOTH kinds are registered (dual-registry) — user-record + topic-operator-record resolve.
 *   (c) DISABLED: the /state/* routes → 503.
 *   (d) the routes require Bearer auth.
 *
 * The schemas are the REAL ones, so this also proves the strict type-clamped schemas are the ones
 * the live registry serves.
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
  USER_KIND_REGISTRATION,
  USER_RECORD_KIND,
  USER_STORE_KEY,
  userTierOf,
} from '../../src/core/UserRegistryReplicatedStore.js';
import {
  TOPIC_OPERATOR_KIND_REGISTRATION,
  TOPIC_OPERATOR_RECORD_KIND,
  TOPIC_OPERATOR_STORE_KEY,
} from '../../src/core/TopicOperatorReplicatedStore.js';
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
function user(origin: string, name: string, observed?: HlcTimestamp): OriginRecord {
  return {
    origin,
    envelope: { recordKey: 'user-x', hlc: hlc(name === 'JustinA' ? 100 : 999, 0, origin), op: 'put', origin, ...(observed ? { observed } : {}) },
    data: { name, channels: [{ type: 'telegram', identifier: '1' }], permissions: ['admin'] },
  };
}

describe('WS2.6 user-record + topic-operator-record E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  const AUTH = 'test-e2e-ws26';

  let enabledServer: AgentServer;
  let enabledApp: express.Express;
  let reader: ReplicatedStoreReader;
  let registry: ReplicatedKindRegistry;

  let disabledServer: AgentServer;
  let disabledApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws26-e2e-'));

    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    const enabledConfig = baseConfig(enabledStateDir, tmpDir, AUTH);
    registry = new ReplicatedKindRegistry();
    registry.register(USER_KIND_REGISTRATION);
    registry.register(TOPIC_OPERATOR_KIND_REGISTRATION);
    const conflictStore = new ConflictStore({ stateDir: enabledStateDir, now: () => new Date() });
    const dropped = new DroppedOriginRegistry({ stateDir: enabledStateDir });
    const rollback = new RollbackUnmerge(dropped, {
      peersDir: () => path.join(enabledStateDir, 'state', 'coherence-journal', 'peers'),
      kindsForStore: (store) => { const r = registry.getByStore(store); return r ? [r.kind] : []; },
      now: () => new Date(),
      dropSnapshotCacheForOrigin: () => {},
      autoResolveConflicts: (o) => conflictStore.autoResolveForDroppedOrigin(o),
    });
    // Two concurrent profiles for the same channel set (offline-then-rejoin divergence) ⇒ a real
    // append-both conflict.
    const records: OriginRecord[] = [
      user('m_A', 'JustinA'),
      user('m_B', 'JustinB', hlc(1, 0, 'm_B')), // concurrent witness
    ];
    reader = new ReplicatedStoreReader({
      registry,
      stores: { [USER_STORE_KEY]: { enabled: true } },
      tierOf: userTierOf,
      loadOriginRecords: (store, key) => (store === USER_STORE_KEY && key === 'user-x' ? records.filter((r) => !dropped.droppedOrigins(store).has(r.origin)) : []),
      listRecordKeys: () => ['user-x'],
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/ws26-user-topicop-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: a user-record conflict is open + readable + resolvable over HTTP (200)', async () => {
    const u = reader.read(USER_STORE_KEY, 'user-x');
    expect(u.conflict).not.toBeNull(); // append-both-and-flag — neither profile clobbers

    const list = await request(enabledApp).get('/state/conflicts').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    expect(list.body.open.length).toBe(1);
    const id = list.body.open[0].conflictId;

    const resolve = await request(enabledApp).post('/state/resolve-conflict').set(auth()).send({ conflictId: id, winnerOrigin: 'm_A' });
    expect(resolve.status).toBe(200);
    expect(resolve.body.entry.resolution).toBe('operator-winner');
  });

  it('(b) BOTH WS2.6 kinds are registered (dual-registry)', () => {
    expect(registry.isReplicatedKind(USER_RECORD_KIND)).toBe(true);
    expect(registry.isReplicatedKind(TOPIC_OPERATOR_RECORD_KIND)).toBe(true);
    expect(registry.getByStore(USER_STORE_KEY)?.kind).toBe(USER_RECORD_KIND);
    expect(registry.getByStore(TOPIC_OPERATOR_STORE_KEY)?.kind).toBe(TOPIC_OPERATOR_RECORD_KIND);
  });

  it('(c) DISABLED: the /state/* routes return 503', async () => {
    expect((await request(disabledApp).get('/state/conflicts').set(auth())).status).toBe(503);
    expect((await request(disabledApp).get('/state/quarantine').set(auth())).status).toBe(503);
  });

  it('(d) the routes require Bearer auth', async () => {
    expect((await request(enabledApp).get('/state/conflicts')).status).toBe(401);
    expect((await request(enabledApp).get('/state/quarantine')).status).toBe(401);
  });
});
