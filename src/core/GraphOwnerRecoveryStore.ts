/** Detached encrypted authority recovery copies; no app plaintext or keys in
 * certificates. A member signs only after actual fsync/reload/self-decryption. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {MachineIdentityManager} from './MachineIdentity.js';
import {IdentityStore} from './IdentityStore.js';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {ensureGraphLocalDirectory,assertGraphLocalPath} from './GraphLocalFiles.js';
import {syncOwnedGraphIdentityDurably} from './GraphCustodyDurability.js';
import {verifyGraphOwnerRecoveryEnvelope,recoverGraphOwnerControl,type GraphOwnerRecoveryEnvelope} from './GraphOwnerRecovery.js';
import {canonicalHash,canonicalJson,exactFields,iso,hash,unsigned,signGraphRecord,verifyGraphRecord,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
export const GRAPH_OWNER_RECOVERY_RECEIPT_DOMAIN='graph-owner-control-recovery-durable-v1';
export interface GraphOwnerRecoveryReceipt {v:1;agentId:string;envelopeHash:string;membershipHash:string;profileHash:string;ownerPublicKeyHash:string;machineId:string;storedAt:string;signature:string}
export function verifyGraphOwnerRecoveryReceiptBinding(value:GraphOwnerRecoveryReceipt,envelopeHash:string,membership:GraphMembershipEpoch,ownerPublicKey:string):boolean{
 try{const member=membership.members.find(row=>row.machineId===value.machineId);return exactFields(value,['v','agentId','envelopeHash','membershipHash','profileHash','ownerPublicKeyHash','machineId','storedAt','signature'])&&value.v===1&&!!member&&hash(envelopeHash)&&value.agentId===membership.agentId&&value.envelopeHash===envelopeHash&&value.membershipHash===canonicalHash(membership)&&value.profileHash===canonicalHash(membership.custodyProfile)&&value.ownerPublicKeyHash===canonicalHash(ownerPublicKey)&&iso(value.storedAt)&&verifyGraphRecord(GRAPH_OWNER_RECOVERY_RECEIPT_DOMAIN,unsigned(value),value.signature,member.signingPublicKey);}catch{ /* @silent-fallback-ok: invalid recovery receipt never credits durable root custody */ return false; }
}
export function verifyGraphOwnerRecoveryReceipt(value:GraphOwnerRecoveryReceipt,envelope:GraphOwnerRecoveryEnvelope,membership:GraphMembershipEpoch):boolean{return verifyGraphOwnerRecoveryReceiptBinding(value,canonicalHash(envelope),membership,envelope.ownerPublicKey);}
export class GraphOwnerRecoveryStore {
 private readonly root:string;private readonly directory:string;
 constructor(private readonly options:{stateDir:string;agentId:string;identity:MachineIdentityManager;identities:IdentityStore}){
  if(!(options.identity instanceof MachineIdentityManager)||!(options.identities instanceof IdentityStore))throw new Error('graph-owner-recovery-enrollment-required');this.root=fs.realpathSync(options.stateDir);this.directory=path.join(this.root,'conversation-graph','owner-control-recovery',canonicalHash(options.agentId));this.assertNativeScope();
 }
 private assertNativeScope():void{const {identity,identities}=this.options,epoch=identities.epochPath;if(fs.realpathSync(this.options.stateDir)!==this.root||fs.realpathSync(identity.baseDir)!==this.root||path.basename(epoch)!=='identity-epochs.json'||path.basename(path.dirname(epoch))!=='state'||fs.realpathSync(path.dirname(path.dirname(epoch)))!==this.root)throw new Error('graph-owner-recovery-home-mismatch');assertGraphLocalPath(this.root,path.join(this.root,'state','identity-epochs.json'));}
 private file(digest:string,receipt=false){this.assertNativeScope();if(!hash(digest))throw new Error('graph-owner-recovery-hash-invalid');const file=path.join(this.directory,digest+(receipt?'.receipt.json':'.envelope.json'));assertGraphLocalPath(this.root,file);return file;}
 private read(file:string):unknown|null{try{assertGraphLocalPath(this.root,file);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error('graph-owner-recovery-file-invalid');return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
 private persist(file:string,value:unknown){ensureGraphLocalDirectory(this.root,this.directory);const bytes=canonicalJson(value);if(Buffer.byteLength(bytes)>65536)throw new Error('graph-owner-recovery-capacity');const temporary=file+'.'+crypto.randomUUID()+'.pending';assertGraphLocalPath(this.root,temporary);const descriptor=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(descriptor,bytes);fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
  try{try{fs.linkSync(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||canonicalJson(this.read(file))!==bytes)throw new Error('graph-owner-recovery-conflict');}}finally{SafeFsExecutor.safeUnlinkSync(temporary,{operation:'graph-owner-recovery:publication-scratch'});}
  const before=fs.lstatSync(file),actual=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(actual);if(!opened.isFile()||opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('graph-owner-recovery-durability-changed');fs.fsyncSync(actual);}finally{fs.closeSync(actual);}
  for(let directory=this.directory;;directory=path.dirname(directory)){const descriptor=fs.openSync(directory,'r');try{fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}if(path.dirname(directory)===directory)break;}
 }
 private self(membership:GraphMembershipEpoch){this.assertNativeScope();const identity=this.options.identity.loadIdentity(),member=membership.members.find(row=>row.machineId===identity.machineId),epoch=this.options.identities.getEpoch(identity.machineId);
  if(!member||epoch.revokedAt||this.options.identity.getSigningPublicKeyPem(identity.machineId)!==member.signingPublicKey||this.options.identity.getEncryptionPublicKeyPem(identity.machineId)!==member.sealingPublicKey)throw new Error('graph-owner-recovery-recipient-not-current');return identity.machineId;
 }
 put(envelope:GraphOwnerRecoveryEnvelope,membership:GraphMembershipEpoch,ownerPublicKey:string):GraphOwnerRecoveryReceipt{
  if(membership.agentId!==this.options.agentId||!verifyGraphOwnerRecoveryEnvelope(envelope,membership,ownerPublicKey))throw new Error('graph-owner-recovery-evidence-invalid');const machineId=this.self(membership);
  // Check before writing and AGAIN from the actual retained bytes after fsync.
  recoverGraphOwnerControl(envelope,membership,ownerPublicKey,machineId,this.options.identity.loadEncryptionKey());syncOwnedGraphIdentityDurably(this.options.identity,this.options.identities);
  const digest=canonicalHash(envelope);this.persist(this.file(digest),envelope);const reloaded=this.read(this.file(digest));if(!verifyGraphOwnerRecoveryEnvelope(reloaded,membership,ownerPublicKey)||canonicalHash(reloaded)!==digest)throw new Error('graph-owner-recovery-readback-invalid');recoverGraphOwnerControl(reloaded,membership,ownerPublicKey,machineId,this.options.identity.loadEncryptionKey());
  const prior=this.read(this.file(digest,true)) as GraphOwnerRecoveryReceipt|null;if(prior){if(!verifyGraphOwnerRecoveryReceipt(prior,envelope,membership)||prior.machineId!==machineId)throw new Error('graph-owner-recovery-receipt-invalid');this.persist(this.file(digest,true),prior);const retained=this.read(this.file(digest,true)) as GraphOwnerRecoveryReceipt;if(!verifyGraphOwnerRecoveryReceipt(retained,envelope,membership)||canonicalHash(retained)!==canonicalHash(prior))throw new Error('graph-owner-recovery-receipt-readback-invalid');if(this.self(membership)!==machineId)throw new Error('graph-owner-recovery-recipient-not-current');return retained;}
  const raw={v:1 as const,agentId:this.options.agentId,envelopeHash:digest,membershipHash:canonicalHash(membership),profileHash:envelope.profileHash,ownerPublicKeyHash:canonicalHash(ownerPublicKey),machineId,storedAt:new Date().toISOString()},receipt={...raw,signature:signGraphRecord(GRAPH_OWNER_RECOVERY_RECEIPT_DOMAIN,raw,this.options.identity.loadSigningKey())};this.persist(this.file(digest,true),receipt);const retained=this.read(this.file(digest,true)) as GraphOwnerRecoveryReceipt;if(!verifyGraphOwnerRecoveryReceipt(retained,envelope,membership)||retained.machineId!==machineId||canonicalHash(retained)!==canonicalHash(receipt))throw new Error('graph-owner-recovery-receipt-readback-invalid');if(this.self(membership)!==machineId)throw new Error('graph-owner-recovery-recipient-not-current');return retained;
 }
 envelope(digest:string,membership:GraphMembershipEpoch,ownerPublicKey:string):GraphOwnerRecoveryEnvelope{
  const value=this.read(this.file(digest));if(!verifyGraphOwnerRecoveryEnvelope(value,membership,ownerPublicKey)||canonicalHash(value)!==digest)throw new Error('graph-owner-recovery-evidence-missing');return value;
 }
 /** Internal only: HTTP recovery must first authorize actual owner and native stage. */
 recover(digest:string,membership:GraphMembershipEpoch,ownerPublicKey:string):crypto.KeyObject{return recoverGraphOwnerControl(this.envelope(digest,membership,ownerPublicKey),membership,ownerPublicKey,this.self(membership),this.options.identity.loadEncryptionKey());}
}
