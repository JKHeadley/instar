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
    name: 'agentOwnedFollowthrough',
    configPath: 'commitments.agentOwnedFollowthrough.enabled',
    description: 'The Agent Carries the Loop (C1+C2) — owner-gated beacon suppression + external-block staleness governor + evidence-gated graveyard reconciler; the user is never status-pinged for an agent-owned commitment.',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the owner-gate + governor + reconciler run the full decision loop and AUDIT/log every suppression/dead-letter/close they WOULD make, but PromiseBeacon.emitUserSend STILL sends and the governor/reconciler mutate nothing while dryRun holds (verified at emitUserSend §4.2 + reconcileGraveyard/maybeReconcileGraveyard dryRun branches). No spend, no destructive action, no egress while the canary holds; real suppression/closes need a deliberate dryRun:false. Same dogfooding posture as topicProfiles / credential-repointing.',
  },
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
    name: 'selfUnblockChecklist',
    configPath: 'monitoring.blockerLedger.selfUnblockChecklist.enabled',
    description: 'Self-Unblock Before Escalating — the deterministic exhaustion checklist that PRODUCES (and BlockerLedger then verifies) the failed-attempt evidence required to settle a true-blocker (/blockers extension; self-unblock-before-escalating spec §5.1).',
    justification: 'Signal-only, deterministic, fail-closed: the checklist RECORDS probe results to a local JSONL run store and the rung onto BlockerLedger\'s existing AuthorityCheckEvidence — it never blocks a message and adds NO new gate (the one judgment stays BlockerLedger\'s Tier-1 B17 authority). The relevance match is pure code (no LLM); each probe is timeout-bounded and degrades to reachable:false; ENABLING it only makes BlockerLedger derive the failed attempt from a VERIFIED persisted run instead of accepting a caller-embedded one (strictly HARDER to settle a true-blocker). No egress of its own, no destructive action; the cloud-account probes are read-only auth checks behind injected providers.',
  },
  {
    name: 'durableVaultSession',
    configPath: 'monitoring.blockerLedger.durableVaultSession.enabled',
    description: 'Durable org-Bitwarden session (self-unblock-before-escalating spec §5.3) — a TTL+idle-bounded, in-flight-only warm session the org-vault probe uses so an in-vault credential is actually reachable.',
    justification: 'The session value lives in PROCESS MEMORY ONLY — never written to any log/config/temp file, never passed as a CLI argv (handed to bw only via the child BW_SESSION env), and NEVER placed on the multiMachine.secretSync path (machine-local). It is held warm only while a checklist run is in flight and carries a TTL + idle-expiry, so the standing-privilege window is minimal. The master password stays operator-held; no new on-disk secret is introduced. The dev agent is the controlled blast radius where this matures before any fleet flip.',
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
    name: 'playwrightRegistry',
    configPath: 'playwrightRegistry.enabled',
    description: 'Playwright profile↔accounts registry + boot awareness + activate.',
    justification: 'Stores vault secret NAMES only (never values) + browser-profile metadata; reads are advisory signal; the only destructive op (activate: MCP-config rewrite + session restart) ships dryRun:true and is reversible; dev-dogfooded.',
  },
  // ── multi-machine seamlessness coherence layers (WS3 / WS1.3 / WS4.1 / WS4.3),
  //    MOVED from hardcoded `false` in ConfigDefaults on 2026-06-13 per operator
  //    directive topic 13481 ("NOTHING should ship dark on development agents —
  //    every multi-machine feature must be live on dev agents so it actually gets
  //    tested, not rot"). Each ConfigDefaults entry now OMITS the flag (NOT
  //    hardcoded false), so resolveDevAgentGate flips it LIVE on a dev agent / DARK
  //    on the fleet — mirroring the ws44PoolLinks/ws44PoolCache siblings below. They
  //    coordinate across the operator's OWN machines (active-active) with NO external
  //    egress; each is reversible (a config flip OR single-machine no-op) and runs in
  //    the SAFE direction on dev. Spec: docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md.
  //    NOTE: the multiMachine.sessionPool.* master switch + its inboundQueue /
  //    holdForStability sub-flags are DELIBERATELY NOT moved here — they share a
  //    SECOND structural gate (`sessionPool.stage`, StageAdvancer-write-only, E2E-
  //    gated rollout ladder dark→shadow→live-transfer→rebalance). The activation
  //    expression everywhere is `enabled && stage !== 'dark'`, so dev-gating
  //    `enabled` alone leaves them inert (still-dark-on-dev), and forcing `stage`
  //    past dark in ConfigDefaults would bypass the deliberate cutover discipline.
  //    They stay in DARK_GATE_EXCLUSIONS for an operator decision (held PR2). ──
  {
    name: 'ws3OneVoice',
    configPath: 'multiMachine.seamlessness.ws3OneVoice',
    description: 'WS3 one-voice gate — the SpeakerElection that gives a multi-machine conversation a single outbound voice (no double-replies across machines).',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress; when dark/single-machine the election returns "speak" unconditionally (byte-for-byte today\'s behavior) and never engages below 2 online machines; a verdict only WITHHOLDS a duplicate send (the safe direction), never fabricates one. No destructive action, no third-party spend. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'ws13Reconcile',
    configPath: 'multiMachine.seamlessness.ws13Reconcile',
    description: 'WS1.3 ownership reconcile — bounded pin/owner convergence (cooperative transfer→claim while the owner lives; force only with owner-death evidence + quorum).',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress; its in-component dryRun sub-knob (ws13DryRun) stays a plain hardcoded default true, so live-on-dev runs the reconcile loop but LOGS intended CAS actions without performing them (no destructive CAS) exactly as the rollout ladder intends; strict single-machine no-op inside the module. No third-party spend. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'ws41DurableAck',
    configPath: 'multiMachine.seamlessness.ws41DurableAck',
    description: 'WS4.1 durable operator-bound /ack across machines — a pooled-attention ack whose owner is briefly offline is persisted with the authenticated operator principal and re-delivered when the owner returns.',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress; the persisted intent is bound to the AUTHENTICATED operator and the owner REVALIDATES at apply time (a stale resolve against a since-escalated item is rejected — current state wins); when dark the routes 503 and the precedence guard is inert; strict single-machine no-op (no peers). No destructive action, no third-party spend. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'ws43RoleGuard',
    configPath: 'multiMachine.seamlessness.ws43RoleGuard',
    description: 'WS4.3 role-guard-at-spawn — the scheduler refuses to spawn a STATE-WRITING job on a machine that does NOT hold the lease (closes the TOCTOU hole where a machine demotes to read-only standby mid-run while its cron tasks keep firing).',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress; the guard can ONLY ever REFUSE a spawn (never wrongly spawn — the safe direction); when dark it is a strict no-op (byte-for-byte today\'s behavior); single-machine agents always hold the lease so it never fires there even live. The refusal raises ONE deduped attention item (no flood). No destructive action, no third-party spend. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'ws43JournalLease',
    configPath: 'multiMachine.seamlessness.ws43JournalLease',
    description: 'WS4.3 journal-lease cutover — job claims upgrade from the best-effort AgentBus broadcast to a durable, epoch-fenced lease over the replicated journal (the JobLeaseCutoverGate guarantees the two mechanisms are NEVER both live for a job set).',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress. The dryRun sub-flag (ws43JournalLeaseDryRun) is ALSO omitted from ConfigDefaults and resolves COHERENTLY with this flag at the consumer (dev → live, fleet → dry-run) so live-on-dev actually exercises the lease path. A genuine live cutover engages ONLY when the flag resolves live AND the pool is flag-coherent (≥2 machines all advertising not-dry-run), so a single-machine dev agent never half-migrates (strict no-op). Job-claim coordination on durable local/replicated state — no destructive/irreversible write, no third-party spend. Operator directive 2026-06-13 topic 13481.',
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
    name: 'liveTestGate',
    configPath: 'monitoring.liveTestGate.enabled',
    description: 'Live-User-Channel Proof completion gate (spec §4, CMT-1568) — refuses an autonomous "done" verdict for a user-facing feature without a verified, signed live-test artifact (right surfaces + risk categories).',
    justification: 'Ships mode:dry-run by default (the canary): on a dev agent the gate runs the FULL decision over POST /autonomous/evaluate-completion and LOGS the veto it WOULD apply, but dry-run/warn NEVER override the verdict — only an explicit mode:veto can flip met:true→met:false, and even then the only effect is keeping the run WORKING (the safe direction, never a destructive action, never a false "done"). Pure local read of signed artifacts on disk (no egress, no spend, no LLM of its own); a gate error falls through to the original verdict (the completion judge stays primary authority). Same dogfooding posture as topicProfiles / threadline.singleNegotiator.',
  },
  {
    name: 'durableOwnership',
    configPath: 'multiMachine.durableOwnership.enabled',
    description: 'Transfer fix (live-user-channel-proof spec §7.2) — swaps the in-memory session-ownership store for a DURABLE per-session store + the OwnershipApplier that materializes ownership on the target from the REPLICATED placement journal, so a topic seat genuinely moves between machines.',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress. The durable store is a per-session atomic JSON write (a cache of journal-decided ownership, not a new authority); the applier only ADOPTS a placement strictly newer than local via fast-forward CAS (it can never clobber a fresher local decision) and runs OFF the routing hot path on an interval; fully reversible (flip back to InMemory — the journal remains the source of truth); single-machine = no-op (no peer placements to apply). No destructive action, no third-party spend. Runs live (dryRun N/A — no destructive write to gate) on dev / dark on fleet.',
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
  // ── multi-machine replicated-store memory family (WS2.1–WS2.6) — the 7 stateSync
  //    stores, MOVED from DARK_GATE_EXCLUSIONS on 2026-06-13 per operator directive
  //    topic 13481 ("NOTHING should ship dark on development agents — every
  //    multi-machine feature must be live on dev agents so it actually gets tested").
  //    UNLIKE credentialRepointing (which keeps dryRun:true because its keychain WRITE
  //    is destructive), these replicate between the operator's OWN two machines with NO
  //    external egress and NO destructive/irreversible write — the foundation's
  //    rollback-unmerge drops a peer's namespace on disable, so they are fully
  //    reversible. A dry-run would defeat "actually gets tested", so the ConfigDefaults
  //    OMIT `enabled` (resolveDevAgentGate flips them LIVE on dev / DARK on fleet) AND
  //    set `dryRun:false` (genuinely live). Spec: docs/specs/multi-machine-replicated-
  //    store-foundation.md (these are its consumers). The `enabled` reads at the four
  //    funnels (selfStateSyncReceive, ReplicatedStoreReader.isLive,
  //    isStoreEmissionEnabled, the /preferences/session-context route) are routed
  //    through resolveDevAgentGate at the construction boundary so the gate actually
  //    flips them live — not just array-shuffling. ──
  {
    name: 'stateSyncPreferences',
    configPath: 'multiMachine.stateSync.preferences.enabled',
    description: 'WS2.1 cross-machine preference replication (multi-machine-replicated-store-foundation).',
    justification: 'Replicates between the operator\'s OWN machines only — no external egress; advisory-only on read (never authority); fully reversible (rollback-unmerge drops a peer namespace on disable); no destructive/irreversible write, no third-party spend. Runs live AND dryRun:false on dev (no destructive write warrants a dry-run). Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'stateSyncRelationships',
    configPath: 'multiMachine.stateSync.relationships.enabled',
    description: 'WS2.3 cross-machine relationship replication — the FIRST PII kind (ws23-relationships-userregistry-security).',
    justification: 'PII crosses only between the operator\'s OWN machines (transit-encrypted); every replicated field is type-clamped on receive; a peer record is quoted UNTRUSTED data, never the authoritative answer to "who is messaging me"; a delete propagates a tombstone; fully reversible (rollback-unmerge). No external egress, no destructive write, no spend. Runs live AND dryRun:false on dev. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'stateSyncLearnings',
    configPath: 'multiMachine.stateSync.learnings.enabled',
    description: 'WS2.2 cross-machine learning replication — the SECOND memory-family kind (multi-machine-replicated-store-foundation).',
    justification: 'Replicates between the operator\'s OWN machines only — no external egress; advisory-only on read; type-clamped on receive; tombstoned deletes; the local LRN-NNN id is never replicated; fully reversible (rollback-unmerge); no destructive write, no spend. Runs live AND dryRun:false on dev. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'stateSyncKnowledge',
    configPath: 'multiMachine.stateSync.knowledge.enabled',
    description: 'WS2.4 cross-machine knowledge-base replication — the THIRD memory-family kind (multi-machine-replicated-store-foundation).',
    justification: 'Only catalog METADATA crosses (never the file body or local path), between the operator\'s OWN machines; advisory-only on read; type-clamped on receive; tombstoned deletes; fully reversible (rollback-unmerge); no external egress, no destructive write, no spend. Runs live AND dryRun:false on dev. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'stateSyncEvolutionActions',
    configPath: 'multiMachine.stateSync.evolutionActions.enabled',
    description: 'WS2.5 cross-machine evolution-action-queue replication — the FOURTH memory-family kind (multi-machine-replicated-store-foundation).',
    justification: 'Replicates the self-improvement action queue between the operator\'s OWN machines only; advisory work-items on read (load-bearing field is status so a peer does not redo completed work); type-clamped on receive; tombstoned removals; the local ACT-NNN id is never replicated; fully reversible (rollback-unmerge); no external egress, no destructive write, no spend. Runs live AND dryRun:false on dev. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'stateSyncUserRegistry',
    configPath: 'multiMachine.stateSync.userRegistry.enabled',
    description: 'WS2.6 cross-machine user-registry replication — the SECOND PII kind (multi-machine-replicated-store-foundation).',
    justification: 'User PII crosses only between the operator\'s OWN machines (transit-encrypted); type-clamped on receive; a peer record is quoted UNTRUSTED data and inbound-principal RESOLUTION stays LOCAL-ONLY (the local channel index is authoritative); tombstoned deletes; fully reversible (rollback-unmerge); no external egress, no destructive write, no spend. Runs live AND dryRun:false on dev. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'stateSyncTopicOperator',
    configPath: 'multiMachine.stateSync.topicOperator.enabled',
    description: 'WS2.6 cross-machine topic-operator replication — the THIRD PII kind (multi-machine-replicated-store-foundation).',
    justification: 'Replicates the verified-operator binding between the operator\'s OWN machines only; THE LOAD-BEARING SAFETY INVARIANT (Know Your Principal): a replicated record is UNTRUSTED peer data and is NEVER the authoritative answer to "who is my verified operator?" — only the LOCAL authenticated setOperator binds it; recordKey is sha256(topicId+verified-uid), never a content-name; tombstoned unbinds; fully reversible (rollback-unmerge); no external egress, no destructive write, no spend. Runs live AND dryRun:false on dev. Operator directive 2026-06-13 topic 13481.',
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
  // (the 7 multiMachine.stateSync.* memory stores — preferences, relationships,
  //  learnings, knowledge, evolutionActions, userRegistry, topicOperator — MOVED to
  //  DEV_GATED_FEATURES on 2026-06-13 per operator directive topic 13481: "NOTHING
  //  should ship dark on development agents — every multi-machine feature must be
  //  live on dev agents so it actually gets tested, not rot." They replicate between
  //  the operator's OWN machines (no external egress, fully reversible via the
  //  foundation's rollback-unmerge), so unlike credentialRepointing they run live AND
  //  dryRun:false on a dev agent — see the DEV_GATED_FEATURES entries' justifications.)
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
