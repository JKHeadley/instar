import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import type { NativeCaptureCaller } from '../server/nativeCaptureAdmission.js';
import { MAX_ZIP_BYTES } from './safeZip.js';
import { AcquisitionArchives } from './archiveStaging.js';
import { NativeCaptureSource, captureIdPattern } from './nativeCaptureSource.js';
import { privateAcquisitionDatabasePath } from './privateImportState.js';
import type { AcquisitionJob, OwnerChat } from './HistoryAcquisition.js';

export type NativeReceipt = {captureId:string;size:number;sha256:string};
export interface NativeCaptureInstallation {
  /** Trusted installation config. No part of this path comes from a request or receipt. */
  applicationSupportRoot:string;
  /** Reverify the stored signed account-selection message. Use verifyNativeCaptureStart with the live app and ledger. */
  verifySignedStart(job:AcquisitionJob,messageId:string):boolean;
  /** A verified operation-specific WebKit delivery handoff for this exact job and local key. */
  hasDeliveryGrant(job:AcquisitionJob,caller:NativeCaptureCaller):boolean;
}
type State = 'issued'|'receiving'|'accepted'|'stopped';
interface Capture extends OwnerChat {
  id:string; job:string; device:string; keyHash:string; profile:string; provider:string; account:string;
  expires:number; state:State; size:number|null; digest:string|null;
}
interface Options {
  stateDir:string; install:NativeCaptureInstallation; archives:AcquisitionArchives;
  readAuthorizedJob(chat:OwnerChat,id:string):AcquisitionJob|undefined;
  holdJob(chat:OwnerChat,id:string):void;
  now:() => number;
}

// RULE 3: EXEMPT — receives a signed capture receipt (id, size, sha256) from the same-Mac app; it reads no provider output or terminal state.
export class NativeCaptureReceiver {
  private readonly db:Database.Database;
  private readonly unregister:() => void;
  private readonly source:NativeCaptureSource;
  private readonly active = new Map<string,AbortController>();

  constructor(private readonly options:Options) {
    this.source = new NativeCaptureSource(options.install.applicationSupportRoot);
    let db:Database.Database|undefined;
    try {
      db = this.db = new Database(privateAcquisitionDatabasePath(options.stateDir,'native-captures.sqlite')); /* state-registry: history-acquisition-local */
      db.pragma('busy_timeout = 5000');
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.exec(`CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, job TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, machine TEXT NOT NULL, conversation TEXT NOT NULL,
        device TEXT NOT NULL, keyHash TEXT NOT NULL, profile TEXT NOT NULL, provider TEXT NOT NULL, account TEXT NOT NULL,
        expires INTEGER NOT NULL,state TEXT NOT NULL,size INTEGER,digest TEXT
      );`);
    } catch (error) { db?.close(); this.source.close(); throw error; }
    this.unregister = registerSqliteHandle(() => this.db.close());
  }

  private row(id:string):Capture|undefined {
    return this.db.prepare('SELECT * FROM captures WHERE id=?').get(id) as Capture|undefined;
  }

  private permitted(row:Capture,caller:NativeCaptureCaller,replay=false):boolean {
    if (!caller.isCurrent() || caller.owner!==row.owner || caller.machine!==row.machine
      || caller.deviceId!==row.device || caller.keyHash!==row.keyHash || row.state==='stopped') return false;
    if (!replay && row.expires<=this.options.now()) return false;
    const job = this.options.readAuthorizedJob(row,row.job);
    if (!job || job.workspace!=='personal' || job.profileId!==row.profile || job.provider!==row.provider
      || job.expectedEmail!==row.account || !this.options.install.hasDeliveryGrant(job,caller)) return false;
    return replay ? ['submitting','waiting','review','applying','complete'].includes(job.phase)
      : ['submitting','waiting'].includes(job.phase) && job.deadline>this.options.now();
  }

  /** No caller-selectable capture UUID. A retry or different installation cannot replace the first lease. */
  issue(chat:OwnerChat,jobId:string,caller:NativeCaptureCaller):{captureId:string;expires:number} {
    const job = this.options.readAuthorizedJob(chat,jobId);
    if (!job || !caller.isCurrent() || chat.owner!==caller.owner || chat.machine!==caller.machine
      || !['submitting','waiting'].includes(job.phase) || job.workspace!=='personal' || job.deadline<=this.options.now()
      || !this.options.install.hasDeliveryGrant(job,caller)) throw new Error('capture-unavailable');
    return this.db.transaction(() => {
      let row = this.db.prepare('SELECT * FROM captures WHERE job=?').get(jobId) as Capture|undefined;
      if (!row) {
        if (this.options.archives.hasArchive(jobId)) throw new Error('capture-unavailable');
        this.options.holdJob(chat,jobId);
        const id = randomUUID();
        const expires = Math.min(job.deadline,this.options.now()+15*60_000);
        this.db.prepare(`INSERT INTO captures VALUES (?,?,?,?,?,?,?,?,?,?,?,'issued',NULL,NULL)`).run(id,jobId,chat.owner,chat.machine,
          chat.conversation,caller.deviceId,caller.keyHash,job.profileId,job.provider,job.expectedEmail,expires);
        row = this.row(id)!;
      }
      if (!this.permitted(row,caller)) throw new Error('capture-unavailable');
      return {captureId:row.id,expires:row.expires};
    }).immediate();
  }

  /** Held captures never fall back to a fresh link redemption, including after lease expiry. */
  deliveryMode(job:string):'ordinary'|'held'|'accepted' {
    const row = this.db.prepare('SELECT state FROM captures WHERE job=?').get(job) as {state:State}|undefined;
    return !row ? 'ordinary' : row.state==='accepted' ? 'accepted' : 'held';
  }

  async receive(caller:NativeCaptureCaller, receipt:NativeReceipt):Promise<{accepted:true}> {
    if (!receipt || Object.keys(receipt).sort().join(',')!=='captureId,sha256,size' || !captureIdPattern.test(receipt.captureId)
      || !Number.isSafeInteger(receipt.size) || receipt.size<=0 || receipt.size>MAX_ZIP_BYTES
      || typeof receipt.sha256!=='string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error('invalid-capture-receipt');
    const row = this.row(receipt.captureId);
    if (!row || !this.permitted(row,caller,row.state==='accepted')) throw new Error('capture-unavailable');
    if (row.digest!==null && (row.digest!==receipt.sha256 || row.size!==receipt.size)) throw new Error('capture-receipt-conflict');
    if (row.state==='accepted') return {accepted:true};
    if (this.active.has(row.id)) throw new Error('capture-in-progress');
    // Persist the exact expectation before opening any file. A crash never grants a new redemption.
    if (row.state==='issued' && this.db.prepare("UPDATE captures SET state='receiving',size=?,digest=? WHERE id=? AND state='issued'")
      .run(receipt.size,receipt.sha256,row.id).changes!==1) throw new Error('capture-in-progress');
    const controller = new AbortController();
    this.active.set(row.id,controller);
    const current = () => {
      const live = this.row(row.id);
      return !controller.signal.aborted && !!live && live.state==='receiving' && this.permitted(live,caller);
    };
    const timer = setTimeout(() => controller.abort(),Math.max(1,row.expires-this.options.now()));
    timer.unref();
    try {
      if (this.options.archives.hasArchive(row.job)) {
        // Recovery when publication succeeded immediately before process death.
        const exact = await this.options.archives.readSnapshot(row.job,async (_file,r) => r.size===receipt.size && r.sha256===receipt.sha256);
        if (!exact) throw new Error('capture-receipt-conflict');
      } else {
        const bytes = this.source.read(row.id,receipt.size,controller.signal);
        await this.options.archives.stageReceipt(row.job,bytes,receipt,current,controller.signal);
      }
      if (!current() || this.db.prepare("UPDATE captures SET state='accepted' WHERE id=? AND state='receiving' AND digest=? AND size=?")
        .run(row.id,receipt.sha256,receipt.size).changes!==1) throw new Error('capture-unavailable');
      return {accepted:true};
    } finally { clearTimeout(timer); this.active.delete(row.id); }
  }

  cancelJob(job:string):void {
    const row = this.db.prepare("SELECT id FROM captures WHERE job=? AND state IN ('issued','receiving')").get(job) as {id:string}|undefined;
    if (row) {
      this.db.prepare("UPDATE captures SET state='stopped' WHERE id=?").run(row.id);
      this.active.get(row.id)?.abort();
    }
  }

  sweepExpired():void {
    const stale = this.db.prepare("SELECT job FROM captures WHERE state IN ('issued','receiving') AND expires<=?").all(this.options.now()) as {job:string}[];
    for (const {job} of stale) {
      this.cancelJob(job);
      this.options.archives.discard(job);
    }
  }

  abortAll():void { for (const controller of this.active.values()) controller.abort(); }
  close():void { this.abortAll(); this.unregister(); this.db.close(); this.source.close(); }
}
