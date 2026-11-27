import { RecoveryAdmission } from './RecoveryAdmission.js';
import { installRecoveryServices } from './RecoveryInstallation.js';
import { recoveryHostBootId } from './RecoveryEngine.js';
import { recoveryPoolHealth } from './RecoveryPoolHealth.js';
import { currentRecoveryStatus } from './RecoveryRuntime.js';
/** Connects the phone setup surface to verified local enrollment and paired-machine inventory. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RecoveryEnrollment, type RecoveryEnrollmentAdvert, type RecoveryEnrollmentOptions } from './RecoveryEnrollment.js';
import { loadRecoveryConfig } from './RecoveryEngine.js';
import { recoveryResponseJson } from './RecoveryHttp.js';
import { signRecovery, verifyRecovery, type RecoveryCertificate, type Signed } from './RecoveryProtocol.js';
import type { RecoveryGrantRequest } from '../server/recoverySetupRoutes.js';

export interface RecoverySetupRuntimeOptions extends Omit<RecoveryEnrollmentOptions, 'certificationRoot' | 'relayUrl'> {
  /** Read only the root shipped with the signed installed release, never an HTTP-supplied key. */
  releaseRoot: () => string | null;
  activate:()=>Promise<void>;
  membershipEpochs?:()=>Record<string,number>;
  machineName?:string;
  machineNames?:()=>Record<string,string>;
  peerAdvert: (machineId: string) => Promise<Signed<RecoveryEnrollmentAdvert>>;
}
export class RecoverySetupRuntime {
  private busy = false;
  constructor(private readonly o: RecoverySetupRuntimeOptions) {}
  private authority(): {certificate: Signed<RecoveryCertificate>; relayUrl: string; root: string} {
    const root = this.o.releaseRoot(); if (!root) throw new Error('recovery-release-root-not-installed');
    const file = path.join(this.o.stateDir, 'recovery', 'authority.json'), st=fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode&0o077) || st.size > 16_384) throw new Error('recovery-authority-config-invalid');
    const a=JSON.parse(fs.readFileSync(file,'utf8')) as {certificate:Signed<RecoveryCertificate>;relayUrl:string};
    const cert=a.certificate?.payload, now=Date.now(), url=new URL(a.relayUrl);
    if (!verifyRecovery(a.certificate,root) || cert.domain!=='instar-recovery-certificate-v1' || cert.agentId!==this.o.agentId || cert.issuedAt>now || cert.expiresAt<=now
      || url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('recovery-authority-config-invalid');
    return {...a,root};
  }
  private enrollment(): RecoveryEnrollment {
    const authority=this.authority();
    return new RecoveryEnrollment({...this.o,certificationRoot:authority.root,relayUrl:authority.relayUrl});
  }
  relayOrigin(): string | null { try { return this.authority().relayUrl; } catch { return null; } }
  status(): unknown {
    let reason='ready-for-enrollment';
    try { this.authority(); } catch(error) {
      reason=error instanceof Error && /^recovery-[a-z-]+$/.test(error.message)?error.message:'recovery-authority-setup-required';
    }
    const recovery=currentRecoveryStatus(),pool=recoveryPoolHealth(this.o.machineId,this.o.paired().map(p=>p.machineId),Date.now(),this.o.membershipEpochs?.()),target=pool.targets.find(t=>t.machineId===this.o.machineId);
    const ready=recovery.ready&&target?.ready===true;
    return {state:ready?'ready':('enabled' in recovery&&recovery.enabled)?'degraded':'setup-required',reason:ready?'two-fresh-independent-peer-proofs':reason==='ready-for-enrollment'&&!target?.ready?'target-awaiting-peer-proofs':reason,machineId:this.o.machineId,pairedMachines:this.o.paired().length,recovery,target,pool,
      requiredSteps:['Install the release-certified recovery authority','Enroll your phone with the recovery authority','Approve access for your paired machines','Install and verify both recovery routes'],
      scope:'Fixed recovery actions on this agent only',ready};
  }
  /** Refresh only local main credentials on an already enrolled active host. */
  async refreshOwnedBindings():Promise<void> {
    const manifestFile=path.join(this.o.stateDir,'recovery','runtime.json');if(!fs.existsSync(manifestFile))return;
    const stat=fs.lstatSync(manifestFile);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)||stat.size>1_048_576)throw new Error('recovery-runtime-config-invalid');
    const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    const configFile=path.join(this.o.stateDir,'recovery','host.json');
    if(manifest.agentId!==this.o.agentId||manifest.machineId!==this.o.machineId||manifest.hostConfigFile!==configFile)throw new Error('recovery-runtime-config-invalid');
    const before=fs.readFileSync(configFile,'utf8'),config=loadRecoveryConfig(configFile);
    const admission=new RecoveryAdmission({stateDir:config.stateDir,agentId:config.agentId,machineId:config.machineId,certificationRoot:config.certificationRoot,bootId:await recoveryHostBootId()});
    try{if(!admission.locallyActive()||admission.ownedUpdate())return;}finally{admission.close();}
    await this.enrollment().prepare();
    if(fs.readFileSync(configFile,'utf8')!==before)await installRecoveryServices(loadRecoveryConfig(configFile),configFile,this.o.entrypoint);
  }
  async advert(): Promise<Signed<RecoveryEnrollmentAdvert>> { return (await this.enrollment().prepare()).advert; }
  async prepare(): Promise<unknown> {
    const enrollment=this.enrollment(); await enrollment.prepare();
    return {state:'owner-approval-required',scope:'fixed-recovery-verbs-only',machineId:this.o.machineId};
  }
  private async adverts(enrollment:RecoveryEnrollment):Promise<Signed<RecoveryEnrollmentAdvert>[]> {
    const adverts:Signed<RecoveryEnrollmentAdvert>[]=[];
    // Bounded sequential discovery, authenticated by MeshRpc plus the peer's own
    // MachineAuth signature. A dark/missing peer keeps setup incomplete.
    const paired=this.o.paired(); if (!paired.length) throw new Error('recovery-repair-peer-required');
    for(const peer of paired) {
      const signed=await this.o.peerAdvert(peer.machineId);
      if (enrollment.verifyAdvert(signed).machineId!==peer.machineId) throw new Error('recovery-peer-advert-invalid');
      adverts.push(signed);
    }
    return adverts;
  }
  async grantRequest():Promise<RecoveryGrantRequest> {
    const enrollment=this.enrollment(), own=await enrollment.prepare(), adverts=await this.adverts(enrollment);
    return {action:'grant',agentId:this.o.agentId,machineId:this.o.machineId,machineName:this.o.machineName??'This machine',peerNames:this.o.machineNames?.()??{},publicKey:own.advert.payload.relayPublicKey,
      principals:adverts.map(a=>({machineId:a.payload.machineId,pairingEpoch:this.o.paired().find(p=>p.machineId===a.payload.machineId)!.pairingEpoch,
        generation:a.payload.generation,sshPublicKey:a.payload.sshPublicKey,relayPublicKey:a.payload.relayPublicKey}))};
  }
  async install():Promise<unknown> {
    if(this.busy)throw new Error('recovery-setup-busy');this.busy=true;
    try {
      const enrollment=this.enrollment();await enrollment.prepare();
      const adverts=await this.adverts(enrollment),own=await enrollment.prepare();
      const config=loadRecoveryConfig(path.join(enrollment.directory,'host.json')),now=Date.now();
      const request=signRecovery({domain:'instar-recovery-control-request-v1',agentId:this.o.agentId,machineId:this.o.machineId,action:'checkpoint',nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+30_000,body:{challenge:own.challenge}},config.relayPrivateKey);
      const response=await fetch(new URL('/v1/recovery/checkpoint',config.relayUrl),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(5_000),redirect:'error'});
      if(!response.ok){await response.body?.cancel();throw new Error('recovery-owner-approval-required');}
      const result=await recoveryResponseJson(response);
      const installed=await enrollment.install(result.certificate,result.checkpoint,adverts);
      await this.o.activate();return installed;
    } finally {this.busy=false;}
  }
}
