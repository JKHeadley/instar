import crypto from 'node:crypto';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import path from 'node:path';
import { FencedLease } from '../../src/core/FencedLease.js';
import { sign as machineSign } from '../../src/core/MachineIdentity.js';
import { sealGraphBundle } from '../../src/core/GraphWitnessCrypto.js';
import { GraphWitnessService } from '../../src/core/GraphWitnessService.js';
import { canonicalHash, GRAPH_SIGNATURE_DOMAINS as D, signGraphRecord, witnessActionPayload,
  type GraphMemberReceipt, type GraphMembershipEpoch, type GraphOperationPacket,
  type GraphWitnessLease } from '../../src/core/GraphWitnessTypes.js';

export const pem = (key: crypto.KeyObject) => key.export({ type: key.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' }).toString();
export function witnessFixture(directory: string) {
  const now = Date.now();
  const owner = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const machines = ['machine-a', 'machine-b'].map((machineId) => ({ machineId,
    signing: crypto.generateKeyPairSync('ed25519'), sealing: crypto.generateKeyPairSync('x25519') }));
  const membershipBody = { v: 1 as const, agentId: 'agent-a', epoch: 1, previousMembershipHash: null,
    members: machines.map((m) => ({ machineId: m.machineId, signingPublicKey: pem(m.signing.publicKey), sealingPublicKey: pem(m.sealing.publicKey) })),
    writerId: machines[0].machineId, witnessId: 'witness-remote', failureDomain: 'managed-cloud:test-volume', createdAt: '2026-11-05T09:00:00Z' };
  const membership: GraphMembershipEpoch = { ...membershipBody, signature: signGraphRecord(D.membership, membershipBody, owner.privateKey) };
  function leaseFor(machineIndex = 0, leaseEpoch = 1) {
    const body = { holder: machines[machineIndex].machineId, epoch: leaseEpoch, acquiredAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), nonce: leaseEpoch };
    const originalLease = { ...body, signature: machineSign(FencedLease.canonicalize(body), pem(machines[machineIndex].signing.privateKey)) };
    const bridgeBody = { v: 1 as const, agentId: membership.agentId, membershipEpoch: membership.epoch,
      leaseEpoch, writerId: body.holder, issuedAt: body.acquiredAt, expiresAt: body.expiresAt, fencedLeaseHash: canonicalHash(originalLease) };
    const lease: GraphWitnessLease = { ...bridgeBody, signature: signGraphRecord(D.lease, bridgeBody, machines[machineIndex].signing.privateKey) };
    return { lease, originalLease };
  }
  const options = { databasePath: path.join(directory, 'witness.sqlite'), witnessId: membership.witnessId, failureDomain: membership.failureDomain,
    signingPrivateKey: pem(witness.privateKey), enrollments: { [membership.agentId]: { ownerPublicKey: pem(owner.publicKey), bearerToken: 'test-agent-token' } },
    installedFailureDomains: ['installed-laptop', 'installed-studio'], now: () => now };
  function prepareRequest(eventId = 'event-0001', sourceSequence = 1, predecessorHash: string | null = null, machineIndex = 0, leaseEpoch = 1) {
    const rawEventId=eventId;eventId=`graph-event:${rawEventId}`;
    const bundle = sealGraphBundle(Buffer.from('private-canary-owner-transcript'), membership.members, { agentId: membership.agentId, eventId });
    const actuation=leaseFor(machineIndex,leaseEpoch);
    const core={schemaVersion:1,eventId:rawEventId,op:'set-primary-placement',subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42},parent:null,relation:null,replacesPlacementEventIds:[],authority:'owner',principal:'owner',receipt:{kind:'owner-proof',id:`proof-${rawEventId}`},machineId:machines[machineIndex].machineId,createdAt:new Date(now).toISOString()};
    const receipt=signGraphAuthorizationReceipt({v:1,agentId:membership.agentId,eventId,coreHash:canonicalHash(core),actorPrincipal:'owner',authenticationMethod:'owner-device',receiptId:core.receipt.id,membershipEpoch:1,leaseEpoch,idempotencyKey:`request:${eventId}`,writerId:machines[machineIndex].machineId,fencedLeaseHash:canonicalHash(actuation.originalLease),acceptedAt:new Date(now).toISOString()},machines[machineIndex].signing.privateKey);
    const controlCapsule=createGraphControlCapsule('graph-event',core,{receipt,membership,...actuation});
    const packet: GraphOperationPacket = {coreType:'graph-event',erasureIdentity:{sourceKind:'graph-intent',sourceId:eventId}, agentId: membership.agentId, eventId, idempotencyKey: `request:${eventId}`,
      coreHash: canonicalHash(core), authorizationReceiptHash: canonicalHash(receipt),controlHash:canonicalHash(controlCapsule), sourceSequence,
      predecessorHash, membershipEpoch: membership.epoch, leaseEpoch, writerId: machines[machineIndex].machineId, sourceBundleHash: canonicalHash(bundle) };
    return { packet,controlCapsule, packetSignature: signGraphRecord(D.packet, packet, machines[machineIndex].signing.privateKey), encryptedSourceBundle: bundle, ...actuation };
  }
  function receipt(packet: GraphOperationPacket, machineIndex: number, phase: GraphMemberReceipt['phase'] = 'source', certificateHash?: string): GraphMemberReceipt {
    const body = { agentId: packet.agentId, eventId: packet.eventId, operationHash: canonicalHash(packet), membershipEpoch: packet.membershipEpoch,
      leaseEpoch: packet.leaseEpoch, machineId: machines[machineIndex].machineId, phase, ...(certificateHash ? { certificateHash } : {}), persistedAt: '2026-11-05T09:30:00Z' };
    return { ...body, signature: signGraphRecord(D.memberReceipt, body, machines[machineIndex].signing.privateKey) };
  }
  function open() { const service = new GraphWitnessService(options); service.registerMembership(membership); return service; }
  const actionSignature = (action: 'cancel' | 'erase', fields: Record<string, unknown>, lease: GraphWitnessLease) => signGraphRecord(D.action, witnessActionPayload(action, fields, lease), machines.find((m) => m.machineId === lease.writerId)!.signing.privateKey);
  return { options, open, owner, witness, machines, membership, leaseFor, prepareRequest, receipt, actionSignature };
}
