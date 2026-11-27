import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
// safe-fs-allow: fixture teardown and permanent-writer-loss simulation use mkdtemp paths only.
/** Real protocol lifecycle: HTTP witness (SQLite FULL WAL), journal serve/apply,
 * fsynced member sources and restart. Loopback is explicit test transport; this
 * does NOT prove deployment to an independent physical failure domain. */
import fs from 'node:fs/promises';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphWitnessService } from '../../src/core/GraphWitnessService.js';
import { GraphWitnessClient } from '../../src/core/GraphWitnessClient.js';
import { createGraphWitnessRoutes } from '../../src/server/graphWitnessRoutes.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ConversationGraphReplication, CONVERSATION_GRAPH_JOURNAL_KIND, registerConversationGraphReplication,
  type ConversationGraphReplicationRecord } from '../../src/core/ConversationGraphReplication.js';
import { canonicalHash } from '../../src/core/GraphWitnessTypes.js';
import { replicationFixture } from '../unit/conversation-graph-replication.fixtures.js';

const directories: string[] = []; const journals: CoherenceJournal[] = [];
let service: GraphWitnessService | null = null; let server: Server | null = null;
async function temp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-lifecycle-')); directories.push(dir); return dir; }
afterEach(async () => {
  journals.splice(0).forEach((j) => j.close());
  if (server) { const s = server; server = null; await new Promise<void>((resolve) => s.close(() => resolve())); }
  service?.close(); service = null;
  for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-replication-test:teardown' });
});

describe('Conversations replication protocol lifecycle', () => {
  it('keeps sleeping-member work pending, certifies only every durable member, and survives writer/witness loss', async () => {
    const f = replicationFixture(); const witnessDir = await temp(); const writerDir = await temp(); const peerDir = await temp();
    service = new GraphWitnessService({ databasePath: path.join(witnessDir, 'witness.sqlite'), witnessId: 'independent-witness',
      failureDomain: 'managed-external', signingPrivateKey: f.witness.privateKey,
      enrollments: { echo: { ownerPublicKey: f.owner.publicKey.export({ type: 'spki', format: 'pem' }).toString(), bearerToken: 'test-only-agent-transport-key' } },
      installedFailureDomains: ['writer-domain', 'sleeper-domain'], now: () => Date.parse('2026-11-05T08:06:00Z') });
    const app = express(); app.use(express.json({ limit: '3mb' })); app.use(createGraphWitnessRoutes(service));
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing-listen-address');
    const witness = new GraphWitnessClient({ baseUrl: `http://127.0.0.1:${address.port}`, agentId: 'echo',
      ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(), witnessId: 'independent-witness', witnessPublicKey: f.witness.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      expectedFailureDomain: 'managed-external', bearerToken: 'test-only-agent-transport-key', allowLoopbackHttpForTests: true });
    await witness.registerMembership(f.membership);
    const writer = await ConversationGraphReplication.open(f.options(path.join(writerDir, 'source')));
    const peer = await ConversationGraphReplication.open(f.options(path.join(peerDir, 'source'), 'sleeper'));
    const record = f.record();
    const local = await writer.appendLocal(record);
    const preparation = {controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof), packet: record.packet, packetSignature: record.packetSignature,
      lease: f.lease, originalLease: f.originalLease, encryptedSourceBundle: record.encryptedSourceBundle! };
    await witness.prepare(preparation);
    expect((await witness.operation(record.packet.idempotencyKey)).state).toBe('prepared');
    await expect(witness.commit(preparation, f.membership, [local.receipt])).rejects.toThrow('all-member-durable-receipts-required');
    expect(writer.mayAcknowledgeNewWrite('graph-event:event-one')).toBe(false);
    const registry = new ReplicatedKindRegistry(); registerConversationGraphReplication(registry);
    const peerCommits: Promise<unknown>[] = [];
    const journal = new CoherenceJournal({ stateDir: writerDir, machineId: 'writer', flushIntervalMs: 100000 });
    journals.push(journal); journal.setReplicatedKindRegistry(registry); journal.open();
    const applier = new JournalSyncApplier({ stateDir: peerDir, replicatedRegistry: registry,
      onReplicatedRecordsCommitted: (origin, kind, entries) => {
        if (kind === CONVERSATION_GRAPH_JOURNAL_KIND) for (const entry of entries)
          peerCommits.push(peer.receive(writer.repairRecord((entry.data.descriptor as {eventId:string}).eventId)!,origin));
      } });
    await writer.drainOutbox((r) => journal.emitReplicatedRecord(CONVERSATION_GRAPH_JOURNAL_KIND,
      writer.envelope(r, { physical: 1000, logical: 0, node: 'writer' })));
    journal.flush();
    const serving = new JournalSyncApplier({ stateDir: writerDir, replicatedRegistry: registry });
    expect(applier.apply('writer', [serving.buildServeBatch(CONVERSATION_GRAPH_JOURNAL_KIND, 0, 'writer')]).applied).toBe(1);
    const peerReceipt = (await Promise.all(peerCommits))[0] as Awaited<ReturnType<ConversationGraphReplication['receive']>>;
    const certificate = await witness.commit(preparation, f.membership, [local.receipt, peerReceipt]);
    const writerAck = await writer.attachCertificate('graph-event:event-one', certificate);
    expect((await witness.acknowledgeCertificate(record.packet.idempotencyKey, writerAck)).allMembersPersisted).toBe(false);
    const peerAck = await peer.attachCertificate('graph-event:event-one', certificate);
    expect((await witness.acknowledgeCertificate(record.packet.idempotencyKey, peerAck)).allMembersPersisted).toBe(true);
    await writer.recordCertificateReceipt('graph-event:event-one', peerAck); await peer.recordCertificateReceipt('graph-event:event-one', writerAck);
    expect(writer.mayAcknowledgeNewWrite('graph-event:event-one')).toBe(true);
    journal.close(); journals.splice(journals.indexOf(journal), 1);
    SafeFsExecutor.safeRmSync(writerDir, { recursive: true, force: true, operation: 'graph-replication-test:simulate-writer-loss' });
    await new Promise<void>((resolve) => server!.close(() => resolve())); server = null;
    service.close(); service = null;
    const survivor = await ConversationGraphReplication.open(f.options(path.join(peerDir, 'source'), 'sleeper'));
    expect(survivor.status('graph-event:event-one').state).toBe('committed');
    const localOnly = survivor.repairRecord('graph-event:event-one')!;
    const plaintext=survivor.openVerifiedPayload(localOnly);try{expect(plaintext.toString()).toBe('private original source');}finally{plaintext.fill(0);}
    expect(canonicalHash(localOnly.core)).toBe(record.packet.coreHash);
  });
});
