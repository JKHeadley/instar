/**
 * intelligenceProviderFactory — pick the right IntelligenceProvider
 * implementation for a configured framework.
 *
 * Provider-portability v1.0.0: until v0.x, ClaudeCliIntelligenceProvider
 * was the ONLY implementation, and every reviewer/sentinel/canary
 * routed through `claude -p`. This factory lets the composition root
 * pick `claude-code`, `codex-cli`, or another framework's implementation
 * at startup based on `INSTAR_FRAMEWORK` env var or the agent's
 * configured `primaryFramework`.
 *
 * When the configured framework's binary isn't installed, the factory
 * returns null. The composition root decides whether that's a fatal
 * error or a "fall back to whatever IS installed" situation.
 */

import type { IntelligenceProvider } from './types.js';
import { detectClaudePath, detectCodexPath, detectGeminiPath } from './Config.js';
import { ClaudeCliIntelligenceProvider } from './ClaudeCliIntelligenceProvider.js';
import { CodexCliIntelligenceProvider } from './CodexCliIntelligenceProvider.js';
import { GeminiCliIntelligenceProvider } from './GeminiCliIntelligenceProvider.js';
import { wrapIntelligenceWithCircuitBreaker } from './CircuitBreakingIntelligenceProvider.js';
import type { LlmCircuitBreaker } from './LlmCircuitBreaker.js';
import {
  AnthropicSubscriptionRouter,
  type SubscriptionPathMode,
  type SubscriptionRouteInfo,
  type SubscriptionDegradeInfo,
} from './AnthropicSubscriptionRouter.js';
import { InteractivePoolIntelligenceProvider } from './InteractivePoolIntelligenceProvider.js';
import type { ProviderAdapter } from '../providers/registry.js';
import type { AgentSdkCreditSnapshot } from '../providers/primitives/observability/usageMeterProvider.js';

/**
 * Stable framework identifiers the factory recognizes. Adding a new
 * framework requires (a) extending this union and (b) wiring up a case
 * in `buildIntelligenceProvider`.
 *
 * NOTE (apprenticeship Step 2): extending this union is the ONLY
 * compiler-forced wiring — it forces the `never`-exhaustive switch below
 * and every `Record<IntelligenceFramework, …>` map. The ~10 parallel
 * hardcoded `'claude-code' | 'codex-cli'` unions across the tree are NOT
 * related to this type by the compiler; they are a hand-audit checklist
 * (see APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC §4.3).
 */
export type IntelligenceFramework = 'claude-code' | 'codex-cli' | 'gemini-cli';

export interface BuildIntelligenceProviderOptions {
  /**
   * Which framework's CLI to route through. Defaults to 'claude-code'
   * for backwards-compat — v0.x behavior is preserved when the field
   * is unset.
   */
  framework?: IntelligenceFramework;
  /**
   * Explicit binary path override. When unset, detection runs.
   */
  binaryPath?: string;
  /**
   * Optional working directory (currently used only by Codex).
   */
  workingDirectory?: string;
  /**
   * Optional circuit breaker to wrap the provider with. When omitted, the
   * account-global singleton is used (today's behavior). The IntelligenceRouter
   * passes a DISTINCT breaker per framework so per-framework rate-limit isolation
   * actually holds (docs/specs/per-component-framework-routing.md, D3).
   */
  breaker?: LlmCircuitBreaker;
  /**
   * Optional quota-state path for providers whose live capacity signal is only
   * available after invoking the CLI. Currently used by gemini-cli to persist
   * CLI-reported usage-limit windows into the existing quota gate.
   */
  quotaStateFile?: string;
  /**
   * Anthropic subscription-path routing (June-15 readiness, spec 04 Rule 1).
   * claude-code framework only; ignored for codex/gemini. When present, the
   * ClaudeCliIntelligenceProvider is wrapped in an AnthropicSubscriptionRouter
   * (SDK-credit `claude -p` ⟷ interactive REPL pool) BEFORE the circuit
   * breaker. When absent (config mode 'off' / unset), the claude-code path is
   * byte-for-byte today's behavior.
   */
  subscriptionPath?: {
    mode: SubscriptionPathMode;
    /** The registered anthropic-interactive-pool adapter (bootRegistration). */
    poolAdapter: ProviderAdapter;
    /** Real credit reader (bootRegistration.buildReadSdkCredit). */
    readSdkCredit: () => Promise<AgentSdkCreditSnapshot | null>;
    safetyMarginFraction?: number;
    onRoute?: (info: SubscriptionRouteInfo) => void;
    onDegrade?: (info: SubscriptionDegradeInfo) => void;
  };
}

/**
 * Build an IntelligenceProvider for the given framework. Returns null
 * if the required binary can't be located. The caller decides what
 * happens next — fatal error, fall-back to a different framework, or
 * disable LLM-backed paths entirely.
 *
 * @example
 *   const intel = buildIntelligenceProvider({ framework: 'codex-cli' });
 *   if (intel === null) {
 *     console.warn('Codex CLI not found — LLM-backed paths disabled.');
 *   }
 */
export function buildIntelligenceProvider(
  options: BuildIntelligenceProviderOptions = {},
): IntelligenceProvider | null {
  const framework = options.framework ?? 'claude-code';

  // Every provider the factory hands out is wrapped with the account-global
  // LLM circuit breaker (CircuitBreakingIntelligenceProvider). A closed breaker
  // is a transparent passthrough, so this is always safe; it only acts when the
  // provider reports a usage/rate limit. See LlmCircuitBreaker for the why.
  switch (framework) {
    case 'claude-code': {
      const path = options.binaryPath ?? detectClaudePath();
      if (!path) return null;
      const headless = new ClaudeCliIntelligenceProvider(path);
      // Subscription-path routing (spec 04 Rule 1): when configured, route
      // each call between the SDK-credit `claude -p` path and the
      // subscription interactive pool. The router sits INSIDE the breaker
      // wrap so a rate-limit on the surviving path still trips the breaker.
      // Absent option ⇒ plain provider, byte-for-byte today's behavior.
      if (options.subscriptionPath) {
        const sp = options.subscriptionPath;
        const routed = new AnthropicSubscriptionRouter({
          headless,
          pool: new InteractivePoolIntelligenceProvider(sp.poolAdapter),
          mode: sp.mode,
          readSdkCredit: sp.readSdkCredit,
          ...(sp.safetyMarginFraction !== undefined
            ? { safetyMarginFraction: sp.safetyMarginFraction }
            : {}),
          ...(sp.onRoute ? { onRoute: sp.onRoute } : {}),
          ...(sp.onDegrade ? { onDegrade: sp.onDegrade } : {}),
        });
        return wrapIntelligenceWithCircuitBreaker(routed, options.breaker);
      }
      return wrapIntelligenceWithCircuitBreaker(headless, options.breaker);
    }
    case 'codex-cli': {
      const path = options.binaryPath ?? detectCodexPath();
      if (!path) return null;
      return wrapIntelligenceWithCircuitBreaker(
        new CodexCliIntelligenceProvider({
          codexPath: path,
          ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
        }),
        options.breaker,
      );
    }
    case 'gemini-cli': {
      const path = options.binaryPath ?? detectGeminiPath();
      if (!path) return null;
      return wrapIntelligenceWithCircuitBreaker(
        new GeminiCliIntelligenceProvider({
          geminiPath: path,
          ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
          ...(options.quotaStateFile ? { capacityPolicy: { quotaStateFile: options.quotaStateFile } } : {}),
        }),
        options.breaker,
      );
    }
    default: {
      // Exhaustiveness check — extending IntelligenceFramework without
      // adding a case here is a type error.
      const _exhaustive: never = framework;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Convenience: read the framework selection from the environment.
 * Returns null when no framework is explicitly selected, leaving
 * the caller to apply the default (`claude-code`) or its own logic.
 */
export function frameworkFromEnv(env: NodeJS.ProcessEnv = process.env): IntelligenceFramework | null {
  const raw = env['INSTAR_FRAMEWORK']?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'claude-code' || raw === 'claude') return 'claude-code';
  if (raw === 'codex-cli' || raw === 'codex') return 'codex-cli';
  if (raw === 'gemini-cli' || raw === 'gemini') return 'gemini-cli';
  return null;
}
