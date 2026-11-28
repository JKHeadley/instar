// safe-fs-allow: isolated HTTP fixture cleanup uses SafeFsExecutor.
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import { identityKey, type LoginSummary } from '../../src/monitoring/quotaPacing.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'manual balance HTTP cleanup' }); });
function fixture(freshReset = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-balance-http-')); dirs.push(dir);
  const state = new StateManager(dir); const pool = new SubscriptionPool({ stateDir: dir }); const now = Date.now();
  const reset = new Date(now + 60 * 3_600_000).toISOString();
  const forecastsForAccounts: LoginSummary[] = [];
  for (const id of ['source','amrch','sagemindai']) {
    const home = path.join(dir,id); fs.mkdirSync(home);
    pool.addFixture({ id, nickname: id, email: `${id}@example.test`, framework:'codex-cli', provider:'openai', configHome: home });
    const cold = freshReset && id !== 'source';
    const hoursLeft = cold ? (id === 'amrch' ? 166 : 164) : 60;
    const resetsAt = cold ? new Date(now + hoursLeft * 3_600_000).toISOString() : reset;
    const usage = cold ? 0 : 11;
    pool.update(id, { lastQuota: { source: 'codex-app-server', measuredAt: new Date(now).toISOString(),
      windowsListed: ['sevenDay'], sevenDay: { utilizationPct: usage, resetsAt } } });
    if (id !== 'source') {
      forecastsForAccounts.push({ accountId: id, identity: identityKey('openai', `${id}@example.test`),
        provider: 'openai', framework: 'codex-cli', fresh: true, sourceKind: 'live',
        newestMeasuredAt: new Date(now).toISOString(),
        sevenDay: { used: usage, central: cold ? null : (id === 'amrch' ? 20 : 30), hoursLeft,
          resetsAt, reason: cold ? 'not-enough-readings' : null },
      } as LoginSummary);
    }
  }
  for (const id of ['one','two','three','four']) state.saveSession({ id, name:id, tmuxSession:`topic-${id}`, framework:'codex-cli', subscriptionAccountId:'source', status:'running', startedAt:new Date().toISOString() } as any);
  let forecasts: LoginSummary[] | null = forecastsForAccounts;
  const targets:string[]=[]; let busy=false;
  const refresh = vi.fn(async (intent: {sessionName:string;accountId:string;callerClass?:string}) => {
    expect(intent.callerClass).toBe('interactive-refresh');
    if (busy) return {ok:false,code:'session-busy'};
    targets.push(intent.accountId); await new Promise(resolve=>setTimeout(resolve,2));
    const old=state.listSessions().find(s=>s.tmuxSession===intent.sessionName && s.status==='running')!;
    state.saveSession({...old,status:'completed'});state.saveSession({...old,id:old.id+'-new',subscriptionAccountId:intent.accountId});
    return {ok:true};
  });
  const scheduler=new QuotaAwareScheduler({listAccounts:()=>pool.list(),refreshFn:refresh});
  const app=express();app.use(express.json());app.use(createRoutes({config:{authToken:'fixture',stateDir:dir,projectDir:dir,sessions:{},subscriptionPool:{}},startTime:new Date(),state,subscriptionPool:pool,quotaAwareScheduler:scheduler,manualBalanceForecasts:async()=>forecasts,sessionManager:{} } as any));
  const swap=(name='one',extra:Record<string,unknown>={})=>request(app).post('/subscription-pool/swap').set('Authorization','Bearer fixture').send({sessionName:`topic-${name}`,exhaustedAccountId:'source',balanceUnusedQuota:true,...extra});
  return {app,swap,targets,refresh,state,pool,scheduler,setForecasts:(v:LoginSummary[]|null)=>{forecasts=v;},setBusy:()=>{busy=true;}};
}
describe('explicit manual balance HTTP',()=>{
  it('four concurrent moves use both forecast targets through the real scheduler',async()=>{
    const x=fixture();const results=await Promise.all(['one','two','three','four'].map(id=>x.swap(id)));
    expect(results.every(r=>r.status===200&&r.body.swapped)).toBe(true);expect(x.targets).toEqual(['amrch','sagemindai','amrch','sagemindai']);
  });
  it('balances two verified fresh resets while their forecast is warming up', async () => {
    const x = fixture(true);
    const first = await x.swap('one');
    const second = await x.swap('two');
    expect(first.body).toMatchObject({ swapped: true, toAccountId: 'amrch' });
    expect(second.body).toMatchObject({ swapped: true, toAccountId: 'sagemindai' });
    expect(x.targets).toEqual(['amrch', 'sagemindai']);
  });
  it('unknown forecasts do not silently use reset-first; invalid flag types are rejected',async()=>{
    const x=fixture();x.setForecasts(null);
    expect((await x.swap()).body.reason).toBe('manual-balance-forecast-unavailable');expect(x.refresh).not.toHaveBeenCalled();
    expect((await x.swap('one',{balanceUnusedQuota:'true'})).status).toBe(400);
    expect((await x.swap('one',{exhaustedAccountId:'other'})).body.reason).toBe('manual-balance-source-changed');
  });
  it('busy work remains refused and no balancing authority reaches ordinary manual swaps',async()=>{
    const x=fixture();x.setBusy();expect((await x.swap()).body.reason).toBe('session-busy');
    expect(x.targets).toEqual([]);
    const ordinary=vi.spyOn(x.scheduler,'onQuotaPressure').mockResolvedValue({swapped:false,toAccountId:null,reason:'ordinary-path'});
    expect((await x.swap('two',{balanceUnusedQuota:false})).body.reason).toBe('ordinary-path');
    expect(ordinary).toHaveBeenCalledWith(expect.not.objectContaining({manualBalanceTarget:expect.anything()}));
  });
});
