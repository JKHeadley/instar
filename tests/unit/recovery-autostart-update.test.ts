import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {installAutoStart} from '../../src/commands/setup.js';
import {recoveryAutostartUpdatePhase,validateOwnedRecoveryAutostartPlan,resumeAbandonedRecoveryMainUpdate,beginRecoveryAutostartBindingUpdate} from '../../src/recovery/RecoveryAutostartUpdate.js';
import {RecoveryAdmission} from '../../src/recovery/RecoveryAdmission.js';
import {loadRecoveryConfig,LaunchdRecoveryControl} from '../../src/recovery/RecoveryEngine.js';
import {installRecoveryServices} from '../../src/recovery/RecoveryInstallation.js';
import {recoveryKeyPair} from '../../src/recovery/RecoveryProtocol.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {saveRecoveryMainBindingCandidate,validateRecoveryMainBindings} from '../../src/recovery/RecoveryMainBindings.js';

const earlyBridges=vi.hoisted(()=>({loadCommands:[] as Array<{action:string;owned:boolean}>,snapshots:[] as Array<{project:string;before:string|null;observed:string|null;nodeBefore:string|null;nodeObserved:string|null}>}));
vi.mock('node:child_process',async original=>{
  const actual=await original<typeof import('node:child_process')>();
  return {...actual,execFileSync:vi.fn((command:string,args:string[],options:any)=>{
    if(args?.some(a=>String(a).endsWith('recovery-update-entrypoint.mjs'))){
      if(args[1]==='prepare'){const t=JSON.parse(fs.readFileSync(args[2],'utf8')),js=path.join(t.projectDir,'.instar','instar-boot.cjs'),alias=path.join(t.projectDir,'.instar','bin','node');earlyBridges.snapshots.push({project:t.projectDir,before:t.previousBindings?.js?.content??null,observed:fs.existsSync(js)?fs.readFileSync(js,'utf8'):null,nodeBefore:t.previousBindings?.nodeTarget??null,nodeObserved:fs.existsSync(alias)?fs.readlinkSync(alias):null});}
      const t=JSON.parse(fs.readFileSync(args[2],'utf8')),c=JSON.parse(t.previousConfig),a=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId:'test-boot',processStart:()=>1000});
      try{const key=t.latchKey??crypto.createHash('sha256').update(t.previousConfig+t.nextPlist).digest('hex');if(args[1]==='prepare')a.beginOwnedUpdate(key,{pid:t.ownerPid,birth:t.ownerBirth,bootId:'test-boot'});else if(args[1]==='commit'||args[1]==='rollback')a.finishOwnedUpdate(key,{pid:t.ownerPid,birth:t.ownerBirth});}finally{a.close();}
      return Buffer.alloc(0);
    }
    if(command==='launchctl'){
      const file=path.join(os.homedir(),'agent','.instar','recovery','host.json');if(fs.existsSync(file)&&args.some(v=>v.includes('ai.instar.agent'))){const c=JSON.parse(fs.readFileSync(file,'utf8')),a=new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId:'test-boot',processStart:()=>1000});try{earlyBridges.loadCommands.push({action:args[0],owned:!!a.ownedUpdate()});}finally{a.close();}}return Buffer.alloc(0);
    }
    if(command==='plutil')return Buffer.alloc(0);
    return actual.execFileSync(command,args,options);
  })};
});
vi.mock('../../src/core/processIdentity.js',()=>({processStartMs:()=>1000}));
vi.mock('../../src/recovery/RecoveryEngine.js',async original=>({...await original<object>(),recoveryHostBootId:async()=>'test-boot'}));
vi.mock('../../src/recovery/RecoveryInstallation.js',async original=>({...await original<object>(),installRecoveryServices:vi.fn(async()=>({state:'awaiting-peer-proofs',labels:[]}))}));
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
const dirs:string[]=[];
beforeEach(()=>{earlyBridges.snapshots=[];earlyBridges.loadCommands=[];vi.spyOn(process,'platform','get').mockReturnValue('darwin');vi.spyOn(LaunchdRecoveryControl.prototype,'start').mockResolvedValue();vi.mocked(installRecoveryServices).mockClear();});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-autostart-update.test:cleanup'});});
function fixture(noStart=false){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-owned-updater-'));dirs.push(home);vi.spyOn(os,'homedir').mockReturnValue(home);
  const project=path.join(home,'agent');fs.mkdirSync(path.join(project,'.instar'),{recursive:true});
  expect(installAutoStart('agent',project,false,{force:true})).toBe(true);
  const plist=path.join(home,'Library','LaunchAgents','ai.instar.agent.plist'),previous=fs.readFileSync(plist,'utf8');
  fs.appendFileSync(path.join(project,'.instar','instar-boot.cjs'),'\n// prior installed wrapper revision\n');
  const recovery=path.join(project,'.instar','recovery');fs.mkdirSync(recovery,{mode:0o700});
  const keys=recoveryKeyPair(),configFile=path.join(recovery,'host.json');
  const config={version:1,agentId:'agent',machineId:'machine',stateDir:path.join(recovery,'admission'),certificationRoot:keys.publicKey,sshPrivateKey:keys.privateKey,relayPrivateKey:recoveryKeyPair().privateKey,
    relayUrl:'https://relay.example',serviceLabel:'ai.instar.agent',healthPort:4040,mainService:{plist,ownershipDigest:hash(previous)}};
  fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
  // Exercise the REAL installer generator, not a test-authored prospective plan.
  // Only its synchronous host subprocess bridge is intercepted; the async phase
  // below uses real private files and SQLite with host service IO mocked.
  expect(installAutoStart('agent',project,true,{force:true,noStart})).toBe(true);
  const transactionFile=path.join(recovery,'main-update.json'),transaction=JSON.parse(fs.readFileSync(transactionFile,'utf8'));
  expect(transaction.previousPlist).toBe(previous);expect(transaction.nextPlist).toContain('<string>lifeline</string>');
  fs.writeFileSync(plist,previous,{mode:0o600});
  return {project,plist,previous,config,configFile,transactionFile,transaction,admission:()=>new RecoveryAdmission({stateDir:config.stateDir,agentId:'agent',machineId:'machine',certificationRoot:keys.publicKey,bootId:'test-boot',processStart:()=>1000})};
}
describe('real Autostart writer recovery transaction',()=>{
  it('honors a trusted macOS promotion noStart request without booting out its live installer',()=>{
    vi.stubEnv('VITEST','');vi.stubEnv('INSTAR_SKIP_LAUNCHCTL_LOAD','');const f=fixture(true);expect(earlyBridges.loadCommands).toEqual([]);expect(f.transaction.bindingStaged).toBe(true);const a=f.admission();try{expect(a.ownedUpdate()).toBeNull();}finally{a.close();}
  });
  it('retains the admission latch through every actual trusted main-service reload command',()=>{
    vi.stubEnv('VITEST','');vi.stubEnv('INSTAR_SKIP_LAUNCHCTL_LOAD','');fixture();
    expect(earlyBridges.loadCommands.map(v=>v.action)).toEqual(['bootout','enable','bootstrap']);expect(earlyBridges.loadCommands.every(v=>v.owned)).toBe(true);
  });
  it('preserves the exact durable transaction and bootstrap bytes when another installer owner is alive',()=>{
    const f=fixture(),before=fs.readFileSync(f.transactionFile,'utf8'),wrapper=fs.readFileSync(path.join(f.project,'.instar','instar-boot.cjs'),'utf8');
    expect(()=>beginRecoveryAutostartBindingUpdate(f.project,f.plist)).toThrow('recovery-update-operation-busy');
    expect(fs.readFileSync(f.transactionFile,'utf8')).toBe(before);expect(fs.readFileSync(path.join(f.project,'.instar','instar-boot.cjs'),'utf8')).toBe(wrapper);
  });
  it('refuses to bless a present tampered main wrapper before the trusted installer writes candidates',()=>{
    const f=fixture(),pending={...f.transaction,phase:'rolled-back'};fs.writeFileSync(f.transactionFile,JSON.stringify(pending),{mode:0o600});
    const mainStateDir=path.join(f.project,'.instar'),fallback=path.join(mainStateDir,'recovery','runtime-slots','test','node');fs.mkdirSync(path.dirname(fallback),{recursive:true,mode:0o700});fs.writeFileSync(fallback,'retained-node-fixture',{mode:0o500});
    // Hosted CI's shared tool-cache Node may be group-writable. Own a protected
    // fixture copy and its exact alias; never change the runner's installation.
    const ownedNode=path.join(mainStateDir,'fixture-owned-node');fs.copyFileSync(fs.realpathSync(process.execPath),ownedNode,fs.constants.COPYFILE_FICLONE);fs.chmodSync(ownedNode,0o500);
    const alias=path.join(mainStateDir,'bin','node');SafeFsExecutor.safeUnlinkSync(alias,{operation:'recovery-autostart-update.test:pin-owned-fixture-interpreter'});fs.symlinkSync(ownedNode,alias);
    const config={...f.config,mainStateDir},wrapper=path.join(mainStateDir,'instar-boot.cjs'),snapshot=saveRecoveryMainBindingCandidate(config,fs.readFileSync(wrapper,'utf8'),ownedNode,fallback),pinned={...config,mainBindings:snapshot};
    expect(fs.statSync(ownedNode).mode&0o777).toBe(0o500);expect(fs.readlinkSync(alias)).toBe(ownedNode);expect(()=>validateRecoveryMainBindings(pinned)).not.toThrow();
    fs.writeFileSync(f.configFile,JSON.stringify(pinned),{mode:0o600});fs.appendFileSync(wrapper,'\n// external tamper\n');const priorTransaction=fs.readFileSync(f.transactionFile,'utf8');
    expect(()=>beginRecoveryAutostartBindingUpdate(f.project,f.plist)).toThrow('recovery-main-binding-changed');expect(fs.readFileSync(f.transactionFile,'utf8')).toBe(priorTransaction);expect(fs.readFileSync(wrapper,'utf8')).toContain('external tamper');
  });
  it('enters the fenced bridge before either trusted bootstrap writer mutates its prior bindings',()=>{
    const f=fixture(),snapshot=earlyBridges.snapshots.find(s=>s.project===f.project)!;
    expect(snapshot).toBeDefined();expect(snapshot.observed).toBe(snapshot.before);expect(snapshot.nodeObserved).toBe(snapshot.nodeBefore);expect(snapshot.before).toContain('prior installed wrapper revision');
    expect(fs.readFileSync(path.join(f.project,'.instar','instar-boot.cjs'),'utf8')).not.toBe(snapshot.before);
    expect(f.transaction.latchKey).toMatch(/^[a-f0-9]{64}$/);expect(f.transaction.bindingStaged).toBe(true);
  });
  it('restores the exact previous JavaScript, shell and Node alias on a binding-stage rollback',async()=>{
    const f=fixture();await recoveryAutostartUpdatePhase('prepare',f.transactionFile);
    const nextNode=path.join(f.project,'candidate-node');fs.copyFileSync(process.execPath,nextNode,fs.constants.COPYFILE_FICLONE);fs.chmodSync(nextNode,0o500);
    const pending=JSON.parse(fs.readFileSync(f.transactionFile,'utf8'));pending.nextBindingsCandidate.nodeTarget=nextNode;fs.writeFileSync(f.transactionFile,JSON.stringify(pending),{mode:0o600});
    const alias=path.join(f.project,'.instar','bin','node');SafeFsExecutor.safeUnlinkSync(alias,{operation:'recovery-autostart-update.test:replace-candidate-alias'});fs.symlinkSync(nextNode,alias);
    await recoveryAutostartUpdatePhase('rollback',f.transactionFile);
    for(const [kind,file]of [['js','instar-boot.cjs'],['sh','instar-boot.sh']]as const){expect(fs.readFileSync(path.join(f.project,'.instar',file),'utf8')).toBe(f.transaction.previousBindings[kind].content);expect(fs.statSync(path.join(f.project,'.instar',file)).mode&0o777).toBe(f.transaction.previousBindings[kind].mode);}
    expect(fs.readlinkSync(alias)).toBe(f.transaction.previousBindings.nodeTarget);const a=f.admission();try{expect(a.ownedUpdate()).toBe(null);}finally{a.close();}
  });

  it('moves a genuine server-to-lifeline installer plan without granting any new principal or root',async()=>{
    const f=fixture();await recoveryAutostartUpdatePhase('prepare',f.transactionFile);
    const before=f.admission();expect(before.ownedUpdate()).not.toBeNull();before.close();
    fs.writeFileSync(f.plist,f.transaction.nextPlist,{mode:0o600});
    await recoveryAutostartUpdatePhase('commit',f.transactionFile);
    const next=loadRecoveryConfig(f.configFile);
    expect(next.mainService?.ownershipDigest).toBe(hash(f.transaction.nextPlist));
    expect(next.certificationRoot).toBe(f.config.certificationRoot);expect(next.relayPrivateKey).toBe(f.config.relayPrivateKey);
    expect(installRecoveryServices).toHaveBeenCalledOnce();const after=f.admission();expect(after.ownedUpdate()).toBeNull();after.close();
  });
  it('preserves local uninstall through an ordinary owned Autostart update',async()=>{
    const f=fixture(),a=f.admission();a.deactivate();a.close();
    await recoveryAutostartUpdatePhase('prepare',f.transactionFile);fs.writeFileSync(f.plist,f.transaction.nextPlist,{mode:0o600});
    await recoveryAutostartUpdatePhase('commit',f.transactionFile);
    expect(installRecoveryServices).not.toHaveBeenCalled();const after=f.admission();expect(after.locallyActive()).toBe(false);expect(after.ownedUpdate()).toBeNull();after.close();
  });
  it('restores the exact prior binding if independent service update fails',async()=>{
    const f=fixture();await recoveryAutostartUpdatePhase('prepare',f.transactionFile);fs.writeFileSync(f.plist,f.transaction.nextPlist,{mode:0o600});
    vi.mocked(installRecoveryServices).mockRejectedValueOnce(new Error('service-failed'));
    await expect(recoveryAutostartUpdatePhase('commit',f.transactionFile)).rejects.toThrow('service-failed');
    expect(fs.readFileSync(f.plist,'utf8')).toBe(f.previous);expect(loadRecoveryConfig(f.configFile).mainService?.ownershipDigest).toBe(hash(f.previous));
  });
  it('rolls back an interrupted installer only after proving its PID/birth is no longer the owner',async()=>{
    const f=fixture();const pending=JSON.parse(fs.readFileSync(f.transactionFile,'utf8'));pending.ownerPid=99999999;pending.ownerBirth=999;fs.writeFileSync(f.transactionFile,JSON.stringify(pending),{mode:0o600});
    await recoveryAutostartUpdatePhase('prepare',f.transactionFile);fs.writeFileSync(f.plist,f.transaction.nextPlist,{mode:0o600});
    await resumeAbandonedRecoveryMainUpdate(f.configFile);
    expect(fs.readFileSync(f.plist,'utf8')).toBe(f.previous);expect(loadRecoveryConfig(f.configFile).mainService?.ownershipDigest).toBe(hash(f.previous));
    const after=f.admission();expect(after.ownedUpdate()).toBeNull();after.close();
  });
  it.each(['prepared','committed'] as const)('finishes a durable committed outcome after a crash with phase %s instead of stranding admission',async phase=>{
    const f=fixture();await recoveryAutostartUpdatePhase('prepare',f.transactionFile);fs.writeFileSync(f.plist,f.transaction.nextPlist,{mode:0o600});
    await recoveryAutostartUpdatePhase('commit',f.transactionFile);
    const pending=JSON.parse(fs.readFileSync(f.transactionFile,'utf8'));pending.phase=phase;pending.outcome='committed';pending.ownerPid=99999999;pending.ownerBirth=1000;
    const key=(pending.latchKey??hash(pending.previousConfig+pending.nextPlist)),a=f.admission();a.beginOwnedUpdate(key,{pid:pending.ownerPid,birth:pending.ownerBirth,bootId:'test-boot'});a.close();
    fs.writeFileSync(f.transactionFile,JSON.stringify(pending),{mode:0o600});
    await resumeAbandonedRecoveryMainUpdate(f.configFile);
    expect(fs.readFileSync(f.plist,'utf8')).toBe(f.transaction.nextPlist);expect(loadRecoveryConfig(f.configFile).mainService?.ownershipDigest).toBe(hash(f.transaction.nextPlist));
    const done=f.admission();expect(done.ownedUpdate()).toBeNull();done.close();expect(JSON.parse(fs.readFileSync(f.transactionFile,'utf8')).phase).toBe('committed');
  });
  it('clears a legacy terminal rollback latch only after restoring its exact saved service binding',async()=>{
    const f=fixture();await recoveryAutostartUpdatePhase('prepare',f.transactionFile);
    const pending=JSON.parse(fs.readFileSync(f.transactionFile,'utf8'));pending.phase='rolled-back';delete pending.outcome;pending.ownerPid=99999999;pending.ownerBirth=1000;
    const key=(pending.latchKey??hash(pending.previousConfig+pending.nextPlist)),a=f.admission();a.finishOwnedUpdate(key);a.beginOwnedUpdate(key,{pid:pending.ownerPid,birth:pending.ownerBirth,bootId:'test-boot'});a.close();
    fs.writeFileSync(f.transactionFile,JSON.stringify(pending),{mode:0o600});await resumeAbandonedRecoveryMainUpdate(f.configFile);
    expect(fs.readFileSync(f.plist,'utf8')).toBe(f.previous);const done=f.admission();expect(done.ownedUpdate()).toBeNull();done.close();
  });
  it('aborts an exited prepare helper while its parent remains alive without requiring a main-server restart',async()=>{
    const f=fixture();await recoveryAutostartUpdatePhase('prepare',f.transactionFile);
    const pending=JSON.parse(fs.readFileSync(f.transactionFile,'utf8'));pending.ownerReleased=true;pending.abortBeforeWrite=true;
    fs.writeFileSync(f.transactionFile,JSON.stringify(pending),{mode:0o600});await resumeAbandonedRecoveryMainUpdate(f.configFile);
    expect(fs.readFileSync(f.plist,'utf8')).toBe(f.previous);expect(fs.readFileSync(f.configFile,'utf8')).toBe(pending.previousConfig);
    const done=f.admission();expect(done.ownedUpdate()).toBeNull();done.close();expect(installRecoveryServices).not.toHaveBeenCalled();
  });
  it('does not clear a matching digest held by a different live rollback owner',async()=>{
    const f=fixture();await recoveryAutostartUpdatePhase('prepare',f.transactionFile);fs.writeFileSync(f.plist,f.transaction.nextPlist,{mode:0o600});await recoveryAutostartUpdatePhase('commit',f.transactionFile);
    const pending=JSON.parse(fs.readFileSync(f.transactionFile,'utf8'));pending.ownerPid=99999999;pending.ownerBirth=1000;
    const key=(pending.latchKey??hash(pending.previousConfig+pending.nextPlist)),a=f.admission();a.beginOwnedUpdate(key,{pid:process.ppid,birth:1000,bootId:'test-boot'});a.close();
    fs.writeFileSync(f.transactionFile,JSON.stringify(pending),{mode:0o600});await expect(resumeAbandonedRecoveryMainUpdate(f.configFile)).rejects.toThrow('recovery-update-operation-busy');
    const held=f.admission();expect(held.ownedUpdate()?.pid).toBe(process.ppid);held.close();
  });
  it('refuses external policy edits and a generated plan redirected to another home or runtime command',async()=>{
    const f=fixture();fs.writeFileSync(f.plist,f.previous+'<!-- external edit -->');
    await expect(recoveryAutostartUpdatePhase('prepare',f.transactionFile)).rejects.toThrow('concurrent-policy-change');
    expect(()=>validateOwnedRecoveryAutostartPlan(f.transaction.nextPlist.replace('<string>lifeline</string>','<string>shell</string>'),f.project,'agent')).toThrow('plan-invalid');
    expect(()=>validateOwnedRecoveryAutostartPlan(f.transaction.nextPlist,f.project+'-foreign','agent')).toThrow('plan-invalid');
  });
});
