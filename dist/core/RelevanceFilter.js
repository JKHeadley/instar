/**
 * RelevanceFilter — Rule-based pre-filter for dispatch evaluation.
 *
 * A lightweight, zero-LLM-cost filter that catches obvious mismatches
 * before invoking the LLM evaluator. This is NOT about skipping
 * intelligence — it's about not wasting intelligence on questions
 * with obvious answers.
 *
 * Filter OUT if:
 * - Dispatch references a platform the agent doesn't use
 * - Dispatch targets a feature the agent has explicitly disabled
 * - Dispatch minVersion/maxVersion doesn't match agent version
 * - Dispatch has already been evaluated (idempotency guard)
 *
 * ALWAYS proceed to LLM if:
 * - Dispatch type is security or behavioral
 * - Dispatch priority is critical
 * - Agent has no config metadata to filter against (assume relevant)
 * - Filter confidence is below threshold (0.7)
 */
/** Types that always require LLM evaluation regardless of filter result */
const ALWAYS_EVALUATE_TYPES = new Set(['security', 'behavioral']);
/** Priorities that always require LLM evaluation */
const ALWAYS_EVALUATE_PRIORITIES = new Set(['critical']);
export class RelevanceFilter {
    confidenceThreshold;
    agentVersion;
    constructor(config) {
        this.confidenceThreshold = config?.confidenceThreshold ?? 0.7;
        this.agentVersion = config?.agentVersion;
    }
    /**
     * Check if a dispatch is relevant to the agent.
     *
     * Returns { relevant: true } if the dispatch should proceed to LLM evaluation.
     * Returns { relevant: false } only for high-confidence irrelevance.
     */
    check(dispatch, snapshot, alreadyEvaluatedIds) {
        // Always-evaluate types bypass the filter entirely
        if (ALWAYS_EVALUATE_TYPES.has(dispatch.type)) {
            return {
                relevant: true,
                reason: `${dispatch.type} dispatches always require evaluation`,
                confidence: 1.0,
            };
        }
        // Critical priority always evaluates
        if (ALWAYS_EVALUATE_PRIORITIES.has(dispatch.priority)) {
            return {
                relevant: true,
                reason: 'Critical priority dispatches always require evaluation',
                confidence: 1.0,
            };
        }
        // Idempotency: skip already-evaluated dispatches
        if (alreadyEvaluatedIds?.has(dispatch.dispatchId)) {
            return {
                relevant: false,
                reason: `Dispatch ${dispatch.dispatchId} already evaluated`,
                confidence: 1.0,
            };
        }
        // Version gating
        if (this.agentVersion) {
            if (dispatch.minVersion && !this.versionSatisfies(this.agentVersion, dispatch.minVersion, '>=')) {
                return {
                    relevant: false,
                    reason: `Agent version ${this.agentVersion} below dispatch minVersion ${dispatch.minVersion}`,
                    confidence: 0.95,
                };
            }
            if (dispatch.maxVersion && !this.versionSatisfies(this.agentVersion, dispatch.maxVersion, '<=')) {
                return {
                    relevant: false,
                    reason: `Agent version ${this.agentVersion} above dispatch maxVersion ${dispatch.maxVersion}`,
                    confidence: 0.95,
                };
            }
        }
        // Platform matching — check if dispatch content references platforms agent doesn't use
        const platformMatch = this.checkPlatformRelevance(dispatch, snapshot);
        if (!platformMatch.relevant && platformMatch.confidence >= this.confidenceThreshold) {
            return platformMatch;
        }
        // Feature matching — check if dispatch targets disabled features
        const featureMatch = this.checkFeatureRelevance(dispatch, snapshot);
        if (!featureMatch.relevant && featureMatch.confidence >= this.confidenceThreshold) {
            return featureMatch;
        }
        // No filters triggered — dispatch is relevant
        return {
            relevant: true,
            reason: 'No irrelevance signals detected',
            confidence: 0.5, // Moderate confidence — let LLM decide
        };
    }
    /**
     * Check if a dispatch references platforms the agent uses.
     */
    checkPlatformRelevance(dispatch, snapshot) {
        if (snapshot.capabilities.platforms.length === 0) {
            // No platform info — assume relevant
            return { relevant: true, reason: 'No platform info available', confidence: 0.3 };
        }
        // Check if dispatch content mentions specific platforms
        const platformKeywords = {
            telegram: ['telegram', 'tg bot', 'telegram bot'],
            whatsapp: ['whatsapp', 'wa bot', 'whatsapp bot'],
            slack: ['slack', 'slack bot', 'slack integration'],
            discord: ['discord', 'discord bot'],
        };
        const contentLower = dispatch.content.toLowerCase();
        const titleLower = dispatch.title.toLowerCase();
        for (const [platform, keywords] of Object.entries(platformKeywords)) {
            const mentionsPlatform = keywords.some(k => contentLower.includes(k) || titleLower.includes(k));
            if (mentionsPlatform && !snapshot.capabilities.platforms.includes(platform)) {
                return {
                    relevant: false,
                    reason: `Dispatch references ${platform} but agent doesn't use it`,
                    confidence: 0.85,
                };
            }
        }
        return { relevant: true, reason: 'Platform compatibility check passed', confidence: 0.5 };
    }
    /**
     * Check if a dispatch targets features the agent has disabled.
     */
    checkFeatureRelevance(dispatch, snapshot) {
        if (snapshot.capabilities.disabledFeatures.length === 0) {
            return { relevant: true, reason: 'No disabled features', confidence: 0.3 };
        }
        const contentLower = dispatch.content.toLowerCase();
        const titleLower = dispatch.title.toLowerCase();
        for (const feature of snapshot.capabilities.disabledFeatures) {
            if (contentLower.includes(feature.toLowerCase()) || titleLower.includes(feature.toLowerCase())) {
                return {
                    relevant: false,
                    reason: `Dispatch targets disabled feature: ${feature}`,
                    confidence: 0.8,
                };
            }
        }
        return { relevant: true, reason: 'Feature compatibility check passed', confidence: 0.5 };
    }
    /**
     * Simple semver comparison. Returns true if agentVersion `op` targetVersion.
     */
    versionSatisfies(agentVersion, targetVersion, op) {
        const parse = (v) => {
            const parts = v.replace(/^v/, '').split('.').map(Number);
            return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
        };
        const a = parse(agentVersion);
        const t = parse(targetVersion);
        const cmp = (a.major - t.major) || (a.minor - t.minor) || (a.patch - t.patch);
        return op === '>=' ? cmp >= 0 : cmp <= 0;
    }
}
//# sourceMappingURL=RelevanceFilter.js.map