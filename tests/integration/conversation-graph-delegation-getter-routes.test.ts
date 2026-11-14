/** Mounted route plumbing only: the session manager/capture hook are stubs.
 * Cryptographic delegation and actual tmux are proved by the separate lazy
 * integration. No fabricated source receipt is accepted in this test. */
import {describe,it,expect,vi,afterEach} from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRoutes,type RouteContext} from '../../src/server/routes.js';
import {createMockSessionManager} from '../helpers/setup.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import type {ConversationGraphDelegationGetter,ConversationGraphDelegationAvailability} from '../../src/server/ConversationGraphDelegationManager.js';
const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))SafeFsExecutor.safeRmSync(directory,{recursive:true,force:true,operation:'graph-getter-route-test'});});
function mounted(get:ConversationGraphDelegationGetter,legacy:unknown){
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-getter-route-'));directories.push(stateDir);
 const sessions=createMockSessionManager(),spawn=vi.spyOn(sessions,'spawnSession');
 const app=express();app.use(express.json());
 app.use(createRoutes({config:{authToken:'synthetic',stateDir,port:0},sessionManager:sessions,startTime:new Date(),
  getConversationGraphDelegation:get,conversationGraphDelegationRuntime:legacy} as unknown as RouteContext));
 return{app,spawn};
}
describe('lazy delegation getter at the mounted spawn boundary',()=>{
 it('awaits published initialization before invoking spawn and uses that binding',async()=>{
  let ready!:(value:ConversationGraphDelegationAvailability)=>void;
  const waiting=new Promise<ConversationGraphDelegationAvailability>(resolve=>{ready=resolve;});
  const get=vi.fn(()=>waiting),capture=vi.fn(async()=>({status:'refused',reason:'parent-bootstrap-proof-required'}));
  const {app,spawn}=mounted(get,undefined);
  const response=request(app).post('/sessions/spawn').set('Authorization','Bearer synthetic')
   .send({name:'getter-child',prompt:'Synthetic route plumbing'}).then(value=>value);
  await vi.waitFor(()=>expect(get).toHaveBeenCalledTimes(1));expect(spawn).not.toHaveBeenCalled();
  ready({status:'ready',local:{afterSuccessfulSpawn:capture},remote:null} as unknown as ConversationGraphDelegationAvailability);
  const result=await response;expect(result.status).toBe(201);expect(spawn).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledTimes(1);expect(result.body.graphDelegation.status).toBe('refused');
 });
 it('never substitutes a stale static runtime when the new binding is held',async()=>{
  const stale=vi.fn(async()=>{throw new Error('stale runtime must not run');});
  const {app,spawn}=mounted(async()=>({status:'held',reason:'current-runtime-held'}),{afterSuccessfulSpawn:stale});
  const result=await request(app).post('/sessions/spawn').set('Authorization','Bearer synthetic')
   .set('X-Instar-Bind-Token','synthetic-unverified-token').send({name:'getter-child',prompt:'Synthetic route plumbing'});
  expect(result.status).toBe(201);expect(spawn).toHaveBeenCalledTimes(1);expect(stale).not.toHaveBeenCalled();
  expect(result.body.graphDelegation).toEqual({status:'refused',reason:'verified-delegation-runtime-unavailable'});
 });
});
