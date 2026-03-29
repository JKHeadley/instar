/**
 * CallbackRegistry — Server-side context storage for Telegram inline keyboard callbacks.
 *
 * Telegram limits callback_data to 64 bytes. We store full prompt context server-side
 * keyed by short CSPRNG tokens. Only the token goes in callback_data.
 *
 * Tokens are one-time use: resolve() returns context and deletes the entry.
 * Entries are pruned on a 60-second interval and on server startup.
 */
export interface CallbackContext {
    sessionName: string;
    promptId: string;
    key: string;
    createdAt: number;
}
export interface CallbackRegistryConfig {
    /** Maximum entries before forced pruning (default: 500) */
    maxEntries: number;
    /** Maximum age in ms before auto-pruning (default: 300_000 = 5 min) */
    maxAgeMs: number;
    /** Pruning interval in ms (default: 60_000 = 1 min) */
    pruneIntervalMs: number;
}
export declare function isAllowedButtonKey(key: string): boolean;
export declare class CallbackRegistry {
    private config;
    private registry;
    private pruneTimer;
    constructor(config?: CallbackRegistryConfig);
    /**
     * Start periodic pruning. Call on server startup.
     */
    start(): void;
    /**
     * Stop periodic pruning. Call on server shutdown.
     */
    stop(): void;
    /**
     * Register a callback context and return a short token.
     * The token is safe for Telegram's callback_data (well under 64 bytes).
     */
    register(context: Omit<CallbackContext, 'createdAt'>): string;
    /**
     * Resolve a token to its context. One-time use: the entry is deleted.
     * Returns null for unknown or expired tokens.
     */
    resolve(token: string): CallbackContext | null;
    /**
     * Peek at a token without consuming it.
     * Used for validation checks before resolving.
     */
    peek(token: string): CallbackContext | null;
    /**
     * Remove all entries older than maxAgeMs.
     */
    prune(): number;
    /**
     * Remove all entries for a specific session.
     * Called when a session ends to clean up stale buttons.
     */
    removeForSession(sessionName: string): number;
    /**
     * Current number of registered callbacks.
     */
    get size(): number;
}
//# sourceMappingURL=CallbackRegistry.d.ts.map