/**
 * devGatedFeatures.ts — the registry of features that follow the
 * standard_development_agent_dark_feature_gate convention: config OMITS
 * `enabled`, the runtime resolves it via `resolveDevAgentGate` (live on a
 * development agent, dark on the fleet).
 *
 * WHY (DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC, Slice 2): Slice 1's lint catches a
 * hand-rolled gate and a hardcoded `enabled: false` under a marker comment, but
 * it cannot prove that a feature's *actual config + construction* resolves live
 * on a dev agent. This registry drives the both-sides wiring test
 * (`tests/unit/devGatedFeatures-wiring.test.ts`): for each entry, the REAL
 * ConfigDefaults are applied and `resolveDevAgentGate(<configPath>)` must be
 * true under a dev-agent config and false under a fleet config. A feature whose
 * default hardcodes `enabled: false` (the literal #1001 mechanism — `applyDefaults`
 * would inject the `false`) fails the test. Adding a dev-gated feature here is
 * the natural checklist step; the test then guards it permanently.
 *
 * NOT every site that calls `resolveDevAgentGate` belongs here — only features
 * whose intent is "dark fleet / LIVE on dev". Deliberately EXCLUDED:
 *   - `monitoring.mcpProcessReaper` — destructive (kills processes); ships OFF +
 *     dry-run for EVERYONE incl. dev agents by design (`enabled: false` default).
 *   - `monitoring.resourceLedger` — the ledger itself defaults `enabled: true`
 *     (on for everyone); only its sampling rides the gate off the same key, so
 *     it is not cleanly a dark-on-fleet feature.
 */

/** A feature governed by the developmentAgent dark-feature gate. */
export interface DevGatedFeature {
  /** Stable identifier (matches the feature's name in code/docs). */
  name: string;
  /** Dotted path to the feature's `enabled` flag in the agent config. */
  configPath: string;
  /** One-line description of what runs live on a dev agent. */
  description: string;
}

export const DEV_GATED_FEATURES: DevGatedFeature[] = [
  {
    name: 'growthAnalyst',
    configPath: 'monitoring.growthAnalyst.enabled',
    description: 'Proactive growth & milestone analyst (/growth/*).',
  },
  {
    name: 'coherenceJournal',
    configPath: 'multiMachine.coherenceJournal.enabled',
    description: 'Cross-machine coherence journal.',
  },
  {
    name: 'warmSessionA2A',
    configPath: 'threadline.warmSessionA2A.enabled',
    description: 'Warm-session pool for agent-to-agent delivery.',
  },
  {
    name: 'secretSync',
    configPath: 'multiMachine.secretSync.enabled',
    description: 'Cross-machine secret sync (receive side).',
  },
  {
    name: 'geminiLoopDriver',
    configPath: 'autonomousSessions.geminiLoopDriver.enabled',
    description: 'Gemini autonomous-loop driver.',
  },
  {
    name: 'respawnBuildContext',
    configPath: 'sessions.respawnBuildContext.enabled',
    description: 'Respawn build-context capture on session restart.',
  },
  {
    name: 'selfKnowledgeSessionContext',
    configPath: 'selfKnowledge.sessionContext.enabled',
    description: 'Session-boot self-knowledge context injection.',
  },
];

/**
 * Read a dotted path off a config object, returning the value or undefined.
 * Used by the wiring test and the spec-intent cross-check (Slice 3).
 */
export function getConfigByPath(config: unknown, dottedPath: string): unknown {
  let cur: unknown = config;
  for (const key of dottedPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
