// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration test for WS2.5 — the EvolutionManager evolution-action-record
 * replication emit seam wired alongside a real AgentServer. The action queue is CLI-driven
 * (no dedicated HTTP routes), so this drives the emit-on-mutation contract through the
 * manager that server.ts constructs, with the server alive and the conflict substrate wired —
 * proving the funnel + the union read coexist end-to-end:
 *   (1) addAction() fires a `put` through the manager's emit funnel, keyed on the content
 *       fingerprint (the local ACT id never crosses the wire);
 *   (2) updateAction(status) RE-FIRES a `put` carrying the new status (fork #2 — a peer must
 *       see the action was already completed elsewhere);
 *   (3) the server's /state/conflicts route is alive (200) while the conflict substrate is
 *       wired — the actions union read shares the same substrate.
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
import { EvolutionManager, type EvolutionActionReplicationEmitter } from '../../src/core/EvolutionManager.js';
import { EVOLUTION_ACTION_KIND_REGISTRATION, deriveEvolutionActionRecordKey } from '../../src/core/EvolutionActionsReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('WS2.5 evolution-action-record emit funnel (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let evolution: EvolutionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-int-ws25';
  const putKeys: Array<{ key: string; status: string }> = [];
  const deleteKeys: string[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws25-int-'));
    stateDir = path.join(tmpDir, 'state-home');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'int', agentName: 'INT' }));

    evolution = new EvolutionManager({ stateDir });
    const emitter: EvolutionActionReplicationEmitter = {
      emitPut: (r) => { const k = deriveEvolutionActionRecordKey(r.title, r.commitTo, r.createdAt); if (k) putKeys.push({ key: k, status: r.status }); },
      emitDelete: (title, commitTo, createdAt) => { const k = deriveEvolutionActionRecordKey(title, commitTo, createdAt); if (k) deleteKeys.push(k); },
    };
    evolution.setEvolutionActionReplicationEmitter(emitter);

    // Wire the conflict substrate as server.ts does (the actions union reader shares it).
    const registry = new ReplicatedKindRegistry();
    registry.register(EVOLUTION_ACTION_KIND_REGISTRATION);
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/ws25-evolution-actions-emit.test.ts' });
  });

  const hdr = () => ({ Authorization: `Bearer ${AUTH}` });
  let createdId: string;
  let expectedKey: string;

  it('(1) addAction() fires a put through the wired emit funnel, keyed on the content fingerprint', () => {
    const a = evolution.addAction({ title: 'integration action', description: 'd', commitTo: 'Justin' });
    expect(a.id).toMatch(/^ACT-/);
    createdId = a.id;
    const k = deriveEvolutionActionRecordKey('integration action', 'Justin', a.createdAt);
    expect(k).not.toBeNull();
    expectedKey = k!;
    expect(putKeys.some((p) => p.key === expectedKey && p.status === 'pending')).toBe(true);
    // The local ACT id never crossed the wire — the put key is the fingerprint.
    expect(putKeys.map((p) => p.key)).not.toContain(createdId);
  });

  it('(2) updateAction(status) RE-FIRES a put with the new status (fork #2 — peer sees completed)', () => {
    putKeys.length = 0;
    expect(evolution.updateAction(createdId, { status: 'completed' })).toBe(true);
    expect(putKeys.some((p) => p.key === expectedKey && p.status === 'completed')).toBe(true);
    // Terminal completion is a put, not a delete — the record is retained.
    expect(deleteKeys).toHaveLength(0);
  });

  it('(3) the conflict substrate the actions union read shares is alive over HTTP (200)', async () => {
    const res = await request(app).get('/state/conflicts').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
});
