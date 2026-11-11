import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {GraphWitnessRecoveryCoordinator} from '../../src/core/GraphWitnessRecoveryCoordinator.js';
import {GraphWitnessService} from '../../src/core/GraphWitnessService.js';
import {ConversationGraphReplication,registerConversationGraphReplication,type ConversationGraphReplicationRecord} from '../../src/core/ConversationGraphReplication.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import {ReplicatedStoreReader} from '../../src/core/ReplicatedStoreReader.js';
import {ReplicatedKindRegistry} from '../../src/core/ReplicatedRecordEnvelope.js';
import {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';
import {ConflictStore} from '../../src/core/ConflictStore.js';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {EffortHeaderStore,deriveCertifiedHeaderMetadata,makeHeaderOperation,newTitleSalt,type HeaderOperation} from '../../src/core/EffortHeaderStore.js';
import {deriveGraphErasureIdentity,validateGraphOperationCore} from '../../src/core/ConversationGraphOperation.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {sealGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {canonicalHash,canonicalJson,graphOperationKey,signGraphRecord,GRAPH_SIGNATURE_DOMAINS as D} from '../../src/core/GraphWitnessTypes.js';
import {replicationFixture} from './conversation-graph-replication.fixtures.js';
const dirs:string[]=[];const services:GraphWitnessService[]=[];
async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'header-recovery-'));dirs.push(dir);return dir;}
afterEach(()=>{vi.restoreAllMocks();for(const s of services.splice(0))s.close();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'header-recovery-fixture-cleanup'});});
const H='hdr-0000000000000001';
async function fixture(mode:'fresh'|'stale'|'unknown'|'forgotten'='fresh'){
 const f=replicationFixture(),state=await directory(),fence=new ConversationGraphLocalErasureFence(state),writer=await ConversationGraphReplication.open({...f.options(await directory()),validateCore:(raw,type)=>!!validateGraphOperationCore(type,raw)});
 const peerOptions={...f.options(await directory(),'sleeper'),localErasure:fence,validateCore:(raw:unknown,type:Parameters<typeof validateGraphOperationCore>[0])=>!!validateGraphOperationCore(type,raw)};let peer=await ConversationGraphReplication.open(peerOptions);
 const witness=new GraphWitnessService({databasePath:path.join(await directory(),'w.sqlite'),witnessId:f.membership.witnessId,failureDomain:f.membership.failureDomain,signingPrivateKey:f.witness.privateKey,enrollments:{echo:{ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(),bearerToken:'header-recovery-test-transport'}},installedFailureDomains:['installed'],now:()=>Date.parse('2026-11-05T08:07:00Z')});services.push(witness);witness.registerMembership(f.membership);
 let sequence=0,previous:string|null=null;
 function record(core:Record<string,unknown>,coreType:'graph-event'|'header-op',application:Buffer):ConversationGraphReplicationRecord{
  const base=f.record(String(core.eventId??core.opId),++sequence,previous),eventId=graphOperationKey(coreType,String(core.eventId??core.opId));
  const {signature:_oldSignature,...unsignedReceipt}=base.authorizationProof.receipt;
  const receipt=signGraphAuthorizationReceipt({...unsignedReceipt,eventId,coreHash:canonicalHash(core),receiptId:(core.receipt as {id:string}).id,idempotencyKey:`${coreType}:request:${String(core.eventId??core.opId)}`},f.members[0].signing.privateKey);
  const authorizationProof={...base.authorizationProof,receipt};const encryptedSourceBundle=sealGraphBundle(encodeGraphSourceEnvelope(coreType,core,authorizationProof,application),f.membership.members,{agentId:'echo',eventId});application.fill(0);
  const packet={...base.packet,controlHash:canonicalHash(createGraphControlCapsule(coreType,core,authorizationProof)),coreType,erasureIdentity:deriveGraphErasureIdentity(coreType,core),eventId,idempotencyKey:receipt.idempotencyKey,coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt),sourceBundleHash:canonicalHash(encryptedSourceBundle)};previous=packet.coreHash;
  return {coreType,packet,packetSignature:signGraphRecord(D.packet,packet,f.members[0].signing.privateKey),core,authorizationProof,encryptedSourceBundle};
 }
 function header(opId:string,baseVersion:number,forget=false){const title=`Private ${opId}`,salt=newTitleSalt();const built=makeHeaderOperation(forget?'forget-header':'set-effort-title',H,baseVersion,{title,salt,opId,createdAt:'2026-11-05T08:05:00.000Z'});const core={...built,principal:'owner',machineId:'writer',receipt:{kind:'owner-proof' as const,id:`receipt-${opId}`}};
  return record(core,'header-op',Buffer.from(canonicalJson({kind:'effort-header-payload',requestId:`request-${opId}`,requestHash:canonicalHash({opId}),headerId:H,...(forget?{}:{title,salt})})));}
 async function save(r:ConversationGraphReplicationRecord,commit=true){const own=await writer.appendLocal(r);const proof=witness.prepare({packet:r.packet,controlCapsule:createGraphControlCapsule(r.coreType,r.core,r.authorizationProof),packetSignature:r.packetSignature,encryptedSourceBundle:r.encryptedSourceBundle!,lease:f.lease,originalLease:f.originalLease});r.preparationProof=proof;await writer.receive(r,'writer');const remote=await peer.receive(r,'writer');if(!commit)return;
  const cert=witness.commit('echo',r.packet.idempotencyKey,f.lease,f.originalLease,[own.receipt,remote]);const acks=await Promise.all([writer.attachCertificate(r.packet.eventId,cert),peer.attachCertificate(r.packet.eventId,cert)]);for(const ack of acks){witness.acknowledgeCertificate('echo',r.packet.idempotencyKey,ack);await writer.recordCertificateReceipt(r.packet.eventId,ack);await peer.recordCertificateReceipt(r.packet.eventId,ack);}}
 if(mode!=='unknown'){const template=f.record('creator-source');const core={...template.core,op:'create-effort',subject:{kind:'effort',id:'11111111-1111-4111-8111-111111111111'},projectScope:['instar'],headerId:H};delete core.parent;delete core.relation;delete core.replacesPlacementEventIds;await save(record(core,'graph-event',Buffer.from('opaque graph creator')));}
 if(mode==='stale'||mode==='forgotten')await save(header('current-title',0));
 if(mode==='forgotten')await save(header('forget-title',1,true));
 const pending=header('pending-title',0);await save(pending,false);
 const registry=new ReplicatedKindRegistry();registerConversationGraphReplication(registry);const dropped=new DroppedOriginRegistry({stateDir:state});const reader=new ReplicatedStoreReader({registry,stores:{conversationGraph:{enabled:true}},tierOf:()=> 'high',droppedOrigins:dropped,conflictStore:new ConflictStore({stateDir:state}),listRecordKeys:()=>peer.originRecords().map(row=>row.envelope.recordKey),loadOriginRecords:(_store,key)=>peer.originRecords().filter(row=>row.envelope.recordKey===key)});
 const current=f.actuation('sleeper',2);f.setLive({admitted:true,writerId:'sleeper',leaseEpoch:2,membershipEpoch:1,fencedLeaseHash:current.lease.fencedLeaseHash});
 const options={source:peer,reader,dropped,machineId:'sleeper',signingPrivateKey:f.members[1].signing.privateKey,sealingPrivateKey:f.members[1].sealing.privateKey,ownerPublicKey:f.owner.publicKey,writeAdmission:peerOptions.writeAdmission,legacyReadOnly:peerOptions.legacyReadOnly,liveAdmission:f.getLive,actuation:()=>({membership:f.membership,...current}),scopeVerifier:new ScopeVerifier({projectDir:state,stateDir:state,projectName:'instar'}),telegramChatId:'-1001',now:()=>Date.parse('2026-11-05T08:07:00Z')};
 return {f,witness,writer,peer,peerOptions,pending,current,options,fence};
}
describe('header operation recovery from actual certified metadata',()=>{
 it('adopts a first title only after certified creator, then completes actual witness/all-member storage under renewed native lease',async()=>{
  const x=await fixture(),result=new GraphWitnessRecoveryCoordinator(x.options).revalidate(x.pending.packet.eventId);expect(result,JSON.stringify(result)).toMatchObject({state:'validated',proof:{decision:'adopt'}});if(result.state!=='validated')return;
  const [adoption]=x.witness.adoptPending('echo',{currentLease:x.current.lease,originalCurrentLease:x.current.originalLease,revalidations:[{proof:result.proof,rewrap:result.rewrap}]});const accepted={...x.pending,adoption,rewrap:result.rewrap!};
  const receipts=await Promise.all([x.writer.receive(accepted,'writer'),x.peer.receive(accepted,'writer')]);const cert=x.witness.commit('echo',accepted.packet.idempotencyKey,x.current.lease,x.current.originalLease,receipts);const acks=await Promise.all([x.writer.attachCertificate(accepted.packet.eventId,cert),x.peer.attachCertificate(accepted.packet.eventId,cert)]);for(const ack of acks){x.witness.acknowledgeCertificate('echo',accepted.packet.idempotencyKey,ack);await x.peer.recordCertificateReceipt(accepted.packet.eventId,ack);}
  const reopened=await ConversationGraphReplication.open(x.peerOptions);expect(reopened.status(accepted.packet.eventId).state).toBe('committed');expect(canonicalHash(reopened.repairRecord(accepted.packet.eventId)!.core)).toBe(x.pending.packet.coreHash);
 });
 it('refuses stale CAS base and forgotten headers without unsealing private title bytes',async()=>{
  for(const mode of ['stale','forgotten'] as const){const x=await fixture(mode);const spy=vi.spyOn(x.peer,'openVerifiedPayload');const result=new GraphWitnessRecoveryCoordinator(x.options).revalidate(x.pending.packet.eventId);expect(result,JSON.stringify(result)).toMatchObject({state:'validated',proof:{decision:'refuse',reason:mode==='stale'?'stale-heads':'erased-source'},rewrap:null});expect(spy).not.toHaveBeenCalled();}
 });
 it('holds unknown creator evidence and honors immediate local deny before private unseal or witness erasure delivery',async()=>{
  const unknown=await fixture('unknown');expect(new GraphWitnessRecoveryCoordinator(unknown.options).revalidate(unknown.pending.packet.eventId)).toMatchObject({state:'held',reason:'header-creator-evidence-missing'});
  const x=await fixture();await x.fence.deny(x.pending.packet.erasureIdentity);const result=new GraphWitnessRecoveryCoordinator(x.options).revalidate(x.pending.packet.eventId);expect(result,JSON.stringify(result)).toMatchObject({state:'validated',proof:{decision:'refuse',reason:'erased-source'},rewrap:null});
 });
});
describe('one header metadata/CAS derivation for cache and recovery',()=>{
 it('matches get for the same certified operations and forget, without persisting plaintext or salt',async()=>{
  const state=await directory(),store=new EffortHeaderStore(state,()=>null),ops:HeaderOperation[]=[];let lastContent:{title:string;salt:string}|null=null;
  for(const [id,base]of [['header-aaa',0],['header-bbb',0],['header-ccc',1]] as const){const content={title:`Private ${id}`,salt:newTitleSalt()};const op=makeHeaderOperation('set-effort-title',H,base,{...content,opId:id});store.applyCertified(op,content);ops.push(op);lastContent=content;expect(deriveCertifiedHeaderMetadata(ops)).toEqual(store.get(H));}
  const forget=makeHeaderOperation('forget-header',H,2,{opId:'header-forget'});store.applyCertified(forget,null);ops.push(forget);expect(deriveCertifiedHeaderMetadata(ops)).toEqual(store.get(H));const bytes=await fs.readFile(store.file,'utf8');expect(bytes).not.toContain(lastContent!.title);expect(bytes).not.toContain(lastContent!.salt);
 });
 it('reconciles only current verified union so a dropped old v1 cannot block a new current base0',async()=>{
  const state=await directory(),store=new EffortHeaderStore(state,()=>null),old={title:'Dropped origin title',salt:newTitleSalt()},fresh={title:'Current valid title',salt:newTitleSalt()};const oldOp=makeHeaderOperation('set-effort-title',H,0,{...old,opId:'old-origin-title'}),newOp=makeHeaderOperation('set-effort-title',H,0,{...fresh,opId:'new-origin-title'});
  store.applyCertified(oldOp,old);expect(store.get(H)?.version).toBe(1);store.reconcileCertified([]);expect(store.get(H)).toBeNull();store.reconcileCertified([{operation:newOp,content:fresh}]);expect(store.get(H)?.current?.opId).toBe(newOp.opId);expect(store.get(H)?.conflicts).toEqual([]);
  const before=await fs.readFile(store.file,'utf8');expect(()=>store.reconcileCertified([{operation:newOp,content:{title:'Wrong private body',salt:fresh.salt}}])).toThrow('invalid-content');expect(await fs.readFile(store.file,'utf8')).toBe(before);expect(before).not.toContain(old.title);expect(before).not.toContain(fresh.title);expect(before).not.toContain(fresh.salt);
 });
});
