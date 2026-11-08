import { describe,expect,it,afterEach } from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import crypto from 'node:crypto';
import { admitRecoverySupervisor } from '../../src/recovery/RecoverySupervisor.js';
import { recoveryLaunchdPlan,recoveryServiceId,recoveryInstalledConfig } from '../../src/recovery/RecoveryInstallation.js';
import { serverDownRecoveryHealth, type RecoveryRouteProof } from '../../src/recovery/RecoveryClient.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { loadRecoveryConfig,LaunchdRecoveryControl,RecoveryEngine,type RecoveryHostConfig } from '../../src/recovery/RecoveryEngine.js';
import { recoveryKeyPair,signRecovery,type RecoveryCheckpoint } from '../../src/recovery/RecoveryProtocol.js';
import { PeerAuthorizedKeys } from '../../src/core/PeerAuthorizedKeys.js';
import { RecoveryAdmission } from '../../src/recovery/RecoveryAdmission.js';
describe('independent recovery host wiring',()=> {
 let dir:string;afterEach(()=>{if(dir)SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-host.test:cleanup'});});
 it('survives repeated supervisor kills with a durable finite budget',()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-supervisor-'));const t=1_800_000_000_000;
  for(let i=0;i<3;i++)expect(admitRecoverySupervisor(dir,{revision:1},t+i*1_000).admitted).toBe(true);
  const breaker=admitRecoverySupervisor(dir,{revision:1},t+5_000);expect(breaker.admitted).toBe(false);
  expect(admitRecoverySupervisor(dir,{revision:1},t+60_000).admitted).toBe(false);
  for(let i=0;i<3;i++)expect(admitRecoverySupervisor(dir,{revision:1},breaker.retryAt+i*1_000).admitted).toBe(true);
  expect(admitRecoverySupervisor(dir,{revision:1},breaker.retryAt+5_000).exhausted).toBe(true);
  expect(admitRecoverySupervisor(dir,{revision:1},t+60*60_000).admitted).toBe(false);
  expect(admitRecoverySupervisor(dir,{revision:2},t+60*60_000).admitted).toBe(true);
 });
 it('refuses a writable budget or a symlinked supervisor log',()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-supervisor-protected-'));
  admitRecoverySupervisor(dir,{revision:1});
  const budget=path.join(dir,'sidecar-supervisor.json');fs.chmodSync(budget,0o666);
  expect(()=>admitRecoverySupervisor(dir,{revision:1})).toThrow('recovery-supervisor-state-invalid');
  fs.chmodSync(budget,0o600);SafeFsExecutor.safeUnlinkSync(path.join(dir,'supervisor-events.jsonl'),{operation:'recovery-host.test:replace-fixture-log'});
  fs.symlinkSync(budget,path.join(dir,'supervisor-events.jsonl'));
  expect(()=>admitRecoverySupervisor(dir,{revision:1})).toThrow('recovery-supervisor-state-invalid');
 });
 it('installs an independently scheduled hold restorer and separate sidecar service',()=>{
  const plan=recoveryLaunchdPlan({agentId:'a',machineId:'m',node:'/node',entrypoint:'/entry',configFile:'/config',stateDir:'/state'});
  expect(plan).toHaveLength(2);expect(plan[0].label).not.toBe(plan[1].label);
  expect(plan[1].content).toContain('<key>StartInterval</key><integer>5</integer>');
  expect(plan[1].content).not.toContain('sidecar');expect(recoveryServiceId('a','m')).not.toBe(recoveryServiceId('b','m'));
 });
 it('places production services in the login-persistent LaunchAgents directory',()=>{
  const plan=recoveryLaunchdPlan({agentId:'a',machineId:'m',node:'/node',entrypoint:'/entry',configFile:'/config',stateDir:'/state',launchAgentsDir:'/user/Library/LaunchAgents'});
  for(const service of plan)expect(service.file).toBe(`/user/Library/LaunchAgents/${service.label}.plist`);
 });
 it('uninstalls only protected plans bound to the exact owned label and fixed mode',()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-owned-plan-'));
  const plan=recoveryLaunchdPlan({agentId:'a',machineId:'m',node:'/node',entrypoint:'/entry',configFile:'/config',stateDir:dir})[0];
  fs.writeFileSync(plan.file,plan.content,{mode:0o600});
  expect(recoveryInstalledConfig(plan.file,plan.label,'sidecar')).toBe('/config');
  expect(()=>recoveryInstalledConfig(plan.file,plan.label,'restore')).toThrow('recovery-install-ownership-invalid');
  expect(()=>recoveryInstalledConfig(plan.file,'another-agent','sidecar')).toThrow('recovery-install-ownership-invalid');
  fs.chmodSync(plan.file,0o666);
  expect(()=>recoveryInstalledConfig(plan.file,plan.label,'sidecar')).toThrow('recovery-install-ownership-invalid');
 });
 it('allows the independent restorer to run after the main service policy changes',()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-restore-config-'));
  const root=recoveryKeyPair(),ssh=recoveryKeyPair(),relay=recoveryKeyPair();
  const configFile=path.join(dir,'config.json');
  fs.writeFileSync(configFile,JSON.stringify({version:1,agentId:'a',machineId:'m',stateDir:dir,certificationRoot:root.publicKey,
   sshPrivateKey:ssh.privateKey,relayPrivateKey:relay.privateKey,relayUrl:'https://relay.invalid',serviceLabel:'ai.instar.a',healthPort:4040,
   mainService:{plist:path.join(dir,'changed-main.plist'),ownershipDigest:'0'.repeat(64)}}),{mode:0o600});
  expect(()=>loadRecoveryConfig(configFile)).toThrow();
  expect(loadRecoveryConfig(configFile,{restorationOnly:true}).agentId).toBe('a');
 });
 it('holds only a production agent rule with recent exact watchdog stop evidence and restores across an update',async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-owned-rule-'));
  const script=path.join(dir,'watchdog.sh'),plist=path.join(dir,'watchdog.plist');
  fs.writeFileSync(script,'#!/bin/sh\n# recovery_rule_held\n',{mode:0o700});fs.writeFileSync(plist,'owned fleet watchdog',{mode:0o600});
  const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const w={kind:'agent-rule' as const,label:'ai.instar.watchdog',targetLabel:'ai.instar.a',script,scriptDigest:hash(script),plist,ownershipDigest:hash(plist),
   holdFile:path.join(dir,'watchdog-hold.json'),eventsFile:path.join(dir,'watchdog-events.jsonl'),entrypoint:path.join(dir,'entry.mjs')};
  const config:RecoveryHostConfig={version:1,agentId:'a',machineId:'m',stateDir:path.join(dir,'admission'),certificationRoot:'unused',sshPrivateKey:'unused',relayPrivateKey:'unused',
   relayUrl:'https://relay.invalid',serviceLabel:'ai.instar.a',healthPort:4040,mainStateDir:path.join(dir,'agent-state'),watchdog:w};
  const control=new LaunchdRecoveryControl(config),hold={deadline:Date.now()+60000,monotonicDeadline:Number(process.hrtime.bigint()/1_000_000n)+60000,bootId:'boot',original:w};
  await expect(control.holdWatchdog(hold)).rejects.toThrow('recovery-watchdog-kill-evidence-required');
  const event={version:1,event:'owned-rule-stopped',label:'ai.instar.other',at:Date.now(),scriptDigest:w.scriptDigest,plistDigest:w.ownershipDigest};
  fs.writeFileSync(w.eventsFile,JSON.stringify(event)+'\n',{mode:0o600});
  expect((await control.watchdogEvidence()).recent).toBe(false);
  fs.appendFileSync(w.eventsFile,JSON.stringify({...event,label:'ai.instar.a'})+'\n');
  await control.holdWatchdog(hold);
  expect(JSON.parse(fs.readFileSync(w.holdFile,'utf8')).label).toBe('ai.instar.a');
  // Updating the singleton policy must never strand an owned hold marker.
  fs.appendFileSync(script,'# updated\n');
  await control.restoreWatchdog(w);expect(fs.existsSync(w.holdFile)).toBe(false);
 });
 it('regrants only protected ceremony inventory matching the current authority principal and drops rotated keys',()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-inventory-'));
  const home=path.join(dir,'account'),wrapper=path.join(dir,'ssh-wrapper.sh'),inventory=path.join(dir,'grants.json');
  fs.mkdirSync(home,{mode:0o700});fs.writeFileSync(wrapper,'#!/bin/sh\nexit 1\n',{mode:0o700});
  const ssh=recoveryKeyPair(),relay=recoveryKeyPair(),signer=recoveryKeyPair(),root=recoveryKeyPair();
  const type=Buffer.from('ssh-ed25519'),wire=Buffer.alloc(4+type.length+4+32);wire.writeUInt32BE(type.length);type.copy(wire,4);wire.writeUInt32BE(32,4+type.length);wire.fill(1,8+type.length);
  const publicKey=`ssh-ed25519 ${wire.toString('base64')}`,principal={machineId:'s',pairingEpoch:1,generation:1,sshPublicKey:ssh.publicKey,relayPublicKey:relay.publicKey};
  fs.writeFileSync(inventory,JSON.stringify([{machineId:'s',pairingEpoch:1,generation:1,sshSigningPublicKey:ssh.publicKey,relaySigningPublicKey:relay.publicKey,sshClientPublicKey:publicKey,forcedCommand:wrapper}]),{mode:0o600});
  const config:RecoveryHostConfig={version:1,agentId:'a',machineId:'m',stateDir:path.join(dir,'admission'),certificationRoot:root.publicKey,sshPrivateKey:'unused',relayPrivateKey:'unused',
   relayUrl:'https://relay.invalid',serviceLabel:'unused',healthPort:1,authorizedKeysHome:home,validatedGrantInventory:inventory};
  const admission=new RecoveryAdmission({stateDir:config.stateDir,agentId:'a',machineId:'m',bootId:'boot',certificationRoot:root.publicKey});
  const engine=new RecoveryEngine(config,admission,'boot',{} as never),keys=new PeerAuthorizedKeys(home,false,'instar-recovery-access');
  const grant={agentId:'a',machineId:'s',pairingEpoch:1,clientKeyGeneration:1,publicKey,forcedCommand:wrapper};
  const checkpoint:RecoveryCheckpoint={domain:'instar-recovery-checkpoint-v1',agentId:'a',targetMachineId:'m',challenge:'0'.repeat(64),version:1,issuedAt:Date.now(),expiresAt:Date.now()+60000,principals:[principal],revoked:[]};
  let version=0;const now=Date.now();
  const certificate=signRecovery({domain:'instar-recovery-certificate-v1' as const,agentId:'a',publicKey:signer.publicKey,generation:1,issuedAt:now,expiresAt:now+86400000},root.privateKey);
  const reconcile=(p:RecoveryCheckpoint)=>{admission.acceptCheckpoint(certificate,signRecovery({...p,version:++version,challenge:admission.challenge()},signer.privateKey));return engine.reconcileCheckpointRevocations();};
  reconcile(checkpoint);expect(keys.has(grant)).toBe(true);
  reconcile({...checkpoint,disabledRoutes:['ssh']});expect(keys.has(grant)).toBe(false);
  reconcile(checkpoint);expect(keys.has(grant)).toBe(true);
  reconcile({...checkpoint,principals:[{...principal,generation:2}]});expect(keys.has(grant)).toBe(false);admission.close();
 });
 it('counts only current independent source proofs on the same host boot',()=>{
  const now=Date.now();const a:RecoveryRouteProof={sourceMachineId:'s',targetMachineId:'t',bootId:'boot',route:'ssh',observedAt:now,expiresAt:now+300_000,credentialGeneration:1,pairingEpoch:1,processDomain:'sshd',supervisorDomain:'host-sshd',transportDomain:'utun6:'+('a'.repeat(64))+':'+('b'.repeat(64)),keyFingerprint:'a'};
  const b:RecoveryRouteProof={...a,route:'relay',processDomain:'sidecar',supervisorDomain:'recovery-sidecar',transportDomain:'en0:'+('c'.repeat(64))+':'+('d'.repeat(64)),keyFingerprint:'b'};
  const current={bootId:'boot',pairingEpoch:1,credentialGeneration:1};
  expect(serverDownRecoveryHealth([a,b],'t',current,now).ready).toBe(true);
  expect(serverDownRecoveryHealth([a,{...b,transportDomain:b.transportDomain.replace('en0:','utun6:')}],'t',current,now).ready).toBe(false);
  expect(serverDownRecoveryHealth([{...a,transportDomain:a.transportDomain.replace('utun6:','en0:')},b],'t',current,now).ready).toBe(true);
  expect(serverDownRecoveryHealth([a,{...b,transportDomain:b.transportDomain.replace('en0:','unknown:')}],'t',current,now).ready).toBe(false);
  expect(serverDownRecoveryHealth([a,b],'t',current,now+300_001).ready).toBe(false);
  expect(serverDownRecoveryHealth([a,{...b,keyFingerprint:'a'}],'t',current,now).ready).toBe(false);
  expect(serverDownRecoveryHealth([a,{...b,bootId:'old'}],'t',current,now).ready).toBe(false);
  expect(serverDownRecoveryHealth([{...a,sourceMachineId:'t'},{...b,sourceMachineId:'t'}],'t',current,now).ready).toBe(false);
  expect(serverDownRecoveryHealth([],'t',current,now).ready).toBe(false);
 });
});
