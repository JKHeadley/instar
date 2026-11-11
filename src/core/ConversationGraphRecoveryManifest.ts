import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
import {canonicalHash,verifyMemberReceipt,type GraphMembershipEpoch,type GraphRecoverySourceManifest} from './GraphWitnessTypes.js';
export function graphRecoverySourceManifestEntry(record:ConversationGraphReplicationRecord):GraphRecoverySourceManifest['entries'][number]{
 return {
    eventId:record.packet.eventId,idempotencyKey:record.packet.idempotencyKey,sourceSequence:record.packet.sourceSequence,
      operationHash:canonicalHash(record.packet),coreHash:record.packet.coreHash,authorizationReceiptHash:record.packet.authorizationReceiptHash,
      sourceBundleHash:record.packet.sourceBundleHash,prepareProofHash:record.preparationProof?canonicalHash(record.preparationProof):null,erasedControlProofHash:record.erasedControlProof?canonicalHash(record.erasedControlProof):null,
      certificateHash:record.certificate?canonicalHash(record.certificate):null,cancellationHash:record.cancellation?canonicalHash(record.cancellation):null,
      cancellationCertificateHash:record.cancellationCertificate?canonicalHash(record.cancellationCertificate):null,
      adoptionHash:record.adoption?canonicalHash(record.adoption):null,rewrapHash:record.rewrap?canonicalHash(record.rewrap):null,
      erasureHash:record.erasure?canonicalHash(record.erasure):null,
      certificatePersistenceHash:canonicalHash([...(record.certificatePersistenceReceipts??[])].sort((a,b)=>a.machineId.localeCompare(b.machineId))),
 };
}

/** Metadata-only incremental manifest accumulator; source authority is checked
 * separately by the actual verifier before producing any receipt. */
export class GraphRecoverySourceManifestAccumulator {
  private readonly ids = new Set<string>();private readonly sequences = new Set<number>();private readonly entries:GraphRecoverySourceManifest['entries']=[];private lastSequence=0;
  private highestCertifiedSequence=0;private highestCertifiedCoreHash:string|null=null;
  private highestAcknowledgedSequence=0;private highestAcknowledgedCoreHash:string|null=null;
  constructor(private readonly membership:GraphMembershipEpoch,private readonly collectEntries=true){}
  append(record:ConversationGraphReplicationRecord):GraphRecoverySourceManifest['entries'][number]{
    if(record.packet.sourceSequence<=this.lastSequence||this.ids.size>=20000)throw new Error('graph-transfer-ambiguous-source-chain');this.lastSequence=record.packet.sourceSequence;
    if(this.ids.has(record.packet.eventId)||this.sequences.has(record.packet.sourceSequence)) throw new Error('graph-transfer-ambiguous-source-chain');
    this.ids.add(record.packet.eventId);this.sequences.add(record.packet.sourceSequence);
    const terminal=record.certificate??record.cancellationCertificate;
    if (terminal) {
    if(record.packet.sourceSequence!==this.highestCertifiedSequence+1||record.packet.predecessorHash!==this.highestCertifiedCoreHash) throw new Error('graph-transfer-incomplete-certified-chain');
    this.highestCertifiedSequence=record.packet.sourceSequence;this.highestCertifiedCoreHash=record.packet.coreHash;
    const effective=record.adoption?.newMembership??record.authorizationProof.membership;
    const context=record.adoption?{membershipEpoch:effective.epoch,leaseEpoch:record.adoption.currentLease.leaseEpoch}:undefined;
    if(record.packet.sourceSequence===this.highestAcknowledgedSequence+1 && record.packet.predecessorHash===this.highestAcknowledgedCoreHash
      &&effective.members.every(member=>(record.certificatePersistenceReceipts??[]).some(receipt=>receipt.machineId===member.machineId
        &&verifyMemberReceipt(receipt,record.packet,effective,'certificate',canonicalHash(terminal),context)))) {
      this.highestAcknowledgedSequence=record.packet.sourceSequence;this.highestAcknowledgedCoreHash=record.packet.coreHash;
    }
    }
    const entry=graphRecoverySourceManifestEntry(record);if(this.collectEntries)this.entries.push(entry);return entry;
  }
  finish():GraphRecoverySourceManifest{return{v:1,agentId:this.membership.agentId,membershipHash:canonicalHash(this.membership),highestCertifiedSequence:this.highestCertifiedSequence,highestCertifiedCoreHash:this.highestCertifiedCoreHash,highestAcknowledgedSequence:this.highestAcknowledgedSequence,highestAcknowledgedCoreHash:this.highestAcknowledgedCoreHash,entries:[...this.entries]};}
}
export function buildGraphRecoverySourceManifest(records:ConversationGraphReplicationRecord[],membership:GraphMembershipEpoch):GraphRecoverySourceManifest{const accumulator=new GraphRecoverySourceManifestAccumulator(membership);for(const record of [...records].sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence||a.packet.eventId.localeCompare(b.packet.eventId)))accumulator.append(record);return accumulator.finish();}
