/**
 * TreeSynthesis — Cross-layer narrative synthesis via Haiku.
 *
 * Takes fragments from multiple layers and synthesizes them into a coherent
 * self-knowledge narrative. Handles token budgets, degraded mode (no LLM),
 * and fragment validation.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
import type { IntelligenceProvider } from '../core/types.js';
import type { SelfKnowledgeFragment } from './types.js';
export declare class TreeSynthesis {
    private intelligence;
    constructor(intelligence: IntelligenceProvider | null);
    /**
     * Synthesize fragments into a coherent narrative.
     * Returns null if LLM unavailable (degraded mode).
     */
    synthesize(query: string, fragments: SelfKnowledgeFragment[], agentName: string): Promise<{
        synthesis: string | null;
        tokensUsed: number;
    }>;
}
//# sourceMappingURL=TreeSynthesis.d.ts.map