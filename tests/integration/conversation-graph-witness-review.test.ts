/** Independent second-pass witness/header review. Actual native runtime, HTTP
 * witness and member storage; fixture enrollment is not provider authority. */
import {describe,it,expect,vi} from 'vitest';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphOwnerChanges} from '../../src/server/ConversationGraphOwnerChanges.js';
import {ConversationGraphHeaderCustody} from '../../src/server/ConversationGraphHeaderCustody.js';
import type {Request} from 'express';
import type {NodeRef} from '../../src/core/conversationGraph.js';
describe('independent witness header CAS recovery review',()=>{
 it('revalidates same-lease pending header writes and certifies stale refusal without displaying its title',async()=>{
  const actual=await setupGraphRuntimeFixture();expect(await actual.runtime.refreshReadiness()).toBe(true);expect(await actual.peer.refreshReadiness()).toBe(true);
  const custody=new ConversationGraphHeaderCustody(actual.managers[0].baseDir,actual.runtime);
  const changes=new ConversationGraphOwnerChanges({runtime:actual.runtime,identity:actual.managers[0],membership:()=>actual.f.membership,dropped:actual.options[0].droppedOrigins,scope:actual.options[0].scopeVerifier,telegramChatId:'-1001',resolveViewer:()=>({principalKey:'owner:echo',grantVersion:'review-owner',mayView:()=>true}),hasConversation:()=>false,headerVersion:id=>{custody.synchronize();return custody.get(id);}});
  const req={} as Request,created=await changes.submit(req,'dashboard','review-create-0001',{kind:'create-effort',projectScope:[]});expect(created.body.state).toBe('committed');
  const effort=created.body.effort as NodeRef,headerId=created.body.headerId as string,block=vi.spyOn(actual.runtime,'member').mockReturnValue(undefined);
  let first:Awaited<ReturnType<typeof changes.submit>>,second:Awaited<ReturnType<typeof changes.submit>>;
  try{first=await changes.submit(req,'dashboard','review-title-00001',{kind:'set-effort-title',effort,baseVersion:0,title:'First certified title'});second=await changes.submit(req,'dashboard','review-title-00002',{kind:'set-effort-title',effort,baseVersion:0,title:'Stale rejected title'});expect(first.body.state).toBe('saved-pending');expect(second.body.state).toBe('saved-pending');}finally{block.mockRestore();}
  const epoch=actual.runtime.actuation().lease.leaseEpoch;await actual.runtime.reconcilePending();expect(actual.runtime.actuation().lease.leaseEpoch).toBe(epoch);
  const good=actual.runtime.source.repairRecord(first!.body.eventId as string)!,bad=actual.runtime.source.repairRecord(second!.body.eventId as string)!;
  expect(good.certificate).toBeDefined();expect(bad.certificate).toBeUndefined();expect(bad.cancellationCertificate?.outcome).toBe('canceled');expect(bad.adoption?.revalidation.reason).toBe('stale-heads');
  custody.synchronize();expect(custody.titleOf(headerId)).toBe('First certified title');
  expect(JSON.stringify(actual.runtime.projection().records.map(r=>r.core))).not.toContain('Stale rejected title');
 });
});

describe('independent owner header-erasure review',()=>{
 it('rechecks owner authority after asynchronous erasure status work',async()=>{
  const actual=await setupGraphRuntimeFixture();expect(await actual.runtime.refreshReadiness()).toBe(true);expect(await actual.peer.refreshReadiness()).toBe(true);
  let owner=true;const custody=new ConversationGraphHeaderCustody(actual.managers[0].baseDir,actual.runtime);
  const changes=new ConversationGraphOwnerChanges({runtime:actual.runtime,identity:actual.managers[0],membership:()=>actual.f.membership,dropped:actual.options[0].droppedOrigins,scope:actual.options[0].scopeVerifier,telegramChatId:'-1001',resolveViewer:()=>owner?{principalKey:'owner:echo',grantVersion:'review-owner',mayView:()=>true}:null,hasConversation:()=>false,headerVersion:id=>{custody.synchronize();return custody.get(id);}});
  const req={} as Request,created=await changes.submit(req,'dashboard','review-erasure-create',{kind:'create-effort',projectScope:[]});expect(created.body.state).toBe('committed');
  const accepted=await changes.forgetEffortHeader(req,'dashboard','review-erasure-status',created.body.effort);expect(accepted.status).toBe(202);
  const original=actual.runtime.erasure.status.bind(actual.runtime.erasure);
  const hook=vi.spyOn(actual.runtime.erasure,'status').mockImplementation(async(...args)=>{const result=await original(...args);owner=false;return result;});
  try{expect((await changes.erasureStatus(req,'dashboard','review-erasure-status',undefined)).status).toBe(403);}finally{hook.mockRestore();}
 });
});
