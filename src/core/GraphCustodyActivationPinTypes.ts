/** Per-member ACT persistence is distinct from pre-ACT source-transfer/hold.
 * No title, body, owner credential or content-key envelope enters these facts. */
import type crypto from 'node:crypto';
import type {GraphCustodyProfileStage} from './GraphCustodyProfileAuthority.js';
import {canonicalHash,exactFields,hash,iso,signGraphRecord,unsigned,verifyGraphRecord,verifyMembershipActivation,verifyMembershipTransferReceipt,type GraphMembershipTransferReceipt,type GraphMembershipActivationCertificate} from './GraphWitnessTypes.js';
export const GRAPH_CUSTODY_IMPORT_DOMAIN='graph-owned-custody-act-import-durable-v1';
export const GRAPH_CUSTODY_ACTIVATION_PIN_DOMAIN='graph-owned-custody-act-pin-v1';
export interface GraphCustodyImportedStateReceipt {v:1;agentId:string;machineId:string;stageHash:string;activationHash:string;membershipHash:string;sourceTransferReceiptHash:string;importInventoryHash:string;persistedAt:string;signature:string}
export interface GraphCustodyActivationPin {v:1;agentId:string;machineId:string;stageHash:string;activationHash:string;membershipHash:string;postImportTransferReceiptHash:string;postImportTransferReceipt:GraphMembershipTransferReceipt;postImportReceipt:GraphCustodyImportedStateReceipt;postImportReceiptHash:string;pinnedAt:string;signature:string}
/** Stage owner/hold/retirement validation belongs to the actual custody
 * authority. This predicate verifies a member's exact ACT/import binding. */
export function verifyGraphCustodyActivationPin(pin:GraphCustodyActivationPin,stage:GraphCustodyProfileStage,activation:GraphMembershipActivationCertificate,ownerPublicKey:crypto.KeyLike):boolean{
 try{const m=stage.newMembership,member=m.members.find(row=>row.machineId===pin.machineId),profile=m.custodyProfile,r=pin.postImportReceipt,transfer=activation.stateTransferReceipts.find(row=>row.machineId===pin.machineId);
  if(!member||!profile||profile.mode!=='owned-machine'||!transfer||!verifyMembershipActivation(activation,ownerPublicKey,profile.witnessPublicKey)||canonicalHash(activation.newMembership)!==canonicalHash(m)||canonicalHash(activation.ownerAuthorization)!==canonicalHash(stage.authorization))return false;
  if(!exactFields(pin,['v','agentId','machineId','stageHash','activationHash','membershipHash','postImportTransferReceiptHash','postImportTransferReceipt','postImportReceipt','postImportReceiptHash','pinnedAt','signature'])||pin.v!==1||pin.agentId!==m.agentId||pin.stageHash!==canonicalHash(stage)||pin.activationHash!==canonicalHash(activation)||pin.membershipHash!==canonicalHash(m)||pin.postImportTransferReceiptHash!==canonicalHash(pin.postImportTransferReceipt)||pin.postImportTransferReceipt.machineId!==pin.machineId||!verifyMembershipTransferReceipt(pin.postImportTransferReceipt,activation.ownerAuthorization,m)||pin.postImportReceiptHash!==canonicalHash(r)||!iso(pin.pinnedAt))return false;
  if(!exactFields(r,['v','agentId','machineId','stageHash','activationHash','membershipHash','sourceTransferReceiptHash','importInventoryHash','persistedAt','signature'])||r.v!==1||r.agentId!==m.agentId||r.machineId!==pin.machineId||r.stageHash!==pin.stageHash||r.activationHash!==pin.activationHash||r.membershipHash!==pin.membershipHash||r.sourceTransferReceiptHash!==pin.postImportTransferReceiptHash||!hash(r.importInventoryHash)||!iso(r.persistedAt)||!verifyGraphRecord(GRAPH_CUSTODY_IMPORT_DOMAIN,unsigned(r),r.signature,member.signingPublicKey))return false;
  return verifyGraphRecord(GRAPH_CUSTODY_ACTIVATION_PIN_DOMAIN,unsigned(pin),pin.signature,member.signingPublicKey);
 }catch{ /* @silent-fallback-ok: invalid or cross-ACT pins never unlock a profile */ return false; }
}
export function signGraphCustodyImportedState(value:Omit<GraphCustodyImportedStateReceipt,'signature'>,key:crypto.KeyLike):GraphCustodyImportedStateReceipt{return{...value,signature:signGraphRecord(GRAPH_CUSTODY_IMPORT_DOMAIN,value,key)};}
export function signGraphCustodyActivationPin(value:Omit<GraphCustodyActivationPin,'signature'>,key:crypto.KeyLike):GraphCustodyActivationPin{return{...value,signature:signGraphRecord(GRAPH_CUSTODY_ACTIVATION_PIN_DOMAIN,value,key)};}
