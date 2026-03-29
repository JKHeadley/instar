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
import type { IMessageIncoming, IMessageChat, ConnectionState } from './types.js';
export interface NativeBackendOptions {
    /** Path to chat.db (default: ~/Library/Messages/chat.db) */
    dbPath?: string;
    /** Poll interval for new messages in ms (default: 2000) */
    pollIntervalMs?: number;
    /** Include attachment metadata (default: true) */
    includeAttachments?: boolean;
}
export declare class NativeBackend extends EventEmitter {
    private db;
    private pollTimer;
    private lastRowId;
    private _state;
    private readonly dbPath;
    private readonly pollIntervalMs;
    private readonly includeAttachments;
    private stmtNewMessages;
    private stmtChats;
    private stmtHistory;
    private stmtMaxRowId;
    private stmtContextHistory;
    constructor(options?: NativeBackendOptions);
    get state(): ConnectionState;
    /**
     * Open the Messages database and start polling for new messages.
     */
    connect(): Promise<void>;
    /**
     * Stop polling and close the database.
     */
    disconnect(): Promise<void>;
    /**
     * List recent chats.
     */
    listChats(limit?: number): IMessageChat[];
    /**
     * Get message history for a chat.
     */
    getChatHistory(chatId: string, limit?: number): IMessageIncoming[];
    /**
     * Format conversation context for session bootstrap.
     * Returns a formatted string of recent messages suitable for injection
     * into a Claude Code session as conversation history.
     */
    getConversationContext(sender: string, limit?: number): string;
    private _startPolling;
    private _stopPolling;
    _poll(): void;
    private _setState;
    /** Convert Apple Cocoa nanosecond timestamp to Unix epoch seconds. */
    _cocoaToUnix(cocoaNanos: number): number;
    /** Convert Apple Cocoa nanosecond timestamp to ISO string. */
    private _cocoaToIso;
}
//# sourceMappingURL=NativeBackend.d.ts.map