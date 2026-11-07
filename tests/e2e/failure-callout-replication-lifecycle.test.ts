/** Production AgentServer ledger -> real journal -> peer apply -> offline read.
 * In-process fixture only: no sessions, model providers or test agents.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { FAILURE_CALLOUT_KIND_REGISTRATION, FAILURE_CALLOUT_RECORD_KIND, failureReplicaReader } from '../../src/core/FailureCalloutReplicatedStore.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('failure-callout replication production lifecycle', () => {
  it('keeps real API-captured evidence and its immutable chronology available after the origin goes offline', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-replica-e2e-'));
    const a = path.join(root, 'a'), b = path.join(root, 'b');
    for (const dir of [a, b]) fs.mkdirSync(path.join(dir, 'state', 'sessions'), { recursive: true });
    const reg = new ReplicatedKindRegistry(); reg.register(FAILURE_CALLOUT_KIND_REGISTRATION);
    const journal = new CoherenceJournal({ stateDir: a, machineId: 'origin', flushIntervalMs: 1_000_000 }); journal.open(); journal.setReplicatedKindRegistry(reg);
    const token = 'replica-lifecycle-token';
    const config = (dir: string): InstarConfig => ({ projectName: 'failure-replica', agentName: 'Fixture', projectDir: dir, stateDir: dir,
      authToken: token, port: 0, monitoring: { failureCallouts: { enabled: true }, correctionLearning: { enabled: false } } } as InstarConfig);
    const emitter = new ReplicatedRecordEmitter({ journal, clock: new HybridLogicalClock({ node: 'origin', now: Date.now }), registry: reg,
      origin: 'origin', stores: () => ({ failureCallout: { enabled: true } }), loadWitness: () => undefined });
    try {
      const origin = new AgentServer({ config: config(a), sessionManager: createMockSessionManager() as any, state: new StateManager(a),
        meshSelfId: 'origin', replicatedRecordEmitter: emitter });
      const auth = { Authorization: `Bearer ${token}`, 'X-Instar-Request': '1' };
      const context = { turns: [{ text: 'You make the group', fromUser: false, at: 1 }, { text: 'You can do that yourself', fromUser: true, at: 2 }],
        instructions: ['Agent does approved work'], decisions: ['Helper restriction overrode operator approval'], sourceRefs: ['message:2'], missing: [] };
      const created = await request(origin.getApp()).post('/corrections').set(auth).send({ kind: 'infra-gap', learning: 'Own approved setup', severity: 'failure-callout', failureContext: context });
      expect(created.status).toBe(201);
      const updated = await request(origin.getApp()).patch(`/corrections/${created.body.id}/failure-case`).set(auth).send({ version: created.body.version, context });
      expect(updated.status).toBe(200);
      journal.flush();
      const entries = journal.readTail(FAILURE_CALLOUT_RECORD_KIND, 100).entries;
      expect(entries.length).toBeGreaterThanOrEqual(4);
      const applier = new JournalSyncApplier({ stateDir: b, replicatedRegistry: reg });
      const applied = applier.apply('origin', [{ kind: FAILURE_CALLOUT_RECORD_KIND, incarnation: 'origin-test', entries: [...entries].sort((x, y) => x.seq - y.seq) }]);
      expect(applied.applied).toBe(entries.length);
      const streams = new ReplicatedPeerStreamReader({ stateDir: b, registry: reg, selfMachineId: 'reader', autoRebuild: false }); await streams.rebuildWitnessIndexAsync();
      const reader = new AgentServer({ config: config(b), sessionManager: createMockSessionManager() as any, state: new StateManager(b), meshSelfId: 'reader',
        listPoolMachines: () => [{ machineId: 'origin' }] });
      reader.setFailureReplicaReader(failureReplicaReader(streams));
      const detail = await request(reader.getApp()).get(`/corrections/${created.body.id}?machineId=origin`).set(auth);
      expect(detail.status).toBe(200); expect(detail.body.failureCase.context).toEqual(context);
      expect(detail.body.replication).toMatchObject({ state: 'stale', readOnly: true, originMachineId: 'origin', version: updated.body.version });
      const episodes = await request(reader.getApp()).get(`/corrections/${created.body.id}/failure-episodes?machineId=origin`).set(auth);
      expect(episodes.status).toBe(200); expect(episodes.body.episodes.map((e: any) => e.version)).toEqual([2, 1]);
      const write = await request(reader.getApp()).patch(`/corrections/${created.body.id}/failure-case?machineId=origin`).set(auth).send({ version: updated.body.version, context });
      expect(write.status).toBe(503);
    } finally {
      journal.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'failure-replica-lifecycle' });
    }
  });
});
