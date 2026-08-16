/**
 * LLMConflictResolver — Tiered LLM escalation for git merge conflicts.
 *
 * When programmatic strategies (field-merge, newer-wins, union-by-id) fail,
 * this resolver uses LLM intelligence to understand and resolve conflicts:
 *
 *   Tier 0: Programmatic (handled by GitSync.tryAutoResolve — not here)
 *   Tier 1: Fast LLM (Haiku) — simple conflicts, ~2-8k tokens
 *   Tier 2: Deep LLM (Opus) — complex conflicts with intent context, ~5-20k tokens
 *   Tier 3: Human escalation (DegradationReporter)
 *
 * Each tier has a retry budget (default: 2 attempts). After exhausting retries,
 * the file escalates to the next tier. Validation errors from previous attempts
 * are passed forward so higher tiers can learn from failures.
 *
 * From INTELLIGENT_SYNC_SPEC Section 4 — Tiered Conflict Resolution.
 */
import type { IntelligenceProvider } from './types.js';
export interface ConflictFile {
    /** Absolute path to the conflicted file. */
    filePath: string;
    /** Relative path within the project (for display). */
    relativePath: string;
    /** File content from "ours" side (git stage 2). */
    oursContent: string;
    /** File content from "theirs" side (git stage 3). */
    theirsContent: string;
    /** Conflicted content with markers (working tree). */
    conflictedContent: string;
}
export interface ResolutionResult {
    /** The file that was resolved (or not). */
    filePath: string;
    /** Whether the conflict was resolved. */
    resolved: boolean;
    /** The resolved content (if resolved). */
    resolvedContent?: string;
    /** Which tier resolved it. */
    tier: 0 | 1 | 2 | 3;
    /** Number of attempts at this tier. */
    attempts: number;
    /** If not resolved: why. */
    reason?: string;
    /** For Tier 3: human-readable summary of each side's intent. */
    humanSummary?: string;
    /** LLM's suggested resolution (even if marked NEEDS_HUMAN). */
    suggestion?: string;
}
export interface EscalationContext {
    /** Previous tier's attempted resolution (if any). */
    previousResolution?: string;
    /** Validation error that caused re-escalation. */
    validationError?: string;
    /** Commit messages from "ours" side. */
    oursCommitMessages?: string[];
    /** Commit messages from "theirs" side. */
    theirsCommitMessages?: string[];
    /** Related files changed in the same commits. */
    relatedFiles?: {
        ours: string[];
        theirs: string[];
    };
    /** Work announcements from the inter-agent communication ledger. */
    workAnnouncements?: {
        ours?: string;
        theirs?: string;
    };
}
export interface ResolutionEvent {
    timestamp: string;
    filePath: string;
    tier: number;
    attempt: number;
    resolved: boolean;
    promptHash: string;
    responseHash: string;
    tokensEstimated: number;
    durationMs: number;
    validationError?: string;
    escalatedFrom?: number;
}
export interface LLMConflictResolverConfig {
    /** IntelligenceProvider for LLM calls. */
    intelligence: IntelligenceProvider;
    /** Project directory (repo root). */
    projectDir: string;
    /** State directory (.instar). */
    stateDir: string;
    /** Max retries per tier before escalating (default: 2). */
    maxRetriesPerTier?: number;
    /** Tier 1 timeout in ms (default: 120000). */
    tier1TimeoutMs?: number;
    /** Tier 2 timeout in ms (default: 180000). */
    tier2TimeoutMs?: number;
    /** Tier 1 max content chars per side (default: 3000). */
    tier1MaxChars?: number;
    /** Tier 2 max content chars per side (default: 5000). */
    tier2MaxChars?: number;
}
export declare class LLMConflictResolver {
    private intelligence;
    private projectDir;
    private stateDir;
    private maxRetries;
    private tier1TimeoutMs;
    private tier2TimeoutMs;
    private tier1MaxChars;
    private tier2MaxChars;
    private logPath;
    constructor(config: LLMConflictResolverConfig);
    /**
     * Attempt to resolve a conflict through tiered LLM escalation.
     *
     * Starts at Tier 1 (fast). If resolution fails validation or the
     * LLM can't resolve, escalates to Tier 2. If Tier 2 also fails,
     * returns a Tier 3 result (needs human).
     */
    resolve(conflict: ConflictFile, context?: EscalationContext): Promise<ResolutionResult>;
    /**
     * Try resolving at a specific tier with retry budget.
     */
    private tryTier;
    private buildTier1Prompt;
    private buildTier2Prompt;
    private parseResponse;
    private logEvent;
    /**
     * Read escalation log entries (for health checks / diagnostics).
     */
    readLog(limit?: number): ResolutionEvent[];
}
//# sourceMappingURL=LLMConflictResolver.d.ts.map