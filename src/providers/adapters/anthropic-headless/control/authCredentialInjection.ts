/**
 * AuthCredentialInjection: builds portable credential specs.
 *
 * Validation includes the Anthropic-specific format check
 * (sk-ant-oat... for OAuth, sk-ant-api... for API keys). Probe makes a
 * lightweight Messages API call to verify the credential.
 */

import type {
  AuthCredentialInjection,
  AuthCredentialSpec,
  ProviderCredential,
} from '../../../primitives/control/authCredentialInjection.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AuthError } from '../../../errors.js';
import type { AnthropicHeadlessConfig } from '../config.js';
import { ANTHROPIC_HEADLESS_ID, mapApiError } from '../errors.js';
import { ANTHROPIC_MODELS } from '../../../../core/models.js';

class AnthropicHeadlessAuthCredentialInjection implements AuthCredentialInjection {
  readonly capability = CapabilityFlag.AuthCredentialInjection;

  constructor(private readonly _config: AnthropicHeadlessConfig) {}

  buildSpec(credential: ProviderCredential): AuthCredentialSpec {
    return { __brand: 'AuthCredentialSpec', credential } as AuthCredentialSpec;
  }

  validate(credential: ProviderCredential): string | null {
    if (credential.kind === 'none') {
      return 'anthropic-headless requires credentials; got "none"';
    }
    if (credential.kind === 'bearer') {
      return 'anthropic-headless does not accept bearer tokens; use oauth-subscription or api-key';
    }
    if (credential.kind === 'oauth-subscription') {
      if (!credential.token.startsWith('sk-ant-oat')) {
        return 'OAuth subscription token must start with "sk-ant-oat"';
      }
      return null;
    }
    if (credential.kind === 'api-key') {
      if (!credential.key.startsWith('sk-ant-api')) {
        return 'API key must start with "sk-ant-api"';
      }
      return null;
    }
    return 'unknown credential kind';
  }

  /**
   * RULE 3.1 RATIONALE (state-detection: credential-validity probe)
   * - Criticality: minor-degradation. A wrong verdict surfaces as a loud
   *   AuthError (or a later loud auth failure downstream) — never silent
   *   corruption; the probe is a pre-check convenience, not the authority.
   * - Frequency: per-enrollment / per-verification event (rare).
   * - Stability: very-stable — official public Messages-API HTTP status
   *   semantics (401/403 for bad credentials), not a scraped surface.
   * - Fallback: every downstream call with the credential fails loudly on
   *   its own; mapApiError classifies non-ok statuses.
   * - → Verdict: deterministic, exempt-from-canary (stable public API
   *   contract + loud failure path). Registry row: 06-state-detector-registry.md.
   */
  async probe(credential: ProviderCredential): Promise<void> {
    const validation = this.validate(credential);
    if (validation) {
      throw new AuthError(validation, ANTHROPIC_HEADLESS_ID);
    }
    if (credential.kind !== 'oauth-subscription' && credential.kind !== 'api-key') {
      throw new AuthError('Cannot probe non-Anthropic credential', ANTHROPIC_HEADLESS_ID);
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (credential.kind === 'api-key') {
      headers['x-api-key'] = credential.key;
    } else {
      headers['Authorization'] = `Bearer ${credential.token}`;
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        // Config-overridable (risk item #7); default sourced from the
        // models.ts tier map, not a string literal — the probe only needs
        // the cheapest valid model on the account.
        model: this._config.credentialProbeModel?.trim() || ANTHROPIC_MODELS.haiku,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw mapApiError(response.status, body);
    }
  }
}

export function createAuthCredentialInjection(
  config: AnthropicHeadlessConfig,
): AuthCredentialInjection {
  return new AnthropicHeadlessAuthCredentialInjection(config);
}
