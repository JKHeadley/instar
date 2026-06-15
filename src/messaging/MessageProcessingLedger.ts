/**
 * MessageProcessingLedger — the no-loss / no-duplicate-reply guarantee (spec §8 G3a).
 *
 * A durable, SQLite-backed record of each inbound message's lifecycle:
 *   received → processing → reply_committed → cursor_advanced
 * keyed by the adapter's `dedupeKey(rawEvent)` (Telegram update_id, Slack
 * event_id/client_msg_id). Rules:
 *
 *  - An event whose dedupeKey is already reply_committed/cursor_advanced is
 *    NEVER acted on again — a redelivery (Telegram retry, Slack reconnect, or a
 *    transfer-window overlap during a handoff) is recognized and dropped. This
 *    is what makes "no duplicate replies" structural, not merely "only one
 *    consumer".
 *  - The ingress cursor advances ONLY on durable completion (cursor_advanced),
 *    so a crash before completion replays the event (at-least-once) and the
 *    ledger makes the replay a no-op-or-resume (exactly-once effect).
 *  - Each transition is flushed to local SQLite synchronously on commit (WAL +
 *    NORMAL), so a same-machine crash-restart never double-acts.
 *  - A stuck `processing` entry past maxProcessingMs (old holder fenced
 *    mid-turn) is re-runnable by the current holder from its stored input.
 *
 * Substrate is SQLite (the proven PendingRelayStore/CommitmentTracker path) —
 * NOT a new ad-hoc JSON file and NOT a git-synced blob. Schema self-initializes
 * on first access (no PostUpdateMigrator step needed). Per-agent-id isolation.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type LedgerState = 'received' | 'processing' | 'reply_committed' | 'cursor_advanced' | 'abandoned';

export interface LedgerEntry {
  dedupeKey: string;
  platform: string;
  topic: string | null;
  state: LedgerState;
  receivedAt: string;
  processingStartedAt: string | null;
  replyCommittedAt: string | null;
  cursorAdvancedAt: string | null;
  /** When this entry was terminally abandoned (stuck-recovery exhausted its
   *  re-run budget without a reply). Set iff state === 'abandoned'. */
  abandonedAt: string | null;
  replyIdempotencyKey: string | null;
  replyEpoch: number | null;
  inputSnapshot: string | null;
  attempts: number;
  /**
   * The inbound sender, captured at ingress so a stuck-recovery re-run replays
   * the message AS the real sender — not "from Unknown" (the 2026-06-07
   * identity-loss bug). JSON `{ userId, username?, firstName? }` or null.
   */
  senderEnvelope: SenderEnvelope | null;
}

/** Inbound sender identity, stored so a replay preserves "Know Your Principal". */
export interface SenderEnvelope {
  userId?: string | number;
  username?: string;
  firstName?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS message_ledger (
  dedupe_key TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  topic TEXT,
  state TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processing_started_at TEXT,
  reply_committed_at TEXT,
  cursor_advanced_at TEXT,
  abandoned_at TEXT,
  reply_idempotency_key TEXT,
  reply_epoch INTEGER,
  input_snapshot TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sender_envelope TEXT
);
CREATE INDEX IF NOT EXISTS idx_message_ledger_state ON message_ledger(state);
CREATE INDEX IF NOT EXISTS idx_message_ledger_topic_committed ON message_ledger(topic, reply_committed_at);
`;

/**
 * Apply the schema, then idempotently add columns introduced after a DB was
 * first created. ALTER TABLE ADD COLUMN throws "duplicate column name" on a DB
 * that already has it — caught and ignored. This keeps existing agents' ledgers
 * upgrading in place with no PostUpdateMigrator step (SQLite schema, per the
 * file-header contract).
 */
function ensureSchema(db: BetterSqliteDatabase): void {
  db.exec(SCHEMA);
  for (const col of ['sender_envelope TEXT', 'abandoned_at TEXT']) {
    try {
      db.exec(`ALTER TABLE message_ledger ADD COLUMN ${col}`);
    } catch {
      /* column already exists — idempotent */
    }
  }
}

export function resolveMessageLedgerPath(stateDir: string, agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  return path.join(stateDir, 'state', `message-ledger.${safe}.sqlite`);
}

/**
 * Deterministic outbound idempotency key — any machine re-running the same
 * inbound event reproduces it identically (spec §8 G3a). Used so a failover
 * re-send is recognized as the same reply.
 */
export function computeReplyIdempotencyKey(dedupeKey: string, replyIndex: number): string {
  return crypto.createHash('sha256').update(`${dedupeKey}::${replyIndex}`).digest('hex').slice(0, 32);
}

export class MessageProcessingLedger {
  private readonly db: BetterSqliteDatabase;
  readonly path: string;

  private constructor(db: BetterSqliteDatabase, dbPath: string) {
    this.db = db;
    this.path = dbPath;
    // Close-on-exit registry (SqliteRegistry.ts) — covers both open() and
    // openMemory(); closed once at shutdown via closeAllSqlite().
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  static open(agentId: string, stateDir: string): MessageProcessingLedger {
    const dbPath = resolveMessageLedgerPath(stateDir, agentId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    ensureSchema(db);
    return new MessageProcessingLedger(db, dbPath);
  }

  /** Open an in-memory ledger (tests). */
  static openMemory(): MessageProcessingLedger {
    const db = new Database(':memory:');
    db.pragma('busy_timeout = 5000');
    ensureSchema(db);
    return new MessageProcessingLedger(db, ':memory:');
  }

  /**
   * Record an inbound event. Idempotent on dedupeKey (INSERT OR IGNORE).
   * Returns whether this is the first time we've seen it + the current state.
   * A caller seeing firstSeen:false with an acted-on state must DROP the event.
   */
  record(dedupeKey: string, opts: { platform: string; topic?: string | null; input?: string; sender?: SenderEnvelope | null }): {
    firstSeen: boolean;
    state: LedgerState;
  } {
    const now = new Date().toISOString();
    const senderJson = opts.sender ? JSON.stringify(opts.sender) : null;
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO message_ledger (dedupe_key, platform, topic, state, received_at, input_snapshot, sender_envelope)
         VALUES (?, ?, ?, 'received', ?, ?, ?)`,
      )
      .run(dedupeKey, opts.platform, opts.topic ?? null, now, opts.input ?? null, senderJson);
    const row = this.get(dedupeKey)!;
    return { firstSeen: info.changes === 1, state: row.state };
  }

  /** Has this event already been acted on (reply committed, cursor advanced, or
   *  terminally abandoned)? An 'abandoned' entry is terminal — a provider
   *  redelivery of the SAME event is dropped (we gave up on it; a genuine resend
   *  arrives with a fresh dedupeKey). */
  isActedOn(dedupeKey: string): boolean {
    const row = this.get(dedupeKey);
    return !!row && (row.state === 'reply_committed' || row.state === 'cursor_advanced' || row.state === 'abandoned');
  }

  /**
   * Claim an event for processing under the given fencing epoch. Returns false
   * if it has already been acted on (drop). A stuck 'processing' entry can be
   * re-claimed (the old holder was fenced); attempts is incremented.
   */
  beginProcessing(dedupeKey: string, epoch: number): boolean {
    const row = this.get(dedupeKey);
    if (!row) return false;
    if (row.state === 'reply_committed' || row.state === 'cursor_advanced' || row.state === 'abandoned') return false;
    this.db
      .prepare(
        `UPDATE message_ledger
         SET state = 'processing', processing_started_at = ?, reply_epoch = ?, attempts = attempts + 1
         WHERE dedupe_key = ?`,
      )
      .run(new Date().toISOString(), epoch, dedupeKey);
    return true;
  }

  /**
   * Commit that a reply was sent. Records the deterministic idempotency key and
   * the fencing epoch it was committed under. Idempotent — committing twice is
   * a no-op (the marker already exists).
   */
  commitReply(dedupeKey: string, replyIdempotencyKey: string, epoch: number): void {
    this.db
      .prepare(
        `UPDATE message_ledger
         SET state = 'reply_committed', reply_committed_at = ?, reply_idempotency_key = ?, reply_epoch = ?
         WHERE dedupe_key = ? AND state NOT IN ('reply_committed','cursor_advanced')`,
      )
      .run(new Date().toISOString(), replyIdempotencyKey, epoch, dedupeKey);
  }

  /** Advance the ingress cursor — only call after durable reply commit. */
  advanceCursor(dedupeKey: string): void {
    this.db
      .prepare(
        `UPDATE message_ledger SET state = 'cursor_advanced', cursor_advanced_at = ?
         WHERE dedupe_key = ? AND state = 'reply_committed'`,
      )
      .run(new Date().toISOString(), dedupeKey);
  }

  /**
   * Terminally abandon a stuck 'processing' entry whose re-run budget is exhausted
   * (stuck-recovery gave up). Moves it OUT of 'processing' so `reclaimStuck` stops
   * re-selecting it every cycle (the give-up log-loop), WITHOUT setting
   * `reply_committed_at` — so it never masquerades as a real reply in
   * `hasReplyCommittedForTopicSince`. Terminal: `beginProcessing`/`isActedOn` treat
   * it as acted-on, so a provider redelivery is dropped (a genuine resend has a
   * fresh dedupeKey). The caller is expected to surface a "I didn't get to this"
   * loss notice so the abandonment is never silent. No-op unless still 'processing'.
   */
  markAbandoned(dedupeKey: string, epoch: number): void {
    this.db
      .prepare(
        `UPDATE message_ledger SET state = 'abandoned', abandoned_at = ?, reply_epoch = ?
         WHERE dedupe_key = ? AND state = 'processing'`,
      )
      .run(new Date().toISOString(), epoch, dedupeKey);
  }

  /**
   * Apply a reply_committed marker propagated from another machine (dual-medium
   * marker, spec §8 G3a): if we have the entry and it's not yet acted on, mark
   * it committed so a failover does not re-send. Creates the entry if unknown
   * (the other machine saw it first).
   */
  applyRemoteReplyMarker(dedupeKey: string, opts: { platform: string; replyIdempotencyKey: string; epoch: number; topic?: string | null }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO message_ledger (dedupe_key, platform, topic, state, received_at, reply_committed_at, reply_idempotency_key, reply_epoch)
         VALUES (?, ?, ?, 'reply_committed', ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           state = CASE WHEN message_ledger.state IN ('reply_committed','cursor_advanced') THEN message_ledger.state ELSE 'reply_committed' END,
           reply_committed_at = COALESCE(message_ledger.reply_committed_at, excluded.reply_committed_at),
           reply_idempotency_key = COALESCE(message_ledger.reply_idempotency_key, excluded.reply_idempotency_key),
           reply_epoch = COALESCE(message_ledger.reply_epoch, excluded.reply_epoch)`,
      )
      .run(dedupeKey, opts.platform, opts.topic ?? null, now, now, opts.replyIdempotencyKey, opts.epoch);
  }

  /**
   * Entries stuck in 'processing' past maxProcessingMs — eligible for re-run by
   * the current lease holder from their stored input (spec §8 G3a). The old
   * holder's abandoned output is discarded (the new holder re-executes).
   */
  reclaimStuck(maxProcessingMs: number, nowMs: number = Date.now()): LedgerEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM message_ledger WHERE state = 'processing'`)
      .all() as any[];
    return rows
      .map(rowToEntry)
      .filter((e) => {
        if (!e.processingStartedAt) return false;
        const startedMs = Date.parse(e.processingStartedAt);
        return !Number.isNaN(startedMs) && nowMs - startedMs > maxProcessingMs;
      });
  }

  /**
   * Reply-evidence check (the no-DUPLICATE-re-run half of stuck recovery): has
   * ANY inbound on this topic been reply_committed at/after `sinceISO`? If so the
   * agent already answered this topic since the stuck entry arrived, so re-running
   * it would re-deliver an already-handled message (the 2026-06-07 every-~10-min
   * "from Unknown" replay loop). Durable across restarts (reads the ledger, not
   * in-memory state). Cheap: indexed on (topic, reply_committed_at).
   */
  hasReplyCommittedForTopicSince(topic: string, sinceISO: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM message_ledger
         WHERE topic = ?
           AND state IN ('reply_committed','cursor_advanced')
           AND reply_committed_at IS NOT NULL
           AND reply_committed_at >= ?
         LIMIT 1`,
      )
      .get(topic, sinceISO);
    return !!row;
  }

  get(dedupeKey: string): LedgerEntry | null {
    const row = this.db.prepare(`SELECT * FROM message_ledger WHERE dedupe_key = ?`).get(dedupeKey) as any;
    return row ? rowToEntry(row) : null;
  }

  close(): void {
    try { this.db.close(); } catch { /* best-effort */ }
  }
}

function rowToEntry(row: any): LedgerEntry {
  return {
    dedupeKey: row.dedupe_key,
    platform: row.platform,
    topic: row.topic ?? null,
    state: row.state,
    receivedAt: row.received_at,
    processingStartedAt: row.processing_started_at ?? null,
    replyCommittedAt: row.reply_committed_at ?? null,
    cursorAdvancedAt: row.cursor_advanced_at ?? null,
    abandonedAt: row.abandoned_at ?? null,
    replyIdempotencyKey: row.reply_idempotency_key ?? null,
    replyEpoch: row.reply_epoch ?? null,
    inputSnapshot: row.input_snapshot ?? null,
    attempts: row.attempts ?? 0,
    senderEnvelope: parseSender(row.sender_envelope),
  };
}

function parseSender(raw: unknown): SenderEnvelope | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as SenderEnvelope) : null;
  } catch {
    return null;
  }
}
