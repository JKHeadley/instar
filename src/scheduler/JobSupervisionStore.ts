/**
 * Durable accounting for production script attempts. Every model call gets a
 * committed provenance row before it starts. All state and lease changes use
 * one SQLite transaction so a late provider answer cannot override a newer
 * attempt after a timeout or restart.
 *
 * docs/specs/job-result-supervision-v2.md §1.
 * @self-action-controller: job-supervision-census-repair
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { isSideRun, type JobRun } from './JobRunHistory.js';
import { decideFixedResult, type FixedCertificateAuthority, type FixedResultCertificate } from './JobFixedResultCertificate.js';
import type { ParsedScriptRun } from './jobScriptProtocol.js';

export type SupervisionStatus = 'pending' | 'resolved' | 'unresolved' | 'unchecked' | 'expired-unchecked';
export type SupervisionProvider = 'fixed' | 'jev' | 'replacement' | null;
export type SupervisionVerdict = 'routine' | 'needs-session' | 'cannot-tell' | null;
export type SupervisionGrade = 'correct' | 'incorrect' | 'unknown';
export type SupervisionInvestigation = 'not-needed' | 'requested' | 'started' | 'investigated' | 'blocked';

export interface SupervisionAttempt {
  attemptId: string;
  runId: string;
  fireId: string;
  slug: string;
  machineId: string | null;
  registeredAt: string;
  completedAt: string | null;
  result: 'success' | 'failure' | 'skipped' | 'timeout' | 'spawn-error' | null;
  status: SupervisionStatus;
  reason: string | null;
  provider: SupervisionProvider;
  verdict: SupervisionVerdict;
  investigation: SupervisionInvestigation;
  grade: SupervisionGrade;
  epoch: number;
  callCount: number;
  retryCount: number;
  leaseUntil: number | null;
  nextRetryAt: number | null;
  templateDigest: string | null;
  featureStateHash: string | null;
  decisionEligible: boolean;
  evidencePolicy: string;
  evidenceHash: string | null;
  evidenceSufficient: boolean;
}

export interface RegisterSupervisionInput {
  runId: string;
  fireId: string;
  slug: string;
  machineId?: string | null;
  templateDigest?: string | null;
  featureStateHash?: string | null;
  /** Immutable run-start gate state; a dark-era result can never enter a later worker. */
  decisionEligible?: boolean;
  evidencePolicy: string;
  attemptId?: string;
  now?: number;
}

export interface PreCallAuditInput {
  attemptId: string;
  provider: 'jev' | 'replacement';
  decisionPoint: string;
  promptHash: string;
  evidencePolicyHash: string;
  evidenceHash: string;
  intendedModel: string;
  leaseMs: number;
  /** Optional atomic, per-machine UTC-day replacement reservation. */
  dailyBudget?: { maxCalls: number; maxInputTokens: number; reserveInputTokens: number };
  now?: number;
}

export interface PreCallAuditRow {
  attemptId: string;
  epoch: number;
  provider: 'jev' | 'replacement';
  decisionPoint: string;
  promptHash: string;
  evidencePolicyHash: string;
  evidenceHash: string;
  intendedModel: string;
  startedAt: string;
}

export interface CallSettlement {
  attemptId: string;
  epoch: number;
  actualProvider: string;
  actualModel: string;
  verdict: Exclude<SupervisionVerdict, null>;
  latencyMs: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  now?: number;
}

const DAY_MS = 24 * 60 * 60_000;
const RETRYABLE_REASONS = new Set(['provider-unavailable', 'provider-timeout', 'provider-error',
  'queue-overload', 'replacement-budget-exhausted']);

/** Unknown pairing state cannot silently retire an expected pool machine. */
export function supervisionMembershipStatus(entry: { status?: unknown; revokedAt?: unknown }): 'active' | 'pending' | 'revoked' {
  if (entry.revokedAt !== undefined && entry.revokedAt !== null) {
    if (typeof entry.revokedAt !== 'string' || !Number.isFinite(Date.parse(entry.revokedAt))) {
      throw new Error('invalid supervision registry revocation');
    }
    return 'revoked';
  }
  if (entry.status === 'revoked') return 'revoked';
  if (entry.status === 'pending') return 'pending';
  if (entry.status === 'active') return 'active';
  throw new Error('invalid supervision registry status');
}

/** UUIDv7: sortable timestamp plus 74 cryptographically random bits. */
function attemptIdAt(now: number): string {
  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(Math.max(0, Math.trunc(now)), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class JobSupervisionStore {
  private readonly db: SqliteDatabase;
  private readonly baselineAt: string;
  private readonly journalRecreated: boolean;
  private unregisterSqlite?: () => void;

  constructor(stateDir: string) {
    const dir = path.join(stateDir, 'ledger');
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'job-supervision.db');
    const baselinePath = path.join(dir, 'job-supervision-baseline.json');
    const lossMarkerPath = path.join(dir, 'job-supervision-journal-lost');
    const existed = fs.existsSync(dbPath);
    const baselineExisted = fs.existsSync(baselinePath);
    // This independent marker survives a lost/recreated SQLite journal. Never
    // reset its census boundary merely because the database was removed.
    if (!fs.existsSync(baselinePath)) {
      if (existed) throw new Error('supervision baseline missing for existing journal');
      const fd = fs.openSync(baselinePath, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString() })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { at?: unknown };
    if (typeof baseline.at !== 'string' || !Number.isFinite(Date.parse(baseline.at))) {
      throw new Error('invalid supervision baseline');
    }
    this.baselineAt = baseline.at;
    if (baselineExisted && !existed && !fs.existsSync(lossMarkerPath)) {
      // Keep the accuracy embargo across further restarts. Recreating SQLite
      // once cannot reconstruct the lost result or machine census.
      const fd = fs.openSync(lossMarkerPath, 'wx', 0o600);
      try { fs.writeFileSync(fd, new Date().toISOString()); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    this.journalRecreated = fs.existsSync(lossMarkerPath);
    this.db = new Database(dbPath);
    // Register as soon as the handle opens. A failed schema migration must
    // neither leak the handle nor leave it outside process-exit cleanup.
    this.unregisterSqlite = registerSqliteHandle(() => { try { this.db.close(); } catch { /* already closed */ } });
    try {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        fire_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        machine_id TEXT,
        registered_at TEXT NOT NULL,
        completed_at TEXT,
        result TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','resolved','unresolved','unchecked','expired-unchecked')),
        reason TEXT,
        provider TEXT,
        verdict TEXT,
        investigation TEXT NOT NULL DEFAULT 'not-needed',
        grade TEXT NOT NULL DEFAULT 'unknown',
        epoch INTEGER NOT NULL DEFAULT 0,
        call_count INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        next_retry_at INTEGER,
        template_digest TEXT,
        feature_state_hash TEXT,
        decision_eligible INTEGER NOT NULL DEFAULT 0,
        evidence_policy TEXT NOT NULL,
        evidence_hash TEXT,
        evidence_sufficient INTEGER NOT NULL DEFAULT 0,
        evidence_text TEXT
      );
      CREATE INDEX IF NOT EXISTS attempts_status_idx ON attempts(status, registered_at);
      CREATE INDEX IF NOT EXISTS attempts_slug_idx ON attempts(slug, registered_at);
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL,
        at TEXT NOT NULL,
        event TEXT NOT NULL,
        reason TEXT,
        epoch INTEGER NOT NULL,
        FOREIGN KEY(attempt_id) REFERENCES attempts(attempt_id)
      );
      CREATE TABLE IF NOT EXISTS calls (
        attempt_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        provider TEXT NOT NULL,
        decision_point TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        evidence_policy_hash TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        intended_model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        settled_at TEXT,
        actual_provider TEXT,
        actual_model TEXT,
        verdict TEXT,
        latency_ms INTEGER,
        tokens_in INTEGER,
        reserved_tokens_in INTEGER,
        tokens_out INTEGER,
        cost_usd REAL,
        outcome_evidence_id TEXT,
        error_reason TEXT,
        settlement TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY(attempt_id, epoch),
        FOREIGN KEY(attempt_id) REFERENCES attempts(attempt_id)
      );
      CREATE TABLE IF NOT EXISTS late_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        at TEXT NOT NULL,
        actual_provider TEXT NOT NULL,
        actual_model TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outcome_grades (
        attempt_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        graded_by TEXT NOT NULL,
        grade TEXT NOT NULL CHECK(grade IN ('correct','incorrect','unknown')),
        graded_at TEXT NOT NULL,
        PRIMARY KEY(attempt_id,evidence_id),
        FOREIGN KEY(attempt_id) REFERENCES attempts(attempt_id)
      );
      CREATE TABLE IF NOT EXISTS held_slugs (
        slug TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        held_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expected_machines (
        machine_id TEXT PRIMARY KEY,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
    // Existing record-only ledgers may predate the sufficiency floor.
    const columns = this.db.pragma('table_info(attempts)') as Array<{ name: string }>;
    if (!columns.some(c => c.name === 'evidence_sufficient')) {
      this.db.exec('ALTER TABLE attempts ADD COLUMN evidence_sufficient INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some(c => c.name === 'evidence_text')) {
      this.db.exec('ALTER TABLE attempts ADD COLUMN evidence_text TEXT');
    }
    if (!columns.some(c => c.name === 'next_retry_at')) {
      this.db.exec('ALTER TABLE attempts ADD COLUMN next_retry_at INTEGER');
    }
    if (!columns.some(c => c.name === 'retry_count')) {
      this.db.exec('ALTER TABLE attempts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some(c => c.name === 'feature_state_hash')) {
      this.db.exec('ALTER TABLE attempts ADD COLUMN feature_state_hash TEXT');
    }
    if (!columns.some(c => c.name === 'decision_eligible')) {
      this.db.exec('ALTER TABLE attempts ADD COLUMN decision_eligible INTEGER NOT NULL DEFAULT 0');
    }
    const callColumns = this.db.pragma('table_info(calls)') as Array<{ name: string }>;
    if (!callColumns.some(c => c.name === 'error_reason')) {
      this.db.exec('ALTER TABLE calls ADD COLUMN error_reason TEXT');
    }
    if (!callColumns.some(c => c.name === 'outcome_evidence_id')) {
      this.db.exec('ALTER TABLE calls ADD COLUMN outcome_evidence_id TEXT');
    }
    if (!callColumns.some(c => c.name === 'reserved_tokens_in')) {
      this.db.exec('ALTER TABLE calls ADD COLUMN reserved_tokens_in INTEGER');
    }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    this.unregisterSqlite?.();
    this.unregisterSqlite = undefined;
    if (this.db.open) this.db.close();
  }

  /** Independent run-history boundary established before the first script attempt. */
  censusBaselineAt(): string { return this.baselineAt; }
  journalWasRecreated(): boolean { return this.journalRecreated; }

  holdSlug(slug: string, reason: string, now = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO held_slugs(slug,reason,held_at) VALUES(?,?,?)')
      .run(slug, reason, new Date(now).toISOString());
  }

  heldSlugs(): Array<{ slug: string; reason: string; heldAt: string }> {
    const rows = this.db.prepare('SELECT slug,reason,held_at FROM held_slugs ORDER BY held_at')
      .all() as Array<{ slug: string; reason: string; held_at: string }>;
    return rows.map(r => ({ slug: r.slug, reason: r.reason, heldAt: r.held_at }));
  }

  /** Pairing-registry observations persist across peer outages and restarts.
   * An absent peer stays expected until its membership is explicitly revoked. */
  observeMachineMembership(entries: Array<{ machineId: string; status: 'active' | 'pending' | 'revoked' }>, now = Date.now()): void {
    const at = new Date(now).toISOString();
    this.db.transaction(() => {
      for (const entry of entries) {
        if (!/^m_[a-z0-9]{8,64}$/.test(entry.machineId)) throw new Error('invalid supervision machine id');
        if (entry.status === 'pending') continue; // Unpaired machines cannot have authoritative job history.
        const prior = this.db.prepare('SELECT last_observed_at,revoked_at FROM expected_machines WHERE machine_id=?')
          .get(entry.machineId) as { last_observed_at: string; revoked_at: string | null } | undefined;
        if (entry.status === 'revoked') {
          if (prior?.revoked_at) continue;
          this.db.prepare(`INSERT INTO expected_machines(machine_id,first_observed_at,last_observed_at,revoked_at)
            VALUES(?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET last_observed_at=excluded.last_observed_at,
            revoked_at=excluded.revoked_at`).run(entry.machineId, at, at, at);
        } else if (!prior || prior.revoked_at || !Number.isFinite(Date.parse(prior.last_observed_at))
          || now - Date.parse(prior.last_observed_at) >= DAY_MS) {
          this.db.prepare(`INSERT INTO expected_machines(machine_id,first_observed_at,last_observed_at,revoked_at)
            VALUES(?,?,?,NULL) ON CONFLICT(machine_id) DO UPDATE SET last_observed_at=excluded.last_observed_at,
            revoked_at=NULL`).run(entry.machineId, at, at);
        }
      }
    })();
  }

  expectedMachineIds(): string[] | null {
    // Losing the SQLite journal also loses the seven-day peer census. Do not
    // report pool accuracy from a newly empty roster after that loss.
    if (this.journalRecreated) return null;
    const rows = this.db.prepare('SELECT machine_id FROM expected_machines WHERE revoked_at IS NULL ORDER BY machine_id')
      .all() as Array<{ machine_id: string }>;
    return rows.map(row => row.machine_id);
  }

  register(input: RegisterSupervisionInput): string {
    const now = input.now ?? Date.now();
    const id = input.attemptId ?? attemptIdAt(now);
    const at = new Date(now).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO attempts
        (attempt_id,run_id,fire_id,slug,machine_id,registered_at,status,template_digest,feature_state_hash,decision_eligible,evidence_policy)
        VALUES (?,?,?,?,?,?,'pending',?,?,?,?)`).run(id, input.runId, input.fireId, input.slug,
        input.machineId ?? null, at, input.templateDigest ?? null, input.featureStateHash ?? null,
        input.decisionEligible === true ? 1 : 0, input.evidencePolicy);
      this.transition(id, at, 'attempt-registered', null, 0);
    })();
    return id;
  }

  recordResult(attemptId: string, input: {
    result: Exclude<SupervisionAttempt['result'], null>;
    completedAt?: string;
    evidenceHash?: string | null;
    evidenceSufficient?: boolean;
    evidenceText?: string | null;
    reason?: string | null;
  }): void {
    const at = input.completedAt ?? new Date().toISOString();
    this.db.transaction(() => {
      const row = this.get(attemptId);
      if (!row) throw new Error(`supervision attempt missing: ${attemptId}`);
      if (row.completedAt) {
        if (row.result !== input.result || row.evidenceHash !== (input.evidenceHash ?? null)
          || row.evidenceSufficient !== !!input.evidenceSufficient) {
          throw new Error(`conflicting result for supervision attempt: ${attemptId}`);
        }
        return;
      }
      if (input.evidenceText !== undefined && input.evidenceText !== null) {
        if (Array.from(input.evidenceText).length > 2000
          || crypto.createHash('sha256').update(input.evidenceText).digest('hex') !== input.evidenceHash) {
          throw new Error(`invalid evidence projection for supervision attempt: ${attemptId}`);
        }
      }
      this.db.prepare(`UPDATE attempts SET completed_at=?, result=?, evidence_hash=?, evidence_sufficient=?, evidence_text=?, reason=? WHERE attempt_id=?`)
        .run(at, input.result, input.evidenceHash ?? null, input.evidenceSufficient ? 1 : 0,
          input.evidenceText ?? null, input.reason ?? null, attemptId);
      this.transition(attemptId, at, 'result-recorded', input.reason ?? null, row.epoch);
    })();
  }

  markUnchecked(attemptId: string, reason: string, now = Date.now()): void {
    this.db.transaction(() => {
      const row = this.get(attemptId);
      if (!row) throw new Error(`supervision attempt missing: ${attemptId}`);
      if (row.status === 'resolved' || row.status === 'expired-unchecked') return;
      const at = new Date(now).toISOString();
      const retryable = RETRYABLE_REASONS.has(reason);
      const retryAt = reason === 'replacement-budget-exhausted' ? now + 10 * 60_000
        : retryable ? now + Math.min(10 * 60_000, 10_000 * (2 ** Math.min(row.retryCount, 6))) : null;
      this.db.prepare(`UPDATE attempts SET status='unchecked',reason=?,lease_until=NULL,next_retry_at=?,
        retry_count=retry_count+? WHERE attempt_id=?`)
        .run(reason, retryAt, retryable ? 1 : 0, attemptId);
      this.transition(attemptId, at, 'unchecked', reason, row.epoch);
    })();
  }

  resolveFixed(attemptId: string, input: {
    parsed: ParsedScriptRun;
    certificate: FixedResultCertificate | null;
    authority: FixedCertificateAuthority;
  }): boolean {
    return this.db.transaction(() => {
      const row = this.get(attemptId);
      if (!row || !row.decisionEligible || !row.completedAt || row.status !== 'pending' || row.callCount !== 0) return false;
      const decision = decideFixedResult({ attempt: row, ...input });
      if (decision.kind === 'hold') {
        this.holdSlug(row.slug, decision.reason, input.authority.now);
        this.markUnchecked(attemptId, decision.reason, input.authority.now);
        return false;
      }
      if (decision.kind !== 'fixed') return false;
      const at = new Date(input.authority.now).toISOString();
      this.db.prepare(`UPDATE attempts SET status='resolved',reason=?,provider='fixed',verdict='routine' WHERE attempt_id=?`)
        .run(`certificate:${decision.certificateId}`, attemptId);
      this.transition(attemptId, at, 'fixed-routine', decision.certificateId, row.epoch);
      return true;
    })();
  }

  /** Commit the call's provenance and its lease/epoch atomically, before egress. */
  beginCall(input: PreCallAuditInput): PreCallAuditRow | null {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const row = this.get(input.attemptId);
      if (!row || !row.decisionEligible || !row.completedAt || !row.evidenceHash || row.evidenceHash !== input.evidenceHash) return null;
      if (row.status !== 'pending' && row.status !== 'unchecked') return null;
      if (row.status === 'unchecked' && !RETRYABLE_REASONS.has(row.reason ?? '')) return null;
      if (input.provider !== 'replacement' && row.nextRetryAt && row.nextRetryAt > now) return null;
      if (row.callCount >= 3 || now - Date.parse(row.completedAt) >= DAY_MS) return null;
      if (row.leaseUntil && row.leaseUntil > now) return null;
      if (input.provider === 'replacement' && input.dailyBudget) {
        const dayStart = `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
        const used = this.db.prepare(`SELECT COUNT(*) AS calls,
          COALESCE(SUM(COALESCE(tokens_in,reserved_tokens_in,0)),0) AS tokens
          FROM calls WHERE provider='replacement' AND started_at>=?`)
          .get(dayStart) as { calls: number; tokens: number };
        if (used.calls >= input.dailyBudget.maxCalls
          || used.tokens + input.dailyBudget.reserveInputTokens > input.dailyBudget.maxInputTokens) return null;
      }
      const epoch = row.epoch + 1;
      const startedAt = new Date(now).toISOString();
      this.db.prepare(`UPDATE attempts SET status='pending',epoch=?,call_count=call_count+1,lease_until=?,next_retry_at=NULL,provider=?,reason=NULL WHERE attempt_id=? AND epoch=?`)
        .run(epoch, now + input.leaseMs, input.provider, input.attemptId, row.epoch);
      const audit: PreCallAuditRow = {
        attemptId: input.attemptId, epoch, provider: input.provider,
        decisionPoint: input.decisionPoint, promptHash: input.promptHash,
        evidencePolicyHash: input.evidencePolicyHash, evidenceHash: input.evidenceHash,
        intendedModel: input.intendedModel, startedAt,
      };
      this.db.prepare(`INSERT INTO calls
        (attempt_id,epoch,provider,decision_point,prompt_hash,evidence_policy_hash,evidence_hash,intended_model,started_at,reserved_tokens_in)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.attemptId, epoch, input.provider,
          input.decisionPoint, input.promptHash, input.evidencePolicyHash,
          input.evidenceHash, input.intendedModel, startedAt,
          input.provider === 'replacement' ? input.dailyBudget?.reserveInputTokens ?? null : null);
      this.transition(input.attemptId, startedAt, 'provider-attempt', input.provider, epoch);
      return audit;
    })();
  }

  /** A late response is saved as audit only; it cannot settle a newer epoch. */
  settleCall(input: CallSettlement): 'settled' | 'late' | 'missing' {
    const at = new Date(input.now ?? Date.now()).toISOString();
    return this.db.transaction(() => {
      const call = this.db.prepare('SELECT epoch,settlement FROM calls WHERE attempt_id=? AND epoch=?')
        .get(input.attemptId, input.epoch) as { epoch: number; settlement: string } | undefined;
      if (!call) return 'missing';
      if (call.settlement !== 'pending') {
        this.db.prepare(`INSERT INTO late_settlements
          (attempt_id,epoch,at,actual_provider,actual_model,verdict,reason) VALUES (?,?,?,?,?,?,?)`)
          .run(input.attemptId, input.epoch, at, input.actualProvider, input.actualModel, input.verdict, 'duplicate-settlement');
        return 'late';
      }
      const row = this.get(input.attemptId);
      // A timed-out answer has lost authority even if the lease reaper has
      // not run yet. Keep it for audit, but do not close the result.
      const current = !!row && row.epoch === input.epoch && row.status === 'pending'
        && row.leaseUntil !== null && row.leaseUntil > (input.now ?? Date.now());
      this.db.prepare(`UPDATE calls SET settled_at=?,actual_provider=?,actual_model=?,verdict=?,latency_ms=?,tokens_in=?,tokens_out=?,cost_usd=?,settlement=?
        WHERE attempt_id=? AND epoch=?`).run(at, input.actualProvider, input.actualModel,
          input.verdict, input.latencyMs, input.tokensIn ?? null, input.tokensOut ?? null,
          input.costUsd ?? null, current ? 'current' : 'late', input.attemptId, input.epoch);
      if (!current) return 'late';
      const insufficientRoutine = input.verdict === 'routine' && !row!.evidenceSufficient;
      const next: SupervisionStatus = input.verdict === 'routine' && !insufficientRoutine ? 'resolved' : 'unresolved';
      const investigation: SupervisionInvestigation = next === 'resolved' ? 'not-needed' : 'requested';
      const reason = insufficientRoutine ? 'evidence-insufficient' : null;
      this.db.prepare(`UPDATE attempts SET status=?,verdict=?,investigation=?,reason=?,lease_until=NULL WHERE attempt_id=? AND epoch=?`)
        .run(next, input.verdict, investigation, reason, input.attemptId, input.epoch);
      this.transition(input.attemptId, at, `verdict:${input.verdict}`, reason, input.epoch);
      return 'settled';
    })();
  }

  failCall(attemptId: string, epoch: number, reason: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const call = this.db.prepare('SELECT settlement FROM calls WHERE attempt_id=? AND epoch=?')
        .get(attemptId, epoch) as { settlement: string } | undefined;
      if (!call || call.settlement !== 'pending') return false;
      const at = new Date(now).toISOString();
      this.db.prepare(`UPDATE calls SET settled_at=?,settlement='failed',error_reason=? WHERE attempt_id=? AND epoch=?`)
        .run(at, reason, attemptId, epoch);
      const row = this.get(attemptId);
      if (row?.epoch === epoch && row.status === 'pending') {
        const retryAt = RETRYABLE_REASONS.has(reason)
          ? now + Math.min(10 * 60_000, Math.max(10_000, 10_000 * (2 ** row.callCount))) : null;
        this.db.prepare(`UPDATE attempts SET status='unchecked',reason=?,lease_until=NULL,next_retry_at=? WHERE attempt_id=? AND epoch=?`)
          .run(reason, retryAt, attemptId, epoch);
        this.transition(attemptId, at, 'provider-failed', reason, epoch);
      }
      return true;
    })();
  }

  blockInvestigation(attemptId: string, reason: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const row = this.get(attemptId);
      if (!row || row.status !== 'unresolved') return false;
      this.db.prepare(`UPDATE attempts SET investigation='blocked',reason=COALESCE(reason,?) WHERE attempt_id=?`)
        .run(reason, attemptId);
      this.transition(attemptId, new Date(now).toISOString(), 'investigation-blocked', reason, row.epoch);
      return true;
    })();
  }

  /** A later independent observation grades the verdict; unknown is explicit. */
  gradeOutcome(input: {
    attemptId: string;
    evidenceId: string;
    ruleId: string;
    gradedBy: string;
    grade: SupervisionGrade;
    now?: number;
  }): boolean {
    if (!input.evidenceId || !input.ruleId || !input.gradedBy || input.gradedBy === 'job-supervisor') return false;
    return this.db.transaction(() => {
      const row = this.get(input.attemptId);
      // The initial verdict remains gradeable even when it requested an
      // investigation. Otherwise unnecessary sessions disappear from the
      // accuracy denominator.
      if (!row || !row.completedAt || !row.verdict || (row.status !== 'resolved' && row.status !== 'unresolved')) return false;
      const at = new Date(input.now ?? Date.now()).toISOString();
      const prior = this.db.prepare('SELECT grade,rule_id,graded_by FROM outcome_grades WHERE attempt_id=? AND evidence_id=?')
        .get(input.attemptId, input.evidenceId) as { grade: string; rule_id: string; graded_by: string } | undefined;
      if (prior) return prior.grade === input.grade && prior.rule_id === input.ruleId && prior.graded_by === input.gradedBy;
      this.db.prepare(`INSERT INTO outcome_grades
        (attempt_id,evidence_id,rule_id,graded_by,grade,graded_at) VALUES (?,?,?,?,?,?)`)
        .run(input.attemptId, input.evidenceId, input.ruleId, input.gradedBy, input.grade, at);
      const aggregate = this.db.prepare(`SELECT
        SUM(CASE WHEN grade='incorrect' THEN 1 ELSE 0 END) AS incorrect,
        SUM(CASE WHEN grade='correct' THEN 1 ELSE 0 END) AS correct
        FROM outcome_grades WHERE attempt_id=?`).get(input.attemptId) as { incorrect: number; correct: number };
      const effective: SupervisionGrade = aggregate.incorrect ? 'incorrect' : aggregate.correct ? 'correct' : 'unknown';
      this.db.prepare('UPDATE attempts SET grade=? WHERE attempt_id=?').run(effective, input.attemptId);
      this.db.prepare(`UPDATE calls SET outcome_evidence_id=COALESCE(outcome_evidence_id,?)
        WHERE attempt_id=? AND settlement='current'`).run(input.evidenceId, input.attemptId);
      this.transition(input.attemptId, at, 'outcome-graded', input.grade, row.epoch);
      return true;
    })();
  }

  outcomeGrades(attemptId: string): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM outcome_grades WHERE attempt_id=? ORDER BY graded_at')
      .all(attemptId) as Array<Record<string, unknown>>;
  }

  expireLeases(now = Date.now()): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT attempt_id FROM attempts WHERE status='pending' AND lease_until IS NOT NULL AND lease_until<=?`)
        .all(now) as Array<{ attempt_id: string }>;
      for (const r of rows) this.markUnchecked(r.attempt_id, 'provider-timeout', now);
      return rows.length;
    })();
  }

  expireRetries(now = Date.now()): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT attempt_id,reason,epoch FROM attempts
        WHERE status='unchecked' AND (call_count>=3 OR COALESCE(completed_at,registered_at)<=?)`)
        .all(new Date(now - DAY_MS).toISOString()) as Array<{ attempt_id: string; reason: string | null; epoch: number }>;
      for (const r of rows) {
        this.db.prepare(`UPDATE attempts SET status='expired-unchecked' WHERE attempt_id=?`).run(r.attempt_id);
        this.transition(r.attempt_id, new Date(now).toISOString(), 'expired-unchecked', r.reason, r.epoch);
      }
      return rows.length;
    })();
  }

  /**
   * Independently compare the run-history census with the supervision journal.
   * Never turn a missing row into a successful check or rerun the script.
   */
  reconcileHistory(runs: JobRun[], now = Date.now(), isRunLive?: (runId: string) => boolean): { inserted: number; outcomeUnknown: number } {
    let inserted = 0;
    let outcomeUnknown = 0;
    const at = new Date(now).toISOString();
    this.db.transaction(() => {
      for (const run of runs) {
        if (run.runner !== 'script' || isSideRun(run)) continue;
        const existing = this.findByRunId(run.runId);
        if (!existing) {
          // recordStart precedes the pre-execution registration by a few
          // instructions. Never race that window and invent a lost attempt.
          if (run.result === 'pending' && (isRunLive?.(run.runId) ?? Date.parse(run.startedAt) > now - DAY_MS)) continue;
          const id = attemptIdAt(now);
          const reason = run.result === 'pending' ? 'outcome-unknown' : 'missing-record';
          this.db.prepare(`INSERT INTO attempts
            (attempt_id,run_id,fire_id,slug,machine_id,registered_at,completed_at,result,status,reason,evidence_policy)
            VALUES (?,?,?,?,?,?,?,?, 'unchecked',?,?)`).run(
            id, run.runId, `recovered:${run.runId}`, run.slug, run.machineId ?? null,
            run.startedAt, run.completedAt ?? null, run.result === 'pending' ? null : run.result,
            reason, 'recovered-unknown');
          this.transition(id, at, 'census-recovered', reason, 0);
          inserted++;
          continue;
        }
        // A pending history row may still be an active script. Only the
        // abandoned tail is classified here; claim-aware recovery can do so
        // sooner after proving that its executor has stopped.
        if (run.result === 'pending' && !(isRunLive?.(run.runId) ?? Date.parse(run.startedAt) > now - DAY_MS)
          && existing.status === 'pending' && !existing.completedAt) {
          this.db.prepare(`UPDATE attempts SET status='unchecked',reason='outcome-unknown' WHERE attempt_id=?`)
            .run(existing.attemptId);
          this.transition(existing.attemptId, at, 'outcome-unknown', 'outcome-unknown', existing.epoch);
          outcomeUnknown++;
        }
      }
    })();
    return { inserted, outcomeUnknown };
  }

  get(attemptId: string): SupervisionAttempt | null {
    const r = this.db.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId) as Record<string, unknown> | undefined;
    return r ? this.mapAttempt(r) : null;
  }

  findByRunId(runId: string): SupervisionAttempt | null {
    const r = this.db.prepare('SELECT * FROM attempts WHERE run_id=?').get(runId) as Record<string, unknown> | undefined;
    return r ? this.mapAttempt(r) : null;
  }

  listSince(since: string, limit = 500): SupervisionAttempt[] {
    const rows = this.db.prepare('SELECT * FROM attempts WHERE registered_at>=? ORDER BY registered_at DESC LIMIT ?')
      .all(since, Math.max(1, Math.min(limit, 5000))) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapAttempt(r));
  }

  /** Durable queue source. The caller must still acquire beginCall's epoch lease. */
  claimable(now = Date.now(), limit = 2000): SupervisionAttempt[] {
    const rows = this.db.prepare(`SELECT * FROM attempts
      WHERE decision_eligible=1 AND completed_at IS NOT NULL AND evidence_hash IS NOT NULL
        AND (lease_until IS NULL OR lease_until<=?) AND (next_retry_at IS NULL OR next_retry_at<=?) AND call_count<3
        AND completed_at>?
        AND (status='pending' OR (status='unchecked' AND reason IN
          ('provider-unavailable','provider-timeout','provider-error','queue-overload','replacement-budget-exhausted')))
      ORDER BY registered_at ASC LIMIT ?`).all(now, now, new Date(now - DAY_MS).toISOString(),
      Math.max(1, Math.min(limit, 2000))) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapAttempt(r));
  }

  backlog(): { count: number; oldestAt: string | null } {
    const row = this.db.prepare(`SELECT COUNT(*) AS n, MIN(completed_at) AS oldest
      FROM attempts WHERE decision_eligible=1 AND status='pending' AND completed_at IS NOT NULL`)
      .get() as { n: number; oldest: string | null };
    return { count: row.n, oldestAt: row.oldest };
  }

  countCalls(provider: 'jev' | 'replacement', since: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE provider=? AND started_at>=?')
      .get(provider, since) as { n: number };
    return row.n;
  }

  replacementBudgetSince(since: string): { calls: number; inputTokens: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS calls,
      COALESCE(SUM(COALESCE(tokens_in,reserved_tokens_in,0)),0) AS inputTokens
      FROM calls WHERE provider='replacement' AND started_at>=?`)
      .get(since) as { calls: number; inputTokens: number };
    return { calls: row.calls, inputTokens: row.inputTokens };
  }

  /** Content-free bulk audit for every provider attempt, including failures. */
  callSummarySince(since: string): Array<{
    slug: string; machineId: string | null; provider: string; model: string;
    promptHash: string; calls: number; settled: number; failed: number;
    unknownOutcome: number; incorrect: number; tokensIn: number; tokensOut: number;
    costUsd: number; costUnknown: number; averageLatencyMs: number | null;
  }> {
    const rows = this.db.prepare(`SELECT a.slug AS slug,a.machine_id AS machineId,
      c.provider AS provider,COALESCE(c.actual_model,c.intended_model) AS model,
      c.prompt_hash AS promptHash,COUNT(*) AS calls,
      SUM(CASE WHEN c.settlement='current' THEN 1 ELSE 0 END) AS settled,
      SUM(CASE WHEN c.settlement='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN a.grade='unknown' AND c.settlement='current' THEN 1 ELSE 0 END) AS unknownOutcome,
      SUM(CASE WHEN a.grade='incorrect' AND c.settlement='current' THEN 1 ELSE 0 END) AS incorrect,
      COALESCE(SUM(c.tokens_in),0) AS tokensIn,COALESCE(SUM(c.tokens_out),0) AS tokensOut,
      COALESCE(SUM(c.cost_usd),0) AS costUsd,
      SUM(CASE WHEN c.cost_usd IS NULL THEN 1 ELSE 0 END) AS costUnknown,
      AVG(c.latency_ms) AS averageLatencyMs
      FROM calls c JOIN attempts a ON a.attempt_id=c.attempt_id
      WHERE c.started_at>=?
      GROUP BY a.slug,a.machine_id,c.provider,COALESCE(c.actual_model,c.intended_model),c.prompt_hash
      ORDER BY a.slug,c.provider,model,c.prompt_hash`).all(since) as Array<Record<string, unknown>>;
    return rows.map(r => ({ slug: String(r.slug), machineId: r.machineId as string | null,
      provider: String(r.provider), model: String(r.model), promptHash: String(r.promptHash),
      calls: Number(r.calls), settled: Number(r.settled), failed: Number(r.failed),
      unknownOutcome: Number(r.unknownOutcome), incorrect: Number(r.incorrect),
      tokensIn: Number(r.tokensIn), tokensOut: Number(r.tokensOut), costUsd: Number(r.costUsd),
      costUnknown: Number(r.costUnknown), averageLatencyMs: r.averageLatencyMs === null ? null : Number(r.averageLatencyMs) }));
  }

  callRows(attemptId: string): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM calls WHERE attempt_id=? ORDER BY epoch').all(attemptId) as Array<Record<string, unknown>>;
  }

  lateSettlements(attemptId: string): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM late_settlements WHERE attempt_id=? ORDER BY id').all(attemptId) as Array<Record<string, unknown>>;
  }

  /** Read only the scrubbed, bounded projection; never raw script output. */
  evidenceText(attemptId: string): string | null {
    const row = this.db.prepare('SELECT evidence_text FROM attempts WHERE attempt_id=?').get(attemptId) as { evidence_text: string | null } | undefined;
    return row?.evidence_text ?? null;
  }

  private transition(attemptId: string, at: string, event: string, reason: string | null, epoch: number): void {
    this.db.prepare('INSERT INTO transitions(attempt_id,at,event,reason,epoch) VALUES(?,?,?,?,?)')
      .run(attemptId, at, event, reason, epoch);
  }

  private mapAttempt(r: Record<string, unknown>): SupervisionAttempt {
    return {
      attemptId: String(r.attempt_id), runId: String(r.run_id), fireId: String(r.fire_id),
      slug: String(r.slug), machineId: r.machine_id as string | null,
      registeredAt: String(r.registered_at), completedAt: r.completed_at as string | null,
      result: r.result as SupervisionAttempt['result'], status: r.status as SupervisionStatus,
      reason: r.reason as string | null, provider: r.provider as SupervisionProvider,
      verdict: r.verdict as SupervisionVerdict, investigation: r.investigation as SupervisionInvestigation,
      grade: r.grade as SupervisionGrade, epoch: Number(r.epoch), callCount: Number(r.call_count),
      retryCount: Number(r.retry_count),
      leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
      nextRetryAt: r.next_retry_at === null ? null : Number(r.next_retry_at),
      templateDigest: r.template_digest as string | null, evidencePolicy: String(r.evidence_policy),
      featureStateHash: r.feature_state_hash as string | null,
      decisionEligible: Number(r.decision_eligible) === 1,
      evidenceHash: r.evidence_hash as string | null,
      evidenceSufficient: Number(r.evidence_sufficient) === 1,
    };
  }
}
