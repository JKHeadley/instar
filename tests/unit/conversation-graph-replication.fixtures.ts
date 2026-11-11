import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import crypto from 'node:crypto';
import { FencedLease } from '../../src/core/FencedLease.js';
import { sign as signMachine } from '../../src/core/MachineIdentity.js';
import { sealGraphBundle, rewrapGraphBundle } from '../../src/core/GraphWitnessCrypto.js';
import { canonicalHash,graphOperationKey, GRAPH_SIGNATURE_DOMAINS, signGraphRecord, type GraphCommitCertificate,
  type GraphMembershipEpoch, type GraphMemberReceipt, type GraphWitnessLease, type GraphAdoptionCertificate } from '../../src/core/GraphWitnessTypes.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import { signGraphAuthorizationReceipt } from '../../src/core/ConversationGraphReplicationProof.js';
import type { ConversationGraphReplicationOptions, ConversationGraphReplicationRecord, GraphLiveAdmission } from '../../src/core/ConversationGraphReplication.js';
import {validateGraphOperationCore,deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import { WriteAdmission } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';

export function replicationFixture(material?: Array<{machineId:string;signing:{publicKey:crypto.KeyObject;privateKey:crypto.KeyObject};sealing:{publicKey:crypto.KeyObject;privateKey:crypto.KeyObject}}>, timeBase = Date.parse('2026-11-05T08:00:00Z')) {
  const at=(minute:number)=>new Date(timeBase+minute*60000).toISOString();
  const owner = crypto.generateKeyPairSync('ed25519');
  const witness = crypto.generateKeyPairSync('ed25519');
  const members = material ?? ['writer', 'sleeper'].map((machineId) => ({ machineId,
    signing: crypto.generateKeyPairSync('ed25519'), sealing: crypto.generateKeyPairSync('x25519') }));
  const writerId=members[0].machineId; const sleeperId=members[1].machineId;
  const membershipUnsigned = { v: 1 as const, agentId: 'echo', epoch: 1, previousMembershipHash: null,
    members: members.map((m) => ({ machineId: m.machineId,
      signingPublicKey: m.signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sealingPublicKey: m.sealing.publicKey.export({ type: 'spki', format: 'pem' }).toString() })),
    writerId: writerId, witnessId: 'independent-witness', failureDomain: 'managed-external', createdAt: at(0) };
  const membership: GraphMembershipEpoch = { ...membershipUnsigned,
    signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membership, membershipUnsigned, owner.privateKey) };
  const originalUnsigned = { holder: writerId, epoch: 1, acquiredAt: at(0), expiresAt: at(30), nonce: 1 };
  const originalLease = { ...originalUnsigned, signature: signMachine(FencedLease.canonicalize(originalUnsigned), members[0].signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()) };
  const bridgeUnsigned = { v: 1 as const, agentId: 'echo', membershipEpoch: 1, leaseEpoch: 1, writerId: writerId,
    issuedAt: originalLease.acquiredAt, expiresAt: originalLease.expiresAt, fencedLeaseHash: canonicalHash(originalLease) };
  const lease: GraphWitnessLease = { ...bridgeUnsigned, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.lease, bridgeUnsigned, members[0].signing.privateKey) };
  let live: GraphLiveAdmission = { admitted: true, writerId: writerId, leaseEpoch: 1, membershipEpoch: 1, fencedLeaseHash: canonicalHash(originalLease) };
  function record(eventId = 'event-one', sourceSequence = 1, predecessorHash: string | null = null): ConversationGraphReplicationRecord {
    const core = { schemaVersion: 1, eventId, op: 'set-primary-placement', principal: 'owner', authority: 'owner',
      subject: { kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId: 42 }, parent: null,
      relation: null, replacesPlacementEventIds: [], receipt: { kind: 'owner-proof', id: `receipt-${eventId}` },
      machineId: writerId, createdAt: at(5) };
    const receipt = signGraphAuthorizationReceipt({ v: 1, agentId: 'echo', eventId:graphOperationKey('graph-event',eventId), coreHash: canonicalHash(core), actorPrincipal: 'owner',
      authenticationMethod: 'owner-device', membershipEpoch: 1, leaseEpoch: 1, idempotencyKey: `idempotency-${eventId}`,
      receiptId: core.receipt.id,
      writerId: writerId, fencedLeaseHash: canonicalHash(originalLease), acceptedAt: at(5) }, members[0].signing.privateKey);
    const authorizationProof={receipt,membership,lease,originalLease};
    const plaintext=encodeGraphSourceEnvelope('graph-event',core,authorizationProof,Buffer.from('private original source'));
    const encryptedSourceBundle = sealGraphBundle(plaintext, membership.members, { agentId: 'echo', eventId:graphOperationKey('graph-event',eventId) });
    plaintext.fill(0);
    const packet = {coreType:'graph-event' as const,controlHash:canonicalHash(createGraphControlCapsule('graph-event',core,authorizationProof)),erasureIdentity:deriveGraphErasureIdentity('graph-event',core), agentId: 'echo', eventId:graphOperationKey('graph-event',eventId), idempotencyKey: receipt.idempotencyKey, coreHash: canonicalHash(core),
      authorizationReceiptHash: canonicalHash(receipt), sourceSequence, predecessorHash,
      membershipEpoch: 1, leaseEpoch: 1, writerId: writerId, sourceBundleHash: canonicalHash(encryptedSourceBundle) };
    return {coreType:'graph-event', packet, packetSignature: signGraphRecord('graph-operation-packet-v1', packet, members[0].signing.privateKey),
      core, authorizationProof, encryptedSourceBundle };
  }
  function options(directory: string, machineId = writerId): ConversationGraphReplicationOptions {
    const member = members.find((m) => m.machineId === machineId)!;
    return { installedMembership:membership,directory, agentId: 'echo', machineId, memberPrivateKey: member.signing.privateKey,
      memberSealingPrivateKey: member.sealing.privateKey, ownerPublicKey: owner.publicKey,
      witnessPublicKeys: new Map([['independent-witness', witness.publicKey]]), liveAdmission: () => live,
      writeAdmission: new WriteAdmission({ thisMachineId: machineId, isReadOnly: () => !live.admitted,
        isPoolActive: () => true, registry: buildWriteDomainRegistry({ machineId }), dryRun: true, disableTimers: true }),
      legacyReadOnly: () => !live.admitted,
      validateCore:(value,coreType)=>validateGraphOperationCore(coreType,value)!==null, now: () => new Date(at(6)) };
  }
  function actuation(holderId = writerId, epoch = 1, nonce = 2) {
    const m = members.find((member) => member.machineId === holderId)!;
    const raw = {holder: holderId, epoch, acquiredAt: at(6), expiresAt: at(36), nonce};
    const native = {...raw, signature: signMachine(FencedLease.canonicalize(raw), m.signing.privateKey.export({type:'pkcs8',format:'pem'}).toString())};
    const bridge = {v:1 as const,agentId:'echo',membershipEpoch:1,leaseEpoch:epoch,writerId:holderId,issuedAt:native.acquiredAt,expiresAt:native.expiresAt,fencedLeaseHash:canonicalHash(native)};
    return {originalLease:native,lease:{...bridge,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.lease,bridge,m.signing.privateKey)}};
  }
  function adopted(record: ConversationGraphReplicationRecord, refused = false, epoch=2): ConversationGraphReplicationRecord {
    const current = actuation(sleeperId, epoch); const currentWriter = members[1];
    const rewrap = refused ? null : rewrapGraphBundle(record.encryptedSourceBundle!, sleeperId, currentWriter.sealing.privateKey,
      membership, sleeperId, currentWriter.signing.privateKey, {agentId:'echo',eventId:record.packet.eventId}, at(7));
    const {packet,packetSignature,core,authorizationProof} = record;
    const proof = {v:1 as const,agentId:'echo',idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),coreHash:packet.coreHash,
      sourceProofHash:canonicalHash({coreType:record.coreType,packet,packetSignature,core,authorizationProof}),subjectHeadsHash:canonicalHash([]),dependenciesHash:canonicalHash([]),
      rewrapHash:canonicalHash(rewrap),newMembershipHash:canonicalHash(membership),currentLeaseHash:canonicalHash(current.lease),writerId:sleeperId,
      decision: refused ? 'refuse' as const : 'adopt' as const,reason: refused ? 'erased-source' as const : 'ok' as const,validatedAt:at(7)};
    const raw = {v:1 as const,agentId:'echo',idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),originalMembershipHash:canonicalHash(membership),
      newMembership:membership,currentLease:current.lease,originalCurrentLease:current.originalLease,ownerAuthorization:null,
      revalidation:{...proof,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.revalidation,proof,currentWriter.signing.privateKey)},rewrapHash:canonicalHash(rewrap),
      membershipChain:[membership],disposition:refused ? 'refused' as const : 'adopted' as const,witnessId:'independent-witness',adoptedAt:at(7)};
    const adoption: GraphAdoptionCertificate = {...raw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.adoption,raw,witness.privateKey)};
    const result = {...structuredClone(record),adoption,...(rewrap?{rewrap}: {})};
    if (refused) {
      result.encryptedSourceBundle = null;
      const cancellation = {v:1 as const,agentId:'echo',eventId:packet.eventId,operationHash:canonicalHash(packet),membershipEpoch:1,leaseEpoch:epoch,witnessId:'independent-witness',canceledAt:'2026-11-05T08:08:00Z'};
      result.cancellation = {...cancellation,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.cancellation,cancellation,witness.privateKey)};
    }
    return result;
  }
  function certificate(record: ConversationGraphReplicationRecord, receipts: GraphMemberReceipt[]): GraphCommitCertificate {
    const p = record.packet;
    const unsigned = { v: 1 as const, agentId: p.agentId, eventId: p.eventId, operationHash: canonicalHash(p), coreHash: p.coreHash,
      authorizationReceiptHash: p.authorizationReceiptHash, sourceSequence: p.sourceSequence, predecessorHash: p.predecessorHash,
      membershipEpoch: record.adoption?.newMembership.epoch ?? p.membershipEpoch, leaseEpoch: record.adoption?.currentLease.leaseEpoch ?? p.leaseEpoch, membershipHash: canonicalHash(record.adoption?.newMembership ?? membership), memberReceipts: receipts,
      ...(record.adoption ? {adoption: record.adoption} : {}),
      witnessId: membership.witnessId, committedAt: at(7) };
    return { ...unsigned, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.certificate, unsigned, witness.privateKey) };
  }
  function erasureAuthority(proof:import('../../src/core/GraphWitnessTypes.js').GraphWitnessErasure):import('../../src/core/GraphErasureProtocol.js').GraphErasureAuthority{
    const endorsement={v:1 as const,agentId:'echo',requestId:proof.requestId,erasureHash:canonicalHash(proof),membershipEpoch:1,membershipHash:canonicalHash(membership),activationHash:null,witnessId:membership.witnessId,challenge:crypto.randomBytes(32).toString('base64url'),recordedAt:at(20)};
    return {membership,activations:[],endorsement:{...endorsement,signature:signGraphRecord('graph-erasure-active-endorsement-v1',endorsement,witness.privateKey)}};
  }
  return { owner, witness, members, membership, originalLease, lease, record, options, certificate, erasureAuthority,
    actuation, adopted, setLive: (next: GraphLiveAdmission) => { live = next; }, getLive: () => live };
}
