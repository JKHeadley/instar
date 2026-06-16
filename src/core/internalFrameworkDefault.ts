/**
 * internalFrameworkDefault — the PROVIDER-FALLBACK DEFAULT POLICY
 * (docs/specs/provider-fallback-default-policy.md §4.1–4.2).
 *
 * Computes the effective `ComponentFrameworksConfig` that turns the already-shipped
 * IntelligenceRouter failure-swap engine ON out-of-the-box: internal, lightweight,
 * high-frequency categories (sentinel / gate / reflector) run on the FIRST ACTIVE
 * framework in a documented preference chain, with the remaining active frameworks
 * as the ordered `failureSwap` tail and Claude as the last resort.
 *
 * This is a PURE policy resolver — it does NOT probe the system. The caller passes
 * the already-computed active-framework set (probed once at boot via the router's
 * own `buildProvider(fw) !== null` truth — §4.2), so this module is unit-testable
 * in isolation.
 *
 * What it does NOT do (deliberate, per §4.1):
 *  - `job` is EXCLUDED — routing cost-bearing background jobs (e.g. CartographerSweep)
 *    off Claude by default would silently auto-arm them; an operator arms `categories.job`.
 *  - `other` is left on the agent default (unchanged).
 *  - Spawned interactive sessions stay on `topicFrameworks` (out of scope).
 */

import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import type { ComponentFrameworksConfig } from './IntelligenceRouter.js';

/**
 * The internal-component provider preference chain (§4.1 / §6.5). ONE named,
 * documented, inspectable place. Order: Codex first (operator directive), Claude
 * last (the true last resort for background work). A unit test validates every
 * entry against the real `IntelligenceFramework` enum so an unknown name never ships.
 */
export const INTERNAL_FRAMEWORK_PREFERENCE: readonly IntelligenceFramework[] = [
  'codex-cli',
  'pi-cli',
  'gemini-cli',
  'claude-code',
] as const;

/**
 * Compute the default `componentFrameworks` from the active-framework set.
 *
 * @param activeFrameworks the preference chain filtered to frameworks ACTIVE in this
 *   agent, IN PREFERENCE ORDER (the caller filters `INTERNAL_FRAMEWORK_PREFERENCE`
 *   by `buildProvider(fw) !== null`). MUST already be ordered + de-duplicated.
 * @returns the effective `ComponentFrameworksConfig`:
 *   - `categories.{sentinel,gate,reflector}` = `active[0]` (first active off-Claude,
 *     or claude-code if that's all that's active)
 *   - `failureSwap` = `active.slice(1)` (the ordered tail, claude-code last)
 *   - `fallback: 'default'`
 *
 * No-op cases (byte-identical to today — primary is the agent default, empty swap):
 *   - `active === []`               → `{ failureSwap: [], fallback: 'default' }`
 *   - `active === ['claude-code']`  → `{ failureSwap: [], fallback: 'default' }`
 *     (claude-code IS the default framework, so emitting it as the primary category
 *     value is harmless, but we leave categories unset to keep the no-op truly inert)
 */
export function resolveInternalFrameworkDefault(
  activeFrameworks: readonly IntelligenceFramework[],
): ComponentFrameworksConfig {
  const active = activeFrameworks;

  // No off-Claude provider active ⇒ a true no-op: no category routing, empty swap.
  // 'claude-code' alone means there is nothing to route OFF Claude onto, so the
  // policy is inert (matches §4.2 — never made worse, never spammed with degrades).
  if (active.length === 0 || (active.length === 1 && active[0] === 'claude-code')) {
    return { failureSwap: [], fallback: 'default' };
  }

  const primary = active[0];
  return {
    categories: {
      sentinel: primary,
      gate: primary,
      reflector: primary,
      // `job` and `other` are deliberately ABSENT (§4.1).
    },
    failureSwap: active.slice(1),
    fallback: 'default',
  };
}
