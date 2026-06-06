/**
 * PiCliIntelligenceProvider — IntelligenceProvider using the pi coding agent
 * (PI-HARNESS-INTEGRATION-SPEC §4.4).
 *
 * Sibling of Claude/Codex/GeminiCliIntelligenceProvider: routes internal
 * component judgment calls (sentinels, gates, reviewers) through pi's
 * verified one-shot (`pi -p --mode json --no-session --offline`). This is
 * the ALIVE path for `sessions.componentFrameworks` routing to 'pi-cli' —
 * the registry adapter (src/providers/adapters/pi-cli/) shares the SAME
 * transport implementation (createOneShotCompletion), so the alive path and
 * the registry adapter can never diverge on safety:
 *
 *   - the env allowlist + billing-var hard-delete (piSpawn.buildPiChildEnv)
 *   - the STRUCTURAL SUBSCRIPTION GUARD (policy.assertPiProviderAllowed) —
 *     an Anthropic/Claude-routed model pattern throws before any spawn;
 *     an UNSET model pattern is also denied (pi's ambient default could be
 *     an Anthropic login), which is why this provider REQUIRES an explicit
 *     model pattern at construction.
 *
 * Model semantics: pi is multi-provider — the pattern is `provider/id`
 * (e.g. 'openai-codex/gpt-5.5' or a models.json custom provider). Tier
 * hints from callers (fast/balanced/capable) have no universal pi mapping
 * and resolve to the configured pattern; a caller-supplied EXPLICIT pattern
 * (contains '/') wins and is re-checked by the guard.
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import type { OneShotCompletion } from '../providers/primitives/transport/oneShotCompletion.js';
import { createOneShotCompletion } from '../providers/adapters/pi-cli/transport/oneShotCompletion.js';
import { assertPiProviderAllowed } from '../providers/adapters/pi-cli/policy.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export interface PiCliIntelligenceProviderOptions {
  /** Absolute path to the `pi` CLI binary. */
  piPath: string;
  /**
   * The pi `--model` pattern (`provider/id`) every call runs on. REQUIRED:
   * the subscription guard denies pattern-less calls (see header).
   */
  model: string;
  /**
   * Explicit opt-in for Anthropic-routed patterns (spec §4.3). Even when
   * true, every allowed call is audit-logged with a cost warning.
   */
  allowAnthropicProviders?: boolean;
  /** Optional working directory (pi tool execution cwd; judgment calls don't rely on it). */
  workingDirectory?: string;
  /** Optional override for the captured-output byte cap. */
  maxOutputBytes?: number;
}

export class PiCliIntelligenceProvider implements IntelligenceProvider {
  private readonly oneShot: OneShotCompletion;
  private readonly model: string;
  private readonly allowAnthropicProviders: boolean | undefined;

  constructor(options: PiCliIntelligenceProviderOptions) {
    this.model = options.model;
    this.allowAnthropicProviders = options.allowAnthropicProviders;
    // Fail at CONSTRUCTION when the configured pattern is denied — a
    // misconfigured pi route should break loudly at boot wiring, not on the
    // first sentinel call hours later.
    assertPiProviderAllowed(this.model, {
      ...(this.allowAnthropicProviders !== undefined
        ? { allowAnthropicProviders: this.allowAnthropicProviders }
        : {}),
    });
    this.oneShot = createOneShotCompletion({
      piPath: options.piPath,
      model: options.model,
      ...(options.allowAnthropicProviders !== undefined
        ? { allowAnthropicProviders: options.allowAnthropicProviders }
        : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    // Per-call model hints (tier names like 'fast'/'haiku' or raw ids) are
    // deliberately IGNORED for pi: tiers have no universal pi mapping (the
    // provider half of the pattern decides the vocabulary), and honoring
    // arbitrary per-call patterns would open a per-call bypass surface on
    // the subscription guard. The construction-time pattern — already
    // guard-checked — governs every call. This mirrors the spec's rule that
    // the override is file-config-only, never per-call (§4.3).
    const result = await this.oneShot.evaluate(prompt, {
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const text = result.text.trim();
    if (!text) {
      throw new Error('pi CLI returned an empty completion');
    }
    return text;
  }
}
