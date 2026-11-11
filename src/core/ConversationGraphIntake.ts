// RULE 3: EXEMPT — these classes read signed, hash-checked graph records from disk; none infers agent or provider state from output.
import {flushDescriptorOnce} from './GraphDurableFileMemo.js';
import {GraphSourceCapacityLedger} from './GraphSourceCapacityLedger.js';
import {GraphFrozenPhysicalInventory} from './GraphFrozenPhysicalInventory.js';
import {verifyGraphControlCapsule} from './GraphWitnessControl.js';
import {GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES} from './GraphMemberLossInventoryLimits.js';
import {GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES} from './GraphWitnessTypes.js';
import type {GraphErasureAuthority} from './GraphErasureProtocol.js';
import {ConversationGraphErasureAuthorityStore} from './ConversationGraphErasureAuthorityStore.js';
/** Durable idempotency reservations for graph writes. No acknowledged state is
 * derived here: the real coordinator still supplies witness/member proofs.
 * Reservations contain the exact encrypted packet, never an owner credential.
 * Spec: conversation-effort-hierarchy-v3 §7.2.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import {assertGraphLocalPath} from './GraphLocalFiles.js';
import path from 'node:path';
import { canonicalHash, canonicalJson, exactFields, GRAPH_SIGNATURE_DOMAINS, verifyGraphRecord, verifyEncryptedBundle, verifyWitnessErasure,
  validateGraphErasureIdentity,erasureCoversPacket,sameGraphErasureIdentity,type GraphErasureIdentity,type GraphWitnessErasure } from './GraphWitnessTypes.js';
import { verifyGraphAuthorization } from './ConversationGraphReplicationProof.js';
import { validateGraphOperationCore, graphOperationIdentity } from './ConversationGraphOperation.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
import {GRAPH_REPLICATION_MAX_RECORD_BYTES} from './ConversationGraphReplicationLimits.js';
import {ConversationGraphLocalErasureFence} from './ConversationGraphLocalErasure.js';
import {ConversationGraphQueuedIntentSpool,type GraphQueuedIntentOptions} from './ConversationGraphQueuedIntent.js';

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_RETAINED_CONTROL_BYTES=128*1024;
const MAX_RESERVATION_BYTES=GRAPH_REPLICATION_MAX_RECORD_BYTES+1024;

interface Reservation { v: 1; requestHash: string; record: ConversationGraphReplicationRecord }
type RetainedControl=Pick<ConversationGraphReplicationRecord,'coreType'|'packet'|'packetSignature'|'core'|'authorizationProof'>;
interface RetainedControlDoc {v:1;kind:'erased-reservation-control';requestHash:string;control:RetainedControl}
interface ActionTombstone { v: 1; agentId: string; proofHash: string; keyDigest: string; conservative: boolean }
interface ErasureState { proofs: Map<string, GraphWitnessErasure>; actions: Map<string, ActionTombstone> }
export interface GraphIntakeErasureResult {
  local: true;
  fleetComplete: false;
  complete: boolean;
  removedCopies: number;
  remainingCopies: string[];
  /** Unreadable scratch copies cannot be attributed to one bundle. They are
   * conservatively discarded and their action keys fenced, never called a
   * verified match or silently regenerated. */
  conservativeCopies: number;
}
export class GraphIntakeSourceErased extends Error {
  readonly code = 'source-erased';
  constructor() { super('graph-intake-source-erased'); }
}
export class GraphIdempotencyConflict extends Error {
  readonly code = 'idempotency-conflict';
  constructor() { super('graph-idempotency-conflict'); }
}
const HELD_INTAKE_TOKEN=Symbol('held-intake-physical-snapshot');
export class GraphHeldIntakeSnapshot {
 #check:()=>void;#records:ConversationGraphReplicationRecord[];#closed=false;
 readonly inventoryHash:string;readonly stateRoot:string;readonly erasureInventoryHash:string;readonly capacityBytes:number;
 constructor(token:symbol,root:string,records:ConversationGraphReplicationRecord[],inventoryHash:string,erasureInventoryHash:string,capacityBytes:number,check:()=>void){if(token!==HELD_INTAKE_TOKEN)throw new Error('graph-intake-held-proof-required');this.stateRoot=root;this.#records=records;this.inventoryHash=inventoryHash;this.erasureInventoryHash=erasureInventoryHash;this.capacityBytes=capacityBytes;this.#check=check;Object.freeze(this);}
 assertCurrent():void{if(this.#closed)throw new Error('graph-intake-held-snapshot-closed');try{this.#check();}catch(error){this.close();throw error;}}
 close():void{for(const record of this.#records){record.encryptedSourceBundle=null;delete record.rewrap;}this.#records=[];this.#closed=true;}
 get records():ConversationGraphReplicationRecord[]{this.assertCurrent();return structuredClone(this.#records);}
}
const HELD_INTAKE_READER_TOKEN=Symbol('actual-intake-record-reader');
export interface GraphHeldIntakeDescriptor {eventId:string;sourceSequence:number;packetHash:string;sourceProofHash:string;recordHash:string}
/** Opaque local disk locators; no retained encrypted record array or Source ACK. */
export class GraphHeldIntakeReader {
 #closed=false;#check:()=>void;#final:()=>void;#read:(id:string)=>ConversationGraphReplicationRecord;#descriptors:GraphHeldIntakeDescriptor[];#negative:()=>GraphWitnessErasure[];
 readonly stateRoot:string;readonly inventoryHash:string;readonly erasureInventoryHash:string;readonly capacityBytes:number;
 constructor(token:symbol,value:{stateRoot:string;inventoryHash:string;erasureInventoryHash:string;capacityBytes:number},descriptors:GraphHeldIntakeDescriptor[],check:()=>void,final:()=>void,read:(id:string)=>ConversationGraphReplicationRecord,negative:()=>GraphWitnessErasure[]){if(token!==HELD_INTAKE_READER_TOKEN)throw new Error('graph-intake-actual-reader-required');Object.assign(this,value);this.stateRoot=value.stateRoot;this.inventoryHash=value.inventoryHash;this.erasureInventoryHash=value.erasureInventoryHash;this.capacityBytes=value.capacityBytes;this.#descriptors=descriptors;this.#check=check;this.#final=final;this.#read=read;this.#negative=negative;Object.freeze(this);}
 assertCurrent():void{if(this.#closed)throw new Error('graph-intake-reader-closed');try{this.#check();}catch(error){this.close();throw error;}}
 negativeInventory():GraphWitnessErasure[]{this.assertCurrent();const result=this.#negative();this.assertCurrent();return result;}
 descriptors():readonly GraphHeldIntakeDescriptor[]{this.assertCurrent();return Object.freeze(this.#descriptors.map(row=>Object.freeze({...row})));}
 readRecord(id:string):ConversationGraphReplicationRecord{this.assertCurrent();try{const record=this.#read(id);this.assertCurrent();return record;}catch(error){this.close();throw error;}}
 finalize():void{this.assertCurrent();try{this.#final();this.assertCurrent();}catch(error){this.close();throw error;}}
 close():void{this.#closed=true;this.#descriptors=[];}
}
export class ConversationGraphIntake {
  private queue: Promise<unknown> = Promise.resolve();
  private mutationGeneration=0;
  private localOwnerQueue:ConversationGraphQueuedIntentSpool|null=null;
  configureOwnerQueue(options:Omit<GraphQueuedIntentOptions,'directory'>):ConversationGraphQueuedIntentSpool{
    if(this.localOwnerQueue)throw new Error('graph-owner-queue-already-configured');
    return this.localOwnerQueue=new ConversationGraphQueuedIntentSpool({...options,directory:path.join(this.directory,'queued-owner-intents')});
  }
  get ownerQueue():ConversationGraphQueuedIntentSpool{if(!this.localOwnerQueue)throw new Error('graph-owner-queue-not-configured');return this.localOwnerQueue;}
  constructor(private readonly directory: string, private readonly ownerPublicKey: crypto.KeyLike,
    private readonly witnessPublicKeys: ReadonlyMap<string, crypto.KeyLike> = new Map(),private readonly localErasure?:ConversationGraphLocalErasureFence,private readonly erasureAuthorities?:ConversationGraphErasureAuthorityStore,private readonly historyBudget?:{maxHistoryEntries?:number;operationIds:()=>Promise<ReadonlySet<string>>;knownIdempotencyKey?:(key:string)=>Promise<boolean>}) {const max=historyBudget?.maxHistoryEntries;if(max!==undefined&&(!Number.isSafeInteger(max)||max<1||max>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES))throw new Error('graph-intake-history-budget-invalid');}

  private capacityLedger:GraphSourceCapacityLedger|undefined;
  bindCapacityLedger(ledger:GraphSourceCapacityLedger):void{if(!(ledger instanceof GraphSourceCapacityLedger)||this.capacityLedger&&this.capacityLedger!==ledger||fsSync.realpathSync(this.directory)!==path.join(ledger.stateRoot,'state','conversation-graph-intake'))throw new Error('graph-intake-capacity-scope-invalid');ledger.assertIntakeContext(this.directory,this.ownerPublicKey);this.capacityLedger=ledger;}
  /** Drains actual Intake writes without nesting a Source lock. No Source ACK. */
  verifyHeldReservations(expectedRoot:string,expectedOwner:crypto.KeyLike,fence:ConversationGraphLocalErasureFence,maxBytes=GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES):Promise<GraphHeldIntakeSnapshot>{
    const work=this.queue.then(async()=>{
      if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES)throw new Error('graph-member-loss-snapshot-budget-invalid');
      const scope=()=>{if(!(fence instanceof ConversationGraphLocalErasureFence)||this.localErasure!==fence||fence.stateRoot!==expectedRoot||fsSync.realpathSync(path.dirname(path.dirname(this.directory)))!==expectedRoot||path.join(fsSync.realpathSync(path.dirname(this.directory)),path.basename(this.directory))!==path.join(expectedRoot,'state','conversation-graph-intake'))throw new Error('graph-intake-held-component-scope');if(fsSync.existsSync(this.directory)&&fsSync.realpathSync(this.directory)!==path.join(expectedRoot,'state','conversation-graph-intake'))throw new Error('graph-intake-held-component-scope');const publicPem=(key:crypto.KeyLike)=>{const k=key instanceof crypto.KeyObject&&key.type==='public'?key:crypto.createPublicKey(key);return k.export({type:'spki',format:'pem'}).toString();};if(publicPem(this.ownerPublicKey)!==publicPem(expectedOwner))throw new Error('graph-intake-held-owner-mismatch');};scope();await fs.mkdir(this.directory,{recursive:true,mode:0o700});scope();
      const erasures=await this.erasureState();await this.purge(erasures);scope();const physical=this.heldPhysicalInventory(expectedRoot,true,maxBytes),negative=canonicalHash(fence.durableTargets());const records=await this.frozenReservations();
      const check=()=>{scope();if(canonicalHash(fence.targets())!==negative||this.heldPhysicalInventory(expectedRoot,false,maxBytes).inventoryHash!==physical.inventoryHash)throw new Error('graph-intake-held-state-changed');};check();
      return new GraphHeldIntakeSnapshot(HELD_INTAKE_TOKEN,expectedRoot,records,physical.inventoryHash,physical.erasureInventoryHash,physical.capacityBytes,check);
    });this.queue=work.then(()=>undefined,()=>{/* @silent-fallback-ok: discard only queue scheduling result; the original physical proof promise still rejects. */});return work;
  }
  /** Captures metadata locators after the real Intake queue drains. Per-record
   * reads verify physical bytes; finalize performs the full inventory check. */
  verifyHeldReservationReader(expectedRoot:string,expectedOwner:crypto.KeyLike,fence:ConversationGraphLocalErasureFence,maxPhysicalBytes=GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES):Promise<GraphHeldIntakeReader>{
    const work=this.queue.then(async()=>{
      const publicKey=(key:crypto.KeyLike)=>{const parsed=key instanceof crypto.KeyObject&&key.type==='public'?key:crypto.createPublicKey(key);return parsed.export({type:'spki',format:'pem'}).toString();};
      const scope=()=>{if(!(fence instanceof ConversationGraphLocalErasureFence)||this.localErasure!==fence||fence.stateRoot!==expectedRoot||fsSync.realpathSync(path.dirname(path.dirname(this.directory)))!==expectedRoot||fsSync.realpathSync(this.directory)!==path.join(expectedRoot,'state','conversation-graph-intake')||publicKey(this.ownerPublicKey)!==publicKey(expectedOwner))throw new Error('graph-intake-reader-component-scope');};
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});scope();if(!Number.isSafeInteger(maxPhysicalBytes)||maxPhysicalBytes<0)throw new Error('graph-intake-reader-budget-invalid');const state=await this.erasureState();await this.purge(state);scope();
      const physical=new GraphFrozenPhysicalInventory(expectedRoot,this.directory,{maxFileBytes:MAX_RESERVATION_BYTES,maxTotalBytes:maxPhysicalBytes,maxFiles:GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES*4,skip:(name,isDirectory)=>isDirectory&&name==='queued-owner-intents'}),generation=this.mutationGeneration,negative=canonicalHash(fence.durableTargets()),locators=new Map<string,{name:string;retained:boolean;descriptor:GraphHeldIntakeDescriptor}>();
      const decode=(name:string,retained:boolean):ConversationGraphReplicationRecord=>{const value=physical.readJson(name);let record:ConversationGraphReplicationRecord;if(retained){const doc=this.verifyRetained(value,path.basename(name).slice(0,64));record={...doc.control,encryptedSourceBundle:null};const proof=[...state.proofs.values()].find(proof=>erasureCoversPacket(proof,record.packet));if(!proof&&!fence.isDenied(record.packet.erasureIdentity))throw new Error('graph-intake-retained-control-unfenced');if(proof)record.erasure=proof;}else{const valueRecord=(value as Reservation)?.record,key=valueRecord?.packet?.idempotencyKey;if(typeof key!=='string'||path.basename(name)!==this.digest(key)+'.json')throw new Error('graph-intake-reader-reservation-invalid');record=this.verify(value,key).record;if(this.erased(state,record))throw new Error('graph-intake-reader-denied-body-remains');}return record;};
      for(const name of physical.names()){const retained=/^\.retained-controls\/[a-f0-9]{64}\.json$/.test(name);if(!retained&&!/^[a-f0-9]{64}\.json$/.test(name))continue;const record=decode(name,retained),descriptor={eventId:record.packet.eventId,sourceSequence:record.packet.sourceSequence,packetHash:canonicalHash(record.packet),sourceProofHash:canonicalHash({coreType:record.coreType,packet:record.packet,packetSignature:record.packetSignature,core:record.core,authorizationProof:record.authorizationProof}),recordHash:canonicalHash(record)},prior=locators.get(descriptor.eventId);if(prior&&prior.descriptor.sourceProofHash!==descriptor.sourceProofHash)throw new Error('graph-intake-reader-conflict');if(!prior||retained)locators.set(descriptor.eventId,{name,retained,descriptor});if(locators.size>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)throw new Error('graph-intake-reader-capacity');}
      const check=()=>{scope();physical.assertScope();if(this.mutationGeneration!==generation||canonicalHash(fence.targets())!==negative)throw new Error('graph-intake-reader-state-changed');};check();
      return new GraphHeldIntakeReader(HELD_INTAKE_READER_TOKEN,{stateRoot:expectedRoot,inventoryHash:physical.inventoryHash,erasureInventoryHash:canonicalHash([...state.proofs.values()].map(canonicalHash).sort()),capacityBytes:physical.capacityBytes},[...locators.values()].map(row=>row.descriptor),check,()=>physical.assertCurrent(),id=>{check();const locator=locators.get(id);if(!locator)throw new Error('graph-intake-reader-unlisted-record');const record=decode(locator.name,locator.retained);if(canonicalHash(record)!==locator.descriptor.recordHash)throw new Error('graph-intake-reader-record-changed');check();return record;},()=>structuredClone([...state.proofs.values()]));
    });this.queue=work.then(()=>undefined,()=>{/* @silent-fallback-ok: only queue scheduling recovers; caller retains the original reader creation failure. */});return work;
  }
  private heldPhysicalInventory(root:string,sync:boolean,maxBytes:number):{inventoryHash:string;erasureInventoryHash:string;capacityBytes:number}{
    let capacityBytes=0;const rows:Array<{name:string;hash:string}>=[];const walk=(directory:string)=>{assertGraphLocalPath(root,directory);let names:string[];try{names=fsSync.readdirSync(directory).sort();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      for(const name of names){if(directory===fsSync.realpathSync(this.directory)&&name==='queued-owner-intents')continue;const file=path.join(directory,name);assertGraphLocalPath(root,file);const stat=fsSync.lstatSync(file);if(stat.isSymbolicLink())throw new Error('graph-intake-held-symlink');if(stat.isDirectory()){walk(file);continue;}if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_RESERVATION_BYTES||/\.(pending|tmp)$/.test(name))throw new Error('graph-intake-held-file-invalid');capacityBytes+=stat.size;if(capacityBytes>maxBytes)throw new Error('graph-member-loss-snapshot-byte-capacity');const fd=fsSync.openSync(file,fsSync.constants.O_RDONLY|(fsSync.constants.O_NOFOLLOW??0));try{const opened=fsSync.fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw new Error('graph-intake-held-file-changed');if(opened.size>MAX_RESERVATION_BYTES)throw new Error('graph-intake-held-file-changed');const storage=Buffer.alloc(opened.size+1),count=fsSync.readSync(fd,storage,0,storage.length,0);if(count!==opened.size)throw new Error('graph-intake-held-file-changed');const bytes=storage.subarray(0,count);JSON.parse(bytes.toString('utf8'));if(sync)flushDescriptorOnce(file,fd);rows.push({name:path.relative(fsSync.realpathSync(this.directory),file),hash:crypto.createHash('sha256').update(bytes).digest('hex')});if(rows.length>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES*4)throw new Error('graph-intake-held-capacity');}finally{fsSync.closeSync(fd);}}
      if(sync){const fd=fsSync.openSync(directory,'r');try{fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}}
    };walk(fsSync.realpathSync(this.directory));if(sync){for(const parent of [path.dirname(this.directory),root]){const fd=fsSync.openSync(parent,'r');try{fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}}}return {inventoryHash:canonicalHash(rows),erasureInventoryHash:canonicalHash(rows.filter(row=>row.name.startsWith('.'))),capacityBytes};
  }

  private digest(key: string): string { return crypto.createHash('sha256').update(key).digest('hex'); }
  private async names(directory: string): Promise<string[]> {
    try { return await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private async read(file: string, maxBytes = MAX_RESERVATION_BYTES): Promise<unknown> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('graph-intake-file-invalid');
    const handle = await fs.open(file, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
      let length = 0;
      while (length < bytes.length) {
        const next = await handle.read(bytes, length, bytes.length - length, length);
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      if (length > maxBytes || length !== stat.size || (await handle.stat()).size !== stat.size) throw new Error('graph-intake-file-too-large-or-changed');
      return JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } finally { await handle.close(); }
  }
  private async syncDirectory(directory: string): Promise<void> {
    this.mutationGeneration++;
    const handle = await fs.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  /** Metadata-only, immutable publication. Signed proofs and action fences are
   * fsynced BEFORE any ciphertext/key-envelope copy is unlinked. */
  private async publish(file: string, value: unknown,maxBytes=MAX_METADATA_BYTES): Promise<void> {
    this.mutationGeneration++;
    if(Buffer.byteLength(JSON.stringify(value))>maxBytes)throw new Error('graph-intake-metadata-capacity');
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary, file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || canonicalHash(await this.read(file, maxBytes)) !== canonicalHash(value)) throw error;
      }
      await this.syncDirectory(directory);
      // Persist creation of the metadata directory as well as its contents.
      await this.syncDirectory(this.directory);
    } finally { await SafeFsExecutor.safeUnlink(temporary, { operation: 'graph-intake:metadata-temporary-cleanup' }); }
  }
  private verifyRetained(value:unknown,keyDigest:string):RetainedControlDoc{
    const doc=value as RetainedControlDoc,record=doc?.control;
    if(!exactFields(doc,['v','kind','requestHash','control'])||doc.v!==1||doc.kind!=='erased-reservation-control'||!/^[a-f0-9]{64}$/.test(doc.requestHash)||!exactFields(record,['coreType','packet','packetSignature','core','authorizationProof'])||this.digest(record.packet?.idempotencyKey??'')!==keyDigest
      ||!verifyGraphControlCapsule({v:1,coreType:record.coreType,core:record.core,authorizationProof:record.authorizationProof},record.packet,this.ownerPublicKey))throw new Error('graph-intake-retained-control-invalid');
    const member=record.authorizationProof.membership.members.find(row=>row.machineId===record.packet.writerId);if(!member||!verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.packet,record.packet,record.packetSignature,member.signingPublicKey))throw new Error('graph-intake-retained-control-signature-invalid');return doc;
  }
  private controlDocument(value:Reservation,keyDigest:string):RetainedControlDoc{const {coreType,packet,packetSignature,core,authorizationProof}=value.record;return this.verifyRetained({v:1,kind:'erased-reservation-control',requestHash:value.requestHash,control:{coreType,packet,packetSignature,core,authorizationProof}},keyDigest);}
  private async retainControl(value:Reservation,keyDigest:string):Promise<void>{
    const doc=this.controlDocument(value,keyDigest);const file=path.join(this.directory,'.retained-controls',keyDigest+'.json');await this.publish(file,doc,MAX_RETAINED_CONTROL_BYTES);
    // Existing readable metadata is not a completed durability barrier. Flush
    // the actual retained inode and parents before deleting the sole body.
    const fd=await fs.open(file,fsSync.constants.O_RDONLY|(fsSync.constants.O_NOFOLLOW??0));try{const stat=await fd.stat();if(!stat.isFile()||stat.size>MAX_RETAINED_CONTROL_BYTES||canonicalHash(this.verifyRetained(JSON.parse(await fd.readFile('utf8')),keyDigest))!==canonicalHash(doc))throw new Error('graph-intake-retained-control-changed');await fd.sync();}finally{await fd.close();}await this.syncDirectory(path.dirname(file));await this.syncDirectory(this.directory);
  }
  /** Includes denied original controls for sequence/history/negative recovery.
   * A null body is NOT a source receipt, Saved custody or terminal decision. */
  async frozenReservations():Promise<ConversationGraphReplicationRecord[]>{
    const records=await this.reservations(),state=await this.erasureState(),byId=new Map(records.map(record=>[record.packet.eventId,record]));
    for(const name of (await this.names(path.join(this.directory,'.retained-controls'))).sort()){
      if(!/^[a-f0-9]{64}\.json$/.test(name))throw new Error('graph-intake-retained-control-file-invalid');const doc=this.verifyRetained(await this.read(path.join(this.directory,'.retained-controls',name),MAX_RETAINED_CONTROL_BYTES),name.slice(0,64)),record:ConversationGraphReplicationRecord={...doc.control,encryptedSourceBundle:null};
      const proof=[...state.proofs.values()].find(proof=>erasureCoversPacket(proof,record.packet));if(!proof&&!this.localErasure?.isDenied(record.packet.erasureIdentity))throw new Error('graph-intake-retained-control-unfenced');if(proof)record.erasure=proof;
      const prior=byId.get(record.packet.eventId);if(prior&&canonicalHash(prior.packet)!==canonicalHash(record.packet))throw new Error('graph-intake-retained-control-conflict');byId.set(record.packet.eventId,record);
    }return [...byId.values()];
  }
  private trustedErasure(proof: GraphWitnessErasure, agentId: string): boolean {
    try {
      const key = this.witnessPublicKeys.get(proof.witnessId);
      return this.erasureAuthorities instanceof ConversationGraphErasureAuthorityStore && this.erasureAuthorities.has(proof) && proof.agentId === agentId && !!key && verifyWitnessErasure(proof, key);
    } catch { return false; }
  }
  private async erasureState(): Promise<ErasureState> {
    const proofs = new Map<string, GraphWitnessErasure>();
    const actions = new Map<string, ActionTombstone>();
    const proofDirectory = path.join(this.directory, '.erasure-proofs');
    for (const name of await this.names(proofDirectory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const value = await this.read(path.join(proofDirectory, name), MAX_METADATA_BYTES) as { v: 1; agentId: string; proof: GraphWitnessErasure };
      if(this.erasureAuthorities&&!this.erasureAuthorities.has(value.proof))await this.erasureAuthorities.restore(value.proof);
      if (!exactFields(value, ['v', 'agentId', 'proof']) || value.v !== 1 || !this.trustedErasure(value.proof, value.agentId)
        || `${canonicalHash(value.proof)}.json` !== name) throw new Error('graph-intake-erasure-ledger-invalid');
      proofs.set(canonicalHash(value.proof), value.proof);
    }
    const actionDirectory = path.join(this.directory, '.erased-actions');
    for (const name of await this.names(actionDirectory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const value = await this.read(path.join(actionDirectory, name), MAX_METADATA_BYTES) as ActionTombstone;
      if (!exactFields(value, ['v', 'agentId', 'proofHash', 'keyDigest', 'conservative']) || value.v !== 1
        || `${value.keyDigest}.json` !== name || typeof value.conservative !== 'boolean'
        || proofs.get(value.proofHash)?.agentId !== value.agentId) throw new Error('graph-intake-erasure-ledger-invalid');
      actions.set(value.keyDigest, value);
    }
    return { proofs, actions };
  }
  private erased(state: ErasureState, record: ConversationGraphReplicationRecord): boolean {
    return !!this.localErasure?.isDenied(record.packet.erasureIdentity)||state.actions.has(this.digest(record.packet.idempotencyKey)) || [...state.proofs.values()].some(proof =>
      erasureCoversPacket(proof,record.packet));
  }
  private async fenceAction(state: ErasureState, keyDigest: string, proofHash: string, conservative: boolean): Promise<void> {
    if (state.actions.has(keyDigest)) return;
    const proof = state.proofs.get(proofHash)!;
    const value: ActionTombstone = { v: 1, agentId: proof.agentId, proofHash, keyDigest, conservative };
    await this.publish(path.join(this.directory, '.erased-actions', `${keyDigest}.json`), value);
    state.actions.set(keyDigest, value);
  }
  /** The managed source inventory is published *.json reservations AND every
   * *.json.<uuid>.pending scratch copy/hardlink, plus metadata-only proof/action
   * ledgers. It does not cover external backups, provider logs, or memory held
   * by callers; root must invalidate those and prove fleet completion. */
  private async purge(state: ErasureState): Promise<GraphIntakeErasureResult> {
    const result: GraphIntakeErasureResult = { local: true, fleetComplete: false, complete: true,
      removedCopies: 0, remainingCopies: [], conservativeCopies: 0 };
    if (!state.proofs.size) return result;
    for (const name of await this.names(this.directory)) {
      const match = /^([a-f0-9]{64})\.json(?:\.[A-Za-z0-9-]+\.pending)?$/.exec(name);
      if (!match) continue;
      const file = path.join(this.directory, name); const keyDigest = match[1]!;
      let target = state.actions.get(keyDigest)?.proofHash;
      let conservative = false;let verified:Reservation|undefined;
      try {
        const raw = await this.read(file) as Reservation;
        const key = raw.record?.packet?.idempotencyKey;
        if (typeof key !== 'string' || this.digest(key) !== keyDigest) throw new Error('graph-intake-invalid-key');
        const value = this.verify(raw, key);this.controlDocument(value,keyDigest);verified=value;
        if (!target) target = [...state.proofs].find(([, proof]) => erasureCoversPacket(proof,value.record.packet))?.[0];
      } catch {
        // An unacknowledged malformed scratch/published copy cannot safely be
        // retained on a forget. Fence its opaque filename key before purging;
        // report the conservative attribution rather than inventing a match.
        target ??= state.proofs.keys().next().value;
        conservative = true;
      }
      if (!target) continue;
      if(verified)await this.retainControl(verified,keyDigest);
      await this.fenceAction(state, keyDigest, target, conservative);
      if (conservative) result.conservativeCopies++;
      try {
        await SafeFsExecutor.safeUnlink(file, { operation: 'graph-intake:purge-erased-source-copy' });
        result.removedCopies++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.remainingCopies.push(name);
      }
    }
    await this.syncDirectory(this.directory);
    result.complete = result.remainingCopies.length === 0;
    return result;
  }
  /** The expected agent comes from the trusted runtime, not the erasure request.
   * This is local intake-copy erasure only; it never certifies a fleet forget. */
  applyErasure(proof: GraphWitnessErasure, expectedAgentId: string,authority?:GraphErasureAuthority): Promise<GraphIntakeErasureResult> {
    const operation = this.queue.then(async () => {
      try{if(!this.erasureAuthorities)throw new Error('authority missing');await this.erasureAuthorities.accept(proof,authority);}catch{throw new Error('graph-intake-erasure-proof-invalid');}
      if (!this.trustedErasure(proof, expectedAgentId)) throw new Error('graph-intake-erasure-proof-invalid');
      await this.localOwnerQueue?.purge(proof.target);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.publish(path.join(this.directory, '.erasure-proofs', `${canonicalHash(proof)}.json`),
        { v: 1, agentId: expectedAgentId, proof });
      return this.purge(await this.erasureState());
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  /** Local owner deny is not a signed fleet erasure certificate. */
  eraseLocal(target:GraphErasureIdentity):Promise<void>{
    const operation=this.queue.then(async()=>{
      if(!(this.localErasure instanceof ConversationGraphLocalErasureFence)||!this.localErasure.isDenied(target))throw new Error('graph-intake-local-fence-required');
      await this.localOwnerQueue?.purge(target);
      for(const name of await this.names(this.directory)){
        if(!/^[a-f0-9]{64}\.json(?:\.[A-Za-z0-9-]+\.pending)?$/.test(name))continue;
        const file=path.join(this.directory,name);let remove=false,verified:Reservation|undefined;
        try{const raw=await this.read(file) as Reservation;const value=this.verify(raw,raw.record.packet.idempotencyKey);this.controlDocument(value,name.slice(0,64));remove=sameGraphErasureIdentity(target,value.record.packet.erasureIdentity);if(remove)verified=value;}
        catch{remove=true;} // Unattributable unacknowledged scratch custody is discarded.
        if(remove){const keyDigest=name.slice(0,64);if(verified)await this.retainControl(verified,keyDigest);await this.publish(path.join(this.directory,'.local-erased-actions',`${keyDigest}.json`),{v:1,keyDigest,target});await SafeFsExecutor.safeUnlink(file,{operation:'graph-intake:local-erasure'});}
      }await fs.mkdir(this.directory,{recursive:true,mode:0o700});await this.syncDirectory(this.directory);
    });this.queue=operation.catch(()=>undefined);return operation;
  }

  /** Called from the serialized reservation builder to allocate the next global
   * packet position together with the runtime's verified durable source. */
  nativeTailReservations():Promise<ConversationGraphReplicationRecord[]>{const work=this.queue.then(()=>this.frozenReservations());this.queue=work.catch(()=>{/* @silent-fallback-ok: only queue scheduling recovers; the caller receives the original inventory failure and cannot sign closure. */});return work;}
  async reservations(): Promise<ConversationGraphReplicationRecord[]> {
    const erasures = await this.erasureState();
    await this.purge(erasures);
    let files: string[];
    try { files = await fs.readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: ConversationGraphReplicationRecord[] = [];
    for (const name of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
      const parsed = await this.read(path.join(this.directory, name)) as Reservation;
      const key = parsed.record?.packet?.idempotencyKey;
      if (typeof key !== 'string' || name !== crypto.createHash('sha256').update(key).digest('hex') + '.json') {
        throw new Error('graph-intake-reservation-invalid');
      }
      const record = this.verify(parsed, key).record;
      if (!this.erased(erasures, record)) records.push(structuredClone(record));else await this.retainControl(parsed,this.digest(key));
    }
    // Inventory reads can overlap a serialized forget while awaiting disk I/O.
    // Recheck durable fences after the last read before returning any bundle.
    const latest = await this.erasureState();
    return records.filter(record => !this.erased(latest, record));
  }

  reserve(idempotencyKey: string, requestHash: string,
    build: () => Promise<ConversationGraphReplicationRecord> | ConversationGraphReplicationRecord): Promise<ConversationGraphReplicationRecord> {
    const operation = this.queue.then(() => this.prepare(idempotencyKey, requestHash, build));
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private verify(value: unknown, key: string): Reservation {
    const reservation = value as Reservation;
    const parsedCore = validateGraphOperationCore(reservation?.record?.coreType, reservation?.record?.core);
    if (!exactFields(reservation, ['v', 'requestHash', 'record']) || reservation.v !== 1
        || !/^[a-f0-9]{64}$/.test(reservation.requestHash) || !reservation.record
        || !exactFields(reservation.record, ['coreType', 'packet', 'packetSignature', 'core', 'authorizationProof', 'encryptedSourceBundle'])
        || reservation.record.coreType !== reservation.record.packet?.coreType
        || Buffer.byteLength(canonicalJson(reservation.record)) > GRAPH_REPLICATION_MAX_RECORD_BYTES
        || reservation.record.packet?.idempotencyKey !== key || !parsedCore
        || canonicalHash(parsedCore) !== canonicalHash(reservation.record.core)
        || reservation.record.packet.eventId !== graphOperationIdentity(reservation.record.coreType, parsedCore)
        || !verifyGraphAuthorization(reservation.record.packet, reservation.record.core, reservation.record.authorizationProof,
          this.ownerPublicKey, reservation.record.packet.writerId).ok
        || !reservation.record.authorizationProof.membership.members.some(member =>
          member.machineId === reservation.record.packet.writerId && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.packet,
            reservation.record.packet, reservation.record.packetSignature, member.signingPublicKey))
        || !reservation.record.encryptedSourceBundle
        || !verifyEncryptedBundle(reservation.record.encryptedSourceBundle, reservation.record.authorizationProof.membership)
        || canonicalHash(reservation.record.encryptedSourceBundle) !== reservation.record.packet.sourceBundleHash) {
      throw new Error('graph-intake-reservation-invalid');
    }
    return reservation;
  }
  /** Inspect every owned published/scratch reservation after queue-drained purge. */
  async assertLocalErasurePurged(target:GraphErasureIdentity):Promise<string>{
    if(!(this.localErasure instanceof ConversationGraphLocalErasureFence)||!this.localErasure.isDenied(target))throw new Error('graph-intake-local-fence-required');
    const retained:string[]=[];for(const name of await this.names(this.directory)){
      if(!/^[a-f0-9]{64}\.json(?:\.[A-Za-z0-9-]+\.(?:pending|tmp))?$/.test(name))continue;
      const raw=await this.read(path.join(this.directory,name)) as Reservation,value=this.verify(raw,raw.record.packet.idempotencyKey);
      if(sameGraphErasureIdentity(target,value.record.packet.erasureIdentity))throw new Error('graph-intake-erasure-key-copy-remains');retained.push(canonicalHash(value.record.packet));
    }const controls:string[]=[];for(const name of (await this.names(path.join(this.directory,'.retained-controls'))).sort()){if(!/^[a-f0-9]{64}\.json$/.test(name))throw new Error('graph-intake-retained-control-file-invalid');const doc=this.verifyRetained(await this.read(path.join(this.directory,'.retained-controls',name),MAX_RETAINED_CONTROL_BYTES),name.slice(0,64));controls.push(canonicalHash(doc));}const ownerQueue=this.localOwnerQueue?await this.localOwnerQueue.assertPurged(target):null;return canonicalHash({v:1,scope:'graph-intake',target,retainedPackets:retained.sort(),retainedControls:controls,matchingKeyCopies:[],ownerQueue});
  }
  private async locallyErasedAction(key:string):Promise<boolean>{
    const digest=this.digest(key);try{const value=await this.read(path.join(this.directory,'.local-erased-actions',`${digest}.json`),MAX_METADATA_BYTES) as {v:1;keyDigest:string;target:GraphErasureIdentity};
      if(!exactFields(value,['v','keyDigest','target'])||value.v!==1||value.keyDigest!==digest||!validateGraphErasureIdentity(value.target)||!this.localErasure?.isDenied(value.target))throw new Error('graph-intake-local-erasure-ledger-invalid');return true;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  }
  private async prepare(key: string, requestHash: string,
    build: () => Promise<ConversationGraphReplicationRecord> | ConversationGraphReplicationRecord): Promise<ConversationGraphReplicationRecord> {
    if (!key || key.length > 200 || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error('graph-intake-request-invalid');
    if(await this.locallyErasedAction(key))throw new GraphIntakeSourceErased();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let erasures = await this.erasureState();
    await this.purge(erasures);
    if (erasures.actions.has(this.digest(key))) throw new GraphIntakeSourceErased();
    const file = path.join(this.directory, crypto.createHash('sha256').update(key).digest('hex') + '.json');
    try {
      const prior = this.verify(await this.read(file), key);
      if (this.erased(erasures, prior.record)) throw new GraphIntakeSourceErased();
      if (prior.requestHash !== requestHash) throw new GraphIdempotencyConflict();
      return structuredClone(prior.record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const operationIds=new Set([...(await this.frozenReservations()).map(record=>record.packet.eventId),...await this.historyBudget?.operationIds()??[]]);
    if(operationIds.size>=(this.historyBudget?.maxHistoryEntries??GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)&&!await this.historyBudget?.knownIdempotencyKey?.(key))throw new Error('graph-intake-history-capacity');
    const reservation = this.verify({ v: 1, requestHash, record: await build() }, key);
    erasures = await this.erasureState();
    if (this.erased(erasures, reservation.record)) throw new GraphIntakeSourceErased();
    const capacity=this.capacityLedger?await this.capacityLedger.reserve(reservation.record):null;capacity?.assertCurrent();
    const bytes = JSON.stringify(reservation);
    if (Buffer.byteLength(bytes) > MAX_RESERVATION_BYTES) throw new Error('graph-intake-reservation-too-large');
    // The runtime's actual SingleInstanceLock is a prerequisite. Exclusive
    // creation additionally prevents a duplicate writer replacing a reservation.
    capacity?.assertCurrent();
    const temporary = file + '.' + crypto.randomUUID() + '.pending';
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.link(temporary, file); // atomic exclusive publication; never clobbers
      const parent = await fs.open(this.directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    } finally {
      await SafeFsExecutor.safeUnlink(temporary, { operation: 'graph-intake:remove-encrypted-temporary' });
    }
    // Read back the exact durable ciphertext; a retry never reseals content or
    // substitutes a new receipt/event after an ambiguous previous response.
    const durable = this.verify(await this.read(file), key).record;
    if (this.erased(await this.erasureState(), durable)) throw new GraphIntakeSourceErased();
    return structuredClone(durable);
  }
}
