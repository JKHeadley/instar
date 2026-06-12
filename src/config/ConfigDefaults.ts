/**
 * ConfigDefaults — Single source of truth for Instar agent config defaults.
 *
 * RULES FOR THIS FILE:
 * 1. Only include fields that are SAFE for all agents (not runtime-generated)
 * 2. Never include: port, authToken, paths, dashboardPin, chatId, botToken
 * 3. If a field differs by agent type, put it in TYPE_OVERRIDES
 * 4. If a field should be more conservative for existing agents, put it in MIGRATION_OVERRIDES
 * 5. Every field here is auto-applied to existing agents on update via PostUpdateMigrator
 * 6. Adding a field here is equivalent to adding it to BOTH init AND migration
 *
 * Runtime-generated fields that MUST NOT appear here:
 *   port, authToken, dashboardPin, stateDir, projectDir, tmuxPath, claudePath,
 *   chatId, botToken, appToken, token (any credential), webhookUrl
 */

import { DEFAULT_TIER_ESCALATION_CONFIG } from '../core/ModelTierEscalation.js';

/** Fields shared across ALL agent types and contexts (init + migration) */
const SHARED_DEFAULTS: Record<string, unknown> = {
  // Model-Tier Escalation (FABLE-MODEL-ESCALATION-SPEC §9/§10). Ships DARK
  // fleet-wide (enabled:false, dryRun:true); dev agents (Echo/Codey) are
  // flipped by hand in the same ship, gated on the §5.3 pre-enable canary.
  // The block is the §9 schema verbatim via the single source of truth in
  // ModelTierEscalation.ts. applyDefaults is add-missing-only with deep
  // recursion, so an operator's existing `enabled`/`dryRun` (or any other
  // field) is NEVER overwritten on migration (round-1 Lessons-H2, the
  // burn-alert clobber incident) — missing sub-fields are backfilled.
  models: {
    tierEscalation: DEFAULT_TIER_ESCALATION_CONFIG,
  },
  monitoring: {
    memoryMonitoring: true,
    healthCheckIntervalMs: 30000,
    // Boot health beacon — ships OFF (dark). When enabled, a minimal /health
    // responder answers from the start of boot so the supervisor can't mistake a
    // slow boot for a dead process (topic 21816 root cause #1). Absent ⇒ off.
    bootHealthBeacon: {
      enabled: false,
    },
    // Default-on so SessionWatchdog runs everywhere — required for the
    // compaction-idle polling fallback to actually fire.
    watchdog: {
      enabled: true,
    },
    // RateLimitSentinel — default-on so every agent rides out Anthropic's
    // server-side throttle instead of dropping the session. enabled:false
    // restores pre-feature behavior. See docs/specs/rate-limit-sentinel.md.
    rateLimitSentinel: {
      enabled: true,
    },
    // Parallel-Work Awareness sentinel (Phase B) — the proactive overlap councilor.
    // Ships DARK (enabled:false): a false-positive nudge is worse than silence, so it
    // graduates only after it's proven quiet. When enabled it ticks on a cadence
    // (lease-holder only), detects cross-topic work overlap, and emits ONE deduped
    // councilor nudge. Signal-only; never gates. docs/specs/parallel-activity-coherence.md.
    parallelWorkSentinel: {
      enabled: false,
    },
    // ResourceLedger — default-on so every agent durably records its rate-limit
    // events (breaker trips + sentinel detections) instead of losing them on
    // restart. Read-only observability; never gates. Event-driven, negligible
    // cost. enabled:false leaves the ledger null (route 503s).
    //   Phase A = rate-limit events (always on with the ledger).
    //   Phase B = continuous CPU% + RSS SAMPLING of the agent's server + its
    //     spawned sessions. The sampler itself rides the developmentAgent gate
    //     (live on echo, dark on the fleet) — these dials only tune it once on.
    //     sampleIntervalMs is the active cadence; it backs off to
    //     idleSampleIntervalMs when no sessions are running (idle-CPU-floor
    //     friendly); retentionDays bounds the sample table.
    // See docs/specs/per-agent-resource-ledger.md.
    resourceLedger: {
      enabled: true,
      sampleIntervalMs: 60_000,
      idleSampleIntervalMs: 5 * 60_000,
      retentionDays: 7,
    },
    // Observable Intelligence (docs/specs/observable-intelligence.md): the
    // per-feature LLM audit trail (/metrics/features + the LLM Activity dashboard
    // tab) is kept long enough to see behaviour/performance trends, then aged out.
    // retentionDays bounds the table (0/negative disables pruning). Recording
    // itself is always on at the funnel; this only governs how long it's kept.
    featureMetrics: {
      retentionDays: 30,
    },
    // SocketDisconnectSentinel + ActiveWorkSilenceSentinel — default-on so
    // every agent recovers from connection drops and silent mid-task freezes
    // without anyone having to notice manually. enabled:false restores
    // pre-feature behavior. See docs/specs/silently-stopped-trio.md.
    socketDisconnectSentinel: {
      enabled: true,
    },
    // ActiveWorkSilenceSentinel — detect a session that was working then went
    // silent → nudge → escalate. ONLY the detection switch is persisted here
    // (default-ON is stable; it kills nothing). The destructive auto-heal flag
    // `autoRecover` (respawn the stalled session) is DELIBERATELY OMITTED for
    // the same reason as ContextWedgeSentinel.autoRecovery above: applyDefaults()
    // is add-missing-only, so persisting `autoRecover: false` now would freeze it
    // and a later default-on flip could never reach existing agents. The dark
    // default lives as the runtime fallback in server.ts (`autoRecover === true`).
    // Graduated-Feature-Rollout promotion = flip that runtime check's effect and
    // add `autoRecover: true` here so new agents + the rollout observer see it.
    activeWorkSilenceSentinel: {
      enabled: true,
    },
    // ContextWedgeSentinel — detect+recover the "thinking blocks ... cannot be
    // modified" 400 fast-fail wedge. ONLY the detection switch is persisted here
    // (it kills nothing; default-ON is stable). The destructive fresh-respawn
    // flag `autoRecovery` is DELIBERATELY OMITTED from these persisted defaults:
    // applyDefaults() is add-missing-only, so persisting autoRecovery.enabled
    // now would freeze it and a later default-on flip could never reach existing
    // agents. Instead the autoRecovery default lives as the runtime fallback in
    // server.ts (the trio block). Graduated-Feature-Rollout promotion to
    // default-on = (1) flip that runtime literal so every existing agent without
    // a persisted override inherits it on next update, and (2) add
    // `autoRecovery: { enabled: true }` here so new agents + the rollout observer
    // (rollout-flag-path: monitoring.contextWedgeSentinel.autoRecovery) see it.
    // See docs/specs/context-wedge-sentinel.md.
    contextWedgeSentinel: {
      enabled: true,
    },
    // SessionReaper — pressure-aware reaper of idle-but-alive sessions.
    // UNLIKE the sentinels above, default OFF + dry-run: it is the only monitor
    // that *kills* sessions on a heuristic, so it ships dark and must be flipped
    // on by an operator after validating the dry-run log over a real pressure
    // event. enabled:false → never runs; dryRun:true → logs would-reap, kills
    // nothing. See docs/specs/SESSION-REAPER-SPEC.md.
    sessionReaper: {
      enabled: false,
      dryRun: true,
      tickIntervalSec: 120,
      minAgeMinutes: 30,
      confirmObservations: 3,
      confirmWindowMinutes: 10,
      paneCaptureLines: 200,
      recentUserWindowMinutes: 30,
      idleThresholdModerateMinutes: 45,
      idleThresholdCriticalMinutes: 15,
      normalTierReaps: false,
      maxReapsPerTick: 3,
      maxReapsPerHour: 12,
      finalGraceSec: 60,
      protectOpenCommitments: true,
      staleCommitmentWindowMinutes: 480, // 8h — silent 8h stops an open commitment/idle children from pinning a session (operator: restarts are cheap)
      reapStaleIdleWithActiveChildren: true, // 24h-silent + idle + flat-transcript reaps even with idle children (e.g. idle MCP servers)

      // CPU pressure: overall tier = WORST of memory (free %) and CPU (1-min load
      // ÷ cores), so a CPU-bound box raises pressure even when memory is fine.
      cpuModerateLoadPerCore: 1.0,
      cpuCriticalLoadPerCore: 1.5,
      // Under CPU pressure, require positive descendant-CPU progress before the
      // active-process existence-veto keeps a session (a wedged/idle child no
      // longer holds an idle session hostage). Ships dark; dev agents enable it
      // via developmentAgent. No-op off-pressure / when CPU can't be sampled.
      cpuAwareActiveProcessKeep: false,
      cpuActiveMinRatePerSec: 0.02,
      // Observe-only busy-orphan detection (inverse of the above): audit a
      // `busy-orphan-suspected` row when an idle session is pinned by a
      // CPU-burning child. Never changes the verdict. Ships dark; dev agents on.
      busyOrphanDetection: false,
      busyOrphanConfirmTicks: 5,
    },
    // Reap-notification (UNIFIED-SESSION-LIFECYCLE §P3). Default ON — the single
    // coalescing listener that surfaces "your session was shut down" so a reap is
    // never silent (the disappearing-session incident). recovery-bounce + operator
    // kills stay silent regardless; terminal reaps within the window collapse into
    // one consolidated lifeline message.
    reapNotify: {
      enabled: true,
      coalesceWindowMs: 60_000,
    },
    // AgentWorktreeReaper (Responsible Resource Usage — OS resource hygiene).
    // Reclaims stale CLI-created worktrees under .worktrees/ that are merged +
    // clean + inactive. Ships OFF + dry-run (it deletes worktrees on a heuristic);
    // review a dry-run pass (GET /worktrees/agent-reaper) before enabling.
    agentWorktreeReaper: {
      enabled: false,
      dryRun: true,
      reapIntervalMs: 86_400_000,
      maxReapsPerPass: 20,
    },
    // McpProcessReaper (Responsible Resource Usage — MCP-leak fix, Option B).
    // Reaps leaked MCP-server children (playwright-mcp / mcp-remote / instar
    // stdio) whose owning session is dead/stale or fully orphaned — killing a
    // session's main pid does NOT cascade to these children, so they re-parent
    // and accumulate for days (the fleet hit ~80, up to 5 days old). Ships OFF +
    // dry-run (it kills processes); review a dry-run pass (GET /processes/mcp-
    // reaper) before enabling. NEVER touches a proc under a live/tracked session
    // or an external (non-instar) tmux session.
    mcpProcessReaper: {
      enabled: false,
      dryRun: true,
      minAgeMs: 7_200_000,
      reapIntervalMs: 1_800_000,
      maxReapsPerPass: 25,
      maxAncestorHops: 30,
    },
    // Agent hard-sleep — SleepController decision foundation (Stage B, slice 1;
    // docs/specs/agent-hard-sleep-controller.md). Decides "is it safe for this
    // idle agent to drop its server to near-zero footprint?" with every safety
    // guard (held lease / in-flight work / imminent scheduled job). Ships OFF +
    // dry-run: observes + audits to logs/agent-sleep-events.jsonl, never stops a
    // server. The mechanism (supervisor stop + lifeline respawn) is a later slice.
    agentSleep: {
      enabled: false,
      dryRun: true,
      tickIntervalSec: 60,
      idleGraceMs: 120_000,
      deepIdleMs: 900_000,
      wakeLeadMs: 120_000,
    },
    // Unkillability backstop (UNIFIED-SESSION-LIFECYCLE §P5). Default ON, signal-
    // only: raises ONE deduped Attention item (never auto-kills) when a session is
    // KEPT forever despite faking work, or is stuck indeterminate. The escalation
    // thresholds match the spec (30 min no-forward-progress / 15 indeterminate).
    staleBackstop: {
      enabled: true,
      tickIntervalSec: 120,
      unverifiableEscalateMinutes: 30,
      conversationalEscalateMinutes: 180,
      indeterminateEscalateCount: 15,
      progressFloorBytes: 512,
    },
    // Failure-Learning Loop (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md). Ships
    // OFF — when disabled, the /failures routes 503-stub (surface still exists
    // for capability probing). Registers itself on the rollout board.
    failureLearning: {
      enabled: false,
      minSupport: 4,
      minDistinctSessions: 3,
      minDistinctCauseCommits: 3,
      attributionConfidenceFloor: 0.6,
      insightTelegramEscalation: false,
      // Ingestion sources (spec §4.4) — all off by default; applyDefaults
      // deep-merges this into existing agents without surprise activation.
      sources: {
        ci: false,
        revert: false,
        regression: false,
        regressionIncludesBackslide: false,
        degradation: [],
        ciMaxRunsPerTick: 50,
      },
    },
    // Correction & Preference Learning Sentinel
    // (docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md §9). Ships OFF.
    // SIGNAL-ONLY — never blocks/rewrites an outbound message. Slice 1a wires the
    // preferences read-surface (GET /preferences/session-context → 503 when off);
    // Slice 1b adds the capture→distill→ledger→recurrence loop. applyDefaults
    // deep-merges this into existing agents without surprise activation (no
    // separate migrateConfig block needed — verified deep-merge at
    // ConfigDefaults.deepMerge + applyDefaults add-missing recursion).
    // BlockerLedger (docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md, Piece 1)
    // — the resolution-workflow + memory layer completing Principle 1. Dev-gated
    // dark feature: `enabled` is deliberately OMITTED so the runtime resolves it
    // via resolveDevAgentGate — LIVE on a development agent (dogfood), DARK on
    // the fleet (the /blockers routes 503). Registered in DEV_GATED_FEATURES.
    blockerLedger: {},
    correctionLearning: {
      enabled: false,
      // Self-Violation Signal extension (ships DARK). Even when correctionLearning
      // is enabled, the outbound self-violation observe-only hook stays inert
      // unless this sub-flag is ALSO true. SIGNAL-ONLY — never blocks a message.
      selfViolationSignal: false,
      minSupport: 4,
      minDistinctDaysInfraGap: 3,
      minDistinctDaysPreference: 2,
      minDistinctTopicsPreference: 2,
      autoFeedback: false,
      telegramDigest: false,
      driftCanary: false,
      driftCanaryDailyCents: 5,
      llmDailyCents: 25,
      llmMaxConcurrent: 1,
      captureContextTurns: 6,
      captureTopicMapMax: 64,
      captureTopicTtlMinutes: 60,
      distillPerTopicRatePerMinute: 8,
      verifyWindowDaysInfraGap: 14,
      verifyWindowDaysPreference: 7,
      maxInjectedPreferencesBytes: 4000,
      preferencesInjectionPriority: 'recency*confidence*dedupeCount',
      maxReopens: 2,
      maxRoutesPerTick: 5,
      feedbackPostDelayMs: 7000,
      // Durable capture-backlog with retry (resilience extension). ON when the
      // feature is enabled — a rate-limited distill persists the pre-scrubbed
      // capture instead of dropping it. captureBacklogMaxEntries: 0 disables it
      // (old drop-on-throttle behavior). Backfilled via applyDefaults deep-merge.
      captureBacklogMaxEntries: 200,
      captureBacklogTtlHours: 24,
      captureBacklogDrainPerTick: 5,
      captureBacklogMaxRetries: 3,
    },
    // GrowthMilestoneAnalyst — the proactive growth & milestone analyst.
    // `enabled` is deliberately OMITTED so the runtime resolves it through the
    // standard developmentAgent dark-feature gate (`enabled ?? !!developmentAgent`,
    // standard_development_agent_dark_feature_gate) in AgentServer: LIVE on the
    // dev agent (the dogfooding ground, e.g. echo), DARK fleet-wide. The
    // live-fleet flip is registering `enabled: true` here. The window-expiry
    // trigger keeps the incubation window TIGHT (3d low-risk / 7d standard) so a
    // feature can never be silently left behind. Promotion requires real
    // proof-of-life, never elapsed time alone.
    // Spec: docs/specs/PROACTIVE-GROWTH-MILESTONE-ANALYST-SPEC.md
    growthAnalyst: {
      digestCron: '0 11 * * 1',
      // Slice 2 (GrowthDigestPublisher) ships dark even on a dev agent: COMPUTE +
      // EXPOSE is already live, but the new SEND behavior stays opt-in until the
      // operator advances it, so merging the code buzzes no one.
      digestDelivery: 'off',
      // A fully-calm week is silent by default (no "all healthy" heartbeat — the
      // exact noise burnDetection was killed for).
      digestSendOnCalmWeeks: false,
      incubationWindows: { lowRisk: 3, standard: 7, highRisk: 7 },
      proofOfLifeMinActivations: 1,
      rules: {
        promotionReady: true,
        incubationExpired: true,
        initiativeStalling: true,
        specPattern: true,
        correctionPattern: true,
      },
      specPatternMinTotal: 3,
      specPatternMinChangeRatio: 0.6,
      correctionPatternMinOccurrences: 3,
      digestEvenWhenCalm: true,
    },
    // ApprenticeshipCycleSlaMonitor — observe-only overdue-cycle signal. Ships
    // OFF so no install starts raising Attention topics until the operator opts
    // in. Dedup is per cycle id and the monitor never mutates the cycle store.
    apprenticeshipCycleSla: {
      enabled: false,
      overdueAfterMinutes: 120,
    },
    // GeminiCapacityEscalationMonitor — observe-only escalation when Gemini is
    // capacity-blocked (deferred by #708) longer than escalateAfterMinutes.
    // Ships OFF; raises one Attention item per deferral episode, never mutates
    // the gate. Closes item-3's "escalate, not silently stall" half.
    geminiCapacityEscalation: {
      enabled: false,
      escalateAfterMinutes: 60,
    },
    // ReleaseReadinessSentinel (docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md
    // §4.2). Ships OFF — Echo dogfoods first. Repo-gated: inert unless the
    // install has an analyzable instar git repo. Thresholds default to
    // silent <2d, LOW ≥2d, MEDIUM ≥4d, HIGH ≥7d.
    releaseReadiness: {
      enabled: false,
      tickIntervalMs: 21_600_000,
      backlogAgeDaysSilent: 2,
      backlogAgeDaysLow: 2,
      backlogAgeDaysMedium: 4,
      backlogAgeDaysHigh: 7,
      hysteresisHours: 12,
      staleEpisodeTtlDays: 30,
      fetchTimeoutMs: 30_000,
    },
    // Master gate for Telegram delivery of silently-stopped-sentinel
    // escalations. Default false → sentinel notices are housekeeping and stay
    // in the logs (server.log + sentinel-events.jsonl). Set true to receive
    // ONE consolidated heads-up in the existing system topic when a genuine
    // recovery-failed silence occurs. Default-false in response to the
    // 2026-05-22 topic-spam flood. See docs/specs/silently-stopped-trio.md.
    sentinelTelegramEscalation: false,
    promptGate: {
      enabled: true,
      autoApprove: {
        enabled: true,
        fileCreation: true,
        fileEdits: true,
        planApproval: false,
      },
      dryRun: false,
    },
  },
  threadline: {
    relayEnabled: false,
    visibility: 'public',
    capabilities: ['chat'],
    // A2A Coherence Layer 4 — keep the operator in the loop on agent-to-agent
    // conversations WITHOUT flooding them. Ships DARK (enabled:false): the
    // check-in summarizer is inert until the operator opts in. `heartbeatEnabled`
    // gates the silence-breaker; `heartbeatIntervalMs` is its cadence (operator
    // refinement, 2026-06-02: every 5-10 min while a conversation is active and
    // nothing has surfaced). applyDefaults add-missing semantics → migrateConfig
    // backfills these on existing agents on update (Migration Parity).
    // Spec: docs/specs/THREADLINE-A2A-COHERENCE-SPEC.md Layer 4.
    a2aCheckIn: {
      enabled: false,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 420000, // 7 min — middle of the 5-10 min range
    },
    // Warm-session A2A keep-alive (THREADLINE-WARM-SESSION-A2A-INTEGRATION-SPEC).
    // DARK-SHIP: `enabled` is deliberately OMITTED so the server resolves it via
    // the developmentAgent gate (`enabled ?? !!config.developmentAgent`) — live
    // on Echo, dark on the fleet. Caps/TTL/floor are conservative so a flood
    // can't pin processes. applyDefaults deep-merges this nested block under the
    // existing `threadline` key on update (Migration Parity), so existing agents
    // backfill the caps without an explicit patch.
    warmSessionA2A: {
      globalCap: 3,
      perPeerCap: 1,
      ttlMs: 600000, // 10 min
      trustFloor: 'verified',
    },
  },
  // Topic-intent auto-capture loop (rung 0 of continuous-working-awareness).
  // ON by default (ratified): every substantive conversation turn gets a cheap
  // fast-tier "anything worth filing?" read so the per-topic briefing/ArcCheck
  // have real material. Bounded by a deterministic pre-filter + per-topic rate
  // ceiling + the shared LlmQueue daily cap + QuotaTracker load-shedding, and
  // fire-and-forget so it never slows message delivery. enabled:false is the
  // kill-switch (store + read routes remain, capture goes inert).
  // See docs/specs/topic-intent-capture-loop.md.
  topicIntent: {
    capture: {
      enabled: true,
    },
    // ArcCheck (Layer 3) — pre-send classifier wired into the outbound tone
    // gate as one more signal source. Default ON (ratified). Kill switch:
    // arccheck.enabled=false leaves the HTTP route mounted but the classifier
    // dark (returns degrade-open verdict), and skips the in-process call in
    // checkOutboundMessage. Spec: docs/specs/topic-intent-arccheck-wiring.md.
    arccheck: {
      enabled: true,
    },
  },
  // Framework-Onboarding Mentor System (§19.4). Ships DORMANT: enabled:false +
  // mode:'off' so POST /mentor/tick returns {ran:false,reason:'disabled'} and
  // nothing spawns or spends. Promotion off → dry-run → live is the human's, via
  // the graduated-rollout track. See docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md.
  mentor: {
    enabled: false,
    mode: 'off',
    menteeFramework: 'codex-cli',
    minIntervalMs: 600000, // 10-min floor between ticks (anti-forced-cadence)
    maxRoundsPerDay: 24,
    dailySpendCapUsd: 0.5,
    // The "just be Echo" autonomous-fix loop (MENTOR-AUTONOMOUS-FIX-LOOP-SPEC):
    // when enabled, the heartbeat keeps ONE full-tool Opus loop session alive on
    // the manual dogfooding loop (assign → observe → FIX as a fleet PR → report)
    // instead of the haiku observe-pipeline. Ships dark; opt-in per agent.
    autonomousFix: {
      enabled: false,
      model: 'opus',
      sessionNamePrefix: 'mentor-autoloop',
      maxCycleMinutes: 120,
    },
  },
  // Mentee receiver wiring (MENTOR-LIVE-READINESS-SPEC §Recipient side).
  // The mirror of the mentor block: this agent ACCEPTS inbound mentor prompts
  // from allowlisted mentor agents (anti-spoof gated on bot id), spawns a
  // mentee session, and sends the reply back via sendAgentMessage role=
  // 'mentor-reply' correlated to the incoming marker. Ships DORMANT
  // (enabled:false). When enabled, requires localAgentName + knownMentors +
  // replyChatId + replyTopicId to actually install the hook — any missing
  // piece logs a one-line skip and the wiring stays dark.
  mentee: {
    enabled: false,
    localAgentName: '',
    knownMentors: {},
    replyChatId: '',
    replyTopicId: 0,
    sessionTimeoutMs: 300000, // 5 min bounded-wait per session
  },
  // Spec-review standards-conformance gate (rung-3 normative slice). Default-on:
  // the gate reads docs/STANDARDS-REGISTRY.md and signals possible standard
  // violations in a draft spec. Signal-only (never blocks); 503-stubs where the
  // constitution isn't present. See docs/specs/standards-conformance-gate.md.
  specReview: {
    conformance: {
      enabled: true,
    },
    // Report-Backed Converging Audit (docs/specs/CONVERGING-AUDIT-DEFAULT.md).
    // When true, the instar-dev PRECOMMIT gate ADDITIONALLY requires the
    // converging-audit report file (docs/specs/reports/<slug>-convergence.md) to
    // exist for each in-scope spec — proving the audit actually RAN, not that a
    // tag was hand-added. Default FALSE = byte-identical to today's precommit
    // behavior (the report requirement is inert). The precommit script reads NO
    // config (it runs pre-compile), so the .husky/pre-commit hook exports this
    // as the env var INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT=1 when true. The
    // FORMAL StageTransitionValidator already requires the report
    // unconditionally; this flag only brings the precommit UP to that strictness.
    // applyDefaults is add-missing-only deep-merge, so this backfills into every
    // existing agent on update with no separate migrateConfig block.
    requireConvergenceReport: false,
  },
  // Usher (rung 4) — signal-only mid-task re-surface watcher. Default-on: it only
  // writes suggestions to a read-only pull surface (never injects, never pushes to
  // chat), so safe-on. enabled:false stops the watcher. See docs/specs/cwa-usher.md.
  usher: {
    enabled: true,
  },
  // Scheduler default-on. Autonomous-continuity tasks (org-intent drift
  // audits, threadline sync, post-update self-healing) only fire when the
  // scheduler runs, so agents shipping without it lose silent infrastructure
  // that operators expect to be present. Conservative migration: only
  // BACKFILLS when `enabled` is missing (per applyDefaults semantics);
  // never overrides an explicit `false`. codex-instar audit Item 5.
  scheduler: {
    enabled: true,
  },
  // Backup overrides. `includeFiles` is set-unioned with BackupManager's
  // DEFAULT_CONFIG.includeFiles — the empty default here means users and
  // migrators can ADD paths (e.g. pr-pipeline state) without displacing
  // the built-in identity/memory defaults.
  backup: {
    includeFiles: [] as string[],
  },
  // PR-REVIEW-HARDENING-SPEC Phase A default: all /pr-gate/* routes
  // 404 until explicitly flipped by Phase B+. Runtime kill-switch.
  prGate: {
    phase: 'off' as const,
  },
  // Restart-cascade dampener — minimum ms between two update-driven restart
  // requests. AutoUpdater batches a new restart that lands within this window
  // of the previous one into a single deferred restart, so two updates in
  // quick succession don't produce two user-visible restart cycles. Set to 0
  // to disable. See src/core/RestartCascadeDampener.ts.
  updates: {
    restartCascadeDampenerWindowMs: 15 * 60_000,
  },
  // Lifeline drift auto-promoter — when the server's version handshake
  // reports the lifeline is significantly behind, the lifeline self-restarts
  // at the next clean window to catch up. See src/lifeline/LifelineDriftPromoter.ts.
  lifeline: {
    driftPromoter: {
      enabled: true,
      threshold: 20,
      pollIntervalMs: 30_000,
      maxDeferMs: 60 * 60_000,
    },
  },
  // Multi-Machine Session Pool (spec docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md).
  // Ships DARK. Adding ONLY the sessionPool sub-block here (never multiMachine.enabled)
  // means applyDefaults() merges it under an existing multiMachine block without
  // clobbering, and adds an inert multiMachine:{sessionPool} to agents that have no
  // multiMachine block — neither path enables multi-machine. The entire session-pool
  // layer is a no-op unless enabled:true AND stage advanced past 'dark' (StageAdvancer,
  // Track H). This is the migration-parity path: every existing agent gets the dark
  // defaults on update. The `stage` field is StageAdvancer-write-only at runtime.
  multiMachine: {
    sessionPool: {
      enabled: false,
      stage: 'dark',
      dryRun: true,
      clockSkewToleranceMs: 300000,
      maxExpectedNtpDriftMs: 250,
      machineRecordEvictionMs: 86400000,
      meshRpcClockToleranceMs: 30000,
      // §L4 router/dispatch tunables (spec §Config). The SessionRouter ships with
      // matching hardcoded DEFAULT_ROUTER_CONFIG; these expose them for operators.
      deliverMessageTimeoutMs: 5000,
      deliverMessageMaxRetries: 3,
      placementHysteresisDelta: 0.15,
      ownershipCasMaxRetries: 5,
      // §L5 transfer / handoff tunables (spec §Config).
      transferDrainTimeoutMs: 30000,
      transferOutputCutoffMs: 1000,
      placementCooldownMs: 300000,
      topicPlacementUpdateMinIntervalMs: 10000,
    },
    // Coherence Journal (COHERENCE-JOURNAL-SPEC §3.7). DARK-SHIP: `enabled` is
    // deliberately OMITTED — the runtime resolves `enabled ?? !!developmentAgent`
    // (live on the dev agent, dark on the fleet), mirroring
    // selfKnowledge.sessionContext. applyDefaults add-missing semantics →
    // migrateConfig backfills these literals on existing agents (Migration Parity).
    // retention.rotateKeep semantics: N>0 = keep N archives, delete older;
    // 0 = rotate at maxFileBytes but NEVER delete (bounded files, history forever).
    coherenceJournal: {
      flushIntervalMs: 250,
      scannerIntervalMs: 60000,
      replication: { maxBatchBytes: 262144 },
      // Working-Set Handoff (WORKING-SET-HANDOFF-SPEC §3.7). NO enable flag
      // here — the feature activates IFF replication.enabled === true (the
      // pull is meaningless without replication's mesh path and must never
      // out-activate it). These are the transfer's bounded-behavior dials.
      workingSet: {
        maxFileBytes: 4194304,
        headlineFileBytes: 16777216,
        maxFiles: 64,
        maxTotalBytes: 33554432,
        pullMaxBatchBytes: 1048576,
        pullOnMove: true,
        pendingPullTtlDays: 7,
        chunkRestartCap: 3,
        chunksPerTick: 8,
        serveConcurrency: 2,
        rearmConcurrency: 1,
        busyRetryCap: 10,
      },
      // Commitments Coherence (COMMITMENTS-COHERENCE-SPEC §3.6). No enable
      // flag — rides replication.enabled === true like the working set.
      commitments: {
        syncPageBytes: 262144,
        maxSyncPagesPerTick: 4,
        replicaStaleWarnMs: 600000,
        pendingMutationTtlDays: 7,
        maxPendingOpsPerCommitment: 4,
        maxPendingOpsPerOwner: 64,
        opKeyTtlDays: 7,
      },
      retention: {
        'topic-placement': { maxFileBytes: 8388608, rotateKeep: 0 },
        'session-lifecycle': { maxFileBytes: 16777216, rotateKeep: 4 },
        'autonomous-run': { maxFileBytes: 8388608, rotateKeep: 8 },
        // P3 (THREADLINE-CONVERSATION-COHERENCE-SPEC §3.4): the 4th kind —
        // applyDefaults add-missing backfills existing agents.
        'threadline-conversation': { maxFileBytes: 8388608, rotateKeep: 8 },
      },
    },
  },
  // Session Boot Self-Knowledge (spec: session-boot-self-knowledge.md) — the
  // "what I already have" block (vault secret NAMES + operational facts) the
  // session-start hook injects at boot. DARK-SHIP: `sessionContext.enabled` is
  // deliberately OMITTED so the route resolves it via the developmentAgent
  // gate (`enabled ?? !!config.developmentAgent`) — live on the dev agent,
  // dark on the fleet; the live-fleet flip (registering `enabled: true` here)
  // is the tracked follow-up per the spec's rollout Resolution rule.
  // NOTE: `InstarConfig.selfKnowledge` is DISTINCT from the SelfKnowledgeTree
  // metadata field on AgentContextSnapshot — different type, different system.
  // applyDefaults add-missing semantics → migrateConfig backfills on update
  // (Migration Parity); an operator's existing operationalFacts are never touched.
  selfKnowledge: {
    sessionContext: {
      maxInjectedBytes: 2000,
    },
    operationalFacts: [],
  },
  // Autonomous Completion Discipline (spec: AUTONOMOUS-COMPLETION-DISCIPLINE.md §5).
  // The structural enforcement of "don't stop a pre-approved autonomous run early."
  // `autonomousSessions` is NOT otherwise seeded in SHARED_DEFAULTS, so we add the
  // whole object; `maxConcurrent` is read elsewhere with a `?? 5` fallback and is
  // intentionally LEFT OUT here to avoid changing that behavior. applyDefaults is
  // add-missing-only → existing agents backfill these on update (Migration Parity),
  // and an operator's explicit value is never overwritten. The hook reads
  // `enabled` + `judgeTimeoutMs` at the chokepoint (no restart needed to toggle).
  autonomousSessions: {
    completionDiscipline: {
      // Operator-mandated behavior ("the completion bar is the FULL feature"),
      // not a dark-launch experiment (Open-Q2 → on). The flag exists for instant
      // rollback, not a graduated ramp.
      enabled: true,
      // curl -m budget (ms) for a single judge HTTP call before the hook gives up
      // and falls open per §3 item 4 / §4. DISTINCT from the Claude hook `timeout`
      // (effectively unbounded at 10000 seconds) — this bounds judge REACHABILITY
      // under load, sized generously given this fleet's rate-limit latency history.
      judgeTimeoutMs: 35000,
      // Coarse rotation for logs/autonomous-hard-blocker.jsonl (consistent with
      // other logs/*.jsonl).
      hardBlockerLogRotateBytes: 1048576,
      // Circuit-breaker (cites IntelligenceRouter precedent §3 item 4): after K
      // consecutive judge failures in the window, short-circuit to the cheap
      // checkbox-only decision for the cooldown.
      judgeFailBreakerThreshold: 3,
      judgeFailWindowMs: 600000,
      judgeFailCooldownMs: 600000,
      // Per-field clamp on the <hard-blocker> marker fields before JSON-encoding.
      markerFieldMaxChars: 500,
      // Real-check verification (ACT-152 / autonomous-completion-real-checks spec).
      // When an autonomous job declares a `verification_command`, the stop-hook RUNS
      // it on a met:true verdict and gates the exit on exit-0 (fail/timeout → keep
      // working — the SAFE direction; never causes a premature exit). A NO-OP unless
      // a job actually declares a command, so `enabled:true` costs nothing for jobs
      // that don't use it. Read LIVE at the chokepoint (no restart to toggle), nested
      // under completionDiscipline so applyDefaults backfills it per-leaf to existing
      // agents (Migration Parity — no migrateConfig block needed).
      realCheck: {
        enabled: true,
        // Bounded per-run command timeout (ms). Timeout → FAIL → keep working.
        timeoutMs: 120000,
        // Tail-clamp on the captured output surfaced as next-turn guidance.
        maxChars: 2000,
        // Source-bound: cap the captured stdout+stderr at read time (a runaway
        // command can never buffer GB into the hook before the clamp).
        captureBytes: 65536,
        // P19 breaker: after K consecutive real-check failures in the window, the
        // real-check breaker OPENS for the cooldown — cheap checkbox-only continue
        // (no judge re-fire, no command run) so a stuck/flaky command can't spin the
        // judge + command every iteration to duration.
        failBreakerThreshold: 3,
        failWindowMs: 600000,
        failCooldownMs: 600000,
      },
    },
  },
  // Cartographer doc-tree — hierarchical semantic map with git-hash staleness
  // (cartographer-doc-tree-schema spec #1). `enabled` is deliberately OMITTED so
  // the runtime resolves it through the standard developmentAgent dark-feature
  // gate (`enabled ?? !!developmentAgent`, standard_development_agent_dark_feature_gate):
  // LIVE on a dev agent (the zero-cost read surfaces dogfood there), DARK fleet-wide.
  // Registered in DEV_GATED_FEATURES (src/core/devGatedFeatures.ts). The live-fleet
  // flip is registering `enabled: true` here. Spec: DEV-AGENT-DARK-GATE-ENFORCEMENT.
  cartographer: {
    maxDepth: 12,
    // Doc-freshness sweep (spec #2). A nested key under cartographer so the
    // deep-merge add-missing path backfills it to existing agents (no migrateConfig
    // block needed). Ships dark behind BOTH enabled AND freshnessSweep.enabled, and
    // additionally requires egressAcknowledged:true (enabling the off-Claude sweep
    // transmits source content to a third-party framework — a separate consent gate).
    freshnessSweep: {
      enabled: false,
      egressAcknowledged: false,
      cadenceMs: 600000,          // 10 min, idle-aware backoff
      idleCadenceMs: 1800000,     // 30 min while there is no work / breaker-open
      maxNodesPerPass: 25,
      maxCentsPerPass: 25,        // dual bound with node count; whichever binds first
      estCentsPerAuthor: 1,
      maxLeafBytes: 24576,        // 24 KB committed-content cap per leaf author
      minSummaryChars: 24,
      maxSummaryChars: 600,
      // Target off-Claude framework. The §5 runtime probe is what actually
      // guarantees off-Claude; this is the documented intent. 'default' is refused
      // unless allowClaudeFallback is true.
      framework: 'codex-cli',
      allowClaudeFallback: false,
      zeroProgressTicksToBreak: 3,
      breakerReescalateHours: 6,
      nodeFailQuarantineThreshold: 3,
      maxDeferredPasses: 5,
      revalidateSamplePerPass: 2,
      minNodesUnderPressure: 3,
      // ── Event-loop safety (fix instar#1069) — backfilled to existing agents by
      // the applyDefaults deep-merge (server reads each via num(fsCfg.X, default)). ──
      detectInWorker: true,           // detect/index-writes run off the main event loop (false = sync rollback)
      detectTimeoutMs: 120000,        // worker await bound; on timeout → terminate + refuse
      detectWorkerHeapMb: 1536,       // worker V8 heap cap, co-sized with maxIndexBytes (≈6× parse expansion + headroom)
      maxIndexBytes: 209715200,       // 200MB pre-parse byte guard (200×6 ≈ 1200MB < heap; refuse above this)
      snapshotSampleMax: 500,         // cap on the /stale snapshot sample
      gitMaxBuffer: 67108864,         // 64MB explicit git ls-tree buffer (never the 10MB default that throws)
      detectCandidateHeadroom: 4,     // maxCandidates = maxNodesPerPass × this
      maxRequestNodes: 50000,         // /cartographer/tree (full) ceiling → too-large-for-request above
      scaffoldChunkNodes: 500,        // boot-path chunked scaffold: node-ops per macrotask before yielding
    },
    // Standards Enforcement-Coverage Audit (cartographer-conformance-audit spec #3).
    // A nested key under cartographer so the deep-merge add-missing path backfills
    // it to existing agents (no migrateConfig block needed). `enabled` is deliberately
    // OMITTED so the runtime resolves it through the developmentAgent dark-feature gate
    // (`enabled ?? !!developmentAgent`, standard_development_agent_dark_feature_gate):
    // LIVE on a dev agent (zero-egress deterministic core dogfoods there), DARK fleet-wide.
    // Registered in DEV_GATED_FEATURES. The deterministic core reads local files only
    // (zero egress); the OPTIONAL llmEnrichment path is the only egress and ships OFF
    // (an unwired structural stub — see DARK_GATE_EXCLUSIONS). The value shipped today
    // is the deterministic coverage map — the LLM path is dark.
    conformanceAudit: {
      llmEnrichment: {
        enabled: false,
        egressAcknowledged: false,
        framework: 'codex-cli',
        allowClaudeFallback: false,
      },
      // CI ratchet floor on the enforced ratio (ratchet+gate+lint / total). The
      // committed floor lives in scripts/standards-coverage.mjs; this config mirror
      // is advisory (the script's hardcoded constant is the read baseline).
      ratchetFloor: 0,
    },
    // Subtree Navigation (cartographer-subtree-nav spec #5). A nested key under
    // cartographer so the deep-merge add-missing path backfills it to existing
    // agents (no migrateConfig block needed). The deterministic navigator is the
    // shipped value (zero egress — reads the local index/summaries only) and is
    // available whenever cartographer.enabled. The OPTIONAL llmRerank path is the
    // only egress and ships OFF (it additionally requires egressAcknowledged:true);
    // it is a dark structural stub — no real LLM pipeline is wired here.
    subtreeNav: {
      maxDepth: 6,
      branchingFactor: 4,
      maxNodesVisited: 200,
      maxResults: 25,
      minScore: 0.1,
      collapseFraction: 0.6,
      llmRerank: {
        enabled: false,
        egressAcknowledged: false,
        framework: 'codex-cli',
        allowClaudeFallback: false,
      },
    },
  },
  // Topic Profile (TOPIC-PROFILE-SPEC §12.5) — per-topic model/thinking/framework
  // pins. `enabled` is deliberately OMITTED so the runtime resolves it through the
  // standard developmentAgent dark-feature gate (`enabled ?? !!developmentAgent`,
  // standard_development_agent_dark_feature_gate): LIVE on a dev agent (Echo, the
  // dogfooding ground), DARK fleet-wide. Registered in DEV_GATED_FEATURES
  // (src/core/devGatedFeatures.ts); the live-fleet flip is registering
  // `enabled: true` here. A literal `enabled: false` would force-dark dev agents
  // too — the exact PR #1001 failure the §12.5 lint refuses. An operator's
  // EXPLICIT `enabled` in .instar/config.json remains the documented
  // force-dark / fleet-flip override. dryRun:true is the §14 shadow-field canary
  // (logs intended respawns, performs none). applyDefaults is add-missing-only
  // deep-merge, so existing agents backfill these on update (Migration Parity)
  // and an operator's existing values are NEVER overwritten; `defaults` is an
  // operator-owned map and is left alone whenever present.
  topicProfiles: {
    dryRun: true,                         // §14 — shadow-field dry-run
    respawnDebounceMs: 7000,              // same-framework trailing-edge window (§8)
    frameworkSwitchDebounceMs: 45000,     // heavier framework-switch window (§8)
    maxConcurrentProfileRespawns: 2,      // global stagger cap K (§8)
    spawnFailureBreakerThreshold: 3,      // §10.4 N (attributable failures)
    switchNowConfirmTtlMs: 300000,        // §8 'switch now' validity window
    defaults: {},                         // per-topic config-default profiles (§5.2)
  },
};

/**
 * Fields that differ between agent types at INIT time.
 * These override SHARED_DEFAULTS when creating new agents.
 */
const TYPE_OVERRIDES: Record<string, Record<string, unknown>> = {
  'managed-project': {
    monitoring: { quotaTracking: false },
    externalOperations: {
      enabled: true,
      sentinel: { enabled: true },
      services: {},
      readOnlyServices: [],
      trust: {
        floor: 'collaborative',
        autoElevateEnabled: true,
        elevationThreshold: 5,
      },
    },
    tunnel: {
      enabled: true,
      type: 'quick',
      // Tunnel-failure-resilience (spec Part 4). Existence-checked deep-merge,
      // so existing agents pick these up on update without overwriting any
      // values they've already set.
      relayProviders: ['localtunnel'],
      relaysEnabled: true,
      relayConsent: 'ask',
      consentTimeoutMs: 900000,
      notifyTopic: 'dashboard',
    },
  },
  standalone: {
    monitoring: { quotaTracking: true },
    externalOperations: {
      enabled: true,
      sentinel: { enabled: true },
      services: {},
      readOnlyServices: [],
      trust: {
        floor: 'collaborative',
        autoElevateEnabled: true,
        elevationThreshold: 5,
      },
    },
  },
};

/**
 * Fields that should use MORE CONSERVATIVE values when migrating to existing agents.
 * These override SHARED_DEFAULTS + TYPE_OVERRIDES during migration only.
 *
 * Rationale: existing agents were operating without these features.
 * Silently enabling permissive settings could change security posture.
 * New agents get the permissive defaults; existing agents get conservative ones.
 */
const MIGRATION_OVERRIDES: Record<string, unknown> = {
  externalOperations: {
    enabled: true,
    sentinel: { enabled: true },
    services: {},
    readOnlyServices: [],
    trust: {
      floor: 'supervised',        // More conservative than init's 'collaborative'
      autoElevateEnabled: false,   // Don't auto-elevate existing agents
      elevationThreshold: 10,      // Higher threshold
    },
  },
};

// ── Deep Merge Utility ──

/**
 * Deep merge source into target (mutates target).
 * Arrays are treated as opaque leaves (replaced, never merged/concatenated).
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (
      typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
      typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      target[key] = structuredClone(source[key]);
    }
  }
}

// ── Public API ──

export type AgentType = 'managed-project' | 'standalone';

/**
 * Get the complete defaults for a given agent type (used by init).
 * Returns a deep copy safe to mutate.
 */
export function getInitDefaults(agentType: AgentType): Record<string, unknown> {
  const base = structuredClone(SHARED_DEFAULTS);
  const overrides = TYPE_OVERRIDES[agentType];
  if (overrides) {
    deepMerge(base, structuredClone(overrides));
  }
  return base;
}

/**
 * Get the defaults for migration (used by PostUpdateMigrator).
 * Uses conservative overrides for security-sensitive fields.
 */
export function getMigrationDefaults(agentType: AgentType): Record<string, unknown> {
  const base = getInitDefaults(agentType);
  deepMerge(base, structuredClone(MIGRATION_OVERRIDES));
  return base;
}

/**
 * Apply defaults to an existing config. Only adds MISSING keys.
 * Never overwrites existing values. Respects _instar_noMigrate.
 *
 * Arrays are treated as opaque leaves — if present, left alone; if absent, added whole.
 *
 * @returns { patched, changes, skipped }
 */
export function applyDefaults(
  config: Record<string, unknown>,
  defaults: Record<string, unknown>,
): { patched: boolean; changes: string[]; skipped: string[] } {
  const noMigrate = new Set<string>(
    Array.isArray(config._instar_noMigrate)
      ? config._instar_noMigrate as string[]
      : [],
  );

  const changes: string[] = [];
  const skipped: string[] = [];

  function merge(target: Record<string, unknown>, source: Record<string, unknown>, path: string): void {
    for (const key of Object.keys(source)) {
      const fullPath = path ? `${path}.${key}` : key;

      // Skip fields the user explicitly opted out of
      if (noMigrate.has(fullPath) || noMigrate.has(key)) {
        skipped.push(`${fullPath} (opted out via _instar_noMigrate)`);
        continue;
      }

      if (!(key in target)) {
        // Key is missing — add it
        target[key] = structuredClone(source[key]);
        changes.push(`${fullPath} (added)`);
      } else if (
        typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
        typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
      ) {
        // Both are objects — recurse
        merge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>, fullPath);
      } else {
        // Key exists with a non-object value, or one side is an array — don't touch
        // (includes type mismatches like boolean vs object — skip, don't crash)
      }
    }
  }

  merge(config, defaults, '');
  return { patched: changes.length > 0, changes, skipped };
}
