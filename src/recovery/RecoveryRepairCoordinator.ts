import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
/* @self-action-controller: server-down-recovery-repair */
/** Source repair is fenced by the existing pool lease; target admission owns the cross-source mutation budget. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { RecoveryClient, type RecoveryPeerTarget, type RecoveryProbeEvidence } from './RecoveryClient.js';
import { recoveryDigest, type RecoveryReceipt, type RecoveryRoute, type RecoveryVerb } from './RecoveryProtocol.js';

interface Episode { startedAt:number; attempts:number; nextAt:number; recoveries:number[]; breaks:number[]; cooldownUntil:number; exhausted:boolean; notified:boolean; healthy:boolean; holdPending:boolean; leaseId:string|null; repairEpoch?:number;pauseReason?:string|null;noticeSenderMachineId?:string|null }
export interface RecoveryRepairDependencies {
  stateDir:string;
  /** isRouter() is monotonic-TTL fenced by the existing LeaseCoordinator. */
  lease():{eligible:boolean;epoch:number};
  paired(target:RecoveryPeerTarget):boolean;
  execute?:(target:RecoveryPeerTarget,verb:RecoveryVerb,route:RecoveryRoute,epoch:number)=>Promise<RecoveryReceipt>;
  notify:(key:string,message:string)=>Promise<{operationId:string}>;
  claimEpisode?:(target:RecoveryPeerTarget,route:RecoveryRoute,epoch:number)=>Promise<{leaseId:string;expiresAt:number;notified:boolean;episodeId:string}>;
  claimNotice?:(target:RecoveryPeerTarget,leaseId:string,epoch:number)=>Promise<{claimed:boolean;idempotencyKey?:string;episodeId?:string;noticeSenderMachineId?:string}>;
  pendingNotices?:(target:RecoveryPeerTarget)=>Promise<{pending:Array<{idempotencyKey:string;leaseId:string;sourceLeaseEpoch:number;noticeSenderMachineId:string}>}>;
  ackNotice?:(target:RecoveryPeerTarget,leaseId:string,epoch:number,key:string,operationId:string)=>Promise<unknown>;
  now?:()=>number;
  wait?:(ms:number)=>Promise<void>;
}
interface PendingNotice{key:string;leaseId:string;epoch:number;generation:number;senderMachineId:string;}
export class RecoveryRepairCoordinator {
  private readonly active=new Set<string>();
  constructor(private readonly d:RecoveryRepairDependencies) {}
  private now():number{return (this.d.now??Date.now)();}
  private file(target:RecoveryPeerTarget):string {
    return path.join(this.d.stateDir,'recovery','episodes',recoveryDigest({agent:target.agentId,target:target.targetMachineId,pairing:target.pairingEpoch})+'.json');
  }
  private read(target:RecoveryPeerTarget):Episode {
    try {
      const file=this.file(target),st=fs.lstatSync(file);
      if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid?.()||st.size>8192)throw new Error('recovery-episode-storage-invalid');
      const e=JSON.parse(fs.readFileSync(file,'utf8')) as Episode;
      if(!Number.isSafeInteger(e.startedAt)||!Number.isSafeInteger(e.attempts)||e.attempts<0||e.attempts>4||!Number.isSafeInteger(e.nextAt)||!Array.isArray(e.recoveries)||e.recoveries.length>8||e.recoveries.some(x=>!Number.isSafeInteger(x))||!Array.isArray(e.breaks)||e.breaks.length>8||e.breaks.some(x=>!Number.isSafeInteger(x))||!Number.isSafeInteger(e.cooldownUntil)||typeof e.exhausted!=='boolean'||typeof e.notified!=='boolean'||typeof e.healthy!=='boolean'||typeof e.holdPending!=='boolean'||(e.leaseId!==null&&typeof e.leaseId!=='string'))throw new Error('recovery-episode-storage-invalid');
      return e;
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      return {startedAt:this.now(),attempts:0,nextAt:0,recoveries:[],breaks:[],cooldownUntil:0,exhausted:false,notified:false,healthy:false,holdPending:false,leaseId:null,repairEpoch:0};
    }
  }
  private write(target:RecoveryPeerTarget,e:Episode):void {
    const file=this.file(target),dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid?.())throw new Error('recovery-episode-storage-invalid');
    const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(e),{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);
  }
  private permitted(target:RecoveryPeerTarget,epoch:number):boolean {
    const lease=this.d.lease();return this.d.paired(target)&&lease.eligible&&lease.epoch===epoch&&epoch>0;
  }
  private async execute(target:RecoveryPeerTarget,verb:RecoveryVerb,route:RecoveryRoute,epoch:number):Promise<RecoveryReceipt> {
    if(!this.permitted(target,epoch))throw new Error('recovery-source-fence-lost');
    return this.d.execute?this.d.execute(target,verb,route,epoch):new RecoveryClient(target).execute(verb,route,epoch);
  }
  private notices(target:RecoveryPeerTarget):PendingNotice[]{
    const file=this.file(target)+'.notices';
    try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>65536)throw new Error('recovery-notice-storage-invalid');const rows=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(rows)||rows.length>8||rows.some(r=>typeof r.key!=='string'||r.key.length>128||typeof r.leaseId!=='string'||!Number.isSafeInteger(r.epoch)||!Number.isSafeInteger(r.generation)||r.senderMachineId!==target.sourceMachineId))throw new Error('recovery-notice-storage-invalid');return rows;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  }
  private saveNotices(target:RecoveryPeerTarget,rows:PendingNotice[]):void{
    const file=this.file(target)+'.notices';fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(rows),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);
  }
  /** Original immutable sender retries its own stable intent, even as a standby. */
  async retryPending(target:RecoveryPeerTarget):Promise<void>{
    if(!this.d.paired(target))return;
    try {
      const remote=await (this.d.pendingNotices?this.d.pendingNotices(target):new RecoveryClient(target).pendingRepairNotices());
      if(!Array.isArray(remote.pending)||remote.pending.length>8)throw new Error('recovery-notice-query-invalid');
      const records=this.notices(target);
      for(const row of remote.pending){
        if(row.noticeSenderMachineId!==target.sourceMachineId||!/^recovery-notice-[a-f0-9]{64}$/.test(row.idempotencyKey)||typeof row.leaseId!=='string'||row.leaseId.length>128||!Number.isSafeInteger(row.sourceLeaseEpoch)||row.sourceLeaseEpoch<1)throw new Error('recovery-notice-query-invalid');
        if(!records.some(n=>n.key===row.idempotencyKey)){if(records.length>=8)throw new Error('recovery-notice-capacity');records.push({key:row.idempotencyKey,leaseId:row.leaseId,epoch:row.sourceLeaseEpoch,generation:target.generation,senderMachineId:target.sourceMachineId});}
      }
      if(records.length)this.saveNotices(target,records);
    } catch { /* An unavailable query cannot erase an already durable local notice intent. */ }
    for(const notice of this.notices(target)){
      if(notice.generation!==target.generation||!this.d.paired(target))continue;
      const accepted=await this.d.notify(notice.key,'A recovery episode needed attention. Open Recovery for current status.');
      if(!accepted?.operationId)continue;
      if(this.d.ackNotice)await this.d.ackNotice(target,notice.leaseId,notice.epoch,notice.key,accepted.operationId);
      else await new RecoveryClient(target).acknowledgeRepairNotice(notice.leaseId,notice.epoch,notice.key,accepted.operationId);
      this.saveNotices(target,this.notices(target).filter(n=>n.key!==notice.key));
    }
  }
  private async deliverNotice(target:RecoveryPeerTarget,leaseId:string,epoch:number,notice:{claimed:boolean;idempotencyKey?:string;noticeSenderMachineId?:string}):Promise<boolean> {
    if(!notice.claimed||!notice.idempotencyKey||notice.noticeSenderMachineId&&notice.noticeSenderMachineId!==target.sourceMachineId)return false;
    const pending=this.notices(target);if(!pending.some(n=>n.key===notice.idempotencyKey)){if(pending.length>=8)throw new Error('recovery-notice-capacity');pending.push({key:notice.idempotencyKey,leaseId,epoch,generation:target.generation,senderMachineId:target.sourceMachineId});this.saveNotices(target,pending);}
    await this.retryPending(target);
    return !this.notices(target).some(n=>n.key===notice.idempotencyKey);
  }
  async routeRestored(target:RecoveryPeerTarget,route:RecoveryRoute,evidence:RecoveryProbeEvidence):Promise<void> {
    const file=this.file(target)+'.route-'+route,lease=this.d.lease();
    if(!fs.existsSync(file)||!this.permitted(target,lease.epoch))return;
    const client=new RecoveryClient(target),episode=await client.claimRepairEpisode(route,lease.epoch,'recovery-route-unavailable');
    if(!this.permitted(target,lease.epoch))return;
    await client.resolveRepairEpisode(episode.leaseId,lease.epoch,evidence);
    SafeFsExecutor.safeUnlinkSync(file,{operation:'recovery-route-loss:resolved-owned-episode'});
  }
  async routeLost(target:RecoveryPeerTarget,route:RecoveryRoute,security:boolean):Promise<void> {
    const lease=this.d.lease();if(!this.permitted(target,lease.epoch))return;
    const activeOutage=this.read(target);if(!security&&!activeOutage.healthy&&activeOutage.attempts>0)return;
    const file=this.file(target)+'.route-'+route,dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    let firstAt=this.now();
    try {const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid?.()||st.size>8192)return;firstAt=Number(JSON.parse(fs.readFileSync(file,'utf8')).firstAt);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return;fs.writeFileSync(file,JSON.stringify({firstAt}),{mode:0o600,flag:'wx'});}
    if(!Number.isSafeInteger(firstAt)||(!security&&this.now()-firstAt<30_000))return;
    try {
      const client=new RecoveryClient(target),episode=await client.claimRepairEpisode(route,lease.epoch,'recovery-route-unavailable');
      if(!this.permitted(target,lease.epoch))return;
      const notice=await client.claimRepairNotice(episode.leaseId,lease.epoch);
      const observed=this.read(target);observed.noticeSenderMachineId=notice.noticeSenderMachineId??null;this.write(target,observed);
      if(this.permitted(target,lease.epoch))await this.deliverNotice(target,episode.leaseId,lease.epoch,notice);
    } catch { /* No durable shared notice claim: retain route-loss evidence and report it in pool status. */ }
  }
  status(target:RecoveryPeerTarget):{attempts:number;state:string;nextAttemptAt:number;watchdogHoldPending:boolean;notice?:{state:string;senderMachineId:string|null}} {
    try {
      const e=this.read(target);
      return {attempts:e.attempts,state:e.pauseReason?e.pauseReason==='target-repair-owner-retry-required'?'exhausted':e.pauseReason==='target-repair-cooling-down'?'cooling-down':e.pauseReason.startsWith('main-')?'main-binding-inspection-required':'paused-by-target-intent':e.healthy&&e.leaseId?'pool-resolution-pending':e.exhausted?'exhausted':e.cooldownUntil>this.now()?'cooling-down':e.healthy?'healthy':!e.notified&&e.attempts>=4?'attention-pending':'observing',nextAttemptAt:Math.max(e.nextAt,e.cooldownUntil),watchdogHoldPending:e.holdPending,notice:{state:this.notices(target).length||e.noticeSenderMachineId&&!e.notified?'delivery-pending':e.notified?'durably-accepted':'unclaimed',senderMachineId:this.notices(target)[0]?.senderMachineId??e.noticeSenderMachineId??null}};
    } catch { return {attempts:0,state:'storage-unavailable',nextAttemptAt:0,watchdogHoldPending:false}; }
  }
  /** Called only with a cryptographically verified status response from the target. */
  async observe(target:RecoveryPeerTarget,route:RecoveryRoute,serverHealthy:boolean,evidence?:RecoveryProbeEvidence):Promise<void> {
    const key=this.file(target),lease=this.d.lease();
    if(!lease.eligible||!this.d.paired(target)||this.active.has(key))return;
    this.active.add(key);
    try {
      let e=this.read(target);const now=this.now();
      const repairEpoch=evidence?.response.payload.detail.repairEpoch;
      if(Number.isSafeInteger(repairEpoch)&&Number(repairEpoch)>(e.repairEpoch??0)){
        e={startedAt:now,attempts:0,nextAt:0,recoveries:[],breaks:[],cooldownUntil:0,exhausted:false,notified:false,healthy:false,holdPending:e.holdPending,leaseId:null,repairEpoch:Number(repairEpoch)};
        this.write(target,e);
      }
      if(evidence?.response.payload.detail.repairSuppressed===true){e.pauseReason=String(evidence.response.payload.detail.repairSuppressionReason??'intent-state-unavailable');this.write(target,e);return;}
      if(evidence?.response.payload.detail.repairBudgetAvailable===false){
        e.pauseReason=evidence.response.payload.detail.repairBudgetExhausted===true?'target-repair-owner-retry-required':'target-repair-cooling-down';
        if(evidence.response.payload.detail.repairBudgetExhausted===true)e.exhausted=true;
        this.write(target,e);
        try{const episode=await (this.d.claimEpisode?this.d.claimEpisode(target,route,lease.epoch):new RecoveryClient(target).claimRepairEpisode(route,lease.epoch));const notice=await(this.d.claimNotice?this.d.claimNotice(target,episode.leaseId,lease.epoch):new RecoveryClient(target).claimRepairNotice(episode.leaseId,lease.epoch));if(this.permitted(target,lease.epoch))await this.deliverNotice(target,episode.leaseId,lease.epoch,notice);}catch{/* A blocked target stays visible; no unclaimed notice or mutation is attempted. */}
        return;
      }
      if(e.pauseReason==='target-repair-cooling-down'){e.startedAt=now;e.attempts=0;e.nextAt=0;}
      e.pauseReason=null;
      let episode:{leaseId:string;expiresAt:number;notified:boolean;episodeId:string}|null=null;
      if(!serverHealthy) {
        try { episode=await (this.d.claimEpisode?this.d.claimEpisode(target,route,lease.epoch):new RecoveryClient(target).claimRepairEpisode(route,lease.epoch)); }
        catch(error) {
          // An authoritative lease/principal refusal is never treated as a
          // transport partition. Only an unavailable control plane permits the
          // existing router + target-local budget fallback.
          if(error instanceof Error&&/^recovery-/.test(error.message)&&error.message!=='recovery-relay-request-failed')return;
        }
        if(!this.permitted(target,lease.epoch))return;
      }
      if(episode){e.leaseId=episode.leaseId;e.noticeSenderMachineId=(episode as {noticeSenderMachineId?:string|null}).noticeSenderMachineId??null;}
      if(serverHealthy) {
        if(evidence&&e.leaseId&&this.permitted(target,lease.epoch)) {
          try {
            const renewed=await new RecoveryClient(target).claimRepairEpisode(route,lease.epoch);
            await new RecoveryClient(target).resolveRepairEpisode(renewed.leaseId,lease.epoch,evidence);
            e.leaseId=null;
          } catch { /* A pending pool resolution stays explicit until a fresh proof can resolve it. */ }
        }
        if(e.holdPending&&this.permitted(target,lease.epoch)) {
          await (this.d.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(2_000);
          const stable=await this.execute(target,'status',route,lease.epoch);
          if(stable.result!=='ok'||stable.detail.serverHealthy!==true)return;
          const restored=await this.execute(target,'restore',route,lease.epoch);
          if(restored.result==='ok')e.holdPending=false;
        }
        if(!e.healthy){e.healthy=true;e.recoveries=e.recoveries.filter(t=>now-t<3_600_000);if(e.attempts>0)e.recoveries.push(now);this.write(target,e);}
        return;
      }
      if(e.healthy){e.healthy=false;e.startedAt=now;e.attempts=0;e.nextAt=0;e.notified=false;}
      e.recoveries=e.recoveries.filter(t=>now-t<3_600_000);
      if(e.recoveries.length>=2)e.exhausted=true;
      if(e.cooldownUntil>now)return;
      if(e.cooldownUntil) { e.cooldownUntil=0;e.startedAt=now;e.attempts=0; }
      if(e.exhausted||e.attempts>=4||now-e.startedAt>120_000) {
        if(!e.exhausted) {
          e.breaks=e.breaks.filter(t=>now-t<3_600_000);e.breaks.push(now);
          e.exhausted=e.breaks.length>=2;e.cooldownUntil=now+15*60_000;
        }
        if(!e.notified&&this.permitted(target,lease.epoch)) {
          let accepted=episode?.notified===true;
          if(!accepted&&episode&&episode.expiresAt>this.now()) {
            try {
              const notice=await (this.d.claimNotice?this.d.claimNotice(target,episode.leaseId,lease.epoch):new RecoveryClient(target).claimRepairNotice(episode.leaseId,lease.epoch));
              if(notice.noticeSenderMachineId)e.noticeSenderMachineId=notice.noticeSenderMachineId;
              if(this.permitted(target,lease.epoch))accepted=await this.deliverNotice(target,episode.leaseId,lease.epoch,notice);
            } catch { /* Pending reservation and stable logical ID survive retry/handoff. */ }
          }
          e.notified=accepted;this.write(target,e);
        } else this.write(target,e);
        return;
      }
      if(now<e.nextAt)return;
      e.attempts++;e.nextAt=now+([1_000,2_000,4_000,15*60_000][e.attempts-1]);this.write(target,e);
      // Diagnose before the first mutation. An unidentified or external watchdog
      // is never paused; a separate exact-owned hold path requires kill evidence.
      const diagnostics=await this.execute(target,'collect-diagnostics',route,lease.epoch);
      if(diagnostics.result!=='ok'||typeof diagnostics.detail.serverHealthy!=='boolean')return;
      if(diagnostics.detail.repairSuppressed===true){e.pauseReason=String(diagnostics.detail.repairSuppressionReason??'intent-state-unavailable');this.write(target,e);return;}
      if(diagnostics.detail.serverHealthy)return;
      if(diagnostics.detail.ownedWatchdogRecentMutation===true&&!e.holdPending) {
        const hold=await this.execute(target,'hold-owned-instar-watchdog',route,lease.epoch);
        if(hold.result!=='ok')return;e.holdPending=true;this.write(target,e);
      }
      const started=await this.execute(target,'start-instar-server',route,lease.epoch);
      if(started.result!=='ok')return;
      // A kickstart ACK is not health. Recheck through the same independently
      // authenticated route after bounded settling time, with lease checks on
      // both sides of the await. Recursive re-entry remains under the same
      // durable episode budget; it cannot create a new attempt allowance.
      const delay=e.attempts<4?[1_000,2_000,4_000][e.attempts-1]:0;
      if(delay)await (this.d.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(delay);
      if(!this.permitted(target,lease.epoch))return;
      const status=await this.execute(target,'status',route,lease.epoch);
      if(status.result!=='ok'||typeof status.detail.serverHealthy!=='boolean')return;
      this.active.delete(key);
      await this.observe(target,route,status.detail.serverHealthy);
    } finally {this.active.delete(key);}
  }
}
