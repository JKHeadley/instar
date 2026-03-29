/**
 * Canonical Anthropic Model Dictionary for Instar
 *
 * SINGLE SOURCE OF TRUTH for all Anthropic model IDs in the Instar codebase.
 * All components that need model IDs should import from this module.
 *
 * WHEN TO UPDATE:
 *   - Anthropic releases a new generation (e.g., Claude 5.x)
 *   - A model alias stops working (detected by validation)
 *   - You want to upgrade to a newer model
 *
 * VALIDATION:
 *   From the portal project:
 *     python3 .claude/scripts/validate-anthropic-models.py
 *
 * ARCHITECTURE:
 *   - ANTHROPIC_MODELS: bare model IDs for direct API calls
 *   - CLI_MODEL_FLAGS: CLI model flags for Claude CLI provider
 *   - resolveModelId(): converts tier names to model IDs
 *   - resolveCliFlag(): converts tier names to CLI flags
 */
// =============================================================================
// Anthropic API Model IDs (for direct API calls)
// =============================================================================
/**
 * Canonical mapping of abstract tiers to concrete Anthropic model IDs.
 * These are used by AnthropicIntelligenceProvider and StallTriageNurse.
 */
export const ANTHROPIC_MODELS = Object.freeze({
    /** Most capable model — deep reasoning, complex tasks */
    opus: 'claude-opus-4-6',
    /** Best balance of capability and cost — default for most services */
    sonnet: 'claude-sonnet-4-6',
    /** Fastest and cheapest — quick classification, simple tasks */
    haiku: 'claude-haiku-4-5',
});
// =============================================================================
// Claude CLI Model Flags (for CLI-based intelligence)
// =============================================================================
/**
 * Mapping of abstract tiers to Claude CLI model flags.
 * These are used by ClaudeCliIntelligenceProvider.
 */
export const CLI_MODEL_FLAGS = Object.freeze({
    opus: 'opus',
    sonnet: 'sonnet',
    haiku: 'haiku',
});
// =============================================================================
// Resolution helpers
// =============================================================================
/**
 * Resolve a tier name ('opus', 'sonnet', 'haiku', 'fast', 'balanced', 'capable')
 * or raw model ID to a bare Anthropic model ID.
 *
 * Supports both naming conventions:
 *   - Tier names: 'opus', 'sonnet', 'haiku'
 *   - Legacy aliases: 'fast' → haiku, 'balanced' → sonnet, 'capable' → opus
 *   - Raw IDs: 'claude-sonnet-4-6' → passed through as-is
 */
export function resolveModelId(tierOrId) {
    const key = tierOrId.toLowerCase();
    // Direct tier name match
    if (key in ANTHROPIC_MODELS) {
        return ANTHROPIC_MODELS[key];
    }
    // Legacy alias support (fast/balanced/capable → haiku/sonnet/opus)
    const LEGACY_ALIASES = {
        fast: 'haiku',
        balanced: 'sonnet',
        capable: 'opus',
    };
    if (key in LEGACY_ALIASES) {
        return ANTHROPIC_MODELS[LEGACY_ALIASES[key]];
    }
    // Not a tier name — return as-is (already a model ID)
    return tierOrId;
}
/**
 * Resolve a tier name to a Claude CLI model flag.
 * Supports both naming conventions (tier names and legacy aliases).
 */
export function resolveCliFlag(tierOrFlag) {
    const key = tierOrFlag.toLowerCase();
    if (key in CLI_MODEL_FLAGS) {
        return CLI_MODEL_FLAGS[key];
    }
    const LEGACY_ALIASES = {
        fast: 'haiku',
        balanced: 'sonnet',
        capable: 'opus',
    };
    if (key in LEGACY_ALIASES) {
        return CLI_MODEL_FLAGS[LEGACY_ALIASES[key]];
    }
    return tierOrFlag;
}
/**
 * Get all valid tier names (for validation).
 */
export function getValidTiers() {
    return [...Object.keys(ANTHROPIC_MODELS), 'fast', 'balanced', 'capable'];
}
/**
 * Check if a string is a valid tier name.
 */
export function isValidTier(tier) {
    return getValidTiers().includes(tier.toLowerCase());
}
//# sourceMappingURL=models.js.map