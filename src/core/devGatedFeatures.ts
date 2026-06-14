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
    name: 'credentialRepointing',
    configPath: 'subscriptionPool.credentialRepointing.enabled',
    description: 'Live credential re-pointing (WS5.2) — the /credentials/* levers + the autonomous balancer that MOVES a pool account\'s OAuth credential between config-home slots without restarting.',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the levers + the balancer run the FULL decision loop and AUDIT every swap they WOULD make, but the CredentialSwapExecutor returns BEFORE the keychain/config write step while dryRun holds (verified at CredentialSwapExecutor §2.3 — outcome `dry-run`, ZERO writes). So live-on-dev is alive + observable but performs NO destructive credential write; real writes need a deliberate dryRun:false (gated behind the §5 livetest promotion). Same dogfooding posture as topicProfiles / threadline.singleNegotiator. (Operator directive 2026-06-13, topic 20905: NONE of this should be dark for development agents — replaces the rev-2 dark-for-everyone DARK_GATE_EXCLUSIONS choice.)',
  },
  {
    name: 'ws44PoolLinks',
    configPath: 'multiMachine.seamlessness.ws44PoolLinks',
    description: 'WS4.4 links that survive machine boundaries — tunnel-fronting machine proxies /view/:id to the holder.',
    justification: 'Fronting machine is a dumb relay (holder authorizes); the proxied request carries a short-lived, audience-bound, single-use, mesh-signed user-auth assertion — never the raw PIN; private bodies never cached; single-machine = no-op. No destructive action, no third-party spend.',
  },
  {
    name: 'ws44PoolCache',
    configPath: 'multiMachine.seamlessness.ws44PoolCache',
    description: 'WS4.4(f) global pool-cache unification — every pool-scope surface (sessions/jobs/attention/guards/…) routes its per-peer fan-out through ONE shared PoolPollCache so each peer is hit once per interval, not once per surface per client; over the load-shed threshold the cache serves last-cached (stale-tagged) instead of re-fanning.',
    justification: 'Pure read-side observability/efficiency: caches only peer route bodies the surfaces ALREADY fetch over the mesh, introduces NO new authority, NEVER mutates, never caches private end-user content; a failed fetch is never cached; single-machine = no-op (no peers). No destructive action, no third-party spend.',
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
  {
    name: 'yieldSafety',
    configPath: 'monitoring.yieldSafety.enabled',
    description:
      'Build-Session Yield Safety (ACT-839) — a reaped session with uncommitted worktree work becomes resume-eligible and gets a tracked commit-or-preserve obligation.',
    justification:
      'Dev-enabled per the Maturation Path standard (the dev agent is the controlled blast radius where a lifecycle-touching feature matures before fleet). Loss-reducing only: R1 is a read-only pre-kill dirty-check (no egress, no spend); R2 is a SIGNAL + a tracked beacon (never a blocking gate) plus a NON-destructive preservation patch (git diff → a state-dir file, secret-scrubbed, size-capped; never mutates index/ref/history). The operator origin-veto is preserved — an explicit operator/user/emergency kill is never auto-revived. Fail-open everywhere.',
  },
  {
    name: 'authorizationRequests',
    configPath: 'monitoring.authorizationRequests.enabled',
    description:
      'Operator Authorization Request — the agent pre-fills a structured grant request; the operator approves it one-tap with their dashboard PIN (replaces the raw-JSON mandate form). Spec: docs/specs/OPERATOR-AUTHORIZATION-REQUEST-SPEC.md.',
    justification:
      'Dev-enabled per the Maturation Path standard. Does NOT weaken authority: a pending request confers ZERO authority (it is inert); the grant is issued ONLY inside the existing PIN-gated path (checkMandatePin) via the existing signed MandateStore.issue/addGrants — requester ≠ authorizer is preserved and the agent can never approve its own request. The operator-facing card is SERVER-authored from the structured proposal + the registry display name (never agent free-text), closing the deceptive-summary class. Routes 503 when off; the existing mandate/grant path is unchanged. The dev agent is the controlled blast radius where the operator-surface matures before fleet.',
  },
  // ── CMT-1438 (DEV-AGENT-DARK-GATE-TEETH): the 4 audited-safe migrants from the
  //    retired deliberate-fleet-default bucket. Each was code-grounded (D4) before
  //    the move; 3 candidates (correctionLearning, apprenticeshipCycleSla,
  //    geminiCapacityEscalation) FAILED grounding and stayed exclusions below. ──
  {
    name: 'parallelWorkSentinel',
    configPath: 'monitoring.parallelWorkSentinel.enabled',
    description: 'Proactive cross-topic work-overlap councilor (parallel-activity-coherence Phase B).',
    justification: 'D4-verified observe-only: ticks on a cadence, emits an in-process `overlap` event with NO listener wired, and appends to a local sentinel-events.jsonl audit. No fetch/Telegram/relay, no LLM, no destructive or external action.',
  },
  {
    name: 'failureLearning',
    configPath: 'monitoring.failureLearning.enabled',
    description: 'Failure-Learning Loop — append-only failure ledger + pattern surface (/failures).',
    justification: 'D4-verified observe-only at default sub-flags: append-only ledger; the Telegram insight-push path is unimplemented (insightTelegramEscalation only flips a reported stage string); all ingestion sources (ci/revert/regression/degradation) default off; the loop creates only draft items needing human approval — never auto-implements. No egress/spend on enable.',
  },
  {
    name: 'releaseReadiness',
    configPath: 'monitoring.releaseReadiness.enabled',
    description: 'Release-Readiness Sentinel — release-hygiene read surface (repo-gated).',
    justification: 'D4-verified inert-on-enable: server constructs the sentinel but does NOT start it — ticks are driven by the SEPARATE `release-readiness-check` cron job which ships (and is) enabled:false. So dev-gating makes only the READ surface live (routes stop 503-ing); the send capability is reachable only if the operator ALSO enables that dark job (a P17-budgeted createForumTopic), a separate explicit decision pinned by a drift-guard test. No egress/spend on enable.',
  },
  {
    name: 'bootHealthBeacon',
    configPath: 'monitoring.bootHealthBeacon.enabled',
    description: 'Boot health beacon — a minimal /health responder during the heavy boot phase.',
    justification: 'D4-verified read-only: binds a localhost-only inbound /health socket during boot and cleanly releases it before the real server binds; zero outbound (no fetch/Telegram), no spend, no destructive action.',
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
 *
 * CMT-1438 (DEV-AGENT-DARK-GATE-TEETH): the catch-all `deliberate-fleet-default`
 * category was RETIRED. Every off-even-on-dev category now names a CONCRETE reason
 * dev-live is the wrong place to run the feature — either *unsafe*
 * (`destructive` / `cost-bearing` / `action-bearing`) or *not-runnable*
 * (`optional-integration` / `structural-stub`). There is no "off by policy" home;
 * a feature that is safe AND runnable on a dev agent belongs in DEV_GATED_FEATURES.
 * Honest scope (Signal vs. Authority): the lint adjudicates category spelling +
 * reason length, never category *honesty* — the backstops against mis-parking a
 * safe feature are D4 code-grounding (build-time, per spec) and the
 * GrowthMilestoneAnalyst R6 runtime cross-check.
 */
export type DarkGateCategory =
  | 'destructive'
  | 'cost-bearing'
  | 'action-bearing'
  | 'optional-integration'
  | 'structural-stub';

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
  // (subscriptionPool.credentialRepointing.enabled MOVED to DEV_GATED_FEATURES on
  //  2026-06-13 per operator directive — live-on-dev in dry-run, dark fleet. Its
  //  destructive write is gated by the SEPARATE dryRun flag, which the dry-run canary
  //  holds; see the DEV_GATED_FEATURES entry's justification.)
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
  {
    configPath: 'multiMachine.stateSync.knowledge.enabled',
    category: 'optional-integration',
    reason: 'WS2.4 cross-machine knowledge-base replication — the THIRD memory-family kind on the HLC foundation; graduated rollout dark→dryRun→live per multi-machine-replicated-store-foundation, opt-in per deployment (no knowledge source crosses a machine boundary while dark; the local generated id + filePath are never replicated, only catalog metadata; mirrors the learnings sibling)',
  },
  {
    configPath: 'multiMachine.stateSync.evolutionActions.enabled',
    category: 'optional-integration',
    reason: 'WS2.5 cross-machine evolution-action-queue replication — the FOURTH memory-family kind on the HLC foundation; graduated rollout dark→dryRun→live per multi-machine-replicated-store-foundation, opt-in per deployment (no action crosses a machine boundary while dark; the local ACT-NNN id is never replicated; the load-bearing field is status so a peer sees an action was already completed elsewhere; mirrors the knowledge sibling)',
  },
  {
    configPath: 'multiMachine.stateSync.userRegistry.enabled',
    category: 'optional-integration',
    reason: 'WS2.6 cross-machine user-registry replication — the SECOND PII kind on the HLC foundation; graduated rollout dark→dryRun→live per multi-machine-replicated-store-foundation, opt-in per deployment (no user PII crosses a machine boundary while dark; the local userId is never replicated, the recordKey is the channel-set identity surface; mirrors the relationships sibling)',
  },
  {
    configPath: 'multiMachine.stateSync.topicOperator.enabled',
    category: 'optional-integration',
    reason: 'WS2.6 cross-machine topic-operator replication — the THIRD PII kind on the HLC foundation; graduated rollout dark to dryRun to live per multi-machine-replicated-store-foundation, opt-in per deployment (no operator binding crosses a machine boundary while dark; recordKey is sha256 of topicId plus the verified uid, never a content-name; THE LOAD-BEARING INVARIANT: a replicated topic-operator record is NEVER the authoritative principal — only the local authenticated setOperator binds it; mirrors the userRegistry sibling)',
  },
  // ── action-bearing — when merely enabled, automatically produces an outbound
  //    side-effect that reaches an external system or the operator (a send, a PR
  //    merge, a remote mutation). De-dup/rate-limiting reduces severity but an
  //    auto-send is an auto-send. Held off-on-dev; opt-in per agent. (CMT-1438) ──
  {
    configPath: 'monitoring.greenPrAutoMerge.enabled',
    category: 'action-bearing',
    reason: 'green-PR auto-merge watcher — merges PRs (an irreversible external mutation) when live. Off fleet-wide; flipped on per dev agent with expectedGhLogin. safe-merge re-verifies + lease-gated + runtime rollback + breaker; GitHub App is a binding precondition before any fleet promotion.',
  },
  {
    configPath: 'threadline.a2aCheckIn.enabled',
    category: 'action-bearing',
    reason: 'A2A check-in summarizer — sends UNBOUNDED user-facing Telegram summaries on a heartbeat while a conversation is active; live-on-dev would flood the operator. Opt-in to keep the operator un-flooded.',
  },
  {
    configPath: 'monitoring.apprenticeshipCycleSla.enabled',
    category: 'action-bearing',
    reason: 'D4-grounded action-bearing: auto-ticks on the always-running TokenLedgerPoller cadence and, on each overdue cycle, calls telegram.createAttentionItem → createForumTopic + sendMessage (a user-facing Telegram escalation, flood-guard/dedup bounded). Read-only on the cycle store, but the auto-send contradicts the observe-only claim — held off-on-dev, opt-in per agent.',
  },
  {
    configPath: 'monitoring.geminiCapacityEscalation.enabled',
    category: 'action-bearing',
    reason: 'D4-grounded action-bearing: same pattern as apprenticeshipCycleSla — auto-ticks the TokenLedgerPoller cadence and, on a capacity-block deferral episode (>escalateAfterMinutes), auto-posts a user-facing Telegram attention topic (dedup-bounded per episode). The auto-send contradicts the observe-only claim — held off-on-dev, opt-in per agent.',
  },
  // ── cost-bearing addition (CMT-1438 D4 grounding) ──
  {
    configPath: 'monitoring.correctionLearning.enabled',
    category: 'cost-bearing',
    reason: 'D4-grounded cost-bearing: enabling the capture loop runs a per-message Tier-1 LLM distill (sharedIntelligence.evaluate model:fast via a dedicated LlmQueue, <=25c/day cap) on every preference/frustration-classified inbound message — ongoing LLM spend gated by the base loop, not a sub-flag. The earlier no-spend reason-string was disproved; held off-on-dev, opt-in per agent.',
  },
  // ── optional-integration — inert until per-deployment config/credential exists
  //    (must name the gating config); not unsafe, just nothing to dogfood. (CMT-1438) ──
  {
    configPath: 'mentor.enabled',
    category: 'optional-integration',
    reason: 'framework-onboarding mentor system — inert until the operator advances the graduated rollout (mode off→dry-run→live) and configures menteeFramework; nothing to dogfood live-on-dev until that per-deployment config exists.',
  },
  {
    configPath: 'mentee.enabled',
    category: 'optional-integration',
    reason: 'mentee receiver wiring — inert until localAgentName + knownMentors (an allowlisted mentor) + replyChatId/replyTopicId are configured; any missing piece logs a skip and stays dark, so there is nothing to dogfood until that per-deployment allowlist exists.',
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
