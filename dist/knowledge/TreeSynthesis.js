/**
 * TreeSynthesis — Cross-layer narrative synthesis via Haiku.
 *
 * Takes fragments from multiple layers and synthesizes them into a coherent
 * self-knowledge narrative. Handles token budgets, degraded mode (no LLM),
 * and fragment validation.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
const MAX_SYNTHESIS_INPUT_CHARS = 8_000; // ~2K tokens
const DEFAULT_MAX_SYNTHESIS_OUTPUT_TOKENS = 800;
export class TreeSynthesis {
    intelligence;
    constructor(intelligence) {
        this.intelligence = intelligence;
    }
    /**
     * Synthesize fragments into a coherent narrative.
     * Returns null if LLM unavailable (degraded mode).
     */
    async synthesize(query, fragments, agentName) {
        if (!this.intelligence || fragments.length === 0) {
            return { synthesis: null, tokensUsed: 0 };
        }
        // Build synthesis input from fragments
        const fragmentTexts = fragments.map(f => {
            const label = `[${f.nodeId}] (relevance: ${f.relevance.toFixed(2)})`;
            return `${label}\n${f.content}`;
        });
        let input = fragmentTexts.join('\n\n---\n\n');
        // Truncate input if too large
        if (input.length > MAX_SYNTHESIS_INPUT_CHARS) {
            input = input.slice(0, MAX_SYNTHESIS_INPUT_CHARS) + '\n[input truncated]';
        }
        const prompt = `You are synthesizing self-knowledge for an AI agent named "${agentName}".

The agent asked: "${query}"

Here are relevant knowledge fragments from the agent's self-knowledge tree:

${input}

Synthesize these fragments into a coherent, first-person narrative that directly answers the agent's query. Be concise and factual — only include information that is present in the fragments above. Do not invent or extrapolate beyond what the fragments contain.

Write as if the agent is describing itself. Use "I" voice.`;
        try {
            const response = await this.intelligence.evaluate(prompt, {
                model: 'fast',
                maxTokens: DEFAULT_MAX_SYNTHESIS_OUTPUT_TOKENS,
                temperature: 0.3,
            });
            // Rough token estimate for tracking
            const tokensUsed = Math.ceil((prompt.length + response.length) / 4);
            return { synthesis: response, tokensUsed };
        }
        catch {
            return { synthesis: null, tokensUsed: 0 };
        }
    }
}
//# sourceMappingURL=TreeSynthesis.js.map