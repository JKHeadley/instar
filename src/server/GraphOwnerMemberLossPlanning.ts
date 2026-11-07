/** Mechanical plan/key lookup AFTER the action service authenticates the owner.
 * This class grants no Native permission and never activates a proposed role. */
import crypto from 'node:crypto';
import {ConversationGraphDefault,GRAPH_CUSTODY_ROLE_SECRET} from './ConversationGraphDefault.js';
import type {GraphOwnerMemberLossSigningContext} from './GraphOwnerMemberLossAction.js';
import {GraphOwnerRecoveryStore} from '../core/GraphOwnerRecoveryStore.js';
import {createGraphCustodyProfile} from '../core/GraphCustodyProfile.js';
import {graphOwnedRoleSecretName} from '../core/GraphCustodyStagedRole.js';
import {GRAPH_CUSTODY_MAX_MEMBERSHIP_EPOCH} from '../core/GraphCustodyProfileAuthority.js';
import {ownedGraphInstalledRoster} from '../core/OwnedGraphCustody.js';
import {canonicalHash,exactFields,opaque,signGraphRecord,unsigned,verifyMembershipEpoch,type GraphMembershipEpoch} from '../core/GraphWitnessTypes.js';
import type {GraphOwnerMemberLossContext} from '../core/GraphOwnerMemberLoss.js';
interface Candidate {v:1;agentId:string;requestId:string;previousPublicationHash:string;previousMembershipHash:string;removedMachineIds:string[];newMembership:GraphMembershipEpoch}
export class GraphOwnerMemberLossPlanning {
 constructor(private readonly manager:ConversationGraphDefault){if(!(manager instanceof ConversationGraphDefault))throw new Error('member-loss-actual-default-required');}
 async context(removedMachineIds:readonly string[],requestId:string,expectedPlan?:GraphOwnerMemberLossContext):Promise<GraphOwnerMemberLossSigningContext>{
  if(!opaque(requestId)||!removedMachineIds.length||removedMachineIds.some(id=>!opaque(id))||new Set(removedMachineIds).size!==removedMachineIds.length)throw new Error('member-loss-plan-invalid');
  await this.manager.assertMemberLossPlanningFresh();
  const actual=this.manager.memberLossPlanningComponents(),native=this.manager.nativeDelegationDependencies;if(!actual||!native)throw new Error('member-loss-planning-runtime-unavailable');
  const {authority,publication,secrets}=actual,currentMembership=authority.currentMembership(),previous=expectedPlan?.previousMembership??currentMembership,local=native.identity.loadIdentity().machineId,removed=[...removedMachineIds].sort();
  if(previous.epoch>=GRAPH_CUSTODY_MAX_MEMBERSHIP_EPOCH||previous.custodyProfile?.mode!=='owned-machine'||removed.includes(local)||removed.some(id=>!previous.members.some(member=>member.machineId===id)))throw new Error('member-loss-plan-roster-invalid');
  if(expectedPlan){if(expectedPlan.previousPublicationHash!==canonicalHash(publication)||expectedPlan.ownerPublicKey!==authority.ownerPublicKey||!([canonicalHash(expectedPlan.previousMembership),canonicalHash(expectedPlan.newMembership)].includes(canonicalHash(currentMembership))))throw new Error('member-loss-resume-plan-changed');}
  else if(canonicalHash(ownedGraphInstalledRoster(native.identity,native.identities))!==canonicalHash([...previous.members].sort((a,b)=>a.machineId<b.machineId?-1:a.machineId>b.machineId?1:0)))throw new Error('member-loss-plan-native-roster-changed');
  const lineage=authority.verifiedNegativeRoleLineage(),activeHash=canonicalHash(previous),ordinary=lineage.activations.find(row=>canonicalHash(row.certificate.newMembership)===activeHash),loss=lineage.memberLossActivations.find(row=>canonicalHash(row.certificate.newMembership)===activeHash),recoveryHash=previous.epoch===1?publication.admission.ownerRecoveryHash:ordinary?.stage.ownerRecoveryHash??loss?.certificate.memberLoss?.ownerRecoveryHash;
  if(!recoveryHash)throw new Error('member-loss-owner-recovery-missing');const recovery=new GraphOwnerRecoveryStore({stateDir:authority.stateRoot,agentId:authority.agentId,identity:native.identity,identities:native.identities}),ownerPrivateKey=recovery.recover(recoveryHash,previous,authority.ownerPublicKey);
  const slot='conversation_graph_member_loss_candidate_'+canonicalHash({agentId:authority.agentId,requestId}),stored=secrets.get(slot) as Candidate|undefined;
  if(stored!==undefined){if(!exactFields(stored,['v','agentId','requestId','previousPublicationHash','previousMembershipHash','removedMachineIds','newMembership'])||stored.v!==1||stored.agentId!==authority.agentId||stored.requestId!==requestId||stored.previousPublicationHash!==canonicalHash(publication)||stored.previousMembershipHash!==canonicalHash(expectedPlan?.previousMembership??previous)||canonicalHash(stored.removedMachineIds)!==canonicalHash(removed)||!verifyMembershipEpoch(stored.newMembership,authority.ownerPublicKey)||expectedPlan&&canonicalHash(expectedPlan.newMembership)!==canonicalHash(stored.newMembership))throw new Error('member-loss-candidate-conflict');const privateRole=secrets.get(graphOwnedRoleSecretName(stored.newMembership));if(typeof privateRole!=='string'||crypto.createPublicKey(privateRole).export({type:'spki',format:'pem'}).toString()!==stored.newMembership.custodyProfile?.witnessPublicKey)throw new Error('member-loss-role-key-missing');secrets.syncDurably();return{authority,publication,newMembership:structuredClone(stored.newMembership),ownerPrivateKey};}
  if(expectedPlan)throw new Error('member-loss-candidate-missing');
  const members=previous.members.filter(member=>!removed.includes(member.machineId));if(!members.length)throw new Error('member-loss-survivor-required');
  const holder=native.leaseCoordinator.currentHolder();if(!holder||holder!==local&&!removed.includes(holder))throw new Error('member-loss-surviving-holder-needs-handoff');
  // First Native execution implementation requires one surviving collection.
  // A larger roster must be implemented and proved before exposing this route.
  if(members.length!==1)throw new Error('member-loss-multi-survivor-collection-required');
  const retainRole=previous.custodyProfile.hostMachineId===local,role=retainRole?null:crypto.generateKeyPairSync('ed25519'),rolePublic=retainRole?previous.custodyProfile.witnessPublicKey:role!.publicKey.export({type:'spki',format:'pem'}).toString(),createdAt=new Date().toISOString();
  const raw={v:1 as const,agentId:authority.agentId,epoch:previous.epoch+1,previousMembershipHash:canonicalHash(previous),members,writerId:local,witnessId:retainRole?previous.witnessId:'owned-loss-'+canonicalHash(rolePublic).slice(0,24),failureDomain:retainRole?previous.failureDomain:'owned-'+local,createdAt},body={...raw,custodyProfile:createGraphCustodyProfile({...raw,signature:''},{mode:'owned-machine',hostMachineId:local,witnessPublicKey:rolePublic},ownerPrivateKey)},newMembership={...body,signature:signGraphRecord('graph-membership-v1',body,ownerPrivateKey)};
  if(!verifyMembershipEpoch(newMembership,authority.ownerPublicKey))throw new Error('member-loss-candidate-invalid');
  const rolePrivate=role?role.privateKey.export({type:'pkcs8',format:'pem'}).toString():secrets.get(graphOwnedRoleSecretName(previous))??(previous.witnessId===publication.membership.witnessId?secrets.get(GRAPH_CUSTODY_ROLE_SECRET):undefined);if(typeof rolePrivate!=='string'||crypto.createPublicKey(rolePrivate).export({type:'spki',format:'pem'}).toString()!==rolePublic)throw new Error('member-loss-role-key-missing');secrets.set(graphOwnedRoleSecretName(newMembership),rolePrivate);
  const candidate:Candidate={v:1,agentId:authority.agentId,requestId,previousPublicationHash:canonicalHash(publication),previousMembershipHash:canonicalHash(previous),removedMachineIds:removed,newMembership};secrets.set(slot,candidate);secrets.syncDurably();if(canonicalHash(secrets.get(slot))!==canonicalHash(candidate))throw new Error('member-loss-candidate-readback-mismatch');return{authority,publication,newMembership,ownerPrivateKey};
 }
}
