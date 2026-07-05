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
    name: 'sessionPoolMoveIntent',
    configPath: 'multiMachine.sessionPool.moveIntent.enabled',
    description: 'LLM-with-context move-intent recognizer (docs/specs/nickname-move-intent-llm-rebuild.md) — replaces the keyword verb-list that hijacked "keep the work on the laptop" (2026-07-03). Decides "move/run/pin this on <nickname>?" via MoveIntentClassifier over the message + recent conversation, guardrailed by structured enum output; the downstream TransferByNickname planner is unchanged.',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the classifier RUNS the full LLM decision loop and LOGS would-hijack vs would-pass to logs/move-intent.jsonl, but _tryNicknameRelocation ALWAYS returns handled:false (the message passes through, never hijacked) while dryRun holds — real hijacking needs a deliberate dryRun:false. The whole session-pool layer is itself dark unless stage advances past "dark", so this is doubly inert on the fleet. Fail-OPEN: every uncertainty (no provider, breaker open, timeout, unparseable output, target not in enum, low confidence) passes the message through. One bounded fast-tier LLM call per candidate message (gated behind a cheap no-nickname pre-filter); no destructive action, no egress beyond the shared IntelligenceProvider. Same dogfooding posture as topicProfiles.',
  },
  {
    name: 'hubIntent',
    configPath: 'threadline.hubIntent.enabled',
    description: 'LLM-with-context hub-intent recognizer (docs/specs/keyword-intent-conversions-1-and-3.md, Conversion #3) — replaces the anchored "open this"/"tie this to <topic>" regexes that SWALLOWED the message before the agent saw it (a misread silently EATS a real message — the highest-care conversion). Decides "is this hub message a bind command?" via HubIntentClassifier over the message + recent conversation, guardrailed by a structured topic-id enum for the tie target; the downstream bindHubConversation binder is unchanged.',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the classifier RUNS the full LLM decision loop and LOGS would-swallow vs would-pass to logs/hub-intent.jsonl, but the onTopicMessage hub intercept ALWAYS falls through (the message passes to the agent, never swallowed) while dryRun holds — real swallowing needs a deliberate dryRun:false. Fail-OPEN: every uncertainty (no provider, breaker open, timeout, unparseable/schema-violating output, tie target not in enum, low confidence) passes the message through. One bounded fast-tier LLM call per candidate hub message (gated behind a cheap no-hub-signal pre-filter); no destructive action, no egress beyond the shared IntelligenceProvider. Same dogfooding posture as topicProfiles / the move-intent exemplar (PR #1367).',
  },
  {
    name: 'topicProfileIntentClassifier',
    configPath: 'topicProfiles.intentClassifier.enabled',
    description: 'LLM-with-context framework/model/thinking intent recognizer (docs/specs/keyword-intent-conversions-1-and-3.md, conversion #1) — replaces the keyword/regex write decision removed from parseProfileTrigger (the 2026-07-03 keyword-intent audit\'s offender #1). Decides "change this topic\'s framework/model/thinking?" via ProfileIntentClassifier over the message + recent conversation, guardrailed by structured-enum output; the downstream TopicProfileWriteSurface is unchanged. Enforces "Intelligence Infers, Keywords Only Guard".',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the classifier RUNS the full LLM decision loop and LOGS would-actuate vs would-pass to logs/profile-intent.jsonl, but handleTopicProfileIngress ALWAYS returns pass-through (the message reaches the agent, never actuates a respawn) while dryRun holds — real actuation needs a deliberate dryRun:false. The whole topic-profile WRITE layer is itself dev-gated + dryRun (topicProfiles.enabled/dryRun), so this is doubly inert on the fleet. Fail-OPEN: every uncertainty (no provider, breaker open, timeout, unparseable output, value not in enum, low confidence) passes the message through. One bounded fast-tier LLM call per candidate message (gated behind a cheap no-signal pre-filter); no destructive action, no egress beyond the shared IntelligenceProvider. Same dogfooding posture as topicProfiles.',
  },
  {
    name: 'agentOwnedFollowthrough',
    configPath: 'commitments.agentOwnedFollowthrough.enabled',
    description: 'The Agent Carries the Loop (C1+C2) — owner-gated beacon suppression + external-block staleness governor + evidence-gated graveyard reconciler; the user is never status-pinged for an agent-owned commitment.',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the owner-gate + governor + reconciler run the full decision loop and AUDIT/log every suppression/dead-letter/close they WOULD make, but PromiseBeacon.emitUserSend STILL sends and the governor/reconciler mutate nothing while dryRun holds (verified at emitUserSend §4.2 + reconcileGraveyard/maybeReconcileGraveyard dryRun branches). No spend, no destructive action, no egress while the canary holds; real suppression/closes need a deliberate dryRun:false. Same dogfooding posture as topicProfiles / credential-repointing.',
  },
  {
    name: 'biasToAction',
    configPath: 'monitoring.biasToAction.enabled',
    description: 'Standing-authorization signal for B17_FALSE_BLOCKER (BIAS-TO-ACTION-SPEC) — feeds the outbound tone gate a VERIFIED-operator, non-forwarded, in-window grant so "re-asking for authority you already hold" is recognized as the false blocker it is.',
    justification: 'SIGNAL-ONLY and OBSERVE-ONLY (observeOnly defaults true): on a dev agent the resolver runs and records a would-fire to logs/bias-to-action.jsonl (uid HASH + ask-phrase token, never a raw quote), but the grant is NOT attached to the gate context so NO verdict can change and no message is ever altered. It can never flip a B1–B7/B15 leak HOLD. No spend, no egress, no destructive action while observe-only holds; live B17 firing needs a deliberate observeOnly:false. Same dogfooding posture as topicProfiles / agentOwnedFollowthrough.',
  },
  {
    name: 'standbyHonestyTiers',
    configPath: 'monitoring.standbyHonestyTiers.enabled',
    description: "Tier1/Tier2 standby honest-stuck classification — surface the REAL reason a live-but-failing session is silent (rate-limited / policy-wedge / context-wedge / context-too-long) instead of 'actively working'.",
    justification: "Signal-only — only changes the standby MESSAGE TEXT; never gates, blocks, initiates recovery, spends, or egresses. Reuses the existing tail-gated classifyStuckSignature and defers to the same one-voice recovery-ownership checks Tier 3 already honors. Flag-OFF = Tier1/2 byte-identical to today.",
  },
  {
    name: 'durableOutputScrub',
    configPath: 'monitoring.durableOutputScrub.enabled',
    description: 'Durable-Output Hygiene Standard §2 (Layer B — "What Persists Must Be Clean") — the DurableOutputScrubber: a deterministic credential-SPAN scrub over LLM output at durable-output persistence chokepoints (session summaries wired first), config-gated + dark-first.',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the scrubber COMPUTES the redaction and records would-redact metrics (feature key durable-output-scrub — COUNTS/kind/offset only, NEVER the matched bytes, so the soak telemetry can never itself be the leak), but returns the ORIGINAL text so NO durable content is mutated while dryRun holds (verified at DurableOutputScrubber.scrub/scrubRecord dryRun branches — applied:false, input returned unchanged). A real redaction (which destroys the matched span by design) needs a deliberate dryRun:false — the OPERATOR\'s endpoint decision on the dev-soak packet (Frontloaded Decision #4), never a fleet default. Pure deterministic regex floor (no LLM, no spawn-cap slot, no egress, no third-party spend); every failure path fails SAFE-toward-redaction (a scrub throw / oversize withholds the field under a typed marker, never persists raw bytes). Same dogfooding posture as topicProfiles / credentialRepointing.',
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
    name: 'ropeRecoveryProbe',
    configPath: 'multiMachine.meshTransport.recoveryProbeEnabled',
    description: 'U4.3 traffic-independent rope-health recovery probe — rides the lease-pull tick, sends pinned signed bogus-uid canary probes to dead mesh ropes and feeds the typed result into the ONE health authority (PeerEndpointResolver.recordResult), so a healed rope closes in minutes instead of staying presumed-dead (the week-long Tailscale strand).',
    justification: 'Ships recoveryProbeDryRun:true (the dry-run canary): dry-run SENDS real probes — harmless by the typed-refusal payload contract (a signed bogus-uid deliverMessage the peer answers with not-router/sender-rejected; nothing can ever be injected) — but never mutates the HealthRecord. The only user-facing egress is the DEDUPED escalate-once attention item per (peer, kind, episode) — bounded, episode-keyed output, the same posture as the degradationLadderNeverSilent precedent already in this registry — so it is safe AND runnable live-on-dev rather than an action-bearing DARK_GATE_EXCLUSIONS case. P19 Eternal-Sentinel floor (15 min) bounds a permanently-dead rope in BOTH modes; no spend, no destructive action.',
  },
  {
    name: 'ropeHealthAlerts',
    configPath: 'monitoring.ropeHealth.enabled',
    description: 'U4.5 rope-health alerts — the in-server RopeHealthMonitor: a bounded 30s evaluation loop over the U4.3 resolver snapshot with deterministic sleep-aware classification (ok/degraded/peer-offline/urgent), episode-deduped HIGH partition alerts, Tailscale key-expiry warnings, GET /mesh/rope-health, and the rope-health-digest daily job.',
    justification: 'The urgent tier auto-posts HIGH attention items, which normally pushes a feature into DARK_GATE_EXCLUSIONS\' action-bearing category. This takes the OTHER branch deliberately (R-r2-6): the only egress is EPISODE-DEDUPED (ONE HIGH item per (machine-pair, episode); an already-open split-brain item wins and suppresses it), SLEEP-GATED (the mesh-independent git-synced heartbeat discriminator kills the lid-close false-alarm class by construction — a sleeping machine stops writing heartbeats, so it classifies peer-offline, never urgent), and it is OPERATOR-MANDATED partition alerting — the silent-partition gap is the incident class the operator directed this project to close. Same bounded-escalation posture as the degradationLadderNeverSilent precedent already in this registry. No spend (deterministic classifier, zero LLM), no destructive action; the digest job logs only until digestTopicId is set.',
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
  {
    name: 'conversationFollowThrough',
    configPath: 'conversationIdentity.followThrough.enabled',
    description: 'Durable conversation identity — the §5 deliverToConversation funnel\'s minted-id (id<0) DELIVERY arm (durable-conversation-identity §9). The registry/journal/eager-mint FOUNDATION is always-on and NOT gated here; only delivery rides this gate.',
    justification: 'Delivery is externally visible, so the block ships dryRun:true even live-on-dev: the id<0 arm returns typed §5.1 non-deliveries + would-deliver audit lines (never success-shaped) until a deliberate dryRun:false flip for the live proof. Zero consumers ride the funnel in increment 1, so enabling is inert until the §6.1 proof-consumer increment; no spend, no destructive action, no egress while dry.',
  },
  {
    name: 'actionClaimSlack',
    configPath: 'messaging.actionClaim.slack.enabled',
    description: 'Slack follow-through generalization — the /action-claim/observe registration lane for NEGATIVE (minted Slack) conversation ids (spec: slack-followthrough-generalization §8.1). Registration only; follow-through DELIVERY rides the separate conversationIdentity.followThrough gate.',
    justification: 'SIGNAL-ONLY: registration fires AFTER the Slack reply already went out (the Stop hook runs at turn end) — it can never block/delay/rewrite a message. Ships messaging.actionClaim.slack.dryRun:true even live-on-dev: the observe route runs the full classify + §7 bind-verify + would-register decision and appends a logs/action-claim-observe.jsonl audit line, but performs NO record() until a deliberate dryRun:false for the live proof. A minted-id write is §7 fail-closed (a foreign/unauthenticated caller is refused); the shared per-topic cap + 6h expiry bound the durable surface. The master messaging.actionClaim.enabled must be on for the Stop hook to POST at all. No spend, no destructive action, no egress while dry. Same dogfooding posture as conversationFollowThrough.',
  },
  {
    name: 'prHandLease',
    configPath: 'monitoring.prHandLease.enabled',
    description: 'Per-branch PR-push lease so two of the agent’s own concurrent sessions can’t push competing commits to the same branch (spec: parallel-hand-pr-lease).',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the PreToolUse hook + the /pr-leases/evaluate route run the FULL decision loop and AUDIT every would-deny, but the route returns decision:allow (wouldDeny flag) while dryRun holds, so NO push is ever blocked until a deliberate dryRun:false. Coordinates the agent’s OWN cooperating hands only — never authority over a principal, never external egress; every uncertainty (corrupt state, server down, hook crash, no branch key) fails OPEN (allows the push). No spend, no destructive action while the canary holds. Same dogfooding posture as topicProfiles / credentialRepointing.',
  },
  {
    name: 'closeoutLivenessGate',
    configPath: 'monitoring.sessionReaper.closeoutLivenessGate',
    description: 'Post-transfer closeout correctness (F1) — the SessionReaper closeout liveness gate: never terminate the live local session on a stale/unverified ownership record (spec: post-transfer-closeout-correctness).',
    justification: 'STRICTLY MORE CONSERVATIVE: the gate can only ever WITHHOLD a kill the closeout would otherwise have attempted (every uncertainty — false/unknown/dep-absent/throw — fails CLOSED to WITHHOLD), except the one liveness-CONFIRMED genuine-move case where it lets a true duplicate shed via a narrow audited keep-reason bypass. The terminate still routes through the guarded terminateSession authority (signal-vs-authority: the liveness reading only changes the DECISION to attempt, never bypasses a guard wholesale). The liveness snapshot reuses the existing GET /sessions fan-out (5s-timeout, owner-scoped) — no new endpoint, no extra fleet polling when the gate is off (the refresher is constructed ONLY when resolved on), machine-local (not replicated), no spend. Dogfooded live-on-dev before any fleet flip; the dev-gate per-machine resolution is CORRECT here because the closeout is a per-machine janitor making its OWN independently-safe decision (it never corrupts cross-machine state).',
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
    name: 'writeAdmission',
    configPath: 'multiMachine.writeAdmission.enabled',
    description: 'Standby-write reconciliation — ownership-scoped write admission + typed refusal (docs/specs/standby-write-reconciliation.md). Replaces the blanket lease-boolean standby guard with a per-domain, synchronous in-memory admission decision.',
    justification: 'Ships dryRun:true even on dev (FD-7 telemetry pattern): the layer only EVALUATES and logs would-verdicts while the legacy blanket guard keeps enforcing — zero authority, zero behavior change, no egress, no spend. Refusal authority is double-latched behind dryRun:false AND the wave-2 inventory constant (WRITE_SURFACE_INVENTORY_COMPLETE, §9.14), so live-on-dev soak is observe-only by construction. Single-machine agents are a strict no-op (every domain admits).',
  },
  {
    name: 'ws13Reconcile',
    configPath: 'multiMachine.seamlessness.ws13Reconcile',
    description: 'WS1.3 ownership reconcile — bounded pin/owner convergence (cooperative transfer→claim while the owner lives; force only with owner-death evidence + quorum).',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress; its in-component dryRun sub-knob (ws13DryRun) stays a plain hardcoded default true, so live-on-dev runs the reconcile loop but LOGS intended CAS actions without performing them (no destructive CAS) exactly as the rollout ladder intends; strict single-machine no-op inside the module. No third-party spend. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'ws13PinReplicate',
    configPath: 'multiMachine.seamlessness.ws13PinReplicate',
    description: 'Cross-machine reconciler convergence Fix #2 — replicate the user PIN (move-intent) as a `topic-pin-record` so the OWNING machine reads it (HLC-ordered, advisory, validated known+online) and starts the cooperative transfer. Sub-flag of WS1.3, independently rollback-able during soak.',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress; a replicated pin is ADVISORY move-intent that can only trigger the owner\'s OWN cooperative transfer (owner-gated FSM action), NEVER a force-claim/seat-steal (the force-claim decision is gated on death-evidence + quorum from machine liveness, never on the pin — a stale/corrupt pin cannot manufacture death evidence); rides the existing WS2 replicated-record machinery (HLC ordering, tombstone, quarantine); when dark the topic-pin emitter is a strict no-op (the store-enable entry is absent) and the reconciler reads no advisory pins; strict single-machine no-op (no peers). No destructive action, no third-party spend. Cross-machine reconciler convergence fix 2026-06-30.',
  },
  {
    name: 'ws41DurableAck',
    configPath: 'multiMachine.seamlessness.ws41DurableAck',
    description: 'WS4.1 durable operator-bound /ack across machines — a pooled-attention ack whose owner is briefly offline is persisted with the authenticated operator principal and re-delivered when the owner returns.',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress; the persisted intent is bound to the AUTHENTICATED operator and the owner REVALIDATES at apply time (a stale resolve against a since-escalated item is rejected — current state wins); when dark the routes 503 and the precedence guard is inert; strict single-machine no-op (no peers). No destructive action, no third-party spend. Operator directive 2026-06-13 topic 13481.',
  },
  {
    name: 'accountFollowMe',
    configPath: 'multiMachine.accountFollowMe.enabled',
    description: 'WS5.2 Account Follow-Me — seamless cross-machine account/quota sharing (re-mint per machine, ToS-safe; no OAuth token copied). Gates the non-credential metadata projection + the security primitives.',
    justification: 'No external egress and no third-party spend from the flag itself. The credential SHARE path (Mechanism A sealed-transport) is SEPARATELY gated by credentialTransport (default empty, anthropic REFUSED); the enroll path (Mechanism B) is operator-mandate-gated (deny-by-default, needs a PIN-issued mandate) — so the real authority is the operator mandate, NOT this flag. In PR1 there is NO live-credential code path at all (only the non-credential subscription-account-meta projection + inert primitives), so live-on-dev is functionally inert. Dev-live is the dogfooding intent (prove follow-me on the operator\'s own machines). Strict single-machine no-op. Operator directive 2026-06-13 topic 13481 + ws52-account-follow-me-security.md §9.',
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
    name: 'liveTestRunner',
    configPath: 'monitoring.liveTestRunner.enabled',
    description: 'Live-User-Channel Proof CAPSTONE runner (spec §6/§7.5) — makes the dark cross-machine transfer capstone harness RUNNABLE via POST /live-test/multi-machine-capstone: moves the seat first (POST /pool/transfer), demands the honest seatMoved signal, runs the §7.5 risk-category matrix through the REAL demo surfaces, and records a signed PASS/FAIL artifact (PASS only when the reply came FROM the target machine).',
    justification: 'Drives the operator\'s OWN machines + DEMO channels only (the §5.3 demo-channel isolation + fail-closed demo creds — a surface with no demo cred is BLOCKED-real, never the live agent token, never the live operator channel). The transfer it triggers is the operator\'s own /pool/transfer (the same lever a session calls), bounded + already-validated; the run only WRITES a local signed artifact (no egress beyond the operator\'s own demo workspaces, no third-party spend, no destructive action). When dark the /live-test/* routes 503 (strict no-op). Same dogfooding posture as liveTestGate / topicProfiles.',
  },
  {
    name: 'durableOwnership',
    configPath: 'multiMachine.durableOwnership.enabled',
    description: 'Transfer fix (live-user-channel-proof spec §7.2) — swaps the in-memory session-ownership store for a DURABLE per-session store + the OwnershipApplier that materializes ownership on the target from the REPLICATED placement journal, so a topic seat genuinely moves between machines.',
    justification: 'Coordinates between the operator\'s OWN machines only — no external egress. The durable store is a per-session atomic JSON write (a cache of journal-decided ownership, not a new authority); the applier only ADOPTS a placement strictly newer than local via fast-forward CAS (it can never clobber a fresher local decision) and runs OFF the routing hot path on an interval; fully reversible (flip back to InMemory — the journal remains the source of truth); single-machine = no-op (no peer placements to apply). No destructive action, no third-party spend. Runs live (dryRun N/A — no destructive write to gate) on dev / dark on fleet.',
  },
  {
    name: 'ownershipFollowsLiveWork',
    configPath: 'multiMachine.ownershipFollowsLiveWork',
    description: 'Ownership Follows Live Work (docs/specs/ownership-follows-live-work.md) — the ownership-record correction PR #1258 deferred: release-on-complete (A) + claim-on-autonomous-spawn (B) + a per-topic double-dispatch recovery gate (D), so the SessionOwnership record self-corrects toward where the live session actually is.',
    justification: 'Coordinates the operator\'s OWN machines only — no external egress, no third-party spend, no destructive fs/git action. Parts A/B add TWO fenced-epoch CAS callsites to the EXISTING replicated ownership lifecycle (the same SessionOwnershipRegistry.cas + emitPlacement path the user-move release/transfer already use): every write is best-effort, CAS-fenced at epoch+1, loses safely to a higher epoch, and is NEVER forced (force-claim stays the reconciler\'s death-evidence verb). Part D\'s ownerOf read is a SIGNAL that only ever WITHHOLDS a local re-run / forwards to the owner — it can never cause a new kill or a new send (strictly reduces double-dispatch). Single-machine agents are a strict no-op (_meshSelfId null short-circuits every gate). Runs live (no destructive write warrants a dry-run) on dev / dark on fleet. Spec\'s fleet-promotion exit is an evidence-gated dev soak.',
  },
  {
    name: 'idleThrottleSettleGate',
    configPath: 'monitoring.idleThrottleSettleGate.enabled',
    description:
      'Idle-monitor throttle settle-gate (false-ratelimit-recovery follow-up, CMT-1785) — the SessionManager idle-monitor gates its `rateLimitedAtIdle` hand-off behind the SAME settle discipline the SessionWatchdog already uses (throttle present AND pane byte-identical across polls = the turn genuinely ended on the throttle), instead of firing on a single glance at a throttle string that may be stale scrollback or a just-cleared transient throttle.',
    justification:
      'STRICTLY more conservative than the legacy behavior — it can only ever emit `rateLimitedAtIdle` LESS often, never more, so it cannot create a recovery that did not already happen; the genuine-throttle case still settles and hands off (after a bounded settle wait the watchdog also backstops). Pure decision extracted to `nextIdleThrottleAction` (unit-tested without tmux). No external egress, no third-party spend, no destructive action, no new authority — it only WITHHOLDS a spurious recovery signal. Reversible (flip the flag → legacy immediate emit). Runs live (no destructive write warrants a dry-run) on dev / dark on fleet; the deeper two-path detection unification stays a tracked follow-up.',
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
    name: 'externalHogSentinel',
    configPath: 'monitoring.externalHogSentinel.enabled',
    description:
      'External-hog zombie auto-kill sentinel (CMT-1901, /external-hog) — surfaces any sustained external CPU hog and auto-kills one narrow class (orphaned Electron editor extension-host wrappers). The intelligence (zombie-classify) decides kill/leave/alert WITHIN a mechanical veto-only safety floor.',
    justification:
      "This is a 4th process-killer, and its three siblings (sessionReaper/agentWorktreeReaper/mcpProcessReaper) are DARK_GATE_EXCLUSIONS as destructive — so it is admissible to DEV_GATED_FEATURES ONLY on the credentialRepointing-style ground that the `enabled` gate makes SCAN/CLASSIFY/LOG live while the KILL itself stays doubly-held: `dryRun: true` (the canary — live-on-dev scans, classifies, and LOGS would-kills but kills NOTHING) AND, orthogonally, a PIN-written armed marker (armEpoch > lastDisarmEpoch) that no config write, PATCH, strip-migration, or restart can produce. Live killing needs BOTH a deliberate dryRun:false AND a fresh PIN arm. A kill executes iff floor_pass && classifier==='kill'; the mechanical floor is veto-only (it can only BLOCK a kill, never trigger one) and the numeric kill-gate knobs are read-time clamped to code minimums so they can only ever act inside the owner-dead allowlist envelope. Every failure path fails SAFE (missing/unparseable signal → alert-never-kill; decider unavailable → no kill). Same dogfooding posture as topicProfiles / credentialRepointing.",
  },
  {
    name: 'staleOwnerRelease',
    configPath: 'multiMachine.sessionPool.staleOwnerRelease.enabled',
    description:
      'U4.2 stale-owner release (docs/specs/u4-2-stale-owner-release.md) — the CMT-1786 auto-failover: the serving-lease holder force-claims a provably-dead owner\'s topics behind the §2.2 evidence bar (death + all-transport disproof + quorum + claimant self-proof + side-effect recency), with the replicated topic-claim-annotation carrying budgets/suspensions/refusals across lease movement.',
    justification:
      'Ships dryRun:true (the dry-run canary): on a dev agent the evidence pass, probes, decision trace (logs/stale-owner-release.jsonl) and GET /pool/stale-owner-release all run LIVE, but the engine logs would-claims and NEVER lands a force-claim CAS while dryRun holds — zero authority moves; graduation past dry-run is gated on the spec §5 quantified soak (≥5 operator-corroborated would-claims, zero wrong) PLUS the emission-fence + observer-staleness prerequisites. Additionally subordinate to multiMachine.sessionPool being live AND ≥2 registered machines (strict no-op otherwise). Probes are read-only authenticated handshakes to the operator\'s OWN machines — no external egress, no spend, no destructive action while the canary holds. Same dogfooding posture as topicProfiles / credentialRepointing.',
  },
  {
    name: 'selfDeferralGuard',
    configPath: 'monitoring.selfDeferralGuard.enabled',
    description:
      'Turn-End Self-Deferral Guard (Phase A / shadow; docs/specs/turn-end-self-deferral-guard.md) — the UnjustifiedStopGate authority offers an allow-class U_SELF_DEFERRAL classification on every turn-end (B17 "within your own means") and RECORDS it as shadow telemetry in widened StopGateDb columns, with the last ≤3 user turns as bounded, fail-open conversational context.',
    justification:
      'OBSERVE-ONLY by construction — Phase A blocks NOTHING (no continue, no exit 2, no block path; §3.2 makes U_SELF_DEFERRAL an ALLOW-class verdict that can never produce a block, and §3.5 leaves the router block gate untouched). The `enabled` gate only switches whether the authority OFFERS the rule + four output fields in its prompt and whether the route records the self-deferral columns; OFF = the base stop-gate runs byte-identical (no U_SELF_DEFERRAL in the prompt, no columns recorded). ZERO new LLM calls (one added allow-rule label + four fields on the SINGLE existing evaluate() call), zero destructive action, zero egress. The transcript tail-read is bounded (reverse read, ≤256KB, ≤3 user turns, per-turn char clamp) and fail-open (any missing/unreadable/malformed transcript → empty context, contextTurns:0, never throws, never delays turn-end). Same dogfooding posture as topicProfiles.',
  },
  {
    name: 'strandedTopicSentinel',
    configPath: 'monitoring.strandedTopicSentinel.enabled',
    description:
      'Stranded-inbound detector (stranded-inbound-self-heal) — surfaces a Telegram/Slack topic whose owner machine is online-by-heartbeat but unable to serve (quota-walled or adapter-disconnected) while a healthy machine holds the lease, so inbound is silently dead for that topic. Raises ONE aggregated attention item per (owner-machine, stranding window).',
    justification:
      'PURE SIGNAL — its sole output is an advisory attention item; it MUTATES NOTHING (no ownership CAS, no pin write, no session kill, no direct user message). Lease-holder is the sole actor and a single-machine agent is a strict no-op, so across machines exactly one raises the item (no duplicate-voice). Synchronous + LLM-free + acquires NO spawn-cap slot (asserted by test); reads only the in-memory ownership cache + the replicated heartbeat pool view, with an explicit fail-closed staleness bound (every uncertainty — missing field, stale beat, underivable scope, pool view unavailable — routes to SKIP, never manufactures a strand). It can only ever ADD an attention item, already bounded by the existing AttentionTopicGuard flood ceiling. No egress beyond the operator-facing item, no spend, no destructive action. Runs live (no destructive write warrants a dry-run) on dev / dark on fleet. Auto-failover is a tracked v2 with named prerequisites.',
  },
  {
    name: 'machineCoherence',
    configPath: 'monitoring.machineCoherence.enabled',
    description:
      'Machine-coherence guard (machine-coherence-guard, roadmap 4.1 F4/P0-1) \u2014 the pool-wide version/flag/protocol/manifest skew EVALUATOR + episode/alarm machinery. Detects the F4 class (a dev-gated mesh feature resolving LIVE on one of the agent\u2019s machines and DARK on another silently halves a cross-machine guarantee) and raises ONE deduped episode-scoped attention item from exactly ONE elected machine. NOTE: only the evaluator/alarm ride this gate \u2014 the \u00a73.2 advert EMISSION ships live unconditionally (M3).',
    justification:
      'SIGNAL-ONLY \u2014 it never blocks, equalizes, or restarts anything; its sole output is one episode-scoped attention item (and the \u00a74.2.1 fix is operator-approval-gated per episode, never autonomous). Fully deterministic (Tier 0, no LLM call, no spend), no egress beyond the existing signed mesh reads, fails toward silence on evaluator error. Ships dryRun:true even on dev (dry-run FIRST: counters record would-raise, NO item) with the D7 soak criterion gating each rollout rung; single-machine agents are a strict no-op at every layer.',
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
    name: 'autonomousLivenessReconciler',
    configPath: 'monitoring.autonomousLivenessReconciler.enabled',
    description: 'Level-triggered self-heal for an autonomous run marked active but with no live session ("dead but marked active" — docs/specs/autonomous-liveness-reconciler.md).',
    justification: 'Ships dryRun-first (the component code-defaults dryRun:true): on the dev agent the gate makes the reconcile loop + GET /autonomous/liveness LIVE but it only LOGS "would respawn" until a deliberate dryRun:false flip — zero spawns, zero spend while dark/dryRun. Live, its only action is a bounded (P19 cap), lease-gated, operator-stop-respecting, quota-gated respawn of a run the run-state file already says should be alive — the strictly-safe direction. Never blocks/rewrites a message. Routes 503 when off.',
  },
  {
    name: 'autonomousHeartbeat',
    configPath: 'monitoring.autonomousHeartbeat.enabled',
    description: 'AutonomousProgressHeartbeat — hedged, change-gated, sparse liveness backstop for an autonomous run gone silent-to-user while output is still moving (autonomous-progress-heartbeat spec).',
    justification: 'Dev-gated under the Maturation Path standard. CAN send a user-facing Telegram line, so it does not ship LIVE on dev: its persisted ConfigDefaults default is `dryRun: true` (the route + tick run, but the final send is swapped for a "would emit" log, gated on the SAME cooldown/budget as live — no per-tick flood). So enabling on dev makes only the READ surface + dry-run observation live; an actual send requires a deliberate `dryRun: false` after the dev soak. Signal-only (never gates/blocks/rewrites); every predicate fails CLOSED on uncertainty; bounded by a long user-silence gate + a corroborated recent-output-change + per-topic cooldown + widening per-run backoff + a hard per-run cap + the shared one-voice ProxyCoordinator lease. No spend (no LLM), no destructive action.',
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
  {
    name: 'meshCoherenceLiveCheck',
    configPath: 'monitoring.meshCoherenceLiveCheck.enabled',
    description: 'Periodic mesh config-vs-live-state coherence check (signal-only log warnings; per-feature metric). Spec: docs/specs/mesh-coherence-live-state-honesty.md.',
    justification: 'Signal-only periodic log line; reads only own config + own registry self-entry (boolean presence) + own resolved bind host; no egress, no spend, no mutation, no destructive action — safe to soak live on a dev agent. Transition-only emit + capped half-open-breaker backoff bound the output; the live read is throw-wrapped (fails toward silence).',
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
  {
    name: 'degradationLadderBackoff',
    configPath: 'intelligence.degradationLadder.backoff.enabled',
    description: 'Resilient Degradation Ladder v1 (resilient-degradation-ladder.md) — the DEFERRABLE backoff rung (slow down + retry the same provider on a rate-limit via options.rateLimitWaitMs before swapping) + the GATING-call responsiveness budget (gatingLadderBudgetMs, default 6s).',
    justification: 'Internal-call routing only; behavior-preserving when off (absent ladder = EXACTLY today\'s framework-swap-only behavior). On a dev agent it runs live: backoff only adds bounded, jittered waits to DEFERRABLE (non-awaited, background) calls on a rate-limit, and the gating budget only caps the awaited-gate failure path at 6s — MORE responsive, never less safe (a gate still fails closed, never degrades to a heuristic). No spend increase (same call count or fewer), no destructive action, no egress. Queue rung lands in a later increment.',
  },
  {
    name: 'degradationLadderNeverSilent',
    configPath: 'intelligence.degradationLadder.neverSilent.enabled',
    description: 'Resilient Degradation Ladder §4 — never-silent degradation tracking: a non-gating call that exhausts the ladder (→ caller heuristic) opens a tracked degradation; a successful real-LLM answer auto-resolves it; a genuinely-stuck one (≥1 retry, open past 15m) escalates ONE deduped attention item; a run-once/idle one TTL-auto-closes (no false alarm).',
    justification: 'Observe-and-escalate only — opens/resolves an in-memory map and, on a genuinely-stuck degradation, sends ONE deduped fixed-template attention line. Designed to NOT repeat the 2026-06-21 DegradationReporter wedge: bounded (MAX_OPEN), O(1) per open/resolve, the sweep NEVER calls report()/reportEvent()/gateHealthAlert (it surfaces via telegramSender directly), liveness-gated (a run-once component auto-closes, never escalates). No spend, no destructive action; the only egress is the deduped escalation line the operator explicitly wants ("never silently degraded"). No-op when off.',
  },
  {
    name: 'degradationLadderQueue',
    configPath: 'intelligence.degradationLadder.queue.enabled',
    description: 'Resilient Degradation Ladder §3b.3 — the DEFERRABLE queue rung: a non-gating call that exhausts framework-swap WAITS for capacity in a dedicated LlmQueue (the enqueued provider.evaluate honors the account-global breaker retryAfterMs) instead of dropping straight to the caller heuristic; an enqueue rejection (daily-cap/reserve) or queued-call failure falls through to the heuristic, never dropped. Includes the opt-in §3c herd-pacing gap (drainMinGapMs, 0/off by default).',
    justification: 'Internal-call routing only; behavior-preserving when off (no llmQueue injected ⇒ the rung is a no-op ⇒ EXACTLY today\'s heuristic-on-exhaustion behavior). On a dev agent it runs live on DEFERRABLE (non-awaited, background) calls ONLY — a GATING call NEVER reaches the queue rung (structural: deferrable = !gating && deferrable; D5). The dedicated queue is bounded (maxConcurrent 1, its own small daily cap so it cannot starve interactive callers) and each enqueued call is timeout-bounded; it adds bounded WAITS, not new calls — no spend increase (same call count or fewer), no destructive action, no egress. Reuses the existing wedge-safe LlmQueue.',
  },
  // ── tmux Event-Loop Resilience, Increment 1 (tmux-event-loop-resilience-spec).
  //    The three gates ride the developmentAgent dark-feature gate: each ConfigDefaults
  //    sub-block OMITS `enabled` (NOT hardcoded false — #1001), so resolveDevAgentGate
  //    flips them LIVE on a dev agent / DARK on the fleet. All three are non-destructive
  //    and behavior-preserving (or strictly-safer) when off. ──
  {
    name: 'tmuxResilienceAsyncHotPath',
    configPath: 'monitoring.tmuxResilience.asyncHotPath.enabled',
    description: 'tmux Event-Loop Resilience (A) — the bounded async tmux hot path + tri-state classifier that stops a slow/wedged shared tmux server from blocking the event loop or spuriously reaping a live session.',
    justification: 'Behavior-preserving when off (D1/D6 — the off path is today\'s sync behavior byte-for-byte). When live the on-path is bounded (9s + SIGKILL per call) and CAPPED — single-flight coalescing per (op,session) + a max-in-flight ceiling mean it can never fan out MORE subprocesses than today, only fewer. Destructive actions become strictly POSITIVE-signal-gated: an indeterminate (slow/timed-out) tmux probe PRESERVES the session (never reaps), so the on-path is strictly safer than the current false-on-timeout reap. No egress, no third-party spend, no LLM, no new destructive action.',
  },
  {
    name: 'tmuxResilienceInFlightMarker',
    configPath: 'monitoring.tmuxResilience.inFlightMarker.enabled',
    description: 'tmux Event-Loop Resilience (B) — the in-flight-sync-op marker that lets SleepWakeDetector tell a ~0-CPU synchronous tmux/tunnel block apart from a real OS sleep (the block burns ~0 CPU so the CPU check can\'t see it).',
    justification: 'Signal-only — it changes ONLY the stall-vs-wake classification of a drift, never blocks/rewrites a message and never takes a destructive action. Both-directions-safe via the 2× per-call-timeout TTL self-heal: a leaked marker is auto-reset so a real multi-minute sleep that began mid-op re-classifies as a wake once the TTL expires, and the observable staleMarker counter surfaces any self-heal. Every read fails closed (a marker-read error is treated as not-in-flight). No egress, no spend, no destructive action.',
  },
  {
    name: 'tmuxResilienceLatencyGuard',
    configPath: 'monitoring.degradedTmuxGuard.enabled',
    description: 'tmux Event-Loop Resilience (C) — the DegradedTmuxGuard: a signal-only watcher that raises ONE deduped agent-health Attention item when the shared tmux server is degraded (slow sync calls / event-loop stalls). NEVER kills the shared socket.',
    justification: 'Observe-and-escalate only. Bounded by construction — a fixed-capacity O(1) modulo-write ring (never an unbounded array), load-gated (suppressed above a 1-min-load-per-core threshold so a busy multi-agent box does not false-fire) and N-cycle corroborated before any escalation. Signal vs Authority: the ONLY automated action is ONE deduped, NORMAL-priority agent-health Attention item; any actual tmux refresh is an explicit operator Y/N, never auto-performed. Registered in GUARD_MANIFEST with a pure in-memory getter (no I/O on the guard-status read). No spend, no egress beyond the operator-facing dedup line, no destructive action.',
  },
  {
    name: 'swapContinuity',
    configPath: 'subscriptionPool.swapContinuity.enabled',
    description: 'Swap-continuity in-flight work gate (swap-continuity-antithrash §4) — every session-killing mutation (proactive/reactive account swap, agent/API refresh) consults the SwapWorkGate at the SessionRefresh funnel: a proactive swap DEFERS over in-flight work (ceiling-dropped, never forced), a reactive swap gets a bounded ≤120s grace then proceeds WITH the F3 mitigations (enumerated killed subagents + re-injected unanswered inbound), an interactive refresh gets a structured session-busy refusal + force.',
    justification: 'Ships dryRun:true (the dry-run canary): on a dev agent the gate probes and LOGS every would-defer/would-refuse/would-mitigate verdict but changes NOTHING — every refresh kills exactly as today until a deliberate dryRun:false. The gate itself is deterministic structural-state math (pane footer / child process / subagent registry — Tier 0, no LLM), bounded on every edge (30-min deferral ceiling, 120-s reactive grace, force override, recovery-class exemption), and its uncertainty direction only ever DELAYS an optimization — it can never kill work, spend, or egress. Same dogfooding posture as topicProfiles / agentOwnedFollowthrough.',
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
  {
    configPath: 'prGate.classClosure.enabled',
    category: 'structural-stub',
    reason: 'class-closure gate increment 1 is CI-only report-only tooling (scripts/class-closure-lint.mjs) read at build time, NOT a runtime server feature — resolveDevAgentGate does not apply; enabled:false + dryRun:true is the intended report-only ship state (spec rollout step 1), enforcing is a later opt-in; no runtime consumer wired (route/escalator are increment 3), repo-gated no-op off the maintainer repo',
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
    configPath: 'multiMachine.sessionPool.ownershipCheckedSpawn.enabled',
    category: 'optional-integration',
    reason: 'G3 lease-gated spawn (MESH-SELF-HEAL-SPEC §3.3) — spawn iff holding the fenced awake-lease, else forward to holder; stops the duplicate-session harm. Dark→dry-run→dev-live→fleet, live-verified on the real Mini+Laptop pair before enablement.',
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
    configPath: 'multiMachine.leaseSelfHeal.staleHolderTakeover.enabled',
    category: 'action-bearing',
    reason: 'multi-machine-lease-self-heal F2 — when enabled, a standby TAKES OVER the awake lease from a non-renewing holder (a live authority change, CAS-fenced). Ships hard-dark on EVERY agent (dev included) because it changes who-is-awake and MUST be live-verified on the real Mini+Laptop pair (with an injected clock offset) before any enablement; off ⇒ canAcquire is byte-for-byte the legacy behavior. Opt-in per agent after soak. Spec: docs/specs/multi-machine-lease-self-heal.md.',
  },
  {
    configPath: 'multiMachine.leaseSelfHeal.silentStandbyRelinquish.enabled',
    category: 'action-bearing',
    reason: 'multi-machine-lease-self-heal F3 — when enabled, a muted (silent-standby) machine that still holds a lease RELINQUISHES it and broadcasts a signed tombstone (a live authority change). Ships hard-dark on EVERY agent because it mutates the live lease record; must be live-verified on the real pair (reading the relinquishing machine\'s own security.jsonl) before enablement. Opt-in per agent after soak. Spec: docs/specs/multi-machine-lease-self-heal.md.',
  },
  {
    configPath: 'multiMachine.leaseSelfHeal.soloCaptainHold.enabled',
    category: 'action-bearing',
    reason: 'multi-transport-mesh-comms Layer 3 — when enabled, a preferred stationary captain RETAINS the awake lease (a live authority change) instead of self-suspending when its sole peer is presumed-gone by liveness-silence. Ships hard-dark on EVERY agent because it changes who-is-awake under partition; preferred-awake + liveness gated; MUST be live-verified on the real Mini+Laptop pair (physically sever the peer, then return it at a higher epoch and assert one-tick stand-down) before enablement. Off ⇒ renew() is byte-for-byte the legacy self-fence. Opt-in per agent after soak. Spec: docs/specs/multi-transport-mesh-comms.md.',
  },
  {
    configPath: 'multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled',
    category: 'action-bearing',
    reason:
      'U4.4 lease hand-back (docs/specs/u4-4-lease-handback.md, R-r2-4) — when enabled, the serving lease is HANDED BACK to the F4 preferred captain (a live authority change: claim-before-release via a holder-signed single-use consent token). Ships hard-dark on EVERY agent (dev included) like its F2/F3/L3 siblings because it moves who-is-awake; MUST be live-verified on the real Mini+Laptop pair (fail over, heal, watch the hand-back fire at a clean boundary, canary-verify ingress) before any enablement, then dev-dry-run → dev-live → fleet. dryRun:false is additionally boot-refused unless pollFollowsLease is live (the lease/ingress-split chokepoint). Documented Maturation-Path exception.',
  },
  {
    configPath: 'threadline.a2aCheckIn.enabled',
    category: 'action-bearing',
    reason: 'A2A check-in summarizer — sends UNBOUNDED user-facing Telegram summaries on a heartbeat while a conversation is active; live-on-dev would flood the operator. Opt-in to keep the operator un-flooded.',
  },
  {
    configPath: 'multiMachine.stateSync.threadlinePairing.enabled',
    category: 'action-bearing',
    reason: 'Secure A2A Verified Pairing §3.8 — replicates the verified-IDENTITY RESULT of a pairing across the agent\'s own machines; the inherited record AUTHORIZES the identity half of the credential-share gate on a peer machine (key-pinned). A credential-gating surface, so it ships hard-dark with explicit enabled:false + dryRun:true on EVERY agent (dev included) — the cautious rollout posture the spec mandates, NOT the dev-gate-live posture of the 7 WS2 memory/PII stores. NEVER replicates the SAS, shared secret, or relay token (structurally — they are not fields of the replicated result). Opt-in per agent after soak.',
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
