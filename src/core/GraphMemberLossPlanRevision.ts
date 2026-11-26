/** A new, explicitly signed negative-only plan. This never changes the original
 * creation, source packet, consent, role key or transfer namespace. It is not
 * human admission or native administration; those remain actual capabilities. */
import type {GraphTransferStageMetadata} from './ConversationGraphReplicationTransfer.js';
import {verifyGraphOwnerMemberLossConsent,type GraphOwnerMemberLossConsent,type GraphOwnerMemberLossContext} from './GraphOwnerMemberLoss.js';
import {canonicalHash,exactFields,hash,iso,unsigned,validateGraphErasureIdentity,type GraphErasureIdentity,verifyGraphRecord,verifyRecoveryAuthorization,validateRecoverySourceManifest,verifyFencedLeaseBridge,GRAPH_SIGNATURE_DOMAINS as D} from './GraphWitnessTypes.js';
export const GRAPH_MEMBER_LOSS_PLAN_REVISION_DOMAIN='graph-owned-member-loss-plan-revision-v1';
export const GRAPH_MEMBER_LOSS_REVISION_ACTIVATION_DOMAIN='graph-owned-member-loss-revision-activation-v1';
export interface GraphMemberLossPlanRevision {
 v:1;kind:'owned-member-loss-plan-revision';agentId:string;intentHash:string;consentHash:string;
 originalCreationHash:string;generation:number;supersedesHash:string|null;
 originalPlan:GraphTransferStageMetadata;plan:GraphTransferStageMetadata;
 inventoryHash:string;erasureInventoryHash:string;ownerRecoveryHash:string;negativeFacts:GraphMemberLossRevisionNegativeFacts;issuedAt:string;signature:string;
}
export interface GraphMemberLossRevisionNegativeFacts {erasureHashes:string[];localTargets:GraphErasureIdentity[]}
/** Public negative inventory is a containment commitment, never an erasure proof. */
export function validGraphMemberLossRevisionNegativeFacts(value:GraphMemberLossRevisionNegativeFacts):boolean{
 if(!exactFields(value,['erasureHashes','localTargets'])||!Array.isArray(value.erasureHashes)||!Array.isArray(value.localTargets)||value.erasureHashes.length>20000||value.localTargets.length>20000)return false;
 const ordered=(values:string[])=>values.every((item,index)=>index===0||values[index-1]<item);
 return value.erasureHashes.every(hash)&&value.localTargets.every(validateGraphErasureIdentity)&&ordered(value.erasureHashes)&&ordered(value.localTargets.map(target=>canonicalHash(target)));
}
export function graphMemberLossRevisionPreservesNegativeFacts(previous:GraphMemberLossRevisionNegativeFacts,next:GraphMemberLossRevisionNegativeFacts):boolean{
 if(!validGraphMemberLossRevisionNegativeFacts(previous)||!validGraphMemberLossRevisionNegativeFacts(next))return false;
 const proofs=new Set(next.erasureHashes),targets=new Set(next.localTargets.map(target=>canonicalHash(target)));
 return previous.erasureHashes.every(proof=>proofs.has(proof))&&previous.localTargets.every(target=>targets.has(canonicalHash(target)));
}
export function graphMemberLossRevisionRecoveryId(value:Pick<GraphMemberLossPlanRevision,'consentHash'|'originalCreationHash'|'generation'|'inventoryHash'|'erasureInventoryHash'>&{leaseHash:string}):string{return 'lossr_'+canonicalHash(value);}
function validPlan(plan:GraphTransferStageMetadata,context:Pick<GraphOwnerMemberLossContext,'ownerPublicKey'|'previousMembership'|'newMembership'>):boolean{
 const old=context.previousMembership,next=context.newMembership;
 if(!exactFields(plan,['authorization','previousMembership','newMembership','currentLease','originalCurrentLease','manifest','revalidations'])||canonicalHash(plan.previousMembership)!==canonicalHash(old)||canonicalHash(plan.newMembership)!==canonicalHash(next)||!verifyRecoveryAuthorization(plan.authorization,old,next,context.ownerPublicKey)||!validateRecoverySourceManifest(plan.manifest)||plan.manifest.agentId!==old.agentId||plan.manifest.membershipHash!==canonicalHash(old)||canonicalHash(plan.manifest)!==plan.authorization.sourceManifestHash||!verifyFencedLeaseBridge(plan.currentLease,plan.originalCurrentLease,next)||plan.authorization.fenceEpoch!==plan.currentLease.leaseEpoch||!Array.isArray(plan.revalidations)||plan.revalidations.length>512||plan.revalidations.length!==plan.authorization.pendingOutcomes.length)return false;
 const ids=new Set<string>(),member=next.members.find(row=>row.machineId===plan.currentLease.writerId);if(!member)return false;
 for(const proof of plan.revalidations){const outcome=plan.authorization.pendingOutcomes.find(row=>row.idempotencyKey===proof.idempotencyKey),entry=plan.manifest.entries.find(row=>row.idempotencyKey===proof.idempotencyKey);if(!exactFields(proof,['v','agentId','idempotencyKey','operationHash','coreHash','sourceProofHash','subjectHeadsHash','dependenciesHash','rewrapHash','newMembershipHash','currentLeaseHash','writerId','decision','reason','validatedAt','signature'])||proof.v!==1||proof.agentId!==old.agentId||![proof.sourceProofHash,proof.subjectHeadsHash,proof.dependenciesHash].every(hash)||!iso(proof.validatedAt)||ids.has(proof.idempotencyKey)||!outcome||!entry||outcome.decision!=='refuse'||proof.decision!=='refuse'||proof.reason!=='operator-refused'||proof.rewrapHash!==canonicalHash(null)||proof.writerId!==member.machineId||proof.newMembershipHash!==canonicalHash(next)||proof.currentLeaseHash!==canonicalHash(plan.currentLease)||proof.operationHash!==entry.operationHash||proof.coreHash!==entry.coreHash||outcome.operationHash!==entry.operationHash||outcome.revalidationHash!==canonicalHash(proof)||!verifyGraphRecord(D.revalidation,unsigned(proof),proof.signature,member.signingPublicKey))return false;ids.add(proof.idempotencyKey);}
 return true;
}
/** Public metadata census only. This does not establish current authority,
 * human admission, Native revocation, physical import or an erasure decision. */
export function verifyGraphMemberLossPublicPlan(raw:unknown,actualOwnerPublicKey:import('node:crypto').KeyLike):raw is GraphTransferStageMetadata{
 try{const plan=raw as GraphTransferStageMetadata;return validPlan(plan,{ownerPublicKey:actualOwnerPublicKey,previousMembership:plan.previousMembership,newMembership:plan.newMembership});}catch{/* @silent-fallback-ok: unknown/private-bearing plan documents are census debt, never presumed public. */return false;}
}
/** Only compares public immutable facts. Real Source/cancellation/erasure proof
 * verification is additionally mandatory at witness import and ACT validation. */
export function verifyGraphMemberLossPlanRevision(value:GraphMemberLossPlanRevision,consent:GraphOwnerMemberLossConsent,intentHash:string,context:GraphOwnerMemberLossContext):boolean{
 try{
  if(!exactFields(value,['v','kind','agentId','intentHash','consentHash','originalCreationHash','generation','supersedesHash','originalPlan','plan','inventoryHash','erasureInventoryHash','ownerRecoveryHash','negativeFacts','issuedAt','signature'])||value.v!==1||value.kind!=='owned-member-loss-plan-revision'||value.agentId!==context.previousMembership.agentId||value.intentHash!==intentHash||value.consentHash!==canonicalHash(consent)||![value.intentHash,value.consentHash,value.originalCreationHash,value.inventoryHash,value.erasureInventoryHash,value.ownerRecoveryHash].every(hash)||!Number.isSafeInteger(value.generation)||value.generation<1||(value.generation===1?value.supersedesHash!==null:!hash(value.supersedesHash))||!validGraphMemberLossRevisionNegativeFacts(value.negativeFacts)||!iso(value.issuedAt)||!verifyGraphOwnerMemberLossConsent(consent,context)||!validPlan(value.originalPlan,context)||!validPlan(value.plan,context)||!verifyGraphRecord(GRAPH_MEMBER_LOSS_PLAN_REVISION_DOMAIN,unsigned(value),value.signature,context.ownerPublicKey))return false;
  const p=value.plan,o=value.originalPlan,cut=consent.payload.operations;
  if(o.authorization.recoveryId!=='loss-'+value.consentHash||p.authorization.recoveryId!==graphMemberLossRevisionRecoveryId({consentHash:value.consentHash,originalCreationHash:value.originalCreationHash,generation:value.generation,inventoryHash:value.inventoryHash,erasureInventoryHash:value.erasureInventoryHash,leaseHash:canonicalHash(p.currentLease)})||p.currentLease.leaseEpoch<o.currentLease.leaseEpoch||p.currentLease.writerId!==o.currentLease.writerId||p.manifest.entries.length!==cut.length||o.manifest.entries.length!==cut.length||p.manifest.highestCertifiedSequence<o.manifest.highestCertifiedSequence||p.manifest.highestAcknowledgedSequence<o.manifest.highestAcknowledgedSequence)return false;
  const originals=new Map(o.manifest.entries.map(row=>[row.eventId,row])),current=new Map(p.manifest.entries.map(row=>[row.eventId,row]));if(originals.size!==cut.length||current.size!==cut.length)return false;
  for(const operation of cut){const before=originals.get(operation.eventId),after=current.get(operation.eventId);if(!before||!after||before.operationHash!==operation.operationHash||after.operationHash!==operation.operationHash||before.coreHash!==operation.coreHash||after.coreHash!==operation.coreHash||before.sourceSequence!==operation.sourceSequence||after.sourceSequence!==operation.sourceSequence)return false;
   for(const key of ['eventId','idempotencyKey','sourceSequence','operationHash','coreHash','authorizationReceiptHash','sourceBundleHash','prepareProofHash','certificateHash'] as const)if(before[key]!==after[key])return false;
   if(operation.outcome==='committed'){if(before.certificateHash!==operation.terminalHash||after.certificateHash!==operation.terminalHash||before.cancellationHash!==after.cancellationHash||before.cancellationCertificateHash!==after.cancellationCertificateHash||before.adoptionHash!==after.adoptionHash)return false;}
   else if(operation.outcome!=='pending'){if(before.certificateHash!==null||after.certificateHash!==null||before.cancellationCertificateHash!==operation.terminalHash||after.cancellationCertificateHash!==operation.terminalHash)return false;}
   else if(before.certificateHash!==null||after.certificateHash!==null||before.cancellationCertificateHash!==null&&after.cancellationCertificateHash!==before.cancellationCertificateHash)return false;
   // Key loss may only accompany a real negative fact. These hashes alone are
   // never accepted as that fact by the witness importer.
   if(before.rewrapHash!==after.rewrapHash&&(after.rewrapHash!==null||after.erasureHash===null))return false;
   if((before.erasedControlProofHash!==after.erasedControlProofHash||before.cancellationHash!==after.cancellationHash||before.adoptionHash!==after.adoptionHash)&&after.erasureHash===null&&after.cancellationCertificateHash===null)return false;
   if(before.erasureHash!==null&&after.erasureHash===null)return false;
  }
  return true;
 }catch{/* @silent-fallback-ok: malformed or non-monotonic signed revisions never replace an immutable loss plan or grant ACT authority. */return false;}
}

/** Every adjacent revision must be checked: comparison with the original alone
 * would allow a later plan to forget negatives learned by its predecessor. */
export function verifyGraphMemberLossPlanRevisionSuccessor(previous:GraphMemberLossPlanRevision,next:GraphMemberLossPlanRevision,consent:GraphOwnerMemberLossConsent,intentHash:string,context:GraphOwnerMemberLossContext):boolean{
 if(!verifyGraphMemberLossPlanRevision(previous,consent,intentHash,context)||!verifyGraphMemberLossPlanRevision(next,consent,intentHash,context)||next.generation!==previous.generation+1||next.supersedesHash!==canonicalHash(previous)||next.originalCreationHash!==previous.originalCreationHash||canonicalHash(next.originalPlan)!==canonicalHash(previous.originalPlan)||next.ownerRecoveryHash!==previous.ownerRecoveryHash||!graphMemberLossRevisionPreservesNegativeFacts(previous.negativeFacts,next.negativeFacts))return false;
 const before=previous.plan,after=next.plan;
 if(after.currentLease.writerId!==before.currentLease.writerId||after.currentLease.leaseEpoch<before.currentLease.leaseEpoch||after.manifest.highestCertifiedSequence<before.manifest.highestCertifiedSequence||after.manifest.highestAcknowledgedSequence<before.manifest.highestAcknowledgedSequence)return false;
 const entries=new Map(after.manifest.entries.map(entry=>[entry.eventId,entry]));
 for(const entry of before.manifest.entries){const current=entries.get(entry.eventId);if(!current)return false;
  for(const key of ['erasureHash','cancellationCertificateHash','erasedControlProofHash','cancellationHash'] as const)if(entry[key]!==null&&entry[key]!==current[key])return false;
  if(entry.rewrapHash===null&&current.rewrapHash!==null)return false;
 }
 return true;
}

export const GRAPH_MEMBER_LOSS_REVISION_RECEIPT_DOMAIN='graph-owned-member-loss-revision-persisted-v1';
export interface GraphMemberLossRevisionReceipt {v:1;kind:'owned-member-loss-revision-persisted';agentId:string;membershipHash:string;consentHash:string;revisionHash:string;generation:number;witnessId:string;persistedAt:string;signature:string}
export function verifyGraphMemberLossRevisionReceipt(receipt:GraphMemberLossRevisionReceipt,revision:GraphMemberLossPlanRevision,witnessPublicKey:import('node:crypto').KeyLike):boolean{
 try{return exactFields(receipt,['v','kind','agentId','membershipHash','consentHash','revisionHash','generation','witnessId','persistedAt','signature'])&&receipt.v===1&&receipt.kind==='owned-member-loss-revision-persisted'&&receipt.agentId===revision.agentId&&receipt.membershipHash===canonicalHash(revision.plan.newMembership)&&receipt.consentHash===revision.consentHash&&receipt.revisionHash===canonicalHash(revision)&&receipt.generation===revision.generation&&receipt.witnessId===revision.plan.newMembership.witnessId&&iso(receipt.persistedAt)&&verifyGraphRecord(GRAPH_MEMBER_LOSS_REVISION_RECEIPT_DOMAIN,unsigned(receipt),receipt.signature,witnessPublicKey);}catch{/* @silent-fallback-ok: only an exact signed durable W revision receipt can fence a continuation. */return false;}
}

export const GRAPH_MEMBER_LOSS_PLAN_ORIGIN_DOMAIN='graph-owned-member-loss-plan-origin-v1';
export interface GraphMemberLossPlanOrigin {v:1;kind:'owned-member-loss-plan-origin';agentId:string;consentHash:string;intentHash:string;originalPlan:GraphTransferStageMetadata;ownerRecoveryHash:string;createdAt:string;signature:string}
export function verifyGraphMemberLossPlanOrigin(value:GraphMemberLossPlanOrigin,consent:GraphOwnerMemberLossConsent,intentHash:string,context:GraphOwnerMemberLossContext):boolean{
 try{return exactFields(value,['v','kind','agentId','consentHash','intentHash','originalPlan','ownerRecoveryHash','createdAt','signature'])&&value.v===1&&value.kind==='owned-member-loss-plan-origin'&&value.agentId===context.previousMembership.agentId&&value.consentHash===canonicalHash(consent)&&value.intentHash===intentHash&&hash(value.ownerRecoveryHash)&&iso(value.createdAt)&&verifyGraphOwnerMemberLossConsent(consent,context)&&validPlan(value.originalPlan,context)&&value.originalPlan.authorization.recoveryId==='loss-'+value.consentHash&&verifyGraphRecord(GRAPH_MEMBER_LOSS_PLAN_ORIGIN_DOMAIN,unsigned(value),value.signature,context.ownerPublicKey);}catch{/* @silent-fallback-ok: invalid retained origin is not a fresh plan or continuation authority. */return false;}
}
