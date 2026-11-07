/** First-use custody publication, pinned by every installed member before genesis.
 * A native lease serializes bootstrap; its holder still needs actual owner admission.
 * This store never rotates a root or treats a missing database as a new installation.
 */
import {durableStamp,isDurablyUnchanged,rememberDurable} from './GraphDurableFileMemo.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {verifyGraphOwnerRecoveryReceiptBinding,type GraphOwnerRecoveryReceipt} from './GraphOwnerRecoveryStore.js';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from './GraphLocalFiles.js';
import {canonicalHash,canonicalJson,canonicalPublicKey,exactFields,hash,iso,opaque,signGraphRecord,unsigned,
 verifyGraphRecord,verifyMembershipEpoch,verifyFencedLeaseBridge,
 type GraphMembershipEpoch,type GraphMembershipMember,type GraphWitnessLease} from './GraphWitnessTypes.js';
import type {LeaseRecord} from './types.js';

export const GRAPH_CUSTODY_BOOTSTRAP_DOMAIN='graph-custody-bootstrap-owner-admission-v1';
export const GRAPH_CUSTODY_PIN_DOMAIN='graph-custody-bootstrap-pin-v1';
export interface GraphCustodyBootstrapAdmission {
 v:1;agentId:string;principalKey:string;admissionId:string;authenticationMethod:'owner-device'|'owner-dashboard';
 requestId:string;ownerRecoveryHash:string;profileHash:string;membershipHash:string;nativeLeaseHash:string;machineId:string;acceptedAt:string;signature:string;
}
export interface GraphCustodyBootstrapPublication {
 v:1;ownerPublicKey:string;membership:GraphMembershipEpoch;lease:GraphWitnessLease;originalLease:LeaseRecord;
 admission:GraphCustodyBootstrapAdmission;
}
export interface GraphCustodyBootstrapPin {
 v:1;publicationHash:string;machineId:string;ownerRecoveryReceipt:GraphOwnerRecoveryReceipt;pinnedAt:string;signature:string;
}

/** The expected roster comes from installed enrollment, never this incoming publication.
 * Historical verification deliberately does not demand that a past lease is still live.
 * NEW publication admission separately checks current owner/lease at the caller seam.
 */
export function verifyGraphCustodyBootstrapPublication(publication:GraphCustodyBootstrapPublication,
 installed:readonly GraphMembershipMember[],expectedOwnerPublicKey?:string):boolean {
 try{
  if(!exactFields(publication,['v','ownerPublicKey','membership','lease','originalLease','admission'])||publication.v!==1
   ||!canonicalPublicKey(publication.ownerPublicKey,'ed25519')
   ||(expectedOwnerPublicKey!==undefined&&publication.ownerPublicKey!==expectedOwnerPublicKey))return false;
  const m=publication.membership,a=publication.admission;
  if(m.custodyProfile?.mode!=='owned-machine'||m.epoch!==1||m.previousMembershipHash!==null||!verifyMembershipEpoch(m,publication.ownerPublicKey)
   ||!installed.length||installed.length>64)return false;
  const roster=(rows:readonly GraphMembershipMember[])=>rows.map(row=>({machineId:row.machineId,signingPublicKey:row.signingPublicKey,sealingPublicKey:row.sealingPublicKey}))
   .sort((x,y)=>x.machineId.localeCompare(y.machineId));
  if(new Set(installed.map(row=>row.machineId)).size!==installed.length||canonicalHash(roster(installed))!==canonicalHash(roster(m.members)))return false;
  if(!exactFields(a,['v','agentId','principalKey','admissionId','authenticationMethod','requestId','ownerRecoveryHash','profileHash','membershipHash','nativeLeaseHash','machineId','acceptedAt','signature'])
   ||a.v!==1||a.agentId!==m.agentId||a.principalKey!==`owner:${m.agentId}`||!opaque(a.admissionId)
   ||!['owner-device','owner-dashboard'].includes(a.authenticationMethod)||!opaque(a.requestId)||!iso(a.acceptedAt)
   ||!hash(a.ownerRecoveryHash)||a.profileHash!==canonicalHash(m.custodyProfile)||a.membershipHash!==canonicalHash(m)
   ||a.nativeLeaseHash!==canonicalHash(publication.originalLease)||a.machineId!==m.writerId
   ||publication.lease.writerId!==a.machineId||!verifyFencedLeaseBridge(publication.lease,publication.originalLease,m))return false;
  const at=Date.parse(a.acceptedAt);
  if(at<Date.parse(publication.originalLease.acquiredAt)||at>=Date.parse(publication.originalLease.expiresAt))return false;
  const member=m.members.find(row=>row.machineId===a.machineId);
  return !!member&&verifyGraphRecord(GRAPH_CUSTODY_BOOTSTRAP_DOMAIN,unsigned(a),a.signature,member.signingPublicKey);
 }catch{ /* @silent-fallback-ok: malformed bootstrap evidence never grants first-use or replacement authority */ return false; }
}

export function verifyGraphCustodyBootstrapPin(pin:GraphCustodyBootstrapPin,publication:GraphCustodyBootstrapPublication):boolean {
 try{
  const member=publication.membership.members.find(row=>row.machineId===pin.machineId);
  return exactFields(pin,['v','publicationHash','machineId','ownerRecoveryReceipt','pinnedAt','signature'])&&pin.v===1&&!!member&&iso(pin.pinnedAt)
   &&pin.publicationHash===canonicalHash(publication)&&pin.ownerRecoveryReceipt.machineId===pin.machineId&&verifyGraphOwnerRecoveryReceiptBinding(pin.ownerRecoveryReceipt,publication.admission.ownerRecoveryHash,publication.membership,publication.ownerPublicKey)
   &&verifyGraphRecord(GRAPH_CUSTODY_PIN_DOMAIN,unsigned(pin),pin.signature,member.signingPublicKey);
 }catch{ /* @silent-fallback-ok: invalid pin is missing enrollment evidence, never an acknowledgement */ return false; }
}

/** Durable immutable pin files. Corruption and conflicting roots refuse; nothing
 * replaces a publication or silently removes an installed member to make progress.
 */
export class GraphCustodyBootstrapStore {
 private readonly directory:string;
 private readonly stateRoot:string;
 constructor(stateDir:string,private readonly agentId:string){
  if(!opaque(agentId))throw new Error('graph-bootstrap-agent-invalid');
  this.stateRoot=fs.realpathSync(stateDir);
  this.directory=path.join(this.stateRoot,'conversation-graph','bootstrap',canonicalHash(agentId));
 }
 private file(name:string){return path.join(this.directory,name+'.json');}
 private read(name:string):unknown|null{
  const file=this.file(name);
  assertGraphLocalPath(this.stateRoot,file);
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw new Error('graph-bootstrap-file-invalid');return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }
 private persist(name:string,value:unknown,exclusive=false):void{
  if(!exclusive&&isDurablyUnchanged(this.file(name))&&canonicalJson(this.read(name))===canonicalJson(value))return;
  ensureGraphLocalDirectory(this.stateRoot,this.directory);
  const dirStat=fs.lstatSync(this.directory);if(!dirStat.isDirectory()||dirStat.isSymbolicLink())throw new Error('graph-bootstrap-directory-invalid');
  // Persist newly created ancestor links too, not merely the leaf's entries.
  for(let child=this.directory;;child=path.dirname(child)){
   const parentPath=path.dirname(child);if(parentPath===child)break;
   const parentFd=fs.openSync(parentPath,'r');try{fs.fsyncSync(parentFd);}finally{fs.closeSync(parentFd);}
  }
  const bytes=canonicalJson(value);if(Buffer.byteLength(bytes)>256*1024)throw new Error('graph-bootstrap-capacity');
  const scratch=this.file(name+'.'+crypto.randomUUID()+'.pending');const fd=fs.openSync(scratch,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{try{fs.linkSync(scratch,this.file(name));}catch(error){if(exclusive||(error as NodeJS.ErrnoException).code!=='EEXIST'||canonicalJson(this.read(name))!==bytes)throw new Error('graph-bootstrap-publication-conflict');}}
  finally{SafeFsExecutor.safeUnlinkSync(scratch,{operation:'graph-bootstrap:publication-scratch'});}
  const target=this.file(name),stamp=durableStamp(target),before=fs.lstatSync(target),actual=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(actual);if(!opened.isFile()||opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('graph-bootstrap-durability-file-changed');fs.fsyncSync(actual);}finally{fs.closeSync(actual);}
  const parent=fs.openSync(this.directory,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
  if(canonicalJson(this.read(name))!==bytes)throw new Error('graph-bootstrap-durable-readback-failed');
  rememberDurable(target,stamp);
 }
 /** Read an already pinned historical genesis after an explicit roster transition.
  * The caller must supply its ORIGINAL durable publication anchor. This reader
  * never creates a publication, admits a member, or activates a successor. */
 establishedPublication(anchor:{v:1;agentId:string;publicationHash:string;ownerPublicKeyHash:string;membershipHash:string}):GraphCustodyBootstrapPublication|null{
  if(!exactFields(anchor,['v','agentId','publicationHash','ownerPublicKeyHash','membershipHash'])||anchor.v!==1||anchor.agentId!==this.agentId||![anchor.publicationHash,anchor.ownerPublicKeyHash,anchor.membershipHash].every(hash))throw new Error('graph-bootstrap-established-anchor-invalid');
  const publication=this.read('publication') as GraphCustodyBootstrapPublication|null;if(!publication)return null;
  if(canonicalHash(publication)!==anchor.publicationHash||canonicalHash(publication.ownerPublicKey)!==anchor.ownerPublicKeyHash||canonicalHash(publication.membership)!==anchor.membershipHash||publication.membership.agentId!==this.agentId||!verifyGraphCustodyBootstrapPublication(publication,publication.membership.members))throw new Error('graph-bootstrap-established-anchor-mismatch');
  return publication;
 }
 publication(installed:readonly GraphMembershipMember[]):GraphCustodyBootstrapPublication|null{
  const p=this.read('publication') as GraphCustodyBootstrapPublication|null;if(!p)return null;
  if(p.membership.agentId!==this.agentId||!verifyGraphCustodyBootstrapPublication(p,installed))throw new Error('graph-bootstrap-publication-invalid');
  return p;
 }
 pin(publication:GraphCustodyBootstrapPublication,installed:readonly GraphMembershipMember[],machineId:string,signingKey:crypto.KeyLike,ownerRecoveryReceipt:GraphOwnerRecoveryReceipt):GraphCustodyBootstrapPin{
  if(publication.membership.agentId!==this.agentId||!verifyGraphCustodyBootstrapPublication(publication,installed))throw new Error('graph-bootstrap-publication-invalid');
  const member=installed.find(row=>row.machineId===machineId);if(!member)throw new Error('graph-bootstrap-member-invalid');
  const prior=this.publication(installed);
  if(prior&&canonicalHash(prior)!==canonicalHash(publication))throw new Error('graph-bootstrap-publication-conflict');
  const priorPin=this.read('pin-'+canonicalHash(machineId)) as GraphCustodyBootstrapPin|null;
  if(priorPin){if(!verifyGraphCustodyBootstrapPin(priorPin,publication))throw new Error('graph-bootstrap-pin-invalid');this.persist('publication',publication);this.persist('pin-'+canonicalHash(machineId),priorPin);return priorPin;}
  const raw={v:1 as const,publicationHash:canonicalHash(publication),machineId,ownerRecoveryReceipt,pinnedAt:new Date().toISOString()};
  const pin={...raw,signature:signGraphRecord(GRAPH_CUSTODY_PIN_DOMAIN,raw,signingKey)};
  if(!verifyGraphCustodyBootstrapPin(pin,publication))throw new Error('graph-bootstrap-signer-invalid');
  // Validate our actual signing key before allowing even a first durable pin.
  this.persist('publication',publication);
  this.persist('pin-'+canonicalHash(machineId),pin);return pin;
 }
 receivePin(pin:GraphCustodyBootstrapPin,installed:readonly GraphMembershipMember[]):void{
  const publication=this.publication(installed);if(!publication||!verifyGraphCustodyBootstrapPin(pin,publication))throw new Error('graph-bootstrap-pin-invalid');
  const name='pin-'+canonicalHash(pin.machineId),prior=this.read(name) as GraphCustodyBootstrapPin|null;
  if(prior){if(!verifyGraphCustodyBootstrapPin(prior,publication))throw new Error('graph-bootstrap-pin-invalid');this.persist(name,prior);return;}
  this.persist(name,pin);
 }
 pins(installed:readonly GraphMembershipMember[]):GraphCustodyBootstrapPin[]{
  const publication=this.publication(installed);if(!publication)return [];
  return publication.membership.members.flatMap(member=>{const pin=this.read('pin-'+canonicalHash(member.machineId)) as GraphCustodyBootstrapPin|null;if(!pin)return [];if(!verifyGraphCustodyBootstrapPin(pin,publication))throw new Error('graph-bootstrap-pin-invalid');return [pin];});
 }
 waitingMembers(installed:readonly GraphMembershipMember[]):string[]{
  const publication=this.publication(installed);if(!publication)return installed.map(row=>row.machineId);
  return publication.membership.members.filter(member=>{
   const pin=this.read('pin-'+canonicalHash(member.machineId)) as GraphCustodyBootstrapPin|null;
   if(pin&&!verifyGraphCustodyBootstrapPin(pin,publication))throw new Error('graph-bootstrap-pin-invalid');return !pin;
  }).map(row=>row.machineId);
 }
 /** One-shot database creation permit, durably consumed BEFORE SQLite creation.
  * An interrupted claim requires authenticated recovery, never blank reinitialization.
  * This is not old-backup freshness proof; runtime restore fencing remains mandatory.
  */
 openDatabase<T>(installed:readonly GraphMembershipMember[],machineId:string,databasePath:string,open:(fresh:boolean)=>T):T{
  const publication=this.publication(installed);
  if(!publication||this.waitingMembers(installed).length)throw new Error('graph-bootstrap-pins-pending');
  if(publication.membership.custodyProfile?.mode!=='owned-machine'||publication.membership.custodyProfile.hostMachineId!==machineId)throw new Error('graph-bootstrap-host-invalid');
  assertGraphLocalPath(this.stateRoot,path.join(fs.realpathSync(path.dirname(databasePath)),path.basename(databasePath)));
  const expected={v:1,publicationHash:canonicalHash(publication),databasePath:path.resolve(databasePath)};
  const claim=this.read('database-claim'),ready=this.read('database-ready');
  if(claim){
   if(canonicalJson(claim)!==canonicalJson(expected)||canonicalJson(ready)!==canonicalJson(expected))throw new Error('graph-bootstrap-restore-quarantine');
   const stat=fs.lstatSync(databasePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0)throw new Error('graph-bootstrap-restore-quarantine');
   return open(false);
  }
  if(ready||fs.existsSync(databasePath))throw new Error('graph-bootstrap-unpublished-database');
  this.persist('database-claim',expected,true);
  const result=open(true),stat=fs.lstatSync(databasePath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0)throw new Error('graph-bootstrap-initialization-failed');
  const fd=fs.openSync(databasePath,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  this.persist('database-ready',expected);return result;
 }
}
