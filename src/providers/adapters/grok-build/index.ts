/**
 * grok-build adapter — entry point (grok-build framework integration spec).
 *
 * Mirrors the pi-cli/gemini-cli/openai-codex adapter shape: a factory that
 * builds an `impls` map and returns a `ProviderAdapter`. Declares the honest
 * capability floor (capabilities.ts) — OneShotCompletion + SessionId +
 * HardKill; the ACP face is deliberately NOT declared until its contracts
 * are probed (spec §4.2).
 *
 * THE BILLING GUARD (spec §3.1): the one-shot transport enforces
 * `assertGrokAuthAllowed` at call construction — an API/deployment key in
 * the environment, a missing auth file, or an expired session refuses the
 * call BEFORE any spawn. Subscription-session billing is the only allowed
 * path; the vendor-side `disable_api_key_auth` login policy (§3.1.1) is the
 * primary control and this is the second layer.
 *
 * Registration: `registerGrokBuildAdapters()` (bootRegistration.ts) — gated
 * on `enabledFrameworks` containing 'grok-build' AND the binary being
 * detectable. Ships dark: no opt-in, no registration, zero behavior change.
 */

import type { CapabilityFlag } from '../../capabilities.js';
import type { ProviderAdapter } from '../../registry.js';
import { UnsupportedCapabilityError } from '../../errors.js';
import { grokBuildCapabilities } from './capabilities.js';
import { GROK_BUILD_ID } from './errors.js';
import { configFromEnv, type GrokBuildConfig } from './config.js';

import { createOneShotCompletion } from './transport/oneShotCompletion.js';
import { createSessionId } from './observability/sessionId.js';
import { createHardKill } from './control/grokHardKill.js';

import { CapabilityFlag as Cap } from '../../capabilities.js';

/**
 * Create the grok-build adapter with the given config (or environment
 * defaults if omitted).
 */
export function createGrokBuildAdapter(
  partialConfig: Partial<GrokBuildConfig> = {},
): ProviderAdapter {
  const config: GrokBuildConfig = {
    ...configFromEnv(),
    ...partialConfig,
  };

  const impls = new Map<CapabilityFlag, unknown>();

  // Transport
  impls.set(Cap.OneShotCompletion, createOneShotCompletion(config));

  // Observability
  impls.set(Cap.SessionId, createSessionId());

  // Control
  impls.set(Cap.HardKill, createHardKill());

  return {
    id: GROK_BUILD_ID,
    capabilities: grokBuildCapabilities,
    primitive(capability: CapabilityFlag): unknown {
      const impl = impls.get(capability);
      if (impl === undefined) {
        throw new UnsupportedCapabilityError(capability, GROK_BUILD_ID);
      }
      return impl;
    },
  };
}

export type { GrokBuildConfig } from './config.js';
export { configFromEnv, resolveGrokHome, grokAuthPath } from './config.js';
export {
  GROK_BUILD_ID,
  GrokApiKeyForbiddenError,
  GrokSessionExpiredError,
  GrokLoginPolicyUnverifiedError,
} from './errors.js';
export {
  assertGrokAuthAllowed,
  readSessionExpiry,
  GROK_FORBIDDEN_ENV_VARS,
} from './policy.js';
