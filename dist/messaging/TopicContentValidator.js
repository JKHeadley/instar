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
/**
 * Classify the content category of a message based on keyword matching.
 * Categories are provided at runtime — nothing is hardcoded.
 */
export function classifyContent(text, categories) {
    const lowerText = text.toLowerCase();
    let bestCategory = null;
    let bestConfidence = 'low';
    let bestMatches = [];
    let bestScore = 0;
    for (const [category, keywords] of Object.entries(categories)) {
        const primaryMatches = keywords.primary.filter(kw => lowerText.includes(kw.toLowerCase()));
        const secondaryMatches = keywords.secondary.filter(kw => lowerText.includes(kw.toLowerCase()));
        // Score: primary matches worth 3 each, secondary worth 1 each
        const score = primaryMatches.length * 3 + secondaryMatches.length;
        if (score > bestScore) {
            bestScore = score;
            bestCategory = category;
            bestMatches = [...primaryMatches, ...secondaryMatches];
            if (primaryMatches.length > 0) {
                bestConfidence = 'high';
            }
            else if (secondaryMatches.length >= 2) {
                bestConfidence = 'moderate';
            }
            else {
                bestConfidence = 'low';
            }
        }
    }
    // Only return a category if confidence is at least moderate
    if (bestConfidence === 'low') {
        return { category: null, confidence: 'low', matchedKeywords: [] };
    }
    return {
        category: bestCategory,
        confidence: bestConfidence,
        matchedKeywords: bestMatches,
    };
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
export function validateTopicContent(text, topicPurpose, config, options) {
    // Bypass flag for system messages
    if (options?.bypass) {
        return { allowed: true, reason: null, detectedCategory: null, topicPurpose, suggestion: null };
    }
    // No purpose declared — permissive
    if (!topicPurpose) {
        return { allowed: true, reason: null, detectedCategory: null, topicPurpose: null, suggestion: null };
    }
    const purpose = topicPurpose.toLowerCase();
    // "general" and "interface" topics accept everything
    if (purpose === 'general' || purpose === 'interface') {
        return { allowed: true, reason: null, detectedCategory: null, topicPurpose: purpose, suggestion: null };
    }
    // Classify the content
    const classification = classifyContent(text, config.categories);
    // No category detected — allow (can't validate what you can't classify)
    if (!classification.category) {
        return { allowed: true, reason: null, detectedCategory: null, topicPurpose: purpose, suggestion: null };
    }
    // Check if detected category is compatible with topic purpose
    const compatible = config.compatibility[purpose] || [];
    if (classification.category === purpose || compatible.includes(classification.category)) {
        return {
            allowed: true,
            reason: null,
            detectedCategory: classification.category,
            topicPurpose: purpose,
            suggestion: null,
        };
    }
    // Mismatch — reject with guidance
    return {
        allowed: false,
        reason: `Content appears to be about "${classification.category}" (matched: ${classification.matchedKeywords.slice(0, 3).join(', ')}). This topic's purpose is "${purpose}".`,
        detectedCategory: classification.category,
        topicPurpose: purpose,
        suggestion: `This content doesn't match the topic's purpose. Send to a topic with purpose "${classification.category}" instead, or use the attention queue for cross-domain discoveries.`,
    };
}
/**
 * Get the purpose for a topic from the config.
 * Returns null if no purpose is set (permissive).
 */
export function getTopicPurpose(topicId, config) {
    return config.topicPurposes[String(topicId)]?.toLowerCase() ?? null;
}
//# sourceMappingURL=TopicContentValidator.js.map