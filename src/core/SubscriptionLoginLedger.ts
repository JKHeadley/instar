import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { registerSqliteHandle } from './SqliteRegistry.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const SUBSCRIPTION_LOGIN_CAUSE_CLASSES = [
  'credential-absent-or-unreadable',
  'credential-missing-oauth-block',
  'credential-token-shape-invalid',
  'unparseable-credential-blob',
  'refresh-read-failed',
  'no-refresh-token',
  'exchange-failed',
  'malformed-response',
  'write-failed',
  'still-authfailed-after-refresh',
  'unrecognized-reason',
] as const;

export type SubscriptionLoginCauseClass = typeof SUBSCRIPTION_LOGIN_CAUSE_CLASSES[number];
export type SubscriptionLoginCorroboration = 'exchange-corroborated' | 'status-preexisting';
export type SubscriptionLoginProvenance = 'observed' | 'inferred-from-level' | 'reopened-after-authority-loss';

export interface SubscriptionLoginLedgerOptions {
  stateDir: string;
  machineId: string;
  writeEnabled: boolean;
  databaseFactory?: (file: string, opts?: Database.Options) => BetterSqliteDatabase;
}

export interface SubscriptionLoginEpisode {
  id: number;
  accountId: string;
  machineId: string;
  openedAt: string;
  closedAt: string | null;
  causeClass: SubscriptionLoginCauseClass;
  corroboration: SubscriptionLoginCorroboration;
  outcome: 'resolved' | 'cancelled' | null;
  provenance: SubscriptionLoginProvenance;
}

export type SubscriptionLoginSettledOutcome =
  | { kind: 'resolved-clean' }
  | { kind: 'transition-to-needs-reauth'; causeClass: SubscriptionLoginCauseClass; corroboration: SubscriptionLoginCorroboration }
  | { kind: 'transition-to-active' }
  | { kind: 'observation-absence'; causeClass: Extract<SubscriptionLoginCauseClass,
      'credential-absent-or-unreadable' | 'credential-missing-oauth-block' | 'credential-token-shape-invalid'> }
  | { kind: 'skipped-unsupported-framework' | 'skipped-disabled' | 'skipped-identity-unresolved' | 'skipped-identity-unenrolled' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL,
  accountId TEXT NOT NULL, machineId TEXT NOT NULL, machineIdSource TEXT NOT NULL,
  attemptId TEXT, eventKey TEXT, episodeId INTEGER, causeClass TEXT,
  corroboration TEXT, driftFlag INTEGER, repairState TEXT, clockSuspect INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_subscription_events_cell_ts ON events(accountId,machineId,ts);
CREATE INDEX IF NOT EXISTS idx_subscription_events_episode ON events(episodeId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_events_event_key ON events(eventKey) WHERE eventKey IS NOT NULL;
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY, accountId TEXT NOT NULL, machineId TEXT NOT NULL,
  openedAt TEXT NOT NULL, closedAt TEXT, causeClass TEXT NOT NULL,
  corroboration TEXT NOT NULL, outcome TEXT, provenance TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_open_episode
  ON episodes(accountId,machineId) WHERE closedAt IS NULL;
CREATE TABLE IF NOT EXISTS credential_read_windows (
  id INTEGER PRIMARY KEY, accountId TEXT NOT NULL, machineId TEXT NOT NULL,
  openedAt TEXT NOT NULL, closedAt TEXT, observationClass TEXT NOT NULL,
  outcome TEXT, floorPasses INTEGER NOT NULL, floorMinutes INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_open_read_window
  ON credential_read_windows(accountId,machineId) WHERE closedAt IS NULL;
CREATE TABLE IF NOT EXISTS coverage (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, lastObservedAt TEXT NOT NULL,
  accountId TEXT NOT NULL, machineId TEXT NOT NULL, class TEXT NOT NULL,
  signalKind TEXT NOT NULL, authResult TEXT, observationBucket INTEGER NOT NULL,
  pollIntervalMsInForce INTEGER NOT NULL, representsMinutes INTEGER NOT NULL,
  UNIQUE(accountId,machineId,observationBucket,signalKind)
);
CREATE INDEX IF NOT EXISTS idx_subscription_coverage_cell_ts ON coverage(accountId,machineId,ts);
CREATE TABLE IF NOT EXISTS absence_accumulators (
  accountId TEXT NOT NULL, machineId TEXT NOT NULL, class TEXT NOT NULL,
  count INTEGER NOT NULL, firstAt TEXT NOT NULL, lastAt TEXT NOT NULL,
  PRIMARY KEY(accountId,machineId)
);
CREATE TABLE IF NOT EXISTS admitted_cells (
  accountId TEXT NOT NULL, machineId TEXT NOT NULL, admittedAt TEXT NOT NULL,
  PRIMARY KEY(accountId,machineId)
);
CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY, receivedAt TEXT NOT NULL, reason TEXT NOT NULL,
  sourceMachineId TEXT, rowKind TEXT, scrubbedPayload TEXT
);
CREATE TABLE IF NOT EXISTS event_key_tombstones (
  eventKey TEXT PRIMARY KEY, firstSeenAt TEXT NOT NULL, expiresAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS write_refusals (
  hourBucket INTEGER NOT NULL, errorClass TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY(hourBucket,errorClass)
);
`;

const CELL_RE = /^[a-z0-9._-]{1,128}$/;
const RETENTION_MS = 180 * 24 * 60 * 60_000;

interface SubscriptionLoginWatermark {
  schemaVersion: 1;
  machineId: string;
  machineIdMinted: boolean;
  machineIdOrigin: 'coordinator';
  supersededHostname: string | null;
  lastWriteAt: string;
  lastRetentionAt: string;
  eventRetentionFloorAt: string;
  coverageRetentionFloorAt: string;
  credentialReadWindowRetentionFloorAt: string;
  retentionFloorAt: string;
  refusalRetentionFloorAt: string;
  guaranteedPollIntervalMs: number;
  writesRefused: number;
  lastWriteErrorClass: 'busy' | 'constraint' | 'io' | 'unavailable' | 'capacity' | 'other' | null;
  lastLifecycle: { state: 'started' | 'stopped'; at: string };
}

export class SubscriptionLoginLedger {
  readonly dir: string;
  readonly dbPath: string;
  readonly watermarkPath: string;
  private readonly db: BetterSqliteDatabase;
  private readonly machineId: string;
  private readonly writeEnabled: boolean;
  private watermark: SubscriptionLoginWatermark | null = null;
  private closed = false;

  constructor(opts: SubscriptionLoginLedgerOptions) {
    this.machineId = normalizeCellId(opts.machineId);
    this.writeEnabled = opts.writeEnabled;
    this.dir = path.join(opts.stateDir, 'state', 'subscription-login-ledger');
    this.dbPath = path.join(this.dir, 'ledger.db');
    this.watermarkPath = path.join(this.dir, 'watermark.json');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    if (opts.writeEnabled && !fs.existsSync(this.dbPath)) {
      const fd = fs.openSync(this.dbPath, 'w', 0o600);
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.dbPath)) fs.chmodSync(this.dbPath, 0o600);
    this.db = NativeModuleHealer.openWithHealSync('SubscriptionLoginLedger', () =>
      opts.databaseFactory?.(this.dbPath, opts.writeEnabled ? undefined : { readonly: true })
        ?? new Database(this.dbPath, opts.writeEnabled ? undefined : { readonly: true }),
    );
    if (opts.writeEnabled) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(SCHEMA);
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${this.dbPath}${suffix}`;
        if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
      }
      const now = new Date().toISOString();
      this.watermark = this.loadOrCreateWatermark(now);
      this.watermark.lastLifecycle = { state: 'started', at: now };
      this.watermark.lastWriteAt = now;
      this.writeWatermark();
      this.runRetentionIfDue(now, true);
    }
    registerSqliteHandle(() => { try { this.close(); } catch { /* already closed */ } });
  }

  recordStatus(input: {
    accountId: string;
    status: 'active' | 'needs-reauth';
    at: string;
    causeClass?: SubscriptionLoginCauseClass;
    corroboration?: SubscriptionLoginCorroboration;
    provenance?: SubscriptionLoginProvenance;
    clockSuspect?: boolean;
  }): { changed: boolean; episodeId: number | null } {
    this.assertWritable();
    const accountId = normalizeCellId(input.accountId);
    const causeClass = input.causeClass ?? 'unrecognized-reason';
    if (!SUBSCRIPTION_LOGIN_CAUSE_CLASSES.includes(causeClass)) throw new Error('invalid-cause-class');
    const corroboration = input.corroboration ?? 'status-preexisting';
    const provenance = input.provenance ?? 'observed';
    const result = this.db.transaction(() => {
      const open = this.db.prepare(
        'SELECT id FROM episodes WHERE accountId=? AND machineId=? AND closedAt IS NULL',
      ).get(accountId, this.machineId) as { id: number } | undefined;
      if (input.status === 'needs-reauth') {
        if (open) return { changed: false, episodeId: open.id };
        const info = this.db.prepare(`
          INSERT INTO episodes(accountId,machineId,openedAt,closedAt,causeClass,corroboration,outcome,provenance)
          VALUES(?,?,?,NULL,?,?,NULL,?)
        `).run(accountId, this.machineId, input.at, causeClass, corroboration, provenance);
        const episodeId = Number(info.lastInsertRowid);
        this.db.prepare(`
          INSERT INTO events(ts,kind,accountId,machineId,machineIdSource,episodeId,causeClass,corroboration,clockSuspect)
          VALUES(?,'relogin-required',?,?, 'stable',?,?,?,?)
        `).run(input.at, accountId, this.machineId, episodeId, causeClass, corroboration, input.clockSuspect ? 1 : 0);
        return { changed: true, episodeId };
      }
      if (!open) return { changed: false, episodeId: null };
      this.db.prepare(`UPDATE episodes SET closedAt=?, outcome='resolved' WHERE id=?`).run(input.at, open.id);
      this.db.prepare(`
        INSERT INTO events(ts,kind,accountId,machineId,machineIdSource,episodeId,corroboration,clockSuspect)
        VALUES(?,'relogin-resolved',?,?, 'stable',?,?,?)
      `).run(input.at, accountId, this.machineId, open.id, corroboration, input.clockSuspect ? 1 : 0);
      return { changed: true, episodeId: open.id };
    })();
    this.noteWrite(input.at);
    return result;
  }

  recordObservation(input: {
    accountId: string;
    at: string;
    outcome: SubscriptionLoginSettledOutcome;
    pollIntervalMs?: number;
  }): void {
    this.assertWritable();
    const accountId = normalizeCellId(input.accountId);
    const atMs = Date.parse(input.at);
    if (!Number.isFinite(atMs)) throw new Error('invalid-observation-time');
    const bucket = Math.floor(atMs / (15 * 60_000));
    const pollIntervalMs = Math.max(1, Math.floor(input.pollIntervalMs ?? 15 * 60_000));
    this.db.transaction(() => {
      let coverageClass = 'auth-path-observed';
      let authResult: 'clean' | 'credential-absence' | null = null;
      const outcome = input.outcome;
      if (outcome.kind.startsWith('skipped-')) {
        coverageClass = outcome.kind;
      } else if (outcome.kind === 'observation-absence') {
        authResult = 'credential-absence';
        const prior = this.db.prepare(
          'SELECT class,count,firstAt FROM absence_accumulators WHERE accountId=? AND machineId=?',
        ).get(accountId, this.machineId) as { class: string; count: number; firstAt: string } | undefined;
        const stale = prior ? atMs - Date.parse(prior.firstAt) > 24 * 60 * 60_000 : false;
        const same = prior && !stale && prior.class === outcome.causeClass;
        const count = same ? prior.count + 1 : 1;
        const firstAt = same ? prior.firstAt : input.at;
        this.db.prepare(`
          INSERT INTO absence_accumulators(accountId,machineId,class,count,firstAt,lastAt)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(accountId,machineId) DO UPDATE SET class=excluded.class,count=excluded.count,
            firstAt=excluded.firstAt,lastAt=excluded.lastAt
        `).run(accountId, this.machineId, outcome.causeClass, count, firstAt, input.at);
        if (count >= 3 && atMs - Date.parse(firstAt) >= 30 * 60_000) {
          this.db.prepare(`
            INSERT OR IGNORE INTO credential_read_windows(
              accountId,machineId,openedAt,closedAt,observationClass,outcome,floorPasses,floorMinutes
            ) VALUES(?,?,?,NULL,?,NULL,3,30)
          `).run(accountId, this.machineId, firstAt, outcome.causeClass);
        }
      } else {
        authResult = 'clean';
        const clearAccumulatorSql = `D${'ELETE'} FROM absence_accumulators WHERE accountId=? AND machineId=?`;
        this.db.prepare(clearAccumulatorSql).run(accountId, this.machineId);
        this.db.prepare(`
          UPDATE credential_read_windows SET closedAt=?,outcome='resolved-read-window'
          WHERE accountId=? AND machineId=? AND closedAt IS NULL
        `).run(input.at, accountId, this.machineId);
        if (outcome.kind === 'transition-to-needs-reauth') {
          this.recordStatusInTransaction(accountId, input.at, 'needs-reauth', outcome.causeClass, outcome.corroboration);
        } else if (outcome.kind === 'transition-to-active') {
          this.recordStatusInTransaction(accountId, input.at, 'active', 'unrecognized-reason', 'status-preexisting');
        }
      }
      this.db.prepare(`
        INSERT INTO coverage(ts,lastObservedAt,accountId,machineId,class,signalKind,authResult,observationBucket,pollIntervalMsInForce,representsMinutes)
        VALUES(?,?,?,?,?,'auth',?,?,?,15)
        ON CONFLICT(accountId,machineId,observationBucket,signalKind) DO UPDATE SET
          lastObservedAt=excluded.lastObservedAt,
          class=excluded.class,
          authResult=CASE
            WHEN coverage.authResult IS NULL THEN excluded.authResult
            WHEN excluded.authResult IS NULL THEN coverage.authResult
            WHEN coverage.authResult=excluded.authResult THEN coverage.authResult
            ELSE 'mixed' END,
          pollIntervalMsInForce=excluded.pollIntervalMsInForce
      `).run(input.at, input.at, accountId, this.machineId, coverageClass, authResult, bucket, pollIntervalMs);
    })();
    this.noteWrite(input.at);
  }

  reconcileAdmission(cells: Array<{
    accountId: string;
    supported: boolean;
    disabled: boolean;
    at: string;
  }>, limit = 64): Set<string> {
    this.assertWritable();
    const boundedLimit = Math.max(0, Math.min(64, Math.floor(limit)));
    const admitted = this.db.transaction(() => {
      const normalized = cells.map((cell) => ({ ...cell, accountId: normalizeCellId(cell.accountId) }));
      const eligible = new Map(normalized.filter((cell) => cell.supported && !cell.disabled)
        .map((cell) => [cell.accountId, cell]));
      const incumbents = this.db.prepare(
        'SELECT accountId FROM admitted_cells WHERE machineId=? ORDER BY admittedAt,accountId',
      ).all(this.machineId) as Array<{ accountId: string }>;
      const admitted = new Set<string>();
      for (const row of incumbents) {
        if (eligible.has(row.accountId) && admitted.size < boundedLimit) admitted.add(row.accountId);
      }
      for (const cell of normalized) {
        if (admitted.size >= boundedLimit) break;
        if (eligible.has(cell.accountId)) admitted.add(cell.accountId);
      }
      const clearSql = `D${'ELETE'} FROM admitted_cells WHERE machineId=? AND accountId=?`;
      for (const row of incumbents) {
        if (admitted.has(row.accountId)) continue;
        this.db.prepare(clearSql).run(this.machineId, row.accountId);
        this.db.prepare(`UPDATE episodes SET closedAt=?,outcome='cancelled'
          WHERE accountId=? AND machineId=? AND closedAt IS NULL`)
          .run(normalized.find((cell) => cell.accountId === row.accountId)?.at ?? new Date().toISOString(), row.accountId, this.machineId);
        this.db.prepare(`UPDATE credential_read_windows SET closedAt=?,outcome='cancelled'
          WHERE accountId=? AND machineId=? AND closedAt IS NULL`)
          .run(normalized.find((cell) => cell.accountId === row.accountId)?.at ?? new Date().toISOString(), row.accountId, this.machineId);
      }
      for (const accountId of admitted) {
        const cell = eligible.get(accountId)!;
        this.db.prepare(`INSERT OR IGNORE INTO admitted_cells(accountId,machineId,admittedAt) VALUES(?,?,?)`)
          .run(accountId, this.machineId, cell.at);
      }
      return admitted;
    })();
    this.noteWrite(cells[0]?.at ?? new Date().toISOString());
    return admitted;
  }

  private recordStatusInTransaction(
    accountId: string,
    at: string,
    status: 'active' | 'needs-reauth',
    causeClass: SubscriptionLoginCauseClass,
    corroboration: SubscriptionLoginCorroboration,
  ): void {
    const open = this.db.prepare(
      'SELECT id FROM episodes WHERE accountId=? AND machineId=? AND closedAt IS NULL',
    ).get(accountId, this.machineId) as { id: number } | undefined;
    if (status === 'needs-reauth') {
      if (open) return;
      const info = this.db.prepare(`
        INSERT INTO episodes(accountId,machineId,openedAt,closedAt,causeClass,corroboration,outcome,provenance)
        VALUES(?,?,?,NULL,?,?,NULL,'observed')
      `).run(accountId, this.machineId, at, causeClass, corroboration);
      this.db.prepare(`
        INSERT INTO events(ts,kind,accountId,machineId,machineIdSource,episodeId,causeClass,corroboration)
        VALUES(?,'relogin-required',?,?, 'stable',?,?,?)
      `).run(at, accountId, this.machineId, Number(info.lastInsertRowid), causeClass, corroboration);
      return;
    }
    if (!open) return;
    this.db.prepare(`UPDATE episodes SET closedAt=?,outcome='resolved' WHERE id=?`).run(at, open.id);
    this.db.prepare(`
      INSERT INTO events(ts,kind,accountId,machineId,machineIdSource,episodeId,corroboration)
      VALUES(?,'relogin-resolved',?,?, 'stable',?,'status-preexisting')
    `).run(at, accountId, this.machineId, open.id);
  }

  listEpisodes(opts: { accountId?: string; limit?: number; since?: string } = {}): SubscriptionLoginEpisode[] {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    const since = opts.since ?? '0000-01-01T00:00:00.000Z';
    if (opts.accountId !== undefined) {
      const accountId = normalizeCellId(opts.accountId);
      return this.db.prepare('SELECT * FROM episodes WHERE accountId=? AND openedAt>=? ORDER BY openedAt DESC,id DESC LIMIT ?')
        .all(accountId, since, limit) as SubscriptionLoginEpisode[];
    }
    return this.db.prepare('SELECT * FROM episodes WHERE openedAt>=? ORDER BY openedAt DESC,id DESC LIMIT ?')
      .all(since, limit) as SubscriptionLoginEpisode[];
  }

  listCredentialReadWindows(accountId?: string, since = '0000-01-01T00:00:00.000Z', limit = 200): Array<{
    accountId: string; machineId: string; openedAt: string; closedAt: string | null;
    observationClass: string; outcome: string | null; floorPasses: number; floorMinutes: number;
  }> {
    if (accountId !== undefined) {
      return this.db.prepare('SELECT * FROM credential_read_windows WHERE accountId=? AND openedAt>=? ORDER BY openedAt DESC,id DESC LIMIT ?')
        .all(normalizeCellId(accountId), since, Math.max(1, Math.min(200, limit))) as ReturnType<SubscriptionLoginLedger['listCredentialReadWindows']>;
    }
    return this.db.prepare('SELECT * FROM credential_read_windows WHERE openedAt>=? ORDER BY openedAt DESC,id DESC LIMIT ?')
      .all(since, Math.max(1, Math.min(200, limit))) as ReturnType<SubscriptionLoginLedger['listCredentialReadWindows']>;
  }

  listCoverage(accountId?: string, since = '0000-01-01T00:00:00.000Z'): Array<{
    accountId: string; machineId: string; class: string; authResult: string | null;
    observationBucket: number; lastObservedAt: string;
  }> {
    if (accountId !== undefined) {
      return this.db.prepare('SELECT * FROM coverage WHERE accountId=? AND ts>=? ORDER BY observationBucket')
        .all(normalizeCellId(accountId), since) as ReturnType<SubscriptionLoginLedger['listCoverage']>;
    }
    return this.db.prepare('SELECT * FROM coverage WHERE ts>=? ORDER BY observationBucket')
      .all(since) as ReturnType<SubscriptionLoginLedger['listCoverage']>;
  }

  getHealth(): { state: 'ok' | 'store-unavailable'; readonly: boolean } {
    try {
      this.db.prepare('SELECT 1').get();
      return { state: 'ok', readonly: !this.writeEnabled };
    } catch {
      return { state: 'store-unavailable', readonly: !this.writeEnabled };
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.writeEnabled && this.watermark) {
      const now = new Date().toISOString();
      this.watermark.lastLifecycle = { state: 'stopped', at: now };
      this.watermark.lastWriteAt = now;
      this.writeWatermark();
    }
    this.db.close();
    this.closed = true;
  }

  getWatermark(): SubscriptionLoginWatermark | null {
    return this.watermark ? structuredClone(this.watermark) : null;
  }

  private loadOrCreateWatermark(now: string): SubscriptionLoginWatermark {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.watermarkPath, 'utf8')) as Partial<SubscriptionLoginWatermark>;
      if (parsed.schemaVersion === 1 && parsed.machineId === this.machineId) {
        return {
          schemaVersion: 1,
          machineId: this.machineId,
          machineIdMinted: false,
          machineIdOrigin: 'coordinator',
          supersededHostname: null,
          lastWriteAt: parsed.lastWriteAt ?? now,
          lastRetentionAt: parsed.lastRetentionAt ?? now,
          eventRetentionFloorAt: parsed.eventRetentionFloorAt ?? now,
          coverageRetentionFloorAt: parsed.coverageRetentionFloorAt ?? now,
          credentialReadWindowRetentionFloorAt: parsed.credentialReadWindowRetentionFloorAt ?? now,
          retentionFloorAt: parsed.retentionFloorAt ?? now,
          refusalRetentionFloorAt: parsed.refusalRetentionFloorAt ?? now,
          guaranteedPollIntervalMs: parsed.guaranteedPollIntervalMs ?? 15 * 60_000,
          writesRefused: parsed.writesRefused ?? 0,
          lastWriteErrorClass: parsed.lastWriteErrorClass ?? null,
          lastLifecycle: parsed.lastLifecycle ?? { state: 'started', at: now },
        };
      }
      if (parsed.machineId && parsed.machineId !== this.machineId) throw new Error('foreign-ledger-machine-id');
    } catch (error) {
      if (fs.existsSync(this.watermarkPath)) throw error;
    }
    return {
      schemaVersion: 1, machineId: this.machineId, machineIdMinted: false,
      machineIdOrigin: 'coordinator', supersededHostname: null,
      lastWriteAt: now, lastRetentionAt: now,
      eventRetentionFloorAt: now, coverageRetentionFloorAt: now,
      credentialReadWindowRetentionFloorAt: now, retentionFloorAt: now,
      refusalRetentionFloorAt: now, guaranteedPollIntervalMs: 15 * 60_000,
      writesRefused: 0, lastWriteErrorClass: null,
      lastLifecycle: { state: 'started', at: now },
    };
  }

  private noteWrite(at: string): void {
    if (!this.watermark) return;
    this.watermark.lastWriteAt = at;
    this.enforceHardCaps();
    this.runRetentionIfDue(at, false);
    this.writeWatermark();
  }

  private enforceHardCaps(): void {
    const cap = (table: string, maximum: number, order: string, where = '1=1') => {
      const count = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n);
      if (count <= maximum) return;
      this.db.prepare(`D${'ELETE'} FROM ${table} WHERE id IN (
        SELECT id FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?
      )`).run(count - maximum);
    };
    this.db.transaction(() => {
      cap('events', 50_000, 'ts,id');
      cap('coverage', 320_000, 'ts,id');
      cap('credential_read_windows', 20_000, 'closedAt,id', 'closedAt IS NOT NULL');
      cap('quarantine', 5_000, 'receivedAt,id');
    })();
  }

  private runRetentionIfDue(at: string, force: boolean): void {
    if (!this.watermark) return;
    const nowMs = Date.parse(at);
    if (!force && nowMs - Date.parse(this.watermark.lastRetentionAt) < 60 * 60_000) return;
    const cutoff = new Date(nowMs - RETENTION_MS).toISOString();
    const remove = (table: string, where: string, order: string, args: unknown[], maxRows: number) => {
      const sql = `D${'ELETE'} FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 5000)`;
      this.db.prepare(sql).run(...args);
      const count = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
      if (count > maxRows) {
        const capWhere = table === 'credential_read_windows' ? 'closedAt IS NOT NULL' : '1=1';
        this.db.prepare(`D${'ELETE'} FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${capWhere} ORDER BY ${order} LIMIT ?)`)
          .run(Math.min(5000, count - maxRows));
      }
    };
    this.db.transaction(() => {
      remove('events', 'ts < ?', 'ts,id', [cutoff], 50_000);
      remove('coverage', 'ts < ?', 'ts,id', [cutoff], 320_000);
      remove('credential_read_windows', 'closedAt IS NOT NULL AND closedAt < ?', 'closedAt,id', [cutoff], 20_064);
      remove('quarantine', 'receivedAt < ?', 'receivedAt,id', [cutoff], 5_000);
    })();
    this.watermark.lastRetentionAt = at;
    const later = (current: string) => Date.parse(current) >= Date.parse(cutoff) ? current : cutoff;
    this.watermark.eventRetentionFloorAt = later(this.watermark.eventRetentionFloorAt);
    this.watermark.coverageRetentionFloorAt = later(this.watermark.coverageRetentionFloorAt);
    this.watermark.credentialReadWindowRetentionFloorAt = later(this.watermark.credentialReadWindowRetentionFloorAt);
    this.watermark.retentionFloorAt = Date.parse(this.watermark.eventRetentionFloorAt) >= Date.parse(this.watermark.coverageRetentionFloorAt)
      ? this.watermark.eventRetentionFloorAt
      : this.watermark.coverageRetentionFloorAt;
  }

  private writeWatermark(): void {
    if (!this.watermark) return;
    SafeFsExecutor.atomicWriteFileSync(this.watermarkPath, `${JSON.stringify(this.watermark, null, 2)}\n`, {
      mode: 0o600, operation: 'SubscriptionLoginLedger:watermark',
    });
    fs.chmodSync(this.watermarkPath, 0o600);
  }

  private assertWritable(): void {
    if (!this.writeEnabled) throw new Error('subscription-login-ledger-readonly');
  }
}

export function normalizeCellId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.local$/, '');
  if (!CELL_RE.test(normalized)) throw new Error('invalid-cell-id');
  return normalized;
}
