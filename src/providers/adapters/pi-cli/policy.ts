/**
 * pi-cli routing policy — the STRUCTURAL subscription guard
 * (PI-HARNESS-INTEGRATION-SPEC §4.3; Justin's additive-only constraint,
 * topic 20390, 2026-06-06).
 *
 * THE RULE: Claude work stays on Claude Code. Anthropic counts only Claude
 * Code itself against plan limits — a third-party harness like pi bills
 * Claude Pro/Max usage as per-token EXTRA USAGE. Routing an instar component
 * through pi onto an Anthropic provider would therefore silently convert
 * subscription-covered work into billed work. That must be structurally
 * impossible by default, not a configuration accident.
 *
 * Enforcement point: every pi call-construction path (one-shot transport,
 * RPC session start, intelligence provider) calls `assertPiProviderAllowed`
 * BEFORE spawning. The check is deliberately conservative: it denies any
 * model pattern that names Anthropic or Claude in ANY segment — including
 * pass-through aggregators (`openrouter/anthropic/claude-*`), which would
 * bill an API key and violate the no-API-keys rule from the other side.
 *
 * Override: `piCli.allowAnthropicProviders: true` in config — explicit,
 * file-based, never via env var or per-call parameter. Even when allowed,
 * the call is audit-logged with a cost warning so the spend is visible.
 * A false positive costs one explicit config line; a false negative costs
 * silent real money. Deny wins ties.
 */

import { PiAnthropicRouteError } from './errors.js';

/**
 * Segments that mark a model pattern as routing to Anthropic/Claude.
 * Matched case-insensitively against `/`-, `:`- and whitespace-delimited
 * segments of the pattern, AND as a substring of the model id segment
 * (Claude model ids embed the name, e.g. `claude-sonnet-4-6`).
 */
const DENIED_NEEDLES = ['anthropic', 'claude'] as const;

/**
 * Decide whether a pi `--model` pattern (a `provider/id` string, a bare
 * model id, or pi's pattern syntax with an optional `:<thinking>` suffix)
 * routes to an Anthropic/Claude target.
 *
 * Exported for tests; production callers use `assertPiProviderAllowed`.
 */
export function isAnthropicRoutedModelPattern(modelPattern: string | undefined): boolean {
  if (!modelPattern) {
    // No explicit model → pi falls back to ITS OWN configured default
    // provider/model, which we cannot see from here. The conservative floor
    // is enforced at the config layer instead: adapter configs must pin a
    // model; the intelligence provider refuses to run without one. Treating
    // undefined as allowed here would let pi's ambient default (potentially
    // an Anthropic login from interactive use) leak through — so undefined
    // is DENIED at this gate too. Callers that legitimately want pi's
    // default must resolve it to an explicit pattern first.
    return true;
  }
  const lower = modelPattern.toLowerCase();
  return DENIED_NEEDLES.some((needle) => lower.includes(needle));
}

/**
 * Throw `PiAnthropicRouteError` when the model pattern routes to Anthropic
 * and the explicit override is not set. On an allowed-by-override call, the
 * audit logger is invoked so the extra-usage spend stays visible.
 */
export function assertPiProviderAllowed(
  modelPattern: string | undefined,
  options: {
    allowAnthropicProviders?: boolean;
    /** Audit sink for override-allowed calls. Defaults to console.warn. */
    auditLog?: (line: string) => void;
  } = {},
): void {
  if (!isAnthropicRoutedModelPattern(modelPattern)) {
    return;
  }
  if (options.allowAnthropicProviders === true) {
    const audit = options.auditLog ?? ((line: string) => console.warn(line));
    audit(
      `[pi-cli policy] ALLOWED Anthropic-routed pi call by explicit override ` +
      `(piCli.allowAnthropicProviders=true): model=${modelPattern ?? '<pi-default>'} — ` +
      `NOTE: this bills as Anthropic extra usage (per-token), NOT plan limits.`,
    );
    return;
  }
  throw new PiAnthropicRouteError(modelPattern);
}
