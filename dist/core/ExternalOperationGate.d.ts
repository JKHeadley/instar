/**
 * External Operation Gate — LLM-supervised safety for external service operations.
 *
 * Born from the OpenClaw email deletion incident (2026-02-25): An agent deleted
 * 200+ emails autonomously, ignoring repeated "stop" commands, because nothing
 * distinguished safe operations (read email) from destructive ones (delete 200 emails).
 *
 * Design principle: Structure > Willpower. A memory.md rule saying "don't delete
 * emails without approval" degrades as context grows. A gate that physically
 * intercepts the operation and evaluates risk does not.
 *
 * Three layers:
 * 1. Static classification — operation type × reversibility × scope → risk level
 * 2. Config permissions — per-service allow/block lists (structural floor)
 * 3. LLM evaluation — for medium+ risk, a haiku-tier model evaluates proportionality
 *
 * Integrates with AdaptiveTrust for organic permission evolution.
 */
import type { IntelligenceProvider } from './types.js';
export type OperationMutability = 'read' | 'write' | 'modify' | 'delete';
export type OperationReversibility = 'reversible' | 'partially-reversible' | 'irreversible';
export type OperationScope = 'single' | 'batch' | 'bulk';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type GateAction = 'proceed' | 'show-plan' | 'suggest-alternative' | 'block';
export type TrustLevel = 'blocked' | 'approve-always' | 'approve-first' | 'log' | 'autonomous';
export type TrustSource = 'default' | 'config' | 'user-explicit' | 'earned' | 'revoked';
export type AutonomyBehavior = 'proceed' | 'log' | 'approve' | 'block';
export interface OperationClassification {
    /** What the operation does */
    mutability: OperationMutability;
    /** Whether it can be undone */
    reversibility: OperationReversibility;
    /** How many items affected */
    scope: OperationScope;
    /** Computed risk level */
    riskLevel: RiskLevel;
    /** External service name */
    service: string;
    /** Human-readable description */
    description: string;
    /** Number of items affected (if known) */
    itemCount?: number;
}
export interface GateDecision {
    /** What the gate recommends */
    action: GateAction;
    /** Why this decision was made */
    reason: string;
    /** The operation classification that led to this decision */
    classification: OperationClassification;
    /** If show-plan: what to present to user */
    plan?: string;
    /** If suggest-alternative: safer approach */
    alternative?: string;
    /** If batch/bulk: checkpoint config */
    checkpoint?: CheckpointConfig;
    /** Whether LLM was consulted */
    llmEvaluated: boolean;
    /** Timestamp */
    evaluatedAt: string;
}
export interface CheckpointConfig {
    /** Pause after this many items */
    afterCount: number;
    /** Total items expected */
    totalExpected: number;
    /** Items completed so far */
    completedSoFar: number;
}
export interface ServicePermissions {
    /** Operations the agent CAN perform */
    permissions: OperationMutability[];
    /** Operations that are HARD BLOCKED (no override, no trust escalation) */
    blocked?: OperationMutability[];
    /** Maximum batch size before requiring checkpoint */
    batchLimit?: number;
    /** Operations that always require approval regardless of trust */
    requireApproval?: OperationMutability[];
}
export interface ExternalOperationGateConfig {
    /** State directory for operation logs and trust data */
    stateDir: string;
    /** Intelligence provider for LLM evaluation (haiku-tier recommended) */
    intelligence?: IntelligenceProvider;
    /** Per-service permissions */
    services?: Record<string, ServicePermissions>;
    /** Services that are fully blocked */
    blockedServices?: string[];
    /** Services that are read-only */
    readOnlyServices?: string[];
    /** Batch checkpoint configuration */
    batchCheckpoint?: {
        /** Items before first checkpoint (default: 5) */
        batchThreshold: number;
        /** Items considered "bulk" (default: 20) */
        bulkThreshold: number;
        /** Checkpoint interval for bulk operations (default: 10) */
        checkpointEvery: number;
    };
    /** Autonomy gradient — default behavior per risk level */
    autonomyDefaults?: Record<RiskLevel, AutonomyBehavior>;
}
export interface OperationLogEntry {
    /** ISO timestamp */
    timestamp: string;
    /** The operation that was evaluated */
    classification: OperationClassification;
    /** The gate's decision */
    decision: GateAction;
    /** Whether the user approved (if approval was requested) */
    userApproved?: boolean;
    /** Whether the operation completed successfully */
    succeeded?: boolean;
}
/** Autonomy profiles for the three standard levels */
export declare const AUTONOMY_PROFILES: Record<string, Record<RiskLevel, AutonomyBehavior>>;
/**
 * Compute risk level from operation dimensions.
 *
 * The matrix follows the principle: irreversible + bulk = critical,
 * read operations are always low, and risk escalates with scope.
 */
export declare function computeRiskLevel(mutability: OperationMutability, reversibility: OperationReversibility, scope: OperationScope): RiskLevel;
/**
 * Determine scope from item count.
 */
export declare function scopeFromCount(count: number, config?: {
    batchThreshold?: number;
    bulkThreshold?: number;
}): OperationScope;
export declare class ExternalOperationGate {
    private config;
    private logPath;
    constructor(config: ExternalOperationGateConfig);
    /**
     * Classify an external operation into its risk dimensions.
     */
    classify(params: {
        service: string;
        mutability: OperationMutability;
        reversibility: OperationReversibility;
        description: string;
        itemCount?: number;
    }): OperationClassification;
    /**
     * Evaluate an operation through the full gate pipeline.
     *
     * Pipeline:
     * 1. Check if service is fully blocked → block
     * 2. Check if service is read-only and operation mutates → block
     * 3. Check per-service permission config → block if operation type blocked
     * 4. Classify operation risk
     * 5. Check autonomy gradient for this risk level
     * 6. For medium+ risk with intelligence provider, consult LLM
     * 7. Check batch limits and add checkpoint if needed
     * 8. Return final decision
     */
    evaluate(params: {
        service: string;
        mutability: OperationMutability;
        reversibility: OperationReversibility;
        description: string;
        itemCount?: number;
        /** The user's original request (for LLM proportionality check) */
        userRequest?: string;
    }): Promise<GateDecision>;
    /**
     * Consult LLM for proportionality evaluation.
     *
     * IMPORTANT: The LLM never sees the content being operated on.
     * This prevents prompt injection via email body, calendar event, etc.
     * The LLM only sees: what operation, what scope, what the user asked for.
     */
    private consultLLM;
    /**
     * Build a human-readable plan for the user.
     */
    private buildPlan;
    /**
     * Log an operation evaluation to the JSONL log.
     */
    private logOperation;
    /**
     * Read recent operation log entries.
     */
    getOperationLog(limit?: number): OperationLogEntry[];
    /**
     * Get the effective service permissions (config + defaults).
     */
    getServicePermissions(service: string): ServicePermissions | null;
    /**
     * Get the current autonomy profile.
     */
    getAutonomyProfile(): Record<RiskLevel, AutonomyBehavior>;
    /**
     * Update autonomy defaults (used by AdaptiveTrust when trust changes).
     */
    updateAutonomyDefaults(defaults: Record<RiskLevel, AutonomyBehavior>): void;
    /**
     * Update service permissions at runtime.
     */
    updateServicePermissions(service: string, permissions: ServicePermissions): void;
}
//# sourceMappingURL=ExternalOperationGate.d.ts.map