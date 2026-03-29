/**
 * AnthropicIntelligenceProvider — OPTIONAL IntelligenceProvider using the Anthropic Messages API.
 *
 * ⚠️  This provider uses API tokens (extra cost). For most Instar agents, the
 * ClaudeCliIntelligenceProvider (which uses the Claude subscription) is the
 * correct default. Only use this provider when:
 *   - The user explicitly sets intelligenceProvider: "anthropic-api" in config
 *   - The Claude CLI is not available
 *   - The user has a specific reason to prefer direct API access
 *
 * No SDK dependency — direct fetch calls, following the TelegramAdapter pattern.
 */
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
export declare class AnthropicIntelligenceProvider implements IntelligenceProvider {
    private apiKey;
    constructor(apiKey: string);
    /**
     * Create a provider from environment variables, or null if no key available.
     * Follows the same graceful degradation pattern as TelegramAdapter's voice providers.
     */
    static fromEnv(): AnthropicIntelligenceProvider | null;
    evaluate(prompt: string, options?: IntelligenceOptions): Promise<string>;
}
//# sourceMappingURL=AnthropicIntelligenceProvider.d.ts.map