/**
 * StopGateDb — SQLite persistence for the UnjustifiedStopGate.
 *
 * Spec: docs/specs/context-death-pitfall-prevention.md § (d)
 *
 * Tables (per spec § (d), lines 373-377):
 *   - sessions(session_id, agent_id, started_at)
 *   - session_continue_counts(session_id, count, updated_at)
 *   - session_stuck_state(session_id, last_ceiling_hit_at)
 *   - agent_eval_aggregate(agent_id, day_key, triggered_count,
 *     shadow_count, continue_count, ...)    — hourly rollup
 *   - annotations(event_id, operator, verdict, rationale, dwell_ms,
 *     created_at)                           — operator review tool
 *   - events(event_id, session_id, ts, mode, decision, rule,
 *     invalidKind, evidence_pointer_json, latency_ms, reason_preview)
 *     — decision log
 *
 * Storage: `~/.instar/<agent-id>/server-data/stop-gate.db` per spec §
 * P0.8 (outside project tree, chmod 600). For in-process tests we
 * support `:memory:`.
 *
 * Threat model: drift-correction, not security boundary. Session tampering
 * with the DB file is out of scope.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from './SqliteRegistry.js';
import fs from 'node:fs';
import path from 'node:path';
import type { StopGateBreakerState, StopGateBreakerStateStore } from './StopGateBreakerState.js';
import { emptyStopGateBreakerState, mintStopGateProbeToken, normalizeStopGateBreakerState } from './StopGateBreakerState.js';

// ── Types ─────────────────────────────────────────────────────────────

export type EvalMode = 'off' | 'shadow' | 'enforce';
export type Decision = 'continue' | 'allow' | 'escalate' | 'force_allow';
export type InvalidKind =
  | null
  | 'timeout'
  | 'malformed'
  | 'invalidRule'
  | 'invalidEvidence'
  | 'missingPointer'
  | 'llmUnavailable'
  | 'breakerOpen'
  | 'queue_shed_overload'
  | 'staleCompaction';

export interface EvalEvent {
  eventId: string;
  sessionId: string;
  ts: number;
  mode: EvalMode;
  decision: Decision | null; // null for fail-open failures
  rule: string | null;
  invalidKind: InvalidKind;
  evidencePointerJson: string | null;
  latencyMs: number;
  reasonPreview: string; // first ~200 chars of stop_reason
  agentId: string;
  // ── Turn-End Self-Deferral Guard (Phase A / shadow) — all NULLABLE.
  // Widened columns (spec docs/specs/turn-end-self-deferral-guard.md §3.4);
  // populated ONLY when the dev-gated `monitoring.selfDeferralGuard` guard is on
  // AND the authority emitted an allow-class U_SELF_DEFERRAL classification. No
  // raw message/user-turn text is ever added here — structured fields only.
  /** 1 = the turn-ending message hands the operator agent-ownable work; 0/null otherwise. */
  selfDeferral?: number | null;
  /** 'high' | 'medium' | 'low' — the classifier's confidence. */
  confidence?: string | null;
  /** 1 = the deferred work is something the agent could do within its own means. */
  agentOwnable?: number | null;
  /** 1 = the message ends the turn (vs a mid-turn continuation). */
  turnEnding?: number | null;
  /** The allow-class rule id the authority cited (e.g. U_SELF_DEFERRAL). */
  allowClassRule?: string | null;
  /** sha256 of the STABLE authority SYSTEM_PROMPT template (edit-detection). */
  promptHash?: string | null;
  /** 'autonomous' | 'non-autonomous' — derived from getHotPathState. */
  surface?: string | null;
  /** Count of user turns fed to the judge (0 = judged context-blind). */
  contextTurns?: number | null;
}

export interface Annotation {
  eventId: string;
  operator: string;
  verdict: 'correct' | 'incorrect' | 'unclear';
  rationale: string;
  dwellMs: number;
  createdAt: number;
}

export interface ContinueCountState {
  sessionId: string;
  count: number;
  updatedAt: number;
}

// ── Schema ────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
     session_id TEXT PRIMARY KEY,
     agent_id   TEXT NOT NULL,
     started_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS session_continue_counts (
     session_id TEXT PRIMARY KEY,
     count      INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS session_stuck_state (
     session_id         TEXT PRIMARY KEY,
     last_ceiling_hit_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     event_id              TEXT PRIMARY KEY,
     session_id            TEXT NOT NULL,
     agent_id              TEXT NOT NULL,
     ts                    INTEGER NOT NULL,
     mode                  TEXT NOT NULL,
     decision              TEXT,
     rule                  TEXT,
     invalid_kind          TEXT,
     evidence_pointer_json TEXT,
     latency_ms            INTEGER NOT NULL,
     reason_preview        TEXT NOT NULL,
     self_deferral         INTEGER,
     confidence            TEXT,
     agent_ownable         INTEGER,
     turn_ending           INTEGER,
     allow_class_rule      TEXT,
     prompt_hash           TEXT,
     surface               TEXT,
     context_turns         INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_mode_outcome ON events(mode, decision, invalid_kind)`,
  `CREATE TABLE IF NOT EXISTS annotations (
     event_id   TEXT NOT NULL,
     operator   TEXT NOT NULL,
     verdict    TEXT NOT NULL CHECK(verdict IN ('correct','incorrect','unclear')),
     rationale  TEXT NOT NULL,
     dwell_ms   INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (event_id, operator, created_at)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_annotations_event ON annotations(event_id)`,
  `CREATE TABLE IF NOT EXISTS agent_eval_aggregate (
     agent_id        TEXT NOT NULL,
     day_key         TEXT NOT NULL,
     triggered_count INTEGER NOT NULL DEFAULT 0,
     shadow_count    INTEGER NOT NULL DEFAULT 0,
     continue_count  INTEGER NOT NULL DEFAULT 0,
     allow_count     INTEGER NOT NULL DEFAULT 0,
     escalate_count  INTEGER NOT NULL DEFAULT 0,
     failure_count   INTEGER NOT NULL DEFAULT 0,
     self_deferral_count INTEGER NOT NULL DEFAULT 0,
     updated_at      INTEGER NOT NULL,
     PRIMARY KEY (agent_id, day_key)
   )`,
  `CREATE TABLE IF NOT EXISTS authority_breaker_state (
     breaker_key          TEXT PRIMARY KEY,
     consecutive_failures INTEGER NOT NULL DEFAULT 0,
     open_until           INTEGER NOT NULL DEFAULT 0,
     probe_lease_until    INTEGER NOT NULL DEFAULT 0,
     probe_token          TEXT,
     first_opened_at      INTEGER NOT NULL DEFAULT 0,
     suppressed_count     INTEGER NOT NULL DEFAULT 0,
     updated_at           INTEGER NOT NULL DEFAULT 0
   )`,
];

// ── Turn-End Self-Deferral Guard (Phase A) — additive schema migration ─────
//
// StopGateDb historically had NO migration path: `CREATE TABLE IF NOT EXISTS`
// is a NO-OP on an already-existing on-disk DB, so new columns would silently
// never appear on a deployed agent (spec §3.4, FD7). We run an idempotent
// post-CREATE migration: for each new column, `PRAGMA table_info` → `ALTER
// TABLE ADD COLUMN` only if absent. Safe to run twice. Migration Parity
// Standard obligation (existing agents gain the columns on update).
const EVENTS_MIGRATION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['self_deferral', 'INTEGER'],
  ['confidence', 'TEXT'],
  ['agent_ownable', 'INTEGER'],
  ['turn_ending', 'INTEGER'],
  ['allow_class_rule', 'TEXT'],
  ['prompt_hash', 'TEXT'],
  ['surface', 'TEXT'],
  ['context_turns', 'INTEGER'],
];

// Age-based retention: prune `events` rows older than this many days. There is
// NO other bound on the events table (it grows one row per turn-end forever, and
// FD2 — the judge on every surface incl. long autonomous runs — is the highest-
// volume writer). Run cheaply on init (spec §3.4, FD7).
const RETENTION_DAYS = 30;

// ── StopGateDb class ──────────────────────────────────────────────────

export class StopGateDb implements StopGateBreakerStateStore {
  private db: BetterSqliteDatabase;
  private stmts!: {
    insertEvent: Database.Statement;
    insertAnnotation: Database.Statement;
    recentEvents: Database.Statement;
    eventById: Database.Statement;
    annotationsFor: Database.Statement;
    incrementContinueCount: Database.Statement;
    getContinueCount: Database.Statement;
    setStuck: Database.Statement;
    getStuck: Database.Statement;
    recordSessionStart: Database.Statement;
    getSessionStartedAt: Database.Statement;
    upsertAggregate: Database.Statement;
    aggregateFor: Database.Statement;
  };

  constructor(opts: { dbPath: string } | { db: BetterSqliteDatabase }) {
    if ('db' in opts) {
      this.db = opts.db;
    } else {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
      this.db = new Database(opts.dbPath);
      try {
        fs.chmodSync(opts.dbPath, 0o600);
      } catch {
        // chmod may fail on non-POSIX FS; not critical.
      }
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 10');

    for (const ddl of SCHEMA) this.db.exec(ddl);
    this.migrateSchema();
    this.pruneOldEvents();
    this.pruneOldBreakerStates();
    this.prepareStatements();
    // Close-on-exit registry — see SqliteRegistry.ts. Registered AFTER the db is
    // fully open so closeAllSqlite() never targets a half-constructed handle.
    this._unregisterSqlite = registerSqliteHandle(() => {
      try { this.db?.close(); } catch { /* already closed — fine */ }
    });
  }

  private _unregisterSqlite?: () => void;
  private _closed = false;

  /**
   * Idempotent additive migration for the Phase-A self-deferral columns.
   * `CREATE TABLE IF NOT EXISTS` does NOT add columns to an existing table, so
   * we PRAGMA-check + ALTER each missing column. Safe to run twice.
   */
  private migrateSchema(): void {
    const columnExists = (table: string, col: string): boolean => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some(r => r.name === col);
    };
    for (const [col, type] of EVENTS_MIGRATION_COLUMNS) {
      if (!columnExists('events', col)) {
        this.db.exec(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
      }
    }
    if (!columnExists('agent_eval_aggregate', 'self_deferral_count')) {
      this.db.exec('ALTER TABLE agent_eval_aggregate ADD COLUMN self_deferral_count INTEGER NOT NULL DEFAULT 0');
    }
  }

  /**
   * Delete `events` rows older than `maxAgeDays` days. Cheap age-based
   * retention (spec §3.4) — the only bound on the otherwise unbounded events
   * table. Called on init; also invokable directly. Never throws (retention is
   * best-effort; a failure must not block the gate).
   */
  pruneOldEvents(maxAgeDays = RETENTION_DAYS, now = Date.now()): number {
    try {
      const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
      const info = this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
      return Number(info.changes) || 0;
    } catch {
      // @silent-fallback-ok: retention is best-effort (spec §3.4) — a prune failure (locked db,
      // transient IO) must NEVER block the stop-gate; the rows are simply pruned on a later call.
      return 0;
    }
  }

  /** Best-effort retention for route identities no longer used by this agent. */
  pruneOldBreakerStates(maxAgeDays = RETENTION_DAYS, now = Date.now()): number {
    try {
      const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
      const pruneSql = 'DELETE' + ' FROM authority_breaker_state WHERE updated_at > 0 AND updated_at < ?';
      const info = this.db.prepare(pruneSql).run(cutoff);
      return Number(info.changes) || 0;
    } catch {
      // @silent-fallback-ok: retention is hygiene, never admission authority.
      return 0;
    }
  }

  private prepareStatements(): void {
    this.stmts = {
      insertEvent: this.db.prepare(`
        INSERT OR REPLACE INTO events
          (event_id, session_id, agent_id, ts, mode, decision, rule,
           invalid_kind, evidence_pointer_json, latency_ms, reason_preview,
           self_deferral, confidence, agent_ownable, turn_ending,
           allow_class_rule, prompt_hash, surface, context_turns)
        VALUES
          (@eventId, @sessionId, @agentId, @ts, @mode, @decision, @rule,
           @invalidKind, @evidencePointerJson, @latencyMs, @reasonPreview,
           @selfDeferral, @confidence, @agentOwnable, @turnEnding,
           @allowClassRule, @promptHash, @surface, @contextTurns)
      `),
      insertAnnotation: this.db.prepare(`
        INSERT INTO annotations
          (event_id, operator, verdict, rationale, dwell_ms, created_at)
        VALUES
          (@eventId, @operator, @verdict, @rationale, @dwellMs, @createdAt)
      `),
      recentEvents: this.db.prepare(`
        SELECT * FROM events
        ORDER BY ts DESC
        LIMIT ?
      `),
      eventById: this.db.prepare(`SELECT * FROM events WHERE event_id = ?`),
      annotationsFor: this.db.prepare(
        `SELECT * FROM annotations WHERE event_id = ? ORDER BY created_at ASC`
      ),
      incrementContinueCount: this.db.prepare(`
        INSERT INTO session_continue_counts (session_id, count, updated_at)
        VALUES (@sessionId, 1, @updatedAt)
        ON CONFLICT(session_id) DO UPDATE SET
          count = count + 1,
          updated_at = excluded.updated_at
        RETURNING count
      `),
      getContinueCount: this.db.prepare(
        `SELECT count, updated_at FROM session_continue_counts WHERE session_id = ?`
      ),
      setStuck: this.db.prepare(`
        INSERT INTO session_stuck_state (session_id, last_ceiling_hit_at)
        VALUES (@sessionId, @ts)
        ON CONFLICT(session_id) DO UPDATE SET
          last_ceiling_hit_at = excluded.last_ceiling_hit_at
      `),
      getStuck: this.db.prepare(
        `SELECT last_ceiling_hit_at FROM session_stuck_state WHERE session_id = ?`
      ),
      recordSessionStart: this.db.prepare(`
        INSERT OR IGNORE INTO sessions (session_id, agent_id, started_at)
        VALUES (@sessionId, @agentId, @startedAt)
      `),
      getSessionStartedAt: this.db.prepare(
        `SELECT started_at FROM sessions WHERE session_id = ?`
      ),
      upsertAggregate: this.db.prepare(`
        INSERT INTO agent_eval_aggregate
          (agent_id, day_key, triggered_count, shadow_count, continue_count,
           allow_count, escalate_count, failure_count, self_deferral_count, updated_at)
        VALUES
          (@agentId, @dayKey, @triggeredCount, @shadowCount, @continueCount,
           @allowCount, @escalateCount, @failureCount, @selfDeferralCount, @updatedAt)
        ON CONFLICT(agent_id, day_key) DO UPDATE SET
          triggered_count = triggered_count + excluded.triggered_count,
          shadow_count    = shadow_count + excluded.shadow_count,
          continue_count  = continue_count + excluded.continue_count,
          allow_count     = allow_count + excluded.allow_count,
          escalate_count  = escalate_count + excluded.escalate_count,
          failure_count   = failure_count + excluded.failure_count,
          self_deferral_count = self_deferral_count + excluded.self_deferral_count,
          updated_at      = excluded.updated_at
      `),
      aggregateFor: this.db.prepare(
        `SELECT * FROM agent_eval_aggregate WHERE agent_id = ? AND day_key = ?`
      ),
    };
  }

  recordEvent(event: EvalEvent): void {
    this.stmts.insertEvent.run({
      eventId: event.eventId,
      sessionId: event.sessionId,
      agentId: event.agentId,
      ts: event.ts,
      mode: event.mode,
      decision: event.decision,
      rule: event.rule,
      invalidKind: event.invalidKind,
      evidencePointerJson: event.evidencePointerJson,
      latencyMs: event.latencyMs,
      reasonPreview: event.reasonPreview,
      // Phase-A self-deferral columns — NULL unless the guard is on + the
      // authority emitted the classification. `?? null` keeps every existing
      // caller (force_allow, fail-open) valid without a change (better-sqlite3
      // requires every named param present).
      selfDeferral: event.selfDeferral ?? null,
      confidence: event.confidence ?? null,
      agentOwnable: event.agentOwnable ?? null,
      turnEnding: event.turnEnding ?? null,
      allowClassRule: event.allowClassRule ?? null,
      promptHash: event.promptHash ?? null,
      surface: event.surface ?? null,
      contextTurns: event.contextTurns ?? null,
    });
  }

  addAnnotation(ann: Annotation): void {
    this.stmts.insertAnnotation.run(ann);
  }

  recentEvents(limit = 100): EvalEvent[] {
    const rows = this.stmts.recentEvents.all(Math.max(1, Math.min(1000, limit))) as Array<Record<string, unknown>>;
    return rows.map(toEvalEvent);
  }

  eventById(eventId: string): EvalEvent | null {
    const row = this.stmts.eventById.get(eventId) as Record<string, unknown> | undefined;
    return row ? toEvalEvent(row) : null;
  }

  annotationsFor(eventId: string): Annotation[] {
    const rows = this.stmts.annotationsFor.all(eventId) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      eventId: String(r.event_id),
      operator: String(r.operator),
      verdict: r.verdict as Annotation['verdict'],
      rationale: String(r.rationale),
      dwellMs: Number(r.dwell_ms),
      createdAt: Number(r.created_at),
    }));
  }

  /** Increment the continue-count for a session. Returns the new value. */
  incrementContinueCount(sessionId: string, now = Date.now()): number {
    const row = this.stmts.incrementContinueCount.get({ sessionId, updatedAt: now }) as
      | { count: number }
      | undefined;
    return row?.count ?? 1;
  }

  getContinueCount(sessionId: string): ContinueCountState | null {
    const row = this.stmts.getContinueCount.get(sessionId) as
      | { count: number; updated_at: number }
      | undefined;
    if (!row) return null;
    return { sessionId, count: row.count, updatedAt: row.updated_at };
  }

  setStuck(sessionId: string, ts = Date.now()): void {
    this.stmts.setStuck.run({ sessionId, ts });
  }

  isStuck(sessionId: string): boolean {
    const row = this.stmts.getStuck.get(sessionId) as { last_ceiling_hit_at: number } | undefined;
    return !!row;
  }

  recordSessionStart(sessionId: string, agentId: string, startedAt = Date.now()): void {
    this.stmts.recordSessionStart.run({ sessionId, agentId, startedAt });
  }

  getSessionStartedAt(sessionId: string): number | null {
    const row = this.stmts.getSessionStartedAt.get(sessionId) as { started_at: number } | undefined;
    return row?.started_at ?? null;
  }

  rollupAggregate(opts: {
    agentId: string;
    dayKey: string;
    triggeredDelta?: number;
    shadowDelta?: number;
    continueDelta?: number;
    allowDelta?: number;
    escalateDelta?: number;
    failureDelta?: number;
    selfDeferralDelta?: number;
  }): void {
    this.stmts.upsertAggregate.run({
      agentId: opts.agentId,
      dayKey: opts.dayKey,
      triggeredCount: opts.triggeredDelta ?? 0,
      shadowCount: opts.shadowDelta ?? 0,
      continueCount: opts.continueDelta ?? 0,
      allowCount: opts.allowDelta ?? 0,
      escalateCount: opts.escalateDelta ?? 0,
      failureCount: opts.failureDelta ?? 0,
      selfDeferralCount: opts.selfDeferralDelta ?? 0,
      updatedAt: Date.now(),
    });
  }

  getAggregate(
    agentId: string,
    dayKey: string
  ): {
    triggered: number;
    shadow: number;
    continueCount: number;
    allowCount: number;
    escalateCount: number;
    failureCount: number;
    selfDeferralCount: number;
  } | null {
    const row = this.stmts.aggregateFor.get(agentId, dayKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      triggered: Number(row.triggered_count),
      shadow: Number(row.shadow_count),
      continueCount: Number(row.continue_count),
      allowCount: Number(row.allow_count),
      escalateCount: Number(row.escalate_count),
      failureCount: Number(row.failure_count),
      selfDeferralCount: Number(row.self_deferral_count ?? 0),
    };
  }

  loadBreakerState(breakerKey: string): StopGateBreakerState | null {
    const row = this.db.prepare('SELECT * FROM authority_breaker_state WHERE breaker_key = ?').get(breakerKey) as Record<string, unknown> | undefined;
    return row ? toBreakerState(row) : null;
  }

  private writeBreakerState(state: StopGateBreakerState): void {
    this.db.prepare(`
      INSERT INTO authority_breaker_state
        (breaker_key, consecutive_failures, open_until, probe_lease_until,
         probe_token, first_opened_at, suppressed_count, updated_at)
      VALUES (@breakerKey, @consecutiveFailures, @openUntil, @probeLeaseUntil,
              @probeToken, @firstOpenedAt, @suppressedCount, @updatedAt)
      ON CONFLICT(breaker_key) DO UPDATE SET
        consecutive_failures = excluded.consecutive_failures,
        open_until = excluded.open_until,
        probe_lease_until = excluded.probe_lease_until,
        probe_token = excluded.probe_token,
        first_opened_at = excluded.first_opened_at,
        suppressed_count = excluded.suppressed_count,
        updated_at = excluded.updated_at
    `).run(state);
  }

  recordBreakerFailure(input: {
    breakerKey: string;
    now: number;
    threshold: number;
    cooldownMs: number;
    probeToken?: string | null;
  }): StopGateBreakerState {
    const transition = this.db.transaction(() => {
      const raw = this.loadBreakerState(input.breakerKey) ?? emptyStopGateBreakerState(input.breakerKey);
      const state = normalizeStopGateBreakerState(raw, input.now, input.cooldownMs, input.cooldownMs);
      if (input.probeToken !== undefined && input.probeToken !== state.probeToken) return state;
      const consecutiveFailures = state.consecutiveFailures + 1;
      const opens = input.threshold > 0 && consecutiveFailures >= input.threshold;
      const next: StopGateBreakerState = {
        ...state,
        consecutiveFailures,
        openUntil: opens ? input.now + input.cooldownMs : 0,
        probeLeaseUntil: 0,
        probeToken: null,
        firstOpenedAt: opens ? (state.firstOpenedAt || input.now) : state.firstOpenedAt,
        updatedAt: input.now,
      };
      this.writeBreakerState(next);
      return next;
    });
    return transition.immediate();
  }

  tryAcquireBreakerProbe(input: {
    breakerKey: string;
    now: number;
    cooldownMs: number;
    leaseMs: number;
  }): { acquired: boolean; token: string | null; state: StopGateBreakerState } {
    const transition = this.db.transaction(() => {
      const raw = this.loadBreakerState(input.breakerKey) ?? emptyStopGateBreakerState(input.breakerKey);
      const state = normalizeStopGateBreakerState(raw, input.now, input.cooldownMs, input.leaseMs);
      if (input.now < state.openUntil || input.now < state.probeLeaseUntil) {
        return { acquired: false, token: null, state };
      }
      const token = mintStopGateProbeToken();
      const next: StopGateBreakerState = {
        ...state,
        probeLeaseUntil: input.now + input.leaseMs,
        probeToken: token,
        updatedAt: input.now,
      };
      this.writeBreakerState(next);
      return { acquired: true, token, state: next };
    });
    return transition.immediate();
  }

  resetBreakerState(breakerKey: string, probeToken?: string | null): StopGateBreakerState {
    const transition = this.db.transaction(() => {
      const current = this.loadBreakerState(breakerKey) ?? emptyStopGateBreakerState(breakerKey);
      if (probeToken !== undefined && probeToken !== current.probeToken) return current;
      const next = emptyStopGateBreakerState(breakerKey);
      next.updatedAt = Date.now();
      this.writeBreakerState(next);
      return next;
    });
    return transition.immediate();
  }

  addBreakerSuppressions(breakerKey: string, count: number, now: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.db.prepare(`
      INSERT INTO authority_breaker_state
        (breaker_key, consecutive_failures, open_until, probe_lease_until,
         probe_token, first_opened_at, suppressed_count, updated_at)
      VALUES (?, 0, 0, 0, NULL, 0, ?, ?)
      ON CONFLICT(breaker_key) DO UPDATE SET
        suppressed_count = suppressed_count + excluded.suppressed_count,
        updated_at = MAX(updated_at, excluded.updated_at)
    `).run(breakerKey, Math.floor(count), now);
  }

  close(): void {
    // Unregister BEFORE closing our own handle so closeAllSqlite() never
    // double-closes it. Idempotent via the _closed guard (the spec flagged
    // StopGateDb.close() as lacking one — better-sqlite3 .close() throws on a
    // second call).
    if (this._unregisterSqlite) { this._unregisterSqlite(); this._unregisterSqlite = undefined; }
    if (this._closed) return;
    this._closed = true;
    this.db.close();
  }
}

function toEvalEvent(row: Record<string, unknown>): EvalEvent {
  return {
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    agentId: String(row.agent_id),
    ts: Number(row.ts),
    mode: row.mode as EvalMode,
    decision: (row.decision ?? null) as Decision | null,
    rule: (row.rule ?? null) as string | null,
    invalidKind: (row.invalid_kind ?? null) as InvalidKind,
    evidencePointerJson: (row.evidence_pointer_json ?? null) as string | null,
    latencyMs: Number(row.latency_ms),
    reasonPreview: String(row.reason_preview),
    selfDeferral: (row.self_deferral ?? null) as number | null,
    confidence: (row.confidence ?? null) as string | null,
    agentOwnable: (row.agent_ownable ?? null) as number | null,
    turnEnding: (row.turn_ending ?? null) as number | null,
    allowClassRule: (row.allow_class_rule ?? null) as string | null,
    promptHash: (row.prompt_hash ?? null) as string | null,
    surface: (row.surface ?? null) as string | null,
    contextTurns: (row.context_turns ?? null) as number | null,
  };
}

function toBreakerState(row: Record<string, unknown>): StopGateBreakerState {
  return {
    breakerKey: String(row.breaker_key),
    consecutiveFailures: Number(row.consecutive_failures),
    openUntil: Number(row.open_until),
    probeLeaseUntil: Number(row.probe_lease_until),
    probeToken: typeof row.probe_token === 'string' ? row.probe_token : null,
    firstOpenedAt: Number(row.first_opened_at),
    suppressedCount: Number(row.suppressed_count),
    updatedAt: Number(row.updated_at),
  };
}

export function dayKeyFor(ts = Date.now()): string {
  // UTC YYYY-MM-DD
  return new Date(ts).toISOString().slice(0, 10);
}
