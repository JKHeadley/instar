/**
 * Commitment Tracker — durable promise enforcement for agent infrastructure.
 *
 * When a user asks an agent to change something, the agent says "done" — but
 * often the change doesn't stick. Sessions compact, configs revert, behavioral
 * promises get forgotten. This module closes that gap.
 *
 * Three commitment types:
 *   1. config-change  — enforced by code (auto-corrects config drift)
 *   2. behavioral     — injected into every session via hooks
 *   3. one-time-action — tracked until verified, then closed
 *
 * The CommitmentTracker runs as a server-side monitor. It does NOT depend on
 * the LLM following instructions — it enforces commitments independently.
 *
 * Lifecycle:
 *   record → verify → (auto-correct if needed) → monitor → resolve
 */
import { EventEmitter } from 'node:events';
import type { LiveConfig } from '../config/LiveConfig.js';
import type { ComponentHealth } from '../core/types.js';
export type CommitmentType = 'config-change' | 'behavioral' | 'one-time-action';
export type CommitmentStatus = 'pending' | 'verified' | 'violated' | 'expired' | 'withdrawn';
export interface Commitment {
    /** Unique identifier (CMT-xxx) */
    id: string;
    /** What the user asked for, in their words */
    userRequest: string;
    /** What the agent committed to */
    agentResponse: string;
    /** Commitment type determines verification strategy */
    type: CommitmentType;
    /** Current status */
    status: CommitmentStatus;
    /** When the commitment was made */
    createdAt: string;
    /** When the commitment was last verified */
    lastVerifiedAt?: string;
    /** When the commitment was fulfilled or violated */
    resolvedAt?: string;
    /** Resolution details */
    resolution?: string;
    /** Number of consecutive successful verifications */
    verificationCount: number;
    /** Number of violations detected */
    violationCount: number;
    /** Telegram topic ID where the commitment was made */
    topicId?: number;
    /** Source: 'agent' (self-registered) or 'sentinel' (detected by LLM scanner) */
    source?: 'agent' | 'sentinel' | 'manual';
    /** For config-change: the config path and expected value */
    configPath?: string;
    configExpectedValue?: unknown;
    /** For behavioral: the rule text injected into sessions */
    behavioralRule?: string;
    /** For behavioral/one-time: when this commitment expires (null = forever) */
    expiresAt?: string;
    /** For one-time-action: verification method */
    verificationMethod?: 'config-value' | 'file-exists' | 'manual';
    /** For one-time-action with file-exists: the path to check */
    verificationPath?: string;
    /** Number of times auto-correction has fired for this commitment */
    correctionCount: number;
    /** Timestamps of recent corrections (for pattern detection) */
    correctionHistory: string[];
    /** Whether this commitment has been escalated as a potential bug */
    escalated: boolean;
    /** Escalation details */
    escalationDetail?: string;
}
export interface CommitmentStore {
    version: 1;
    commitments: Commitment[];
    lastModified: string;
}
export interface CommitmentVerificationReport {
    timestamp: string;
    active: number;
    verified: number;
    violated: number;
    pending: number;
    violations: Array<{
        id: string;
        userRequest: string;
        detail: string;
        autoCorrected: boolean;
    }>;
}
export interface CommitmentTrackerConfig {
    stateDir: string;
    liveConfig: LiveConfig;
    /** Check interval in ms. Default: 60_000 (1 minute) */
    checkIntervalMs?: number;
    /** Callback when a violation is detected */
    onViolation?: (commitment: Commitment, detail: string) => void;
    /** Callback when a commitment is verified for the first time */
    onVerified?: (commitment: Commitment) => void;
    /** Callback when repeated corrections suggest a bug. */
    onEscalation?: (commitment: Commitment, detail: string) => void;
    /** Number of corrections within the window that triggers escalation. Default: 3 */
    escalationThreshold?: number;
    /** Time window for counting corrections (ms). Default: 3_600_000 (1 hour) */
    escalationWindowMs?: number;
}
export declare class CommitmentTracker extends EventEmitter {
    private config;
    private store;
    private storePath;
    private rulesPath;
    private interval;
    private nextId;
    constructor(config: CommitmentTrackerConfig);
    start(): void;
    stop(): void;
    /**
     * Record a new commitment. Returns the created commitment.
     */
    record(input: {
        userRequest: string;
        agentResponse: string;
        type: CommitmentType;
        topicId?: number;
        source?: 'agent' | 'sentinel' | 'manual';
        configPath?: string;
        configExpectedValue?: unknown;
        behavioralRule?: string;
        expiresAt?: string;
        verificationMethod?: 'config-value' | 'file-exists' | 'manual';
        verificationPath?: string;
    }): Commitment;
    /**
     * Withdraw a commitment (user changed their mind).
     */
    withdraw(id: string, reason: string): boolean;
    /**
     * Get all active commitments (pending or verified, not expired).
     */
    getActive(): Commitment[];
    /**
     * Get all commitments (including resolved).
     */
    getAll(): Commitment[];
    /**
     * Get a single commitment by ID.
     */
    get(id: string): Commitment | null;
    /**
     * Run verification on all active commitments.
     */
    verify(): CommitmentVerificationReport;
    /**
     * Verify a single commitment. Returns null if commitment not found or not active.
     */
    verifyOne(id: string): {
        passed: boolean;
        detail: string;
    } | null;
    /**
     * Get behavioral commitments formatted for session injection.
     * This is what hooks read and inject into new sessions.
     */
    getBehavioralContext(): string;
    /**
     * Get ComponentHealth for integration with HealthChecker.
     */
    getHealth(): ComponentHealth;
    private verifyConfigChange;
    private verifyBehavioral;
    private verifyOneTimeAction;
    private attemptAutoCorrection;
    /**
     * Check if a commitment has been auto-corrected too many times,
     * suggesting a bug rather than simple drift.
     */
    private checkForEscalation;
    /**
     * Write the commitment-rules.md file for hook injection.
     */
    private writeBehavioralRules;
    private expireCommitments;
    private loadStore;
    private saveStore;
    private computeNextId;
    private deepEqual;
}
//# sourceMappingURL=CommitmentTracker.d.ts.map