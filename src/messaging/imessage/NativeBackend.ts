/**
 * NativeBackend — Read-only macOS Messages database integration.
 *
 * Provides:
 * - SQLite reads from ~/Library/Messages/chat.db (via better-sqlite3)
 * - Polling for new messages (watches max ROWID)
 * - Conversation context formatting for session bootstrap
 *
 * Does NOT send messages. Sending happens from Claude Code sessions
 * via imessage-reply.sh → imsg send CLI, because AppleScript Automation
 * permission doesn't propagate through LaunchAgent process trees.
 *
 * Requires:
 * - Full Disk Access for the process reading chat.db
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { IMessageIncoming, IMessageChat, ConnectionState } from './types.js';

// Apple Cocoa epoch: 2001-01-01T00:00:00Z in Unix epoch seconds
const APPLE_EPOCH_OFFSET = 978307200;

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

export interface NativeBackendOptions {
  /** Path to chat.db (default: ~/Library/Messages/chat.db) */
  dbPath?: string;
  /** Poll interval for new messages in ms (default: 2000) */
  pollIntervalMs?: number;
  /** Include attachment metadata (default: true) */
  includeAttachments?: boolean;
  /** Path to persist poll offset (lastRowId) across restarts */
  offsetPath?: string;
  /** Authorized contacts (normalized E.164) — scopes SQL queries for defense-in-depth */
  authorizedContacts?: string[];
  /**
   * Directory to hardlink incoming attachments into. iMessage stores files
   * in ~/Library/Messages/Attachments/ which is TCC-protected; hardlinking
   * to a non-protected location makes photos/documents readable by the
   * daemon without Full Disk Access on node. If unset, attachment paths
   * stay pointed at the original TCC-protected location.
   */
  attachmentsDir?: string;
}

export class NativeBackend extends EventEmitter {
  private db: import('better-sqlite3').Database | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;
  private _state: ConnectionState = 'disconnected';
  private readonly dbPath: string;
  private readonly pollIntervalMs: number;
  private readonly includeAttachments: boolean;
  private readonly offsetPath: string | null;
  private readonly authorizedContacts: string[];
  private readonly attachmentsDir: string | null;

  // Prepared statements (cached for performance)
  private stmtNewMessages: import('better-sqlite3').Statement | null = null;
  private stmtChats: import('better-sqlite3').Statement | null = null;
  private stmtHistory: import('better-sqlite3').Statement | null = null;
  private stmtMaxRowId: import('better-sqlite3').Statement | null = null;
  private stmtContextHistory: import('better-sqlite3').Statement | null = null;
  private stmtAttachments: import('better-sqlite3').Statement | null = null;

  constructor(options: NativeBackendOptions = {}) {
    super();
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.includeAttachments = options.includeAttachments ?? true;
    this.offsetPath = options.offsetPath ?? null;
    this.authorizedContacts = options.authorizedContacts ?? [];
    this.attachmentsDir = options.attachmentsDir ?? null;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Open the Messages database and start polling for new messages.
   */
  async connect(): Promise<void> {
    if (this._state === 'connected') return;
    this._setState('connecting');

    try {
      const Database = (await import('better-sqlite3')).default;

      // Open without readonly flag — readonly mode cannot read the WAL (write-ahead log).
      // Messages.app writes to WAL continuously; new messages only appear in WAL until
      // a checkpoint flushes them to the main db file. query_only pragma prevents writes
      // while still allowing WAL reads.
      this.db = new Database(this.dbPath, { fileMustExist: true });
      this.db.pragma('query_only = ON');

      // Scope poll query to authorized contacts for defense-in-depth.
      // Even if the adapter's auth check is bypassed, the SQL itself won't return
      // unauthorized messages. Falls back to unscoped if no contacts configured.
      if (this.authorizedContacts.length > 0) {
        const placeholders = this.authorizedContacts.map(() => '?').join(', ');
        this.stmtNewMessages = this.db.prepare(`
          SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, m.service,
                 m.associated_message_type,
                 h.id AS sender,
                 c.chat_identifier AS chat_id, c.display_name AS chat_name
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
          LEFT JOIN chat c ON cmj.chat_id = c.ROWID
          WHERE m.ROWID > ?
            AND (m.is_from_me = 1 OR h.id IN (${placeholders}))
          ORDER BY m.ROWID ASC
        `);
      } else {
        this.stmtNewMessages = this.db.prepare(`
          SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, m.service,
                 m.associated_message_type,
                 h.id AS sender,
                 c.chat_identifier AS chat_id, c.display_name AS chat_name
          FROM message m
          LEFT JOIN handle h ON m.handle_id = h.ROWID
          LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
          LEFT JOIN chat c ON cmj.chat_id = c.ROWID
          WHERE m.ROWID > ?
          ORDER BY m.ROWID ASC
        `);
      }

      // Scope chat listing to authorized contacts
      if (this.authorizedContacts.length > 0) {
        const placeholders = this.authorizedContacts.map(() => '?').join(', ');
        this.stmtChats = this.db.prepare(`
          SELECT c.ROWID AS id, c.chat_identifier, c.display_name, c.service_name,
                 c.guid, c.is_archived,
                 (SELECT MAX(m.date) FROM message m
                  JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                  WHERE cmj.chat_id = c.ROWID) AS last_message_date
          FROM chat c
          WHERE c.chat_identifier IN (${placeholders})
          ORDER BY last_message_date DESC
          LIMIT ?
        `);
      } else {
        this.stmtChats = this.db.prepare(`
          SELECT c.ROWID AS id, c.chat_identifier, c.display_name, c.service_name,
                 c.guid, c.is_archived,
                 (SELECT MAX(m.date) FROM message m
                  JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
                  WHERE cmj.chat_id = c.ROWID) AS last_message_date
          FROM chat c
          ORDER BY last_message_date DESC
          LIMIT ?
        `);
      }

      this.stmtHistory = this.db.prepare(`
        SELECT m.ROWID, m.guid, m.text, m.date, m.is_from_me, m.service,
               h.id AS sender
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE c.chat_identifier = ?
        ORDER BY m.date DESC
        LIMIT ?
      `);

      // Context history query — filters by sender handle (phone/email)
      this.stmtContextHistory = this.db.prepare(`
        SELECT m.ROWID, m.text, m.date, m.is_from_me, h.id AS sender
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE (h.id = ? OR c.chat_identifier = ?)
          AND m.text IS NOT NULL
          AND m.associated_message_type = 0
        ORDER BY m.date DESC
        LIMIT ?
      `);

      this.stmtMaxRowId = this.db.prepare('SELECT MAX(ROWID) AS max_id FROM message');

      // Attachments for a given message ROWID
      this.stmtAttachments = this.db.prepare(`
        SELECT a.filename, a.mime_type, a.transfer_name, a.total_bytes
        FROM attachment a
        JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
        WHERE maj.message_id = ?
        ORDER BY a.ROWID ASC
      `);

      // Restore persisted poll offset if available; otherwise use a 50-message
      // lookback so messages received while the server was down are processed.
      const persistedOffset = this._loadOffset();
      if (persistedOffset !== null) {
        this.lastRowId = persistedOffset;
      } else {
        const maxRow = this.stmtMaxRowId.get() as { max_id: number } | undefined;
        const maxId = maxRow?.max_id ?? 0;
        this.lastRowId = Math.max(0, maxId - 50);
      }

      this._setState('connected');
      this._startPolling();
    } catch (err) {
      this._setState('error');
      throw new Error(`Failed to open Messages database: ${(err as Error).message}`);
    }
  }

  /**
   * Stop polling and close the database.
   */
  async disconnect(): Promise<void> {
    this._stopPolling();
    if (this.db) {
      try { this.db.close(); } catch { /* already closed */ }
      this.db = null;
    }
    this.stmtNewMessages = null;
    this.stmtChats = null;
    this.stmtHistory = null;
    this.stmtContextHistory = null;
    this.stmtMaxRowId = null;
    this._setState('disconnected');
  }

  /**
   * List recent chats.
   */
  listChats(limit = 20): IMessageChat[] {
    if (!this.db || !this.stmtChats) {
      throw new Error('Database not connected');
    }

    const chatBindParams = this.authorizedContacts.length > 0
      ? [...this.authorizedContacts, limit]
      : [limit];
    const rows = this.stmtChats.all(...chatBindParams) as Array<{
      id: number;
      chat_identifier: string;
      display_name: string | null;
      service_name: string;
      guid: string;
      is_archived: number;
      last_message_date: number | null;
    }>;

    return rows.map((row) => ({
      chatId: row.chat_identifier,
      displayName: row.display_name || undefined,
      participants: [row.chat_identifier],
      lastMessageDate: row.last_message_date
        ? this._cocoaToIso(row.last_message_date)
        : undefined,
      service: row.service_name,
    }));
  }

  /**
   * Get message history for a chat.
   */
  getChatHistory(chatId: string, limit = 50): IMessageIncoming[] {
    if (!this.db || !this.stmtHistory) {
      throw new Error('Database not connected');
    }

    // Defense-in-depth: only return history for authorized contacts
    if (this.authorizedContacts.length > 0 && !this.authorizedContacts.includes(chatId)) {
      return [];
    }

    const rows = this.stmtHistory.all(chatId, limit) as Array<{
      ROWID: number;
      guid: string;
      text: string | null;
      date: number;
      is_from_me: number;
      service: string;
      sender: string | null;
    }>;

    return rows.map((row) => ({
      chatId,
      messageId: row.guid,
      sender: row.sender || chatId,
      text: row.text || '',
      timestamp: this._cocoaToUnix(row.date),
      isFromMe: row.is_from_me === 1,
      service: row.service,
    }));
  }

  /**
   * Format conversation context for session bootstrap.
   * Returns a formatted string of recent messages suitable for injection
   * into a Claude Code session as conversation history.
   */
  getConversationContext(sender: string, limit = 20): string {
    if (!this.db || !this.stmtContextHistory) {
      return '';
    }

    try {
      const rows = this.stmtContextHistory.all(sender, sender, limit) as Array<{
        ROWID: number;
        text: string | null;
        date: number;
        is_from_me: number;
        sender: string | null;
      }>;

      if (rows.length === 0) return '';

      // Reverse to chronological order (query returns newest first)
      rows.reverse();

      const lines = rows.map((row) => {
        const time = new Date(this._cocoaToUnix(row.date) * 1000);
        const hh = time.getHours().toString().padStart(2, '0');
        const mm = time.getMinutes().toString().padStart(2, '0');
        const who = row.is_from_me ? 'Agent' : (row.sender || sender);
        const text = row.text || '(attachment)';
        return `[${hh}:${mm}] ${who}: ${text}`;
      });

      return `--- Conversation History (last ${rows.length} messages) ---\n${lines.join('\n')}\n--- End History ---`;
    } catch {
      return '';
    }
  }

  // ── Internal ──

  private _startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  private _stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _poll(): void {
    if (!this.db || !this.stmtNewMessages) return;

    try {
      // Pass authorized contacts as bind params when SQL is scoped
      const bindParams = this.authorizedContacts.length > 0
        ? [this.lastRowId, ...this.authorizedContacts]
        : [this.lastRowId];
      const rows = this.stmtNewMessages.all(...bindParams) as Array<{
        ROWID: number;
        guid: string;
        text: string | null;
        date: number;
        is_from_me: number;
        service: string;
        associated_message_type: number;
        sender: string | null;
        chat_id: string | null;
        chat_name: string | null;
      }>;

      const startRowId = this.lastRowId;
      for (const row of rows) {
        this.lastRowId = row.ROWID;

        // Skip non-text messages (reactions, edits, etc.)
        if (row.associated_message_type !== 0) continue;
        // Skip empty messages (typing indicators, read receipts)
        if (!row.text && !this.includeAttachments) continue;

        const msg: IMessageIncoming = {
          chatId: row.chat_id || row.sender || 'unknown',
          messageId: row.guid,
          sender: row.sender || 'unknown',
          senderName: row.chat_name || undefined,
          text: row.text || '',
          timestamp: this._cocoaToUnix(row.date),
          isFromMe: row.is_from_me === 1,
          service: row.service,
        };

        // Attachments: fetch from DB, hardlink each file into attachmentsDir so
        // the daemon can read them without FDA on ~/Library/Messages/Attachments.
        if (this.includeAttachments && this.stmtAttachments) {
          try {
            const attRows = this.stmtAttachments.all(row.ROWID) as Array<{
              filename: string | null;
              mime_type: string | null;
              transfer_name: string | null;
              total_bytes: number | null;
            }>;
            if (attRows.length > 0) {
              msg.attachments = attRows
                .filter(a => a.filename) // skip attachments without a file (stickers etc.)
                .map(a => {
                  const srcPath = this._expandPath(a.filename!);
                  const hardlinked = this._hardlinkAttachment(srcPath, row.guid, a.transfer_name);
                  return {
                    filename: a.transfer_name || path.basename(srcPath),
                    mimeType: a.mime_type || 'application/octet-stream',
                    path: hardlinked || srcPath, // fall back to original if hardlink fails
                    size: a.total_bytes || undefined,
                  };
                });
            }
          } catch (err) {
            console.warn(`[imessage-native] Attachment lookup failed for ROWID ${row.ROWID}: ${(err as Error).message}`);
          }
        }

        this.emit('message', msg);
      }
      // Persist offset if it advanced
      if (this.lastRowId > startRowId) {
        this._saveOffset(this.lastRowId);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes('SQLITE_BUSY') && !msg.includes('database is locked')) {
        console.error(`[imessage-native] Poll error: ${msg}`);
      }
    }
  }

  private _setState(state: ConnectionState): void {
    const prev = this._state;
    this._state = state;
    if (prev !== state) {
      this.emit('stateChange', state, prev);
    }
  }

  /** Convert Apple Cocoa nanosecond timestamp to Unix epoch seconds. */
  _cocoaToUnix(cocoaNanos: number): number {
    return Math.floor(cocoaNanos / 1e9) + APPLE_EPOCH_OFFSET;
  }

  /** Load persisted poll offset from disk. */
  private _loadOffset(): number | null {
    if (!this.offsetPath) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.offsetPath, 'utf-8'));
      if (typeof data.lastRowId === 'number' && data.lastRowId > 0) {
        return data.lastRowId;
      }
    } catch { /* first run or corrupted — use lookback */ }
    return null;
  }

  /** Save poll offset to disk. */
  private _saveOffset(rowId: number): void {
    if (!this.offsetPath) return;
    try {
      fs.writeFileSync(this.offsetPath, JSON.stringify({ lastRowId: rowId, savedAt: new Date().toISOString() }) + '\n');
    } catch { /* non-critical */ }
  }

  /** Convert Apple Cocoa nanosecond timestamp to ISO string. */
  private _cocoaToIso(cocoaNanos: number): string {
    return new Date(this._cocoaToUnix(cocoaNanos) * 1000).toISOString();
  }

  /** Expand a chat.db attachment path (may start with ~) to an absolute path. */
  private _expandPath(p: string): string {
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    if (p === '~') return os.homedir();
    return p;
  }

  /**
   * Hardlink an attachment file into the hardlink-safe attachments dir.
   * Returns the new path, or null if the hardlink couldn't be created.
   * Idempotent — if the target already exists pointing at the same inode,
   * it's reused.
   *
   * ~/Library/Messages/Attachments/ is TCC-protected on macOS. Daemon-spawned
   * processes without FDA can't read files there directly. A hardlink in a
   * non-protected directory shares the same inode — reads work without FDA.
   * The hardlink itself requires FDA to create, which happens on first-run
   * from a user session (or any time a new message arrives while a user-context
   * process is running the poll loop).
   */
  private _hardlinkAttachment(
    srcPath: string,
    messageGuid: string,
    transferName: string | null,
  ): string | null {
    if (!this.attachmentsDir) return null;
    if (!srcPath) return null;

    // First try: if an external watcher (like the fswatch-based LaunchAgent)
    // has already hardlinked the source file into attachmentsDir, find and
    // return THAT path. We match by inode — whatever naming scheme the
    // external watcher uses, the inode is identical to the source. This works
    // even when the daemon has no FDA on ~/Library/Messages/Attachments/,
    // because stat() on attachmentsDir is always allowed.
    try {
      if (fs.existsSync(this.attachmentsDir)) {
        // We need the source inode to match against. Try stat on src; if that
        // fails (EPERM), we fall back to matching by basename.
        let srcIno: number | null = null;
        try {
          srcIno = fs.statSync(srcPath).ino;
        } catch { /* no FDA, skip inode check */ }

        const entries = fs.readdirSync(this.attachmentsDir);
        const srcBase = path.basename(srcPath);
        for (const name of entries) {
          const candidate = path.join(this.attachmentsDir, name);
          try {
            const st = fs.statSync(candidate);
            if (srcIno !== null && st.ino === srcIno) {
              return candidate;  // perfect match by inode
            }
            if (srcIno === null && name.endsWith(`__${srcBase}`)) {
              // Heuristic: external watcher prefixes with a uuid fragment
              return candidate;
            }
          } catch { /* skip broken entries */ }
        }
      }
    } catch { /* continue to own-create attempt */ }

    // Fallback: try to create our own hardlink. Requires FDA on node.
    if (!fs.existsSync(srcPath)) return null;
    try {
      fs.mkdirSync(this.attachmentsDir, { recursive: true });
      const base = transferName
        ? path.basename(transferName)
        : path.basename(srcPath);
      const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '_');
      const target = path.join(
        this.attachmentsDir,
        `${messageGuid}__${safeBase}`,
      );

      if (fs.existsSync(target)) {
        try {
          const srcIno = fs.statSync(srcPath).ino;
          const tgtIno = fs.statSync(target).ino;
          if (srcIno === tgtIno) return target;
        } catch { /* fall through to recreate */ }
        try { fs.unlinkSync(target); } catch { /* best effort */ }
      }

      fs.linkSync(srcPath, target);
      return target;
    } catch (err) {
      const msg = (err as Error).message || '';
      // Silently swallow "operation not permitted" — daemon lacks FDA.
      // External watcher (LaunchAgent) should fill the gap.
      if (!msg.includes('EACCES') && !msg.includes('EPERM') && !msg.includes('not permitted')) {
        console.warn(`[imessage-native] Attachment hardlink failed: ${msg}`);
      }
      return null;
    }
  }
}
