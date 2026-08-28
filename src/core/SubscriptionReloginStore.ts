import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { registerSqliteHandle } from './SqliteRegistry.js';

export const SUBSCRIPTION_RELOGIN_STATES = [
  'suggested', 'approved', 'cli-starting', 'artifact-ready', 'browser-driving',
  'cli-finishing', 'identity-verifying', 'auth-verifying', 'waiting-operator-only',
  'succeeded', 'refused', 'cancelled', 'failed',
] as const;
export type SubscriptionReloginState = typeof SUBSCRIPTION_RELOGIN_STATES[number];
export type SubscriptionReloginMode = 'observe' | 'approval' | 'unattended';
export type SubscriptionReloginFailureClass =
  | 'seat-busy' | 'target-unreachable' | 'artifact-expired' | 'provider-transient'
  | 'wrong-identity' | 'unexpected-origin' | 'captcha' | 'phone-confirmation'
  | 'permission-expansion' | 'authority-degraded' | 'vault-reference-missing'
  | 'provider-rejected' | 'verification-failed' | 'attempt-budget-exhausted'
  | 'repair-time-budget-exhausted'
  | 'uncertain-external-outcome'
  | 'cancelled-by-operator' | 'other';

export interface SubscriptionReloginEpisode {
  id: string; sourceEpisodeId: number; accountId: string; machineId: string;
  mode: SubscriptionReloginMode; state: SubscriptionReloginState; inputDigest: string;
  profileId: string; framework: string; provider: string; attemptCount: number;
  reissueCount: number; approvedAt: string | null; approvalExpiresAt: string | null;
  startedAt: string | null; finishedAt: string | null; nextAttemptAt: string | null;
  failureClass: SubscriptionReloginFailureClass | null; version: number;
  createdAt: string; updatedAt: string;
}
export interface SubscriptionReloginEvent {
  id: number; episodeId: string; at: string; fromState: SubscriptionReloginState | null;
  toState: SubscriptionReloginState; eventClass: string; attempt: number;
}
export interface SubscriptionReloginNotification {
  id: number; episodeId: string; kind: 'suggested' | 'operator-only' | 'terminal';
  deliveryKey: string; state: 'pending' | 'delivering' | 'delivered'; attemptCount: number;
  nextAttemptAt: string; leaseExpiresAt: string | null; createdAt: string; deliveredAt: string | null;
}
export interface SubscriptionReloginStoreOptions {
  stateDir: string; now?: () => number; idFactory?: () => string;
  databaseFactory?: (file: string, opts?: Database.Options) => BetterSqliteDatabase;
}

const TERMINAL = new Set<SubscriptionReloginState>(['succeeded', 'refused', 'cancelled', 'failed']);
const TRANSITIONS: Readonly<Record<SubscriptionReloginState, readonly SubscriptionReloginState[]>> = {
  suggested: ['approved', 'refused', 'cancelled'],
  approved: ['cli-starting', 'refused', 'cancelled', 'failed'],
  'cli-starting': ['approved', 'artifact-ready', 'waiting-operator-only', 'cancelled', 'failed'],
  'artifact-ready': ['approved', 'browser-driving', 'waiting-operator-only', 'cancelled', 'failed'],
  'browser-driving': ['approved', 'cli-finishing', 'identity-verifying', 'waiting-operator-only', 'refused', 'cancelled', 'failed'],
  'cli-finishing': ['approved', 'identity-verifying', 'waiting-operator-only', 'cancelled', 'failed'],
  'identity-verifying': ['approved', 'auth-verifying', 'refused', 'cancelled', 'failed'],
  'auth-verifying': ['approved', 'succeeded', 'cancelled', 'failed'],
  'waiting-operator-only': ['approved', 'cancelled', 'failed'],
  succeeded: [], refused: [], cancelled: [], failed: ['approved'],
};
const FAILURES: readonly string[] = [
  'seat-busy', 'target-unreachable', 'artifact-expired', 'provider-transient',
  'wrong-identity', 'unexpected-origin', 'captcha', 'phone-confirmation',
  'permission-expansion', 'authority-degraded', 'vault-reference-missing',
  'provider-rejected', 'verification-failed', 'attempt-budget-exhausted',
  'repair-time-budget-exhausted',
  'uncertain-external-outcome',
  'cancelled-by-operator', 'other',
];
const ID_RE = /^[a-zA-Z0-9._:-]{1,160}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_EPISODES = 2_000;
const MAX_EVENTS = 20_000;
const RETENTION_MS = 180 * 24 * 60 * 60_000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repair_episodes (
 id TEXT PRIMARY KEY, sourceEpisodeId INTEGER NOT NULL, accountId TEXT NOT NULL,
 machineId TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, inputDigest TEXT NOT NULL,
 profileId TEXT NOT NULL, framework TEXT NOT NULL, provider TEXT NOT NULL,
 attemptCount INTEGER NOT NULL DEFAULT 0, reissueCount INTEGER NOT NULL DEFAULT 0,
 approvedAt TEXT, approvalExpiresAt TEXT, startedAt TEXT, finishedAt TEXT, nextAttemptAt TEXT,
 failureClass TEXT, version INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
 UNIQUE(sourceEpisodeId,accountId,machineId)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relogin_live_cell ON repair_episodes(accountId,machineId)
 WHERE state NOT IN ('succeeded','refused','cancelled','failed');
CREATE INDEX IF NOT EXISTS idx_relogin_state_next ON repair_episodes(state,nextAttemptAt);
CREATE TABLE IF NOT EXISTS repair_events (
 id INTEGER PRIMARY KEY, episodeId TEXT NOT NULL, at TEXT NOT NULL, fromState TEXT,
 toState TEXT NOT NULL, eventClass TEXT NOT NULL, attempt INTEGER NOT NULL,
 FOREIGN KEY(episodeId) REFERENCES repair_episodes(id)
);
CREATE INDEX IF NOT EXISTS idx_relogin_events_episode ON repair_events(episodeId,id);
CREATE TABLE IF NOT EXISTS repair_notifications (
 id INTEGER PRIMARY KEY, episodeId TEXT NOT NULL, kind TEXT NOT NULL, deliveryKey TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'pending', attemptCount INTEGER NOT NULL DEFAULT 0,
 nextAttemptAt TEXT NOT NULL, leaseExpiresAt TEXT, createdAt TEXT NOT NULL, deliveredAt TEXT,
 UNIQUE(episodeId,kind), FOREIGN KEY(episodeId) REFERENCES repair_episodes(id)
);
CREATE INDEX IF NOT EXISTS idx_relogin_notifications_due ON repair_notifications(state,nextAttemptAt);
`;

export class SubscriptionReloginConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'SubscriptionReloginConflictError'; }
}

/** Closed-metadata-only action ledger. It cannot persist credentials, codes, URLs, DOM, or errors. */
export class SubscriptionReloginStore {
  readonly dir: string;
  readonly dbPath: string;
  private readonly db: BetterSqliteDatabase;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly unregister: () => void;
  private closed = false;

  constructor(options: SubscriptionReloginStoreOptions) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.dir = path.join(options.stateDir, 'state', 'subscription-relogin');
    this.dbPath = path.join(this.dir, 'repairs.db');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    if (!fs.existsSync(this.dbPath)) { const fd = fs.openSync(this.dbPath, 'w', 0o600); fs.closeSync(fd); }
    fs.chmodSync(this.dbPath, 0o600);
    this.db = NativeModuleHealer.openWithHealSync('SubscriptionReloginStore', () =>
      options.databaseFactory?.(this.dbPath) ?? new Database(this.dbPath));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${this.dbPath}${suffix}`; if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
    this.unregister = registerSqliteHandle(() => { try { this.close(); } catch { /* already closed */ } });
    this.prune();
  }

  suggest(input: {
    sourceEpisodeId: number; accountId: string; machineId: string; mode: SubscriptionReloginMode;
    inputDigest: string; profileId: string; framework: string; provider: string; at?: string;
  }): SubscriptionReloginEpisode {
    const at = input.at ?? this.isoNow();
    const source = Math.floor(input.sourceEpisodeId);
    if (!Number.isSafeInteger(source) || source <= 0) throw new Error('invalid-source-episode-id');
    const account = normalizeId(input.accountId, 'account');
    const machine = normalizeId(input.machineId, 'machine');
    const profile = normalizeId(input.profileId, 'profile');
    const framework = normalizeId(input.framework, 'framework');
    const provider = normalizeId(input.provider, 'provider');
    if (!DIGEST_RE.test(input.inputDigest)) throw new Error('invalid-input-digest');
    if (!['observe', 'approval', 'unattended'].includes(input.mode)) throw new Error('invalid-relogin-mode');
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM repair_episodes WHERE sourceEpisodeId=? AND accountId=? AND machineId=?')
        .get(source, account, machine) as SubscriptionReloginEpisode | undefined;
      if (prior) return coerceEpisode(prior);
      const live = this.db.prepare(`SELECT id FROM repair_episodes WHERE accountId=? AND machineId=?
        AND state NOT IN ('succeeded','refused','cancelled','failed')`).get(account, machine);
      if (live) throw new SubscriptionReloginConflictError('live-repair-already-owns-cell');
      const id = normalizeId(this.idFactory(), 'episode');
      this.db.prepare(`INSERT INTO repair_episodes(
        id,sourceEpisodeId,accountId,machineId,mode,state,inputDigest,profileId,framework,provider,
        attemptCount,reissueCount,version,createdAt,updatedAt)
        VALUES(?,?,?,?,?,'suggested',?,?,?,?,0,0,1,?,?)`)
        .run(id, source, account, machine, input.mode, input.inputDigest, profile, framework, provider, at, at);
      this.event(id, at, null, 'suggested', 'candidate-admitted', 0);
      if (input.mode === 'approval') this.enqueueNotification(id, 'suggested', at);
      this.enforceCaps();
      return this.mustGet(id);
    })();
  }

  approve(id: string, input: { inputDigest: string; at?: string; ttlMs?: number }): SubscriptionReloginEpisode {
    const ep = this.mustGet(id);
    if (ep.inputDigest !== input.inputDigest) throw new SubscriptionReloginConflictError('approval-input-digest-mismatch');
    if (ep.state !== 'suggested' && ep.state !== 'waiting-operator-only')
      throw new SubscriptionReloginConflictError('episode-not-approvable');
    const at = input.at ?? this.isoNow();
    const ttl = Math.max(1, Math.min(3_600_000, Math.floor(input.ttlMs ?? 900_000)));
    return this.transition(id, { expectedVersion: ep.version, to: 'approved', at,
      eventClass: ep.state === 'suggested' ? 'operator-approved' : 'operator-resumed',
      approvedAt: at, approvalExpiresAt: new Date(Date.parse(at) + ttl).toISOString(), clearFailure: true });
  }

  retryFailed(id: string, input: { inputDigest: string; at?: string; ttlMs?: number }): SubscriptionReloginEpisode {
    const ep = this.mustGet(id);
    if (ep.state !== 'failed') throw new SubscriptionReloginConflictError('episode-not-retryable');
    if (ep.inputDigest !== input.inputDigest) throw new SubscriptionReloginConflictError('approval-input-digest-mismatch');
    const at = input.at ?? this.isoNow();
    const ttl = Math.max(1, Math.min(3_600_000, Math.floor(input.ttlMs ?? 900_000)));
    return this.transition(id, { expectedVersion: ep.version, to: 'approved', at,
      eventClass: 'operator-retry-approved', approvedAt: at,
      approvalExpiresAt: new Date(Date.parse(at) + ttl).toISOString(), clearFailure: true, resetBudgets: true });
  }

  transition(id: string, input: {
    expectedVersion: number; to: SubscriptionReloginState; eventClass: string; at?: string;
    failureClass?: SubscriptionReloginFailureClass; nextAttemptAt?: string | null;
    incrementAttempt?: boolean; incrementReissue?: boolean; approvedAt?: string;
    approvalExpiresAt?: string; clearFailure?: boolean; resetBudgets?: boolean;
  }): SubscriptionReloginEpisode {
    const at = input.at ?? this.isoNow(); normalizeEvent(input.eventClass);
    return this.db.transaction(() => {
      const ep = this.mustGet(id);
      if (ep.version !== input.expectedVersion) throw new SubscriptionReloginConflictError('episode-version-conflict');
      if (!TRANSITIONS[ep.state].includes(input.to))
        throw new SubscriptionReloginConflictError(`invalid-transition:${ep.state}->${input.to}`);
      if (input.failureClass && !FAILURES.includes(input.failureClass)) throw new Error('invalid-failure-class');
      const attempt = input.resetBudgets ? 0 : ep.attemptCount + (input.incrementAttempt ? 1 : 0);
      const reissue = input.resetBudgets ? 0 : ep.reissueCount + (input.incrementReissue ? 1 : 0);
      const finished = TERMINAL.has(input.to) ? at : null;
      const info = this.db.prepare(`UPDATE repair_episodes SET state=?,attemptCount=?,reissueCount=?,
        approvedAt=COALESCE(?,approvedAt),approvalExpiresAt=COALESCE(?,approvalExpiresAt),
        startedAt=CASE WHEN ?=1 THEN NULL WHEN ?='cli-starting' THEN COALESCE(startedAt,?) ELSE startedAt END,
        finishedAt=?,nextAttemptAt=?,failureClass=?,version=version+1,updatedAt=? WHERE id=? AND version=?`)
        .run(input.to, attempt, reissue, input.approvedAt ?? null, input.approvalExpiresAt ?? null,
          input.resetBudgets ? 1 : 0, input.to, at, finished, input.nextAttemptAt ?? null,
          input.clearFailure ? null : (input.failureClass ?? ep.failureClass), at, ep.id, ep.version);
      if (info.changes !== 1) throw new SubscriptionReloginConflictError('episode-version-conflict');
      this.event(ep.id, at, ep.state, input.to, input.eventClass, attempt);
      if (input.to === 'waiting-operator-only') this.enqueueNotification(ep.id, 'operator-only', at);
      if (TERMINAL.has(input.to)) this.enqueueNotification(ep.id, 'terminal', at);
      this.enforceCaps();
      return this.mustGet(ep.id);
    })();
  }

  cancel(id: string, at = this.isoNow()): SubscriptionReloginEpisode {
    const ep = this.mustGet(id); if (TERMINAL.has(ep.state)) return ep;
    return this.transition(id, { expectedVersion: ep.version, to: 'cancelled', at,
      eventClass: 'operator-cancelled', failureClass: 'cancelled-by-operator' });
  }
  recordReissue(id: string, expectedVersion: number, count: number, at = this.isoNow()): SubscriptionReloginEpisode {
    const bounded = Math.max(0, Math.min(100, Math.floor(count)));
    return this.db.transaction(() => {
      const ep = this.mustGet(id);
      if (ep.version !== expectedVersion) throw new SubscriptionReloginConflictError('episode-version-conflict');
      if (bounded <= ep.reissueCount) return ep;
      const info = this.db.prepare(`UPDATE repair_episodes SET reissueCount=?,version=version+1,updatedAt=?
        WHERE id=? AND version=?`).run(bounded, at, ep.id, ep.version);
      if (info.changes !== 1) throw new SubscriptionReloginConflictError('episode-version-conflict');
      this.event(ep.id, at, ep.state, ep.state, 'artifact-reissued', ep.attemptCount);
      return this.mustGet(ep.id);
    })();
  }

  get(id: string): SubscriptionReloginEpisode | null {
    const row = this.db.prepare('SELECT * FROM repair_episodes WHERE id=?').get(normalizeId(id, 'episode')) as SubscriptionReloginEpisode | undefined;
    return row ? coerceEpisode(row) : null;
  }
  list(input: { state?: SubscriptionReloginState; accountId?: string; limit?: number } = {}): SubscriptionReloginEpisode[] {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    if (input.state && !SUBSCRIPTION_RELOGIN_STATES.includes(input.state)) throw new Error('invalid-relogin-state');
    const rows = input.accountId
      ? (input.state
        ? this.db.prepare('SELECT * FROM repair_episodes WHERE accountId=? AND state=? ORDER BY createdAt DESC LIMIT ?').all(normalizeId(input.accountId, 'account'), input.state, limit)
        : this.db.prepare('SELECT * FROM repair_episodes WHERE accountId=? ORDER BY createdAt DESC LIMIT ?').all(normalizeId(input.accountId, 'account'), limit))
      : (input.state
        ? this.db.prepare('SELECT * FROM repair_episodes WHERE state=? ORDER BY createdAt DESC LIMIT ?').all(input.state, limit)
        : this.db.prepare('SELECT * FROM repair_episodes ORDER BY createdAt DESC LIMIT ?').all(limit));
    return rows.map((row) => coerceEpisode(row as SubscriptionReloginEpisode));
  }
  listEvents(episodeId: string, limit = 200): SubscriptionReloginEvent[] {
    return this.db.prepare('SELECT * FROM repair_events WHERE episodeId=? ORDER BY id DESC LIMIT ?')
      .all(normalizeId(episodeId, 'episode'), Math.max(1, Math.min(500, Math.floor(limit)))) as SubscriptionReloginEvent[];
  }
  isBreakerOpen(accountId: string, provider: string, windowMs = 24 * 60 * 60_000, threshold = 3): boolean {
    const account = normalizeId(accountId, 'account');
    const normalizedProvider = normalizeId(provider, 'provider');
    const cutoff = new Date(this.now() - Math.max(60_000, Math.min(7 * 24 * 60 * 60_000, windowMs))).toISOString();
    const success = this.db.prepare(`SELECT finishedAt FROM repair_episodes WHERE accountId=? AND provider=?
      AND state='succeeded' AND finishedAt>=? ORDER BY finishedAt DESC LIMIT 1`)
      .get(account, normalizedProvider, cutoff) as { finishedAt: string } | undefined;
    const since = success?.finishedAt ?? cutoff;
    const row = this.db.prepare(`SELECT COUNT(*) n FROM repair_episodes WHERE accountId=? AND provider=?
      AND state IN ('failed','refused') AND finishedAt>?`).get(account, normalizedProvider, since) as { n: number };
    return Number(row.n) >= Math.max(1, Math.min(10, Math.floor(threshold)));
  }
  claimNotifications(limit = 10, leaseMs = 60_000): SubscriptionReloginNotification[] {
    const at = this.isoNow();
    const leaseExpiresAt = new Date(this.now() + Math.max(5_000, Math.min(300_000, leaseMs))).toISOString();
    const bounded = Math.max(1, Math.min(50, Math.floor(limit)));
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE repair_notifications SET state='pending',leaseExpiresAt=NULL
        WHERE state='delivering' AND leaseExpiresAt<=?`).run(at);
      const rows = this.db.prepare(`SELECT * FROM repair_notifications
        WHERE state='pending' AND nextAttemptAt<=? ORDER BY id LIMIT ?`).all(at, bounded) as SubscriptionReloginNotification[];
      const claim = this.db.prepare(`UPDATE repair_notifications SET state='delivering',attemptCount=attemptCount+1,
        leaseExpiresAt=? WHERE id=? AND state='pending'`);
      return rows.filter((row) => claim.run(leaseExpiresAt, row.id).changes === 1)
        .map((row) => ({ ...row, state: 'delivering' as const, attemptCount: Number(row.attemptCount) + 1, leaseExpiresAt }));
    })();
  }
  completeNotification(id: number, at = this.isoNow()): void {
    const info = this.db.prepare(`UPDATE repair_notifications SET state='delivered',deliveredAt=?,leaseExpiresAt=NULL
      WHERE id=? AND state='delivering'`).run(at, id);
    if (info.changes !== 1) throw new SubscriptionReloginConflictError('notification-not-claimed');
  }
  retryNotification(id: number, delayMs: number): void {
    const next = new Date(this.now() + Math.max(1_000, Math.min(3_600_000, delayMs))).toISOString();
    const info = this.db.prepare(`UPDATE repair_notifications SET state='pending',nextAttemptAt=?,leaseExpiresAt=NULL
      WHERE id=? AND state='delivering'`).run(next, id);
    if (info.changes !== 1) throw new SubscriptionReloginConflictError('notification-not-claimed');
  }
  close(): void { if (this.closed) return; this.unregister(); this.db.close(); this.closed = true; }

  private mustGet(id: string): SubscriptionReloginEpisode {
    const ep = this.get(id); if (!ep) throw new Error('relogin-episode-not-found'); return ep;
  }
  private event(id: string, at: string, from: SubscriptionReloginState | null,
    to: SubscriptionReloginState, cls: string, attempt: number): void {
    this.db.prepare('INSERT INTO repair_events(episodeId,at,fromState,toState,eventClass,attempt) VALUES(?,?,?,?,?,?)')
      .run(id, at, from, to, normalizeEvent(cls), attempt);
  }
  private enqueueNotification(id: string, kind: SubscriptionReloginNotification['kind'], at: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO repair_notifications(
      episodeId,kind,deliveryKey,state,attemptCount,nextAttemptAt,createdAt)
      VALUES(?,?,?,'pending',0,?,?)`).run(id, kind, `subscription-relogin:${id}:${kind}`, at, at);
  }
  private enforceCaps(): void {
    const episodes = Number((this.db.prepare('SELECT COUNT(*) n FROM repair_episodes').get() as { n: number }).n);
    if (episodes > MAX_EPISODES) this.db.prepare(`D${'ELETE'} FROM repair_episodes WHERE id IN (
      SELECT id FROM repair_episodes WHERE state IN ('succeeded','refused','cancelled','failed')
      ORDER BY finishedAt,id LIMIT ?)` ).run(episodes - MAX_EPISODES);
    const events = Number((this.db.prepare('SELECT COUNT(*) n FROM repair_events').get() as { n: number }).n);
    if (events > MAX_EVENTS) this.db.prepare(`D${'ELETE'} FROM repair_events WHERE id IN
      (SELECT id FROM repair_events ORDER BY id LIMIT ?)` ).run(events - MAX_EVENTS);
  }
  private prune(): void {
    const cutoff = new Date(this.now() - RETENTION_MS).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`D${'ELETE'} FROM repair_events WHERE episodeId IN
        (SELECT id FROM repair_episodes WHERE finishedAt IS NOT NULL AND finishedAt < ?)` ).run(cutoff);
      this.db.prepare(`D${'ELETE'} FROM repair_episodes WHERE finishedAt IS NOT NULL AND finishedAt < ?`).run(cutoff);
      this.enforceCaps();
    })();
  }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
}

function normalizeId(value: string, field: string): string {
  const v = String(value ?? '').trim(); if (!ID_RE.test(v)) throw new Error(`invalid-${field}-id`); return v;
}
function normalizeEvent(value: string): string {
  const v = String(value ?? '').trim(); if (!/^[a-z0-9-]{1,80}$/.test(v)) throw new Error('invalid-event-class'); return v;
}
function coerceEpisode(row: SubscriptionReloginEpisode): SubscriptionReloginEpisode {
  return { ...row, sourceEpisodeId: Number(row.sourceEpisodeId), attemptCount: Number(row.attemptCount),
    reissueCount: Number(row.reissueCount), version: Number(row.version) };
}
