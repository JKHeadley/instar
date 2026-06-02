/**
 * gemini-cli adapter — entry point (MINIMAL BODY, apprenticeship Step 2).
 *
 * Mirrors the openai-codex adapter shape (a factory that builds an `impls`
 * map and returns a `ProviderAdapter`), but declares a SMALLER, honest
 * capability set for the minimal body. Only the MANDATORY floor is wired:
 * OneShotCompletion, SessionId, HardKill. The CONDITIONAL primitives
 * (HookEventReceiver / CompactionLifecycle / SessionResumeIndex) are NOT
 * wired here — their live contract is uncharacterized, so shipping them
 * half-built would be a capability-declaration lie (tracked as `programNeeds`
 * need-gem-001 instead).
 *
 * DORMANCY: this registry adapter is the parity-harness / future-routing
 * surface — `server.ts` registers no adapters against the production registry.
 * The ALIVE transport runs through `GeminiCliIntelligenceProvider`
 * (src/core/), constructed by `buildIntelligenceProvider`. This adapter and
 * that class share the one-shot transport, but the alive proof flows through
 * the class, not this registry.
 *
 * Usage:
 *
 *   import { createGeminiCliAdapter } from
 *     './providers/adapters/gemini-cli/index.js';
 *   import { registry } from './providers/registry.js';
 *
 *   await registry.register(createGeminiCliAdapter({ ... }));
 */

import type { CapabilityFlag } from '../../capabilities.js';
import type { ProviderAdapter } from '../../registry.js';
import { UnsupportedCapabilityError } from '../../errors.js';
import { geminiCliCapabilities } from './capabilities.js';
import { GEMINI_CLI_ID } from './errors.js';
import { configFromEnv, type GeminiCliConfig } from './config.js';

import { createOneShotCompletion } from './transport/oneShotCompletion.js';
import { createSessionId } from './observability/sessionId.js';
import { createHardKill } from './control/geminiHardKill.js';

import { CapabilityFlag as Cap } from '../../capabilities.js';

/**
 * Create the gemini-cli adapter with the given config (or environment
 * defaults if omitted).
 */
export function createGeminiCliAdapter(
  partialConfig: Partial<GeminiCliConfig> = {},
): ProviderAdapter {
  const config: GeminiCliConfig = {
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
    id: GEMINI_CLI_ID,
    capabilities: geminiCliCapabilities,
    primitive(capability: CapabilityFlag): unknown {
      const impl = impls.get(capability);
      if (impl === undefined) {
        throw new UnsupportedCapabilityError(capability, GEMINI_CLI_ID);
      }
      return impl;
    },
  };
}

export type { GeminiCliConfig } from './config.js';
export { configFromEnv } from './config.js';
export { GEMINI_CLI_ID } from './errors.js';
