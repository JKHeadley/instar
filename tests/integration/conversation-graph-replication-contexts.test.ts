import {graphTransferContextCapacityBytes} from '../../src/core/ConversationGraphContextCapacity.js';
import {verifyGraphHistoricalMaterialization} from '../../src/core/ConversationGraphHistoricalMaterialization.js';
/** Large, real source history. Fixed protocol bounds stay unchanged; the test
 * explicitly provisions a finite staging disk budget and records actual bytes. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type {Server} from 'node:http';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {setupGraphRuntimeFixture,runtimes} from '../helpers/conversation-graph-runtime.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {SingleInstanceLock} from '../../src/core/SingleInstanceLock.js';
import {FencedLease} from '../../src/core/FencedLease.js';
import {LocalLeaseStore} from '../../src/core/LocalLeaseStore.js';
import {LeaseCoordinator} from '../../src/core/LeaseCoordinator.js';
import {WriteAdmission} from '../../src/core/WriteAdmission.js';
import {buildWriteDomainRegistry} from '../../src/core/WriteDomainRegistry.js';
import {CoherenceJournal} from '../../src/core/CoherenceJournal.js';
import {ReplicatedKindRegistry} from '../../src/core/ReplicatedRecordEnvelope.js';
import {ReplicatedPeerStreamReader} from '../../src/core/ReplicatedPeerStreamReader.js';
import {HybridLogicalClock} from '../../src/core/HybridLogicalClock.js';
import {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';
import {ConflictStore} from '../../src/core/ConflictStore.js';
import {PeerEndpointResolver} from '../../src/core/PeerEndpointResolver.js';
import {ConversationGraphReplicationRuntime,type ConversationGraphRuntimeConfiguration} from '../../src/server/ConversationGraphReplicationRuntime.js';
import {ConversationGraphReplicationTransfer,buildGraphRecoverySourceManifest,buildGraphTransferRewrapInventory,type GraphSourceTransferStage} from '../../src/core/ConversationGraphReplicationTransfer.js';
import {validateGraphReplicationRecord,GRAPH_REPLICATION_MAX_RECORD_BYTES,type ConversationGraphReplicationRecord} from '../../src/core/ConversationGraphReplication.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import {newHeaderId,newTitleSalt,titleCommitment} from '../../src/core/EffortHeaderStore.js';
import {sealGraphBundle,rewrapGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {canonicalHash,canonicalJson,graphOperationKey,graphRewrapInventoryHash,signGraphRecord,witnessActionPayload,GRAPH_SIGNATURE_DOMAINS as D,type GraphMembershipEpoch,type GraphCoreType} from '../../src/core/GraphWitnessTypes.js';
import type {LeaseRecord} from '../../src/core/types.js';
const directories:string[]=[],servers:Server[]=[],locks:SingleInstanceLock[]=[],journals:CoherenceJournal[]=[];
async function temp(){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'graph-context-scale-'));directories.push(directory);return directory;}
afterEach(async()=>{for(const server of servers.splice(0))await new Promise<void>(resolve=>server.close(()=>resolve()));for(const journal of journals.splice(0))journal.close();for(const lock of locks.splice(0))lock.release();for(const directory of directories.splice(0))SafeFsExecutor.safeRmSync(directory,{recursive:true,force:true,operation:'graph-context-scale:cleanup'});});
async function treeBytes(directory:string):Promise<number>{let total=0;for(const name of await fs.readdir(directory)){const file=path.join(directory,name),stat=await fs.stat(file);total+=stat.isDirectory()?await treeBytes(file):stat.size;}return total;}
async function boot(identity:MachineIdentityManager,configuration:ConversationGraphRuntimeConfiguration,native:LeaseRecord){
 const stateDir=identity.baseDir,machineId=identity.loadIdentity().machineId,lock=new SingleInstanceLock({stateDir});expect((await lock.acquire()).acquired).toBe(true);locks.push(lock);
 const store=new LocalLeaseStore({filePath:path.join(stateDir,'context-lease.json')});store.casWrite(native);
 const fenced=new FencedLease({selfMachineId:machineId,sign:data=>crypto.sign(null,Buffer.from(data),identity.loadSigningKey()).toString('base64'),verify:(data,signature,holder)=>{const key=configuration.membership.members.find(m=>m.machineId===holder)?.signingPublicKey;return !!key&&crypto.verify(null,Buffer.from(data),key,Buffer.from(signature,'base64'));}},{leaseTtlMs:30*60000,failoverThresholdMs:60*60000});
 const leaseCoordinator=new LeaseCoordinator({lease:fenced,store,presumedDeadHolders:()=>new Set(),monotonicNow:()=>0}),registry=new ReplicatedKindRegistry();let runtime:ConversationGraphReplicationRuntime|null=null;
 const journal=new CoherenceJournal({stateDir,machineId,flushIntervalMs:100000,onReplicatedRecordsCommitted:(kind,entries)=>runtime?.onJournalCommit(kind,entries)});journal.setReplicatedKindRegistry(registry);journal.open();journals.push(journal);
 runtime=await ConversationGraphReplicationRuntime.open({stateDir,configuration,identity,identities:new IdentityStore({stateDir}),leaseCoordinator,instanceLock:lock,
  writeAdmission:new WriteAdmission({thisMachineId:machineId,isReadOnly:()=>!leaseCoordinator.holdsLease(),isPoolActive:()=>true,registry:buildWriteDomainRegistry({machineId}),dryRun:true,disableTimers:true}),
  endpointResolver:new PeerEndpointResolver({config:{enabled:true,hedgeDelayMs:0,priorityLan:1,priorityTailscale:2,priorityCloudflare:3,tailscaleEnabled:true,lanSubnetGate:false,unhealthyAfterFailures:2,endpointEvictionMs:60000,maxProbeBackoffMs:60000,requestTimeoutMs:5000}}),
  journal,registry,peerStreams:new ReplicatedPeerStreamReader({stateDir,registry,selfMachineId:machineId}),clock:new HybridLogicalClock({node:machineId,now:Date.now}),droppedOrigins:new DroppedOriginRegistry({stateDir}),conflictStore:new ConflictStore({stateDir})});
 if(!runtime)throw new Error('missing-runtime');runtimes.push(runtime);return {runtime,lock,journal,url:await serve(runtime)};
}
async function serve(runtime:ConversationGraphReplicationRuntime){
 const app=express();app.use('/internal/conversation-graph',runtime.admissionGuard(),express.json({limit:'4mb'}),runtime.router);
 const server=await new Promise<Server>(resolve=>{const server=app.listen(0,'0.0.0.0',()=>resolve(server));});servers.push(server);const address=server.address();if(!address||typeof address==='string')throw new Error('missing-server');
 const host=Object.values(os.networkInterfaces()).flat().find(row=>row&&row.family==='IPv4'&&!row.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(row.address))?.address;if(!host)throw new Error('private-interface-required');
 return `http://${host}:${address.port}`;
}
async function exerciseHistoricalContext(count:number,requireLarge:boolean,minPages=requireLarge?25:1){
  const fixture=await setupGraphRuntimeFixture(),{f,runtime:origin,peer:oldPeer,service,witness,managers}=fixture;
  await origin.prepareNativeTailClosure();
  const headerId=newHeaderId(),effort={kind:'effort' as const,id:crypto.randomUUID()};let predecessorHash:string|null=null;
  for(let i=1;i<=count;i++){
   if(i===1||i%100===0)expect(await fixture.options[0].leaseCoordinator.renew()).toBe(true);
   const current=origin.actuation(),acceptedAt=new Date().toISOString();
   const rawId='change-'+crypto.randomUUID(),coreType:GraphCoreType=i===1?'graph-event':'header-op',receiptId='owner-'+crypto.randomUUID(),salt=newTitleSalt();
   const common={schemaVersion:1,authority:'owner',principal:'owner',receipt:{kind:'owner-proof',id:receiptId},machineId:origin.machineId,createdAt:acceptedAt};
   const core:Record<string,unknown>=i===1?{...common,eventId:rawId,op:'create-effort',subject:effort,projectScope:[],headerId}
    :{...common,opId:rawId,kind:'set-effort-title',headerId,baseVersion:i-2,titleCommitment:titleCommitment(`private title ${i}`,salt),bundleRef:{kind:'header-source-bundle',id:'bundle-'+crypto.randomUUID()}};
   const eventId=graphOperationKey(coreType,rawId),idempotencyKey='owner-change:'+canonicalHash(i),receipt=signGraphAuthorizationReceipt({v:1,agentId:'echo',eventId,coreHash:canonicalHash(core),actorPrincipal:'owner',authenticationMethod:'owner-device',receiptId,membershipEpoch:1,leaseEpoch:1,idempotencyKey,writerId:origin.machineId,fencedLeaseHash:canonicalHash(current.originalLease),acceptedAt},managers[0].loadSigningKey());
   const authorizationProof={receipt,membership:f.membership,lease:current.lease,originalLease:current.originalLease},application=i===1?{kind:'graph-owner-change',requestId:'bulk-create',requestHash:canonicalHash('bulk-create')}:{kind:'effort-header-payload',requestId:'bulk-'+i,requestHash:canonicalHash({headerId,baseVersion:i-2}),headerId,title:`private title ${i}`,salt};
   const plaintext=encodeGraphSourceEnvelope(coreType,core,authorizationProof,Buffer.from(canonicalJson(application))),encryptedSourceBundle=sealGraphBundle(plaintext,f.membership.members,{agentId:'echo',eventId});plaintext.fill(0);
   const controlCapsule=createGraphControlCapsule(coreType,core,authorizationProof),packet={coreType,controlHash:canonicalHash(controlCapsule),erasureIdentity:deriveGraphErasureIdentity(coreType,core),agentId:'echo',eventId,idempotencyKey,coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt),sourceSequence:i,predecessorHash,membershipEpoch:1,leaseEpoch:1,writerId:origin.machineId,sourceBundleHash:canonicalHash(encryptedSourceBundle)};
   const record:ConversationGraphReplicationRecord={coreType,packet,packetSignature:signGraphRecord(D.packet,packet,managers[0].loadSigningKey()),core,authorizationProof,encryptedSourceBundle};
   const own=await origin.source.appendLocal(record),prepared=service.prepare({packet,packetSignature:record.packetSignature,controlCapsule,encryptedSourceBundle,...current});await origin.source.attachPreparation(eventId,prepared);record.preparationProof=prepared;
   const remote=await oldPeer.source.receive(record,origin.machineId),certificate=service.commit('echo',idempotencyKey,current.lease,current.originalLease,[own.receipt,remote]);
   const acknowledgments=await Promise.all([origin.source.attachCertificate(eventId,certificate),oldPeer.source.attachCertificate(eventId,certificate)]);
   for(const ack of acknowledgments){service.acknowledgeCertificate('echo',idempotencyKey,ack);await origin.source.recordCertificateReceipt(eventId,ack);await oldPeer.source.recordCertificateReceipt(eventId,ack);}predecessorHash=packet.coreHash;
   if(i%1000===0)console.log('real historical records certified',i);
  }
  const target={sourceKind:'header' as const,sourceId:headerId},requestId='bulk-header-erasure',authorizationReceiptHash=canonicalHash('actual owner erasure'),action={requestId,target,bundleHashes:[],authorizationReceiptHash};
  const eraseActuation=origin.actuation(),erasure=service.erase('echo',requestId,target,[],authorizationReceiptHash,eraseActuation.lease,eraseActuation.originalLease,signGraphRecord(D.action,witnessActionPayload('erase',action,eraseActuation.lease),managers[0].loadSigningKey()));
  const erasureAuthority=await witness.erasureAuthority(erasure);await origin.source.applyErasure(erasure,erasureAuthority);await oldPeer.source.applyErasure(erasure,erasureAuthority);const records=oldPeer.source.recordsForRepair().sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence);
  const added=new MachineIdentityManager(await temp());await added.generateIdentity();const addedId=added.loadIdentity().machineId;
  const unsignedMembership={...f.membership,epoch:2,previousMembershipHash:canonicalHash(f.membership),writerId:oldPeer.machineId,members:[f.membership.members[1],{machineId:addedId,signingPublicKey:added.getSigningPublicKeyPem(addedId)!,sealingPublicKey:added.getEncryptionPublicKeyPem(addedId)!}]};delete (unsignedMembership as Partial<typeof unsignedMembership>).signature;
  expect(fixture.leaseStores[1].refresh(origin.actuation().originalLease)).toBe(true);
  expect(await fixture.options[1].leaseCoordinator.acquireOnConsent(origin.machineId)).toBe(true);
  const membership:GraphMembershipEpoch={...unsignedMembership,signature:signGraphRecord(D.membership,unsignedMembership,f.owner.privateKey)},actuation=oldPeer.actuation(),leaseUnsigned={...actuation.lease,membershipEpoch:2};delete (leaseUnsigned as Partial<typeof leaseUnsigned>).signature;
  const lease={...leaseUnsigned,signature:signGraphRecord(D.lease,leaseUnsigned,managers[1].loadSigningKey())};
  const live=records[0],rewrap=rewrapGraphBundle(live.encryptedSourceBundle!,oldPeer.machineId,managers[1].loadEncryptionKey(),membership,oldPeer.machineId,managers[1].loadSigningKey(),live.packet,new Date().toISOString());
  const rewraps=[{eventId:live.packet.eventId,rewrap}],manifest=buildGraphRecoverySourceManifest(records,f.membership),inventory=buildGraphTransferRewrapInventory(records,rewraps);
  if(requireLarge)expect(Buffer.byteLength(canonicalJson(manifest))).toBeGreaterThan(GRAPH_REPLICATION_MAX_RECORD_BYTES);
  const auth={v:1 as const,agentId:'echo',recoveryId:'actual-large-context',previousMembershipHash:canonicalHash(f.membership),newMembershipHash:canonicalHash(membership),previousWitnessId:f.membership.witnessId,newWitnessId:membership.witnessId,fenceEpoch:2,highestCertifiedSequence:manifest.highestCertifiedSequence,highestCertifiedCoreHash:manifest.highestCertifiedCoreHash,pendingOutcomes:[],sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash(inventory),issuedAt:new Date().toISOString()};
  const authorization={...auth,signature:signGraphRecord(D.recovery,auth,f.owner.privateKey)},stage:GraphSourceTransferStage={authorization,previousMembership:f.membership,newMembership:membership,currentLease:lease,originalCurrentLease:actuation.originalLease,manifest,records,revalidations:[],rewraps};
  const addedStage=await temp(),survivorStage=await temp(),budget=128*1024*1024;
  const stageOptions={ownerPublicKey:f.owner.publicKey,verification:oldPeer.source,witnessPublicKeys:new Map([[membership.witnessId,f.witness.publicKey]]),diskQuotaBytes:budget};
  if(!requireLarge){
   const rejectedDirectory=await temp(),contextBudgetBytes=graphTransferContextCapacityBytes({previousMembership:f.membership,newMembership:membership,authorization,manifest,rewrapInventory:inventory,currentLease:lease,originalCurrentLease:actuation.originalLease})-1;
   await expect(new ConversationGraphReplicationTransfer({...stageOptions,directory:rejectedDirectory,machineId:addedId,memberPrivateKey:added.loadSigningKey(),memberSealingPrivateKey:added.loadEncryptionKey(),contextBudgetBytes}).stage(stage)).rejects.toThrow('context-capacity');
   expect((await witness.inventory(crypto.randomBytes(32).toString('base64url'))).activeMembershipHash).toBe(canonicalHash(f.membership));
   expect(origin.source.status(live.packet.eventId).state).toBe('committed');expect(canonicalHash((await witness.operation(live.packet.idempotencyKey)).certificate)).toBe(canonicalHash(live.certificate));
   const retained=origin.source.openVerifiedPayload(live);expect(JSON.parse(retained.toString()).requestId).toBe('bulk-create');retained.fill(0);
  }
  const addedReceipt=await new ConversationGraphReplicationTransfer({...stageOptions,directory:addedStage,machineId:addedId,memberPrivateKey:added.loadSigningKey(),memberSealingPrivateKey:added.loadEncryptionKey()}).stage(stage);
  const survivorReceipt=await new ConversationGraphReplicationTransfer({...stageOptions,directory:survivorStage,machineId:oldPeer.machineId,memberPrivateKey:managers[1].loadSigningKey(),memberSealingPrivateKey:managers[1].loadEncryptionKey()}).stage(stage);
  const activated=await witness.recoverPending({newMembership:membership,authorization,currentLease:lease,originalCurrentLease:actuation.originalLease,revalidations:[],stateTransferReceipts:[addedReceipt,survivorReceipt],sourceManifest:manifest,historicalRewraps:rewraps});
  await origin.close();await oldPeer.close();
  for(const identity of [managers[1],added]){for(const other of [managers[1],added])if(identity!==other){identity.registerMachine(other.loadIdentity(),'standby');new IdentityStore({stateDir:identity.baseDir}).apply({identity:other.loadIdentity(),scope:'remote',actor:'pairing-trust',path:'pair'});}const registry=identity.loadRegistry();if(registry.machines[origin.machineId])registry.machines[origin.machineId].revokedAt=new Date().toISOString();identity.saveRegistry(registry);}
  const configuration={...fixture.options[1].configuration!,membership,stagingDiskQuotaBytes:budget};
  expect(canonicalHash(fixture.leaseStores[1].read().lease)).toBe(canonicalHash(actuation.originalLease));
  // The old component is stopped; its server-level lifetime lock remains held.
  const survivor=await ConversationGraphReplicationRuntime.open({...fixture.options[1],configuration});if(!survivor)throw new Error('missing-survivor');runtimes.push(survivor);
  const addedBoot=await boot(added,configuration,actuation.originalLease);const receiver=addedBoot.runtime;
  const activatedErasureAuthority=await witness.erasureAuthority(erasure);await receiver.source.applyErasure(erasure,activatedErasureAuthority);await survivor.source.applyErasure(erasure,activatedErasureAuthority);
  if(!requireLarge)for(const record of records){const entry=inventory.find(row=>row.eventId===record.packet.eventId)!,trial={...record,materialization:{activation:activated.activation,manifest,rewrapInventory:inventory,rewrapHash:entry.rewrapHash,currentLease:lease,originalCurrentLease:actuation.originalLease},...(record.erasure?{}:{rewrap})};
   expect(validateGraphReplicationRecord(trial),`typed historical record ${record.coreType}`).not.toBeNull();
   expect(verifyGraphHistoricalMaterialization(trial.materialization,trial,{ownerPublicKey:f.owner.publicKey,witnessPublicKeys:stageOptions.witnessPublicKeys,installedMembership:membership,machineId:survivor.machineId}),`actual activation context ${record.coreType}`).toBe(true);
   expect(survivor.source.verifyHistoricalRecord(trial),`survivor historical ${record.coreType}:${record.packet.sourceSequence}`).toBe(true);
  }
  await new ConversationGraphReplicationTransfer({...stageOptions,directory:survivorStage,machineId:survivor.machineId,memberPrivateKey:managers[1].loadSigningKey(),memberSealingPrivateKey:managers[1].loadEncryptionKey(),verification:survivor.source}).importTransferred(stage,activated.activation).catch(error=>{throw new Error('actual-context-import:'+error.message);});
  await new ConversationGraphReplicationTransfer({...stageOptions,directory:addedStage,machineId:addedId,memberPrivateKey:added.loadSigningKey(),memberSealingPrivateKey:added.loadEncryptionKey(),verification:receiver.source}).importTransferred(stage,activated.activation).catch(error=>{throw new Error('actual-context-import:'+error.message);});
  const sourceDirectory=path.join(added.baseDir,'state','conversation-graph-source'),contexts=await fs.readdir(path.join(sourceDirectory,'contexts'));
  expect(contexts.filter(name=>name.endsWith('.json'))).toHaveLength(1);if(requireLarge)expect((await fs.stat(path.join(sourceDirectory,'contexts',contexts[0]))).size).toBeGreaterThan(GRAPH_REPLICATION_MAX_RECORD_BYTES);
  if(!requireLarge){const retainedContexts=path.join(addedStage,'contexts');await fs.mkdir(retainedContexts,{recursive:true});for(const name of contexts.filter(name=>name.endsWith('.json')))await fs.copyFile(path.join(sourceDirectory,'contexts',name),path.join(retainedContexts,name));await receiver.localErasure.deny(erasure.target);const audit=new ConversationGraphReplicationTransfer({...stageOptions,directory:addedStage,machineId:addedId,memberPrivateKey:added.loadSigningKey(),memberSealingPrivateKey:added.loadEncryptionKey(),verification:receiver.source,localErasure:receiver.localErasure});expect(await audit.assertLocalErasurePurged(erasure.target)).toMatch(/^[a-f0-9]{64}$/);}
  const references=(await fs.readdir(sourceDirectory)).filter(name=>name.endsWith('.materialization.json'));expect(references).toHaveLength(count);
  let referenceBytes=0;for(const name of references){const file=path.join(sourceDirectory,name);referenceBytes+=(await fs.stat(file)).size;const reference=JSON.parse(await fs.readFile(file,'utf8'));expect(Object.keys(reference).sort()).toEqual(['contextHash','rewrapHash','v']);}expect(referenceBytes).toBeLessThan(2*1024*1024);
  expect(await treeBytes(addedStage)).toBeLessThan(budget);expect(await treeBytes(survivorStage)).toBeLessThan(budget);
  console.log('actual bounded context bytes',JSON.stringify({records:count,manifest:Buffer.byteLength(canonicalJson(manifest)),sourceReferenceBytes:referenceBytes,stageBytes:await treeBytes(addedStage)}));
  expect(receiver.source.recordsForRepair()).toHaveLength(count);expect(()=>receiver.source.openVerifiedPayload(receiver.source.repairRecord(records[1].packet.eventId)!)).toThrow('erased');
  const originalCertificate=canonicalJson(records[0].certificate),survivorUrl=await serve(survivor);
  for(const identity of [managers[1],added]){const registry=identity.loadRegistry();registry.machines[survivor.machineId].endpoints=[{kind:'lan',url:survivorUrl}];registry.machines[addedId].endpoints=[{kind:'lan',url:addedBoot.url}];identity.saveRegistry(registry);}
  const survivorReady=await survivor.refreshReadiness();expect(survivorReady,(survivor as unknown as {lastReadinessFailure:string}).lastReadinessFailure).toBe(true);const receiverReady=await receiver.refreshReadiness();expect(receiverReady,(receiver as unknown as {lastReadinessFailure:string}).lastReadinessFailure).toBe(true);
  await receiver.close();addedBoot.journal.close();addedBoot.lock.release();
  SafeFsExecutor.safeRmSync(sourceDirectory,{recursive:true,force:true,operation:'graph-context-scale:lose-entire-added-source'});
  const restarted=await boot(added,configuration,actuation.originalLease);
  let contextPages=0;const originalPage=survivor.source.contextPage.bind(survivor.source);
  survivor.source.contextPage=(hash,index)=>{contextPages++;return originalPage(hash,index);};
  expect(restarted.runtime.readiness().retained).toBe(false);
  const bodyRecovery=vi.spyOn(witness,'recover').mockRejectedValue(new Error('independent witness application-body endpoint unavailable'));let repairedReady=false;try{repairedReady=await restarted.runtime.refreshReadiness();}finally{bodyRecovery.mockRestore();}
  expect(repairedReady,(restarted.runtime as unknown as {lastReadinessFailure:string}).lastReadinessFailure).toBe(true);
  expect(contextPages).toBeGreaterThanOrEqual(minPages); // the context actually transferred in 128KiB signed pages
  const repaired=restarted.runtime.source.repairRecord(records[0].packet.eventId)!;
  expect(canonicalJson(repaired.certificate)).toBe(originalCertificate);
  expect(restarted.runtime.source.recordsForRepair()).toHaveLength(count);
  const payload=restarted.runtime.source.openVerifiedPayload(repaired);expect(JSON.parse(payload.toString()).requestId).toBe('bulk-create');payload.fill(0);
  expect(()=>restarted.runtime.source.openVerifiedPayload(restarted.runtime.source.repairRecord(records[1].packet.eventId)!)).toThrow('erased');
  expect((await fs.readdir(path.join(sourceDirectory,'contexts'))).filter(name=>name.endsWith('.json'))).toHaveLength(1);
  expect((await fs.readdir(sourceDirectory)).filter(name=>name.endsWith('.receipt.json'))).toHaveLength(0);

}
describe('bounded shared historical proof custody',()=>{
 it('smoke: imports and repairs real eight-row history through the same native/activation/signed-peer ceremony',()=>exerciseHistoricalContext(8,false),120000);
 it('repairs a multi-page historical context across restart through the signed-peer ceremony',()=>exerciseHistoricalContext(300,false,2),600000);
 // Scale proof: about 30 minutes, longer than a whole Local Verify integration shard. Opt-in like the
 // other graph scale proofs; the eight-row smoke above runs the same ceremony by default.
 it.runIf(process.env.GRAPH_HISTORICAL_CONTEXT_SCALE_PROOF==='1')('imports, restarts and signed-peer repairs a >3MiB actual historical context with one shared proof file',()=>exerciseHistoricalContext(4000,true),3600000);
});
