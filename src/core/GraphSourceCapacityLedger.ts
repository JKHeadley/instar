/** Logical local recovery credit only. This component does not preallocate disk,
 * issue Source ACKs, or prove a peer's capacity. Source integration is separate. */
import {durableStamp,isDurablyUnchanged,rememberDurable} from './GraphDurableFileMemo.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {MachineIdentityManager} from './MachineIdentity.js';
import {SingleInstanceLock} from './SingleInstanceLock.js';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from './GraphLocalFiles.js';
import {canonicalHash,canonicalJson,exactFields,hash,validGraphOperationKey,signGraphRecord,verifyGraphRecord,GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES} from './GraphWitnessTypes.js';
import {verifyGraphControlCapsule} from './GraphWitnessControl.js';
import {verifyEncryptedBundle} from './GraphWitnessTypes.js';
import {GRAPH_REPLICATION_MAX_RECORD_BYTES} from './ConversationGraphReplicationLimits.js';
import {GRAPH_CONTEXT_MAX_BYTES,splitGraphMaterialization} from './ConversationGraphMaterializationContexts.js';
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
export interface GraphSourceCapacityPolicy {v:1;durableBytes:number;transientBytes:number;metadataBytes:number;futureSidecarBytesPerRecord:number;futureRowOverheadBytes:number}
export interface GraphSourceCapacityOptions {stateRoot:string;agentId:string;identity:MachineIdentityManager;lock:SingleInstanceLock;ownerPublicKey:crypto.KeyLike;policy:GraphSourceCapacityPolicy}
interface Charge {v:1;agentId:string;machineId:string;policyHash:string;eventId:string;packetHash:string;recordHash:string;recordBytes:number;contextHash:string|null;contextBytes:number;futureSidecarBytes:number;transientBytes:number}
interface SignedCharge {charge:Charge;signature:string}
export interface GraphSourceCapacityInspection {policyHash:string;physicalBytes:number;reservedBytes:number;sharedContextBytes:number;metadataBytes:number;transientHighWaterBytes:number;debt:readonly string[];logicalWithinPolicy:boolean;physicalHeadroomProven:false;readyForSourceAck:false;futureRecoveryReady:false}
const DOMAIN='graph-source-local-capacity-v1',TOKEN=Symbol('local-capacity-reservation');
const queues=new Map<string,Promise<unknown>>();
/** Module-minted logical reservation, never custody/native/owner authority. */
export class GraphLocalSourceCapacityReservation {
 readonly eventId:string;readonly packetHash:string;readonly recordHash:string;readonly policyHash:string;readonly physicalHeadroomProven=false;readonly readyForSourceAck=false;readonly futureRecoveryReady=false;
 #assert:()=>void;
 constructor(token:symbol,charge:Charge,check:()=>void){if(token!==TOKEN)throw new Error('graph-capacity-actual-reservation-required');this.eventId=charge.eventId;this.packetHash=charge.packetHash;this.recordHash=charge.recordHash;this.policyHash=charge.policyHash;this.#assert=check;Object.freeze(this);}
 assertCurrent():void{this.#assert();}
}
export class GraphSourceCapacityLedger {
 readonly stateRoot:string;readonly machineId:string;readonly agentId:string;readonly policyHash:string;
 private readonly directory:string;private readonly rootStat:fs.Stats;private readonly policy:GraphSourceCapacityPolicy;private readonly publicKey:crypto.KeyObject;private readonly ownerPublicKey:crypto.KeyObject;
 constructor(private readonly options:GraphSourceCapacityOptions){
  if(!(options.identity instanceof MachineIdentityManager)||!(options.lock instanceof SingleInstanceLock))throw new Error('graph-capacity-actual-components-required');
  this.stateRoot=fs.realpathSync(options.stateRoot);this.rootStat=fs.lstatSync(this.stateRoot);this.machineId=options.identity.loadIdentity().machineId;this.agentId=options.agentId;
  const p=options.policy;if(!exactFields(p,['v','durableBytes','transientBytes','metadataBytes','futureSidecarBytesPerRecord','futureRowOverheadBytes'])||p.v!==1||!Object.entries(p).every(([key,n])=>key==='v'||Number.isSafeInteger(n)&&n>0))throw new Error('graph-capacity-explicit-policy-required');
  this.options={...options,policy:{...p}};this.ownerPublicKey=crypto.createPublicKey(options.ownerPublicKey instanceof crypto.KeyObject?options.ownerPublicKey.export({type:'spki',format:'pem'}):options.ownerPublicKey);this.policy=Object.freeze({...p});this.policyHash=canonicalHash(this.policy);this.publicKey=crypto.createPublicKey(options.identity.loadSigningKey());this.directory=path.join(this.stateRoot,'state','conversation-graph-capacity');this.scope();ensureGraphLocalDirectory(this.stateRoot,this.directory);
 }
 private scope():void{
  const stat=fs.lstatSync(this.stateRoot);if(!stat.isDirectory()||stat.dev!==this.rootStat.dev||stat.ino!==this.rootStat.ino||fs.realpathSync(this.options.stateRoot)!==this.stateRoot||fs.realpathSync(this.options.identity.baseDir)!==this.stateRoot||this.options.identity.loadIdentity().machineId!==this.machineId||!this.options.lock.revalidate()||fs.realpathSync(this.options.lock.lockPath())!==path.join(this.stateRoot,'local','server-instance.lock')||!crypto.createPublicKey(this.options.identity.loadSigningKey()).equals(this.publicKey))throw new Error('graph-capacity-local-scope-invalid');for(const file of [path.join(this.stateRoot,'local','server-instance.lock'),path.join(this.stateRoot,path.relative(this.options.identity.baseDir,this.options.identity.signingKeyPath))]){assertGraphLocalPath(this.stateRoot,file);const local=fs.lstatSync(file);if(!local.isFile()||local.isSymbolicLink()||local.nlink!==1)throw new Error('graph-capacity-local-file-invalid');}assertGraphLocalPath(this.stateRoot,this.directory);
 }
 private read(file:string,limit:number):Buffer{
  assertGraphLocalPath(this.stateRoot,file);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit)throw new Error('graph-capacity-file-invalid');const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{const opened=fs.fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size)throw new Error('graph-capacity-file-changed');const bytes=Buffer.alloc(opened.size+1),count=fs.readSync(fd,bytes,0,bytes.length,0);if(count!==opened.size)throw new Error('graph-capacity-file-changed');if(!isDurablyUnchanged(file)){const stamp=durableStamp(file);fs.fsyncSync(fd);rememberDurable(file,stamp);}return bytes.subarray(0,count);}finally{fs.closeSync(fd);}
 }
 private flushDirectory(directory:string,changed=false):void{if(!changed&&isDurablyUnchanged(directory))return;const stamp=durableStamp(directory),fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);rememberDurable(directory,stamp);}finally{fs.closeSync(fd);}}
 private charge(record:ConversationGraphReplicationRecord):Charge{
  if(record.packet.agentId!==this.agentId||!verifyGraphControlCapsule({v:1,coreType:record.coreType,core:record.core,authorizationProof:record.authorizationProof},record.packet,this.ownerPublicKey)||!record.encryptedSourceBundle||!verifyEncryptedBundle(record.encryptedSourceBundle,record.authorizationProof.membership)||canonicalHash(record.encryptedSourceBundle)!==record.packet.sourceBundleHash)throw new Error('graph-capacity-candidate-invalid');
  const self=record.authorizationProof.membership.members.find(row=>row.machineId===this.machineId);if(!self||!crypto.createPublicKey(self.signingPublicKey).equals(this.publicKey))throw new Error('graph-capacity-candidate-local-key-invalid');
  const writer=record.authorizationProof.membership.members.find(row=>row.machineId===record.packet.writerId);if(!writer||!verifyGraphRecord('graph-operation-packet-v1',record.packet,record.packetSignature,writer.signingPublicKey))throw new Error('graph-capacity-candidate-signature-invalid');
  const {coreType,packet,packetSignature,core,authorizationProof,encryptedSourceBundle,materialization}=record,body={coreType,packet,packetSignature,core,authorizationProof,encryptedSourceBundle};const split=materialization?splitGraphMaterialization(materialization):null,recordBytes=Buffer.byteLength(canonicalJson({...body,...(split?{materialization:split.reference}:{})})),contextBytes=split?Buffer.byteLength(canonicalJson(split.context)):0;
  if(recordBytes>GRAPH_REPLICATION_MAX_RECORD_BYTES||contextBytes>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-capacity-candidate-limit');const transientBytes=2*(recordBytes+contextBytes)+this.policy.futureRowOverheadBytes;if(!Number.isSafeInteger(transientBytes))throw new Error('graph-capacity-charge-overflow');
  return{v:1,agentId:this.agentId,machineId:this.machineId,policyHash:this.policyHash,eventId:record.packet.eventId,packetHash:canonicalHash(record.packet),recordHash:canonicalHash(body),recordBytes,contextHash:split?canonicalHash(split.context):null,contextBytes,futureSidecarBytes:this.policy.futureSidecarBytesPerRecord,transientBytes};
 }
 private scan():{charges:Map<string,SignedCharge>;inspection:GraphSourceCapacityInspection}{
  this.scope();const charges=new Map<string,SignedCharge>(),contexts=new Map<string,number>(),debt:string[]=[];let metadataBytes=0,reservedBytes=0,transientHighWaterBytes=0,physicalBytes=0;
  const names=fs.readdirSync(this.directory).sort();if(names.length>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES*2)throw new Error('graph-capacity-metadata-count');
  for(const name of names){
   const file=path.join(this.directory,name),stat=fs.lstatSync(file);metadataBytes+=stat.isFile()?stat.size:0;
   if(!/^[a-f0-9]{64}\.json$/.test(name)){debt.push('unclassified-capacity-file');continue;}
   const raw=JSON.parse(this.read(file,65536).toString('utf8')) as SignedCharge,c=raw?.charge;
   if(!exactFields(raw,['charge','signature'])||!exactFields(c,['v','agentId','machineId','policyHash','eventId','packetHash','recordHash','recordBytes','contextHash','contextBytes','futureSidecarBytes','transientBytes'])||c.v!==1||!['graph-event','header-op','source-observation'].some(type=>validGraphOperationKey(type,c.eventId))||!hash(c.packetHash)||!hash(c.recordHash)||(c.contextHash!==null&&!hash(c.contextHash))||c.recordBytes>GRAPH_REPLICATION_MAX_RECORD_BYTES||c.contextBytes>GRAPH_CONTEXT_MAX_BYTES||c.agentId!==this.agentId||c.machineId!==this.machineId||c.policyHash!==this.policyHash||name!==canonicalHash(c.eventId)+'.json'||!verifyGraphRecord(DOMAIN,c,raw.signature,this.publicKey)||![c.recordBytes,c.contextBytes,c.futureSidecarBytes,c.transientBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||c.futureSidecarBytes!==this.policy.futureSidecarBytesPerRecord||c.transientBytes!==2*(c.recordBytes+c.contextBytes)+this.policy.futureRowOverheadBytes||!!c.contextHash!==(c.contextBytes>0))throw new Error('graph-capacity-retained-charge-invalid');
   charges.set(c.eventId,raw);reservedBytes+=c.recordBytes+c.futureSidecarBytes;transientHighWaterBytes=Math.max(transientHighWaterBytes,c.transientBytes);
   if(c.contextHash){const old=contexts.get(c.contextHash);if(old!==undefined&&old!==c.contextBytes)throw new Error('graph-capacity-context-conflict');contexts.set(c.contextHash,c.contextBytes);}
  }
  // Measure actual durable and retained stage copies separately. No optimistic
  // refund for cancellation, duplicate physical copies, or unknown scratch.
  let nodes=0;const measure=(directory:string,depth=0):void=>{if(depth>16)throw new Error('graph-capacity-physical-depth');for(const name of fs.readdirSync(directory)){if(++nodes>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES*64)throw new Error('graph-capacity-physical-count');const file=path.join(directory,name);assertGraphLocalPath(this.stateRoot,file);const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))throw new Error('graph-capacity-physical-file-invalid');if(stat.isDirectory())measure(file,depth+1);else{physicalBytes+=stat.size;if(/\.(?:tmp|pending)$/.test(name))debt.push('unclassified-physical-scratch');}}};
  for(const relative of ['state/conversation-graph-source','state/conversation-graph-intake','state/conversation-graph-transfer','conversation-graph']){const directory=path.join(this.stateRoot,relative);assertGraphLocalPath(this.stateRoot,directory);if(fs.existsSync(directory))measure(directory);}
  const sharedContextBytes=[...contexts.values()].reduce((sum,n)=>sum+n,0),total=physicalBytes+reservedBytes+sharedContextBytes+metadataBytes;
  const logicalWithinPolicy=Number.isSafeInteger(total)&&total<=this.policy.durableBytes&&metadataBytes+[...charges.values()].reduce((sum,row)=>sum+row.charge.futureSidecarBytes,0)<=this.policy.metadataBytes&&transientHighWaterBytes<=this.policy.transientBytes&&charges.size<=GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES&&debt.length===0;
  this.flushDirectory(this.directory);this.scope();return{charges,inspection:{policyHash:this.policyHash,physicalBytes,reservedBytes,sharedContextBytes,metadataBytes,transientHighWaterBytes,debt:Object.freeze([...new Set(debt)]),logicalWithinPolicy,physicalHeadroomProven:false,readyForSourceAck:false,futureRecoveryReady:false}};
 }
 assertIntakeContext(directory:string,ownerPublicKey:crypto.KeyLike):void{this.scope();assertGraphLocalPath(this.stateRoot,path.join(this.stateRoot,'state','conversation-graph-intake'));const owner=crypto.createPublicKey(ownerPublicKey instanceof crypto.KeyObject?ownerPublicKey.export({type:'spki',format:'pem'}):ownerPublicKey);if(fs.realpathSync(directory)!==path.join(this.stateRoot,'state','conversation-graph-intake')||!owner.equals(this.ownerPublicKey))throw new Error('graph-capacity-intake-scope-invalid');}
 assertLocalContext(context:{stateRoot:string;agentId:string;machineId:string;signingPublicKey:crypto.KeyLike;ownerPublicKey:crypto.KeyLike}):void{this.scope();const key=(value:crypto.KeyLike)=>crypto.createPublicKey(value instanceof crypto.KeyObject?value.export({type:'spki',format:'pem'}):value);if(fs.realpathSync(context.stateRoot)!==this.stateRoot||context.agentId!==this.agentId||context.machineId!==this.machineId||!key(context.signingPublicKey).equals(this.publicKey)||!key(context.ownerPublicKey).equals(this.ownerPublicKey))throw new Error('graph-capacity-component-scope-invalid');}
 inspect():GraphSourceCapacityInspection{return this.scan().inspection;}
 reserve(record:ConversationGraphReplicationRecord):Promise<GraphLocalSourceCapacityReservation>{
  // Freeze candidate before awaiting the process-local per-root admission queue.
  const charge=this.charge(record),operation=(queues.get(this.stateRoot)??Promise.resolve()).then(()=>{
   const before=this.scan(),prior=before.charges.get(charge.eventId);if(prior){if(canonicalHash(prior.charge)!==canonicalHash(charge))throw new Error('graph-capacity-idempotency-conflict');return this.reservation(prior);}
   const contextKnown=charge.contextHash&&[...before.charges.values()].some(row=>row.charge.contextHash===charge.contextHash),signed={charge,signature:signGraphRecord(DOMAIN,charge,this.options.identity.loadSigningKey())},bytes=canonicalJson(signed);
   const next=before.inspection.physicalBytes+before.inspection.reservedBytes+before.inspection.sharedContextBytes+before.inspection.metadataBytes+charge.recordBytes+charge.futureSidecarBytes+(contextKnown?0:charge.contextBytes)+Buffer.byteLength(bytes);
   if(!Number.isSafeInteger(next)||!before.inspection.logicalWithinPolicy||next>this.policy.durableBytes||before.inspection.metadataBytes+[...before.charges.values()].reduce((sum,row)=>sum+row.charge.futureSidecarBytes,0)+charge.futureSidecarBytes+Buffer.byteLength(bytes)>this.policy.metadataBytes||charge.transientBytes>this.policy.transientBytes||before.charges.size>=GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)throw new Error('graph-capacity-local-credit-unavailable');
   const file=path.join(this.directory,canonicalHash(charge.eventId)+'.json'),fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}// A new entry always flushes: two creates can share a coarse directory timestamp.
   this.flushDirectory(this.directory,true);this.flushDirectory(path.dirname(this.directory));const stored=this.scan().charges.get(charge.eventId);if(!stored||canonicalHash(stored)!==canonicalHash(signed))throw new Error('graph-capacity-publication-readback-invalid');return this.reservation(stored);
  });queues.set(this.stateRoot,operation.catch(()=>{/* @silent-fallback-ok: only release queue scheduling; caller keeps original rejection and no reservation/ACK is returned. */}));return operation;
 }
 private reservation(signed:SignedCharge):GraphLocalSourceCapacityReservation{return new GraphLocalSourceCapacityReservation(TOKEN,signed.charge,()=>{const current=this.scan(),row=current.charges.get(signed.charge.eventId);if(!row||canonicalHash(row)!==canonicalHash(signed)||!current.inspection.logicalWithinPolicy)throw new Error('graph-capacity-reservation-stale');});}
}
