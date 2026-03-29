/**
 * SoulManager — Self-authored identity management for Instar agents.
 *
 * Manages `.instar/soul.md` with:
 * - Server-side trust enforcement (section-level write permissions)
 * - Pending queue for changes exceeding trust level
 * - Drift detection against init-time snapshot
 * - Audit trail via security ledger
 * - Integrity hashing for compaction recovery verification
 *
 * soul.md is reflective identity ("what I believe, what I'm wrestling with").
 * AGENT.md is operational identity ("how I work, what I do").
 * They are complementary, not competing.
 */
import type { AutonomyProfileLevel, SoulSection, SoulWriteSource, SoulWriteOperation, SoulPatchRequest, SoulPatchResponse, SoulPendingChange, SoulDriftReport } from './types.js';
import type { IntegrityManager } from '../knowledge/IntegrityManager.js';
export declare class SoulManager {
    private stateDir;
    private soulPath;
    private initSnapshotPath;
    private integrityPath;
    private pendingPath;
    private lockPath;
    private securityLedgerPath;
    private integrityManager;
    constructor(opts: {
        stateDir: string;
        integrityManager?: IntegrityManager | null;
    });
    /** Check if soul.md exists for this agent. */
    isEnabled(): boolean;
    /** Read the full soul.md content. */
    readSoul(): string | null;
    /** Read only the public sections (Personality Seed + Core Values). */
    readPublicSections(): string | null;
    /**
     * Apply a patch to soul.md with trust enforcement.
     *
     * Returns { status: 'applied' } if the write succeeded,
     * or { status: 'pending', pendingId } if the change was queued.
     */
    patch(request: SoulPatchRequest, trustLevel: AutonomyProfileLevel): SoulPatchResponse;
    /**
     * Check if a section can be written at the given trust level.
     *
     * At Collaborative+ level, all sections are writable.
     * At Supervised, protected sections go to pending queue.
     * At Cautious, only integrations and evolution-history are writable.
     */
    checkSectionAccess(section: SoulSection, trustLevel: AutonomyProfileLevel): boolean;
    /** Add a change to the pending queue. */
    addPending(opts: {
        section: SoulSection;
        operation: SoulWriteOperation;
        content: string;
        source: SoulWriteSource;
        trustLevel: AutonomyProfileLevel;
    }): string;
    /** Get all pending changes. */
    getPending(status?: 'pending' | 'approved' | 'rejected'): SoulPendingChange[];
    /** Approve a pending change — apply it to soul.md. */
    approvePending(id: string): SoulPatchResponse;
    /** Reject a pending change with optional reason. */
    rejectPending(id: string, reason?: string): void;
    /** Analyze drift between current soul.md and init snapshot. */
    analyzeDrift(): SoulDriftReport;
    /** Record that drift was reviewed (resets the review timer). */
    markDriftReviewed(): void;
    /** Verify soul.md integrity against stored hash or HMAC (v0.22+). */
    verifyIntegrity(): {
        valid: boolean;
        reason?: string;
    };
    /**
     * Get content safe for compaction recovery injection.
     * Only returns Personality Seed + Core Values after integrity check.
     */
    getCompactionContent(): string | null;
    /**
     * Initialize soul.md for the first time.
     * Creates soul.md, soul.init.md, and integrity hash.
     */
    initialize(content: string): void;
    private applyWrite;
    private extractSection;
    private replaceSection;
    private appendToSection;
    private removeFromSection;
    private calculateDivergence;
    private acquireLock;
    private releaseLock;
    private hashFile;
    private updateIntegrityHash;
    private loadIntegrity;
    private saveIntegrity;
    private getLastDriftReview;
    private loadPending;
    private savePending;
    private emitAuditEvent;
    private summarizeDiff;
}
export declare class SoulError extends Error {
    code: string;
    details?: Record<string, unknown>;
    constructor(message: string, code: string, details?: Record<string, unknown>);
}
//# sourceMappingURL=SoulManager.d.ts.map