import {ConversationGraphErasureAuthorityStore} from '../../src/core/ConversationGraphErasureAuthorityStore.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {ConversationGraphIntake} from '../../src/core/ConversationGraphIntake.js';
import {canonicalHash,signGraphRecord,GRAPH_SIGNATURE_DOMAINS,type GraphWitnessErasure} from '../../src/core/GraphWitnessTypes.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {replicationFixture} from './conversation-graph-replication.fixtures.js';
import {sealGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
const directories:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const d of directories.splice(0))await SafeFsExecutor.safeRm(d,{recursive:true,force:true,operation:'graph-intake-test:cleanup'});});
async function temporaryDirectory(){const d=await fs.mkdtemp(path.join(os.tmpdir(),'graph-intake-'));directories.push(d);return d;}
function erasure(f:ReturnType<typeof replicationFixture>,record:ReturnType<ReturnType<typeof replicationFixture>['record']>,agentId='echo'):GraphWitnessErasure{
 const unsigned={v:1 as const,agentId,requestId:'forget-one',target:record.packet.erasureIdentity,bundleHashes:[record.packet.sourceBundleHash],membershipEpoch:1,leaseEpoch:1,
  authorizationReceiptHash:'a'.repeat(64),witnessId:'independent-witness',erasedAt:'2026-11-05T08:20:00Z'};
 return {...unsigned,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,unsigned,f.witness.privateKey)};
}
const keyName=(key:string)=>crypto.createHash('sha256').update(key).digest('hex');
function intakeFor(d:string,f:ReturnType<typeof replicationFixture>){return new ConversationGraphIntake(d,f.owner.publicKey,new Map([['independent-witness',f.witness.publicKey]]),undefined,new ConversationGraphErasureAuthorityStore(path.join(d,'.authorities'),f.membership,f.owner.publicKey,new Map([['independent-witness',f.witness.publicKey]])));}
describe('durable graph idempotency reservation',()=>{
 it('refuses before invoking a third reservation builder while preserving the two exact frozen retries',async()=>{
  const dir=await temporaryDirectory(),f=replicationFixture(),intake=new ConversationGraphIntake(dir,f.owner.publicKey,new Map(),undefined,undefined,{maxHistoryEntries:2,operationIds:async()=>new Set()});
  const a=f.record('budget-a'),b=f.record('budget-b',2,a.packet.coreHash),c=f.record('budget-c',3,b.packet.coreHash);
  await intake.reserve(a.packet.idempotencyKey,canonicalHash('a'),()=>a);await intake.reserve(b.packet.idempotencyKey,canonicalHash('b'),()=>b);
  const build=vi.fn(()=>c),before=(await fs.readdir(dir)).sort();await expect(intake.reserve(c.packet.idempotencyKey,canonicalHash('c'),build)).rejects.toThrow('history-capacity');expect(build).not.toHaveBeenCalled();expect((await fs.readdir(dir)).sort()).toEqual(before);
  expect(await intake.reserve(a.packet.idempotencyKey,canonicalHash('a'),()=>{throw new Error('must not rebuild');})).toEqual(a);
 });
 it('reseals once across concurrent retries and restart, and refuses changed requests',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'graph-intake-'));directories.push(directory);
  const f=replicationFixture();const intake=new ConversationGraphIntake(directory,f.owner.publicKey);const record=f.record();
  const build=vi.fn(()=>record);const hash=canonicalHash({op:'move',observedHeads:[]});const key=record.packet.idempotencyKey;
  const copies=await Promise.all([intake.reserve(key,hash,build),intake.reserve(key,hash,build)]);
  expect(build).toHaveBeenCalledOnce();expect(copies[0]).toEqual(copies[1]);
  const restarted=new ConversationGraphIntake(directory,f.owner.publicKey);
  expect(await restarted.reserve(key,hash,()=>{throw new Error('must-not-reseal');})).toEqual(record);
  await expect(restarted.reserve(key,canonicalHash({op:'changed'}),build)).rejects.toMatchObject({code:'idempotency-conflict'});
  expect(build).toHaveBeenCalledOnce();
  const files=await fs.readdir(directory);expect(files).toHaveLength(1);
  const bytes=await fs.readFile(path.join(directory,files[0]),'utf8');expect(bytes).not.toContain('private original source');
  expect((await fs.stat(path.join(directory,files[0]))).mode&0o777).toBe(0o600);
 });
 it('rejects forged authority before publishing any reservation',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'graph-intake-'));directories.push(directory);
  const f=replicationFixture();const record=f.record();record.authorizationProof.receipt.signature='forged';
  await expect(new ConversationGraphIntake(directory,f.owner.publicKey).reserve(record.packet.idempotencyKey,canonicalHash({op:'move'}),()=>record)).rejects.toThrow('reservation-invalid');
  expect(await fs.readdir(directory)).toEqual([]);
 });
 it('rejects extra plaintext stripped by the graph parser even when every affected signature is authentic',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();record.core.extraPlaintext='private original source';
  const {signature:_signature,...prior}=record.authorizationProof.receipt;
  const unsigned={...prior,coreHash:canonicalHash(record.core)};
  record.authorizationProof.receipt={...unsigned,signature:signGraphRecord('graph-authorization-receipt-v1',unsigned,f.members[0].signing.privateKey)};
  record.packet.coreHash=unsigned.coreHash;record.packet.authorizationReceiptHash=canonicalHash(record.authorizationProof.receipt);record.packet.controlHash=canonicalHash({v:1,coreType:record.coreType,core:record.core,authorizationProof:record.authorizationProof});
  record.packetSignature=signGraphRecord(GRAPH_SIGNATURE_DOMAINS.packet,record.packet,f.members[0].signing.privateKey);
  await expect(intakeFor(d,f).reserve(record.packet.idempotencyKey,canonicalHash({op:'move'}),()=>record)).rejects.toThrow('reservation-invalid');
  expect(await fs.readdir(d)).toEqual([]);
 });
 it('preserves a legal 1 MiB encrypted reservation across restart and purges it without enlarging metadata bounds',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();
  record.encryptedSourceBundle=sealGraphBundle(Buffer.alloc(1024*1024,65),f.membership.members,{agentId:record.packet.agentId,eventId:record.packet.eventId});
  record.packet.sourceBundleHash=canonicalHash(record.encryptedSourceBundle);
  record.packetSignature=signGraphRecord(GRAPH_SIGNATURE_DOMAINS.packet,record.packet,f.members[0].signing.privateKey);
  const hash=canonicalHash({op:'move'});await intakeFor(d,f).reserve(record.packet.idempotencyKey,hash,()=>record);
  const restarted=intakeFor(d,f);expect(await restarted.reserve(record.packet.idempotencyKey,hash,()=>{throw new Error('must-not-reseal');})).toEqual(record);
  expect((await restarted.reservations())[0].packet.coreType).toBe('graph-event');
  expect(await restarted.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)))).toMatchObject({complete:true,removedCopies:1});
  expect(await restarted.reservations()).toEqual([]);
 });
 it('refuses missing, unknown and mismatched core namespaces rather than inferring a type',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const intake=intakeFor(d,f);
  for(const changed of [{...record,coreType:undefined},{...record,coreType:'unknown'},{...record,coreType:'source-observation'}]){
   await expect(intake.reserve(record.packet.idempotencyKey,canonicalHash({op:'move'}),()=>changed as any)).rejects.toThrow('reservation-invalid');
  }
  expect(await fs.readdir(d)).toEqual([]);
 });
});

describe('signed local intake-copy erasure',()=>{
 it('requires a pinned exact witness proof and the trusted runtime agent before mutation',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const intake=intakeFor(d,f);
  await intake.reserve(record.packet.idempotencyKey,canonicalHash({op:'move'}),()=>record);
  const before=await fs.readdir(d);const proof=erasure(f,record);
  for(const invalid of [{...proof,signature:'forged'},{...proof,title:'plaintext'},erasure(f,record,'other-agent')]){
   await expect(intake.applyErasure(invalid,'echo')).rejects.toThrow('erasure-proof-invalid');
  }
  await expect(new ConversationGraphIntake(d,f.owner.publicKey).applyErasure(proof,'echo')).rejects.toThrow('erasure-proof-invalid');
  expect(await fs.readdir(d)).toEqual(before);expect(await intake.reservations()).toHaveLength(1);
 });
 it('purges published, orphan and hardlinked copies without touching another valid action',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const other=f.record('other-event',2,record.packet.coreHash);
  const intake=intakeFor(d,f);const hash=canonicalHash({op:'move'});
  await intake.reserve(record.packet.idempotencyKey,hash,()=>record);await intake.reserve(other.packet.idempotencyKey,hash,()=>other);
  const published=path.join(d,`${await keyName(record.packet.idempotencyKey)}.json`);
  const linked=published+'.11111111-1111-4111-8111-111111111111.pending';await fs.link(published,linked);
  const orphan=published+'.22222222-2222-4222-8222-222222222222.pending';await fs.writeFile(orphan,await fs.readFile(published));
  const result=await intake.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)));
  expect(result).toMatchObject({local:true,fleetComplete:false,complete:true,removedCopies:3,conservativeCopies:0});
  expect((await intake.reservations()).map(r=>r.packet.eventId)).toEqual([other.packet.eventId]);
  expect((await fs.readdir(d)).filter(n=>n.endsWith('.pending'))).toEqual([]);
  const restarted=intakeFor(d,f);const build=vi.fn(()=>f.record());
  await expect(restarted.reserve(record.packet.idempotencyKey,hash,build)).rejects.toMatchObject({code:'source-erased'});
  expect(build).not.toHaveBeenCalled();expect(await restarted.reservations()).toHaveLength(1);
 });
 it('conservatively fences and purges malformed crash scratch copies with an honest scope count',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const key='unreadable-crash-action';
  const file=path.join(d,`${await keyName(key)}.json.33333333-3333-4333-8333-333333333333.pending`);
  await fs.writeFile(file,'{"record":{"encryptedSourceBundle":{"ciphertext":"incomplete-key-copy');
  const intake=intakeFor(d,f);const result=await intake.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)));
  expect(result).toMatchObject({local:true,fleetComplete:false,complete:true,removedCopies:1,conservativeCopies:1});
  await expect(fs.stat(file)).rejects.toMatchObject({code:'ENOENT'});
  const build=vi.fn(()=>record);await expect(intakeFor(d,f).reserve(key,canonicalHash({op:'move'}),build)).rejects.toMatchObject({code:'source-erased'});
  expect(build).not.toHaveBeenCalled();
 });
 it('persists suppression before unlink and retries failed physical purge after restart',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const intake=intakeFor(d,f);const hash=canonicalHash({op:'move'});
  await intake.reserve(record.packet.idempotencyKey,hash,()=>record);
  const original=SafeFsExecutor.safeUnlink.bind(SafeFsExecutor);
  vi.spyOn(SafeFsExecutor,'safeUnlink').mockImplementation(async(file,options)=>{
   if(options.operation==='graph-intake:purge-erased-source-copy')throw new Error('simulated-crash-before-unlink');
   return original(file,options);
  });
  const result=await intake.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)));
  expect(result.complete).toBe(false);expect(result.remainingCopies).toHaveLength(1);
  const restarted=intakeFor(d,f);const build=vi.fn(()=>record);
  await expect(restarted.reserve(record.packet.idempotencyKey,hash,build)).rejects.toMatchObject({code:'source-erased'});
  expect(await restarted.reservations()).toEqual([]);expect(build).not.toHaveBeenCalled();
  vi.restoreAllMocks();expect(await restarted.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)))).toMatchObject({complete:true,removedCopies:1});
  expect(await restarted.reservations()).toEqual([]);
 });
 it('recovers a crash after proof durability but before an orphan action fence was written',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const proof=erasure(f,record);
  await new ConversationGraphErasureAuthorityStore(path.join(d,'.authorities'),f.membership,f.owner.publicKey,new Map([['independent-witness',f.witness.publicKey]])).accept(proof,f.erasureAuthority(proof));
  const proofDir=path.join(d,'.erasure-proofs');await fs.mkdir(proofDir);
  await fs.writeFile(path.join(proofDir,canonicalHash(proof)+'.json'),JSON.stringify({v:1,agentId:'echo',proof}));
  const key='orphan-before-action-fence';await fs.writeFile(path.join(d,`${await keyName(key)}.json.44444444-4444-4444-8444-444444444444.pending`),'broken sealed copy');
  const build=vi.fn(()=>record);
  await expect(intakeFor(d,f).reserve(key,canonicalHash({op:'move'}),build)).rejects.toMatchObject({code:'source-erased'});
  expect(build).not.toHaveBeenCalled();expect((await fs.readdir(d)).filter(n=>n.endsWith('.pending'))).toEqual([]);
 });
 it('counts erased original controls against history capacity without keeping their bodies',async()=>{const d=await temporaryDirectory(),f=replicationFixture(),fence=new ConversationGraphLocalErasureFence(d),store=new ConversationGraphErasureAuthorityStore(path.join(d,'.authorities'),f.membership,f.owner.publicKey,new Map([['independent-witness',f.witness.publicKey]])),intake=new ConversationGraphIntake(d,f.owner.publicKey,new Map([['independent-witness',f.witness.publicKey]]),fence,store,{maxHistoryEntries:2,operationIds:async()=>new Set()});const a=f.record('retained-a'),b=f.record('retained-b',2,a.packet.coreHash),c=f.record('retained-c',3,b.packet.coreHash),ha=canonicalHash('a'),hb=canonicalHash('b');await intake.reserve(a.packet.idempotencyKey,ha,()=>a);await intake.reserve(b.packet.idempotencyKey,hb,()=>b);await fence.deny(a.packet.erasureIdentity);await intake.eraseLocal(a.packet.erasureIdentity);expect(await intake.reservations()).toHaveLength(1);expect(await intake.frozenReservations()).toHaveLength(2);const build=vi.fn(()=>c);await expect(intake.reserve(c.packet.idempotencyKey,canonicalHash('c'),build)).rejects.toThrow('history-capacity');expect(build).not.toHaveBeenCalled();expect(await intake.reserve(b.packet.idempotencyKey,hb,()=>{throw new Error('do not rebuild');})).toEqual(b);});
 it('serializes forgetting ahead of a retry and does not reseal the erased source',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const intake=intakeFor(d,f);const hash=canonicalHash({op:'move'});
  await intake.reserve(record.packet.idempotencyKey,hash,()=>record);const build=vi.fn(()=>record);
  const forget=intake.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)));const retry=intake.reserve(record.packet.idempotencyKey,hash,build);
  expect((await forget).complete).toBe(true);await expect(retry).rejects.toMatchObject({code:'source-erased'});expect(build).not.toHaveBeenCalled();
 });
 it('refuses a valid signed reuse of an erased bundle under a fresh action key',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const intake=intakeFor(d,f);
  await intake.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)));
  const key='fresh-key-for-erased-bundle';const {signature:_signature,...prior}=record.authorizationProof.receipt;
  const unsigned={...prior,idempotencyKey:key};record.authorizationProof.receipt={...unsigned,signature:signGraphRecord('graph-authorization-receipt-v1',unsigned,f.members[0].signing.privateKey)};
  record.packet.idempotencyKey=key;record.packet.authorizationReceiptHash=canonicalHash(record.authorizationProof.receipt);record.packet.controlHash=canonicalHash(createGraphControlCapsule(record.coreType,record.core,record.authorizationProof));
  record.packetSignature=signGraphRecord(GRAPH_SIGNATURE_DOMAINS.packet,record.packet,f.members[0].signing.privateKey);
  await expect(intake.reserve(key,canonicalHash({op:'move'}),()=>record)).rejects.toMatchObject({code:'source-erased'});
  expect((await fs.readdir(d)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name))).toEqual([]);
 });
 it('a restored old reservation is suppressed and purged again before it can be returned',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const intake=intakeFor(d,f);const hash=canonicalHash({op:'move'});
  await intake.reserve(record.packet.idempotencyKey,hash,()=>record);const file=path.join(d,`${keyName(record.packet.idempotencyKey)}.json`);
  const restoredBytes=await fs.readFile(file);await intake.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)));await fs.writeFile(file,restoredBytes);
  const restarted=intakeFor(d,f);expect(await restarted.reservations()).toEqual([]);
  await expect(fs.stat(file)).rejects.toMatchObject({code:'ENOENT'});
  const build=vi.fn(()=>record);await expect(restarted.reserve(record.packet.idempotencyKey,hash,build)).rejects.toMatchObject({code:'source-erased'});
  expect(build).not.toHaveBeenCalled();
 });
 it('an inventory read paused with old bytes cannot return them after a forget completes',async()=>{
  const d=await temporaryDirectory();const f=replicationFixture();const record=f.record();const intake=intakeFor(d,f);
  await intake.reserve(record.packet.idempotencyKey,canonicalHash({op:'move'}),()=>record);
  const file=path.join(d,`${keyName(record.packet.idempotencyKey)}.json`);
  let reached!:()=>void;const paused=new Promise<void>(resolve=>{reached=resolve;});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let first=true;
  const original=(intake as any).read.bind(intake);
  vi.spyOn(intake as any,'read').mockImplementation(async(candidate:unknown)=>{
   const value=await original(candidate);if(candidate===file&&first){first=false;reached();await gate;}return value;
  });
  const inventory=intake.reservations();await paused;
  expect((await intake.applyErasure(erasure(f,record),'echo',f.erasureAuthority(erasure(f,record)))).complete).toBe(true);
  release();expect(await inventory).toEqual([]);
 });
 it('fences an unseen logical target with empty hashes and refuses future nonce reservations',async()=>{
  const d=await temporaryDirectory(),f=replicationFixture(),r=f.record(),intake=intakeFor(d,f);const priorProof=erasure(f,r);const raw={...priorProof,bundleHashes:[]};delete (raw as Partial<GraphWitnessErasure>).signature;
  const proof={...raw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,raw,f.witness.privateKey)};await intake.applyErasure(proof,'echo',f.erasureAuthority(proof));
  await expect(intake.reserve(r.packet.idempotencyKey,canonicalHash('future nonce'),()=>f.record())).rejects.toThrow('source-erased');
 });
 it('purges local reservation and hardlink temp before witness access and denies its action key after restart',async()=>{
  const d=await temporaryDirectory(),f=replicationFixture(),r=f.record(),fence=new ConversationGraphLocalErasureFence(d);
  const intake=new ConversationGraphIntake(d,f.owner.publicKey,new Map([['independent-witness',f.witness.publicKey]]),fence);
  await intake.reserve(r.packet.idempotencyKey,canonicalHash('request'),()=>r);
  const file=path.join(d,`${keyName(r.packet.idempotencyKey)}.json`);await fs.link(file,`${file}.crash.pending`);
  await fence.deny(r.packet.erasureIdentity);await intake.eraseLocal(r.packet.erasureIdentity);
  expect((await fs.readdir(d)).filter(n=>/^[a-f0-9]{64}\.json/.test(n))).toEqual([]);
  const restored=new ConversationGraphIntake(d,f.owner.publicKey,new Map(),new ConversationGraphLocalErasureFence(d));
  const build=vi.fn(()=>f.record('different-target'));await expect(restored.reserve(r.packet.idempotencyKey,canonicalHash('request'),build)).rejects.toThrow('source-erased');expect(build).not.toHaveBeenCalled();
 });

});
