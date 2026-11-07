import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import os from 'node:os';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {LiveConfig} from '../../src/config/LiveConfig.js';
import {readConversationGraphOwnerPolicy,initializeConversationGraphOwnerPolicy} from '../../src/core/ConversationGraphOwnerPolicy.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {ConversationGraphOwnerGrantStore} from '../../src/server/ConversationGraphOwnerGrant.js';
import {createConversationGraphOwnerAdmission} from '../../src/server/ConversationGraphOwnerAdmission.js';
/** Real native identities/locks/Source/W/peer transport; queue assertions never
 * substitute a mocked success receipt for canonical commitment. */
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {setupGraphRuntimeFixture as setup,runtimes,witnesses} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphReplicationRuntime} from '../../src/server/ConversationGraphReplicationRuntime.js';
import type {GraphLocalOwnerIntentInput,GraphLocalOwnerIntent} from '../../src/core/ConversationGraphQueuedIntent.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {canonicalHash,unsigned} from '../../src/core/GraphWitnessTypes.js';
import {newHeaderId} from '../../src/core/EffortHeaderStore.js';
function input(key='offline-opaque-owner-intent'):GraphLocalOwnerIntentInput{return {idempotencyKey:key,requestId:'request-offline-01',principalKey:'owner',grantVersion:'owner-grant-v1',surface:'mobile',admission:{kind:'owner-device',deviceId:'device-owner',identity:{keyHash:'a'.repeat(64),userId:'owner-user',role:'owner'}},change:{kind:'create-effort',projectScope:['instar']}};}
describe('actual runtime local pre-admission Pending',()=>{
 it('keeps a restored private intent opaque and unpromoted even after actual witness readiness until fresh same-body owner admission',async()=>{
  const {runtime,peer,options,f}=await setup();const original=f.record('restored-private-queue'),request=input(original.packet.idempotencyKey);await runtime.recordLocalOwnerIntent(request,()=>true);expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);await runtime.close();
  const restored=await ConversationGraphReplicationRuntime.open(options[0]);if(!restored)throw new Error('missing restored runtime');runtimes.push(restored);expect(await restored.refreshReadiness()).toBe(true);
  const execute=vi.fn(async(intent:GraphLocalOwnerIntent,token:symbol)=>{if(intent.change.kind!=='create-effort'||!intent.createdEffort)throw new Error('unexpected owner intent');const current=restored.actuation(),core={schemaVersion:1,eventId:'restored-private-queue',op:'create-effort',subject:intent.createdEffort.ref,headerId:intent.createdEffort.headerId,projectScope:intent.change.projectScope,authority:'owner',principal:'owner',receipt:original.core.receipt,machineId:restored.machineId,createdAt:new Date().toISOString()},receipt=signGraphAuthorizationReceipt({...unsigned(original.authorizationProof.receipt),coreHash:canonicalHash(core),acceptedAt:core.createdAt,leaseEpoch:current.lease.leaseEpoch,fencedLeaseHash:canonicalHash(current.originalLease)},f.members[0].signing.privateKey);return restored.submitPrepared({coreType:original.coreType,idempotencyKey:original.packet.idempotencyKey,requestHash:canonicalHash('exact restored request'),core,authorizationProof:{receipt,membership:f.membership,...current},plaintextSource:Buffer.from('fresh owner admitted original request')},token);});
  const opaque=await restored.promoteQueuedOwnerIntent(request.idempotencyKey,request.principalKey,execute);expect(opaque.state).toBe('recorded-local');expect('details'in opaque&&opaque.details).toBe('quarantined');expect(execute).not.toHaveBeenCalled();expect(restored.source.recordsForRepair()).toEqual([]);expect(await restored.intake.reservations()).toEqual([]);
  const reaccepted=await restored.recordLocalOwnerIntent({...request,grantVersion:'new-current-owner-session'},()=>true);expect(reaccepted.details).toBe('available');expect((await restored.promoteQueuedOwnerIntent(request.idempotencyKey,request.principalKey,execute)).state).toBe('committed');expect(execute).toHaveBeenCalledTimes(1);
 });
 it('records self-only enrolled custody when pairing changes the actual roster while all canonical and retained reads stay withheld',async()=>{
  const {runtime,peer,options,managers}=await setup();expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);const directory=await fs.mkdtemp(path.join(os.tmpdir(),'graph-new-enrollment-'));
  try{const added=new MachineIdentityManager(directory);await added.generateIdentity();const identity=added.loadIdentity();managers[0].registerMachine(identity,'standby');options[0].identities.apply({identity,scope:'remote',actor:'pairing-trust',path:'pair'});
   expect(runtime.canRecordLocalOwnerIntents()).toBe(true);expect(runtime.isReady()).toBe(false);expect(()=>runtime.retainedProjection()).toThrow('retained-unavailable');expect(()=>runtime.actuation()).toThrow('write-fenced');
   const request=input('paired-before-profile-activation');request.change={kind:'set-effort-title',effort:{kind:'effort',id:crypto.randomUUID()},baseVersion:0,title:'Local private intent while profile is held'};request.headerId=newHeaderId();const view=await runtime.recordLocalOwnerIntent(request,()=>true);expect(view.details).toBe('available');expect(view.state).toBe('recorded-local');
   const stem=canonicalHash(request.idempotencyKey),base=path.join(options[0].stateDir,'state','conversation-graph-intake','queued-owner-intents');const control=JSON.parse(await fs.readFile(path.join(base,stem+'.control.json'),'utf8')),bundle=JSON.parse(await fs.readFile(path.join(base,stem+'.bundle.json'),'utf8'));expect(control.v).toBe(2);expect(control.membership).toBeUndefined();expect(bundle.envelopes.map((row:{machineId:string})=>row.machineId)).toEqual([runtime.machineId]);expect(runtime.source.recordsForRepair()).toEqual([]);expect(await runtime.intake.reservations()).toEqual([]);
   await runtime.eraseLocal({sourceKind:'header',sourceId:request.headerId});expect(view.mayServeDetails()).toBe(false);await expect(fs.stat(path.join(base,stem+'.bundle.json'))).rejects.toMatchObject({code:'ENOENT'});
  }finally{await SafeFsExecutor.safeRm(directory,{recursive:true,force:true,operation:'graph-local-pairing-fixture:cleanup'});}
 });

 it('records on a real standby with the custody host stopped, reopens exact overlay and cancels without a global slot',async()=>{
  const f=await setup(),{peer,options,service,witness}=f;service.close();witnesses.splice(witnesses.indexOf(service),1);expect(options[1].leaseCoordinator.holdsLease()).toBe(false);
  const inventory=vi.spyOn(witness,'inventory'),prepare=vi.spyOn(witness,'prepare'),request=input();
  const accepted=await peer.recordLocalOwnerIntent(request,()=>true);expect(accepted.state).toBe('recorded-local');expect(accepted.createdEffort?.ref.kind).toBe('effort');
  expect(inventory).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();expect(peer.source.recordsForRepair()).toEqual([]);expect(await peer.intake.reservations()).toEqual([]);expect(peer.source.originRecords()).toEqual([]);
  await peer.close();const restored=await ConversationGraphReplicationRuntime.open(options[1]);if(!restored)throw new Error('runtime missing');runtimes.push(restored);
  expect(restored.isReady()).toBe(false);expect(await restored.localOwnerIntent(request.idempotencyKey,'owner')).toEqual({...accepted,details:'quarantined',change:undefined});expect(await restored.localOwnerIntents('another-owner')).toEqual([]);
  const executor=vi.fn(async()=>{throw new Error('standby must not allocate');});expect(await restored.promoteQueuedOwnerIntent(request.idempotencyKey,'owner',executor)).toEqual({...accepted,details:'quarantined',change:undefined});expect(executor).not.toHaveBeenCalled();
  expect((await restored.cancelLocalOwnerIntent(request.idempotencyKey,'owner',()=>true)).state).toBe('canceled-local');await restored.close();const again=await ConversationGraphReplicationRuntime.open(options[1]);if(!again)throw new Error('runtime missing');runtimes.push(again);
  expect((await again.localOwnerIntent(request.idempotencyKey,'owner'))?.state).toBe('canceled-local');expect(again.source.recordsForRepair()).toEqual([]);expect(await again.intake.reservations()).toEqual([]);inventory.mockRestore();prepare.mockRestore();
 });
 it('promotes only through actual writer Source/W/all-member proofs and recovers a lost local promotion marker without a second packet',async()=>{
  const {runtime,peer,f,witness}=await setup(),record=f.record('queued-real-promotion');const request=input(record.packet.idempotencyKey);request.change={kind:'set-primary-placement',subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42},parent:null,replacesPlacementEventIds:[]};
  await runtime.recordLocalOwnerIntent(request,()=>true);expect(runtime.source.recordsForRepair()).toEqual([]);expect(await runtime.intake.reservations()).toEqual([]);
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const execute=async(intent:Parameters<Parameters<typeof runtime.promoteQueuedOwnerIntent>[2]>[0],token:symbol)=>{
   expect(intent.admission).toEqual(request.admission);expect(intent.change).toEqual(request.change);
   return runtime.submitPrepared({coreType:record.coreType,idempotencyKey:intent.idempotencyKey,requestHash:canonicalHash('queued-real-intent'),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('real original owner intent')},token);
  };
  const finish=vi.spyOn(runtime.intake.ownerQueue,'finish').mockRejectedValueOnce(new Error('simulated crash before promotion marker'));
  await expect(runtime.promoteQueuedOwnerIntent(request.idempotencyKey,'owner',execute)).rejects.toThrow('simulated crash');finish.mockRestore();
  const original=runtime.source.lookupByIdempotencyKey(request.idempotencyKey)!;expect(runtime.source.status(original.packet.eventId).state).toBe('committed');expect(original.packet.sourceSequence).toBe(1);expect(runtime.source.allCommitProofDelivered(original.packet.eventId)).toBe(true);const frozen=canonicalHash(original.packet);
  const prepare=vi.spyOn(witness,'prepare');expect((await runtime.promoteQueuedOwnerIntent(request.idempotencyKey,'owner',execute)).state).toBe('committed');expect(prepare).not.toHaveBeenCalled();expect(runtime.source.recordsForRepair()).toHaveLength(1);expect(canonicalHash(runtime.source.lookupByIdempotencyKey(request.idempotencyKey)!.packet)).toBe(frozen);expect((await runtime.localOwnerIntent(request.idempotencyKey,'owner'))?.promotion?.packetHash).toBe(frozen);
  await expect(runtime.cancelLocalOwnerIntent(request.idempotencyKey,'owner',()=>true)).rejects.toThrow('already-admitted');prepare.mockRestore();
 });
 it('durably records an explicit authorization/head refusal without a Source receipt or reservation',async()=>{
  const {runtime,peer,witness}=await setup(),request=input('revoked-before-promotion');await runtime.recordLocalOwnerIntent(request,()=>true);expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  const prepare=vi.spyOn(witness,'prepare');const reply=await runtime.promoteQueuedOwnerIntent(request.idempotencyKey,'owner',async()=>({refused:'owner-revoked'}));expect(reply.state).toBe('refused-local');expect(runtime.source.recordsForRepair()).toEqual([]);expect(await runtime.intake.reservations()).toEqual([]);expect(prepare).not.toHaveBeenCalled();
  const executor=vi.fn(async()=>{throw new Error('terminal refusal cannot be promoted');});expect((await runtime.promoteQueuedOwnerIntent(request.idempotencyKey,'owner',executor)).state).toBe('refused-local');expect(executor).not.toHaveBeenCalled();prepare.mockRestore();
 });
 it('priority local forget includes pending private title bodies even before native admission or custody availability',async()=>{
  const {runtime,options}=await setup(),request=input('forget-before-admission');request.change={kind:'set-effort-title',effort:{kind:'effort',id:crypto.randomUUID()},baseVersion:0,title:'Sealed queued title'};request.headerId=newHeaderId();await runtime.recordLocalOwnerIntent(request,()=>true);
  const target={sourceKind:'header' as const,sourceId:request.headerId};const proof=await runtime.localFleetPurge(target);expect(proof.purgeInventoryHash).toMatch(/^[a-f0-9]{64}$/);expect(await runtime.localOwnerIntents('owner')).toEqual([]);await expect(runtime.localOwnerIntent(request.idempotencyKey,'owner')).rejects.toThrow('intent-erased');expect(runtime.source.recordsForRepair()).toEqual([]);expect(await runtime.intake.reservations()).toEqual([]);
  const names=await fs.readdir(path.join(options[0].stateDir,'state','conversation-graph-intake','queued-owner-intents'));expect(names.some(name=>name.includes('.bundle.json'))).toBe(false);
 });
 it('rechecks current owner after a queued mutation wait before recording or canceling',async()=>{
  const {runtime}=await setup(),request=input('queued-authorization-race');await runtime.recordLocalOwnerIntent(request,()=>true);
  let current=true,entered!:()=>void,release!:()=>void;const inside=new Promise<void>(resolve=>entered=resolve),resume=new Promise<void>(resolve=>release=resolve);
  const held=runtime.withMutation(async()=>{entered();await resume;});await inside;const canceled=runtime.cancelLocalOwnerIntent(request.idempotencyKey,'owner',()=>current);const rejection=expect(canceled).rejects.toThrow('current-owner-required');current=false;release();await held;await rejection;
  expect((await runtime.localOwnerIntent(request.idempotencyKey,'owner'))?.state).toBe('recorded-local');expect(runtime.source.recordsForRepair()).toEqual([]);expect(await runtime.intake.reservations()).toEqual([]);
  await expect(runtime.recordLocalOwnerIntent(input('never-recorded-revoked-owner'),()=>false)).rejects.toThrow('current-owner-required');expect(await runtime.localOwnerIntent('never-recorded-revoked-owner','owner')).toBeNull();
 });

 it('queries current authority on the original recorder with a signed fresh peer request and the original sealed admission',async()=>{
  const {runtime,peer,options}=await setup();await fs.writeFile(path.join(options[0].stateDir,'config.json'),JSON.stringify({dashboardPin:'synthetic-current-dashboard-policy'}));const liveConfig=new LiveConfig(options[0].stateDir),policyOptions={stateDir:options[0].stateDir,liveConfig};initializeConversationGraphOwnerPolicy(policyOptions);const grants=new ConversationGraphOwnerGrantStore({stateDir:options[0].stateDir,agentId:'echo',secrets:new SecretStore({stateDir:options[0].stateDir,forceFileKey:true}),dashboardPolicy:()=>readConversationGraphOwnerPolicy(policyOptions)});
  const request=input('actual-recorded-owner-query');request.principalKey='owner:echo';request.surface='dashboard';request.admission=grants.capture(request.idempotencyKey,request.principalKey);request.grantVersion=canonicalHash(request.admission);await runtime.recordLocalOwnerIntent(request,()=>true);
  const authority=createConversationGraphOwnerAdmission({agentId:'echo',machineId:runtime.machineId,pairing:null,grants,resolveViewer:()=>null});const seen=vi.fn(authority.currentRecordedIntent);runtime.setRecordedOwnerIntentAuthority(seen);
  const original=await runtime.intake.ownerQueue.readRecordedIntent(request.idempotencyKey);if(!original)throw new Error('missing original');
  const actualFetch=globalThis.fetch.bind(globalThis),bodies:unknown[]=[];const network=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{if(typeof init?.body==='string'){const wire=JSON.parse(init.body);if(wire.action==='owner-current')bodies.push(wire.body);}return actualFetch(url,init);});
  expect(await peer.recordedOwnerIntentCurrent(original)).toBe(true);expect(seen).toHaveBeenLastCalledWith(original);expect(bodies).toEqual([{idempotencyKey:request.idempotencyKey,admissionHash:canonicalHash(request.admission)}]);
  liveConfig.set('dashboardPin','rotated-dashboard-policy');grants.observePolicy();expect(await peer.recordedOwnerIntentCurrent({...original,grantVersion:'caller-cannot-replace-original-grant'})).toBe(false);expect(seen).toHaveBeenLastCalledWith(original);
  expect(await peer.recordedOwnerIntentCurrent({...original,admission:{kind:'owner-dashboard',grantId:'forged-current-grant'}})).toBeNull();await runtime.close();expect(await peer.recordedOwnerIntentCurrent(original)).toBeNull();network.mockRestore();
 });

});
