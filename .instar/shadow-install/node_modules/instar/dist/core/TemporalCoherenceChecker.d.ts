/**
 * Temporal Coherence Checker -- Detects when draft content reflects outdated thinking.
 *
 * Born from Dawn's compaction thread incident (2026-03-01): A draft written Feb 7
 * about compaction as loss was posted after a Feb 28 essay reframed compaction as
 * choice. The draft contradicted published work, creating public incoherence.
 *
 * The problem is universal: Any agent that publishes over time will evolve.
 * Drafts frozen at an earlier point can become temporally incoherent with the
 * agent's current understanding.
 *
 * This module compares draft content against:
 *   1. Agent identity documents (AGENT.md, reflections, mission)
 *   2. Published content timeline (via PlatformActivityRegistry)
 *   3. Canonical state quick-facts (current positions on key topics)
 *
 * Uses IntelligenceProvider (Instar's LLM abstraction) for evaluation.
 * Falls back gracefully to "no issues found" when no provider is configured
 * (structural floor: temporal checking is advisory, not blocking).
 *
 * Integration points:
 *   - Standalone: checker.check(draftContent) -> TemporalCoherenceResult
 *   - With CoherenceGate: Add as a custom check before publishing
 *   - With PlatformActivityRegistry: Auto-loads published content timeline
 *   - With CanonicalState: Auto-loads agent's current positions
 */
import type { IntelligenceProvider } from './types.js';
import type { PlatformActivityRegistry } from './PlatformActivityRegistry.js';
import type { CanonicalState } from './CanonicalState.js';
export type TemporalSeverity = 'BLOCK' | 'WARN' | 'INFO';
export type TemporalAssessment = 'COHERENT' | 'EVOLVED' | 'OUTDATED';
export type TemporalIssueType = 'superseded_perspective' | 'evolved_framing' | 'outdated_reference' | 'infrastructure_missing' | 'parse_error' | 'evaluation_error';
export interface TemporalIssue {
    /** How severe this issue is */
    severity: TemporalSeverity;
    /** Classification of the temporal gap */
    type: TemporalIssueType;
    /** The specific phrase or position from the draft */
    claim: string;
    /** What the current understanding says instead (if applicable) */
    current?: string;
    /** How to update the draft to reflect current thinking */
    suggestion?: string;
}
export interface TemporalCoherenceResult {
    /** Overall assessment of the draft's temporal coherence */
    assessment: TemporalAssessment;
    /** Individual issues found */
    issues: TemporalIssue[];
    /** One-sentence summary */
    summary: string;
    /** When this check was performed */
    checkedAt: string;
    /** Whether an LLM was used for evaluation */
    llmEvaluated: boolean;
}
export interface TemporalCoherenceConfig {
    /** Instar state directory */
    stateDir: string;
    /** Agent's project directory */
    projectDir: string;
    /** Intelligence provider for LLM evaluation */
    intelligence?: IntelligenceProvider;
    /** Optional PlatformActivityRegistry for published content timeline */
    activityRegistry?: PlatformActivityRegistry;
    /** Optional CanonicalState for current positions */
    canonicalState?: CanonicalState;
    /**
     * Paths to identity/state documents (relative to projectDir or absolute).
     * These represent the agent's current understanding.
     * Defaults to common locations: AGENT.md, .instar/reflections.md
     */
    stateDocuments?: string[];
    /**
     * Maximum characters to load from each state document.
     * Keeps the LLM prompt budget reasonable. Default: 2000.
     */
    maxCharsPerDocument?: number;
    /**
     * Maximum severity that temporal issues can reach.
     * Useful for capping at WARN to prevent temporal checks from blocking.
     * Default: no cap (BLOCK issues are reported as BLOCK).
     */
    maxSeverity?: TemporalSeverity;
    /**
     * Number of hours of published content to include in timeline.
     * Default: 720 (30 days).
     */
    timelineWindowHours?: number;
}
export declare class TemporalCoherenceChecker {
    private config;
    constructor(config: TemporalCoherenceConfig);
    /**
     * Check draft content for temporal coherence against the agent's
     * current understanding and published content timeline.
     */
    check(content: string): Promise<TemporalCoherenceResult>;
    /**
     * Load the agent's current state from configured documents.
     * Returns combined text from all found documents, or null if none exist.
     */
    loadCurrentState(): string | null;
    /**
     * Build a timeline of published content from PlatformActivityRegistry.
     * Returns formatted text, or null if no registry or no content.
     */
    buildTimeline(): string | null;
    /**
     * Build the LLM evaluation prompt.
     * Exposed for testing — allows verifying prompt construction without LLM calls.
     */
    buildPrompt(content: string, currentState: string | null, timeline: string | null): string;
    /**
     * Parse the LLM response into a structured result.
     * Handles malformed JSON, missing fields, and unexpected formats gracefully.
     */
    parseResponse(response: string): TemporalCoherenceResult;
    private validateAssessment;
    private validateSeverity;
    private validateIssueType;
    /**
     * Cap severity at the configured maximum.
     * E.g., if maxSeverity is WARN, BLOCK issues become WARN.
     */
    private capSeverity;
    /**
     * Check whether the checker has an IntelligenceProvider configured.
     */
    get hasIntelligence(): boolean;
    /**
     * Check whether state documents exist and have content.
     */
    get hasStateDocuments(): boolean;
    /**
     * Check whether a published content timeline is available.
     */
    get hasTimeline(): boolean;
}
//# sourceMappingURL=TemporalCoherenceChecker.d.ts.map