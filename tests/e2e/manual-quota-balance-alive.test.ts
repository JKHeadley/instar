// safe-fs-allow: production-wiring fixtures use isolated history/session files.
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import { identityKey } from '../../src/monitoring/quotaPacing.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
async function boot(enabled:boolean){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'manual-balance-alive-'));cleanups.push(()=>SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'manual balance lifecycle cleanup'}));
  const stateDir=path.join(dir,'.instar');const history=path.join(stateDir,'state/quota-history');fs.mkdirSync(history,{recursive:true});fs.writeFileSync(path.join(stateDir,'config.json'),'{}');
  const state=new StateManager(stateDir);const pool=new SubscriptionPool({stateDir});const now=Date.now();const reset=new Date(now+60*3_600_000).toISOString();
  for(const id of ['source','amrch','sagemindai']){
    const home=path.join(dir,id);fs.mkdirSync(home);pool.addFixture({id,nickname:id,email:`${id}@example.test`,provider:'openai',framework:'codex-cli',configHome:home});
    pool.update(id,{lastQuota:{measuredAt:new Date(now).toISOString(),windowsListed:['sevenDay'],sevenDay:{utilizationPct:11,resetsAt:reset}}});
    const rows=[18,12,6,0].map(hours=>({v:1,polledAt:new Date(now-hours*3_600_000).toISOString(),measuredAt:new Date(now-hours*3_600_000).toISOString(),identity:identityKey('openai',`${id}@example.test`),source:'codex-app-server',drifted:false,windows:{sevenDay:{pct:11,resetsAt:reset}}}));
    fs.writeFileSync(path.join(history,id+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  }
  for(const id of ['one','two'])state.saveSession({id,name:id,tmuxSession:`topic-${id}`,framework:'codex-cli',subscriptionAccountId:'source',status:'running',startedAt:new Date().toISOString()} as any);
  const targets:string[]=[];
  const scheduler=new QuotaAwareScheduler({listAccounts:()=>pool.list(),refreshFn:async intent=>{
    expect(intent.callerClass).toBe('interactive-refresh');targets.push(intent.accountId);
    const old=state.listSessions().find(s=>s.tmuxSession===intent.sessionName&&s.status==='running')!;
    state.saveSession({...old,status:'completed'});state.saveSession({...old,id:old.id+'-new',subscriptionAccountId:intent.accountId});return true;
  }});
  const sessionManager=createMockSessionManager() as any;sessionManager.on=()=>undefined;
  const config={projectName:'manual-balance-alive',projectDir:dir,stateDir,port:0,authToken:'fixture',developmentAgent:enabled,sessions:{claudePath:'/usr/bin/echo',maxSessions:5,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],updates:{}} as InstarConfig;
  const server=new AgentServer({config,sessionManager,state,initiativeTracker:new InitiativeTracker(stateDir),subscriptionPool:pool,quotaAwareScheduler:scheduler});cleanups.push(()=>server.stop());
  const swap=(id:string)=>request(server.getApp()).post('/subscription-pool/swap').set('Authorization','Bearer fixture').send({sessionName:`topic-${id}`,exhaustedAccountId:'source',balanceUnusedQuota:true});
  return{swap,targets,server};
}
it('FEATURE ALIVE: real AgentServer local-history callback balances two manual moves without changing reset-first routing',async()=>{
  const x=await boot(true);const first=await x.swap('one');expect(first.status).toBe(200);expect(first.body.swapped,JSON.stringify(first.body)).toBe(true);
  expect((await x.swap('two')).body.swapped).toBe(true);expect(x.targets).toEqual(['amrch','sagemindai']);
});
it('explicit balancing refuses when the production quota ledger is off',async()=>{
  const x=await boot(false);expect((await x.swap('one')).body.reason).toBe('manual-balance-forecast-unavailable');expect(x.targets).toEqual([]);
});
