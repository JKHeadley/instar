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
 * The LATENCY-SENSITIVE preference chain — used for the `gate` category ONLY.
 *
 * A `gate` is a SYNCHRONOUS, action-blocking check (the user-facing
 * `MessagingToneGate` is the canonical one — a human is waiting for their reply).
 * The general `INTERNAL_FRAMEWORK_PREFERENCE` puts `codex-cli` first by operator
 * directive (spread background LOAD off Claude), but codex-cli is the SLOWEST
 * off-Claude framework (~30s, which exceeds the 20s outbound-gate review budget
 * and times the gate out — the 2026-06-25 silent-outbound class). For a
 * latency-sensitive gate the right default is the FASTEST available off-Claude
 * framework, not the load-spreading order. Ranked fastest→slowest, Claude last.
 *
 * This does NOT override the codex-first directive for the BACKGROUND categories
 * (`sentinel` / `reflector`) — their latency does not block a human, so they keep
 * the load-spreading order. Only `gate` (where a user waits) goes fastest-first.
 */
export const LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE: readonly IntelligenceFramework[] = [
  'pi-cli',
  'gemini-cli',
  'codex-cli',
  'claude-code',
] as const;

/** The first framework in `order` that is also present in `active`, else undefined. */
function firstActiveIn(
  order: readonly IntelligenceFramework[],
  active: readonly IntelligenceFramework[],
): IntelligenceFramework | undefined {
  return order.find((fw) => active.includes(fw));
}

/**
 * Compute the default `componentFrameworks` from the active-framework set.
 *
 * @param activeFrameworks the preference chain filtered to frameworks ACTIVE in this
 *   agent, IN PREFERENCE ORDER (the caller filters `INTERNAL_FRAMEWORK_PREFERENCE`
 *   by `buildProvider(fw) !== null`). MUST already be ordered + de-duplicated.
 * @returns the effective `ComponentFrameworksConfig`:
 *   - `categories.{sentinel,reflector}` = `active[0]` (first active off-Claude in the
 *     codex-first load-spreading order, or claude-code if that's all that's active)
 *   - `categories.gate` = the FASTEST active off-Claude framework
 *     (`LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE`: pi → gemini → codex → claude) — the
 *     gate is synchronous + user-blocking, so it prefers speed over load-spreading.
 *     Equals `active[0]` when only one off-Claude framework is active (no-op then).
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
  // The `gate` category is LATENCY-SENSITIVE: a synchronous, user-blocking check.
  // It gets the FASTEST active off-Claude framework (pi → gemini → codex → claude),
  // NOT the load-spreading codex-first order. `active` is in INTERNAL_FRAMEWORK_
  // PREFERENCE order, so we re-rank it by the latency order to find the fastest.
  // Falls back to `primary` if (somehow) no latency-ranked match — keeping the gate
  // never worse than today. When only one off-Claude framework is active, gatePrimary
  // === primary (byte-identical to the old behavior).
  const gatePrimary = firstActiveIn(LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE, active) ?? primary;
  return {
    categories: {
      sentinel: primary,
      gate: gatePrimary,
      reflector: primary,
      // `job` and `other` are deliberately ABSENT (§4.1).
    },
    failureSwap: active.slice(1),
    fallback: 'default',
  };
}
