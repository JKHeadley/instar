/**
 * JobClaimManager — Distributed job deduplication via AgentBus.
 *
 * Before executing a scheduled job, the owning machine broadcasts a
 * `work-announcement` claim via AgentBus. Other machines see the claim
 * and skip the job. When the job completes, a `work-complete` message
 * signals other machines that the claim is released.
 *
 * Claim semantics:
 *   - At-most-once execution with idempotency keys (claimId)
 *   - Claims expire if no work-complete within timeout
 *   - Partition mode: proceed independently when no peers are reachable
 *   - Local ledger persisted to disk for crash recovery
 *
 * Part of Phase 4C (User-Agent Topology Spec — Gap 5).
 */
import { EventEmitter } from 'node:events';
import type { AgentBus } from '../core/AgentBus.js';
export interface JobClaimPayload {
    /** Unique claim ID (idempotency key). */
    claimId: string;
    /** Job slug being claimed. */
    jobSlug: string;
    /** Machine ID of the claimer. */
    machineId: string;
    /** When the claim expires if no work-complete arrives (ISO 8601). */
    expiresAt: string;
}
export interface JobCompletePayload {
    /** Claim ID that this completion resolves. */
    claimId: string;
    /** Job slug that was completed. */
    jobSlug: string;
    /** Machine ID that completed the job. */
    machineId: string;
    /** Execution result. */
    result: 'success' | 'failure';
}
export interface JobClaim {
    /** Unique claim ID. */
    claimId: string;
    /** Job slug. */
    jobSlug: string;
    /** Machine ID that owns the claim. */
    machineId: string;
    /** When the claim was created (ISO 8601). */
    claimedAt: string;
    /** When the claim expires (ISO 8601). */
    expiresAt: string;
    /** Whether the job completed. */
    completed: boolean;
    /** Completion result (set on work-complete). */
    result?: 'success' | 'failure';
    /** When the job completed (ISO 8601). */
    completedAt?: string;
}
export interface JobClaimManagerConfig {
    /** The AgentBus for sending/receiving claim messages. */
    bus: AgentBus;
    /** This machine's ID. */
    machineId: string;
    /** State directory (.instar) for persisting the claim ledger. */
    stateDir: string;
    /** Default claim timeout in ms (default: 30 min). */
    defaultClaimTimeoutMs?: number;
    /** How often to prune expired claims in ms (default: 5 min). */
    pruneIntervalMs?: number;
}
export interface JobClaimManagerEvents {
    /** Emitted when a remote claim is received. */
    'claim-received': (claim: JobClaim) => void;
    /** Emitted when a remote completion is received. */
    'complete-received': (payload: JobCompletePayload) => void;
    /** Emitted when a claim is pruned due to expiry. */
    'claim-expired': (claim: JobClaim) => void;
}
export declare class JobClaimManager extends EventEmitter {
    private bus;
    private machineId;
    private stateDir;
    private defaultClaimTimeoutMs;
    private pruneIntervalMs;
    private claims;
    private claimsDir;
    private pruneTimer;
    constructor(config: JobClaimManagerConfig);
    /**
     * Attempt to claim a job before execution.
     *
     * Returns a `claimId` if the claim succeeds, or `null` if another
     * machine already holds an active claim on this job.
     *
     * @param jobSlug - The job to claim.
     * @param timeoutMs - Claim timeout (default: defaultClaimTimeoutMs).
     */
    tryClaim(jobSlug: string, timeoutMs?: number): Promise<string | null>;
    /**
     * Signal that a claimed job has completed.
     *
     * @param jobSlug - The job that completed.
     * @param result - Success or failure.
     */
    completeClaim(jobSlug: string, result: 'success' | 'failure'): Promise<void>;
    /**
     * Check if a job has an active (non-expired, non-completed) claim
     * from another machine.
     */
    hasRemoteClaim(jobSlug: string): boolean;
    /**
     * Get the active claim for a job (if any).
     */
    getClaim(jobSlug: string): JobClaim | undefined;
    /**
     * Get all active (non-expired, non-completed) claims.
     */
    getActiveClaims(): JobClaim[];
    /**
     * Get all claims (including completed and expired for diagnostics).
     */
    getAllClaims(): JobClaim[];
    /**
     * Stop the claim manager (clear timers, save state).
     */
    destroy(): void;
    private registerHandlers;
    private startPruning;
    /**
     * Remove expired and completed claims from the ledger.
     * Expired claims are claims where expiresAt has passed and no
     * work-complete was received — the claiming machine may have crashed.
     */
    pruneExpired(): number;
    private isExpired;
    private loadClaims;
    private saveClaims;
}
//# sourceMappingURL=JobClaimManager.d.ts.map