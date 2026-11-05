/**
 * RequiredAckStore — durable state of docs/specs/a2a-required-acknowledgment.md,
 * in the A2ADeliveryTracker's database: peer capabilities (D1) and the one D5 table
 * `a2a_ack_watch`, which holds two kinds of row.
 *
 * A `watch` row follows one inbound message through this receiver:
 *   prepared → router in flight (the handle already exists, in the prompt)
 *   queued   → in the spawn manager's in-memory queue (the D2 journal row)
 *   open     → a session has it; the D5 clock is running
 *   closed   → acknowledged, replied, unacknowledged, dropped, or not delivered
 *
 * A `pending` row is a kinded ack the sender must hear (`read`, `dropped`,
 * `unknown`, `unacknowledged`). It stores whether the trigger arrived encrypted,
 * because known keys empty on restart. Its text is rebuilt from the fixed set.
 *
 * Signal-only: nothing here can block a session or a message.
 */

import crypto from 'node:crypto';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { HeldReason } from './requiredAck.js';

export const REQUIRED_ACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS a2a_peer_caps (
  peer_fp TEXT PRIMARY KEY,
  ack_kinds INTEGER NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS a2a_ack_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  peer_fp TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  ack_ref TEXT,
  session_name TEXT,
  launch_lane TEXT,
  trigger_encrypted INTEGER NOT NULL DEFAULT 0,
  copies INTEGER NOT NULL DEFAULT 0,
  handed_off INTEGER NOT NULL DEFAULT 0,
  replied_before_open INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  opened_at TEXT,
  reminded_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  ack_kind TEXT,
  ack_state TEXT,
  ack_reason TEXT,
  summary TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  expires_at TEXT,
  sent_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_ack_watch_ref ON a2a_ack_watch(ack_ref) WHERE ack_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_ack_watch_msg ON a2a_ack_watch(peer_fp, message_id) WHERE row_kind = 'watch';
CREATE INDEX IF NOT EXISTS idx_a2a_ack_watch_open ON a2a_ack_watch(status, opened_at) WHERE status IN ('open','queued','prepared','pending');
CREATE INDEX IF NOT EXISTS idx_a2a_ack_watch_peer ON a2a_ack_watch(peer_fp, close_reason);
`;

/** Closed rows are removed after this long (D5). */
export const WATCH_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 500;

export interface WatchRow {
  id: number;
  status: 'prepared' | 'queued' | 'open' | 'closed';
  peerFp: string;
  messageId: string;
  threadId: string | null;
  ackRef: string;
  sessionName: string | null;
  launchLane: 'interactive' | 'headless' | null;
  triggerEncrypted: boolean;
  copies: number;
  handedOff: boolean;
  repliedBeforeOpen: boolean;
  openedAt: string | null;
  remindedAt: string | null;
  closeReason: string | null;
}

export interface PendingRow {
  id: number;
  peerFp: string;
  messageId: string;
  threadId: string | null;
  ackKind: 'held' | 'read';
  ackState: string | null;
  ackReason: HeldReason | null;
  summary: string | null;
  triggerEncrypted: boolean;
  attempts: number;
  nextAttemptAt: string;
  expiresAt: string;
}

export interface RequiredAckPeerCounts {
  /** Messages this peer sent us that sessions never acknowledged within the window. */
  unacknowledged: number;
  /** Must-hear receipts that expired before they could be sent. */
  pendingExpired: number;
  /** Pending receipts still waiting to go out. */
  pending: number;
  /** Messages that reached a topic session on another machine, so are not watched. */
  notWatchedRemoteTopic: number;
  /** Watches currently running. */
  openWatches: number;
}

function toWatch(r: any): WatchRow {
  return {
    id: r.id, status: r.status, peerFp: r.peer_fp, messageId: r.message_id, threadId: r.thread_id ?? null,
    ackRef: r.ack_ref, sessionName: r.session_name ?? null, launchLane: r.launch_lane ?? null,
    triggerEncrypted: r.trigger_encrypted === 1, copies: r.copies, handedOff: r.handed_off === 1,
    repliedBeforeOpen: r.replied_before_open === 1, openedAt: r.opened_at ?? null, remindedAt: r.reminded_at ?? null,
    closeReason: r.close_reason ?? null,
  };
}

function toPending(r: any): PendingRow {
  return {
    id: r.id, peerFp: r.peer_fp, messageId: r.message_id, threadId: r.thread_id ?? null,
    ackKind: r.ack_kind, ackState: r.ack_state ?? null, ackReason: r.ack_reason ?? null,
    summary: r.summary ?? null, triggerEncrypted: r.trigger_encrypted === 1, attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at, expiresAt: r.expires_at,
  };
}

/** A short random handle. A peer never chooses it, and it maps only through this table. */
export function mintAckRef(): string {
  return `ack-${crypto.randomBytes(6).toString('hex')}`;
}

export class RequiredAckStore {
  constructor(private readonly db: BetterSqliteDatabase) {}

  // ── D1: capabilities ──────────────────────────────────────────────

  /** Record the highest value per peer. A chat message without the stamp deletes the row. */
  notePeerCaps(peerFp: string, ackKinds: unknown, at: string): void {
    if (!peerFp) return;
    if (typeof ackKinds === 'number' && Number.isFinite(ackKinds) && ackKinds >= 1) {
      this.db.prepare(
        `INSERT INTO a2a_peer_caps (peer_fp, ack_kinds, seen_at) VALUES (?, ?, ?)
         ON CONFLICT(peer_fp) DO UPDATE SET ack_kinds = MAX(a2a_peer_caps.ack_kinds, excluded.ack_kinds), seen_at = excluded.seen_at`,
      ).run(peerFp, Math.floor(ackKinds), at);
    } else {
      this.db.prepare(`DELETE FROM a2a_peer_caps WHERE peer_fp = ?`).run(peerFp);
    }
  }

  peerAckKinds(peerFp: string): number | null {
    const r = this.db.prepare(`SELECT ack_kinds FROM a2a_peer_caps WHERE peer_fp = ?`).get(peerFp) as { ack_kinds: number } | undefined;
    return r?.ack_kinds ?? null;
  }

  // ── Watch rows ────────────────────────────────────────────────────

  /**
   * The row for one inbound message, before the router runs. The handle exists from
   * here, so a session can never hold a handle with no row behind it. A resend of the
   * same id reuses the row: a row a session never answered is re-armed, so the new
   * copy's receipts apply; an acknowledged or replied one stays closed.
   */
  prepareWatch(input: { peerFp: string; messageId: string; threadId: string | null; triggerEncrypted: boolean; at: string }): WatchRow {
    const existing = this.db.prepare(`SELECT * FROM a2a_ack_watch WHERE row_kind = 'watch' AND peer_fp = ? AND message_id = ?`)
      .get(input.peerFp, input.messageId) as any;
    if (existing) {
      if (existing.status === 'closed' && existing.close_reason !== 'acknowledged' && existing.close_reason !== 'replied') {
        this.db.prepare(`UPDATE a2a_ack_watch SET status = 'prepared', closed_at = NULL, close_reason = NULL, copies = 0, reminded_at = NULL, opened_at = NULL, handed_off = 0 WHERE id = ?`).run(existing.id);
      }
      // A copy that arrived encrypted means the peer holds keys, so the acknowledgment
      // must never go plaintext, whichever copy came first.
      if (input.triggerEncrypted && !existing.trigger_encrypted) {
        this.db.prepare(`UPDATE a2a_ack_watch SET trigger_encrypted = 1 WHERE id = ?`).run(existing.id);
      }
      return toWatch(this.db.prepare(`SELECT * FROM a2a_ack_watch WHERE id = ?`).get(existing.id));
    }
    const ackRef = mintAckRef();
    this.db.prepare(
      `INSERT INTO a2a_ack_watch (row_kind, status, peer_fp, message_id, thread_id, ack_ref, trigger_encrypted, created_at)
       VALUES ('watch', 'prepared', ?, ?, ?, ?, ?, ?)`,
    ).run(input.peerFp, input.messageId, input.threadId, ackRef, input.triggerEncrypted ? 1 : 0, input.at);
    return toWatch(this.db.prepare(`SELECT * FROM a2a_ack_watch WHERE ack_ref = ?`).get(ackRef));
  }

  watchForMessage(peerFp: string, messageId: string): WatchRow | null {
    const r = this.db.prepare(`SELECT * FROM a2a_ack_watch WHERE row_kind = 'watch' AND peer_fp = ? AND message_id = ?`).get(peerFp, messageId);
    return r ? toWatch(r) : null;
  }

  watchForRef(ackRef: string): WatchRow | null {
    const r = this.db.prepare(`SELECT * FROM a2a_ack_watch WHERE row_kind = 'watch' AND ack_ref = ?`).get(ackRef);
    return r ? toWatch(r) : null;
  }

  /** The D2 journal: held in the spawn queue. A row already handed off stays as it is. */
  markQueued(id: number, threadId: string | null): void {
    this.db.prepare(
      `UPDATE a2a_ack_watch SET status = 'queued', copies = copies + 1, thread_id = COALESCE(?, thread_id)
       WHERE id = ? AND status IN ('prepared','queued')`,
    ).run(threadId, id);
  }

  /**
   * A session received the message. If a reply beat the row, the row opens already
   * closed. Idempotent: a later copy reaching a session leaves the clock running.
   * Returns true when the clock started.
   */
  openWatch(id: number, input: { sessionName: string | null; lane: 'interactive' | 'headless'; threadId?: string | null; at: string }): boolean {
    const r = this.db.prepare(`SELECT status, replied_before_open FROM a2a_ack_watch WHERE id = ?`).get(id) as { status: string; replied_before_open: number } | undefined;
    if (!r) return false;
    if (r.status === 'open') {
      // The spawn manager's callback got here first; the router's report knows the
      // thread it resolved and, on the injected path, the session.
      this.db.prepare(`UPDATE a2a_ack_watch SET thread_id = COALESCE(?, thread_id), session_name = COALESCE(session_name, ?) WHERE id = ?`)
        .run(input.threadId ?? null, input.sessionName, id);
      return false;
    }
    if (r.status === 'closed') {
      this.db.prepare(`UPDATE a2a_ack_watch SET handed_off = 1 WHERE id = ?`).run(id);
      return false;
    }
    if (r.replied_before_open === 1) {
      this.db.prepare(
        `UPDATE a2a_ack_watch SET status = 'closed', handed_off = 1, closed_at = ?, close_reason = 'replied', session_name = ?, launch_lane = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?`,
      ).run(input.at, input.sessionName, input.lane, input.threadId ?? null, id);
      return false;
    }
    this.db.prepare(
      `UPDATE a2a_ack_watch SET status = 'open', handed_off = 1, opened_at = ?, session_name = ?, launch_lane = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?`,
    ).run(input.at, input.sessionName, input.lane, input.threadId ?? null, id);
    return true;
  }

  closeWatch(id: number, reason: string, at: string): void {
    this.db.prepare(`UPDATE a2a_ack_watch SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ? AND status != 'closed'`).run(at, reason, id);
  }

  /** One queued copy died. Returns true when no copy is left and none reached a session. */
  dropCopy(id: number): boolean {
    const r = this.db.prepare(`SELECT status, copies, handed_off FROM a2a_ack_watch WHERE id = ?`).get(id) as { status: string; copies: number; handed_off: number } | undefined;
    if (!r || r.status !== 'queued' || r.handed_off === 1) return false;
    const left = Math.max(0, r.copies - 1);
    this.db.prepare(`UPDATE a2a_ack_watch SET copies = ? WHERE id = ?`).run(left, id);
    return left === 0;
  }

  /**
   * A session-authored send was accepted on this thread to this peer. Closes open
   * rows; a row not yet open remembers the reply, and opens already closed.
   */
  closeOnReply(peerFp: string, threadId: string, at: string): number {
    const closed = this.db.prepare(
      `UPDATE a2a_ack_watch SET status = 'closed', closed_at = ?, close_reason = 'replied'
       WHERE row_kind = 'watch' AND peer_fp = ? AND thread_id = ? AND status = 'open'`,
    ).run(at, peerFp, threadId);
    this.db.prepare(
      `UPDATE a2a_ack_watch SET replied_before_open = 1
       WHERE row_kind = 'watch' AND peer_fp = ? AND thread_id = ? AND status IN ('prepared','queued')`,
    ).run(peerFp, threadId);
    return closed.changes;
  }

  /** Open watches, oldest first. Bounded by the partial index. */
  openWatches(limit = 500): WatchRow[] {
    return (this.db.prepare(`SELECT * FROM a2a_ack_watch WHERE status = 'open' AND row_kind = 'watch' ORDER BY opened_at ASC LIMIT ?`).all(limit) as any[]).map(toWatch);
  }

  markReminded(ids: number[], at: string): void {
    const stmt = this.db.prepare(`UPDATE a2a_ack_watch SET reminded_at = ? WHERE id = ?`);
    this.db.transaction(() => { for (const id of ids) stmt.run(at, id); })();
  }

  /** Reminder events (not rows: a burst shares one timestamp) sent to sessions about this peer since `sinceIso`. */
  remindersSince(peerFp: string, sinceIso: string): number {
    const r = this.db.prepare(`SELECT COUNT(DISTINCT reminded_at) AS n FROM a2a_ack_watch WHERE row_kind = 'watch' AND peer_fp = ? AND reminded_at IS NOT NULL AND reminded_at >= ?`).get(peerFp, sinceIso) as { n: number };
    return r.n;
  }

  /** Rows a restart interrupted: the server had a message that never finished its hand-off. */
  interruptedWatches(limit = 500): WatchRow[] {
    return (this.db.prepare(`SELECT * FROM a2a_ack_watch WHERE row_kind = 'watch' AND status IN ('prepared','queued') ORDER BY created_at ASC LIMIT ?`).all(limit) as any[]).map(toWatch);
  }

  // ── Pending kinded acks ───────────────────────────────────────────

  /** Durably queue a kinded ack the sender must hear. Idempotent per (peer, message, kind, state). */
  addPending(input: {
    peerFp: string; messageId: string; threadId: string | null; ackKind: 'held' | 'read';
    ackState: string | null; ackReason: HeldReason | null; summary?: string | null;
    triggerEncrypted: boolean; at: string; expiresAt: string;
  }): number {
    const existing = this.db.prepare(
      `SELECT id FROM a2a_ack_watch WHERE row_kind = 'pending' AND status = 'pending' AND peer_fp = ? AND message_id = ? AND ack_kind = ? AND COALESCE(ack_state,'') = COALESCE(?,'')`,
    ).get(input.peerFp, input.messageId, input.ackKind, input.ackState) as { id: number } | undefined;
    if (existing) return existing.id;
    const info = this.db.prepare(
      `INSERT INTO a2a_ack_watch (row_kind, status, peer_fp, message_id, thread_id, trigger_encrypted, created_at, ack_kind, ack_state, ack_reason, summary, next_attempt_at, expires_at)
       VALUES ('pending', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.peerFp, input.messageId, input.threadId, input.triggerEncrypted ? 1 : 0, input.at, input.ackKind, input.ackState, input.ackReason, input.summary ?? null, input.at, input.expiresAt);
    return Number(info.lastInsertRowid);
  }

  /** A `read` write and the watch close, as one step: a limit or a crash cannot lose both. */
  acceptRead(input: { watch: WatchRow; summary: string; at: string; expiresAt: string }): number {
    return this.db.transaction(() => {
      const id = this.addPending({
        peerFp: input.watch.peerFp, messageId: input.watch.messageId, threadId: input.watch.threadId,
        ackKind: 'read', ackState: null, ackReason: null, summary: input.summary,
        triggerEncrypted: input.watch.triggerEncrypted, at: input.at, expiresAt: input.expiresAt,
      });
      this.db.prepare(`UPDATE a2a_ack_watch SET status = 'closed', closed_at = ?, close_reason = 'acknowledged' WHERE id = ?`).run(input.at, input.watch.id);
      return id;
    })();
  }

  duePending(nowIsoStr: string, limit = 200): PendingRow[] {
    return (this.db.prepare(
      `SELECT * FROM a2a_ack_watch WHERE status = 'pending' AND row_kind = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?`,
    ).all(nowIsoStr, limit) as any[]).map(toPending);
  }

  /** Pending rows past their hour close as expired, counted on the health read. */
  expirePending(nowIsoStr: string): number {
    return this.db.prepare(
      `UPDATE a2a_ack_watch SET status = 'closed', closed_at = ?, close_reason = 'expired' WHERE status = 'pending' AND row_kind = 'pending' AND expires_at <= ?`,
    ).run(nowIsoStr, nowIsoStr).changes;
  }

  markPendingSent(ids: number[], at: string): void {
    const stmt = this.db.prepare(`UPDATE a2a_ack_watch SET status = 'closed', closed_at = ?, close_reason = 'sent', sent_at = ? WHERE id = ?`);
    this.db.transaction(() => { for (const id of ids) stmt.run(at, at, id); })();
  }

  closePending(ids: number[], reason: string, at: string): void {
    const stmt = this.db.prepare(`UPDATE a2a_ack_watch SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ?`);
    this.db.transaction(() => { for (const id of ids) stmt.run(at, reason, id); })();
  }

  markPendingRetry(ids: number[], attempts: number, nextAttemptAt: string): void {
    const stmt = this.db.prepare(`UPDATE a2a_ack_watch SET attempts = ?, next_attempt_at = ? WHERE id = ?`);
    this.db.transaction(() => { for (const id of ids) stmt.run(attempts, nextAttemptAt, id); })();
  }

  /** A remote topic session has it: not watched, and health says so. */
  markNotWatched(id: number, at: string): void {
    this.db.prepare(`UPDATE a2a_ack_watch SET status = 'closed', closed_at = ?, close_reason = 'remote-topic', handed_off = 1 WHERE id = ?`).run(at, id);
  }

  // ── Reads ─────────────────────────────────────────────────────────

  peerCounts(peerFp: string): RequiredAckPeerCounts {
    const rows = this.db.prepare(
      `SELECT row_kind, status, close_reason, ack_state, COUNT(*) AS n FROM a2a_ack_watch WHERE peer_fp = ? GROUP BY row_kind, status, close_reason, ack_state`,
    ).all(peerFp) as Array<{ row_kind: string; status: string; close_reason: string | null; ack_state: string | null; n: number }>;
    const out: RequiredAckPeerCounts = { unacknowledged: 0, pendingExpired: 0, pending: 0, notWatchedRemoteTopic: 0, openWatches: 0 };
    for (const r of rows) {
      if (r.row_kind === 'watch' && r.status === 'closed' && r.close_reason === 'unacknowledged') out.unacknowledged += r.n;
      else if (r.row_kind === 'watch' && r.status === 'closed' && r.close_reason === 'remote-topic') out.notWatchedRemoteTopic += r.n;
      else if (r.row_kind === 'watch' && r.status === 'open') out.openWatches += r.n;
      else if (r.row_kind === 'pending' && r.status === 'pending') out.pending += r.n;
      else if (r.row_kind === 'pending' && r.close_reason === 'expired') out.pendingExpired += r.n;
    }
    return out;
  }

  /** Retention: closed rows older than 14 days. Bounded per sweep. */
  sweep(nowMs: number): number {
    const cutoff = new Date(nowMs - WATCH_RETENTION_MS).toISOString();
    return this.db.prepare(
      `DELETE FROM a2a_ack_watch WHERE id IN (SELECT id FROM a2a_ack_watch WHERE status = 'closed' AND closed_at < ? LIMIT ${SWEEP_LIMIT})`,
    ).run(cutoff).changes;
  }
}
