import {describe,expect,it,vi} from 'vitest';
import express,{type Request} from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import {createConversationGraphRouter} from '../../src/server/conversationGraphRoutes.js';
import fs from 'node:fs';
import path from 'node:path';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphOwnerChanges} from '../../src/server/ConversationGraphOwnerChanges.js';
import {ConversationGraphHeaderCustody} from '../../src/server/ConversationGraphHeaderCustody.js';
import {ConversationGraphRuntimeReadSource} from '../../src/server/ConversationGraphReadSource.js';
import {ConversationGraphReadModel} from '../../src/core/conversationGraphRead.js';
import {nodeKey,type NodeRef} from '../../src/core/conversationGraph.js';

async function fixture(){
 const actual=await setupGraphRuntimeFixture();
 expect(await actual.runtime.refreshReadiness()).toBe(true);
 expect(await actual.peer.refreshReadiness()).toBe(true);
 const custody=new ConversationGraphHeaderCustody(actual.managers[0].baseDir,actual.runtime);
 let owner=true,visible=true;
 const changes=new ConversationGraphOwnerChanges({runtime:actual.runtime,identity:actual.managers[0],membership:()=>actual.f.membership,
  dropped:actual.options[0].droppedOrigins,scope:actual.options[0].scopeVerifier,telegramChatId:'-1001',
  resolveViewer:()=>owner?{principalKey:'owner:echo',grantVersion:'actual-test-owner',mayView:()=>visible}:null,
  hasConversation:ref=>ref.kind==='conversation'&&ref.platform==='telegram'&&ref.chatId==='-1001'&&ref.topicId===42,
  headerVersion:headerId=>{custody.synchronize();return custody.get(headerId);}});
 return{...actual,changes,custody,revoke:()=>{owner=false;},hideSubjects:()=>{visible=false;}};
}
const req={} as Request;
describe('owner corrections through actual native admission, witness HTTP and two durable members',()=>{
 it('does not claim external custody when preparation fails after actual local Source admission',async()=>{
  const {changes,runtime,witness}=await fixture();
  const failed=vi.spyOn(witness,'prepare').mockRejectedValue(new Error('actual-custody-prepare-unavailable'));
  try{
   const result=await changes.submit(req,'dashboard','unprepared-custody-create',{kind:'create-effort',projectScope:[]});
   expect(result.body.state).toBe('checking-save');
   const record=runtime.source.repairRecord(result.body.eventId as string)!;
   expect(record.preparationProof).toBeUndefined();
   expect(result.body.custody).toMatchObject({kind:'recorded-here'});
  }finally{failed.mockRestore();}
 });
 it('withholds already assembled pending metadata when current subject visibility changes before bytes',async()=>{
  const {changes,runtime,peer,managers,hideSubjects}=await fixture();
  const created=await changes.submit(req,'dashboard','pending-scope-create',{kind:'create-effort',projectScope:[]});
  expect(created.body.state).toBe('committed');
  const registry=managers[0].loadRegistry();registry.machines[peer.machineId].endpoints=[];
  delete registry.machines[peer.machineId].lastKnownUrl;managers[0].saveRegistry(registry);
  const moved=await changes.submit(req,'dashboard','pending-scope-move',{kind:'set-primary-placement',subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42},parent:created.body.effort,replacesPlacementEventIds:[]});
  expect(moved.body.state).toBe('saved-pending');
  const pending=await changes.pending(req,'dashboard');
  expect(pending.body.items).toHaveLength(1);expect(pending.privateMayServe?.()).toBe(true);
  hideSubjects();expect(pending.privateMayServe?.()).toBe(false);
  const hidden=await changes.pending(req,'dashboard');expect(hidden.body).toEqual({items:[],total:0,nextOffset:null});
  expect(runtime.source.status(String(moved.body.eventId)).state).not.toBe('quarantined');
 });
 it('does not commit an intent when local priority erasure wins during real peer I/O',async()=>{
  const {changes,runtime,witness}=await fixture();
  const member=runtime.member.bind(runtime);
  const replacement=vi.spyOn(runtime,'member').mockImplementation(machineId=>{
   const peer=member(machineId);if(!peer)return null;
   return{...peer,receiveSource:async record=>{
    const receipt=await peer.receiveSource(record);
    await runtime.eraseLocal(record.packet.erasureIdentity);
    return receipt;
   }};
  });
  try{
   const result=await changes.submit(req,'dashboard','erase-race-000001',{kind:'create-effort',projectScope:[]});
   expect(result.body.state).toBe('saved-pending');
   const record=runtime.source.repairRecord(result.body.eventId as string)!;
   expect(runtime.source.isErased(record.packet.erasureIdentity)).toBe(true);
   expect((await witness.operation(record.packet.idempotencyKey)).certificate).toBeNull();
  }finally{replacement.mockRestore();}
 });
 it('cancels a witnessed pending owner move through actual cancellation-only receipts',async()=>{
  const {changes,runtime,peer,managers}=await fixture();
  const created=await changes.submit(req,'dashboard','create-cancel-0001',{kind:'create-effort',projectScope:[]});
  expect(created.body.state).toBe('committed');
  const registry=managers[0].loadRegistry();const saved=registry.machines[peer.machineId].endpoints;
  registry.machines[peer.machineId].endpoints=[];delete registry.machines[peer.machineId].lastKnownUrl;managers[0].saveRegistry(registry);
  const moved=await changes.submit(req,'dashboard','move-cancel-00001',{kind:'set-primary-placement',subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42},
   parent:created.body.effort,replacesPlacementEventIds:[]});
  expect(moved.body.state).toBe('saved-pending');
  const before=(await runtime.intake.reservations()).length;
  const duplicateSubject=await changes.submit(req,'dashboard','move-concurrent-0001',{kind:'set-primary-placement',subject:{kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42},parent:null,replacesPlacementEventIds:[]});
  expect(duplicateSubject).toMatchObject({status:409,body:{code:'subject-change-pending',requestState:'not-recorded',operationKey:moved.body.eventId}});
  expect((await runtime.intake.reservations()).length).toBe(before);
  registry.machines[peer.machineId].endpoints=saved;managers[0].saveRegistry(registry);
  const canceled=await changes.cancel(req,'dashboard',moved.body.eventId);
  expect(canceled.body.state).toBe('canceled');
  expect(canceled.body.requestId).toBe('move-cancel-00001');
  expect(changes.status(req,'dashboard','move-cancel-00001').body.state).toBe('canceled');
  const final=runtime.source.repairRecord(moved.body.eventId as string)!;
  expect(final.certificate).toBeUndefined();expect(final.cancellationCertificate?.memberReceipts.every(receipt=>receipt.phase==='cancellation')).toBe(true);
 });
 it('certifies creation and salted title separately, retries frozen intents and undoes only current heads',async()=>{
  const {changes,custody,runtime,peer,managers}=await fixture();
  const created=await changes.submit(req,'dashboard','create-request-0001',{kind:'create-effort',projectScope:[]});
  expect(created.status).toBe(200);expect(created.body.state).toBe('committed');
  const effort=created.body.effort as NodeRef,headerId=created.body.headerId as string;
  const title=await changes.submit(req,'dashboard','title-request-0001',{kind:'set-effort-title',effort,baseVersion:0,title:'Private effort title'});
  expect(title.status).toBe(200);custody.synchronize();expect(custody.titleOf(headerId)).toBe('Private effort title');
  expect((await changes.submit(req,'dashboard','title-request-0001',{kind:'set-effort-title',effort,baseVersion:0,title:'Different title'})).body.code).toBe('idempotency-conflict');
  const reservations=path.join(managers[0].baseDir,'state','conversation-graph-intake');
  const persisted=fs.readdirSync(reservations).filter(name=>name.endsWith('.json')).map(name=>fs.readFileSync(path.join(reservations,name),'utf8')).join('\n');
  expect(persisted).not.toContain(canonicalHash({kind:'set-effort-title',effort,baseVersion:0,title:'Private effort title'}));
  expect(persisted).not.toContain('Private effort title');
  const model=new ConversationGraphReadModel(new ConversationGraphRuntimeReadSource(runtime,custody));
  const read=model.roots({principalKey:'owner:echo',grantVersion:'owner-read',mayView:()=>true},{view:'overview'});
  expect(read).toMatchObject({status:200,body:{partial:true,items:[{ref:effort,title:'Private effort title'}]}});
  expect(JSON.stringify(runtime.source.recordsForRepair().map(record=>record.core))).not.toContain('Private effort title');
  const subject:NodeRef={kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42};
  const input={kind:'set-primary-placement',subject,parent:effort,replacesPlacementEventIds:[]};
  expect(changes.preview(req,'dashboard',input)).toMatchObject({status:200,body:{eligible:true,replacesPlacementEventIds:[]}});
  const placed=await changes.submit(req,'dashboard','place-request-0001',input);
  expect(placed.status).toBe(200);expect(placed.body.undoToken).toBeTypeOf('string');
  expect(changes.preview(req,'dashboard',input).body.code).toBe('placement-conflict');
  expect((await changes.submit(req,'dashboard','place-request-0001',input)).body.eventId).toBe(placed.body.eventId);
  expect((await changes.submit(req,'dashboard','place-request-0001',{...input,parent:null})).body.code).toBe('idempotency-conflict');
  expect((await changes.submit(req,'dashboard','place-request-0001',{...input,parent:null})).body.requestState).toBeUndefined();
  expect((await changes.submit(req,'dashboard','stale-place-000001',input)).body).toMatchObject({code:'placement-conflict',requestState:'not-recorded'});
  expect((await changes.undo(req,'dashboard','undo-request-00001',placed.body.undoToken)).body.state).toBe('committed');
  expect((await changes.undo(req,'dashboard','undo-request-00002',placed.body.undoToken)).body.code).toBe('placement-conflict');
  expect(runtime.projection().records.every(record=>peer.source.status(record.packet.eventId).state==='committed')).toBe(true);
  expect(nodeKey(effort)).toContain('effort');
 });
 it('denies owner operations after revocation without reserving or exposing an intent',async()=>{
  const {changes,runtime,revoke}=await fixture();revoke();
  expect((await changes.submit(req,'dashboard','revoked-request-01',{kind:'create-effort',projectScope:[]})).status).toBe(403);
  expect((await changes.pending(req,'dashboard')).status).toBe(403);
  expect((await runtime.intake.reservations())).toHaveLength(0);
 });
 it('resolves header erasure from a certified effort and reports live purge separately from backup debt',async()=>{
  const {changes,custody,runtime,peer,revoke}=await fixture();
  const created=await changes.submit(req,'dashboard','create-fleet-00001',{kind:'create-effort',projectScope:[]});
  expect(created.body.state).toBe('committed');
  const effort=created.body.effort as NodeRef,headerId=created.body.headerId as string;
  const titled=await changes.submit(req,'dashboard','title-fleet-000001',{kind:'set-effort-title',effort,baseVersion:0,title:'Fleet erase canary'});
  expect(titled.body.state).toBe('committed');
  const erased=await changes.forgetEffortHeader(req,'dashboard','erase-header-00001',effort);
  expect(erased).toMatchObject({status:202,body:{localHidden:true,liveGraphStoresPurged:true,fleetComplete:false}});
  expect(erased.body.memberBackupDebt).toEqual(expect.arrayContaining([expect.objectContaining({state:'unknown'})]));
  expect(custody.titleOf(headerId)).toBeNull();
  expect(runtime.source.isErased({sourceKind:'header',sourceId:headerId})).toBe(true);
  expect(peer.source.isErased({sourceKind:'header',sourceId:headerId})).toBe(true);
  expect((await changes.erasureStatus(req,'dashboard','erase-header-00001',undefined)).body.fleetComplete).toBe(false);
  expect((await changes.forgetEffortHeader(req,'dashboard','invalid-ref-00001',{kind:'conversation',platform:'app',conversationKey:'private-key'})).status).toBe(400);
  revoke();
  expect((await changes.forgetEffortHeader(req,'dashboard','revoked-erase-0001',effort)).status).toBe(403);
  expect((await changes.erasureStatus(req,'dashboard','erase-header-00001',undefined)).status).toBe(403);
 });
 it('ensures a stable server-side privacy identity while witness storage is offline and refuses reserved-id poisoning',async()=>{
  const {changes,runtime,witness}=await fixture();
  const created=await changes.submit(req,'dashboard','create-ensure-0001',{kind:'create-effort',projectScope:[]});
  const effort=created.body.effort as NodeRef,target={sourceKind:'header' as const,sourceId:created.body.headerId as string};
  expect((await changes.forgetEffortHeader(req,'dashboard','erasev1_'+ '0'.repeat(64),effort)).status).toBe(400);
  expect(runtime.source.isErased(target)).toBe(false);
  expect((await changes.discoverHeaderErasure(req,'dashboard',effort)).status).toBe(404);
  const offline=vi.spyOn(witness,'beginFleetErasure').mockRejectedValue(new Error('witness-offline'));
  try{
   const first=await changes.discoverHeaderErasure(req,'dashboard',effort,true);
   expect(first).toMatchObject({status:202,body:{localHidden:true,fleetComplete:false}});
   expect(first.body.requestId).toMatch(/^erasev1_[a-f0-9]{64}$/);
   const retry=await changes.discoverHeaderErasure(req,'dashboard',effort,true);
   expect(retry.body.requestId).toBe(first.body.requestId);
   const discovered=await changes.discoverHeaderErasure(req,'dashboard',effort);
   expect(discovered).toMatchObject({status:200,body:{requestId:first.body.requestId,target,continuity:{publication:'published'}}});
  }finally{offline.mockRestore();}
 });
 it('rechecks owner after discovery before fleet admission, retaining the earlier authorized local restriction',async()=>{
  const {changes,runtime,revoke}=await fixture();
  const created=await changes.submit(req,'dashboard','create-discover-01',{kind:'create-effort',projectScope:[]});
  const target={sourceKind:'header' as const,sourceId:created.body.headerId as string};
  const actual=runtime.erasure.lookupByTarget.bind(runtime.erasure);
  const replacement=vi.spyOn(runtime.erasure,'lookupByTarget').mockImplementation(async(...args)=>{const result=await actual(...args);expect(runtime.source.isErased(target)).toBe(true);revoke();return result;});
  try{expect((await changes.discoverHeaderErasure(req,'dashboard',created.body.effort,true)).status).toBe(403);expect(runtime.source.isErased(target)).toBe(true);}
  finally{replacement.mockRestore();}
 });
 it('hides locally even when continuity evidence is unavailable without inventing fleet acceptance',async()=>{
  const {changes,runtime}=await fixture();
  const created=await changes.submit(req,'dashboard','create-corrupt-001',{kind:'create-effort',projectScope:[]});
  const target={sourceKind:'header' as const,sourceId:created.body.headerId as string};
  const unavailable=vi.spyOn(runtime.erasure,'lookupByTarget').mockRejectedValue(new Error('erasure-discovery-evidence-missing'));
  try{expect(await changes.discoverHeaderErasure(req,'dashboard',created.body.effort,true)).toMatchObject({status:503,body:{code:'erasure-discovery-unavailable',localHidden:true,fleetComplete:false}});expect(runtime.source.isErased(target)).toBe(true);}
  finally{unavailable.mockRestore();}
 });
 it('captures unmodified HTTP read envelopes from the real certified runtime for decoder alignment',async()=>{
  const {changes,runtime,custody}=await fixture();
  const created=await changes.submit(req,'dashboard','capture-create-001',{kind:'create-effort',projectScope:[]});
  expect(created.body.state).toBe('committed');
  const titled=await changes.submit(req,'dashboard','capture-title-0001',{kind:'set-effort-title',effort:created.body.effort,baseVersion:0,title:'Synthetic contract capture'});
  expect(titled.body.state).toBe('committed');
  const model=new ConversationGraphReadModel(new ConversationGraphRuntimeReadSource(runtime,custody,{correctionsEnabled:true,erasureEnabled:true}));
  const viewer={principalKey:'owner:echo',grantVersion:'synthetic-capture-owner',mayView:()=>true,hasFullCorrectionScope:()=>true};
  const app=express();app.use(createConversationGraphRouter({model,resolveViewer:()=>viewer}));
  const roots=await request(app).get('/mobile/conversation-graph/roots?view=overview');
  const ref=Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(created.body.effort as object).sort(([a],[b])=>a.localeCompare(b))))).toString('base64url');
  const node=await request(app).get('/mobile/conversation-graph/nodes/'+ref);
  expect(roots.status).toBe(200);expect(node.status).toBe(200);
  expect(node.body.node.ref).toEqual(created.body.effort);expect(node.body.node.title).toBe('Synthetic contract capture');
  expect(node.body).toMatchObject({capabilities:{ownerCorrections:true,ownerErasure:true},correction:{headerVersion:1},erasure:{headerForgotten:false}});
  const files=['src/core/conversationGraph.ts','src/core/conversationGraphRead.ts','src/core/EffortHeaderStore.ts','src/server/ConversationGraphHeaderCustody.ts','src/server/ConversationGraphReadSource.ts','src/server/conversationGraphRoutes.ts'];
  const sourceHashes=Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const directory=path.join(process.cwd(),'.instar','state','build');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'conversation-graph-wire-capture.json'),JSON.stringify({kind:'local-synthetic-http-capture',uncommittedSources:true,sourceHashes,
   limitations:['test viewer resolver; not device-signature evidence','synthetic data and loopback witness; no real server deployment','effort envelopes only; no flat source-alias integration proof'],
   capturedAt:new Date().toISOString(),roots:roots.body,node:node.body},null,2));
 });
 it('hides a header outside a stalled ordinary queue without claiming witness or fleet erasure',async()=>{
  const {changes,custody,runtime,witness}=await fixture();
  const created=await changes.submit(req,'dashboard','create-forget-0001',{kind:'create-effort',projectScope:[]});
  expect(created.body.state).toBe('committed');
  const effort=created.body.effort as NodeRef,headerId=created.body.headerId as string;
  const titled=await changes.submit(req,'dashboard','title-forget-00001',{kind:'set-effort-title',effort,baseVersion:0,title:'Erase this title'});
  expect(titled.body.state).toBe('committed');custody.synchronize();expect(custody.titleOf(headerId)).toBe('Erase this title');
  const original=runtime.source.repairRecord(titled.body.eventId as string)!;
  let release!:()=>void;let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const stalled=runtime.withMutation(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
  await started;
  try{
   const hidden=await changes.forgetLocal(req,'dashboard',{sourceKind:'header',sourceId:headerId});
   expect(hidden).toMatchObject({status:202,body:{state:'local-hidden',fleetComplete:false}});
   expect(custody.titleOf(headerId)).toBeNull();
   expect(()=>runtime.source.openVerifiedPayload(original)).toThrow();
   expect((await witness.operation(original.packet.idempotencyKey)).encryptedSourceBundle).not.toBeNull();
  }finally{release();await stalled;}
 });
});
