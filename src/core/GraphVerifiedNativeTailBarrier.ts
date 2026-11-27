/** Typed, paged closure proofs. These prove signed metadata for ONE supplied
 * membership/lease; they do not elect a writer or grant live native authority. */
import crypto from 'node:crypto';
import {GraphPublicMetadataData,GraphPublicMetadataPages,type GraphPublicMetadataDescriptor} from './GraphPublicMetadataPages.js';
import {GRAPH_NATIVE_TAIL_DOMAIN,validateGraphNativeTailEntries,type GraphNativeTailEntry,type GraphNativeTailReceipt} from './ConversationGraphNativeTail.js';
import {canonicalHash,canonicalJson,exactFields,hash,iso,opaque,verifyFencedLeaseBridge,verifyGraphRecord,verifyMembershipEpoch,verifyWitnessLease,type GraphMembershipEpoch,type GraphWitnessLease} from './GraphWitnessTypes.js';
import type {LeaseRecord} from './types.js';
const TOKEN=Symbol('graph-verified-native-tail'),MAX_ROWS=20000,MAX_ROW_BYTES=4096;
export interface GraphPagedNativeTailClosure {receipt:GraphNativeTailReceipt;observedLease:GraphWitnessLease;originalObservedLease:LeaseRecord;entries:GraphPublicMetadataData}
export interface GraphRetainedNativeTailClosure {receipt:GraphNativeTailReceipt;observedLease:GraphWitnessLease;originalObservedLease:LeaseRecord;entries:GraphPublicMetadataDescriptor}
export interface GraphNativeTailBarrierCommitment {v:1;kind:'graph-native-tail-barrier-commitment';membershipHash:string;leaseHash:string;closedTailsHash:string;memberCount:number;receiptSetHash:string;pagesRootHash:string}
function immutable<T>(value:T):T{const result=structuredClone(value);const freeze=(raw:unknown):void=>{if(raw&&typeof raw==='object'){for(const child of Object.values(raw))freeze(child);Object.freeze(raw);}};freeze(result);return result;}
function context(membership:GraphMembershipEpoch,lease:GraphWitnessLease,owner:crypto.KeyLike):void{if(!verifyMembershipEpoch(membership,owner)||!verifyWitnessLease(lease,membership))throw new Error('graph-paged-tail-context-invalid');}
/** Exact canonical grammar of the legacy entries array, with no whole-array
 * parse or string. Valid entry fields are ASCII and the maximum canonical row
 * is below4096 bytes under the existing200-character operation-key validator. */
async function* rows(data:GraphPublicMetadataData):AsyncGenerator<GraphNativeTailEntry>{
 let pending='',state:'start'|'first'|'item'|'separator'|'done'='start';
 for await(const chunk of data.bytes()){
  for(const byte of chunk)if(byte<32||byte>126)throw new Error('graph-paged-tail-noncanonical-bytes');pending+=chunk.toString('ascii');
  for(;;){if(!pending.length)break;if(state==='start'){if(pending[0]!=='[')throw new Error('graph-paged-tail-array-invalid');pending=pending.slice(1);state='first';continue;}
   if(state==='done')throw new Error('graph-paged-tail-trailing-bytes');
   if(state==='separator'){if(pending[0]===']'){pending=pending.slice(1);state='done';continue;}if(pending[0]!==',')throw new Error('graph-paged-tail-separator-invalid');pending=pending.slice(1);state='item';continue;}
   if(state==='first'&&pending[0]===']'){pending=pending.slice(1);state='done';continue;}
   if(pending[0]!=='{')throw new Error('graph-paged-tail-entry-invalid');const end=pending.indexOf('}');if(end===-1){if(pending.length>MAX_ROW_BYTES)throw new Error('graph-paged-tail-row-capacity');break;}const raw=pending.slice(0,end+1);if(raw.length>MAX_ROW_BYTES)throw new Error('graph-paged-tail-row-capacity');let row:unknown;try{row=JSON.parse(raw);}catch{throw new Error('graph-paged-tail-entry-invalid');}if(!validateGraphNativeTailEntries([row])||canonicalJson(row)!==raw)throw new Error('graph-paged-tail-entry-invalid');pending=pending.slice(end+1);state='separator';yield immutable(row as GraphNativeTailEntry);
  }
 }
 if(state!=='done'||pending.length)throw new Error('graph-paged-tail-incomplete');
}
export async function persistGraphNativeTailEntries(store:GraphPublicMetadataPages,input:AsyncIterable<GraphNativeTailEntry>|Iterable<GraphNativeTailEntry>):Promise<GraphPublicMetadataData>{
 if(!(store instanceof GraphPublicMetadataPages))throw new Error('graph-paged-tail-actual-store-required');
 async function* bytes(){yield Buffer.from('[');let count=0,sequence=0;const ids=new Set<string>();for await(const raw of input){const row=immutable(raw);if(!validateGraphNativeTailEntries([row])||row.sourceSequence<=sequence||ids.has(row.eventId)||count>=MAX_ROWS)throw new Error('graph-paged-tail-entry-order');const value=canonicalJson(row);if(value.length>MAX_ROW_BYTES)throw new Error('graph-paged-tail-row-capacity');if(count++)yield Buffer.from(',');yield Buffer.from(value);sequence=row.sourceSequence;ids.add(row.eventId);}yield Buffer.from(']');}
 return store.put(bytes());
}
function header(value:Omit<GraphPagedNativeTailClosure,'entries'>,membership:GraphMembershipEpoch,current:GraphWitnessLease):void{
 const r=value.receipt,member=membership.members.find(row=>row.machineId===r?.machineId);
 if(!exactFields(value,['receipt','observedLease','originalObservedLease'])||!r||!exactFields(r,['v','agentId','membershipHash','writerId','leaseEpoch','nativeLeaseHash','machineId','tailHash','entryCount','highestSourceSequence','recordedAt','signature'])||r.v!==1||r.agentId!==membership.agentId||r.membershipHash!==canonicalHash(membership)||r.writerId!==current.writerId||r.leaseEpoch!==current.leaseEpoch||!member||!iso(r.recordedAt)||!opaque(r.machineId)||!hash(r.nativeLeaseHash)||r.nativeLeaseHash!==canonicalHash(value.originalObservedLease)||!verifyFencedLeaseBridge(value.observedLease,value.originalObservedLease,membership)||value.observedLease.writerId!==r.writerId||value.observedLease.leaseEpoch!==r.leaseEpoch||!Number.isSafeInteger(r.entryCount)||r.entryCount<0||r.entryCount>MAX_ROWS||!Number.isSafeInteger(r.highestSourceSequence)||r.highestSourceSequence<0||!hash(r.tailHash))throw new Error('graph-paged-tail-receipt-invalid');const{signature,...body}=r;if(!verifyGraphRecord(GRAPH_NATIVE_TAIL_DOMAIN,body,signature,member.signingPublicKey))throw new Error('graph-paged-tail-signature-invalid');
}
export class GraphVerifiedNativeTailClosure {
 readonly receipt:Readonly<GraphNativeTailReceipt>;readonly observedLease:Readonly<GraphWitnessLease>;readonly originalObservedLease:Readonly<LeaseRecord>;
 #data:GraphPublicMetadataData;#membershipHash:string;#leaseHash:string;#owner:crypto.KeyLike;
 constructor(token:symbol,value:GraphPagedNativeTailClosure,membership:GraphMembershipEpoch,lease:GraphWitnessLease,owner:crypto.KeyLike){if(token!==TOKEN)throw new Error('graph-paged-tail-actual-verified-closure-required');this.receipt=immutable(value.receipt);this.observedLease=immutable(value.observedLease);this.originalObservedLease=immutable(value.originalObservedLease);this.#data=value.entries;this.#membershipHash=canonicalHash(membership);this.#leaseHash=canonicalHash(lease);this.#owner=crypto.createPublicKey(owner instanceof crypto.KeyObject?owner.export({type:'spki',format:'pem'}):owner);Object.freeze(this);}
 assertCurrent(membership:GraphMembershipEpoch,lease:GraphWitnessLease):void{context(membership,lease,this.#owner);if(canonicalHash(membership)!==this.#membershipHash||canonicalHash(lease)!==this.#leaseHash)throw new Error('graph-paged-tail-context-changed');header({receipt:this.receipt,observedLease:this.observedLease,originalObservedLease:this.originalObservedLease},membership,lease);this.#data.assertCurrent();}
 entries():AsyncGenerator<GraphNativeTailEntry>{return rows(this.#data);}
 get entriesDescriptor(){return Object.freeze({...this.#data.descriptor});}
 get stateRoot():string{return this.#data.stateRoot;}
 async *canonicalEntryBytes():AsyncGenerator<Buffer>{for await(const piece of this.#data.bytes())yield piece;}
}
export async function verifyGraphNativeTailClosurePages(value:GraphPagedNativeTailClosure,membership:GraphMembershipEpoch,lease:GraphWitnessLease,owner:crypto.KeyLike):Promise<GraphVerifiedNativeTailClosure>{
 context(membership,lease,owner);if(!exactFields(value,['receipt','observedLease','originalObservedLease','entries'])||!(value.entries instanceof GraphPublicMetadataData))throw new Error('graph-paged-tail-actual-data-required');const data=value.entries,frozen={receipt:immutable(value.receipt),observedLease:immutable(value.observedLease),originalObservedLease:immutable(value.originalObservedLease)},m=immutable(membership),l=immutable(lease);header(frozen,m,l);data.assertCurrent();if(data.descriptor.hash!==frozen.receipt.tailHash)throw new Error('graph-paged-tail-hash-mismatch');let count=0,sequence=0;const ids=new Set<string>();for await(const row of rows(data)){if(++count>MAX_ROWS||row.sourceSequence<=sequence||ids.has(row.eventId))throw new Error('graph-paged-tail-entry-order');sequence=row.sourceSequence;ids.add(row.eventId);}if(count!==frozen.receipt.entryCount||sequence!==frozen.receipt.highestSourceSequence)throw new Error('graph-paged-tail-count-mismatch');data.assertCurrent();return new GraphVerifiedNativeTailClosure(TOKEN,{...frozen,entries:data},m,l,owner);
}
async function* union(closures:ReadonlyArray<GraphVerifiedNativeTailClosure>):AsyncGenerator<GraphNativeTailEntry>{
 const cursors=closures.map(c=>c.entries()),heads=await Promise.all(cursors.map(cursor=>cursor.next()));let sequence=0,predecessor:string|null=null;
 try{for(;;){const live=heads.filter(row=>!row.done);if(!live.length)break;const next=Math.min(...live.map(row=>row.value!.sourceSequence));let chosen:GraphNativeTailEntry|undefined;for(let index=0;index<heads.length;index++)if(!heads[index].done&&heads[index].value!.sourceSequence===next){const row=heads[index].value!;if(chosen&&canonicalHash(row)!==canonicalHash(chosen))throw new Error('graph-paged-tail-overlap-conflict');chosen=row;heads[index]=await cursors[index].next();}if(!chosen||next!==sequence+1||chosen.predecessorHash!==predecessor)throw new Error('graph-paged-tail-prefix-gap');sequence=next;predecessor=chosen.coreHash;yield chosen;}}finally{for(const cursor of cursors)await cursor.return(undefined);}
}
export class GraphVerifiedNativeTailBarrier {
 readonly memberCount:number;readonly highestSourceSequence:number;
 #closures:ReadonlyArray<GraphVerifiedNativeTailClosure>;#membership:GraphMembershipEpoch;#lease:GraphWitnessLease;
 constructor(token:symbol,closures:GraphVerifiedNativeTailClosure[],membership:GraphMembershipEpoch,lease:GraphWitnessLease,highest:number){if(token!==TOKEN)throw new Error('graph-paged-tail-actual-barrier-required');this.#closures=Object.freeze([...closures]);this.#membership=immutable(membership);this.#lease=immutable(lease);this.memberCount=closures.length;this.highestSourceSequence=highest;Object.freeze(this);}
 assertCurrent(membership:GraphMembershipEpoch,lease:GraphWitnessLease):void{for(const closure of this.#closures)closure.assertCurrent(membership,lease);if(canonicalHash(membership)!==canonicalHash(this.#membership)||canonicalHash(lease)!==canonicalHash(this.#lease))throw new Error('graph-paged-tail-context-changed');}
 async *entries():AsyncGenerator<GraphNativeTailEntry>{this.assertCurrent(this.#membership,this.#lease);yield*union(this.#closures);this.assertCurrent(this.#membership,this.#lease);}
 assertStateRoot(stateRoot:string):void{if(this.#closures.some(row=>row.stateRoot!==stateRoot))throw new Error('graph-paged-tail-state-root-mismatch');this.assertCurrent(this.#membership,this.#lease);}
 retainedClosureDescriptors():ReadonlyArray<GraphRetainedNativeTailClosure>{this.assertCurrent(this.#membership,this.#lease);return Object.freeze(this.#closures.map(row=>immutable({receipt:row.receipt,observedLease:row.observedLease,originalObservedLease:row.originalObservedLease,entries:{...row.entriesDescriptor}})));}
 /** Compact DATA commitment derived only from these actual verified proofs.
  * Domain consumers must still bind their live supplied membership/lease. */
 async commitment():Promise<Readonly<GraphNativeTailBarrierCommitment>>{this.assertCurrent(this.#membership,this.#lease);const sorted=[...this.#closures].sort((a,b)=>a.receipt.machineId.localeCompare(b.receipt.machineId)),closedTailsHash=await this.closedTailsHash(),value:GraphNativeTailBarrierCommitment={v:1,kind:'graph-native-tail-barrier-commitment',membershipHash:canonicalHash(this.#membership),leaseHash:canonicalHash(this.#lease),closedTailsHash,memberCount:this.memberCount,receiptSetHash:canonicalHash(sorted.map(row=>row.receipt)),pagesRootHash:canonicalHash(sorted.map(row=>({machineId:row.receipt.machineId,entries:row.entriesDescriptor})))};this.assertCurrent(this.#membership,this.#lease);return Object.freeze(value);}
 /** EXACT legacy graphNativeClosedTailsHash grammar and machine sorting. */
 async closedTailsHash():Promise<string>{this.assertCurrent(this.#membership,this.#lease);const h=crypto.createHash('sha256');h.update('[');let count=0;for(const closure of [...this.#closures].sort((a,b)=>a.receipt.machineId.localeCompare(b.receipt.machineId))){if(count++)h.update(',');h.update('{"entries":');for await(const bytes of closure.canonicalEntryBytes())h.update(bytes);h.update(',"observedLease":'+canonicalJson(closure.observedLease)+',"originalObservedLease":'+canonicalJson(closure.originalObservedLease)+',"receipt":'+canonicalJson(closure.receipt)+'}');}h.update(']');this.assertCurrent(this.#membership,this.#lease);return h.digest('hex');}
}
export async function verifyGraphNativeTailBarrierPages(closures:GraphVerifiedNativeTailClosure[],membership:GraphMembershipEpoch,lease:GraphWitnessLease):Promise<GraphVerifiedNativeTailBarrier>{
 const held=[...closures],m=immutable(membership),l=immutable(lease);if(!Array.isArray(closures)||held.length!==m.members.length||held.length<1||held.length>64||held.some(row=>!(row instanceof GraphVerifiedNativeTailClosure))||new Set(held.map(row=>row.receipt.machineId)).size!==held.length||m.members.some(member=>!held.some(row=>row.receipt.machineId===member.machineId)))throw new Error('graph-paged-tail-member-set-invalid');for(const closure of held)closure.assertCurrent(m,l);let highest=0;for await(const row of union(held))highest=row.sourceSequence;for(const closure of held)closure.assertCurrent(m,l);return new GraphVerifiedNativeTailBarrier(TOKEN,held,m,l,highest);
}
