import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RecoveryRepairCoordinator} from '../../src/recovery/RecoveryRepairCoordinator.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import type {RecoveryPeerTarget} from '../../src/recovery/RecoveryClient.js';
import type {RecoveryReceipt,RecoveryVerb} from '../../src/recovery/RecoveryProtocol.js';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-repair-coordinator.test:cleanup'});});
const target={agentId:'agent',sourceMachineId:'source',targetMachineId:'target',pairingEpoch:1,generation:1} as RecoveryPeerTarget;
function fixture(){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-repair-'));dirs.push(stateDir);
  let now=1_000_000,eligible=true,epoch=1,paired=true,owned=false,statusHealthy=true;
  const notify=vi.fn(async()=>({operationId:'outbox-operation'})),verbs:RecoveryVerb[]=[];
  const execute=vi.fn(async(_target:RecoveryPeerTarget,verb:RecoveryVerb)=>{verbs.push(verb);return {result:'ok',detail:{serverHealthy:verb==='status'&&statusHealthy,ownedWatchdogRecentMutation:owned}} as RecoveryReceipt;});
  const deps={stateDir,now:()=>now,lease:()=>({eligible,epoch}),paired:()=>paired,execute,notify,claimEpisode:async()=>({leaseId:'test-lease',expiresAt:now+120_000,notified:false,episodeId:'test-episode'}),claimNotice:async()=>({claimed:true,idempotencyKey:'stable-notice-key'}),ackNotice:async()=>({accepted:true}),pendingNotices:async()=>({pending:[]}),wait:async(ms:number)=>{now+=ms;}};
  return {deps,verbs,execute,notify,make:()=>new RecoveryRepairCoordinator(deps),advance:(ms:number)=>{now+=ms;},loseLease:()=>{eligible=false;},changeFence:()=>{epoch++;},revoke:()=>{paired=false;},ownedEvidence:()=>{owned=true;},keepDown:()=>{statusHealthy=false;}};
}
describe('pool-fenced bounded recovery',()=>{
  it('diagnoses first and does not pause an unknown watchdog',async()=>{
    const f=fixture();await f.make().observe(target,'ssh',false);
    expect(f.verbs).toEqual(['collect-diagnostics','start-instar-server','status']);
  });
  it('holds only a target-verified owned rule before starting',async()=>{
    const f=fixture();f.ownedEvidence();await f.make().observe(target,'relay',false);
    expect(f.verbs).toEqual(['collect-diagnostics','hold-owned-instar-watchdog','start-instar-server','status','status','restore']);
  });
  it('rechecks the pool fence and pairing after diagnostic IO',async()=>{
    const f=fixture();f.execute.mockImplementationOnce(async()=>{f.changeFence();return {result:'ok',detail:{serverHealthy:false}} as RecoveryReceipt;});
    await expect(f.make().observe(target,'ssh',false)).rejects.toThrow('source-fence-lost');
    expect(f.execute).toHaveBeenCalledOnce();
    f.revoke();await f.make().observe(target,'ssh',false);expect(f.execute).toHaveBeenCalledOnce();
  });
  it('preserves attempt/backoff/breaker state across process reconstruction',async()=>{
    const f=fixture();f.keepDown();await f.make().observe(target,'ssh',false);
    expect(f.verbs.filter(v=>v==='start-instar-server')).toHaveLength(4);
    expect(f.notify).toHaveBeenCalledOnce();
    for(let i=0;i<100;i++)await f.make().observe(target,'relay',false);
    expect(f.verbs.filter(v=>v==='start-instar-server')).toHaveLength(4);
    f.advance(15*60_000);await f.make().observe(target,'ssh',false);
    f.advance(4*3_600_000);
    for(let i=0;i<100;i++)await f.make().observe(target,'relay',false);
    expect(f.verbs.filter(v=>v==='start-instar-server')).toHaveLength(8);
  });
  it('retains a failed notice intent across reconstruction and retries the same budget from its original standby',async()=>{
    const f=fixture();f.keepDown();f.notify.mockRejectedValueOnce(new Error('origin-store-temporarily-unavailable'));
    await f.make().observe(target,'ssh',false);expect(f.notify).toHaveBeenCalledOnce();
    expect(f.make().status(target).notice?.state).toBe('delivery-pending');
    f.loseLease();await f.make().retryPending(target);
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.notify.mock.calls.map(c=>c[0])).toEqual(['stable-notice-key','stable-notice-key']);
    await f.make().retryPending(target);expect(f.notify).toHaveBeenCalledTimes(2);
  });
  it('resets exhausted source state only for a strictly higher verified target repair epoch',async()=>{
    const f=fixture();f.keepDown();await f.make().observe(target,'ssh',false);f.advance(15*60_000);await f.make().observe(target,'ssh',false);
    expect(f.verbs.filter(v=>v==='start-instar-server')).toHaveLength(8);
    const proof=(repairEpoch:number)=>({response:{payload:{detail:{repairEpoch,repairBudgetAvailable:true}}}} as never);
    await f.make().observe(target,'ssh',false,proof(0));expect(f.verbs.filter(v=>v==='start-instar-server')).toHaveLength(8);
    await f.make().observe(target,'ssh',false,proof(1));expect(f.verbs.filter(v=>v==='start-instar-server')).toHaveLength(12);
  });
  it('does not spend source attempts against a target-reported breaker or deliberate sleep',async()=>{
    const f=fixture();
    await f.make().observe(target,'ssh',false,{response:{payload:{detail:{repairEpoch:0,repairBudgetAvailable:false,repairBudgetExhausted:false}}}} as never);
    expect(f.execute).not.toHaveBeenCalled();expect(f.make().status(target).state).toBe('cooling-down');
    f.notify.mockClear();
    await f.make().observe(target,'ssh',false,{response:{payload:{detail:{repairEpoch:0,repairBudgetAvailable:false,repairBudgetExhausted:true,repairSuppressed:true,repairSuppressionReason:'intentional-sleep'}}}} as never);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();expect(f.make().status(target).state).toBe('paused-by-target-intent');
  });
  it('recovers a reserved notice lost before local enqueue without acquiring a new repair lease',async()=>{
    const f=fixture(),key='recovery-notice-'+ 'a'.repeat(64);f.loseLease();
    f.deps.pendingNotices=async()=>({pending:[{idempotencyKey:key,leaseId:'old-owned-reservation',sourceLeaseEpoch:1,noticeSenderMachineId:'source'}]});
    await f.make().retryPending(target);
    expect(f.notify).toHaveBeenCalledWith(key,'A recovery episode needed attention. Open Recovery for current status.');expect(f.execute).not.toHaveBeenCalled();
  });
  it('never mutates from an unfenced standby even with a valid route',async()=>{
    const f=fixture();f.loseLease();await f.make().observe(target,'ssh',false);
    expect(f.execute).not.toHaveBeenCalled();expect(f.notify).not.toHaveBeenCalled();
  });
});
