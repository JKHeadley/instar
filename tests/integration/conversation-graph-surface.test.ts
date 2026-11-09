import {describe,it,expect} from 'vitest';
import express from 'express';
import request from 'supertest';
import {createConversationGraphSurface} from '../../src/server/ConversationGraphSurface.js';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';

describe('default-off Conversations surface with actual replicated runtime',()=>{
 it('does not mount from storage alone, and enabled reads retain owner and cold-read gates',async()=>{
  const actual=await setupGraphRuntimeFixture();
  let owner=true;
  const options={stateDir:actual.managers[0].baseDir,agentId:actual.f.membership.agentId,runtime:actual.runtime,
   identity:actual.managers[0],scope:actual.options[0].scopeVerifier!,telegramChatId:'-1001',pairing:null,
   verifyDashboardOwner:(token:string|undefined)=>owner&&token==='operator-proof'};
  const off=express();off.use(express.json(),createConversationGraphSurface({...options,correctionsEnabled:true}));
  // Configured off answers the console's "not switched on" code, never HTML 404.
  for(const response of [await request(off).get('/conversation-graph/roots').set('X-Instar-Operator-Session','operator-proof'),
   await request(off).post('/conversation-graph/changes').send({}),await request(off).get('/mobile/conversation-graph/roots')]){
   expect(response.status).toBe(503);expect(response.body).toEqual({code:'conversation-graph-off'});
  }
  expect((await request(off).get('/conversation-graph-elsewhere')).status).toBe(404);
  const on=express();on.use(express.json(),createConversationGraphSurface({...options,readEnabled:true}));
  expect((await request(on).get('/conversation-graph/roots').set('X-Instar-Operator-Session','operator-proof')).status).toBe(503);
  expect((await request(on).get('/mobile/conversation-graph/roots').set('Authorization','Bearer agent-token')).status).toBe(403);
  expect(await actual.runtime.refreshReadiness()).toBe(true);
  const ready=await request(on).get('/conversation-graph/roots').set('X-Instar-Operator-Session','operator-proof');
  expect(ready.status).toBe(200);
  owner=false;
  expect((await request(on).get('/conversation-graph/roots').set('X-Instar-Operator-Session','operator-proof')).status).toBe(403);
  expect((await request(on).post('/conversation-graph/changes').send({})).status).toBe(404);
 });
 it('mounts corrections only with the explicit switch and actual scope verifier',async()=>{
  const actual=await setupGraphRuntimeFixture();
  const options={stateDir:actual.managers[0].baseDir,agentId:actual.f.membership.agentId,runtime:actual.runtime,
   identity:actual.managers[0],telegramChatId:'-1001',pairing:null,readEnabled:true,correctionsEnabled:true,
   verifyDashboardOwner:(token:string|undefined)=>token==='operator-proof'};
  const noScope=express();noScope.use(express.json(),createConversationGraphSurface({...options,scope:null}));
  expect((await request(noScope).post('/conversation-graph/changes').set('X-Instar-Operator-Session','operator-proof').send({})).status).toBe(404);
  const on=express();on.use(express.json(),createConversationGraphSurface({...options,scope:actual.options[0].scopeVerifier!}));
  expect(await actual.runtime.refreshReadiness()).toBe(true);
  const result=await request(on).post('/conversation-graph/changes').set('X-Instar-Operator-Session','operator-proof')
   .send({requestId:'surface-create-0001',change:{kind:'create-effort',projectScope:[]}});
  expect(result.status).toBe(200);
  expect(result.body.state).toBe('committed');
  const roots=await request(on).get('/conversation-graph/roots').set('X-Instar-Operator-Session','operator-proof');
  expect(roots.status).toBe(200);
  expect(roots.body.items).toHaveLength(1);
 });
});
