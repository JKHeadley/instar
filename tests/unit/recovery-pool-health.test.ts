import {afterEach,describe,expect,it} from 'vitest';
import {observeRecoveryPeer,recoveryPoolHealth} from '../../src/recovery/RecoveryPoolHealth.js';
import type {RecoveryRuntimeStatus} from '../../src/recovery/RecoveryRuntime.js';
const now=2_000_000;
const globals=globalThis as unknown as {__instarRecoveryRuntime?:{status:()=>RecoveryRuntimeStatus}};
afterEach(()=>{delete globals.__instarRecoveryRuntime;});
function source(id:string,target:string,route:'both'|'ssh'|'relay'='both'):RecoveryRuntimeStatus {
  const proof=(r:'ssh'|'relay')=>({state:route==='both'||route===r?'proven':'unknown',observedAt:now,expiresAt:now+300_000,sourceMachineId:id,pairingEpoch:1,credentialGeneration:1,bootId:'boot',targetKeyFingerprint:'key-'+target+'-'+r});
  return {scope:'source-machine',sourceMachineId:id,credentialGeneration:1,enabled:true,ready:route==='both',reason:'test',commonDependencies:[],targets:[{machineId:target,ready:route==='both',reason:'test',routes:{ssh:proof('ssh'),relay:proof('relay')}}]};
}
describe('authenticated source recovery projections',()=>{
  it('requires source proof in both directions before the pool is ready',()=>{
    globals.__instarRecoveryRuntime={status:()=>source('pool-self','pool-peer')};
    expect(recoveryPoolHealth('pool-self',['pool-peer'],now)).toMatchObject({scope:'pool',ready:false});
    observeRecoveryPeer('pool-peer',source('pool-peer','pool-self'),now);
    expect(recoveryPoolHealth('pool-self',['pool-peer'],now)).toMatchObject({scope:'pool',ready:true,targets:[{machineId:'pool-peer',testedSources:['pool-self']},{machineId:'pool-self',testedSources:['pool-peer']}]});
  });
  it('does not stitch independent half-proofs from different source machines',()=>{
    observeRecoveryPeer('half-a',source('half-a','half-target','ssh'),now);
    observeRecoveryPeer('half-b',source('half-b','half-target','relay'),now);
    expect(recoveryPoolHealth(null,['half-a','half-b','half-target'],now)).toMatchObject({ready:false,targets:expect.arrayContaining([{machineId:'half-target',ready:false,testedSources:[],reason:'missing-fresh-peer-proof'}])});
  });
  it('invalidates cached readiness when the agreed pair epoch or current listener key changes',()=>{
    globals.__instarRecoveryRuntime={status:()=>source('epoch-source','epoch-target')};
    const target=source('epoch-target','epoch-source');observeRecoveryPeer('epoch-target',target,now);
    expect(recoveryPoolHealth('epoch-source',['epoch-target'],now,{'epoch-source':1,'epoch-target':2})).toMatchObject({ready:false});
    observeRecoveryPeer('epoch-target',{...target,listenerKeys:{ssh:'changed-key',relay:'changed-key'}},now);
    expect(recoveryPoolHealth('epoch-source',['epoch-target'],now)).toMatchObject({targets:expect.arrayContaining([{machineId:'epoch-target',ready:false,testedSources:[],reason:'missing-fresh-peer-proof'}])});
  });
  it('fails closed when another fresh source sees a different target boot',()=>{
    globals.__instarRecoveryRuntime={status:()=>source('boot-source','boot-target')};
    const partial=source('boot-observer','boot-target','ssh');partial.targets[0].routes.ssh.bootId='new-boot';partial.targets[0].routes.ssh.observedAt=now+1;
    observeRecoveryPeer('boot-observer',partial,now+1);
    expect(recoveryPoolHealth('boot-source',['boot-target','boot-observer'],now+1)).toMatchObject({targets:expect.arrayContaining([{machineId:'boot-target',ready:false,testedSources:[],reason:'target-boot-observations-disagree'}])});
  });
  it('treats a dark source, expired receipt, mismatched source identity and disabled observer as unknown',()=>{
    observeRecoveryPeer('stale-peer',source('stale-peer','stale-target'),now);
    expect(recoveryPoolHealth(null,['stale-peer','stale-target'],now+300_001)).toMatchObject({ready:false,sources:expect.arrayContaining([{machineId:'stale-peer',state:'unknown'}])});
    observeRecoveryPeer('mismatch-peer',source('foreign','mismatch-target'),now);
    expect(recoveryPoolHealth(null,['mismatch-peer','mismatch-target'],now)).toMatchObject({sources:expect.arrayContaining([{machineId:'mismatch-peer',state:'unknown'}])});
    observeRecoveryPeer('disabled-peer',{...source('disabled-peer','disabled-target'),enabled:false},now);
    expect(recoveryPoolHealth(null,['disabled-peer','disabled-target'],now)).toMatchObject({targets:expect.arrayContaining([{machineId:'disabled-target',ready:false,testedSources:[],reason:'missing-fresh-peer-proof'}])});
  });
});
