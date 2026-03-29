/**
 * IMessageRpcClient — JSON-RPC client for the `imsg` CLI tool.
 *
 * Manages a child process running `imsg rpc` and communicates via
 * JSON-RPC 2.0 over stdin/stdout. Handles:
 * - Process lifecycle (spawn, restart, cleanup)
 * - Request/response matching with timeouts
 * - Notification (incoming message) event emission
 * - Line-buffered stdout parsing
 * - Reconnection with exponential backoff
 */
import { EventEmitter } from 'node:events';
import type { ConnectionState } from './types.js';
export interface RpcClientOptions {
    /** Path to the imsg CLI binary (default: 'imsg') */
    cliPath?: string;
    /** Path to the Messages database */
    dbPath?: string;
    /** Auto-reconnect on process exit (default: true) */
    autoReconnect?: boolean;
    /** Max reconnection attempts (default: 10) */
    maxReconnectAttempts?: number;
    /** Base delay in ms for exponential backoff (default: 1000) */
    reconnectBaseDelayMs?: number;
    /** Request timeout in ms (default: 15000) */
    requestTimeoutMs?: number;
}
export declare class IMessageRpcClient extends EventEmitter {
    private process;
    private readline;
    private pendingRequests;
    private nextId;
    private _state;
    private reconnectAttempts;
    private reconnectTimer;
    private intentionalStop;
    private readonly cliPath;
    private readonly dbPath;
    private readonly autoReconnect;
    private readonly maxReconnectAttempts;
    private readonly reconnectBaseDelayMs;
    private readonly requestTimeoutMs;
    constructor(options?: RpcClientOptions);
    /** Current connection state */
    get state(): ConnectionState;
    /** PID of the running imsg process, if any */
    get pid(): number | undefined;
    /**
     * Start the imsg rpc process and begin listening.
     * Resolves when the process is spawned (does not wait for first message).
     */
    connect(): Promise<void>;
    /**
     * Stop the imsg rpc process and clean up.
     */
    disconnect(): Promise<void>;
    /**
     * Send a JSON-RPC request and wait for the response.
     * @throws Error on timeout, process not running, or RPC error response.
     */
    request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    private _setState;
    private _spawn;
    private _handleLine;
    private _handleResponse;
    private _handleNotification;
    private _cleanup;
    private _kill;
    private _rejectAllPending;
    private _scheduleReconnect;
    private _clearReconnectTimer;
}
//# sourceMappingURL=IMessageRpcClient.d.ts.map