/** Same real pinned model, dtype and thread settings as production; no hook downloads. */
import { EmbeddingProvider, ONNX_SESSION_OPTIONS } from '../../src/memory/EmbeddingProvider.js';
import { MODEL, requireEmbeddingCache } from '../setup/real-embedding-cache.mjs';

export function createRealEmbeddingProvider(): EmbeddingProvider {
  const cache = requireEmbeddingCache();
  return new EmbeddingProvider({
    modelName: MODEL,
    pipelineFactory: async modelName => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('feature-extraction', modelName, {
        dtype: 'fp32', session_options: ONNX_SESSION_OPTIONS,
        cache_dir: cache, local_files_only: true,
      });
    },
  });
}
