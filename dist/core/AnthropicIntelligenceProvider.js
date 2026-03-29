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
import { resolveModelId } from './models.js';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'fast';
export class AnthropicIntelligenceProvider {
    apiKey;
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    /**
     * Create a provider from environment variables, or null if no key available.
     * Follows the same graceful degradation pattern as TelegramAdapter's voice providers.
     */
    static fromEnv() {
        const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
        if (!apiKey) {
            return null;
        }
        return new AnthropicIntelligenceProvider(apiKey);
    }
    async evaluate(prompt, options) {
        const model = resolveModelId(options?.model ?? DEFAULT_MODEL);
        const maxTokens = options?.maxTokens ?? 100;
        const temperature = options?.temperature ?? 0;
        const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION,
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                temperature,
                messages: [
                    { role: 'user', content: prompt },
                ],
            }),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'unknown error');
            throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
        }
        const data = await response.json();
        // Extract text from the response
        const textBlock = data.content?.find((block) => block.type === 'text');
        return textBlock?.text ?? '';
    }
}
//# sourceMappingURL=AnthropicIntelligenceProvider.js.map