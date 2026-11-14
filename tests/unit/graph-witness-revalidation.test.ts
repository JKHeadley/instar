import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {sealGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {validateGraphEvent} from '../../src/core/conversationGraph.js';
import {GraphWitnessRecoveryCoordinator} from '../../src/core/GraphWitnessRecoveryCoordinator.js';
import {ConversationGraphReplication,registerConversationGraphReplication} from '../../src/core/ConversationGraphReplication.js';
import {ReplicatedStoreReader} from '../../src/core/ReplicatedStoreReader.js';
import {ReplicatedKindRegistry} from '../../src/core/ReplicatedRecordEnvelope.js';
import {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';
import {ConflictStore} from '../../src/core/ConflictStore.js';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {canonicalHash,signGraphRecord,unsigned,verifyPendingRevalidation} from '../../src/core/GraphWitnessTypes.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {replicationFixture} from './conversation-graph-replication.fixtures.js';
const dirs:string[]=[];async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'graph-revalidate-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-revalidation-fixture-cleanup'});});
function rewrite(record:ReturnType<ReturnType<typeof replicationFixture>['record']>, core:Record<string,unknown>, f:ReturnType<typeof replicationFixture>){
 if(core.op==='create-effort'){core.headerId='hdr-1111111111111111';delete core.parent;delete core.relation;delete core.replacesPlacementEventIds;}
 record.core=core;const receipt=signGraphAuthorizationReceipt({...unsigned(record.authorizationProof.receipt),coreHash:canonicalHash(core)},f.members[0].signing.privateKey);
 record.authorizationProof.receipt=receipt;record.packet={...record.packet,coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt)};record.encryptedSourceBundle=sealGraphBundle(encodeGraphSourceEnvelope(record.coreType,core,record.authorizationProof,Buffer.from('semantic revalidation source fixture')),f.membership.members,record.packet);record.packet.controlHash=canonicalHash(createGraphControlCapsule(record.coreType,core,record.authorizationProof));record.packet.sourceBundleHash=canonicalHash(record.encryptedSourceBundle);record.packetSignature=signGraphRecord('graph-operation-packet-v1',record.packet,f.members[0].signing.privateKey);return record;
}
async function fixture(previous=false, effortScope?:string[], missingEffort=false,frontDoorGuard=false){
 const f=replicationFixture();const dir=await directory();const writer=await ConversationGraphReplication.open({...f.options(await directory()),validateCore:(value:unknown)=>!!validateGraphEvent(value)});
 const sourceOptions={...f.options(await directory(),'sleeper'),validateCore:(value:unknown)=>!!validateGraphEvent(value)};const source=await ConversationGraphReplication.open(sourceOptions);
 let initial:ReturnType<typeof f.record>|null=null;
 if(previous){initial=f.record('certified-first');if(effortScope)rewrite(initial,{...initial.core,op:'create-effort',subject:{kind:'effort',id:'11111111-1111-4111-8111-111111111111'},projectScope:effortScope},f);const r1=await writer.appendLocal(initial);const r2=await source.receive(initial,'writer');const certificate=f.certificate(initial,[r1.receipt,r2]);
  const acks=await Promise.all([writer.attachCertificate(initial.packet.eventId,certificate),source.attachCertificate(initial.packet.eventId,certificate)]);
  for(const ack of acks){await writer.recordCertificateReceipt(initial.packet.eventId,ack);await source.recordCertificateReceipt(initial.packet.eventId,ack);}}
 if(frontDoorGuard){
  const effort={kind:'effort',id:'11111111-1111-4111-8111-111111111111'};const conversation={kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42};
  const values=[{op:'create-effort',subject:effort,projectScope:['instar']},{op:'set-primary-placement',subject:conversation,parent:effort,relation:'coordinates',replacesPlacementEventIds:[]},{op:'set-front-door',subject:effort,frontDoor:conversation,replacesFrontDoorEventIds:[],observedPlacementEventIds:['history-1']}];
  for(let i=0;i<values.length;i++){const record=f.record(`history-${i}`,i+1,initial?.packet.coreHash??null);const raw={...record.core,...values[i]};if(raw.op==='set-front-door'){delete raw.parent;delete raw.relation;delete raw.replacesPlacementEventIds;}rewrite(record,raw,f);
   const r1=await writer.appendLocal(record);const r2=await source.receive(record,'writer');const cert=f.certificate(record,[r1.receipt,r2]);const acks=await Promise.all([writer.attachCertificate(record.packet.eventId,cert),source.attachCertificate(record.packet.eventId,cert)]);
   for(const ack of acks){await writer.recordCertificateReceipt(record.packet.eventId,ack);await source.recordCertificateReceipt(record.packet.eventId,ack);}initial=record;}
 }
 const pending=f.record('pending-one',frontDoorGuard?4:previous?2:1,initial?initial.packet.coreHash:null);if(frontDoorGuard)rewrite(pending,{...pending.core,replacesPlacementEventIds:['history-1']},f);if(effortScope||missingEffort)rewrite(pending,{...pending.core,parent:{kind:'effort',id:'11111111-1111-4111-8111-111111111111'},relation:'coordinates'},f);await writer.appendLocal(pending);await source.receive(pending,'writer');
 const registry=new ReplicatedKindRegistry();registerConversationGraphReplication(registry);const dropped=new DroppedOriginRegistry({stateDir:dir});
 const reader=new ReplicatedStoreReader({registry,stores:{conversationGraph:{enabled:true}},tierOf:()=> 'high',droppedOrigins:dropped,conflictStore:new ConflictStore({stateDir:dir}),listRecordKeys:()=>source.originRecords().map(r=>r.envelope.recordKey),loadOriginRecords:(_store,key)=>source.originRecords().filter(r=>r.envelope.recordKey===key)});
 const current=f.actuation('sleeper',2);f.setLive({admitted:true,writerId:'sleeper',leaseEpoch:2,membershipEpoch:1,fencedLeaseHash:current.lease.fencedLeaseHash});
 // The live admission binding is the native lease hash itself.
 f.setLive({...f.getLive(),fencedLeaseHash:current.lease.fencedLeaseHash});
 const scopeVerifier=new ScopeVerifier({projectDir:dir,stateDir:dir,projectName:'instar',topicProjects:{'42':{projectName:'instar',projectDir:dir}}});
 const options={source,reader,dropped,machineId:'sleeper',signingPrivateKey:f.members[1].signing.privateKey,sealingPrivateKey:f.members[1].sealing.privateKey,ownerPublicKey:f.owner.publicKey,
 writeAdmission:sourceOptions.writeAdmission,legacyReadOnly:sourceOptions.legacyReadOnly,liveAdmission:f.getLive,actuation:()=>({membership:f.membership,...current}),scopeVerifier,telegramChatId:'-1001',now:()=>Date.parse(current.lease.issuedAt)+1000};
 return {f,source,pending,current,options};
}
describe('actual-source pending semantic revalidation',()=>{
 it('derives and signs adoption from actual certified union, decryptable original source and current native authority',async()=>{
  const {f,pending,current,options}=await fixture();const result=new GraphWitnessRecoveryCoordinator(options).revalidate(pending.packet.eventId);
  expect(result,JSON.stringify(result)).toMatchObject({state:'validated'});if(result.state!=='validated')return;
  expect(result.proof.decision).toBe('adopt');expect(result.rewrap).not.toBeNull();expect(verifyPendingRevalidation(result.proof,pending.packet,f.membership,current.lease)).toBe(true);
  expect(result.proof.sourceProofHash).toBe(canonicalHash({coreType:pending.coreType,packet:pending.packet,packetSignature:pending.packetSignature,core:pending.core,authorizationProof:pending.authorizationProof}));
 });
 it('refuses pending whose observed subject heads changed in the real all-member-certified source',async()=>{
  const {pending,options}=await fixture(true);const result=new GraphWitnessRecoveryCoordinator(options).revalidate(pending.packet.eventId);
  expect(result,JSON.stringify(result)).toMatchObject({state:'validated'});if(result.state!=='validated')return;expect(result.proof).toMatchObject({decision:'refuse',reason:'stale-heads'});expect(result.rewrap).toBeNull();
 });
 it('holds expired or mismatched native authority and refuses an unknown owner/project binding',async()=>{
  const {pending,current,options}=await fixture();
  expect(new GraphWitnessRecoveryCoordinator({...options,now:()=>Date.parse(current.lease.expiresAt)+1}).revalidate(pending.packet.eventId)).toMatchObject({state:'held',reason:'current-native-admission-invalid'});
  const result=new GraphWitnessRecoveryCoordinator({...options,telegramChatId:'another-owner-chat'}).revalidate(pending.packet.eventId);
  expect(result,JSON.stringify(result)).toMatchObject({state:'validated'});if(result.state==='validated')expect(result.proof).toMatchObject({decision:'refuse',reason:'dependency-refused'});
 });
 it('refuses absent effort dependencies and certified effort scope that excludes the actual topic binding',async()=>{
  for(const setup of [await fixture(false,undefined,true),await fixture(true,['another-project'])]){
   const result=new GraphWitnessRecoveryCoordinator(setup.options).revalidate(setup.pending.packet.eventId);
   expect(result,JSON.stringify(result)).toMatchObject({state:'validated',proof:{decision:'refuse',reason:'dependency-refused'},rewrap:null});
  }
 });
 it('holds source when the current machine cannot actually decrypt the original encrypted bundle',async()=>{
  const {pending,options,f}=await fixture();
  const result=new GraphWitnessRecoveryCoordinator({...options,sealingPrivateKey:f.witness.privateKey}).revalidate(pending.packet.eventId);
  expect(result).toEqual({state:'held',reason:'source-decryption-or-rewrap-invalid'});
 });

 it('refuses a causally current move that would unlink an actually certified effort front door',async()=>{
  const {pending,options}=await fixture(false,undefined,false,true);
  const result=new GraphWitnessRecoveryCoordinator(options).revalidate(pending.packet.eventId);
  expect(result,JSON.stringify(result)).toMatchObject({state:'validated',proof:{decision:'refuse',reason:'dependency-refused'},rewrap:null});
 });

 it('does not strand an earlier pending operation merely because another verified Saving source exists',async()=>{
  const {f,pending,source,options}=await fixture();
  const next=f.record('pending-two',2,pending.packet.coreHash);await source.receive(next,'writer');
  const result=new GraphWitnessRecoveryCoordinator(options).revalidate(pending.packet.eventId);
  expect(result,JSON.stringify(result)).toMatchObject({state:'validated',proof:{decision:'adopt'}});
 });

});
