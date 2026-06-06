/**
 * A2ADeliveryTracker — the "communications never just die out" guarantee for
 * agent-to-agent (Threadline / file-relay) messaging.
 *
 * The problem this closes (operator directive, 2026-06-06): every A2A hop was
 * fire-and-forget. A `threadline_send` that returns `delivered:true` only means
 * the TRANSPORT accepted it — it says nothing about whether the peer ever
 * PROCESSED it. And there was no record on the SENDER side of "this message is
 * still waiting for the peer to acknowledge it", so a peer going dark was
 * invisible until a human noticed silence (Dawn's check-in sat 10h unread; my
 * hosting kickoff was accepted by the relay but never seen).
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

/** Outbound delivery lifecycle. */
export type A2ADeliveryState = 'awaiting-ack' | 'acked' | 'escalated' | 'failed';

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
    return new A2ADeliveryTracker(db, dbPath);
  }

  /** Open an in-memory tracker (tests). */
  static openMemory(): A2ADeliveryTracker {
    const db = new Database(':memory:');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return new A2ADeliveryTracker(db, ':memory:');
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
    const now = opts.sentAt ?? new Date().toISOString();
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
         WHERE message_id = ? AND state IN ('awaiting-ack','escalated')`,
      )
      .run(ackedAt ?? new Date().toISOString(), messageId);
    return info.changes > 0;
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
         WHERE thread_id = ? AND state IN ('awaiting-ack','escalated')
         ORDER BY sent_at ASC LIMIT 1`,
      )
      .get(threadId) as { message_id: string } | undefined;
    if (!row) return null;
    return this.recordAck(row.message_id, ackedAt) ? row.message_id : null;
  }

  /** Bump a peer's inbound-liveness clock — call when we ACCEPT a message from them. */
  recordInboundFrom(peerFp: string, peerName: string | null, at?: string): void {
    if (!peerFp) return;
    const now = at ?? new Date().toISOString();
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
      .prepare(`SELECT * FROM a2a_delivery WHERE state = 'awaiting-ack' ORDER BY sent_at ASC`)
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
         WHERE message_id = ? AND state = 'awaiting-ack'`,
      )
      .run(at ?? new Date().toISOString(), nextRetryAt ?? null, messageId);
  }

  /** Mark a message escalated (retries exhausted, peer dark — operator notified). */
  markEscalated(messageId: string, at?: string): void {
    this.db
      .prepare(
        `UPDATE a2a_delivery SET state = 'escalated', escalated_at = ?
         WHERE message_id = ? AND state = 'awaiting-ack'`,
      )
      .run(at ?? new Date().toISOString(), messageId);
  }

  /** Mark a message permanently failed (no further retries/escalation). */
  markFailed(messageId: string): void {
    this.db
      .prepare(`UPDATE a2a_delivery SET state = 'failed' WHERE message_id = ? AND state IN ('awaiting-ack','escalated')`)
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
    const pendingRows = this.db
      .prepare(`SELECT sent_at, last_attempt_at FROM a2a_delivery WHERE peer_fp = ? AND state = 'awaiting-ack' ORDER BY sent_at ASC`)
      .all(peerFp) as Array<{ sent_at: string; last_attempt_at: string | null }>;
    const escalatedCount = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM a2a_delivery WHERE peer_fp = ? AND state = 'escalated'`)
      .get(peerFp) as { n: number }).n;

    let oldestPendingAgeMs: number | null = null;
    if (pendingRows.length > 0) {
      const oldestMs = Date.parse(pendingRows[0].sent_at);
      if (!Number.isNaN(oldestMs)) oldestPendingAgeMs = Math.max(0, nowMs - oldestMs);
    }
    const stale = oldestPendingAgeMs !== null && oldestPendingAgeMs > staleAfterMs;

    return {
      peerFp,
      peerName: lastSent?.peer_name ?? inbound?.peer_name ?? null,
      lastSentAt: lastSent?.sent_at ?? null,
      lastAckedAt: lastAcked?.acked_at ?? null,
      lastInboundAt: inbound?.last_accepted_at ?? null,
      pendingCount: pendingRows.length,
      oldestPendingAgeMs,
      escalatedCount,
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
