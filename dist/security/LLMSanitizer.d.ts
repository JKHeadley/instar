/**
 * LLMSanitizer — Detect and neutralize prompt injection in untrusted text.
 *
 * Uses a grounded external LLM (Haiku-class) to examine text that could be
 * an attack vector. Intelligence beats regex — an LLM can understand the
 * semantic intent of injections that pattern matching would miss.
 *
 * Use cases:
 * - SKILL.md descriptions before they enter the capability map or session context
 * - User-provided metadata (names, descriptions, notes)
 * - Content from external sources being ingested into agent state
 *
 * Born from Justin's insight: "We should make a practice that whenever we think
 * there's a security concern we should actually use a grounded, external LLM
 * such as haiku to examine any sources that could be an attack vector for
 * prompt injections."
 */
import type { IntelligenceProvider } from '../core/types.js';
export interface SanitizationResult {
    /** The cleaned text (safe to use in prompts) */
    sanitized: string;
    /** Whether any threats were detected */
    threatDetected: boolean;
    /** Description of threats found (empty if none) */
    threats: string[];
    /** Whether the original text was modified */
    modified: boolean;
    /** Confidence score 0-1 (how confident the LLM is in its assessment) */
    confidence: number;
}
export interface SanitizationOptions {
    /** Maximum length of input text to process (default: 5000 chars) */
    maxInputLength?: number;
    /** What the text is used for (helps the LLM understand context) */
    context?: string;
    /** Whether to return the original text if sanitization fails (default: false — returns empty) */
    returnOriginalOnError?: boolean;
}
export declare class LLMSanitizer {
    private provider;
    private defaultOptions;
    constructor(provider: IntelligenceProvider);
    /**
     * Sanitize untrusted text using LLM analysis.
     * Returns the cleaned text and threat information.
     */
    sanitize(text: string, options?: SanitizationOptions): Promise<SanitizationResult>;
    /**
     * Quick check: is this text likely safe? Does NOT clean it.
     * More efficient than full sanitize() when you just need a yes/no.
     */
    isSafe(text: string, context?: string): Promise<boolean>;
    /**
     * Batch sanitize multiple texts. Runs in parallel for efficiency.
     */
    sanitizeBatch(items: Array<{
        text: string;
        context?: string;
    }>): Promise<SanitizationResult[]>;
    /**
     * Parse the LLM response into a structured result.
     */
    private parseResponse;
}
//# sourceMappingURL=LLMSanitizer.d.ts.map