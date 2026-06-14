// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration test for WS2.4 — the KnowledgeManager knowledge-record replication
 * emit seam wired alongside a real AgentServer. KnowledgeManager is CLI-only (no HTTP
 * routes), so unlike the WS2.2 learnings sibling this drives the emit-on-mutation contract
 * through the manager that server.ts constructs, with the server alive and the conflict
 * substrate wired — proving the funnel + the union read coexist end-to-end:
 *   (1) ingest() fires a `put` through the manager's emit funnel, keyed on the content
 *       fingerprint (the local id + filePath never cross the wire);
 *   (2) remove() fires an `op:delete` tombstone keyed on the SAME fingerprint (so a
 *       removed source is not resurrected by a peer);
 *   (3) the server's /state/conflicts route is alive (200) while the conflict substrate is
 *       wired — the knowledge union read shares the same substrate.
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
import { KnowledgeManager, type KnowledgeReplicationEmitter } from '../../src/knowledge/KnowledgeManager.js';
import { KNOWLEDGE_KIND_REGISTRATION, deriveKnowledgeRecordKey } from '../../src/core/KnowledgeReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('WS2.4 knowledge-record emit funnel (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let knowledge: KnowledgeManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-int-ws24';
  const putKeys: string[] = [];
  const deleteKeys: string[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws24-int-'));
    stateDir = path.join(tmpDir, 'state-home');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'int', agentName: 'INT' }));

    knowledge = new KnowledgeManager(stateDir);
    const emitter: KnowledgeReplicationEmitter = {
      emitPut: (r) => { const k = deriveKnowledgeRecordKey(r.title, r.url, r.type); if (k) putKeys.push(k); },
      emitDelete: (title, url, type) => { const k = deriveKnowledgeRecordKey(title, url, type); if (k) deleteKeys.push(k); },
    };
    knowledge.setKnowledgeReplicationEmitter(emitter);

    // Wire the conflict substrate as server.ts does (the knowledge union reader shares it).
    const registry = new ReplicatedKindRegistry();
    registry.register(KNOWLEDGE_KIND_REGISTRATION);
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/ws24-knowledge-emit.test.ts' });
  });

  const hdr = () => ({ Authorization: `Bearer ${AUTH}` });
  let createdId: string;
  let expectedKey: string;

  it('(1) ingest() fires a put through the wired emit funnel, keyed on the content fingerprint', () => {
    const res = knowledge.ingest('a knowledge body written to a local file', {
      title: 'integration source', url: 'https://example.com/int', type: 'article', tags: ['t'], summary: 'a summary',
    });
    expect(res.sourceId).toMatch(/^kb_/);
    createdId = res.sourceId;
    const k = deriveKnowledgeRecordKey('integration source', 'https://example.com/int', 'article');
    expect(k).not.toBeNull();
    expectedKey = k!;
    expect(putKeys).toContain(expectedKey);
    // The local id + filePath never crossed the wire — the put key is the fingerprint.
    expect(putKeys).not.toContain(createdId);
  });

  it('(2) remove() fires an op:delete tombstone keyed on the SAME fingerprint (no resurrection)', () => {
    deleteKeys.length = 0;
    expect(knowledge.remove(createdId)).toBe(true);
    expect(deleteKeys).toContain(expectedKey); // tombstone reaches the same source
    expect(knowledge.getCatalog()).toHaveLength(0);
  });

  it('(3) the conflict substrate the knowledge union read shares is alive over HTTP (200)', async () => {
    const res = await request(app).get('/state/conflicts').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
});
