import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FailureEpisodeLatch, type FailureEpisodeSnapshot } from './FailureEpisodeLatch.js';
import { registerSqliteHandle } from './SqliteRegistry.js';
import type { Admission, AdmissionToken, AdmitOpts, DerivedTarget } from '../monitoring/selfaction/types.js';

export type SelfHealSeverity = 'recoverable' | 'irreversible' | 'data-loss' | 'security' | 'unknown';
export type SelfHealEvidenceCode = 'source-absent' | 'schema-stale' | 'repaired' | 'already-healthy' | 'malformed-json' | 'access-denied' | 'io-error' | 'symlink-refused' | 'non-regular-refused' | 'sqlite-busy' | 'fence-stale' | 'verification-failed';
export type SelfHealRemediationResult = { outcome: 'healed' | 'pending-restart' | 'not-healed'; evidence: SelfHealEvidenceCode };
type NoticeReason = 'unknown-severity' | 'irreversible' | 'data-loss' | 'security' | 'latency' | 'max-attempts' | 'wall-clock' | 'flap' | 'state-failure';
type NoticeState = { state: 'pending' | 'enqueued'; id: string };
type RestartState = { state: 'required' | 'requested'; requestingBootId: string; stableRequestId: string };

export interface SelfHealNotice { id: string; controllerId: string; reason: NoticeReason; priority: 'HIGH' | 'URGENT' }
export interface SelfHealAuditEvent { at: number; controllerId: string; event: string; reason?: string; attempt?: number; elapsedMs?: number }
export interface SelfHealSpec<Ctx> {
  id: string; controllerResource: 'hardware-bound' | 'pool-shared'; episodeAuthority: 'process-local' | 'durable-machine-local'; classId: string;
  severity(ctx: Ctx): SelfHealSeverity; dedupeKey(ctx: Ctx): string; eligible(ctx: Ctx): { eligible: boolean; fence: string | null };
  remediation(ctx: Ctx): SelfHealRemediationResult; maxAttempts: number; maxWallClockMs: number; backoffMs(attempt: number): number;
  notificationLatencyCeilingMs: number; flap: { maxRecoveries: number; windowMs: number };
  remediationActions: { operation: string; idempotencyGuard: string; compensation: string };
  restartVerified?(ctx: Ctx): boolean;
}
export type SelfHealResult = { outcome: 'healed' | 'attempted' | 'backoff' | 'busy' | 'governed' | 'exhausted' | 'invalid-severity' | 'state-failure'; reason: string; noticeAttempted?: boolean; noticeReason?: NoticeReason; tokenValid?: boolean };

export interface SelfHealEpisodeRecord {
  schemaVersion: 1; key: string; revision: number; status: 'active' | 'recovered' | 'exhausted'; startedAt: number; attempts: number;
  nextEligibleAt: number; latch: FailureEpisodeSnapshot; notices: Partial<Record<NoticeReason, NoticeState>>; recoveries: number[];
  restart: RestartState | null; updatedAt: number;
}
export interface SelfHealEpisodeStore {
  load(key: string): SelfHealEpisodeRecord | null;
  create(record: SelfHealEpisodeRecord): SelfHealEpisodeRecord | null;
  mutate(key: string, expectedRevision: number, update: (record: SelfHealEpisodeRecord) => SelfHealEpisodeRecord, guard?: () => boolean): SelfHealEpisodeRecord | null;
  appendAudit?(event: SelfHealAuditEvent): void; close?(): void;
}

function cloneRecord(record: SelfHealEpisodeRecord): SelfHealEpisodeRecord { return structuredClone(record); }
function validateRecord(value: unknown): SelfHealEpisodeRecord {
  if (!value || typeof value !== 'object') throw new Error('invalid self-heal episode');
  const r = value as SelfHealEpisodeRecord;
  if (r.schemaVersion !== 1 || typeof r.key !== 'string' || r.key.length < 1 || r.key.length > 240) throw new Error('invalid self-heal episode');
  for (const n of [r.revision, r.startedAt, r.attempts, r.nextEligibleAt, r.updatedAt]) if (!Number.isFinite(n) || n < 0) throw new Error('invalid self-heal episode');
  if (!Number.isInteger(r.revision) || !Number.isInteger(r.attempts) || !['active', 'recovered', 'exhausted'].includes(r.status)) throw new Error('invalid self-heal episode');
  if (!Array.isArray(r.recoveries) || r.recoveries.length > 64 || r.recoveries.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('invalid self-heal episode');
  const latch = new FailureEpisodeLatch({ signalAfterMs: 1 }); latch.restore(r.latch);
  return r;
}

export class InMemorySelfHealEpisodeStore implements SelfHealEpisodeStore {
  private readonly rows = new Map<string, SelfHealEpisodeRecord>(); readonly audits: SelfHealAuditEvent[] = [];
  load(key: string): SelfHealEpisodeRecord | null { const row = this.rows.get(key); return row ? cloneRecord(row) : null; }
  create(record: SelfHealEpisodeRecord): SelfHealEpisodeRecord | null { if (this.rows.has(record.key)) return null; const row = validateRecord(cloneRecord(record)); this.rows.set(row.key, row); return cloneRecord(row); }
  mutate(key: string, expectedRevision: number, update: (record: SelfHealEpisodeRecord) => SelfHealEpisodeRecord, guard?: () => boolean): SelfHealEpisodeRecord | null {
    const current = this.rows.get(key); if (!current || current.revision !== expectedRevision) return null;
    if (guard && !guard()) return null;
    const next = validateRecord(update(cloneRecord(current)));
    if (next.key !== key || next.revision !== expectedRevision + 1) throw new Error('self-heal mutation must increment revision once');
    if (current.status === 'exhausted' && next.status !== 'exhausted') throw new Error('self-heal exhausted state is monotonic');
    this.rows.set(key, cloneRecord(next)); return cloneRecord(next);
  }
  appendAudit(event: SelfHealAuditEvent): void { this.audits.push(structuredClone(event)); }
}

export class SqliteSelfHealEpisodeStore implements SelfHealEpisodeStore {
  private readonly db: Database.Database;
  private readonly unregisterSqlite: () => void;
  constructor(dbPath: string) {
    const parent = path.dirname(dbPath); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const ps = fs.lstatSync(parent); if (!ps.isDirectory() || ps.isSymbolicLink()) throw new Error('unsafe self-heal store parent');
    if (fs.existsSync(dbPath)) { const st = fs.lstatSync(dbPath); if (!st.isFile() || st.isSymbolicLink()) throw new Error('unsafe self-heal store file'); }
    this.db = new Database(dbPath, { timeout: 100 }); this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 100');
    this.db.exec('CREATE TABLE IF NOT EXISTS self_heal_episodes (episode_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS self_heal_audit (id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, controller_id TEXT NOT NULL, event TEXT NOT NULL, reason TEXT, attempt INTEGER, elapsed_ms INTEGER);');
    try { fs.chmodSync(dbPath, 0o600); } catch { /* non-posix */ }
    this.unregisterSqlite = registerSqliteHandle(() => { try { this.db.close(); } catch { /* already closed */ } });
  }
  load(key: string): SelfHealEpisodeRecord | null { const row = this.db.prepare('SELECT payload FROM self_heal_episodes WHERE episode_key=?').get(key) as { payload: string } | undefined; return row ? validateRecord(JSON.parse(row.payload)) : null; }
  create(record: SelfHealEpisodeRecord): SelfHealEpisodeRecord | null {
    const row = validateRecord(cloneRecord(record)); const tx = this.db.transaction(() => {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM self_heal_episodes').get() as { n: number }).n; if (count >= 256) return false;
      return this.db.prepare('INSERT OR IGNORE INTO self_heal_episodes(episode_key,revision,payload,updated_at) VALUES(?,?,?,?)').run(row.key, row.revision, JSON.stringify(row), row.updatedAt).changes === 1;
    });
    try { return tx() ? cloneRecord(row) : null; } catch (error) { if (/busy|locked/i.test(String(error))) return null; throw error; }
  }
  mutate(key: string, expectedRevision: number, update: (record: SelfHealEpisodeRecord) => SelfHealEpisodeRecord, guard?: () => boolean): SelfHealEpisodeRecord | null {
    const tx = this.db.transaction(() => { const current = this.load(key); if (!current || current.revision !== expectedRevision) return null;
      if (guard && !guard()) return null;
      const next = validateRecord(update(cloneRecord(current))); if (next.key !== key || next.revision !== expectedRevision + 1) throw new Error('self-heal mutation must increment revision once');
      if (current.status === 'exhausted' && next.status !== 'exhausted') throw new Error('self-heal exhausted state is monotonic');
      const changed = this.db.prepare('UPDATE self_heal_episodes SET revision=?,payload=?,updated_at=? WHERE episode_key=? AND revision=?').run(next.revision, JSON.stringify(next), next.updatedAt, key, expectedRevision).changes;
      return changed === 1 ? next : null; });
    try { const row = tx(); return row ? cloneRecord(row) : null; } catch (error) { if (/busy|locked/i.test(String(error))) return null; throw error; }
  }
  appendAudit(event: SelfHealAuditEvent): void { this.db.prepare('INSERT OR REPLACE INTO self_heal_audit(id,at_ms,controller_id,event,reason,attempt,elapsed_ms) VALUES(?,?,?,?,?,?,?)').run(event.at % 1024, event.at, event.controllerId, event.event, event.reason ?? null, event.attempt ?? null, event.elapsedMs ?? null); }
  close(): void { this.unregisterSqlite(); this.db.close(); }
}

export interface SelfHealGateDeps {
  admit(target: DerivedTarget, opts: AdmitOpts): Promise<Admission>; consumeToken(token: AdmissionToken, controllerId: string, opts: { targetKey: string; nowMs: number }): { proceed: boolean; valid: boolean; reason?: string };
  notify(notice: SelfHealNotice): void | Promise<void>; audit(event: SelfHealAuditEvent): void; now?: () => number; episodeStore?: SelfHealEpisodeStore;
  bootId?: string; requestRestart?: (stableRequestId: string) => boolean;
}

export class SelfHealGate<Ctx> {
  private readonly now: () => number; private readonly store: SelfHealEpisodeStore; private readonly bootId: string;
  private readonly stateFailureNotices = new Set<string>();
  constructor(private readonly spec: SelfHealSpec<Ctx>, private readonly deps: SelfHealGateDeps) {
    if (spec.controllerResource !== 'hardware-bound') throw new Error('v1 SelfHealGate refuses pool-shared controllers');
    if (!Number.isInteger(spec.maxAttempts) || spec.maxAttempts < 1 || spec.maxAttempts > 32) throw new Error('invalid maxAttempts');
    for (const value of [spec.maxWallClockMs, spec.notificationLatencyCeilingMs, spec.flap.maxRecoveries, spec.flap.windowMs]) if (!Number.isFinite(value) || value <= 0) throw new Error('invalid SelfHealGate bound');
    this.now = deps.now ?? Date.now; this.store = deps.episodeStore ?? new InMemorySelfHealEpisodeStore(); this.bootId = deps.bootId ?? crypto.randomUUID();
  }
  needsRestartVerification(ctx: Ctx): boolean { return this.store.load(this.key(ctx))?.restart !== null; }
  async attempt(ctx: Ctx): Promise<SelfHealResult> { const began = this.now(); try { return await this.attemptInner(ctx); } catch { return this.stateFailureWithNotice('store-operation-failed'); } finally { this.audit({ event: 'attempt-finished', elapsedMs: Math.max(0, this.now() - began) }); } }
  recordHealthy(ctx: Ctx): SelfHealResult {
    const current = this.store.load(this.key(ctx)); if (!current) return { outcome: 'healed', reason: 'already-healthy' }; if (current.status === 'exhausted') return { outcome: 'exhausted', reason: 'terminal' };
    if (current.restart) return { outcome: 'governed', reason: 'restart-verification-required' };
    const next = this.cas(current, (row) => ({ ...row, status: 'recovered', recoveries: [...row.recoveries, this.now()].slice(-64), restart: null }));
    return next ? { outcome: 'healed', reason: 'recorded-healthy' } : { outcome: 'busy', reason: 'revision-conflict' };
  }
  private async attemptInner(ctx: Ctx): Promise<SelfHealResult> {
    const key = this.key(ctx); let row = this.store.load(key); if (!row) { const fresh = this.newEpisode(key); row = this.store.create(fresh) ?? this.store.load(key); } if (!row) return this.stateFailureWithNotice('create-failed');
    if (row.status === 'active') {
      const now = this.now(); const recent = row.recoveries.filter((at) => now - at <= this.spec.flap.windowMs);
      if (now - row.startedAt >= this.spec.maxWallClockMs) return this.exhaust(row, 'wall-clock');
      if (recent.length >= this.spec.flap.maxRecoveries) return this.exhaust(row, 'flap');
      if (row.attempts >= this.spec.maxAttempts && !row.restart) return this.exhaust(row, 'max-attempts');
    }
    if (row.restart) {
      if (row.restart.state === 'required') return this.requestPendingRestart(row);
      if (row.restart.requestingBootId === this.bootId) return { outcome: 'attempted', reason: 'restart-awaiting-new-boot' };
      let verified = false; try { verified = this.spec.restartVerified?.(ctx) === true; } catch { verified = false; }
      if (!verified) { let severity: SelfHealSeverity; try { severity = this.spec.severity(ctx); } catch { severity = 'unknown'; }
        if (severity === 'unknown') return this.noticeAndReturn(row, 'unknown-severity', 'invalid-severity');
        return { outcome: 'attempted', reason: 'restart-verification-not-healthy' }; }
      const closed = this.cas(row, (r) => ({ ...r, status: 'recovered', restart: null, recoveries: [...r.recoveries, this.now()].slice(-64) }));
      return closed ? { outcome: 'healed', reason: 'restart-verified' } : { outcome: 'busy', reason: 'revision-conflict' };
    }
    let severity: SelfHealSeverity; try { severity = this.spec.severity(ctx); } catch { severity = 'unknown'; }
    if (!['recoverable', 'irreversible', 'data-loss', 'security'].includes(severity)) return this.noticeAndReturn(row, 'unknown-severity', 'invalid-severity');
    if (severity !== 'recoverable') { const notice = await this.ensureNotice(row, severity as NoticeReason); row = notice.row; }
    if (row.status === 'recovered') { const now = this.now(); const reset = this.cas(row, (r) => ({ ...r, status: 'active', startedAt: now, attempts: 0, nextEligibleAt: 0, latch: emptyLatch(), notices: {}, restart: null })); if (!reset) return { outcome: 'busy', reason: 'revision-conflict' }; row = reset; }
    if (row.status === 'exhausted') return { outcome: 'exhausted', reason: 'terminal' };
    const latch = new FailureEpisodeLatch({ signalAfterMs: this.spec.notificationLatencyCeilingMs, now: this.now }); latch.restore(row.latch); const failure = latch.recordFailure();
    const detected = this.cas(row, (r) => ({ ...r, latch: latch.snapshot() })); if (!detected) return { outcome: 'busy', reason: 'revision-conflict' }; row = detected;
    if (failure.shouldSignal) { const notice = await this.ensureNotice(row, 'latency'); row = notice.row; }
    const now = this.now(); const recent = row.recoveries.filter((at) => now - at <= this.spec.flap.windowMs);
    if (now - row.startedAt >= this.spec.maxWallClockMs) return this.exhaust(row, 'wall-clock'); if (recent.length >= this.spec.flap.maxRecoveries) return this.exhaust(row, 'flap'); if (row.attempts >= this.spec.maxAttempts) return this.exhaust(row, 'max-attempts');
    if (row.nextEligibleAt > now) return { outcome: 'backoff', reason: 'not-eligible-yet' };
    const eligibility = safeEligible(this.spec, ctx); if (!eligibility.eligible || !eligibility.fence) return { outcome: 'governed', reason: 'fence-stale' };
    const target: DerivedTarget = { key: keyHash(key), classId: this.spec.classId, keyIsVolatile: false };
    const admission = await this.deps.admit(target, { incarnation: eligibility.fence, eligible: () => safeEligible(this.spec, ctx).fence === eligibility.fence, onAdmitted: (token) => { void this.runAdmitted(ctx, target, token).catch(() => { void this.stateFailureWithNotice('queued-attempt-failed'); }); }, lane: 'job', nowMs: now });
    if (admission.outcome !== 'allow') return { outcome: 'governed', reason: admission.outcome }; return this.runAdmitted(ctx, target, admission.token);
  }
  private async runAdmitted(ctx: Ctx, target: DerivedTarget, token: AdmissionToken): Promise<SelfHealResult> {
    let row = this.store.load(this.key(ctx)); if (!row || row.status !== 'active') return { outcome: 'governed', reason: 'episode-not-active' };
    const latch = new FailureEpisodeLatch({ signalAfterMs: this.spec.notificationLatencyCeilingMs, now: this.now });
    latch.restore(row.latch); const failure = latch.recordFailure();
    const observed = this.cas(row, (r) => ({ ...r, latch: latch.snapshot() }));
    if (!observed) return { outcome: 'busy', reason: 'revision-conflict' }; row = observed;
    if (failure.shouldSignal) { const notice = await this.ensureNotice(row, 'latency'); row = notice.row; }
    const now = this.now();
    const recent = row.recoveries.filter((at) => now - at <= this.spec.flap.windowMs);
    if (now - row.startedAt >= this.spec.maxWallClockMs) return this.exhaust(row, 'wall-clock');
    if (recent.length >= this.spec.flap.maxRecoveries) return this.exhaust(row, 'flap');
    if (row.nextEligibleAt > now) return { outcome: 'backoff', reason: 'not-eligible-yet' };
    const eligibility = safeEligible(this.spec, ctx); if (!eligibility.eligible || !eligibility.fence) return { outcome: 'governed', reason: 'fence-stale' };
    const consumed = this.deps.consumeToken(token, this.spec.id, { targetKey: target.key, nowMs: this.now() }); if (!consumed.proceed) return { outcome: 'governed', reason: consumed.reason ?? 'token-refused', tokenValid: consumed.valid };
    const again = safeEligible(this.spec, ctx); if (!again.eligible || again.fence !== eligibility.fence) return { outcome: 'governed', reason: 'fence-stale', tokenValid: consumed.valid };
    if (row.attempts >= this.spec.maxAttempts) return this.exhaust(row, 'max-attempts');
    const claim = this.cas(row, (r) => ({ ...r, attempts: r.attempts + 1 }), () => {
      const live = safeEligible(this.spec, ctx); return live.eligible && live.fence === eligibility.fence;
    });
    if (!claim) return { outcome: 'governed', reason: 'fence-stale-or-revision-conflict' }; row = claim;
    let result: SelfHealRemediationResult; try { result = this.spec.remediation(ctx); if (result && typeof (result as unknown as { then?: unknown }).then === 'function') throw new Error('async remediation forbidden'); } catch { result = { outcome: 'not-healed', evidence: 'io-error' }; }
    if (result.outcome === 'healed') { const closed = this.cas(row, (r) => ({ ...r, status: 'recovered', recoveries: [...r.recoveries, this.now()].slice(-64) })); return closed ? { outcome: 'healed', reason: result.evidence, tokenValid: consumed.valid } : { outcome: 'busy', reason: 'revision-conflict' }; }
    if (result.outcome === 'pending-restart') { const stableRequestId = `self-heal:${keyHash(row.key)}:${row.startedAt}`; const pending = this.cas(row, (r) => ({ ...r, restart: { state: 'required', requestingBootId: this.bootId, stableRequestId } })); return pending ? this.requestPendingRestart(pending) : { outcome: 'busy', reason: 'revision-conflict' }; }
    const failed = this.cas(row, (r) => ({ ...r, nextEligibleAt: this.now() + Math.max(0, this.spec.backoffMs(row.attempts)) })); return failed ? { outcome: 'attempted', reason: result.evidence, tokenValid: consumed.valid } : { outcome: 'busy', reason: 'revision-conflict' };
  }
  private requestPendingRestart(row: SelfHealEpisodeRecord): SelfHealResult {
    if (!row.restart) return { outcome: 'state-failure', reason: 'restart-state-missing' }; const ok = this.deps.requestRestart?.(row.restart.stableRequestId) ?? false; if (!ok) return { outcome: 'attempted', reason: 'restart-request-failed' };
    if (row.restart.state === 'requested') return { outcome: 'attempted', reason: 'restart-requested' }; const requested = this.cas(row, (r) => ({ ...r, restart: r.restart ? { ...r.restart, state: 'requested' } : null })); return requested ? { outcome: 'attempted', reason: 'restart-requested' } : { outcome: 'busy', reason: 'revision-conflict' };
  }
  private async ensureNotice(row: SelfHealEpisodeRecord, reason: NoticeReason): Promise<{ row: SelfHealEpisodeRecord; attempted: boolean }> {
    const existing = row.notices[reason]; if (existing?.state === 'enqueued') return { row, attempted: false }; const id = existing?.id ?? `self-heal:${keyHash(row.key)}:${reason}:${row.startedAt}`;
    if (!existing) { const pending = this.cas(row, (r) => ({ ...r, notices: { ...r.notices, [reason]: { state: 'pending', id } } })); if (!pending) return { row: this.store.load(row.key) ?? row, attempted: false }; row = pending; }
    try { await this.deps.notify({ id, controllerId: this.spec.id, reason, priority: ['irreversible', 'data-loss', 'security'].includes(reason) ? 'URGENT' : 'HIGH' }); } catch { this.audit({ event: 'notice-enqueue-failed', reason }); return { row, attempted: true }; }
    const enqueued = this.cas(row, (r) => ({ ...r, notices: { ...r.notices, [reason]: { state: 'enqueued', id } } })); return { row: enqueued ?? row, attempted: true };
  }
  private async noticeAndReturn(row: SelfHealEpisodeRecord, reason: NoticeReason, outcome: SelfHealResult['outcome']): Promise<SelfHealResult> { const notice = await this.ensureNotice(row, reason); return { outcome, reason, noticeAttempted: notice.attempted, noticeReason: reason }; }
  private async exhaust(row: SelfHealEpisodeRecord, reason: 'wall-clock' | 'flap' | 'max-attempts'): Promise<SelfHealResult> { const notice = await this.ensureNotice(row, reason); row = notice.row; const terminal = this.cas(row, (r) => ({ ...r, status: 'exhausted' })); return terminal ? { outcome: 'exhausted', reason, noticeAttempted: notice.attempted, noticeReason: reason } : { outcome: 'busy', reason: 'revision-conflict' }; }
  private stateFailure(reason: string): SelfHealResult { this.audit({ event: 'state-failure', reason }); return { outcome: 'state-failure', reason }; }
  private async stateFailureWithNotice(reason: string): Promise<SelfHealResult> {
    this.audit({ event: 'state-failure', reason });
    const id = `self-heal:${this.spec.id}:state-failure:${this.bootId}`;
    if (!this.stateFailureNotices.has(id)) {
      try { await this.deps.notify({ id, controllerId: this.spec.id, reason: 'state-failure', priority: 'HIGH' }); this.stateFailureNotices.add(id); }
      catch { this.audit({ event: 'notice-enqueue-failed', reason: 'state-failure' }); }
    }
    return { outcome: 'state-failure', reason, noticeAttempted: true, noticeReason: 'state-failure' };
  }
  private key(ctx: Ctx): string { const d = this.spec.dedupeKey(ctx); if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(d)) throw new Error('invalid self-heal dedupe key'); return `${this.spec.id}:${d}`; }
  private newEpisode(key: string): SelfHealEpisodeRecord { const now = this.now(); return { schemaVersion: 1, key, revision: 0, status: 'active', startedAt: now, attempts: 0, nextEligibleAt: 0, latch: emptyLatch(), notices: {}, recoveries: [], restart: null, updatedAt: now }; }
  private cas(row: SelfHealEpisodeRecord, update: (r: SelfHealEpisodeRecord) => SelfHealEpisodeRecord, guard?: () => boolean): SelfHealEpisodeRecord | null { return this.store.mutate(row.key, row.revision, (r) => ({ ...update(r), revision: r.revision + 1, updatedAt: this.now() }), guard); }
  private audit(input: Omit<SelfHealAuditEvent, 'at' | 'controllerId'>): void { const event = { ...input, at: this.now(), controllerId: this.spec.id }; try { this.store.appendAudit?.(event); } catch { /* secondary sink below */ } try { this.deps.audit(event); } catch { /* metadata audit best effort */ } }
}
function safeEligible<Ctx>(spec: SelfHealSpec<Ctx>, ctx: Ctx): { eligible: boolean; fence: string | null } { try { return spec.eligible(ctx); } catch { return { eligible: false, fence: null }; } }
function emptyLatch(): FailureEpisodeSnapshot { return { schemaVersion: 1, failingSince: null, failures: 0, signaledFor: null }; }
function keyHash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }
