import {graphCompleteDeliveryFacts} from './ConversationGraphDeliveryProof.js';
import {GRAPH_REPLICATION_MAX_LEASE_EPOCH,graphReplicationPublicationVersion,validGraphReplicationPublicationVersion,GRAPH_REPLICATION_NEGATIVE_RANK_BASE,GRAPH_REPLICATION_EPOCH_STRIDE} from './ConversationGraphReplicationLimits.js';
import {graphHistoricalMaterializationRef} from './ConversationGraphHistoricalMaterialization.js';
/** Immutable journal transport contains opaque hashes only. Source ciphertext,
 * sealed envelopes and rewrap inventory belong to erasable authenticated repair.
 * Metadata alone never proves that a member durably holds the original source. */
import {canonicalHash,exactFields,hash,opaque,positive,type GraphCoreType,validGraphOperationKey} from './GraphWitnessTypes.js';
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
export interface ConversationGraphReplicationDescriptor {
 v:1;coreType:GraphCoreType;agentId:string;eventId:string;origin:string;sourceSequence:number;predecessorHash:string|null;
 packetHash:string;coreHash:string;authorizationReceiptHash:string;sourceBundleHash:string;controlHash:string;publicationVersion:number;
 preparationProofHash:string|null;erasedControlProofHash:string|null;certificateHash:string|null;cancellationHash:string|null;cancellationCertificateHash:string|null;
 adoptionHash:string|null;rewrapHash:string|null;erasureHash:string|null;certificatePersistenceHash:string;commitProofDeliveryHash:string;
}
export function describeGraphReplicationRecord(record:ConversationGraphReplicationRecord):ConversationGraphReplicationDescriptor {
 const {encryptedSourceBundle:_bundle,rewrap:_rewrap,erasure:_erasure,certificatePersistenceReceipts:_persistence,commitProofDeliveryReceipts:_deliveries,custodyMembership:_custodyMembership,custodyActivations:_custodyActivations,...remaining}=record;
 const erasure=record.erasure?{agentId:record.packet.agentId,eventId:record.packet.eventId,sourceBundleHash:record.packet.sourceBundleHash,erased:true}:undefined;
 // A and B may hold different legitimate partial receipt subsets. Those
 // private repair facts are not divergent canonical publications. Source's
 // cryptographic verifier still checks every receipt before this descriptor.
 const receipts=[...(record.certificatePersistenceReceipts??[])].sort((a,b)=>a.machineId.localeCompare(b.machineId)),members=record.adoption?.newMembership.members??record.authorizationProof.membership.members;
 const complete=receipts.length===members.length&&new Set(receipts.map(receipt=>receipt.machineId)).size===receipts.length&&members.every(member=>receipts.some(receipt=>receipt.machineId===member.machineId));
 const durability=record.materialization?record.materialization.activation.stateTransferReceipts:complete?receipts:[];
 // Original-epoch custody role is already locked in the immutable auth proof.
 // Extra issuer epochs require the entire validated activation chain, never a subset.
 const extraCustody=record.erasedControlProof&&record.erasedControlProof.custodyMembershipEpoch!==record.authorizationProof.membership.epoch
  ?{custodyMembership:record.custodyMembership,custodyActivations:record.custodyActivations}:{};
 const deliveryFacts=graphCompleteDeliveryFacts(record);
 const control={...remaining,...extraCustody,...(record.materialization?{materialization:graphHistoricalMaterializationRef(record.materialization)}:{}),certificatePersistenceReceipts:durability,commitProofDeliveryReceipts:deliveryFacts,...(erasure?{erasure}:{})};
 const epoch=record.materialization?.currentLease.leaseEpoch??record.adoption?.currentLease.leaseEpoch??record.packet.leaseEpoch;
 const terminal=record.certificate??record.cancellationCertificate;
 const count=record.materialization?record.materialization.activation.newMembership.members.length:durability.length;
 if(!Number.isSafeInteger(epoch)||epoch<1||epoch>GRAPH_REPLICATION_MAX_LEASE_EPOCH||!Number.isInteger(count)||count<0||count>64)throw new Error('graph-replication-publication-capacity');
 // Before a terminal certificate every independently arriving proof gets a
 // low phase bit. Afterwards cancellation is already bound by that immutable
 // certificate; custody/adoption/materialization remain independently deliverable.
 const custody=!!(record.preparationProof||record.erasedControlProof);
 const stage=terminal?16+count*8+(deliveryFacts.length?256:0)+(record.adoption?1:0)+(record.materialization?2:0)+(custody?4:0)
  :(custody?1:0)+(record.adoption?2:0)+(record.cancellation?4:0);
 if(stage>=GRAPH_REPLICATION_EPOCH_STRIDE)throw new Error('graph-replication-publication-stage-overflow');
 const membershipEpoch=Math.max(record.packet.membershipEpoch,record.adoption?.newMembership.epoch??0,record.materialization?.activation.newMembership.epoch??0,record.erasedControlProof?.custodyMembershipEpoch??0,record.erasure?.membershipEpoch??0);
 const publicationVersion=graphReplicationPublicationVersion(membershipEpoch,epoch,stage,!!record.erasure);
 if(!Number.isSafeInteger(publicationVersion))throw new Error('graph-replication-publication-version-overflow');
 const digest=(value:unknown)=>value===undefined?null:canonicalHash(value);
 return {v:1,coreType:record.coreType,agentId:record.packet.agentId,eventId:record.packet.eventId,origin:record.packet.writerId,sourceSequence:record.packet.sourceSequence,
  predecessorHash:record.packet.predecessorHash,packetHash:canonicalHash(record.packet),coreHash:record.packet.coreHash,authorizationReceiptHash:record.packet.authorizationReceiptHash,
  sourceBundleHash:record.packet.sourceBundleHash,controlHash:canonicalHash(control),publicationVersion,
  preparationProofHash:digest(record.preparationProof),erasedControlProofHash:digest(record.erasedControlProof),certificateHash:digest(record.certificate),cancellationHash:digest(record.cancellation),
  cancellationCertificateHash:digest(record.cancellationCertificate),adoptionHash:digest(record.adoption),rewrapHash:digest(record.rewrap),erasureHash:digest(erasure),
  certificatePersistenceHash:canonicalHash(durability),commitProofDeliveryHash:canonicalHash(deliveryFacts)};
}
export function validateGraphReplicationDescriptor(raw:unknown):ConversationGraphReplicationDescriptor|null {
 try{const value=raw as ConversationGraphReplicationDescriptor;
  if(!exactFields(value,['v','coreType','agentId','eventId','origin','sourceSequence','predecessorHash','packetHash','coreHash','authorizationReceiptHash','sourceBundleHash','controlHash','publicationVersion',
    'preparationProofHash','erasedControlProofHash','certificateHash','cancellationHash','cancellationCertificateHash','adoptionHash','rewrapHash','erasureHash','certificatePersistenceHash','commitProofDeliveryHash'])
   ||value.v!==1||![value.agentId,value.origin].every(opaque)||!validGraphOperationKey(value.coreType,value.eventId)||!positive(value.sourceSequence)||!validGraphReplicationPublicationVersion(value.publicationVersion)
   ||![value.packetHash,value.coreHash,value.authorizationReceiptHash,value.sourceBundleHash,value.controlHash,value.certificatePersistenceHash,value.commitProofDeliveryHash].every(hash))return null;
  for(const field of [value.predecessorHash,value.preparationProofHash,value.erasedControlProofHash,value.certificateHash,value.cancellationHash,value.cancellationCertificateHash,value.adoptionHash,value.rewrapHash,value.erasureHash])if(field!==null&&!hash(field))return null;
  if((value.publicationVersion>=GRAPH_REPLICATION_NEGATIVE_RANK_BASE)!==(value.erasureHash!==null))return null;
  return value;
 }catch{/* @silent-fallback-ok: malformed metadata descriptor is rejected, never interpreted as an empty canonical source. */return null;}
}
