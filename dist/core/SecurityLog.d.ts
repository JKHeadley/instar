/**
 * Security event log with hash-chain integrity.
 *
 * Append-only JSONL log where each entry includes a prevHash field
 * containing the SHA-256 hash of the previous entry. This makes
 * retroactive tampering detectable — altering any entry breaks
 * the chain for all subsequent entries.
 *
 * Part of Phase 1 (machine identity infrastructure).
 */
export type SecurityEventType = 'pairing_attempt' | 'pairing_success' | 'pairing_failure' | 'signature_verification_failure' | 'nonce_replay_detected' | 'machine_revoked' | 'role_transition' | 'lock_acquired' | 'lock_contention' | 'unauthorized_user_blocked' | 'secret_sync' | 'split_brain_detected' | 'auto_failover' | 'tiebreaker_promotion';
export interface SecurityEvent {
    timestamp: string;
    event: SecurityEventType;
    machineId: string;
    prevHash: string;
    /** Additional event-specific data */
    [key: string]: unknown;
}
export declare class SecurityLog {
    private logPath;
    private lastHash;
    private initialized;
    constructor(logsDir: string);
    /**
     * Initialize the log by reading the last entry's hash.
     * Must be called before appending. Idempotent.
     */
    initialize(): void;
    /**
     * Append a security event to the log.
     */
    append(eventData: Omit<SecurityEvent, 'timestamp' | 'prevHash'>): SecurityEvent;
    /**
     * Read all log entries.
     */
    readAll(): SecurityEvent[];
    /**
     * Verify the integrity of the hash chain.
     * Returns { valid: true } if the chain is intact, or
     * { valid: false, brokenAt: index } if tampering is detected.
     */
    verifyChain(): {
        valid: true;
    } | {
        valid: false;
        brokenAt: number;
    };
    /**
     * Get the number of entries in the log.
     */
    get length(): number;
    /**
     * Get the path to the log file.
     */
    get path(): string;
}
//# sourceMappingURL=SecurityLog.d.ts.map