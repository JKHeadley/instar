/**
 * AuditTrail — Tamper-evident logging for LLM merge operations.
 *
 * Logs:
 *   - Every LLM invocation (prompt hash, model, timestamp)
 *   - Resolution decisions (chosen side, confidence, file)
 *   - Validation results (post-merge checks)
 *   - Redaction events (count, types — never the values)
 *   - Security events (injection attempts, auth failures)
 *
 * Log entries are chained: each entry includes a hash of the previous
 * entry, creating a tamper-evident audit chain.
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.6 and Phase 6 requirements.
 */
export type AuditEventType = 'llm-invocation' | 'resolution' | 'validation' | 'redaction' | 'security' | 'handoff' | 'branch' | 'access-denied';
export interface AuditEntry {
    /** Unique entry ID. */
    id: string;
    /** Event type. */
    type: AuditEventType;
    /** ISO timestamp. */
    timestamp: string;
    /** Machine that generated this event. */
    machineId: string;
    /** User ID (if applicable). */
    userId?: string;
    /** Session ID. */
    sessionId?: string;
    /** Event-specific data. */
    data: Record<string, unknown>;
    /** SHA-256 hash of the previous entry (chain link). */
    previousHash: string;
    /** SHA-256 hash of this entry (for the next link). */
    entryHash: string;
}
export interface AuditQuery {
    /** Filter by event type. */
    type?: AuditEventType;
    /** Filter by machine. */
    machineId?: string;
    /** Filter by session. */
    sessionId?: string;
    /** Entries after this timestamp. */
    after?: string;
    /** Entries before this timestamp. */
    before?: string;
    /** Maximum entries to return. */
    limit?: number;
}
export interface AuditIntegrityResult {
    /** Whether the chain is intact. */
    intact: boolean;
    /** Total entries checked. */
    entriesChecked: number;
    /** First broken link (if any). */
    brokenAt?: number;
    /** Details about the break. */
    breakDetails?: string;
}
export interface AuditStats {
    /** Total entries. */
    totalEntries: number;
    /** Entries by type. */
    byType: Record<AuditEventType, number>;
    /** Entries by machine. */
    byMachine: Record<string, number>;
    /** Time range. */
    firstEntry?: string;
    lastEntry?: string;
}
export interface AuditTrailConfig {
    /** State directory (.instar). */
    stateDir: string;
    /** This machine's ID. */
    machineId: string;
    /** Maximum entries per file before rotation (default: 1000). */
    maxEntriesPerFile?: number;
}
export declare class AuditTrail {
    private stateDir;
    private machineId;
    private auditDir;
    private maxEntries;
    private lastHash;
    constructor(config: AuditTrailConfig);
    /**
     * Log an LLM invocation event.
     */
    logLLMInvocation(data: {
        promptHash: string;
        model: string;
        conflictFile: string;
        tier: number;
        tokenEstimate?: number;
        sessionId?: string;
    }): AuditEntry;
    /**
     * Log a resolution decision.
     */
    logResolution(data: {
        file: string;
        chosenSide: 'ours' | 'theirs' | 'merged';
        confidence: number;
        tier: number;
        conflictRegions: number;
        sessionId?: string;
    }): AuditEntry;
    /**
     * Log a validation result.
     */
    logValidation(data: {
        file: string;
        passed: boolean;
        checks: string[];
        failures?: string[];
        sessionId?: string;
    }): AuditEntry;
    /**
     * Log a redaction event (never log the actual values).
     */
    logRedaction(data: {
        file: string;
        totalRedactions: number;
        typeCounts: Record<string, number>;
        entropyStringsFound: number;
        sessionId?: string;
    }): AuditEntry;
    /**
     * Log a security event.
     */
    logSecurity(data: {
        event: string;
        severity: 'low' | 'medium' | 'high';
        details: string;
        sourceFile?: string;
        sessionId?: string;
    }): AuditEntry;
    /**
     * Log a handoff event.
     */
    logHandoff(data: {
        fromMachine: string;
        toMachine?: string;
        reason: string;
        workItemCount: number;
        sessionId?: string;
    }): AuditEntry;
    /**
     * Log a branch event.
     */
    logBranch(data: {
        action: 'create' | 'merge' | 'abandon';
        branch: string;
        result: 'success' | 'conflict' | 'failed';
        conflictFiles?: string[];
        sessionId?: string;
    }): AuditEntry;
    /**
     * Log an access denied event.
     */
    logAccessDenied(data: {
        userId: string;
        permission: string;
        role: string;
        action: string;
        sessionId?: string;
    }): AuditEntry;
    /**
     * Query audit entries with filters.
     */
    query(filter?: AuditQuery): AuditEntry[];
    /**
     * Get audit statistics.
     */
    stats(): AuditStats;
    /**
     * Verify the integrity of the audit chain.
     * Checks that each entry's previousHash matches the prior entry's entryHash.
     */
    verifyIntegrity(): AuditIntegrityResult;
    /**
     * Append an entry to the audit log.
     */
    private append;
    /**
     * Compute the SHA-256 hash of an entry (excluding the entryHash field).
     */
    private computeEntryHash;
    /**
     * Load the last hash from the current log.
     */
    private loadLastHash;
    /**
     * Load all entries from the current log.
     */
    private loadEntries;
    /**
     * Current log file path.
     */
    private currentLogPath;
    /**
     * Rotate log if it exceeds max entries.
     */
    private maybeRotate;
}
//# sourceMappingURL=AuditTrail.d.ts.map