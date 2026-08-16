/**
 * JobReflector — LLM-powered per-job reflection (Living Skills Phase 4, PROP-229).
 *
 * Runs after job completion (enabled by default when livingSkills.enabled is true).
 * Uses IntelligenceProvider to produce qualitative analysis beyond what
 * PatternAnalyzer does mechanically:
 *
 * - WHY did deviations happen? (not just that they happened)
 * - Is the job evolving toward a different purpose?
 * - Are there retroactive corrections needed for past outputs?
 * - What would an ideal execution look like?
 *
 * Falls back gracefully when no IntelligenceProvider is configured.
 */
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
export interface ReflectionInsight {
    /** Job slug */
    jobSlug: string;
    /** Session that was reflected on */
    sessionId: string;
    /** ISO timestamp */
    reflectedAt: string;
    /** High-level summary of the execution */
    summary: string;
    /** What went well */
    strengths: string[];
    /** What could improve */
    improvements: string[];
    /** Deviation analysis — why did deviations happen? */
    deviationAnalysis: string | null;
    /** Is the job evolving toward a different purpose? */
    purposeDrift: string | null;
    /** Retroactive corrections — should past outputs be revisited? */
    retroactiveCorrections: string[];
    /** Suggested changes to the job definition */
    suggestedChanges: string[];
    /** Raw LLM response (for debugging) */
    rawResponse?: string;
}
export interface JobReflectorConfig {
    /** State directory for journal/pattern access */
    stateDir: string;
    /** LLM provider for reflection analysis */
    intelligence?: IntelligenceProvider;
    /** Model tier for reflection (default: 'capable' = Opus) */
    model?: IntelligenceOptions['model'];
    /** Max tokens for LLM response (default: 1500) */
    maxTokens?: number;
    /** Agent ID (default: 'default') */
    agentId?: string;
}
export declare class JobReflector {
    private config;
    private journal;
    private analyzer;
    constructor(config: JobReflectorConfig);
    /**
     * Reflect on the most recent execution of a job.
     * Returns null if no intelligence provider is configured.
     */
    reflect(jobSlug: string, opts?: {
        sessionId?: string;
        includePatterns?: boolean;
        days?: number;
    }): Promise<ReflectionInsight | null>;
    /**
     * Reflect on the latest execution of all jobs that have livingSkills.perJobReflection enabled.
     */
    reflectAll(opts?: {
        days?: number;
    }): Promise<ReflectionInsight[]>;
    /**
     * Parse the LLM's JSON response into a ReflectionInsight.
     */
    parseResponse(rawResponse: string, jobSlug: string, sessionId: string): ReflectionInsight;
    /**
     * Format an insight for Telegram notification.
     */
    formatInsight(insight: ReflectionInsight): string;
}
//# sourceMappingURL=JobReflector.d.ts.map