/**
 * Nonce store for replay prevention.
 *
 * Triple-layer anti-replay:
 * 1. Timestamp: 30-second window
 * 2. Nonce: unique per request, persisted to disk
 * 3. Sequence number: monotonic per peer
 *
 * Nonces are pruned continuously (every 5 minutes) and on startup.
 *
 * Part of Phase 4 (secret sync infrastructure).
 */
export interface NonceStoreConfig {
    /** Timestamp window for freshness validation (default: 30s). */
    timestampWindowMs?: number;
    /** Max age for nonce retention before pruning (default: 60s). */
    nonceMaxAgeMs?: number;
    /** Interval between automatic prune runs (default: 5 min). */
    pruneIntervalMs?: number;
}
export declare class NonceStore {
    private stateDir;
    private nonces;
    private sequences;
    private pruneTimer;
    private initialized;
    private timestampWindowMs;
    private nonceMaxAgeMs;
    private pruneIntervalMs;
    constructor(stateDir: string, config?: NonceStoreConfig);
    /**
     * Initialize: load persisted nonces and prune old ones.
     * Must be called before use. Idempotent.
     */
    initialize(): void;
    /**
     * Stop the prune timer. Call on shutdown.
     */
    destroy(): void;
    /**
     * Validate a request's anti-replay fields.
     * Returns { valid: true } or { valid: false, reason }.
     *
     * @param timestamp - ISO string or epoch ms
     * @param nonce - Unique nonce for this request
     * @param sequence - Monotonic sequence number
     * @param peerId - The sending machine's ID
     */
    validate(timestamp: string | number, nonce: string, sequence: number, peerId: string): {
        valid: true;
    } | {
        valid: false;
        reason: string;
    };
    /**
     * Get the next sequence number to use when sending to a peer.
     * Returns the last seen + 1, or 0 if never communicated.
     */
    getNextSequence(peerId: string): number;
    /**
     * Get the current nonce count (for diagnostics).
     */
    get size(): number;
    /**
     * Prune expired nonces from memory and rewrite the file.
     */
    prune(): void;
    private get noncePath();
    private loadFromDisk;
    private persistNonce;
}
//# sourceMappingURL=NonceStore.d.ts.map