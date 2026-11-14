import {GraphOwnerRecoveryStore} from './GraphOwnerRecoveryStore.js';
import {syncOwnedGraphIdentityDurably} from './GraphCustodyDurability.js';
export {syncOwnedGraphIdentityDurably} from './GraphCustodyDurability.js';
/** Owned-machine lifecycle for the existing durable custody engine.
 * An authenticated, durably pinned owner publication governs first creation.
 * Missing established storage never becomes permission for a blank genesis. */
import path from 'node:path';
import crypto from 'node:crypto';
import {base64ToSigningPem,base64ToEncryptionPem} from './MachineIdentity.js';
import type {IdentityStore} from './IdentityStore.js';
import {GraphWitnessService as DurableGraphWitnessService} from './GraphWitnessService.js';
import {GraphCustodyBootstrapStore,verifyGraphCustodyBootstrapPublication,type GraphCustodyBootstrapPublication} from './GraphCustodyBootstrap.js';
import type {GraphMembershipMember} from './GraphWitnessTypes.js';
import type {MachineIdentityManager} from './MachineIdentity.js';
import {GraphWitnessClient} from './GraphWitnessClient.js';
import type {GraphWitnessService} from './GraphWitnessService.js';
import {createInProcessGraphCustodyTransport,type GraphCustodyTransport} from './GraphCustodyTransport.js';
import {canonicalHash,verifyMembershipEpoch,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
export interface OwnedGraphCustody {
 readonly client:GraphWitnessClient;readonly transport:GraphCustodyTransport;readonly service:GraphWitnessService;
 close():void;
}
export function attachOwnedGraphCustody(options:{service:GraphWitnessService;identity:MachineIdentityManager;membership:GraphMembershipEpoch;ownerPublicKey:string;bearerToken:string;historicalWitnessPublicKeys?:Record<string,string>}):OwnedGraphCustody {
 const {service,identity,membership,ownerPublicKey,bearerToken}=options,profile=membership.custodyProfile,machine=identity.loadIdentity(),publicKey=identity.getSigningPublicKeyPem(machine.machineId);
 if(!profile||profile.mode!=='owned-machine'||!verifyMembershipEpoch(membership,ownerPublicKey)||profile.hostMachineId!==machine.machineId||profile.hostSigningPublicKey!==publicKey||profile.witnessPublicKey!==service.publicKey||canonicalHash(service.membershipProof(membership.agentId,membership.epoch))!==canonicalHash(membership))throw new Error('owned-custody-local-identity-invalid');
 const health=service.health();if(health.witnessId!==membership.witnessId||health.failureDomain!==membership.failureDomain)throw new Error('owned-custody-engine-identity-invalid');
 const dispatch=createInProcessGraphCustodyTransport({service,membership,ownerPublicKey,bearerToken});let closed=false;
 const transport:GraphCustodyTransport=Object.freeze({...dispatch,request:async(method:'GET'|'POST',path:string,body?:unknown)=>closed?{status:503,json:'{"code":"owned-custody-closed"}'}:dispatch.request(method,path,body)});
 const client=new GraphWitnessClient({agentId:membership.agentId,witnessId:membership.witnessId,witnessPublicKey:profile.witnessPublicKey,expectedFailureDomain:membership.failureDomain,ownerPublicKey,bearerToken:'',transport,historicalWitnessPublicKeys:options.historicalWitnessPublicKeys});
 return Object.freeze({client,transport,service,close(){if(closed)return;closed=true;service.close();}});
}

/** Real enrolled identities only. No roster supplied by a request body is authority. */
export function ownedGraphInstalledRoster(identity:MachineIdentityManager,identities:IdentityStore):GraphMembershipMember[]{
 const local=identity.loadIdentity(),registry=identity.loadRegistry(),ids=new Set(Object.entries(registry.machines).filter(([,row])=>row.status==='active'&&!row.revokedAt).map(([id])=>id));ids.add(local.machineId);
 return [...ids].sort().map(machineId=>{const member=machineId===local.machineId?local:identities.loadIdentity(machineId,'remote'),epoch=identities.getEpoch(machineId);
  if(!member||epoch.revokedAt)throw new Error('owned-custody-installed-identity-unavailable');
  return {machineId,signingPublicKey:base64ToSigningPem(member.signingPublicKey),sealingPublicKey:base64ToEncryptionPem(member.encryptionPublicKey)};
 });
}
/** Opens only under the durable owner-admitted publication and database claim.
 * Existing history never turns into a fresh installation after a missing disk. */
export function openPublishedOwnedGraphCustody(options:{stateDir:string;agentId:string;identity:MachineIdentityManager;identities:IdentityStore;ownerPublicKey:string;rolePrivateKey:crypto.KeyLike;publication:GraphCustodyBootstrapPublication;membership?:GraphMembershipEpoch;historicalWitnessPublicKeys?:Record<string,string>}):OwnedGraphCustody {
 const {stateDir,agentId,identity,identities,ownerPublicKey,publication}=options,genesis=publication.membership,membership=options.membership??genesis,profile=membership.custodyProfile,local=identity.loadIdentity(),installed=ownedGraphInstalledRoster(identity,identities);
 if(genesis.agentId!==agentId||!verifyGraphCustodyBootstrapPublication(publication,genesis.members,ownerPublicKey)||!verifyMembershipEpoch(membership,ownerPublicKey)||membership.agentId!==agentId||!profile||profile.mode!=='owned-machine'||profile.hostMachineId!==local.machineId)throw new Error('owned-custody-publication-invalid');
 // Every signed member must still be installed under its signed keys. A machine paired later holds no signed place.
 const installedById=new Map(installed.map(row=>[row.machineId,canonicalHash(row)]));if(!membership.members.every(row=>installedById.get(row.machineId)===canonicalHash(row)))throw new Error('owned-custody-installed-roster-mismatch');
 syncOwnedGraphIdentityDurably(identity,identities);
 const recoveryStore=new GraphOwnerRecoveryStore({stateDir,agentId,identity,identities});recoveryStore.put(recoveryStore.envelope(publication.admission.ownerRecoveryHash,genesis,ownerPublicKey),genesis,ownerPublicKey);
 const store=new GraphCustodyBootstrapStore(stateDir,agentId),pinned=store.publication(genesis.members);
 if(!pinned||canonicalHash(pinned)!==canonicalHash(publication))throw new Error('owned-custody-publication-not-pinned');
 const role=options.rolePrivateKey instanceof crypto.KeyObject?options.rolePrivateKey:crypto.createPrivateKey(options.rolePrivateKey);
 if(role.type!=='private'||role.asymmetricKeyType!=='ed25519'||crypto.createPublicKey(role).export({type:'spki',format:'pem'}).toString()!==profile.witnessPublicKey||identity.getSigningPublicKeyPem(local.machineId)!==profile.hostSigningPublicKey)throw new Error('owned-custody-role-key-mismatch');
 const databasePath=path.join(stateDir,'conversation-graph','custody.sqlite'),bearerToken=crypto.randomBytes(32).toString('base64url');let opened:GraphWitnessService|undefined;
 try{
  return store.openDatabase(genesis.members,local.machineId,databasePath,fresh=>{
   // Genesis may name fewer machines than are paired, because the owner chose them. Each one it names must be installed under its signed keys, which is checked above.
   if(fresh&&canonicalHash(membership)!==canonicalHash(genesis))throw new Error('owned-custody-genesis-roster-mismatch');
   const service=new DurableGraphWitnessService({databasePath,witnessId:membership.witnessId,failureDomain:membership.failureDomain,signingPrivateKey:options.rolePrivateKey,ownedHost:{machineId:local.machineId,signingPublicKey:identity.getSigningPublicKeyPem(local.machineId)!},installedFailureDomains:[profile.failureDomain],enrollments:{[agentId]:{ownerPublicKey,bearerToken}},historicalWitnessPublicKeys:options.historicalWitnessPublicKeys});opened=service;
   if(fresh)service.registerMembership(genesis);
   else if(canonicalHash(service.membershipProof(agentId,1))!==canonicalHash(genesis)||canonicalHash(service.membershipProof(agentId,membership.epoch))!==canonicalHash(membership))throw new Error('owned-custody-database-profile-mismatch');
   return attachOwnedGraphCustody({service,identity,membership,ownerPublicKey,bearerToken,historicalWitnessPublicKeys:options.historicalWitnessPublicKeys});
  });
 }catch(error){opened?.close();throw error;}
}
