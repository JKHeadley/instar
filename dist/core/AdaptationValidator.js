/**
 * AdaptationValidator — Post-adaptation scope enforcement and drift scoring.
 *
 * When the ContextualEvaluator adapts a dispatch, the adapted content must
 * pass scope enforcement before execution. This prevents prompt injection
 * via LLM adaptation (e.g., adapting a lesson into executable code).
 *
 * Also computes adaptation drift — how far the adapted content deviates
 * from the original. High drift is flagged for human review.
 */
// ── Dangerous content patterns ──────────────────────────────────────
/**
 * Patterns that indicate scope escalation in adapted content.
 * If the original dispatch didn't contain these but the adaptation does,
 * it's likely a scope escalation attempt.
 */
const ESCALATION_PATTERNS = [
    // Shell execution
    /\b(?:exec|spawn|system|popen|child_process)\b/i,
    /(?:^|\s)(?:rm|mv|cp|chmod|chown|sudo|curl|wget)\s/m,
    /\$\(.*\)/,
    /`[^`]*`/,
    // File system operations
    /(?:fs\.(?:write|unlink|rmdir|rename|mkdir|appendFile))/i,
    /(?:writeFile|writeFileSync|unlinkSync)/i,
    // Network operations
    /(?:fetch|axios|http\.request|net\.connect)/i,
    // Process/env manipulation
    /process\.env\[/,
    /process\.exit/,
    // Config file paths (injection targets)
    /\.(?:env|npmrc|bashrc|zshrc|gitconfig)/,
];
// ── Main Class ──────────────────────────────────────────────────────
export class AdaptationValidator {
    config;
    constructor(config) {
        this.config = {
            driftThreshold: config?.driftThreshold ?? 0.6,
        };
    }
    /**
     * Validate adapted content against the original dispatch's scope.
     */
    validate(original, adaptedContent, scopeEnforcer, autonomyProfile) {
        const violations = [];
        let flagForReview = false;
        // 1. Check for escalation patterns introduced by adaptation
        const originalPatterns = this.detectPatterns(original.content);
        const adaptedPatterns = this.detectPatterns(adaptedContent);
        const newPatterns = adaptedPatterns.filter(p => !originalPatterns.includes(p));
        if (newPatterns.length > 0) {
            violations.push(`Adaptation introduces ${newPatterns.length} escalation pattern(s): ${newPatterns.join(', ')}`);
        }
        // 2. Check scope enforcement if available
        if (scopeEnforcer) {
            const tier = scopeEnforcer.getScopeTier(original.type);
            // Try to parse adapted content as structured action
            // (some adaptations might introduce structure where there was none)
            try {
                const parsed = JSON.parse(adaptedContent);
                if (parsed.steps && Array.isArray(parsed.steps)) {
                    const stepCheck = scopeEnforcer.validateSteps(parsed.steps, tier);
                    if (!stepCheck.valid) {
                        violations.push(...stepCheck.violations.map(v => `Scope violation: ${v}`));
                    }
                }
            }
            catch {
                // Not structured JSON — check text-based escalation only
            }
        }
        // 3. Compute drift score
        const driftScore = this.computeDrift(original.content, adaptedContent);
        // 4. Flag for review if drift exceeds threshold
        if (driftScore > this.config.driftThreshold) {
            flagForReview = true;
        }
        // 5. Also flag if there are violations but content might still be usable
        if (violations.length > 0) {
            flagForReview = true;
        }
        return {
            withinScope: violations.length === 0,
            violations,
            driftScore,
            flagForReview,
        };
    }
    /**
     * Compute drift between original and adapted content.
     * Uses a simple token-overlap approach (Jaccard similarity inverted).
     * Returns 0 (identical) to 1 (completely different).
     */
    computeDrift(original, adapted) {
        if (original === adapted)
            return 0;
        if (!original || !adapted)
            return 1;
        const origTokens = this.tokenize(original);
        const adaptTokens = this.tokenize(adapted);
        if (origTokens.size === 0 && adaptTokens.size === 0)
            return 0;
        if (origTokens.size === 0 || adaptTokens.size === 0)
            return 1;
        // Jaccard distance: 1 - |A ∩ B| / |A ∪ B|
        let intersection = 0;
        for (const token of origTokens) {
            if (adaptTokens.has(token))
                intersection++;
        }
        const union = new Set([...origTokens, ...adaptTokens]).size;
        return 1 - (intersection / union);
    }
    // ── Private ───────────────────────────────────────────────────────
    tokenize(text) {
        return new Set(text.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 1));
    }
    detectPatterns(content) {
        const detected = [];
        for (const pattern of ESCALATION_PATTERNS) {
            if (pattern.test(content)) {
                detected.push(pattern.source.slice(0, 30));
            }
        }
        return detected;
    }
}
//# sourceMappingURL=AdaptationValidator.js.map