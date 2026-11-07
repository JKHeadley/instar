import { restoreRecoveryMainBindings, validateRecoveryMainBindings, type RecoveryMainBindingSnapshot } from './RecoveryMainBindings.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { recoveryResponseJson } from './RecoveryHttp.js';
import { PeerAuthorizedKeys } from '../core/PeerAuthorizedKeys.js';
import { qualifyRecoverySshEnvironment } from './RecoverySshEnvironment.js';
import type { RecoveryRuntimeSlot } from './RecoveryRuntimeSlot.js';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { RecoveryAdmission, type RecoveryWatchdogHold, type RecoveryWatchdogPolicy } from './RecoveryAdmission.js';
import { recoveryServiceId } from './RecoveryInstallation.js';
import { validRecoveryId, recoveryDigest, signRecovery, type RecoveryCertificate, type RecoveryCheckpoint, type RecoveryControlRequest, type RecoveryDiscovery, type RecoveryHello, type RecoveryEnvelope, type RecoveryReceipt, type RecoveryRoute, type Signed } from './RecoveryProtocol.js';

const exec = promisify(execFile);
export interface RecoveryHostConfig {
  version: 1; agentId: string; machineId: string; stateDir: string; certificationRoot: string;
  sshPrivateKey: string; relayPrivateKey: string;
  relayUrl: string; serviceLabel: string; healthPort: number; mainAuthToken?: string;
  authorizedKeysHome?:string;
  mainStateDir?:string;
  sshEnvironmentHostKeyFile?:string;
  runtimeSlot?:RecoveryRuntimeSlot;
  previousRuntimeSlot?:RecoveryRuntimeSlot;
  validatedGrantInventory?:string;
  mainBindings?:RecoveryMainBindingSnapshot;
  mainService?: { plist:string; ownershipDigest:string };
  watchdog?: RecoveryWatchdogPolicy;
}
export async function recoveryHostBootId(): Promise<string> {
  if (process.platform === 'darwin') return (await exec('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{timeout:3_000,maxBuffer:1_024})).stdout.trim();
  if (process.platform === 'linux') return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  throw new Error('recovery-host-unsupported');
}
export function loadRecoveryConfig(file: string, options: { restorationOnly?: boolean } = {}): RecoveryHostConfig {
  if (!path.isAbsolute(file)) throw new Error('recovery-config-absolute-path-required');
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid?.() || st.size > 32_768) throw new Error('recovery-config-ownership-invalid');
  const c = JSON.parse(fs.readFileSync(file,'utf8')) as RecoveryHostConfig;
  if (c.version !== 1 || !validRecoveryId(c.agentId) || !validRecoveryId(c.machineId)
    || (c.serviceLabel !== `com.instar.recovery-target.${recoveryServiceId(c.agentId,c.machineId)}` && c.serviceLabel !== `ai.instar.${c.agentId}`)
    || !path.isAbsolute(c.stateDir) || !Number.isSafeInteger(c.healthPort) || c.healthPort < 1 || c.healthPort > 65535) throw new Error('recovery-config-invalid');
  const url = new URL(c.relayUrl);
  if((c.authorizedKeysHome!==undefined&&!path.isAbsolute(c.authorizedKeysHome))||(c.validatedGrantInventory!==undefined&&!path.isAbsolute(c.validatedGrantInventory))||(c.mainStateDir!==undefined&&!path.isAbsolute(c.mainStateDir)))throw new Error('recovery-config-invalid');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('recovery-relay-tls-required');
  if (!options.restorationOnly && c.serviceLabel.startsWith('ai.instar.')) verifyRecoveryMainService(c);
  return c;
}
/** The exact installed main-service policy is locally pinned, never selected by a peer. */
export function verifyRecoveryMainService(config:RecoveryHostConfig):void {
  const policy=config.mainService;
  if (!policy || !path.isAbsolute(policy.plist) || !/^[a-f0-9]{64}$/.test(policy.ownershipDigest)) throw new Error('recovery-main-service-ownership-invalid');
  const st=fs.lstatSync(policy.plist);
  if (!st.isFile() || st.isSymbolicLink() || st.uid!==process.getuid?.() || (st.mode&0o022) || st.size>65_536) throw new Error('recovery-main-service-ownership-invalid');
  const content=fs.readFileSync(policy.plist,'utf8');
  if (crypto.createHash('sha256').update(content).digest('hex')!==policy.ownershipDigest
    || !content.includes(`<string>${config.serviceLabel}</string>`)
    || (!content.includes('<string>server</string>')&&!content.includes('<string>lifeline</string>')) || !content.includes('<string>start</string>')) throw new Error('recovery-main-service-policy-changed');
}
export interface RecoveryServiceControl {
  status(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
  watchdogActive(): Promise<boolean>;
  holdWatchdog(hold?:RecoveryWatchdogHold): Promise<void>;
  restoreWatchdog(original: RecoveryWatchdogHold['original']): Promise<void>;
  watchdogEvidence?():Promise<{recent:boolean;observedAt:number|null;kind:string}>;
  stopOwnedRuleTarget?():void;
  repairDisposition?():Promise<{allowed:boolean;reason:string|null}>;
}
/** No remote argument reaches execFile: all selectors come from the protected installation. */
export class LaunchdRecoveryControl implements RecoveryServiceControl {
  constructor(private readonly config: RecoveryHostConfig) {}
  private domain(): string {
    if (process.platform !== 'darwin' || !process.getuid) throw new Error('recovery-service-platform-unsupported');
    return `gui/${process.getuid()}`;
  }
  private mainInspection:{healthy:boolean;allowRepair:boolean;reason:string|null}|null=null;
  async status(): Promise<boolean> {
    const set=(healthy:boolean,allowRepair:boolean,reason:string|null)=>{this.mainInspection={healthy,allowRepair,reason};return healthy;};
    try {
      if(this.config.serviceLabel.startsWith('ai.instar.')&&(this.config.mainBindings||this.config.runtimeSlot))validateRecoveryMainBindings(this.config);
      let service:{stdout:string};
      try{service=await exec('/bin/launchctl',['print',`${this.domain()}/${this.config.serviceLabel}`],{timeout:3_000,maxBuffer:16_384});}
      catch(error){return this.missingService(error)?set(false,true,'main-service-not-loaded'):set(false,false,'main-inspection-unavailable');}
      if(!/pid = [1-9][0-9]*/.test(service.stdout))return set(false,true,'main-service-not-running');
      if(!this.config.mainAuthToken)return set(false,false,'main-credential-unavailable');
      const headers={Authorization:`Bearer ${this.config.mainAuthToken}`,'X-Instar-AgentId':this.config.agentId};
      let identity:Response;
      try {identity=await fetch(`http://127.0.0.1:${this.config.healthPort}/whoami`,{headers,signal:AbortSignal.timeout(2_000),redirect:'error'});}
      catch(error){return (error as {cause?:{code?:string}})?.cause?.code==='ECONNREFUSED'?set(false,true,'main-http-unreachable'):set(false,false,'main-inspection-unavailable');}
      if(!identity.ok){await identity.body?.cancel();return set(false,false,identity.status===401||identity.status===403?'main-identity-authentication-failed':'main-identity-unavailable');}
      let who:Record<string,unknown>;
      try{who=await recoveryResponseJson(identity,4_096);}catch{return set(false,false,'main-identity-unavailable');}
      if(who.agentId!==this.config.agentId)return set(false,false,'main-identity-mismatch');
      const health=await fetch(`http://127.0.0.1:${this.config.healthPort}/health`,{headers,signal:AbortSignal.timeout(2_000),redirect:'error'});
      await health.body?.cancel();
      if(health.status===401||health.status===403)return set(false,false,'main-identity-authentication-failed');
      return set(health.status===200,true,health.status===200?null:'main-health-unavailable');
    } catch {return set(false,false,'main-inspection-unavailable');}
  }
  private repairDispositionNow():{allowed:boolean;reason:string|null} {
    if(this.mainInspection&&!this.mainInspection.allowRepair)return {allowed:false,reason:this.mainInspection.reason};
    if(!this.config.mainStateDir)return {allowed:!this.config.serviceLabel.startsWith('ai.instar.'),reason:this.config.serviceLabel.startsWith('ai.instar.')?'intent-state-unavailable':null};
    const state=path.join(this.config.mainStateDir,'state');
    try {
      const directory=fs.lstatSync(state);
      if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()||(directory.mode&0o022))throw new Error('untrusted-intent');
      for(const [name,reason] of [['slept-marker.json','intentional-sleep'],['sleep-requested.json','sleep-request-pending']] as const) {
        const file=path.join(state,name);
        let st:fs.Stats;
        try{st=fs.lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
        if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022)||st.size>4096)throw new Error('untrusted-intent');
        // The existing supervisor treats marker presence as intentional sleep,
        // including an old/malformed marker. Only its wake path clears it.
        if(name==='slept-marker.json')return {allowed:false,reason};
        let request:{expiresAt?:string}={};
        try{request=JSON.parse(fs.readFileSync(file,'utf8'));}catch{ /* Existing supervisor tolerates malformed pending sleep as an intent. */ }
        if(request?.expiresAt&&new Date(request.expiresAt).getTime()<Date.now())continue;
        return {allowed:false,reason};
      }
      return {allowed:true,reason:null};
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT')return {allowed:true,reason:null};
      return {allowed:false,reason:'intent-state-unavailable'};
    }
  }
  async repairDisposition():Promise<{allowed:boolean;reason:string|null}> {return this.repairDispositionNow();}
  private async assertRepairAllowed():Promise<void> {
    const disposition=await this.repairDisposition();
    if(!disposition.allowed)throw new Error(disposition.reason?.startsWith('main-')?'recovery-main-inspection-unverified':'recovery-intentional-stop');
  }
  private missingService(error:unknown):boolean {
    return /Could not find service|No such process|No such file or directory/.test(String((error as {stderr?:string})?.stderr??''));
  }
  async start(): Promise<void> {
    if(this.config.serviceLabel.startsWith('ai.instar.'))verifyRecoveryMainService(this.config);
    await this.assertRepairAllowed();
    if(this.config.serviceLabel.startsWith('ai.instar.')&&(this.config.mainBindings||this.config.runtimeSlot))restoreRecoveryMainBindings(this.config);
    await this.status();
    await this.assertRepairAllowed();
    const production=this.config.serviceLabel.startsWith('ai.instar.'),service=`${this.domain()}/${this.config.serviceLabel}`;
    if(production) {
      verifyRecoveryMainService(this.config);
      try {await exec('/bin/launchctl',['print',service],{timeout:3_000,maxBuffer:16_384});}
      catch(error) {
        // A successful owned watchdog stop removes the launchd job. Restore only
        // its exact pinned installed policy; never select a source-supplied file.
        if(!this.missingService(error))throw error;
        verifyRecoveryMainService(this.config);
        await exec('/bin/launchctl',['bootstrap',this.domain(),this.config.mainService!.plist],{timeout:5_000,maxBuffer:2_048});
      }
      verifyRecoveryMainService(this.config);
    }
    await this.assertRepairAllowed();
    await exec('/bin/launchctl',['kickstart',service],{timeout:15_000,maxBuffer:2_048});
  }
  async stop(): Promise<void> {
    if(this.config.serviceLabel.startsWith('ai.instar.')) {
      verifyRecoveryMainService(this.config);
      // SIGTERM alone immediately respawns a KeepAlive job. Boot out only this
      // agent's pinned service; start() restores its exact original policy.
      try {await exec('/bin/launchctl',['bootout',`${this.domain()}/${this.config.serviceLabel}`],{timeout:5_000,maxBuffer:2_048});}
      catch(error){if(!this.missingService(error))throw error;}
      return;
    }
    await exec('/bin/launchctl',['kill','SIGTERM',`${this.domain()}/${this.config.serviceLabel}`],{timeout:5_000,maxBuffer:2_048});
  }
  private watchdog(original = this.config.watchdog): RecoveryWatchdogPolicy {
    const w = original;
    if (!w || (!(w.kind==='agent-rule'&&w.label==='ai.instar.watchdog')&&!/^com\.instar\.recovery-watchdog\.[a-f0-9]{32}$/.test(w.label)) || !path.isAbsolute(w.plist)) throw new Error('recovery-external-watchdog-refused');
    const st = fs.lstatSync(w.plist);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o022)) throw new Error('recovery-watchdog-ownership-invalid');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(w.plist)).digest('hex');
    if (digest !== w.ownershipDigest) throw new Error('recovery-watchdog-policy-changed');
    if(w.kind==='agent-rule') {
      const parent=path.dirname(this.config.stateDir);
      if(w.targetLabel!==this.config.serviceLabel||w.holdFile!==path.join(parent,'watchdog-hold.json')||w.eventsFile!==path.join(parent,'watchdog-events.jsonl')
        ||!w.script||!path.isAbsolute(w.script)||!w.scriptDigest||!w.entrypoint||!path.isAbsolute(w.entrypoint))throw new Error('recovery-watchdog-ownership-invalid');
      const script=fs.lstatSync(w.script);
      if(!script.isFile()||script.isSymbolicLink()||script.uid!==process.getuid?.()||(script.mode&0o022)||script.size>262_144)throw new Error('recovery-watchdog-ownership-invalid');
      const source=fs.readFileSync(w.script,'utf8');
      if(crypto.createHash('sha256').update(source).digest('hex')!==w.scriptDigest||!source.includes('recovery_rule_held'))throw new Error('recovery-watchdog-policy-changed');
    }
    return w;
  }
  stopOwnedRuleTarget():void {
    if(!this.repairDispositionNow().allowed)throw new Error('recovery-intentional-stop');
    const w=this.watchdog();
    if(w.kind!=='agent-rule')throw new Error('recovery-external-watchdog-refused');
    verifyRecoveryMainService(this.config);
    execFileSync('/bin/launchctl',['bootout',`${this.domain()}/${this.config.serviceLabel}`],{timeout:5_000,killSignal:'SIGKILL',maxBuffer:2_048});
  }
  validateOwnedWatchdogRule():void{if(this.watchdog().kind!=='agent-rule')throw new Error('recovery-external-watchdog-refused');}
  async watchdogActive(): Promise<boolean> {
    const w=this.watchdog();
    await exec('/bin/launchctl',['print',`${this.domain()}/${w.label}`],{timeout:3_000,maxBuffer:16_384});
    return true;
  }
  async watchdogEvidence():Promise<{recent:boolean;observedAt:number|null;kind:string}> {
    const w=this.watchdog();
    if(w.kind!=='agent-rule')return {recent:false,observedAt:null,kind:'dedicated-owned-service'};
    try {
      const st=fs.lstatSync(w.eventsFile!);
      if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>262_144)throw new Error('recovery-watchdog-evidence-invalid');
      const events=fs.readFileSync(w.eventsFile!,'utf8').trim().split('\n').slice(-128).reverse();
      for(const line of events) {
        const event=JSON.parse(line);
        if(event.version===1&&event.label===this.config.serviceLabel&&event.event==='owned-rule-stopped'
          &&event.scriptDigest===w.scriptDigest&&event.plistDigest===w.ownershipDigest&&Number.isSafeInteger(event.at)
          &&event.at<=Date.now()&&Date.now()-event.at<=120_000)return {recent:true,observedAt:event.at,kind:'agent-rule'};
      }
    } catch { /* @silent-fallback-ok — absent/untrusted evidence never permits a rule hold */ }
    return {recent:false,observedAt:null,kind:'agent-rule'};
  }
  async holdWatchdog(hold?:RecoveryWatchdogHold): Promise<void> {
    await this.assertRepairAllowed();
    const w = this.watchdog();
    if(w.kind==='agent-rule') {
      if(!hold||!(await this.watchdogEvidence()).recent)throw new Error('recovery-watchdog-kill-evidence-required');
      await this.assertRepairAllowed();
      const file=w.holdFile!,temporary=file+'.'+crypto.randomUUID()+'.tmp';
      if(fs.existsSync(file)){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('recovery-watchdog-ownership-invalid');}
      fs.writeFileSync(temporary,JSON.stringify({version:1,label:w.targetLabel,deadline:hold.deadline,monotonicDeadline:hold.monotonicDeadline,bootId:hold.bootId,
        scriptDigest:w.scriptDigest,plistDigest:w.ownershipDigest}),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);
      return;
    }
    await exec('/bin/launchctl',['bootout',`${this.domain()}/${w.label}`],{timeout:5_000,maxBuffer:2_048});
  }
  async restoreWatchdog(original: RecoveryWatchdogHold['original']): Promise<void> {
    if(original.kind==='agent-rule') {
      // Removing an exact owned marker restores the rule even if the installed
      // watchdog was updated during the hold. Never unload the fleet service.
      const w=original;
      if(w.targetLabel!==this.config.serviceLabel||w.holdFile!==path.join(path.dirname(this.config.stateDir),'watchdog-hold.json'))throw new Error('recovery-watchdog-ownership-invalid');
      try {
        const st=fs.lstatSync(w.holdFile!);
        if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('recovery-watchdog-ownership-invalid');
        const marker=JSON.parse(fs.readFileSync(w.holdFile!,'utf8'));
        if(marker.label!==w.targetLabel||marker.scriptDigest!==w.scriptDigest||marker.plistDigest!==w.ownershipDigest)throw new Error('recovery-watchdog-ownership-invalid');
        SafeFsExecutor.safeUnlinkSync(w.holdFile!,{operation:'recovery-watchdog:restore-owned-marker'});
      } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      return;
    }
    const w = this.watchdog(original);
    try { await exec('/bin/launchctl',['print',`${this.domain()}/${w.label}`],{timeout:3_000,maxBuffer:16_384}); }
    catch { // @silent-fallback-ok — absent owned service is restored from the exact validated plist
      await exec('/bin/launchctl',['bootstrap',this.domain(),w.plist],{timeout:5_000,maxBuffer:2_048});
    }
  }
}
export class RecoveryEngine {
  constructor(readonly config: RecoveryHostConfig, readonly admission: RecoveryAdmission, readonly bootId: string, private readonly services: RecoveryServiceControl) {}
  hello(request:Signed<RecoveryDiscovery>, route: RecoveryRoute): Signed<RecoveryHello> {
    this.admission.verifyDiscovery(request,route);
    return signRecovery({domain:'instar-recovery-hello-v1',agentId:this.config.agentId,machineId:this.config.machineId,bootId:this.bootId,
      nonce:request.payload.nonce,route,fencingEpoch:this.admission.fencingEpoch(),repairEpoch:this.admission.repairEpoch(),checkpoint:this.admission.lease(),observedAt:Date.now()},route === 'ssh' ? this.config.sshPrivateKey : this.config.relayPrivateKey);
  }
  private controlRequest(action:'checkpoint'|'checkpoint-ack',body:Record<string,unknown>):Signed<RecoveryControlRequest> {
    const now=Date.now();
    return signRecovery({domain:'instar-recovery-control-request-v1',agentId:this.config.agentId,machineId:this.config.machineId,action,
      nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30_000,body},this.config.relayPrivateKey);
  }
  checkpointForCarrier(request:Signed<RecoveryDiscovery>):Signed<RecoveryControlRequest> {
    this.admission.verifyDiscovery(request,'ssh',{checkpointCarryOnly:true});
    return this.controlRequest('checkpoint',{challenge:this.admission.challenge()});
  }
  acceptCarriedCheckpoint(input:{certificate:Signed<RecoveryCertificate>;checkpoint:Signed<RecoveryCheckpoint>}):Signed<RecoveryControlRequest> {
    this.admission.acceptCheckpoint(input.certificate,input.checkpoint);
    const checkpointVersion=this.reconcileCheckpointRevocations();
    return this.controlRequest('checkpoint-ack',{checkpointVersion});
  }
  reconcileCheckpointRevocations():number {
    return this.admission.withCurrentCheckpoint(checkpoint=>{
      if(!this.config.authorizedKeysHome)return checkpoint.payload.version;
      const keys=new PeerAuthorizedKeys(this.config.authorizedKeysHome,false,'instar-recovery-access'),p=checkpoint.payload;
      if(p.disabledRoutes?.includes('ssh')||!this.config.validatedGrantInventory) {
        keys.revokeUnknown(this.config.agentId,new Set());return p.version;
      }
      if(this.config.serviceLabel.startsWith('ai.instar.')) {
        if(!this.config.sshEnvironmentHostKeyFile){keys.revokeUnknown(this.config.agentId,new Set());throw new Error('recovery-ssh-environment-unverified');}
        try{qualifyRecoverySshEnvironment({hostKeyFile:this.config.sshEnvironmentHostKeyFile});}
        catch(error){keys.revokeUnknown(this.config.agentId,new Set());throw error;}
      }
      const st=fs.lstatSync(this.config.validatedGrantInventory);
      if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>131_072)throw new Error('recovery-grant-inventory-invalid');
      const inventory=JSON.parse(fs.readFileSync(this.config.validatedGrantInventory,'utf8')) as Array<{machineId:string;pairingEpoch:number;generation:number;sshSigningPublicKey:string;relaySigningPublicKey:string;sshClientPublicKey:string;forcedCommand:string}>;
      if(!Array.isArray(inventory)||inventory.length>128)throw new Error('recovery-grant-inventory-invalid');
      const valid=inventory.filter(entry=>{
        const principal=p.principals.find(q=>q.machineId===entry.machineId);
        return principal&&!p.revoked.includes(entry.machineId)&&principal.pairingEpoch===entry.pairingEpoch&&principal.generation===entry.generation
          &&principal.sshPublicKey===entry.sshSigningPublicKey&&principal.relayPublicKey===entry.relaySigningPublicKey;
      });
      keys.revokeUnknown(this.config.agentId,new Set(valid.map(entry=>entry.machineId)));
      for(const entry of valid) {
        const wrapper=path.join(path.dirname(this.config.stateDir),'ssh-wrapper.sh');
        if(entry.forcedCommand!==wrapper)throw new Error('recovery-grant-inventory-invalid');
        const wrapperStat=fs.lstatSync(wrapper);
        if(!wrapperStat.isFile()||wrapperStat.isSymbolicLink()||wrapperStat.uid!==process.getuid?.()||(wrapperStat.mode&0o077))throw new Error('recovery-grant-inventory-invalid');
        keys.reconcile({agentId:this.config.agentId,machineId:entry.machineId,pairingEpoch:entry.pairingEpoch,clientKeyGeneration:entry.generation,publicKey:entry.sshClientPublicKey,forcedCommand:wrapper});
      }
      return p.version;
    });
  }
  /** Local fleet watchdog only. SQLite owns the race with incoming recovery
   * mutations, so a rule cannot kill the server after a hold/start is admitted. */
  stopOwnedWatchdogRuleTarget(ownerPid?:number):{stopped:boolean} {
    if(!this.services.stopOwnedRuleTarget)throw new Error('recovery-external-watchdog-refused');
    const outcome=this.admission.runOwnedWatchdogRuleStop(()=>{
      this.services.stopOwnedRuleTarget!();
      this.admission.audit('owned-watchdog-rule-stopped');
      return true;
    },ownerPid);
    return {stopped:outcome===true};
  }
  async execute(signed: Signed<RecoveryEnvelope>, route: RecoveryRoute): Promise<unknown> {
    const e = signed.payload;
    const admitted = this.admission.admit(signed,route);
    if (admitted.state === 'repeat') {
      if (!admitted.receipt) throw new Error('recovery-operation-in-doubt');
      return admitted.receipt;
    }
    let result: RecoveryReceipt['result'] = 'ok';
    let detail: RecoveryReceipt['detail'] = {};
    try {
      switch (e.verb) {
        case 'status': case 'collect-diagnostics': {
          const budget=this.admission.repairBudget();
          detail = {serverHealthy:await this.services.status(),hostBootId:this.bootId,leaseExpiresAt:this.admission.lease().expiresAt,
            listenerPid:process.pid,listenerParentPid:process.ppid,repairEpoch:budget.repairEpoch,
            independentRuntime:!!this.config.runtimeSlot&&process.execPath===this.config.runtimeSlot.node&&fileURLToPath(import.meta.url)===path.join(this.config.runtimeSlot.directory,'dist','recovery','RecoveryEngine.js'),
            repairBudgetExhausted:budget.exhausted,repairBudgetAvailable:budget.available,repairBudgetRetryAt:budget.retryAt,
            listenerSupervisor:route==='ssh'?'host-sshd':`com.instar.recovery-sidecar.${recoveryServiceId(this.config.agentId,this.config.machineId)}`};
          const disposition=this.services.repairDisposition?await this.services.repairDisposition():{allowed:true,reason:null};
          detail={...detail,repairSuppressed:!disposition.allowed,repairSuppressionReason:disposition.reason};
          if(e.verb==='collect-diagnostics'&&this.config.watchdog&&this.services.watchdogEvidence) {
            const evidence=await this.services.watchdogEvidence();
            detail={...detail,ownedWatchdogRecentMutation:evidence.recent,ownedWatchdogEvidenceAt:evidence.observedAt,ownedWatchdogKind:evidence.kind};
          }
          break;
        }
        case 'start-instar-server': await this.services.start(); detail = {startRequested:true}; break;
        case 'stop-instar-server': await this.services.stop(); detail = {stopRequested:true}; break;
        case 'hold-owned-instar-watchdog':
          // The independent restore service reads this durable intent BEFORE the hold begins.
          if (!await this.services.watchdogActive()) throw new Error('recovery-watchdog-not-active');
          if (!this.config.watchdog) throw new Error('recovery-external-watchdog-refused');
          {
            const hold={deadline:Date.now()+60_000,monotonicDeadline:Number(process.hrtime.bigint()/1_000_000n)+60_000,bootId:this.bootId,original:this.config.watchdog};
            this.admission.beginHold(hold);
            await this.services.holdWatchdog(hold); detail = {holdUntil:this.admission.holdDeadline()}; break;
          }
        case 'restore': {
          const hold=this.admission.hold();
          if(!hold)throw new Error('recovery-watchdog-no-owned-hold');
          await this.services.restoreWatchdog(hold.original); this.admission.clearHold(); detail = {restored:true}; break;
        }
      }
    } catch (error) {
      result = 'failed';
      detail = {reason:error instanceof Error && /^recovery-[a-z-]+$/.test(error.message) ? error.message : 'recovery-service-action-failed'};
    }
    const receipt: RecoveryReceipt = {domain:'instar-recovery-receipt-v1',agentId:e.agentId,sourceMachineId:e.sourceMachineId,targetMachineId:e.targetMachineId,targetBootId:this.bootId,
      operationId:e.operationId,requestDigest:recoveryDigest(e),route,observedAt:Date.now(),checkpointVersion:this.admission.lease().version,result,detail};
    const response = signRecovery(receipt,route === 'ssh' ? this.config.sshPrivateKey : this.config.relayPrivateKey);
    this.admission.complete(e.operationId,response);
    return response;
  }
  async restoreExpiredHold(): Promise<void> {
    const hold = this.admission.hold();
    if (hold && (hold.deadline <= Date.now() || hold.bootId !== this.bootId || hold.monotonicDeadline <= Number(process.hrtime.bigint()/1_000_000n))) {
      await this.services.restoreWatchdog(hold.original); this.admission.clearHold(); this.admission.audit('watchdog-hold-expired-restored');
    }
  }
}
