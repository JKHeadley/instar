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
import type { FeatureDefinition, ConsentTier } from './FeatureRegistry.js';
export type SurfaceLevel = 'awareness' | 'suggestion' | 'prompt';
export interface SurfacingContext {
    /** The observed problem or pattern (for suggestion/prompt levels) */
    observedContext?: string;
    /** Specific benefit in current context (for prompt level) */
    specificBenefit?: string;
}
export interface SurfacingMessage {
    level: SurfaceLevel;
    message: string;
    featureId: string;
    /** Whether data implications were disclosed */
    dataDisclosed: boolean;
    /** Whether reversibility was mentioned */
    reversibilityMentioned: boolean;
}
/**
 * Generate an awareness-level surfacing message.
 * Lowest pressure — just informing the user that a capability exists.
 */
export declare function awarenessMessage(definition: FeatureDefinition): SurfacingMessage;
/**
 * Generate a suggestion-level surfacing message.
 * Medium pressure — ties to an observed problem or pattern.
 */
export declare function suggestionMessage(definition: FeatureDefinition, context: SurfacingContext): SurfacingMessage;
/**
 * Generate a prompt-level surfacing message.
 * Highest pressure — includes data implications, benefit, and reversibility.
 * Data implications are presented BEFORE benefits (not the reverse).
 */
export declare function promptMessage(definition: FeatureDefinition, context: SurfacingContext): SurfacingMessage;
/**
 * Generate a surfacing message for any level.
 * Dispatches to the appropriate template based on level.
 */
export declare function generateSurfacingMessage(definition: FeatureDefinition, level: SurfaceLevel, context?: SurfacingContext): SurfacingMessage;
/**
 * Validate that a surfacing message follows the template design principles.
 * Returns a list of violations (empty = valid).
 */
export declare function validateSurfacingMessage(message: SurfacingMessage): string[];
/**
 * Get the recommended surface level based on consent tier.
 * Higher-tier features should default to lower surfacing pressure.
 */
export declare function recommendedSurfaceLevel(tier: ConsentTier): SurfaceLevel;
//# sourceMappingURL=SurfacingTemplates.d.ts.map