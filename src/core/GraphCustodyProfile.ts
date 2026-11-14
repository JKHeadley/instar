/** Owner-signed deployment identity. A role signature never implies a second disk. */
import crypto from 'node:crypto';
import {canonicalHash,canonicalPublicKey,exactFields,iso,opaque,signGraphRecord,unsigned,verifyGraphRecord,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
export const GRAPH_CUSTODY_PROFILE_DOMAIN='graph-custody-deployment-v1';
export type {GraphCustodyProfile} from './GraphMembershipTypes.js';
import type {GraphCustodyProfile} from './GraphMembershipTypes.js';
export function graphCustodyMembershipContext(membership:GraphMembershipEpoch):unknown {
 const {signature:_signature,custodyProfile:_profile,...context}=membership;return context;
}
export function createGraphCustodyProfile(membership:GraphMembershipEpoch,host:{mode:'owned-machine'|'external';witnessPublicKey:string;hostMachineId:string|null},ownerPrivateKey:crypto.KeyLike):GraphCustodyProfile {
 const member=membership.members.find(row=>row.machineId===host.hostMachineId);
 const raw={v:1 as const,agentId:membership.agentId,membershipEpoch:membership.epoch,membershipContextHash:canonicalHash(graphCustodyMembershipContext(membership)),mode:host.mode,witnessId:membership.witnessId,witnessPublicKey:host.witnessPublicKey,failureDomain:membership.failureDomain,hostMachineId:host.hostMachineId,hostSigningPublicKey:member?.signingPublicKey??null,createdAt:membership.createdAt};
 return {...raw,signature:signGraphRecord(GRAPH_CUSTODY_PROFILE_DOMAIN,raw,ownerPrivateKey)};
}
export function verifyGraphCustodyProfile(profile:GraphCustodyProfile,membership:GraphMembershipEpoch,ownerPublicKey:crypto.KeyLike):boolean {
 try{
  if(!exactFields(profile,['v','agentId','membershipEpoch','membershipContextHash','mode','witnessId','witnessPublicKey','failureDomain','hostMachineId','hostSigningPublicKey','createdAt','signature'])||profile.v!==1||profile.agentId!==membership.agentId||profile.membershipEpoch!==membership.epoch||profile.membershipContextHash!==canonicalHash(graphCustodyMembershipContext(membership))||profile.witnessId!==membership.witnessId||profile.failureDomain!==membership.failureDomain||!iso(profile.createdAt)||profile.createdAt!==membership.createdAt||!canonicalPublicKey(profile.witnessPublicKey,'ed25519')||membership.members.some(member=>member.signingPublicKey===profile.witnessPublicKey))return false;
  const owner=ownerPublicKey instanceof crypto.KeyObject?ownerPublicKey:crypto.createPublicKey(ownerPublicKey);
  if(owner.type!=='public'||owner.export({type:'spki',format:'pem'}).toString()===profile.witnessPublicKey)return false;
  if(profile.mode==='owned-machine'){
   const host=membership.members.find(member=>member.machineId===profile.hostMachineId);
   if(!host||!opaque(profile.hostMachineId)||profile.hostSigningPublicKey!==host.signingPublicKey)return false;
  }else if(profile.mode!=='external'||profile.hostMachineId!==null||profile.hostSigningPublicKey!==null)return false;
  return verifyGraphRecord(GRAPH_CUSTODY_PROFILE_DOMAIN,unsigned(profile),profile.signature,ownerPublicKey);
 }catch{ /* @silent-fallback-ok: malformed deployment evidence is invalid profile authority, never an inferred local or external role */ return false; }
}
export type GraphCustodyScope={kind:'recorded-here'|'copied-on-owned-machine'|'external-custody';hostMachineId:string|null;failureDomain:string;profileHash:string|null};
/** Requires a separately verified owner membership/profile and pinned role key. */
export function graphCustodyScope(membership:GraphMembershipEpoch,recordingMachineId:string):GraphCustodyScope {
 const profile=membership.custodyProfile;
 if(!profile)return {kind:'external-custody',hostMachineId:null,failureDomain:membership.failureDomain,profileHash:null};
 return {kind:profile.mode==='external'?'external-custody':profile.hostMachineId===recordingMachineId?'recorded-here':'copied-on-owned-machine',hostMachineId:profile.hostMachineId,failureDomain:profile.failureDomain,profileHash:canonicalHash(profile)};
}
