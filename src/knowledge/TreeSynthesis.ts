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
import { buildBoundedContext, buildStructuredSha256Identity } from '../core/JudgmentProvenanceLog.js';
import { DP_TREE_SYNTHESIZE } from '../data/provenanceCoverage.js';
import type { SelfKnowledgeFragment } from './types.js';

const MAX_SYNTHESIS_INPUT_CHARS = 8_000; // ~2K tokens
const DEFAULT_MAX_SYNTHESIS_OUTPUT_TOKENS = 800;

export const TREE_SYNTHESIS_PROMPT_ID = 'tree-synthesis-v1';

/** Identity-only envelope for the exact knowledge-fragment synthesis input. */
export function buildTreeSynthesisDecisionContext(input: {
  promptText: string;
  query: string;
  fragments: SelfKnowledgeFragment[];
  agentName: string;
  inputTruncated: boolean;
}): Record<string, unknown> {
  return buildBoundedContext({
    promptIdentitySha256: buildStructuredSha256Identity(input.promptText),
    promptChars: input.promptText.length,
    promptBytes: Buffer.byteLength(input.promptText, 'utf8'),
    queryIdentitySha256: buildStructuredSha256Identity(input.query),
    agentIdentitySha256: buildStructuredSha256Identity(input.agentName),
    fragmentSetIdentitySha256: buildStructuredSha256Identity(JSON.stringify(
      input.fragments.map((fragment) => [
        fragment.layerId,
        fragment.nodeId,
        fragment.relevance,
        fragment.content,
        fragment.cached,
        fragment.sensitivity,
      ]),
    )),
    fragmentCount: input.fragments.length,
    internalFragmentCount: input.fragments.filter((fragment) => fragment.sensitivity === 'internal').length,
    cachedFragmentCount: input.fragments.filter((fragment) => fragment.cached).length,
    inputTruncated: input.inputTruncated,
  });
}

export class TreeSynthesis {
  private intelligence: IntelligenceProvider | null;

  constructor(intelligence: IntelligenceProvider | null) {
    this.intelligence = intelligence;
  }

  /**
   * Synthesize fragments into a coherent narrative.
   * Returns null if LLM unavailable (degraded mode).
   */
  async synthesize(
    query: string,
    fragments: SelfKnowledgeFragment[],
    agentName: string,
  ): Promise<{ synthesis: string | null; tokensUsed: number }> {
    if (!this.intelligence || fragments.length === 0) {
      return { synthesis: null, tokensUsed: 0 };
    }

    // Build synthesis input from fragments
    const fragmentTexts = fragments.map(f => {
      const label = `[${f.nodeId}] (relevance: ${f.relevance.toFixed(2)})`;
      return `${label}\n${f.content}`;
    });

    let input = fragmentTexts.join('\n\n---\n\n');
    const inputTruncated = input.length > MAX_SYNTHESIS_INPUT_CHARS;

    // Truncate input if too large
    if (inputTruncated) {
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
        attribution: { component: 'TreeSynthesis' }, // attribution for /metrics/features
        provenance: {
          decisionPoint: DP_TREE_SYNTHESIZE,
          context: buildTreeSynthesisDecisionContext({
            promptText: prompt,
            query,
            fragments,
            agentName,
            inputTruncated,
          }),
          optionsPresented: ['write-synthesis'],
          promptId: TREE_SYNTHESIS_PROMPT_ID,
        },
      });

      // Rough token estimate for tracking
      const tokensUsed = Math.ceil(
        (prompt.length + response.length) / 4,
      );

      return { synthesis: response, tokensUsed };
    } catch {
      return { synthesis: null, tokensUsed: 0 };
    }
  }
}
