import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RecoveryAdmission } from '../../src/recovery/RecoveryAdmission.js';
import { OFFLINE_LEASE_MS, recoveryKeyPair, signRecovery, type RecoveryCertificate, type RecoveryCheckpoint, type RecoveryEnvelope } from '../../src/recovery/RecoveryProtocol.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('independent recovery admission', () => {
  let dir: string, store: RecoveryAdmission;
  let now: number, uptime: number;
  const root = recoveryKeyPair(), signer = recoveryKeyPair(), ssh = recoveryKeyPair(), relay = recoveryKeyPair();
  const certificate = (): RecoveryCertificate => ({ domain:'instar-recovery-certificate-v1', agentId:'throwaway', publicKey:signer.publicKey, generation:1, issuedAt:now, expiresAt:now + 30 * OFFLINE_LEASE_MS });
  const checkpoint = (version = 1, revoked: string[] = []): RecoveryCheckpoint => ({ domain:'instar-recovery-checkpoint-v1', agentId:'throwaway', targetMachineId:'target', challenge:store.challenge(), version, issuedAt:now, expiresAt:now + OFFLINE_LEASE_MS,
    principals:revoked.length ? [] : [{ machineId:'source',pairingEpoch:1,generation:1,sshPublicKey:ssh.publicKey,relayPublicKey:relay.publicKey }], revoked });
  const install = (version = 1, revoked: string[] = []) => store.acceptCheckpoint(signRecovery(certificate(), root.privateKey),signRecovery(checkpoint(version,revoked), signer.privateKey));
  const envelope = (overrides: Partial<RecoveryEnvelope> = {}): RecoveryEnvelope => ({ domain:'instar-recovery-operation-v1',agentId:'throwaway',sourceMachineId:'source',targetMachineId:'target',targetBootId:'host-boot',pairingEpoch:1,generation:1,route:'ssh',operationId:crypto.randomUUID(),nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now + 30_000,fencingEpoch:1,verb:'status',...overrides });
  beforeEach(() => {
    now = 1_800_000_000_000; uptime = 100_000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(),'recovery-admission-'));
    store = new RecoveryAdmission({ stateDir:dir,agentId:'throwaway',machineId:'target',bootId:'host-boot',certificationRoot:root.publicKey,now:()=>now,uptime:()=>uptime,processStart:()=>1000 });
  });
  afterEach(() => { store.close(); SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-admission.test:cleanup'}); });
  it('refuses a writable or symlinked admission ledger directory', () => {
    fs.chmodSync(dir,0o777);
    const options={stateDir:dir,agentId:'throwaway',machineId:'target',bootId:'host-boot',certificationRoot:root.publicKey};
    expect(()=>new RecoveryAdmission(options)).toThrow('recovery-state-ownership-invalid');
    fs.chmodSync(dir,0o700);
    const link=path.join(dir,'link');fs.symlinkSync(dir,link);
    expect(()=>new RecoveryAdmission({...options,stateDir:link})).toThrow('recovery-state-ownership-invalid');
  });

  it('keeps concurrent enrollment and sidecar challenges independently one-use',()=>{
    const first=checkpoint(1),second=checkpoint(2);
    store.acceptCheckpoint(signRecovery(certificate(),root.privateKey),signRecovery(first,signer.privateKey));
    store.acceptCheckpoint(signRecovery(certificate(),root.privateKey),signRecovery(second,signer.privateKey));
    expect(store.lease().version).toBe(2);
    expect(()=>store.acceptCheckpoint(signRecovery(certificate(),root.privateKey),signRecovery({...first,version:3},signer.privateKey))).toThrow('checkpoint-invalid');
  });
  it('fences all recovery admission during a durable owned update and cannot clear a foreign update',()=>{
    install();store.beginOwnedUpdate('a'.repeat(64),{pid:process.pid,birth:1000,bootId:'host-boot'});
    expect(()=>store.admit(signRecovery(envelope({verb:'start-instar-server'}),ssh.privateKey),'ssh')).toThrow('owned-update-in-progress');
    expect(()=>store.finishOwnedUpdate('b'.repeat(64))).toThrow('owner-invalid');
    store.finishOwnedUpdate('a'.repeat(64));expect(store.admit(signRecovery(envelope(),ssh.privateKey),'ssh').state).toBe('new');
  });
  it('serializes service installation against running mutations and foreign owned updates without an orphan latch',async()=>{
    install();const e=envelope({verb:'start-instar-server'});store.admit(signRecovery(e,ssh.privateKey),'ssh');let writes=0;
    await expect(store.withServiceInstallation(async()=>++writes)).rejects.toThrow('install-operation-busy');expect(writes).toBe(0);store.complete(e.operationId,{result:'ok'});
    const key='c'.repeat(64);store.beginOwnedUpdate(key,{pid:process.pid,birth:1000,bootId:'host-boot'});
    await expect(store.withServiceInstallation(async()=>++writes)).rejects.toThrow('owned-update-in-progress');
    expect(await store.withServiceInstallation(async()=>++writes,key)).toBe(1);expect(store.ownedUpdate()?.digest).toBe(key);
    store.finishOwnedUpdate(key);
    await expect(store.withServiceInstallation(async()=>{throw Error('OS refused');})).rejects.toThrow('OS refused');
    expect(await store.withServiceInstallation(async()=>++writes)).toBe(2);expect(store.ownedUpdate()).toBeNull();
  });
  it('refuses a stale install activation when uninstall changed its epoch',()=>{
    install();const epoch=store.installationEpoch();store.deactivate();install(2);
    expect(()=>store.activateFromCheckpoint(2,epoch)).toThrow('installation-superseded');
    expect(store.locallyActive()).toBe(false);
  });
  it('admits a paired source through its route-specific key', () => {
    install(); expect(store.admit(signRecovery(envelope(),ssh.privateKey),'ssh').state).toBe('new');
  });
  it('admits independent relay credentials and refuses SSH credentials on relay', () => {
    install(); const e = envelope({route:'relay'});
    expect(()=>store.admit(signRecovery(e,ssh.privateKey),'relay')).toThrow();
    expect(store.admit(signRecovery(e,relay.privateKey),'relay').state).toBe('new');
  });
  it.each([{agentId:'foreign'},{targetMachineId:'other'},{targetBootId:'old-boot'},{pairingEpoch:2},{generation:2},{verb:'sh' as never},{expiresAt:1},{route:'relay' as const},{fencingEpoch:Number.MAX_SAFE_INTEGER}])('refuses incorrect bindings %j', changes => {
    install(); expect(()=>store.admit(signRecovery(envelope(changes),ssh.privateKey),'ssh')).toThrow();
  });
  it('makes retries idempotent and refuses rebound operations or nonce', () => {
    install(); const e = envelope(), signed = signRecovery(e,ssh.privateKey);
    store.admit(signed,'ssh'); store.complete(e.operationId,{result:'ok'});
    expect(store.admit(signed,'ssh')).toEqual({state:'repeat',receipt:{result:'ok'}});
    expect(()=>store.admit(signRecovery({...e,verb:'start-instar-server'},ssh.privateKey),'ssh')).toThrow('rebound');
    expect(()=>store.admit(signRecovery({...e,operationId:crypto.randomUUID()},ssh.privateKey),'ssh')).toThrow('rebound');
  });
  it('keeps a durable breaker beyond the two-minute mutation window', () => {
    install();
    const mutate=(fencingEpoch:number)=> {
      const e=envelope({verb:'start-instar-server',fencingEpoch});
      const result=store.admit(signRecovery(e,ssh.privateKey),'ssh');
      store.complete(e.operationId,{result:'ok'});return result;
    };
    for(let epoch=1;epoch<=4;epoch++)mutate(epoch);
    expect(()=>mutate(5)).toThrow('recovery-attempts-exhausted');
    now+=120_001;uptime+=120_001;
    expect(()=>mutate(6)).toThrow('recovery-breaker-open');
    now+=15*60_000;uptime+=15*60_000;
    for(let epoch=7;epoch<=10;epoch++)mutate(epoch);
    expect(()=>mutate(11)).toThrow('recovery-attempts-exhausted');
    now+=15*60_000;uptime+=15*60_000;
    expect(()=>mutate(12)).toThrow('recovery-episode-exhausted');
    const inspect=envelope({fencingEpoch:13});
    expect(store.admit(signRecovery(inspect,ssh.privateKey),'ssh').state).toBe('new');
  });

  it('re-arms a finite exhausted mutation episode only for a strictly newer signed repair epoch',()=>{
    install();
    const mutate=(fencingEpoch:number)=>{const e=envelope({verb:'start-instar-server',fencingEpoch});const result=store.admit(signRecovery(e,ssh.privateKey),'ssh');store.complete(e.operationId,{result:'ok'});return result;};
    for(let i=1;i<=4;i++)mutate(i);expect(()=>mutate(5)).toThrow('recovery-attempts-exhausted');
    now+=15*60000;uptime+=15*60000;
    for(let i=6;i<=9;i++)mutate(i);expect(()=>mutate(10)).toThrow('recovery-attempts-exhausted');
    expect(store.repairBudget()).toMatchObject({exhausted:true,available:false,repairEpoch:0});
    install(2);expect(()=>mutate(11)).toThrow('recovery-episode-exhausted');
    const rearmed={...checkpoint(3),repairEpoch:1};store.acceptCheckpoint(signRecovery(certificate(),root.privateKey),signRecovery(rearmed,signer.privateKey));
    expect(store.repairBudget()).toMatchObject({exhausted:false,available:true,repairEpoch:1});
    // Old recent mutations must not instantly consume this newly authorized budget.
    for(let i=12;i<=15;i++)expect(mutate(i).state).toBe('new');
    expect(()=>mutate(16)).toThrow('recovery-attempts-exhausted');
    expect(()=>store.acceptCheckpoint(signRecovery(certificate(),root.privateKey),signRecovery({...checkpoint(4),repairEpoch:0},signer.privateKey))).toThrow('recovery-repair-epoch-invalid');
  });
  it('locks across listeners and refuses stale fencing epochs', () => {
    install(); const e = envelope(); store.admit(signRecovery(e,ssh.privateKey),'ssh');
    const other = new RecoveryAdmission({stateDir:dir,agentId:'throwaway',machineId:'target',bootId:'host-boot',certificationRoot:root.publicKey,now:()=>now,uptime:()=>uptime,processStart:()=>1000});
    try { expect(()=>other.admit(signRecovery(envelope({route:'relay',fencingEpoch:2}),relay.privateKey),'relay')).toThrow('busy'); }
    finally { other.close(); }
    store.complete(e.operationId,{result:'ok'});
    expect(()=>store.admit(signRecovery(envelope(),ssh.privateKey),'ssh')).toThrow('fence');
  });
  it('serializes owned watchdog stops with repairs and resumes after a hold expires without the restorer',()=>{
    install();let stopped=0;
    expect(store.runOwnedWatchdogRuleStop(()=>++stopped)).toBe(1);
    const mutation=envelope({verb:'start-instar-server'});store.admit(signRecovery(mutation,ssh.privateKey),'ssh');
    expect(store.runOwnedWatchdogRuleStop(()=>++stopped)).toBeNull();expect(stopped).toBe(1);
    store.complete(mutation.operationId,{result:'ok'});
    store.beginHold({deadline:now+60000,monotonicDeadline:uptime+60000,bootId:'host-boot',original:{label:'owned',plist:'/owned',ownershipDigest:'pinned'}});
    expect(store.runOwnedWatchdogRuleStop(()=>++stopped)).toBeNull();
    now+=60001;uptime+=60001;
    expect(store.runOwnedWatchdogRuleStop(()=>++stopped)).toBe(2);
    expect(store.hold()).not.toBeNull();
    store.clearHold();
    store.beginHold({deadline:now+60000,monotonicDeadline:uptime+60000,bootId:'previous-boot',original:{label:'owned',plist:'/owned',ownershipDigest:'pinned'}});
    expect(store.runOwnedWatchdogRuleStop(()=>++stopped)).toBe(3);
  });
  it('releases a crashed owner whose live PID was reused, requiring inspection before another mutation', () => {
    store.close();
    const options={stateDir:dir,agentId:'throwaway',machineId:'target',bootId:'host-boot',certificationRoot:root.publicKey,now:()=>now,uptime:()=>uptime};
    store=new RecoveryAdmission({...options,processStart:()=>1000});install();
    store.admit(signRecovery(envelope({verb:'start-instar-server'}),ssh.privateKey),'ssh');
    store.close();store=new RecoveryAdmission({...options,processStart:()=>2000});
    expect(()=>store.admit(signRecovery(envelope({verb:'start-instar-server',fencingEpoch:2}),ssh.privateKey),'ssh')).toThrow('recovery-inspection-required');
    const inspect=envelope({fencingEpoch:2});expect(store.admit(signRecovery(inspect,ssh.privateKey),'ssh').state).toBe('new');store.complete(inspect.operationId,{result:'ok'});
    expect(store.admit(signRecovery(envelope({verb:'start-instar-server',fencingEpoch:3}),ssh.privateKey),'ssh').state).toBe('new');
  });
  it('allows diagnostics but refuses host mutations when its own process birth is unavailable', () => {
    store.close();store=new RecoveryAdmission({stateDir:dir,agentId:'throwaway',machineId:'target',bootId:'host-boot',certificationRoot:root.publicKey,now:()=>now,uptime:()=>uptime,processStart:()=>null});install();
    const inspect=envelope();expect(store.admit(signRecovery(inspect,ssh.privateKey),'ssh').state).toBe('new');store.complete(inspect.operationId,{result:'ok'});
    expect(()=>store.admit(signRecovery(envelope({verb:'start-instar-server',fencingEpoch:2}),ssh.privateKey),'ssh')).toThrow('recovery-process-identity-unavailable');
  });

  it('does not free a live owner when its process birth cannot be checked', () => {
    store.close();const options={stateDir:dir,agentId:'throwaway',machineId:'target',bootId:'host-boot',certificationRoot:root.publicKey,now:()=>now,uptime:()=>uptime};
    store=new RecoveryAdmission({...options,processStart:()=>1000});install();store.admit(signRecovery(envelope(),ssh.privateKey),'ssh');
    store.close();store=new RecoveryAdmission({...options,processStart:()=>null});
    expect(()=>store.admit(signRecovery(envelope({fencingEpoch:2}),ssh.privateKey),'ssh')).toThrow('recovery-operation-busy');
  });

  it('refuses self-issued checkpoints, reused challenges and old versions', () => {
    const cert = signRecovery(certificate(),root.privateKey), cp = checkpoint();
    expect(()=>store.acceptCheckpoint(cert,signRecovery(cp,ssh.privateKey))).toThrow();
    const signed = signRecovery(cp,signer.privateKey); store.acceptCheckpoint(cert,signed);
    expect(()=>store.acceptCheckpoint(cert,signed)).toThrow();
    expect(()=>store.acceptCheckpoint(cert,signRecovery(checkpoint(),signer.privateKey))).toThrow();
  });
  it('durably revokes both routes and refuses tombstone rollback', () => {
    install(); install(2,['source']);
    expect(()=>store.admit(signRecovery(envelope(),ssh.privateKey),'ssh')).toThrow();
    expect(()=>store.admit(signRecovery(envelope({route:'relay'}),relay.privateKey),'relay')).toThrow();
    expect(()=>install(3)).toThrow('rollback');
  });
  it('independently disables each route and accepts only a newer authority checkpoint to re-enable it',()=>{
    install();
    const change=(version:number,disabledRoutes:Array<'ssh'|'relay'>)=>store.acceptCheckpoint(signRecovery(certificate(),root.privateKey),signRecovery({...checkpoint(version),disabledRoutes},signer.privateKey));
    change(2,['ssh']);
    expect(store.disabledRoutes()).toEqual(['ssh']);
    expect(()=>store.admit(signRecovery(envelope(),ssh.privateKey),'ssh')).toThrow('recovery-route-disabled');
    const relayRequest=envelope({route:'relay'});
    expect(store.admit(signRecovery(relayRequest,relay.privateKey),'relay').state).toBe('new');store.complete(relayRequest.operationId,{result:'ok'});
    change(3,['relay']);
    expect(()=>store.admit(signRecovery(envelope({route:'relay',fencingEpoch:2}),relay.privateKey),'relay')).toThrow('recovery-route-disabled');
    expect(store.admit(signRecovery(envelope({fencingEpoch:2}),ssh.privateKey),'ssh').state).toBe('new');
  });
  it('expires after 24 hours and never extends a lease across clock rollback', () => {
    install(); expect(store.lease().ready).toBe(true);
    now += OFFLINE_LEASE_MS; uptime += OFFLINE_LEASE_MS; expect(store.lease().ready).toBe(false);
    now -= OFFLINE_LEASE_MS; expect(store.lease().ready).toBe(false);
    install(2); expect(store.lease().ready).toBe(true);
    now -= 1; expect(store.lease().ready).toBe(false);
  });
  it('persists checkpoint, fences and lease across listener restart', () => {
    install(); const e = envelope(); store.admit(signRecovery(e,ssh.privateKey),'ssh'); store.complete(e.operationId,{result:'ok'});
    store.close(); store = new RecoveryAdmission({stateDir:dir,agentId:'throwaway',machineId:'target',bootId:'host-boot',certificationRoot:root.publicKey,now:()=>now,uptime:()=>uptime,processStart:()=>1000});
    expect(store.lease().ready).toBe(true); expect(store.admit(signRecovery(e,ssh.privateKey),'ssh').state).toBe('repeat');
  });
  it('persists local uninstall, rejects cached channels and never re-arms on checkpoint renewal alone', () => {
    install();const staleInstallationEpoch=store.installationEpoch();store.deactivate();expect(store.lease().ready).toBe(false);
    expect(()=>store.admit(signRecovery(envelope(),ssh.privateKey),'ssh')).toThrow();
    const discovery=signRecovery({domain:'instar-recovery-discovery-v1' as const,agentId:'throwaway',sourceMachineId:'source',targetMachineId:'target',pairingEpoch:1,generation:1,route:'ssh' as const,nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30000},ssh.privateKey);
    expect(()=>store.verifyDiscovery(discovery,'ssh',{checkpointCarryOnly:true})).toThrow('recovery-locally-deactivated');
    expect(()=>store.activateFromCheckpoint(1,store.installationEpoch())).toThrow('recovery-fresh-install-checkpoint-required');
    install(2);expect(store.lease().ready).toBe(false);
    expect(()=>store.activateFromCheckpoint(2,staleInstallationEpoch)).toThrow('recovery-installation-superseded');
    store.activateFromCheckpoint(2,store.installationEpoch());expect(store.lease().ready).toBe(true);
    expect(store.admit(signRecovery(envelope(),ssh.privateKey),'ssh').state).toBe('new');
  });
  it('does not uninstall across an owned update transaction', () => {
    install();const digest='a'.repeat(64);store.beginOwnedUpdate(digest,{pid:process.pid,birth:1000,bootId:'host-boot'});
    expect(()=>store.deactivate()).toThrow('recovery-update-operation-busy');expect(store.locallyActive()).toBe(true);
    store.finishOwnedUpdate(digest);store.deactivate();expect(store.locallyActive()).toBe(false);
  });

  it('does not trust a certificate signed by another agent root', () => {
    expect(()=>store.acceptCheckpoint(signRecovery(certificate(),ssh.privateKey),signRecovery(checkpoint(),signer.privateKey))).toThrow('certificate');
  });
});
