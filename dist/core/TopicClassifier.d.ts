/**
 * TopicClassifier — Deterministic, rule-based topic classification.
 *
 * Part of the Consent & Discovery Framework (Round 2 hardening).
 *
 * Why not LLM-based:
 *   Adversarial reviewer flagged that LLM-based topic extraction reintroduces
 *   prompt injection risk into the discovery pipeline. A user could craft input
 *   that manipulates the topic classifier to trigger specific feature surfacing.
 *
 * This classifier uses keyword matching against a fixed taxonomy. It's less
 * nuanced than an LLM classifier but has zero injection surface. The evaluator
 * (which IS LLM-based) receives these labels as sanitized input.
 *
 * Design:
 *   - Fixed taxonomy of ~15 topic categories
 *   - Keyword sets per category, scored by match density
 *   - Returns top category + confidence score
 *   - Also classifies conversation intent (same approach)
 *   - Input sanitized: lowercased, truncated, non-alpha stripped
 */
export type TopicCategory = 'debugging' | 'configuration' | 'deployment' | 'security' | 'communication' | 'monitoring' | 'development' | 'documentation' | 'collaboration' | 'data-management' | 'automation' | 'performance' | 'architecture' | 'onboarding' | 'general';
export type ConversationIntent = 'debugging' | 'configuring' | 'exploring' | 'building' | 'asking' | 'monitoring' | 'unknown';
export interface ClassificationResult {
    topicCategory: TopicCategory;
    topicConfidence: number;
    conversationIntent: ConversationIntent;
    intentConfidence: number;
    /** Problem categories detected (for evaluator context) */
    problemCategories: string[];
}
/**
 * Sanitize input text for classification.
 * Strips control characters, lowercases, truncates.
 */
export declare function sanitizeInput(text: string): string;
/**
 * Classify a text into topic category and conversation intent.
 * Purely deterministic — no LLM, no injection surface.
 */
export declare function classify(rawText: string): ClassificationResult;
/**
 * Classify and return a sanitized DiscoveryContext-compatible object.
 * This is the main entry point for the discovery pipeline.
 */
export declare function classifyForDiscovery(rawText: string, autonomyProfile: string, enabledFeatures: string[], userId?: string): {
    topicCategory: string;
    conversationIntent: string;
    problemCategories: string[];
    autonomyProfile: string;
    enabledFeatures: string[];
    userId: string;
};
//# sourceMappingURL=TopicClassifier.d.ts.map