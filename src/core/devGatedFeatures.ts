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
  {
    name: 'ws44PoolLinks',
    configPath: 'multiMachine.seamlessness.ws44PoolLinks',
    description: 'WS4.4 links that survive machine boundaries — tunnel-fronting machine proxies /view/:id to the holder.',
    justification: 'Fronting machine is a dumb relay (holder authorizes); the proxied request carries a short-lived, audience-bound, single-use, mesh-signed user-auth assertion — never the raw PIN; private bodies never cached; single-machine = no-op. No destructive action, no third-party spend.',
  },
  {
    name: 'canonicalHistoryConversationDiscipline',
    configPath: 'threadline.canonicalHistory.conversationDiscipline.enabled',
    description:
      'Conversation-discipline resolver JOIN — outbound replies join the canonical (peer, workstream) thread instead of forking (Threadline Robustness Phase 2, D-E; closes F5).',
    justification:
      'Ships dryRun:true (logs the would-join decision, performs NO reroute) so live-on-dev only emits telemetry; recoverable routing that never blocks a send, never gates an irreversible action, no destructive action, no third-party spend.',
  },
  {
    name: 'outboundAdvisoryTimeClaim',
    configPath: 'messaging.outboundAdvisory.timeClaim.enabled',
    description:
      'TIME_CLAIM outbound advisory — flags elapsed/remaining/percent claims that contradict the live session clock (operator mandate 2026-06-12).',
    justification:
      'Deterministic regex check feeding the existing inform-only advisory surface (never blocks; sender fixes or acks); no LLM, no egress, no spend, no destructive action.',
  },
  {
    name: 'threadlineSingleNegotiator',
    configPath: 'threadline.singleNegotiator.enabled',
    description:
      'Threadline single-negotiator lease — one session owns each conversation\'s outbound voice (THREADLINE-SINGLE-NEGOTIATOR-SPEC, CMT-1362).',
    justification:
      'Lives live on a dev agent ONLY in dry-run (dryRun defaults true) — it engages the lease logic and logs every would-hold verdict for the FD-7 false-positive telemetry but withholds NOTHING (a real send is only blocked by an explicit dryRun:false). No egress, no spend, no destructive action; this is exactly the dogfooding posture FD-7 requires before the lease can ever enforce. (Was mis-classified deliberate-fleet-default at ship, which starved the telemetry — corrected here.)',
  },
  {
    name: 'orphanedWorkSentinel',
    configPath: 'monitoring.orphanedWorkSentinel.enabled',
    description:
      'Silent-uncommitted-death backstop — flags agent worktrees with uncommitted work whose owning session died (/orphaned-work).',
    justification:
      'Signal-only local recorder + ONE deduped attention item; reads git status/diff + lsof read-only; no egress, no spend, no destructive action. The optional preservation is a NON-destructive patch write (git diff → a state-dir file) behind an off-by-default preserveWork sub-flag — it never mutates the worktree, its index, or any ref.',
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
  {
    configPath: 'subscriptionPool.credentialRepointing.enabled',
    category: 'destructive',
    reason: 'writes OAuth credentials between config homes; off+dry-run for everyone (incl. dev) — live needs a deliberate enabled:true AND dryRun:false flip',
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
  {
    configPath: 'multiMachine.sessionPool.inboundQueue.enabled',
    category: 'optional-integration',
    reason: 'durable inbound custody queue; staged rollout per spec frontmatter (dark→dry-run→dev-live→fleet)',
  },
  {
    configPath: 'multiMachine.sessionPool.holdForStability.enabled',
    category: 'optional-integration',
    reason: 'hold-for-stability policy; trails inboundQueue one rollout stage behind (operator discipline)',
  },
  {
    configPath: 'multiMachine.stateSync.preferences.enabled',
    category: 'optional-integration',
    reason: 'WS2.1 cross-machine preference replication on the HLC foundation; graduated rollout dark→dryRun→live per spec §10.1, opt-in per deployment (mirrors sessionPool.inboundQueue staging)',
  },
  {
    configPath: 'multiMachine.stateSync.relationships.enabled',
    category: 'optional-integration',
    reason: 'WS2.3 cross-machine relationship replication — the FIRST PII kind on the HLC foundation; graduated rollout dark→dryRun→live per ws23-relationships-userregistry-security §INV-iii, opt-in per deployment (PII never crosses a machine boundary while dark; mirrors the preferences sibling)',
  },
  {
    configPath: 'multiMachine.stateSync.learnings.enabled',
    category: 'optional-integration',
    reason: 'WS2.2 cross-machine learning replication — the SECOND memory-family kind on the HLC foundation; graduated rollout dark→dryRun→live per multi-machine-replicated-store-foundation, opt-in per deployment (no learning crosses a machine boundary while dark; the local LRN-NNN id is never replicated; mirrors the relationships sibling)',
  },
  // ── deliberate-fleet-default — off for everyone by design (incl. dev) ──
  {
    configPath: 'monitoring.greenPrAutoMerge.enabled',
    category: 'deliberate-fleet-default',
    reason: 'green-PR auto-merge watcher — action-bearing (merges PRs), so NOT dev-gated (the dev-gate registry bars action-bearing features, devGatedFeatures.ts contract). Off fleet-wide; flipped on per dev agent with expectedGhLogin. safe-merge re-verifies + lease-gated + runtime rollback + breaker; GitHub App is a binding precondition before any fleet promotion.',
  },
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
