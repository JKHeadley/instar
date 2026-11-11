import type {GraphOwnedControlMetadataFrames} from './GraphOwnedControlMetadataFrames.js';
/** Ephemeral transport custody, never a Saved receipt or an authority source.
 * A restart discards frames; callers resubmit the exact semantic command. */
import fs from 'node:fs';
import {GraphCustodyProfileAuthority} from './GraphCustodyProfileAuthority.js';
import {ConversationGraphLocalErasureFence} from './ConversationGraphLocalErasure.js';
import {LeaseCoordinator} from './LeaseCoordinator.js';
import {MachineIdentityManager,verify as verifyMachineSignature} from './MachineIdentity.js';
import {FencedLease} from './FencedLease.js';
import {verifyGraphControlCapsule,type GraphControlCapsule} from './GraphWitnessControl.js';
import {canonicalHash,canonicalJson,exactFields,hash,unsigned,signGraphRecord,verifyGraphRecord,verifyMembershipEpoch,verifyFencedLeaseBridge,verifyWitnessLease,validatePacket,verifyEncryptedBundle,verifyBundleRewrap,GRAPH_SIGNATURE_DOMAINS as D,type GraphOperationPacket,type GraphWitnessLease,type GraphEncryptedBundle,type GraphErasureIdentity,type GraphBundleRewrap,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
import type {LeaseRecord} from './types.js';

export const GRAPH_OWNED_FRAME_DOMAIN='graph-owned-control-private-part-v1';
export const GRAPH_OWNED_FRAME_CHUNK_BYTES=128*1024;
export const GRAPH_OWNED_FRAME_PART_BYTES=32*1024*1024;
export const GRAPH_OWNED_FRAME_ACTIVE_BYTES=64*1024*1024;
export interface GraphOwnedPrivatePartPlan {
 v:1;kind:'source-bundle'|'source-rewrap';agentId:string;sender:string;target:string;commandHash:string;partHash:string;
 packet:GraphOperationPacket;packetSignature:string;controlCapsule:GraphControlCapsule;
 lease:GraphWitnessLease;originalLease:LeaseRecord;newMembership:GraphMembershipEpoch|null;bytes:number;chunkHashes:string[];signature:string;
}
export class GraphOwnedControlFrameBudget {private active=0;private generation=0;private readonly buffers=new Set<Buffer>();reserve(bytes:number){if(!Number.isSafeInteger(bytes)||bytes<0||this.active+bytes>GRAPH_OWNED_FRAME_ACTIVE_BYTES)throw new Error('graph-control-frame-capacity');this.active+=bytes;}release(bytes:number){this.active-=bytes;if(this.active<0)throw new Error('graph-control-frame-budget-invalid');}track(buffer:Buffer){this.buffers.add(buffer);}untrack(buffer:Buffer){this.buffers.delete(buffer);}zero(){this.generation++;for(const buffer of this.buffers)buffer.fill(0);}get epoch(){return this.generation;}get activeBytes(){return this.active;}assertZero(){if([...this.buffers].some(buffer=>buffer.some(byte=>byte!==0)))throw new Error('graph-control-frame-purge-incomplete');}}
interface Entry {cost:number;plan:GraphOwnedPrivatePartPlan;buffer:Buffer;received:Set<number>;expiresAt:number;generation:string}
export interface GraphOwnedControlFrameCacheOptions {
 stateDir:string;agentId:string;identity:MachineIdentityManager;authority:GraphCustodyProfileAuthority;
 leaseCoordinator:LeaseCoordinator;metadata?:GraphOwnedControlMetadataFrames;budget?:GraphOwnedControlFrameBudget;fence:ConversationGraphLocalErasureFence;
}
export class GraphOwnedControlFrameCache {
 readonly stateRoot:string;
 get agentId(){return this.options.agentId;}
 private readonly budget:GraphOwnedControlFrameBudget;private context:string;private readonly timer:NodeJS.Timeout;
 private readonly entries=new Map<string,Entry>();private bytes=0;private closed=false;
 constructor(private readonly options:GraphOwnedControlFrameCacheOptions){
  this.budget=options.budget??new GraphOwnedControlFrameBudget();this.stateRoot=fs.realpathSync(options.stateDir);
  if(options.fence.stateRoot!==this.stateRoot||options.authority.currentMembership().agentId!==options.agentId)throw new Error('graph-control-frame-scope-invalid');this.context=this.currentContext();this.timer=setInterval(()=>{try{this.sweep();this.options.metadata?.expire();}catch{this.budget.zero();for(const key of this.entries.keys())this.remove(key);this.options.metadata?.clear();}},1000);this.timer.unref();
 }
 private generation(){if(this.closed||this.options.fence.stateRoot!==this.stateRoot)throw new Error('graph-control-frame-closed');return canonicalHash(this.options.fence.targets().sort((a,b)=>canonicalHash(a).localeCompare(canonicalHash(b))));}
 private currentContext(){const native=this.options.leaseCoordinator.currentLease();return canonicalHash({membership:canonicalHash(this.options.authority.currentMembership()),holder:native?.holder??null,epoch:native?.epoch??null});}
 private sweep(){const context=this.currentContext();if(context!==this.context){this.budget.zero();for(const key of this.entries.keys())this.remove(key);this.options.metadata?.clear();this.context=context;}const generation=this.generation(),now=Date.now();for(const [key,entry] of this.entries)if(entry.expiresAt<=now||entry.generation!==generation)this.remove(key);return generation;}
 private remove(key:string){const entry=this.entries.get(key);if(entry){entry.buffer.fill(0);this.budget.untrack(entry.buffer);this.bytes-=entry.buffer.length;this.budget.release(entry.cost);this.entries.delete(key);}}
 private key(plan:GraphOwnedPrivatePartPlan){return canonicalHash(plan);}
 private verify(plan:GraphOwnedPrivatePartPlan,sender:string,target:string):void{
  const m=this.options.authority.currentMembership(),native=this.options.leaseCoordinator.currentLease(),original=plan?.controlCapsule?.authorizationProof?.membership;
  const signer=m.members.find(row=>row.machineId===sender),origin=original?.members.find(row=>row.machineId===plan?.packet?.writerId);
  if(!exactFields(plan,['v','kind','agentId','sender','target','commandHash','partHash','packet','packetSignature','controlCapsule','lease','originalLease','newMembership','bytes','chunkHashes','signature'])
   ||plan.v!==1||!['source-bundle','source-rewrap'].includes(plan.kind)||plan.agentId!==this.options.agentId||plan.sender!==sender||plan.target!==target||!hash(plan.commandHash)||!hash(plan.partHash)
   ||!Number.isSafeInteger(plan.bytes)||plan.bytes<1||plan.bytes>GRAPH_OWNED_FRAME_PART_BYTES||!Array.isArray(plan.chunkHashes)||plan.chunkHashes.length!==Math.ceil(plan.bytes/GRAPH_OWNED_FRAME_CHUNK_BYTES)||!plan.chunkHashes.every(hash)
   ||!m.members.some(row=>row.machineId===target)||!signer||!native||native.holder!==sender||native.epoch!==plan.lease.leaseEpoch||plan.lease.writerId!==sender
   ||native.released===true||Date.parse(native.expiresAt)<=Date.now()||!verifyMachineSignature(FencedLease.canonicalize(native),native.signature,signer.signingPublicKey)
   ||!verifyWitnessLease(plan.lease,m)||!verifyFencedLeaseBridge(plan.lease,plan.originalLease,m)
   ||!verifyGraphRecord(GRAPH_OWNED_FRAME_DOMAIN,unsigned(plan),plan.signature,signer.signingPublicKey)
   ||!original||!verifyMembershipEpoch(original,this.options.authority.ownerPublicKey)||!origin||!validatePacket(plan.packet)
   ||plan.packet.agentId!==plan.agentId||(plan.kind==='source-bundle'?(plan.packet.sourceBundleHash!==plan.partHash||plan.newMembership!==null):(!plan.newMembership||!verifyMembershipEpoch(plan.newMembership,this.options.authority.ownerPublicKey)||plan.newMembership.agentId!==plan.agentId))
   ||!verifyGraphRecord(D.packet,plan.packet,plan.packetSignature,origin.signingPublicKey)
   ||!verifyGraphControlCapsule(plan.controlCapsule,plan.packet,this.options.authority.ownerPublicKey)
   ||this.options.fence.isDenied(plan.packet.erasureIdentity))throw new Error('graph-control-frame-proof-invalid');
 }
 /** Only the actual native holder can construct outbound private commitments. */
 createSourcePart(input:{target:string;commandHash:string;packet:GraphOperationPacket;packetSignature:string;controlCapsule:GraphControlCapsule;lease:GraphWitnessLease;originalLease:LeaseRecord;bundle:GraphEncryptedBundle}):{plan:GraphOwnedPrivatePartPlan;key:string}{
  this.sweep();const sender=this.options.identity.loadIdentity().machineId;
  if(!this.options.leaseCoordinator.holdsLease()||!verifyEncryptedBundle(input.bundle,input.controlCapsule.authorizationProof.membership)||canonicalHash(input.bundle)!==input.packet.sourceBundleHash)throw new Error('graph-control-frame-source-invalid');
  const bytes=Buffer.from(canonicalJson(input.bundle));try{
   if(bytes.length>GRAPH_OWNED_FRAME_PART_BYTES)throw new Error('graph-control-frame-capacity');
   const chunks:string[]=[];for(let offset=0;offset<bytes.length;offset+=GRAPH_OWNED_FRAME_CHUNK_BYTES)chunks.push(bytes.subarray(offset,offset+GRAPH_OWNED_FRAME_CHUNK_BYTES).toString('base64url'));
   const body:Omit<GraphOwnedPrivatePartPlan,'signature'>={v:1,kind:'source-bundle',agentId:this.options.agentId,sender,target:input.target,commandHash:input.commandHash,partHash:canonicalHash(input.bundle),packet:input.packet,packetSignature:input.packetSignature,controlCapsule:input.controlCapsule,lease:input.lease,originalLease:input.originalLease,newMembership:null,bytes:bytes.length,chunkHashes:chunks.map(canonicalHash)};
   const plan={...body,signature:signGraphRecord(GRAPH_OWNED_FRAME_DOMAIN,body,this.options.identity.loadSigningKey())};this.verify(plan,sender,input.target);const key=this.key(plan);if(!this.entries.has(key)){if(this.entries.size>=8192||this.bytes+bytes.length>GRAPH_OWNED_FRAME_ACTIVE_BYTES)throw new Error('graph-control-frame-capacity');const cost=bytes.length+Buffer.byteLength(canonicalJson(plan));this.budget.reserve(cost);this.entries.set(key,{cost,plan:structuredClone(plan),buffer:Buffer.from(bytes),received:new Set(chunks.map((_,index)=>index)),expiresAt:Date.now()+120000,generation:this.generation()});this.budget.track(this.entries.get(key)!.buffer);this.bytes+=bytes.length;}return {plan,key};
  }finally{bytes.fill(0);}
 }
 createRewrapPart(input:{target:string;commandHash:string;packet:GraphOperationPacket;packetSignature:string;controlCapsule:GraphControlCapsule;lease:GraphWitnessLease;originalLease:LeaseRecord;bundle:GraphEncryptedBundle;rewrap:GraphBundleRewrap;newMembership:GraphMembershipEpoch}):{plan:GraphOwnedPrivatePartPlan;key:string}{
  this.sweep();const sender=this.options.identity.loadIdentity().machineId;
  if(!this.options.leaseCoordinator.holdsLease()||!verifyEncryptedBundle(input.bundle,input.controlCapsule.authorizationProof.membership)||canonicalHash(input.bundle)!==input.packet.sourceBundleHash||!verifyMembershipEpoch(input.newMembership,this.options.authority.ownerPublicKey)||!verifyBundleRewrap(input.rewrap,input.bundle,input.newMembership)||input.rewrap.eventId!==input.packet.eventId)throw new Error('graph-control-frame-source-invalid');
  const bytes=Buffer.from(canonicalJson(input.rewrap));try{
   if(bytes.length>GRAPH_OWNED_FRAME_PART_BYTES)throw new Error('graph-control-frame-capacity');
   const chunks:string[]=[];for(let offset=0;offset<bytes.length;offset+=GRAPH_OWNED_FRAME_CHUNK_BYTES)chunks.push(bytes.subarray(offset,offset+GRAPH_OWNED_FRAME_CHUNK_BYTES).toString('base64url'));
   const body:Omit<GraphOwnedPrivatePartPlan,'signature'>={v:1,kind:'source-rewrap',agentId:this.options.agentId,sender,target:input.target,commandHash:input.commandHash,partHash:canonicalHash(input.rewrap),packet:input.packet,packetSignature:input.packetSignature,controlCapsule:input.controlCapsule,lease:input.lease,originalLease:input.originalLease,newMembership:input.newMembership,bytes:bytes.length,chunkHashes:chunks.map(canonicalHash)};
   const plan={...body,signature:signGraphRecord(GRAPH_OWNED_FRAME_DOMAIN,body,this.options.identity.loadSigningKey())};this.verify(plan,sender,input.target);const key=this.key(plan);if(!this.entries.has(key)){if(this.entries.size>=8192||this.bytes+bytes.length>GRAPH_OWNED_FRAME_ACTIVE_BYTES)throw new Error('graph-control-frame-capacity');const cost=bytes.length+Buffer.byteLength(canonicalJson(plan));this.budget.reserve(cost);this.entries.set(key,{cost,plan:structuredClone(plan),buffer:Buffer.from(bytes),received:new Set(chunks.map((_,index)=>index)),expiresAt:Date.now()+120000,generation:this.generation()});this.budget.track(this.entries.get(key)!.buffer);this.bytes+=bytes.length;}return {plan,key};
  }finally{bytes.fill(0);}
 }
 /** Produces one transient wire chunk; the retained outbound copy is purgeable. */
 outboundChunk(key:string,target:string,index:number):string{this.sweep();const entry=this.entries.get(key);if(!entry||entry.plan.sender!==this.options.identity.loadIdentity().machineId||entry.plan.target!==target||!Number.isSafeInteger(index)||index<0||index>=entry.plan.chunkHashes.length)throw new Error('graph-control-frame-unknown');this.verify(entry.plan,entry.plan.sender,target);return entry.buffer.subarray(index*GRAPH_OWNED_FRAME_CHUNK_BYTES,Math.min(entry.buffer.length,(index+1)*GRAPH_OWNED_FRAME_CHUNK_BYTES)).toString('base64url');}
 partPlan(key:string,sender:string):GraphOwnedPrivatePartPlan{this.sweep();const row=this.entries.get(key);if(!row||row.plan.sender!==sender)throw new Error('graph-control-frame-unknown');this.verify(row.plan,sender,this.options.identity.loadIdentity().machineId);return structuredClone(row.plan);}
 release(key:string):void{this.remove(key);}
 /** Proof and negative fence are checked BEFORE reserving any private buffer. */
 begin(plan:GraphOwnedPrivatePartPlan,authenticatedSender:string):string{
  const generation=this.sweep();this.verify(plan,authenticatedSender,this.options.identity.loadIdentity().machineId);
  const key=this.key(plan);if(this.entries.has(key))return key;
  if(this.entries.size>=8192||this.bytes+plan.bytes>GRAPH_OWNED_FRAME_ACTIVE_BYTES)throw new Error('graph-control-frame-capacity');
  const cost=plan.bytes+Buffer.byteLength(canonicalJson(plan));this.budget.reserve(cost);this.entries.set(key,{cost,plan:structuredClone(plan),buffer:Buffer.alloc(plan.bytes),received:new Set(),expiresAt:Date.now()+120000,generation});this.budget.track(this.entries.get(key)!.buffer);this.bytes+=plan.bytes;return key;
 }
 chunk(key:string,authenticatedSender:string,index:number,encoded:string):void{
  this.sweep();const entry=this.entries.get(key);if(!entry||entry.plan.sender!==authenticatedSender)throw new Error('graph-control-frame-unknown');
  this.verify(entry.plan,authenticatedSender,this.options.identity.loadIdentity().machineId);
  if(!Number.isSafeInteger(index)||index<0||index>=entry.plan.chunkHashes.length||typeof encoded!=='string'||encoded.length>Math.ceil(GRAPH_OWNED_FRAME_CHUNK_BYTES*4/3)||!/^[A-Za-z0-9_-]+$/.test(encoded)||canonicalHash(encoded)!==entry.plan.chunkHashes[index])throw new Error('graph-control-frame-chunk-invalid');
  const bytes=Buffer.from(encoded,'base64url');try{if(bytes.toString('base64url')!==encoded||bytes.length!==Math.min(GRAPH_OWNED_FRAME_CHUNK_BYTES,entry.plan.bytes-index*GRAPH_OWNED_FRAME_CHUNK_BYTES))throw new Error('graph-control-frame-chunk-invalid');bytes.copy(entry.buffer,index*GRAPH_OWNED_FRAME_CHUNK_BYTES);entry.received.add(index);}finally{bytes.fill(0);}
 }
 take(key:string,authenticatedSender:string,commandHash:string,originalBundle?:GraphEncryptedBundle):GraphEncryptedBundle|GraphBundleRewrap{
  this.sweep();const entry=this.entries.get(key);if(!entry||entry.plan.sender!==authenticatedSender||entry.plan.commandHash!==commandHash||entry.received.size!==entry.plan.chunkHashes.length)throw new Error('graph-control-frame-incomplete');
  try{this.verify(entry.plan,authenticatedSender,this.options.identity.loadIdentity().machineId);const bundle:unknown=JSON.parse(entry.buffer.toString('utf8'));if(canonicalHash(bundle)!==entry.plan.partHash||(entry.plan.kind==='source-bundle'?!verifyEncryptedBundle(bundle,entry.plan.controlCapsule.authorizationProof.membership):(!originalBundle||canonicalHash(originalBundle)!==entry.plan.packet.sourceBundleHash||!entry.plan.newMembership||!verifyBundleRewrap(bundle as GraphBundleRewrap,originalBundle,entry.plan.newMembership)||(bundle as GraphBundleRewrap).eventId!==entry.plan.packet.eventId)))throw new Error('graph-control-frame-source-invalid');return bundle as GraphEncryptedBundle|GraphBundleRewrap;}finally{this.remove(key);}
 }
 /** Conservative abort of derived transport only; canonical Source is untouched. */
 purge(target:GraphErasureIdentity):void{if(!this.options.fence.isDenied(target))throw new Error('graph-control-frame-deny-required');this.budget.zero();for(const key of this.entries.keys())this.remove(key);this.options.metadata?.clear();}
 assertLocalErasurePurged(target:GraphErasureIdentity):string{this.sweep();if(!this.options.fence.isDenied(target)||this.entries.size||this.bytes||this.options.metadata?.activeBytes)throw new Error('graph-control-frame-purge-incomplete');this.budget.assertZero();return canonicalHash({v:1,scope:this.stateRoot,target,activeBytes:0});}
 close():void{clearInterval(this.timer);this.budget.zero();for(const key of this.entries.keys())this.remove(key);this.options.metadata?.clear();this.closed=true;}
}
