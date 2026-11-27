/** Feature-scoped owner-control recovery, sealed only to installed member keys.
 * Application erasure never embeds these authority envelopes in immutable cores.
 * Decryption is internal capability; an actual owner-admitted recovery caller
 * must authorize its transient use. No root is invented if material is missing. */
import crypto from 'node:crypto';
import {sealGraphBundle,openGraphBundle} from './GraphWitnessCrypto.js';
import {canonicalHash,canonicalJson,exactFields,verifyEncryptedBundle,verifyMembershipEpoch,verifyGraphRecord,signGraphRecord,unsigned,type GraphMembershipEpoch,type GraphEncryptedBundle} from './GraphWitnessTypes.js';
export const GRAPH_OWNER_RECOVERY_DOMAIN='graph-owner-control-recovery-v1';
export interface GraphOwnerRecoveryEnvelope {
 v:1;agentId:string;membershipHash:string;profileHash:string;ownerPublicKey:string;bundle:GraphEncryptedBundle;signature:string;
}
function context(membership:GraphMembershipEpoch){return{agentId:membership.agentId,eventId:'owner-control-recovery:'+canonicalHash(membership)};}
export function createGraphOwnerRecoveryEnvelope(ownerPrivateKey:crypto.KeyLike,membership:GraphMembershipEpoch):GraphOwnerRecoveryEnvelope {
 const key=ownerPrivateKey instanceof crypto.KeyObject?ownerPrivateKey:crypto.createPrivateKey(ownerPrivateKey);
 if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')throw new Error('graph-owner-recovery-key-invalid');
 const ownerPublicKey=crypto.createPublicKey(key).export({type:'spki',format:'pem'}).toString();
 if(!membership.custodyProfile||membership.custodyProfile.mode!=='owned-machine'||!verifyMembershipEpoch(membership,ownerPublicKey))throw new Error('graph-owner-recovery-membership-invalid');
 const header={v:1 as const,agentId:membership.agentId,membershipHash:canonicalHash(membership),profileHash:canonicalHash(membership.custodyProfile),ownerPublicKey};
 const plaintext=Buffer.from(canonicalJson({...header,purpose:'owned-custody-owner-control',privateKey:key.export({type:'pkcs8',format:'pem'}).toString()}));
 try{const raw={...header,bundle:sealGraphBundle(plaintext,membership.members,context(membership))};return{...raw,signature:signGraphRecord(GRAPH_OWNER_RECOVERY_DOMAIN,raw,key)};}finally{plaintext.fill(0);}
}
export function verifyGraphOwnerRecoveryEnvelope(raw:unknown,membership:GraphMembershipEpoch,ownerPublicKey:string):raw is GraphOwnerRecoveryEnvelope {
 try{const value=raw as GraphOwnerRecoveryEnvelope;return exactFields(value,['v','agentId','membershipHash','profileHash','ownerPublicKey','bundle','signature'])&&value.v===1&&value.agentId===membership.agentId&&value.membershipHash===canonicalHash(membership)&&!!membership.custodyProfile&&membership.custodyProfile.mode==='owned-machine'&&value.profileHash===canonicalHash(membership.custodyProfile)&&value.ownerPublicKey===ownerPublicKey&&verifyMembershipEpoch(membership,ownerPublicKey)&&verifyEncryptedBundle(value.bundle,membership)&&Buffer.byteLength(canonicalJson(value))<=65536&&verifyGraphRecord(GRAPH_OWNER_RECOVERY_DOMAIN,unsigned(value),value.signature,ownerPublicKey);
 }catch{ /* @silent-fallback-ok: malformed recovery material is invalid authority, never permission to create another root */ return false; }
}
/** Returns an actual private KeyObject only after authenticating the exact
 * owner root and self-only decryption capability; this grants no HTTP admission. */
export function recoverGraphOwnerControl(envelope:GraphOwnerRecoveryEnvelope,membership:GraphMembershipEpoch,ownerPublicKey:string,machineId:string,sealingPrivateKey:crypto.KeyLike):crypto.KeyObject {
 if(!verifyGraphOwnerRecoveryEnvelope(envelope,membership,ownerPublicKey)||!membership.members.some(member=>member.machineId===machineId))throw new Error('graph-owner-recovery-evidence-invalid');
 const plaintext=openGraphBundle(envelope.bundle,machineId,sealingPrivateKey,context(membership));
 try{const value=JSON.parse(plaintext.toString('utf8')) as {v:1;agentId:string;membershipHash:string;profileHash:string;ownerPublicKey:string;purpose:string;privateKey:string};
  if(plaintext.length>4096||!exactFields(value,['v','agentId','membershipHash','profileHash','ownerPublicKey','purpose','privateKey'])||value.v!==1||value.agentId!==membership.agentId||value.membershipHash!==envelope.membershipHash||value.profileHash!==envelope.profileHash||value.ownerPublicKey!==ownerPublicKey||value.purpose!=='owned-custody-owner-control'||typeof value.privateKey!=='string')throw new Error('graph-owner-recovery-plaintext-invalid');
  const key=crypto.createPrivateKey(value.privateKey);if(key.asymmetricKeyType!=='ed25519'||key.export({type:'pkcs8',format:'pem'}).toString()!==value.privateKey||crypto.createPublicKey(key).export({type:'spki',format:'pem'}).toString()!==ownerPublicKey)throw new Error('graph-owner-recovery-root-mismatch');return key;
 }finally{plaintext.fill(0);}
}
