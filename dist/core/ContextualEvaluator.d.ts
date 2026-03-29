/**
 * ContextualEvaluator — LLM-based contextual dispatch evaluation.
 *
 * The core intelligence layer of the Discernment Layer. Evaluates each
 * dispatch against the agent's context snapshot and decides how to
 * integrate it: accept, adapt, defer, or reject.
 *
 * Security features:
 * - Prompt isolation with UNTRUSTED content markers
 * - Response schema validation
 * - Circuit breaker with type-specific fallback behavior
 * - Evaluation jitter to prevent broadcast spike overload
 * - Individual evaluation for security/behavioral/critical dispatches
 *
 * Model selection:
 * - Uses agent's configured model tier by default
 * - Security/behavioral dispatches use 'capable' (Sonnet+) regardless
 */
import type { IntelligenceProvider } from './types.js';
import type { AgentContextSnapshot } from './types.js';
import type { Dispatch } from './DispatchManager.js';
export interface ContextualEvaluation {
    decision: 'accept' | 'adapt' | 'defer' | 'reject';
    reasoning: string;
    /** Modified content (only for 'adapt' decisions) */
    adaptation?: string;
    /** When to re-evaluate (only for 'defer' decisions) */
    deferCondition?: string;
    /** How confident the evaluator is (0-1) */
    confidenceScore: number;
    /** Version of the evaluation prompt used */
    promptVersion: string;
    /** Whether this was evaluated individually or as part of a batch */
    evaluationMode: 'individual' | 'batch';
    /** If batch, which other dispatch IDs were co-evaluated */
    batchContext?: string[];
}
export interface ContextualEvaluatorConfig {
    /** Maximum dispatches per batch evaluation (default: 5) */
    batchSize?: number;
    /** Evaluation jitter range in ms (default: 1000-60000) */
    jitterMinMs?: number;
    jitterMaxMs?: number;
    /** Circuit breaker: failures before opening (default: 3) */
    circuitBreakerThreshold?: number;
    /** Circuit breaker: reset timeout in ms (default: 600000 = 10 min) */
    circuitBreakerResetMs?: number;
    /** Default model tier for evaluation (default: 'fast') */
    defaultModelTier?: 'fast' | 'balanced' | 'capable';
    /** Dry-run mode: evaluates but doesn't apply (default: false) */
    dryRun?: boolean;
}
type CircuitState = 'closed' | 'open' | 'half-open';
export declare class ContextualEvaluator {
    private provider;
    private config;
    private circuit;
    constructor(provider: IntelligenceProvider, config?: ContextualEvaluatorConfig);
    /**
     * Evaluate a single dispatch against the agent's context.
     */
    evaluate(dispatch: Dispatch, snapshot: AgentContextSnapshot): Promise<ContextualEvaluation>;
    /**
     * Evaluate multiple dispatches, batching standard types.
     * Returns evaluations in the same order as input dispatches.
     */
    evaluateBatch(dispatches: Dispatch[], snapshot: AgentContextSnapshot): Promise<ContextualEvaluation[]>;
    /**
     * Get the fallback evaluation for a dispatch type when circuit is open.
     */
    fallbackEvaluation(dispatch: Dispatch, reason: string): ContextualEvaluation;
    /**
     * Get the current circuit breaker state.
     */
    getCircuitState(): CircuitState;
    /**
     * Get whether the evaluator is in dry-run mode.
     */
    get isDryRun(): boolean;
    /**
     * Generate random jitter delay in milliseconds.
     */
    getJitterDelay(): number;
    /**
     * Build the evaluation prompt with structural isolation.
     */
    buildEvaluationPrompt(dispatch: Dispatch, snapshot: AgentContextSnapshot, contextRenderer?: (s: AgentContextSnapshot) => string): string;
    /**
     * Parse and validate an LLM response into a ContextualEvaluation.
     * Returns null if response is not valid.
     */
    parseResponse(response: string): Omit<ContextualEvaluation, 'promptVersion' | 'evaluationMode' | 'batchContext'> | null;
    private getModelTier;
    private retryWithSimplifiedPrompt;
    private evaluateBatchGroup;
    private handleEvaluationError;
    private recordFailure;
    private isCircuitOpen;
    private maybeResetCircuit;
    private defaultContextRenderer;
}
export {};
//# sourceMappingURL=ContextualEvaluator.d.ts.map