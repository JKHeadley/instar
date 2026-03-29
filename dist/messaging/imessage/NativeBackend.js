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
import path from 'node:path';
import os from 'node:os';
// Apple Cocoa epoch: 2001-01-01T00:00:00Z in Unix epoch seconds
const APPLE_EPOCH_OFFSET = 978307200;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
export class NativeBackend extends EventEmitter {
    db = null;
    pollTimer = null;
    lastRowId = 0;
    _state = 'disconnected';
    dbPath;
    pollIntervalMs;
    includeAttachments;
    // Prepared statements (cached for performance)
    stmtNewMessages = null;
    stmtChats = null;
    stmtHistory = null;
    stmtMaxRowId = null;
    stmtContextHistory = null;
    constructor(options = {}) {
        super();
        this.dbPath = options.dbPath || DEFAULT_DB_PATH;
        this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.includeAttachments = options.includeAttachments ?? true;
    }
    get state() {
        return this._state;
    }
    /**
     * Open the Messages database and start polling for new messages.
     */
    async connect() {
        if (this._state === 'connected')
            return;
        this._setState('connecting');
        try {
            const Database = (await import('better-sqlite3')).default;
            // Open without readonly flag — readonly mode cannot read the WAL (write-ahead log).
            // Messages.app writes to WAL continuously; new messages only appear in WAL until
            // a checkpoint flushes them to the main db file. query_only pragma prevents writes
            // while still allowing WAL reads.
            this.db = new Database(this.dbPath, { fileMustExist: true });
            this.db.pragma('query_only = ON');
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
            // Start from a lookback window so recent messages are processed on startup.
            // Without this, messages that arrived while the server was down are silently
            // skipped — the adapter only sees messages with ROWID > lastRowId.
            // A 50-message lookback ensures we catch anything from the last few hours.
            const maxRow = this.stmtMaxRowId.get();
            const maxId = maxRow?.max_id ?? 0;
            this.lastRowId = Math.max(0, maxId - 50);
            this._setState('connected');
            this._startPolling();
        }
        catch (err) {
            this._setState('error');
            throw new Error(`Failed to open Messages database: ${err.message}`);
        }
    }
    /**
     * Stop polling and close the database.
     */
    async disconnect() {
        this._stopPolling();
        if (this.db) {
            try {
                this.db.close();
            }
            catch { /* already closed */ }
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
    listChats(limit = 20) {
        if (!this.db || !this.stmtChats) {
            throw new Error('Database not connected');
        }
        const rows = this.stmtChats.all(limit);
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
    getChatHistory(chatId, limit = 50) {
        if (!this.db || !this.stmtHistory) {
            throw new Error('Database not connected');
        }
        const rows = this.stmtHistory.all(chatId, limit);
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
    getConversationContext(sender, limit = 20) {
        if (!this.db || !this.stmtContextHistory) {
            return '';
        }
        try {
            const rows = this.stmtContextHistory.all(sender, sender, limit);
            if (rows.length === 0)
                return '';
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
        }
        catch {
            return '';
        }
    }
    // ── Internal ──
    _startPolling() {
        if (this.pollTimer)
            return;
        this.pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
    }
    _stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
    _poll() {
        if (!this.db || !this.stmtNewMessages)
            return;
        try {
            const rows = this.stmtNewMessages.all(this.lastRowId);
            for (const row of rows) {
                this.lastRowId = row.ROWID;
                // Skip non-text messages (reactions, edits, etc.)
                if (row.associated_message_type !== 0)
                    continue;
                // Skip empty messages (typing indicators, read receipts)
                if (!row.text && !this.includeAttachments)
                    continue;
                const msg = {
                    chatId: row.chat_id || row.sender || 'unknown',
                    messageId: row.guid,
                    sender: row.sender || 'unknown',
                    senderName: row.chat_name || undefined,
                    text: row.text || '',
                    timestamp: this._cocoaToUnix(row.date),
                    isFromMe: row.is_from_me === 1,
                    service: row.service,
                };
                this.emit('message', msg);
            }
        }
        catch (err) {
            const msg = err.message;
            if (!msg.includes('SQLITE_BUSY') && !msg.includes('database is locked')) {
                console.error(`[imessage-native] Poll error: ${msg}`);
            }
        }
    }
    _setState(state) {
        const prev = this._state;
        this._state = state;
        if (prev !== state) {
            this.emit('stateChange', state, prev);
        }
    }
    /** Convert Apple Cocoa nanosecond timestamp to Unix epoch seconds. */
    _cocoaToUnix(cocoaNanos) {
        return Math.floor(cocoaNanos / 1e9) + APPLE_EPOCH_OFFSET;
    }
    /** Convert Apple Cocoa nanosecond timestamp to ISO string. */
    _cocoaToIso(cocoaNanos) {
        return new Date(this._cocoaToUnix(cocoaNanos) * 1000).toISOString();
    }
}
//# sourceMappingURL=NativeBackend.js.map