import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
/** Real source capabilities -> dispatch receipt -> fsynced member stores ->
 * production witness HTTP routes. Loopback is a test fixture, NOT evidence of
 * an independently deployed failure domain or a real CLI spawn hook. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { MachineIdentityManager, sign, verify } from '../../src/core/MachineIdentity.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { WriteAdmission } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';
import { ConversationGraphDelegationSource, ConversationGraphDelegationIngress, buildGraphDelegationAuthorizationProof,
  verifyGraphDelegationCoreSource } from '../../src/core/ConversationGraphDelegation.js';
import { ConversationGraphReplication, type ConversationGraphReplicationRecord } from '../../src/core/ConversationGraphReplication.js';
import { verifyGraphAuthorization } from '../../src/core/ConversationGraphReplicationProof.js';
import { sealGraphBundle, openGraphBundle } from '../../src/core/GraphWitnessCrypto.js';
import { GraphWitnessService } from '../../src/core/GraphWitnessService.js';
import { createGraphWitnessRoutes } from '../../src/server/graphWitnessRoutes.js';
import { canonicalHash, GRAPH_SIGNATURE_DOMAINS as D, signGraphRecord, type GraphMembershipEpoch,
  type GraphWitnessLease } from '../../src/core/GraphWitnessTypes.js';

const directories: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'delegation-integration-test-cleanup' });
  vi.useRealTimers();
});

describe('delegation to witnessed member persistence integration', () => {
  it.each([false, true])('preserves witnessed source with native takeover=%s and refuses success until every member persists the certificate', async (nativeTakeover) => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-integration-')); directories.push(dir);
    const writerIdentity = new MachineIdentityManager(path.join(dir, 'writer'));
    const peerIdentity = new MachineIdentityManager(path.join(dir, 'peer'));
    const writer = await writerIdentity.generateIdentity();
    const peer = await peerIdentity.generateIdentity();
    const owner = crypto.generateKeyPairSync('ed25519');
    const witnessKeys = crypto.generateKeyPairSync('ed25519');
    const leaseSigner = new FencedLease({ selfMachineId: writer.machineId,
      sign: (bytes) => sign(bytes, writerIdentity.loadSigningKey()),
      verify: (bytes, signature, id) => { const key = writerIdentity.getSigningPublicKeyPem(id); return !!key && verify(bytes, signature, key); },
    }, { leaseTtlMs: 60000, failoverThresholdMs: 180000 });
    const originalLease = leaseSigner.signLease(4, new Date(now - 1000).toISOString(), new Date(now + 59000).toISOString(), 1);
    const makeAdmission = (id: string) => {
      const admission = new WriteAdmission({ thisMachineId: id, isReadOnly: () => false, isPoolActive: () => true,
        registry: buildWriteDomainRegistry({ machineId: id }), dryRun: false, disableTimers: true });
      cleanups.push(() => admission.stop()); return admission;
    };
    const admission = makeAdmission(writer.machineId);
    const state = new StateManager(writerIdentity.baseDir);
    const registry = new ConversationRegistry({ stateDir: writerIdentity.baseDir, machineId: () => writer.machineId });
    cleanups.push(() => registry.close());
    const bind = createConversationBindAuth(writerIdentity.baseDir);
    state.saveSession({ id: 'parent-id', name: 'parent', tmuxSession: 'parent-tmux', status: 'running', startedAt: new Date(now - 2000).toISOString(), telegramTopicId: 42 });
    state.saveSession({ id: 'worker-id', name: 'worker', tmuxSession: 'worker-tmux', status: 'running', startedAt: new Date(now - 1000).toISOString(), telegramTopicId: 43 });
    const parentRef = { kind: 'conversation' as const, platform: 'telegram' as const, chatId: '-100123', topicId: 42 };
    const workerRef = { ...parentRef, topicId: 43 };
    const coordinator = { currentLease: () => originalLease, currentEpoch: () => 4,
      holdsLease: () => leaseSigner.holdsValidLease(originalLease, 4, now) };
    const ownershipForConversation = (ref: unknown) => ({ sessionKey: `telegram-${(ref as typeof parentRef).topicId}`, ownerMachineId: writer.machineId, ownershipEpoch: 7, status: 'active' as const, nonce: 'ownership', timestamp: now, updatedAt: new Date(now - 1000).toISOString() });
    const sourceStore = new ConversationGraphDelegationSource({ agentId: 'echo', identity: writerIdentity, admission, coordinator, ownershipForConversation,
      state, bindAuth: bind, conversations: registry, telegramChatId: '-100123', now: () => now,
      conversationIdsForSession: (session) => session === 'parent-tmux' ? [42] : session === 'worker-tmux' ? [43] : [],
      projectForConversation: () => 'instar' });
    const captured = sourceStore.captureSuccessfulSpawn({ sourceId: 'dispatch-integration-one', parentSessionId: 'parent-id', workerSessionId: 'worker-id',
      parentRef, workerRef, parentBindToken: bind.mint('parent-tmux', [42]), workerBindToken: bind.mint('worker-tmux', [43]) });
    expect(captured.status).toBe('captured-local');
    if (captured.status !== 'captured-local') throw new Error(captured.reason);
    const ingress = new ConversationGraphDelegationIngress({ agentId: 'echo', identity: writerIdentity, admission, coordinator, ownershipForConversation,
      stateDir: writerIdentity.baseDir, now: () => now, verifiedHeadsFor: () => [], parentProjectScope: () => ['instar'], currentProjectForConversation: () => 'instar' });
    const proposed = ingress.prepare(captured.source);
    if (proposed.status !== 'proposed') throw new Error('delegation not proposed');
    const member = (id: MachineIdentityManager) => ({ machineId: id.loadIdentity().machineId,
      signingPublicKey: id.getSigningPublicKeyPem(id.loadIdentity().machineId)!, sealingPublicKey: id.getEncryptionPublicKeyPem(id.loadIdentity().machineId)! });
    const unsignedMembership = { v: 1 as const, agentId: 'echo', epoch: 1, previousMembershipHash: null,
      members: [member(writerIdentity), member(peerIdentity)], writerId: nativeTakeover ? peer.machineId : writer.machineId,
      witnessId: 'test-independent-witness', failureDomain: 'test-witness-domain', createdAt: new Date(now - 2000).toISOString() };
    const membership: GraphMembershipEpoch = { ...unsignedMembership, signature: signGraphRecord(D.membership, unsignedMembership, owner.privateKey) };
    const unsignedBridge = { v: 1 as const, agentId: 'echo', membershipEpoch: 1, leaseEpoch: 4, writerId: writer.machineId,
      issuedAt: originalLease.acquiredAt, expiresAt: originalLease.expiresAt, fencedLeaseHash: canonicalHash(originalLease) };
    const lease: GraphWitnessLease = { ...unsignedBridge, signature: signGraphRecord(D.lease, unsignedBridge, writerIdentity.loadSigningKey()) };
    const proof = buildGraphDelegationAuthorizationProof(proposed, { identity: writerIdentity, membership, lease, originalLease,
      ownerPublicKey: owner.publicKey, acceptedAt: new Date(now).toISOString() });
    expect(proof.receipt.authenticationMethod).toBe('dispatch');
    const plaintext = Buffer.from(JSON.stringify({ source: captured.source }));
    const controlCapsule=createGraphControlCapsule('graph-event',proposed.core as unknown as Record<string,unknown>,proof);
    const controlBytes=encodeGraphSourceEnvelope('graph-event',proposed.core,proof,plaintext);
    const bundle = sealGraphBundle(controlBytes, membership.members, { agentId: 'echo', eventId: proof.receipt.eventId });controlBytes.fill(0);plaintext.fill(0);
    const packet = { coreType:'graph-event' as const,controlHash:canonicalHash(controlCapsule),erasureIdentity:deriveGraphErasureIdentity('graph-event',proposed.core),agentId: 'echo', eventId: proof.receipt.eventId, idempotencyKey: proof.receipt.idempotencyKey,
      coreHash: canonicalHash(proposed.core), authorizationReceiptHash: canonicalHash(proof.receipt), sourceSequence: 1,
      predecessorHash: null, membershipEpoch: 1, leaseEpoch: 4, writerId: writer.machineId, sourceBundleHash: canonicalHash(bundle) };
    const record: ConversationGraphReplicationRecord = { coreType:'graph-event',packet, packetSignature: signGraphRecord('graph-operation-packet-v1', packet, writerIdentity.loadSigningKey()),
      core: proposed.core as unknown as Record<string, unknown>, authorizationProof: proof, encryptedSourceBundle: bundle };
    expect(verifyGraphDelegationCoreSource(record.core, captured.source, writerIdentity.getSigningPublicKeyPem(writer.machineId)!, 'echo', writer.machineId)).toBe(true);
    expect(verifyGraphAuthorization(packet, record.core, proof, owner.publicKey, writer.machineId)).toEqual({ ok: true });
    const storeOptions = (id: MachineIdentityManager) => ({ directory: path.join(id.baseDir, 'graph-replication'), agentId: 'echo', machineId: id.loadIdentity().machineId,
      memberPrivateKey: id.loadSigningKey(), memberSealingPrivateKey: id.loadEncryptionKey(), ownerPublicKey: owner.publicKey, witnessPublicKeys: new Map([['test-independent-witness', witnessKeys.publicKey]]),
      writeAdmission: id === writerIdentity ? admission : makeAdmission(peer.machineId), legacyReadOnly: () => false,
      liveAdmission: () => ({ admitted: true, writerId: writer.machineId, leaseEpoch: 4, membershipEpoch: 1, fencedLeaseHash: canonicalHash(originalLease) }),
      validateCore: (core: unknown) => verifyGraphDelegationCoreSource(core, captured.source, writerIdentity.getSigningPublicKeyPem(writer.machineId)!, 'echo', writer.machineId),
      now: () => new Date(now) });
    const writerStore = await ConversationGraphReplication.open(storeOptions(writerIdentity));
    const peerStore = await ConversationGraphReplication.open(storeOptions(peerIdentity));
    const writerReceipt = await writerStore.appendLocal(record);
    expect(writerStore.mayAcknowledgeNewWrite(packet.eventId)).toBe(false);
    const service = new GraphWitnessService({ databasePath: path.join(dir, 'witness', 'witness.sqlite'), witnessId: 'test-independent-witness',
      failureDomain: 'test-witness-domain', signingPrivateKey: witnessKeys.privateKey, enrollments: { echo: { ownerPublicKey: owner.publicKey.export({ type: 'spki', format: 'pem' }).toString(), bearerToken: 'delegation-integration-fixture-token-32chars' } },
      installedFailureDomains: ['writer-domain', 'peer-domain'], now: () => now });
    cleanups.push(() => service.close());
    const app = express(); app.use(express.json({ limit: '3mb' })); app.use(createGraphWitnessRoutes(service));
    const prefix = `/v1/agents/echo/operations/${encodeURIComponent(packet.idempotencyKey)}`;
    await request(app).post('/v1/agents/echo/membership').set('Authorization', 'Bearer delegation-integration-fixture-token-32chars').send({ membership }).expect(200);
    await request(app).post(`${prefix}/prepare`).set('Authorization', 'Bearer delegation-integration-fixture-token-32chars').send({ packet, packetSignature: record.packetSignature,
      lease, originalLease, controlCapsule,encryptedSourceBundle: bundle }).expect(200);
    const incomplete = await request(app).post(`${prefix}/commit`).set('Authorization', 'Bearer delegation-integration-fixture-token-32chars').send({ lease, originalLease, receipts: [writerReceipt.receipt] }).expect(403);
    expect(incomplete.body.code).toBe('all-member-durable-receipts-required');
    const peerReceipt = await peerStore.receive(record, writer.machineId);
    const committed = await request(app).post(`${prefix}/commit`).set('Authorization', 'Bearer delegation-integration-fixture-token-32chars')
      .send({ lease, originalLease, receipts: [writerReceipt.receipt, peerReceipt] }).expect(200);
    const writerCertificateReceipt = await writerStore.attachCertificate(packet.eventId, committed.body);
    expect(writerStore.mayAcknowledgeNewWrite(packet.eventId)).toBe(false);
    const peerCertificateReceipt = await peerStore.attachCertificate(packet.eventId, committed.body);
    await writerStore.recordCertificateReceipt(packet.eventId, peerCertificateReceipt);
    await peerStore.recordCertificateReceipt(packet.eventId, writerCertificateReceipt);
    await writerStore.recordCommitProofDeliveryReceipt(packet.eventId,writerStore.commitProofDeliveryReceipt(packet.eventId));
    await writerStore.recordCommitProofDeliveryReceipt(packet.eventId,peerStore.commitProofDeliveryReceipt(packet.eventId));
    expect(writerStore.mayAcknowledgeNewWrite(packet.eventId)).toBe(true);
    const recoveredPeer = await ConversationGraphReplication.open(storeOptions(peerIdentity));
    expect(recoveredPeer.status(packet.eventId).state).toBe('committed');
    const recovered = recoveredPeer.repairRecord(packet.eventId)!;
    expect(JSON.parse(recoveredPeer.openVerifiedPayload(recovered).toString())).toEqual({ source: captured.source });
    const missingSource = structuredClone(record); delete missingSource.authorizationProof.dispatchSource;
    const invalidDir = path.join(dir, 'refused-store');
    const untrusted = await ConversationGraphReplication.open({ ...storeOptions(peerIdentity), directory: invalidDir });
    await expect(untrusted.receive(missingSource, writer.machineId)).rejects.toThrow('untrusted-record');
  });
});
