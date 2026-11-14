/** Installation plans are explicit and reversible; setup never labels them proven. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LaunchdRecoveryControl, loadRecoveryConfig, recoveryHostBootId, type RecoveryHostConfig } from './RecoveryEngine.js';
import { RecoveryAdmission } from './RecoveryAdmission.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { PeerAuthorizedKeys } from '../core/PeerAuthorizedKeys.js';
import {prepareRecoveryRuntimeSlot,verifyRecoveryRuntimeSlot} from './RecoveryRuntimeSlot.js';
const exec=promisify(execFile);
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function recoveryServiceId(agentId: string,machineId: string): string {
  return crypto.createHash('sha256').update(`instar-recovery-v1\0${agentId}\0${machineId}`).digest('hex').slice(0,32);
}
/** Stable installed build identity; timestamps and ordinary restarts cannot re-arm a breaker. */
export function recoveryRuntimeRevision(entrypoint:string):string {
  if(!path.isAbsolute(entrypoint))throw new Error('recovery-runtime-build-unavailable');
  const root=path.resolve(path.dirname(entrypoint),'..'),bundle=path.join(root,'dist','recovery');
  const directory=fs.lstatSync(bundle);
  if(!directory.isDirectory()||directory.isSymbolicLink()||![0,process.getuid?.()].includes(directory.uid)||(directory.mode&0o022))throw new Error('recovery-runtime-build-unavailable');
  const names=fs.readdirSync(bundle).filter(name=>/^[A-Za-z0-9_-]+\.js$/.test(name)).sort();
  if(!names.length||names.length>128)throw new Error('recovery-runtime-build-unavailable');
  const hash=crypto.createHash('sha256');
  for(const file of [path.join(root,'package.json'),entrypoint,...names.map(name=>path.join(bundle,name))]) {
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||![0,process.getuid?.()].includes(st.uid)||(st.mode&0o022)||st.size>1_048_576)throw new Error('recovery-runtime-build-unavailable');
    hash.update(path.relative(root,file));hash.update('\0');hash.update(fs.readFileSync(file));hash.update('\0');
  }
  return hash.digest('hex');
}
export function recoveryLaunchdPlan(input: {agentId:string;machineId:string;node:string;entrypoint:string;configFile:string;stateDir:string;launchAgentsDir?:string;configRevision?:string;runtimeRevision?:string}): Array<{label:string;file:string;content:string}> {
  for(const file of [input.node,input.entrypoint,input.configFile,input.stateDir,input.launchAgentsDir ?? input.stateDir]) if(!path.isAbsolute(file)||/[\r\n]/.test(file)) throw new Error('recovery-install-path-invalid');
  if(input.configRevision!==undefined&&!/^[a-f0-9]{64}$/.test(input.configRevision))throw new Error('recovery-install-config-revision-invalid');
  if(input.runtimeRevision!==undefined&&!/^[a-f0-9]{64}$/.test(input.runtimeRevision))throw new Error('recovery-install-runtime-revision-invalid');
  const id=recoveryServiceId(input.agentId,input.machineId);
  return ['sidecar','restore'].map(mode=> {
    const label=`com.instar.recovery-${mode}.${id}`;
    const args=[input.node,'--max-old-space-size=64',input.entrypoint,mode,input.configFile];
    const content=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/>
${input.configRevision||input.runtimeRevision?`<key>EnvironmentVariables</key><dict>${input.configRevision?`<key>INSTAR_RECOVERY_CONFIG_REVISION</key><string>${input.configRevision}</string>`:''}${input.runtimeRevision?`<key>INSTAR_RECOVERY_RUNTIME_REVISION</key><string>${input.runtimeRevision}</string>`:''}</dict>`:''}
${mode==='restore'?'<key>StartInterval</key><integer>5</integer>':'<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>'}
<key>ProcessType</key><string>Background</string>
<key>Nice</key><integer>10</integer>
<key>SoftResourceLimits</key><dict><key>ResidentSetSize</key><integer>134217728</integer></dict>
<key>HardResourceLimits</key><dict><key>CPU</key><integer>600</integer><key>NumberOfFiles</key><integer>256</integer><key>Core</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>${xml(path.join(input.stateDir,mode+'.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(input.stateDir,mode+'.log'))}</string>
</dict></plist>\n`;
    return {label,file:path.join(input.launchAgentsDir ?? input.stateDir,label+'.plist'),content};
  });
}
/** launchd can acknowledge bootout before it permits the exact label to be
 * bootstrapped again. Retry only that bounded OS transition, never another job. */
async function bootstrapOwnedPlan(domain:string,label:string,file:string,expected?:{entrypoint:string;configRevision:string},budgetMs=15000):Promise<void> {
  const deadline=Date.now()+budgetMs;let delay=100;
  while(true){
    try{await exec('/bin/launchctl',['bootstrap',domain,file],{timeout:Math.max(1,Math.min(5000,deadline-Date.now())),killSignal:'SIGKILL',maxBuffer:2048});return;}
    catch(error){
      const stderr=String((error as{stderr?:string}).stderr??'');
      if(!/Bootstrap failed: 5|Input\/output error/.test(stderr)||Date.now()>=deadline)throw error;
      try{const status=await exec('/bin/launchctl',['print',`${domain}/${label}`],{timeout:2000,maxBuffer:16384});
        if(expected&&status.stdout.includes(expected.entrypoint)&&status.stdout.includes(expected.configRevision))return;
      }catch{ /* Exact owned label is still completing asynchronous removal. */ }
      await new Promise(resolve=>setTimeout(resolve,Math.min(delay,Math.max(1,deadline-Date.now()))));delay=Math.min(1000,delay*2);
    }
  }
}
/** Caller obtains protected config from verified pairing/owner grant before installing. */
export async function installRecoveryServices(config: RecoveryHostConfig,configFile: string,entrypoint: string,options:{ownedUpdateDigest?:string;admission?:RecoveryAdmission}={}): Promise<{state:'awaiting-peer-proofs';labels:string[]}> {
  if(process.platform!=='darwin'||!process.getuid)throw new Error('recovery-service-platform-unsupported');
  if(JSON.stringify(loadRecoveryConfig(configFile,{restorationOnly:true}))!==JSON.stringify(config))throw new Error('recovery-install-config-changed');
  const runtime=config.runtimeSlot?verifyRecoveryRuntimeSlot(config.runtimeSlot,config.stateDir,true):prepareRecoveryRuntimeSlot(entrypoint,config.stateDir);
  if(options.admission){options.admission.assertInstallationScope(config.stateDir,config.agentId,config.machineId);return installRecoveryServicesLocked(config,configFile,runtime,options.admission);}
  const admission=new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,bootId:await recoveryHostBootId(),certificationRoot:config.certificationRoot});
  try{return await admission.withServiceInstallation(()=>installRecoveryServicesLocked(config,configFile,runtime,admission),options.ownedUpdateDigest);}finally{admission.close();}
}
async function installRecoveryServicesLocked(config:RecoveryHostConfig,configFile:string,runtime:ReturnType<typeof prepareRecoveryRuntimeSlot>,admission:RecoveryAdmission):Promise<{state:'awaiting-peer-proofs';labels:string[]}> {
  if(!process.getuid)throw new Error('recovery-service-platform-unsupported');
  if(JSON.stringify(loadRecoveryConfig(configFile,{restorationOnly:true}))!==JSON.stringify(config))throw new Error('recovery-install-config-changed');
  // Never take the independent restorer away while a watchdog is held. Restore
  // the exact saved policy first; if compensation fails the old services stay.
  const hold=admission.hold();
  if(hold){await new LaunchdRecoveryControl(config).restoreWatchdog(hold.original);admission.clearHold();admission.audit('watchdog-hold-restored-before-update');}
  const launchAgentsDir=path.join(os.homedir(),'Library','LaunchAgents');
  fs.mkdirSync(launchAgentsDir,{recursive:true,mode:0o700});
  const directory=fs.lstatSync(launchAgentsDir);
  if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid()||(directory.mode&0o022))throw new Error('recovery-install-ownership-invalid');
  const plans=recoveryLaunchdPlan({agentId:config.agentId,machineId:config.machineId,node:runtime.node,entrypoint:runtime.entrypoint,configFile,stateDir:config.stateDir,launchAgentsDir,configRevision:crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex'),runtimeRevision:runtime.digest});
  fs.mkdirSync(config.stateDir,{recursive:true,mode:0o700});
  for(const p of plans) {
    const st=fs.existsSync(p.file)?fs.lstatSync(p.file):null;
    if(st&&(st.isSymbolicLink()||!st.isFile()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>65_536))throw new Error('recovery-install-ownership-invalid');
    if(st) {
      const previousConfig=recoveryInstalledConfig(p.file,p.label,p.label.includes('recovery-sidecar.')?'sidecar':'restore');
      const previous=loadRecoveryConfig(previousConfig,{restorationOnly:true});
      if(previous.agentId!==config.agentId||previous.machineId!==config.machineId)throw new Error('recovery-install-ownership-invalid');
    }
    const prior=st?fs.readFileSync(p.file,'utf8'):null;
    const service=`gui/${process.getuid()}/${p.label}`;
    // A changed plan must be reloaded, not merely written beneath a still-running
    // old executable. Keep the exact previous plan for compensating rollback.
    let loaded=false;
    try {await exec('/bin/launchctl',['print',service],{timeout:3_000,maxBuffer:16_384});loaded=true;}
    catch { /* @silent-fallback-ok — an absent service is installed below */ }
    if(prior===p.content&&loaded)continue;
    const temporary=p.file+'.'+crypto.randomUUID()+'.tmp';
    fs.writeFileSync(temporary,p.content,{mode:0o600,flag:'wx'});
    if(loaded)await exec('/bin/launchctl',['bootout',service],{timeout:5_000,maxBuffer:2_048});
    fs.renameSync(temporary,p.file);
    try {await bootstrapOwnedPlan(`gui/${process.getuid()}`,p.label,p.file,{entrypoint:runtime.entrypoint,configRevision:crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex')});}
    catch(error) {
      if(prior!==null) {
        fs.writeFileSync(temporary,prior,{mode:0o600});fs.renameSync(temporary,p.file);
        if(loaded)await bootstrapOwnedPlan(`gui/${process.getuid()}`,p.label,p.file,undefined);
      } else SafeFsExecutor.safeUnlinkSync(p.file,{operation:'recovery-install:rollback-new-owned-service'});
      throw error;
    }
  }
  return {state:'awaiting-peer-proofs',labels:plans.map(p=>p.label)};
}
/** Parse only our protected fixed-action plans; no caller-selected launchd label. */
export function recoveryInstalledConfig(file:string,label:string,mode:string):string {
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>65_536)throw new Error('recovery-install-ownership-invalid');
  const content=fs.readFileSync(file,'utf8');
  const unxml=(s:string)=>s.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
  if(!content.includes(`<key>Label</key><string>${label}</string>`))throw new Error('recovery-install-ownership-invalid');
  const block=/<key>ProgramArguments<\/key><array>([\s\S]*?)<\/array>/.exec(content)?.[1];
  const args=block?[...block.matchAll(/<string>([^<]*)<\/string>/g)].map(m=>unxml(m[1])):[];
  if((args.length!==4&&args.length!==5)||args.at(-2)!==mode||!path.isAbsolute(args[0])||!path.isAbsolute(args.at(-3)??'')||!path.isAbsolute(args.at(-1)??'')
    ||(args.length===5&&args[1]!=='--max-old-space-size=64'))throw new Error('recovery-install-ownership-invalid');
  return args.at(-1)!;
}
export async function stopRecoveryServices(agentId:string,machineId:string,options:{configFile?:string}={}): Promise<void> {
  if(process.platform!=='darwin'||!process.getuid)throw new Error('recovery-service-platform-unsupported');
  const uid=process.getuid();
  const id=recoveryServiceId(agentId,machineId);
  const plans=['sidecar','restore'].map(mode=>{
    const label=`com.instar.recovery-${mode}.${id}`,file=path.join(os.homedir(),'Library','LaunchAgents',label+'.plist');
    return {mode,label,file,configFile:fs.existsSync(file)?recoveryInstalledConfig(file,label,mode):null};
  });
  const files=new Set([options.configFile,...plans.map(p=>p.configFile)].filter((file):file is string=>!!file));
  if(files.size>1)throw new Error('recovery-install-ownership-invalid');
  if(!files.size)return;
  const config=loadRecoveryConfig([...files][0],{restorationOnly:true});
  if(config.agentId!==agentId||config.machineId!==machineId)throw new Error('recovery-install-ownership-invalid');
  // Existing authenticated SSH connections survive authorized_keys removal.
  // Persist the admission latch before touching grants or stopping listeners.
  const deactivation=new RecoveryAdmission({stateDir:config.stateDir,agentId,machineId,bootId:await recoveryHostBootId(),certificationRoot:config.certificationRoot});
  try{deactivation.deactivate();}finally{deactivation.close();}
  const admission=new RecoveryAdmission({stateDir:config.stateDir,agentId,machineId,bootId:await recoveryHostBootId(),certificationRoot:config.certificationRoot});
  try {
    // Let an already admitted bounded operation finish without holding the DB
    // writer lock it needs to record completion. New remote work is deactivated.
    const deadline=Date.now()+20_000;
    while(admission.hasRunningMutation()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    if(admission.hasRunningMutation())throw new Error('recovery-uninstall-operation-busy');
    let failure:unknown;
    await admission.withServiceInstallation(async()=>{
      const current=loadRecoveryConfig([...files][0],{restorationOnly:true});
      if(current.agentId!==agentId||current.machineId!==machineId||current.stateDir!==config.stateDir)throw new Error('recovery-install-ownership-invalid');
      // An explicit reinstall may have finished while the old operation drained.
      // This final deactivation advances the epoch under the SAME writer lock
      // as every grant/service removal, so that install cannot arm after stop.
      admission.deactivate();
      try{
      if(current.authorizedKeysHome)new PeerAuthorizedKeys(current.authorizedKeysHome,false,'instar-recovery-access').revokeUnknown(agentId,new Set());
      const unload=async(p:typeof plans[number])=>{
        try{await exec('/bin/launchctl',['bootout',`gui/${uid}/${p.label}`],{timeout:5_000,maxBuffer:2_048});}
        catch(error){const detail=String((error as{stderr?:string}).stderr??'');if(!/Could not find service|No such process|No such file or directory/.test(detail))throw error;}
        if(p.configFile&&fs.existsSync(p.file))SafeFsExecutor.safeUnlinkSync(p.file,{operation:'recovery-uninstall:remove-owned-login-service'});
      };
      await unload(plans[0]);
      if(current.authorizedKeysHome)new PeerAuthorizedKeys(current.authorizedKeysHome,false,'instar-recovery-access').revokeUnknown(agentId,new Set());
      const manifest=path.join(path.dirname(current.stateDir),'runtime.json');
      if(fs.existsSync(manifest)){
        const st=fs.lstatSync(manifest);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('recovery-install-ownership-invalid');
        SafeFsExecutor.safeUnlinkSync(manifest,{operation:'recovery-uninstall:remove-runtime-enrollment'});
      }
      const hold=admission.hold();if(hold){await new LaunchdRecoveryControl(current).restoreWatchdog(hold.original);admission.clearHold();}
      admission.audit('recovery-services-uninstalled');await unload(plans[1]);
      }catch(error){failure=error;admission.audit('recovery-uninstall-incomplete');}
    });
    if(failure)throw failure;
  }finally{admission.close();}
}
