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
  /**
   * One-line "non-destructive, safe-to-run-live-on-dev" rationale. REQUIRED on
   * every entry (DEV-AGENT-DARK-GATE-ENFORCEMENT Slice B): the human gate is the
   * real backstop — dev-gating a feature live means it runs unattended on the dev
   * agent, so each entry must carry an explicit justification a CODEOWNERS reviewer
   * can check. A destructive/cost-bearing feature does NOT belong here.
   */
  justification: string;
}

export const DEV_GATED_FEATURES: DevGatedFeature[] = [
  {
    name: 'growthAnalyst',
    configPath: 'monitoring.growthAnalyst.enabled',
    description: 'Proactive growth & milestone analyst (/growth/*).',
    justification: 'Read/observe analyst; sends nothing by default (digestDelivery off); no destructive action, no spend.',
  },
  {
    name: 'coherenceJournal',
    configPath: 'multiMachine.coherenceJournal.enabled',
    description: 'Cross-machine coherence journal.',
    justification: 'Append-only local journal of content-free lifecycle events; no egress, no spend, no destructive action.',
  },
  {
    name: 'warmSessionA2A',
    configPath: 'threadline.warmSessionA2A.enabled',
    description: 'Warm-session pool for agent-to-agent delivery.',
    justification: 'Bounded warm-session pool (global/per-peer caps + TTL); no destructive action, no third-party spend.',
  },
  {
    name: 'secretSync',
    configPath: 'multiMachine.secretSync.enabled',
    description: 'Cross-machine secret sync (receive side).',
    justification: 'Receive-only by default (push needs pushEnabled); encrypted-per-peer; no destructive action, no spend.',
  },
  {
    name: 'geminiLoopDriver',
    configPath: 'autonomousSessions.geminiLoopDriver.enabled',
    description: 'Gemini autonomous-loop driver.',
    justification: 'Drives the dev agent\'s own autonomous loop; bounded, no destructive action against the source tree.',
  },
  {
    name: 'respawnBuildContext',
    configPath: 'sessions.respawnBuildContext.enabled',
    description: 'Respawn build-context capture on session restart.',
    justification: 'Captures build context on restart; read-only observability, no destructive action, no spend.',
  },
  {
    name: 'selfKnowledgeSessionContext',
    configPath: 'selfKnowledge.sessionContext.enabled',
    description: 'Session-boot self-knowledge context injection.',
    justification: 'Injects vault secret NAMES (never values) + facts at boot; read-only, no egress, no destructive action.',
  },
  {
    name: 'cartographer',
    configPath: 'cartographer.enabled',
    description: 'Cartographer doc-tree + navigation read surfaces (zero egress).',
    justification: 'Read-only local-index surfaces; no egress, no spend.',
  },
  {
    name: 'cartographerConformanceAudit',
    configPath: 'cartographer.conformanceAudit.enabled',
    description: 'Standards enforcement-coverage audit (deterministic, zero egress).',
    justification: 'Deterministic local audit; no LLM, no egress, no spend.',
  },
  {
    name: 'blockerLedger',
    configPath: 'monitoring.blockerLedger.enabled',
    description: 'Blocker Ledger — resolution pipeline + memory for Principle 1 (/blockers/*).',
    justification: 'Signal-only local recorder (never blocks a message); file-JSON state, no egress, no destructive action; the only LLM use is one bounded (<=200-token) fail-closed B17 settle check on the rare true-blocker settle.',
  },
  {
    name: 'topicProfiles',
    configPath: 'topicProfiles.enabled',
    description: 'Topic Profile — per-topic model/thinking/framework pins (TOPIC-PROFILE-SPEC).',
    justification: 'Gate covers the WRITE path only (reads are always-on O(1) resolution) and ships dryRun:true (§14 shadow-field — logs intended respawns, performs none); no spend, no destructive action while the dry-run canary holds.',
  },
];

/**
 * An `enabled: false` config default that is DELIBERATELY dark for EVERYONE (dev
 * agents included) — the opposite of a DEV_GATED_FEATURES entry. The lint
 * (scripts/lint-dev-agent-dark-gate.js, assertion C) requires every literal
 * `enabled: false` in ConfigDefaults.ts to be EITHER dev-gated (registered above,
 * with `enabled` omitted) OR classified here, so no dark default can ship by
 * accident (the cartographer hole this spec closed).
 *
 * The registry's value is diffability + a category/reason quality bar — NOT
 * prevention. It is a CODEOWNERS-reviewed path; the human gate is the real
 * backstop. The lint REJECTS an entry with an unknown category or a reason
 * shorter than 12 non-whitespace chars.
 */
export type DarkGateCategory =
  | 'destructive'
  | 'optional-integration'
  | 'cost-bearing'
  | 'structural-stub'
  | 'deliberate-fleet-default';

export interface DarkGateExclusion {
  /** Dotted path to the feature's `enabled` flag in the agent config. */
  configPath: string;
  /** Why it is NOT dev-gated (closed enum). */
  category: DarkGateCategory;
  /** Human-readable rationale (≥12 non-whitespace chars; the lint enforces this). */
  reason: string;
}

export const DARK_GATE_EXCLUSIONS: DarkGateExclusion[] = [
  // ── destructive — kills/deletes on a heuristic; off + dry-run for EVERYONE ──
  {
    configPath: 'monitoring.sessionReaper.enabled',
    category: 'destructive',
    reason: 'kills idle sessions; off+dry-run for everyone',
  },
  {
    configPath: 'monitoring.agentWorktreeReaper.enabled',
    category: 'destructive',
    reason: 'deletes git worktrees; off+dry-run for everyone',
  },
  {
    configPath: 'monitoring.mcpProcessReaper.enabled',
    category: 'destructive',
    reason: 'kills MCP processes; off+dry-run for everyone',
  },
  // ── cost-bearing — ongoing third-party / LLM spend; explicit opt-in ──
  {
    configPath: 'mentor.autonomousFix.enabled',
    category: 'cost-bearing',
    reason: 'spawns full-tool Opus fix sessions; ongoing spend',
  },
  {
    configPath: 'monitoring.resumeQueue.enabled',
    category: 'cost-bearing',
    reason: 'drainer spawns sessions + makes LLM calls; ships enabled+dryRun code-default, dev agent flips dryRun locally (reap-notify spec)',
  },
  {
    configPath: 'cartographer.freshnessSweep.enabled',
    category: 'cost-bearing',
    reason: 'authors summaries via off-Claude codex; ongoing third-party spend; explicit opt-in even on dev',
  },
  // ── structural-stub — no runtime consumer wired; a gate would assert dead behavior ──
  {
    configPath: 'cartographer.conformanceAudit.llmEnrichment.enabled',
    category: 'structural-stub',
    reason: 'no LLM pipeline wired; dark stub',
  },
  {
    configPath: 'cartographer.subtreeNav.llmRerank.enabled',
    category: 'structural-stub',
    reason: 'no LLM pipeline wired; dark stub',
  },
  {
    configPath: 'monitoring.agentSleep.enabled',
    category: 'structural-stub',
    reason: 'sleep/respawn mechanism is a later slice; not wired',
  },
  // ── optional-integration — opt-in per deployment ──
  {
    configPath: 'multiMachine.sessionPool.enabled',
    category: 'optional-integration',
    reason: 'multi-machine pooling; opt-in per deployment',
  },
  // ── deliberate-fleet-default — off for everyone by design (incl. dev) ──
  {
    configPath: 'monitoring.bootHealthBeacon.enabled',
    category: 'deliberate-fleet-default',
    reason: 'minimal boot /health responder; deliberate fleet default, off until a supervisor needs it',
  },
  {
    configPath: 'monitoring.parallelWorkSentinel.enabled',
    category: 'deliberate-fleet-default',
    reason: 'observe-only overlap councilor; candidate for dev-gating in a follow-up audit',
  },
  {
    configPath: 'monitoring.failureLearning.enabled',
    category: 'deliberate-fleet-default',
    reason: 'observe-only failure-learning loop; candidate for dev-gating in a follow-up audit',
  },
  {
    configPath: 'monitoring.correctionLearning.enabled',
    category: 'deliberate-fleet-default',
    reason: 'observe-only correction/preference sentinel; candidate for dev-gating in a follow-up audit',
  },
  {
    configPath: 'monitoring.apprenticeshipCycleSla.enabled',
    category: 'deliberate-fleet-default',
    reason: 'observe-only overdue-cycle signal; candidate for dev-gating in a follow-up audit',
  },
  {
    configPath: 'monitoring.geminiCapacityEscalation.enabled',
    category: 'deliberate-fleet-default',
    reason: 'observe-only capacity-block escalation; candidate for dev-gating in a follow-up audit',
  },
  {
    configPath: 'monitoring.releaseReadiness.enabled',
    category: 'deliberate-fleet-default',
    reason: 'observe-only release-readiness sentinel; repo-gated; candidate for dev-gating in a follow-up audit',
  },
  {
    configPath: 'threadline.a2aCheckIn.enabled',
    category: 'deliberate-fleet-default',
    reason: 'A2A check-in summarizer; deliberate fleet default, opt-in to keep the operator un-flooded',
  },
  {
    configPath: 'mentor.enabled',
    category: 'deliberate-fleet-default',
    reason: 'framework-onboarding mentor system; deliberate fleet default, off until the human advances rollout',
  },
  {
    configPath: 'mentee.enabled',
    category: 'deliberate-fleet-default',
    reason: 'mentee receiver wiring; deliberate fleet default, off until an allowlisted mentor is configured',
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
