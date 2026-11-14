import { prepareRecoveryRuntimeSlot, type RecoveryRuntimeSlot } from './RecoveryRuntimeSlot.js';
import { saveRecoveryMainBindingCandidate, validateRecoveryMainBindings, type RecoveryMainBindingSnapshot } from './RecoveryMainBindings.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { withSyncOp } from '../core/InFlightSyncOpMarker.js';
import { processStartMs } from '../core/processIdentity.js';
/** Owned Autostart installer transaction; never reachable through recovery wire verbs or phone bodies. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {loadRecoveryConfig,LaunchdRecoveryControl,recoveryHostBootId,type RecoveryHostConfig} from './RecoveryEngine.js';
import {RecoveryAdmission} from './RecoveryAdmission.js';
import {installRecoveryServices} from './RecoveryInstallation.js';

const digest=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
function read(file:string,privateFile=false):string {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&(privateFile?0o077:0o022))||st.size>262_144)throw new Error('recovery-update-ownership-invalid');return fs.readFileSync(fd,'utf8');}
  finally{fs.closeSync(fd);}
}
function atomic(file:string,content:string):void {
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,content,{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);
}
function xmlDecode(s:string):string{return s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');}
/** Exact installer command shape, scoped to the already enrolled agent home. */
export function validateOwnedRecoveryAutostartPlan(plan:string,projectDir:string,agentId:string):void {
  const stringValue=(key:string)=>{const matches=[...plan.matchAll(new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`,'g'))];if(matches.length!==1)throw new Error('recovery-update-plan-invalid');return xmlDecode(matches[0][1]);};
  if(stringValue('Label')!==`ai.instar.${agentId}`||stringValue('WorkingDirectory')!==projectDir)throw new Error('recovery-update-plan-invalid');
  const blocks=[...plan.matchAll(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/g)];
  if(blocks.length!==1)throw new Error('recovery-update-plan-invalid');
  const args=[...blocks[0][1].matchAll(/<string>([^<]*)<\/string>/g)].map(m=>xmlDecode(m[1]));
  const prefix=[path.join(projectDir,'.instar','bin','node'),path.join(projectDir,'.instar','instar-boot.cjs')];
  const candidates=[ [...prefix,'server','start','--foreground','--dir',projectDir], [...prefix,'lifeline','start','--dir',projectDir] ];
  if(!candidates.some(expected=>JSON.stringify(args)===JSON.stringify(expected)))throw new Error('recovery-update-plan-invalid');
  if(/<key>\s*Program\s*<\/key>/.test(plan))throw new Error('recovery-update-plan-invalid');
}
interface BindingFile{content:string;mode:number}
interface BindingState{js:BindingFile|null;sh:BindingFile|null;nodeTarget:string|null}
interface Transaction {
  version:1;projectDir:string;configFile:string;plistFile:string;entrypoint:string;
  latchKey?:string;bindingStage?:boolean;bindingStaged?:boolean;previousBindings?:BindingState;nextBindingsCandidate?:{js?:string;sh?:string;nodeTarget?:string};nextMainBindings?:RecoveryMainBindingSnapshot;nextRuntimeSlot?:RecoveryRuntimeSlot;
  previousConfig:string;previousPlist:string;nextPlist:string;ownerPid:number;ownerBirth:number;ownerReleased?:boolean;abortBeforeWrite?:boolean;outcome?:'committed'|'rolled-back';recoveryWasActive?:boolean;phase:'prepared'|'committed'|'rolled-back';
}
function load(file:string):Transaction {
  const t=JSON.parse(read(file,true)) as Transaction;
  if(t.version!==1||file!==path.join(t.projectDir,'.instar','recovery','main-update.json')||t.configFile!==path.join(t.projectDir,'.instar','recovery','host.json')||!path.isAbsolute(t.entrypoint))throw new Error('recovery-update-transaction-invalid');
  const old=JSON.parse(t.previousConfig) as RecoveryHostConfig;
  if(t.plistFile!==old.mainService?.plist||digest(t.previousPlist)!==old.mainService.ownershipDigest)throw new Error('recovery-update-transaction-invalid');
  if(t.latchKey!==undefined&&!/^[a-f0-9]{64}$/.test(t.latchKey))throw new Error('recovery-update-transaction-invalid');
  if(!t.bindingStage||t.bindingStaged)validateOwnedRecoveryAutostartPlan(t.nextPlist,t.projectDir,old.agentId);
  else if(t.nextPlist!==t.previousPlist)throw new Error('recovery-update-transaction-invalid');
  return t;
}
function transactionKey(t:Transaction):string{return t.latchKey??digest(t.previousConfig+t.nextPlist);}
function nextConfig(prior:RecoveryHostConfig,t:Transaction):RecoveryHostConfig{return {...prior,mainService:{...prior.mainService!,ownershipDigest:digest(t.nextPlist)},...(t.nextMainBindings?{mainBindings:t.nextMainBindings}:{}),...(t.nextRuntimeSlot?{runtimeSlot:t.nextRuntimeSlot,previousRuntimeSlot:prior.runtimeSlot}:{})};}
function bindingPaths(projectDir:string){const state=path.join(projectDir,'.instar');return{js:path.join(state,'instar-boot.cjs'),sh:path.join(state,'instar-boot.sh'),node:path.join(state,'bin','node')};}
function bindingFile(file:string):BindingFile|null{
  try{const stat=fs.lstatSync(file);return{content:read(file),mode:stat.mode&0o777};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
function bindingState(projectDir:string):BindingState{
  const paths=bindingPaths(projectDir);let nodeTarget:string|null=null;
  try{const stat=fs.lstatSync(paths.node);if(!stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw new Error('recovery-update-binding-changed');nodeTarget=fs.readlinkSync(paths.node);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return{js:bindingFile(paths.js),sh:bindingFile(paths.sh),nodeTarget};
}
function assertCandidateBindings(t:Transaction):void{
  const current=bindingState(t.projectDir),candidate=t.nextBindingsCandidate;
  if(!candidate||current.js?.content!==candidate.js||current.sh?.content!==candidate.sh||!current.nodeTarget||path.resolve(path.dirname(bindingPaths(t.projectDir).node),current.nodeTarget)!==candidate.nodeTarget)throw new Error('recovery-update-binding-changed');
}
function restoreBindingState(t:Transaction):void{
  if(!t.bindingStage||!t.previousBindings)return;
  const current=bindingState(t.projectDir),prior=t.previousBindings,candidate=t.nextBindingsCandidate??{},paths=bindingPaths(t.projectDir);
  for(const kind of ['js','sh']as const){
    if(current[kind]&&current[kind]!.content!==prior[kind]?.content&&current[kind]!.content!==candidate[kind])throw new Error('recovery-update-binding-changed');
  }
  if(current.nodeTarget!==null&&current.nodeTarget!==prior.nodeTarget&&path.resolve(path.dirname(paths.node),current.nodeTarget)!==candidate.nodeTarget)throw new Error('recovery-update-binding-changed');
  for(const kind of ['js','sh']as const){
    if(prior[kind]){atomic(paths[kind],prior[kind]!.content);fs.chmodSync(paths[kind],prior[kind]!.mode);}
    else if(current[kind])SafeFsExecutor.safeUnlinkSync(paths[kind],{operation:'recovery-update:rollback-generated-owned-wrapper'});
  }
  if(current.nodeTarget!==prior.nodeTarget){
    if(current.nodeTarget!==null)SafeFsExecutor.safeUnlinkSync(paths.node,{operation:'recovery-update:rollback-owned-interpreter-alias'});
    if(prior.nodeTarget!==null)fs.symlinkSync(prior.nodeTarget,paths.node);
  }
}
export interface RecoveryAutostartBindingUpdate{
  wrappers(js:string,sh:string):void;node(target:string):void;
  stage(nextPlist:string):{commit():void;rollback():void};rollback():void;
}
/** Fence and retain all fixed bootstrap bytes BEFORE either trusted writer runs. */
export function beginRecoveryAutostartBindingUpdate(projectDir:string,plistFile:string):RecoveryAutostartBindingUpdate|null{
  const configFile=path.join(projectDir,'.instar','recovery','host.json');if(!fs.existsSync(configFile))return null;
  recoverAbandonedRecoveryMainUpdate(configFile);const old=loadRecoveryConfig(configFile);
  if(old.mainBindings)validateRecoveryMainBindings(old);
  if(old.mainService?.plist!==plistFile||(old.mainStateDir&&old.mainStateDir!==path.join(projectDir,'.instar')))throw new Error('recovery-update-plan-invalid');
  const previousPlist=read(plistFile),previousConfig=read(configFile,true),ownerBirth=processStartMs(process.pid);
  if(ownerBirth===null||digest(previousPlist)!==old.mainService.ownershipDigest)throw new Error('recovery-update-owner-invalid');
  const file=path.join(projectDir,'.instar','recovery','main-update.json');
  if(fs.existsSync(file)&&load(file).phase==='prepared')throw new Error('recovery-update-transaction-incomplete');
  const transaction:Transaction={version:1,projectDir,configFile,plistFile,previousConfig,previousPlist,nextPlist:previousPlist,ownerPid:process.pid,ownerBirth,latchKey:crypto.randomBytes(32).toString('hex'),bindingStage:true,previousBindings:bindingState(projectDir),nextBindingsCandidate:{},entrypoint:fileURLToPath(new URL('../../scripts/recovery-entrypoint.mjs',import.meta.url)),phase:'prepared'};
  atomic(file,JSON.stringify(transaction));
  const run=(phase:string)=>withSyncOp(()=>execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/recovery-update-entrypoint.mjs',import.meta.url)),phase,file],{timeout:90_000,maxBuffer:4096,stdio:['ignore','pipe','pipe']}));
  const release=(abortBeforeWrite=false)=>{const pending=load(file);pending.ownerReleased=true;if(abortBeforeWrite)pending.abortBeforeWrite=true;atomic(file,JSON.stringify(pending));};
  const rollback=()=>{release();run('rollback');};
  try{run('prepare');}catch(error){release(true);try{run('resume');}catch{console.warn('[recovery] binding preparation compensation remains pending');}throw error;}
  return{
    wrappers(js,sh){const t=load(file);if(t.bindingStaged||Buffer.byteLength(js)>131072||Buffer.byteLength(sh)>131072)throw new Error('recovery-update-binding-changed');t.nextBindingsCandidate={...t.nextBindingsCandidate,js,sh};atomic(file,JSON.stringify(t));},
    node(target){if(!path.isAbsolute(target))throw new Error('recovery-update-binding-changed');const t=load(file);if(t.bindingStaged)throw new Error('recovery-update-binding-changed');t.nextBindingsCandidate={...t.nextBindingsCandidate,nodeTarget:target};atomic(file,JSON.stringify(t));},
    stage(nextPlist){const t=load(file);validateOwnedRecoveryAutostartPlan(nextPlist,projectDir,old.agentId);t.nextPlist=nextPlist;assertCandidateBindings(t);
      if(old.runtimeSlot&&old.mainStateDir){t.nextRuntimeSlot=prepareRecoveryRuntimeSlot(t.entrypoint,old.stateDir);t.nextMainBindings=saveRecoveryMainBindingCandidate(old,t.nextBindingsCandidate!.js!,t.nextBindingsCandidate!.nodeTarget!,t.nextRuntimeSlot.node);}
      t.bindingStaged=true;atomic(file,JSON.stringify(t));return{commit(){run('commit');},rollback};},rollback,
  };
}
/** Synchronous caller bridge, because the existing Autostart installer API is synchronous. */
export function beginRecoveryAutostartUpdate(projectDir:string,plistFile:string,nextPlist:string):{commit():void;rollback():void}|null {
  const configFile=path.join(projectDir,'.instar','recovery','host.json');
  if(!fs.existsSync(configFile))return null;
  recoverAbandonedRecoveryMainUpdate(configFile);
  const old=loadRecoveryConfig(configFile);
  if(old.mainService?.plist!==plistFile)throw new Error('recovery-update-plan-invalid');
  validateOwnedRecoveryAutostartPlan(nextPlist,projectDir,old.agentId);
  const previousPlist=read(plistFile),previousConfig=read(configFile);
  if(digest(previousPlist)!==old.mainService.ownershipDigest)throw new Error('recovery-update-unexpected-main-policy');
  if(previousPlist===nextPlist)return null;
  const file=path.join(projectDir,'.instar','recovery','main-update.json');
  if(fs.existsSync(file)){
    const pending=load(file);
    if(pending.phase==='prepared')throw new Error('recovery-update-transaction-incomplete');
  }
  const ownerBirth=processStartMs(process.pid);if(ownerBirth===null)throw new Error('recovery-update-owner-invalid');
  const transaction:Transaction={version:1,projectDir,configFile,plistFile,ownerPid:process.pid,ownerBirth,entrypoint:fileURLToPath(new URL('../../scripts/recovery-entrypoint.mjs',import.meta.url)),previousConfig,previousPlist,nextPlist,phase:'prepared'};
  atomic(file,JSON.stringify(transaction));
  const run=(phase:string)=>withSyncOp(()=>execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/recovery-update-entrypoint.mjs',import.meta.url)),phase,file],{timeout:90_000,maxBuffer:4096,stdio:['ignore','pipe','pipe']}));
  const release=(abortBeforeWrite=false)=>{const pending=load(file);pending.ownerReleased=true;if(abortBeforeWrite)pending.abortBeforeWrite=true;atomic(file,JSON.stringify(pending));};
  try{run('prepare');}catch(error){release(true);try{run('resume');}catch{console.warn('[recovery] owned update compensation remains pending in its durable transaction');}throw error;}
  return {commit(){run('commit');},rollback(){release();run('rollback');}};
}
/** Executed only by the installer-owned standalone bridge; all selectors revalidated locally. */
export async function recoveryAutostartUpdatePhase(phase:string,file:string):Promise<void> {
  let t=load(file);const prior=JSON.parse(t.previousConfig) as RecoveryHostConfig;
  if(phase==='resume'){
    await resumeAbandonedRecoveryMainUpdate(t.configFile);
    const check=new RecoveryAdmission({stateDir:prior.stateDir,agentId:prior.agentId,machineId:prior.machineId,certificationRoot:prior.certificationRoot,bootId:await recoveryHostBootId()});
    try{if(check.ownedUpdate())throw new Error('recovery-update-operation-busy');}finally{check.close();}return;
  }
  const current=read(t.plistFile);
  if(phase==='prepare') {
    if(digest(current)!==prior.mainService!.ownershipDigest||read(t.configFile)!==t.previousConfig)throw new Error('recovery-update-concurrent-policy-change');
    const admission=new RecoveryAdmission({stateDir:prior.stateDir,agentId:prior.agentId,machineId:prior.machineId,certificationRoot:prior.certificationRoot,bootId:await recoveryHostBootId()});
    try {
      t.recoveryWasActive=admission.locallyActive();atomic(file,JSON.stringify(t));
      admission.beginOwnedUpdate(transactionKey(t),{pid:t.ownerPid,birth:t.ownerBirth,bootId:await recoveryHostBootId()});
      const hold=admission.hold();if(hold){await new LaunchdRecoveryControl(prior).restoreWatchdog(hold.original);admission.clearHold();admission.audit('watchdog-hold-restored-before-main-update');}
    }catch(error){admission.finishOwnedUpdate(transactionKey(t),{pid:t.ownerPid,birth:t.ownerBirth});throw error;}finally{admission.close();}
    return;
  }
  if(phase==='commit') {
    if(t.bindingStage&&!t.bindingStaged)throw new Error('recovery-update-bindings-not-staged');
    if(t.bindingStage)assertCandidateBindings(t);
    if(t.phase!=='prepared'||current!==t.nextPlist||read(t.configFile,true)!==t.previousConfig)throw new Error('recovery-update-concurrent-policy-change');
    const next=nextConfig(prior,t);
    atomic(t.configFile,JSON.stringify(next));
    try {if(t.recoveryWasActive)await installRecoveryServices(next,t.configFile,t.entrypoint,{ownedUpdateDigest:transactionKey(t)});t.outcome='committed';atomic(file,JSON.stringify(t));await clearUpdateLatch(prior,t);t.phase='committed';atomic(file,JSON.stringify(t));}
    catch(error){t.ownerReleased=true;atomic(file,JSON.stringify(t));try{await recoveryAutostartUpdatePhase('rollback',file);}catch{console.warn('[recovery] main update rollback remains pending');}throw error;}
    return;
  }
  if(phase==='rollback') {
    t=await claimMainUpdate(file,t);t.phase='prepared';delete t.outcome;atomic(file,JSON.stringify(t));
    const nowConfig=loadRecoveryConfig(t.configFile,{restorationOnly:true}),expectedNext=nextConfig(prior,t);
    if(![JSON.stringify(prior),JSON.stringify(expectedNext)].includes(JSON.stringify(nowConfig))||![digest(t.previousPlist),digest(t.nextPlist)].includes(digest(current)))throw new Error('recovery-update-concurrent-policy-change');
    restoreBindingState(t);atomic(t.plistFile,t.previousPlist);atomic(t.configFile,t.previousConfig);
    if(t.recoveryWasActive)await installRecoveryServices(prior,t.configFile,t.entrypoint,{ownedUpdateDigest:transactionKey(t)});
    const control=new LaunchdRecoveryControl(prior);if((await control.repairDisposition()).allowed)await control.start();
    t.outcome='rolled-back';atomic(file,JSON.stringify(t));await clearUpdateLatch(prior,t);t.phase='rolled-back';atomic(file,JSON.stringify(t));return;
  }
  throw new Error('recovery-update-phase-refused');
}

async function clearUpdateLatch(config:RecoveryHostConfig,t:Transaction):Promise<void> {
  const admission=new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,certificationRoot:config.certificationRoot,bootId:await recoveryHostBootId()});
  try{admission.finishOwnedUpdate(transactionKey(t),{pid:t.ownerPid,birth:t.ownerBirth});}finally{admission.close();}
}
async function claimMainUpdate(file:string,t:Transaction):Promise<Transaction> {
  const config=JSON.parse(t.previousConfig) as RecoveryHostConfig,birth=processStartMs(process.pid),bootId=await recoveryHostBootId();
  if(birth===null)throw new Error('recovery-update-owner-invalid');
  const a=new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,certificationRoot:config.certificationRoot,bootId});
  try {
    const owned=a.ownedUpdate();
    if(t.ownerReleased&&owned?.pid===t.ownerPid&&owned.birth===t.ownerBirth)a.releaseOwnedUpdate(transactionKey(t),{pid:t.ownerPid,birth:t.ownerBirth});
    a.beginOwnedUpdate(transactionKey(t),{pid:process.pid,birth,bootId});
  } finally {a.close();}
  t.ownerPid=process.pid;t.ownerBirth=birth;t.ownerReleased=false;atomic(file,JSON.stringify(t));return t;
}
/** A crashed or explicitly released installer cannot strand admission. A durable
 * outcome remains resumable until exact postconditions AND latch clearance hold. */
export async function resumeAbandonedRecoveryMainUpdate(configFile:string):Promise<void> {
  const file=path.join(path.dirname(configFile),'main-update.json');if(!fs.existsSync(file))return;
  let t=load(file);
  const config=JSON.parse(t.previousConfig) as RecoveryHostConfig,bootId=await recoveryHostBootId();
  const a=new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,certificationRoot:config.certificationRoot,bootId});
  let owned:ReturnType<RecoveryAdmission['ownedUpdate']>;
  try{owned=a.ownedUpdate();}finally{a.close();}
  if(t.phase!=='prepared'&&!owned)return;
  if(owned&&owned.digest!==transactionKey(t))throw new Error('recovery-update-operation-busy');
  let dead=t.ownerReleased===true;try{if(!dead)process.kill(t.ownerPid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}
  if(!dead){const live=processStartMs(t.ownerPid);dead=live!==null&&live!==t.ownerBirth;}
  if(!dead)return;
  if(t.abortBeforeWrite){
    if(owned?.digest===transactionKey(t)){t=await claimMainUpdate(file,t);await clearUpdateLatch(config,t);}
    t.phase='rolled-back';t.outcome='rolled-back';atomic(file,JSON.stringify(t));return;
  }
  if(!t.outcome&&t.phase==='prepared'){await recoveryAutostartUpdatePhase('rollback',file);return;}
  t=await claimMainUpdate(file,t);
  const outcome=t.outcome??(t.phase==='committed'?'committed':'rolled-back');
  const expected=outcome==='committed'?nextConfig(config,t):config;
  const expectedPlist=outcome==='committed'?t.nextPlist:t.previousPlist;
  if(read(t.plistFile)!==expectedPlist||JSON.stringify(JSON.parse(read(t.configFile,true)))!==JSON.stringify(expected))throw new Error('recovery-update-concurrent-policy-change');
  if(t.recoveryWasActive)await installRecoveryServices(expected,t.configFile,t.entrypoint,{ownedUpdateDigest:transactionKey(t)});
  t.outcome=outcome;atomic(file,JSON.stringify(t));await clearUpdateLatch(config,t);t.phase=outcome;atomic(file,JSON.stringify(t));
}
function recoverAbandonedRecoveryMainUpdate(configFile:string):void {
  const file=path.join(path.dirname(configFile),'main-update.json');if(!fs.existsSync(file))return;
  const t=load(file);
  if(t.phase==='prepared') {
    let dead=t.ownerReleased===true;try{if(!dead)process.kill(t.ownerPid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}
    if(!dead){const live=processStartMs(t.ownerPid);dead=live!==null&&live!==t.ownerBirth;}
    if(!dead)throw new Error('recovery-update-operation-busy');
  }
  withSyncOp(()=>execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/recovery-update-entrypoint.mjs',import.meta.url)),'resume',file],{timeout:90_000,maxBuffer:4096,stdio:['ignore','pipe','pipe']}));
}
