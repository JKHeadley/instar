/* @self-action-controller: history-acquisition-delivery-poll */
import { DELIVERY_WINDOW_MS, MAX_NOTICE_ATTEMPTS, nextDeliveryObservation, nextNoticeAttempt, type NoticeAttempts } from './acquisitionPolling.js';
import { randomUUID } from 'node:crypto';
import { privateAcquisitionDatabasePath } from './privateImportState.js';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';

export type Provider = 'chatgpt' | 'claude';
export type OwnerChat = { owner: string; machine: string; conversation: string };
export type ExportAccount = { provider: Provider; profileId: string; expectedEmail: string; workspace: 'personal' };
type Phase = 'ready' | 'submitting' | 'waiting' | 'review' | 'applying' | 'cancelled' | 'expired' | 'complete';
export interface AcquisitionJob extends OwnerChat, ExportAccount {
  id: string;
  phase: Phase;
  deadline: number;
  nextCheck: number;
  previewDigest: string | null;
  createdAt: number;
  requestedAt: number | null;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;
const active = "phase IN ('ready','submitting','waiting','review','applying')";

/** Local to the machine with the browser login. No page text, URL, mail or archive bytes enter this DB. */
export class HistoryAcquisitionStore {
  private readonly db: Database.Database;
  private readonly unregister: () => void;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.db = new Database(privateAcquisitionDatabasePath(stateDir, 'jobs.sqlite')); /* state-registry: history-acquisition-local */
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, machine TEXT NOT NULL, conversation TEXT NOT NULL,
          provider TEXT NOT NULL, profileId TEXT NOT NULL, expectedEmail TEXT NOT NULL, workspace TEXT NOT NULL,
          phase TEXT NOT NULL, deadline INTEGER NOT NULL, nextCheck INTEGER NOT NULL, previewDigest TEXT, createdAt INTEGER NOT NULL, requestedAt INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS active_account ON jobs(owner,machine,provider,expectedEmail,workspace)
          WHERE ${active};
        CREATE UNIQUE INDEX IF NOT EXISTS active_conversation ON jobs(owner,machine,conversation)
          WHERE ${active};
        CREATE TABLE IF NOT EXISTS attention (
          jobId TEXT PRIMARY KEY, phase TEXT NOT NULL, reason TEXT
        );
        CREATE TABLE IF NOT EXISTS notices (
          jobId TEXT PRIMARY KEY, lastKind TEXT NOT NULL, sequence INTEGER NOT NULL, sent INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notice_attempts (
          jobId TEXT PRIMARY KEY, sequence INTEGER NOT NULL, attempts INTEGER NOT NULL,
          nextAt INTEGER NOT NULL, warned INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS starts (
          owner TEXT NOT NULL, machine TEXT NOT NULL, conversation TEXT NOT NULL, requestId TEXT NOT NULL,
          jobId TEXT NOT NULL, PRIMARY KEY(owner,machine,conversation,requestId)
        );`);
    } catch (err) { this.db.close(); throw err; }
    this.unregister = registerSqliteHandle(() => this.db.close());
  }

  close(): void { this.unregister(); if (this.db.open) this.db.close(); }

  /** A replay after completion or cancellation still refers to the original operation. */
  start(chat: OwnerChat, account: ExportAccount, requestId: string): AcquisitionJob {
    const email = account.expectedEmail.trim().toLowerCase();
    if (!chat.owner || !chat.machine || !chat.conversation || !requestId || !/^[^\s@]+@[^\s@]+$/.test(email)
      || account.workspace !== 'personal' || !['chatgpt', 'claude'].includes(account.provider)
      || !/^[a-zA-Z0-9_-]{1,120}$/.test(account.profileId)) throw new Error('invalid-export-binding');
    const scope = { ...chat, ...account, expectedEmail: email, requestId };
    return this.db.transaction(() => {
      this.expire();
      const replay = this.db.prepare('SELECT jobId FROM starts WHERE owner=@owner AND machine=@machine AND conversation=@conversation AND requestId=@requestId').get(scope) as { jobId: string } | undefined;
      if (replay) {
        const prior = this.read(chat, replay.jobId)!;
        if (prior.provider !== account.provider || prior.expectedEmail !== email || prior.profileId !== account.profileId) throw new Error('request-id-conflict');
        return prior;
      }
      const existing = this.db.prepare(`SELECT * FROM jobs WHERE owner=@owner AND machine=@machine AND provider=@provider AND expectedEmail=@expectedEmail AND workspace=@workspace AND ${active}`).get(scope) as AcquisitionJob | undefined;
      if (existing && (existing.conversation !== chat.conversation || existing.profileId !== account.profileId)) throw new Error('account-export-in-progress');
      const other = this.db.prepare(`SELECT id FROM jobs WHERE owner=@owner AND machine=@machine AND conversation=@conversation AND ${active}`).get(chat) as { id: string } | undefined;
      if (other && other.id !== existing?.id) throw new Error('conversation-export-in-progress');
      const id = existing?.id ?? randomUUID();
      if (!existing) this.db.prepare(`INSERT INTO jobs VALUES (@id,@owner,@machine,@conversation,@provider,@profileId,@expectedEmail,@workspace,'ready',@deadline,@nextCheck,NULL,@nextCheck,NULL)`).run({ ...scope, id, deadline: this.now() + WEEK, nextCheck: this.now() });
      this.db.prepare('INSERT INTO starts VALUES (@owner,@machine,@conversation,@requestId,@id)').run({ ...scope, id });
      return this.read(chat, id)!;
    }).immediate();
  }

  read(chat: OwnerChat, id: string): AcquisitionJob | undefined {
    this.expire();
    return this.db.prepare('SELECT * FROM jobs WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation').get({ ...chat, id }) as AcquisitionJob | undefined;
  }

  private expire(): void {
    this.db.prepare(`UPDATE jobs SET phase='expired', previewDigest=NULL WHERE phase IN ('ready','submitting','waiting','review') AND deadline<=?`).run(this.now());
  }

  private move(chat: OwnerChat, id: string, from: Phase, to: Phase): boolean {
    return this.db.prepare(`UPDATE jobs SET phase=@to WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation AND phase=@from AND deadline>@now`).run({ ...chat, id, from, to, now: this.now() }).changes === 1;
  }

  /** The only point that can authorize the driver's final click. Commit the intent before acting. */
  reserveSubmission(chat: OwnerChat, id: string): boolean {
    const now = this.now();
    return this.db.prepare(`UPDATE jobs SET phase='submitting',requestedAt=@now,nextCheck=@now,deadline=@deadline
      WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation AND phase='ready' AND deadline>@now`).run({ ...chat, id, now, deadline: now + DELIVERY_WINDOW_MS }).changes === 1;
  }
  acknowledge(chat: OwnerChat, id: string): boolean { return this.move(chat, id, 'submitting', 'waiting'); }

  /** Reserve an observation interval before I/O so two pollers cannot both consume a one-use link. */
  claimObservation(chat: OwnerChat, id: string): boolean {
    return this.db.transaction(() => {
      const current = this.db.prepare(`SELECT requestedAt,nextCheck,deadline FROM jobs
        WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation AND phase IN ('submitting','waiting')`)
        .get({...chat,id}) as Pick<AcquisitionJob,'requestedAt'|'nextCheck'|'deadline'> | undefined;
      if (!current || current.requestedAt === null) return false;
      const next = nextDeliveryObservation(current.requestedAt,current.nextCheck,current.deadline,this.now());
      if (next === null) return false;
      this.db.prepare('UPDATE jobs SET nextCheck=? WHERE id=?').run(next,id);
      return true;
    }).immediate();
  }

  review(chat: OwnerChat, id: string, digest: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid-archive-digest');
    // Correlated delivery also resolves an uncertain submission.
    return this.db.prepare(`UPDATE jobs SET phase='review',previewDigest=@digest WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation AND phase IN ('submitting','waiting') AND deadline>@now`).run({ ...chat, id, digest, now: this.now() }).changes === 1;
  }

  beginApply(chat: OwnerChat, id: string, digest: string): boolean {
    return this.db.prepare(`UPDATE jobs SET phase='applying' WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation
      AND phase='review' AND previewDigest=@digest AND deadline>@now`).run({ ...chat, id, digest, now: this.now() }).changes === 1;
  }

  finishApply(chat: OwnerChat, id: string): boolean {
    return this.db.prepare(`UPDATE jobs SET phase='complete',previewDigest=NULL WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation AND phase='applying'`).run({ ...chat, id }).changes === 1;
  }

  /** A possibly partial apply is never repeated by the poller. A fresh review is required. */
  requestReviewAfterInterruptedApply(chat: OwnerChat, id: string): boolean {
    return this.db.prepare(`UPDATE jobs SET phase=CASE WHEN deadline<=@now THEN 'expired' ELSE 'review' END
      WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation AND phase='applying'`)
      .run({ ...chat, id, now: this.now() }).changes === 1;
  }

  attentionFor(job: AcquisitionJob): string | undefined {
    if (!['ready', 'submitting', 'waiting', 'cancelled'].includes(job.phase)) return undefined;
    const row = this.db.prepare('SELECT reason FROM attention WHERE jobId=? AND phase=?').get(job.id, job.phase) as { reason: string | null } | undefined;
    return row?.reason ?? undefined;
  }

  recordAttention(job: AcquisitionJob, reason?: string): void {
    this.db.prepare(`INSERT INTO attention VALUES (?,?,?) ON CONFLICT(jobId)
      DO UPDATE SET phase=excluded.phase, reason=excluded.reason`).run(job.id, job.phase, reason ?? null);
  }

  rejectArchive(chat: OwnerChat, id: string): void {
    this.db.transaction(() => {
      if (!this.cancel(chat, id)) return;
      this.recordAttention(this.read(chat, id)!, 'invalid-archive');
      this.note(id, 'rejected');
    }).immediate();
  }

  keepArchive(id: string): boolean {
    this.expire();
    return Boolean(this.db.prepare(`SELECT 1 FROM jobs WHERE id=? AND phase IN ('submitting','waiting','review','applying')`).get(id));
  }

  latest(chat: OwnerChat): Pick<AcquisitionJob, 'id' | 'phase' | 'provider' | 'expectedEmail'> | null {
    this.expire();
    return this.db.prepare('SELECT id,phase,provider,expectedEmail FROM jobs WHERE owner=@owner AND machine=@machine AND conversation=@conversation ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(chat) as Pick<AcquisitionJob, 'id' | 'phase' | 'provider' | 'expectedEmail'> | undefined ?? null;
  }

  recoverInterruptedApplies(): void {
    // Called only after acquiring the machine's exclusive worker lease. Import writes are idempotent.
    this.db.prepare("UPDATE jobs SET phase='review' WHERE phase='applying'").run();
    this.expire();
  }

  note(id: string, kind: string): void {
    this.db.prepare(`INSERT INTO notices VALUES(?,?,1,0) ON CONFLICT(jobId) DO UPDATE SET lastKind=excluded.lastKind,
      sequence=notices.sequence+1,sent=0 WHERE notices.lastKind<>excluded.lastKind`).run(id, kind);
  }

  restoreNotices(): void {
    this.expire();
    this.db.prepare(`INSERT INTO notices SELECT id,phase,1,0 FROM jobs WHERE phase IN ('review','expired')
      ON CONFLICT(jobId) DO UPDATE SET lastKind=excluded.lastKind,sequence=notices.sequence+1,sent=0
        WHERE notices.lastKind<>excluded.lastKind`).run();
  }

  pendingNotices(): Array<OwnerChat & { id: string; lastKind: string; sequence: number }> {
    return this.db.prepare(`SELECT jobs.id,jobs.owner,jobs.machine,jobs.conversation,notices.lastKind,notices.sequence FROM notices JOIN jobs ON jobs.id=notices.jobId
      LEFT JOIN notice_attempts a ON a.jobId=notices.jobId AND a.sequence=notices.sequence
      WHERE COALESCE(a.attempts,0) < ? AND COALESCE(a.nextAt,0) <= ? AND notices.sent=0 AND (jobs.phase IN ('waiting','submitting','ready','review','expired')
        OR (jobs.phase='cancelled' AND notices.lastKind='rejected')) ORDER BY jobs.nextCheck,jobs.id LIMIT 32`).all(MAX_NOTICE_ATTEMPTS,this.now()) as Array<OwnerChat & { id: string; lastKind: string; sequence: number }>;
  }
  reserveNotice(id: string, sequence: number): boolean {
    return this.db.transaction(() => {
      const current = this.db.prepare(`SELECT COALESCE(a.attempts,0) AS attempts,COALESCE(a.nextAt,0) AS nextAt
        FROM notices n LEFT JOIN notice_attempts a ON a.jobId=n.jobId AND a.sequence=n.sequence
        WHERE n.jobId=? AND n.sequence=? AND n.sent=0`).get(id,sequence) as NoticeAttempts | undefined;
      if (!current) return false;
      const reserved = nextNoticeAttempt(current,this.now());
      if (!reserved) return false;
      this.db.prepare(`INSERT INTO notice_attempts(jobId,sequence,attempts,nextAt,warned) VALUES(?,?,?,?,0)
        ON CONFLICT(jobId) DO UPDATE SET sequence=excluded.sequence,attempts=excluded.attempts,nextAt=excluded.nextAt,warned=0`)
        .run(id,sequence,reserved.attempts,reserved.nextAt);
      return true;
    }).immediate();
  }

  noticeExhausted(chat: OwnerChat, id: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM jobs j JOIN notices n ON n.jobId=j.id
      JOIN notice_attempts a ON a.jobId=n.jobId AND a.sequence=n.sequence
      WHERE j.id=@id AND j.owner=@owner AND j.machine=@machine AND j.conversation=@conversation
        AND n.sent=0 AND a.attempts>=@max`).get({...chat,id,max:MAX_NOTICE_ATTEMPTS}));
  }

  /** Includes final attempts interrupted after reservation. Keep their original notice explicitly unsent. */
  takeExhaustionWarnings(): number {
    return this.db.prepare(`UPDATE notice_attempts SET warned=1 WHERE warned=0 AND attempts>=? AND EXISTS
      (SELECT 1 FROM notices n WHERE n.jobId=notice_attempts.jobId AND n.sequence=notice_attempts.sequence AND n.sent=0)`)
      .run(MAX_NOTICE_ATTEMPTS).changes;
  }

  delivered(id: string, sequence: number): void { this.db.prepare('UPDATE notices SET sent=1 WHERE jobId=? AND sequence=?').run(id, sequence); }

  due(limit = 8): AcquisitionJob[] {
    this.expire();
    return this.db.prepare(`SELECT * FROM jobs WHERE phase IN ('submitting','waiting') AND nextCheck<=? ORDER BY nextCheck,id LIMIT ?`).all(this.now(), Math.min(32, Math.max(1, limit))) as AcquisitionJob[];
  }

  cancel(chat: OwnerChat, id: string): boolean {
    return this.db.prepare(`UPDATE jobs SET phase='cancelled',previewDigest=NULL WHERE id=@id AND owner=@owner AND machine=@machine AND conversation=@conversation AND phase IN ('ready','submitting','waiting','review')`).run({ ...chat, id }).changes === 1;
  }
}
