import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { RecoveryAdmission } from '../../src/recovery/RecoveryAdmission.js';
import { RecoveryEngine } from '../../src/recovery/RecoveryEngine.js';
import { RecoveryClient, type RecoveryPeerTarget } from '../../src/recovery/RecoveryClient.js';
import { RecoveryControlPlane } from '../../src/recovery/RecoveryControlPlane.js';
import { OFFLINE_LEASE_MS, recoveryKeyPair, signRecovery, type RecoveryCertificate, type RecoveryCheckpoint } from '../../src/recovery/RecoveryProtocol.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('authority checkpoint carried through SSH handlers with real relay HTTP',()=>{
  let dir:string,admission:RecoveryAdmission,server:http.Server;
  afterEach(async()=>{admission?.close();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));if(dir)SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-checkpoint-carry.test:cleanup'});});
  it('restores an expired lease, delivers a revoke and returns target acknowledgement without target relay connectivity',async()=>{
    const root=recoveryKeyPair(),signer=recoveryKeyPair(),ssh=recoveryKeyPair(),relay=recoveryKeyPair(),targetSsh=recoveryKeyPair(),targetRelay=recoveryKeyPair();
    const now=Date.now();let uptime=1_000;
    const certificate=signRecovery<RecoveryCertificate>({domain:'instar-recovery-certificate-v1',agentId:'a',publicKey:signer.publicKey,generation:1,issuedAt:now-1000,expiresAt:now+30*OFFLINE_LEASE_MS},root.privateKey);
    const principal={machineId:'s',pairingEpoch:1,generation:1,sshPublicKey:ssh.publicKey,relayPublicKey:relay.publicKey};
    dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-carried-checkpoint-'));
    admission=new RecoveryAdmission({stateDir:dir,agentId:'a',machineId:'t',bootId:'boot',certificationRoot:root.publicKey,uptime:()=>uptime});
    const initial:RecoveryCheckpoint={domain:'instar-recovery-checkpoint-v1',agentId:'a',targetMachineId:'t',challenge:admission.challenge(),version:1,issuedAt:now,expiresAt:now+OFFLINE_LEASE_MS,principals:[principal],revoked:[]};
    admission.acceptCheckpoint(certificate,signRecovery(initial,signer.privateKey));
    const state=new Map<string,unknown>();
    state.set('target:a:t',{agentId:'a',machineId:'t',publicKey:targetRelay.publicKey,principals:[principal],revoked:[],version:1,acknowledgement:1,ownerSequence:1});
    const control=new RecoveryControlPlane({recoveryRead:key=>state.get(key),recoveryWrite:(key,value)=>{state.set(key,value);},recoveryTransaction:fn=>fn()},
      new Map([['a',{certificate,privateKey:signer.privateKey,owner:{deviceId:'owner',publicKey:'unused',host:'test.invalid',active:true}}]]));
    server=http.createServer((req,res)=>{void control.handle(req,res,new URL(req.url!,'http://localhost').pathname);});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const engine=new RecoveryEngine({version:1,agentId:'a',machineId:'t',stateDir:dir,certificationRoot:root.publicKey,sshPrivateKey:targetSsh.privateKey,relayPrivateKey:targetRelay.privateKey,
      relayUrl:'https://target-network-blocked.invalid',serviceLabel:'unused',healthPort:1},admission,'boot',{
      status:async()=>{throw new Error('main server must not be needed');},start:async()=>{throw new Error('must not mutate');},stop:async()=>{throw new Error('must not mutate');},watchdogActive:async()=>false,holdWatchdog:async()=>{},restoreWatchdog:async()=>{}});
    const target:RecoveryPeerTarget={agentId:'a',sourceMachineId:'s',targetMachineId:'t',bootId:'boot',pairingEpoch:1,generation:1,
      sshSigningPrivateKey:ssh.privateKey,relaySigningPrivateKey:relay.privateKey,targetSshPublicKey:targetSsh.publicKey,targetRelayPublicKey:targetRelay.publicKey,
      relayUrl:base,ssh:{host:'unopened',port:22,username:'unopened',privateKey:'unused',hostFingerprint:'unused'}};
    const client=new RecoveryClient(target);
    // Exercise the actual target handlers in place of the physical SSH socket;
    // destructive qualification on two hosts remains a separate live gate.
    (client as unknown as {sshWire:(request:any,command:string)=>Promise<unknown>}).sshWire=async(request,command)=>{
      if(command==='instar-recovery-checkpoint-challenge-v1')return engine.checkpointForCarrier(request);
      if(command==='instar-recovery-checkpoint-deliver-v1')return engine.acceptCarriedCheckpoint(request);
      throw new Error('unexpected SSH command');
    };
    uptime+=OFFLINE_LEASE_MS;expect(admission.lease().ready).toBe(false);
    await client.renewCheckpointViaSsh();expect(admission.lease().ready).toBe(true);
    const targetRow=state.get('target:a:t') as {principals:unknown[];revoked:string[];version:number;acknowledgement:number};
    targetRow.principals=[];targetRow.revoked=['s'];targetRow.version++;
    const result=await client.renewCheckpointViaSsh();
    expect(targetRow.acknowledgement).toBe(result.checkpointVersion);
    await expect(client.renewCheckpointViaSsh()).rejects.toThrow('recovery-principal-refused');
  });
});
