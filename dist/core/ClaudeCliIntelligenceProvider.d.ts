/**
 * ClaudeCliIntelligenceProvider — Default IntelligenceProvider using the Claude CLI.
 *
 * Uses `claude -p` (print mode) to make judgment calls via the user's existing
 * Claude subscription. Zero extra cost — the subscription is already paid for.
 *
 * This is the DEFAULT provider for Instar agents. The Anthropic API provider
 * (AnthropicIntelligenceProvider) is an explicit opt-in alternative for users
 * who intentionally choose direct API access.
 *
 * Preference hierarchy:
 *   1. Claude CLI (subscription) — default, always available
 *   2. Anthropic API — explicit user choice only
 */
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
export declare class ClaudeCliIntelligenceProvider implements IntelligenceProvider {
    private claudePath;
    constructor(claudePath: string);
    evaluate(prompt: string, options?: IntelligenceOptions): Promise<string>;
}
//# sourceMappingURL=ClaudeCliIntelligenceProvider.d.ts.map