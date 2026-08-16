/**
 * CoverageAuditor — Detects gaps between agent capabilities and tree coverage.
 *
 * Compares what the agent CAN do (platforms, memory, jobs, etc.) against
 * what the tree KNOWS about (nodes with valid sources). Reports missing
 * coverage and content validity.
 */
import type { SelfKnowledgeTreeConfig, ValidationResult } from './types.js';
export interface CoverageGap {
    /** What's missing */
    description: string;
    /** Which layer it belongs to */
    layerId: string;
    /** Suggested node ID */
    suggestedNodeId: string;
    /** Severity: how much this gap matters */
    severity: 'low' | 'medium' | 'high';
}
export interface AuditResult {
    /** Overall content coverage score (0-1) */
    coverageScore: number;
    /** Total nodes in tree */
    totalNodes: number;
    /** Nodes with valid, non-empty sources */
    validNodes: number;
    /** Detected gaps */
    gaps: CoverageGap[];
    /** Validation result from tree */
    validation: ValidationResult;
}
export interface HealthSummary {
    totalNodes: number;
    coverageScore: number;
    cacheHitRate: number;
    avgLatencyMs: number;
    errorRate: number;
    searchCount: number;
    degradedSearches: number;
}
export declare class CoverageAuditor {
    private projectDir;
    private stateDir;
    constructor(projectDir: string, stateDir: string);
    /**
     * Run a full coverage audit.
     */
    audit(config: SelfKnowledgeTreeConfig, validation: ValidationResult, detectedPlatforms?: string[]): AuditResult;
    /**
     * Detect platforms from agent config files.
     */
    detectPlatforms(): string[];
    /**
     * Build health summary from trace logs.
     */
    healthSummary(): HealthSummary;
    private countNodes;
}
//# sourceMappingURL=CoverageAuditor.d.ts.map