import { withSyncOp } from '../core/InFlightSyncOpMarker.js';
/** Rebind only previously enrolled own watchdog rules to an installer-produced fleet template. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {fileURLToPath}from 'node:url';import {execFileSync}from 'node:child_process';
import {agentRegistryPath}from '../core/AgentRegistryPaths.js';import {processStartMs}from '../core/processIdentity.js';
import {loadRecoveryConfig,LaunchdRecoveryControl,recoveryHostBootId,type RecoveryHostConfig}from './RecoveryEngine.js';
import {RecoveryAdmission}from './RecoveryAdmission.js';import {installRecoveryServices}from './RecoveryInstallation.js';
const hash=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
function read(file:string,privateFile=false,max=262144):string {const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&(privateFile?0o077:0o022))||st.size>max)throw new Error('recovery-fleet-update-ownership-invalid');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}
function write(file:string,value:string,mode=0o600):void{const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,value,{mode,flag:'wx'});fs.renameSync(tmp,file);}
interface Member{configFile:string;previousConfig:string;active?:boolean;}
interface FleetTransaction{version:1;scriptFile:string;plistFile:string;previousScript:string;previousPlist:string;nextScript:string;nextPlist:string;ownerPid:number;ownerBirth:number;ownerReleased?:boolean;abortBeforeWrite?:boolean;outcome?:'committed'|'rolled-back';members:Member[];phase:'prepared'|'committed'|'rolled-back';}
const token=(t:FleetTransaction)=>hash(t.previousScript+t.previousPlist+t.nextScript+t.nextPlist);
function load(file:string):FleetTransaction{
 const t=JSON.parse(read(file,true,4194304))as FleetTransaction;
 if(t.version!==1||file!==path.join(path.dirname(t.scriptFile),'recovery-fleet-update.json')||path.basename(t.scriptFile)!=='instar-watchdog.sh'||path.basename(t.plistFile)!=='ai.instar.watchdog.plist'||!Array.isArray(t.members)||t.members.length>128)throw new Error('recovery-fleet-update-invalid');
 if(!t.nextScript.includes('recovery_rule_held')||!t.nextPlist.includes('<string>ai.instar.watchdog</string>')||!t.nextPlist.includes('<string>/bin/bash</string>'))throw new Error('recovery-fleet-update-invalid');
 return t;
}
function admission(config:RecoveryHostConfig,bootId:string):RecoveryAdmission{return new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,certificationRoot:config.certificationRoot,bootId});}
export function beginRecoveryFleetUpdate(scriptFile:string,plistFile:string,nextScript:string,nextPlist:string):{commit():void;rollback():void}|null{
 if(!fs.existsSync(scriptFile)||!fs.existsSync(plistFile)||!fs.existsSync(agentRegistryPath()))return null;
 const pendingFile=path.join(path.dirname(scriptFile),'recovery-fleet-update.json');
 if(fs.existsSync(pendingFile)){
  const pending=load(pendingFile);if(pending.phase==='prepared'&&!releasedOrDead(pending))throw new Error('recovery-fleet-update-operation-busy');
  execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/recovery-update-entrypoint.mjs',import.meta.url)),'fleet-resume',pendingFile],{timeout:180_000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});
 }

 const previousScript=read(scriptFile),previousPlist=read(plistFile);
 if(previousScript===nextScript&&previousPlist===nextPlist)return null;
 const registry=JSON.parse(read(agentRegistryPath(),false,1048576))as{entries?:Array<{path:string;name:string}>};
 if(!Array.isArray(registry.entries)||registry.entries.length>1024)throw new Error('recovery-fleet-registry-invalid');
 const members:Member[]=[];
 for(const entry of registry.entries){
  if(typeof entry.path!=='string'||!path.isAbsolute(entry.path)||!fs.existsSync(entry.path))continue;
  if(fs.realpathSync(entry.path)!==path.resolve(entry.path))continue;
  const configFile=path.join(entry.path,'.instar','recovery','host.json');if(!fs.existsSync(configFile))continue;
  try{
   const previousConfig=read(configFile,true),c=loadRecoveryConfig(configFile,{restorationOnly:true}),w=c.watchdog;
   const local=JSON.parse(read(path.join(entry.path,'.instar','config.json'))),identity=JSON.parse(read(path.join(entry.path,'.instar','machine','identity.json')));
   if(c.agentId!==local.projectName||c.machineId!==identity.machineId||c.mainStateDir!==path.join(entry.path,'.instar')||w?.kind!=='agent-rule'||w.script!==scriptFile||w.plist!==plistFile||w.scriptDigest!==hash(previousScript)||w.ownershipDigest!==hash(previousPlist)||w.targetLabel!==c.serviceLabel)continue;
   members.push({configFile,previousConfig});
  }catch{console.warn('[recovery] unverified registered watchdog binding left unchanged and degraded');}
 }
 if(!members.length)return null;if(members.length>128)throw new Error('recovery-fleet-registry-invalid');
 const ownerBirth=processStartMs(process.pid);if(ownerBirth===null)throw new Error('recovery-update-owner-invalid');
 const file=path.join(path.dirname(scriptFile),'recovery-fleet-update.json');
 if(fs.existsSync(file)&&load(file).phase==='prepared')throw new Error('recovery-fleet-update-operation-busy');
 const t:FleetTransaction={version:1,scriptFile,plistFile,previousScript,previousPlist,nextScript,nextPlist,ownerPid:process.pid,ownerBirth,members,phase:'prepared'};write(file,JSON.stringify(t));
 const run=(phase:string)=>withSyncOp(()=>execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/recovery-update-entrypoint.mjs',import.meta.url)),'fleet-'+phase,file],{timeout:180_000,maxBuffer:4096,stdio:['ignore','pipe','pipe']}));
 const release=(abortBeforeWrite=false)=>{const pending=load(file);pending.ownerReleased=true;if(abortBeforeWrite)pending.abortBeforeWrite=true;write(file,JSON.stringify(pending));};
 try{run('prepare');}catch(error){release(true);try{run('resume');}catch{console.warn('[recovery] fleet prepare compensation remains pending');}throw error;}
 return{commit(){run('commit');},rollback(){release();run('rollback');}};
}
export async function recoveryFleetUpdatePhase(phase:string,file:string):Promise<void>{
 let t=load(file);const boot=await recoveryHostBootId(),key=token(t);
 if(phase==='resume'){
  await resumeAbandonedRecoveryFleetUpdate(t.members[0].configFile);
  for(const m of t.members){const a=admission(JSON.parse(m.previousConfig),boot);try{if(a.ownedUpdate())throw new Error('recovery-fleet-update-operation-busy');}finally{a.close();}}return;
 }
 const finish=()=>finishFleetLatches(t,boot);
 if(phase==='prepare'){
  if(read(t.scriptFile)!==t.previousScript||read(t.plistFile)!==t.previousPlist)throw new Error('recovery-fleet-update-concurrent-policy');
  try{for(const m of t.members){if(read(m.configFile,true)!==m.previousConfig)throw new Error('recovery-fleet-update-concurrent-policy');const c=JSON.parse(m.previousConfig)as RecoveryHostConfig,a=admission(c,boot);try{m.active=a.locallyActive();a.beginOwnedUpdate(key,{pid:t.ownerPid,birth:t.ownerBirth,bootId:boot});const h=a.hold();if(h){await new LaunchdRecoveryControl(c).restoreWatchdog(h.original);a.clearHold();}}finally{a.close();}}write(file,JSON.stringify(t));}
  catch(error){finishFleetLatches(t,boot,true);throw error;}return;
 }
 const configs=t.members.map(m=>{const previous=JSON.parse(m.previousConfig)as RecoveryHostConfig;return{m,previous,next:{...previous,watchdog:{...previous.watchdog!,scriptDigest:hash(t.nextScript),ownershipDigest:hash(t.nextPlist)}}};});
 if(phase==='commit'){
  if(t.phase!=='prepared'||read(t.scriptFile)!==t.nextScript||read(t.plistFile)!==t.nextPlist||configs.some(({m})=>read(m.configFile,true)!==m.previousConfig))throw new Error('recovery-fleet-update-concurrent-policy');
  try{for(const{m,next}of configs){write(m.configFile,JSON.stringify(next));if(m.active)await installRecoveryServices(next,m.configFile,next.watchdog!.entrypoint!,{ownedUpdateDigest:key});}t.outcome='committed';write(file,JSON.stringify(t));finish();t.phase='committed';write(file,JSON.stringify(t));return;}
  catch(error){t.ownerReleased=true;write(file,JSON.stringify(t));try{await recoveryFleetUpdatePhase('rollback',file);}catch{console.warn('[recovery] fleet rollback remains pending');}throw error;}
 }
 if(phase==='rollback'){
  t=await claimFleetUpdate(file,t);t.phase='prepared';delete t.outcome;write(file,JSON.stringify(t));
  if(![t.previousScript,t.nextScript].includes(read(t.scriptFile))||![t.previousPlist,t.nextPlist].includes(read(t.plistFile)))throw new Error('recovery-fleet-update-concurrent-policy');
  if(configs.some(({m,previous,next})=>![JSON.stringify(previous),JSON.stringify(next)].includes(JSON.stringify(JSON.parse(read(m.configFile,true))))))throw new Error('recovery-fleet-update-concurrent-policy');
  write(t.scriptFile,t.previousScript,0o755);write(t.plistFile,t.previousPlist);
  for(const{m,previous}of configs){write(m.configFile,m.previousConfig);if(m.active)await installRecoveryServices(previous,m.configFile,previous.watchdog!.entrypoint!,{ownedUpdateDigest:key});}
  t.outcome='rolled-back';write(file,JSON.stringify(t));finish();t.phase='rolled-back';write(file,JSON.stringify(t));return;
 }
 throw new Error('recovery-fleet-update-phase-refused');
}
function releasedOrDead(t:FleetTransaction):boolean {
 let dead=t.ownerReleased===true;try{if(!dead)process.kill(t.ownerPid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}
 if(!dead){const birth=processStartMs(t.ownerPid);dead=birth!==null&&birth!==t.ownerBirth;}return dead;
}
/** The first member remains the common mutex until every other latch clears. */
function finishFleetLatches(t:FleetTransaction,boot:string,onlyMatching=false):void {
 for(const m of [...t.members.slice(1),t.members[0]]){
  const a=admission(JSON.parse(m.previousConfig),boot);
  try{const owned=a.ownedUpdate();if(onlyMatching&&owned?.digest!==token(t))continue;a.finishOwnedUpdate(token(t),{pid:t.ownerPid,birth:t.ownerBirth});}finally{a.close();}
 }
}
async function claimFleetUpdate(file:string,t:FleetTransaction,onlyExisting=false):Promise<FleetTransaction> {
 const boot=await recoveryHostBootId(),birth=processStartMs(process.pid);if(birth===null)throw new Error('recovery-update-owner-invalid');
 for(const [index,m]of t.members.entries()){
  const a=admission(JSON.parse(m.previousConfig),boot);
  try{
   const owned=a.ownedUpdate();if(onlyExisting&&index>0&&owned?.digest!==token(t))continue;
   if(t.ownerReleased&&owned?.digest===token(t)&&owned.pid===t.ownerPid&&owned.birth===t.ownerBirth)a.releaseOwnedUpdate(token(t),{pid:t.ownerPid,birth:t.ownerBirth});
   a.beginOwnedUpdate(token(t),{pid:process.pid,birth,bootId:boot});
  }finally{a.close();}
 }
 t.ownerPid=process.pid;t.ownerBirth=birth;t.ownerReleased=false;write(file,JSON.stringify(t));return t;
}
export async function resumeAbandonedRecoveryFleetUpdate(configFile:string):Promise<void>{
 const c=loadRecoveryConfig(configFile,{restorationOnly:true});if(c.watchdog?.kind!=='agent-rule'||!c.watchdog.script)return;
 const file=path.join(path.dirname(c.watchdog.script),'recovery-fleet-update.json');if(!fs.existsSync(file))return;let t=load(file);
 if(!t.members.length||!t.members.some(m=>m.configFile===configFile))return;
 const boot=await recoveryHostBootId();let hasMatching=false;
 for(const m of t.members){const a=admission(JSON.parse(m.previousConfig),boot);try{if(a.ownedUpdate()?.digest===token(t))hasMatching=true;}finally{a.close();}}
 if(t.phase!=='prepared'&&!hasMatching)return;if(!releasedOrDead(t))return;
 if(t.abortBeforeWrite){
  if(hasMatching){t=await claimFleetUpdate(file,t,true);finishFleetLatches(t,boot,true);}
  t.phase='rolled-back';t.outcome='rolled-back';write(file,JSON.stringify(t));return;
 }
 if(!t.outcome&&t.phase==='prepared'){await recoveryFleetUpdatePhase('rollback',file);return;}
 t=await claimFleetUpdate(file,t);
 const outcome=t.outcome??(t.phase==='committed'?'committed':'rolled-back');
 const expectedScript=outcome==='committed'?t.nextScript:t.previousScript,expectedPlist=outcome==='committed'?t.nextPlist:t.previousPlist;
 if(read(t.scriptFile)!==expectedScript||read(t.plistFile)!==expectedPlist)throw new Error('recovery-fleet-update-concurrent-policy');
 for(const m of t.members){
  const previous=JSON.parse(m.previousConfig)as RecoveryHostConfig;
  const expected=outcome==='committed'?{...previous,watchdog:{...previous.watchdog!,scriptDigest:hash(t.nextScript),ownershipDigest:hash(t.nextPlist)}}:previous;
  if(JSON.stringify(JSON.parse(read(m.configFile,true)))!==JSON.stringify(expected))throw new Error('recovery-fleet-update-concurrent-policy');
  if(m.active)await installRecoveryServices(expected,m.configFile,expected.watchdog!.entrypoint!,{ownedUpdateDigest:token(t)});
 }
 t.outcome=outcome;write(file,JSON.stringify(t));finishFleetLatches(t,boot);t.phase=outcome;write(file,JSON.stringify(t));
}
