import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js'; import { StateManager } from '../../src/core/StateManager.js'; import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AutonomousThroughputFloor } from '../../src/monitoring/AutonomousThroughputFloor.js'; import type { InstarConfig } from '../../src/core/types.js';
const AUTH='throughput-floor-test'; let tmp=''; let server: AgentServer; let app: ReturnType<AgentServer['getApp']>;
describe('GET /autonomous/throughput-floor', () => {
 beforeAll(async()=>{ tmp=fs.mkdtempSync(path.join(os.tmpdir(),'throughput-floor-')); const stateDir=path.join(tmp,'.instar'); fs.mkdirSync(stateDir,{recursive:true}); fs.writeFileSync(path.join(stateDir,'config.json'),'{}');
  const floor=new AutonomousThroughputFloor({listRuns:()=>[],sweep:async()=>({status:'unknown',failure:'github-read'}),observeOutbound:()=>({coverage:'proven'}),loadState:()=>null,saveState:()=>{},audit:()=>{},now:()=>1234},{enabled:true});
  const config={projectName:'tf',projectDir:tmp,stateDir,port:0,authToken:AUTH,requestTimeoutMs:10000,version:'0',sessions:{claudePath:'/usr/bin/echo',maxSessions:1,protectedSessions:[],monitorIntervalMs:5000},scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],updates:{},monitoring:{}} as unknown as InstarConfig;
  server=new AgentServer({config,sessionManager:{listRunningSessions:()=>[],getSession:()=>null} as never,state:new StateManager(stateDir),autonomousThroughputFloor:floor}); await server.start(); app=server.getApp(); await floor.tick(); });
 afterAll(async()=>{await server.stop(); SafeFsExecutor.safeRmSync(tmp,{recursive:true,force:true,operation:'throughput-floor-test'});});
 it('is authenticated and exposes the pull/audit-only posture',async()=>{expect((await request(app).get('/autonomous/throughput-floor')).status).toBe(401); const r=await request(app).get('/autonomous/throughput-floor').set({Authorization:`Bearer ${AUTH}`}); expect(r.status).toBe(200); expect(r.body).toMatchObject({enabled:true,mode:'pull-audit-only',lastTickAt:1234});});
});
