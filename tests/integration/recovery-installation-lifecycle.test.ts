import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';

const host=vi.hoisted(()=>({loaded:new Map<string,{file:string;content:string}>(),calls:[] as Array<{args:string[];holdPresent:boolean}>,failBootstrap:'',eioBootstrap:'',failPrint:'',home:'',holdFile:''}));
vi.mock('node:child_process',async(importOriginal)=>{
 const original=await importOriginal<typeof import('node:child_process')>();
 const operatingSystem=(file:string,args:string[])=>{
  if(file==='/usr/sbin/sysctl'&&args.join(' ')==='-n kern.bootsessionuuid')return {stdout:'installation-host-boot\n',stderr:''};
  if(file!=='/bin/launchctl')throw new Error('Unexpected mocked OS command');
  host.calls.push({args:[...args],holdPresent:!!host.holdFile&&fs.existsSync(host.holdFile)});
  if(args[0]==='print'){
   const label=args[1].split('/').at(-1)!;
   if(host.failPrint===label)throw Object.assign(new Error('launchctl permission denied'),{stderr:'Operation not permitted'});
   if(host.loaded.has(label))return {stdout:'state = running\npid = 9000\n',stderr:''};
   throw Object.assign(new Error('not loaded'),{stderr:'Could not find service'});
  }
  if(args[0]==='bootout'){
   const label=args[1].split('/').at(-1)!;
   if(!host.loaded.delete(label))throw Object.assign(new Error('not loaded'),{stderr:'Could not find service'});
   return {stdout:'',stderr:''};
  }
  if(args[0]==='kickstart'){const label=args.at(-1)!.split('/').at(-1)!;if(!host.loaded.has(label))throw Object.assign(new Error('not loaded'),{stderr:'Could not find service'});return {stdout:'',stderr:''};}
  if(args[0]==='bootstrap'){
   const content=fs.readFileSync(args[2],'utf8'),label=/<key>Label<\/key><string>([^<]+)<\/string>/.exec(content)![1];
   if(host.eioBootstrap===label){host.eioBootstrap='';throw Object.assign(new Error('removal still pending'),{stderr:'Bootstrap failed: 5: Input/output error'});}
   if(host.failBootstrap===label){host.failBootstrap='';throw Object.assign(new Error('injected launchctl bootstrap failure'),{stderr:'fixture bootstrap failure'});}
   host.loaded.set(label,{file:args[2],content});return {stdout:'',stderr:''};
  }
  throw new Error('Unexpected mocked launchctl verb');
 };
 const mocked=(file:string,args:string[],options:unknown,callback:(error:unknown,stdout?:string,stderr?:string)=>void)=>{
  if(file!=='/bin/launchctl'&&file!=='/usr/sbin/sysctl')return (original.execFile as any)(file,args,options,callback);
  try{const result=operatingSystem(file,args);callback(null,result.stdout,result.stderr);}catch(error){callback(error);}
 };
 Object.defineProperty(mocked,Symbol.for('nodejs.util.promisify.custom'),{value:async(file:string,args:string[],options:unknown)=>{
  if(file==='/bin/launchctl'||file==='/usr/sbin/sysctl')return operatingSystem(file,args);
  return new Promise((resolve,reject)=>(original.execFile as any)(file,args,options,(error:unknown,stdout:string,stderr:string)=>error?reject(error):resolve({stdout,stderr})));
 }});
 return {...original,execFile:mocked,execFileSync:(file:string,args:string[],options:unknown)=>{if(file==='/bin/launchctl'||file==='/usr/sbin/sysctl')return operatingSystem(file,args).stdout;return (original.execFileSync as any)(file,args,options);}};
});

import {qualifyRecoverySshEnvironment} from '../../src/recovery/RecoverySshEnvironment.js';
import {RecoveryEnrollment,type RecoveryEnrollmentAdvert} from '../../src/recovery/RecoveryEnrollment.js';
import {RecoveryAdmission} from '../../src/recovery/RecoveryAdmission.js';
import {admitRecoverySupervisor} from '../../src/recovery/RecoverySupervisor.js';
import {installRecoveryServices,stopRecoveryServices,recoveryServiceId,recoveryRuntimeRevision} from '../../src/recovery/RecoveryInstallation.js';
import {loadRecoveryConfig,LaunchdRecoveryControl,RecoveryEngine,type RecoveryHostConfig} from '../../src/recovery/RecoveryEngine.js';
import {recoveryKeyPair,signRecovery,OFFLINE_LEASE_MS,type RecoveryCertificate,type RecoveryCheckpoint,type RecoveryEnvelope} from '../../src/recovery/RecoveryProtocol.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {installBootWrapper} from '../../src/commands/setup.js';

function sshPublicKey():string{
 const key=crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32),type=Buffer.from('ssh-ed25519'),wire=Buffer.alloc(4+type.length+4+32);wire.writeUInt32BE(type.length);type.copy(wire,4);wire.writeUInt32BE(32,4+type.length);key.copy(wire,8+type.length);return 'ssh-ed25519 '+wire.toString('base64');
}
describe('production recovery enrollment and persistent installation lifecycle',()=>{
 let directory:string,enrollment:RecoveryEnrollment,configFile:string,entrypoint:string,operatorLine:string,config:RecoveryHostConfig;
 let certificate:ReturnType<typeof signRecovery<RecoveryCertificate>>,checkpoint:ReturnType<typeof signRecovery<RecoveryCheckpoint>>,advert:ReturnType<typeof signRecovery<RecoveryEnrollmentAdvert>>;
 const platformDescriptor=Object.getOwnPropertyDescriptor(process,'platform')!;
 const root=recoveryKeyPair(),foreignRoot=recoveryKeyPair(),signer=recoveryKeyPair(),machine=recoveryKeyPair(),peerMachine=recoveryKeyPair(),peerSsh=recoveryKeyPair(),peerRelay=recoveryKeyPair();
 const agentId='installation-fixture',machineId='target',serviceId=recoveryServiceId(agentId,machineId),sidecar=`com.instar.recovery-sidecar.${serviceId}`,restorer=`com.instar.recovery-restore.${serviceId}`;
 const stageRuntime=(name:string)=>{
  const root=path.join(directory,name),file=path.join(root,'scripts','recovery-entrypoint.mjs');
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.copyFileSync(path.resolve('scripts/recovery-entrypoint.mjs'),file);
  fs.copyFileSync(path.resolve('scripts/recovery-update-entrypoint.mjs'),path.join(root,'scripts','recovery-update-entrypoint.mjs'));
  fs.copyFileSync(path.resolve('package.json'),path.join(root,'package.json'));if(name!=='installed')fs.appendFileSync(file,'\n// fixture installed build '+name+'\n');
  fs.cpSync(path.resolve('dist/recovery'),path.join(root,'dist','recovery'),{recursive:true,mode:fs.constants.COPYFILE_FICLONE});
  fs.cpSync(path.resolve('dist/core'),path.join(root,'dist','core'),{recursive:true,mode:fs.constants.COPYFILE_FICLONE});
  fs.symlinkSync(fs.realpathSync('node_modules'),path.join(root,'node_modules'),'dir');
  return file;
 };
 beforeEach(async()=>{
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-install-lifecycle-'));host.home=path.join(directory,'home');fs.mkdirSync(host.home,{mode:0o700});host.loaded.clear();host.calls=[];host.failBootstrap='';host.eioBootstrap='';host.failPrint='';host.holdFile='';
  vi.spyOn(os,'homedir').mockReturnValue(host.home);Object.defineProperty(process,'platform',{...platformDescriptor,value:'darwin'});
  vi.spyOn(globalThis,'fetch').mockImplementation(async url=>new Response(JSON.stringify(String(url).endsWith('/whoami')?{agentId}:{status:'ok'}),{status:200}));
  const agents=path.join(host.home,'Library','LaunchAgents');fs.mkdirSync(agents,{recursive:true,mode:0o700});
  const mainPlist=path.join(agents,`ai.instar.${agentId}.plist`);fs.writeFileSync(mainPlist,`<plist><key>Label</key><string>ai.instar.${agentId}</string><key>ProgramArguments</key><array><string>/installed/node</string><string>server</string><string>start</string></array></plist>`,{mode:0o600});
  fs.mkdirSync(path.join(host.home,'.instar'),{mode:0o700});fs.writeFileSync(path.join(host.home,'.instar','instar-watchdog.sh'),'#!/bin/sh\n# recovery_rule_held\n',{mode:0o700});fs.writeFileSync(path.join(agents,'ai.instar.watchdog.plist'),'<plist>owned fleet watchdog</plist>',{mode:0o600});
  fs.mkdirSync(path.join(host.home,'.ssh'),{mode:0o700});operatorLine=sshPublicKey()+' operator-owned';fs.writeFileSync(path.join(host.home,'.ssh','authorized_keys'),operatorLine+'\n',{mode:0o600});
  const policy=path.join(directory,'sshd_config');fs.writeFileSync(policy,'AcceptEnv LANG LC_*\nPermitUserEnvironment no\n',{mode:0o600});
  const stateDir=path.join(directory,'agent','.instar');fs.mkdirSync(stateDir,{recursive:true,mode:0o700});installBootWrapper(path.dirname(stateDir));fs.mkdirSync(path.join(stateDir,'bin'),{recursive:true,mode:0o700});fs.symlinkSync(process.execPath,path.join(stateDir,'bin','node'));entrypoint=stageRuntime('installed');
  enrollment=new RecoveryEnrollment({stateDir,agentId,machineId,certificationRoot:root.publicKey,machineSigningKey:machine.privateKey,paired:()=>[{machineId:'peer',pairingEpoch:42,publicKey:peerMachine.publicKey}],relayUrl:'https://recovery.invalid',directHost:'192.0.2.10',sshPort:22,sshHostPublicKey:sshPublicKey(),username:'fixture',agentHome:host.home,mainServicePlist:mainPlist,mainHealthPort:4040,mainAuthToken:'disposable-token',entrypoint,inspectSshEnvironment:hostKeyFile=>{qualifyRecoverySshEnvironment({hostKeyFile,configFile:policy,run:()=> 'acceptenv LANG\nacceptenv LC_*\npermituserenvironment no\nforcecommand none\n'});}});
  const prepared=await enrollment.prepare(),now=Date.now();configFile=path.join(enrollment.directory,'host.json');config=loadRecoveryConfig(configFile);host.holdFile=config.watchdog!.holdFile!;
  certificate=signRecovery<RecoveryCertificate>({domain:'instar-recovery-certificate-v1',agentId,publicKey:signer.publicKey,generation:1,issuedAt:now-1000,expiresAt:now+30*OFFLINE_LEASE_MS},root.privateKey);
  checkpoint=signRecovery<RecoveryCheckpoint>({domain:'instar-recovery-checkpoint-v1',agentId,targetMachineId:machineId,challenge:prepared.challenge,version:1,issuedAt:now,expiresAt:now+OFFLINE_LEASE_MS,principals:[{machineId:'peer',pairingEpoch:42,generation:1,sshPublicKey:peerSsh.publicKey,relayPublicKey:peerRelay.publicKey}],revoked:[]},signer.privateKey);
  advert=signRecovery<RecoveryEnrollmentAdvert>({domain:'instar-recovery-enrollment-v1',agentId,machineId:'peer',generation:1,sshPublicKey:peerSsh.publicKey,relayPublicKey:peerRelay.publicKey,sshClientPublicKey:sshPublicKey(),ssh:{host:'192.0.2.11',port:22,username:'fixture-peer',hostFingerprint:'a'.repeat(64)},relayUrl:'https://recovery.invalid',issuedAt:now,expiresAt:now+300000},peerMachine.privateKey);
 });
 afterEach(()=>{Object.defineProperty(process,'platform',platformDescriptor);vi.restoreAllMocks();SafeFsExecutor.safeRmSync(directory,{recursive:true,force:true,operation:'recovery-installation-lifecycle.test:cleanup'});});
 const grantLines=()=>fs.readFileSync(path.join(host.home,'.ssh','authorized_keys'),'utf8');
 const planFile=(label:string)=>path.join(host.home,'Library','LaunchAgents',label+'.plist');
 const prepareNext=async(next:string)=>{const updated=new RecoveryEnrollment({...((enrollment as unknown as {o:ConstructorParameters<typeof RecoveryEnrollment>[0]}).o),entrypoint:next});await updated.prepare();config=loadRecoveryConfig(configFile);return config;};
 const admission=()=>new RecoveryAdmission({stateDir:config.stateDir,agentId,machineId,bootId:'installation-host-boot',certificationRoot:root.publicKey});
 const activeHold=()=>{
  config=loadRecoveryConfig(configFile);const hold={deadline:Date.now()+60000,monotonicDeadline:Number(process.hrtime.bigint()/1_000_000n)+60000,bootId:'installation-host-boot',original:config.watchdog!};
  const store=admission();try{store.beginHold(hold);}finally{store.close();}
  fs.writeFileSync(host.holdFile,JSON.stringify({version:1,label:config.serviceLabel,scriptDigest:config.watchdog!.scriptDigest,plistDigest:config.watchdog!.ownershipDigest,deadline:hold.deadline,monotonicDeadline:hold.monotonicDeadline,bootId:hold.bootId}),{mode:0o600});
 };
 it('runs real enrollment, installs persistent independent services, reloads a new binary and preserves operator SSH lines',async()=>{
  await expect(enrollment.install(certificate,checkpoint,[advert])).resolves.toEqual({state:'awaiting-peer-proofs'});
  expect(grantLines()).toContain(operatorLine);expect(grantLines()).toContain('instar-recovery-access');expect(grantLines()).toContain('command=');expect(fs.existsSync(path.join(enrollment.directory,'runtime.json'))).toBe(true);
  for(const label of [sidecar,restorer]){expect(host.loaded.has(label)).toBe(true);expect(fs.statSync(planFile(label)).mode&0o077).toBe(0);expect(fs.readFileSync(planFile(label),'utf8')).toContain(loadRecoveryConfig(configFile).runtimeSlot!.entrypoint);}
  const before=host.calls.filter(c=>c.args[0]==='bootstrap').length;await installRecoveryServices(loadRecoveryConfig(configFile),configFile,entrypoint);expect(host.calls.filter(c=>c.args[0]==='bootstrap')).toHaveLength(before);
  const next=stageRuntime('updated');await prepareNext(next);await installRecoveryServices(config,configFile,next);
  for(const label of [sidecar,restorer])expect(host.loaded.get(label)!.content).toContain(config.runtimeSlot!.entrypoint);
  expect(host.calls.filter(c=>c.args[0]==='bootout')).toHaveLength(2);expect(grantLines()).toContain(operatorLine);
 });
 it('retries only the exact own bootstrap when launchd is still removing that job',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);const next=stageRuntime('launchd-removal-race');await prepareNext(next);host.calls=[];host.eioBootstrap=sidecar;
  await installRecoveryServices(config,configFile,next);
  expect(host.calls.filter(c=>c.args[0]==='bootstrap'&&c.args[2]===planFile(sidecar))).toHaveLength(2);
  expect(host.loaded.get(sidecar)!.content).toContain(config.runtimeSlot!.entrypoint);
 });
 it('restarts an exact production job removed by its owned watchdog, rather than kickstarting a missing label',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);config=loadRecoveryConfig(configFile);
  host.loaded.set(config.serviceLabel,{file:config.mainService!.plist,content:fs.readFileSync(config.mainService!.plist,'utf8')});
  const control=new LaunchdRecoveryControl(config);control.stopOwnedRuleTarget();expect(host.loaded.has(config.serviceLabel)).toBe(false);
  await control.start();expect(host.loaded.get(config.serviceLabel)!.file).toBe(config.mainService!.plist);
  const mainBootstraps=host.calls.filter(c=>c.args[0]==='bootstrap'&&c.args[2]===config.mainService!.plist);expect(mainBootstraps).toHaveLength(1);
  // Ordinary source start keeps an already running owned service in place.
  await control.start();expect(host.calls.filter(c=>c.args[0]==='bootstrap'&&c.args[2]===config.mainService!.plist)).toHaveLength(1);
 });
 it('keeps a production KeepAlive service stopped until an explicit start restores its pinned policy',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);config=loadRecoveryConfig(configFile);
  const content=fs.readFileSync(config.mainService!.plist,'utf8');host.loaded.set(config.serviceLabel,{file:config.mainService!.plist,content});
  const control=new LaunchdRecoveryControl(config);host.calls=[];
  await control.stop();expect(host.loaded.has(config.serviceLabel)).toBe(false);
  await control.stop();expect(host.loaded.has(config.serviceLabel)).toBe(false);
  expect(host.calls.some(call=>call.args[0]==='kill')).toBe(false);
  expect(host.calls.filter(call=>call.args[0]==='bootout').every(call=>call.args[1].endsWith('/'+config.serviceLabel))).toBe(true);
  expect(fs.readFileSync(config.mainService!.plist,'utf8')).toBe(content);
  await control.start();expect(host.loaded.get(config.serviceLabel)).toEqual({file:config.mainService!.plist,content});
  expect(host.calls.some(call=>call.args.some(arg=>arg.endsWith('/ai.instar.watchdog')))).toBe(false);
 });
 it('preserves the supervisor intentional sleep authority in signed diagnostics and refuses autonomous start or hold',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);config=loadRecoveryConfig(configFile);
  const state=path.join(config.mainStateDir!,'state');fs.mkdirSync(state,{recursive:true,mode:0o700});
  const marker=path.join(state,'slept-marker.json');fs.writeFileSync(marker,JSON.stringify({sleptAt:new Date().toISOString(),reason:'deep-idle'}),{mode:0o600});
  const control=new LaunchdRecoveryControl(config);host.calls=[];
  expect(await control.repairDisposition()).toEqual({allowed:false,reason:'intentional-sleep'});
  await expect(control.start()).rejects.toThrow('recovery-intentional-stop');
  await expect(control.holdWatchdog()).rejects.toThrow('recovery-intentional-stop');
  expect(host.calls).toHaveLength(0);expect(fs.existsSync(marker)).toBe(true);
  const store=admission(),now=Date.now();
  try {
   const engine=new RecoveryEngine(config,store,'installation-host-boot',control);
   const request=signRecovery<RecoveryEnvelope>({domain:'instar-recovery-operation-v1',agentId,sourceMachineId:'peer',targetMachineId:machineId,targetBootId:'installation-host-boot',pairingEpoch:42,generation:1,route:'ssh',operationId:crypto.randomUUID(),nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30000,fencingEpoch:1,verb:'status'},peerSsh.privateKey);
   const response=await engine.execute(request,'ssh') as {payload:{result:string;detail:Record<string,unknown>}};
   expect(response.payload.result).toBe('ok');expect(response.payload.detail).toMatchObject({serverHealthy:false,repairSuppressed:true,repairSuppressionReason:'intentional-sleep'});
  } finally {store.close();}
  SafeFsExecutor.safeUnlinkSync(marker,{operation:'recovery-lifecycle.test:supervisor-wake-fixture'});
  const pending=path.join(state,'sleep-requested.json');
  fs.writeFileSync(pending,JSON.stringify({requestedBy:'SleepController',expiresAt:new Date(Date.now()+60000).toISOString()}),{mode:0o600});
  expect(await control.repairDisposition()).toEqual({allowed:false,reason:'sleep-request-pending'});
  await expect(control.start()).rejects.toThrow('recovery-intentional-stop');
  fs.writeFileSync(pending,JSON.stringify({expiresAt:new Date(Date.now()-1).toISOString()}));
  expect(await control.repairDisposition()).toEqual({allowed:true,reason:null});
  await control.start();expect(host.loaded.has(config.serviceLabel)).toBe(true);
 });
 it('refuses a changed main policy or an uncertain launchctl inspection without bootstrapping anything',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);config=loadRecoveryConfig(configFile);
  const control=new LaunchdRecoveryControl(config),original=fs.readFileSync(config.mainService!.plist,'utf8');host.calls=[];
  fs.appendFileSync(config.mainService!.plist,'<!-- unexpected policy -->');
  await expect(control.start()).rejects.toThrow('recovery-main-service-policy-changed');
  await expect(control.stop()).rejects.toThrow('recovery-main-service-policy-changed');
  expect(host.calls).toHaveLength(0);
  fs.writeFileSync(config.mainService!.plist,original);host.failPrint=config.serviceLabel;
  await expect(control.start()).rejects.toThrow('recovery-main-inspection-unverified');
  expect(host.calls.some(call=>call.args[0]==='bootstrap'||call.args[0]==='kickstart')).toBe(false);
 });
 it.each([
  {name:'authentication refusal',response:()=>new Response('{}',{status:401}),reason:'main-identity-authentication-failed'},
  {name:'foreign identity',response:()=>new Response(JSON.stringify({agentId:'another-agent'}),{status:200}),reason:'main-identity-mismatch'},
  {name:'unreadable identity',response:()=>new Response('not JSON',{status:200}),reason:'main-identity-unavailable'},
 ])('treats $name as unverifiable rather than a down main server',async({response,reason})=>{
  await enrollment.install(certificate,checkpoint,[advert]);config=loadRecoveryConfig(configFile);
  host.loaded.set(config.serviceLabel,{file:config.mainService!.plist,content:fs.readFileSync(config.mainService!.plist,'utf8')});
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>response());
  const control=new LaunchdRecoveryControl(config);expect(await control.status()).toBe(false);
  expect(await control.repairDisposition()).toEqual({allowed:false,reason});host.calls=[];
  await expect(control.start()).rejects.toThrow('recovery-main-inspection-unverified');
  expect(host.calls.some(call=>['bootout','bootstrap','kickstart'].includes(call.args[0]))).toBe(false);
 });
 it('does not infer a down main server from a missing credential and authenticates its own health read',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);config=loadRecoveryConfig(configFile);
  host.loaded.set(config.serviceLabel,{file:config.mainService!.plist,content:fs.readFileSync(config.mainService!.plist,'utf8')});
  const unavailable=new LaunchdRecoveryControl({...config,mainAuthToken:undefined});expect(await unavailable.status()).toBe(false);
  expect(await unavailable.repairDisposition()).toEqual({allowed:false,reason:'main-credential-unavailable'});
  const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
   expect(options?.headers).toMatchObject({Authorization:'Bearer disposable-token','X-Instar-AgentId':agentId});
   return new Response(JSON.stringify(String(url).endsWith('/whoami')?{agentId}:{status:'ok'}),{status:200});
  });
  const control=new LaunchdRecoveryControl(config);expect(await control.status()).toBe(true);expect(fetchMock).toHaveBeenCalledTimes(2);
 });
 it('refreshes only the trusted local main binding and reloads the sidecar when that protected config changes',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);const old=fs.readFileSync(planFile(sidecar),'utf8');host.calls=[];
  const refreshed=new RecoveryEnrollment({...((enrollment as unknown as {o:ConstructorParameters<typeof RecoveryEnrollment>[0]}).o),mainAuthToken:'rotated-own-main-token',mainHealthPort:4456});
  await refreshed.prepare();config=loadRecoveryConfig(configFile);
  expect(config.mainAuthToken).toBe('rotated-own-main-token');expect(config.healthPort).toBe(4456);
  await installRecoveryServices(config,configFile,entrypoint);
  expect(host.loaded.get(sidecar)!.content).not.toBe(old);
  expect(host.loaded.get(sidecar)!.content).toContain('INSTAR_RECOVERY_CONFIG_REVISION');
  expect(host.loaded.get(sidecar)!.content).not.toContain('rotated-own-main-token');
  expect(host.calls.filter(call=>call.args[0]==='bootout')).toHaveLength(2);
 });
 it('re-arms an exhausted sidecar only for an actual installed build or protected configuration change',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);config=loadRecoveryConfig(configFile);
  const original=recoveryRuntimeRevision(entrypoint),originalPlan=host.loaded.get(sidecar)!.content;
  const configRevision=crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex');
  const cause=(runtimeRevision:string)=>({agentId,machineId,relayUrl:config.relayUrl,certificationRoot:config.certificationRoot,configRevision,runtimeRevision});
  let now=Date.now();for(let i=0;i<3;i++)expect(admitRecoverySupervisor(config.stateDir,cause(original),now+i).admitted).toBe(true);
  const first=admitRecoverySupervisor(config.stateDir,cause(original),now+3);now=first.retryAt;
  for(let i=0;i<3;i++)expect(admitRecoverySupervisor(config.stateDir,cause(original),now+i).admitted).toBe(true);
  expect(admitRecoverySupervisor(config.stateDir,cause(original),now+3).exhausted).toBe(true);
  fs.utimesSync(entrypoint,new Date(),new Date());expect(recoveryRuntimeRevision(entrypoint)).toBe(original);
  expect(admitRecoverySupervisor(config.stateDir,cause(original),now+3600000).admitted).toBe(false);
  const engineFile=path.join(path.dirname(entrypoint),'..','dist','recovery','RecoveryEngine.js');fs.appendFileSync(engineFile,'\n// genuine installed recovery build change\n');
  const updated=recoveryRuntimeRevision(entrypoint);expect(updated).not.toBe(original);
  await prepareNext(entrypoint);await installRecoveryServices(config,configFile,entrypoint);expect(host.loaded.get(sidecar)!.content).not.toBe(originalPlan);
  expect(host.loaded.get(sidecar)!.content).toContain('INSTAR_RECOVERY_RUNTIME_REVISION');
  expect(admitRecoverySupervisor(config.stateDir,cause(updated),now+3600000).admitted).toBe(true);
  const manifest=path.join(path.dirname(entrypoint),'..','package.json'),pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));pkg.version+='-next';fs.writeFileSync(manifest,JSON.stringify(pkg));
  expect(recoveryRuntimeRevision(entrypoint)).not.toBe(updated);
 });
 it('rolls the exact previous owned plan back when launchctl rejects a changed executable',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);const old=fs.readFileSync(planFile(sidecar),'utf8'),other=fs.readFileSync(planFile(restorer),'utf8');host.failBootstrap=sidecar;
  const next=stageRuntime('broken-update');await prepareNext(next);await expect(installRecoveryServices(config,configFile,next)).rejects.toThrow('injected launchctl');
  expect(fs.readFileSync(planFile(sidecar),'utf8')).toBe(old);expect(host.loaded.get(sidecar)!.content).toBe(old);expect(fs.readFileSync(planFile(restorer),'utf8')).toBe(other);expect(host.loaded.get(restorer)!.content).toBe(other);expect(grantLines()).toContain(operatorLine);
 });
 it('restores a durable owned hold before reloading either service and completes uninstall without touching operator keys',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);activeHold();host.calls=[];
  const next=stageRuntime('updated-entry');await prepareNext(next);await installRecoveryServices(config,configFile,next);expect(fs.existsSync(host.holdFile)).toBe(false);expect(host.calls.filter(c=>c.args[0]==='bootout').every(c=>!c.holdPresent)).toBe(true);
  const store=admission();try{expect(store.hold()).toBe(null);}finally{store.close();}
  activeHold();await stopRecoveryServices(agentId,machineId,{configFile});
  expect(host.loaded.has(sidecar)).toBe(false);expect(host.loaded.has(restorer)).toBe(false);expect(fs.existsSync(planFile(sidecar))).toBe(false);expect(fs.existsSync(planFile(restorer))).toBe(false);expect(fs.existsSync(path.join(enrollment.directory,'runtime.json'))).toBe(false);expect(fs.existsSync(host.holdFile)).toBe(false);expect(grantLines()).toBe(operatorLine+'\n');expect(fs.existsSync(configFile)).toBe(true);expect(fs.existsSync(path.join(config.stateDir,'recovery-admission.db'))).toBe(true);
  // An already-authenticated sshd connection can open a new forced-command
  // channel after authorized_keys removal. The retained wrapper must refuse it.
  const now=Date.now(),request=signRecovery<RecoveryEnvelope>({domain:'instar-recovery-operation-v1',agentId,sourceMachineId:'peer',targetMachineId:machineId,targetBootId:'installation-host-boot',pairingEpoch:42,generation:1,route:'ssh',operationId:crypto.randomUUID(),nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30000,fencingEpoch:1,verb:'status'},peerSsh.privateKey);
  const uninstalled=admission();try{expect(()=>uninstalled.admit(request,'ssh')).toThrow();}finally{uninstalled.close();}
 });
 it('keeps the persistent independent restorer when uninstall cannot compensate a hold, then resumes safely',async()=>{
  await enrollment.install(certificate,checkpoint,[advert]);activeHold();const marker=fs.readFileSync(host.holdFile,'utf8');fs.writeFileSync(host.holdFile,JSON.stringify({...JSON.parse(marker),label:'ai.instar.other'}));
  await expect(stopRecoveryServices(agentId,machineId,{configFile})).rejects.toThrow('recovery-watchdog-ownership-invalid');
  expect(host.loaded.has(restorer)).toBe(true);expect(fs.existsSync(planFile(restorer))).toBe(true);expect(host.loaded.has(sidecar)).toBe(false);expect(grantLines()).toBe(operatorLine+'\n');
  const store=admission();try{expect(store.hold()).not.toBe(null);}finally{store.close();}
  fs.writeFileSync(host.holdFile,marker);await stopRecoveryServices(agentId,machineId,{configFile});expect(host.loaded.has(restorer)).toBe(false);expect(fs.existsSync(host.holdFile)).toBe(false);
 });
 it('never opens first enrollment when the restorer bootstrap fails after the sidecar and SSH grants exist',async()=>{
  host.failBootstrap=restorer;
  await expect(enrollment.install(certificate,checkpoint,[advert])).rejects.toThrow();
  expect(host.loaded.has(sidecar)).toBe(true);expect(host.loaded.has(restorer)).toBe(false);expect(grantLines()).toContain('instar-recovery-access');
  const closed=admission();try{expect(closed.locallyActive()).toBe(false);expect(closed.lease().ready).toBe(false);expect(()=>closed.verifyDiscovery({} as never,'ssh')).toThrow('locally-deactivated');expect(()=>closed.verifyDiscovery({} as never,'relay')).toThrow('locally-deactivated');}finally{closed.close();}
 });
 it('refuses an untrusted root or forged MachineAuth advert before changing any SSH admission or host service',async()=>{
  const forgedRoot=signRecovery(certificate.payload,foreignRoot.privateKey);
  await expect(enrollment.install(forgedRoot,checkpoint,[advert])).rejects.toThrow('recovery-certificate-invalid');
  expect(grantLines()).toBe(operatorLine+'\n');expect(host.calls).toHaveLength(0);expect(fs.existsSync(path.join(enrollment.directory,'runtime.json'))).toBe(false);
  await expect(enrollment.install(certificate,checkpoint,[signRecovery(advert.payload,machine.privateKey)])).rejects.toThrow('recovery-peer-advert-invalid');expect(grantLines()).toBe(operatorLine+'\n');expect(host.loaded.size).toBe(0);
 });
});
