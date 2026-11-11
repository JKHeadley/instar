/** Cancellation-only custody after explicit permanent loss. Absence of a Saved
 * proof is never repaired by inventing a witness preparation or Source ACK. */
import type crypto from 'node:crypto';
import {verifyGraphControlCapsule,type GraphControlCapsule} from './GraphWitnessControl.js';
import {canonicalHash,validatePacket,verifyGraphRecord,verifyMembershipEpoch,verifyAdoptionCertificate,verifyWitnessCancellation,GRAPH_SIGNATURE_DOMAINS as D,type GraphMembershipEpoch,type GraphOperationPacket,type GraphAdoptionCertificate,type GraphWitnessCancellation,type GraphWitnessPrepareProof,type GraphWitnessErasedControlProof,type GraphCommitCertificate} from './GraphWitnessTypes.js';
export interface GraphMemberLossNegativeCustody {
 packet:GraphOperationPacket;packetSignature:string;controlCapsule:GraphControlCapsule;
 prepareProof:GraphWitnessPrepareProof|null;erasedControlProof:GraphWitnessErasedControlProof|null;
 certificate:GraphCommitCertificate|null;adoption:GraphAdoptionCertificate|null;cancellation:GraphWitnessCancellation|null;
}
/** The caller must independently pin the original roster/root and ACT issuer.
 * This predicate authorizes ONLY phase:cancellation, never Source or commit. */
export function verifyGraphMemberLossNegativeCustody(value:GraphMemberLossNegativeCustody,originalMembership:GraphMembershipEpoch,ownerPublicKey:crypto.KeyLike,witnessPublicKey:crypto.KeyLike):boolean{
 try{
  if(value.prepareProof!==null||value.erasedControlProof!==null||value.certificate!==null||!value.adoption||!value.cancellation||!validatePacket(value.packet)||!verifyMembershipEpoch(originalMembership,ownerPublicKey)||originalMembership.epoch!==value.packet.membershipEpoch||originalMembership.agentId!==value.packet.agentId)return false;
  const writer=originalMembership.members.find(row=>row.machineId===value.packet.writerId),adoption=value.adoption,activation=adoption.activation,loss=activation?.memberLoss;
  if(!writer||!verifyGraphRecord(D.packet,value.packet,value.packetSignature,writer.signingPublicKey)||!verifyGraphControlCapsule(value.controlCapsule,value.packet,ownerPublicKey)||!activation||!loss||loss.consent.payload.pendingDisposition!=='refuse-all-uncommitted'||!verifyAdoptionCertificate(adoption,value.packet,originalMembership,ownerPublicKey,witnessPublicKey)||adoption.disposition!=='refused'||adoption.revalidation.decision!=='refuse'||adoption.revalidation.reason!=='operator-refused'||adoption.rewrapHash!==canonicalHash(null)||adoption.erasedControlHash!==undefined)return false;
  const admitted=loss.consent.payload.operations.find(row=>row.eventId===value.packet.eventId);
  return !!admitted&&admitted.outcome==='pending'&&admitted.terminalHash===null&&admitted.operationHash===canonicalHash(value.packet)&&admitted.coreHash===value.packet.coreHash&&admitted.sourceSequence===value.packet.sourceSequence&&admitted.predecessorHash===value.packet.predecessorHash&&value.cancellation.witnessId===adoption.witnessId&&Date.parse(value.cancellation.canceledAt)>=Date.parse(activation.activatedAt)&&verifyWitnessCancellation(value.cancellation,value.packet,witnessPublicKey,{membershipEpoch:adoption.newMembership.epoch,leaseEpoch:adoption.currentLease.leaseEpoch});
 }catch{/* @silent-fallback-ok: missing or mismatched explicit loss/negative authority is refused, never replaced by Saved custody. */return false;}
}
