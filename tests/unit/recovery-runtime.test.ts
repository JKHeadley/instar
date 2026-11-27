import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecoveryRuntime, currentRecoveryStatus } from '../../src/recovery/RecoveryRuntime.js';
import { recoveryKeyPair,recoveryKeyFingerprint } from '../../src/recovery/RecoveryProtocol.js';
import { recoveryServiceId } from '../../src/recovery/RecoveryInstallation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const directories:string[]=[];
const runtimes:RecoveryRuntime[]=[];
function fixture(enabled=true,onSetupRequired?:(reason:string)=>Promise<void>) {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-runtime-'));directories.push(stateDir);
  let pairs=[{machineId:'target',pairingEpoch:1}];
  const probe=vi.fn(async()=>{throw new Error('recovery-ssh-timeout');});
  const install=vi.fn(async()=>({state:'awaiting-peer-proofs' as const,labels:[]}));
  const runtime=new RecoveryRuntime({stateDir,agentId:'agent',machineId:'source',enabled,paired:()=>pairs,probe,install,onSetupRequired,entrypoint:'/installed/scripts/recovery-entrypoint.mjs'});
  runtimes.push(runtime);
  return {runtime,probe,install,stateDir,revoke:()=>{pairs=[];}};
}
function enroll(f:ReturnType<typeof fixture>) {
  const keys=recoveryKeyPair(),relay=recoveryKeyPair(),root=path.join(f.stateDir,'recovery'),host=path.join(root,'host.json');
  fs.writeFileSync(host,JSON.stringify({version:1,agentId:'agent',machineId:'source',stateDir:path.join(root,'admission'),certificationRoot:keys.publicKey,
    sshPrivateKey:keys.privateKey,relayPrivateKey:relay.privateKey,relayUrl:'https://relay.invalid',serviceLabel:`com.instar.recovery-target.${recoveryServiceId('agent','source')}`,healthPort:1234}),{mode:0o600});
  fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify({version:1,agentId:'agent',machineId:'source',hostConfigFile:host,peers:[{
    agentId:'agent',sourceMachineId:'source',targetMachineId:'target',bootId:'old',pairingEpoch:1,generation:1,
    sshSigningPrivateKey:keys.privateKey,relaySigningPrivateKey:keys.privateKey,targetSshPublicKey:keys.publicKey,targetRelayPublicKey:keys.publicKey,
    relayUrl:'https://relay.invalid',ssh:{host:'unused.invalid',port:22,username:'unused',privateKey:'unused',hostFingerprint:'unused'},
  }]}),{mode:0o600});
  return {ssh:keys.publicKey,relay:relay.publicKey};
}
afterEach(()=>{
  for(const runtime of runtimes.splice(0))runtime.stop();
  for(const dir of directories.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-runtime.test:cleanup'});
  vi.useRealTimers();
});
describe('production recovery observer lifecycle',()=>{
  it('leaves host services untouched while dark and reports setup explicitly',async()=>{
    const f=fixture(false);enroll(f);await f.runtime.start();
    expect(f.install).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();
    expect(f.runtime.status()).toMatchObject({ready:false,reason:'recovery-disabled'});
  });
  it('keeps missing setup visible on a dark fleet observer without granting or probing',async()=>{
    const attention=vi.fn(async()=>{}),f=fixture(false,attention);await f.runtime.start();await new Promise(resolve=>setImmediate(resolve));
    expect(attention).toHaveBeenCalledWith('recovery-not-enrolled');expect(f.install).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();expect(f.runtime.status().targets[0]).toMatchObject({ready:false,routes:{ssh:{state:'unknown'},relay:{state:'unknown'}}});
  });
  it('publishes only current public listener fingerprints from the private host keys',async()=>{
    const f=fixture(false),keys=enroll(f);await f.runtime.start();const status=f.runtime.status();
    expect(status.listenerKeys).toEqual({ssh:recoveryKeyFingerprint(keys.ssh),relay:recoveryKeyFingerprint(keys.relay)});
    expect(status.listenerKeys?.ssh).not.toBe(status.listenerKeys?.relay);expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');
  });
  it('reports unknown for absent enrollment rather than counting configured SSH as recovery',async()=>{
    const f=fixture();await f.runtime.start();
    expect(f.install).not.toHaveBeenCalled();expect(f.runtime.status()).toMatchObject({ready:false,reason:'recovery-setup-required',targets:[{ready:false,routes:{ssh:{state:'unknown'},relay:{state:'unknown'}}}]});
  });
  it('installs independent services, probes both routes, then schedules without overlapping failures',async()=>{
    vi.useFakeTimers();const f=fixture();enroll(f);await f.runtime.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.install).toHaveBeenCalledOnce();expect(f.probe).toHaveBeenCalledTimes(2);
    expect(f.runtime.status().targets[0].routes).toMatchObject({ssh:{state:'broken'},relay:{state:'broken'}});
    await vi.advanceTimersByTimeAsync(270_000);
    expect(f.probe).toHaveBeenCalledTimes(4);
    f.runtime.stop();await vi.advanceTimersByTimeAsync(300_000);expect(f.probe).toHaveBeenCalledTimes(4);
  });
  it('rechecks current pairing before every route, and removes revoked peers from readiness',async()=>{
    const f=fixture();enroll(f);f.probe.mockImplementationOnce(async()=>{f.revoke();throw new Error('revoked');});
    await f.runtime.start();await new Promise(resolve=>setImmediate(resolve));
    expect(f.probe).toHaveBeenCalledOnce();expect(f.runtime.status()).toMatchObject({ready:false,reason:'no-repair-capable-peer',targets:[]});
  });
  it('rejects a permissive enrollment file and never probes from it',async()=>{
    const f=fixture();enroll(f);fs.chmodSync(path.join(f.stateDir,'recovery','runtime.json'),0o644);
    await f.runtime.start();expect(f.probe).not.toHaveBeenCalled();expect(f.runtime.status().reason).toBe('recovery-runtime-config-invalid');
  });
  it('never derives readiness when the main server has not initialized recovery',()=>{
    expect(currentRecoveryStatus()).toMatchObject({ready:false,reason:'recovery-not-initialized'});
  });
});
