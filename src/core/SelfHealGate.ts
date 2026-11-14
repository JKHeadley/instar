import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FailureEpisodeLatch, type FailureEpisodeSnapshot } from './FailureEpisodeLatch.js';
import { registerSqliteHandle } from './SqliteRegistry.js';
import type { Admission, AdmissionToken, AdmitOpts, DerivedTarget } from '../monitoring/selfaction/types.js';

export type SelfHealSeverity = 'recoverable' | 'irreversible' | 'data-loss' | 'security' | 'unknown';
export type SelfHealEvidenceCode = 'source-absent' | 'schema-stale' | 'repaired' | 'already-healthy' | 'malformed-json' | 'access-denied' | 'io-error' | 'symlink-refused' | 'non-regular-refused' | 'sqlite-busy' | 'fence-stale' | 'verification-failed' | 'remediation-timeout';
export type SelfHealRemediationResult = { outcome: 'healed' | 'pending-restart' | 'not-healed'; evidence: SelfHealEvidenceCode };
type NoticeReason = 'unknown-severity' | 'irreversible' | 'data-loss' | 'security' | 'latency' | 'max-attempts' | 'wall-clock' | 'flap' | 'state-failure';
type NoticeState = { state: 'pending' | 'enqueued'; id: string };
type RestartState = { state: 'required' | 'requested'; requestingBootId: string; stableRequestId: string };

export interface SelfHealNotice { id: string; controllerId: string; reason: NoticeReason; priority: 'HIGH' | 'URGENT' }
export interface SelfHealAuditEvent { at: number; controllerId: string; event: string; reason?: string; attempt?: number; elapsedMs?: number }
export interface SelfHealSpec<Ctx> {
  id: string; controllerResource: 'hardware-bound' | 'pool-shared'; episodeAuthority: 'process-local' | 'durable-machine-local'; classId: string;
  severity(ctx: Ctx): SelfHealSeverity; dedupeKey(ctx: Ctx): string; eligible(ctx: Ctx): { eligible: boolean; fence: string | null };
  /** Synchronous remediation (the default mode). A returned promise is refused. */
  remediation?(ctx: Ctx): SelfHealRemediationResult; maxAttempts: number; maxWallClockMs: number; backoffMs(attempt: number): number;
  notificationLatencyCeilingMs: number; flap: { maxRecoveries: number; windowMs: number };
  remediationActions: { operation: string; idempotencyGuard: string; compensation: string };
  restartVerified?(ctx: Ctx): boolean;
  /**
   * `pool-shared` controllers only (and required for them): is this machine the
   * owner of the target? Anything but `true` REFUSES the attempt before an
   * episode is created or touched, and again inside the atomic claim — a
   * machine that does not own the target never remediates it.
   */
  isOwner?(ctx: Ctx): boolean | 'unknown';
  /**
   * `'async'` runs `remediationAsync` (rollback, re-stage), awaited under
   * `maxRemediationMs`; a timeout or rejection is `not-healed`. One remediation
   * per episode key is in flight at a time in this process.
   */
  remediationMode?: 'sync' | 'async';
  remediationAsync?(ctx: Ctx): Promise<SelfHealRemediationResult>;
  maxRemediationMs?: number;
  /**
   * How long the gate's prune keeps an EXHAUSTED episode after its last
   * update (default 24 h). Within it the same incident key stays exhausted,
   * so a prune can never re-open a ladder that already gave up and paged.
   */
  exhaustedRetentionMs?: number;
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
  /**
   * Delete terminal episodes (recovered, or exhausted with every notice
   * enqueued); returns how many. An exhausted row whose notice never went out
   * is KEPT, so the gate can retry the notice.
   */
  pruneTerminal?(): number;
  /** Delete the episodes the predicate selects (unparseable rows are always kept); returns how many. */
  pruneWhere?(select: (record: SelfHealEpisodeRecord) => boolean): number;
}

/** Terminal and safe to forget: recovered, or exhausted with no notice left pending. */
export function isPrunableTerminal(r: SelfHealEpisodeRecord): boolean {
  if (r.status === 'recovered') return r.restart === null;
  if (r.status !== 'exhausted') return false;
  return Object.values(r.notices).every((n) => n?.state === 'enqueued');
}

/**
 * Store bounds. `maxRows` (default 256) caps the store. `ring` bounds the
 * episodes per group (e.g. topic+cause, with per-incident keys): creating one
 * more evicts the group's OLDEST TERMINAL episode and refuses only when every
 * episode in the group is still active. With a ring, the global cap also
 * evicts the oldest terminal episode before refusing.
 */
export interface SelfHealStoreOptions { maxRows?: number; ring?: { groupOf(key: string): string; perGroup: number } }

function validateStoreOptions(o: SelfHealStoreOptions): { maxRows: number; ring: SelfHealStoreOptions['ring'] | null } {
  const maxRows = o.maxRows ?? 256;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100_000) throw new Error('invalid self-heal store maxRows');
  if (o.ring && (typeof o.ring.groupOf !== 'function' || !Number.isInteger(o.ring.perGroup) || o.ring.perGroup < 1 || o.ring.perGroup > 64)) throw new Error('invalid self-heal ring');
  return { maxRows, ring: o.ring ?? null };
}

/** Which keys to evict (oldest terminal first) so one more row fits; null => refuse. */
function evictionsFor(rows: Array<{ key: string; status: string; updatedAt: number }>, newKey: string, maxRows: number, ring: SelfHealStoreOptions['ring'] | null): string[] | null {
  if (rows.some((r) => r.key === newKey)) return [];
  const evict = new Set<string>();
  const terminalOldestFirst = (xs: typeof rows) => xs.filter((r) => r.status !== 'active' && !evict.has(r.key)).sort((a, b) => a.updatedAt - b.updatedAt);
  if (ring) {
    const g = ring.groupOf(newKey);
    const same = rows.filter((r) => ring.groupOf(r.key) === g);
    const t = terminalOldestFirst(same);
    let over = same.length - ring.perGroup + 1;
    while (over > 0) { const victim = t.shift(); if (!victim) return null; evict.add(victim.key); over--; }
  }
  let over = rows.length - evict.size - maxRows + 1;
  if (over > 0) {
    if (!ring) return null;
    const t = terminalOldestFirst(rows);
    while (over > 0) { const victim = t.shift(); if (!victim) return null; evict.add(victim.key); over--; }
  }
  return [...evict];
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
  private readonly bounds: { maxRows: number; ring: SelfHealStoreOptions['ring'] | null } | null;
  /** No options => unbounded (the historical in-memory behaviour). */
  constructor(options?: SelfHealStoreOptions) { this.bounds = options ? validateStoreOptions(options) : null; }
  load(key: string): SelfHealEpisodeRecord | null { const row = this.rows.get(key); return row ? cloneRecord(row) : null; }
  create(record: SelfHealEpisodeRecord): SelfHealEpisodeRecord | null {
    if (this.rows.has(record.key)) return null; const row = validateRecord(cloneRecord(record));
    if (this.bounds) {
      const evict = evictionsFor([...this.rows.values()].map((r) => ({ key: r.key, status: r.status, updatedAt: r.updatedAt })), row.key, this.bounds.maxRows, this.bounds.ring);
      if (evict === null) return null;
      for (const k of evict) this.rows.delete(k);
    }
    this.rows.set(row.key, row); return cloneRecord(row);
  }
  pruneTerminal(): number { return this.pruneWhere(isPrunableTerminal); }
  pruneWhere(select: (record: SelfHealEpisodeRecord) => boolean): number { let n = 0; for (const [k, r] of this.rows) if (select(cloneRecord(r))) { this.rows.delete(k); n++; } return n; }
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
  private readonly bounds: { maxRows: number; ring: SelfHealStoreOptions['ring'] | null };
  constructor(dbPath: string, options: SelfHealStoreOptions = {}) {
    this.bounds = validateStoreOptions(options);
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
      if (!this.bounds.ring) {
        const count = (this.db.prepare('SELECT COUNT(*) AS n FROM self_heal_episodes').get() as { n: number }).n; if (count >= this.bounds.maxRows) return false;
      } else {
        const all = (this.db.prepare('SELECT episode_key AS key, payload, updated_at AS updatedAt FROM self_heal_episodes').all() as Array<{ key: string; payload: string; updatedAt: number }>)
          .map((r) => ({ key: r.key, updatedAt: r.updatedAt, status: statusOf(r.payload) }));
        const evict = evictionsFor(all, row.key, this.bounds.maxRows, this.bounds.ring);
        if (evict === null) return false;
        const del = this.db.prepare('DELETE FROM self_heal_episodes WHERE episode_key=?');
        for (const k of evict) del.run(k);
      }
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
  pruneTerminal(): number { return this.pruneWhere(isPrunableTerminal); }
  pruneWhere(select: (record: SelfHealEpisodeRecord) => boolean): number {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare('SELECT episode_key AS key, payload FROM self_heal_episodes').all() as Array<{ key: string; payload: string }>;
      const del = this.db.prepare('DELETE FROM self_heal_episodes WHERE episode_key=?');
      let n = 0;
      for (const r of rows) {
        let rec: SelfHealEpisodeRecord;
        try { rec = validateRecord(JSON.parse(r.payload)); } catch { continue; } // @silent-fallback-ok — an unreadable row is kept, never deleted on a guess
        if (select(rec)) { del.run(r.key); n++; }
      }
      return n;
    });
    try { return tx(); } catch (error) { if (/busy|locked/i.test(String(error))) return 0; throw error; } // @silent-fallback-ok — a busy store prunes on the next tick
  }
  appendAudit(event: SelfHealAuditEvent): void { this.db.prepare('INSERT OR REPLACE INTO self_heal_audit(id,at_ms,controller_id,event,reason,attempt,elapsed_ms) VALUES(?,?,?,?,?,?,?)').run(event.at % 1024, event.at, event.controllerId, event.event, event.reason ?? null, event.attempt ?? null, event.elapsedMs ?? null); }
  close(): void { this.unregisterSqlite(); this.db.close(); }
}

/** An unparseable payload counts as ACTIVE: never evicted or pruned on a guess. */
function statusOf(payload: string): string {
  try { const s = (JSON.parse(payload) as { status?: unknown }).status; return typeof s === 'string' ? s : 'active'; } catch { return 'active'; } // @silent-fallback-ok — unreadable rows are kept, not deleted
}

export interface SelfHealGateDeps {
  admit(target: DerivedTarget, opts: AdmitOpts): Promise<Admission>; consumeToken(token: AdmissionToken, controllerId: string, opts: { targetKey: string; nowMs: number }): { proceed: boolean; valid: boolean; reason?: string };
  notify(notice: SelfHealNotice): void | Promise<void>; audit(event: SelfHealAuditEvent): void; now?: () => number; episodeStore?: SelfHealEpisodeStore;
  bootId?: string; requestRestart?: (stableRequestId: string) => boolean;
}

export class SelfHealGate<Ctx> {
  private readonly now: () => number; private readonly store: SelfHealEpisodeStore; private readonly bootId: string;
  private readonly stateFailureNotices = new Set<string>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly spec: SelfHealSpec<Ctx>, private readonly deps: SelfHealGateDeps) {
    if (spec.controllerResource === 'pool-shared') {
      if (typeof spec.isOwner !== 'function') throw new Error('a pool-shared SelfHealGate controller requires isOwner');
      // Its prune is scoped by the `<id>:` key prefix; a `:` in the id could overlap another ladder's prefix.
      if (spec.id.includes(':')) throw new Error('a pool-shared SelfHealGate id must not contain ":"');
    }
    else if (spec.controllerResource !== 'hardware-bound') throw new Error('invalid SelfHealGate controllerResource');
    if ((spec.remediationMode ?? 'sync') === 'sync') { if (typeof spec.remediation !== 'function') throw new Error('sync SelfHealGate requires remediation'); }
    else if (spec.remediationMode === 'async') {
      if (typeof spec.remediationAsync !== 'function') throw new Error('async SelfHealGate requires remediationAsync');
      if (!Number.isFinite(spec.maxRemediationMs) || (spec.maxRemediationMs as number) <= 0) throw new Error('async SelfHealGate requires maxRemediationMs');
      // setTimeout overflows above 2^31-1 ms (fires at once); and a remediation may not outlive its episode's wall clock.
      if ((spec.maxRemediationMs as number) > Math.min(2 ** 31 - 1, spec.maxWallClockMs)) throw new Error('maxRemediationMs must not exceed maxWallClockMs');
    } else throw new Error('invalid remediationMode');
    // A retention below the wall clock (or NaN) would re-open an exhausted incident and page again, or never prune.
    if (spec.exhaustedRetentionMs !== undefined && (!Number.isFinite(spec.exhaustedRetentionMs) || spec.exhaustedRetentionMs < spec.maxWallClockMs)) throw new Error('exhaustedRetentionMs must be finite and at least maxWallClockMs');
    if (!Number.isInteger(spec.maxAttempts) || spec.maxAttempts < 1 || spec.maxAttempts > 32) throw new Error('invalid maxAttempts');
    for (const value of [spec.maxWallClockMs, spec.notificationLatencyCeilingMs, spec.flap.maxRecoveries, spec.flap.windowMs]) if (!Number.isFinite(value) || value <= 0) throw new Error('invalid SelfHealGate bound');
    this.now = deps.now ?? Date.now; this.store = deps.episodeStore ?? new InMemorySelfHealEpisodeStore(); this.bootId = deps.bootId ?? crypto.randomUUID();
  }
  /**
   * The per-tick pruning of THIS ladder's episodes: recovered ones at once;
   * exhausted ones (every notice out) only after `exhaustedRetentionMs`, so the
   * same incident cannot re-open a ladder that already gave up and paged; and
   * ABANDONED active ones — IDLE
   * (untouched) for a whole wall-clock budget, with no restart pending and no
   * remediation in flight here (e.g. ownership moved mid-incident, so this
   * machine may no longer close or exhaust it). Idle, not old: a ladder still
   * being attempted rewrites its row every attempt, so it reaches `exhausted`
   * and its notice through `attempt` whatever order a tick calls prune and
   * attempt in. Without the abandoned rule such rows would fill the ring and
   * refuse that topic+cause forever.
   */
  pruneTerminal(): number {
    const prefix = `${this.spec.id}:`; const now = this.now();
    let abandoned = 0;
    const select = (r: SelfHealEpisodeRecord): boolean => {
      if (!r.key.startsWith(prefix)) return false;
      if (r.status === 'recovered') return isPrunableTerminal(r);
      if (r.status === 'exhausted') return isPrunableTerminal(r) && now - r.updatedAt >= (this.spec.exhaustedRetentionMs ?? 24 * 60 * 60_000);
      const idle = r.status === 'active' && r.restart === null && !this.inFlight.has(r.key) && now - r.updatedAt >= this.spec.maxWallClockMs;
      if (idle) abandoned++;
      return idle;
    };
    try {
      const n = this.store.pruneWhere ? this.store.pruneWhere(select) : (this.store.pruneTerminal?.() ?? 0);
      if (abandoned > 0) this.audit({ event: 'pruned-abandoned-active', attempt: abandoned });
      return n;
    } catch { this.audit({ event: 'prune-failed' }); return 0; } // @silent-fallback-ok — audited; prunes again next tick
  }
  needsRestartVerification(ctx: Ctx): boolean { return this.store.load(this.key(ctx))?.restart !== null; }
  async attempt(ctx: Ctx): Promise<SelfHealResult> { const began = this.now(); try { return await this.attemptInner(ctx); } catch { return this.stateFailureWithNotice('store-operation-failed'); } finally { this.audit({ event: 'attempt-finished', elapsedMs: Math.max(0, this.now() - began) }); } }
  recordHealthy(ctx: Ctx): SelfHealResult {
    if (!this.ownsTarget(ctx)) return { outcome: 'governed', reason: 'not-owner' };
    const current = this.store.load(this.key(ctx)); if (!current) return { outcome: 'healed', reason: 'already-healthy' }; if (current.status === 'exhausted') return { outcome: 'exhausted', reason: 'terminal' };
    if (current.restart) return { outcome: 'governed', reason: 'restart-verification-required' };
    const next = this.cas(current, (row) => ({ ...row, status: 'recovered', recoveries: [...row.recoveries, this.now()].slice(-64), restart: null }));
    return next ? { outcome: 'healed', reason: 'recorded-healthy' } : { outcome: 'busy', reason: 'revision-conflict' };
  }
  private async attemptInner(ctx: Ctx): Promise<SelfHealResult> {
    // A pool-shared controller REFUSES on a machine that is not the owner,
    // before any episode is created or touched.
    // (Not audited: a non-owner refuses on every tick, and the audit table is a small ring.)
    if (!this.ownsTarget(ctx)) return { outcome: 'governed', reason: 'not-owner' };
    const key = this.key(ctx);
    if (this.inFlight.has(key)) return { outcome: 'busy', reason: 'remediation-in-flight' }; let row = this.store.load(key); if (!row) { const fresh = this.newEpisode(key); row = this.store.create(fresh) ?? this.store.load(key); } if (!row) return this.stateFailureWithNotice('create-failed');
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
    if (row.status === 'exhausted') return this.retryPendingNotices(row);
    const latch = new FailureEpisodeLatch({ signalAfterMs: this.spec.notificationLatencyCeilingMs, now: this.now }); latch.restore(row.latch); const failure = latch.recordFailure();
    const detected = this.cas(row, (r) => ({ ...r, latch: latch.snapshot() })); if (!detected) return { outcome: 'busy', reason: 'revision-conflict' }; row = detected;
    if (failure.shouldSignal) { const notice = await this.ensureNotice(row, 'latency'); row = notice.row; }
    const now = this.now(); const recent = row.recoveries.filter((at) => now - at <= this.spec.flap.windowMs);
    if (now - row.startedAt >= this.spec.maxWallClockMs) return this.exhaust(row, 'wall-clock'); if (recent.length >= this.spec.flap.maxRecoveries) return this.exhaust(row, 'flap'); if (row.attempts >= this.spec.maxAttempts) return this.exhaust(row, 'max-attempts');
    if (row.nextEligibleAt > now) return { outcome: 'backoff', reason: 'not-eligible-yet' };
    const eligibility = safeEligible(this.spec, ctx); if (!eligibility.eligible || !eligibility.fence) return { outcome: 'governed', reason: 'fence-stale' };
    const target: DerivedTarget = { key: keyHash(key), classId: this.spec.classId, keyIsVolatile: false };
    const admission = await this.deps.admit(target, { incarnation: eligibility.fence, eligible: () => safeEligible(this.spec, ctx).fence === eligibility.fence && this.ownsTarget(ctx), onAdmitted: (token) => { void this.runAdmitted(ctx, target, token).catch(() => { void this.stateFailureWithNotice('queued-attempt-failed'); }); }, lane: 'job', nowMs: now });
    if (admission.outcome !== 'allow') return { outcome: 'governed', reason: admission.outcome }; return this.runAdmitted(ctx, target, admission.token);
  }
  private async runAdmitted(ctx: Ctx, target: DerivedTarget, token: AdmissionToken): Promise<SelfHealResult> {
    // A queued admission can fire after ownership moved: refuse before touching anything.
    if (!this.ownsTarget(ctx)) return { outcome: 'governed', reason: 'not-owner' };
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
    if (this.inFlight.has(row.key)) return { outcome: 'busy', reason: 'remediation-in-flight', tokenValid: consumed.valid };
    const claim = this.cas(row, (r) => ({ ...r, attempts: r.attempts + 1 }), () => {
      const live = safeEligible(this.spec, ctx); return live.eligible && live.fence === eligibility.fence && this.ownsTarget(ctx);
    });
    if (!claim) return { outcome: 'governed', reason: 'fence-stale-or-revision-conflict' }; row = claim;
    let result: SelfHealRemediationResult;
    if (this.spec.remediationMode === 'async') {
      const key = row.key;
      this.inFlight.add(key);
      // The in-flight hold lasts until the WORK settles, not until the gate
      // stops waiting: a timed-out remediation may still be running, and a
      // second one for the same key must not start beside it. Bounded by the
      // episode's wall clock so a promise that never settles cannot pin the key.
      let work: Promise<SelfHealRemediationResult>;
      try { work = Promise.resolve(this.spec.remediationAsync!(ctx)); } catch (e) { work = Promise.reject(e); }
      let released = false;
      const release = () => { if (!released) { released = true; this.inFlight.delete(key); } };
      const cap = setTimeout(release, this.spec.maxWallClockMs); cap.unref?.();
      work.then(() => { clearTimeout(cap); release(); }, () => { clearTimeout(cap); release(); });
      try { result = validResult(await withTimeout(work, this.spec.maxRemediationMs!)); }
      catch (e) { result = { outcome: 'not-healed', evidence: e instanceof RemediationTimeout ? 'remediation-timeout' : 'io-error' }; }
      // The await yielded: ownership and the row may have moved.
      if (!this.ownsTarget(ctx)) return { outcome: 'governed', reason: 'not-owner', tokenValid: consumed.valid };
      row = this.store.load(key) ?? row;
      if (row.status !== 'active') return { outcome: 'busy', reason: 'episode-changed-during-remediation', tokenValid: consumed.valid };
    } else {
      try { result = this.spec.remediation!(ctx); if (result && typeof (result as unknown as { then?: unknown }).then === 'function') throw new Error('async remediation forbidden'); } catch { result = { outcome: 'not-healed', evidence: 'io-error' }; }
    }
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
  /** An exhausted episode whose notice never went out retries it (the row is kept from pruning until it does). */
  private async retryPendingNotices(row: SelfHealEpisodeRecord): Promise<SelfHealResult> {
    const pending = (Object.entries(row.notices) as Array<[NoticeReason, NoticeState | undefined]>).filter(([, n]) => n?.state === 'pending');
    for (const [reason] of pending) { const r = await this.ensureNotice(row, reason); row = r.row; }
    return { outcome: 'exhausted', reason: 'terminal', ...(pending.length ? { noticeAttempted: true } : {}) };
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
  private ownsTarget(ctx: Ctx): boolean {
    if (this.spec.controllerResource !== 'pool-shared') return true;
    try { return this.spec.isOwner!(ctx) === true; } catch { return false; } // @silent-fallback-ok — an owner check that throws is not ownership
  }
  private key(ctx: Ctx): string { const d = this.spec.dedupeKey(ctx); if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(d)) throw new Error('invalid self-heal dedupe key'); return `${this.spec.id}:${d}`; }
  private newEpisode(key: string): SelfHealEpisodeRecord { const now = this.now(); return { schemaVersion: 1, key, revision: 0, status: 'active', startedAt: now, attempts: 0, nextEligibleAt: 0, latch: emptyLatch(), notices: {}, recoveries: [], restart: null, updatedAt: now }; }
  private cas(row: SelfHealEpisodeRecord, update: (r: SelfHealEpisodeRecord) => SelfHealEpisodeRecord, guard?: () => boolean): SelfHealEpisodeRecord | null { return this.store.mutate(row.key, row.revision, (r) => ({ ...update(r), revision: r.revision + 1, updatedAt: this.now() }), guard); }
  private audit(input: Omit<SelfHealAuditEvent, 'at' | 'controllerId'>): void { const event = { ...input, at: this.now(), controllerId: this.spec.id }; try { this.store.appendAudit?.(event); } catch { /* secondary sink below */ } try { this.deps.audit(event); } catch { /* metadata audit best effort */ } }
}
class RemediationTimeout extends Error {}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RemediationTimeout('remediation-timeout')), ms); timer.unref?.(); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}
function validResult(r: unknown): SelfHealRemediationResult {
  const o = r as SelfHealRemediationResult | null;
  return o && ['healed', 'pending-restart', 'not-healed'].includes(o.outcome) && typeof o.evidence === 'string' ? o : { outcome: 'not-healed', evidence: 'io-error' };
}
function safeEligible<Ctx>(spec: SelfHealSpec<Ctx>, ctx: Ctx): { eligible: boolean; fence: string | null } { try { return spec.eligible(ctx); } catch { return { eligible: false, fence: null }; } }
function emptyLatch(): FailureEpisodeSnapshot { return { schemaVersion: 1, failingSince: null, failures: 0, signaledFor: null }; }
function keyHash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }
