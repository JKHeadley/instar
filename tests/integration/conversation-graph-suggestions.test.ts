/**
 * Conversations suggestions + Chief of Staff root over the real composition
 * (docs/specs/conversation-graph-suggestions.md): the actual replicated runtime, the actual
 * surface router, the actual owner-change ingress. The model is a stub; nothing else is.
 */
import {describe,it,expect,vi} from 'vitest';
import express,{type Request} from 'express';
import request from 'supertest';
import {createConversationGraphSurface} from '../../src/server/ConversationGraphSurface.js';
import {ConversationGraphOwnerChanges} from '../../src/server/ConversationGraphOwnerChanges.js';
import {ConversationGraphHeaderCustody} from '../../src/server/ConversationGraphHeaderCustody.js';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {nodeKey,type ConversationRef,type NodeRef} from '../../src/core/conversationGraph.js';
vi.setConfig({testTimeout:120_000});

const PROOF='operator-proof';
const cos:ConversationRef={kind:'conversation',platform:'telegram',chatId:'-1001',topicId:42};

describe('suggestion routes on the actual surface',()=>{
 it('are owner only, mounted with corrections, and serve the service through the read model',async()=>{
  const actual=await setupGraphRuntimeFixture();
  let owner=true;const prompts:string[]=[];
  const options={stateDir:actual.managers[0].baseDir,agentId:actual.f.membership.agentId,runtime:actual.runtime,
   identity:actual.managers[0],scope:actual.options[0].scopeVerifier!,telegramChatId:'-1001',pairing:null,readEnabled:true,correctionsEnabled:true,
   verifyDashboardOwner:(token:string|undefined)=>owner&&token===PROOF,chiefOfStaffTopicId:()=>42,
   suggestions:{intelligence:{evaluate:async(prompt:string)=>{prompts.push(prompt);return '{"groups":[]}';}},evidence:()=>({project:null,text:''})}};
  const app=express();app.use(express.json(),createConversationGraphSurface(options));
  expect(await actual.runtime.refreshReadiness()).toBe(true);
  const got=await request(app).get('/conversation-graph/suggestions').set('X-Instar-Operator-Session',PROOF);
  expect(got.status).toBe(200);
  expect(got.body).toMatchObject({items:[]});
  expect(['ready','building']).toContain(got.body.state);
  expect((await request(app).post('/conversation-graph/suggestions/not-an-id/reject').set('X-Instar-Operator-Session',PROOF).send({})).status).toBe(400);
  expect((await request(app).post('/conversation-graph/suggestions/sg-0123456789abcdef0123/reject').set('X-Instar-Operator-Session',PROOF).send({})).status).toBe(404);
  expect((await request(app).post('/conversation-graph/suggestions/sg-0123456789abcdef0123/start').set('X-Instar-Operator-Session',PROOF).send({})).status).toBe(404);
  const refreshed=await request(app).post('/conversation-graph/suggestions/refresh').set('X-Instar-Operator-Session',PROOF).send({});
  expect([202,429]).toContain(refreshed.status);
  owner=false;
  expect((await request(app).get('/conversation-graph/suggestions').set('X-Instar-Operator-Session',PROOF)).status).toBe(403);
  expect((await request(app).post('/conversation-graph/suggestions/refresh').set('X-Instar-Operator-Session',PROOF).send({})).status).toBe(403);
 });

 it('are not mounted without owner corrections',async()=>{
  const actual=await setupGraphRuntimeFixture();
  const app=express();app.use(express.json(),createConversationGraphSurface({stateDir:actual.managers[0].baseDir,agentId:actual.f.membership.agentId,
   runtime:actual.runtime,identity:actual.managers[0],scope:actual.options[0].scopeVerifier!,telegramChatId:'-1001',pairing:null,readEnabled:true,
   verifyDashboardOwner:(token:string|undefined)=>token===PROOF,suggestions:{intelligence:null,evidence:()=>({project:null,text:''})}}));
  expect(await actual.runtime.refreshReadiness()).toBe(true);
  expect((await request(app).get('/conversation-graph/suggestions').set('X-Instar-Operator-Session',PROOF)).status).toBe(404);
 });
});

describe('the Chief of Staff conversation is never placed under anything',()=>{
 it('refuses the move at preview and at the real write ingress; other conversations still move',async()=>{
  const actual=await setupGraphRuntimeFixture();
  expect(await actual.runtime.refreshReadiness()).toBe(true);
  expect(await actual.peer.refreshReadiness()).toBe(true);
  const custody=new ConversationGraphHeaderCustody(actual.managers[0].baseDir,actual.runtime);
  let root:NodeRef|null=cos;
  const changes=new ConversationGraphOwnerChanges({runtime:actual.runtime,identity:actual.managers[0],membership:()=>actual.f.membership,
   dropped:actual.options[0].droppedOrigins,scope:actual.options[0].scopeVerifier,telegramChatId:'-1001',
   resolveViewer:()=>({principalKey:'owner:echo',grantVersion:'actual-test-owner',mayView:()=>true}),
   hasConversation:ref=>ref.kind==='conversation'&&ref.platform==='telegram'&&ref.chatId==='-1001'&&ref.topicId===42,
   isRootConversation:ref=>root!==null&&nodeKey(ref)===nodeKey(root),
   headerVersion:headerId=>{custody.synchronize();return custody.get(headerId);}});
  const req={} as Request;
  const created=await changes.submit(req,'dashboard','cos-root-create-01',{kind:'create-effort',projectScope:[]});
  expect(created.body.state).toBe('committed');
  const move={kind:'set-primary-placement',subject:cos,parent:created.body.effort,replacesPlacementEventIds:[]};
  const preview=changes.preview(req,'dashboard',move);
  expect(preview.status).toBe(200);expect(preview.body).toMatchObject({eligible:false,reason:'chief-of-staff-is-root'});
  const refused=await changes.submit(req,'dashboard','cos-root-move-0001',move);
  expect(refused.status).toBe(409);expect(refused.body).toMatchObject({code:'chief-of-staff-is-root',requestState:'not-recorded'});
  // The same conversation moves normally once it is not the root: the rule is the only difference.
  root=null;
  const moved=await changes.submit(req,'dashboard','cos-root-move-0002',move);
  expect(moved.body.state).toBe('committed');
 });
});
