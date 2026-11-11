/**
 * TopicMemory — SQLite-backed conversational memory per Telegram topic.
 *
 * Topic history is the HIGHEST priority context for any agent. It represents
 * what the user and agent have been working on — the living relationship.
 * All other context (identity, memory, relationships) supports this primary layer.
 *
 * Architecture:
 *   - Messages: Dual-written to JSONL (append log) AND SQLite (query layer)
 *   - Search: FTS5 full-text search over all messages, filterable by topic
 *   - Summaries: Rolling LLM-generated summaries per topic, updated on session end
 *   - Context: Session-start loads topic summary + recent messages as primary context
 *
 * The JSONL log remains the source of truth for disaster recovery.
 * SQLite is a derived query layer that can be rebuilt from JSONL at any time.
 *
 * Born from the insight: "Topic history represents the highest level of information
 * of what the user and the agent have been working on." — Justin, 2026-02-24
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { NativeModuleHealer } from './NativeModuleHealer.js';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { formatLocalTimestamp } from '../utils/localTime.js';

// Dynamic import for better-sqlite3
type Database = import('better-sqlite3').Database;

export interface TopicMessage {
  messageId: number;
  topicId: number;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  /** Sender display name (from Telegram first_name) */
  senderName?: string;
  /** Sender @username (optional — not all Telegram users have one) */
  senderUsername?: string;
  /** Telegram numeric user ID — authoritative identity */
  telegramUserId?: number;
  /** User ID from UserManager (resolved identity) */
  userId?: string;
  /** Privacy scope for this message (default: private to the sender) */
  privacyScope?: import('../core/types.js').PrivacyScopeType;
  /** Explicit platform forwarding provenance; undefined means legacy/unknown. */
  forwarded?: boolean;
  /**
   * The channel's own message id, kept verbatim (context-budget §14 key rule):
   * Telegram the native id, Slack the `ts`, an app conversation the event id.
   * Undefined on legacy rows and on writers that predate the row writer.
   */
  channelMessageId?: string;
  /**
   * Set only on rows that reached this topic through another agent
   * (context-budget §8): `relay` (a Threadline relay message mirrored in) or
   * `a2a` (this agent's own agent-to-agent traffic mirrored in). Such rows are
   * kept and labelled, and carry no operator authority. Undefined otherwise.
   */
  origin?: TopicRowOrigin;
}

/** Row origins that mark a TopicMemory row as arriving from another agent (§8). */
export const TOPIC_ROW_ORIGINS = ['relay', 'a2a'] as const;
export type TopicRowOrigin = (typeof TOPIC_ROW_ORIGINS)[number];

/** A recorded origin, or undefined for anything else (an unknown value is never guessed). */
export function coerceTopicRowOrigin(value: unknown): TopicRowOrigin | undefined {
  return typeof value === 'string' && (TOPIC_ROW_ORIGINS as readonly string[]).includes(value)
    ? value as TopicRowOrigin
    : undefined;
}

/** What a keyed insert did (context-budget §14). */
export type KeyedInsertResult =
  /** A new row landed. */
  | { outcome: 'inserted' }
  /** The same channel message was already stored (a replay); nothing changed. */
  | { outcome: 'duplicate' }
  /** A legacy row with this integer key and no channel id was adopted: its channel id was filled in. */
  | { outcome: 'adopted' }
  /** The integer key is held by a DIFFERENT channel message: refused, the existing row is untouched. */
  | { outcome: 'collision'; existingChannelMessageId: string }
  /** The channel id is already stored under a DIFFERENT integer key: refused (a key-rule mismatch). */
  | { outcome: 'key-mismatch'; existingMessageId: number }
  /** TopicMemory is not open. */
  | { outcome: 'not-ready' };

export interface TopicSummary {
  topicId: number;
  summary: string;
  /** One-line description of the topic's current focus (soft awareness, not a constraint) */
  purpose: string | null;
  messageCountAtSummary: number;
  lastMessageId: number;
  updatedAt: string;
}

export interface TopicMeta {
  topicId: number;
  topicName: string | null;
  messageCount: number;
  lastActivity: string;
  hasSummary: boolean;
}

export interface TopicSearchResult {
  text: string;
  topicId: number;
  fromUser: boolean;
  timestamp: string;
  messageId: number;
  rank: number;
  highlight?: string;
}

export interface TopicContext {
  /** Rolling summary of the full conversation (null if none generated yet) */
  summary: string | null;
  /** One-line description of the topic's current focus (null if not yet generated) */
  purpose: string | null;
  /** Recent messages (most recent N) */
  recentMessages: TopicMessage[];
  /** Total message count for this topic */
  totalMessages: number;
  /** Topic name if known */
  topicName: string | null;
}

const SCHEMA_VERSION = '6';

/**
 * Map a raw SQLite row to a TopicMessage with proper type coercion.
 */
function mapRow(row: any): TopicMessage {
  return {
    ...row,
    fromUser: !!row.fromUser,
    senderName: row.senderName ?? undefined,
    senderUsername: row.senderUsername ?? undefined,
    telegramUserId: row.telegramUserId ?? undefined,
    userId: row.userId ?? undefined,
    privacyScope: row.privacyScope ?? undefined,
    forwarded: row.forwarded == null ? undefined : !!row.forwarded,
    channelMessageId: row.channelMessageId ?? undefined,
    origin: coerceTopicRowOrigin(row.origin),
  };
}

/**
 * Strip FTS5 special syntax characters from a query.
 */
function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .replace(/[*:"^{}().]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TopicMemory {
  private db: Database | null = null;
  private dbPath: string;
  private stateDir: string;
  /** Set after corruption auto-recovery — caller should reimport from JSONL */
  private _needsRebuild = false;
  /** Stats from the most recent importFromJsonl() / rebuild() call */
  private _lastImportStats: { imported: number; malformed: number; missingFields: number } | null = null;
  /** insertKeyedMessage's statements, prepared once per open handle. */
  private keyedStmts: { db: Database; byKey: import('better-sqlite3').Statement; byChannel: import('better-sqlite3').Statement; adopt: import('better-sqlite3').Statement } | null = null;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.dbPath = path.join(stateDir, 'topic-memory.db');
  }

  /**
   * Check if the database is open and ready for queries.
   * Use this to verify TopicMemory is functional before relying on it.
   */
  isReady(): boolean {
    return this.db !== null;
  }

  /**
   * Open the database and create schema if needed.
   */
  async open(): Promise<void> {
    if (this.db) return;

    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    // Wrap import + construct in NativeModuleHealer so a NODE_MODULE_VERSION
    // mismatch is auto-rebuilt and retried once. See PROP-399.
    const opened = await NativeModuleHealer.openWithHeal('TopicMemory', async () => {
      const mod = await import('better-sqlite3');
      const Ctor = mod.default;
      return { Ctor, db: new Ctor(this.dbPath) };
    });
    const BetterSqlite3: any = opened.Ctor;
    this.db = opened.db;

    // Integrity check — auto-recover from corruption (JSONL is source of truth)
    if (fs.existsSync(this.dbPath) && fs.statSync(this.dbPath).size > 0) {
      try {
        const result = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (result[0]?.integrity_check !== 'ok') {
          console.warn(`[TopicMemory] Database corrupt (${result[0]?.integrity_check}) — deleting and rebuilding`);
          this.db.close();
          this.db = null;
          SafeFsExecutor.safeUnlinkSync(this.dbPath, { operation: 'src/memory/TopicMemory.ts:159' });
          for (const ext of ['-wal', '-shm']) {
            try { SafeFsExecutor.safeUnlinkSync(this.dbPath + ext, { operation: 'src/memory/TopicMemory.ts:162' }); } catch { /* may not exist */ }
          }
          this.db = new BetterSqlite3(this.dbPath);
          this._needsRebuild = true;
        }
      } catch (err) {
        // If even the integrity check fails, the db is severely corrupted
        console.warn(`[TopicMemory] Database unreadable — deleting and rebuilding:`, err);
        try { this.db?.close(); } catch { /* ignore */ }
        this.db = null;
        try { SafeFsExecutor.safeUnlinkSync(this.dbPath, { operation: 'src/memory/TopicMemory.ts:173' }); } catch { /* ignore */ }
        for (const ext of ['-wal', '-shm']) {
          try { SafeFsExecutor.safeUnlinkSync(this.dbPath + ext, { operation: 'src/memory/TopicMemory.ts:176' }); } catch { /* may not exist */ }
        }
        this.db = new BetterSqlite3(this.dbPath);
        this._needsRebuild = true;
      }
    }

    // WAL mode for concurrent reads during writes
    this.db!.pragma('journal_mode = WAL');
    this.db!.pragma('busy_timeout = 5000');

    this.createSchema();
    // Close-on-exit registry (SqliteRegistry.ts) — closed once at shutdown; the
    // closeFn reads this.db live so a corruption-rebuild reopen is still covered.
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });

    // Auto-rebuild from JSONL after corruption recovery
    if (this._needsRebuild) {
      const jsonlPath = path.join(this.stateDir, 'telegram-messages.jsonl');
      if (fs.existsSync(jsonlPath)) {
        const imported = await this.importFromJsonl(jsonlPath);
        console.log(`[TopicMemory] Auto-rebuilt from JSONL: ${imported} messages reimported`);
      } else {
        console.warn('[TopicMemory] No JSONL log found for rebuild — starting fresh');
      }
      this._needsRebuild = false;
    }
  }

  /**
   * Close the database cleanly.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Checkpoint the WAL file. Call after sleep/wake to flush stale WAL locks.
   * Uses PASSIVE mode (non-blocking) — safe to call at any time.
   */
  checkpoint(): void {
    if (this.db) {
      try { this.db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* non-critical */ }
    }
  }

  /**
   * Create the schema if it doesn't exist, and run migrations.
   */
  private createSchema(): void {
    if (!this.db) throw new Error('Database not open');

    this.db.exec(`
      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- All messages, indexed by topic
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        topic_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        from_user INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL,
        session_name TEXT,
        sender_name TEXT,
        sender_username TEXT,
        telegram_user_id INTEGER,
        user_id TEXT,
        privacy_scope TEXT DEFAULT 'private',
        forwarded INTEGER,
        channel_message_id TEXT,
        origin TEXT,
        UNIQUE(message_id, topic_id)
      );

      -- Indexes for efficient topic queries
      CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_topic_id ON messages(topic_id, message_id);

      -- FTS5 full-text search over messages
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        content='messages',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS5 in sync with messages table
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

      -- Rolling summaries per topic
      CREATE TABLE IF NOT EXISTS topic_summaries (
        topic_id INTEGER PRIMARY KEY,
        summary TEXT NOT NULL,
        purpose TEXT,
        message_count_at_summary INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Topic metadata
      CREATE TABLE IF NOT EXISTS topic_meta (
        topic_id INTEGER PRIMARY KEY,
        topic_name TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_activity TEXT NOT NULL
      );
    `);

    // Run migrations for existing databases
    this.migrateSchema();

    // Ensure indexes exist (safe for both new and migrated databases)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(telegram_user_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_privacy ON messages(privacy_scope)');
    // Context-budget §14: one row per channel message. Partial, so legacy rows
    // (NULL channel id) never conflict with each other.
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_msg ON messages(topic_id, channel_message_id) WHERE channel_message_id IS NOT NULL');

    // Set schema version
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  }

  /**
   * Run schema migrations for existing databases.
   * SQLite ALTER TABLE ADD COLUMN is safe — new columns default to NULL
   * for existing rows.
   */
  private migrateSchema(): void {
    if (!this.db) return;

    const versionRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    const currentVersion = versionRow?.value ?? '0';

    if (currentVersion < '2') {
      // Migration v1 → v2: Add sender identity columns
      // (User-Agent Topology Spec, Phase 1C)
      const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(c => c.name));

      if (!columnNames.has('sender_name')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN sender_name TEXT');
      }
      if (!columnNames.has('sender_username')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN sender_username TEXT');
      }
      if (!columnNames.has('telegram_user_id')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN telegram_user_id INTEGER');
      }

      // Add sender index if missing
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(telegram_user_id)');
      } catch { /* index may already exist */ }
    }

    if (currentVersion < '3') {
      // Migration v2 → v3: Add privacy scoping columns
      // (User-Agent Topology Spec, Phase 2B)
      const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(c => c.name));

      if (!columnNames.has('user_id')) {
        this.db.exec("ALTER TABLE messages ADD COLUMN user_id TEXT");
      }
      if (!columnNames.has('privacy_scope')) {
        this.db.exec("ALTER TABLE messages ADD COLUMN privacy_scope TEXT DEFAULT 'private'");
      }

      // Add user_id index for privacy-filtered queries
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id)');
      } catch { /* index may already exist */ }
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_privacy ON messages(privacy_scope)');
      } catch { /* index may already exist */ }
    }

    if (currentVersion < '4') {
      // Migration v3 → v4: Add purpose column to topic_summaries
      // Purpose tracks the topic's current focus for soft session awareness.
      const columns = this.db.prepare("PRAGMA table_info(topic_summaries)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(c => c.name));

      if (!columnNames.has('purpose')) {
        this.db.exec('ALTER TABLE topic_summaries ADD COLUMN purpose TEXT');
      }
    }

    if (currentVersion < '5') {
      // Migration v4 → v5: retain explicit forwarded provenance. Existing rows
      // remain NULL/unknown and therefore cannot establish operator authority.
      const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(c => c.name));
      if (!columnNames.has('forwarded')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN forwarded INTEGER');
      }
    }

    if (currentVersion < '6') {
      // Migration v5 → v6 (context-budget-layered-summaries §14, §8): the
      // channel's own message id and the relay/A2A row origin. Both nullable
      // and inert on existing rows (unknown, never guessed). The unique index
      // on (topic_id, channel_message_id) is created after this pass.
      const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const columnNames = new Set(columns.map(c => c.name));
      if (!columnNames.has('channel_message_id')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN channel_message_id TEXT');
      }
      if (!columnNames.has('origin')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN origin TEXT');
      }
    }
  }

  // ── Message Operations ──────────────────────────────────────

  /**
   * Insert a message into the database.
   * Idempotent — duplicate messageId+topicId pairs are ignored.
   */
  insertMessage(msg: TopicMessage): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (message_id, topic_id, text, from_user, timestamp, session_name, sender_name, sender_username, telegram_user_id, user_id, privacy_scope, forwarded, channel_message_id, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.messageId, msg.topicId, msg.text, msg.fromUser ? 1 : 0,
      msg.timestamp, msg.sessionName,
      msg.senderName ?? null, msg.senderUsername ?? null, msg.telegramUserId ?? null,
      msg.userId ?? null, msg.privacyScope ?? 'private',
      msg.forwarded == null ? null : (msg.forwarded ? 1 : 0),
      msg.channelMessageId ?? null, msg.origin ?? null,
    );

    // Update topic metadata
    this.db.prepare(`
      INSERT INTO topic_meta (topic_id, message_count, last_activity)
      VALUES (?, 1, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        message_count = message_count + 1,
        last_activity = excluded.last_activity
    `).run(msg.topicId, msg.timestamp);
  }

  /**
   * Insert a row keyed by the channel-neutral key rule (context-budget §14):
   * the integer `messageId` derived deterministically per channel, and the
   * channel's own id in `channelMessageId` (required here). Unlike
   * `insertMessage`, this never ignores silently: a replay of the same channel
   * message is `duplicate`, and an integer key already held by a DIFFERENT
   * channel message is `collision` (refused, the stored row untouched), so the
   * caller can count it. A legacy row with this key and no channel id is
   * adopted (its channel id filled in), so rows written before the column
   * existed do not read as collisions.
   */
  insertKeyedMessage(msg: TopicMessage & { channelMessageId: string }): KeyedInsertResult {
    const db = this.db;
    if (!db) return { outcome: 'not-ready' };
    if (typeof msg.channelMessageId !== 'string' || msg.channelMessageId.length === 0) {
      throw new Error('insertKeyedMessage requires a channelMessageId');
    }
    if (!Number.isSafeInteger(msg.messageId)) {
      throw new Error(`insertKeyedMessage requires a safe-integer messageId (got ${String(msg.messageId)})`);
    }
    // Prepared once per open database (a corruption rebuild opens a new handle).
    if (!this.keyedStmts || this.keyedStmts.db !== db) {
      this.keyedStmts = {
        db,
        byKey: db.prepare('SELECT id, channel_message_id AS cmid FROM messages WHERE topic_id = ? AND message_id = ?'),
        byChannel: db.prepare('SELECT id, message_id AS mid FROM messages WHERE topic_id = ? AND channel_message_id = ?'),
        adopt: db.prepare('UPDATE messages SET channel_message_id = ?, origin = COALESCE(origin, ?) WHERE id = ?'),
      };
    }
    const st = this.keyedStmts;
    return db.transaction((): KeyedInsertResult => {
      const byKey = st.byKey.get(msg.topicId, msg.messageId) as { id: number; cmid: string | null } | undefined;
      const byChannel = st.byChannel.get(msg.topicId, msg.channelMessageId) as { id: number; mid: number } | undefined;
      if (byKey) {
        if (byKey.cmid === msg.channelMessageId) return { outcome: 'duplicate' };
        if (byKey.cmid !== null) return { outcome: 'collision', existingChannelMessageId: byKey.cmid };
        if (byChannel) return { outcome: 'key-mismatch', existingMessageId: byChannel.mid };
        st.adopt.run(msg.channelMessageId, msg.origin ?? null, byKey.id);
        return { outcome: 'adopted' };
      }
      if (byChannel) return { outcome: 'key-mismatch', existingMessageId: byChannel.mid };
      this.insertMessage(msg);
      return { outcome: 'inserted' };
    })();
  }

  /**
   * Batch-insert messages (for JSONL import).
   */
  insertMessages(messages: TopicMessage[]): number {
    if (!this.db) return 0;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO messages (message_id, topic_id, text, from_user, timestamp, session_name, sender_name, sender_username, telegram_user_id, user_id, privacy_scope, forwarded, channel_message_id, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const tx = this.db.transaction(() => {
      for (const msg of messages) {
        const result = insert.run(
          msg.messageId, msg.topicId, msg.text, msg.fromUser ? 1 : 0,
          msg.timestamp, msg.sessionName,
          msg.senderName ?? null, msg.senderUsername ?? null, msg.telegramUserId ?? null,
          msg.userId ?? null, msg.privacyScope ?? 'private',
          msg.forwarded == null ? null : (msg.forwarded ? 1 : 0),
          msg.channelMessageId ?? null, msg.origin ?? null,
        );
        if (result.changes > 0) count++;
      }
    });
    tx();

    // Rebuild topic_meta from messages after bulk import
    this.rebuildTopicMeta();

    return count;
  }

  /**
   * Get recent messages for a topic.
   */
  getRecentMessages(topicId: number, limit: number = 20): TopicMessage[] {
    if (!this.db) return [];

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope, forwarded,
             channel_message_id AS channelMessageId, origin
      FROM messages
      WHERE topic_id = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(topicId, limit).reverse().map(mapRow) as TopicMessage[];
  }

  /**
   * Chronological, bounded source read used by goal-realignment reconciliation.
   * `complete:false` means the caller hit the hard bound and must not claim full
   * coverage. Forwarded provenance is returned exactly: false is eligible,
   * true/undefined remain ineligible at the authority layer.
   */
  getMessagesSince(
    topicId: number,
    sinceIso: string,
    limit: number = 500,
  ): { messages: TopicMessage[]; complete: boolean } {
    if (!this.db) return { messages: [], complete: false };
    const bounded = Math.max(1, Math.min(Math.floor(limit), 2_000));
    const rows = this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername,
             telegram_user_id AS telegramUserId, user_id AS userId,
             privacy_scope AS privacyScope, forwarded,
             channel_message_id AS channelMessageId, origin
      FROM messages
      WHERE topic_id = ? AND timestamp >= ?
      ORDER BY timestamp ASC, id ASC
      LIMIT ?
    `).all(topicId, sinceIso, bounded + 1).map(mapRow) as TopicMessage[];
    return { messages: rows.slice(0, bounded), complete: rows.length <= bounded };
  }

  /**
   * Get recent messages for a topic, filtered by user visibility.
   * Returns only messages the specified user is allowed to see.
   *
   * Visibility rules:
   *   - Messages with scope 'shared-project' or NULL are visible to everyone
   *   - Messages with scope 'private' are visible only to the owner
   *   - Messages with scope 'shared-topic' are visible to all users in that topic
   *
   * Phase 2B — User-Agent Topology Spec, Gap 9
   */
  getRecentMessagesForUser(topicId: number, userId: string, limit: number = 20): TopicMessage[] {
    if (!this.db) return [];

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope, forwarded,
             channel_message_id AS channelMessageId, origin
      FROM messages
      WHERE topic_id = ?
        AND (
          privacy_scope IS NULL
          OR privacy_scope = 'shared-project'
          OR privacy_scope = 'shared-topic'
          OR (privacy_scope = 'private' AND user_id = ?)
          OR user_id IS NULL
        )
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(topicId, userId, limit).reverse().map(mapRow) as TopicMessage[];
  }

  /**
   * Get the full context for a topic: summary + recent messages.
   * This is the primary context loader for session spawning.
   */
  getTopicContext(topicId: number, recentLimit: number = 20): TopicContext {
    if (!this.db) return { summary: null, purpose: null, recentMessages: [], totalMessages: 0, topicName: null };

    const summary = this.getTopicSummary(topicId);
    const recentMessages = this.getRecentMessages(topicId, recentLimit);
    const meta = this.getTopicMeta(topicId);

    return {
      summary: summary?.summary ?? null,
      purpose: summary?.purpose ?? null,
      recentMessages,
      totalMessages: meta?.messageCount ?? 0,
      topicName: meta?.topicName ?? null,
    };
  }

  /**
   * Get message count for a topic.
   */
  getMessageCount(topicId: number): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE topic_id = ?').get(topicId) as any;
    return row?.count ?? 0;
  }

  /**
   * How far a layer stamped at `messageId` is behind the topic: the messages
   * (and the operator-typed ones among them) stored after that row, in
   * storage order. `null` when the stamp's row is not in this database (the
   * freshness is then unknown, never "fresh").
   * context-budget-layered-summaries §6: "as of <time>, <n> messages behind".
   */
  countMessagesAfter(topicId: number, messageId: number): { total: number; fromUser: number } | null {
    if (!this.db) return null;
    const at = this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE topic_id = ? AND message_id = ?').get(topicId, messageId) as { id: number | null } | undefined;
    if (!at || at.id === null || at.id === undefined) return null;
    const row = this.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN from_user = 1 THEN 1 ELSE 0 END), 0) AS fromUser FROM messages WHERE topic_id = ? AND id > ?').get(topicId, at.id) as { total: number; fromUser: number };
    return { total: row?.total ?? 0, fromUser: row?.fromUser ?? 0 };
  }

  /**
   * The sender rows the protected user corpus is built from
   * (context-budget-layered-summaries §8: U is sourced by SENDER ROW, never by
   * transcript role). Every `from_user=1` row plus every row that arrived
   * through another agent (`origin` set), in insertion order, after the
   * given SQLite row id. `complete:false` means the hard bound was hit and
   * the caller must read again from the last `rowId` it got. `messageId`
   * reads only that message's row (the current turn's, listed ahead of a
   * backfill). `maxRowId` is the topic's highest row id, so a caller can tell
   * a rebuilt database (its watermark above every row).
   */
  getUserCorpusRows(topicId: number, opts: { afterRowId?: number; limit?: number; messageId?: number } = {}): { rows: Array<{ rowId: number; message: TopicMessage }>; complete: boolean; maxRowId: number } {
    if (!this.db) return { rows: [], complete: false, maxRowId: 0 };
    const bounded = Math.max(1, Math.min(Math.floor(opts.limit ?? 2_000), 10_000));
    const maxRowId = Number((this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE topic_id = ?').get(topicId) as { id: number } | undefined)?.id ?? 0);
    const byMessage = opts.messageId !== undefined && Number.isSafeInteger(opts.messageId);
    const raw = this.db.prepare(`
      SELECT id AS rowId, message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope, forwarded,
             channel_message_id AS channelMessageId, origin
      FROM messages
      WHERE topic_id = ? AND id > ? AND (from_user = 1 OR origin IS NOT NULL)${byMessage ? ' AND message_id = ?' : ''}
      ORDER BY id ASC
      LIMIT ?
    `).all(...[topicId, byMessage ? 0 : (opts.afterRowId ?? 0), ...(byMessage ? [opts.messageId] : []), bounded + 1]) as Array<Record<string, unknown>>;
    const rows = raw.slice(0, bounded).map((r) => {
      const { rowId, ...rest } = r;
      return { rowId: Number(rowId), message: mapRow(rest) };
    });
    return { rows, complete: raw.length <= bounded, maxRowId };
  }

  /**
   * True when `earlierMessageId` names a row of this topic inserted before the
   * row `laterMessageId` names; null when either row is not in TopicMemory
   * (the referent-stub validator reads null as "does not name a preceding message").
   */
  messagePrecedes(topicId: number, earlierMessageId: number, laterMessageId: number): boolean | null {
    if (!this.db) return null;
    const q = this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE topic_id = ? AND message_id = ?');
    const a = (q.get(topicId, earlierMessageId) as { id: number | null } | undefined)?.id;
    const b = (q.get(topicId, laterMessageId) as { id: number | null } | undefined)?.id;
    if (a === null || a === undefined || b === null || b === undefined) return null;
    return a < b;
  }

  /**
   * The agent's own messages immediately preceding a row, oldest first
   * (the referent candidates a stub may name). Empty when the row is unknown.
   */
  getAgentMessagesBefore(topicId: number, messageId: number, limit: number = 3): TopicMessage[] {
    if (!this.db) return [];
    const at = this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE topic_id = ? AND message_id = ?').get(topicId, messageId) as { id: number | null } | undefined;
    if (!at || at.id === null || at.id === undefined) return [];
    const bounded = Math.max(1, Math.min(Math.floor(limit), 20));
    return (this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope, forwarded,
             channel_message_id AS channelMessageId, origin
      FROM messages
      WHERE topic_id = ? AND id < ? AND from_user = 0 AND origin IS NULL
      ORDER BY id DESC
      LIMIT ?
    `).all(topicId, at.id, bounded) as unknown[]).reverse().map(mapRow);
  }

  /**
   * Get all messages by a specific user across all topics.
   * Used by /mydata export (GDPR Article 15).
   */
  getMessagesByUser(userId: string): TopicMessage[] {
    if (!this.db) return [];

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope, forwarded,
             channel_message_id AS channelMessageId, origin
      FROM messages
      WHERE user_id = ?
      ORDER BY timestamp ASC
    `).all(userId).map(mapRow) as TopicMessage[];
  }

  /**
   * Delete all messages by a specific user.
   * Used by /forget erasure (GDPR Article 17).
   * Returns the number of messages deleted.
   */
  deleteMessagesByUser(userId: string): number {
    if (!this.db) return 0;

    const result = this.db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
    this.rebuildTopicMeta();
    return result.changes;
  }

  // ── Search ──────────────────────────────────────────────────

  /**
   * Full-text search across topic messages.
   * Optionally scoped to a single topic.
   */
  search(query: string, opts?: { topicId?: number; limit?: number }): TopicSearchResult[] {
    if (!this.db) return [];

    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const limit = Math.min(opts?.limit ?? 20, 100);

    let sql: string;
    let params: any[];

    if (opts?.topicId !== undefined) {
      sql = `
        SELECT m.message_id AS messageId, m.topic_id AS topicId, m.text, m.from_user AS fromUser,
               m.timestamp, rank,
               highlight(messages_fts, 0, '<b>', '</b>') AS highlight
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
          AND m.topic_id = ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [sanitized, opts.topicId, limit];
    } else {
      sql = `
        SELECT m.message_id AS messageId, m.topic_id AS topicId, m.text, m.from_user AS fromUser,
               m.timestamp, rank,
               highlight(messages_fts, 0, '<b>', '</b>') AS highlight
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [sanitized, limit];
    }

    return this.db.prepare(sql).all(...params).map((row: any) => ({
      ...row,
      fromUser: !!row.fromUser,
    })) as TopicSearchResult[];
  }

  // ── Summaries ───────────────────────────────────────────────

  /**
   * Get the rolling summary for a topic.
   */
  getTopicSummary(topicId: number): TopicSummary | null {
    if (!this.db) return null;

    const row = this.db.prepare(`
      SELECT topic_id AS topicId, summary, purpose,
             message_count_at_summary AS messageCountAtSummary,
             last_message_id AS lastMessageId, updated_at AS updatedAt
      FROM topic_summaries
      WHERE topic_id = ?
    `).get(topicId) as TopicSummary | undefined;

    return row ?? null;
  }

  /**
   * Save or update a rolling summary for a topic.
   */
  saveTopicSummary(topicId: number, summary: string, messageCount: number, lastMessageId: number, purpose?: string | null): void {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO topic_summaries (topic_id, summary, purpose, message_count_at_summary, last_message_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        summary = excluded.summary,
        purpose = excluded.purpose,
        message_count_at_summary = excluded.message_count_at_summary,
        last_message_id = excluded.last_message_id,
        updated_at = excluded.updated_at
    `).run(topicId, summary, purpose ?? null, messageCount, lastMessageId, new Date().toISOString());
  }

  /**
   * Get messages since the last summary for a topic.
   * Used to generate incremental summary updates.
   */
  getMessagesSinceSummary(topicId: number): TopicMessage[] {
    if (!this.db) return [];

    const summary = this.getTopicSummary(topicId);
    const lastMessageId = summary?.lastMessageId ?? -1;

    return this.db.prepare(`
      SELECT message_id AS messageId, topic_id AS topicId, text, from_user AS fromUser,
             timestamp, session_name AS sessionName,
             sender_name AS senderName, sender_username AS senderUsername, telegram_user_id AS telegramUserId,
             user_id AS userId, privacy_scope AS privacyScope, forwarded,
             channel_message_id AS channelMessageId, origin
      FROM messages
      WHERE topic_id = ? AND message_id > ?
      ORDER BY timestamp ASC
    `).all(topicId, lastMessageId).map(mapRow) as TopicMessage[];
  }

  /**
   * Check if a topic needs its summary updated.
   * Returns true if there are more than `threshold` new messages since the last summary.
   */
  needsSummaryUpdate(topicId: number, threshold: number = 20): boolean {
    if (!this.db) return false;

    const summary = this.getTopicSummary(topicId);
    const totalMessages = this.getMessageCount(topicId);

    if (!summary) {
      // No summary yet — need one if there are enough messages
      return totalMessages >= threshold;
    }

    return (totalMessages - summary.messageCountAtSummary) >= threshold;
  }

  // ── Topic Metadata ──────────────────────────────────────────

  /**
   * Get metadata for a topic.
   */
  getTopicMeta(topicId: number): TopicMeta | null {
    if (!this.db) return null;

    const row = this.db.prepare(`
      SELECT topic_id AS topicId, topic_name AS topicName, message_count AS messageCount,
             last_activity AS lastActivity
      FROM topic_meta
      WHERE topic_id = ?
    `).get(topicId) as any;

    if (!row) return null;

    const hasSummary = !!this.db.prepare('SELECT 1 FROM topic_summaries WHERE topic_id = ?').get(topicId);
    return { ...row, hasSummary };
  }

  /**
   * Update topic name in metadata.
   */
  setTopicName(topicId: number, name: string): void {
    if (!this.db) return;

    this.db.prepare(`
      INSERT INTO topic_meta (topic_id, topic_name, message_count, last_activity)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(topic_id) DO UPDATE SET topic_name = excluded.topic_name
    `).run(topicId, name, new Date().toISOString());
  }

  /**
   * List all topics with metadata.
   */
  listTopics(): TopicMeta[] {
    if (!this.db) return [];

    const rows = this.db.prepare(`
      SELECT tm.topic_id AS topicId, tm.topic_name AS topicName,
             tm.message_count AS messageCount, tm.last_activity AS lastActivity,
             CASE WHEN ts.topic_id IS NOT NULL THEN 1 ELSE 0 END AS hasSummary
      FROM topic_meta tm
      LEFT JOIN topic_summaries ts ON ts.topic_id = tm.topic_id
      ORDER BY tm.last_activity DESC
    `).all() as any[];

    return rows.map(r => ({ ...r, hasSummary: !!r.hasSummary }));
  }

  // ── Import / Rebuild ────────────────────────────────────────

  /**
   * Import messages from the JSONL log file using streaming reads.
   * Idempotent — only inserts messages not already in the database.
   * Returns the number of new messages imported.
   *
   * Uses readline.createInterface on a read stream instead of
   * fs.readFileSync to avoid OOM on large JSONL files (100K+ messages).
   */
  async importFromJsonl(jsonlPath: string): Promise<number> {
    if (!this.db) return 0;
    if (!fs.existsSync(jsonlPath)) return 0;

    const db = this.db;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO messages (message_id, topic_id, text, from_user, timestamp, session_name, sender_name, sender_username, telegram_user_id, user_id, privacy_scope, forwarded, channel_message_id, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    let malformed = 0;
    let missingFields = 0;
    const BATCH_SIZE = 500;
    let batch: TopicMessage[] = [];

    const flushBatch = () => {
      if (batch.length === 0) return;
      const tx = db.transaction(() => {
        for (const msg of batch) {
          const result = insert.run(
            msg.messageId, msg.topicId, msg.text, msg.fromUser ? 1 : 0,
            msg.timestamp, msg.sessionName,
            msg.senderName ?? null, msg.senderUsername ?? null, msg.telegramUserId ?? null,
            msg.userId ?? null, msg.privacyScope ?? 'private',
            msg.forwarded == null ? null : (msg.forwarded ? 1 : 0),
            msg.channelMessageId ?? null, msg.origin ?? null,
          );
          if (result.changes > 0) count++;
        }
      });
      tx();
      batch = [];
    };

    const rl = readline.createInterface({
      input: fs.createReadStream(jsonlPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.topicId != null && entry.text) {
          batch.push({
            messageId: entry.messageId,
            topicId: entry.topicId,
            text: entry.text,
            fromUser: entry.fromUser ?? false,
            timestamp: entry.timestamp,
            sessionName: entry.sessionName ?? null,
            senderName: entry.senderName ?? undefined,
            senderUsername: entry.senderUsername ?? undefined,
            telegramUserId: entry.telegramUserId ?? undefined,
            userId: entry.userId ?? undefined,
            privacyScope: entry.privacyScope ?? undefined,
            forwarded: entry.forwarded == null ? undefined : entry.forwarded === true,
            origin: coerceTopicRowOrigin(entry.rowOrigin),
          });
          if (batch.length >= BATCH_SIZE) {
            flushBatch();
          }
        } else {
          // Valid JSON but missing the fields we need — count separately from malformed JSON.
          missingFields++;
        }
      } catch {
        // @silent-fallback-ok — JSONL parse error; count so we can surface it at end.
        malformed++;
      }
    }

    // Flush remaining
    flushBatch();

    // Rebuild topic_meta from messages after import
    this.rebuildTopicMeta();

    // Surface parse / schema problems at end of import so operators can
    // diagnose corrupted JSONL without tailing logs during the hot path.
    if (malformed > 0 || missingFields > 0) {
      console.warn(
        `[TopicMemory] importFromJsonl(${jsonlPath}): imported=${count} malformed_json=${malformed} missing_fields=${missingFields}`,
      );
    }

    this._lastImportStats = { imported: count, malformed, missingFields };
    return count;
  }

  /**
   * Returns stats from the most recent importFromJsonl() / rebuild() call.
   * Useful for tests and /topic/rebuild endpoints that want to surface
   * parse-error counts in the API response.
   */
  getLastImportStats(): { imported: number; malformed: number; missingFields: number } | null {
    return this._lastImportStats;
  }

  /**
   * Full rebuild — drop all data and reimport from JSONL.
   */
  async rebuild(jsonlPath: string): Promise<number> {
    if (!this.db) return 0;

    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM topic_meta');
    // Keep summaries — they're LLM-generated and expensive to recreate
    this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);

    return this.importFromJsonl(jsonlPath);
  }

  /**
   * Rebuild topic_meta counts from messages table.
   */
  private rebuildTopicMeta(): void {
    if (!this.db) return;

    this.db.exec(`
      INSERT OR REPLACE INTO topic_meta (topic_id, topic_name, message_count, last_activity)
      SELECT
        topic_id,
        (SELECT topic_name FROM topic_meta WHERE topic_id = m.topic_id),
        COUNT(*),
        MAX(timestamp)
      FROM messages m
      GROUP BY topic_id
    `);
  }

  // ── Stats ───────────────────────────────────────────────────

  /**
   * Get database statistics.
   */
  stats(): {
    totalMessages: number;
    totalTopics: number;
    topicsWithSummaries: number;
    dbSizeBytes: number;
  } {
    if (!this.db) return { totalMessages: 0, totalTopics: 0, topicsWithSummaries: 0, dbSizeBytes: 0 };

    const msgCount = (this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as any)?.c ?? 0;
    const topicCount = (this.db.prepare('SELECT COUNT(*) AS c FROM topic_meta').get() as any)?.c ?? 0;
    const summaryCount = (this.db.prepare('SELECT COUNT(*) AS c FROM topic_summaries').get() as any)?.c ?? 0;

    let dbSize = 0;
    try {
      dbSize = fs.statSync(this.dbPath).size;
    } catch { /* @silent-fallback-ok — stat returns 0, non-critical */ }

    return {
      totalMessages: msgCount,
      totalTopics: topicCount,
      topicsWithSummaries: summaryCount,
      dbSizeBytes: dbSize,
    };
  }

  /**
   * Format topic context as readable text for session injection, filtered by user.
   * Returns only messages the specified user is allowed to see.
   *
   * Phase 2B — User-Agent Topology Spec, Gap 9
   */
  formatContextForUser(topicId: number, userId: string, recentLimit: number = 30): string {
    if (!this.db) return '';

    const recentMessages = this.getRecentMessagesForUser(topicId, userId, recentLimit);
    const summary = this.getTopicSummary(topicId);
    const meta = this.getTopicMeta(topicId);

    if (recentMessages.length === 0 && !summary) return '';

    const totalMessages = meta?.messageCount ?? 0;
    const topicName = meta?.topicName ?? null;

    const lines: string[] = [];
    lines.push(`--- TOPIC CONTEXT (${totalMessages} total messages) ---`);

    if (topicName) {
      lines.push(`Topic: ${topicName}`);
    }

    if (summary?.purpose) {
      lines.push(`Current focus: ${summary.purpose}`);
    }

    if (summary) {
      lines.push('');
      lines.push('CONVERSATION SUMMARY:');
      lines.push(summary.summary);
    }

    if (recentMessages.length > 0) {
      lines.push('');
      lines.push(`RECENT MESSAGES (last ${recentMessages.length}${summary ? ', since last summary' : ''}):`);
      lines.push('');
      for (const m of recentMessages) {
        const sender = m.fromUser
          ? (m.senderName || 'User')
          : 'Agent';
        const ts = formatLocalTimestamp(m.timestamp); // local + tz label (see src/utils/localTime.ts)
        const text = (m.text || '').slice(0, 2000);
        lines.push(`[${ts}] ${sender}: ${text}`);
      }
    }

    lines.push('');
    lines.push('--- END TOPIC CONTEXT ---');
    return lines.join('\n');
  }

  /**
   * Format topic context as readable text for session injection.
   * This is the primary interface for loading topic context into a session.
   */
  formatContextForSession(topicId: number, recentLimit: number = 50): string {
    // Return empty string when db is not open — callers use this as a falsy check
    // to trigger JSONL fallback. A non-empty string from a broken db would
    // prevent the fallback and leave the session without conversation history.
    if (!this.db) return '';

    const ctx = this.getTopicContext(topicId, recentLimit);

    // Also return empty if the db is open but has no data for this topic —
    // the JSONL might have messages that weren't imported yet.
    if (ctx.recentMessages.length === 0 && !ctx.summary) return '';

    const lines: string[] = [];

    lines.push(`--- TOPIC CONTEXT (${ctx.totalMessages} total messages) ---`);

    if (ctx.topicName) {
      lines.push(`Topic: ${ctx.topicName}`);
    }

    if (ctx.purpose) {
      lines.push(`Current focus: ${ctx.purpose}`);
    }

    if (ctx.summary) {
      lines.push('');
      lines.push('CONVERSATION SUMMARY:');
      lines.push(ctx.summary);
    }

    if (ctx.recentMessages.length > 0) {
      lines.push('');
      lines.push(`RECENT MESSAGES (last ${ctx.recentMessages.length}${ctx.summary ? ', since last summary' : ''}):`);
      lines.push('');
      for (const m of ctx.recentMessages) {
        // Use sender name when available, fall back to generic "User"
        const sender = m.fromUser
          ? (m.senderName || 'User')
          : 'Agent';
        const ts = formatLocalTimestamp(m.timestamp); // local + tz label (see src/utils/localTime.ts)
        const text = (m.text || '').slice(0, 2000);
        lines.push(`[${ts}] ${sender}: ${text}`);
      }
    }

    lines.push('');
    lines.push('To search conversation history: curl http://localhost:PORT/topic/search?topic=TOPIC_ID&q=QUERY');
    lines.push('--- END TOPIC CONTEXT ---');

    return lines.join('\n');
  }
}
