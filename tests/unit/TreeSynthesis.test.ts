import { describe, expect, it } from 'vitest';
import type { IntelligenceProvider } from '../../src/core/types.js';
import {
  TreeSynthesis,
  TREE_SYNTHESIS_PROMPT_ID,
} from '../../src/knowledge/TreeSynthesis.js';
import type { SelfKnowledgeFragment } from '../../src/knowledge/types.js';
import { DP_TREE_SYNTHESIZE } from '../../src/data/provenanceCoverage.js';

describe('TreeSynthesis', () => {
  it('enrolls the exact synthesis input without storing query, agent, or fragment text', async () => {
    let capturedPrompt = '';
    let capturedOptions: any;
    const intelligence: IntelligenceProvider = {
      evaluate: async (prompt: string, options?: any) => {
        capturedPrompt = prompt;
        capturedOptions = options;
        return 'I know the bounded answer.';
      },
    };
    const fragments: SelfKnowledgeFragment[] = [{
      layerId: 'identity-private',
      nodeId: 'node-private',
      relevance: 0.91,
      content: 'cobalt-lantern private knowledge fragment',
      cached: false,
      sensitivity: 'internal',
    }];

    const result = await new TreeSynthesis(intelligence).synthesize(
      'cobalt-lantern private query',
      fragments,
      'cobalt-lantern private agent',
    );

    expect(result.synthesis).toBe('I know the bounded answer.');
    expect(capturedPrompt).toContain('cobalt-lantern');
    expect(capturedOptions.provenance).toMatchObject({
      decisionPoint: DP_TREE_SYNTHESIZE,
      optionsPresented: ['write-synthesis'],
      promptId: TREE_SYNTHESIS_PROMPT_ID,
    });
    expect(JSON.stringify(capturedOptions.provenance.context)).not.toContain('cobalt-lantern');
    expect(JSON.stringify(capturedOptions.provenance.context)).not.toContain('identity-private');
  });

  it('preserves degraded behavior without a provider', async () => {
    const result = await new TreeSynthesis(null).synthesize('query', [{
      layerId: 'identity',
      nodeId: 'identity.core',
      relevance: 1,
      content: 'content',
      cached: true,
      sensitivity: 'public',
    }], 'Agent');

    expect(result).toEqual({ synthesis: null, tokensUsed: 0 });
  });
});
