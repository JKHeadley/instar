// safe-fs-allow: fixture teardown and simulated transport loss touch mkdtemp paths only.
import fs from 'node:fs/promises';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CoherenceJournal, JOURNAL_KINDS, type JournalEntry } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ConversationGraphReplication, CONVERSATION_GRAPH_JOURNAL_KIND, CONVERSATION_GRAPH_STORE,
  registerConversationGraphReplication, type ConversationGraphReplicationRecord } from '../../src/core/ConversationGraphReplication.js';
import { canonicalHash } from '../../src/core/GraphWitnessTypes.js';
import { replicationFixture } from '../unit/conversation-graph-replication.fixtures.js';

const roots: string[] = []; const journals: CoherenceJournal[] = [];
async function temp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-repl-integration-')); roots.push(dir); return dir; }
afterEach(async () => { journals.splice(0).forEach((j) => j.close()); for (const dir of roots.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-replication-test:teardown' }); });

describe('Conversations source → real journal → peer durable apply', () => {
  it('advertises, serves and applies the registered kind, and HTTP diagnostics read durable bytes', async () => {
    const f = replicationFixture(); const writerDir = await temp(); const peerDir = await temp();
    const writer = await ConversationGraphReplication.open(f.options(path.join(writerDir, 'graph-source')));
    const peer = await ConversationGraphReplication.open(f.options(path.join(peerDir, 'graph-source'), 'sleeper'));
    const record = f.record(); await writer.appendLocal(record);
    const registry = new ReplicatedKindRegistry(); registerConversationGraphReplication(registry);
    const publications: Promise<void>[] = []; const received: Promise<unknown>[] = [];
    const journal = new CoherenceJournal({ stateDir: writerDir, machineId: 'writer', flushIntervalMs: 100000,
      onReplicatedRecordsCommitted: (kind, entries) => {
        if (kind !== CONVERSATION_GRAPH_JOURNAL_KIND) return;
        for (const e of entries) {
          const descriptor=e.data.descriptor as {eventId:string};
          publications.push(writer.journalCommitted(descriptor.eventId,canonicalHash(descriptor)));
        }
      } }); journals.push(journal); journal.setReplicatedKindRegistry(registry); journal.open();
    expect(JOURNAL_KINDS).toContain(CONVERSATION_GRAPH_JOURNAL_KIND);
    expect(journal.getOwnAdvert()[CONVERSATION_GRAPH_JOURNAL_KIND].lastSeq).toBe(0);
    let tick = 0;
    expect(await writer.drainOutbox((r) => journal.emitReplicatedRecord(CONVERSATION_GRAPH_JOURNAL_KIND,
      writer.envelope(r, { physical: 1000, logical: tick++, node: 'writer' })))).toEqual({ 'graph-event:event-one': 'accepted' });
    expect(publications).toHaveLength(0);
    journal.flush(); await Promise.all(publications);
    expect(journal.getOwnAdvert()[CONVERSATION_GRAPH_JOURNAL_KIND].lastSeq).toBe(1);
    const serving = new JournalSyncApplier({ stateDir: writerDir, replicatedRegistry: registry });
    const batch = serving.buildServeBatch(CONVERSATION_GRAPH_JOURNAL_KIND, 0, 'writer');
    expect(batch.entries).toHaveLength(1);
    expect(JSON.stringify(batch)).not.toMatch(/ciphertext|envelopes|ephemeralPublicKey/);
    const receiver = new JournalSyncApplier({ stateDir: peerDir, replicatedRegistry: registry,
      onReplicatedRecordsCommitted: (origin, kind, entries) => {
        if (kind === CONVERSATION_GRAPH_JOURNAL_KIND) for (const e of entries)
          received.push(peer.receive(writer.repairRecord((e.data.descriptor as {eventId:string}).eventId)!,origin));
      } });
    expect(receiver.apply('writer', [batch])).toMatchObject({ applied: 1, invalidEntries: 0, forgedEntries: 0 });
    await Promise.all(received);
    expect(peer.repairRecord('graph-event:event-one')?.packet).toEqual(record.packet);
    const restartedPeer = await ConversationGraphReplication.open(f.options(path.join(peerDir, 'graph-source'), 'sleeper'));
    expect(restartedPeer.status('graph-event:event-one').state).toBe('prepared');
    // The HTTP path is the existing production route factory, not a fake endpoint.
    const app = express(); app.use(express.json());
    app.use(createRoutes({ config: { projectName: 'test', projectDir: writerDir, stateDir: writerDir, port: 0, sessions: {}, scheduler: {} },
      sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null,
        listSessions: () => [], getCoherenceJournal: () => journal }, tokenLedger: null, reapLog: null, startTime: new Date() } as unknown as RouteContext));
    const response = await request(app).get(`/coherence/journal?kind=${CONVERSATION_GRAPH_JOURNAL_KIND}`);
    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(1);
    expect(response.body.entries[0].data.descriptor.coreHash).toBe(record.packet.coreHash);
  });

  it('a surviving member rebuilds certified state after writer, witness and journal transport disappear', async () => {
    const f = replicationFixture(); const writerDir = await temp(); const peerDir = await temp(); const r = f.record();
    const writer = await ConversationGraphReplication.open(f.options(path.join(writerDir, 'source')));
    const peer = await ConversationGraphReplication.open(f.options(path.join(peerDir, 'source'), 'sleeper'));
    const wr = await writer.appendLocal(r); const pr = await peer.receive(r, 'writer');
    const certificate = f.certificate(r, [wr.receipt, pr]);
    const wa = await writer.attachCertificate('graph-event:event-one', certificate); const pa = await peer.attachCertificate('graph-event:event-one', certificate);
    await writer.recordCertificateReceipt('graph-event:event-one', pa); await peer.recordCertificateReceipt('graph-event:event-one', wa);
    SafeFsExecutor.safeRmSync(writerDir, { recursive: true, force: true, operation: 'graph-replication-test:simulate-writer-loss' }); // permanent writer loss
    const restored = await ConversationGraphReplication.open(f.options(path.join(peerDir, 'source'), 'sleeper'));
    const recovered = restored.repairRecord('graph-event:event-one')!;
    expect(restored.status('graph-event:event-one').state).toBe('committed');
    const plaintext=restored.openVerifiedPayload(recovered);try{expect(plaintext.toString()).toBe('private original source');}finally{plaintext.fill(0);}
    const registry = new ReplicatedKindRegistry(); registerConversationGraphReplication(registry);
    const dropped = new DroppedOriginRegistry({ stateDir: peerDir });
    const reader = new ReplicatedStoreReader({ registry, stores: { conversationGraph: { enabled: true } }, tierOf: () => 'high',
      droppedOrigins: dropped, conflictStore: new ConflictStore({ stateDir: peerDir, now: () => new Date() }),
      listRecordKeys: () => restored.originRecords().map((x) => x.envelope.recordKey),
      loadOriginRecords: (_store, key) => restored.originRecords().filter((x) => x.envelope.recordKey === key) });
    expect(restored.certifiedUnion(reader, dropped)).toMatchObject({ partial: false, records: [{ packet: r.packet }] });
    dropped.add(CONVERSATION_GRAPH_STORE, 'writer', new Date().toISOString());
    expect(restored.certifiedUnion(reader, dropped).records).toHaveLength(0); // source cannot bypass un-merge
  });
});
