import {verifyGraphMemberLossPlanRevision,GRAPH_MEMBER_LOSS_REVISION_ACTIVATION_DOMAIN,type GraphMemberLossPlanRevision} from './GraphMemberLossPlanRevision.js';
/** Separate owner-confirmed permanent-loss activation. This never relaxes the
 * ordinary all-old-member hold/retirement protocol. No private key is retained. */
import crypto from 'node:crypto';
import type {LeaseRecord} from './types.js';
import {verifyGraphMemberLossIntent,verifyGraphMemberLossSurvivorHold,verifyGraphNativeMemberLossReceipts,verifyGraphNativeMemberLossFloor,type GraphMemberLossIntentProof,type GraphMemberLossSurvivorHold,type GraphNativeMemberLossReceipt,type GraphNativeMemberLossFloor} from './GraphMemberLossNativeProof.js';
import {verifyGraphOwnerMemberLossConsent,type GraphOwnerMemberLossConsent,type GraphMemberLossNativeIdentity} from './GraphOwnerMemberLoss.js';
import {verifyGraphOwnerRecoveryReceiptBinding,type GraphOwnerRecoveryReceipt} from './GraphOwnerRecoveryStore.js';
import {canonicalHash,exactFields,hash,iso,signGraphRecord,unsigned,verifyGraphRecord,verifyMembershipTransferReceipt,verifyFencedLeaseBridge,verifyWitnessLease,type GraphMembershipActivationCertificate,type GraphMembershipEpoch,type GraphWitnessLease} from './GraphWitnessTypes.js';
export interface GraphMemberLossActivationRow {v:1;certificate:GraphMembershipActivationCertificate}
export const GRAPH_MEMBER_LOSS_ACTIVATION_DOMAIN='graph-owned-member-loss-activation-v1';
export interface GraphMemberLossActivationAuthority {
 v:1|2;kind:'owned-member-loss';planRevision?:GraphMemberLossPlanRevision;intent:GraphMemberLossIntentProof;consent:GraphOwnerMemberLossConsent;nativeIdentities:GraphMemberLossNativeIdentity[];
 nativeReceipts:GraphNativeMemberLossReceipt[];nativeFloors:GraphNativeMemberLossFloor[];survivorHolds:GraphMemberLossSurvivorHold[];
 negativeAdvancements:Array<{eventId:string;operationHash:string;terminalHash:string;outcome:'canceled'|'erased'}>;
 sourceInventories:Array<{machineId:string;inventoryHash:string;erasureInventoryHash:string}>;
 ownerRecoveryHash:string;ownerRecoveryReceipts:GraphOwnerRecoveryReceipt[];currentLease:GraphWitnessLease;originalLease:LeaseRecord;
}
/** A fresh same-epoch proof of holding, presented only at commit. The signed plan
 * stays immutable: its lease is a snapshot that revalidations and revisions bind to,
 * and a removal slower than one lease outlives that snapshot's expiry. */
export interface GraphMemberLossActivationHolding {lease:GraphWitnessLease;originalLease:LeaseRecord}
type GraphMemberLossActivationScope=Pick<GraphMembershipActivationCertificate,'agentId'|'previousMembership'|'newMembership'|'ownerAuthorization'|'activatedAt'>;
/** Rule for certificates that carry no holding proof: the plan's own lease covers activatedAt. */
export function verifyGraphMemberLossActivationAuthority(value:GraphMemberLossActivationAuthority,certificate:GraphMemberLossActivationScope,ownerPublicKey:crypto.KeyLike):boolean{
 return verifyGraphMemberLossPlanAuthority(value,certificate,ownerPublicKey)&&verifyWitnessLease(value.currentLease,certificate.newMembership,Date.parse(certificate.activatedAt));
}
/** Same holder, same acquisition, same epoch as the plan, and live at the given moment. */
export function verifyGraphMemberLossActivationHolding(holding:GraphMemberLossActivationHolding,plan:GraphMemberLossActivationAuthority,membership:GraphMembershipEpoch,at:number):boolean{
 try{return exactFields(holding,['lease','originalLease'])&&Number.isFinite(at)&&verifyFencedLeaseBridge(holding.lease,holding.originalLease,membership)&&holding.lease.leaseEpoch===plan.currentLease.leaseEpoch&&holding.lease.writerId===plan.currentLease.writerId&&holding.originalLease.epoch===plan.originalLease.epoch&&holding.originalLease.holder===plan.originalLease.holder&&holding.originalLease.acquiredAt===plan.originalLease.acquiredAt&&holding.originalLease.nonce>=plan.originalLease.nonce&&verifyWitnessLease(holding.lease,membership,at);
 }catch{/* @silent-fallback-ok: a malformed holding proof is no proof of holding, and refuses the activation. */return false;}
}
/** Signs the current native lease for this membership, and refuses unless this machine holds it right now. */
export function mintGraphMemberLossLeaseProof(o:{coordinator:{currentLease():LeaseRecord|null;holdsLease():boolean};instanceLockCurrent:()=>boolean;machineId:string;signingKey:crypto.KeyLike;membership:GraphMembershipEpoch;leaseEpoch:number}):GraphMemberLossActivationHolding{
 const original=o.coordinator.currentLease();if(!original||!o.instanceLockCurrent()||!o.coordinator.holdsLease()||original.holder!==o.machineId||original.epoch!==o.leaseEpoch)throw new Error('member-loss-native-epoch-continuation-required');
 const body={v:1 as const,agentId:o.membership.agentId,membershipEpoch:o.membership.epoch,leaseEpoch:original.epoch,writerId:o.machineId,issuedAt:original.acquiredAt,expiresAt:original.expiresAt,fencedLeaseHash:canonicalHash(original)},lease={...body,signature:signGraphRecord('graph-lease-v1',body,o.signingKey)};
 if(!verifyFencedLeaseBridge(lease,original,o.membership)||!verifyWitnessLease(lease,o.membership,Date.now()))throw new Error('member-loss-current-negative-lease-invalid');
 return{lease,originalLease:original};
}
/** Everything about the plan except whether its lease snapshot is still live. */
export function verifyGraphMemberLossPlanAuthority(value:GraphMemberLossActivationAuthority,certificate:GraphMemberLossActivationScope,ownerPublicKey:crypto.KeyLike):boolean{
 try{if(!exactFields(value,['v','kind',...(value.planRevision===undefined?[]:['planRevision']),'intent','consent','nativeIdentities','nativeReceipts','nativeFloors','survivorHolds','negativeAdvancements','sourceInventories','ownerRecoveryHash','ownerRecoveryReceipts','currentLease','originalLease'])||![1,2].includes(value.v)||value.v===1&&value.planRevision!==undefined||value.v===2&&value.planRevision===undefined||value.kind!=='owned-member-loss')return false;
 const ownerKey=ownerPublicKey instanceof crypto.KeyObject&&ownerPublicKey.type==='public'?ownerPublicKey:crypto.createPublicKey(ownerPublicKey),ownerPem=ownerKey.export({type:'spki',format:'pem'}).toString();
 const old=certificate.previousMembership,next=certificate.newMembership,p=value.consent.payload,context={ownerPublicKey,previousPublicationHash:p.previousPublicationHash,previousMembership:old,newMembership:next,nativeIdentities:value.nativeIdentities};
 if(!verifyGraphOwnerMemberLossConsent(value.consent,context)||!verifyGraphMemberLossIntent(value.intent,context)||p.pendingDisposition!=='refuse-all-uncommitted'||value.intent.payload.pendingDisposition!=='refuse-all-uncommitted'||value.intent.payload.requestId!==p.requestId||value.intent.payload.draftHash!==p.draftHash||value.intent.payload.challengeHash!==p.challengeHash||value.intent.payload.acceptingMachineId!==p.acceptingMachineId||certificate.agentId!==p.agentId||!verifyGraphNativeMemberLossReceipts(value.nativeReceipts,value.consent,context)||!Array.isArray(value.nativeFloors)||value.nativeFloors.length!==next.members.length||!Array.isArray(value.survivorHolds)||value.survivorHolds.length!==next.members.length||!Array.isArray(value.sourceInventories)||value.sourceInventories.length!==next.members.length||!hash(value.ownerRecoveryHash)||!Array.isArray(value.ownerRecoveryReceipts)||value.ownerRecoveryReceipts.length!==next.members.length)return false;
 const floorIds=new Set<string>(),holdIds=new Set<string>(),sourceIds=new Set<string>(),recoveryIds=new Set<string>();for(const floor of value.nativeFloors){if(floorIds.has(floor.machineId)||!verifyGraphNativeMemberLossFloor(floor,value.intent,context))return false;floorIds.add(floor.machineId);}for(const hold of value.survivorHolds){if(holdIds.has(hold.machineId)||!verifyGraphMemberLossSurvivorHold(hold,value.intent,context))return false;holdIds.add(hold.machineId);}for(const row of value.sourceInventories){if(!exactFields(row,['machineId','inventoryHash','erasureInventoryHash'])||sourceIds.has(row.machineId)||!next.members.some(member=>member.machineId===row.machineId)||!hash(row.inventoryHash)||!hash(row.erasureInventoryHash))return false;sourceIds.add(row.machineId);}for(const receipt of value.ownerRecoveryReceipts){if(recoveryIds.has(receipt.machineId)||!verifyGraphOwnerRecoveryReceiptBinding(receipt,value.ownerRecoveryHash,next,ownerPem))return false;recoveryIds.add(receipt.machineId);}
 if(!verifyFencedLeaseBridge(value.currentLease,value.originalLease,next)||value.currentLease.leaseEpoch!==certificate.ownerAuthorization.fenceEpoch||value.currentLease.leaseEpoch<=Math.max(...value.nativeFloors.map(row=>row.epoch))||value.nativeReceipts.some(row=>Date.parse(row.persistedAt)>Date.parse(certificate.activatedAt)))return false;
 if(value.v===2){const revision=value.planRevision!;if(!verifyGraphMemberLossPlanRevision(revision,value.consent,canonicalHash(value.intent),context)||canonicalHash(revision.plan.authorization)!==canonicalHash(certificate.ownerAuthorization)||canonicalHash(revision.plan.currentLease)!==canonicalHash(value.currentLease)||canonicalHash(revision.plan.originalCurrentLease)!==canonicalHash(value.originalLease)||revision.ownerRecoveryHash!==value.ownerRecoveryHash||value.sourceInventories.some(row=>row.inventoryHash!==revision.inventoryHash||row.erasureInventoryHash!==revision.erasureInventoryHash))return false;}
 const pending=p.operations.filter(row=>row.outcome==='pending'),outcomes=certificate.ownerAuthorization.pendingOutcomes,covered=new Set<string>();if(!Array.isArray(value.negativeAdvancements)||value.negativeAdvancements.length>pending.length)return false;for(const row of value.negativeAdvancements){if(!exactFields(row,['eventId','operationHash','terminalHash','outcome'])||!hash(row.terminalHash)||!['canceled','erased'].includes(row.outcome)||covered.has(row.operationHash)||!pending.some(op=>op.eventId===row.eventId&&op.operationHash===row.operationHash))return false;covered.add(row.operationHash);}for(const outcome of outcomes){if(outcome.decision!=='refuse'||covered.has(outcome.operationHash)||!pending.some(op=>op.operationHash===outcome.operationHash))return false;covered.add(outcome.operationHash);}if(covered.size!==pending.length)return false;
 return true;
 }catch{/* @silent-fallback-ok: incomplete loss/native/root custody proof cannot replace missing old holds or activate a member. */return false;}
}

export const GRAPH_MEMBER_LOSS_PIN_DOMAIN='graph-owned-member-loss-activation-pin-v1';
export const GRAPH_MEMBER_LOSS_SETTLED_DOMAIN='graph-owned-member-loss-settled-v1';
export interface GraphMemberLossActivationPin {
 v:1;kind:'member-loss-activation-pin';agentId:string;activationHash:string;membershipHash:string;consentHash:string;machineId:string;
 importInventoryHash:string;transferReceipt:import('./GraphWitnessTypes.js').GraphMembershipTransferReceipt;persistedAt:string;signature:string;
}
export interface GraphMemberLossSettlementProof {
 v:1;kind:'owned-member-loss-settled';agentId:string;activationHash:string;membershipHash:string;activationPinsHash:string;terminalInventoryHash:string;
 highestSequence:number;highestCoreHash:string|null;witnessId:string;settledAt:string;signature:string;
}
export function verifyGraphMemberLossActivationPin(pin:GraphMemberLossActivationPin,activation:GraphMembershipActivationCertificate):boolean{
 try{const loss=activation.memberLoss,member=activation.newMembership.members.find(row=>row.machineId===pin.machineId);return !!loss&&!!member&&exactFields(pin,['v','kind','agentId','activationHash','membershipHash','consentHash','machineId','importInventoryHash','transferReceipt','persistedAt','signature'])&&pin.v===1&&pin.kind==='member-loss-activation-pin'&&pin.agentId===activation.agentId&&pin.activationHash===canonicalHash(activation)&&pin.membershipHash===canonicalHash(activation.newMembership)&&pin.consentHash===canonicalHash(loss.consent)&&hash(pin.importInventoryHash)&&pin.transferReceipt.machineId===pin.machineId&&verifyMembershipTransferReceipt(pin.transferReceipt,activation.ownerAuthorization,activation.newMembership)&&iso(pin.persistedAt)&&Date.parse(pin.transferReceipt.persistedAt)>=Date.parse(activation.activatedAt)&&Date.parse(pin.persistedAt)>=Date.parse(pin.transferReceipt.persistedAt)&&verifyGraphRecord(GRAPH_MEMBER_LOSS_PIN_DOMAIN,unsigned(pin),pin.signature,member.signingPublicKey);
 }catch{/* @silent-fallback-ok: malformed member pin is missing physical import evidence, never an activation ACK. */return false;}
}
export function verifyGraphMemberLossActivationPins(pins:GraphMemberLossActivationPin[],activation:GraphMembershipActivationCertificate):boolean{
 if(!Array.isArray(pins)||pins.length!==activation.newMembership.members.length)return false;const ids=new Set<string>();for(const pin of pins){if(ids.has(pin.machineId)||!verifyGraphMemberLossActivationPin(pin,activation))return false;ids.add(pin.machineId);}return true;
}
export function verifyGraphMemberLossSettlement(proof:GraphMemberLossSettlementProof,activation:GraphMembershipActivationCertificate,witnessPublicKey:crypto.KeyLike,pins:GraphMemberLossActivationPin[]):boolean{
 try{const loss=activation.memberLoss,last=loss?.consent.payload.operations.at(-1);return !!loss&&exactFields(proof,['v','kind','agentId','activationHash','membershipHash','activationPinsHash','terminalInventoryHash','highestSequence','highestCoreHash','witnessId','settledAt','signature'])&&proof.v===1&&proof.kind==='owned-member-loss-settled'&&proof.agentId===activation.agentId&&proof.activationHash===canonicalHash(activation)&&proof.membershipHash===canonicalHash(activation.newMembership)&&verifyGraphMemberLossActivationPins(pins,activation)&&proof.activationPinsHash===canonicalHash([...pins].sort((a,b)=>a.machineId<b.machineId?-1:a.machineId>b.machineId?1:0))&&hash(proof.terminalInventoryHash)&&proof.highestSequence===(last?.sourceSequence??0)&&proof.highestCoreHash===(last?.coreHash??null)&&proof.witnessId===activation.witnessId&&iso(proof.settledAt)&&Date.parse(proof.settledAt)>=Date.parse(activation.activatedAt)&&verifyGraphRecord(GRAPH_MEMBER_LOSS_SETTLED_DOMAIN,unsigned(proof),proof.signature,witnessPublicKey);
 }catch{/* @silent-fallback-ok: malformed settlement cannot clear the permanent-loss maintenance hold. */return false;}
}

export function graphMemberLossActivationDomain(loss:GraphMemberLossActivationAuthority):string{return loss.v===2?GRAPH_MEMBER_LOSS_REVISION_ACTIVATION_DOMAIN:GRAPH_MEMBER_LOSS_ACTIVATION_DOMAIN;}
