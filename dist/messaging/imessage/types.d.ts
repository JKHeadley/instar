/**
 * iMessage adapter types — configuration, messages, and connection state.
 */
export interface IMessageConfig {
    /**
     * Path to the `imsg` CLI binary.
     * Defaults to 'imsg' (assumes it's in PATH).
     */
    cliPath?: string;
    /**
     * Path to the Messages database.
     * Defaults to ~/Library/Messages/chat.db
     */
    dbPath?: string;
    /**
     * Authorized sender identifiers (phone numbers or email addresses).
     * REQUIRED — fail-closed. Empty array = reject all messages.
     * Phone numbers should be in E.164 format (e.g., "+14081234567").
     */
    authorizedSenders: string[];
    /** Include attachment metadata in incoming messages (default: true) */
    includeAttachments?: boolean;
    /** Auto-reconnect the RPC process on crash (default: true) */
    autoReconnect?: boolean;
    /** Max reconnection attempts before giving up (default: 10) */
    maxReconnectAttempts?: number;
    /** Base delay in ms for exponential backoff reconnection (default: 1000) */
    reconnectBaseDelayMs?: number;
    /** Stall detection timeout in minutes (default: 5) */
    stallTimeoutMinutes?: number;
    /** Promise follow-through timeout in minutes (default: 10) */
    promiseTimeoutMinutes?: number;
    /** Message log retention in days (default: 90) */
    logRetentionDays?: number;
}
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
}
export interface IMessageIncoming {
    chatId: string;
    messageId: string;
    sender: string;
    senderName?: string;
    text: string;
    timestamp: number;
    isFromMe: boolean;
    attachments?: IMessageAttachment[];
    service?: string;
}
export interface IMessageAttachment {
    filename: string;
    mimeType: string;
    path: string;
    size?: number;
}
export interface IMessageChat {
    chatId: string;
    displayName?: string;
    participants: string[];
    lastMessageDate?: string;
    service?: string;
}
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export interface ConnectionInfo {
    state: ConnectionState;
    connectedAt?: string;
    lastError?: string;
    reconnectAttempts: number;
    pid?: number;
}
//# sourceMappingURL=types.d.ts.map