/**
 * A2ADeliveryTracker — the "communications never just die out" guarantee for
 * agent-to-agent (Threadline / file-relay) messaging.
 *
 * The problem this closes (operator directive, 2026-06-06): every A2A hop was
 * fire-and-forget. Older `threadline_send` results collapsed local submission,
 * transport acceptance, and peer processing into `delivered:true`; current
 * results separate `accepted` from proven `delivered`. There was also no record
 * on the SENDER side of "this message is
 * still waiting for the peer to acknowledge it", so a peer going dark was
 * invisible until a human noticed silence (Dawn's check-in sat 10h unread; my
 * hosting kickoff was submitted to the relay but never seen).
 *
 * This is the durable spine of the fix:
 *   - recordSent()      — every outbound A2A message is written here BEFORE/with
 *                         the transport attempt (lifecycle starts 'awaiting-ack').
 *   - recordAck()       — a peer's PROCESSED-ack (not transport-ack) flips it to
 *                         'acked'. This is the real delivered signal.
 *   - recordInboundFrom — every accepted inbound message bumps the peer's
 *                         liveness clock (last time we heard FROM them).
 *   - findOverdue()     — awaiting-ack rows past a TTL: the redelivery +
 *                         escalation sentinel's work-list (PR2 layers on this).
 *   - peerHealth()      — "is my channel to <peer> alive?" as a lookup, not a
 *                         guess: last sent, last acked, last heard-from, how many
 *                         messages are stuck awaiting ack, and a stale flag.
 *
 * Substrate is SQLite (the proven MessageProcessingLedger / PendingRelayStore /
 * CommitmentTracker path) — NOT a new ad-hoc JSON file and NOT a git-synced
 * blob. Schema self-initializes on first access (no PostUpdateMigrator step).
 * Per-agent-id isolation. Read-only at the HTTP layer (observability) — it never
 * gates a send.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import fs from 'node:fs';
import path from 'node:path';
import type { RelayVerdict, RelayReasonCode } from './relayVerdict.js';
import { clampRelayTtlSec } from './relayVerdict.js';

/**
 * Outbound delivery lifecycle.
 *
 * `state` tracks PEER PROCESSING (ack by reply); `relay_status` tracks the
 * TRANSPORT verdict. Neither is inferred from the other except by the listed
 * transitions (docs/specs/a2a-honest-delivery-outcomes.md §2).
 * `unconfirmed` = no proof either way (non-terminal; a later verdict or reply
 * still settles it). Silence is NEVER failure.
 */
export type A2ADeliveryState = 'awaiting-ack' | 'acked' | 'escalated' | 'failed' | 'unconfirmed';

/** Relay-sourced transport verdict stored on a row. A ban stores NO status (only the reason code). */
export type A2ARelayStatus = 'delivered' | 'queued' | 'rejected' | 'expired';

export interface A2ARelayStatusView {
  status: A2ARelayStatus | null;
  at: string | null;
  reasonCode: RelayReasonCode | null;
  retryable: boolean | null;
}

/** Every stored timestamp is a JS `toISOString()` value (ISO with `T`) — the invariant the lexical compares rely on. */
export function nowIso(d: Date = new Date()): string {
  const iso = d.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) throw new Error(`nowIso: non-ISO timestamp ${iso}`);
  return iso;
}

export interface A2ADeliveryEntry {
  messageId: string;
  peerFp: string;
  peerName: string | null;
  threadId: string | null;
  subject: string | null;
  transport: string | null;
  state: A2ADeliveryState;
  sentAt: string;
  ackedAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  escalatedAt: string | null;
  relayStatus: A2ARelayStatus | null;
  relayStatusAt: string | null;
  relayReasonCode: RelayReasonCode | null;
  relayReason: string | null;
  relayExpiresAt: string | null;
  relayRetryable: boolean | null;
}

export interface PeerHealth {
  peerFp: string;
  peerName: string | null;
  /** Last outbound message we sent to this peer (any state). */
  lastSentAt: string | null;
  /** Last time a message we sent was PROCESSED-acked by the peer. */
  lastAckedAt: string | null;
  /** Last time we ACCEPTED an inbound message from this peer. */
  lastInboundAt: string | null;
  /** Outbound messages still awaiting the peer's ack. */
  pendingCount: number;
  /** Age (ms) of the OLDEST awaiting-ack message; null when none pending. */
  oldestPendingAgeMs: number | null;
  /** Messages that exhausted retries and were escalated. */
  escalatedCount: number;
  /** Rows the relay explicitly refused or expired. */
  failedCount: number;
  /** Rows with no proof either way (silence, lost verdict, ban). */
  unconfirmedCount: number;
  /** Newest relay verdict recorded for this peer (code only — never relay prose). */
  lastRelayStatus: A2ARelayStatusView | null;
  /**
   * True when the channel looks unhealthy: a message has been awaiting ack
   * longer than `staleAfterMs`. This is the "is my channel to Dawn alive?"
   * signal — silence made visible.
   */
  stale: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS a2a_delivery (
  message_id TEXT PRIMARY KEY,
  peer_fp TEXT NOT NULL,
  peer_name TEXT,
  thread_id TEXT,
  subject TEXT,
  transport TEXT,
  state TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  acked_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  escalated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_a2a_delivery_peer ON a2a_delivery(peer_fp);
CREATE INDEX IF NOT EXISTS idx_a2a_delivery_state ON a2a_delivery(state);
CREATE INDEX IF NOT EXISTS idx_a2a_delivery_state_sent ON a2a_delivery(state, sent_at);
CREATE INDEX IF NOT EXISTS idx_a2a_delivery_peer_state ON a2a_delivery(peer_fp, state);
CREATE TABLE IF NOT EXISTS a2a_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS a2a_peer_inbound (
  peer_fp TEXT PRIMARY KEY,
  peer_name TEXT,
  last_accepted_at TEXT NOT NULL,
  accept_count INTEGER NOT NULL DEFAULT 0
);
`;

export function resolveA2ADeliveryPath(stateDir: string, agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  return path.join(stateDir, 'state', `a2a-delivery.${safe}.sqlite`);
}

/** Default: a message awaiting ack longer than this marks the channel stale. */
export const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h — matches the ACK-discipline window proposed to Dawn.

/** Silence sweep constants (spec Frontloaded #5). */
export const SWEEP_QUEUED_GRACE_MS = 60 * 60 * 1000;        // relay_expires_at + 1 h
export const SWEEP_NO_VERDICT_AFTER_MS = 24 * 60 * 60 * 1000; // sent_at + 24 h
export const SWEEP_MAX_ROWS_PER_TICK = 500;

/**
 * Additive columns (spec §2) — ALTER TABLE guarded by PRAGMA table_info so an
 * existing database upgrades in place and the migration is idempotent.
 */
const ADDITIVE_COLUMNS: Array<[string, string]> = [
  ['relay_status', 'TEXT'],
  ['relay_status_at', 'TEXT'],
  ['relay_reason_code', 'TEXT'],
  ['relay_reason', 'TEXT'],
  ['relay_expires_at', 'TEXT'],
  ['relay_retryable', 'INTEGER'],
];

function migrateAdditiveColumns(db: BetterSqliteDatabase): void {
  const have = new Set((db.prepare(`PRAGMA table_info(a2a_delivery)`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const [col, type] of ADDITIVE_COLUMNS) {
    if (!have.has(col)) db.exec(`ALTER TABLE a2a_delivery ADD COLUMN ${col} ${type}`);
  }
  db.prepare(`INSERT OR IGNORE INTO a2a_meta (key, value) VALUES ('relay_tracking_since', ?)`).run(nowIso());
}

function rowToEntry(r: any): A2ADeliveryEntry {
  return {
    messageId: r.message_id,
    peerFp: r.peer_fp,
    peerName: r.peer_name ?? null,
    threadId: r.thread_id ?? null,
    subject: r.subject ?? null,
    transport: r.transport ?? null,
    state: r.state as A2ADeliveryState,
    sentAt: r.sent_at,
    ackedAt: r.acked_at ?? null,
    attempts: r.attempts ?? 1,
    lastAttemptAt: r.last_attempt_at ?? null,
    nextRetryAt: r.next_retry_at ?? null,
    escalatedAt: r.escalated_at ?? null,
    relayStatus: (r.relay_status as A2ARelayStatus | null) ?? null,
    relayStatusAt: r.relay_status_at ?? null,
    relayReasonCode: (r.relay_reason_code as RelayReasonCode | null) ?? null,
    relayReason: r.relay_reason ?? null,
    relayExpiresAt: r.relay_expires_at ?? null,
    relayRetryable: r.relay_retryable === null || r.relay_retryable === undefined ? null : r.relay_retryable === 1,
  };
}

export class A2ADeliveryTracker {
  private readonly db: BetterSqliteDatabase;
  readonly path: string;

  private unregister: (() => void) | undefined;

  private constructor(db: BetterSqliteDatabase, dbPath: string) {
    this.db = db;
    this.path = dbPath;
    // Capture the unregister fn so close() honors the SqliteRegistry contract
    // (unregister before closing) — otherwise openMemory() leaks a process-global
    // registry entry per test and closeAllSqlite() calls a stale handle.
    this.unregister = registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  static open(agentId: string, stateDir: string): A2ADeliveryTracker {
    const dbPath = resolveA2ADeliveryPath(stateDir, agentId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    migrateAdditiveColumns(db);
    return new A2ADeliveryTracker(db, dbPath);
  }

  /** Open an in-memory tracker (tests). */
  static openMemory(): A2ADeliveryTracker {
    const db = new Database(':memory:');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    migrateAdditiveColumns(db);
    return new A2ADeliveryTracker(db, ':memory:');
  }

  /** Counter: `delivery_expired` frames ignored because they did not corroborate a `queued` row for that recipient. */
  expiredMismatchIgnored = 0;

  /** When relay-verdict tracking began on this database (rows sent before it are never swept). */
  relayTrackingSince(): string {
    const r = this.db.prepare(`SELECT value FROM a2a_meta WHERE key = 'relay_tracking_since'`).get() as { value: string } | undefined;
    return r?.value ?? nowIso();
  }

  /**
   * Record an outbound A2A message. Lifecycle starts 'awaiting-ack'. Idempotent
   * on messageId (INSERT OR IGNORE) so a retry of the SAME message never
   * double-inserts — and never resurrects a row already acked/failed.
   */
  recordSent(opts: {
    messageId: string;
    peerFp: string;
    peerName?: string | null;
    threadId?: string | null;
    subject?: string | null;
    transport?: string | null;
    sentAt?: string;
  }): void {
    if (!opts.messageId || !opts.peerFp) return;
    const now = opts.sentAt ?? nowIso();
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO a2a_delivery
           (message_id, peer_fp, peer_name, thread_id, subject, transport, state, sent_at, attempts, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, 'awaiting-ack', ?, 1, ?)`,
      )
      .run(
        opts.messageId,
        opts.peerFp,
        opts.peerName ?? null,
        opts.threadId ?? null,
        opts.subject ?? null,
        opts.transport ?? null,
        now,
        now,
      );
    // Collision visibility: INSERT OR IGNORE makes recordSent idempotent on a
    // RE-SEND of the same messageId, but message ids on the plaintext/local
    // transports are `msg-<ms>-<4char>` (a weak space). If the insert was ignored
    // AND the existing row is a genuinely DIFFERENT message (different peer/thread),
    // that's a silent-drop of THIS send's lifecycle — exactly what this component
    // exists to prevent. Surface it loudly rather than swallow it.
    if (info.changes === 0) {
      const existing = this.get(opts.messageId);
      if (existing && (existing.peerFp !== opts.peerFp || (opts.threadId && existing.threadId !== opts.threadId))) {
        console.warn(
          `[A2ADeliveryTracker] messageId collision: ${opts.messageId} already tracked for peer ${existing.peerFp.slice(0, 12)} thread ${existing.threadId ?? 'none'}, ` +
          `but a NEW send targets peer ${opts.peerFp.slice(0, 12)} thread ${opts.threadId ?? 'none'} — the new send is NOT tracked (weak id source). Fix the id generator to crypto.randomUUID().`,
        );
      }
    }
  }

  /**
   * Record a peer's PROCESSED-ack for a specific outbound message — the real
   * "delivered" signal. Flips 'awaiting-ack'/'escalated' → 'acked'. Idempotent;
   * never downgrades an already-acked row. Returns true if a row was flipped.
   */
  recordAck(messageId: string, ackedAt?: string): boolean {
    if (!messageId) return false;
    const info = this.db
      .prepare(
        `UPDATE a2a_delivery
         SET state = 'acked', acked_at = ?
         WHERE message_id = ? AND state IN ('awaiting-ack','escalated','unconfirmed')`,
      )
      .run(ackedAt ?? nowIso(), messageId);
    return info.changes > 0;
  }

  /**
   * Record what the RELAY said about one message (spec §2 transition table).
   * Single transaction; unknown ids are ignored (another process's send, or a
   * pre-upgrade row). Never inferred — only id-bearing relay frames (plus the
   * socket-level ban fan-out, which lands as non-terminal `unconfirmed`).
   */
  recordRelayStatus(v: RelayVerdict, at?: string): 'applied' | 'ignored' {
    if (!v?.messageId) return 'ignored';
    const now = at ?? nowIso();
    const row = this.db.prepare(`SELECT state, peer_fp, relay_status FROM a2a_delivery WHERE message_id = ?`)
      .get(v.messageId) as { state: A2ADeliveryState; peer_fp: string; relay_status: string | null } | undefined;
    if (!row) return 'ignored';
    if (row.state === 'acked') return 'ignored';
    const retryable = v.retryLater === undefined || v.retryLater === null ? null : (v.retryLater ? 1 : 0);
    const apply = this.db.transaction((): 'applied' | 'ignored' => {
      switch (v.status) {
        case 'delivered':
        case 'queued': {
          if (row.relay_status === 'rejected' || row.relay_status === 'expired') return 'ignored';
          const expiresAt = v.status === 'queued'
            ? new Date(Date.parse(now) + clampRelayTtlSec(v.ttlSec) * 1000).toISOString()
            : null;
          // A late id-bearing verdict on an `unconfirmed` row is real evidence:
          // the row returns to awaiting-ack.
          this.db.prepare(
            `UPDATE a2a_delivery
             SET relay_status = ?, relay_status_at = ?, relay_expires_at = COALESCE(?, relay_expires_at),
                 state = CASE WHEN state = 'unconfirmed' THEN 'awaiting-ack' ELSE state END
             WHERE message_id = ?`,
          ).run(v.status, now, expiresAt, v.messageId);
          return 'applied';
        }
        case 'rejected': {
          this.db.prepare(
            `UPDATE a2a_delivery
             SET relay_status = 'rejected', relay_status_at = ?, relay_reason_code = ?, relay_reason = ?, relay_retryable = ?,
                 state = 'failed'
             WHERE message_id = ? AND state IN ('awaiting-ack','escalated','unconfirmed')`,
          ).run(now, v.reasonCode ?? 'unmapped', v.reason ?? null, retryable, v.messageId);
          return 'applied';
        }
        case 'expired': {
          // Corroboration: the row must say the relay QUEUED it, and the frame's
          // recipient must be this row's peer. Otherwise it is not evidence about
          // this row (counted, ignored).
          if (row.relay_status !== 'queued' || !v.recipientId || v.recipientId !== row.peer_fp) {
            this.expiredMismatchIgnored++;
            return 'ignored';
          }
          this.db.prepare(
            `UPDATE a2a_delivery
             SET relay_status = 'expired', relay_status_at = ?, state = 'failed'
             WHERE message_id = ? AND state IN ('awaiting-ack','escalated','unconfirmed')`,
          ).run(now, v.messageId);
          return 'applied';
        }
        case 'unconfirmed': {
          // Ban fan-out: socket-level, never a per-message verdict. From
          // awaiting-ack only, and only when no relay status is stored (a row that
          // already carries `delivered` must not be stamped banned).
          if (v.reasonCode !== 'banned') return 'ignored';
          const info = this.db.prepare(
            `UPDATE a2a_delivery SET state = 'unconfirmed', relay_reason_code = 'banned', relay_status_at = ?
             WHERE message_id = ? AND state = 'awaiting-ack' AND relay_status IS NULL`,
          ).run(now, v.messageId);
          return info.changes > 0 ? 'applied' : 'ignored';
        }
        default:
          return 'ignored';
      }
    });
    return apply();
  }

  /**
   * Silence sweep (spec §3): relabel `awaiting-ack` relay rows with no usable
   * verdict to the NON-TERMINAL `unconfirmed` — never to `failed`. Only rows
   * sent after relay tracking began; bounded per tick; oldest first.
   * Returns the relabelled rows (messageId, peer, cause) for the audit log.
   */
  sweepSilence(nowMs: number = Date.now()): Array<{ messageId: string; peerFp: string; cause: 'queued-expired-unobserved' | 'no-verdict-timeout' }> {
    const since = this.relayTrackingSince();
    const queuedCutoff = new Date(nowMs - SWEEP_QUEUED_GRACE_MS).toISOString();
    const noVerdictCutoff = new Date(nowMs - SWEEP_NO_VERDICT_AFTER_MS).toISOString();
    const rows = this.db.prepare(
      `UPDATE a2a_delivery SET state = 'unconfirmed'
       WHERE rowid IN (
         SELECT rowid FROM a2a_delivery
         WHERE state = 'awaiting-ack' AND transport = 'relay' AND sent_at > ?
           AND ((relay_status = 'queued' AND relay_expires_at IS NOT NULL AND relay_expires_at < ?)
             OR (relay_status IS NULL AND sent_at < ?))
         ORDER BY sent_at ASC LIMIT ${SWEEP_MAX_ROWS_PER_TICK})
       RETURNING message_id, peer_fp, relay_status`,
    ).all(since, queuedCutoff, noVerdictCutoff) as Array<{ message_id: string; peer_fp: string; relay_status: string | null }>;
    return rows.map((r) => ({
      messageId: r.message_id,
      peerFp: r.peer_fp,
      cause: r.relay_status === 'queued' ? 'queued-expired-unobserved' : 'no-verdict-timeout',
    }));
  }

  /**
   * Implicit ack: a reply ON A THREAD is proof the peer processed our prior send
   * on that thread. Acks the OLDEST awaiting message on the thread. Returns the
   * messageId acked, or null.
   *
   * Keyed on threadId ALONE — deliberately NOT on peer fingerprint. The inbound
   * sender identity differs by transport (a cross-machine relay carries the
   * peer's FINGERPRINT in from.agent; a same-machine local delivery carries the
   * peer's NAME), while the threadId is consistent on both sides of a
   * conversation. Keying on the thread makes the ack robust to that asymmetry —
   * the bug a same-model test suite missed but cross-perspective review caught:
   * outbound rows are keyed by fingerprint, so a name-keyed ack never matched and
   * the implicit ack never fired in production.
   *
   * Count-conservative, not per-message truth: if N messages await on the thread
   * and one reply arrives, only the OLDEST flips to acked (the reply may actually
   * be answering the newest, but acking the oldest never OVER-acks — the genuinely
   * unanswered tail stays pending and can still go stale/escalate).
   */
  recordAckByThread(threadId: string, ackedAt?: string): string | null {
    if (!threadId) return null;
    const row = this.db
      .prepare(
        `SELECT message_id FROM a2a_delivery
         WHERE thread_id = ? AND state IN ('awaiting-ack','escalated','unconfirmed')
         ORDER BY sent_at ASC LIMIT 1`,
      )
      .get(threadId) as { message_id: string } | undefined;
    if (!row) return null;
    return this.recordAck(row.message_id, ackedAt) ? row.message_id : null;
  }

  /** Bump a peer's inbound-liveness clock — call when we ACCEPT a message from them. */
  recordInboundFrom(peerFp: string, peerName: string | null, at?: string): void {
    if (!peerFp) return;
    const now = at ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO a2a_peer_inbound (peer_fp, peer_name, last_accepted_at, accept_count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(peer_fp) DO UPDATE SET
           last_accepted_at = excluded.last_accepted_at,
           peer_name = COALESCE(excluded.peer_name, a2a_peer_inbound.peer_name),
           accept_count = a2a_peer_inbound.accept_count + 1`,
      )
      .run(peerFp, peerName ?? null, now);
  }

  /** Outbound messages still awaiting the peer's ack (optionally for one peer). */
  pending(peerFp?: string): A2ADeliveryEntry[] {
    const rows = peerFp
      ? this.db.prepare(`SELECT * FROM a2a_delivery WHERE state = 'awaiting-ack' AND peer_fp = ? ORDER BY sent_at ASC`).all(peerFp)
      : this.db.prepare(`SELECT * FROM a2a_delivery WHERE state = 'awaiting-ack' ORDER BY sent_at ASC`).all();
    return (rows as any[]).map(rowToEntry);
  }

  /**
   * awaiting-ack messages whose last attempt is older than ttlMs — the
   * redelivery/escalation work-list. Sorted oldest-first.
   */
  findOverdue(ttlMs: number, nowMs: number = Date.now()): A2ADeliveryEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM a2a_delivery WHERE state IN ('awaiting-ack','unconfirmed') ORDER BY sent_at ASC`)
      .all() as any[];
    return rows
      .map(rowToEntry)
      .filter((e) => {
        const ref = e.lastAttemptAt || e.sentAt;
        const refMs = Date.parse(ref);
        return !Number.isNaN(refMs) && nowMs - refMs > ttlMs;
      });
  }

  /** Record a redelivery attempt: bump attempts, stamp lastAttempt + nextRetry. */
  markAttempt(messageId: string, nextRetryAt?: string, at?: string): void {
    this.db
      .prepare(
        `UPDATE a2a_delivery
         SET attempts = attempts + 1, last_attempt_at = ?, next_retry_at = ?
         WHERE message_id = ? AND state IN ('awaiting-ack','unconfirmed')`,
      )
      .run(at ?? nowIso(), nextRetryAt ?? null, messageId);
  }

  /** Mark a message escalated (retries exhausted, peer dark — operator notified). */
  markEscalated(messageId: string, at?: string): void {
    this.db
      .prepare(
        `UPDATE a2a_delivery SET state = 'escalated', escalated_at = ?
         WHERE message_id = ? AND state IN ('awaiting-ack','unconfirmed')`,
      )
      .run(at ?? nowIso(), messageId);
  }

  /** Mark a message permanently failed (no further retries/escalation). */
  markFailed(messageId: string): void {
    this.db
      .prepare(`UPDATE a2a_delivery SET state = 'failed' WHERE message_id = ? AND state IN ('awaiting-ack','escalated','unconfirmed')`)
      .run(messageId);
  }

  /** Single entry by messageId. */
  get(messageId: string): A2ADeliveryEntry | null {
    const r = this.db.prepare(`SELECT * FROM a2a_delivery WHERE message_id = ?`).get(messageId);
    return r ? rowToEntry(r) : null;
  }

  /** "Is my channel to <peer> alive?" — composed from outbound + inbound records. */
  peerHealth(peerFp: string, opts: { nowMs?: number; staleAfterMs?: number } = {}): PeerHealth {
    const nowMs = opts.nowMs ?? Date.now();
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

    const lastSent = this.db
      .prepare(`SELECT sent_at, peer_name FROM a2a_delivery WHERE peer_fp = ? ORDER BY sent_at DESC LIMIT 1`)
      .get(peerFp) as { sent_at: string; peer_name: string | null } | undefined;
    const lastAcked = this.db
      .prepare(`SELECT acked_at FROM a2a_delivery WHERE peer_fp = ? AND acked_at IS NOT NULL ORDER BY acked_at DESC LIMIT 1`)
      .get(peerFp) as { acked_at: string } | undefined;
    const inbound = this.db
      .prepare(`SELECT last_accepted_at, peer_name FROM a2a_peer_inbound WHERE peer_fp = ?`)
      .get(peerFp) as { last_accepted_at: string; peer_name: string | null } | undefined;
    // Aggregates, never materialized rows: `unconfirmed` accumulates by design.
    const pendingAgg = this.db
      .prepare(`SELECT COUNT(*) AS n, MIN(sent_at) AS oldest FROM a2a_delivery WHERE peer_fp = ? AND state IN ('awaiting-ack','unconfirmed')`)
      .get(peerFp) as { n: number; oldest: string | null };
    const counts = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM a2a_delivery WHERE peer_fp = ? AND state IN ('escalated','failed','unconfirmed') GROUP BY state`)
      .all(peerFp) as Array<{ state: string; n: number }>;
    const countOf = (st: string): number => counts.find((c) => c.state === st)?.n ?? 0;
    const lastRelay = this.db
      .prepare(`SELECT relay_status, relay_status_at, relay_reason_code, relay_retryable FROM a2a_delivery
                WHERE peer_fp = ? AND relay_status_at IS NOT NULL ORDER BY relay_status_at DESC LIMIT 1`)
      .get(peerFp) as { relay_status: string | null; relay_status_at: string; relay_reason_code: string | null; relay_retryable: number | null } | undefined;

    let oldestPendingAgeMs: number | null = null;
    if (pendingAgg.n > 0 && pendingAgg.oldest) {
      const oldestMs = Date.parse(pendingAgg.oldest);
      if (!Number.isNaN(oldestMs)) oldestPendingAgeMs = Math.max(0, nowMs - oldestMs);
    }
    // Spec §2 stale rule, as one expression: the time-windowed pending clause OR a
    // row the peer provably never received (relay `expired`) newer than its last
    // ack and last inbound (clears only on a later ack/inbound — a dead channel
    // must not read healthy by age).
    const expiredNewer = (this.db
      .prepare(`SELECT 1 AS hit FROM a2a_delivery d
                WHERE d.peer_fp = ? AND d.state = 'failed' AND d.relay_status = 'expired'
                  AND d.relay_status_at > COALESCE(?, '') AND d.relay_status_at > COALESCE(?, '') LIMIT 1`)
      .get(peerFp, lastAcked?.acked_at ?? null, inbound?.last_accepted_at ?? null) as { hit: number } | undefined) !== undefined;
    const stale = (oldestPendingAgeMs !== null && oldestPendingAgeMs > staleAfterMs) || expiredNewer;

    return {
      peerFp,
      peerName: lastSent?.peer_name ?? inbound?.peer_name ?? null,
      lastSentAt: lastSent?.sent_at ?? null,
      lastAckedAt: lastAcked?.acked_at ?? null,
      lastInboundAt: inbound?.last_accepted_at ?? null,
      pendingCount: pendingAgg.n,
      oldestPendingAgeMs,
      escalatedCount: countOf('escalated'),
      failedCount: countOf('failed'),
      unconfirmedCount: countOf('unconfirmed'),
      lastRelayStatus: lastRelay
        ? {
            status: (lastRelay.relay_status as A2ARelayStatus | null) ?? null,
            at: lastRelay.relay_status_at,
            reasonCode: (lastRelay.relay_reason_code as RelayReasonCode | null) ?? null,
            retryable: lastRelay.relay_retryable === null ? null : lastRelay.relay_retryable === 1,
          }
        : null,
      stale,
    };
  }

  /** Health for every peer we've sent to or heard from. */
  allPeerHealth(opts: { nowMs?: number; staleAfterMs?: number } = {}): PeerHealth[] {
    const fps = new Set<string>();
    for (const r of this.db.prepare(`SELECT DISTINCT peer_fp FROM a2a_delivery`).all() as Array<{ peer_fp: string }>) fps.add(r.peer_fp);
    for (const r of this.db.prepare(`SELECT DISTINCT peer_fp FROM a2a_peer_inbound`).all() as Array<{ peer_fp: string }>) fps.add(r.peer_fp);
    return [...fps].map((fp) => this.peerHealth(fp, opts));
  }

  close(): void {
    try { this.unregister?.(); } catch { /* best-effort */ }
    try { this.db.close(); } catch { /* already closed */ }
  }
}
