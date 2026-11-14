/**
 * Feature-alive: the Conversations suggestion step on the actual AgentServer composition
 * (docs/specs/conversation-graph-suggestions.md). Boots the production owned-default graph from a
 * real PIN unlock, exactly as conversation-graph-surface-alive does, with a stub model, and proves
 * the suggestion routes answer 200 (not 503/404) for the owner and 403 for anyone else.
 */
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import {AgentServer} from '../../src/server/AgentServer.js';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {SingleInstanceLock} from '../../src/core/SingleInstanceLock.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {ConversationGraphDefault} from '../../src/server/ConversationGraphDefault.js';
import {StateManager} from '../../src/core/StateManager.js';
import {InitiativeTracker} from '../../src/core/InitiativeTracker.js';
import type {InstarConfig} from '../../src/core/types.js';
import {createMockSessionManager} from '../helpers/setup.js';
vi.setConfig({testTimeout:120_000});

const HOST='graph-suggestions-alive.example.dev';
describe('Conversations suggestions on the production AgentServer composition',()=>{
 it('serves the owner suggestions route alive and refuses a caller without the owner proof',async()=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-suggestions-alive-'));
  const identity=new MachineIdentityManager(stateDir);
  const lock=new SingleInstanceLock({stateDir});expect((await lock.acquire()).acquired).toBe(true);
  const scope=new ScopeVerifier({projectName:'instar',projectDir:stateDir});
  const manager=new ConversationGraphDefault({stateDir,agentId:'echo',instanceLock:lock,scopeVerifier:scope,telegramChatId:'-1001',
   secrets:new SecretStore({stateDir,forceFileKey:true})});
  const config={projectName:'echo',projectDir:stateDir,stateDir,port:0,authToken:'suggestions-fixture-token',dashboardPin:'654321',developmentAgent:true,
   sessions:{claudePath:'/usr/bin/echo',maxSessions:1,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},
   scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],updates:{},threadline:{ownerName:'Owner'},
   secrets:{forceFileKey:true},mobilePairing:{multiRoute:{enabled:false}},tunnel:{enabled:true,type:'named',token:'x',hostname:HOST},
   multiMachine:{enabled:false,conversationGraph:{readEnabled:true,correctionsEnabled:true}},
  } as unknown as InstarConfig;
  fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config));
  const calls:string[]=[];
  const server=new AgentServer({config,sessionManager:createMockSessionManager(),state:new StateManager(stateDir),initiativeTracker:new InitiativeTracker(stateDir),
   coordinator:{enabled:false,managers:{identityManager:identity}} as never,coherenceGate:scope,conversationGraphDefault:manager,
   intelligence:{evaluate:async(prompt:string)=>{calls.push(prompt);return '{"groups":[]}';}},
   tunnel:{lifecycleState:{lastState:'active',activeProvider:'cloudflare-named'},url:`https://${HOST}`,on:()=>undefined} as never});
  try{
   const app=server.getApp();
   const unlocked=await request(app).post('/dashboard/unlock').send({pin:'654321'});expect(unlocked.status).toBe(200);
   const owner=(r:request.Test)=>r.set('Authorization','Bearer suggestions-fixture-token').set('X-Instar-AgentId','echo').set('X-Instar-Operator-Session',unlocked.body.operatorSessionToken);
   // Opening the graph first (the dashboard always reads roots before suggestions).
   expect((await owner(request(app).get('/conversation-graph/roots'))).status).toBe(200);
   const got=await owner(request(app).get('/conversation-graph/suggestions'));
   expect(got.status,JSON.stringify(got.body)).toBe(200);
   expect(got.body).toMatchObject({items:[]});
   expect(['ready','building']).toContain(got.body.state);
   const anon=await request(app).get('/conversation-graph/suggestions').set('Authorization','Bearer suggestions-fixture-token').set('X-Instar-AgentId','echo');
   expect(anon.status).toBe(403);
   // An empty inventory never spends a model call.
   expect(calls).toEqual([]);
  }finally{
   await server.stop();await manager.close();lock.release();
   SafeFsExecutor.safeRmSync(stateDir,{recursive:true,force:true,operation:'graph-suggestions-alive-cleanup'});
  }
 });
});
