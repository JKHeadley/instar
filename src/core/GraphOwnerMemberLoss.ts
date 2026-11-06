/** Isolated historical consent proof, NOT native-admin or activation authority.
 * The actual owner service must freshly admit the exact action before signing.
 * There is deliberately no exported mint/permission factory while that service
 * and native authority integration have not been implemented and reviewed. */
import type crypto from 'node:crypto';
import {canonicalHash,canonicalJson,exactFields,hash,iso,opaque,positive,unsigned,verifyGraphRecord,verifyMembershipEpoch,validGraphOperationKey,
 GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
export const GRAPH_OWNER_MEMBER_LOSS_ADMISSION_DOMAIN='graph-owner-member-loss-admission-v1';
export const GRAPH_OWNER_MEMBER_LOSS_CONSENT_DOMAIN='graph-owner-member-loss-consent-v1';
export interface GraphMemberLossNativeIdentity {machineId:string;signingKeyHash:string;sealingKeyHash:string;nativeKeyEpoch:number}
export interface GraphMemberLossOperation {eventId:string;operationHash:string;coreHash:string;predecessorHash:string|null;sourceSequence:number;terminalHash:string|null;outcome:'committed'|'canceled'|'erased'|'pending'}
export interface GraphOwnerMemberLossPayload {
 v:1;kind:'owner-member-loss';pendingDisposition:'refuse-all-uncommitted';scope:'installed-machine-decommission';reason:'permanent-loss';agentId:string;requestId:string;
 draftHash:string;challengeHash:string;confirmationHash:string;previousPublicationHash:string;previousMembershipHash:string;newMembershipHash:string;nativeRosterHash:string;
 removed:GraphMemberLossNativeIdentity[];acceptingMachineId:string;
 acknowledgedPrefix:{sourceSequence:number;coreHash:string|null};
 operations:GraphMemberLossOperation[];knownManifestHash:string;knownPendingManifestHash:string;
 unknownRemovedTailMachineIds:string[];historicalCopyDebtMachineIds:string[];
 lossAcknowledgement:'removed-local-unshared-edits-may-be-lost';acceptedAt:string;
}
export interface GraphOwnerMemberLossAdmission {
 v:1;kind:'owner-member-loss-admission';action:'confirm-permanent-member-loss';agentId:string;requestId:string;consentPayloadHash:string;
 acceptingMachineId:string;principalKey:string;authenticationMethod:'owner-device'|'owner-dashboard';admissionIdHash:string;acceptedAt:string;signature:string;
}
export interface GraphOwnerMemberLossConsent {v:1;kind:'owner-member-loss-consent';payload:GraphOwnerMemberLossPayload;admission:GraphOwnerMemberLossAdmission;signature:string}
/** All context is already-trusted service input. This verifier does not discover
 * the current installed roster, current PIN/device policy, or native epoch. */
export interface GraphOwnerMemberLossContext {ownerPublicKey:crypto.KeyLike;previousPublicationHash:string;previousMembership:GraphMembershipEpoch;newMembership:GraphMembershipEpoch;nativeIdentities:GraphMemberLossNativeIdentity[]}
/** Content-free named confirmation commitment; no admission or permission. */
export function graphOwnerMemberLossConfirmationHash(value:Pick<GraphOwnerMemberLossPayload,'agentId'|'requestId'|'challengeHash'|'previousMembershipHash'|'newMembershipHash'|'removed'>):string {
 return canonicalHash({action:'confirm-permanent-member-loss',agentId:value.agentId,requestId:value.requestId,challengeHash:value.challengeHash,previousMembershipHash:value.previousMembershipHash,newMembershipHash:value.newMembershipHash,removed:value.removed});
}
const ordered=(rows:readonly string[])=>rows.every((row,index)=>index===0||rows[index-1]<row);
const operationId=(id:string)=>['graph-event','header-op','source-observation'].some(kind=>validGraphOperationKey(kind,id));
function validNative(row:GraphMemberLossNativeIdentity):boolean{return exactFields(row,['machineId','signingKeyHash','sealingKeyHash','nativeKeyEpoch'])&&opaque(row.machineId)&&hash(row.signingKeyHash)&&hash(row.sealingKeyHash)&&Number.isSafeInteger(row.nativeKeyEpoch)&&row.nativeKeyEpoch>=0;}
function payloadValid(value:unknown,context:GraphOwnerMemberLossContext):value is GraphOwnerMemberLossPayload {
 const p=value as GraphOwnerMemberLossPayload,old=context.previousMembership,next=context.newMembership;
 if(!exactFields(p,['v','kind','pendingDisposition','scope','reason','agentId','requestId','draftHash','challengeHash','confirmationHash','previousPublicationHash','previousMembershipHash','newMembershipHash','nativeRosterHash','removed','acceptingMachineId','acknowledgedPrefix','operations','knownManifestHash','knownPendingManifestHash','unknownRemovedTailMachineIds','historicalCopyDebtMachineIds','lossAcknowledgement','acceptedAt'])
 ||p.v!==1||p.kind!=='owner-member-loss'||p.pendingDisposition!=='refuse-all-uncommitted'||p.scope!=='installed-machine-decommission'||p.reason!=='permanent-loss'||!opaque(p.agentId)||!opaque(p.requestId)||!opaque(p.acceptingMachineId)||!iso(p.acceptedAt)
 ||p.lossAcknowledgement!=='removed-local-unshared-edits-may-be-lost'||![p.draftHash,p.challengeHash,p.confirmationHash,p.previousPublicationHash,p.previousMembershipHash,p.newMembershipHash,p.nativeRosterHash,p.knownManifestHash,p.knownPendingManifestHash].every(hash)
 ||!hash(context.previousPublicationHash)||p.previousPublicationHash!==context.previousPublicationHash||!verifyMembershipEpoch(old,context.ownerPublicKey)||!verifyMembershipEpoch(next,context.ownerPublicKey)
 ||old.custodyProfile?.mode!=='owned-machine'||next.custodyProfile?.mode!=='owned-machine'||p.agentId!==old.agentId||p.agentId!==next.agentId||next.epoch!==old.epoch+1||next.previousMembershipHash!==canonicalHash(old)||p.previousMembershipHash!==canonicalHash(old)||p.newMembershipHash!==canonicalHash(next))return false;
 if(!Array.isArray(context.nativeIdentities)||context.nativeIdentities.length!==old.members.length||!context.nativeIdentities.every(validNative)||!ordered(context.nativeIdentities.map(row=>row.machineId)))return false;
 const native=new Map(context.nativeIdentities.map(row=>[row.machineId,row]));for(const member of old.members){const row=native.get(member.machineId);if(!row||row.signingKeyHash!==canonicalHash(member.signingPublicKey)||row.sealingKeyHash!==canonicalHash(member.sealingPublicKey))return false;}
 if(p.nativeRosterHash!==canonicalHash(context.nativeIdentities)||!Array.isArray(p.removed)||!p.removed.length||p.removed.length>=old.members.length||!p.removed.every(validNative)||!ordered(p.removed.map(row=>row.machineId)))return false;
 const removed=new Set(p.removed.map(row=>row.machineId));if(p.removed.some(row=>canonicalHash(row)!==canonicalHash(native.get(row.machineId))))return false;
 const survivors=old.members.filter(row=>!removed.has(row.machineId));if(next.members.length!==survivors.length||survivors.some(row=>!next.members.some(candidate=>canonicalHash(candidate)===canonicalHash(row)))||!survivors.some(row=>row.machineId===p.acceptingMachineId))return false;
 if(p.confirmationHash!==graphOwnerMemberLossConfirmationHash(p))return false;
 const removedIds=p.removed.map(row=>row.machineId);if(!Array.isArray(p.unknownRemovedTailMachineIds)||!Array.isArray(p.historicalCopyDebtMachineIds)||canonicalHash(p.unknownRemovedTailMachineIds)!==canonicalHash(removedIds)||canonicalHash(p.historicalCopyDebtMachineIds)!==canonicalHash(removedIds))return false;
 if(!exactFields(p.acknowledgedPrefix,['sourceSequence','coreHash'])||!Number.isSafeInteger(p.acknowledgedPrefix.sourceSequence)||p.acknowledgedPrefix.sourceSequence<0||!(p.acknowledgedPrefix.coreHash===null||hash(p.acknowledgedPrefix.coreHash))||(p.acknowledgedPrefix.sourceSequence===0)!==(p.acknowledgedPrefix.coreHash===null)
 ||!Array.isArray(p.operations)||p.operations.length>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)return false;
 const ids=new Set<string>();for(let index=0;index<p.operations.length;index++){const row=p.operations[index];if(!exactFields(row,['eventId','operationHash','coreHash','predecessorHash','sourceSequence','terminalHash','outcome'])||!operationId(row.eventId)||!hash(row.operationHash)||!hash(row.coreHash)||!positive(row.sourceSequence)||row.sourceSequence!==index+1||row.predecessorHash!==(index===0?null:p.operations[index-1].coreHash)||!['committed','canceled','erased','pending'].includes(row.outcome)||(row.outcome==='pending'?row.terminalHash!==null:!hash(row.terminalHash))||ids.has(row.eventId)||row.sourceSequence<=p.acknowledgedPrefix.sourceSequence&&row.outcome==='pending')return false;ids.add(row.eventId);}
 if(p.acknowledgedPrefix.sourceSequence>p.operations.length||p.acknowledgedPrefix.sourceSequence>0&&p.operations[p.acknowledgedPrefix.sourceSequence-1].coreHash!==p.acknowledgedPrefix.coreHash||p.knownManifestHash!==canonicalHash(p.operations)||p.knownPendingManifestHash!==canonicalHash(p.operations.filter(row=>row.outcome==='pending')))return false;
 return true;
}
/** Canonical defensive copy of an exact unsigned payload; no permission grant. */
export function parseGraphOwnerMemberLossPayload(value:unknown,context:GraphOwnerMemberLossContext):GraphOwnerMemberLossPayload|null {
 try{if(!payloadValid(value,context))return null;return JSON.parse(canonicalJson(value)) as GraphOwnerMemberLossPayload;}
 catch{/* @silent-fallback-ok: malformed or wrongly scoped loss proposals are invalid data, never permission to revoke. */return null;}
}
/** Historical dual-signature verification only. A caller still needs actual
 * fresh human admission and native-admin review before any side effect. */
export function verifyGraphOwnerMemberLossConsent(value:unknown,context:GraphOwnerMemberLossContext):value is GraphOwnerMemberLossConsent {
 try{const consent=value as GraphOwnerMemberLossConsent;if(!exactFields(consent,['v','kind','payload','admission','signature'])||consent.v!==1||consent.kind!=='owner-member-loss-consent'||!payloadValid(consent.payload,context))return false;
 const p=consent.payload,a=consent.admission,member=context.previousMembership.members.find(row=>row.machineId===p.acceptingMachineId);
 if(!member||!exactFields(a,['v','kind','action','agentId','requestId','consentPayloadHash','acceptingMachineId','principalKey','authenticationMethod','admissionIdHash','acceptedAt','signature'])||a.v!==1||a.kind!=='owner-member-loss-admission'||a.action!=='confirm-permanent-member-loss'||a.agentId!==p.agentId||a.requestId!==p.requestId||a.consentPayloadHash!==canonicalHash(p)||a.acceptingMachineId!==p.acceptingMachineId||a.principalKey!==`owner:${p.agentId}`||!['owner-device','owner-dashboard'].includes(a.authenticationMethod)||!hash(a.admissionIdHash)||a.acceptedAt!==p.acceptedAt)return false;
 return verifyGraphRecord(GRAPH_OWNER_MEMBER_LOSS_ADMISSION_DOMAIN,unsigned(a),a.signature,member.signingPublicKey)&&verifyGraphRecord(GRAPH_OWNER_MEMBER_LOSS_CONSENT_DOMAIN,unsigned(consent),consent.signature,context.ownerPublicKey);
 }catch{/* @silent-fallback-ok: untrusted loss signatures/structures fail closed; no native or graph authority is installed. */return false;}
}
