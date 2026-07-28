/**
 * pi-cli adapter — entry point (PI-HARNESS-INTEGRATION-SPEC §4.2).
 *
 * Mirrors the gemini-cli/openai-codex adapter shape: a factory that builds an
 * `impls` map and returns a `ProviderAdapter`. Declares the honest capability
 * floor (capabilities.ts) — every wired primitive was verified hands-on in
 * the P0.1 eval (pi 0.78.1, docs/specs/_drafts/pi-eval-report.md).
 *
 * THE GUARD (spec §4.3): both transports enforce `assertPiProviderAllowed`
 * at call/session construction — an Anthropic/Claude-routed model pattern
 * throws `PiAnthropicRouteError` unless `allowAnthropicProviders` is
 * explicitly set in config (and even then it is audit-logged). A config with
 * NO model pinned is also denied at call time: pi's ambient default model
 * could be an Anthropic login from interactive use, so explicitness is the
 * floor. Justin's additive-only constraint, enforced structurally.
 *
 * Registration: `registerPiAdapters()` (bootRegistration.ts) — gated on
 * `enabledFrameworks` containing 'pi-cli' AND the binary being detectable.
 * Ships dark: no opt-in, no registration, zero behavior change.
 *
 * Usage:
 *
 *   import { createPiCliAdapter } from './providers/adapters/pi-cli/index.js';
 *   import { registry } from './providers/registry.js';
 *
 *   await registry.register(createPiCliAdapter({ model: 'openai-codex/gpt-5.5' }));
 */

import type { CapabilityFlag } from '../../capabilities.js';
import type { ProviderAdapter } from '../../registry.js';
import { UnsupportedCapabilityError } from '../../errors.js';
import { piCliCapabilities } from './capabilities.js';
import { PI_CLI_ID } from './errors.js';
import { configFromEnv, type PiCliConfig } from './config.js';

import { createOneShotCompletion } from './transport/oneShotCompletion.js';
import { createPiAgenticSessionRpc } from './transport/agenticSessionRpc.js';
import { createSessionId } from './observability/sessionId.js';
import { createHardKill } from './control/piHardKill.js';

import { CapabilityFlag as Cap } from '../../capabilities.js';

/**
 * Create the pi-cli adapter with the given config (or environment defaults
 * if omitted).
 */
export function createPiCliAdapter(
  partialConfig: Partial<PiCliConfig> = {},
): ProviderAdapter {
  const config: PiCliConfig = {
    ...configFromEnv(),
    ...partialConfig,
  };

  const impls = new Map<CapabilityFlag, unknown>();

  // Transport
  impls.set(Cap.OneShotCompletion, createOneShotCompletion(config));
  impls.set(Cap.AgenticSessionRpc, createPiAgenticSessionRpc(config));

  // Observability
  impls.set(Cap.SessionId, createSessionId());

  // Control
  impls.set(Cap.HardKill, createHardKill());

  return {
    id: PI_CLI_ID,
    capabilities: piCliCapabilities,
    primitive(capability: CapabilityFlag): unknown {
      const impl = impls.get(capability);
      if (impl === undefined) {
        throw new UnsupportedCapabilityError(capability, PI_CLI_ID);
      }
      return impl;
    },
  };
}

export type { PiCliConfig } from './config.js';
export { configFromEnv } from './config.js';
export { PI_CLI_ID, PiAnthropicRouteError } from './errors.js';
export { assertPiProviderAllowed, isAnthropicRoutedModelPattern } from './policy.js';
