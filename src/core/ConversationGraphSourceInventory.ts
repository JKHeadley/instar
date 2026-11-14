/** Conversations v3 §7.2/§7.5: witnessed source inventory, separate from GraphEvent.
 * Observation proves an actual server-owned flat row, never placement or owner
 * authority. Display bytes and the exact machine-local open alias stay erasable.
 */
import crypto from 'node:crypto';
import {reconcileGraphSourceCoverage,type GraphSourceInventoryCoverage} from './ConversationGraphSourceCoverage.js';
import fs from 'node:fs';
import path from 'node:path';
import {localConversationListPage,listCursorFor,type MobileConversationRouteDeps,type ConversationListRow} from '../server/mobileConversationRoutes.js';
import {validateNodeRef,nodeKey,type ConversationRef,type ConversationSource} from './conversationGraph.js';
import {canonicalHash,canonicalJson,exactFields,hash,iso,opaque,graphOperationKey,signGraphRecord,unsigned,verifyGraphRecord,verifyMembershipEpoch,verifyFencedLeaseBridge,
 type GraphMembershipEpoch,type GraphEncryptedBundle,type GraphWitnessLease} from './GraphWitnessTypes.js';
import {validateGraphErasureIdentity,type GraphErasureIdentity} from './GraphWitnessTypes.js';
import {sealGraphBundle,openGraphBundle} from './GraphWitnessCrypto.js';
import type {MachineIdentityManager} from './MachineIdentity.js';
import type {ConversationRegistry} from './ConversationRegistry.js';
import type {WriteAdmission} from './WriteAdmission.js';
import type {LeaseCoordinator} from './LeaseCoordinator.js';
import type {ConversationGraphReplication,ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
import type {ReplicatedStoreReader} from './ReplicatedStoreReader.js';
import type {DroppedOriginRegistry} from './RollbackUnmerge.js';
import type {GraphAuthorizationProof,GraphAuthorizationReceipt} from './ConversationGraphReplicationProof.js';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {ConversationGraphLocalErasureFence} from './ConversationGraphLocalErasure.js';
import {validateGraphSourceSweepCore,verifyGraphSourceSweepCapture,verifyGraphSourceSweepCoreSource,validateGraphSourceSweepPlaintext,sourceSweepEventId,
 type SignedGraphSourceSweepCheckpoint,type CapturedGraphSourceSweepCheckpoint,type GraphSourceSweepCore} from './ConversationGraphSourceSweep.js';

const DOMAIN='graph-source-observation-v1';
const PAYLOAD_DOMAIN='graph-source-observation-payload-v1';
export interface SignedGraphSourceObservation {
 version:1;kind:'conversation-source-observation';agentId:string;sourceId:string;subject:ConversationRef;
 producerMachineId:string;producerSequence:number;membershipEpoch:number;membershipHash:string;capturedAt:string;payloadHash:string;signature:string;
}
export interface GraphSourceObservationCore {
 schemaVersion:1;op:'observe-conversation-source';eventId:string;subject:ConversationRef;authority:'source';principal:'server-source-observer';
 receipt:{kind:'source-observation-record';id:string};machineId:string;createdAt:string;payloadHash:string;
}
/** No transcript/preview or claimed owner role is part of inventory. */
export type GraphSourceFlatRow=Pick<ConversationListRow,'id'|'platform'|'title'|'lastActivity'|'machine'>;
/** How old a signed activity time may get before one new record refreshes it. */
export const GRAPH_SOURCE_ACTIVITY_REFRESH_MS=7*24*60*60*1000;
/** Every record is permanent and a removal carries them all, so a new message
 * must not add one. Only a real change of the row, or an activity time that has
 * fallen a week behind, does. This machine's live activity reaches the read
 * through `noteLocalActivity`, so ordering does not wait for a record. */
export function graphSourceRowUnchanged(prior:GraphSourceFlatRow,row:GraphSourceFlatRow):boolean{
 const {lastActivity:priorActivity,...priorRest}=prior,{lastActivity:activity,...rest}=row;
 if(canonicalJson(priorRest)!==canonicalJson(rest))return false;
 if(!activity||priorActivity===activity)return true;if(!priorActivity)return false;
 return Date.parse(activity)-Date.parse(priorActivity)<GRAPH_SOURCE_ACTIVITY_REFRESH_MS;
}
export interface GraphSourceObservationPayload {v:1;salt:string;sourceId:string;subject:ConversationRef;producerMachineId:string;producerSequence:number;row:GraphSourceFlatRow}
export interface CapturedGraphSourceObservation {capture:SignedGraphSourceObservation;encryptedPayload:GraphEncryptedBundle}
export type SignedGraphSourceOperation=SignedGraphSourceObservation|SignedGraphSourceSweepCheckpoint;
export type CapturedGraphSourceOperation=CapturedGraphSourceObservation|CapturedGraphSourceSweepCheckpoint;
export function validateGraphSourceOperationCore(raw:unknown):GraphSourceObservationCore|GraphSourceSweepCore|null{return validateGraphSourceObservationCore(raw)??validateGraphSourceSweepCore(raw);}
export function verifyGraphSourceOperationCapture(raw:unknown,membership:GraphMembershipEpoch):raw is SignedGraphSourceOperation{return verifyGraphSourceObservationCapture(raw,membership)||verifyGraphSourceSweepCapture(raw,membership);}
export const sourceObservationEventId=(sourceId:string)=>`source-observation-${sourceId}`;
function conversationRef(raw:unknown):raw is ConversationRef {const ref=validateNodeRef(raw);return !!ref&&ref.kind==='conversation'&&canonicalHash(ref)===canonicalHash(raw);}
export function validateGraphSourceObservationCore(raw:unknown):GraphSourceObservationCore|null {
 try{const c=raw as GraphSourceObservationCore;
  return exactFields(c,['schemaVersion','op','eventId','subject','authority','principal','receipt','machineId','createdAt','payloadHash'])
   &&c.schemaVersion===1&&c.op==='observe-conversation-source'&&opaque(c.eventId)&&conversationRef(c.subject)&&c.authority==='source'
   &&c.principal==='server-source-observer'&&exactFields(c.receipt,['kind','id'])&&c.receipt.kind==='source-observation-record'
   &&opaque(c.receipt.id)&&c.eventId===sourceObservationEventId(c.receipt.id)&&opaque(c.machineId)&&iso(c.createdAt)&&hash(c.payloadHash)?c:null;
 }catch{/* @silent-fallback-ok: strict source schema parser refuses malformed input with explicit null. */return null;}
}
export function verifyGraphSourceObservationCapture(raw:unknown,membership:GraphMembershipEpoch):raw is SignedGraphSourceObservation {
 try{const c=raw as SignedGraphSourceObservation;const producer=membership.members.find(m=>m.machineId===c.producerMachineId);
  return exactFields(c,['version','kind','agentId','sourceId','subject','producerMachineId','producerSequence','membershipEpoch','membershipHash','capturedAt','payloadHash','signature'])
   &&c.version===1&&c.kind==='conversation-source-observation'&&c.agentId===membership.agentId&&opaque(c.sourceId)&&opaque(sourceObservationEventId(c.sourceId))&&conversationRef(c.subject)
   &&!!producer&&Number.isSafeInteger(c.producerSequence)&&c.producerSequence>0&&c.membershipEpoch===membership.epoch&&c.membershipHash===canonicalHash(membership)&&iso(c.capturedAt)&&hash(c.payloadHash)
   &&verifyGraphRecord(DOMAIN,unsigned(c),c.signature,producer.signingPublicKey);
 }catch{/* @silent-fallback-ok: source signature/payload predicate refuses invalid evidence; no source receipt or coverage is granted. */return false;}
}
/** Called only after the common proof verifier pins owner-signed membership and
 * the separately accepting writer's native lease. No display bytes in proof. */
export function verifyGraphSourceObservationCoreSource(core:unknown,raw:unknown,membership:GraphMembershipEpoch,currentWriterId:string):boolean {
 if((raw as {kind?:unknown}|null)?.kind==='source-inventory-sweep')return verifyGraphSourceSweepCoreSource(core,raw,membership,currentWriterId);
 const c=validateGraphSourceObservationCore(core);
 return !!c&&verifyGraphSourceObservationCapture(raw,membership)&&c.machineId===currentWriterId
  &&c.receipt.id===raw.sourceId&&c.payloadHash===raw.payloadHash&&c.createdAt===raw.capturedAt&&nodeKey(c.subject)===nodeKey(raw.subject);
}
function payloadHash(payload:GraphSourceObservationPayload):string{return canonicalHash({domain:PAYLOAD_DOMAIN,payload});}
function validRow(row:GraphSourceFlatRow,ref:ConversationRef,producer:string):boolean {
 if(!exactFields(row,['id','platform','title','lastActivity',...(Object.hasOwn(row,'machine')?['machine']:[])])||row.platform!==ref.platform
  ||(row.title!==null&&(typeof row.title!=='string'||row.title.length>1024))||(row.lastActivity!==null&&!iso(row.lastActivity))
  ||(Object.hasOwn(row,'machine')&&row.machine!==null&&!opaque(row.machine)))return false;
 if(ref.platform==='telegram')return typeof row.id==='number'&&row.id===ref.topicId;
 if(ref.platform==='app')return typeof row.id==='string'&&row.id===ref.conversationKey;
 return typeof row.id==='number'&&Number.isSafeInteger(row.id)&&row.id<0&&row.machine===producer;
}
export function validateGraphSourceObservationPayload(raw:unknown,capture:SignedGraphSourceObservation):GraphSourceObservationPayload|null {
 try{const p=raw as GraphSourceObservationPayload;
  return exactFields(p,['v','salt','sourceId','subject','producerMachineId','producerSequence','row'])&&p.v===1&&typeof p.salt==='string'&&/^[0-9a-f]{64}$/.test(p.salt)
   &&p.sourceId===capture.sourceId&&conversationRef(p.subject)&&nodeKey(p.subject)===nodeKey(capture.subject)
   &&p.producerMachineId===capture.producerMachineId&&Number.isSafeInteger(p.producerSequence)&&p.producerSequence>0&&p.producerSequence===capture.producerSequence&&validRow(p.row,p.subject,p.producerMachineId)&&payloadHash(p)===capture.payloadHash?p:null;
 }catch{/* @silent-fallback-ok: strict source schema parser refuses malformed input with explicit null. */return null;}
}
export function validateGraphSourceObservationPlaintext(raw:unknown,capture:SignedGraphSourceObservation):boolean {
 try{const body=raw as {sourceObservation:unknown;payload:unknown};return exactFields(body,['sourceObservation','payload'])
  &&canonicalHash(body.sourceObservation)===canonicalHash(capture)&&validateGraphSourceObservationPayload(body.payload,capture)!==null;}catch{/* @silent-fallback-ok: source signature/payload predicate refuses invalid evidence; no source receipt or coverage is granted. */return false;}
}
export function validateGraphSourceOperationPlaintext(raw:unknown,capture:SignedGraphSourceOperation):boolean {
 return capture.kind==='source-inventory-sweep'?validateGraphSourceSweepPlaintext(raw,capture):validateGraphSourceObservationPlaintext(raw,capture);
}
function read(file:string):unknown {const fd=fs.openSync(file,'r');try{const size=fs.fstatSync(fd).size;if(size<2||size>128*1024)throw new Error('source-inventory-record-size');
 const bytes=Buffer.alloc(size+1);const count=fs.readSync(fd,bytes,0,bytes.length,0);if(count!==size)throw new Error('source-inventory-record-changed');return JSON.parse(bytes.subarray(0,count).toString());}finally{fs.closeSync(fd);}}
function write(file:string,value:unknown):void {fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${crypto.randomUUID()}.tmp`;const fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
function sourceInventoryFence(stateDir:string,agentId:string,ref:ConversationRef):string {
 return path.join(stateDir,'state','conversation-graph-source-observations',`erased-${canonicalHash({agentId,subject:ref})}.json`);
}
/** A durable denial fence. Its presence never grants visibility or authority. */
export function graphSourceObservationIsErased(stateDir:string,agentId:string,ref:ConversationRef,localErasure?:ConversationGraphLocalErasureFence):boolean {
 return fs.existsSync(sourceInventoryFence(stateDir,agentId,ref))||(localErasure??new ConversationGraphLocalErasureFence(stateDir)).isDenied({sourceKind:'conversation-metadata',sourceId:canonicalHash(ref)});
}
/** Privacy-first local intent, independent of network/witness availability.
 * The actual durable deny-fence class is required; no claimed wire boolean can
 * authorize cache deletion or resurrect a source. Every producer alias is purged. */
export function purgeLocallyDeniedGraphSourceObservationCache(options:{stateDir:string;agentId:string;target:GraphErasureIdentity;fence:ConversationGraphLocalErasureFence}):{removed:number} {
 if(!(options.fence instanceof ConversationGraphLocalErasureFence)||!validateGraphErasureIdentity(options.target)||!options.fence.isDenied(options.target))throw new Error('source-inventory-local-denial-required');
 if(options.target.sourceKind!=='conversation-metadata')return {removed:0};
 const directory=path.join(options.stateDir,'state','conversation-graph-source-observations');if(!fs.existsSync(directory))return {removed:0};
 const files=fs.readdirSync(directory);if(files.length>20000)throw new Error('source-inventory-erasure-scan-limit');let removed=0;
 for(const name of files){
  const temporary=/^[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/.test(name);
  if(/^erased-[0-9a-f]{64}\.json$/.test(name))continue;const file=path.join(directory,name);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('source-inventory-cache-inspection-unavailable');
  // Torn temporary cache writes are disposable and cannot be classified by a
  // complete signed capture. They never represent an accepted source record.
  if(temporary){SafeFsExecutor.safeUnlinkSync(file,{operation:'conversation-graph:erase-observation-cache-temporary'});removed++;continue;}
  const cached=read(file) as CapturedGraphSourceObservation;
  if(cached.capture?.agentId!==options.agentId||!conversationRef(cached.capture.subject)||canonicalHash(cached.capture.subject)!==options.target.sourceId)continue;
  write(sourceInventoryFence(options.stateDir,options.agentId,cached.capture.subject),{v:1,agentId:options.agentId,subject:cached.capture.subject,target:options.target,locallyDenied:true});
  SafeFsExecutor.safeUnlinkSync(file,{operation:'conversation-graph:erase-locally-denied-observation-cache'});removed++;
 }
 const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {removed};
}
/** Independent physical-cache inspection after purge. No counter or claimed
 * success flag substitutes for opening every owned file, including temp/link
 * aliases. Sequence ledger metadata lives outside this erasable-body scope. */
export function assertGraphSourceObservationCachePurged(options:{stateDir:string;agentId:string;target:GraphErasureIdentity;fence:ConversationGraphLocalErasureFence}):string {
 if(!(options.fence instanceof ConversationGraphLocalErasureFence)||!validateGraphErasureIdentity(options.target)||!options.fence.isDenied(options.target))throw new Error('source-inventory-local-denial-required');
 const scope={v:1,engine:'source-observation-cache',agentId:options.agentId,target:options.target};
 if(options.target.sourceKind!=='conversation-metadata')return canonicalHash({...scope,files:[],notApplicable:true});
 const directory=path.join(options.stateDir,'state','conversation-graph-source-observations'),inspected:Array<{nameHash:string;hash:string}>=[];
 if(fs.existsSync(directory)){
  const names=fs.readdirSync(directory).sort();if(names.length>20000)throw new Error('source-inventory-erasure-scan-limit');
  for(const name of names){const file=path.join(directory,name),stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink())throw new Error('source-inventory-cache-inspection-unavailable');
   const raw=read(file),cached=raw as Partial<CapturedGraphSourceObservation>;
   if(cached.encryptedPayload!==undefined){const c=cached.capture;
    if(!c||!conversationRef(c.subject)||typeof c.agentId!=='string')throw new Error('source-inventory-cache-unclassified');
    if(c.agentId===options.agentId&&canonicalHash(c.subject)===options.target.sourceId)throw new Error('source-inventory-cache-body-retained');
   }else if(!exactFields(raw,['v','agentId','subject','target','locallyDenied'])&&!exactFields(raw,['v','agentId','subject','producerMachineId','sourceId','sourceBundleHash','erasure']))throw new Error('source-inventory-cache-unclassified');
   inspected.push({nameHash:canonicalHash(name),hash:canonicalHash(raw)});
  }
 }
 if(!options.fence.isDenied(options.target))throw new Error('source-inventory-local-denial-required');
 return canonicalHash({...scope,files:inspected});
}
export function purgeGraphSourceObservationCache(options:{stateDir:string;agentId:string;record:ConversationGraphReplicationRecord;source:ConversationGraphReplication}):{fenced:boolean;removed:number} {
 const {record,source}=options;
  const core=validateGraphSourceObservationCore(record.core),capture=record.authorizationProof.sourceObservation;
  if(!core||!capture||record.packet.agentId!==options.agentId||!record.erasure||!source.verifyHistoricalRecord(record)
   ||!verifyGraphSourceObservationCoreSource(core,capture,record.authorizationProof.membership,record.packet.writerId))throw new Error('source-inventory-verified-erasure-required');
  write(sourceInventoryFence(options.stateDir,options.agentId,core.subject),{v:1,agentId:options.agentId,subject:core.subject,producerMachineId:capture.producerMachineId,
   sourceId:capture.sourceId,sourceBundleHash:record.packet.sourceBundleHash,erasure:record.erasure});
  const directory=path.dirname(sourceInventoryFence(options.stateDir,options.agentId,core.subject));let removed=0;
  const files=fs.readdirSync(directory);if(files.length>20000)throw new Error('source-inventory-erasure-scan-limit');
  for(const name of files){if(!/^[0-9a-f]{64}\.json$/.test(name))continue;const file=path.join(directory,name);const cached=read(file) as CapturedGraphSourceObservation;
   // Purge every cached alias of this canonical source, not only the last
   // observed alias. Cache records are encrypted; signatures do not grant reads.
   if(cached.capture?.agentId===options.agentId
    &&conversationRef(cached.capture.subject)&&nodeKey(cached.capture.subject)===nodeKey(core.subject)){
    SafeFsExecutor.safeUnlinkSync(file,{operation:'conversation-graph:erase-observation-cache'});removed++;
   }
  }
  const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {fenced:true,removed};
 }
export function assertGraphSourceObservationAdmission(capture:SignedGraphSourceObservation,options:{source:ConversationGraphReplication;reader:ReplicatedStoreReader;dropped:DroppedOriginRegistry}):void {
 const pending=new Set(options.source.recordsForRepair().filter(r=>options.source.verifyHistoricalRecord(r)&&!r.certificate&&!r.cancellationCertificate&&!r.erasure).map(r=>r.packet.eventId));
 const union=options.source.certifiedUnion(options.reader,options.dropped,pending);if(union.partial||union.quarantined.length)throw new Error('source-causal-inventory-incomplete');
 for(const record of options.source.recordsForRepair()){
  const c=record.authorizationProof.sourceObservation;if(record.coreType!=='source-observation'||c?.kind!=='conversation-source-observation'||c.producerMachineId!==capture.producerMachineId||nodeKey(c.subject)!==nodeKey(capture.subject))continue;
  if(!options.source.verifyHistoricalRecord(record))throw new Error('source-causal-proof-invalid');
  if(c.producerSequence>capture.producerSequence)throw new Error('source-causal-stale');
  if(c.producerSequence===capture.producerSequence&&(c.sourceId!==capture.sourceId||c.payloadHash!==capture.payloadHash))throw new Error('source-causal-equivocation');
 }
}
export interface GraphSourceInventoryCaptureDeps {
 agentId:string;identity:MachineIdentityManager;ownerPublicKey:crypto.KeyLike;membership():GraphMembershipEpoch;
 flat:MobileConversationRouteDeps;registry:ConversationRegistry;telegramChatId:string|null;now?:()=>number;
 localErasure?:ConversationGraphLocalErasureFence;
 noteLocalActivity?(ref:ConversationRef,lastActivity:string|null):void;
 acceptedInventory():{source:ConversationGraphReplication;reader:ReplicatedStoreReader;dropped:DroppedOriginRegistry};
}
/** Capture accepts no wire row, title, canonical id or owner claim. The input
 * page comes directly from the shared local server-owned flat producer. */
export class ConversationGraphSourceInventoryCapture {
 private readonly localErasure:ConversationGraphLocalErasureFence;
 constructor(private readonly deps:GraphSourceInventoryCaptureDeps){this.localErasure=deps.localErasure??new ConversationGraphLocalErasureFence(deps.identity.baseDir);}
 private frontier(ref:ConversationRef,producer:string,records:ConversationGraphReplicationRecord[]):{file:string;sequence:number;sourceId:string|null;payloadHash:string|null} {
  const d=this.deps,refHash=canonicalHash(ref),file=path.join(d.identity.baseDir,'state','conversation-graph-source-observation-sequences',`${canonicalHash({agentId:d.agentId,producer,refHash})}.json`);
  let sequence=0,sourceId:string|null=null,payloadHash:string|null=null;
  if(fs.existsSync(file)){const raw=read(file) as {v:number;agentId:string;producer:string;refHash:string;sequence:number;sourceId:string;payloadHash:string;signature:string};
   if(!exactFields(raw,['v','agentId','producer','refHash','sequence','sourceId','payloadHash','signature'])||raw.v!==1||raw.agentId!==d.agentId||raw.producer!==producer||raw.refHash!==refHash||!Number.isSafeInteger(raw.sequence)||raw.sequence<1||!opaque(raw.sourceId)||!hash(raw.payloadHash)||!verifyGraphRecord('graph-source-producer-sequence-v1',unsigned(raw),raw.signature,d.identity.getSigningPublicKeyPem(producer)!))throw new Error('source-causal-ledger-invalid');
   ({sequence,sourceId,payloadHash}=raw);
  }
  const seen=new Map<number,string>();
  for(const record of records){const c=record.authorizationProof.sourceObservation;
   if(record.coreType!=='source-observation'||c?.kind!=='conversation-source-observation'||c.producerMachineId!==producer||nodeKey(c.subject)!==nodeKey(ref))continue;
   const identity=canonicalHash({sourceId:c.sourceId,payloadHash:c.payloadHash});
   if(seen.has(c.producerSequence)&&seen.get(c.producerSequence)!==identity)throw new Error('source-causal-equivocation');seen.set(c.producerSequence,identity);
   if(c.producerSequence>sequence){sequence=c.producerSequence;sourceId=c.sourceId;payloadHash=c.payloadHash;}else if(c.producerSequence===sequence&&(c.sourceId!==sourceId||c.payloadHash!==payloadHash))throw new Error('source-causal-ledger-conflict');
  }
  return {file,sequence,sourceId,payloadHash};
 }
 private fence(ref:ConversationRef):string {return sourceInventoryFence(this.deps.identity.baseDir,this.deps.agentId,ref);}

 /** Called by whole-source erasure after actual source verification. The local
  * fence prevents the ordinary flat producer from silently resurrecting a
  * forgotten display header. There is deliberately no bearer-based restore. */
 purgeErasedObservation(record:ConversationGraphReplicationRecord,source:ConversationGraphReplication):{fenced:boolean;removed:number} {
  return purgeGraphSourceObservationCache({stateDir:this.deps.identity.baseDir,agentId:this.deps.agentId,record,source});
 }

 private ref(row:ConversationListRow):ConversationRef|null {
  const d=row.platform==='app'&&typeof row.id==='string'?this.deps.registry.resolveByKey(`app:${row.id}`)
   :typeof row.id==='number'?this.deps.registry.resolve(row.id):null;
  if(!d||d.platform!==row.platform)return null;
  const ref=d.platform==='telegram'&&this.deps.telegramChatId?{kind:'conversation' as const,platform:'telegram' as const,chatId:this.deps.telegramChatId,topicId:d.topicId}
   :d.platform==='slack'?{kind:'conversation' as const,platform:'slack' as const,channelId:d.channelId,...(d.threadTs?{threadTs:d.threadTs}:{})}
   :d.platform==='app'?{kind:'conversation' as const,platform:'app' as const,conversationKey:d.conversationKey}:null;
  return conversationRef(ref)?ref:null;
 }
 capturePage(limit=100,cursor:string|null=null):{observations:CapturedGraphSourceObservation[];nextCursor:string|null;partial:boolean} {
  const m=this.deps.membership(),local=this.deps.identity.loadIdentity();
  if(!verifyMembershipEpoch(m,this.deps.ownerPublicKey)||m.agentId!==this.deps.agentId||this.deps.flat.machineId()!==local.machineId
   ||!m.members.some(member=>member.machineId===local.machineId&&member.signingPublicKey===this.deps.identity.getSigningPublicKeyPem(local.machineId))
   ||!this.deps.identity.isMachineActive(local.machineId))throw new Error('source-inventory-producer-untrusted');
  const inventory=this.deps.acceptedInventory(),records=inventory.source.recordsForRepair();
  if(records.some(r=>!inventory.source.verifyHistoricalRecord(r)))throw new Error('source-causal-proof-invalid');
  const pending=new Set(records.filter(r=>!r.certificate&&!r.cancellationCertificate&&!r.erasure).map(r=>r.packet.eventId)),union=inventory.source.certifiedUnion(inventory.reader,inventory.dropped,pending);
  if(union.partial||union.quarantined.length)throw new Error('source-causal-inventory-incomplete');
  const page=localConversationListPage(this.deps.flat,Math.max(1,Math.min(200,limit)),cursor);const observations:CapturedGraphSourceObservation[]=[];
  let partial=page.partial||page.slackOwnerUnset;
  for(const raw of page.rows){
   const ref=this.ref(raw);const row:GraphSourceFlatRow={id:raw.id,platform:raw.platform,title:raw.title,lastActivity:raw.lastActivity,...(Object.hasOwn(raw,'machine')?{machine:raw.machine}:{})};
   if(!ref||!validRow(row,ref,local.machineId)){partial=true;continue;}
   this.deps.noteLocalActivity?.(ref,row.lastActivity);
   if(fs.existsSync(this.fence(ref))||this.localErasure.isDenied({sourceKind:'conversation-metadata',sourceId:canonicalHash(ref)})){partial=true;continue;}
   const slot=canonicalHash({agentId:this.deps.agentId,producerMachineId:local.machineId,subject:ref,alias:{platform:row.platform,id:row.id,...(Object.hasOwn(row,'machine')?{machine:row.machine}:{})}});
   const file=path.join(this.deps.identity.baseDir,'state','conversation-graph-source-observations',`${slot}.json`);
   const frontier=this.frontier(ref,local.machineId,records);
   if(fs.existsSync(file)){
    try{const old=read(file) as CapturedGraphSourceObservation;
     if(exactFields(old,['capture','encryptedPayload'])&&verifyGraphSourceObservationCapture(old.capture,m)){
      const bytes=openGraphBundle(old.encryptedPayload,local.machineId,this.deps.identity.loadEncryptionKey(),{agentId:this.deps.agentId,eventId:sourceObservationEventId(old.capture.sourceId)});
      let prior:GraphSourceObservationPayload|null;try{prior=validateGraphSourceObservationPayload(JSON.parse(bytes.toString()),old.capture);}finally{bytes.fill(0);}
      if(prior&&old.capture.producerSequence===frontier.sequence&&old.capture.sourceId===frontier.sourceId&&old.capture.payloadHash===frontier.payloadHash&&graphSourceRowUnchanged(prior.row,row)){observations.push(old);continue;}
     }
    }catch{/* @silent-fallback-ok: corrupt cache explicitly marks returned capture partial and grants no cached authority. */partial=true;} // corrupt cache never grants authority; new actual observation is independently captured
   }
   if(frontier.sequence>=Number.MAX_SAFE_INTEGER)throw new Error('source-causal-sequence-exhausted');
   const producerSequence=frontier.sequence+1,sourceId=crypto.randomUUID();const payload:GraphSourceObservationPayload={v:1,salt:crypto.randomBytes(32).toString('hex'),sourceId,subject:ref,producerMachineId:local.machineId,producerSequence,row};
   const unsignedCapture={version:1 as const,kind:'conversation-source-observation' as const,agentId:this.deps.agentId,sourceId,subject:ref,producerMachineId:local.machineId,producerSequence,
    membershipEpoch:m.epoch,membershipHash:canonicalHash(m),capturedAt:new Date(this.deps.now?.()??Date.now()).toISOString(),payloadHash:payloadHash(payload)};
   const capture:SignedGraphSourceObservation={...unsignedCapture,signature:signGraphRecord(DOMAIN,unsignedCapture,this.deps.identity.loadSigningKey())};
   const plaintext=Buffer.from(canonicalJson(payload));let encryptedPayload:GraphEncryptedBundle;
   try{encryptedPayload=sealGraphBundle(plaintext,m.members,{agentId:this.deps.agentId,eventId:sourceObservationEventId(sourceId)});}finally{plaintext.fill(0);}
   const ledger={v:1,agentId:this.deps.agentId,producer:local.machineId,refHash:canonicalHash(ref),sequence:producerSequence,sourceId,payloadHash:capture.payloadHash};
   write(frontier.file,{...ledger,signature:signGraphRecord('graph-source-producer-sequence-v1',ledger,this.deps.identity.loadSigningKey())});
   const value={capture,encryptedPayload};write(file,value);observations.push(value);
  }
  const last=page.rows.at(-1);return {observations,nextCursor:page.more&&last?listCursorFor(last):null,partial};
 }
}
export function prepareGraphSourceObservation(captured:CapturedGraphSourceObservation,options:{agentId:string;identity:MachineIdentityManager;ownerPublicKey:crypto.KeyLike;
 membership:GraphMembershipEpoch;admission:WriteAdmission;coordinator:Pick<LeaseCoordinator,'holdsLease'|'currentEpoch'|'currentLease'>;localErasure?:ConversationGraphLocalErasureFence;now?:()=>number}):{
 coreType:'source-observation';core:GraphSourceObservationCore;authorizationProof:GraphAuthorizationProof;plaintextSource:Buffer;idempotencyKey:string;requestHash:string} {
 const m=options.membership,local=options.identity.loadIdentity(),native=options.coordinator.currentLease(),now=options.now?.()??Date.now();
 if(!verifyMembershipEpoch(m,options.ownerPublicKey)||m.agentId!==options.agentId||!verifyGraphSourceObservationCapture(captured.capture,m)
  ||options.admission.guardStoreWrite('conversationGraph.append').enforce==='refuse'||!options.admission.evaluate('cluster-shared').admit
  ||!options.identity.isMachineActive(local.machineId)||!options.coordinator.holdsLease()||!native||native.holder!==local.machineId||native.epoch!==options.coordinator.currentEpoch()
  ||Date.parse(native.acquiredAt)>now||Date.parse(native.expiresAt)<=now
  ||!m.members.some(member=>member.machineId===local.machineId&&member.signingPublicKey===options.identity.getSigningPublicKeyPem(local.machineId)))throw new Error('source-observation-current-admission-required');
 const bridge={v:1 as const,agentId:options.agentId,membershipEpoch:m.epoch,leaseEpoch:native.epoch,writerId:local.machineId,issuedAt:native.acquiredAt,expiresAt:native.expiresAt,fencedLeaseHash:canonicalHash(native)};
 const lease:GraphWitnessLease={...bridge,signature:signGraphRecord('graph-lease-v1',bridge,options.identity.loadSigningKey())};
 if(!verifyFencedLeaseBridge(lease,native,m))throw new Error('source-observation-native-lease-invalid');
 const capture=captured.capture;
 if(graphSourceObservationIsErased(options.identity.baseDir,options.agentId,capture.subject,options.localErasure)||options.localErasure?.isDenied({sourceKind:'conversation-metadata',sourceId:canonicalHash(capture.subject)}))throw new Error('source-observation-erased');
 const bytes=openGraphBundle(captured.encryptedPayload,local.machineId,options.identity.loadEncryptionKey(),{agentId:options.agentId,eventId:sourceObservationEventId(capture.sourceId)});
 let payload:GraphSourceObservationPayload|null;try{payload=validateGraphSourceObservationPayload(JSON.parse(bytes.toString()),capture);}finally{bytes.fill(0);}
 if(!payload)throw new Error('source-observation-payload-invalid');
 const core:GraphSourceObservationCore={schemaVersion:1,op:'observe-conversation-source',eventId:sourceObservationEventId(capture.sourceId),subject:capture.subject,
  authority:'source',principal:'server-source-observer',receipt:{kind:'source-observation-record',id:capture.sourceId},machineId:local.machineId,createdAt:capture.capturedAt,payloadHash:capture.payloadHash};
 const idempotencyKey=`source-observation:${capture.sourceId}`;
 const receipt:Omit<GraphAuthorizationReceipt,'signature'>={v:1,agentId:options.agentId,eventId:graphOperationKey('source-observation',core.eventId),coreHash:canonicalHash(core),actorPrincipal:core.principal,
  receiptId:capture.sourceId,authenticationMethod:'source-observation',membershipEpoch:m.epoch,leaseEpoch:native.epoch,idempotencyKey,writerId:local.machineId,fencedLeaseHash:canonicalHash(native),acceptedAt:new Date(now).toISOString()};
 const authorizationProof:GraphAuthorizationProof={receipt:{...receipt,signature:signGraphRecord('graph-authorization-receipt-v1',receipt,options.identity.loadSigningKey())},membership:m,lease,originalLease:native,sourceObservation:capture};
 return {coreType:'source-observation',core,authorizationProof,plaintextSource:Buffer.from(canonicalJson({sourceObservation:capture,payload})),idempotencyKey,requestHash:canonicalHash(capture)};
}
export function materializeGraphSourceInventory(options:{source:ConversationGraphReplication;reader:ReplicatedStoreReader;dropped:DroppedOriginRegistry;membership?:GraphMembershipEpoch}):{
 coverage:GraphSourceInventoryCoverage;unavailableConversations:ConversationRef[];entries:Array<{ref:ConversationRef;row:GraphSourceFlatRow;producerMachineId:string;eventId:string}>;conversations:ConversationSource[];partial:boolean;missingEventIds:string[]} {
 const union=options.source.certifiedUnion(options.reader,options.dropped);let partial=union.partial;const missingEventIds:string[]=[];
 const latest=new Map<string,{record:ConversationGraphReplicationRecord;entry:{ref:ConversationRef;row:GraphSourceFlatRow;producerMachineId:string;eventId:string}|null}>();
 for(const record of union.records){const core=validateGraphSourceObservationCore(record.core),observed=record.authorizationProof.sourceObservation;if(!core||observed?.kind!=='conversation-source-observation')continue;const k=canonicalHash({ref:core.subject,producer:observed.producerMachineId});
  // A newer unavailable/erased observation suppresses the old title and alias.
  const previous=latest.get(k)?.record.authorizationProof.sourceObservation;if(previous?.kind==='conversation-source-observation'){
   if(previous.producerSequence>observed.producerSequence)continue;
   if(previous.producerSequence===observed.producerSequence){if(previous.sourceId!==observed.sourceId||previous.payloadHash!==observed.payloadHash){partial=true;latest.set(k,{record,entry:null});missingEventIds.push(core.eventId);}continue;}
  }
  latest.set(k,{record,entry:null});
  const capture=record.authorizationProof.sourceObservation;
  if(!capture||capture.kind!=='conversation-source-observation'||!options.source.verifyHistoricalRecord(record)||record.erasure||!record.encryptedSourceBundle){partial=true;missingEventIds.push(core.eventId);continue;}
  try{const bytes=options.source.openVerifiedPayload(record);
   let body:{sourceObservation?:unknown;payload?:unknown};try{body=JSON.parse(bytes.toString());}finally{bytes.fill(0);}
   const payload=exactFields(body,['sourceObservation','payload'])&&canonicalHash(body.sourceObservation)===canonicalHash(capture)?validateGraphSourceObservationPayload(body.payload,capture):null;
   if(!payload)throw new Error('inventory-source-payload-invalid');
   latest.set(k,{record,entry:{ref:payload.subject,row:payload.row,producerMachineId:payload.producerMachineId,eventId:core.eventId}});
  }catch{/* @silent-fallback-ok: returned inventory explicitly exposes partial plus missingEventIds for this unavailable certified body. */partial=true;missingEventIds.push(core.eventId);}
 }
 const coverage=reconcileGraphSourceCoverage(options);
 const entries=[...latest.values()].flatMap(value=>value.entry&&!coverage.removed.some(r=>nodeKey(r.ref)===nodeKey(value.entry!.ref)&&r.producerMachineId===value.entry!.producerMachineId&&r.sourceSequence>value.record.packet.sourceSequence)?[value.entry]:[]);
 const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
 entries.sort((a,b)=>compare(b.row.lastActivity??'',a.row.lastActivity??'')||compare(nodeKey(a.ref),nodeKey(b.ref)));
 // `entries` stays one row per producer. `conversations` is one row per ref.
 // An app conversation replicates to every machine and a Telegram topic list is
 // read by every machine with a Telegram adapter, so several producers report
 // the same global ref; the history route reads both through this machine's
 // pool read, never from one producer. Every machine picks the same display
 // row from certified content alone (newest activity, then producer id), never
 // from arrival order. A Slack ref names a machine-local alias and the one
 // machine that serves its history, so two Slack producers stay ambiguous.
 // A producer whose own checkpoint calls the ref unavailable does not supply
 // its row; another producer that still holds a global ref does.
 const unavailableFrom=new Map<string,Set<string>>();
 for(const u of coverage.unavailableBy){const k=nodeKey(u.ref);if(!unavailableFrom.has(k))unavailableFrom.set(k,new Set());unavailableFrom.get(k)!.add(u.producerMachineId);}
 const chosen=new Map<string,(typeof entries)[number]>(),ambiguous=new Map<string,ConversationRef>();
 for(const e of entries){const k=nodeKey(e.ref),prior=chosen.get(k);
  if(e.ref.platform!=='slack'&&unavailableFrom.get(k)?.has(e.producerMachineId))continue;
  if(!prior){chosen.set(k,e);continue;}
  if(prior.producerMachineId===e.producerMachineId)continue;
  if(e.ref.platform==='slack'){ambiguous.set(k,e.ref);continue;}
  const newer=compare(e.row.lastActivity??'',prior.row.lastActivity??'');
  if(newer>0||(newer===0&&compare(e.producerMachineId,prior.producerMachineId)<0))chosen.set(k,e);
 }
 if(ambiguous.size)partial=true;
 const conversations:ConversationSource[]=entries.filter(e=>!ambiguous.has(nodeKey(e.ref))&&chosen.get(nodeKey(e.ref))===e).map(e=>({ref:e.ref,conversationId:e.row.id,...(Object.hasOwn(e.row,'machine')?{machine:e.row.machine}:{}),title:e.row.title??'',lastActivity:e.row.lastActivity}));
 const heldElsewhere=(ref:ConversationRef)=>ref.platform!=='slack'&&chosen.has(nodeKey(ref));
 return {entries,conversations,coverage,unavailableConversations:[...coverage.unavailableConversations.filter(ref=>!heldElsewhere(ref)),...ambiguous.values()],partial:partial||!coverage.membershipHash||!!(coverage.staleProducerIds.length||coverage.missingProducerIds.length||coverage.partialProducerIds.length||coverage.missingObservationIds.length),missingEventIds:[...new Set(missingEventIds)].sort()};
}

/** One accepting native writer for both source variants. Producer forwarding
 * ciphertext is opened only after registered-source and native admission checks. */
export function prepareGraphSourceOperation(captured:CapturedGraphSourceOperation,options:Parameters<typeof prepareGraphSourceObservation>[1]):{
 coreType:'source-observation';core:GraphSourceObservationCore|GraphSourceSweepCore;authorizationProof:GraphAuthorizationProof;plaintextSource:Buffer;idempotencyKey:string;requestHash:string} {
 if(captured.capture.kind==='conversation-source-observation')return prepareGraphSourceObservation(captured as CapturedGraphSourceObservation,options);
 const capture=captured.capture,m=options.membership,local=options.identity.loadIdentity(),native=options.coordinator.currentLease(),now=options.now?.()??Date.now();
 if(!verifyMembershipEpoch(m,options.ownerPublicKey)||m.agentId!==options.agentId||!verifyGraphSourceSweepCapture(capture,m)||!options.identity.isMachineActive(local.machineId)
  ||options.admission.guardStoreWrite('conversationGraph.append').enforce==='refuse'||!options.admission.evaluate('cluster-shared').admit||!options.coordinator.holdsLease()
  ||!native||native.holder!==local.machineId||native.epoch!==options.coordinator.currentEpoch()||Date.parse(native.acquiredAt)>now||Date.parse(native.expiresAt)<=now
  ||!m.members.some(member=>member.machineId===local.machineId&&member.signingPublicKey===options.identity.getSigningPublicKeyPem(local.machineId)))throw new Error('source-sweep-current-admission-required');
 const core:GraphSourceSweepCore={schemaVersion:1,op:'observe-source-inventory',eventId:sourceSweepEventId(capture.sourceId),authority:'source',principal:'server-source-observer',
  receipt:{kind:'source-observation-record',id:capture.sourceId},machineId:local.machineId,createdAt:capture.completedAt,payloadHash:capture.payloadHash};
 if(options.localErasure?.isDenied({sourceKind:'graph-intent',sourceId:graphOperationKey('source-observation',core.eventId)}))throw new Error('source-sweep-locally-erased');
 const b={v:1 as const,agentId:options.agentId,membershipEpoch:m.epoch,leaseEpoch:native.epoch,writerId:local.machineId,issuedAt:native.acquiredAt,expiresAt:native.expiresAt,fencedLeaseHash:canonicalHash(native)};
 const lease:GraphWitnessLease={...b,signature:signGraphRecord('graph-lease-v1',b,options.identity.loadSigningKey())};if(!verifyFencedLeaseBridge(lease,native,m))throw new Error('source-sweep-native-lease-invalid');
 const bytes=openGraphBundle(captured.encryptedPayload,local.machineId,options.identity.loadEncryptionKey(),{agentId:options.agentId,eventId:core.eventId});let payload:unknown;
 try{payload=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}if(!validateGraphSourceSweepPlaintext({sourceObservation:capture,payload},capture))throw new Error('source-sweep-payload-invalid');
 const idempotencyKey=`source-inventory:${capture.sourceId}`;
 const r:Omit<GraphAuthorizationReceipt,'signature'>={v:1,agentId:options.agentId,eventId:graphOperationKey('source-observation',core.eventId),coreHash:canonicalHash(core),actorPrincipal:core.principal,receiptId:capture.sourceId,
  authenticationMethod:'source-observation',membershipEpoch:m.epoch,leaseEpoch:native.epoch,idempotencyKey,writerId:local.machineId,fencedLeaseHash:canonicalHash(native),acceptedAt:new Date(now).toISOString()};
 const authorizationProof:GraphAuthorizationProof={receipt:{...r,signature:signGraphRecord('graph-authorization-receipt-v1',r,options.identity.loadSigningKey())},membership:m,lease,originalLease:native,sourceObservation:capture};
 return {coreType:'source-observation',core,authorizationProof,plaintextSource:Buffer.from(canonicalJson({sourceObservation:capture,payload})),idempotencyKey,requestHash:canonicalHash(capture)};
}
