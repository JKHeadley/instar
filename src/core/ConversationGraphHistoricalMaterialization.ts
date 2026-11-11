import {GraphSelectedMaterializationV2,GraphVerifiedMaterializationContextV2,graphMaterializationSharedHashes} from './ConversationGraphMaterializationContexts.js';
/** Historical terminal source transfer is authorized by the owner's exact
 * recovery plan plus every new member's durable state-transfer receipt. It
 * never rewrites the original certificate or invents an old-epoch receipt. */
import type crypto from 'node:crypto';
import type {LeaseRecord} from './types.js';
import {canonicalHash,canonicalJson,canonicalGraphRewrapInventory,graphRewrapInventoryHash,exactFields,hash,verifyMembershipActivation,verifyFencedLeaseBridge,validateRecoverySourceManifest,
 type GraphMembershipActivationCertificate,type GraphRecoverySourceManifest,type GraphRewrapInventoryEntry,type GraphWitnessLease,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
export interface GraphHistoricalMaterialization {
 activation:GraphMembershipActivationCertificate;manifest:GraphRecoverySourceManifest;rewrapInventory:GraphRewrapInventoryEntry[];
 rewrapHash:string;currentLease:GraphWitnessLease;originalCurrentLease:LeaseRecord;
}
export interface GraphHistoricalMaterializationRef {epoch:number;activationHash:string;manifestHash:string;rewrapInventoryHash:string;rewrapHash:string;leaseHash:string;originalLeaseHash:string}
export function graphHistoricalMaterializationRef(proof:GraphHistoricalMaterialization):GraphHistoricalMaterializationRef{return {epoch:proof.activation.newMembership.epoch,...graphMaterializationSharedHashes(proof),rewrapHash:proof.rewrapHash};}
export interface GraphMaterializationTrust {ownerPublicKey:crypto.KeyLike;witnessPublicKeys:ReadonlyMap<string,crypto.KeyLike>;installedMembership?:GraphMembershipEpoch;machineId?:string}
/** Signature authority only. Paged consumers independently verify every exact
 * manifest/inventory byte before their typed context is issued. */
export function verifyGraphHistoricalMaterializationAuthority(proof:Pick<GraphHistoricalMaterialization,'activation'|'currentLease'|'originalCurrentLease'>,agentId:string,trust:GraphMaterializationTrust):boolean{
 const {activation}=proof,witness=trust.witnessPublicKeys.get(activation.witnessId);return !!witness&&verifyMembershipActivation(activation,trust.ownerPublicKey,witness)&&activation.agentId===agentId&&proof.currentLease.leaseEpoch===activation.ownerAuthorization.fenceEpoch&&verifyFencedLeaseBridge(proof.currentLease,proof.originalCurrentLease,activation.newMembership);
}
export function verifyGraphHistoricalMaterializationContext(proof:GraphHistoricalMaterialization,agentId:string,trust:GraphMaterializationTrust):boolean{
 try{
  if(proof instanceof GraphSelectedMaterializationV2){proof.assertCurrent();return proof.trustedFor(agentId,trust);}
  if(!exactFields(proof,['activation','manifest','rewrapInventory','rewrapHash','currentLease','originalCurrentLease']))return false;
  const {activation,manifest}=proof;
  if(!verifyGraphHistoricalMaterializationAuthority(proof,agentId,trust)||!validateRecoverySourceManifest(manifest)||canonicalHash(manifest)!==activation.ownerAuthorization.sourceManifestHash||manifest.membershipHash!==canonicalHash(activation.previousMembership))return false;
  const inventory=canonicalGraphRewrapInventory(proof.rewrapInventory),ids=new Set(manifest.entries.map(entry=>entry.eventId));
  return canonicalJson(inventory)===canonicalJson(proof.rewrapInventory)&&graphRewrapInventoryHash(inventory)===activation.ownerAuthorization.rewrapInventoryHash
   &&inventory.length===manifest.entries.length&&inventory.every(row=>ids.has(row.eventId));
 }catch { /* @silent-fallback-ok: malformed source-transfer context fails verification, never authorizes historical materialization */ return false; }
}
export function verifyGraphHistoricalMaterializationEntry(proof:GraphHistoricalMaterialization,record:Pick<ConversationGraphReplicationRecord,'packet'|'certificate'|'cancellationCertificate'>,
 entry=proof instanceof GraphSelectedMaterializationV2?undefined:proof.manifest.entries.find(row=>row.eventId===record.packet.eventId),key=proof instanceof GraphSelectedMaterializationV2?undefined:proof.rewrapInventory.find(row=>row.eventId===record.packet.eventId)):boolean{
 if(proof instanceof GraphSelectedMaterializationV2)return proof.matches(record);return !!entry&&!!key&&hash(proof.rewrapHash)&&key.rewrapHash===proof.rewrapHash&&entry.operationHash===canonicalHash(record.packet)&&entry.coreHash===record.packet.coreHash
  &&entry.authorizationReceiptHash===record.packet.authorizationReceiptHash&&entry.sourceBundleHash===record.packet.sourceBundleHash
  &&entry.sourceSequence===record.packet.sourceSequence&&entry.sourceSequence<=proof.manifest.highestCertifiedSequence
  &&entry.certificateHash===(record.certificate?canonicalHash(record.certificate):null)
  &&entry.cancellationCertificateHash===(record.cancellationCertificate?canonicalHash(record.cancellationCertificate):null)&&!!(record.certificate||record.cancellationCertificate);
}
export function verifyGraphHistoricalMaterialization(proof:GraphHistoricalMaterialization,record:Pick<ConversationGraphReplicationRecord,'packet'|'certificate'|'cancellationCertificate'>,trust:GraphMaterializationTrust):boolean{
 return verifyGraphHistoricalMaterializationContext(proof,record.packet.agentId,trust)
  &&(!trust.installedMembership||canonicalHash(trust.installedMembership)===canonicalHash(proof.activation.newMembership))
  &&(!trust.machineId||proof.activation.newMembership.members.some(member=>member.machineId===trust.machineId))
  &&verifyGraphHistoricalMaterializationEntry(proof,record);
}

/** Initial complete signed context plus a fresh selected row, not live/native
 * admission. Storage errors reject; callers must run context.assertCurrent()
 * over the whole set at their final actuation barrier. No giant array hydrate. */
export async function verifyGraphHistoricalMaterializationPaged(context:GraphVerifiedMaterializationContextV2,record:Pick<ConversationGraphReplicationRecord,'packet'|'certificate'|'cancellationCertificate'>,rewrapHash:string,trust:GraphMaterializationTrust):Promise<boolean>{
 if(!(context instanceof GraphVerifiedMaterializationContextV2)||!context.trustedFor(record.packet.agentId,trust)||!hash(rewrapHash))return false;const row=await context.readEntry(record.packet.eventId);if(!row)return false;const e=row.entry;return row.rewrapHash===rewrapHash&&e.operationHash===canonicalHash(record.packet)&&e.coreHash===record.packet.coreHash&&e.authorizationReceiptHash===record.packet.authorizationReceiptHash&&e.sourceBundleHash===record.packet.sourceBundleHash&&e.sourceSequence===record.packet.sourceSequence&&e.sourceSequence<=context.manifestHeader.highestCertifiedSequence&&e.certificateHash===(record.certificate?canonicalHash(record.certificate):null)&&e.cancellationCertificateHash===(record.cancellationCertificate?canonicalHash(record.cancellationCertificate):null)&&!!(record.certificate||record.cancellationCertificate);
}
