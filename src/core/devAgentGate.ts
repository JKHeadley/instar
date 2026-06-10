/**
 * devAgentGate.ts — the single funnel for the developmentAgent dark-feature gate
 * (standard_development_agent_dark_feature_gate).
 *
 * A "development-agent dark feature" ships DARK for the fleet but runs LIVE on
 * development agents (the dogfooding ground). The canonical resolution is:
 *
 *     enabled = explicitEnabled ?? !!config.developmentAgent
 *
 * Convention (see src/config/ConfigDefaults.ts and src/core/types.ts):
 *   - The config default OMITS `enabled` so the gate decides at runtime.
 *   - On a `developmentAgent: true` agent → LIVE.
 *   - On the fleet → DARK until explicitly flipped on.
 *   - An explicit `enabled` in config ALWAYS wins (false force-darks even a dev
 *     agent; true is the fleet-flip).
 *
 * WHY A FUNNEL: PR #1001 (GrowthMilestoneAnalyst) hardcoded `enabled: false` in
 * the config default instead of omitting it, so the feature shipped dark for
 * EVERYONE — dev agents included — silently contradicting this standard. It was
 * caught only by operator review. Routing every dev-gate resolution through this
 * one helper makes the correct behavior uniform and greppable, and lets
 * `scripts/lint-dev-agent-dark-gate.js` ban hand-rolled resolutions that could
 * drift. Spec: docs/specs/DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC.md.
 */

/** The minimal shape this gate reads off the agent config. */
export interface DevAgentGateConfig {
  developmentAgent?: boolean;
}

/**
 * Resolve a development-agent dark-feature flag.
 *
 * @param explicitEnabled the feature's explicit config value (`cfg?.enabled`),
 *   or `undefined` when the config omits it (the expected default).
 * @param config the agent config (only `developmentAgent` is read).
 * @returns the explicit value when set, otherwise `true` on a dev agent and
 *   `false` on the fleet.
 */
export function resolveDevAgentGate(
  explicitEnabled: boolean | undefined,
  config: DevAgentGateConfig | undefined,
): boolean {
  return explicitEnabled ?? !!config?.developmentAgent;
}
