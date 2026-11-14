// safe-fs-allow: real lifecycle fixture directories only.
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
const servers:AgentServer[]=[],dirs:string[]=[];
afterEach(async()=>{for(const s of servers.splice(0))await s.stop();for(const d of dirs.splice(0))SafeFsExecutor.safeRmSync(d,{recursive:true,force:true,operation:'evo022-lifecycle-cleanup'});});
function boot(d:string) {
 const config={projectName:'evo022-test',projectDir:d,stateDir:d,port:0,authToken:'evo022-test-auth',version:'0.0.0',sessions:{claudePath:'/usr/bin/echo',maxSessions:1,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],monitoring:{},updates:{}} as InstarConfig;
 const evolution=new EvolutionManager({stateDir:d,retentionTargets:{actions:1,learnings:0}});
 const s=new AgentServer({config,evolution,state:new StateManager(d),sessionManager:{listRunningSessions:()=>[],getSession:()=>null,on:()=>{}} as never});servers.push(s);return s;
}
describe('EVO-022 production factory and restart lifecycle',()=>{
 it('requires auth and preserves complete archived memory across server restart',async()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'evo022-alive-'));dirs.push(d);fs.mkdirSync(path.join(d,'state/sessions'),{recursive:true});fs.mkdirSync(path.join(d,'logs'),{recursive:true});
  let s=boot(d);await s.start();let app=s.getApp();
  expect((await request(app).get('/evolution/archive')).status).toBe(401);
  const auth={Authorization:'Bearer evo022-test-auth','X-Instar-AgentId':'evo022-test'};
  const created=await request(app).post('/evolution/actions').set(auth).send({title:'saved result',description:'all original content',dueBy:'2099-01-01T00:00:00Z'});expect(created.status).toBe(201);
  expect((await request(app).patch(`/evolution/actions/${created.body.id}`).set(auth).send({status:'completed',resolution:'verified result'})).status).toBe(200);
  expect((await request(app).post('/evolution/actions').set(auth).send({title:'open obligation',description:'must remain',dueBy:'2099-01-01T00:00:00Z'})).status).toBe(201);
  await s.stop();servers.splice(servers.indexOf(s),1);s=boot(d);await s.start();app=s.getApp();
  const hot=await request(app).get('/evolution/actions').set(auth);expect(hot.body.actions).toHaveLength(1);expect(hot.body.actions[0].title).toBe('open obligation');
  const archived=await request(app).get(`/evolution/archive?kind=actions&id=${created.body.id}`).set(auth);expect(archived.status).toBe(200);expect(archived.body.entries[0].record).toMatchObject({title:'saved result',description:'all original content',dueBy:'2099-01-01T00:00:00Z',status:'completed',resolution:'verified result'});
  const stats=await request(app).get('/evolution/retention?scope=local').set(auth);expect(stats.status).toBe(200);expect(stats.body.stores.actions).toMatchObject({total:1,active:1,terminalRetained:0,overflow:0});
 });
});
