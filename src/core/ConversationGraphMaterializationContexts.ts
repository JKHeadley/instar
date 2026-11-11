/** Shared opaque transfer proof custody. Per-operation references contain no
 * envelopes; actual sealed keys remain in independently erasable sidecars. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import {GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES,validateRecoverySourceManifest,validGraphOperationKey,type GraphRecoverySourceManifest,type GraphRewrapInventoryEntry,canonicalHash,canonicalJson,exactFields,hash} from './GraphWitnessTypes.js';
import {verifyGraphHistoricalMaterializationAuthority,type GraphMaterializationTrust,type GraphHistoricalMaterialization} from './ConversationGraphHistoricalMaterialization.js';
import {GraphPublicMetadataPages,GraphPublicMetadataData,type GraphPublicMetadataDescriptor} from './GraphPublicMetadataPages.js';

export const GRAPH_CONTEXT_MAX_BYTES=32*1024*1024;
export const GRAPH_CONTEXT_PAGE_BYTES=128*1024;
export interface GraphMaterializationContextReference {v:1;contextHash:string;rewrapHash:string}
export type GraphMaterializationContext=Omit<GraphHistoricalMaterialization,'rewrapHash'>;
export interface GraphMaterializationContextPage {v:1;contextHash:string;index:number;pages:number;totalBytes:number;data:string}
export function validateGraphMaterializationReference(raw:unknown):raw is GraphMaterializationContextReference {
 const ref=raw as GraphMaterializationContextReference;return exactFields(ref,['v','contextHash','rewrapHash'])&&ref.v===1&&hash(ref.contextHash)&&hash(ref.rewrapHash);
}
interface Shared {context:GraphMaterializationContext;contextHash:string;bytes:number;hashes:{activationHash:string;manifestHash:string;rewrapInventoryHash:string;leaseHash:string;originalLeaseHash:string}}
const shared=new WeakMap<object,Shared>();
function same(proof:GraphHistoricalMaterialization,value:Shared):boolean{return proof.activation===value.context.activation&&proof.manifest===value.context.manifest&&proof.rewrapInventory===value.context.rewrapInventory&&proof.currentLease===value.context.currentLease&&proof.originalCurrentLease===value.context.originalCurrentLease;}
function freeze(value:unknown):void{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
function entry(proof:GraphHistoricalMaterialization):Shared{
 const cached=shared.get(proof.manifest);if(cached&&same(proof,cached))return cached;
 const {rewrapHash:_rewrap,...context}=proof,bytes=Buffer.byteLength(canonicalJson(context));
 return {context,contextHash:canonicalHash(context),bytes,hashes:{activationHash:canonicalHash(proof.activation),manifestHash:canonicalHash(proof.manifest),rewrapInventoryHash:canonicalHash(proof.rewrapInventory),leaseHash:canonicalHash(proof.currentLease),originalLeaseHash:canonicalHash(proof.originalCurrentLease)}};
}
export function graphMaterializationSharedHashes(proof:GraphHistoricalMaterialization){return proof instanceof GraphSelectedMaterializationV2?proof.context.hashes:entry(proof).hashes;}
export function graphMaterializationContextSize(proof:GraphHistoricalMaterialization):number{return proof instanceof GraphSelectedMaterializationV2?proof.context.canonicalBytes:entry(proof).bytes;}
export function splitGraphMaterialization(proof:GraphHistoricalMaterialization):{reference:GraphMaterializationContextReference;context:GraphMaterializationContext}{
 if(proof instanceof GraphSelectedMaterializationV2)throw new Error('graph-paged-materialization-full-array-unavailable');const value=entry(proof);return {reference:{v:1,contextHash:value.contextHash,rewrapHash:proof.rewrapHash},context:value.context};
}
export function hydrateGraphMaterialization(reference:GraphMaterializationContextReference,bytes:Uint8Array):GraphHistoricalMaterialization {
 if(!validateGraphMaterializationReference(reference)||bytes.byteLength>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-context-invalid-reference');
 const context=JSON.parse(Buffer.from(bytes).toString('utf8')) as GraphMaterializationContext;
 if(!exactFields(context,['activation','manifest','rewrapInventory','currentLease','originalCurrentLease'])||canonicalHash(context)!==reference.contextHash)throw new Error('graph-context-hash-mismatch');
 return {...context,rewrapHash:reference.rewrapHash};
}
export function validateGraphContextPage(raw:unknown,reference:GraphMaterializationContextReference,index:number):raw is GraphMaterializationContextPage {
 const p=raw as GraphMaterializationContextPage;
 if(!exactFields(p,['v','contextHash','index','pages','totalBytes','data'])||p.v!==1||p.contextHash!==reference.contextHash||p.index!==index
  ||!Number.isSafeInteger(p.totalBytes)||p.totalBytes<1||p.totalBytes>GRAPH_CONTEXT_MAX_BYTES
  ||p.pages!==Math.ceil(p.totalBytes/GRAPH_CONTEXT_PAGE_BYTES)||!Number.isInteger(p.index)||p.index<0||p.index>=p.pages
  ||typeof p.data!=='string'||p.data.length>Math.ceil(GRAPH_CONTEXT_PAGE_BYTES/3)*4||!/^[A-Za-z0-9_-]+$/.test(p.data))return false;
 const bytes=Buffer.from(p.data,'base64url');return bytes.toString('base64url')===p.data
  &&bytes.length===Math.min(GRAPH_CONTEXT_PAGE_BYTES,p.totalBytes-index*GRAPH_CONTEXT_PAGE_BYTES);
}
export class ConversationGraphMaterializationContexts {
 private readonly cache=new Map<string,Buffer>();
 private readonly parsed=new Map<string,GraphMaterializationContext>();
 private readonly published=new Set<string>();
 private readonly interned=new WeakMap<object,GraphMaterializationContext>();
 constructor(private readonly directory:string){}
 intern(proof:GraphHistoricalMaterialization):GraphHistoricalMaterialization{
  if(proof instanceof GraphSelectedMaterializationV2){proof.assertCurrent();return proof;}let value=shared.get(proof.manifest);if(!value||!same(proof,value)){value=entry(proof);if(value.bytes>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-context-over-capacity');freeze(value.context);shared.set(proof.manifest,value);}
  this.interned.set(proof.manifest,value.context);return Object.freeze({...value.context,rewrapHash:proof.rewrapHash});
 }
 owns(proof:GraphHistoricalMaterialization):boolean{if(proof instanceof GraphSelectedMaterializationV2)return false;const context=this.interned.get(proof.manifest);return !!context&&proof.activation===context.activation&&proof.rewrapInventory===context.rewrapInventory&&proof.currentLease===context.currentLease&&proof.originalCurrentLease===context.originalCurrentLease;}
 async persistVerified(proof:GraphHistoricalMaterialization):Promise<GraphMaterializationContextReference>{
  if(proof instanceof GraphSelectedMaterializationV2)throw new Error('graph-paged-materialization-source-held-import-required');proof=this.intern(proof);const {reference,context}=splitGraphMaterialization(proof);if(this.published.has(reference.contextHash))return reference;const bytes=Buffer.from(canonicalJson(context));
  if(bytes.length>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-context-over-capacity');
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});for(const parent of [path.dirname(this.directory),path.dirname(path.dirname(this.directory))]){const entry=await fs.open(parent,'r');try{await entry.sync();}finally{await entry.close();}}const file=path.join(this.directory,`${reference.contextHash}.json`);
  try{const existing=await this.bytes(reference.contextHash);if(!existing.equals(bytes))throw new Error('graph-context-conflict');this.published.add(reference.contextHash);return reference;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=`${file}.${crypto.randomUUID()}.tmp`,handle=await fs.open(temporary,'wx',0o600);
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  try{await fs.link(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!(await this.bytes(reference.contextHash)).equals(bytes))throw error;}
  finally{SafeFsExecutor.safeUnlinkSync(temporary,{operation:'graph-context:publication-temp'});}
  const directory=await fs.open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}
  this.remember(reference.contextHash,bytes);this.published.add(reference.contextHash);return reference;
 }
 private remember(key:string,bytes:Buffer):void{this.cache.set(key,bytes);while(this.cache.size>2)this.cache.delete(this.cache.keys().next().value!);}
 async bytes(key:string):Promise<Buffer>{
  if(!hash(key))throw new Error('graph-context-key-invalid');const cached=this.cache.get(key);if(cached)return Buffer.from(cached);
  const file=await fs.open(path.join(this.directory,`${key}.json`),'r');let bytes:Buffer;
  try{const stat=await file.stat();if(!stat.isFile()||stat.size>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-context-over-capacity');bytes=await file.readFile();}finally{await file.close();}
  if(canonicalHash(JSON.parse(bytes.toString('utf8')))!==key)throw new Error('graph-context-corrupt');this.remember(key,bytes);return Buffer.from(bytes);
 }
 async hydrate(reference:GraphMaterializationContextReference):Promise<GraphHistoricalMaterialization>{
  let context=this.parsed.get(reference.contextHash);if(!context){const hydrated=hydrateGraphMaterialization(reference,await this.bytes(reference.contextHash));const {rewrapHash:_hash,...common}=hydrated;context=common;
   freeze(context);this.parsed.set(reference.contextHash,context);while(this.parsed.size>2)this.parsed.delete(this.parsed.keys().next().value!);
  }return this.intern({...context,rewrapHash:reference.rewrapHash});
 }
 async page(key:string,index:number):Promise<GraphMaterializationContextPage>{
  const bytes=this.cache.get(key)??await this.bytes(key),pages=Math.ceil(bytes.length/GRAPH_CONTEXT_PAGE_BYTES);
  if(!Number.isInteger(index)||index<0||index>=pages)throw new Error('graph-context-page-invalid');
  return {v:1,contextHash:key,index,pages,totalBytes:bytes.length,data:bytes.subarray(index*GRAPH_CONTEXT_PAGE_BYTES,(index+1)*GRAPH_CONTEXT_PAGE_BYTES).toString('base64url')};
 }
}

/** Disjoint PUBLIC storage projection. Legacy v1 readers continue to reject it.
 * The original ACT, manifest, inventory and whole-context hashes are preserved. */
export type GraphMaterializationManifestHeader=Omit<GraphRecoverySourceManifest,'entries'>;
type ManifestRow=GraphRecoverySourceManifest['entries'][number];
interface PagedRoot {
 v:2;kind:'graph-materialization-context-pages';contextHash:string;
 activation:GraphHistoricalMaterialization['activation'];manifestHeader:GraphMaterializationManifestHeader;
 entries:GraphPublicMetadataDescriptor;rewrapInventory:GraphPublicMetadataDescriptor;
 currentLease:GraphHistoricalMaterialization['currentLease'];originalCurrentLease:GraphHistoricalMaterialization['originalCurrentLease'];
}
export interface GraphMaterializationContextReferenceV2 {v:2;contextHash:string;rewrapHash:string;root:GraphPublicMetadataDescriptor}
interface RowPosition {offset:number;length:number}
const PAGED_CONTEXT_TOKEN=Symbol('graph-verified-materialization-context-v2'),MAX_PUBLIC_ROW=4096;
function immutablePublic<T>(value:T):T{const copy=structuredClone(value);freeze(copy);return copy;}
function pinMaterializationTrust(trust:GraphMaterializationTrust):GraphMaterializationTrust{
 const publicCopy=(key:crypto.KeyLike):crypto.KeyObject=>{const value=key instanceof crypto.KeyObject&&key.type==='public'?key:crypto.createPublicKey(key);return crypto.createPublicKey(value.export({type:'spki',format:'pem'}));};return Object.freeze({ownerPublicKey:publicCopy(trust.ownerPublicKey),witnessPublicKeys:new Map([...trust.witnessPublicKeys].map(([id,key])=>[id,publicCopy(key)])),...(trust.installedMembership?{installedMembership:immutablePublic(trust.installedMembership)}:{}),...(trust.machineId?{machineId:trust.machineId}:{})});
}
function publicKeyHash(key:crypto.KeyLike):string{const value=key instanceof crypto.KeyObject&&key.type==='public'?key:crypto.createPublicKey(key);return crypto.createHash('sha256').update(value.export({type:'spki',format:'der'})).digest('hex');}
/** Flat, ASCII, strict canonical rows only. Each row is schema bounded; the
 * scratch string contains at most one128KiB page plus one4096-byte row. */
async function* pagedRows<T>(data:GraphPublicMetadataData,valid:(value:unknown)=>boolean):AsyncGenerator<{value:T;position:RowPosition}>{
 let pending='',offset=0,state:'start'|'first'|'item'|'separator'|'done'='start',count=0;
 const consume=(n:number)=>{pending=pending.slice(n);offset+=n;};
 for await(const bytes of data.bytes()){
  for(const byte of bytes)if(byte<32||byte>126)throw new Error('graph-context-pages-noncanonical');pending+=bytes.toString('ascii');
  for(;;){if(!pending.length)break;if(state==='start'){if(pending[0]!=='[')throw new Error('graph-context-pages-array');consume(1);state='first';continue;}if(state==='done')throw new Error('graph-context-pages-trailing');
   if(state==='separator'){if(pending[0]===']'){consume(1);state='done';continue;}if(pending[0]!==',')throw new Error('graph-context-pages-separator');consume(1);state='item';continue;}
   if(state==='first'&&pending[0]===']'){consume(1);state='done';continue;}if(pending[0]!=='{')throw new Error('graph-context-pages-row');const end=pending.indexOf('}');if(end<0){if(pending.length>MAX_PUBLIC_ROW)throw new Error('graph-context-pages-row-capacity');break;}const text=pending.slice(0,end+1);if(text.length>MAX_PUBLIC_ROW||++count>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)throw new Error('graph-context-pages-row-capacity');const row:unknown=JSON.parse(text);if(!valid(row)||canonicalJson(row)!==text)throw new Error('graph-context-pages-row-invalid');const position={offset,length:text.length};consume(text.length);state='separator';yield{value:immutablePublic(row as T),position};
  }
 }
 if(state!=='done'||pending.length)throw new Error('graph-context-pages-incomplete');
}
async function* publicCanonicalBytes(value:unknown):AsyncGenerator<Buffer>{
 if(value instanceof GraphPublicMetadataData){yield*value.bytes();return;}if(Array.isArray(value)){yield Buffer.from('[');let n=0;for(const child of value){if(n++)yield Buffer.from(',');yield*publicCanonicalBytes(child);}yield Buffer.from(']');return;}
 if(value&&typeof value==='object'){yield Buffer.from('{');let n=0;for(const key of Object.keys(value).sort()){const child=(value as Record<string,unknown>)[key];if(child===undefined)continue;if(n++)yield Buffer.from(',');yield Buffer.from(JSON.stringify(key)+':');yield*publicCanonicalBytes(child);}yield Buffer.from('}');return;}yield Buffer.from(canonicalJson(value));
}
async function publicCanonicalHash(value:unknown):Promise<string>{const h=crypto.createHash('sha256');for await(const bytes of publicCanonicalBytes(value))h.update(bytes);return h.digest('hex');}
function manifestHeaderValid(header:GraphMaterializationManifestHeader):boolean{return exactFields(header,['v','agentId','membershipHash','highestCertifiedSequence','highestCertifiedCoreHash','highestAcknowledgedSequence','highestAcknowledgedCoreHash'])&&validateRecoverySourceManifest({...header,entries:[]});}
function manifestRowValid(header:GraphMaterializationManifestHeader,row:unknown):boolean{return validateRecoverySourceManifest({...header,entries:[row as ManifestRow]});}
function inventoryRowValid(row:unknown):boolean{const r=row as GraphRewrapInventoryEntry;return exactFields(r,['eventId','rewrapHash'])&&['graph-event','header-op','source-observation'].some(kind=>validGraphOperationKey(kind,r.eventId))&&hash(r.rewrapHash);}
async function* publishRows<T>(input:AsyncIterable<T>|Iterable<T>,valid:(row:unknown)=>boolean):AsyncGenerator<Buffer>{yield Buffer.from('[');let n=0;for await(const row of input){if(++n>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES||!valid(row))throw new Error('graph-context-pages-row-invalid');const bytes=Buffer.from(canonicalJson(row));if(bytes.length>MAX_PUBLIC_ROW)throw new Error('graph-context-pages-row-capacity');if(n>1)yield Buffer.from(',');yield bytes;}yield Buffer.from(']');}

/** Historical signature/data proof only; never current Core/native permission.
 * Selected reads are fresh only for selected pages. Final assertCurrent checks
 * ALL pages before any receipt/import/pin. No full-array materialize method. */
export class GraphVerifiedMaterializationContextV2 {
 readonly activation:GraphHistoricalMaterialization['activation'];readonly manifestHeader:Readonly<GraphMaterializationManifestHeader>;readonly currentLease:GraphHistoricalMaterialization['currentLease'];readonly originalCurrentLease:GraphHistoricalMaterialization['originalCurrentLease'];
 readonly stateRoot:string;readonly canonicalBytes:number;readonly contextHash:string;readonly hashes:Readonly<{activationHash:string;manifestHash:string;rewrapInventoryHash:string;leaseHash:string;originalLeaseHash:string}>;
 #store:GraphPublicMetadataPages;#root:GraphPublicMetadataData;#entries:GraphPublicMetadataData;#inventory:GraphPublicMetadataData;#entryPositions:ReadonlyMap<string,RowPosition>;#keyPositions:ReadonlyMap<string,RowPosition>;#ownerHash:string;#witnessHash:string;
 constructor(token:symbol,root:PagedRoot,data:{root:GraphPublicMetadataData;entries:GraphPublicMetadataData;inventory:GraphPublicMetadataData},positions:{entries:Map<string,RowPosition>;keys:Map<string,RowPosition>},trust:GraphMaterializationTrust,store:GraphPublicMetadataPages){
  if(token!==PAGED_CONTEXT_TOKEN||!(store instanceof GraphPublicMetadataPages))throw new Error('graph-context-pages-actual-verified-required');this.#store=store;this.stateRoot=store.stateRoot;this.canonicalBytes=Buffer.byteLength(canonicalJson({activation:root.activation,manifest:{...root.manifestHeader,entries:[]},rewrapInventory:[],currentLease:root.currentLease,originalCurrentLease:root.originalCurrentLease}))+data.entries.descriptor.bytes+data.inventory.descriptor.bytes-4;this.activation=immutablePublic(root.activation);this.manifestHeader=immutablePublic(root.manifestHeader);this.currentLease=immutablePublic(root.currentLease);this.originalCurrentLease=immutablePublic(root.originalCurrentLease);this.contextHash=root.contextHash;this.hashes=Object.freeze({activationHash:canonicalHash(root.activation),manifestHash:root.activation.ownerAuthorization.sourceManifestHash,rewrapInventoryHash:root.activation.ownerAuthorization.rewrapInventoryHash,leaseHash:canonicalHash(root.currentLease),originalLeaseHash:canonicalHash(root.originalCurrentLease)});this.#root=data.root;this.#entries=data.entries;this.#inventory=data.inventory;this.#entryPositions=positions.entries;this.#keyPositions=positions.keys;this.#ownerHash=publicKeyHash(trust.ownerPublicKey);this.#witnessHash=publicKeyHash(trust.witnessPublicKeys.get(root.activation.witnessId)!);Object.freeze(this);
 }
 trustedFor(agentId:string,trust:GraphMaterializationTrust):boolean{return agentId===this.activation.agentId&&publicKeyHash(trust.ownerPublicKey)===this.#ownerHash&&!!trust.witnessPublicKeys.get(this.activation.witnessId)&&publicKeyHash(trust.witnessPublicKeys.get(this.activation.witnessId)!)===this.#witnessHash&&(!trust.installedMembership||canonicalHash(trust.installedMembership)===canonicalHash(this.activation.newMembership))&&(!trust.machineId||this.activation.newMembership.members.some(row=>row.machineId===trust.machineId));}
 reference(rewrapHash:string):GraphMaterializationContextReferenceV2{if(!hash(rewrapHash))throw new Error('graph-context-pages-rewrap-hash');return{v:2,contextHash:this.contextHash,rewrapHash,root:{...this.#root.descriptor}};}
 assertCurrent():void{this.#root.assertCurrent();this.#entries.assertCurrent();this.#inventory.assertCurrent();}
 assertStore(store:GraphPublicMetadataPages):void{if(!(store instanceof GraphPublicMetadataPages)||store!==this.#store||store.stateRoot!==this.stateRoot)throw new Error('graph-context-pages-store-mismatch');}
 selectRecord(record:Pick<import('./ConversationGraphReplication.js').ConversationGraphReplicationRecord,'packet'|'certificate'|'cancellationCertificate'>,rewrapHash:string,trust:GraphMaterializationTrust):GraphSelectedMaterializationV2{if(!this.trustedFor(record.packet.agentId,trust))throw new Error('graph-context-pages-selected-trust');const row=this.readEntrySync(record.packet.eventId);if(!row||row.rewrapHash!==rewrapHash)throw new Error('graph-context-pages-selected-rewrap');const proof=new GraphSelectedMaterializationV2(PAGED_CONTEXT_TOKEN,this,record.packet.eventId,rewrapHash,canonicalHash(row.entry));if(!proof.matches(record))throw new Error('graph-context-pages-selected-record');return proof;}
 async readEntry(eventId:string):Promise<{entry:ManifestRow;rewrapHash:string}|null>{return this.readEntrySync(eventId);}
 readEntrySync(eventId:string):{entry:ManifestRow;rewrapHash:string}|null{
  const entry=this.#entryPositions.get(eventId),key=this.#keyPositions.get(eventId);if(!entry||!key)return null;this.#root.readRangeSync(0,0);const row=JSON.parse(this.#entries.readRangeSync(entry.offset,entry.length).toString('ascii')) as ManifestRow,k=JSON.parse(this.#inventory.readRangeSync(key.offset,key.length).toString('ascii')) as GraphRewrapInventoryEntry;if(row.eventId!==eventId||k.eventId!==eventId||!manifestRowValid(this.manifestHeader,row)||!inventoryRowValid(k))throw new Error('graph-context-pages-selected-row-invalid');this.#root.readRangeSync(0,0);return{entry:immutablePublic(row),rewrapHash:k.rewrapHash};
 }
 async *entries():AsyncGenerator<ManifestRow>{for await(const row of pagedRows<ManifestRow>(this.#entries,value=>manifestRowValid(this.manifestHeader,value)))yield row.value;}
 async *rewrapInventory():AsyncGenerator<GraphRewrapInventoryEntry>{for await(const row of pagedRows<GraphRewrapInventoryEntry>(this.#inventory,inventoryRowValid))yield row.value;}
}

/** Strict v2 open: hashes identify data; only genuine ACT/owner/member/W
 * signatures plus full exact canonical manifest/inventory validation mint it. */
export async function openGraphMaterializationContextV2(store:GraphPublicMetadataPages,descriptor:GraphPublicMetadataDescriptor,agentId:string,trust:GraphMaterializationTrust,expectedContextHash?:string):Promise<GraphVerifiedMaterializationContextV2>{
 if(!(store instanceof GraphPublicMetadataPages))throw new Error('graph-context-pages-actual-store-required');trust=pinMaterializationTrust(trust);const rootData=store.open(descriptor);if(rootData.descriptor.bytes>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-context-pages-activation-object-capacity');const pieces:Buffer[]=[];for await(const piece of rootData.bytes())pieces.push(piece);const bytes=Buffer.concat(pieces),root=JSON.parse(bytes.toString('utf8')) as PagedRoot;if(!exactFields(root,['v','kind','contextHash','activation','manifestHeader','entries','rewrapInventory','currentLease','originalCurrentLease'])||root.v!==2||root.kind!=='graph-materialization-context-pages'||!hash(root.contextHash)||expectedContextHash!==undefined&&root.contextHash!==expectedContextHash||canonicalJson(root)!==bytes.toString('utf8')||!manifestHeaderValid(root.manifestHeader)||!verifyGraphHistoricalMaterializationAuthority(root,agentId,trust)||root.manifestHeader.agentId!==agentId||root.manifestHeader.membershipHash!==canonicalHash(root.activation.previousMembership))throw new Error('graph-context-pages-authority-invalid');
 const entries=store.open(root.entries),inventory=store.open(root.rewrapInventory),entryPositions=new Map<string,RowPosition>(),keyPositions=new Map<string,RowPosition>(),keys=new Set<string>();let prior:ManifestRow|undefined;
 for await(const {value,position}of pagedRows<ManifestRow>(entries,row=>manifestRowValid(root.manifestHeader,row))){if(entryPositions.has(value.eventId)||keys.has(value.idempotencyKey)||prior&&(value.sourceSequence<prior.sourceSequence||value.sourceSequence===prior.sourceSequence&&value.eventId<=prior.eventId))throw new Error('graph-context-pages-manifest-order');entryPositions.set(value.eventId,position);keys.add(value.idempotencyKey);prior=value;}
 let priorId='';for await(const {value,position}of pagedRows<GraphRewrapInventoryEntry>(inventory,inventoryRowValid)){if(value.eventId<=priorId||!entryPositions.has(value.eventId))throw new Error('graph-context-pages-inventory-order');keyPositions.set(value.eventId,position);priorId=value.eventId;}
 if(entryPositions.size!==keyPositions.size||await publicCanonicalHash({...root.manifestHeader,entries})!==root.activation.ownerAuthorization.sourceManifestHash||inventory.descriptor.hash!==root.activation.ownerAuthorization.rewrapInventoryHash||await publicCanonicalHash({activation:root.activation,manifest:{...root.manifestHeader,entries},rewrapInventory:inventory,currentLease:root.currentLease,originalCurrentLease:root.originalCurrentLease})!==root.contextHash)throw new Error('graph-context-pages-semantic-hash-mismatch');rootData.assertCurrent();entries.assertCurrent();inventory.assertCurrent();return new GraphVerifiedMaterializationContextV2(PAGED_CONTEXT_TOKEN,root,{root:rootData,entries,inventory},{entries:entryPositions,keys:keyPositions},trust,store);
}
export async function persistGraphMaterializationContextV2(store:GraphPublicMetadataPages,input:{activation:GraphHistoricalMaterialization['activation'];manifestHeader:GraphMaterializationManifestHeader;entries:AsyncIterable<ManifestRow>|Iterable<ManifestRow>;rewrapInventory:AsyncIterable<GraphRewrapInventoryEntry>|Iterable<GraphRewrapInventoryEntry>;currentLease:GraphHistoricalMaterialization['currentLease'];originalCurrentLease:GraphHistoricalMaterialization['originalCurrentLease']},agentId:string,trust:GraphMaterializationTrust):Promise<GraphVerifiedMaterializationContextV2>{
 if(!(store instanceof GraphPublicMetadataPages))throw new Error('graph-context-pages-actual-store-required');trust=pinMaterializationTrust(trust);const activation=immutablePublic(input.activation),manifestHeader=immutablePublic(input.manifestHeader),currentLease=immutablePublic(input.currentLease),originalCurrentLease=immutablePublic(input.originalCurrentLease);if(!verifyGraphHistoricalMaterializationAuthority({activation,currentLease,originalCurrentLease},agentId,trust)||!manifestHeaderValid(manifestHeader))throw new Error('graph-context-pages-authority-invalid');const entries=await store.put(publishRows(input.entries,row=>manifestRowValid(manifestHeader,row))),inventory=await store.put(publishRows(input.rewrapInventory,inventoryRowValid)),contextHash=await publicCanonicalHash({activation,manifest:{...manifestHeader,entries},rewrapInventory:inventory,currentLease,originalCurrentLease}),root:PagedRoot={v:2,kind:'graph-materialization-context-pages',contextHash,activation,manifestHeader,entries:{...entries.descriptor},rewrapInventory:{...inventory.descriptor},currentLease,originalCurrentLease},bytes=Buffer.from(canonicalJson(root));if(bytes.length>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-context-pages-activation-object-capacity');const data=await store.put([bytes]);return openGraphMaterializationContextV2(store,{...data.descriptor},agentId,trust,contextHash);
}

/** Actual selected projection, not a truncated legacy context. Unsupported
 * full-array consumers fail explicitly; no partial array is ever fabricated. */
export class GraphSelectedMaterializationV2 implements GraphHistoricalMaterialization {
 readonly kind='graph-selected-materialization-v2';readonly activation:GraphHistoricalMaterialization['activation'];readonly currentLease:GraphHistoricalMaterialization['currentLease'];readonly originalCurrentLease:GraphHistoricalMaterialization['originalCurrentLease'];readonly rewrapHash:string;readonly eventId:string;
 #context:GraphVerifiedMaterializationContextV2;#entryHash:string;
 constructor(token:symbol,context:GraphVerifiedMaterializationContextV2,eventId:string,rewrapHash:string,entryHash:string){if(token!==PAGED_CONTEXT_TOKEN||!(context instanceof GraphVerifiedMaterializationContextV2))throw new Error('graph-selected-materialization-actual-proof-required');this.#context=context;this.activation=context.activation;this.currentLease=context.currentLease;this.originalCurrentLease=context.originalCurrentLease;this.rewrapHash=rewrapHash;this.eventId=eventId;this.#entryHash=entryHash;Object.freeze(this);}
 get manifest():never{throw new Error('graph-paged-materialization-full-array-unavailable');}
 get rewrapInventory():never{throw new Error('graph-paged-materialization-full-array-unavailable');}
 get context():GraphVerifiedMaterializationContextV2{return this.#context;}
 reference():GraphMaterializationContextReferenceV2{return this.#context.reference(this.rewrapHash);}
 assertCurrent():void{const row=this.#context.readEntrySync(this.eventId);if(!row||row.rewrapHash!==this.rewrapHash||canonicalHash(row.entry)!==this.#entryHash)throw new Error('graph-selected-materialization-row-changed');}
 trustedFor(agentId:string,trust:GraphMaterializationTrust):boolean{return this.#context.trustedFor(agentId,trust);}
 matches(record:Pick<import('./ConversationGraphReplication.js').ConversationGraphReplicationRecord,'packet'|'certificate'|'cancellationCertificate'>):boolean{this.assertCurrent();const row=this.#context.readEntrySync(this.eventId);if(!row||record.packet.eventId!==this.eventId)return false;const e=row.entry;return e.operationHash===canonicalHash(record.packet)&&e.coreHash===record.packet.coreHash&&e.authorizationReceiptHash===record.packet.authorizationReceiptHash&&e.sourceBundleHash===record.packet.sourceBundleHash&&e.sourceSequence===record.packet.sourceSequence&&e.sourceSequence<=this.#context.manifestHeader.highestCertifiedSequence&&e.certificateHash===(record.certificate?canonicalHash(record.certificate):null)&&e.cancellationCertificateHash===(record.cancellationCertificate?canonicalHash(record.cancellationCertificate):null)&&!!(record.certificate||record.cancellationCertificate);}
}
export function validateGraphMaterializationReferenceV2(raw:unknown):raw is GraphMaterializationContextReferenceV2{
 const r=raw as GraphMaterializationContextReferenceV2,d=r?.root;return exactFields(r,['v','contextHash','rewrapHash','root'])&&r.v===2&&hash(r.contextHash)&&hash(r.rewrapHash)&&exactFields(d,['v','kind','hash','bytes','pages','indexHash'])&&d.v===1&&d.kind==='graph-public-metadata-bytes'&&hash(d.hash)&&Number.isSafeInteger(d.bytes)&&d.bytes>0&&Number.isSafeInteger(d.pages)&&d.pages===Math.ceil(d.bytes/(128*1024))&&hash(d.indexHash);
}
export function graphMaterializationReference(proof:GraphHistoricalMaterialization):GraphMaterializationContextReference|GraphMaterializationContextReferenceV2{return proof instanceof GraphSelectedMaterializationV2?proof.reference():splitGraphMaterialization(proof).reference;}
