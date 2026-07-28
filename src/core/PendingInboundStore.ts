/**
 * PendingInboundStore — durable custody store for inbound messages the router
 * cannot deliver right now (Durable Inbound Message Queue spec §1).
 *
 * Spec: docs/specs/durable-inbound-message-queue.md (CMT-1118).
 *
 * Path: `<stateDir>/state/pending-inbound.<sanitizedAgentId>.sqlite`, 0600.
 * Pattern: PendingRelayStore, with the spec's named deviations:
 *   - `synchronous=FULL` — a custody-ack must survive power loss; this store
 *     has no sender-side exit-1 backstop, and write volume is
 *     human-message-rate.
 *   - chmod 0600 happens BEFORE the WAL pragma so the -wal/-shm sidecars
 *     inherit the mode.
 *   - The DB handle is a #private field — no raw-handle export, every
 *     mutation is a named method (spec §1 round-8: the single-writer executor
 *     is a CONTRACT, enforced by encapsulation + a unit test, not convention).
 *
 * Sanitization-collision caveat (inherited from PendingRelayStore): two agent
 * ids that sanitize to the same string would share a file. Same blast radius
 * as the relay store — same-machine, same-user; documented, not defended.
 *
 * The store is data + invariants only. Policy (selection, holds, halt, clock
 * discipline) lives in QueueDrainLoop; the store's methods take explicit
 * `nowIso`/`monoMs` so the policy layer owns time.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from './SqliteRegistry.js';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────

export type InboundEntryState =
  | 'queued'
  | 'claimed'
  | 'delivered'
  | 'expired'
  | 'dropped-overflow';

const NON_TERMINAL: InboundEntryState[] = ['queued', 'claimed'];
const TERMINAL: InboundEntryState[] = ['delivered', 'expired', 'dropped-overflow'];

export interface SenderEnvelope {
  userId?: string | number;
  username?: string;
  firstName?: string;
}

export interface PendingInboundRow {
  enqueue_seq: number;
  session_key: string;
  message_id: string;
  payload: string | null;
  payload_bytes: number;
  sender_envelope: string | null;
  sender_display: string | null;
  topic_metadata: string | null;
  reason: string;
  state: InboundEntryState;
  terminal_reason: string | null;
  enqueued_at: string;
  enqueued_mono: number | null;
  boot_session_id: string | null;
  lease_epoch: string | null;
  first_held_at: string | null;
  first_frozen_at: string | null;
  total_frozen_ms: number;
  frozen_since: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  delivered_unconfirmed: 0 | 1;
  status_history: string;
}

export interface EnqueueInput {
  sessionKey: string;
  messageId: string;
  payload: string;
  senderEnvelope?: SenderEnvelope | null;
  topicMetadata?: unknown;
  reason: string;
  /** Tenure id at enqueue (§3.5) — opaque string from the drain's tenure source. */
  tenure: string | null;
  nowIso: string;
  monoMs: number | null;
  bootSessionId: string | null;
  /** When a pause is durably in effect, new rows are frozen at enqueue (§3.6 round-10). */
  frozenAtEnqueue?: boolean;
}

export interface InboundQueueBounds {
  maxPerSession: number;
  maxTotal: number;
  hardMaxTotal: number;
  maxPayloadBytes: number;
}

export type EnqueueOutcome =
  | { result: 'queued'; seq: number; evicted: EvictedRowInfo | null }
  | { result: 'already-queued'; existingState: InboundEntryState }
  | { result: 'refused'; reason: string };

/** Loss-report locator for an evicted/expired row — NEVER payload content. */
export interface EvictedRowInfo {
  sessionKey: string;
  messageId: string;
  enqueuedAt: string;
  payloadBytes: number;
  senderDisplay: string | null;
  reason: string;
}

export type ReceiptClass = 'injection' | 'remote';

export interface ReceiptRow {
  session_key: string;
  message_id: string;
  class: ReceiptClass;
  created_at: string;
  injected: 0 | 1;
  reported: 0 | 1;
}

/**
 * Durable counter keys (meta table) — spec §2.4 dry-run counters, §4.5 hold
 * counters, and the observability counters. Well-known keys:
 * wouldEnqueue, wouldHold, wouldRefuse, dryRunErrors, orderingViolations,
 * mirrorDrift, possiblyNotInjected, holdBypassedByAttemptsCap, holdsStarted,
 * holdsRecoveredInPlace, holdsReleasedToFailover:budget-exhausted,
 * holdsReleasedToFailover:flap-forced, holdsReleasedToFailover:maxHeldTotal-refused,
 * budgetOverrunHolds.
 */
export type CounterKey = string;

// ── Path resolution ───────────────────────────────────────────────────

export function resolvePendingInboundPath(stateDir: string, agentId: string): string {
  return path.join(stateDir, 'state', `pending-inbound.${sanitizeAgentId(agentId)}.sqlite`);
}

function sanitizeAgentId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ── Schema ────────────────────────────────────────────────────────────

// Schema legality (spec §1 round-3): AUTOINCREMENT only on INTEGER PRIMARY KEY,
// so enqueue_seq is the PK and UNIQUE(session_key, message_id) is the dedupe
// key — never-reused seqs guaranteed (plain rowid reuses after deletes).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
     enqueue_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
     session_key     TEXT NOT NULL,
     message_id      TEXT NOT NULL,
     payload         TEXT,
     payload_bytes   INTEGER NOT NULL DEFAULT 0,
     sender_envelope TEXT,
     sender_display  TEXT,
     topic_metadata  TEXT,
     reason          TEXT NOT NULL,
     state           TEXT NOT NULL,
     terminal_reason TEXT,
     enqueued_at     TEXT NOT NULL,
     enqueued_mono   REAL,
     boot_session_id TEXT,
     lease_epoch     TEXT,
     first_held_at   TEXT,
     first_frozen_at TEXT,
     total_frozen_ms INTEGER NOT NULL DEFAULT 0,
     frozen_since    TEXT,
     attempts        INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT,
     last_error      TEXT,
     delivered_unconfirmed INTEGER NOT NULL DEFAULT 0,
     status_history  TEXT NOT NULL DEFAULT '[]',
     UNIQUE (session_key, message_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pi_state_next ON entries(state, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pi_session_seq ON entries(session_key, enqueue_seq)`,
  // Receipts — class-tagged, canonical-id-keyed (§3.4). The class column makes
  // "never confused with ingress rows" mechanical: this table holds ONLY
  // injection/remote receipts, in the queue DB (same durability, same 0600).
  `CREATE TABLE IF NOT EXISTS receipts (
     session_key TEXT NOT NULL,
     message_id  TEXT NOT NULL,
     class       TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     injected    INTEGER NOT NULL DEFAULT 0,
     reported    INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_key, message_id, class)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pi_receipt_created ON receipts(created_at)`,
  // Meta — tenure acquisition generation (§3.5), durable counters (§2.4),
  // pause state. Key/value, integers stored as text.
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

const STATUS_HISTORY_CAP = 10;
const LAST_ERROR_CAP = 300;

// ── Store ─────────────────────────────────────────────────────────────

export class PendingInboundStore {
  // ES #private — the encapsulation contract (spec §1 round-8): no raw-handle
  // export. A unit test pins that `'db' in store === false` and no method
  // returns the handle.
  #db: BetterSqliteDatabase;
  #path: string;

  private constructor(db: BetterSqliteDatabase, dbPath: string) {
    this.#db = db;
    this.#path = dbPath;
    registerSqliteHandle(() => {
      try { this.#db?.close(); } catch { /* already closed */ }
    });
  }

  /**
   * Open (or create) the store. Throws on an unopenable file — the caller
   * (QueueDrainLoop boot sweep) owns the §5.3 quarantine path; the store
   * never quarantines itself.
   */
  static open(agentId: string, stateDir: string): PendingInboundStore {
    const dbPath = resolvePendingInboundPath(stateDir, agentId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db: BetterSqliteDatabase = new Database(dbPath);

    // 0600 BEFORE the WAL pragma so -wal/-shm sidecars inherit the mode
    // (spec §1). Best-effort on filesystems without mode bits.
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');

    for (const ddl of SCHEMA) db.exec(ddl);

    return new PendingInboundStore(db, dbPath);
  }

  pathOnDisk(): string {
    return this.#path;
  }

  close(): void {
    try { this.#db.close(); } catch { /* best-effort */ }
  }

  // ── Enqueue (tri-state, one transaction) ────────────────────────────

  /**
   * Take custody of a message. One transaction: existence check + bounds +
   * (possible per-session eviction) + insert (spec §1 Transactions/Bounds).
   *
   * Tri-state semantics (spec §1):
   *  - existing row non-terminal or `delivered` → `already-queued` (custody
   *    re-affirmed — correct dedupe);
   *  - existing row `expired`/`dropped-overflow` → `refused` (the prior
   *    instance was loss-reported; re-affirming custody against a row that
   *    will never dispatch would be silent loss);
   *  - oversize payload → `refused`;
   *  - `hardMaxTotal` reached → `refused` (even carve-out appends);
   *  - `maxTotal` reached and the session has nothing queued → `refused`
   *    (FIRST entries refused; sessions already queued may append);
   *  - `maxPerSession` reached → evict that session's oldest `queued` row
   *    (never `claimed`) as `dropped-overflow`, returned for loss-reporting.
   *
   * Storage failures (ENOSPC etc.) THROW — the caller maps a throw to
   * `refused` → fall-through (the fail-safe direction, spec §1 round-5).
   * Enqueue must be the caller's last fallible step before returning its
   * outcome (no-throw-after-commit invariant, §2.2).
   */
  enqueue(input: EnqueueInput, bounds: InboundQueueBounds): EnqueueOutcome {
    const payloadBytes = Buffer.byteLength(input.payload, 'utf-8');
    if (payloadBytes > bounds.maxPayloadBytes) {
      return { result: 'refused', reason: 'payload-oversize' };
    }

    const tx = this.#db.transaction((): EnqueueOutcome => {
      const existing = this.#db
        .prepare('SELECT state FROM entries WHERE session_key = ? AND message_id = ?')
        .get(input.sessionKey, input.messageId) as { state: InboundEntryState } | undefined;
      if (existing) {
        if (existing.state === 'expired' || existing.state === 'dropped-overflow') {
          return { result: 'refused', reason: `prior-instance-terminal:${existing.state}` };
        }
        return { result: 'already-queued', existingState: existing.state };
      }

      const totalRow = this.#db
        .prepare(`SELECT COUNT(*) AS n FROM entries WHERE state IN ('queued','claimed')`)
        .get() as { n: number };
      const sessRow = this.#db
        .prepare(`SELECT COUNT(*) AS n FROM entries WHERE session_key = ? AND state IN ('queued','claimed')`)
        .get(input.sessionKey) as { n: number };

      if (totalRow.n >= bounds.hardMaxTotal) {
        return { result: 'refused', reason: 'hard-max-total' };
      }
      if (totalRow.n >= bounds.maxTotal && sessRow.n === 0) {
        return { result: 'refused', reason: 'max-total-first-entry' };
      }

      let evicted: EvictedRowInfo | null = null;
      if (sessRow.n >= bounds.maxPerSession) {
        // Evict this session's oldest QUEUED row (never claimed).
        const victim = this.#db
          .prepare(
            `SELECT enqueue_seq, session_key, message_id, enqueued_at, payload_bytes, sender_display
               FROM entries WHERE session_key = ? AND state = 'queued'
               ORDER BY enqueue_seq ASC LIMIT 1`,
          )
          .get(input.sessionKey) as
          | { enqueue_seq: number; session_key: string; message_id: string; enqueued_at: string; payload_bytes: number; sender_display: string | null }
          | undefined;
        if (!victim) {
          // Every row claimed (all in flight) — nothing evictable.
          return { result: 'refused', reason: 'max-per-session-all-claimed' };
        }
        this.#terminalizeInTx(victim.enqueue_seq, 'queued', 'dropped-overflow', 'overflow-evicted', input.nowIso);
        evicted = {
          sessionKey: victim.session_key,
          messageId: victim.message_id,
          enqueuedAt: victim.enqueued_at,
          payloadBytes: victim.payload_bytes,
          senderDisplay: victim.sender_display,
          reason: 'overflow-evicted',
        };
      }

      const senderDisplay = input.senderEnvelope
        ? (input.senderEnvelope.firstName || input.senderEnvelope.username || (input.senderEnvelope.userId != null ? String(input.senderEnvelope.userId) : null))
        : null;
      const initialHistory = JSON.stringify([
        { state: 'queued', reason: input.reason, at: input.nowIso },
      ]);
      const res = this.#db
        .prepare(
          `INSERT INTO entries (
             session_key, message_id, payload, payload_bytes, sender_envelope,
             sender_display, topic_metadata, reason, state, enqueued_at,
             enqueued_mono, boot_session_id, lease_epoch, status_history,
             first_frozen_at, frozen_since
           ) VALUES (
             @session_key, @message_id, @payload, @payload_bytes, @sender_envelope,
             @sender_display, @topic_metadata, @reason, 'queued', @enqueued_at,
             @enqueued_mono, @boot_session_id, @lease_epoch, @status_history,
             @first_frozen_at, @frozen_since
           )`,
        )
        .run({
          session_key: input.sessionKey,
          message_id: input.messageId,
          payload: input.payload,
          payload_bytes: payloadBytes,
          sender_envelope: input.senderEnvelope ? JSON.stringify(input.senderEnvelope) : null,
          sender_display: senderDisplay,
          topic_metadata: input.topicMetadata != null ? JSON.stringify(input.topicMetadata) : null,
          reason: input.reason,
          enqueued_at: input.nowIso,
          enqueued_mono: input.monoMs,
          boot_session_id: input.bootSessionId,
          lease_epoch: input.tenure,
          status_history: initialHistory,
          // Rows enqueued while a pause is durably in effect are frozen at
          // enqueue — same rule as freeze-at-release (§3.6 round-10).
          first_frozen_at: input.frozenAtEnqueue ? input.nowIso : null,
          frozen_since: input.frozenAtEnqueue ? input.nowIso : null,
        });
      return { result: 'queued', seq: Number(res.lastInsertRowid), evicted };
    });

    return tx() as EnqueueOutcome;
  }

  // ── Reads ────────────────────────────────────────────────────────────

  /** Point read for the custody-aware route-throw catch (§2.2): does a
   *  committed NON-TERMINAL row exist for THIS message? Indexed PK lookup.
   *  Throws propagate — the caller fails OPEN to fall-through on a read
   *  error (a bounded duplicate window, §5-enumerated). */
  hasNonTerminalRow(sessionKey: string, messageId: string): boolean {
    const row = this.#db
      .prepare(`SELECT state FROM entries WHERE session_key = ? AND message_id = ? AND state IN ('queued','claimed')`)
      .get(sessionKey, messageId);
    return row !== undefined;
  }

  getRow(seq: number): PendingInboundRow | null {
    const row = this.#db.prepare('SELECT * FROM entries WHERE enqueue_seq = ?').get(seq) as PendingInboundRow | undefined;
    return row ?? null;
  }

  getRowByCanonicalId(sessionKey: string, messageId: string): PendingInboundRow | null {
    const row = this.#db
      .prepare('SELECT * FROM entries WHERE session_key = ? AND message_id = ?')
      .get(sessionKey, messageId) as PendingInboundRow | undefined;
    return row ?? null;
  }

  /**
   * Head-only per-session selection (§3.2): for each session whose LOWEST
   * non-terminal seq is `queued`, due (`next_attempt_at` null or <= now), and
   * not frozen, return that head row. Successors inherit the head's schedule
   * by construction (they are simply never selected while the head exists).
   * A session whose lowest non-terminal row is `claimed` is in flight → skip.
   */
  selectEligibleHeads(nowIso: string, limit: number): PendingInboundRow[] {
    return this.#db
      .prepare(
        `SELECT e.* FROM entries e
          JOIN (
            SELECT session_key, MIN(enqueue_seq) AS head_seq
              FROM entries WHERE state IN ('queued','claimed')
              GROUP BY session_key
          ) h ON e.session_key = h.session_key AND e.enqueue_seq = h.head_seq
          WHERE e.state = 'queued'
            AND e.frozen_since IS NULL
            AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= @now)
          ORDER BY e.enqueue_seq ASC
          LIMIT @limit`,
      )
      .all({ now: nowIso, limit }) as PendingInboundRow[];
  }

  /** Queued rows with a hold clock running — the boot-rebuild source for the
   *  in-memory held-set cache (§3.2: the first_held_at column is AUTHORITATIVE). */
  listHeldRows(): PendingInboundRow[] {
    return this.#db
      .prepare(`SELECT * FROM entries WHERE state = 'queued' AND first_held_at IS NOT NULL ORDER BY enqueue_seq ASC`)
      .all() as PendingInboundRow[];
  }

  /** Targeted deadline write for the §6 sleep-shift (queued rows only). */
  setNextAttempt(seq: number, nextAttemptAtIso: string | null): void {
    this.#db
      .prepare(`UPDATE entries SET next_attempt_at = ? WHERE enqueue_seq = ? AND state = 'queued'`)
      .run(nextAttemptAtIso, seq);
  }

  /** Scoped event-trigger reset (§3.2): make a session's queued rows due now. */
  resetNextAttempt(sessionKey: string): number {
    const res = this.#db
      .prepare(`UPDATE entries SET next_attempt_at = NULL WHERE session_key = ? AND state = 'queued'`)
      .run(sessionKey);
    return res.changes ?? 0;
  }

  /** All non-terminal rows (boot sweep, §5.3). */
  listNonTerminal(): PendingInboundRow[] {
    return this.#db
      .prepare(`SELECT * FROM entries WHERE state IN ('queued','claimed') ORDER BY enqueue_seq ASC`)
      .all() as PendingInboundRow[];
  }

  /** Sessions with operator-stop terminal rows still in retention — the boot
   *  sweep's PIS-veto scan (§3.4, STOP-scoped only). */
  listOperatorStopSessions(): string[] {
    return (
      this.#db
        .prepare(`SELECT DISTINCT session_key AS sk FROM entries WHERE terminal_reason = 'operator-stop'`)
        .all() as Array<{ sk: string }>
    ).map((r) => r.sk);
  }

  /** Per-session non-terminal counts + min seq — the mirror rebuild/reconcile
   *  source (§2.3). GROUP BY over ≤hardMaxTotal rows. */
  sessionCounts(): Array<{ session_key: string; count: number; min_seq: number }> {
    return this.#db
      .prepare(
        `SELECT session_key, COUNT(*) AS count, MIN(enqueue_seq) AS min_seq
           FROM entries WHERE state IN ('queued','claimed') GROUP BY session_key`,
      )
      .all() as Array<{ session_key: string; count: number; min_seq: number }>;
  }

  counts(): { queued: number; claimed: number; held: number; frozen: number; delivered24h: number; deliveredUnconfirmed24h: number; expired24h: number; droppedOverflow24h: number; oldestQueuedAt: string | null } {
    const one = (sql: string, params: Record<string, unknown> = {}): number =>
      (this.#db.prepare(sql).get(params) as { n: number }).n;
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    const oldest = this.#db
      .prepare(`SELECT MIN(enqueued_at) AS m FROM entries WHERE state IN ('queued','claimed')`)
      .get() as { m: string | null };
    return {
      queued: one(`SELECT COUNT(*) AS n FROM entries WHERE state='queued'`),
      claimed: one(`SELECT COUNT(*) AS n FROM entries WHERE state='claimed'`),
      held: one(`SELECT COUNT(*) AS n FROM entries WHERE state='queued' AND first_held_at IS NOT NULL`),
      frozen: one(`SELECT COUNT(*) AS n FROM entries WHERE frozen_since IS NOT NULL AND state IN ('queued','claimed')`),
      // delivered24h EXCLUDES possibly-not-injected rows (spec round-8/9:
      // success totals never overstate; the two are summed separately).
      delivered24h: one(`SELECT COUNT(*) AS n FROM entries WHERE state='delivered' AND delivered_unconfirmed=0 AND enqueued_at >= @c`, { c: dayAgo }),
      deliveredUnconfirmed24h: one(`SELECT COUNT(*) AS n FROM entries WHERE state='delivered' AND delivered_unconfirmed=1 AND enqueued_at >= @c`, { c: dayAgo }),
      expired24h: one(`SELECT COUNT(*) AS n FROM entries WHERE state='expired' AND enqueued_at >= @c`, { c: dayAgo }),
      droppedOverflow24h: one(`SELECT COUNT(*) AS n FROM entries WHERE state='dropped-overflow' AND enqueued_at >= @c`, { c: dayAgo }),
      oldestQueuedAt: oldest.m,
    };
  }

  // ── Transitions (expected-prior-state asserted) ─────────────────────

  /** Atomic claim: queued → claimed iff still queued. Returns the claimed row
   *  or null (lost race / no longer queued). */
  claim(seq: number, nowIso: string): PendingInboundRow | null {
    const tx = this.#db.transaction((): PendingInboundRow | null => {
      const res = this.#db
        .prepare(`UPDATE entries SET state='claimed' WHERE enqueue_seq = ? AND state = 'queued'`)
        .run(seq);
      if (res.changes !== 1) return null;
      this.#appendHistoryInTx(seq, 'claimed', null, nowIso);
      return this.getRow(seq);
    });
    return tx() as PendingInboundRow | null;
  }

  /**
   * Generic transition with expected-prior-state assert (spec §1): mismatch is
   * a LOGGED NO-OP (returns false), never a throw. Terminal transitions null
   * payload/envelope/metadata in the same transaction (payload hygiene) while
   * the locator (timestamps, ids, sender_display, payload_bytes) survives
   * (MUST 11).
   */
  transition(
    seq: number,
    expectedPrior: InboundEntryState,
    to: InboundEntryState,
    opts: {
      nowIso: string;
      terminalReason?: string;
      deliveredUnconfirmed?: boolean;
      lastError?: string | null;
      attempts?: number;
      nextAttemptAt?: string | null;
    },
  ): boolean {
    const tx = this.#db.transaction((): boolean => {
      if (TERMINAL.includes(to)) {
        const ok = this.#terminalizeInTx(seq, expectedPrior, to, opts.terminalReason ?? to, opts.nowIso, opts.deliveredUnconfirmed === true);
        return ok;
      }
      const fields: string[] = ['state = @state'];
      const params: Record<string, unknown> = { seq, state: to, expected: expectedPrior };
      if (opts.lastError !== undefined) { fields.push('last_error = @last_error'); params.last_error = sanitizeError(opts.lastError); }
      if (opts.attempts !== undefined) { fields.push('attempts = @attempts'); params.attempts = opts.attempts; }
      if (opts.nextAttemptAt !== undefined) { fields.push('next_attempt_at = @next_attempt_at'); params.next_attempt_at = opts.nextAttemptAt; }
      const res = this.#db
        .prepare(`UPDATE entries SET ${fields.join(', ')} WHERE enqueue_seq = @seq AND state = @expected`)
        .run(params);
      if (res.changes !== 1) return false;
      this.#appendHistoryInTx(seq, to, opts.terminalReason ?? null, opts.nowIso);
      return true;
    });
    return tx() as boolean;
  }

  /** Release a claimed row back to queued with backoff (failed attempt, §3.3).
   *  When a pause is in effect the caller passes `freeze:true` — the row is
   *  frozen at release (§3.6 round-9). */
  release(seq: number, opts: { nowIso: string; attempts: number; nextAttemptAt: string | null; lastError?: string | null; freeze?: boolean }): boolean {
    const tx = this.#db.transaction((): boolean => {
      const fields = ['state = \'queued\'', 'attempts = @attempts', 'next_attempt_at = @next'];
      const params: Record<string, unknown> = { seq, attempts: opts.attempts, next: opts.nextAttemptAt };
      if (opts.lastError !== undefined) { fields.push('last_error = @err'); params.err = sanitizeError(opts.lastError); }
      if (opts.freeze) {
        fields.push('frozen_since = @now', 'first_frozen_at = COALESCE(first_frozen_at, @now)');
        params.now = opts.nowIso;
      }
      const res = this.#db
        .prepare(`UPDATE entries SET ${fields.join(', ')} WHERE enqueue_seq = @seq AND state = 'claimed'`)
        .run(params);
      if (res.changes !== 1) return false;
      this.#appendHistoryInTx(seq, 'queued', opts.freeze ? 'released-frozen' : 'released', opts.nowIso);
      return true;
    });
    return tx() as boolean;
  }

  /** Mark a queued head held (first_held_at set once; §4.3 cumulative clock). */
  markHeld(seq: number, nowIso: string): void {
    this.#db
      .prepare(`UPDATE entries SET first_held_at = COALESCE(first_held_at, ?) WHERE enqueue_seq = ? AND state = 'queued'`)
      .run(nowIso, seq);
  }

  #terminalizeInTx(
    seq: number,
    expectedPrior: InboundEntryState,
    to: InboundEntryState,
    terminalReason: string,
    nowIso: string,
    deliveredUnconfirmed = false,
  ): boolean {
    const res = this.#db
      .prepare(
        `UPDATE entries SET
           state = @to, terminal_reason = @reason,
           payload = NULL, sender_envelope = NULL, topic_metadata = NULL,
           frozen_since = NULL,
           delivered_unconfirmed = @unconfirmed
         WHERE enqueue_seq = @seq AND state = @expected`,
      )
      .run({ seq, to, reason: terminalReason, expected: expectedPrior, unconfirmed: deliveredUnconfirmed ? 1 : 0 });
    if (res.changes !== 1) return false;
    this.#appendHistoryInTx(seq, to, terminalReason, nowIso);
    return true;
  }

  #appendHistoryInTx(seq: number, state: string, reason: string | null, atIso: string): void {
    const cur = this.#db.prepare('SELECT status_history FROM entries WHERE enqueue_seq = ?').get(seq) as
      | { status_history: string }
      | undefined;
    if (!cur) return;
    let history: unknown[];
    try {
      const parsed = JSON.parse(cur.status_history);
      history = Array.isArray(parsed) ? parsed : [];
    } catch {
      history = [];
    }
    // States/reasons/timestamps only — never content (spec §1).
    history.push(reason ? { state, reason, at: atIso } : { state, at: atIso });
    while (history.length > STATUS_HISTORY_CAP) history.shift();
    this.#db.prepare('UPDATE entries SET status_history = ? WHERE enqueue_seq = ?').run(JSON.stringify(history), seq);
  }

  // ── Receipts (§3.4) ──────────────────────────────────────────────────

  /**
   * The CONDITIONAL receipt commit (§3.6): writes the injection-class receipt
   * iff the queue row is still `claimed` — one transaction, so a stop's
   * claimed→expired transition makes a late receipt write fail atomically
   * (which aborts the inject). Returns true when the receipt committed.
   */
  writeReceiptIfClaimed(seq: number, sessionKey: string, messageId: string, nowIso: string): boolean {
    const tx = this.#db.transaction((): boolean => {
      const row = this.#db
        .prepare(`SELECT state FROM entries WHERE enqueue_seq = ?`)
        .get(seq) as { state: InboundEntryState } | undefined;
      if (!row || row.state !== 'claimed') return false;
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO receipts (session_key, message_id, class, created_at)
           VALUES (?, ?, 'injection', ?)`,
        )
        .run(sessionKey, messageId, nowIso);
      return true;
    });
    return tx() as boolean;
  }

  hasReceipt(sessionKey: string, messageId: string, cls: ReceiptClass = 'injection'): boolean {
    return (
      this.#db
        .prepare('SELECT 1 AS x FROM receipts WHERE session_key = ? AND message_id = ? AND class = ?')
        .get(sessionKey, messageId, cls) !== undefined
    );
  }

  /** Remote path (§3.4): receive-side receipt, keyed on the canonical id. */
  recordRemoteReceipt(sessionKey: string, messageId: string, nowIso: string): boolean {
    const res = this.#db
      .prepare(`INSERT OR IGNORE INTO receipts (session_key, message_id, class, created_at) VALUES (?, ?, 'remote', ?)`)
      .run(sessionKey, messageId, nowIso);
    return res.changes === 1;
  }

  /** Flip the `injected` marker after the local inject completes (§3.4 remote
   *  path round-8 — makes peer-crash-between-receipt-and-inject boot-detectable). */
  markReceiptInjected(sessionKey: string, messageId: string, cls: ReceiptClass): void {
    this.#db
      .prepare('UPDATE receipts SET injected = 1 WHERE session_key = ? AND message_id = ? AND class = ?')
      .run(sessionKey, messageId, cls);
  }

  markReceiptReported(sessionKey: string, messageId: string, cls: ReceiptClass): void {
    this.#db
      .prepare('UPDATE receipts SET reported = 1 WHERE session_key = ? AND message_id = ? AND class = ?')
      .run(sessionKey, messageId, cls);
  }

  /** Unflipped (never-injected), unreported REMOTE receipts — the boot sweep's
   *  window-6 detection surface (§3.4 remote path). REMOTE-class only: local
   *  injection-class receipts never flip a marker — their loss variant is
   *  carried by the row's `delivered_unconfirmed` flag instead. */
  findUnflippedUnreportedReceipts(): ReceiptRow[] {
    return this.#db
      .prepare(`SELECT * FROM receipts WHERE class = 'remote' AND injected = 0 AND reported = 0`)
      .all() as ReceiptRow[];
  }

  /**
   * Receipt pruning (§3.4, §3.2 backstop duty): receipts older than the cutoff
   * are pruned — but an UNFLIPPED receipt is never silently pruned: the rows
   * about to be dropped while injected=0 AND reported=0 are RETURNED so the
   * caller reports them first (report once, then prune — retention is never
   * extended; spec round-10). The prune itself runs after the caller's report
   * via `confirmPruneReceipts`.
   */
  listPrunableReceipts(cutoffIso: string): { silent: number; needsReport: ReceiptRow[] } {
    const needsReport = this.#db
      .prepare(`SELECT * FROM receipts WHERE class = 'remote' AND created_at < ? AND injected = 0 AND reported = 0`)
      .all(cutoffIso) as ReceiptRow[];
    const total = (this.#db
      .prepare('SELECT COUNT(*) AS n FROM receipts WHERE created_at < ?')
      .get(cutoffIso) as { n: number }).n;
    return { silent: total - needsReport.length, needsReport };
  }

  confirmPruneReceipts(cutoffIso: string): number {
    const res = this.#db.prepare('DELETE FROM receipts WHERE created_at < ?').run(cutoffIso);
    return res.changes ?? 0;
  }

  /** Delete a just-committed receipt (deliberate in-process un-commit — only
   *  legal while the caller KNOWS no inject ran; used by halt skip paths). */
  deleteReceipt(sessionKey: string, messageId: string, cls: ReceiptClass): void {
    this.#db
      .prepare('DELETE FROM receipts WHERE session_key = ? AND message_id = ? AND class = ?')
      .run(sessionKey, messageId, cls);
  }

  // ── Tenure (§3.5 meta) ───────────────────────────────────────────────

  /**
   * Tenure source of truth (§3.5): the queue maintains its OWN
   * acquisition-generation counter, persisted here, bumped iff the lease ref
   * tip observed at this machine's claim names a holder ≠ self. Unchanged on
   * renewals and same-holder re-acquire.
   *
   * Returns the current tenure id (`<selfMachineId>#<generation>`).
   */
  observeLeaseClaim(selfMachineId: string, tipHolderAtClaim: string | null): string {
    const tx = this.#db.transaction((): string => {
      const genRow = this.#db.prepare(`SELECT value FROM meta WHERE key = 'acquisition_generation'`).get() as { value: string } | undefined;
      let gen = genRow ? Number(genRow.value) : 0;
      if (tipHolderAtClaim !== null && tipHolderAtClaim !== selfMachineId) {
        gen += 1;
      } else if (!genRow) {
        gen = 1; // first ever claim on this store
      }
      this.#db
        .prepare(`INSERT INTO meta (key, value) VALUES ('acquisition_generation', @v)
                  ON CONFLICT(key) DO UPDATE SET value = @v`)
        .run({ v: String(gen) });
      return `${selfMachineId}#${gen}`;
    });
    return tx() as string;
  }

  currentTenure(selfMachineId: string): string | null {
    const genRow = this.#db.prepare(`SELECT value FROM meta WHERE key = 'acquisition_generation'`).get() as { value: string } | undefined;
    return genRow ? `${selfMachineId}#${genRow.value}` : null;
  }

  /** The bare generation number (capacity-heartbeat field, §5.1). */
  acquisitionGeneration(): number | null {
    const genRow = this.#db.prepare(`SELECT value FROM meta WHERE key = 'acquisition_generation'`).get() as { value: string } | undefined;
    return genRow ? Number(genRow.value) : null;
  }

  // ── Pause / freeze (§3.6) ────────────────────────────────────────────

  /** Durable pause flag — restart mid-pause stays paused. */
  setPaused(paused: boolean, nowIso: string): void {
    this.#db
      .prepare(`INSERT INTO meta (key, value) VALUES ('paused_at', @v)
                ON CONFLICT(key) DO UPDATE SET value = @v`)
      .run({ v: paused ? nowIso : '' });
  }

  isPaused(): boolean {
    const row = this.#db.prepare(`SELECT value FROM meta WHERE key = 'paused_at'`).get() as { value: string } | undefined;
    return !!row && row.value !== '';
  }

  /** Freeze all QUEUED rows (pause scope pin, §3.6 round-9 — claimed rows
   *  complete normally and freeze at release if they fail). */
  freezeQueuedRows(nowIso: string): number {
    const res = this.#db
      .prepare(
        `UPDATE entries SET
           frozen_since = @now,
           first_frozen_at = COALESCE(first_frozen_at, @now)
         WHERE state = 'queued' AND frozen_since IS NULL`,
      )
      .run({ now: nowIso });
    return res.changes ?? 0;
  }

  /**
   * Resume: fold each live frozen span into `total_frozen_ms`, clear
   * `frozen_since`, shift `next_attempt_at` deadlines by the frozen span
   * (the §6 sleep-shift pattern), and return rows whose CUMULATIVE frozen
   * time now exceeds `pauseMaxMs` — the caller terminals those as
   * `pause-expired` (the cumulative cap, §3.6 round-7/8).
   */
  resumeFrozenRows(nowIso: string, pauseMaxMs: number): { resumed: number; overCap: PendingInboundRow[] } {
    const tx = this.#db.transaction((): { resumed: number; overCap: PendingInboundRow[] } => {
      const frozen = this.#db
        .prepare(`SELECT * FROM entries WHERE frozen_since IS NOT NULL AND state IN ('queued','claimed')`)
        .all() as PendingInboundRow[];
      const nowMs = Date.parse(nowIso);
      const overCap: PendingInboundRow[] = [];
      let resumed = 0;
      for (const row of frozen) {
        const sinceMs = Date.parse(row.frozen_since as string);
        const span = Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : 0;
        const total = row.total_frozen_ms + span;
        let nextAttempt = row.next_attempt_at;
        if (nextAttempt) {
          const t = Date.parse(nextAttempt);
          if (Number.isFinite(t)) nextAttempt = new Date(t + span).toISOString();
        }
        this.#db
          .prepare(
            `UPDATE entries SET total_frozen_ms = @total, frozen_since = NULL, next_attempt_at = @next
             WHERE enqueue_seq = @seq`,
          )
          .run({ total, next: nextAttempt, seq: row.enqueue_seq });
        resumed += 1;
        if (total > pauseMaxMs) {
          const updated = this.getRow(row.enqueue_seq);
          if (updated) overCap.push(updated);
        }
      }
      return { resumed, overCap };
    });
    return tx() as { resumed: number; overCap: PendingInboundRow[] };
  }

  /** Live cumulative frozen span for the cap check while still paused
   *  (`total_frozen_ms + (now − frozen_since)`, §1 columns round-8). */
  liveFrozenMs(row: PendingInboundRow, nowIso: string): number {
    let live = row.total_frozen_ms;
    if (row.frozen_since) {
      const since = Date.parse(row.frozen_since);
      const now = Date.parse(nowIso);
      if (Number.isFinite(since) && Number.isFinite(now)) live += Math.max(0, now - since);
    }
    return live;
  }

  // ── TTL / pruning (§3.2 backstop duties) ─────────────────────────────

  /** Rows whose TTL has expired (frozen rows excluded — TTL accounting pauses
   *  while frozen, §3.6). Caller terminals + loss-reports them. */
  listTtlExpired(nowIso: string, entryTtlMs: number): PendingInboundRow[] {
    const cutoff = new Date(Date.parse(nowIso) - entryTtlMs).toISOString();
    return this.#db
      .prepare(
        `SELECT * FROM entries
          WHERE state = 'queued' AND frozen_since IS NULL AND enqueued_at < @cutoff`,
      )
      .all({ cutoff }) as PendingInboundRow[];
  }

  /** Prune terminal rows past retention (payload already nulled at terminal). */
  pruneTerminal(cutoffIso: string): number {
    const res = this.#db
      .prepare(`DELETE FROM entries WHERE state IN ('delivered','expired','dropped-overflow') AND enqueued_at < ?`)
      .run(cutoffIso);
    return res.changes ?? 0;
  }

  // ── Durable counters (§2.4 + observability) ──────────────────────────

  incrementCounter(key: CounterKey, by = 1): void {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (@k, @by)
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + @by AS TEXT)`,
      )
      .run({ k: `counter:${key}`, by: String(by) });
  }

  getCounter(key: CounterKey): number {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(`counter:${key}`) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  // ── Test-only diagnostics (no handle export) ─────────────────────────

  /** File mode check support — path only; the test stats the file itself. */
  countAll(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Sanitized last_error (spec §1): error class + length-capped message; the
 *  caller must never pass payload-bearing text — this cap is the backstop. */
export function sanitizeError(err: unknown): string | null {
  if (err == null) return null;
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const msg = err instanceof Error ? err.message : String(err);
  return `${name}: ${msg}`.slice(0, LAST_ERROR_CAP);
}

export const PENDING_INBOUND_TERMINAL_STATES = TERMINAL;
export const PENDING_INBOUND_NON_TERMINAL_STATES = NON_TERMINAL;
