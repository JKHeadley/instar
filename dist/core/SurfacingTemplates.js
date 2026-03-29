/**
 * SurfacingTemplates — Dark-pattern-free message templates for feature discovery.
 *
 * Part of the Consent & Discovery Framework (Phase 4: Agent Integration).
 *
 * Design principles (from spec review):
 *   - Lead with INFORMATION, not obligation
 *   - Present data implications BEFORE benefits
 *   - Use neutral phrasing ("let me know if"), not pressure ("want me to...")
 *   - Never manufacture urgency or implied commitment
 *
 * Templates are parameterized and validated — the agent doesn't craft
 * discovery messages from scratch, reducing dark-pattern risk.
 */
// ── Template Functions ───────────────────────────────────────────────
/**
 * Generate an awareness-level surfacing message.
 * Lowest pressure — just informing the user that a capability exists.
 */
export function awarenessMessage(definition) {
    const message = `By the way — I have an opt-in feature called ${definition.name} that ${definition.oneLiner.toLowerCase()}. No action needed, just letting you know it exists.`;
    return {
        level: 'awareness',
        message,
        featureId: definition.id,
        dataDisclosed: false,
        reversibilityMentioned: false,
    };
}
/**
 * Generate a suggestion-level surfacing message.
 * Medium pressure — ties to an observed problem or pattern.
 */
export function suggestionMessage(definition, context) {
    const observed = context.observedContext || 'what you\'re working on';
    const message = `I'm noticing ${observed}. There's an opt-in feature called ${definition.name} that addresses exactly this — ${definition.oneLiner.toLowerCase()}. Happy to explain more if you're curious.`;
    return {
        level: 'suggestion',
        message,
        featureId: definition.id,
        dataDisclosed: false,
        reversibilityMentioned: false,
    };
}
/**
 * Generate a prompt-level surfacing message.
 * Highest pressure — includes data implications, benefit, and reversibility.
 * Data implications are presented BEFORE benefits (not the reverse).
 */
export function promptMessage(definition, context) {
    const dataDesc = formatDataImplications(definition.dataImplications);
    const benefit = context.specificBenefit || `help with ${definition.oneLiner.toLowerCase()}`;
    const reversibility = definition.reversibilityNote;
    // Data implications before benefits — cost before value
    const message = `${definition.name} — ${dataDesc}. It would ${benefit}. Reversible: ${reversibility}. Let me know if you'd like to try it.`;
    return {
        level: 'prompt',
        message,
        featureId: definition.id,
        dataDisclosed: true,
        reversibilityMentioned: true,
    };
}
/**
 * Generate a surfacing message for any level.
 * Dispatches to the appropriate template based on level.
 */
export function generateSurfacingMessage(definition, level, context) {
    switch (level) {
        case 'awareness':
            return awarenessMessage(definition);
        case 'suggestion':
            return suggestionMessage(definition, context || {});
        case 'prompt':
            return promptMessage(definition, context || {});
    }
}
/**
 * Validate that a surfacing message follows the template design principles.
 * Returns a list of violations (empty = valid).
 */
export function validateSurfacingMessage(message) {
    const violations = [];
    // Prompt-level messages must disclose data and mention reversibility
    if (message.level === 'prompt') {
        if (!message.dataDisclosed) {
            violations.push('Prompt-level messages must include data implications');
        }
        if (!message.reversibilityMentioned) {
            violations.push('Prompt-level messages must mention reversibility');
        }
    }
    // Check for dark pattern indicators in the message text
    const darkPatterns = [
        { pattern: /you should/i, reason: 'Prescriptive language ("you should")' },
        { pattern: /don't miss/i, reason: 'Manufactured urgency ("don\'t miss")' },
        { pattern: /everyone is using/i, reason: 'Social pressure ("everyone is using")' },
        { pattern: /limited time/i, reason: 'Artificial scarcity ("limited time")' },
        { pattern: /you're missing out/i, reason: 'FOMO language ("you\'re missing out")' },
        { pattern: /want me to/i, reason: 'Anthropomorphic pressure ("want me to")' },
    ];
    for (const dp of darkPatterns) {
        if (dp.pattern.test(message.message)) {
            violations.push(dp.reason);
        }
    }
    return violations;
}
// ── Helpers ──────────────────────────────────────────────────────────
/**
 * Format data implications into a concise, readable description.
 * Leads with what data is involved and where it goes.
 */
function formatDataImplications(implications) {
    if (implications.length === 0)
        return 'no data collected';
    const parts = implications.map(di => {
        const where = di.destination === 'local' ? 'stays on your machine'
            : di.destination === 'anthropic-api' ? 'sent to Anthropic\'s API'
                : di.destination === 'cloudflare' ? 'routed through Cloudflare'
                    : `sent to ${di.destination}`;
        return `${di.dataType} (${where})`;
    });
    return parts.join('; ');
}
/**
 * Get the recommended surface level based on consent tier.
 * Higher-tier features should default to lower surfacing pressure.
 */
export function recommendedSurfaceLevel(tier) {
    switch (tier) {
        case 'informational': return 'suggestion';
        case 'local': return 'suggestion';
        case 'network': return 'awareness';
        case 'self-governing': return 'awareness';
    }
}
//# sourceMappingURL=SurfacingTemplates.js.map