/**
 * Feature-alive: the Chief of Staff tree import on the actual AgentServer composition (work-front-doors §3.1,
 * §7 stage 2). Boots the production owned-default graph from a real PIN unlock, as
 * conversation-graph-suggestions-alive does, with a Chief of Staff whose tree has a child under a project the
 * owner has NOT accepted. Proves the runner is constructed by the real wiring, reads the real CoS tree records
 * and the real certified graph, keeps an unaccepted mapping untouched (no graph event written), and that the
 * switch is dev-gated (dark on a fleet agent).
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

const HOST='graph-cos-import-alive.example.dev';
function boot(developmentAgent:boolean){
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-cos-import-alive-'));
 const identity=new MachineIdentityManager(stateDir);
 const lock=new SingleInstanceLock({stateDir});
 const scope=new ScopeVerifier({projectName:'instar',projectDir:stateDir});
 const manager=new ConversationGraphDefault({stateDir,agentId:'echo',instanceLock:lock,scopeVerifier:scope,telegramChatId:'-1001',secrets:new SecretStore({stateDir,forceFileKey:true})});
 const config={projectName:'echo',projectDir:stateDir,stateDir,port:0,authToken:'cos-import-fixture-token',dashboardPin:'654321',developmentAgent,
  sessions:{claudePath:'/usr/bin/echo',maxSessions:1,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},
  scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[{type:'telegram',enabled:true,config:{chatId:'-1001'}}],updates:{},threadline:{ownerName:'Owner'},
  secrets:{forceFileKey:true},mobilePairing:{multiRoute:{enabled:false}},tunnel:{enabled:true,type:'named',token:'x',hostname:HOST},
  multiMachine:{enabled:false,conversationGraph:{readEnabled:true,correctionsEnabled:true}},
 } as unknown as InstarConfig;
 fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config));
 let treeReads=0;
 const server=new AgentServer({config,sessionManager:createMockSessionManager(),state:new StateManager(stateDir),initiativeTracker:new InitiativeTracker(stateDir),
  coordinator:{enabled:false,managers:{identityManager:identity}} as never,coherenceGate:scope,conversationGraphDefault:manager,
  // A Chief of Staff with project telegram:42 and its sub-conversation telegram:43; the owner never accepted the project.
  chiefOfStaffLoop:{projectsSummary:()=>[{conversationKey:'telegram:42',title:'Ship the thing'}],
   tree:()=>new Map([['telegram:43',{conversationKey:'telegram:43',parentConversationKey:'telegram:42'}]]),
   treeRecords:()=>{treeReads++;return [{conversationKey:'telegram:43',parentConversationKey:'telegram:42',hlc:{physical:1_700_000_000_000,logical:0,node:'mac-a'},origin:'mac-a'}];}} as never,
  tunnel:{lifecycleState:{lastState:'active',activeProvider:'cloudflare-named'},url:`https://${HOST}`,on:()=>undefined} as never});
 return {stateDir,lock,manager,server,treeReads:()=>treeReads};
}

describe('Chief of Staff tree import on the production AgentServer composition',()=>{
 it('is wired, reads the real CoS tree and graph, and writes nothing for a project the owner has not accepted',async()=>{
  const b=boot(true);expect((await b.lock.acquire()).acquired).toBe(true);
  try{
   const importer=b.server.conversationGraphCosTreeImport;
   expect(importer).not.toBeNull();
   // Before the owner opens the graph there is no runtime yet.
   expect(await importer!.runOnce()).toEqual({state:'not-ready'});
   const app=b.server.getApp();
   const unlocked=await request(app).post('/dashboard/unlock').send({pin:'654321'});expect(unlocked.status).toBe(200);
   const roots=await request(app).get('/conversation-graph/roots').set('Authorization','Bearer cos-import-fixture-token').set('X-Instar-AgentId','echo')
    .set('X-Instar-Operator-Session',unlocked.body.operatorSessionToken);
   expect(roots.status,JSON.stringify(roots.body)).toBe(200);
   const runtime=b.manager.runtime!;expect(runtime.installedMembership.members).toHaveLength(1);
   const before=runtime.source.recordsForRepair().length;
   // One member (this machine) => the gate is open; the real tree and the real certified graph are read.
   const run=await importer!.runOnce();
   expect(run).toEqual({state:'ran',imported:[],skipped:{'project-not-accepted':1},refused:[]});
   expect(b.treeReads()).toBeGreaterThan(0);
   expect(runtime.source.recordsForRepair().length).toBe(before);
   expect(importer!.status()).toEqual(run);
  }finally{
   await b.server.stop();await b.manager.close();b.lock.release();
   SafeFsExecutor.safeRmSync(b.stateDir,{recursive:true,force:true,operation:'graph-cos-import-alive-cleanup'});
  }
 });
 it('is dark on a fleet agent: the switch resolves off and nothing is read',async()=>{
  const b=boot(false);expect((await b.lock.acquire()).acquired).toBe(true);
  try{
   expect(await b.server.conversationGraphCosTreeImport!.runOnce()).toEqual({state:'off'});
   expect(b.treeReads()).toBe(0);
  }finally{
   await b.server.stop();await b.manager.close();b.lock.release();
   SafeFsExecutor.safeRmSync(b.stateDir,{recursive:true,force:true,operation:'graph-cos-import-alive-cleanup'});
  }
 });
});
