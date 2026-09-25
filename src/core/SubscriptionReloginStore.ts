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
  | 'repair-time-budget-exhausted' | 'automation-permission'
  | 'uncertain-external-outcome'
  | 'passkey-refused'
  | 'agent-sign-in-unfinished' | 'no-healthy-seat'
  | 'resolved-elsewhere'
  | 'cancelled-by-operator' | 'other';

export interface SubscriptionReloginEpisode {
  id: string; sourceEpisodeId: number; accountId: string; machineId: string;
  mode: SubscriptionReloginMode; state: SubscriptionReloginState; inputDigest: string;
  profileId: string; framework: string; provider: string; attemptCount: number;
  reissueCount: number; approvedAt: string | null; approvalExpiresAt: string | null;
  startedAt: string | null; finishedAt: string | null; nextAttemptAt: string | null;
  failureClass: SubscriptionReloginFailureClass | null; version: number;
  createdAt: string; updatedAt: string;
  /** The login method the repair was admitted under; null on rows created before the column existed. */
  loginMethod: string | null;
}
export interface SubscriptionReloginEvent {
  id: number; episodeId: string; at: string; fromState: SubscriptionReloginState | null;
  toState: SubscriptionReloginState; eventClass: string; attempt: number;
  /** A short machine token saying WHY (e.g. `chrome-launch-timeout`), or null. Never free text. */
  reason?: string | null;
}
export interface SubscriptionReloginNotification {
  id: number; episodeId: string; kind: 'suggested' | 'operator-only' | 'terminal' | 'phone-tap';
  deliveryKey: string; state: 'pending' | 'delivering' | 'delivered'; attemptCount: number;
  nextAttemptAt: string; leaseExpiresAt: string | null; createdAt: string; deliveredAt: string | null;
}
export interface SubscriptionReloginStoreOptions {
  stateDir: string; now?: () => number; idFactory?: () => string;
  databaseFactory?: (file: string, opts?: Database.Options) => BetterSqliteDatabase;
}
export interface SubscriptionReloginEvidence {
  successfulRepairs: number;
  oldestSuccessAt: string | null;
  identityMismatches: number;
  unexpectedOrigins: number;
}

const TERMINAL = new Set<SubscriptionReloginState>(['succeeded', 'refused', 'cancelled', 'failed']);
const TRANSITIONS: Readonly<Record<SubscriptionReloginState, readonly SubscriptionReloginState[]>> = {
  suggested: ['approved', 'refused', 'cancelled'],
  // approved → waiting-operator-only: the agent-session pre-attempt check found no healthy helper
  // account on this machine (spec skill-driven-signin-repair, `no-healthy-seat`).
  approved: ['cli-starting', 'waiting-operator-only', 'refused', 'cancelled', 'failed'],
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
  'repair-time-budget-exhausted', 'automation-permission',
  'uncertain-external-outcome',
  'cancelled-by-operator', 'other',
  'passkey-refused',
  'agent-sign-in-unfinished', 'no-healthy-seat',
  'resolved-elsewhere',
];
/** An approval never stays alive longer than this after the operator's tap, however long it queues. */
const APPROVAL_EXTENSION_CAP_MS = 60 * 60_000;
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

/**
 * Additive columns on `repair_episodes` (spec agent-held-google-passkey §3.4). `CREATE TABLE IF
 * NOT EXISTS` never adds a column to an existing database, so each addition is guarded by a
 * `PRAGMA table_info` check (the InboundDeliveryStore pattern) and applied right after the schema.
 */
function ensureRepairEventColumns(db: BetterSqliteDatabase): void {
  const columns = new Set((db.prepare('PRAGMA table_info(repair_events)').all() as Array<{ name: string }>).map((r) => r.name));
  if (!columns.has('reason')) db.exec('ALTER TABLE repair_events ADD COLUMN reason TEXT');
}

function ensureRepairEpisodeColumns(db: BetterSqliteDatabase): void {
  const columns = new Set((db.prepare('PRAGMA table_info(repair_episodes)').all() as Array<{ name: string }>).map((r) => r.name));
  const additions: Array<[string, string]> = [
    ['loginMethod', 'TEXT'],
  ];
  for (const [name, declaration] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE repair_episodes ADD COLUMN ${name} ${declaration}`);
  }
}

/** Failure classes `isBreakerOpen` treats as security events; such a row is never re-admitted. */
const READMIT_BLOCKING_FAILURES: ReadonlySet<string> = new Set([
  'wrong-identity', 'unexpected-origin', 'permission-expansion', 'captcha', 'phone-confirmation',
]);

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
    ensureRepairEpisodeColumns(this.db);
    ensureRepairEventColumns(this.db);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${this.dbPath}${suffix}`; if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
    this.unregister = registerSqliteHandle(() => { try { this.close(); } catch { /* already closed */ } });
    this.prune();
  }

  suggest(input: {
    sourceEpisodeId: number; accountId: string; machineId: string; mode: SubscriptionReloginMode;
    inputDigest: string; profileId: string; framework: string; provider: string; at?: string;
    /** The admitted login method; recorded so graduation evidence can be scoped per method. */
    loginMethod?: string | null;
  }): SubscriptionReloginEpisode {
    const at = input.at ?? this.isoNow();
    const loginMethod = typeof input.loginMethod === 'string' && input.loginMethod.length > 0
      ? input.loginMethod.slice(0, 64) : null;
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
      if (prior) {
        // One row per source incident. When the admitted inputs have CHANGED since that row was
        // written (a profile was added, the account joined the unattended list, …), a suggestion
        // can never be approved and a failure can never be retried — both check the stored digest
        // — so the incident would stay unrepaired until it closed. Re-admit the row under the new
        // inputs instead. Unchanged inputs keep today's answer: a deliberate cancel stays cancelled
        // and a failure waits for an operator retry. `refused` (a safety verdict) and `succeeded`
        // are never re-admitted.
        // A failure carrying a security class is breaker evidence (`isBreakerOpen` reads these rows);
        // re-admitting it would erase that evidence, so it stays terminal like `refused`.
        const securityFailure = prior.failureClass !== null && READMIT_BLOCKING_FAILURES.has(prior.failureClass);
        const readmittable = (prior.state === 'suggested' || prior.state === 'cancelled' || prior.state === 'failed')
          && !securityFailure;
        if (!readmittable || prior.inputDigest === input.inputDigest) return coerceEpisode(prior);
        const otherLive = this.db.prepare(`SELECT id FROM repair_episodes WHERE accountId=? AND machineId=? AND id<>?
          AND state NOT IN ('succeeded','refused','cancelled','failed')`).get(account, machine, prior.id);
        if (otherLive) throw new SubscriptionReloginConflictError('live-repair-already-owns-cell');
        this.db.prepare(`UPDATE repair_episodes SET mode=?,state='suggested',inputDigest=?,profileId=?,framework=?,
          provider=?,loginMethod=?,attemptCount=0,reissueCount=0,approvedAt=NULL,approvalExpiresAt=NULL,startedAt=NULL,
          finishedAt=NULL,nextAttemptAt=NULL,failureClass=NULL,version=version+1,updatedAt=? WHERE id=?`)
          .run(input.mode, input.inputDigest, profile, framework, provider, loginMethod, at, prior.id);
        this.event(prior.id, at, prior.state, 'suggested', 'candidate-readmitted-inputs-changed', 0);
        // Notifications are keyed (episode, kind); clear the prior outcome's rows so this
        // admission's suggestion and outcome are delivered rather than silently deduplicated. A row
        // mid-delivery is left alone so its in-flight completion still finds its claim.
        this.db.prepare(`D${'ELETE'} FROM repair_notifications WHERE episodeId=? AND state<>'delivering'`).run(prior.id);
        if (input.mode === 'approval') this.enqueueNotification(prior.id, 'suggested', at);
        return this.mustGet(prior.id);
      }
      const live = this.db.prepare(`SELECT id FROM repair_episodes WHERE accountId=? AND machineId=?
        AND state NOT IN ('succeeded','refused','cancelled','failed')`).get(account, machine);
      if (live) throw new SubscriptionReloginConflictError('live-repair-already-owns-cell');
      const id = normalizeId(this.idFactory(), 'episode');
      this.db.prepare(`INSERT INTO repair_episodes(
        id,sourceEpisodeId,accountId,machineId,mode,state,inputDigest,profileId,framework,provider,
        attemptCount,reissueCount,version,createdAt,updatedAt,loginMethod)
        VALUES(?,?,?,?,?,'suggested',?,?,?,?,0,0,1,?,?,?)`)
        .run(id, source, account, machine, input.mode, input.inputDigest, profile, framework, provider, at, at, loginMethod);
      this.event(id, at, null, 'suggested', 'candidate-admitted', 0);
      if (input.mode === 'approval') this.enqueueNotification(id, 'suggested', at);
      this.enforceCaps();
      return this.mustGet(id);
    })();
  }

  approve(id: string, input: { inputDigest: string; at?: string; ttlMs?: number;
    authority?: 'operator' | 'unattended-policy' }): SubscriptionReloginEpisode {
    const ep = this.mustGet(id);
    if (ep.inputDigest !== input.inputDigest) throw new SubscriptionReloginConflictError('approval-input-digest-mismatch');
    if (ep.state !== 'suggested' && ep.state !== 'waiting-operator-only')
      throw new SubscriptionReloginConflictError('episode-not-approvable');
    const at = input.at ?? this.isoNow();
    const ttl = Math.max(1, Math.min(3_600_000, Math.floor(input.ttlMs ?? 900_000)));
    return this.transition(id, { expectedVersion: ep.version, to: 'approved', at,
      eventClass: input.authority === 'unattended-policy'
        ? 'unattended-policy-approved'
        : (ep.state === 'suggested' ? 'operator-approved' : 'operator-resumed'),
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

  /**
   * Keep an approved-but-queued episode's approval alive while it waits its turn for the machine's
   * one helper seat (spec skill-driven-signin-repair §2). Version-checked; never extends past 60
   * minutes after the operator's approval, and only while the episode is still `approved` and no
   * attempt has started. Returns the (possibly unchanged) episode.
   */
  extendApproval(id: string, expectedVersion: number, until: string, at = this.isoNow()): SubscriptionReloginEpisode {
    return this.db.transaction(() => {
      const ep = this.mustGet(id);
      if (ep.version !== expectedVersion) throw new SubscriptionReloginConflictError('episode-version-conflict');
      if (ep.state !== 'approved' || ep.startedAt || !ep.approvedAt) return ep;
      const cap = Date.parse(ep.approvedAt) + APPROVAL_EXTENSION_CAP_MS;
      const wanted = Date.parse(until);
      if (!Number.isFinite(wanted) || !Number.isFinite(cap)) throw new Error('invalid-approval-extension');
      const target = Math.min(wanted, cap);
      const current = ep.approvalExpiresAt ? Date.parse(ep.approvalExpiresAt) : 0;
      if (target <= current) return ep;
      const info = this.db.prepare(`UPDATE repair_episodes SET approvalExpiresAt=?,version=version+1,updatedAt=?
        WHERE id=? AND version=?`).run(new Date(target).toISOString(), at, ep.id, ep.version);
      if (info.changes !== 1) throw new SubscriptionReloginConflictError('episode-version-conflict');
      return this.mustGet(ep.id);
    })();
  }

  /**
   * Queue the fixed "tap Yes on your phone" notice for this episode (spec skill-driven-signin-repair,
   * operator contact). Idempotent within an attempt: the notice row is unique per (episode, kind) and
   * cleared at the start of the next attempt.
   */
  enqueuePhoneTap(id: string, at = this.isoNow()): void {
    const ep = this.mustGet(id);
    this.enqueueNotification(ep.id, 'phone-tap', at);
  }

  transition(id: string, input: {
    expectedVersion: number; to: SubscriptionReloginState; eventClass: string; at?: string;
    failureClass?: SubscriptionReloginFailureClass; nextAttemptAt?: string | null;
    incrementAttempt?: boolean; incrementReissue?: boolean; approvedAt?: string;
    approvalExpiresAt?: string; clearFailure?: boolean; resetBudgets?: boolean;
    /** Why this transition happened, as a short machine token (see {@link reloginReasonToken}). */
    reason?: string | null;
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
      this.event(ep.id, at, ep.state, input.to, input.eventClass, attempt, reloginReasonToken(input.reason));
      // A new attempt may need its own phone-tap / operator-only notice. Notice rows are unique per
      // (episode, kind), so the prior attempt's rows are cleared here (a row mid-delivery is kept so
      // its in-flight completion still finds its claim).
      if (ep.state === 'approved' && input.to === 'cli-starting') {
        this.db.prepare(`D${'ELETE'} FROM repair_notifications WHERE episodeId=? AND kind IN ('phone-tap','operator-only')
          AND state<>'delivering'`).run(ep.id);
      }
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
  /**
   * Close an open repair whose account×machine cell the server has since verified healthy by
   * another path (signed in by hand, from the phone, …). Goes through the store's own audited
   * transition to the terminal `cancelled` state with failure class `resolved-elsewhere` — never a
   * raw delete, never counted as a repair success (graduation evidence) or a failure (breaker).
   */
  resolveElsewhere(id: string, at = this.isoNow()): SubscriptionReloginEpisode {
    const ep = this.mustGet(id); if (TERMINAL.has(ep.state)) return ep;
    return this.transition(id, { expectedVersion: ep.version, to: 'cancelled', at,
      eventClass: 'resolved-elsewhere', failureClass: 'resolved-elsewhere' });
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
  /**
   * Authoritative aggregate over every retained episode; never use the bounded display list for policy.
   * With `loginMethod`, ONLY the success count and `oldestSuccessAt` are scoped to that method (a
   * method change resets graduation evidence); `identityMismatches` and `unexpectedOrigins` stay
   * counted across ALL methods, so switching method never erases an account's bad history. Rows
   * from before the column existed carry no method: they count for a legacy method (they can only
   * have been produced by one) and never for `google-passkey`.
   */
  getUnattendedEvidence(accountId: string, machineId: string, provider: string,
    framework: string, loginMethod?: string | null): SubscriptionReloginEvidence {
    const method = typeof loginMethod === 'string' && loginMethod.length > 0 ? loginMethod : null;
    const legacyRowsCount = method !== null && method !== 'google-passkey' ? 1 : 0;
    const successScope = method === null ? '1' : '(loginMethod=? OR (loginMethod IS NULL AND ?=1))';
    const scopeParams = method === null ? [] : [method, legacyRowsCount];
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN state='succeeded' AND ${successScope} THEN 1 ELSE 0 END) successfulRepairs,
      MIN(CASE WHEN state='succeeded' AND ${successScope} THEN finishedAt ELSE NULL END) oldestSuccessAt,
      SUM(CASE WHEN failureClass='wrong-identity' THEN 1 ELSE 0 END) identityMismatches,
      SUM(CASE WHEN failureClass IN ('unexpected-origin','permission-expansion') THEN 1 ELSE 0 END) unexpectedOrigins
      FROM repair_episodes WHERE accountId=? AND machineId=? AND provider=? AND framework=?`)
      .get(...scopeParams, ...scopeParams, normalizeId(accountId, 'account'), normalizeId(machineId, 'machine'),
        normalizeId(provider, 'provider'), normalizeId(framework, 'framework')) as Record<string, unknown>;
    return {
      successfulRepairs: Number(row.successfulRepairs ?? 0),
      oldestSuccessAt: typeof row.oldestSuccessAt === 'string' ? row.oldestSuccessAt : null,
      identityMismatches: Number(row.identityMismatches ?? 0),
      unexpectedOrigins: Number(row.unexpectedOrigins ?? 0),
    };
  }
  isBreakerOpen(accountId: string, provider: string, windowMs = 24 * 60 * 60_000, threshold = 3): boolean {
    const account = normalizeId(accountId, 'account');
    const normalizedProvider = normalizeId(provider, 'provider');
    const cutoff = new Date(this.now() - Math.max(60_000, Math.min(7 * 24 * 60 * 60_000, windowMs))).toISOString();
    const success = this.db.prepare(`SELECT finishedAt FROM repair_episodes WHERE accountId=? AND provider=?
      AND state='succeeded' AND finishedAt>=? ORDER BY finishedAt DESC LIMIT 1`)
      .get(account, normalizedProvider, cutoff) as { finishedAt: string } | undefined;
    const since = success?.finishedAt ?? cutoff;
    const securityEvent = this.db.prepare(`SELECT 1 present FROM repair_episodes WHERE accountId=? AND provider=?
      AND state IN ('failed','refused') AND finishedAt>?
      AND failureClass IN ('wrong-identity','unexpected-origin','permission-expansion','captcha','phone-confirmation')
      LIMIT 1`).get(account, normalizedProvider, since);
    if (securityEvent) return true;
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
    to: SubscriptionReloginState, cls: string, attempt: number, reason: string | null = null): void {
    this.db.prepare('INSERT INTO repair_events(episodeId,at,fromState,toState,eventClass,attempt,reason) VALUES(?,?,?,?,?,?,?)')
      .run(id, at, from, to, normalizeEvent(cls), attempt, reason);
  }
  private enqueueNotification(id: string, kind: SubscriptionReloginNotification['kind'], at: string): void {
    // The delivery key (also the attention-item id) carries the attempt number, so a notice
    // re-inserted for a later attempt is not de-duplicated away downstream.
    const attempt = Number((this.db.prepare('SELECT attemptCount FROM repair_episodes WHERE id=?').get(id) as
      { attemptCount: number } | undefined)?.attemptCount ?? 0);
    let key = `subscription-relogin:${id}:${kind}:${attempt}`;
    if (kind === 'operator-only') {
      // A second operator-only reason within ONE attempt (e.g. no-healthy-seat, an operator resume,
      // then no-healthy-seat again) is its own notice: replace an already-delivered row, and give
      // the new one a distinct key so the attention layer does not de-duplicate it away.
      const prior = this.db.prepare(`SELECT state, deliveryKey FROM repair_notifications WHERE episodeId=? AND kind='operator-only'`)
        .get(id) as { state: string; deliveryKey: string } | undefined;
      if (prior && prior.state === 'delivered') {
        const entries = Number((this.db.prepare(`SELECT COUNT(*) n FROM repair_events WHERE episodeId=? AND toState='waiting-operator-only'
          AND attempt=?`).get(id, attempt) as { n: number }).n);
        this.db.prepare(`D${'ELETE'} FROM repair_notifications WHERE episodeId=? AND kind='operator-only' AND state='delivered'`).run(id);
        key = `${key}.${entries}`;
      }
    }
    this.db.prepare(`INSERT OR IGNORE INTO repair_notifications(
      episodeId,kind,deliveryKey,state,attemptCount,nextAttemptAt,createdAt)
      VALUES(?,?,?,'pending',0,?,?)`).run(id, kind, key, at, at);
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
/**
 * A repair reason is recorded only as a short machine token from the code's own error names
 * (`chrome-launch-timeout`, `plain-browser-apple-event-error--1743`, `relogin-profile-in-use`, ...).
 * Anything else — free text, a value that could carry page content — becomes `unclassified`, so the
 * audit can explain a failure remotely without ever holding page text or a secret.
 */
export function reloginReasonToken(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  return /^(chrome|plain-browser|relogin|browser|cdp|agent|drive|hold|consent|navigat)[a-z0-9-]{0,70}$/.test(v) ? v : 'unclassified';
}

function normalizeEvent(value: string): string {
  const v = String(value ?? '').trim(); if (!/^[a-z0-9-]{1,80}$/.test(v)) throw new Error('invalid-event-class'); return v;
}
function coerceEpisode(row: SubscriptionReloginEpisode): SubscriptionReloginEpisode {
  return { ...row, sourceEpisodeId: Number(row.sourceEpisodeId), attemptCount: Number(row.attemptCount),
    reissueCount: Number(row.reissueCount), version: Number(row.version) };
}
