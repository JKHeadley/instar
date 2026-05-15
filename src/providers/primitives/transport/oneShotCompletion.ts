/**
 * OneShotCompletion — single prompt → single text response, no tools.
 *
 * The lightest-weight primitive. Used for: classification, routing decisions,
 * scoring, summarization, validation checks. The IntelligenceProvider
 * interface in src/core/types.ts will be re-expressed in terms of this
 * primitive during Phase 3 refactoring.
 *
 * Maps to:
 *   - Claude headless: `claude -p PROMPT --max-turns 1 --output-format text`
 *   - Claude interactive: REPL session, inject prompt, capture response
 *   - OpenAI Codex: `codex exec PROMPT --output-last-message <path>`
 *   - OpenAI Responses API directly (no agent loop)
 *   - Local Ollama: HTTP POST /api/generate
 *
 * What this primitive does NOT do:
 *   - Multi-turn conversation (use AgenticSession* variants)
 *   - Tool calls (use AgenticSession* variants)
 *   - File system access (use AgenticSession* variants)
 *   - Streaming output (use AgenticSession-headless and consume events)
 *
 * Implementations SHOULD return as quickly as the provider allows. Callers
 * SHOULD use a low maxTokens budget when the response is expected to be short.
 */

import type { CancellationOptions, ModelTier, ProviderSpecific, UsageReport } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface OneShotCompletion {
  readonly capability: typeof CapabilityFlag.OneShotCompletion;

  /**
   * Send a single prompt, get a single text response.
   *
   * Implementations MUST throw a ProviderError subclass on failure. They
   * MUST honor `options.signal` for cancellation. They SHOULD honor
   * `options.timeoutMs` and throw TimeoutError when exceeded.
   */
  evaluate(prompt: string, options?: OneShotCompletionOptions): Promise<OneShotCompletionResult>;
}

export interface OneShotCompletionOptions extends CancellationOptions {
  /** Model tier preference. Adapter resolves to a concrete model. */
  model?: ModelTier;
  /** Maximum tokens in the response. */
  maxTokens?: number;
  /** Sampling temperature, 0-1. Lower = more deterministic. */
  temperature?: number;
  /** Optional system message / instructions prepended to the prompt. */
  system?: string;
}

export interface OneShotCompletionResult {
  /** The model's text response, trimmed. */
  text: string;
  /** Usage data if the provider reports it. May be null even when authoritative. */
  usage: UsageReport | null;
  /** Adapter-specific extension fields. */
  providerSpecific?: ProviderSpecific;
}
