/**
 * selectIntelligenceProvider — choose the shared LLM provider with subscription-by-default
 * safety guarantees.
 *
 * Rules:
 *   1. Anthropic API mode requires BOTH `intelligenceProvider: "anthropic-api"` AND
 *      `intelligenceProviderConfirmed: true` in config. Either one alone is rejected with
 *      a visible warning, and selection falls through to Claude CLI.
 *   2. With both flags set and an `ANTHROPIC_API_KEY` available, API mode engages and the
 *      caller is expected to render a billing banner (signaled via `apiModeActive`).
 *   3. If API mode is rejected (or never requested), Claude CLI is attempted next.
 *   4. If neither succeeds, the result is `provider: null, source: 'none'`. The caller
 *      degrades gracefully — there is NO silent fallback to the API even if an
 *      `ANTHROPIC_API_KEY` is present in the environment. The presence of the env key
 *      without explicit opt-in is reported via `apiKeyIgnored: true`.
 *
 * This is the single chokepoint where Instar's subscription-by-default principle is
 * enforced. Every other LLM-gated feature shares the provider this function returns.
 */

import type { IntelligenceProvider } from './types.js';

export interface IntelligenceSelectionInput {
  intelligenceProvider?: string;
  intelligenceProviderConfirmed?: boolean;
  anthropicApiKey?: string | undefined;
  claudePath?: string | undefined;
  buildClaude: (claudePath: string) => IntelligenceProvider | null;
  buildAnthropic: (apiKey: string) => IntelligenceProvider | null;
}

export type IntelligenceSource =
  | 'anthropic-api-confirmed'
  | 'claude-cli'
  | 'none';

export interface IntelligenceSelection {
  provider: IntelligenceProvider | null;
  source: IntelligenceSource;
  /** Human-readable warnings the caller should surface via console + degradation log. */
  warnings: string[];
  /** True iff API mode is the active, confirmed selection (caller should render billing banner). */
  apiModeActive: boolean;
  /** True iff ANTHROPIC_API_KEY was present in env but NOT used due to subscription-by-default. */
  apiKeyIgnored: boolean;
}

export function selectIntelligenceProvider(input: IntelligenceSelectionInput): IntelligenceSelection {
  const warnings: string[] = [];
  const wantsApi = input.intelligenceProvider === 'anthropic-api';
  const apiConfirmed = input.intelligenceProviderConfirmed === true;
  const hasKey = typeof input.anthropicApiKey === 'string' && input.anthropicApiKey.length > 0;

  // Step 1 — explicit, confirmed API opt-in.
  if (wantsApi && apiConfirmed) {
    if (hasKey) {
      const apiProvider = safeBuild(() => input.buildAnthropic(input.anthropicApiKey!));
      if (apiProvider) {
        return {
          provider: apiProvider,
          source: 'anthropic-api-confirmed',
          warnings,
          apiModeActive: true,
          apiKeyIgnored: false,
        };
      }
      warnings.push(
        'intelligenceProvider "anthropic-api" + intelligenceProviderConfirmed true set, ' +
          'but the Anthropic provider constructor returned null — falling back to Claude CLI.',
      );
    } else {
      warnings.push(
        'intelligenceProvider "anthropic-api" requested but ANTHROPIC_API_KEY not found in environment ' +
          '— falling back to Claude CLI.',
      );
    }
  } else if (wantsApi && !apiConfirmed) {
    // Strong guard: setting the provider name alone is not consent to spend.
    warnings.push(
      'intelligenceProvider "anthropic-api" is set but intelligenceProviderConfirmed is missing or false. ' +
        'API mode is DISABLED until both flags are explicitly set in config.json ' +
        '(Anthropic API charges per call). Using Claude CLI subscription instead.',
    );
  }

  // Step 2 — Claude CLI subscription (the default).
  if (input.claudePath) {
    const cliProvider = safeBuild(() => input.buildClaude(input.claudePath!));
    if (cliProvider) {
      return {
        provider: cliProvider,
        source: 'claude-cli',
        warnings,
        apiModeActive: false,
        apiKeyIgnored: hasKey && !wantsApi,
      };
    }
  }

  // Step 3 — neither path succeeded. Subscription-by-default: do NOT fall through
  // to the API "as a last resort." That was the old silent behaviour. Now we
  // surface the env-key-present case explicitly and degrade.
  if (hasKey && !wantsApi) {
    warnings.push(
      'ANTHROPIC_API_KEY detected in environment but intelligenceProvider is not set to "anthropic-api". ' +
        'Subscription-by-default: ignoring the key. To opt in to API mode, set BOTH ' +
        'intelligenceProvider: "anthropic-api" AND intelligenceProviderConfirmed: true in config.json.',
    );
  }

  return {
    provider: null,
    source: 'none',
    warnings,
    apiModeActive: false,
    apiKeyIgnored: hasKey && !wantsApi,
  };
}

function safeBuild<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
