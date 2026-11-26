/** Shared durable admission and operation fencing for BOTH recovery listeners. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {registerSqliteHandle} from '../core/SqliteRegistry.js';
import { processStartMs } from '../core/processIdentity.js';
import {
  OFFLINE_LEASE_MS, recoveryCanonical, recoveryDigest, validRecoveryId, validRecoveryTime,
  validateRecoveryEnvelope, verifyRecovery, validateRecoveryPrincipals, recoveryKeyFingerprint,
  type RecoveryCertificate, type RecoveryCheckpoint, type RecoveryDiscovery, type RecoveryEnvelope, type RecoveryRoute, type Signed,
} from './RecoveryProtocol.js';

export interface RecoveryWatchdogPolicy {
  label:string;plist:string;ownershipDigest:string;
  kind?:'agent-rule';script?:string;scriptDigest?:string;targetLabel?:string;holdFile?:string;eventsFile?:string;entrypoint?:string;
}
export interface RecoveryWatchdogHold {
  deadline:number; monotonicDeadline:number; bootId:string;
  original:RecoveryWatchdogPolicy;
}
export class RecoveryAdmission {
  private readonly db: Database.Database;
  private readonly unregisterSqlite:()=>void;
  private readonly ownProcessStart:number|null;
  constructor(private readonly options: {
    stateDir: string; agentId: string; machineId: string; bootId: string; certificationRoot: string;
    now?: () => number; uptime?: () => number; processStart?: (pid:number)=>number|null;
  }) {
    this.ownProcessStart=(options.processStart??processStartMs)(process.pid);
    fs.mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(options.stateDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw new Error('recovery-state-ownership-invalid');
    const database = path.join(options.stateDir, 'recovery-admission.db');
    for (const file of [database, database+'-wal', database+'-shm']) {
      if (!fs.existsSync(file)) {
        try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('recovery-state-ownership-invalid'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        continue;
      }
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077)) throw new Error('recovery-state-ownership-invalid');
    }
    const fd = fs.openSync(database, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
    this.db = new Database(database);
    this.unregisterSqlite=registerSqliteHandle(()=>this.close());
    try{
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, nonce TEXT UNIQUE NOT NULL, digest TEXT NOT NULL,
        source TEXT NOT NULL, expires INTEGER NOT NULL, admitted_at INTEGER NOT NULL, epoch INTEGER NOT NULL, mutation INTEGER NOT NULL, owner_pid INTEGER NOT NULL, owner_boot TEXT NOT NULL, owner_start INTEGER, state TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS audits (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL, source TEXT, operation TEXT, reason TEXT);
    `);
    const columns=this.db.prepare('PRAGMA table_info(operations)').all() as Array<{name:string}>;
    if(!columns.some(c=>c.name==='owner_start'))this.db.exec('ALTER TABLE operations ADD COLUMN owner_start INTEGER');
    if(!columns.some(c=>c.name==='admitted_at')) this.db.transaction(()=>{
      this.db.exec('ALTER TABLE operations ADD COLUMN admitted_at INTEGER NOT NULL DEFAULT 0');
      this.db.exec('UPDATE operations SET admitted_at = expires - 30000 WHERE admitted_at = 0');
    })();
    }catch(error){this.close();throw error;}
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private uptime(): number { return (this.options.uptime ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))(); }
  private read<T>(name: string): T | null {
    const row = this.db.prepare('SELECT value FROM state WHERE name = ?').get(name) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }
  private write(name: string, value: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO state (name,value) VALUES (?,?)').run(name, recoveryCanonical(value));
  }
  /** Target creates a one-time challenge; a peer can carry it but cannot issue its checkpoint. */
  challenge(): string {
    return this.db.transaction(()=>{
      const nonce=crypto.randomBytes(32).toString('hex');
      const pending=(this.read<Array<{nonce:string;expiresAt:number}>>('challenges')??[]).filter(c=>c.expiresAt>=this.now()).slice(-15);
      pending.push({nonce,expiresAt:this.now()+60_000});this.write('challenges',pending);return nonce;
    }).immediate();
  }
  acceptCheckpoint(certificate: Signed<RecoveryCertificate>, checkpoint: Signed<RecoveryCheckpoint>): void {
    this.db.transaction(() => {
      const c = certificate.payload; const p = checkpoint.payload; const now = this.now();
      const pending=this.read<Array<{nonce:string;expiresAt:number}>>('challenges')??[];
      const legacy=this.read<{nonce:string;expiresAt:number}>('challenge');
      const challenge=pending.find(c=>c.nonce===p?.challenge)??(legacy?.nonce===p?.challenge?legacy:null);
      const prior = this.read<Signed<RecoveryCheckpoint>>('checkpoint')?.payload;
      const priorCert = this.read<Signed<RecoveryCertificate>>('certificate')?.payload;
      if (c?.domain !== 'instar-recovery-certificate-v1' || c.agentId !== this.options.agentId
        || !Number.isSafeInteger(c.generation) || c.generation < (priorCert?.generation ?? 1)
        || !validRecoveryTime(c.issuedAt, c.expiresAt, now, 366 * OFFLINE_LEASE_MS)
        || (priorCert && c.generation === priorCert.generation && recoveryKeyFingerprint(c.publicKey) !== recoveryKeyFingerprint(priorCert.publicKey))
        || !verifyRecovery(certificate, this.options.certificationRoot)) throw new Error('recovery-certificate-invalid');
      if (p?.domain !== 'instar-recovery-checkpoint-v1' || p.agentId !== this.options.agentId || p.targetMachineId !== this.options.machineId
        || !challenge || challenge.expiresAt < now || p.challenge !== challenge.nonce
        || !Number.isSafeInteger(p.version) || p.version <= (prior?.version ?? 0)
        || (prior && p.issuedAt < prior.issuedAt) || Math.abs(now - p.issuedAt) > 30_000
        || !validRecoveryTime(p.issuedAt, p.expiresAt, now, OFFLINE_LEASE_MS) || p.expiresAt > c.expiresAt
        || !Array.isArray(p.principals) || p.principals.length > 128 || !Array.isArray(p.revoked) || p.revoked.length > 1024
        || !verifyRecovery(checkpoint, c.publicKey)) throw new Error('recovery-checkpoint-invalid');
      validateRecoveryPrincipals(p.principals,p.revoked);
      if(!Number.isSafeInteger(p.repairEpoch??0)||(p.repairEpoch??0)<(prior?.repairEpoch??0)||(p.repairEpoch??0)<0)throw new Error('recovery-repair-epoch-invalid');
      if(p.disabledRoutes!==undefined&&(!Array.isArray(p.disabledRoutes)||p.disabledRoutes.length>2||new Set(p.disabledRoutes).size!==p.disabledRoutes.length
        ||p.disabledRoutes.some(route=>route!=='ssh'&&route!=='relay')))throw new Error('recovery-checkpoint-invalid');
      // Revoke tombstones cannot disappear from a later checkpoint.
      if (prior?.revoked.some(id => !p.revoked.includes(id))) throw new Error('recovery-revocation-rollback');
      this.write('certificate', certificate); this.write('checkpoint', checkpoint); this.write('challenge', null);this.write('challenges',pending.filter(c=>c.nonce!==p.challenge&&c.expiresAt>=now));
      this.write('clock', { wall: now, uptime: this.uptime(), deadline: this.uptime() + p.expiresAt - now, boot: this.options.bootId, expired: false });
      this.audit('checkpoint-accepted', undefined, undefined, String(p.version));
    })();
  }
  /** Clock rollback/reboot uncertainty expires the lease until a fresh signed checkpoint. */
  lease(options:{allowDeactivated?:true}={}): { ready: boolean; version: number; expiresAt: number } {
    return this.db.transaction(() => {
      const p = this.read<Signed<RecoveryCheckpoint>>('checkpoint')?.payload;
      const clock = this.read<{ wall: number; uptime: number; deadline: number; boot: string; expired: boolean }>('clock');
      const wall = this.now(); const uptime = this.uptime();
      const elapsed = clock ? uptime - clock.uptime : -1;
      const uncertain = !clock || clock.expired || clock.boot !== this.options.bootId || elapsed < 0 || wall < clock.wall
        || Math.abs((wall - clock.wall) - elapsed) > 30_000;
      const expired = uncertain || !p || wall >= p.expiresAt || uptime >= (clock?.deadline ?? 0);
      if (clock && expired && !clock.expired) this.write('clock', {...clock, expired:true});
      return { ready: !expired && (options.allowDeactivated===true||this.locallyActive()), version: p?.version ?? 0, expiresAt: p?.expiresAt ?? 0 };
    })();
  }
  verifyDiscovery(signed: Signed<RecoveryDiscovery>, transport:RecoveryRoute, options:{checkpointCarryOnly?:boolean}={}): void {
    if(!this.locallyActive())throw new Error('recovery-locally-deactivated');
    if(!options.checkpointCarryOnly&&this.ownedUpdate())throw new Error('recovery-owned-update-in-progress');
    const p=signed?.payload;
    if (!p || p.domain!=='instar-recovery-discovery-v1' || p.agentId!==this.options.agentId || p.targetMachineId!==this.options.machineId
      || p.route!==transport || !/^[a-f0-9]{64}$/.test(p.nonce) || !validRecoveryTime(p.issuedAt,p.expiresAt,this.now(),30_000)
      || (!options.checkpointCarryOnly&&!this.lease().ready)) throw new Error('recovery-discovery-refused');
    // A previously admitted peer may carry an authority-signed checkpoint even
    // after expiry. This grants no operation: the fresh checkpoint can revoke it.
    const checkpoint=this.read<Signed<RecoveryCheckpoint>>('checkpoint')?.payload;
    if(!checkpoint)throw new Error('recovery-principal-refused');
    if(checkpoint.disabledRoutes?.includes(transport))throw new Error('recovery-route-disabled');
    const source=checkpoint.principals.find(x=>x.machineId===p.sourceMachineId);
    if (!source || checkpoint.revoked.includes(p.sourceMachineId) || source.pairingEpoch!==p.pairingEpoch || source.generation!==p.generation
      || !verifyRecovery(signed,transport==='ssh'?source.sshPublicKey:source.relayPublicKey)) throw new Error('recovery-principal-refused');
  }
  admit(signed: Signed<RecoveryEnvelope>, transport: RecoveryRoute): { state: 'new' | 'repeat'; receipt: unknown } {
    const lease = this.lease(); // persist clock uncertainty even when admission is refused
    const outcome = this.db.transaction(() => {
      if(this.ownedUpdate())throw new Error('recovery-owned-update-in-progress');
      if(!this.locallyActive())throw new Error('recovery-locally-deactivated');
      const e = signed.payload; const now = this.now();
      if (!validateRecoveryEnvelope(e, now) || e.agentId !== this.options.agentId || e.targetMachineId !== this.options.machineId
        || e.targetBootId !== this.options.bootId || e.route !== transport || !lease.ready) throw new Error('recovery-admission-refused');
      const p = this.read<Signed<RecoveryCheckpoint>>('checkpoint')!.payload;
      if(p.disabledRoutes?.includes(transport))throw new Error('recovery-route-disabled');
      const principal = p.principals.find(x => x.machineId === e.sourceMachineId);
      if (!principal || p.revoked.includes(e.sourceMachineId) || principal.pairingEpoch !== e.pairingEpoch || principal.generation !== e.generation
        || !verifyRecovery(signed, transport === 'ssh' ? principal.sshPublicKey : principal.relayPublicKey)) throw new Error('recovery-principal-refused');
      const digest = recoveryDigest(e);
      const prior = this.db.prepare('SELECT * FROM operations WHERE id = ? OR nonce = ?').get(e.operationId, e.nonce) as { digest: string; state: string; receipt: string | null } | undefined;
      if (prior) {
        if (prior.digest !== digest) throw new Error('recovery-operation-rebound');
        return { state: 'repeat' as const, receipt: prior.receipt ? JSON.parse(prior.receipt) : null };
      }
      const mutation=!['status','collect-diagnostics'].includes(e.verb);
      if(mutation&&this.watchdogRuleOwner())throw new Error('recovery-owned-watchdog-busy');
      if(mutation&&this.ownProcessStart===null)throw new Error('recovery-process-identity-unavailable');
      const running=this.db.prepare("SELECT id, owner_pid, owner_boot, owner_start, admitted_at, mutation, expires FROM operations WHERE state = 'running'").all() as Array<{id:string;owner_pid:number;owner_boot:string;owner_start:number|null;admitted_at:number;mutation:number;expires:number}>;
      for (const row of running) {
        // A timed-out read has no host mutation to race. Mutating owners are
        // never unlocked by time alone, even when process birth is unreadable.
        let dead=row.owner_boot !== this.options.bootId||(row.mutation===0&&row.expires<now);
        if (!dead) { try { process.kill(row.owner_pid,0); } catch(error) { dead=(error as NodeJS.ErrnoException).code==='ESRCH'; } }
        if(!dead){
          const liveStart=row.owner_pid===process.pid?this.ownProcessStart:(this.options.processStart??processStartMs)(row.owner_pid);
          // A live recycled PID is not the operation owner. Unknown process birth
          // keeps the lock closed; elapsed time alone never unlocks a mutation.
          dead=liveStart!==null&&(row.owner_start!==null?liveStart!==row.owner_start:liveStart>row.admitted_at+2000);
        }
        if (!dead) throw new Error('recovery-operation-busy');
        this.db.prepare("UPDATE operations SET state='uncertain' WHERE id=? AND state='running'").run(row.id);
      }
      if (!['status','collect-diagnostics'].includes(e.verb) && this.db.prepare("SELECT 1 FROM operations WHERE state='uncertain' AND mutation=1 LIMIT 1").get()) throw new Error('recovery-inspection-required');
      const fence = this.read<number>('fencing-epoch') ?? 0;
      if (e.fencingEpoch <= fence) throw new Error('recovery-fence-stale');
      if (!['status', 'collect-diagnostics', 'restore'].includes(e.verb)) {
        // Persist refusal transitions by returning them from the transaction;
        // throwing here would roll back the breaker that protects the target.
        const cause = recoveryDigest({principals:p.principals,repairEpoch:p.repairEpoch??0});
        let budget = this.read<{cause:string;cooldownUntil:number;cycles:number[];exhausted:boolean;startFence?:number}>('mutation-budget');
        if (!budget || budget.cause !== cause) {
          budget = {cause,cooldownUntil:0,cycles:[],exhausted:false,startFence:fence};
          this.write('mutation-budget',budget);
        }
        if (budget.exhausted) return {error:'recovery-episode-exhausted'};
        if (budget.cooldownUntil > now) return {error:'recovery-breaker-open'};
        const mutations = this.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE admitted_at > ? AND mutation = 1 AND epoch > ?").get(now - 120_000,budget.startFence??0) as { count: number };
        if (mutations.count >= 4) {
          budget.cycles = [...budget.cycles.filter(at=>at>now-60*60_000),now];
          budget.cooldownUntil = now+15*60_000;
          budget.exhausted = budget.cycles.length >= 2;
          this.write('mutation-budget',budget);
          this.audit('mutation-breaker-open',e.sourceMachineId,e.operationId);
          return {error:'recovery-attempts-exhausted'};
        }
      }
      this.db.prepare('INSERT INTO operations (id,nonce,digest,source,expires,admitted_at,epoch,mutation,owner_pid,owner_boot,owner_start,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(e.operationId,e.nonce,digest,e.sourceMachineId,e.expiresAt,now,e.fencingEpoch,['status','collect-diagnostics'].includes(e.verb) ? 0 : 1,process.pid,this.options.bootId,this.ownProcessStart,'running');
      this.write('fencing-epoch', e.fencingEpoch);
      this.db.prepare("DELETE FROM operations WHERE expires < ? AND state = 'done'").run(now - 120_000);
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number };
      if (count.count > 10000) throw new Error('recovery-operation-store-full');
      this.audit('operation-admitted',e.sourceMachineId,e.operationId,e.verb);
      return { state: 'new' as const, receipt: null };
    })();
    if ('error' in outcome) throw new Error(outcome.error);
    return outcome;
  }
  complete(id: string, receipt: unknown): void {
    this.db.prepare("UPDATE operations SET state = 'done', receipt = ? WHERE id = ? AND state = 'running'").run(recoveryCanonical(receipt),id);
    const row=this.db.prepare('SELECT mutation FROM operations WHERE id=?').get(id) as {mutation:number}|undefined;
    if(row?.mutation===0) this.db.prepare("UPDATE operations SET state='inspected' WHERE state='uncertain'").run();
    this.audit('operation-complete', undefined, id);
  }
  audit(event: string, source?: string, operation?: string, reason?: string): void {
    this.db.prepare('INSERT INTO audits (at,event,source,operation,reason) VALUES (?,?,?,?,?)').run(this.now(),event,source ?? null,operation ?? null,reason ?? null);
    this.db.prepare('DELETE FROM audits WHERE id < (SELECT COALESCE(MAX(id),0) - 10000 FROM audits)').run();
  }
  /** The owned watchdog checks admission under the same writer lock as repairs.
   * Its bounded synchronous stop must not race a hold/start admission. */
  runOwnedWatchdogRuleStop<T>(fn:()=>T,ownerPid?:number):T|null {
    return this.db.transaction(()=>{
      if(this.ownedUpdate())return null;
      const owner=this.watchdogRuleOwner();if(owner&&owner.pid!==ownerPid)return null;
      const hold=this.hold();
      const activeHold=hold&&hold.bootId===this.options.bootId&&hold.deadline>this.now()&&hold.monotonicDeadline>this.uptime();
      if(activeHold||this.hasRunningMutation())return null;
      return fn();
    }).immediate();
  }
  beginHold(hold: RecoveryWatchdogHold): void {
    const prior = this.holdDeadline();
    if (prior) throw new Error('recovery-watchdog-hold-already-active');
    this.write('watchdog-hold', hold);
  }
  hold(): RecoveryWatchdogHold | null { return this.read<RecoveryWatchdogHold>('watchdog-hold'); }
  fencingEpoch():number {return this.read<number>('fencing-epoch')??0;}
  watchdogRuleOwner():{pid:number;birth:number;bootId:string}|null {
    const owner=this.read<{pid:number;birth:number;bootId:string}>('watchdog-rule-owner');if(!owner)return null;
    let dead=owner.bootId!==this.options.bootId;
    if(!dead){try{process.kill(owner.pid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}}
    if(!dead){const birth=(this.options.processStart??processStartMs)(owner.pid);dead=birth!==null&&birth!==owner.birth;}
    if(dead){this.write('watchdog-rule-owner',null);return null;}return owner;
  }
  beginWatchdogRule(ownerPid:number):boolean {
    return this.db.transaction(()=>{
      const birth=(this.options.processStart??processStartMs)(ownerPid);
      if(!Number.isSafeInteger(ownerPid)||ownerPid<2||birth===null)throw new Error('recovery-watchdog-owner-unverifiable');
      if(this.ownedUpdate()||this.hasRunningMutation())return false;
      const hold=this.hold();if(hold&&hold.bootId===this.options.bootId&&hold.deadline>this.now()&&hold.monotonicDeadline>this.uptime())return false;
      const owner=this.watchdogRuleOwner();if(owner&&(owner.pid!==ownerPid||owner.birth!==birth))return false;
      this.write('watchdog-rule-owner',{pid:ownerPid,birth,bootId:this.options.bootId});return true;
    }).immediate();
  }
  endWatchdogRule(ownerPid:number):boolean {
    return this.db.transaction(()=>{const owner=this.watchdogRuleOwner();if(!owner)return true;if(owner.pid!==ownerPid)return false;const birth=(this.options.processStart??processStartMs)(ownerPid);if(birth!==owner.birth)return false;this.write('watchdog-rule-owner',null);return true;}).immediate();
  }
  ownedUpdate():{digest:string;pid:number;birth:number;bootId:string;released?:boolean}|null{return this.read('owned-update');}
  beginOwnedUpdate(digest:string,owner:{pid:number;birth:number;bootId:string}):void {
    this.db.transaction(()=>{
      if(!/^[a-f0-9]{64}$/.test(digest)||!Number.isSafeInteger(owner.pid)||owner.pid<1||!Number.isFinite(owner.birth)||!validRecoveryId(owner.bootId))throw new Error('recovery-update-owner-invalid');
      const prior=this.ownedUpdate();
      if(prior&&prior.digest!==digest)throw new Error('recovery-update-operation-busy');
      if(prior&&(prior.pid!==owner.pid||prior.birth!==owner.birth)){
        let dead=prior.released===true||prior.bootId!==this.options.bootId;
        if(!dead){try{process.kill(prior.pid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}}
        if(!dead){const birth=(this.options.processStart??processStartMs)(prior.pid);dead=birth!==null&&birth!==prior.birth;}
        if(!dead)throw new Error('recovery-update-operation-busy');
      }
      if(this.hasRunningMutation()||this.watchdogRuleOwner())throw new Error('recovery-update-operation-busy');
      this.write('owned-update',{digest,...owner});
    }).immediate();
  }
  releaseOwnedUpdate(digest:string,owner:{pid:number;birth:number}):void {
    this.db.transaction(()=>{
      const prior=this.ownedUpdate();if(!prior)return;
      if(prior.digest!==digest||prior.pid!==owner.pid||prior.birth!==owner.birth)throw new Error('recovery-update-owner-invalid');
      this.write('owned-update',{...prior,released:true});
    }).immediate();
  }
  finishOwnedUpdate(digest:string,owner?:{pid:number;birth:number}):void {
    this.db.transaction(()=>{const prior=this.ownedUpdate();
      if(prior&&(prior.digest!==digest||(owner&&(prior.pid!==owner.pid||prior.birth!==owner.birth))))throw new Error('recovery-update-owner-invalid');
      this.write('owned-update',null);
    }).immediate();
  }
  repairEpoch():number {return this.read<Signed<RecoveryCheckpoint>>('checkpoint')?.payload.repairEpoch??0;}
  repairBudget():{exhausted:boolean;available:boolean;retryAt:number;repairEpoch:number} {
    return this.db.transaction(()=>{
      const p=this.read<Signed<RecoveryCheckpoint>>('checkpoint')?.payload;
    if(!p)return {exhausted:false,available:false,retryAt:0,repairEpoch:0};
    const cause=recoveryDigest({principals:p.principals,repairEpoch:p.repairEpoch??0});
    const budget=this.read<{cause:string;exhausted:boolean;cooldownUntil:number}>('mutation-budget');
    if(!budget||budget.cause!==cause)return {exhausted:false,available:true,retryAt:0,repairEpoch:p.repairEpoch??0};
    return {exhausted:budget.exhausted,available:!budget.exhausted&&budget.cooldownUntil<=this.now(),retryAt:budget.exhausted?0:budget.cooldownUntil,repairEpoch:p.repairEpoch??0};
    })();
  }

  disabledRoutes():RecoveryRoute[] {return this.read<Signed<RecoveryCheckpoint>>('checkpoint')?.payload.disabledRoutes??[];}
  /** This connection holds the OS-backed writer lock through local service
   * changes. A crashed installer releases it automatically; no orphan latch. */
  async withServiceInstallation<T>(fn:()=>Promise<T>,ownedUpdateDigest?:string):Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update=this.ownedUpdate();
      if(update&&update.digest!==ownedUpdateDigest)throw new Error('recovery-owned-update-in-progress');
      if(this.hasRunningMutation()||this.watchdogRuleOwner())throw new Error('recovery-install-operation-busy');
      const result=await fn();this.db.exec('COMMIT');return result;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** Filesystem slot reservations share this OS-backed writer lock without changing authority. */
  withRuntimeSlotAllocation<T>(fn:()=>T):T{return this.db.transaction(fn).immediate();}
  assertInstallationScope(stateDir:string,agentId:string,machineId:string):void {
    if(!this.db.inTransaction||this.options.stateDir!==stateDir||this.options.agentId!==agentId||this.options.machineId!==machineId)throw new Error('recovery-install-admission-scope-invalid');
  }
  /** Trusted synchronous local binding writes share the same admission fence. */
  withOwnedBindingWrite<T>(fn:()=>T):T {
    return this.db.transaction(()=>{
      if(this.ownedUpdate()||this.hasRunningMutation()||this.watchdogRuleOwner())throw new Error('recovery-install-operation-busy');
      return fn();
    }).immediate();
  }
  withCurrentCheckpoint<T>(fn:(checkpoint:Signed<RecoveryCheckpoint>)=>T):T {
    return this.db.transaction(()=>{
      const checkpoint=this.read<Signed<RecoveryCheckpoint>>('checkpoint');
      if(!checkpoint)throw new Error('recovery-checkpoint-required');
      return fn(checkpoint);
    }).immediate();
  }
  hasRunningMutation():boolean {
    const running=this.db.prepare("SELECT owner_pid, owner_boot, owner_start, admitted_at FROM operations WHERE state='running' AND mutation=1").all() as Array<{owner_pid:number;owner_boot:string;owner_start:number|null;admitted_at:number}>;
    return running.some(row=>{
      if(row.owner_boot!==this.options.bootId)return false;
      try {process.kill(row.owner_pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;}
      const birth=row.owner_pid===process.pid?this.ownProcessStart:(this.options.processStart??processStartMs)(row.owner_pid);
      return birth===null||(row.owner_start!==null?birth===row.owner_start:birth<=row.admitted_at+2000);
    });
  }
  holdDeadline(): number { return this.hold()?.deadline ?? 0; }
  clearHold(): void { this.write('watchdog-hold', null); }
  /** Local commissioning starts disabled; generic protocol fixtures remain unchanged. */
  initializeEnrollment():void {
    this.db.transaction(()=>{
      if(this.read('local-admission')!==null)return;
      this.write('local-admission',{active:false,epoch:0,deactivatedAt:this.now(),checkpointVersion:0});
      this.audit('recovery-enrollment-prepared-inactive');
    }).immediate();
  }
  installationEpoch():number{return this.read<{epoch?:number}>('local-admission')?.epoch??0;}
  locallyActive():boolean {return this.read<{active:boolean}>('local-admission')?.active!==false;}
  /** Revoking a key cannot invalidate an existing authenticated sshd socket.
   * This latch is checked by every new wrapper/sidecar operation instead. */
  deactivate():void {
    this.db.transaction(()=>{
      if(this.ownedUpdate())throw new Error('recovery-update-operation-busy');
      this.write('local-admission',{active:false,epoch:this.installationEpoch()+1,deactivatedAt:this.now(),checkpointVersion:this.read<Signed<RecoveryCheckpoint>>('checkpoint')?.payload.version??0});
      this.write('challenge',null);this.write('challenges',[]);this.audit('recovery-admission-deactivated');
    }).immediate();
  }
  /** Only the explicit verified local installer calls this after both services
   * and protected grant inventory exist. Renewal alone never reactivates. */
  activateFromCheckpoint(minimumVersion:number,expectedEpoch:number):void {
    this.db.transaction(()=>{
      if(expectedEpoch!==this.installationEpoch())throw new Error('recovery-installation-superseded');
      const prior=this.read<{active:boolean;checkpointVersion:number}>('local-admission');
      const checkpoint=this.read<Signed<RecoveryCheckpoint>>('checkpoint')?.payload;
      if(!Number.isSafeInteger(minimumVersion)||minimumVersion<1||!checkpoint||checkpoint.version<minimumVersion||(!prior?.active&&prior&&checkpoint.version<=prior.checkpointVersion))throw new Error('recovery-fresh-install-checkpoint-required');
      if(this.ownedUpdate())throw new Error('recovery-owned-update-in-progress');
      this.write('local-admission',{active:true,epoch:expectedEpoch,activatedAt:this.now(),checkpointVersion:checkpoint.version});this.audit('recovery-admission-activated');
    }).immediate();
  }
  close(): void { this.unregisterSqlite();if(this.db.open)this.db.close(); }
}
