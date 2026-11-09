import {GRAPH_REPLICATION_MAX_LEASE_EPOCH} from '../../src/core/ConversationGraphReplicationLimits.js';
import {newHeaderId} from '../../src/core/EffortHeaderStore.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {ConversationGraphSourceInventoryCapture} from '../../src/core/ConversationGraphSourceInventory.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ConversationRegistry} from '../../src/core/ConversationRegistry.js';
import {AppConversationService} from '../../src/core/AppConversationService.js';
import {MobileChatRequestStore} from '../../src/core/MobileChatRequests.js';
import {ConversationGraphSourceInventoryRuntime} from '../../src/server/ConversationGraphSourceInventoryRuntime.js';
import request from 'supertest';
import {describe,expect,it,vi} from 'vitest';
import {ConversationGraphReplicationRuntime} from '../../src/server/ConversationGraphReplicationRuntime.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {unsigned,canonicalHash,signGraphRecord,GRAPH_SIGNATURE_DOMAINS,witnessActionPayload} from '../../src/core/GraphWitnessTypes.js';
import {setupGraphRuntimeFixture as setup,runtimes,witnesses} from '../helpers/conversation-graph-runtime.js';
describe('actual graph source runtime + authenticated installed peer transport',()=>{
 it('routes custody transition proofs over the authenticated peer channel outside source mutation',async()=>{
  const {runtime,peer}=await setup();let actualSender:string|null=null;
  peer.setCustodyTransitionHandler(async(payload,sender)=>{actualSender=sender;return peer.withMutation(()=>({received:payload,recorder:peer.machineId}));});
  await expect(runtime.requestCustodyTransition(peer.machineId,{kind:'proof-request',nonce:'one'})).resolves.toEqual({received:{kind:'proof-request',nonce:'one'},recorder:peer.machineId});
  expect(actualSender).toBe(runtime.machineId);
  expect(()=>peer.setCustodyTransitionHandler(async()=>null)).toThrow('already-installed');
  await expect(peer.requestCustodyTransition(runtime.machineId,{kind:'proof-request'})).rejects.toThrow('graph-peer-unavailable');
 });

 it.each([false,true])('holds new native-writer allocation across an Intake-only tail=%s until every installed frozen tail is closed',async(intakeOnly)=>{
  const {runtime,peer,f,witness,options,leaseStores}=await setup();
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const first=f.record('before-native-transition'),prepare=vi.spyOn(witness,'prepare').mockRejectedValue(new Error('witness-unavailable-before-custody'));
  const sourceFailure=intakeOnly?vi.spyOn(runtime.source,'appendReserved').mockRejectedValue(new Error('fault-before-source-fsync')):null;
  const attempt=runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:first.coreType,idempotencyKey:first.packet.idempotencyKey,requestHash:canonicalHash('before-native-transition'),core:first.core,authorizationProof:first.authorizationProof,plaintextSource:Buffer.from('original frozen never-witnessed intent')},token));
  if(intakeOnly){await expect(attempt).rejects.toThrow('fault-before-source-fsync');expect(runtime.source.lookupByIdempotencyKey(first.packet.idempotencyKey)).toBeNull();sourceFailure!.mockRestore();}else expect((await attempt).state).toBe('checking-save');
  const original=runtime.source.lookupByIdempotencyKey(first.packet.idempotencyKey)??(await runtime.intake.reservations())[0];expect(original.packet.sourceSequence).toBe(1);expect(original.preparationProof).toBeUndefined();prepare.mockRestore();
  expect(await options[1].leaseCoordinator.acquireOnConsent(runtime.machineId)).toBe(true);
  const current=peer.actuation();expect(current.originalLease.epoch).toBe(2);
  // Actual native higher epoch must be durably visible to the old member, not
  // an injected holdsLease boolean. Its old immutable Source remains intact.
  expect(leaseStores[0].casWrite(current.originalLease).ok).toBe(true);
  expect(await peer.refreshReadiness()).toBe(true);
  const candidate=f.record('after-native-transition'),core={...candidate.core,machineId:peer.machineId,createdAt:new Date().toISOString()};
  const receipt=signGraphAuthorizationReceipt({...unsigned(candidate.authorizationProof.receipt),coreHash:canonicalHash(core),writerId:peer.machineId,leaseEpoch:2,fencedLeaseHash:canonicalHash(current.originalLease),acceptedAt:new Date().toISOString()},f.members[1].signing.privateKey);
  const proof={receipt,membership:f.membership,...current};
  const before=await peer.intake.reservations();
  await expect(peer.withSourceMutation(token=>peer.submitPrepared({coreType:candidate.coreType,idempotencyKey:candidate.packet.idempotencyKey,requestHash:canonicalHash('after-native-transition'),core,authorizationProof:proof,plaintextSource:Buffer.from('new writer intent')},token))).rejects.toThrow('tail');
  expect(await peer.intake.reservations()).toEqual(before);expect(peer.source.lookupByIdempotencyKey(candidate.packet.idempotencyKey)).toBeNull();
  if(!intakeOnly)expect(runtime.source.repairRecord(original.packet.eventId)?.packet).toEqual(original.packet);
  if(intakeOnly)expect(peer.source.retainedOriginalSourceReceipt(original.packet.eventId)).toBeNull();
  const recovered=await peer.reconcilePending();expect(recovered).toContainEqual({eventId:original.packet.eventId,state:'committed'});const preserved=peer.source.repairRecord(original.packet.eventId)!;expect(preserved.packet).toEqual(original.packet);expect(preserved.packetSignature).toBe(original.packetSignature);expect(preserved.authorizationProof).toEqual(original.authorizationProof);
  const nextCore={...core,replacesPlacementEventIds:[String(first.core.eventId)],createdAt:new Date().toISOString()},nextReceipt=signGraphAuthorizationReceipt({...unsigned(receipt),coreHash:canonicalHash(nextCore),acceptedAt:new Date().toISOString()},f.members[1].signing.privateKey);
  const outcome=await peer.withSourceMutation(token=>peer.submitPrepared({coreType:candidate.coreType,idempotencyKey:candidate.packet.idempotencyKey,requestHash:canonicalHash('after-native-transition'),core:nextCore,authorizationProof:{...proof,receipt:nextReceipt},plaintextSource:Buffer.from('after recovered original prefix')},token));expect(outcome.state).toBe('committed');expect(peer.source.lookupByIdempotencyKey(candidate.packet.idempotencyKey)?.packet.sourceSequence).toBe(2);
 });

 it('bounds the unique source plus reservation population before allocating a third global source slot',async()=>{
  const fixture=await setup(),{f,peer,witness,options}=fixture;await fixture.runtime.close();
  const runtime=await ConversationGraphReplicationRuntime.open({...options[0],configuration:{...options[0].configuration!,maxHistoryEntries:2}});if(!runtime)throw new Error('missing runtime');runtimes.push(runtime);
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const submit=(id:string)=>{const r=f.record(id);return runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash(id),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('bounded real source')},token));};
  expect((await submit('capacity-a')).state).toBe('committed');expect((await submit('capacity-b')).state).toBe('committed');
  const before=await runtime.intake.reservations(),prepare=vi.spyOn(witness,'prepare');await expect(submit('capacity-c')).rejects.toThrow('history-capacity');expect(prepare).not.toHaveBeenCalled();expect(await runtime.intake.reservations()).toEqual(before);expect(runtime.source.lookupByIdempotencyKey('idempotency-capacity-c')).toBeNull();expect((await runtime.source.controlIntents()).some(record=>record.packet.idempotencyKey==='idempotency-capacity-c')).toBe(false);
  expect((await submit('capacity-a')).state).toBe('committed');prepare.mockRestore();
 });
 it('keeps missing configuration inert and repairs readiness only from signed full witness inventory before reads',async()=>{
  const fixture=await setup();const {f,runtime,peer,witness,options}=fixture;
  expect(await ConversationGraphReplicationRuntime.open({...options[0],configuration:undefined})).toBeNull();
  expect(()=>runtime.projection()).toThrow('not-ready');expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const record=f.record();await runtime.prepareNativeTailClosure();const local=await runtime.source.appendLocal(record);
  const prepared={controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),packet:record.packet,packetSignature:record.packetSignature,encryptedSourceBundle:record.encryptedSourceBundle!,...runtime.actuation()};await witness.prepare(prepared);
  const member=runtime.member(peer.machineId)!;const remote=await member.receiveSource(record);
  const certificate=await witness.commit(prepared,f.membership,[local.receipt,remote]);const wa=await runtime.source.attachCertificate(record.packet.eventId,certificate);
  const pa=await member.persistCertificate(record,certificate);await runtime.source.recordCertificateReceipt(record.packet.eventId,pa);await peer.source.recordCertificateReceipt(record.packet.eventId,wa);
  await witness.acknowledgeCertificate(record.packet.idempotencyKey,wa);await witness.acknowledgeCertificate(record.packet.idempotencyKey,pa);
  const committed=runtime.source.repairRecord(record.packet.eventId)!;const delivered=await member.persistCommitProof(committed);expect(delivered.machineId).toBe(peer.machineId);
  await runtime.drainJournal();expect(await runtime.refreshReadiness()).toBe(true);expect(runtime.projection().records).toHaveLength(1);
  expect(await peer.refreshReadiness()).toBe(true);expect(peer.projection().records).toHaveLength(1);
  const bad=structuredClone(record);bad.core.title='must refuse header leakage';await expect(member.receiveSource(bad)).rejects.toThrow();
  expect((await request(fixture.apps[1]).post('/internal/conversation-graph/replicate').send({body:{record}})).status).toBe(401);
  expect((await request(fixture.apps[1]).post('/internal/conversation-graph/replicate').set('Authorization','Bearer runtime-peer-auth').send({body:{record}})).status).toBe(409);
  fixture.service.close();witnesses.splice(witnesses.indexOf(fixture.service),1);
  expect(await runtime.refreshReadiness()).toBe(false);expect(()=>runtime.projection()).toThrow('not-ready');
  expect(runtime.retainedProjection()).toMatchObject({partial:true,olderRevision:true});expect(runtime.retainedProjection().records).toHaveLength(1);
  const restored=await ConversationGraphReplicationRuntime.open(options[0]);if(!restored)throw new Error('restored-missing');runtimes.push(restored);
  expect(()=>restored.retainedProjection()).toThrow('retained-unavailable');expect(await restored.refreshReadiness()).toBe(false);
  await runtime.close();expect(runtime.isReady()).toBe(false);await expect(member.receiveSource(record)).rejects.toThrow();
 });
 it('withdraws availability when a signed member is lost or the real lifetime lock is released, but not for a machine paired later',async()=>{
  const {runtime,options,managers}=await setup();expect(await runtime.refreshReadiness()).toBe(true);
  const registry=managers[0].loadRegistry();registry.machines.extra={...Object.values(registry.machines)[0],name:'extra',status:'active'};managers[0].saveRegistry(registry);
  // A machine paired later is not a member yet, so it must not stop the members.
  expect(runtime.isReady()).toBe(true);delete registry.machines.extra;managers[0].saveRegistry(registry);
  // Losing a signed member does stop them.
  const peerId=managers[1].loadIdentity().machineId,peerRow=registry.machines[peerId];delete registry.machines[peerId];managers[0].saveRegistry(registry);
  expect(runtime.isReady()).toBe(false);expect(()=>runtime.actuation()).toThrow('write-fenced');
  registry.machines[peerId]=peerRow;managers[0].saveRegistry(registry);expect(runtime.isReady()).toBe(true);
  options[0].instanceLock.release();expect(runtime.isReady()).toBe(false);expect(()=>runtime.projection()).toThrow('not-ready');
 });
 it('judges a reserved row by what Source holds now, not by the copy taken before the witness answered',async()=>{
  const {f,runtime,peer}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);await runtime.prepareNativeTailClosure();
  const record=f.record('reserved-older-lease'),input={coreType:'graph-event' as const,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash({core:record.core,source:'reserved'}),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('reserved source')};
  const outcome=await runtime.withSourceMutation(token=>runtime.submitPrepared(input,token));const held=runtime.source.repairRecord(outcome.eventId)!;expect(held.preparationProof).toBeTruthy();
  const ensure=(runtime as unknown as {ensureNativeTailClosed():Promise<void>}),olderCopy={...held,packet:{...held.packet,leaseEpoch:held.packet.leaseEpoch-1}};delete (olderCopy as Partial<typeof olderCopy>).preparationProof;delete (olderCopy as Partial<typeof olderCopy>).certificate;
  const frozen=vi.spyOn(runtime.intake,'frozenReservations').mockResolvedValue([olderCopy as never]);
  try{
   await expect(ensure.ensureNativeTailClosed()).resolves.toBeUndefined();
   // The same row with nothing in Source really is unfinished work from an older lease.
   const unknown={...olderCopy,packet:{...olderCopy.packet,eventId:'not-in-source-event'}};frozen.mockResolvedValue([unknown as never]);
   await expect(ensure.ensureNativeTailClosed()).rejects.toThrow('graph-native-tail-recovery-required');
  }finally{frozen.mockRestore();}
 });
 it('builds one origin row without building every other row',async()=>{
  const {f,runtime,peer}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);await runtime.prepareNativeTailClosure();
  const record=f.record('origin-row'),input={coreType:'graph-event' as const,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash({core:record.core,source:'origin'}),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('origin source')};
  const outcome=await runtime.withSourceMutation(token=>runtime.submitPrepared(input,token)),all=runtime.source.originRecords();
  expect(runtime.source.originRecordKeys().sort()).toEqual(all.map(row=>row.envelope.recordKey).sort());
  expect(runtime.source.originRecordsFor(outcome.eventId)).toEqual(all.filter(row=>row.envelope.recordKey===outcome.eventId));expect(runtime.source.originRecordsFor('unknown-event')).toEqual([]);
  const describe=vi.spyOn(runtime.source,'descriptorFor');try{runtime.source.originRecordsFor(outcome.eventId);expect(describe.mock.calls.length).toBeLessThanOrEqual(2);}finally{describe.mockRestore();}
 });
 it('uses one actual mutation queue, durable reservation allocator and authenticated allmember coordinator for producer intake',async()=>{
  const {f,runtime,peer}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const record=f.record();const input={coreType:'graph-event' as const,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash({core:record.core,source:'actual producer'}),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('actual producer source')};
  await expect(runtime.submitPrepared(input,Symbol('forged-token'))).rejects.toThrow('not-admitted');
  const result=await runtime.withSourceMutation(token=>runtime.submitPrepared(input,token));expect(result.state).toBe('committed');
  expect(runtime.source.allCommitProofDelivered(record.packet.eventId)).toBe(true);expect(peer.source.status(record.packet.eventId).state).toBe('committed');
  const replay=await runtime.withSourceMutation(token=>runtime.submitPrepared(input,token));expect(replay.state).toBe('committed');
  expect((await runtime.intake.reservations())).toHaveLength(1);
  expect(await runtime.refreshReadiness()).toBe(true);expect(runtime.projection().records).toHaveLength(1);
 });

 it.each([{withoutTelegram:false},{withoutTelegram:true}])('takes over witnessed pending source under a real new native lease without changing membership or original authority: %j',async({withoutTelegram})=>{
  const {f,runtime,peer,managers,leaseStores}=await setup({withoutTelegram});expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  await runtime.prepareNativeTailClosure();
  const registry=managers[0].loadRegistry();const old=registry.machines[peer.machineId].endpoints;registry.machines[peer.machineId].endpoints=[];delete registry.machines[peer.machineId].lastKnownUrl;managers[0].saveRegistry(registry);
  const record=f.record();const input={coreType:'graph-event' as const,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash({core:record.core,source:'takeover'}),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('takeover source')};
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared(input,token))).state).toBe('saved-pending');
  const saved=runtime.source.repairRecord(record.packet.eventId)!;await peer.source.receive(saved,runtime.machineId);
  registry.machines[peer.machineId].endpoints=old;managers[0].saveRegistry(registry);
  const native=f.actuation(peer.machineId,2).originalLease;leaseStores[0].casWrite(native);leaseStores[1].casWrite(native);
  expect(await peer.refreshReadiness()).toBe(true);const results=await peer.reconcilePending();
  // Without Telegram the recovery path must still exist. This row's subject is a Telegram topic, which nothing can verify there, so it stays held rather than being adopted.
  if(withoutTelegram){expect((peer as unknown as {recovery?:unknown}).recovery).toBeTruthy();expect(results).toContainEqual({eventId:record.packet.eventId,state:'held'});return;}
  expect(results).toContainEqual({eventId:record.packet.eventId,state:'committed'});
  const recovered=peer.source.repairRecord(record.packet.eventId)!;expect(recovered.packet).toEqual(saved.packet);expect(recovered.authorizationProof).toEqual(saved.authorizationProof);
  expect(recovered.adoption?.newMembership.epoch).toBe(1);expect(recovered.adoption?.currentLease.leaseEpoch).toBe(2);expect(peer.source.allCommitProofDelivered(record.packet.eventId)).toBe(true);
 });

 it('captures actual follower flat rows and forwards signed observations through real peer/native/all-member durability',async()=>{
  const {runtime,peer,managers,f}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const identity=managers[1];const registry=new ConversationRegistry({stateDir:identity.baseDir,machineId:()=>peer.machineId});
  const requests=new MobileChatRequestStore(identity.baseDir);const service=new AppConversationService({stateDir:identity.baseDir,machineId:()=>peer.machineId,registry,requests,holdsLease:()=>false,ownerName:()=> 'Owner',dispatch:()=>null});
  const lastActivity=new Date().toISOString();const flatDeps={config:{stateDir:identity.baseDir} as never,pairing:null as never,service,machineId:()=>peer.machineId,telegramTopics:()=>[{topicId:42,topicName:'actual follower topic',lastActivity}]};
  const worker=new ConversationGraphSourceInventoryRuntime({flatDeps,conversations:registry,runtime:peer,identity,membership:()=>f.membership,ownerPublicKey:f.owner.publicKey,telegramChatId:'-1001'});
  try{const status=await worker.tick();expect(status.failed).toBe(0);expect(status.committed).toBeGreaterThanOrEqual(2);
   const rows=peer.inventory();expect(rows.conversations).toHaveLength(1);expect(rows.entries[0].row.title).toBe('actual follower topic');
   expect(runtime.source.recordsForRepair()[0].authorizationProof.sourceObservation?.producerMachineId).toBe(peer.machineId);
   expect(runtime.source.recordsForRepair()[0].packet.writerId).toBe(runtime.machineId);
  }finally{await worker.close();await registry.close();}
 });

 it('replays the first frozen reservation to the real witness before later source sequence can be Saved',async()=>{
  const {f,runtime,peer,witness}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const input=(rawId:string)=>{const r=f.record(rawId);if(rawId==='second-after-outage'){r.core={...r.core,subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:43}};r.authorizationProof={...r.authorizationProof,receipt:signGraphAuthorizationReceipt({...unsigned(r.authorizationProof.receipt),coreHash:canonicalHash(r.core)},f.members[0].signing.privateKey)};}return {coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash(rawId),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('actual retained source')};};
  const prepare=vi.spyOn(witness,'prepare');prepare.mockRejectedValueOnce(new Error('simulated transport interrupted before witness persistence'));
  const first=await runtime.withSourceMutation(token=>runtime.submitPrepared(input('first-frozen'),token));expect(first.state).toBe('checking-save');
  const frozen=runtime.source.lookupByIdempotencyKey(first.idempotencyKey)!;expect(frozen.preparationProof).toBeUndefined();
  const second=await runtime.withSourceMutation(token=>runtime.submitPrepared(input('second-after-outage'),token));expect(second.state).toBe('committed');
  expect((await witness.operation(first.idempotencyKey)).packet).toEqual(frozen.packet);
  expect(runtime.source.lookupByIdempotencyKey(first.idempotencyKey)?.packetSignature).toBe(frozen.packetSignature);
  expect(runtime.projection().records).toHaveLength(2);prepare.mockRestore();
 });

 it('physically purges local source and reserved ciphertext while witness is unavailable, without fleet acknowledgment',async()=>{
  const {runtime,peer,f,service,options}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const r=f.record();await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash('local forget'),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('private source')},token));
  const stored=runtime.source.lookupByIdempotencyKey(r.packet.idempotencyKey)!;service.close();witnesses.splice(witnesses.indexOf(service),1);
  await runtime.eraseLocal(stored.packet.erasureIdentity);expect(()=>runtime.source.openVerifiedPayload(stored)).toThrow('locally-erased');
  expect(runtime.source.repairRecord(stored.packet.eventId)?.erasure).toBeUndefined();expect(runtime.retainedProjection().records.map(r=>r.packet.eventId)).toEqual([stored.packet.eventId]);
  const sourceDir=path.join(options[0].stateDir,'state','conversation-graph-source');expect((await fs.readdir(sourceDir)).some(n=>n.includes('.bundle.json')||n.includes('.rewrap-'))).toBe(false);
  expect(await runtime.intake.reservations()).toEqual([]);
 });

 it('revalidates same-lease witnessed Pending heads and certifies refusal instead of a stale second placement',async()=>{
  const {runtime,peer,f}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const unavailable=vi.spyOn(runtime,'member').mockReturnValue(undefined);
  const save=async(id:string)=>{const r=f.record(id);return runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash(id),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('owner frozen intent')},token));};
  const first=await save('first-proposed'),second=await save('stale-proposed');expect(first.state).toBe('saved-pending');expect(second.state).toBe('saved-pending');
  const epoch=runtime.actuation().lease.leaseEpoch;unavailable.mockRestore();const result=await runtime.reconcilePending();
  expect(runtime.actuation().lease.leaseEpoch).toBe(epoch);expect(result).toEqual([{eventId:first.eventId,state:'committed'},{eventId:second.eventId,state:'canceled'}]);
  const stale=runtime.source.repairRecord(second.eventId)!;expect(stale.certificate).toBeUndefined();expect(stale.adoption?.revalidation.reason).toBe('stale-heads');expect(stale.cancellationCertificate?.outcome).toBe('canceled');
  expect(runtime.projection().records.map(r=>r.packet.eventId)).toEqual([first.eventId]);
 });

 it('refuses delayed signed producer capture before reserving a new source sequence',async()=>{
  const {runtime,peer,managers,f}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const identity=managers[1],registry=new ConversationRegistry({stateDir:identity.baseDir,machineId:()=>peer.machineId}),requests=new MobileChatRequestStore(identity.baseDir);
  const service=new AppConversationService({stateDir:identity.baseDir,machineId:()=>peer.machineId,registry,requests,holdsLease:()=>false,ownerName:()=> 'Owner',dispatch:()=>null});let title='old title';const lastActivity=new Date().toISOString();
  const flat={config:{stateDir:identity.baseDir} as never,pairing:null as never,service,machineId:()=>peer.machineId,telegramTopics:()=>[{topicId:42,topicName:title,lastActivity}]};
  const capture=new ConversationGraphSourceInventoryCapture({agentId:'echo',identity,ownerPublicKey:f.owner.publicKey,membership:()=>f.membership,flat,registry,telegramChatId:'-1001',localErasure:peer.localErasure,acceptedInventory:()=>({source:peer.source,reader:peer.reader,dropped:peer.droppedOriginRegistry})});
  try{const old=capture.capturePage().observations[0];title='new certified title';const newer=capture.capturePage().observations[0];expect(newer.capture.producerSequence).toBeGreaterThan(old.capture.producerSequence);
   expect((await peer.observe(newer)).state).toBe('committed');const reservations=(await runtime.intake.reservations()).length;
   await expect(peer.observe(old)).rejects.toThrow();expect((await runtime.intake.reservations()).length).toBe(reservations);
   expect(peer.inventory().entries[0].row.title).toBe('new certified title');
  }finally{await registry.close();}
 });

 it('closes an erased original frozen slot after a crash before source publication before later Saved',async()=>{
  const {runtime,peer,f,witness}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const original=f.record('intent-before-body'),source=runtime.source as unknown as {save:(name:string,value:unknown,immutable?:boolean)=>Promise<void>};
  const save=source.save.bind(source);let interrupted=false;
  const fault=vi.spyOn(source,'save').mockImplementation(async(name,value,immutable)=>{await save(name,value,immutable);if(name.endsWith('.intent.json')&&!interrupted){interrupted=true;await runtime.localErasure.deny(original.packet.erasureIdentity);throw new Error('simulated crash after intent fsync');}});
  await expect(runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:original.coreType,idempotencyKey:original.packet.idempotencyKey,requestHash:canonicalHash('crash-intent'),core:original.core,authorizationProof:original.authorizationProof,plaintextSource:Buffer.from('private erased before publication')},token))).rejects.toThrow('simulated crash');fault.mockRestore();
  const frozen=(await runtime.source.controlIntents())[0];expect(frozen.packet.sourceSequence).toBe(1);expect(runtime.source.recordsForRepair()).toHaveLength(0);
  await runtime.erasure.acceptOwner({requestId:'erase-before-source',target:frozen.packet.erasureIdentity,principalKey:'actual-owner',authenticationMethod:'owner-dashboard'});
  const second=f.record('after-erased-intent');second.core={...second.core,subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:43}};
  second.authorizationProof={...second.authorizationProof,receipt:signGraphAuthorizationReceipt({...unsigned(second.authorizationProof.receipt),coreHash:canonicalHash(second.core)},f.members[0].signing.privateKey)};
  const result=await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:second.coreType,idempotencyKey:second.packet.idempotencyKey,requestHash:canonicalHash('after-erasure'),core:second.core,authorizationProof:second.authorizationProof,plaintextSource:Buffer.from('unrelated source')},token));
  expect(result.state,JSON.stringify({result,records:runtime.source.recordsForRepair().map(r=>({id:r.packet.eventId,prepare:!!r.preparationProof,erased:!!r.erasedControlProof,terminal:!!r.cancellationCertificate}))})).toBe('committed');const terminal=await witness.operation(frozen.packet.idempotencyKey);
  expect(terminal.packet).toEqual(frozen.packet);expect(terminal.prepareProof).toBeNull();expect(terminal.erasedControlProof).not.toBeNull();expect(terminal.cancellationCertificate?.outcome).toBe('erased');
  expect(runtime.source.repairRecord(result.eventId)?.packet.sourceSequence).toBe(2);expect(runtime.projection().records.map(record=>record.packet.eventId)).toEqual([result.eventId]);
 });

 it('derives only the certified opaque header erase target on fresh boot while witness is offline',async()=>{
  const {runtime,peer,f,options,service}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const effort={kind:'effort' as const,id:'81111111-1111-4111-8111-111111111111'},headerId=newHeaderId(),original=f.record('offline-forget-create');
  const creator={schemaVersion:1,eventId:'offline-forget-create',op:'create-effort',subject:effort,headerId,projectScope:[],authority:'owner',principal:'owner',receipt:original.core.receipt,machineId:runtime.machineId,createdAt:original.core.createdAt};
  const proof={...original.authorizationProof,receipt:signGraphAuthorizationReceipt({...unsigned(original.authorizationProof.receipt),coreHash:canonicalHash(creator)},f.members[0].signing.privateKey)};
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:'graph-event',idempotencyKey:original.packet.idempotencyKey,requestHash:canonicalHash('offline-forget-create'),core:creator,authorizationProof:proof,plaintextSource:Buffer.from('opaque owner intent')},token))).state).toBe('committed');
  await runtime.close();service.close();witnesses.splice(witnesses.indexOf(service),1);
  const cold=await ConversationGraphReplicationRuntime.open(options[0]);if(!cold)throw new Error('missing-cold-runtime');runtimes.push(cold);
  expect(cold.readiness().retained).toBe(false);expect(await cold.refreshReadiness()).toBe(false);
  expect(()=>cold.retainedProjection()).toThrow();expect(cold.erasureHeaderId(effort)).toBe(headerId);
  expect(cold.erasureHeaderId({kind:'effort',id:'unknown'})).toBeNull();expect(cold.erasureHeaderId({...effort,title:'caller cannot choose target'})).toBeNull();
  await cold.eraseLocal({sourceKind:'header',sourceId:headerId});expect(cold.localErasure.isDenied({sourceKind:'header',sourceId:headerId})).toBe(true);
  expect(cold.readiness().retained).toBe(false);expect(()=>cold.projection()).toThrow();
 });

 it('does not hide or purge for a signed tombstone absent from the actual witness authority ledger',async()=>{
  const {runtime,peer,f}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);const r=f.record('not-in-witness-erasure-ledger');
  const result=await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash('not-in-ledger'),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('must survive invalid erasure authority')},token));expect(result.state).toBe('committed');
  const record=runtime.source.repairRecord(result.eventId)!,raw={v:1 as const,agentId:'echo',requestId:'forged-ledger-presence',target:record.packet.erasureIdentity,bundleHashes:[],membershipEpoch:1,leaseEpoch:1,authorizationReceiptHash:record.packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:new Date().toISOString()};
  const proof={...raw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,raw,f.witness.privateKey)};
  await expect(runtime.localFleetPurge(proof.target,proof)).rejects.toThrow();expect(runtime.localErasure.isDenied(proof.target)).toBe(false);expect(runtime.source.isErased(proof.target)).toBe(false);
  const payload=runtime.source.openVerifiedPayload(record);expect(payload.toString()).toBe('must survive invalid erasure authority');payload.fill(0);
 });

 it('checks a fresh final witness inventory and applies erasure arriving during awaited catch-up',async()=>{
  const {runtime,peer,f,witness,service}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);const r=f.record('erasure-during-catchup');
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash('during-catchup'),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('must never reappear after late witness erase')},token))).state).toBe('committed');
  const record=runtime.source.lookupByIdempotencyKey(r.packet.idempotencyKey)!,operation=witness.operation.bind(witness);let erased=false;
  const inventory=vi.spyOn(witness,'inventory'),race=vi.spyOn(witness,'operation').mockImplementation(async key=>{const response=await operation(key);if(!erased){erased=true;const current=runtime.actuation(),input={requestId:'late-catchup-erase',target:record.packet.erasureIdentity,bundleHashes:[],authorizationReceiptHash:canonicalHash('actual owner erase during catchup')};service.erase('echo',input.requestId,input.target,[],input.authorizationReceiptHash,current.lease,current.originalLease,signGraphRecord(GRAPH_SIGNATURE_DOMAINS.action,witnessActionPayload('erase',input,current.lease),f.members[0].signing.privateKey));}return response;});
  try{expect(await runtime.refreshReadiness()).toBe(true);expect(inventory.mock.calls).toHaveLength(2);expect(inventory.mock.calls[0][0]).not.toBe(inventory.mock.calls[1][0]);expect(runtime.source.isErased(record.packet.erasureIdentity)).toBe(true);expect(runtime.source.repairRecord(record.packet.eventId)?.encryptedSourceBundle).toBeNull();expect(()=>runtime.source.openVerifiedPayload(record)).toThrow();}finally{race.mockRestore();inventory.mockRestore();}
 });

 it('refuses graph capacity before source or witness ACK when the actual native counter exceeds its declared subset',async()=>{
  const {runtime,peer,f,witness,leaseStores,options}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const submit=(id:string)=>{const r=f.record(id);return runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash(id),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('old saved source must remain repairable')},token));};
  const saved=await submit('saved-before-capacity');expect(saved.state).toBe('committed');const original=runtime.source.repairRecord(saved.eventId)!,prepare=vi.spyOn(witness,'prepare');
  const preceding=f.actuation(peer.machineId,GRAPH_REPLICATION_MAX_LEASE_EPOCH).originalLease;expect(leaseStores[0].casWrite(preceding).ok).toBe(true);expect(await options[0].leaseCoordinator.acquireOnConsent(peer.machineId)).toBe(true);expect(options[0].leaseCoordinator.currentEpoch()).toBe(GRAPH_REPLICATION_MAX_LEASE_EPOCH+1);expect(options[0].leaseCoordinator.holdsLease()).toBe(true);
  expect(()=>runtime.actuation()).toThrow('epoch-capacity');await expect(submit('unadmitted-huge-counter')).rejects.toThrow('epoch-capacity');expect(prepare).not.toHaveBeenCalled();expect(runtime.source.lookupByIdempotencyKey('idempotency-unadmitted-huge-counter')).toBeNull();expect((await runtime.intake.reservations()).some(record=>record.packet.idempotencyKey==='idempotency-unadmitted-huge-counter')).toBe(false);
  expect((await witness.operation(original.packet.idempotencyKey)).certificate).toEqual(original.certificate);const payload=runtime.source.openVerifiedPayload(original);expect(payload.toString()).toBe('old saved source must remain repairable');payload.fill(0);prepare.mockRestore();
 });

 it('verifies the removal history once per readiness stretch and reads it again after any await', async () => {
  // Real Studio + M5 run (2026-11-09): after a removal the readiness pass read
  // and verified the whole removal history once per manifest record. It now
  // reuses one read only across records reached with no await in between.
  const {runtime,peer,f}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const save=(id:string)=>{const r=f.record(id);return runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:r.coreType,idempotencyKey:r.packet.idempotencyKey,requestHash:canonicalHash(id),core:r.core,authorizationProof:r.authorizationProof,plaintextSource:Buffer.from('lineage reuse source')},token));};
  const ids:string[]=[];for(const id of ['event-aaa','event-bbb','event-ccc']){const outcome=await save(id);expect(outcome.state).toBe('committed');ids.push(outcome.eventId);}
  for(let i=0;i<2;i++){expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);}
  const settled=(runtime as unknown as {settledRecords:Map<string,string>}).settledRecords;expect(ids.every(id=>settled.has(id))).toBe(true);
  let reads=0;const checked:string[]=[],used=new Map<string,number>();
  (runtime.source as unknown as {historicalImportAuthority:unknown}).historicalImportAuthority={
   verifiedNegativeRoleLineage:()=>{reads++;return {read:reads,memberLossActivations:[]};},
   assertMemberLossRepairAllowed:(record:{packet:{eventId:string}},lineage?:{read:number})=>{if(!lineage)throw new Error('per-record lineage read');checked.push(record.packet.eventId);used.set(record.packet.eventId,lineage.read);},
  };
  try{
   // Every record settled: no await between records, so one read serves all three.
   expect(await runtime.refreshReadiness()).toBe(true);expect(reads).toBe(1);expect(checked.filter(id=>ids.includes(id))).toEqual(ids);
   // The middle record now awaits the witness, so the record after it reads the history again.
   reads=0;checked.length=0;settled.delete(ids[1]);
   expect(await runtime.refreshReadiness()).toBe(true);expect(checked.filter(id=>ids.includes(id))).toEqual(ids);expect(reads).toBe(2);
   expect(ids.map(id=>used.get(id))).toEqual([1,1,2]);
   // A history that fails to verify still stops readiness.
   (runtime.source as unknown as {historicalImportAuthority:{verifiedNegativeRoleLineage:()=>unknown}}).historicalImportAuthority.verifiedNegativeRoleLineage=()=>{throw new Error('lineage-invalid');};
   checked.length=0;const repairRead=vi.spyOn(runtime.source,'repairLineage');
   expect(await runtime.refreshReadiness()).toBe(false);expect((runtime as unknown as {lastReadinessFailure:string|null}).lastReadinessFailure).toBe('lineage-invalid');expect(repairRead).toHaveBeenCalledTimes(1);expect(checked).toEqual([]);repairRead.mockRestore();
  }finally{(runtime.source as unknown as {historicalImportAuthority:unknown}).historicalImportAuthority=undefined;}
 });

});
