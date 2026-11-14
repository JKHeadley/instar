/** Capacity arithmetic only. Placeholder signatures are NEVER authority or
 * receipts: their fixed canonical lengths bound a future activation frame. */
import {canonicalHash,canonicalJson,type GraphMembershipEpoch,type GraphRecoveryAuthorization,type GraphRecoverySourceManifest,type GraphRewrapInventoryEntry,type GraphWitnessLease} from './GraphWitnessTypes.js';
import type {LeaseRecord} from './types.js';
export interface GraphTransferContextCapacityInput {
 previousMembership:GraphMembershipEpoch;newMembership:GraphMembershipEpoch;authorization:GraphRecoveryAuthorization;
 manifest:GraphRecoverySourceManifest;rewrapInventory:GraphRewrapInventoryEntry[];currentLease:GraphWitnessLease;originalCurrentLease:LeaseRecord;
}
export function graphTransferContextCapacityBytes(input:GraphTransferContextCapacityInput):number{
 const signature='A'.repeat(86),timestamp='9999-12-31T23:59:59.999+00:00',a=input.authorization;
 const receipts=input.newMembership.members.map(member=>({v:1,agentId:a.agentId,recoveryId:a.recoveryId,newMembershipHash:canonicalHash(input.newMembership),sourceManifestHash:a.sourceManifestHash,rewrapInventoryHash:a.rewrapInventoryHash,
  highestCertifiedSequence:a.highestCertifiedSequence,highestCertifiedCoreHash:a.highestCertifiedCoreHash,machineId:member.machineId,persistedAt:timestamp,signature}));
 const activation={v:1,agentId:a.agentId,previousMembership:input.previousMembership,newMembership:input.newMembership,ownerAuthorization:a,stateTransferReceipts:receipts,witnessId:input.newMembership.witnessId,activatedAt:timestamp,signature};
 return Buffer.byteLength(canonicalJson({activation,manifest:input.manifest,rewrapInventory:input.rewrapInventory,currentLease:input.currentLease,originalCurrentLease:input.originalCurrentLease}));
}
