import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecoveryClient, RecoveryProofStore,recoveryTransportConfigDigest, type RecoveryPeerTarget, type RecoveryProbeEvidence } from '../../src/recovery/RecoveryClient.js';
import { RecoveryAdmission } from '../../src/recovery/RecoveryAdmission.js';
import { RecoveryEngine } from '../../src/recovery/RecoveryEngine.js';
import { OFFLINE_LEASE_MS, recoveryDigest, recoveryKeyPair, signRecovery, type RecoveryCheckpoint, type RecoveryCertificate, type RecoveryEnvelope, type RecoveryReceipt, type RecoveryDiscovery } from '../../src/recovery/RecoveryProtocol.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const root=recoveryKeyPair(), authority=recoveryKeyPair(), sourceSsh=recoveryKeyPair(), sourceRelay=recoveryKeyPair(), targetSsh=recoveryKeyPair(), targetRelay=recoveryKeyPair();
const target:RecoveryPeerTarget={agentId:'a',sourceMachineId:'s',targetMachineId:'t',bootId:'old-boot',pairingEpoch:1,generation:1,
  sshSigningPrivateKey:sourceSsh.privateKey,relaySigningPrivateKey:sourceRelay.privateKey,targetSshPublicKey:targetSsh.publicKey,targetRelayPublicKey:targetRelay.publicKey,
  relayUrl:'https://relay.invalid',ssh:{host:'unused.invalid',port:22,username:'unused',privateKey:'unused',hostFingerprint:'unused'}};
const dirs:string[]=[];
function directory():string {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-evidence-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-client.test:cleanup'});});
function evidence():RecoveryProbeEvidence {
  const now=Date.now();
  const e:RecoveryEnvelope={domain:'instar-recovery-operation-v1',agentId:'a',sourceMachineId:'s',targetMachineId:'t',targetBootId:'current-boot',pairingEpoch:1,generation:1,route:'relay',
    operationId:crypto.randomUUID(),nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30_000,fencingEpoch:1,verb:'status'};
  const r:RecoveryReceipt={domain:'instar-recovery-receipt-v1',agentId:'a',sourceMachineId:'s',targetMachineId:'t',targetBootId:'current-boot',operationId:e.operationId,requestDigest:recoveryDigest(e),
    route:'relay',observedAt:now,checkpointVersion:1,result:'ok',detail:{serverHealthy:false,repairEpoch:0,repairBudgetAvailable:true,repairBudgetExhausted:false,hostBootId:'current-boot',leaseExpiresAt:now+OFFLINE_LEASE_MS,
      independentRuntime:true,listenerPid:100,listenerParentPid:1,listenerSupervisor:'com.instar.recovery-sidecar.'+'a'.repeat(32)}};
  return {request:signRecovery(e,sourceRelay.privateKey),response:signRecovery(r,targetRelay.privateKey),
    transport:signRecovery({domain:'instar-recovery-transport-observation-v1',requestDigest:recoveryDigest(e),route:'relay',interface:'en0',
      nextHopDigest:'a'.repeat(64),endpointDigest:'b'.repeat(64),configurationDigest:recoveryTransportConfigDigest(target,'relay'),observedAt:now},sourceRelay.privateKey)};
}

describe('source-bound recovery evidence',()=>{
  it.each([-5000,20,5000,30000])('handles bounded target clock skew (%d ms) without extending source freshness',skew=>{
    const e=evidence(),now=e.transport.payload.observedAt;
    e.response=signRecovery({...e.response.payload,observedAt:now+skew},targetRelay.privateKey);
    const proof=new RecoveryClient(target).proof(e,now);
    expect(proof.observedAt).toBe(now);expect(proof.expiresAt).toBeLessThanOrEqual(now+300000);
    expect(()=>new RecoveryClient(target).proof(e,now+300000)).toThrow();
  });
  it('refuses excessive target skew, source clock rollback and nearly expired target leases',()=>{
    const e=evidence(),now=e.transport.payload.observedAt,client=new RecoveryClient(target);
    expect(()=>client.proof({...e,response:signRecovery({...e.response.payload,observedAt:now+30001},targetRelay.privateKey)},now)).toThrow();
    expect(()=>client.proof(e,now-1)).toThrow();
    expect(()=>client.proof({...e,response:signRecovery({...e.response.payload,detail:{...e.response.payload.detail,leaseExpiresAt:now+1000}},targetRelay.privateKey)},now)).toThrow();
    expect(()=>client.proof({...e,response:signRecovery({...e.response.payload,detail:{...e.response.payload.detail,leaseExpiresAt:now+60000}},targetRelay.privateKey)},now+30001)).toThrow();
  });
  it('derives a route proof from a signed status receipt while the main server is down',()=>{
    const proof=new RecoveryClient(target).proof(evidence());
    expect(proof.bootId).toBe('current-boot');expect(proof.route).toBe('relay');
    expect(proof.sourceMachineId).toBe('s');expect(proof.processDomain).toBe('current-boot:100');
  });
  it('rejects fabricated, expired and cross-target persisted receipts',()=>{
    const e=evidence(),client=new RecoveryClient(target);
    expect(()=>client.proof({...e,response:{...e.response,payload:{...e.response.payload,result:'failed'}}})).toThrow('receipt-invalid');
    expect(()=>client.proof(e,e.response.payload.observedAt+300_000)).toThrow('proof-invalid');
    expect(()=>new RecoveryClient({...target,targetMachineId:'foreign'}).proof(e)).toThrow('proof-invalid');
  });
  it('requires bound source-observed routing and target-signed listener identity',()=>{
    const e=evidence(),client=new RecoveryClient(target);
    expect(()=>client.proof({...e,transport:undefined as never})).toThrow('transport-observation-invalid');
    expect(()=>client.proof({...e,transport:signRecovery({...e.transport.payload,requestDigest:'0'.repeat(64)},sourceRelay.privateKey)})).toThrow('transport-observation-invalid');
    const response=signRecovery({...e.response.payload,detail:{serverHealthy:false,hostBootId:'current-boot',leaseExpiresAt:Date.now()+OFFLINE_LEASE_MS}},targetRelay.privateKey);
    expect(()=>client.proof({...e,response})).toThrow('proof-invalid');
  });
  it('refuses to qualify a listener dependent on the mutable main installation',()=>{
    const e=evidence();
    const response=signRecovery({...e.response.payload,detail:{...e.response.payload.detail,independentRuntime:false}},targetRelay.privateKey);
    expect(()=>new RecoveryClient(target).proof({...e,response})).toThrow('proof-invalid');
  });
  it('revalidates every saved proof and treats changed keys or tampering as unknown',()=>{
    const dir=directory(),store=new RecoveryProofStore(dir),e=evidence();store.save(target,e);
    expect(store.read(target,'relay')?.bootId).toBe('current-boot');
    expect(store.read({...target,targetRelayPublicKey:sourceRelay.publicKey},'relay')).toBeNull();
    expect(store.read({...target,relayUrl:'https://changed-relay.invalid'},'relay')).toBeNull();
    const file=path.join(dir,fs.readdirSync(dir)[0]);
    const changed=JSON.parse(fs.readFileSync(file,'utf8'));changed.response.payload.targetBootId='forged';
    fs.writeFileSync(file,JSON.stringify(changed));expect(store.read(target,'relay')).toBeNull();
  });
  it('persists a newer failed-route invalidation across source-store reconstruction',()=>{
    const dir=directory(),store=new RecoveryProofStore(dir);store.save(target,evidence());
    expect(new RecoveryProofStore(dir).read(target,'relay')).not.toBeNull();
    store.invalidate(target,'relay');
    expect(new RecoveryProofStore(dir).read(target,'relay')).toBeNull();
  });
  it('discovers a new host boot with a signed challenge independently of SSH',()=>{
    const admission=new RecoveryAdmission({stateDir:directory(),agentId:'a',machineId:'t',bootId:'new-host-boot',certificationRoot:root.publicKey});
    try {
      const now=Date.now();
      const cert:RecoveryCertificate={domain:'instar-recovery-certificate-v1',agentId:'a',publicKey:authority.publicKey,generation:1,issuedAt:now,expiresAt:now+30*OFFLINE_LEASE_MS};
      const checkpoint:RecoveryCheckpoint={domain:'instar-recovery-checkpoint-v1',agentId:'a',targetMachineId:'t',challenge:admission.challenge(),version:1,issuedAt:now,expiresAt:now+OFFLINE_LEASE_MS,
        principals:[{machineId:'s',pairingEpoch:1,generation:1,sshPublicKey:sourceSsh.publicKey,relayPublicKey:sourceRelay.publicKey}],revoked:[]};
      admission.acceptCheckpoint(signRecovery(cert,root.privateKey),signRecovery(checkpoint,authority.privateKey));
      const config={version:1 as const,agentId:'a',machineId:'t',stateDir:directory(),certificationRoot:root.publicKey,sshPrivateKey:targetSsh.privateKey,relayPrivateKey:targetRelay.privateKey,
        relayUrl:'https://unused.invalid',serviceLabel:'unused',healthPort:1};
      const control={status:async()=>false,start:async()=>{},stop:async()=>{},watchdogActive:async()=>false,holdWatchdog:async()=>{},restoreWatchdog:async()=>{}};
      const engine=new RecoveryEngine(config,admission,'new-host-boot',control);
      const request:RecoveryDiscovery={domain:'instar-recovery-discovery-v1',agentId:'a',sourceMachineId:'s',targetMachineId:'t',pairingEpoch:1,generation:1,route:'relay',
        nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30_000};
      const hello=engine.hello(signRecovery(request,sourceRelay.privateKey),'relay');
      expect(hello.payload.bootId).toBe('new-host-boot');expect(hello.payload.nonce).toBe(request.nonce);
      expect(()=>engine.hello(signRecovery(request,sourceSsh.privateKey),'relay')).toThrow('principal-refused');
      expect(()=>engine.hello(signRecovery({...request,sourceMachineId:'foreign'},sourceRelay.privateKey),'relay')).toThrow('principal-refused');
    } finally {admission.close();}
  });
});
