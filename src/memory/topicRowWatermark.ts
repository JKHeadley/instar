/**
 * topicRowWatermark — the per-topic contiguous-ack watermark of the relay-path
 * row carrier (docs/specs/context-budget-layered-summaries.md §14, "U bodies and
 * the message-row source"; §18 "the relay-path row carrier with the watermark
 * precondition").
 *
 * Rows are written on the machine whose adapter received the message, and the
 * forward-to-owner path carries each row to the topic's owner. The machine that
 * forwards numbers the rows it carries for a topic in its own STREAM
 * (`<machineId>/<epoch>`, the epoch minted once per database so a lost database
 * never reuses a number), 1, 2, 3, … The owner keeps, per (topic, stream):
 *
 *   - `contiguous` — the highest n such that every row 1..n has LANDED in its
 *     TopicMemory (a carried seq whose row could not be stored does not count);
 *   - `maxSeen`    — the highest seq it knows the stream has assigned;
 *   - `floor`      — seqs at or below it are older than a bounded pull reached.
 *
 * The watermark advances only contiguously: a gap holds it. A topic is clean
 * only when every stream has `contiguous >= maxSeen`, and every message the
 * owner accepted for the topic (carried or not, so an older peer that carries no
 * row still counts) is present in its TopicMemory. Machine-local by design: it
 * describes this machine's own TopicMemory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { NativeModuleHealer } from './NativeModuleHealer.js';

/** How many accepted message ids per topic the presence check keeps. */
export const EXPECTED_ROWS_PER_TOPIC = 500;
/** How many landed seqs per stream the store keeps below the watermark (the rest is pruned). */
export const LANDED_KEEP_PER_STREAM = 1000;

export interface StreamState {
  stream: string;
  contiguous: number;
  maxSeen: number;
  floor: number;
}

/** A stream with a gap: seqs `from..to` are missing or did not land. */
export interface StreamGap { stream: string; from: number; to: number }

/**
 * The pure watermark rule: from `contiguous`, advance while the next seq has
 * landed. Never moves backwards; a missing seq holds it.
 */
export function advanceContiguous(contiguous: number, landed: (seq: number) => boolean): number {
  let c = contiguous;
  while (landed(c + 1)) c++;
  return c;
}

/** The stream id's machine part (who to pull a gap from). */
export function streamMachine(stream: string): string {
  const i = stream.lastIndexOf('/');
  return i > 0 ? stream.slice(0, i) : stream;
}

const STREAM_RE = /^[A-Za-z0-9._:@-]{1,160}\/[a-f0-9]{8,32}$/;
export function isStreamId(s: unknown): s is string {
  return typeof s === 'string' && STREAM_RE.test(s);
}

export class TopicRowWatermarkStore {
  private readonly db: BetterSqliteDatabase;
  private readonly epoch: string;
  private readonly unregister: () => void;
  private closed = false;

  /**
   * `machineId` is read when a row is carried (the stream names the machine a gap is
   * pulled from), so the store can open before the mesh identity is known.
   */
  constructor(private readonly opts: { dbPath: string; machineId: string | (() => string | null | undefined) }) {
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = NativeModuleHealer.openWithHealSync('TopicRowWatermarkStore', () => new Database(opts.dbPath));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS out_seq (
        topic_key TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL,
        PRIMARY KEY (topic_key, seq), UNIQUE (topic_key, message_id)
      );
      CREATE TABLE IF NOT EXISTS in_stream (
        topic_key TEXT NOT NULL, stream TEXT NOT NULL,
        contiguous INTEGER NOT NULL DEFAULT 0, max_seen INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (topic_key, stream)
      );
      CREATE TABLE IF NOT EXISTS in_seq (
        topic_key TEXT NOT NULL, stream TEXT NOT NULL, seq INTEGER NOT NULL, row_key INTEGER,
        abandoned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (topic_key, stream, seq)
      );
      CREATE TABLE IF NOT EXISTS expected (
        topic_key TEXT NOT NULL, channel_message_id TEXT NOT NULL, at INTEGER NOT NULL,
        source TEXT, attempts INTEGER NOT NULL DEFAULT 0, abandoned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (topic_key, channel_message_id)
      );
      CREATE TABLE IF NOT EXISTS move_pending (
        topic_key TEXT PRIMARY KEY, prev_owner TEXT NOT NULL, epoch INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'epoch'`).get() as { value: string } | undefined;
    if (row) this.epoch = row.value;
    else {
      this.epoch = crypto.randomBytes(8).toString('hex');
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('epoch', ?)`).run(this.epoch);
    }
    this.unregister = registerSqliteHandle(() => this.close());
  }

  /** This machine's own outbound stream id. */
  streamId(): string {
    const m = typeof this.opts.machineId === 'function' ? this.opts.machineId() : this.opts.machineId;
    return `${m || 'local'}/${this.epoch}`;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.unregister(); } catch { /* @silent-fallback-ok — registry already cleared */ }
    try { this.db.close(); } catch { /* @silent-fallback-ok — already closed */ }
  }

  // ── Sender side ─────────────────────────────────────────────

  /** The seq for a message this machine carries, idempotent on (topic, message id). */
  assignSeq(topicKey: string, messageId: string): number {
    return this.db.transaction((): number => {
      const had = this.db.prepare('SELECT seq FROM out_seq WHERE topic_key = ? AND message_id = ?').get(topicKey, messageId) as { seq: number } | undefined;
      if (had) return had.seq;
      const top = this.db.prepare('SELECT MAX(seq) AS m FROM out_seq WHERE topic_key = ?').get(topicKey) as { m: number | null };
      const seq = (top.m ?? 0) + 1;
      this.db.prepare('INSERT INTO out_seq (topic_key, seq, message_id) VALUES (?, ?, ?)').run(topicKey, seq, messageId);
      return seq;
    })();
  }

  /** The highest seq this machine has assigned for a topic (0 when none). */
  outboundHead(topicKey: string): number {
    const top = this.db.prepare('SELECT MAX(seq) AS m FROM out_seq WHERE topic_key = ?').get(topicKey) as { m: number | null };
    return top.m ?? 0;
  }

  /** The message ids this machine assigned to seqs `from..to` of a topic. */
  outboundSeqs(topicKey: string, from: number, to: number): Array<{ seq: number; messageId: string }> {
    return this.db.prepare('SELECT seq, message_id AS messageId FROM out_seq WHERE topic_key = ? AND seq BETWEEN ? AND ? ORDER BY seq')
      .all(topicKey, from, to) as Array<{ seq: number; messageId: string }>;
  }

  // ── Owner side ──────────────────────────────────────────────

  /**
   * Record one carried seq. `rowKey` is the integer key of the row now in
   * TopicMemory, or null when the row could not be stored (it then stays a gap).
   * Idempotent: a second arrival of the same seq only fills a missing row key.
   */
  recordInbound(topicKey: string, stream: string, seq: number, rowKey: number | null): StreamState {
    return this.db.transaction((): StreamState => {
      this.ensureStream(topicKey, stream);
      this.db.prepare(`
        INSERT INTO in_seq (topic_key, stream, seq, row_key) VALUES (?, ?, ?, ?)
        ON CONFLICT(topic_key, stream, seq) DO UPDATE SET row_key = COALESCE(in_seq.row_key, excluded.row_key),
          abandoned = CASE WHEN excluded.row_key IS NOT NULL THEN 0 ELSE in_seq.abandoned END
      `).run(topicKey, stream, seq, rowKey);
      this.db.prepare('UPDATE in_stream SET max_seen = MAX(max_seen, ?) WHERE topic_key = ? AND stream = ?').run(seq, topicKey, stream);
      return this.advance(topicKey, stream);
    })();
  }

  /** Learn that a stream has assigned at least `head` seqs (from a peer's report): a gap until they land. */
  noteHead(topicKey: string, stream: string, head: number): StreamState {
    return this.db.transaction((): StreamState => {
      this.ensureStream(topicKey, stream);
      this.db.prepare('UPDATE in_stream SET max_seen = MAX(max_seen, ?) WHERE topic_key = ? AND stream = ?').run(head, topicKey, stream);
      return this.advance(topicKey, stream);
    })();
  }

  /**
   * Seqs at or below `floor` are older than a bounded pull reached. They count
   * toward contiguity, and `floor > 0` stays on the state so the cut is visible.
   */
  setFloor(topicKey: string, stream: string, floor: number): StreamState {
    return this.db.transaction((): StreamState => {
      this.ensureStream(topicKey, stream);
      this.db.prepare('UPDATE in_stream SET floor = MAX(floor, ?), contiguous = MAX(contiguous, ?) WHERE topic_key = ? AND stream = ?')
        .run(floor, floor, topicKey, stream);
      return this.advance(topicKey, stream);
    })();
  }

  /**
   * Every message the owner accepted for a topic (and which machine sent it), so the
   * presence check covers rows no peer carried. Pruned to the most recent
   * `EXPECTED_ROWS_PER_TOPIC` only when over the cap.
   */
  expectRow(topicKey: string, channelMessageId: string, source: string | null = null, atMs: number = Date.now()): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO expected (topic_key, channel_message_id, at, source) VALUES (?, ?, ?, ?)').run(topicKey, channelMessageId, atMs, source);
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM expected WHERE topic_key = ?').get(topicKey) as { n: number }).n;
      if (n > EXPECTED_ROWS_PER_TOPIC) {
        this.db.prepare(`
          DELETE FROM expected WHERE topic_key = ? AND channel_message_id NOT IN (
            SELECT channel_message_id FROM expected WHERE topic_key = ? ORDER BY at DESC, channel_message_id DESC LIMIT ?
          )
        `).run(topicKey, topicKey, EXPECTED_ROWS_PER_TOPIC);
      }
    })();
  }

  /** Accepted message ids still counted by the presence check (an abandoned one is not). */
  expectedRows(topicKey: string): string[] {
    return this.expectedEntries(topicKey).filter((e) => !e.abandoned).map((e) => e.channelMessageId);
  }

  expectedEntries(topicKey: string): Array<{ channelMessageId: string; source: string | null; attempts: number; abandoned: boolean }> {
    return (this.db.prepare('SELECT channel_message_id AS c, source, attempts, abandoned FROM expected WHERE topic_key = ? ORDER BY at, channel_message_id').all(topicKey) as Array<{ c: string; source: string | null; attempts: number; abandoned: number }>)
      .map((r) => ({ channelMessageId: r.c, source: r.source, attempts: r.attempts, abandoned: r.abandoned === 1 }));
  }

  bumpExpectedAttempt(topicKey: string, channelMessageId: string): number {
    this.db.prepare('UPDATE expected SET attempts = attempts + 1 WHERE topic_key = ? AND channel_message_id = ?').run(topicKey, channelMessageId);
    return (this.db.prepare('SELECT attempts FROM expected WHERE topic_key = ? AND channel_message_id = ?').get(topicKey, channelMessageId) as { attempts: number } | undefined)?.attempts ?? 0;
  }

  /** Stop counting an accepted message whose row no machine could supply (kept, marked, visible). */
  abandonExpected(topicKey: string, channelMessageId: string): void {
    this.db.prepare('UPDATE expected SET abandoned = 1 WHERE topic_key = ? AND channel_message_id = ?').run(topicKey, channelMessageId);
  }

  /**
   * Seqs `from..to` of a stream that can never be supplied (the stream's machine no longer
   * holds that stream, or has no row for them after repeated pulls): they count toward
   * contiguity, and stay marked so the cut is visible.
   */
  abandonSeqs(topicKey: string, stream: string, from: number, to: number): StreamState {
    return this.db.transaction((): StreamState => {
      this.ensureStream(topicKey, stream);
      const up = this.db.prepare(`
        INSERT INTO in_seq (topic_key, stream, seq, row_key, abandoned) VALUES (?, ?, ?, NULL, 1)
        ON CONFLICT(topic_key, stream, seq) DO UPDATE SET abandoned = CASE WHEN in_seq.row_key IS NULL THEN 1 ELSE in_seq.abandoned END
      `);
      for (let q = from; q <= to; q++) up.run(topicKey, stream, q);
      this.db.prepare('UPDATE in_stream SET max_seen = MAX(max_seen, ?) WHERE topic_key = ? AND stream = ?').run(to, topicKey, stream);
      return this.advance(topicKey, stream);
    })();
  }

  /** Mark these seqs unrecoverable, clearing a row key whose row is gone (the caller checked TopicMemory). */
  abandonSeqList(topicKey: string, stream: string, seqs: number[]): StreamState {
    return this.db.transaction((): StreamState => {
      this.ensureStream(topicKey, stream);
      const up = this.db.prepare(`
        INSERT INTO in_seq (topic_key, stream, seq, row_key, abandoned) VALUES (?, ?, ?, NULL, 1)
        ON CONFLICT(topic_key, stream, seq) DO UPDATE SET row_key = NULL, abandoned = 1
      `);
      let top = 0;
      for (const q of seqs) { up.run(topicKey, stream, q); top = Math.max(top, q); }
      this.db.prepare('UPDATE in_stream SET max_seen = MAX(max_seen, ?) WHERE topic_key = ? AND stream = ?').run(top, topicKey, stream);
      return this.advance(topicKey, stream);
    })();
  }

  abandonedCount(topicKey: string): number {
    const a = (this.db.prepare('SELECT COUNT(*) AS n FROM in_seq WHERE topic_key = ? AND abandoned = 1 AND row_key IS NULL').get(topicKey) as { n: number }).n;
    const b = (this.db.prepare('SELECT COUNT(*) AS n FROM expected WHERE topic_key = ? AND abandoned = 1').get(topicKey) as { n: number }).n;
    return a + b;
  }

  /** Every landed seq this store still retains, so the presence check can re-confirm each row. */
  landedEntries(topicKey: string): Array<{ stream: string; seq: number; rowKey: number }> {
    return this.db.prepare('SELECT stream, seq, row_key AS rowKey FROM in_seq WHERE topic_key = ? AND row_key IS NOT NULL ORDER BY stream, seq')
      .all(topicKey) as Array<{ stream: string; seq: number; rowKey: number }>;
  }

  // ── Topic moves ─────────────────────────────────────────────

  /** A topic moved here at `epoch`: until its previous owner's rows are pulled, it is not clean. */
  markMovePending(topicKey: string, prevOwner: string, epoch: number): void {
    this.db.prepare(`
      INSERT INTO move_pending (topic_key, prev_owner, epoch) VALUES (?, ?, ?)
      ON CONFLICT(topic_key) DO UPDATE SET prev_owner = excluded.prev_owner, epoch = excluded.epoch, attempts = 0, next_at = 0
        WHERE excluded.epoch >= move_pending.epoch
    `).run(topicKey, prevOwner, epoch);
  }

  movePending(topicKey: string): { prevOwner: string; epoch: number; attempts: number; nextAt: number } | null {
    const r = this.db.prepare('SELECT prev_owner AS prevOwner, epoch, attempts, next_at AS nextAt FROM move_pending WHERE topic_key = ?').get(topicKey);
    return (r as { prevOwner: string; epoch: number; attempts: number; nextAt: number } | undefined) ?? null;
  }

  noteMoveAttempt(topicKey: string, nextAt: number): number {
    this.db.prepare('UPDATE move_pending SET attempts = attempts + 1, next_at = ? WHERE topic_key = ?').run(nextAt, topicKey);
    return this.movePending(topicKey)?.attempts ?? 0;
  }

  clearMovePending(topicKey: string): void {
    this.db.prepare('DELETE FROM move_pending WHERE topic_key = ?').run(topicKey);
  }

  /** Topics with any open or checkable work, for the repair sweep. */
  topicsNeedingCheck(limit: number, offset: number = 0): string[] {
    return (this.db.prepare(`
      SELECT topic_key AS k FROM move_pending
      UNION SELECT topic_key FROM in_stream WHERE max_seen > contiguous
      UNION SELECT topic_key FROM expected WHERE abandoned = 0
      UNION SELECT topic_key FROM in_seq WHERE row_key IS NOT NULL
      ORDER BY k LIMIT ? OFFSET ?
    `).all(limit, offset) as Array<{ k: string }>).map((r) => r.k);
  }

  streams(topicKey: string): StreamState[] {
    return this.db.prepare('SELECT stream, contiguous, max_seen AS maxSeen, floor FROM in_stream WHERE topic_key = ? ORDER BY stream')
      .all(topicKey) as StreamState[];
  }

  /** The gaps of a topic: per stream, the first missing seq to the highest known. */
  gaps(topicKey: string): StreamGap[] {
    return this.streams(topicKey).filter((s) => s.maxSeen > s.contiguous).map((s) => ({ stream: s.stream, from: s.contiguous + 1, to: s.maxSeen }));
  }

  /** Is every stream of the topic contiguous up to its highest known seq? */
  contiguousClean(topicKey: string): boolean {
    return this.gaps(topicKey).length === 0;
  }

  private ensureStream(topicKey: string, stream: string): void {
    this.db.prepare('INSERT OR IGNORE INTO in_stream (topic_key, stream) VALUES (?, ?)').run(topicKey, stream);
  }

  private advance(topicKey: string, stream: string): StreamState {
    const st = this.db.prepare('SELECT stream, contiguous, max_seen AS maxSeen, floor FROM in_stream WHERE topic_key = ? AND stream = ?')
      .get(topicKey, stream) as StreamState;
    const landed = this.db.prepare('SELECT 1 FROM in_seq WHERE topic_key = ? AND stream = ? AND seq = ? AND (row_key IS NOT NULL OR abandoned = 1)');
    const c = advanceContiguous(st.contiguous, (seq) => !!landed.get(topicKey, stream, seq));
    if (c !== st.contiguous) {
      this.db.prepare('UPDATE in_stream SET contiguous = ?, max_seen = MAX(max_seen, ?) WHERE topic_key = ? AND stream = ?').run(c, c, topicKey, stream);
      st.contiguous = c;
      if (st.maxSeen < c) st.maxSeen = c;
      // Bounded: keep the most recent landed seqs below the watermark; the watermark itself is the record.
      this.db.prepare('DELETE FROM in_seq WHERE topic_key = ? AND stream = ? AND seq <= ?').run(topicKey, stream, c - LANDED_KEEP_PER_STREAM);
    }
    return st;
  }
}
