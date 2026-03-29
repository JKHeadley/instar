/**
 * TopicContentValidator — Validates outbound messages against topic purpose.
 *
 * When a session sends a message to its topic, this validator checks if
 * the content matches the topic's declared purpose. Mismatched content
 * is rejected with guidance — never rerouted.
 *
 * Design principles:
 * - One session, one topic. Messages never get rerouted to other topics.
 * - Topics without a declared purpose are permissive (no validation).
 * - System/infrastructure messages bypass validation.
 * - Keyword-based classification — simple, fast, auditable.
 * - Fully configurable — categories, purposes, and compatibility
 *   are defined in instar.config.json, not hardcoded.
 */
/** Keyword patterns for a single content category */
export interface CategoryKeywords {
    /** Strong signal — one match is enough */
    primary: string[];
    /** Weaker signal — need 2+ matches to classify */
    secondary: string[];
}
/** Full content validation configuration */
export interface ContentValidationConfig {
    /** Whether content validation is enabled (default: false) */
    enabled: boolean;
    /** Content categories and their keyword patterns */
    categories: Record<string, CategoryKeywords>;
    /** Topic ID → purpose mapping (e.g., { "42": "billing" }) */
    topicPurposes: Record<string, string>;
    /** Purpose compatibility map — which categories are accepted by which purposes.
     * Example: { "billing": ["billing", "support"] } means a "billing" topic
     * also accepts "support" content. */
    compatibility: Record<string, string[]>;
}
export interface ClassificationResult {
    /** Detected content category (null if no strong match) */
    category: string | null;
    /** Confidence: 'high' (primary keyword match), 'moderate' (2+ secondary), or 'low' */
    confidence: 'high' | 'moderate' | 'low';
    /** Keywords that matched */
    matchedKeywords: string[];
}
/**
 * Classify the content category of a message based on keyword matching.
 * Categories are provided at runtime — nothing is hardcoded.
 */
export declare function classifyContent(text: string, categories: Record<string, CategoryKeywords>): ClassificationResult;
export interface ValidationResult {
    /** Whether the message is allowed */
    allowed: boolean;
    /** Reason for rejection (null if allowed) */
    reason: string | null;
    /** Detected content category */
    detectedCategory: string | null;
    /** Topic's declared purpose */
    topicPurpose: string | null;
    /** Suggested action for the caller */
    suggestion: string | null;
}
export interface ValidateOptions {
    /** Skip validation entirely (for system messages) */
    bypass?: boolean;
}
/**
 * Validate whether a message's content matches a topic's declared purpose.
 *
 * Rules:
 * - Topics without a purpose are permissive (always allowed).
 * - Topics with purpose "general" or "interface" accept everything.
 * - Content with no detected category is allowed (can't validate what you can't classify).
 * - Content matching the topic's purpose (or compatible purposes) is allowed.
 * - Mismatched content is rejected with a helpful suggestion.
 */
export declare function validateTopicContent(text: string, topicPurpose: string | null, config: ContentValidationConfig, options?: ValidateOptions): ValidationResult;
/**
 * Get the purpose for a topic from the config.
 * Returns null if no purpose is set (permissive).
 */
export declare function getTopicPurpose(topicId: number, config: ContentValidationConfig): string | null;
//# sourceMappingURL=TopicContentValidator.d.ts.map