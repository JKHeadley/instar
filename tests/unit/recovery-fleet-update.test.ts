import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {installAutoStart,installFleetWatchdog} from '../../src/commands/setup.js';
import {recoveryFleetUpdatePhase,resumeAbandonedRecoveryFleetUpdate} from '../../src/recovery/RecoveryFleetUpdate.js';
import {RecoveryAdmission} from '../../src/recovery/RecoveryAdmission.js';
import {LaunchdRecoveryControl} from '../../src/recovery/RecoveryEngine.js';
import {installRecoveryServices} from '../../src/recovery/RecoveryInstallation.js';
import {recoveryKeyPair} from '../../src/recovery/RecoveryProtocol.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
vi.mock('node:child_process',async original=>{const actual=await original<typeof import('node:child_process')>();return{...actual,execFileSync:vi.fn((command:string,args:string[],options:any)=>command==='plutil'||args?.some(a=>String(a).endsWith('recovery-update-entrypoint.mjs'))?Buffer.alloc(0):actual.execFileSync(command,args,options))};});
vi.mock('../../src/core/processIdentity.js',()=>({processStartMs:()=>1000}));
vi.mock('../../src/recovery/RecoveryEngine.js',async original=>({...await original<object>(),recoveryHostBootId:async()=>'test-boot'}));
vi.mock('../../src/recovery/RecoveryInstallation.js',async original=>({...await original<object>(),installRecoveryServices:vi.fn(async()=>({state:'awaiting-peer-proofs',labels:[]}))}));
const dirs:string[]=[];const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
beforeEach(()=>{vi.spyOn(process,'platform','get').mockReturnValue('darwin');vi.spyOn(LaunchdRecoveryControl.prototype,'restoreWatchdog').mockResolvedValue();vi.mocked(installRecoveryServices).mockClear();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-fleet-update.test:cleanup'});});
function fixture(memberCount=1){
 const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'recovery-fleet-installer-')));dirs.push(home);vi.spyOn(os,'homedir').mockReturnValue(home);vi.stubEnv('INSTAR_TEST_REGISTRY_DIR',path.join(home,'.instar'));
 const project=path.join(home,'agent'),state=path.join(project,'.instar');fs.mkdirSync(state,{recursive:true});
 expect(installAutoStart('agent',project,false,{force:true})).toBe(true);
 const secondProject=path.join(home,'agent-two');if(memberCount>1){fs.mkdirSync(path.join(secondProject,'.instar'),{recursive:true});expect(installAutoStart('agent-two',secondProject,false,{force:true})).toBe(true);}
 const script=path.join(home,'.instar','instar-watchdog.sh'),plist=path.join(home,'Library','LaunchAgents','ai.instar.watchdog.plist');
 // The previous installed template is pinned exactly; next bytes still come
 // from the real packaged installer, not an arbitrary test-authored new plan.
 fs.appendFileSync(script,'\n# previous released template revision\n');
 const previousScript=fs.readFileSync(script,'utf8'),previousPlist=fs.readFileSync(plist,'utf8'),root=recoveryKeyPair();
 fs.writeFileSync(path.join(state,'config.json'),JSON.stringify({projectName:'agent'}),{mode:0o600});
 fs.mkdirSync(path.join(state,'machine'),{mode:0o700});fs.writeFileSync(path.join(state,'machine','identity.json'),JSON.stringify({machineId:'machine'}),{mode:0o600});
 const recovery=path.join(state,'recovery');fs.mkdirSync(recovery,{mode:0o700});
 const mainPlist=path.join(home,'Library','LaunchAgents','ai.instar.agent.plist');
 const config={version:1,agentId:'agent',machineId:'machine',stateDir:path.join(recovery,'admission'),mainStateDir:state,certificationRoot:root.publicKey,sshPrivateKey:root.privateKey,relayPrivateKey:recoveryKeyPair().privateKey,
  serviceLabel:'ai.instar.agent',healthPort:4040,relayUrl:'https://relay.example',mainService:{plist:mainPlist,ownershipDigest:hash(fs.readFileSync(mainPlist,'utf8'))},
  watchdog:{kind:'agent-rule',label:'ai.instar.watchdog',targetLabel:'ai.instar.agent',script,scriptDigest:hash(previousScript),plist,ownershipDigest:hash(previousPlist),entrypoint:'/installed/scripts/recovery-entrypoint.mjs',holdFile:path.join(recovery,'watchdog-hold.json'),eventsFile:path.join(recovery,'watchdog-events.jsonl')}};
 const configFile=path.join(recovery,'host.json');fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
 const entries=[{name:'agent',path:project}];
 if(memberCount>1){
  const stateTwo=path.join(secondProject,'.instar'),recoveryTwo=path.join(stateTwo,'recovery');fs.mkdirSync(recoveryTwo,{mode:0o700});
  fs.mkdirSync(path.join(stateTwo,'machine'),{mode:0o700});fs.writeFileSync(path.join(stateTwo,'config.json'),JSON.stringify({projectName:'agent-two'}),{mode:0o600});fs.writeFileSync(path.join(stateTwo,'machine','identity.json'),JSON.stringify({machineId:'machine-two'}),{mode:0o600});
  const mainTwo=path.join(home,'Library','LaunchAgents','ai.instar.agent-two.plist');
  const configTwo={...config,agentId:'agent-two',machineId:'machine-two',stateDir:path.join(recoveryTwo,'admission'),mainStateDir:stateTwo,serviceLabel:'ai.instar.agent-two',sshPrivateKey:recoveryKeyPair().privateKey,relayPrivateKey:recoveryKeyPair().privateKey,
   mainService:{plist:mainTwo,ownershipDigest:hash(fs.readFileSync(mainTwo,'utf8'))},watchdog:{...config.watchdog,targetLabel:'ai.instar.agent-two',holdFile:path.join(recoveryTwo,'watchdog-hold.json'),eventsFile:path.join(recoveryTwo,'watchdog-events.jsonl')}};
  fs.writeFileSync(path.join(recoveryTwo,'host.json'),JSON.stringify(configTwo),{mode:0o600});entries.push({name:'agent-two',path:secondProject});
 }
 fs.writeFileSync(path.join(home,'.instar','registry.json'),JSON.stringify({version:1,entries}),{mode:0o600});
 expect(installFleetWatchdog()).toBe(true);
 const file=path.join(home,'.instar','recovery-fleet-update.json'),transaction=JSON.parse(fs.readFileSync(file,'utf8'));
 expect(transaction.members).toHaveLength(memberCount);fs.writeFileSync(script,previousScript,{mode:0o755});fs.writeFileSync(plist,previousPlist);
 return{home,project,config,configFile,script,plist,file,transaction,previousScript,previousPlist,memberAdmission:(index:number)=>{const c=JSON.parse(transaction.members[index].previousConfig);return new RecoveryAdmission({stateDir:c.stateDir,agentId:c.agentId,machineId:c.machineId,certificationRoot:c.certificationRoot,bootId:'test-boot',processStart:()=>1000});},admission:()=>new RecoveryAdmission({stateDir:config.stateDir,agentId:'agent',machineId:'machine',certificationRoot:root.publicKey,bootId:'test-boot',processStart:()=>1000})};
}
describe('trusted fleet watchdog installer binding refresh',()=>{
 it('restores own hold before global rewrite and rotates only matching watchdog digests',async()=>{
  const f=fixture(),a=f.admission();a.beginHold({deadline:Date.now()+60_000,monotonicDeadline:Number(process.hrtime.bigint()/1000000n)+60_000,bootId:'test-boot',original:f.config.watchdog});a.close();
  await recoveryFleetUpdatePhase('prepare',f.file);expect(LaunchdRecoveryControl.prototype.restoreWatchdog).toHaveBeenCalledWith(f.config.watchdog);
  const held=f.admission();expect(held.hold()).toBeNull();expect(held.ownedUpdate()).not.toBeNull();held.close();
  fs.writeFileSync(f.script,f.transaction.nextScript,{mode:0o755});fs.writeFileSync(f.plist,f.transaction.nextPlist);
  await recoveryFleetUpdatePhase('commit',f.file);
  const next=JSON.parse(fs.readFileSync(f.configFile,'utf8'));expect(next.watchdog.scriptDigest).toBe(hash(f.transaction.nextScript));
  expect(next.certificationRoot).toBe(f.config.certificationRoot);expect(next.sshPrivateKey).toBe(f.config.sshPrivateKey);expect(next.mainService).toEqual(f.config.mainService);
  expect(installRecoveryServices).toHaveBeenCalledOnce();const done=f.admission();expect(done.ownedUpdate()).toBeNull();done.close();
 });
 it('rolls global bytes and member pins back when an independent service reload fails',async()=>{
  const f=fixture();await recoveryFleetUpdatePhase('prepare',f.file);fs.writeFileSync(f.script,f.transaction.nextScript,{mode:0o755});fs.writeFileSync(f.plist,f.transaction.nextPlist);
  vi.mocked(installRecoveryServices).mockRejectedValueOnce(new Error('reload-failed'));
  await expect(recoveryFleetUpdatePhase('commit',f.file)).rejects.toThrow('reload-failed');
  expect(fs.readFileSync(f.script,'utf8')).toBe(f.previousScript);expect(fs.readFileSync(f.plist,'utf8')).toBe(f.previousPlist);
  expect(JSON.parse(fs.readFileSync(f.configFile,'utf8')).watchdog).toEqual(f.config.watchdog);
 });
 it.each([['prepared','committed'],['committed','committed'],['rolled-back','rolled-back']] as const)('closes crashed fleet phase %s/%s and clears the common guard only after every other member',async(phase,outcome)=>{
  const f=fixture(2);await recoveryFleetUpdatePhase('prepare',f.file);
  if(outcome==='committed'){fs.writeFileSync(f.script,f.transaction.nextScript,{mode:0o755});fs.writeFileSync(f.plist,f.transaction.nextPlist);await recoveryFleetUpdatePhase('commit',f.file);}
  else await recoveryFleetUpdatePhase('rollback',f.file);
  const pending=JSON.parse(fs.readFileSync(f.file,'utf8'));pending.phase=phase;pending.outcome=outcome;pending.ownerPid=99999999;pending.ownerBirth=1000;
  const key=hash(pending.previousScript+pending.previousPlist+pending.nextScript+pending.nextPlist);
  for(let i=0;i<2;i++){const a=f.memberAdmission(i);a.beginOwnedUpdate(key,{pid:pending.ownerPid,birth:1000,bootId:'test-boot'});a.close();}
  fs.writeFileSync(f.file,JSON.stringify(pending),{mode:0o600});
  const finish=RecoveryAdmission.prototype.finishOwnedUpdate;
  vi.spyOn(RecoveryAdmission.prototype,'finishOwnedUpdate').mockImplementation(function(digest,owner){
   if((this as unknown as {options:{machineId:string}}).options.machineId==='machine'){const other=f.memberAdmission(1);expect(other.ownedUpdate()).toBeNull();other.close();}
   return finish.call(this,digest,owner);
  });
  await resumeAbandonedRecoveryFleetUpdate(f.configFile);
  for(let i=0;i<2;i++){const a=f.memberAdmission(i);expect(a.ownedUpdate()).toBeNull();a.close();}
  expect(fs.readFileSync(f.script,'utf8')).toBe(outcome==='committed'?f.transaction.nextScript:f.previousScript);
  expect(JSON.parse(fs.readFileSync(f.file,'utf8')).phase).toBe(outcome);
 });
 it('releases only its prepared fleet guards when the prepare child exits before any policy write',async()=>{
  const f=fixture(2);await recoveryFleetUpdatePhase('prepare',f.file);
  const pending=JSON.parse(fs.readFileSync(f.file,'utf8'));pending.ownerReleased=true;pending.abortBeforeWrite=true;fs.writeFileSync(f.file,JSON.stringify(pending),{mode:0o600});
  await resumeAbandonedRecoveryFleetUpdate(f.configFile);
  for(let i=0;i<2;i++){const a=f.memberAdmission(i);expect(a.ownedUpdate()).toBeNull();a.close();}
  expect(fs.readFileSync(f.script,'utf8')).toBe(f.previousScript);expect(installRecoveryServices).not.toHaveBeenCalled();
 });
 it('leaves deactivated recovery inactive during a normal global template update',async()=>{
  const f=fixture(),a=f.admission();a.deactivate();a.close();await recoveryFleetUpdatePhase('prepare',f.file);
  fs.writeFileSync(f.script,f.transaction.nextScript,{mode:0o755});fs.writeFileSync(f.plist,f.transaction.nextPlist);await recoveryFleetUpdatePhase('commit',f.file);
  expect(installRecoveryServices).not.toHaveBeenCalled();const after=f.admission();expect(after.locallyActive()).toBe(false);after.close();
 });
});
