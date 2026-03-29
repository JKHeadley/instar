/**
 * Platform-agnostic JSONL message logger.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Handles append, rotation, search, topic history, and stats for any
 * messaging adapter that needs persistent message logging.
 */
export interface LogEntry {
    messageId: number | string;
    /** Channel identifier (topic ID for Telegram, chat JID for WhatsApp, etc.) */
    channelId: number | string | null;
    text: string;
    fromUser: boolean;
    timestamp: string;
    sessionName: string | null;
    senderName?: string;
    senderUsername?: string;
    /** Platform-specific user ID */
    platformUserId?: number | string;
    /** Platform name (telegram, whatsapp, etc.) */
    platform?: string;
}
/** Legacy Telegram-specific log entry shape for backward compatibility */
export interface TelegramLogEntry {
    messageId: number;
    topicId: number | null;
    text: string;
    fromUser: boolean;
    timestamp: string;
    sessionName: string | null;
    senderName?: string;
    senderUsername?: string;
    telegramUserId?: number;
}
export interface MessageLoggerConfig {
    /** Path to the JSONL log file */
    logPath: string;
    /** Maximum lines before rotation triggers (default: 100000) */
    maxLines?: number;
    /** Lines to keep after rotation (default: 75000) */
    keepLines?: number;
    /** File size threshold in bytes before checking line count (default: 20MB) */
    rotationSizeThreshold?: number;
}
/** Callback fired after every message is logged */
export type OnMessageLoggedCallback = (entry: LogEntry) => void;
export declare class MessageLogger {
    private logPath;
    private maxLines;
    private keepLines;
    private rotationSizeThreshold;
    private onMessageLogged;
    constructor(config: MessageLoggerConfig);
    /**
     * Set a callback that fires on every message logged (inbound and outbound).
     * Used by TopicMemory to dual-write to SQLite for search and summarization.
     */
    setOnMessageLogged(callback: OnMessageLoggedCallback | null): void;
    /**
     * Append a log entry to the JSONL file.
     */
    append(entry: LogEntry): void;
    /**
     * Search the message log with flexible filters.
     */
    search(opts?: {
        query?: string;
        channelId?: number | string;
        since?: Date;
        limit?: number;
    }): LogEntry[];
    /**
     * Get recent messages for a channel (for thread history on respawn).
     */
    getChannelHistory(channelId: number | string, limit?: number): LogEntry[];
    /**
     * Get recent log entries (most recent first).
     */
    getRecent(limit?: number): LogEntry[];
    /**
     * Get message log statistics.
     */
    getStats(): {
        totalMessages: number;
        logSizeBytes: number;
        logPath: string;
    };
    /**
     * Keep only the last N lines when log exceeds max.
     * High limits because message history is core agent memory.
     */
    private maybeRotate;
}
//# sourceMappingURL=MessageLogger.d.ts.map