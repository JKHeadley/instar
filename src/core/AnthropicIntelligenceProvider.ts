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
 *
 * Phase 1 burn-detection wiring (docs/specs/token-burn-detection-and-self-heal.md):
 *   - Consults `LlmRateGate` before each call (Phase 1 no-op; Phase 4 enforces).
 *   - Computes an attribution_key (component::promptFingerprint) from
 *     `IntelligenceOptions.attribution`.
 *   - Records the event on the optional `TokenLedger` injected via the
 *     constructor (the CLI path already writes JSONL the ledger reads, but
 *     direct-API calls have no JSONL trail and must record explicitly).
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { resolveModelId } from './models.js';
import { LlmRateGate } from '../monitoring/LlmRateGate.js';
import { buildAttributionKey } from '../monitoring/attributionKey.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

const DEFAULT_MODEL = 'fast';

/**
 * Minimal subset of TokenLedger.recordEvent the provider needs. Kept narrow
 * so tests can pass a fake without pulling in the SQLite-backed ledger.
 */
export interface AttributionLedger {
  recordEvent(event: {
    requestId: string;
    sessionId: string;
    projectPath?: string | null;
    ts: number;
    model?: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    serviceTier?: string | null;
    attributionKey?: string;
  }): unknown;
}

export interface AnthropicProviderDeps {
  /** Optional rate-gate consultation. Defaults to the process-wide singleton. */
  rateGate?: LlmRateGate;
  /** Optional ledger to record events for burn-detection. Calls still succeed if missing. */
  ledger?: AttributionLedger | null;
  /** Pseudo-session id for ledger writes when the caller has no Claude-Code session. */
  sessionId?: string;
}

export class AnthropicIntelligenceProvider implements IntelligenceProvider {
  private apiKey: string;
  private rateGate: LlmRateGate;
  private ledger: AttributionLedger | null;
  private sessionId: string;

  constructor(apiKey: string, deps?: AnthropicProviderDeps) {
    this.apiKey = apiKey;
    this.rateGate = deps?.rateGate ?? LlmRateGate.instance();
    this.ledger = deps?.ledger ?? null;
    this.sessionId = deps?.sessionId ?? 'anthropic-api';
  }

  /**
   * Create a provider from environment variables, or null if no key available.
   * Follows the same graceful degradation pattern as TelegramAdapter's voice providers.
   */
  static fromEnv(deps?: AnthropicProviderDeps): AnthropicIntelligenceProvider | null {
    const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
    if (!apiKey) {
      return null;
    }
    return new AnthropicIntelligenceProvider(apiKey, deps);
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const model = resolveModelId(options?.model ?? DEFAULT_MODEL);
    const maxTokens = options?.maxTokens ?? 100;
    const temperature = options?.temperature ?? 0;

    const attributionKey = buildAttributionKey(options?.attribution?.component, prompt);

    // Consult the rate gate. Phase 1 always allows; Phase 4 may refuse.
    // When refused, throw a recoverable error so the caller can degrade
    // gracefully (the same shape as a transient API error).
    if (!this.rateGate.shouldFire(attributionKey)) {
      throw new Error(`LLM call throttled by burn-detection runbook for key ${attributionKey}`);
    }

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

    const data = await response.json() as {
      id?: string;
      model?: string;
      content: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        service_tier?: string;
      };
    };

    // Record the event for burn-detection observability. Best-effort: if the
    // ledger throws, the LLM result is still returned to the caller — token
    // accounting must never break the user-facing path. Failures land in
    // the ledger's own error counter, not in the caller's flow.
    if (this.ledger && data.usage && data.id) {
      try {
        this.ledger.recordEvent({
          requestId: data.id,
          sessionId: this.sessionId,
          ts: Date.now(),
          model: data.model ?? model,
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
          serviceTier: data.usage.service_tier ?? null,
          attributionKey,
        });
      } catch {
        // Intentional swallow — ledger failure must not affect the user path.
      }
    }

    // Extract text from the response
    const textBlock = data.content?.find((block) => block.type === 'text');
    return textBlock?.text ?? '';
  }
}
