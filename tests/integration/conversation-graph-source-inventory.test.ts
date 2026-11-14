/** Real local flat producer + registry -> signed sealed observations -> actual
 * all-member witness certification -> survivor inventory. Synthetic persisted
 * Slack alias collision is deliberate test data, never a production id source. */
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {ConversationGraphSourceInventoryCapture,assertGraphSourceObservationCachePurged,assertGraphSourceObservationAdmission,purgeLocallyDeniedGraphSourceObservationCache,prepareGraphSourceOperation,validateGraphSourceOperationCore,prepareGraphSourceObservation,materializeGraphSourceInventory,validateGraphSourceObservationCore,verifyGraphSourceObservationCapture,
 validateGraphSourceObservationPayload,sourceObservationEventId,type CapturedGraphSourceObservation} from '../../src/core/ConversationGraphSourceInventory.js';
import {reconcileGraphSourceCoverage} from '../../src/core/ConversationGraphSourceCoverage.js';
import {GRAPH_SOURCE_SWEEP_STALE_MS} from '../../src/core/ConversationGraphSourceSweep.js';
import {ConversationGraphSourceSweepCapture} from '../../src/core/ConversationGraphSourceSweepCapture.js';
import type {CapturedGraphSourceOperation} from '../../src/core/ConversationGraphSourceInventory.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {encodeGraphSourceRecoveryEnvelope} from '../../src/core/ConversationGraphSourceRecovery.js';
import {GraphSourceObservationRecoveryCoordinator} from '../../src/core/ConversationGraphSourceObservationRecovery.js';
import {reconstructGraphSourceRecord} from '../../src/core/ConversationGraphSourceRecovery.js';
import {ConversationGraphReplicationTransfer,buildGraphRecoverySourceManifest,buildGraphTransferRewrapInventory} from '../../src/core/ConversationGraphReplicationTransfer.js';
import {deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import {MachineIdentityManager,sign} from '../../src/core/MachineIdentity.js';
import {ConversationRegistry} from '../../src/core/ConversationRegistry.js';
import {StateManager} from '../../src/core/StateManager.js';
import {AppConversationService} from '../../src/core/AppConversationService.js';
import {MobileChatRequestStore} from '../../src/core/MobileChatRequests.js';
import {SlackAdapter} from '../../src/messaging/slack/SlackAdapter.js';
import {buildMobileSlackBridge,slackListRows} from '../../src/server/mobileSlackRoutes.js';
import {localConversationListPage,type MobileConversationRouteDeps} from '../../src/server/mobileConversationRoutes.js';
import {ConversationGraphReplication,registerConversationGraphReplication,type ConversationGraphReplicationRecord} from '../../src/core/ConversationGraphReplication.js';
import {ReplicatedKindRegistry} from '../../src/core/ReplicatedRecordEnvelope.js';
import {ReplicatedStoreReader} from '../../src/core/ReplicatedStoreReader.js';
import {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';
import {ConflictStore} from '../../src/core/ConflictStore.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {FencedLease} from '../../src/core/FencedLease.js';
import {WriteAdmission} from '../../src/core/WriteAdmission.js';
import {buildWriteDomainRegistry} from '../../src/core/WriteDomainRegistry.js';
import {sealGraphBundle,openGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {GraphWitnessService} from '../../src/core/GraphWitnessService.js';
import {canonicalHash,canonicalJson,signGraphRecord,witnessActionPayload,graphRewrapInventoryHash,type GraphMembershipEpoch} from '../../src/core/GraphWitnessTypes.js';

const APP='7a1c8a3e-1b2c-4d5e-9f90-1234567890ab';
describe('all-member durable source inventory preserves exact machine-local open identity',()=>{
 let dir:string;let membership:GraphMembershipEpoch;let service:GraphWitnessService;
 let members:Array<{identity:MachineIdentityManager;id:string;registry:ConversationRegistry;svc:AppConversationService;requests:MobileChatRequestStore;flat:MobileConversationRouteDeps;capture:ConversationGraphSourceInventoryCapture;admission:WriteAdmission}>;
 let owner:ReturnType<typeof crypto.generateKeyPairSync<'ed25519'>>,witness:ReturnType<typeof crypto.generateKeyPairSync<'ed25519'>>;
 let native:ReturnType<FencedLease['signLease']>;let stores:ConversationGraphReplication[];
 beforeEach(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-source-inventory-'));owner=crypto.generateKeyPairSync('ed25519');witness=crypto.generateKeyPairSync('ed25519');members=[];stores=[];
  for(const [index,name]of ['origin','survivor'].entries()){
   const home=path.join(dir,name),identity=new MachineIdentityManager(home),id=(await identity.generateIdentity({name})).machineId;
   let registry=new ConversationRegistry({stateDir:home,machineId:()=>id,getConfigWorkspacePin:()=> 'TOWNER'});
   registry.mintForInbound(index===0?'CALPHA':'CBETA',{label:index===0?'private origin title':'survivor title'});await registry.close();
   // Real historical local state can assign the same negative alias to different
   // canonical Slack conversations on different machines. No global alias registry.
   const snapshot=path.join(home,'state','conversation-registry.json');const raw=JSON.parse(fs.readFileSync(snapshot,'utf8'));
   for(const entry of Object.values(raw.conversations) as Array<{id:number}>)entry.id=-7;
   fs.writeFileSync(snapshot,JSON.stringify(raw));registry=new ConversationRegistry({stateDir:home,machineId:()=>id,getConfigWorkspacePin:()=> 'TOWNER'});
   const state=new StateManager(home);const adapter=new SlackAdapter({botToken:'xoxb-fixture',appToken:'xapp-fixture',authorizedUserIds:['UOWNER'],workspaceMode:'dedicated'} as never,home);
   const bridge=buildMobileSlackBridge({adapter,registry,dispatch:()=>null,killAllSessions:()=>false,sendEscape:()=>{},holdsLease:()=>true});
   const requests=new MobileChatRequestStore(home);const svc=new AppConversationService({stateDir:home,machineId:()=>id,registry,requests,holdsLease:()=>true,ownerName:()=> 'Owner',dispatch:()=>null});
   if(index===0)svc.applyCreate('device-owner',`${Date.now()}-${crypto.randomUUID()}`,APP,'private app title');
   const flat:MobileConversationRouteDeps={config:{stateDir:home} as never,pairing:null as never,service:svc,machineId:()=>id,slackConversations:()=>slackListRows(bridge),
    telegramTopics:()=>index===0?[{topicId:42,topicName:'private telegram title',lastActivity:'2026-11-05T10:00:00.000Z',lastPreview:'private transcript excluded'}]:[]};
   const admission=new WriteAdmission({thisMachineId:id,isReadOnly:()=>false,isPoolActive:()=>true,registry:buildWriteDomainRegistry({machineId:id}),dryRun:false,disableTimers:true});
   const capture=new ConversationGraphSourceInventoryCapture({agentId:'echo',identity,ownerPublicKey:owner.publicKey,membership:()=>membership,flat,registry,telegramChatId:'-100123',acceptedInventory:()=>({source:stores[index],...readerFor(stores[index])})});
   members.push({identity,id,registry,svc,requests,flat,capture,admission});
  }
  const m={v:1 as const,agentId:'echo',epoch:1,previousMembershipHash:null,writerId:members[0].id,witnessId:'independent-witness',failureDomain:'external-domain',createdAt:new Date().toISOString(),
   members:members.map(x=>({machineId:x.id,signingPublicKey:x.identity.getSigningPublicKeyPem(x.id)!,sealingPublicKey:x.identity.getEncryptionPublicKeyPem(x.id)!}))};
  membership={...m,signature:signGraphRecord('graph-membership-v1',m,owner.privateKey)};
  const now=Date.now(),fl=new FencedLease({selfMachineId:members[0].id,sign:b=>sign(b,members[0].identity.loadSigningKey()),verify:()=>false},{leaseTtlMs:60000,failoverThresholdMs:180000});
  native=fl.signLease(3,new Date(now-1000).toISOString(),new Date(now+59000).toISOString(),1);
  service=new GraphWitnessService({databasePath:path.join(dir,'witness.sqlite'),witnessId:membership.witnessId,failureDomain:membership.failureDomain,signingPrivateKey:witness.privateKey,
   enrollments:{echo:{ownerPublicKey:owner.publicKey.export({type:'spki',format:'pem'}).toString(),bearerToken:'source-inventory-test-transport-credential'}},installedFailureDomains:['origin-domain','survivor-domain']});service.registerMembership(membership);
  for(const member of members)stores.push(await ConversationGraphReplication.open(storeOptions(member)));
 });
 afterEach(async()=>{service?.close();for(const m of members??[]){m.admission.stop();await m.registry.close();}
  if(dir)SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'source-inventory-integration-cleanup'});});
 function storeOptions(member:typeof members[number]){return {installedMembership:membership,directory:path.join(member.identity.baseDir,'source'),agentId:'echo',machineId:member.id,memberPrivateKey:member.identity.loadSigningKey(),memberSealingPrivateKey:member.identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,
  witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]]),writeAdmission:member.admission,legacyReadOnly:()=>false,
  liveAdmission:()=>({admitted:true,writerId:native.holder,leaseEpoch:native.epoch,membershipEpoch:membership.epoch,fencedLeaseHash:canonicalHash(native)}),validateCore:(c:unknown)=>validateGraphSourceOperationCore(c)!==null};}
 function erasureAuthority(proof:import('../../src/core/GraphWitnessTypes.js').GraphWitnessErasure){
  const endorsement=service.erasureEndorsement('echo',proof.requestId,crypto.randomBytes(32).toString('base64url'));
  const active=service.membershipProof('echo',endorsement.membershipEpoch),activations=[];
  for(let epoch=2;epoch<=active.epoch;epoch++){const activation=service.membershipActivation('echo',epoch);if(!activation)throw new Error('actual-activation-missing');activations.push(activation);}
  return {membership:active,activations,endorsement};
 }
 function readerFor(store:ConversationGraphReplication){const index=stores.indexOf(store),current=()=>stores[index]??store;const registry=new ReplicatedKindRegistry();registerConversationGraphReplication(registry);const dropped=new DroppedOriginRegistry({stateDir:members[1].identity.baseDir});
  const reader=new ReplicatedStoreReader({registry,stores:{conversationGraph:{enabled:true}},tierOf:()=> 'high',droppedOrigins:dropped,conflictStore:new ConflictStore({stateDir:members[1].identity.baseDir}),
   listRecordKeys:()=>current().originRecords().map(r=>r.envelope.recordKey),loadOriginRecords:(_s,key)=>current().originRecords().filter(r=>r.envelope.recordKey===key)});return {reader,dropped};}
 async function certifyAll(inputs?:CapturedGraphSourceOperation[]){const prior=stores[0].recordsForRepair().sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence);let sequence=prior.at(-1)?.packet.sourceSequence??0,previous:string|null=prior.at(-1)?.packet.coreHash??null;const records:ConversationGraphReplicationRecord[]=[];
  for(const captured of inputs??members.flatMap(member=>member.capture.capturePage().observations)){
   const prepared=prepareGraphSourceOperation(captured,{agentId:'echo',identity:members[0].identity,ownerPublicKey:owner.publicKey,membership,admission:members[0].admission,
    coordinator:{holdsLease:()=>true,currentEpoch:()=>native.epoch,currentLease:()=>native}});
   const envelope=encodeGraphSourceRecoveryEnvelope({coreType:'source-observation',core:prepared.core as unknown as Record<string,unknown>,authorizationProof:prepared.authorizationProof,applicationSource:prepared.plaintextSource});
   const encryptedSourceBundle=sealGraphBundle(envelope,membership.members,{agentId:'echo',eventId:prepared.authorizationProof.receipt.eventId});envelope.fill(0);prepared.plaintextSource.fill(0);
   const controlCapsule=createGraphControlCapsule('source-observation',prepared.core as unknown as Record<string,unknown>,prepared.authorizationProof);
   const packet={controlHash:canonicalHash(controlCapsule),coreType:'source-observation' as const,erasureIdentity:deriveGraphErasureIdentity('source-observation',prepared.core),agentId:'echo',eventId:prepared.authorizationProof.receipt.eventId,idempotencyKey:prepared.idempotencyKey,coreHash:canonicalHash(prepared.core),authorizationReceiptHash:canonicalHash(prepared.authorizationProof.receipt),
    sourceSequence:++sequence,predecessorHash:previous,membershipEpoch:membership.epoch,leaseEpoch:native.epoch,writerId:members[0].id,sourceBundleHash:canonicalHash(encryptedSourceBundle)};
   const record:ConversationGraphReplicationRecord={coreType:'source-observation',packet,packetSignature:signGraphRecord('graph-operation-packet-v1',packet,members[0].identity.loadSigningKey()),core:prepared.core as unknown as Record<string,unknown>,authorizationProof:prepared.authorizationProof,encryptedSourceBundle};
   const sourceReceipts=[(await stores[0].appendLocal(record)).receipt,await stores[1].receive(record,members[0].id)];
   service.prepare({packet,controlCapsule,packetSignature:record.packetSignature,encryptedSourceBundle,lease:prepared.authorizationProof.lease,originalLease:native});
   const cert=service.commit('echo',packet.idempotencyKey,prepared.authorizationProof.lease,native,sourceReceipts);
   const acks=await Promise.all(stores.map(s=>s.attachCertificate(packet.eventId,cert)));
   for(const ack of acks)service.acknowledgeCertificate('echo',packet.idempotencyKey,ack);
   for(const store of stores)for(const ack of acks)await store.recordCertificateReceipt(packet.eventId,ack);
   previous=packet.coreHash;records.push(stores[0].repairRecord(packet.eventId)!);
  }return records;}
 async function saveOnlyOnWriterAndWitness(input?:CapturedGraphSourceOperation,sequence=1,predecessor:string|null=null,eraseBeforePrepare=false){
  const captured=input??members[0].capture.capturePage().observations.find(o=>o.capture.subject.platform==='slack')!;
  const p=prepareGraphSourceOperation(captured,{agentId:'echo',identity:members[0].identity,ownerPublicKey:owner.publicKey,membership,admission:members[0].admission,
   coordinator:{holdsLease:()=>true,currentEpoch:()=>native.epoch,currentLease:()=>native}});
  const envelope=encodeGraphSourceRecoveryEnvelope({coreType:'source-observation',core:p.core as unknown as Record<string,unknown>,authorizationProof:p.authorizationProof,applicationSource:p.plaintextSource});p.plaintextSource.fill(0);
  const encryptedSourceBundle=sealGraphBundle(envelope,membership.members,{agentId:'echo',eventId:p.authorizationProof.receipt.eventId});envelope.fill(0);
  const controlCapsule=createGraphControlCapsule('source-observation',p.core as unknown as Record<string,unknown>,p.authorizationProof);
  const packet={controlHash:canonicalHash(controlCapsule),coreType:'source-observation' as const,erasureIdentity:deriveGraphErasureIdentity('source-observation',p.core),agentId:'echo',eventId:p.authorizationProof.receipt.eventId,idempotencyKey:p.idempotencyKey,coreHash:canonicalHash(p.core),authorizationReceiptHash:canonicalHash(p.authorizationProof.receipt),
   sourceSequence:sequence,predecessorHash:predecessor,membershipEpoch:membership.epoch,leaseEpoch:native.epoch,writerId:members[0].id,sourceBundleHash:canonicalHash(encryptedSourceBundle)};
  const record:ConversationGraphReplicationRecord={coreType:'source-observation',packet,packetSignature:signGraphRecord('graph-operation-packet-v1',packet,members[0].identity.loadSigningKey()),core:p.core as unknown as Record<string,unknown>,authorizationProof:p.authorizationProof,encryptedSourceBundle};
  await stores[0].appendLocal(record);if(eraseBeforePrepare){const fields={requestId:'erase-before-peer',target:packet.erasureIdentity,bundleHashes:[],authorizationReceiptHash:canonicalHash({owner:'erase-before-peer'})};service.erase('echo',fields.requestId,fields.target,[],fields.authorizationReceiptHash,p.authorizationProof.lease,native,signGraphRecord('graph-witness-action-v1',witnessActionPayload('erase',fields,p.authorizationProof.lease),members[0].identity.loadSigningKey()));service.admitErasedControl({packet,controlCapsule,packetSignature:record.packetSignature,lease:p.authorizationProof.lease,originalLease:native});}else service.prepare({packet,controlCapsule,packetSignature:record.packetSignature,encryptedSourceBundle,lease:p.authorizationProof.lease,originalLease:native});
  return packet.idempotencyKey; // no original record/control escapes this scope
 }
 function deferredOriginalControl(predecessor:string){
  const captured=members[0].capture.capturePage().observations.find(c=>c.capture.subject.platform==='app')!,p=prepareGraphSourceOperation(captured,{agentId:'echo',identity:members[0].identity,ownerPublicKey:owner.publicKey,membership,admission:members[0].admission,coordinator:{holdsLease:()=>true,currentEpoch:()=>native.epoch,currentLease:()=>native}});
  const capsule=createGraphControlCapsule(p.coreType,p.core as unknown as Record<string,unknown>,p.authorizationProof),envelope=encodeGraphSourceRecoveryEnvelope({coreType:p.coreType,core:p.core as unknown as Record<string,unknown>,authorizationProof:p.authorizationProof,applicationSource:p.plaintextSource});p.plaintextSource.fill(0);const encrypted=sealGraphBundle(envelope,membership.members,{agentId:'echo',eventId:p.authorizationProof.receipt.eventId});envelope.fill(0);
  const packet={coreType:p.coreType,controlHash:canonicalHash(capsule),erasureIdentity:deriveGraphErasureIdentity(p.coreType,p.core),agentId:'echo',eventId:p.authorizationProof.receipt.eventId,idempotencyKey:p.idempotencyKey,coreHash:canonicalHash(p.core),authorizationReceiptHash:canonicalHash(p.authorizationProof.receipt),sourceSequence:2,predecessorHash:predecessor,membershipEpoch:membership.epoch,leaseEpoch:native.epoch,writerId:members[0].id,sourceBundleHash:canonicalHash(encrypted)};
  return {packet,controlCapsule:capsule,packetSignature:signGraphRecord('graph-operation-packet-v1',packet,members[0].identity.loadSigningKey())};
 }
 async function certifySurvivorAfterErasedPrefix(previous:ConversationGraphReplicationRecord){
  const member=members[1],captured=member.capture.capturePage().observations[0];expect(captured).toBeDefined();
  const p=prepareGraphSourceOperation(captured,{agentId:'echo',identity:member.identity,ownerPublicKey:owner.publicKey,membership,admission:member.admission,coordinator:{holdsLease:()=>true,currentEpoch:()=>native.epoch,currentLease:()=>native}});
  const capsule=createGraphControlCapsule(p.coreType,p.core as unknown as Record<string,unknown>,p.authorizationProof),envelope=encodeGraphSourceRecoveryEnvelope({coreType:p.coreType,core:p.core as unknown as Record<string,unknown>,authorizationProof:p.authorizationProof,applicationSource:p.plaintextSource});p.plaintextSource.fill(0);
  const encryptedSourceBundle=sealGraphBundle(envelope,membership.members,{agentId:'echo',eventId:p.authorizationProof.receipt.eventId});envelope.fill(0);
  const packet={coreType:p.coreType,controlHash:canonicalHash(capsule),erasureIdentity:deriveGraphErasureIdentity(p.coreType,p.core),agentId:'echo',eventId:p.authorizationProof.receipt.eventId,idempotencyKey:p.idempotencyKey,coreHash:canonicalHash(p.core),authorizationReceiptHash:canonicalHash(p.authorizationProof.receipt),sourceSequence:2,predecessorHash:previous.packet.coreHash,membershipEpoch:membership.epoch,leaseEpoch:native.epoch,writerId:member.id,sourceBundleHash:canonicalHash(encryptedSourceBundle)};
  const record:ConversationGraphReplicationRecord={coreType:p.coreType,packet,packetSignature:signGraphRecord('graph-operation-packet-v1',packet,member.identity.loadSigningKey()),core:p.core as unknown as Record<string,unknown>,authorizationProof:p.authorizationProof,encryptedSourceBundle};
  const saved=await stores[1].appendLocal(record);expect(saved.receipt.phase).toBe('source');service.prepare({packet,packetSignature:record.packetSignature,controlCapsule:capsule,encryptedSourceBundle,lease:p.authorizationProof.lease,originalLease:native});const cert=service.commit('echo',packet.idempotencyKey,p.authorizationProof.lease,native,[saved.receipt]);const ack=await stores[1].attachCertificate(packet.eventId,cert);await stores[1].recordCertificateReceipt(packet.eventId,ack);service.acknowledgeCertificate('echo',packet.idempotencyKey,ack);const delivery=stores[1].commitProofDeliveryReceipt(packet.eventId);await stores[1].recordCommitProofDeliveryReceipt(packet.eventId,delivery);
  expect(stores[1].mayAcknowledgeNewWrite(packet.eventId,{lease:p.authorizationProof.lease,originalLease:native})).toBe(true);expect(service.recoveryManifest('echo').highestCertifiedSequence).toBe(2);
 }
 function actuationForSurvivor(target:GraphMembershipEpoch,epoch=4){
  const now=Date.now(),b=members[1];const fl=new FencedLease({selfMachineId:b.id,sign:bytes=>sign(bytes,b.identity.loadSigningKey()),verify:()=>false},{leaseTtlMs:60000,failoverThresholdMs:180000});
  native=fl.signLease(epoch,new Date(now-1000).toISOString(),new Date(now+59000).toISOString(),epoch);
  const body={v:1 as const,agentId:'echo',membershipEpoch:target.epoch,leaseEpoch:epoch,writerId:b.id,issuedAt:native.acquiredAt,expiresAt:native.expiresAt,fencedLeaseHash:canonicalHash(native)};
  return {membership:target,lease:{...body,signature:signGraphRecord('graph-lease-v1',body,b.identity.loadSigningKey())},originalLease:native};
 }
 function coldRecordFromWitness(requestKey:string){
  const remote=service.recover('echo',requestKey);
  const cold=reconstructGraphSourceRecord({packet:remote.operation.packet,controlCapsule:remote.operation.controlCapsule,packetSignature:remote.operation.packetSignature,encryptedSourceBundle:remote.encryptedSourceBundle,
   originalMembership:service.membershipProof('echo',remote.operation.packet.membershipEpoch),...(remote.operation.prepareProof?{preparationProof:remote.operation.prepareProof}:{}),...(remote.operation.erasedControlProof?{erasedControlProof:remote.operation.erasedControlProof}:{}),...(remote.operation.erasure?{erasure:remote.operation.erasure}:{})},
   {machineId:members[1].id,sealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  cold.applicationSource.fill(0);return cold.record;
 }
 function recoveryForSurvivor(current:ReturnType<typeof actuationForSurvivor>){
  const {reader,dropped}=readerFor(stores[1]);return new GraphSourceObservationRecoveryCoordinator({source:stores[1],reader,dropped,stateDir:members[1].identity.baseDir,machineId:members[1].id,
   signingPrivateKey:members[1].identity.loadSigningKey(),ownerPublicKey:owner.publicKey,writeAdmission:members[1].admission,legacyReadOnly:()=>false,
   liveAdmission:()=>({admitted:true,writerId:members[1].id,leaseEpoch:current.lease.leaseEpoch,membershipEpoch:current.membership.epoch,fencedLeaseHash:canonicalHash(native)}),actuation:()=>current});
 }
 it('requires actual all-producer certified sweep checkpoints, not row certification alone',async()=>{
  await certifyAll();const {reader,dropped}=readerFor(stores[1]);
  expect(materializeGraphSourceInventory({source:stores[1],reader,dropped,membership}).coverage.missingProducerIds).toHaveLength(2);
  for(const member of members){const scan=new ConversationGraphSourceSweepCapture({agentId:'echo',identity:member.identity,ownerPublicKey:owner.publicKey,membership:()=>membership,flat:member.flat,registry:member.registry,telegramChatId:'-100123',source:stores[1],reader,dropped}).capture();
   await certifyAll([scan.checkpoint]);
  }
  const inventory=materializeGraphSourceInventory({source:stores[1],reader,dropped,membership});
  expect(inventory.coverage.missingProducerIds).toEqual([]);expect(inventory.coverage.partialProducerIds).toEqual([]);expect(inventory.coverage.missingObservationIds).toEqual([]);expect(inventory.partial).toBe(false);
  expect(inventory.entries.filter(e=>e.ref.platform==='slack').map(e=>e.row.id)).toEqual([-7,-7]);
  expect(inventory.coverage.asOf).not.toBeNull();const stale=reconcileGraphSourceCoverage({source:stores[1],reader,dropped,membership,now:()=>Date.now()+GRAPH_SOURCE_SWEEP_STALE_MS+1});expect(stale.staleProducerIds).toHaveLength(2);expect(stale.asOf).toBe(inventory.coverage.asOf);
 });
 it('physically purges offline local capture versions before any witness erasure acknowledgement',async()=>{
  const member=members[0],page=member.capture.capturePage(),captured=page.observations.find(o=>o.capture.subject.platform==='slack')!;
  const target={sourceKind:'conversation-metadata' as const,sourceId:canonicalHash(captured.capture.subject)},fence=new ConversationGraphLocalErasureFence(member.identity.baseDir);
  await fence.deny(target);expect(()=>assertGraphSourceObservationCachePurged({stateDir:member.identity.baseDir,agentId:'echo',target,fence})).toThrow('body-retained');const purged=purgeLocallyDeniedGraphSourceObservationCache({stateDir:member.identity.baseDir,agentId:'echo',target,fence});expect(purged.removed).toBeGreaterThan(0);expect(assertGraphSourceObservationCachePurged({stateDir:member.identity.baseDir,agentId:'echo',target,fence})).toMatch(/^[a-f0-9]{64}$/);
  const alias=path.join(member.identity.baseDir,'state','conversation-graph-source-observations','leftover-hardlink-variant');fs.writeFileSync(alias,JSON.stringify(captured));const hardlink=alias+'-second-link';fs.linkSync(alias,hardlink);expect(()=>assertGraphSourceObservationCachePurged({stateDir:member.identity.baseDir,agentId:'echo',target,fence})).toThrow('body-retained');SafeFsExecutor.safeUnlinkSync(alias,{operation:'source-inventory-test-remove-retained-alias'});expect(()=>assertGraphSourceObservationCachePurged({stateDir:member.identity.baseDir,agentId:'echo',target,fence})).toThrow('body-retained');expect(purgeLocallyDeniedGraphSourceObservationCache({stateDir:member.identity.baseDir,agentId:'echo',target,fence}).removed).toBe(1);expect(fs.existsSync(hardlink)).toBe(false);expect(assertGraphSourceObservationCachePurged({stateDir:member.identity.baseDir,agentId:'echo',target,fence})).toMatch(/^[a-f0-9]{64}$/);
  const fresh=new ConversationGraphSourceInventoryCapture({agentId:'echo',identity:member.identity,ownerPublicKey:owner.publicKey,membership:()=>membership,flat:member.flat,registry:member.registry,telegramChatId:'-100123',localErasure:fence,acceptedInventory:()=>({source:stores[0],...readerFor(stores[0])})});
  expect(fresh.capturePage().observations.some(o=>canonicalHash(o.capture.subject)===target.sourceId)).toBe(false);
  expect(()=>prepareGraphSourceObservation(captured,{agentId:'echo',identity:member.identity,ownerPublicKey:owner.publicKey,membership,admission:member.admission,localErasure:fence,coordinator:{holdsLease:()=>true,currentEpoch:()=>native.epoch,currentLease:()=>native}})).toThrow('erased');
 });
 it('revalidates a pending producer checkpoint from witness ciphertext against actual certified row dependencies',async()=>{
  const records=await certifyAll(),{reader,dropped}=readerFor(stores[1]),member=members[0];
  const scan=new ConversationGraphSourceSweepCapture({agentId:'echo',identity:member.identity,ownerPublicKey:owner.publicKey,membership:()=>membership,flat:member.flat,registry:member.registry,telegramChatId:'-100123',source:stores[1],reader,dropped}).capture();
  const key=await saveOnlyOnWriterAndWitness(scan.checkpoint,records.length+1,records.at(-1)!.packet.coreHash),record=coldRecordFromWitness(key);await stores[1].receive(record,record.packet.writerId);
  const checked=recoveryForSurvivor(actuationForSurvivor(membership)).revalidate(record.packet.eventId);expect(checked).toMatchObject({state:'validated',proof:{decision:'adopt',reason:'ok'}});
  if(checked.state==='validated')expect(checked.rewrap).not.toBeNull();
 });
 it.each(['erased','superseded'] as const)('refuses pending checkpoint after an actual referenced row is %s',async(mode)=>{
  const records=await certifyAll(),member=members[0],{reader,dropped}=readerFor(stores[1]);const scan=new ConversationGraphSourceSweepCapture({agentId:'echo',identity:member.identity,ownerPublicKey:owner.publicKey,membership:()=>membership,flat:member.flat,registry:member.registry,telegramChatId:'-100123',source:stores[1],reader,dropped}).capture();
  const original=records.find(r=>(r.core.subject as {platform?:string})?.platform==='app')!;
  if(mode==='erased'){const fields={requestId:'erase-sweep-row',target:original.packet.erasureIdentity,bundleHashes:[original.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({owner:'forget'})},proof=original.authorizationProof;
   const signature=signGraphRecord('graph-witness-action-v1',witnessActionPayload('erase',fields,proof.lease),member.identity.loadSigningKey());const erasure=service.erase('echo',fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,proof.lease,native,signature);for(const store of stores)await store.eraseBundle(original.packet.eventId,erasure,erasureAuthority(erasure));
  }else{member.svc.applyRename('owner-device',`${Date.now()}-${crypto.randomUUID()}`,APP,'changed after inventory scan');const changed=member.capture.capturePage().observations.find(c=>c.capture.subject.platform==='app')!;await certifyAll([changed]);}
  const prior=stores[0].recordsForRepair().sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence).at(-1)!;
  const key=await saveOnlyOnWriterAndWitness(scan.checkpoint,prior.packet.sourceSequence+1,prior.packet.coreHash),record=coldRecordFromWitness(key);await stores[1].receive(record,record.packet.writerId);
  const checked=recoveryForSurvivor(actuationForSurvivor(membership)).revalidate(record.packet.eventId);expect(checked).toMatchObject({state:'validated',proof:{decision:'refuse',reason:mode==='erased'?'erased-source':'stale-heads'},rewrap:null});
 });
 it('refuses a delayed valid old capture and advances beyond restored producer cache/ledger backups',async()=>{
  const member=members[0],old=member.capture.capturePage().observations.find(c=>c.capture.subject.platform==='app')!;
  const snapshots=['conversation-graph-source-observations','conversation-graph-source-observation-sequences'].flatMap(name=>{const directory=path.join(member.identity.baseDir,'state',name);return fs.readdirSync(directory).map(name=>{const file=path.join(directory,name);return {file,bytes:fs.readFileSync(file)};});});
  expect(member.capture.capturePage().observations.find(c=>c.capture.subject.platform==='app')!.capture).toEqual(old.capture);await certifyAll();
  member.svc.applyRename('owner-device',`${Date.now()}-${crypto.randomUUID()}`,APP,'causally newer title');const newer=member.capture.capturePage().observations.find(c=>c.capture.subject.platform==='app')!;expect(newer.capture.producerSequence).toBe(old.capture.producerSequence+1);await certifyAll([newer]);
  const {reader,dropped}=readerFor(stores[0]);expect(verifyGraphSourceObservationCapture(old.capture,membership)).toBe(true);
  expect(()=>assertGraphSourceObservationAdmission(old.capture,{source:stores[0],reader,dropped})).toThrow('source-causal-stale');
  expect(()=>assertGraphSourceObservationAdmission({...old.capture,producerSequence:newer.capture.producerSequence},{source:stores[0],reader,dropped})).toThrow('source-causal-equivocation');
  for(const saved of snapshots)fs.writeFileSync(saved.file,saved.bytes);
  const restored=member.capture.capturePage().observations.find(c=>c.capture.subject.platform==='app')!;expect(restored.capture.producerSequence).toBe(newer.capture.producerSequence+1);expect(restored.capture.sourceId).not.toBe(old.capture.sourceId);
 });
 it('captures real rows, keeps display bytes sealed, and reuses unchanged source observations',()=>{
  const page=members[0].capture.capturePage(),again=members[0].capture.capturePage();expect(page.partial).toBe(false);expect(page.observations.length).toBe(3);expect(again).toEqual(page);
  for(const value of page.observations){expect(verifyGraphSourceObservationCapture(value.capture,membership)).toBe(true);expect(JSON.stringify(value.capture)).not.toContain('private');
   const plain=openGraphBundle(value.encryptedPayload,members[0].id,members[0].identity.loadEncryptionKey(),{agentId:'echo',eventId:sourceObservationEventId(value.capture.sourceId)});
   const body=JSON.parse(plain.toString());expect(validateGraphSourceObservationPayload(body,value.capture)).not.toBeNull();expect(body.row).not.toHaveProperty('lastPreview');plain.fill(0);}
  const files=fs.readdirSync(path.join(members[0].identity.baseDir,'state','conversation-graph-source-observations'));
  for(const file of files)expect(fs.readFileSync(path.join(members[0].identity.baseDir,'state','conversation-graph-source-observations',file),'utf8')).not.toContain('private');
 });
 it('adds no source record for a new message, and a rename still adds one',()=>{
  const member=members[0],flat=member.flat,base=flat.telegramTopics,first=member.capture.capturePage();
  try{
   flat.telegramTopics=()=>base!().map(topic=>({...topic,lastActivity:'2026-11-05T10:05:00.000Z'}));
   expect(member.capture.capturePage().observations.map(row=>row.capture.sourceId)).toEqual(first.observations.map(row=>row.capture.sourceId));
   flat.telegramTopics=()=>base!().map(topic=>({...topic,topicName:'renamed telegram title'}));
   const renamed=member.capture.capturePage().observations.map(row=>row.capture.sourceId);
   expect(renamed.filter(id=>!first.observations.some(row=>row.capture.sourceId===id))).toHaveLength(1);
  }finally{flat.telegramTopics=base;}
 });
 it('reconstructs all exact aliases on survivor after origin loss without consulting origin registry',async()=>{
  const expected=members.flatMap(m=>localConversationListPage(m.flat,100,null).rows.map(({id,platform,title,lastActivity,machine})=>({id,platform,title,lastActivity,...(machine===undefined?{}:{machine})})));
  const records=await certifyAll();expect(records).toHaveLength(4);
  // Origin is unavailable: only the survivor source directory + sealing key are read.
  const survivor=await ConversationGraphReplication.open(storeOptions(members[1]));const {reader,dropped}=readerFor(survivor);
  const result=materializeGraphSourceInventory({source:survivor,reader,dropped});
  expect(result.partial).toBe(true);expect(result.coverage.membershipHash).toBeNull();expect(result.entries.map(e=>e.row).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))).toEqual(expected.sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b))));
  const slack=result.entries.filter(e=>e.row.platform==='slack');expect(slack).toHaveLength(2);expect(slack.map(e=>e.row.id)).toEqual([-7,-7]);
  expect(new Set(slack.map(e=>e.row.machine))).toEqual(new Set(members.map(m=>m.id)));expect(new Set(slack.map(e=>e.ref.platform==='slack'?e.ref.channelId:''))).toEqual(new Set(['CALPHA','CBETA']));
  expect(result.conversations.find(c=>c.ref.platform==='app')?.conversationId).toBe(APP);expect(result.conversations.find(c=>c.ref.platform==='telegram')?.conversationId).toBe(42);
 });
 it('reports an app conversation and a Telegram topic held by both machines as one available conversation each',async()=>{
  // App conversations replicate to every machine; every machine with a Telegram adapter lists the topics.
  members[1].svc.applyCreate('device-owner',`${Date.now()}-${crypto.randomUUID()}`,APP,'private app title');
  members[1].flat.telegramTopics=()=>[{topicId:42,topicName:'renamed telegram title',lastActivity:'2026-11-05T11:00:00.000Z',lastPreview:null}];
  await certifyAll();const {reader,dropped}=readerFor(stores[1]);
  const result=materializeGraphSourceInventory({source:stores[1],reader,dropped});
  for(const platform of ['app','telegram'] as const){
   expect(new Set(result.entries.filter(e=>e.ref.platform===platform).map(e=>e.producerMachineId))).toEqual(new Set(members.map(m=>m.id)));
   expect(result.conversations.filter(c=>c.ref.platform===platform)).toHaveLength(1);
   expect(result.unavailableConversations.filter(r=>r.platform===platform)).toEqual([]);
  }
  expect(result.conversations.find(c=>c.ref.platform==='telegram')).toMatchObject({conversationId:42,title:'renamed telegram title',lastActivity:'2026-11-05T11:00:00.000Z'});
  // Two machines' Slack conversations share the alias -7 and stay two separate conversations.
  expect(result.conversations.filter(c=>c.ref.platform==='slack').map(c=>[c.conversationId,c.machine]).sort()).toEqual(members.map(m=>[-7,m.id]).sort());
 });
 it('blocks undecryptable source boot and rejects forged capture or extra plaintext core',async()=>{
  const captured=members[0].capture.capturePage().observations[0];expect(verifyGraphSourceObservationCapture({...captured.capture,producerMachineId:members[1].id},membership)).toBe(false);
  const p=prepareGraphSourceOperation(captured,{agentId:'echo',identity:members[0].identity,ownerPublicKey:owner.publicKey,membership,admission:members[0].admission,coordinator:{holdsLease:()=>true,currentEpoch:()=>native.epoch,currentLease:()=>native}});
  expect(validateGraphSourceObservationCore({...p.core,title:'forbidden plaintext'})).toBeNull();p.plaintextSource.fill(0);
  await certifyAll();
  // The central source checks its actual member key on boot. A wrong key must
  // prevent source admission entirely, rather than create a readable facade.
  await expect(ConversationGraphReplication.open({...storeOptions(members[1]),memberSealingPrivateKey:crypto.generateKeyPairSync('x25519').privateKey})).rejects.toThrow();
 });
 it('purges sealed observation caches and prevents forgotten flat-row headers from being captured again',async()=>{
  const records=await certifyAll();const record=records.find(r=>r.core.subject&&((r.core.subject as {platform?:string;channelId?:string}).channelId==='CALPHA'))!;
  const proof=record.authorizationProof;const fields={requestId:'erase-origin-slack',target:record.packet.erasureIdentity,bundleHashes:[record.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({owner:'source-erasure'})};
  const signature=signGraphRecord('graph-witness-action-v1',witnessActionPayload('erase',fields,proof.lease),members[0].identity.loadSigningKey());
  const erasure=service.erase('echo',fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,proof.lease,native,signature);
  for(let i=0;i<stores.length;i++){
   await stores[i].eraseBundle(record.packet.eventId,erasure,erasureAuthority(erasure));
   expect(members[i].capture.purgeErasedObservation(stores[i].repairRecord(record.packet.eventId)!,stores[i]).fenced).toBe(true);
  }
  const repeated=members[0].capture.capturePage();expect(repeated.partial).toBe(true);
  expect(repeated.observations.some(c=>c.capture.subject.platform==='slack'&&c.capture.subject.channelId==='CALPHA')).toBe(false);
  const {reader,dropped}=readerFor(stores[1]);const inventory=materializeGraphSourceInventory({source:stores[1],reader,dropped});
  expect(inventory.entries).toHaveLength(3);expect(inventory.entries.some(e=>e.ref.platform==='slack'&&e.ref.channelId==='CALPHA')).toBe(false);
 });
 it('refuses a durable source receipt when valid ciphertext contains a changed alias rather than the producer-signed payload',async()=>{
  const captured=members[0].capture.capturePage().observations.find(o=>o.capture.subject.platform==='slack')!;
  const p=prepareGraphSourceOperation(captured,{agentId:'echo',identity:members[0].identity,ownerPublicKey:owner.publicKey,membership,admission:members[0].admission,coordinator:{holdsLease:()=>true,currentEpoch:()=>native.epoch,currentLease:()=>native}});
  const body=JSON.parse(p.plaintextSource.toString());p.plaintextSource.fill(0);body.payload.row.id=-8;
  const envelope=encodeGraphSourceEnvelope('source-observation',p.core as unknown as Record<string,unknown>,p.authorizationProof,Buffer.from(JSON.stringify(body)));
  const encryptedSourceBundle=sealGraphBundle(envelope,membership.members,{agentId:'echo',eventId:p.authorizationProof.receipt.eventId});envelope.fill(0);
  const controlCapsule=createGraphControlCapsule('source-observation',p.core as unknown as Record<string,unknown>,p.authorizationProof);
  const packet={controlHash:canonicalHash(controlCapsule),coreType:'source-observation' as const,erasureIdentity:deriveGraphErasureIdentity('source-observation',p.core),agentId:'echo',eventId:p.authorizationProof.receipt.eventId,idempotencyKey:p.idempotencyKey,coreHash:canonicalHash(p.core),authorizationReceiptHash:canonicalHash(p.authorizationProof.receipt),
   sourceSequence:1,predecessorHash:null,membershipEpoch:membership.epoch,leaseEpoch:native.epoch,writerId:members[0].id,sourceBundleHash:canonicalHash(encryptedSourceBundle)};
  const record:ConversationGraphReplicationRecord={coreType:'source-observation',packet,packetSignature:signGraphRecord('graph-operation-packet-v1',packet,members[0].identity.loadSigningKey()),core:p.core as unknown as Record<string,unknown>,authorizationProof:p.authorizationProof,encryptedSourceBundle};
  await expect(stores[0].appendLocal(record)).rejects.toThrow(/application-source-invalid|observation-source-invalid|recovery-application-invalid/);
  expect(stores[0].repairRecord(packet.eventId)).toBeNull();
 });
 it('recovers a pending observation only from witness bytes, revalidates after explicit producer decommission and certifies on every new member',async()=>{
  const requestKey=await saveOnlyOnWriterAndWitness();const oldMembership=membership;
  members[0].svc.store.close();await members[0].registry.close();members[0].admission.stop();
  SafeFsExecutor.safeRmSync(members[0].identity.baseDir,{recursive:true,force:true,operation:'source-observation-test-origin-permanently-lost'});
  stores[0]=undefined as never;
  const remote=service.recover('echo',requestKey);const cold=reconstructGraphSourceRecord({packet:remote.operation.packet,controlCapsule:remote.operation.controlCapsule,packetSignature:remote.operation.packetSignature,encryptedSourceBundle:remote.encryptedSourceBundle,
   originalMembership:oldMembership,...(remote.operation.prepareProof?{preparationProof:remote.operation.prepareProof}:{}),...(remote.operation.erasedControlProof?{erasedControlProof:remote.operation.erasedControlProof}:{}),...(remote.operation.erasure?{erasure:remote.operation.erasure}:{})},{machineId:members[1].id,sealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  cold.applicationSource.fill(0);if(cold.record.erasure)await stores[1].applyErasure(cold.record.erasure,erasureAuthority(cold.record.erasure));await stores[1].receive(cold.record,cold.record.packet.writerId);
  const frozenPacket=canonicalJson(cold.record.packet),frozenAuthorization=canonicalJson(cold.record.authorizationProof);
  const {signature:_oldSignature,...old}=oldMembership;const nextBody={...old,epoch:2,previousMembershipHash:canonicalHash(oldMembership),writerId:members[1].id,members:[oldMembership.members[1]]};
  const next={...nextBody,signature:signGraphRecord('graph-membership-v1',nextBody,owner.privateKey)};const current=actuationForSurvivor(next);
  const {reader,dropped}=readerFor(stores[1]);let helper=new GraphSourceObservationRecoveryCoordinator({source:stores[1],reader,dropped,stateDir:members[1].identity.baseDir,machineId:members[1].id,
   signingPrivateKey:members[1].identity.loadSigningKey(),ownerPublicKey:owner.publicKey,writeAdmission:members[1].admission,legacyReadOnly:()=>false,
   liveAdmission:()=>({admitted:true,writerId:members[1].id,leaseEpoch:4,membershipEpoch:2,fencedLeaseHash:canonicalHash(native)}),actuation:()=>current});
  const checked=helper.revalidate(cold.record.packet.eventId);expect(checked.state).toBe('validated');if(checked.state!=='validated'||!checked.rewrap)throw new Error(JSON.stringify(checked));
  expect(checked.proof.decision).toBe('adopt');
  const manifest=buildGraphRecoverySourceManifest([cold.record],oldMembership);expect(manifest).toEqual(service.recoveryManifest('echo'));
  const inventory=buildGraphTransferRewrapInventory([cold.record],[{eventId:cold.record.packet.eventId,rewrap:checked.rewrap}]);
  const auth={v:1 as const,agentId:'echo',recoveryId:'decommission-lost-producer',previousMembershipHash:canonicalHash(oldMembership),newMembershipHash:canonicalHash(next),previousWitnessId:oldMembership.witnessId,newWitnessId:next.witnessId,
   fenceEpoch:4,highestCertifiedSequence:0,highestCertifiedCoreHash:null,pendingOutcomes:[{idempotencyKey:requestKey,operationHash:canonicalHash(cold.record.packet),decision:'adopt' as const,revalidationHash:canonicalHash(checked.proof)}],
   sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash(inventory),issuedAt:new Date().toISOString()};
  const authorization={...auth,signature:signGraphRecord('graph-recovery-authorization-v1',auth,owner.privateKey)};
  const stage={authorization,previousMembership:oldMembership,newMembership:next,currentLease:current.lease,originalCurrentLease:native,manifest,records:[cold.record],revalidations:[checked.proof],rewraps:[{eventId:cold.record.packet.eventId,rewrap:checked.rewrap}]};
  const transfer=new ConversationGraphReplicationTransfer({directory:path.join(members[1].identity.baseDir,'staged-transfer'),machineId:members[1].id,memberPrivateKey:members[1].identity.loadSigningKey(),memberSealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,verification:stores[1],witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  const transferReceipt=await transfer.stage(stage);
  const activated=service.recoverPending('echo',{newMembership:next,authorization,currentLease:current.lease,originalCurrentLease:native,revalidations:[{proof:checked.proof,rewrap:checked.rewrap}],stateTransferReceipts:[transferReceipt],sourceManifest:manifest});
  membership=next;stores[1]=await ConversationGraphReplication.open(storeOptions(members[1]));helper=recoveryForSurvivor(current);const adopted={...cold.record,adoption:activated.adoptions[0],rewrap:checked.rewrap};
  const receipt=await stores[1].receive(adopted,adopted.packet.writerId);const certificate=service.commit('echo',requestKey,current.lease,native,[receipt]);
  const ack=await stores[1].attachCertificate(adopted.packet.eventId,certificate);await stores[1].recordCertificateReceipt(adopted.packet.eventId,ack);service.acknowledgeCertificate('echo',requestKey,ack);
  const delivery=stores[1].commitProofDeliveryReceipt(adopted.packet.eventId);await stores[1].recordCommitProofDeliveryReceipt(adopted.packet.eventId,delivery);
  expect(stores[1].mayAcknowledgeNewWrite(adopted.packet.eventId,{lease:current.lease,originalLease:native})).toBe(true);
  expect(canonicalJson(stores[1].repairRecord(adopted.packet.eventId)!.packet)).toBe(frozenPacket);expect(canonicalJson(stores[1].repairRecord(adopted.packet.eventId)!.authorizationProof)).toBe(frozenAuthorization);
  const result=materializeGraphSourceInventory({source:stores[1],reader,dropped});expect(result.entries).toHaveLength(1);
  expect(result.entries[0].row).toMatchObject({platform:'slack',id:-7,machine:oldMembership.members[0].machineId,title:'#private origin title'});
  expect(result.entries[0].ref).toEqual({kind:'conversation',platform:'slack',channelId:'CALPHA'});
 });
 it('recovers never-Saved erased control only from W after writer destruction and certifies current-member cancellation',async()=>{
  const requestKey=await saveOnlyOnWriterAndWitness(undefined,1,null,true);const oldMembership=membership;
  members[0].svc.store.close();await members[0].registry.close();members[0].admission.stop();
  SafeFsExecutor.safeRmSync(members[0].identity.baseDir,{recursive:true,force:true,operation:'source-observation-test-origin-permanently-lost'});
  stores[0]=undefined as never;
  const remote=service.recover('echo',requestKey);const cold=reconstructGraphSourceRecord({packet:remote.operation.packet,controlCapsule:remote.operation.controlCapsule,packetSignature:remote.operation.packetSignature,encryptedSourceBundle:remote.encryptedSourceBundle,
   originalMembership:oldMembership,...(remote.operation.prepareProof?{preparationProof:remote.operation.prepareProof}:{}),...(remote.operation.erasedControlProof?{erasedControlProof:remote.operation.erasedControlProof}:{}),...(remote.operation.erasure?{erasure:remote.operation.erasure}:{})},{machineId:members[1].id,sealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  cold.applicationSource.fill(0);if(cold.record.erasure)await stores[1].applyErasure(cold.record.erasure,erasureAuthority(cold.record.erasure));await stores[1].receive(cold.record,cold.record.packet.writerId);
  const frozenPacket=canonicalJson(cold.record.packet),frozenAuthorization=canonicalJson(cold.record.authorizationProof);
  const {signature:_oldSignature,...old}=oldMembership;const nextBody={...old,epoch:2,previousMembershipHash:canonicalHash(oldMembership),writerId:members[1].id,members:[oldMembership.members[1]]};
  const next={...nextBody,signature:signGraphRecord('graph-membership-v1',nextBody,owner.privateKey)};const current=actuationForSurvivor(next);
  const {reader,dropped}=readerFor(stores[1]);let helper=new GraphSourceObservationRecoveryCoordinator({source:stores[1],reader,dropped,stateDir:members[1].identity.baseDir,machineId:members[1].id,
   signingPrivateKey:members[1].identity.loadSigningKey(),ownerPublicKey:owner.publicKey,writeAdmission:members[1].admission,legacyReadOnly:()=>false,
   liveAdmission:()=>({admitted:true,writerId:members[1].id,leaseEpoch:4,membershipEpoch:2,fencedLeaseHash:canonicalHash(native)}),actuation:()=>current});
  const checked=helper.revalidate(cold.record.packet.eventId);expect(checked.state).toBe('validated');if(checked.state!=='validated')throw new Error(JSON.stringify(checked));
  expect(checked.proof.decision).toBe('refuse');expect(checked.proof.reason).toBe('erased-source');expect(checked.rewrap).toBeNull();expect(cold.record.preparationProof).toBeUndefined();expect(cold.record.erasedControlProof).toBeDefined();
  const manifest=buildGraphRecoverySourceManifest([cold.record],oldMembership);expect(manifest).toEqual(service.recoveryManifest('echo'));
  const inventory=buildGraphTransferRewrapInventory([cold.record],[{eventId:cold.record.packet.eventId,rewrap:checked.rewrap}]);
  const auth={v:1 as const,agentId:'echo',recoveryId:'decommission-lost-producer',previousMembershipHash:canonicalHash(oldMembership),newMembershipHash:canonicalHash(next),previousWitnessId:oldMembership.witnessId,newWitnessId:next.witnessId,
   fenceEpoch:4,highestCertifiedSequence:0,highestCertifiedCoreHash:null,pendingOutcomes:[{idempotencyKey:requestKey,operationHash:canonicalHash(cold.record.packet),decision:'refuse' as const,revalidationHash:canonicalHash(checked.proof)}],
   sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash(inventory),issuedAt:new Date().toISOString()};
  const authorization={...auth,signature:signGraphRecord('graph-recovery-authorization-v1',auth,owner.privateKey)};
  const stage={authorization,previousMembership:oldMembership,newMembership:next,currentLease:current.lease,originalCurrentLease:native,manifest,records:[cold.record],revalidations:[checked.proof],rewraps:[]};
  const transfer=new ConversationGraphReplicationTransfer({directory:path.join(members[1].identity.baseDir,'staged-transfer'),machineId:members[1].id,memberPrivateKey:members[1].identity.loadSigningKey(),memberSealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,verification:stores[1],witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  const transferReceipt=await transfer.stage(stage);
  const activated=service.recoverPending('echo',{newMembership:next,authorization,currentLease:current.lease,originalCurrentLease:native,revalidations:[{proof:checked.proof,rewrap:checked.rewrap}],stateTransferReceipts:[transferReceipt],sourceManifest:manifest});
  membership=next;stores[1]=await ConversationGraphReplication.open(storeOptions(members[1]));helper=recoveryForSurvivor(current);const adopted={...cold.record,adoption:activated.adoptions[0],rewrap:checked.rewrap};
  const receipt=await stores[1].receive(adopted,adopted.packet.writerId);expect(receipt.phase).toBe('cancellation');expect(receipt.membershipEpoch).toBe(2);expect(receipt.leaseEpoch).toBe(4);const certificate=service.certifyCancellation('echo',requestKey,current.lease,native,[receipt]);
  const ack=await stores[1].attachCancellationCertificate(adopted.packet.eventId,certificate);await stores[1].recordCertificateReceipt(adopted.packet.eventId,ack);service.acknowledgeCertificate('echo',requestKey,ack);
  const delivery=stores[1].commitProofDeliveryReceipt(adopted.packet.eventId);await stores[1].recordCommitProofDeliveryReceipt(adopted.packet.eventId,delivery);
  expect(stores[1].mayAcknowledgeNewWrite(adopted.packet.eventId,{lease:current.lease,originalLease:native})).toBe(false);expect(service.recoveryManifest('echo').highestCertifiedSequence).toBe(1);
  expect(canonicalJson(stores[1].repairRecord(adopted.packet.eventId)!.packet)).toBe(frozenPacket);expect(canonicalJson(stores[1].repairRecord(adopted.packet.eventId)!.authorizationProof)).toBe(frozenAuthorization);
  const result=materializeGraphSourceInventory({source:stores[1],reader,dropped});expect(result.entries).toHaveLength(0);expect(cold.record.encryptedSourceBundle).toBeNull();
  await certifySurvivorAfterErasedPrefix(cold.record);
 });
 it('restores custody-epoch2 erased control under actual epoch3 only with its completed activation chain',async()=>{
  const requestKey=await saveOnlyOnWriterAndWitness(undefined,1,null,true);const oldMembership=membership;let deferred:ReturnType<typeof deferredOriginalControl>|undefined=deferredOriginalControl(service.operation('echo',requestKey)!.packet.coreHash);
  members[0].svc.store.close();await members[0].registry.close();members[0].admission.stop();
  SafeFsExecutor.safeRmSync(members[0].identity.baseDir,{recursive:true,force:true,operation:'source-observation-test-origin-permanently-lost'});
  stores[0]=undefined as never;
  const remote=service.recover('echo',requestKey);const cold=reconstructGraphSourceRecord({packet:remote.operation.packet,controlCapsule:remote.operation.controlCapsule,packetSignature:remote.operation.packetSignature,encryptedSourceBundle:remote.encryptedSourceBundle,
   originalMembership:oldMembership,...(remote.operation.prepareProof?{preparationProof:remote.operation.prepareProof}:{}),...(remote.operation.erasedControlProof?{erasedControlProof:remote.operation.erasedControlProof}:{}),...(remote.operation.erasure?{erasure:remote.operation.erasure}:{})},{machineId:members[1].id,sealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  cold.applicationSource.fill(0);if(cold.record.erasure)await stores[1].applyErasure(cold.record.erasure,erasureAuthority(cold.record.erasure));await stores[1].receive(cold.record,cold.record.packet.writerId);
  const frozenPacket=canonicalJson(cold.record.packet),frozenAuthorization=canonicalJson(cold.record.authorizationProof);
  const {signature:_oldSignature,...old}=oldMembership;const nextBody={...old,epoch:2,previousMembershipHash:canonicalHash(oldMembership),writerId:members[1].id,members:[oldMembership.members[1]]};
  const next={...nextBody,signature:signGraphRecord('graph-membership-v1',nextBody,owner.privateKey)};const current=actuationForSurvivor(next);
  const {reader,dropped}=readerFor(stores[1]);let helper=new GraphSourceObservationRecoveryCoordinator({source:stores[1],reader,dropped,stateDir:members[1].identity.baseDir,machineId:members[1].id,
   signingPrivateKey:members[1].identity.loadSigningKey(),ownerPublicKey:owner.publicKey,writeAdmission:members[1].admission,legacyReadOnly:()=>false,
   liveAdmission:()=>({admitted:true,writerId:members[1].id,leaseEpoch:4,membershipEpoch:2,fencedLeaseHash:canonicalHash(native)}),actuation:()=>current});
  const checked=helper.revalidate(cold.record.packet.eventId);expect(checked.state).toBe('validated');if(checked.state!=='validated')throw new Error(JSON.stringify(checked));
  expect(checked.proof.decision).toBe('refuse');expect(checked.proof.reason).toBe('erased-source');expect(checked.rewrap).toBeNull();expect(cold.record.preparationProof).toBeUndefined();expect(cold.record.erasedControlProof).toBeDefined();
  const manifest=buildGraphRecoverySourceManifest([cold.record],oldMembership);expect(manifest).toEqual(service.recoveryManifest('echo'));
  const inventory=buildGraphTransferRewrapInventory([cold.record],[{eventId:cold.record.packet.eventId,rewrap:checked.rewrap}]);
  const auth={v:1 as const,agentId:'echo',recoveryId:'decommission-lost-producer',previousMembershipHash:canonicalHash(oldMembership),newMembershipHash:canonicalHash(next),previousWitnessId:oldMembership.witnessId,newWitnessId:next.witnessId,
   fenceEpoch:4,highestCertifiedSequence:0,highestCertifiedCoreHash:null,pendingOutcomes:[{idempotencyKey:requestKey,operationHash:canonicalHash(cold.record.packet),decision:'refuse' as const,revalidationHash:canonicalHash(checked.proof)}],
   sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash(inventory),issuedAt:new Date().toISOString()};
  const authorization={...auth,signature:signGraphRecord('graph-recovery-authorization-v1',auth,owner.privateKey)};
  const stage={authorization,previousMembership:oldMembership,newMembership:next,currentLease:current.lease,originalCurrentLease:native,manifest,records:[cold.record],revalidations:[checked.proof],rewraps:[]};
  const transfer=new ConversationGraphReplicationTransfer({directory:path.join(members[1].identity.baseDir,'staged-transfer'),machineId:members[1].id,memberPrivateKey:members[1].identity.loadSigningKey(),memberSealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,verification:stores[1],witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  const transferReceipt=await transfer.stage(stage);
  const activated=service.recoverPending('echo',{newMembership:next,authorization,currentLease:current.lease,originalCurrentLease:native,revalidations:[{proof:checked.proof,rewrap:checked.rewrap}],stateTransferReceipts:[transferReceipt],sourceManifest:manifest});
  membership=next;stores[1]=await ConversationGraphReplication.open(storeOptions(members[1]));helper=recoveryForSurvivor(current);const adopted={...cold.record,adoption:activated.adoptions[0],rewrap:checked.rewrap};
  const receipt=await stores[1].receive(adopted,adopted.packet.writerId);expect(receipt.phase).toBe('cancellation');expect(receipt.membershipEpoch).toBe(2);expect(receipt.leaseEpoch).toBe(4);const certificate=service.certifyCancellation('echo',requestKey,current.lease,native,[receipt]);
  const ack=await stores[1].attachCancellationCertificate(adopted.packet.eventId,certificate);await stores[1].recordCertificateReceipt(adopted.packet.eventId,ack);service.acknowledgeCertificate('echo',requestKey,ack);
  const delivery=stores[1].commitProofDeliveryReceipt(adopted.packet.eventId);await stores[1].recordCommitProofDeliveryReceipt(adopted.packet.eventId,delivery);
  expect(stores[1].mayAcknowledgeNewWrite(adopted.packet.eventId,{lease:current.lease,originalLease:native})).toBe(false);expect(service.recoveryManifest('echo').highestCertifiedSequence).toBe(1);
  expect(canonicalJson(stores[1].repairRecord(adopted.packet.eventId)!.packet)).toBe(frozenPacket);expect(canonicalJson(stores[1].repairRecord(adopted.packet.eventId)!.authorizationProof)).toBe(frozenAuthorization);
  const result=materializeGraphSourceInventory({source:stores[1],reader,dropped});expect(result.entries).toHaveLength(0);expect(cold.record.encryptedSourceBundle).toBeNull();
  const fields={requestId:'erase-deferred-control',target:deferred!.packet.erasureIdentity,bundleHashes:[],authorizationReceiptHash:canonicalHash({owner:'forget-deferred'})};service.erase('echo',fields.requestId,fields.target,[],fields.authorizationReceiptHash,current.lease,native,signGraphRecord('graph-witness-action-v1',witnessActionPayload('erase',fields,current.lease),members[1].identity.loadSigningKey()));
  const deferredKey=deferred!.packet.idempotencyKey;service.admitErasedControl({...deferred!,lease:current.lease,originalLease:native});deferred=undefined;
  const fromW=()=>{const remote=service.recover('echo',deferredKey);return {packet:remote.operation.packet,packetSignature:remote.operation.packetSignature,controlCapsule:remote.operation.controlCapsule,encryptedSourceBundle:remote.encryptedSourceBundle,originalMembership:oldMembership,...(remote.operation.erasedControlProof?{erasedControlProof:remote.operation.erasedControlProof}:{}),...(remote.operation.erasure?{erasure:remote.operation.erasure}:{}),...(remote.operation.adoption?{adoption:remote.operation.adoption}:{}),...(remote.operation.cancellation?{cancellation:remote.operation.cancellation}:{}),...(remote.operation.cancellationCertificate?{cancellationCertificate:remote.operation.cancellationCertificate}:{})};};
  const trust={machineId:members[1].id,sealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]]),custodyMembership:next,custodyActivations:[activated.activation]};
  expect(()=>reconstructGraphSourceRecord(fromW(),{...trust,custodyActivations:[],installedMembership:next})).toThrow('witness-custody-invalid');
  const restored=reconstructGraphSourceRecord(fromW(),trust);expect(restored.record.erasedControlProof?.custodyMembershipEpoch).toBe(2);expect(restored.applicationSource.length).toBe(0);if(restored.record.erasure)await stores[1].applyErasure(restored.record.erasure,erasureAuthority(restored.record.erasure));await stores[1].receive(restored.record,restored.record.packet.writerId);
  const refused=helper.revalidate(restored.record.packet.eventId);if(refused.state!=='validated')throw new Error(JSON.stringify(refused));expect(refused.proof.decision).toBe('refuse');const routine=service.adoptPending('echo',{currentLease:current.lease,originalCurrentLease:native,revalidations:[{proof:refused.proof,rewrap:null}]})[0];const canceled=service.operation('echo',deferredKey)!.cancellation!;
  const currentRecord={...restored.record,adoption:routine,cancellation:canceled};const terminalReceipt=await stores[1].receive(currentRecord,currentRecord.packet.writerId);const cert2=service.certifyCancellation('echo',deferredKey,current.lease,native,[terminalReceipt]);const ack2=await stores[1].attachCancellationCertificate(currentRecord.packet.eventId,cert2);await stores[1].recordCertificateReceipt(currentRecord.packet.eventId,ack2);service.acknowledgeCertificate('echo',deferredKey,ack2);
  const history=stores[1].recordsForRepair(),manifest3=buildGraphRecoverySourceManifest(history,next),inventory3=buildGraphTransferRewrapInventory(history,[]),body3={...nextBody,epoch:3,previousMembershipHash:canonicalHash(next)},third={...body3,signature:signGraphRecord('graph-membership-v1',body3,owner.privateKey)},live3=actuationForSurvivor(third,5);
  const auth3={...auth,recoveryId:'third-installed-epoch',previousMembershipHash:canonicalHash(next),newMembershipHash:canonicalHash(third),fenceEpoch:5,highestCertifiedSequence:2,highestCertifiedCoreHash:currentRecord.packet.coreHash,pendingOutcomes:[],sourceManifestHash:canonicalHash(manifest3),rewrapInventoryHash:graphRewrapInventoryHash(inventory3)};const owner3={...auth3,signature:signGraphRecord('graph-recovery-authorization-v1',auth3,owner.privateKey)};
  const stage3={authorization:owner3,previousMembership:next,newMembership:third,currentLease:live3.lease,originalCurrentLease:native,manifest:manifest3,records:history,revalidations:[],rewraps:[]};const transfer3=new ConversationGraphReplicationTransfer({directory:path.join(members[1].identity.baseDir,'third-transfer'),machineId:members[1].id,memberPrivateKey:members[1].identity.loadSigningKey(),memberSealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,verification:stores[1],witnessPublicKeys:trust.witnessPublicKeys});const receipt3=await transfer3.stage(stage3);
  const activated3=service.recoverPending('echo',{newMembership:third,authorization:owner3,currentLease:live3.lease,originalCurrentLease:native,revalidations:[],stateTransferReceipts:[receipt3],sourceManifest:manifest3});expect(activated3.activation.newMembership.epoch).toBe(3);membership=third;
  const archived=reconstructGraphSourceRecord(fromW(),{...trust,installedMembership:third});expect(archived.record.custodyMembership?.epoch).toBe(2);expect(archived.record.custodyActivations).toEqual([activated.activation]);expect(archived.record.erasedControlProof?.custodyMembershipEpoch).toBe(2);expect(archived.applicationSource.length).toBe(0);
  expect(()=>reconstructGraphSourceRecord(fromW(),{...trust,installedMembership:third,custodyActivations:[]})).toThrow('witness-custody-invalid');

 });
 it('recovers a SavedPending empty-inventory checkpoint after complete writer-home loss and certifies unchanged proof on the survivor',async()=>{
  const emptyRegistry=new ConversationRegistry({stateDir:path.join(members[1].identity.baseDir,'empty-registered-transport'),machineId:()=>members[1].id,getConfigWorkspacePin:()=> 'TOWNER'});
  const context=readerFor(stores[1]);let checkpoint:ReturnType<ConversationGraphSourceSweepCapture['capture']>['checkpoint'];try{checkpoint=new ConversationGraphSourceSweepCapture({agentId:'echo',identity:members[1].identity,ownerPublicKey:owner.publicKey,membership:()=>membership,flat:{...members[1].flat,telegramTopics:()=>[],slackConversations:()=>[]},registry:emptyRegistry,telegramChatId:'-100123',source:stores[1],...context}).capture().checkpoint;}finally{await emptyRegistry.close();}
  const requestKey=await saveOnlyOnWriterAndWitness(checkpoint);const oldMembership=membership;
  members[0].svc.store.close();await members[0].registry.close();members[0].admission.stop();
  SafeFsExecutor.safeRmSync(members[0].identity.baseDir,{recursive:true,force:true,operation:'source-observation-test-origin-permanently-lost'});
  stores[0]=undefined as never;
  const remote=service.recover('echo',requestKey);const cold=reconstructGraphSourceRecord({packet:remote.operation.packet,controlCapsule:remote.operation.controlCapsule,packetSignature:remote.operation.packetSignature,encryptedSourceBundle:remote.encryptedSourceBundle,
   originalMembership:oldMembership,...(remote.operation.prepareProof?{preparationProof:remote.operation.prepareProof}:{}),...(remote.operation.erasedControlProof?{erasedControlProof:remote.operation.erasedControlProof}:{}),...(remote.operation.erasure?{erasure:remote.operation.erasure}:{})},{machineId:members[1].id,sealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  cold.applicationSource.fill(0);if(cold.record.erasure)await stores[1].applyErasure(cold.record.erasure,erasureAuthority(cold.record.erasure));await stores[1].receive(cold.record,cold.record.packet.writerId);
  const frozenPacket=canonicalJson(cold.record.packet),frozenAuthorization=canonicalJson(cold.record.authorizationProof);
  const {signature:_oldSignature,...old}=oldMembership;const nextBody={...old,epoch:2,previousMembershipHash:canonicalHash(oldMembership),writerId:members[1].id,members:[oldMembership.members[1]]};
  const next={...nextBody,signature:signGraphRecord('graph-membership-v1',nextBody,owner.privateKey)};const current=actuationForSurvivor(next);
  const {reader,dropped}=readerFor(stores[1]);let helper=new GraphSourceObservationRecoveryCoordinator({source:stores[1],reader,dropped,stateDir:members[1].identity.baseDir,machineId:members[1].id,
   signingPrivateKey:members[1].identity.loadSigningKey(),ownerPublicKey:owner.publicKey,writeAdmission:members[1].admission,legacyReadOnly:()=>false,
   liveAdmission:()=>({admitted:true,writerId:members[1].id,leaseEpoch:4,membershipEpoch:2,fencedLeaseHash:canonicalHash(native)}),actuation:()=>current});
  const checked=helper.revalidate(cold.record.packet.eventId);expect(checked.state).toBe('validated');if(checked.state!=='validated'||!checked.rewrap)throw new Error(JSON.stringify(checked));
  expect(checked.proof.decision).toBe('adopt');
  const manifest=buildGraphRecoverySourceManifest([cold.record],oldMembership);expect(manifest).toEqual(service.recoveryManifest('echo'));
  const inventory=buildGraphTransferRewrapInventory([cold.record],[{eventId:cold.record.packet.eventId,rewrap:checked.rewrap}]);
  const auth={v:1 as const,agentId:'echo',recoveryId:'decommission-lost-producer',previousMembershipHash:canonicalHash(oldMembership),newMembershipHash:canonicalHash(next),previousWitnessId:oldMembership.witnessId,newWitnessId:next.witnessId,
   fenceEpoch:4,highestCertifiedSequence:0,highestCertifiedCoreHash:null,pendingOutcomes:[{idempotencyKey:requestKey,operationHash:canonicalHash(cold.record.packet),decision:'adopt' as const,revalidationHash:canonicalHash(checked.proof)}],
   sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash(inventory),issuedAt:new Date().toISOString()};
  const authorization={...auth,signature:signGraphRecord('graph-recovery-authorization-v1',auth,owner.privateKey)};
  const stage={authorization,previousMembership:oldMembership,newMembership:next,currentLease:current.lease,originalCurrentLease:native,manifest,records:[cold.record],revalidations:[checked.proof],rewraps:[{eventId:cold.record.packet.eventId,rewrap:checked.rewrap}]};
  const transfer=new ConversationGraphReplicationTransfer({directory:path.join(members[1].identity.baseDir,'staged-transfer'),machineId:members[1].id,memberPrivateKey:members[1].identity.loadSigningKey(),memberSealingPrivateKey:members[1].identity.loadEncryptionKey(),ownerPublicKey:owner.publicKey,verification:stores[1],witnessPublicKeys:new Map([[membership.witnessId,witness.publicKey]])});
  const transferReceipt=await transfer.stage(stage);
  const activated=service.recoverPending('echo',{newMembership:next,authorization,currentLease:current.lease,originalCurrentLease:native,revalidations:[{proof:checked.proof,rewrap:checked.rewrap}],stateTransferReceipts:[transferReceipt],sourceManifest:manifest});
  membership=next;stores[1]=await ConversationGraphReplication.open(storeOptions(members[1]));helper=recoveryForSurvivor(current);const adopted={...cold.record,adoption:activated.adoptions[0],rewrap:checked.rewrap};
  const receipt=await stores[1].receive(adopted,adopted.packet.writerId);const certificate=service.commit('echo',requestKey,current.lease,native,[receipt]);
  const ack=await stores[1].attachCertificate(adopted.packet.eventId,certificate);await stores[1].recordCertificateReceipt(adopted.packet.eventId,ack);service.acknowledgeCertificate('echo',requestKey,ack);
  const delivery=stores[1].commitProofDeliveryReceipt(adopted.packet.eventId);await stores[1].recordCommitProofDeliveryReceipt(adopted.packet.eventId,delivery);
  expect(stores[1].mayAcknowledgeNewWrite(adopted.packet.eventId,{lease:current.lease,originalLease:native})).toBe(true);
  expect(canonicalJson(stores[1].repairRecord(adopted.packet.eventId)!.packet)).toBe(frozenPacket);expect(canonicalJson(stores[1].repairRecord(adopted.packet.eventId)!.authorizationProof)).toBe(frozenAuthorization);
  const result=materializeGraphSourceInventory({source:stores[1],reader,dropped,membership});expect(result.entries).toHaveLength(0);expect(result.coverage.checkpointEventIds).toEqual([adopted.packet.eventId]);
  expect(result.coverage.missingProducerIds).toEqual([]);expect(result.coverage.partialProducerIds).toEqual([members[1].id]); // Old signed roster: retained memory, not a new-roster scan.
 });

 it('refuses pending observation adoption after verified source erasure without opening deleted bytes',async()=>{
  const requestKey=await saveOnlyOnWriterAndWitness(),record=coldRecordFromWitness(requestKey);await stores[1].receive(record,record.packet.writerId);
  const old=record.authorizationProof,fields={requestId:'erase-pending-observation',target:record.packet.erasureIdentity,bundleHashes:[record.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({ownerAction:'forget'})};
  const sig=signGraphRecord('graph-witness-action-v1',witnessActionPayload('erase',fields,old.lease),members[0].identity.loadSigningKey());
  const erasure=service.erase('echo',fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,old.lease,native,sig);
  await stores[1].eraseBundle(record.packet.eventId,erasure,erasureAuthority(erasure));
  const current=actuationForSurvivor(membership),checked=recoveryForSurvivor(current).revalidate(record.packet.eventId);
  expect(checked).toMatchObject({state:'validated',proof:{decision:'refuse',reason:'erased-source'},rewrap:null});if(checked.state!=='validated')throw new Error(checked.reason);
  const adopted=service.adoptPending('echo',{currentLease:current.lease,originalCurrentLease:native,revalidations:[{proof:checked.proof,rewrap:null}]});
  expect(adopted[0].disposition).toBe('refused');expect(service.recover('echo',requestKey).encryptedSourceBundle).toBeNull();
 });
 it('refuses a delayed older pending capture when certified inventory already contains a newer same-source observation',async()=>{
  const older=members[0].capture.capturePage().observations.find(o=>o.capture.subject.platform==='app')!;
  members[0].svc.applyRename('owner-device',`${Date.now()}-${crypto.randomUUID()}`,APP,'new certified title');
  const laterCapture=new ConversationGraphSourceInventoryCapture({agentId:'echo',identity:members[0].identity,ownerPublicKey:owner.publicKey,membership:()=>membership,flat:members[0].flat,
   registry:members[0].registry,telegramChatId:'-100123',acceptedInventory:()=>({source:stores[0],...readerFor(stores[0])}),now:()=>Date.parse(older.capture.capturedAt)+1000});
  const newer=laterCapture.capturePage().observations.find(o=>o.capture.subject.platform==='app')!;
  const newerKey=await saveOnlyOnWriterAndWitness(newer),newerRecord=coldRecordFromWitness(newerKey);
  const receipts=await Promise.all(stores.map(store=>store.receive(newerRecord,newerRecord.packet.writerId)));
  const cert=service.commit('echo',newerKey,newerRecord.authorizationProof.lease,native,receipts);
  const acks=await Promise.all(stores.map(store=>store.attachCertificate(newerRecord.packet.eventId,cert)));
  for(const store of stores)for(const ack of acks)await store.recordCertificateReceipt(newerRecord.packet.eventId,ack);
  for(const ack of acks)service.acknowledgeCertificate('echo',newerKey,ack);
  const oldKey=await saveOnlyOnWriterAndWitness(older,2,newerRecord.packet.coreHash),pending=coldRecordFromWitness(oldKey);await stores[1].receive(pending,pending.packet.writerId);
  const current=actuationForSurvivor(membership),checked=recoveryForSurvivor(current).revalidate(pending.packet.eventId);
  expect(checked).toMatchObject({state:'validated',proof:{decision:'refuse',reason:'stale-heads'},rewrap:null});if(checked.state!=='validated')throw new Error(checked.reason);
  const adopted=service.adoptPending('echo',{currentLease:current.lease,originalCurrentLease:native,revalidations:[{proof:checked.proof,rewrap:null}]});expect(adopted[0].disposition).toBe('refused');
 });

});
