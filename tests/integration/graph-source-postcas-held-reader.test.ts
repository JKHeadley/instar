import fs from 'node:fs';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {setupNativeMemberLossFixture} from '../helpers/graph-native-member-loss-fixture.js';
import {GraphNativeMemberLossStore} from '../../src/core/GraphNativeMemberLossStore.js';
import {GraphMemberLossHeldPreflight} from '../../src/core/GraphMemberLossHeldPreflight.js';
import {NativeDecommissionLeasePermit} from '../../src/core/NativeDecommissionLeasePermit.js';
import {canonicalHash,signGraphRecord,type GraphWitnessLease} from '../../src/core/GraphWitnessTypes.js';
function bridge(f:Awaited<ReturnType<typeof setupNativeMemberLossFixture>>,originalLease:NonNullable<ReturnType<typeof f.nativeOptions.leaseCoordinator.currentLease>>):GraphWitnessLease{const body={v:1 as const,agentId:'echo',membershipEpoch:f.context.previousMembership.epoch,leaseEpoch:originalLease.epoch,writerId:originalLease.holder,issuedAt:originalLease.acquiredAt,expiresAt:originalLease.expiresAt,fencedLeaseHash:canonicalHash(originalLease)};return{...body,signature:signGraphRecord('graph-lease-v1',body,f.survivor.loadSigningKey())};}
describe('actual post-CAS negative-held Source reader',()=>{
 it('streams a real Intake-only original after Native CAS, preserves no-ACK provenance, and closes on actual priority deny',async()=>{
  const f=await setupNativeMemberLossFixture(0,true),r=f.runtime,record=f.knownRecord!,coordinator=f.nativeOptions.leaseCoordinator;
  await r.intake.reserve(record.packet.idempotencyKey,canonicalHash('postcas-held-source-original'),()=>record);
  const holdReceipt=f.authority.beginMemberLossHold(f.intent,f.context,r.machineId,f.survivor.loadSigningKey()),snapshot=await r.source.verifyMemberLossInventory(r.reader,r.droppedOriginRegistry,r.intake,f.authority,f.intent),preflight=GraphMemberLossHeldPreflight.collect({authority:f.authority,snapshot,context:f.context,intent:f.intent,holds:[holdReceipt]}),floor=await f.store.captureNativeFloor(coordinator,f.intent,f.context),progress=f.store.beginNativeOperation(f.consent,f.context,f.intent,preflight,floor);
  let resumed:GraphMemberLossHeldPreflight|undefined;
  try{
   f.nativeOptions.identities.revokeDurably(f.removed,r.machineId,'synthetic Source reader member-loss fixture');const receipt=f.store.record(f.consent,f.context,f.intent),permit=NativeDecommissionLeasePermit.fromCommittedRevocations({store:f.store,coordinator,consent:f.consent,context:f.context,intent:f.intent,receipts:[receipt],floors:[floor]});expect(await coordinator.acquireOnOwnerDecommission(permit)).toBe(true);const originalLease=coordinator.currentLease()!,lease=bridge(f,originalLease),input={intent:f.intent,preflight,progress,coordinator,lease,originalLease};
   const result=await r.source.verifyMemberLossHeldSourceReader(r.reader,r.droppedOriginRegistry,r.intake,f.authority,input);expect(result.hold.nativeFloor).toBeUndefined();expect(result.reader.nativeLeaseHash).toBe(canonicalHash(lease));expect(progress.originalFloor).toEqual(floor);expect(result.reader.descriptors()).toMatchObject([{eventId:record.packet.eventId,originalSourceReceiptHash:null}]);const view=await result.reader.readRecord(record.packet.eventId);expect(view.packet).toEqual(record.packet);expect(view.packetSignature).toBe(record.packetSignature);expect(r.source.retainedOriginalSourceReceipt(record.packet.eventId)).toBeNull();result.reader.finalize();result.reader.assertFinalized();
   await expect(r.source.verifyMemberLossHeldSourceReader(r.reader,r.droppedOriginRegistry,r.intake,f.authority,{...input,coordinator:f.options[1].leaseCoordinator})).rejects.toThrow();await expect(r.source.verifyMemberLossHeldSourceReader(r.reader,r.droppedOriginRegistry,r.intake,f.authority,{...input,originalLease:floor.lease,lease:bridge(f,floor.lease)})).rejects.toThrow();
   expect(await coordinator.renew()).toBe(true);expect(coordinator.currentEpoch()).toBe(originalLease.epoch);result.reader.assertCurrent();result.reader.assertFinalized();
   const intermediateLease=coordinator.currentLease()!,intermediate=await r.source.verifyMemberLossHeldSourceReader(r.reader,r.droppedOriginRegistry,r.intake,f.authority,{...input,lease:bridge(f,intermediateLease),originalLease:intermediateLease});expect(await coordinator.renew()).toBe(true);intermediate.reader.assertCurrent();
   const coldStore=new GraphNativeMemberLossStore({stateDir:f.survivor.baseDir,identity:f.survivor,identities:f.nativeOptions.identities,instanceLock:f.nativeOptions.instanceLock,authority:f.authority}),coldProgress=coldStore.readProgressForIntent(f.intent,f.context)!;await expect(r.source.verifyMemberLossHeldSourceReader(r.reader,r.droppedOriginRegistry,r.intake,f.authority,{...input,progress:coldProgress,lease:bridge(f,intermediateLease),originalLease:intermediateLease})).rejects.toThrow();intermediate.reader.close();
   await r.eraseLocal(record.packet.erasureIdentity);expect(result.reader.closed).toBe(true);expect(view.encryptedSourceBundle).toBeNull();expect(()=>result.reader.assertFinalized()).toThrow();expect(r.source.retainedOriginalSourceReceipt(record.packet.eventId)).toBeNull();
   const fresh=await r.source.verifyMemberLossInventory(r.reader,r.droppedOriginRegistry,r.intake,f.authority,f.intent);resumed=GraphMemberLossHeldPreflight.resume({authority:f.authority,snapshot:fresh,context:f.context,intent:f.intent,holds:[holdReceipt],consent:f.consent,progress});const current=coordinator.currentLease()!,negative=await r.source.verifyMemberLossHeldSourceReader(r.reader,r.droppedOriginRegistry,r.intake,f.authority,{intent:f.intent,preflight:resumed,progress,coordinator,lease:bridge(f,current),originalLease:current});const control=await negative.reader.readRecord(record.packet.eventId);expect(control.encryptedSourceBundle).toBeNull();expect(control.erasure).toBeUndefined();expect(negative.reader.descriptors()[0].originalSourceReceiptHash).toBeNull();negative.reader.finalize();negative.reader.assertFinalized();negative.reader.close();
  }finally{preflight.close();resumed?.close();}
 });
 it('a change during the read window still refuses the removal at the full check',async()=>{
  const f=await setupNativeMemberLossFixture(0,true),r=f.runtime,record=f.knownRecord!,coordinator=f.nativeOptions.leaseCoordinator;
  await r.intake.reserve(record.packet.idempotencyKey,canonicalHash('postcas-held-source-original'),()=>record);
  const holdReceipt=f.authority.beginMemberLossHold(f.intent,f.context,r.machineId,f.survivor.loadSigningKey()),snapshot=await r.source.verifyMemberLossInventory(r.reader,r.droppedOriginRegistry,r.intake,f.authority,f.intent),preflight=GraphMemberLossHeldPreflight.collect({authority:f.authority,snapshot,context:f.context,intent:f.intent,holds:[holdReceipt]}),floor=await f.store.captureNativeFloor(coordinator,f.intent,f.context),progress=f.store.beginNativeOperation(f.consent,f.context,f.intent,preflight,floor);
  let resumed:GraphMemberLossHeldPreflight|undefined;
  try{
   f.nativeOptions.identities.revokeDurably(f.removed,r.machineId,'synthetic Source reader member-loss fixture');const receipt=f.store.record(f.consent,f.context,f.intent),permit=NativeDecommissionLeasePermit.fromCommittedRevocations({store:f.store,coordinator,consent:f.consent,context:f.context,intent:f.intent,receipts:[receipt],floors:[floor]});expect(await coordinator.acquireOnOwnerDecommission(permit)).toBe(true);const originalLease=coordinator.currentLease()!,lease=bridge(f,originalLease),input={intent:f.intent,preflight,progress,coordinator,lease,originalLease};
   const result=await r.source.verifyMemberLossHeldSourceReader(r.reader,r.droppedOriginRegistry,r.intake,f.authority,input);
   // A read inside the window may pass: it only gathers evidence. The full check before anything takes effect must not.
   fs.writeFileSync(path.join(f.survivor.baseDir,'state','conversation-graph-source','zz-changed-during-read.json'),'{}');
   await result.reader.readRecord(record.packet.eventId).catch(()=>null);
   expect(()=>preflight.assertCurrent()).toThrow();
  }finally{preflight.close();resumed?.close();}
 });
});
