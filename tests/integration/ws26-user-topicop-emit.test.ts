// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration test for WS2.6 — the UserManager + TopicOperatorStore replication emit seams
 * wired alongside a real AgentServer. Both stores are CLI/ingress-driven (no dedicated HTTP routes
 * for the replicated kind), so this drives the emit-on-mutation contract through the managers
 * server.ts constructs, with the server alive and the conflict substrate wired:
 *   (1) UserManager.upsertUser() fires a `put` through the emit funnel, keyed on the channel set
 *       (the local userId never crosses the wire);
 *   (2) UserManager.removeUser() fires an op:delete tombstone keyed on the SAME channel set
 *       (resurrection guard);
 *   (3) TopicOperatorStore.setOperator() fires a `put` on a real bind (the idempotent re-bind is
 *       NOT re-emitted);
 *   (4) THE BLOCKER: a replicated topic-operator record never reaches getOperator() authority —
 *       the seam only EMITS the local binding, it never RECEIVES one;
 *   (5) the server's /state/conflicts route is alive (200) while the conflict substrate is wired.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';

import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { RollbackUnmerge, DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { UserManager, type UserReplicationEmitter } from '../../src/users/UserManager.js';
import { TopicOperatorStore, type TopicOperatorReplicationEmitter } from '../../src/users/TopicOperatorStore.js';
import {
  USER_KIND_REGISTRATION,
  deriveUserRecordKey,
} from '../../src/core/UserRegistryReplicatedStore.js';
import {
  TOPIC_OPERATOR_KIND_REGISTRATION,
  deriveTopicOperatorRecordKey,
} from '../../src/core/TopicOperatorReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('WS2.6 user-record + topic-operator-record emit funnels (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let users: UserManager;
  let operators: TopicOperatorStore;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-int-ws26';
  const userPuts: string[] = [];
  const userDeletes: string[] = [];
  const opPuts: Array<{ key: string; uid: string }> = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws26-int-'));
    stateDir = path.join(tmpDir, 'state-home');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'int', agentName: 'INT' }));

    users = new UserManager(stateDir);
    const userEmitter: UserReplicationEmitter = {
      emitPut: (r) => { const k = deriveUserRecordKey(r.channels); if (k) userPuts.push(k); },
      emitDelete: (channels) => { const k = deriveUserRecordKey(channels); if (k) userDeletes.push(k); },
    };
    users.setUserReplicationEmitter(userEmitter);

    operators = new TopicOperatorStore(stateDir);
    const opEmitter: TopicOperatorReplicationEmitter = {
      emitPut: (topicId, record) => { const k = deriveTopicOperatorRecordKey(topicId, record.uid); if (k) opPuts.push({ key: k, uid: record.uid }); },
    };
    operators.setOperatorReplicationEmitter(opEmitter);

    // Wire the conflict substrate as server.ts does (the union readers share it).
    const registry = new ReplicatedKindRegistry();
    registry.register(USER_KIND_REGISTRATION);
    registry.register(TOPIC_OPERATOR_KIND_REGISTRATION);
    const conflictStore = new ConflictStore({ stateDir, now: () => new Date() });
    const dropped = new DroppedOriginRegistry({ stateDir });
    const rollback = new RollbackUnmerge(dropped, {
      peersDir: () => path.join(stateDir, 'state', 'coherence-journal', 'peers'),
      kindsForStore: (store) => { const r = registry.getByStore(store); return r ? [r.kind] : []; },
      now: () => new Date(),
      dropSnapshotCacheForOrigin: () => {},
      autoResolveConflicts: (o) => conflictStore.autoResolveForDroppedOrigin(o),
    });

    const config = {
      projectName: 'int', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
      conflictStore,
      rollbackUnmerge: rollback,
      droppedOriginRegistry: dropped,
    } as never);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/ws26-user-topicop-emit.test.ts' });
  });

  const hdr = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(1) upsertUser() fires a put through the wired emit funnel, keyed on the channel set (no userId on the wire)', () => {
    users.upsertUser({ id: 'usr-int-001', name: 'Justin', channels: [{ type: 'telegram', identifier: '55555' }], permissions: ['admin'], preferences: {}, createdAt: '2026-06-01T00:00:00.000Z' });
    const key = deriveUserRecordKey([{ type: 'telegram', identifier: '55555' }])!;
    expect(userPuts).toContain(key);
    expect(userPuts).not.toContain('usr-int-001'); // the local userId never crossed the wire
  });

  it('(2) removeUser() fires an op:delete tombstone keyed on the SAME channel set (resurrection guard)', () => {
    const key = deriveUserRecordKey([{ type: 'telegram', identifier: '55555' }])!;
    expect(users.removeUser('usr-int-001')).toBe(true);
    expect(userDeletes).toContain(key);
  });

  it('(3) setOperator() fires a put on a real bind; an idempotent re-bind is NOT re-emitted', () => {
    opPuts.length = 0;
    const bound = operators.setOperator(13481, { platform: 'telegram', uid: '999', displayName: 'Justin', boundAt: '2026-06-01T00:00:00.000Z' });
    expect(bound).not.toBeNull();
    const key = deriveTopicOperatorRecordKey(13481, '999')!;
    expect(opPuts.some((p) => p.key === key && p.uid === '999')).toBe(true);
    // Identical re-bind → idempotent skip → no second emission.
    opPuts.length = 0;
    operators.setOperator(13481, { platform: 'telegram', uid: '999', displayName: 'Justin', boundAt: '2026-06-01T00:00:00.000Z' });
    expect(opPuts).toHaveLength(0);
  });

  it('(4) THE BLOCKER: the topic-operator emit seam never receives — getOperator() stays the LOCAL bind', () => {
    // The bind above set uid 999 locally. A replicated record is never applied here (no apply path).
    expect(operators.getOperator(13481)?.uid).toBe('999');
  });

  it('(5) the conflict substrate the union reads share is alive over HTTP (200)', async () => {
    const res = await request(app).get('/state/conflicts').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
});
