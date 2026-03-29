/**
 * UserContextBuilder — builds a bounded per-user context block for session injection.
 *
 * Implements Gap 8 from the User-Agent Topology Spec:
 *   "No mechanism to inject user-specific context (preferences, relationship history,
 *    communication style, permissions) into session prompts."
 *
 * Design:
 *   - Bounded: respects maxContextTokens (default 500, ~4 chars/token estimate)
 *   - Structured: permissions are injected as structured data the LLM cannot override
 *   - Progressive: richer profiles produce richer context; minimal profiles still work
 *   - Deterministic: same profile always produces same context block
 *
 * Token budget allocation (default 500 tokens):
 *   - Header + permissions: ~50 tokens (always included)
 *   - Preferences: ~30 tokens
 *   - Bio: ~50 tokens (truncated if needed)
 *   - Interests: ~30 tokens
 *   - Relationship: ~40 tokens
 *   - Custom fields: ~50 tokens
 *   - Context (history summary): remaining budget
 */
import type { UserProfile, UserContextBlock, OnboardingConfig } from '../core/types.js';
/**
 * Build a UserContextBlock from a UserProfile.
 * This is the structured representation — use formatUserContextForSession()
 * for the text that gets injected into the prompt.
 */
export declare function buildUserContextBlock(profile: UserProfile): UserContextBlock;
/**
 * Format a UserProfile into a text block for session prompt injection.
 *
 * The output is structured text that the LLM reads but CANNOT override.
 * Permissions are marked as [SYSTEM-ENFORCED] to signal they are not negotiable.
 *
 * Respects maxContextTokens budget via truncation of lower-priority fields.
 */
export declare function formatUserContextForSession(profile: UserProfile, opts?: {
    maxContextTokens?: number;
    onboardingConfig?: OnboardingConfig;
}): string;
/**
 * Check whether a profile has enough data to warrant context injection.
 * Returns false for truly empty profiles (only name + default permissions).
 */
export declare function hasUserContext(profile: UserProfile): boolean;
//# sourceMappingURL=UserContextBuilder.d.ts.map