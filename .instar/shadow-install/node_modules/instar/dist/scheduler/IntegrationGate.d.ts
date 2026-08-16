/**
 * IntegrationGate -- Enforces learning consolidation after job completion.
 *
 * Mirrors Portal's compose-guard pattern: compose-guard ensures grounding
 * BEFORE sending, IntegrationGate ensures learning AFTER job execution.
 *
 * The flow:
 *   1. Job completes -> notifyJobComplete calls gate.evaluate()
 *   2. Gate runs reflection (synchronous, NOT fire-and-forget)
 *   3. Gate runs pattern analysis
 *   4. Gate auto-populates CommonBlockers from high-confidence patterns
 *   5. If failed job produced no learning -> gate BLOCKS queue drain
 *   6. If learning captured -> gate ALLOWS queue drain
 *
 * Born from the 234th Lesson: "Skill text is not enforcement."
 * Born from the 235th Lesson: "Scheduled jobs vs ad-hoc sessions."
 */
import type { ReflectionInsight } from '../core/JobReflector.js';
import type { JobDefinition, IntelligenceProvider } from '../core/types.js';
import type { JobRunHistory } from './JobRunHistory.js';
export interface IntegrationGateConfig {
    stateDir: string;
    intelligence: IntelligenceProvider | null;
    runHistory: JobRunHistory;
    /** Timeout in ms before gate gives up and proceeds. Default: 30000 */
    defaultTimeoutMs?: number;
}
export interface GateContext {
    job: JobDefinition;
    sessionId: string;
    runId: string | null;
    failed: boolean;
    output: string;
    topicId?: number;
}
export interface GateResult {
    /** Whether the scheduler should proceed with queue drain */
    proceed: boolean;
    /** Reflection insight produced (null if skipped or failed) */
    reflectionInsight: ReflectionInsight | null;
    /** Number of patterns detected in analysis */
    patternsDetected: number;
    /** CommonBlocker keys that were auto-added */
    blockersAdded: string[];
    /** Reason the gate blocked (undefined if proceed=true) */
    gateBlockReason?: string;
    /** How long the gate evaluation took */
    durationMs: number;
    /** True if gate was not applicable (livingSkills not enabled, etc.) */
    skipped?: boolean;
}
export declare class IntegrationGate {
    private config;
    private consecutiveBlocks;
    /** Maximum consecutive blocks before auto-downgrade to warning */
    static readonly MAX_CONSECUTIVE_BLOCKS = 3;
    constructor(config: IntegrationGateConfig);
    /**
     * Evaluate whether a completed job's learning has been captured.
     * Returns proceed=true if the scheduler should drain the queue.
     */
    evaluate(ctx: GateContext): Promise<GateResult>;
    /**
     * Run reflection and pattern analysis for a completed job.
     */
    private runLearning;
    /**
     * Auto-populate CommonBlockers from high-confidence failure patterns.
     * Writes to {stateDir}/state/jobs/{slug}/auto-blockers.json
     */
    private autoPopulateBlockers;
    /**
     * Handle a gate block, with consecutive-block downgrade logic.
     */
    private handleBlock;
    private makeResult;
    private timeout;
    private patternToBlockerKey;
    private mapReflectionModel;
}
//# sourceMappingURL=IntegrationGate.d.ts.map