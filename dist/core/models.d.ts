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
/**
 * Canonical mapping of abstract tiers to concrete Anthropic model IDs.
 * These are used by AnthropicIntelligenceProvider and StallTriageNurse.
 */
export declare const ANTHROPIC_MODELS: Readonly<{
    /** Most capable model — deep reasoning, complex tasks */
    readonly opus: "claude-opus-4-6";
    /** Best balance of capability and cost — default for most services */
    readonly sonnet: "claude-sonnet-4-6";
    /** Fastest and cheapest — quick classification, simple tasks */
    readonly haiku: "claude-haiku-4-5";
}>;
/**
 * Mapping of abstract tiers to Claude CLI model flags.
 * These are used by ClaudeCliIntelligenceProvider.
 */
export declare const CLI_MODEL_FLAGS: Readonly<{
    readonly opus: "opus";
    readonly sonnet: "sonnet";
    readonly haiku: "haiku";
}>;
/** Available model tier names */
export type ModelTierName = keyof typeof ANTHROPIC_MODELS;
/** Bare Anthropic model ID values */
export type AnthropicModelId = (typeof ANTHROPIC_MODELS)[ModelTierName];
/**
 * Resolve a tier name ('opus', 'sonnet', 'haiku', 'fast', 'balanced', 'capable')
 * or raw model ID to a bare Anthropic model ID.
 *
 * Supports both naming conventions:
 *   - Tier names: 'opus', 'sonnet', 'haiku'
 *   - Legacy aliases: 'fast' → haiku, 'balanced' → sonnet, 'capable' → opus
 *   - Raw IDs: 'claude-sonnet-4-6' → passed through as-is
 */
export declare function resolveModelId(tierOrId: string): string;
/**
 * Resolve a tier name to a Claude CLI model flag.
 * Supports both naming conventions (tier names and legacy aliases).
 */
export declare function resolveCliFlag(tierOrFlag: string): string;
/**
 * Get all valid tier names (for validation).
 */
export declare function getValidTiers(): string[];
/**
 * Check if a string is a valid tier name.
 */
export declare function isValidTier(tier: string): boolean;
//# sourceMappingURL=models.d.ts.map