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

/**
 * Resolve the developmentAgent dark-feature gate across the multiMachine.stateSync
 * per-store map, returning a NEW stores map where each store's `enabled` is the
 * gate-RESOLVED boolean (the raw `enabled` ?? `!!developmentAgent`), preserving
 * every other per-store field (e.g. `dryRun`).
 *
 * WHY (operator directive 2026-06-13, topic 13481): the 7 stateSync memory stores
 * were moved from DARK_GATE_EXCLUSIONS to DEV_GATED_FEATURES so they run LIVE on a
 * dev agent and DARK on the fleet. Their ConfigDefaults OMIT `enabled` so the gate
 * decides — but the four consumer funnels (selfStateSyncReceive,
 * ReplicatedStoreReader.isLive, isStoreEmissionEnabled, checkPoolFlagCoherence) read
 * `stores[store].enabled === true` DIRECTLY off config, which would see `undefined`
 * and stay dark even on a dev agent. Routing the config through this helper ONCE at
 * the construction boundary makes the gate genuinely flip them live without changing
 * any funnel's `enabled === true` semantics (they receive a pre-resolved map). An
 * explicit `enabled` in config still wins (force-dark false / fleet-flip true).
 */
export function resolveStateSyncStores(
  config: { developmentAgent?: boolean; multiMachine?: { stateSync?: Record<string, { enabled?: boolean } & Record<string, unknown>> } } | undefined,
): Record<string, { enabled?: boolean } & Record<string, unknown>> | undefined {
  const stores = config?.multiMachine?.stateSync;
  if (!stores) return undefined;
  const out: Record<string, { enabled?: boolean } & Record<string, unknown>> = {};
  for (const [store, flags] of Object.entries(stores)) {
    if (flags == null || typeof flags !== 'object') {
      // Preserve non-store foundation knobs (numbers like maxDriftMs) untouched.
      out[store] = flags as { enabled?: boolean } & Record<string, unknown>;
      continue;
    }
    out[store] = { ...flags, enabled: resolveDevAgentGate(flags.enabled, config) };
  }
  return out;
}
