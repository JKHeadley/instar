/** Installed-member closure of immutable pre-witness source tails. Native lease
 * authority remains the real coordinator; these receipts prove only a member's
 * durable graph floor and the exact source inventory observed behind its queue. */
import {durableStamp,isDurablyUnchanged,rememberDurable} from './GraphDurableFileMemo.js';
import type crypto from 'node:crypto';
import type {LeaseRecord} from './types.js';
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
import {canonicalHash,exactFields,hash,iso,opaque,validGraphOperationKey,verifyFencedLeaseBridge,verifyGraphRecord,
 type GraphMembershipEpoch,type GraphWitnessLease} from './GraphWitnessTypes.js';
export const GRAPH_NATIVE_TAIL_DOMAIN='graph-native-tail-closure-v1';
export interface GraphNativeTailEntry {eventId:string;packetHash:string;sourceSequence:number;predecessorHash:string|null;coreHash:string;sourceProofHash:string}
export interface GraphNativeTailReceipt {v:1;agentId:string;membershipHash:string;writerId:string;leaseEpoch:number;nativeLeaseHash:string;machineId:string;tailHash:string;entryCount:number;highestSourceSequence:number;recordedAt:string;signature:string}
export interface GraphNativeTailClosure {receipt:GraphNativeTailReceipt;observedLease:GraphWitnessLease;originalObservedLease:LeaseRecord;entries:GraphNativeTailEntry[]}
export function graphNativeTailEntries(records:ReadonlyArray<ConversationGraphReplicationRecord>):GraphNativeTailEntry[]{
 const byId=new Map<string,GraphNativeTailEntry>();
 for(const record of records){const {packet,packetSignature,core,authorizationProof}=record;const row={eventId:packet.eventId,packetHash:canonicalHash(packet),sourceSequence:packet.sourceSequence,predecessorHash:packet.predecessorHash,coreHash:packet.coreHash,sourceProofHash:canonicalHash({coreType:record.coreType,packet,packetSignature,core,authorizationProof})};const previous=byId.get(row.eventId);if(previous&&canonicalHash(previous)!==canonicalHash(row))throw new Error('graph-native-tail-conflict');byId.set(row.eventId,row);}
 return [...byId.values()].sort((a,b)=>a.sourceSequence-b.sourceSequence||a.eventId.localeCompare(b.eventId));
}
export function validateGraphNativeTailEntries(raw:unknown):raw is GraphNativeTailEntry[]{
 if(!Array.isArray(raw)||raw.length>20000)return false;let sequence=0;const ids=new Set<string>();
 for(const row of raw){if(!exactFields(row,['eventId','packetHash','sourceSequence','predecessorHash','coreHash','sourceProofHash'])||!['graph-event','header-op','source-observation'].some(type=>validGraphOperationKey(type,row.eventId))||!hash(row.packetHash)||!hash(row.coreHash)||!hash(row.sourceProofHash)||!Number.isSafeInteger(row.sourceSequence)||row.sourceSequence<1||row.sourceSequence<=sequence||(row.predecessorHash!==null&&!hash(row.predecessorHash))||ids.has(row.eventId))return false;sequence=row.sourceSequence;ids.add(row.eventId);}
 return true;
}
export function verifyGraphNativeTailClosure(value:GraphNativeTailClosure,membership:GraphMembershipEpoch,currentLease:GraphWitnessLease):boolean{
 if(!value||!exactFields(value,['receipt','observedLease','originalObservedLease','entries'])||!validateGraphNativeTailEntries(value.entries))return false;
 const r=value.receipt,m=membership.members.find(member=>member.machineId===r?.machineId);
 if(!r||!exactFields(r,['v','agentId','membershipHash','writerId','leaseEpoch','nativeLeaseHash','machineId','tailHash','entryCount','highestSourceSequence','recordedAt','signature'])||r.v!==1||r.agentId!==membership.agentId||r.membershipHash!==canonicalHash(membership)||r.writerId!==currentLease.writerId||r.leaseEpoch!==currentLease.leaseEpoch||!m||!iso(r.recordedAt)||!opaque(r.machineId)||!hash(r.nativeLeaseHash)||r.nativeLeaseHash!==canonicalHash(value.originalObservedLease)||!verifyFencedLeaseBridge(value.observedLease,value.originalObservedLease,membership)||value.observedLease.writerId!==r.writerId||value.observedLease.leaseEpoch!==r.leaseEpoch||r.entryCount!==value.entries.length||r.highestSourceSequence!==(value.entries.at(-1)?.sourceSequence??0)||r.tailHash!==canonicalHash(value.entries))return false;
 const {signature,...unsigned}=r;return verifyGraphRecord(GRAPH_NATIVE_TAIL_DOMAIN,unsigned,signature,m.signingPublicKey);
}
/** Every installed member must close; the union must be one exact prefix. */
export function verifyGraphNativeTailBarrier(closures:GraphNativeTailClosure[],membership:GraphMembershipEpoch,currentLease:GraphWitnessLease):boolean{
 if(!Array.isArray(closures)||closures.length!==membership.members.length)return false;const machines=new Set<string>(),union=new Map<number,GraphNativeTailEntry>();
 for(const closure of closures){if(!verifyGraphNativeTailClosure(closure,membership,currentLease)||machines.has(closure.receipt.machineId))return false;machines.add(closure.receipt.machineId);for(const entry of closure.entries){const old=union.get(entry.sourceSequence);if(old&&canonicalHash(old)!==canonicalHash(entry))return false;union.set(entry.sourceSequence,entry);}}
 let sequence=0,predecessor:string|null=null;for(const [n,row]of [...union].sort(([a],[b])=>a-b)){if(n!==sequence+1||row.predecessorHash!==predecessor)return false;sequence=n;predecessor=row.coreHash;}return membership.members.every(member=>machines.has(member.machineId));
}

import fs from 'node:fs/promises';
import fsSync,{realpathSync} from 'node:fs';
import path from 'node:path';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from './GraphLocalFiles.js';
import {verifyMembershipEpoch,canonicalJson} from './GraphWitnessTypes.js';
/** Negative graph admission floor; persisted before acknowledging closure. It
 * cannot elect a writer or replace the coordinator's actual live authority. */
export class ConversationGraphNativeTailFloor {
 private floor:{membership:GraphMembershipEpoch;lease:GraphWitnessLease;originalLease:LeaseRecord}|null=null;
 private queue:Promise<unknown>=Promise.resolve();
 private readonly root:string;private readonly directory:string;private readonly file:string;
 constructor(stateDir:string,private readonly agentId:string,private readonly ownerKey:crypto.KeyLike){this.root=realpathSync(stateDir);this.directory=path.join(this.root,'state','conversation-graph-native-tail');this.file=path.join(this.directory,'floor.json');assertGraphLocalPath(this.root,this.file);}
 async open():Promise<void>{assertGraphLocalPath(this.root,this.file);let raw:unknown;try{const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)throw new Error('graph-native-tail-floor-invalid');raw=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}const f=raw as NonNullable<typeof this.floor>;if(!exactFields(f,['membership','lease','originalLease'])||!verifyMembershipEpoch(f.membership,this.ownerKey)||f.membership.agentId!==this.agentId||!verifyFencedLeaseBridge(f.lease,f.originalLease,f.membership))throw new Error('graph-native-tail-floor-invalid');this.floor=f;}
 /** Mechanical component identity only: never observes or advances a floor. */
 assertComponentScope(stateRoot:string,agentId:string,membership:GraphMembershipEpoch):void{
  if(realpathSync(stateRoot)!==this.root||agentId!==this.agentId||membership.agentId!==this.agentId||!verifyMembershipEpoch(membership,this.ownerKey))throw new Error('graph-native-tail-component-scope-invalid');assertGraphLocalPath(this.root,this.file);
 }
 /** Actual durable observation only; never elects a writer or advances a floor. */
 assertObservedContext(stateRoot:string,agentId:string,membership:GraphMembershipEpoch,lease:GraphWitnessLease,originalLease:LeaseRecord):void{
  if(realpathSync(stateRoot)!==this.root||agentId!==this.agentId||membership.agentId!==agentId||!verifyMembershipEpoch(membership,this.ownerKey)||!verifyFencedLeaseBridge(lease,originalLease,membership))throw new Error('graph-native-tail-observed-scope-invalid');assertGraphLocalPath(this.root,this.file);const stat=fsSync.lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>128*1024)throw new Error('graph-native-tail-floor-invalid');const flushed=isDurablyUnchanged(this.file),stamp=durableStamp(this.file);const fd=fsSync.openSync(this.file,fsSync.constants.O_RDONLY|(fsSync.constants.O_NOFOLLOW??0));try{const opened=fsSync.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size!==stat.size)throw new Error('graph-native-tail-floor-changed');const storage=Buffer.alloc(opened.size+1),count=fsSync.readSync(fd,storage,0,storage.length,0);if(count!==opened.size)throw new Error('graph-native-tail-floor-changed');const value=JSON.parse(storage.subarray(0,count).toString('utf8')) as NonNullable<typeof this.floor>;if(!exactFields(value,['membership','lease','originalLease'])||canonicalHash(value.membership)!==canonicalHash(membership)||!verifyFencedLeaseBridge(value.lease,value.originalLease,membership)||value.originalLease.epoch!==originalLease.epoch||value.originalLease.holder!==originalLease.holder||!this.floor||canonicalHash(value)!==canonicalHash(this.floor))throw new Error('graph-native-tail-observed-context-mismatch');if(!flushed)fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}if(!flushed)for(const directory of [this.directory,path.dirname(this.directory),this.root]){const fd=fsSync.openSync(directory,'r');try{fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}}if(!flushed)rememberDurable(this.file,stamp);
 }
 allows(native:LeaseRecord|null):boolean{return !!native&&(!this.floor||native.epoch>this.floor.originalLease.epoch||native.epoch===this.floor.originalLease.epoch&&native.holder===this.floor.originalLease.holder);}
 observe(membership:GraphMembershipEpoch,lease:GraphWitnessLease,originalLease:LeaseRecord):Promise<void>{const work=this.queue.then(async()=>{
  if(!verifyMembershipEpoch(membership,this.ownerKey)||membership.agentId!==this.agentId||!verifyFencedLeaseBridge(lease,originalLease,membership)||!this.allows(originalLease))throw new Error('graph-native-tail-floor-regression');
  const next={membership,lease,originalLease};ensureGraphLocalDirectory(this.root,this.directory);assertGraphLocalPath(this.root,this.file);
  const temporary=path.join(this.directory,`floor-${globalThis.crypto.randomUUID()}.pending`),h=await fs.open(temporary,'wx',0o600);try{await h.writeFile(canonicalJson(next));await h.sync();}finally{await h.close();}
  await fs.rename(temporary,this.file);const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}this.floor=structuredClone(next);
 });this.queue=work.catch(()=>{/* @silent-fallback-ok: retain queue scheduling after a rejected floor write; the original returned promise still rejects and no closure receipt is issued. */});return work;}
}

/** Current takeover custody is distinct from an original source-phase receipt.
 * It cannot assert that the original native writer ever completed its ACK. */
export const GRAPH_NATIVE_TAKEOVER_CUSTODY_DOMAIN='graph-native-takeover-custody-v1';
export interface GraphNativeTakeoverCustodyReceipt {v:1;agentId:string;eventId:string;operationHash:string;sourceProofHash:string;sourceBundleHash:string;controlHash:string;membershipHash:string;currentLeaseHash:string;closedTailsHash:string;machineId:string;persistedAt:string;signature:string}
export function graphNativeClosedTailsHash(closures:ReadonlyArray<GraphNativeTailClosure>):string{return canonicalHash([...closures].sort((a,b)=>a.receipt.machineId.localeCompare(b.receipt.machineId)));}
export function verifyGraphNativeTakeoverCustodyReceipt(receipt:GraphNativeTakeoverCustodyReceipt,record:Pick<ConversationGraphReplicationRecord,'packet'|'packetSignature'|'coreType'|'core'|'authorizationProof'>,membership:GraphMembershipEpoch,currentLease:GraphWitnessLease,closures:GraphNativeTailClosure[]):boolean{
 if(!receipt||!exactFields(receipt,['v','agentId','eventId','operationHash','sourceProofHash','sourceBundleHash','controlHash','membershipHash','currentLeaseHash','closedTailsHash','machineId','persistedAt','signature']))return false;
 const member=membership.members.find(row=>row.machineId===receipt.machineId),packet=record.packet;
 const sourceProofHash=canonicalHash({coreType:record.coreType,packet,packetSignature:record.packetSignature,core:record.core,authorizationProof:record.authorizationProof});
 return receipt.v===1&&receipt.agentId===packet.agentId&&receipt.eventId===packet.eventId&&receipt.operationHash===canonicalHash(packet)&&receipt.sourceProofHash===sourceProofHash&&receipt.sourceBundleHash===packet.sourceBundleHash&&receipt.controlHash===packet.controlHash&&receipt.membershipHash===canonicalHash(membership)&&receipt.currentLeaseHash===canonicalHash(currentLease)&&receipt.closedTailsHash===graphNativeClosedTailsHash(closures)&&receipt.machineId===currentLease.writerId&&iso(receipt.persistedAt)&&!!member&&closures.some(closure=>closure.entries.some(entry=>entry.eventId===packet.eventId&&entry.packetHash===receipt.operationHash&&entry.sourceProofHash===sourceProofHash))&&verifyGraphRecord(GRAPH_NATIVE_TAKEOVER_CUSTODY_DOMAIN,(({signature,...body})=>body)(receipt),receipt.signature,member.signingPublicKey);
}
