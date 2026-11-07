import {GraphCustodyPeerFrontier,GRAPH_CUSTODY_FRONTIER_DOMAIN} from '../../src/core/GraphCustodyPeerFrontier.js';
import {sealGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import {verifyGraphNativeTailClosure} from '../../src/core/ConversationGraphNativeTail.js';
import type {OwnedGraphCustody} from '../../src/core/OwnedGraphCustody.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {ConversationGraphReplicationRuntime} from '../../src/server/ConversationGraphReplicationRuntime.js';
import {spawn} from 'node:child_process';
import Database from 'better-sqlite3';
import os from 'node:os';
import {ReplicatedPeerStreamReader} from '../../src/core/ReplicatedPeerStreamReader.js';
import {ReplicatedKindRegistry} from '../../src/core/ReplicatedRecordEnvelope.js';
import {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';
import {ConflictStore} from '../../src/core/ConflictStore.js';
import {HybridLogicalClock} from '../../src/core/HybridLogicalClock.js';
import {createGraphCustodyProfile} from '../../src/core/GraphCustodyProfile.js';
import {createGraphOwnerRecoveryEnvelope} from '../../src/core/GraphOwnerRecovery.js';
import {GRAPH_CUSTODY_INTENT_DOMAIN,GRAPH_CUSTODY_STAGE_DOMAIN,type GraphCustodyIntentHold,type GraphCustodyProfileHold,type GraphCustodyRetirementProof} from '../../src/core/GraphCustodyProfileAuthority.js';
import {buildGraphRecoverySourceManifest,type GraphSourceTransferStage} from '../../src/core/ConversationGraphReplicationTransfer.js';
import {rewrapGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {unsigned,graphRewrapInventoryHash,GRAPH_SIGNATURE_DOMAINS as D,type GraphMembershipTransferReceipt,type GraphMembershipActivationCertificate} from '../../src/core/GraphWitnessTypes.js';
import type {GraphNativeTailClosure} from '../../src/core/ConversationGraphNativeTail.js';
import type {GraphCustodyActivationPin} from '../../src/core/GraphCustodyActivationPinTypes.js';
/** Actual enrolled native peers and registered resolver transport. The legacy
 * fixture's graph engines are closed/empty; default boot receives native deps only. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type {Server} from 'node:http';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {setupGraphRuntimeFixture,dirs as runtimeDirectories} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphDefault,GRAPH_OWNER_CONTROL_SECRET,GRAPH_CUSTODY_ROLE_SECRET,GRAPH_PEER_BEARER_SECRET} from '../../src/server/ConversationGraphDefault.js';
import {createConversationGraphDefaultSurface} from '../../src/server/ConversationGraphDefaultSurface.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {CoherenceJournal} from '../../src/core/CoherenceJournal.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {canonicalHash,canonicalJson,signGraphRecord} from '../../src/core/GraphWitnessTypes.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
const managers:ConversationGraphDefault[]=[],servers:Server[]=[],journals:CoherenceJournal[]=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const manager of managers.splice(0))await manager.close();for(const journal of journals.splice(0))journal.close();});
async function fixture(stagingDiskQuotaBytes?:number){
 const native=await setupGraphRuntimeFixture();await native.runtime.close();await native.peer.close();const secrets:SecretStore[]=[],apps:express.Express[]=[],defaults:ConversationGraphDefault[]=[],origins:string[]=[],listeners:Server[]=[],fixtureJournals:CoherenceJournal[]=[];
 const host=new URL(native.managers[1].loadRegistry().machines[native.managers[0].loadIdentity().machineId].endpoints![0].url).hostname;
 for(let index=0;index<2;index++){
  const prior=native.options[index],stateDir=prior.stateDir;prior.journal.close();
  // Remove ONLY empty test graph stores opened by the reused native fixture.
  expect(native.service.inventory('echo','x'.repeat(43)).manifest.entries).toHaveLength(0);
  for(const name of ['conversation-graph-source','conversation-graph-intake','conversation-graph-transfer'])SafeFsExecutor.safeRmSync(path.join(stateDir,'state',name),{recursive:true,force:true,operation:'graph-default-peers-test:empty-fixture-storage'});
  let manager:ConversationGraphDefault;const journal=new CoherenceJournal({stateDir,machineId:prior.identity.loadIdentity().machineId,onReplicatedRecordsCommitted:(kind,entries)=>manager?.runtime?.onJournalCommit(kind,entries)});journal.setReplicatedKindRegistry(prior.registry);journal.open();journals.push(journal);fixtureJournals.push(journal);
  const vault=new SecretStore({stateDir,forceFileKey:true});secrets.push(vault);const {configuration:_legacy,...nativeOnly}=prior;
  manager=new ConversationGraphDefault({stateDir,agentId:'echo',stagingDiskQuotaBytes,instanceLock:prior.instanceLock,secrets:vault,bootstrapBearer:'default-native-peer-bootstrap',fleet:{...nativeOnly,journal}});managers.push(manager);defaults.push(manager);
  const app=express();app.use('/internal/conversation-graph-bootstrap',manager.admissionGuard(),express.json({limit:'256kb'}));app.use(manager.router);
  app.use('/internal/conversation-graph',(req,res,next)=>{const runtime=manager.runtime;if(!runtime)return void res.status(503).json({code:'graph-pending'});runtime.admissionGuard()(req,res,()=>express.json({limit:'4mb'})(req,res,()=>runtime.router(req,res,next)));});apps.push(app);
  const server=app.listen(0,'0.0.0.0');servers.push(server);listeners.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));origins.push(`http://${host}:${(server.address() as {port:number}).port}`);
 }
 for(let index=0;index<2;index++)for(let peer=0;peer<2;peer++)if(index!==peer){const registry=native.managers[index].loadRegistry(),id=native.managers[peer].loadIdentity().machineId;registry.machines[id].endpoints=[{kind:'lan',url:origins[peer]}];native.managers[index].saveRegistry(registry);}
 return{native,secrets,defaults,origins,apps,listeners,fixtureJournals};
}
it('stages an actual >256KiB encrypted Source through fresh signed bounded mesh frames',async()=>{
 const explicitBudget=128*1024*1024,f=await fixture(explicitBudget),[host,follower]=f.defaults;for(const manager of f.defaults)await manager.ensureOwner({principalKey:'owner:echo',authenticationMethod:'owner-dashboard',requestId:'framed-controller-owner',isCurrent:()=>true});
 const capacityBefore=await follower.runtime!.transfer.storageCapacity();expect(capacityBefore.quotaBytes).toBe(explicitBudget);expect(capacityBefore.usedBytes).toBe(0);const runtime=host.runtime!,current=runtime.actuation(),membership=runtime.installedMembership,identity=f.native.managers[0],createdAt=new Date().toISOString(),eventId='actual-large-framed-source',operationKey='graph-event:'+eventId;
 const core={schemaVersion:1,eventId,op:'set-primary-placement',subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42},parent:null,relation:null,replacesPlacementEventIds:[],authority:'owner',principal:'owner:echo',receipt:{kind:'owner-proof',id:'framed-actual-owner-request'},machineId:runtime.machineId,createdAt};
 const receipt=signGraphAuthorizationReceipt({v:1,agentId:'echo',eventId:operationKey,coreHash:canonicalHash(core),actorPrincipal:'owner:echo',authenticationMethod:'owner-dashboard',receiptId:core.receipt.id,membershipEpoch:membership.epoch,leaseEpoch:current.lease.leaseEpoch,idempotencyKey:'actual-large-framed-source-request',writerId:runtime.machineId,fencedLeaseHash:canonicalHash(current.originalLease),acceptedAt:createdAt},identity.loadSigningKey());
 expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:'graph-event',idempotencyKey:receipt.idempotencyKey,requestHash:canonicalHash({request:'actual-framed-source'}),core,authorizationProof:{receipt,membership,...current},plaintextSource:crypto.randomBytes(400000)},token))).state).toBe('committed');
 const records=runtime.source.recordsForRepair();expect(records).toHaveLength(1);expect(follower.runtime!.source.allCommitProofDelivered(operationKey)).toBe(true);
 const control=f.secrets[0].get(GRAPH_OWNER_CONTROL_SECRET) as {privateKey:string},raw={...membership,epoch:2,previousMembershipHash:canonicalHash(membership)};delete raw.custodyProfile;
 const next={...raw,custodyProfile:createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:membership.custodyProfile!.witnessPublicKey,hostMachineId:runtime.machineId},control.privateKey),signature:''};next.signature=signGraphRecord(D.membership,unsigned(next),control.privateKey);
 const envelope=createGraphOwnerRecoveryEnvelope(control.privateKey,next),intentRaw={v:1 as const,agentId:'echo',previousMembership:membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},intent={...intentRaw,signature:signGraphRecord(GRAPH_CUSTODY_INTENT_DOMAIN,intentRaw,control.privateKey)};
 const negative=await Promise.all(f.native.managers.map(manager=>host.applyCustodyTransition(manager.loadIdentity().machineId,{kind:'hold',intent,ownerRecoveryEnvelope:envelope,previous:current}))) as Array<{hold:GraphCustodyIntentHold;closedTail:GraphNativeTailClosure}>;
 const manifest=buildGraphRecoverySourceManifest(records,membership),rewraps=records.map(record=>({eventId:record.packet.eventId,rewrap:rewrapGraphBundle(record.encryptedSourceBundle!,runtime.machineId,identity.loadEncryptionKey(),next,runtime.machineId,identity.loadSigningKey(),record.packet)}));
 const authorizationRaw={v:1 as const,agentId:'echo',recoveryId:'actual-framed-source-recovery',previousMembershipHash:canonicalHash(membership),newMembershipHash:canonicalHash(next),previousWitnessId:membership.witnessId,newWitnessId:next.witnessId,fenceEpoch:current.lease.leaseEpoch,highestCertifiedSequence:manifest.highestCertifiedSequence,highestCertifiedCoreHash:manifest.highestCertifiedCoreHash,pendingOutcomes:[],sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash(rewraps.map(row=>({eventId:row.eventId,rewrapHash:canonicalHash(row.rewrap)}))),issuedAt:new Date().toISOString()},authorization={...authorizationRaw,signature:signGraphRecord(D.recovery,authorizationRaw,control.privateKey)};
 const stageRaw={v:1 as const,agentId:'echo',revision:1,supersedesHash:null,holdIntent:intent,intentHolds:negative.map(row=>row.hold),closedTails:negative.map(row=>row.closedTail),authorization,previousMembership:membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},stage={...stageRaw,signature:signGraphRecord(GRAPH_CUSTODY_STAGE_DOMAIN,stageRaw,control.privateKey)},bridgeRaw={...unsigned(current.lease),membershipEpoch:2},bridge={...bridgeRaw,signature:signGraphRecord(D.lease,bridgeRaw,identity.loadSigningKey())};
 const sourceStage:GraphSourceTransferStage={authorization,previousMembership:membership,newMembership:next,currentLease:bridge,originalCurrentLease:current.originalLease,manifest,records,revalidations:[],rewraps};
 const payload={kind:'stage',stage,sourceStage,ownerRecoveryEnvelope:envelope};expect(Buffer.byteLength(canonicalJson(payload))).toBeGreaterThan(256*1024);
 const wireSizes:number[]=[];f.apps[1].use((_req,_res,next)=>next());const observed=vi.spyOn(globalThis,'fetch');
 const result=await host.applyCustodyTransition(f.native.managers[1].loadIdentity().machineId,payload) as {hold:GraphCustodyProfileHold;transfer:GraphMembershipTransferReceipt};
 for(const [url,init]of observed.mock.calls)if(String(url).includes('/internal/conversation-graph-bootstrap/message')&&typeof init?.body==='string')wireSizes.push(Buffer.byteLength(init.body));
 observed.mockRestore();expect(result.transfer.sourceManifestHash).toBe(canonicalHash(manifest));expect(result.transfer.newMembershipHash).toBe(canonicalHash(next));expect(result.hold.stageHash).toBe(canonicalHash(stage));expect(wireSizes.length).toBeGreaterThan(3);expect(Math.max(...wireSizes)).toBeLessThanOrEqual(256*1024);const capacityAfter=await follower.runtime!.transfer.storageCapacity();expect(capacityAfter.quotaBytes).toBe(explicitBudget);expect(capacityAfter.usedBytes).toBeGreaterThan(400000);expect(capacityAfter.availableBytes).toBe(explicitBudget-capacityAfter.usedBytes);
});
it('finds only the actually pinned genesis planning objects after a native peer revoke and refuses a missing marker',async()=>{
 const f=await fixture(),host=f.defaults[0];expect(host.memberLossPlanningComponents()).toBeNull();
 await host.ensureOwner({principalKey:'owner:echo',authenticationMethod:'owner-dashboard',requestId:'actual-planning-owner',isCurrent:()=>true});
 const original=host.memberLossPlanningComponents()!;expect(original.secrets).toBe(f.secrets[0]);expect(original.publication.membership.members).toHaveLength(2);expect(canonicalHash(original.publication)).toBe(original.authority.publicationHash);
 f.native.managers[0].revokeMachine(f.native.managers[1].loadIdentity().machineId,f.native.managers[0].loadIdentity().machineId,'synthetic planning lookup revoke');
 expect(host.memberLossPlanningComponents()?.publication).toEqual(original.publication);const control=original.secrets.get(GRAPH_OWNER_CONTROL_SECRET);
 original.secrets.delete('conversation_graph_owned_publication');original.secrets.syncDurably();expect(()=>host.memberLossPlanningComponents()).toThrow('planning-publication-unverified');expect(original.secrets.get(GRAPH_OWNER_CONTROL_SECRET)).toEqual(control);
});
it('returns a large real held Source tail through fresh signed response pages without inventing Saved authority',async()=>{
 const phase=(name:string)=>fs.appendFileSync(path.join(process.cwd(),'.instar/state/build/owned-controller-response-phases.jsonl'),JSON.stringify({at:new Date().toISOString(),phase:name})+'\n');phase('start');
 const f=await fixture(),[host,follower]=f.defaults;for(const manager of f.defaults)await manager.ensureOwner({principalKey:'owner:echo',authenticationMethod:'owner-dashboard',requestId:'framed-tail-owner',isCurrent:()=>true});
 const runtime=host.runtime!,current=runtime.actuation(),membership=runtime.installedMembership,identity=f.native.managers[0];await runtime.prepareNativeTailClosure();
 let predecessorHash:string|null=null;
 for(let index=1;index<=620;index++){
  const eventId=`actual-tail-${index}-`+'x'.repeat(50),operationKey='graph-event:'+eventId,createdAt=new Date().toISOString(),core={schemaVersion:1,eventId,op:'set-primary-placement',subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42},parent:null,relation:null,replacesPlacementEventIds:[],authority:'owner',principal:'owner:echo',receipt:{kind:'owner-proof',id:`actual-tail-owner-${index}`},machineId:runtime.machineId,createdAt};
  const receipt=signGraphAuthorizationReceipt({v:1,agentId:'echo',eventId:operationKey,coreHash:canonicalHash(core),actorPrincipal:'owner:echo',authenticationMethod:'owner-dashboard',receiptId:core.receipt.id,membershipEpoch:membership.epoch,leaseEpoch:current.lease.leaseEpoch,idempotencyKey:`actual-tail-request-${index}`,writerId:runtime.machineId,fencedLeaseHash:canonicalHash(current.originalLease),acceptedAt:createdAt},identity.loadSigningKey()),authorizationProof={receipt,membership,...current},plaintext=encodeGraphSourceEnvelope('graph-event',core,authorizationProof,Buffer.from('actual local source; not witness Saved'));
  let encryptedSourceBundle;try{encryptedSourceBundle=sealGraphBundle(plaintext,membership.members,{agentId:'echo',eventId:operationKey});}finally{plaintext.fill(0);}
  const packet={coreType:'graph-event' as const,controlHash:canonicalHash(createGraphControlCapsule('graph-event',core,authorizationProof)),erasureIdentity:deriveGraphErasureIdentity('graph-event',core),agentId:'echo',eventId:operationKey,idempotencyKey:receipt.idempotencyKey,coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt),sourceSequence:index,predecessorHash,membershipEpoch:membership.epoch,leaseEpoch:current.lease.leaseEpoch,writerId:runtime.machineId,sourceBundleHash:canonicalHash(encryptedSourceBundle)},record={coreType:'graph-event' as const,packet,packetSignature:signGraphRecord(D.packet,packet,identity.loadSigningKey()),core,authorizationProof,encryptedSourceBundle};
  await follower.runtime!.source.receive(record,runtime.machineId);predecessorHash=packet.coreHash;
 }
 phase('source-620-persisted');expect(follower.runtime!.source.recordsForRepair()).toHaveLength(620);expect(follower.runtime!.source.recordsForRepair().every(record=>!record.preparationProof&&!record.certificate)).toBe(true);
 const control=f.secrets[0].get(GRAPH_OWNER_CONTROL_SECRET) as {privateKey:string},raw={...membership,epoch:2,previousMembershipHash:canonicalHash(membership)};delete raw.custodyProfile;const next={...raw,custodyProfile:createGraphCustodyProfile(raw,{mode:'owned-machine',witnessPublicKey:membership.custodyProfile!.witnessPublicKey,hostMachineId:runtime.machineId},control.privateKey),signature:''};next.signature=signGraphRecord(D.membership,unsigned(next),control.privateKey);
 const envelope=createGraphOwnerRecoveryEnvelope(control.privateKey,next),intentRaw={v:1 as const,agentId:'echo',previousMembership:membership,newMembership:next,ownerRecoveryHash:canonicalHash(envelope),issuedAt:new Date().toISOString()},intent={...intentRaw,signature:signGraphRecord(GRAPH_CUSTODY_INTENT_DOMAIN,intentRaw,control.privateKey)};
 phase('local-baseline-start');const command={kind:'hold',intent,ownerRecoveryEnvelope:envelope,previous:current},baseline=await follower.applyCustodyTransition(follower.runtime!.machineId,command) as {closedTail:GraphNativeTailClosure};phase('local-baseline-complete');const baselineBytes=Buffer.byteLength(canonicalJson(baseline));expect(baselineBytes).toBeGreaterThan(256*1024);fs.writeFileSync(path.join(process.cwd(),'.instar/state/build/owned-controller-frame-response-evidence.json'),JSON.stringify({v:1,phase:'before-signed-mesh-framed-call',logicalResponseBytes:baselineBytes,sourceRecords:620,sourceCustody:'recipient-local-signed-source-without-witness-prepare-or-cert',tailHash:baseline.closedTail.receipt.tailHash,originalNativeLeaseHash:canonicalHash(current.originalLease)}));expect(verifyGraphNativeTailClosure(baseline.closedTail,membership,current.lease)).toBe(true);
 phase('signed-first-start');const result=await host.applyCustodyTransition(follower.runtime!.machineId,command) as {closedTail:GraphNativeTailClosure};
 phase('signed-first-complete');expect(result.closedTail.entries).toHaveLength(620);expect(Buffer.byteLength(canonicalJson(result))).toBeGreaterThan(256*1024);expect(verifyGraphNativeTailClosure(result.closedTail,membership,current.lease)).toBe(true);
 // Loss of a derived response cache is UNKNOWN, then exact-command retry.
 // It is neither a durable job receipt nor permission to invent a new intent.
 (follower as unknown as {metadataFrames:{clear():void}}).metadataFrames.clear();
 const requestHash=canonicalHash(command),workId=canonicalHash({sender:runtime.machineId,requestHash}),status=await (host as unknown as {peer(target:string,action:'transition-work',body:unknown):Promise<{state:string}>}).peer(follower.runtime!.machineId,'transition-work',{workId,requestHash});expect(status.state).toBe('unknown');phase('derived-loss-status-unknown');
 phase('same-command-retry-start');const replay=await host.applyCustodyTransition(follower.runtime!.machineId,command) as {closedTail:GraphNativeTailClosure};expect(replay.closedTail.entries).toEqual(result.closedTail.entries);expect(verifyGraphNativeTailClosure(replay.closedTail,membership,current.lease)).toBe(true);phase('same-command-retry-complete');
},240000);
