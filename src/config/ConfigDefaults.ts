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
  // Doorway/Model Knowledge Registry — the recurring doorway-scan job's config knob
  // (docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md §D6). Fail-closed defaults:
  // free-probes (zero metered spend), weekly cadence, no digest topic, and a $0 money
  // cap so no metered probe can EVER run until an operator sets a positive cap AND opts
  // into a metered scope by hand. applyDefaults is add-missing-only (seeds `0`/`null`
  // correctly and never clobbers an operator override), and it runs on BOTH init and
  // migration — so existing agents get this on update (Migration Parity).
  //
  // `enabled` is DELIBERATELY OMITTED. Whether the scan RUNS is governed by the
  // job-manifest `enabled` flag (seeded false); `maintenance.doorwayScan.enabled` is a
  // master kill-switch with DENY-WINS semantics (`config.enabled !== false`). A seeded
  // `false` would make `false !== false` false and PERMANENTLY block the scan even after
  // the operator enables the job manifest — the round-2/round-5 bug. So seed every field
  // EXCEPT `enabled` (which stays absent unless the operator sets it).
  maintenance: {
    doorwayScan: {
      scope: 'free-probes',
      cadence: '0 4 * * 1',
      digestTopicId: null,
      budgetCapUsd: 0,
    },
  },
  // Dashboard Live-LLM-Insights (docs/specs/dashboard-live-insights.md) — the
  // per-page Insight Strip. `enabled` is DELIBERATELY OMITTED so
  // resolveDevAgentGate resolves it (LIVE on a development agent, DARK on the
  // fleet; /insights routes 503 when dark) — the standard maturation ladder, not
  // a flat default-false (a seeded `enabled:false` is the #1001 mechanism that
  // would force-dark even a dev agent). `dryRun:true` is the SPEND canary: the
  // LLM layer is inert (deterministic floor served, "would generate" logged)
  // until a deliberate `dryRun:false`. applyDefaults is add-missing-only, so an
  // operator's existing overrides are never clobbered (Migration Parity).
  dashboard: {
    liveInsights: {
      dryRun: true,
      ttlSeconds: 300,
      maxLines: 3,
      llmTimeoutMs: 12000,
    },
  },
  // Fork-bomb prevention — host-wide concurrent-LLM-subprocess cap (the SIMPLE
  // design, docs/specs/forkbomb-prevention-simple.md §D-CAP). A SAFETY FLOOR:
  // ON by default fleet-wide — a safety floor that ships dark is no floor. The
  // values are read at call sites with a plain `?? default` (env > config > the
  // hardcoded default), so absence is already safe; seeding them here just
  // materializes the operator-tunable knobs. applyDefaults is add-missing-only,
  // so an operator's hand-tuned value is NEVER overwritten on migration.
  intelligence: {
    spawnCap: {
      maxConcurrent: 8,
      acquireMs: 5000,
      waitersMax: 64,
      // F5 interactive-priority reservation. `enabled` is DELIBERATELY OMITTED so it
      // rides the dev-agent gate (live-on-dev / dark-fleet); the reserves default 2/2.
      interactivePriority: {
        ri: 2,
        rb: 2,
      },
    },
    // Test-Runner Concurrency Bound — the spawn cap's sibling for vitest roots
    // (docs/specs/test-runner-concurrency-bound.md §2.9). These values mirror
    // the CODE defaults and tune the route report + server-launched tooling
    // ONLY — NOT the chokepoint (its kill switch is env
    // INSTAR_HOST_TEST_SEMAPHORE=off; its host-uniform authority is the
    // ~/.instar/host-test-runner-tuning.json tuning file). Seeded here purely
    // to materialize the operator-visible knobs (add-missing-only, matching
    // the spawnCap treatment — a hand-tuned value is never overwritten).
    testRunnerCap: {
      enabled: true,
      maxConcurrent: 1,
      acquireWaitMs: 120000,
    },
    // Non-gating provider failure-swap timeout. This is deliberately longer than the
    // safety-gating swap cap (`intelligence.swapAttemptTimeoutMs`, default 5s inline)
    // because advisory/background calls can wait through a cold-start provider without
    // slowing fail-closed gates. applyDefaults seeds missing config only; operator
    // overrides are preserved on migration.
    nonGatingSwapTimeoutMs: 15000,
  },
  monitoring: {
    memoryMonitoring: true,
    healthCheckIntervalMs: 30000,
    // Boot health beacon — a minimal /health responder that answers from the start
    // of boot so the supervisor can't mistake a slow boot for a dead process (topic
    // 21816 root cause #1). DEV-GATED (CMT-1438): `enabled` is deliberately OMITTED
    // so resolveDevAgentGate decides — LIVE on a developmentAgent, DARK on the
    // fleet. NEVER hardcode `enabled: false` here (it would dark dev agents too).
    bootHealthBeacon: {},
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
    // DEV-GATED (CMT-1438): `enabled` is OMITTED so resolveDevAgentGate decides —
    // LIVE on a developmentAgent (dogfood), DARK on the fleet. A false-positive nudge
    // is worse than silence on the fleet, so it graduates there only after the dev
    // dogfooding proves it quiet. When live it ticks on a cadence (lease-holder only),
    // detects cross-topic work overlap, and emits ONE deduped in-process councilor
    // nudge (signal-only; never gates). docs/specs/parallel-activity-coherence.md.
    parallelWorkSentinel: {},
    // tmux Event-Loop Resilience, Increment 1 (tmux-event-loop-resilience-spec).
    // The (A) async hot path + (B) in-flight-sync-op marker. DEV-GATED: each
    // sub-block's `enabled` is deliberately OMITTED so resolveDevAgentGate decides
    // — LIVE on a developmentAgent (dogfood), DARK on the fleet. NEVER hardcode
    // `enabled: false` here (#1001 — it would dark dev agents too). Only the tuning
    // knobs are defaulted; applyDefaults() stays add-missing-only so an operator's
    // explicit `enabled` is never overwritten on migration. (A) is behavior-
    // preserving when off (today's sync path); (B) is signal-only (changes only
    // stall-vs-wake classification, both-directions-safe via the 2× TTL self-heal).
    tmuxResilience: {
      asyncHotPath: { timeoutMs: 9000, maxInFlight: 4 },
      inFlightMarker: { staleTtlFactor: 2 },
    },
    // DegradedTmuxGuard (C) — signal-only watcher that raises ONE deduped agent-health
    // Attention item when the shared tmux server is degraded (slow sync calls / event-
    // loop stalls). NEVER kills the shared socket (operator-authorized refresh only).
    // DEV-GATED + GUARD_MANIFEST-keyed on monitoring.degradedTmuxGuard.enabled: the
    // flag is OMITTED so resolveDevAgentGate decides — LIVE on a developmentAgent, DARK
    // on the fleet. NEVER hardcode `enabled: false` here (#1001). Bounded ring O(1),
    // load-gated, N-cycle corroborated. Only the tuning knobs are defaulted.
    degradedTmuxGuard: {
      windowSize: 64,
      ewmaAlpha: 0.3,
      slowCallThresholdMs: 9000,
      episodeCorroborationCycles: 3,
      loadGateMaxLoadPerCore: 1.5,
      episodeEscalateIntervalMs: 1_800_000,
      settleWindowMs: 60_000,
    },
    // AutonomousLivenessReconciler — a level-triggered self-heal for an autonomous
    // run marked active (with time remaining) but with NO live session ("dead but
    // marked active"). DEV-GATED: `enabled` is deliberately OMITTED so
    // resolveDevAgentGate decides — LIVE on a developmentAgent, DARK on the fleet.
    // NEVER hardcode `enabled: false` here (it would dark dev agents too). Ships
    // dryRun-FIRST on dev (logs "would respawn" + a shadow "would-have-capped"
    // until a deliberate dryRun:false flip — zero spawns while dark/dryRun).
    // docs/specs/autonomous-liveness-reconciler.md.
    autonomousLivenessReconciler: {
      dryRun: true,
      tickIntervalSec: 120,
      debounceTicks: 2,
      debounceWindowSec: 180,
      respawnTimeoutMs: 45000,
      respawnCapPerWindow: 3,
      respawnCapWindowSec: 21600,
      spawnFailureRetryCeiling: 6,
      maxPressureBlockedTicks: 10,
      maxPressureBlockedSec: 1800,
      allowFreshFallback: false,
      notifyUser: true,
    },
    // AutonomousProgressHeartbeat — hedged, change-gated, sparse liveness backstop
    // for an autonomous run gone silent-to-user while its output is still moving.
    // DEV-GATED: `enabled` is OMITTED so resolveDevAgentGate decides — LIVE on a
    // developmentAgent (dogfood), DARK on the fleet (GET /autonomous-heartbeat
    // 503s). NEVER hardcode `enabled: false` here (it would dark dev agents too).
    // `dryRun: true` holds it to "would emit" logging (same cooldown/budget gates
    // as live, no per-tick flood) until the dev soak proves it quiet. The
    // threshold/tick/backoff defaults live in the component; persisting only
    // dryRun keeps applyDefaults() add-missing-only. Spec:
    // docs/specs/autonomous-progress-heartbeat.md.
    autonomousHeartbeat: {
      dryRun: true,
    },
    // U4.5 — Rope-Health Alerts (docs/specs/u4-5-rope-health-alerts.md §5).
    // DEV-GATED: `enabled` is DELIBERATELY OMITTED (not hardcoded false) so
    // resolveDevAgentGate decides at runtime — LIVE on a development agent day
    // one, DARK on the fleet (GET /mesh/rope-health 503s, no evaluation timer).
    // Registered in DEV_GATED_FEATURES (`ropeHealthAlerts`). `urgentEnabled`
    // rides the same gate (the action-bearing question is answered in the
    // registry justification — R-r2-6). `digestTopicId` default UNSET (R-r2-8):
    // the digest job logs only until the operator names their hub topic.
    ropeHealth: {
      urgentEnabled: true,
      urgentDebounceMs: 60_000,
      clearSustainMs: 600_000,
      keyExpiryWarnDays: 14,
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
      // HONEST-PROGRESS-MESSAGING D — operator-tunable rollback levers (the
      // monitors' DEFAULT_CONFIG already carries these, so behavior reaches every
      // agent via code; persisting them here surfaces them for tuning and is the
      // documented rollback path). UNLIKE the dark `autoRecover` flag above, these
      // are STABLE defaults, not a dark flag awaiting a fleet flip — so persisting
      // them is intentional. silenceThresholdMs raised 15m→30m; the 90m
      // activeWorkMaxFrozenIndicatorMs is the A5 frozen-indicator backstop.
      silenceThresholdMs: 1_800_000, // 30m (was 15m) — A4
      activeWorkMaxFrozenIndicatorMs: 5_400_000, // 90m — A5 frozen-indicator backstop
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
      // v2 per-topic grouping (reap-notify spec R1.1) — every affected topic
      // gets its own notice; false = legacy single-buffer rollback lever.
      perTopic: true,
      // Max notices released IMMEDIATE in one flush (R1.5).
      maxImmediatePerFlush: 5,
      // NOTE deliberately ABSENT: reapNotify.drainEnabled and ALL
      // monitoring.resumeQueue.* keys are CODE-defaulted (reap-notify spec
      // §Config) — writing them here would freeze today's defaults into
      // every agent's config and break the later fleet flip of the shipped
      // dryRun default.
    },
    // AgentWorktreeReaper (Responsible Resource Usage — OS resource hygiene).
    // Reclaims stale CLI-created worktrees under .worktrees/ that are merged +
    // clean + inactive. Ships OFF + dry-run (it deletes worktrees on a heuristic);
    // review a dry-run pass (GET /worktrees/agent-reaper) before enabling.
    agentWorktreeReaper: {
      enabled: false,
      dryRun: true,
      reapIntervalMs: 86_400_000,
      initialPassDelayMs: 900_000,
      maxReapsPerPass: 20,
    },
    // OrphanedWorkSentinel — the silent-uncommitted-death backstop (2026-06-12,
    // topic 22367): detects an agent worktree with uncommitted work whose owning
    // session is DEAD and that has SETTLED, records it, and raises ONE deduped
    // attention item. Needs nothing registered — it reads the stranded work off
    // disk (the case the PromiseBeacon escalation ladder can't see). Signal-only;
    // `preserveWork` (off) writes a non-destructive preservation patch. `enabled`
    // is OMITTED so the runtime resolves it through the standard developmentAgent
    // dark-feature gate (resolveDevAgentGate): LIVE on a dev agent, DARK on the
    // fleet. Registered in DEV_GATED_FEATURES; review GET /orphaned-work.
    orphanedWorkSentinel: {
      scanIntervalMs: 600_000,
      settleMs: 480_000,
      preserveWork: false,
      maxFlagsPerPass: 10,
    },
    // ExternalHogSentinel (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md):
    // surfaces any sustained external CPU hog and AUTO-KILLS one narrow class (orphaned
    // Electron editor extension-host wrappers). Intelligence decides kill/leave/alert
    // WITHIN a mechanical veto-only floor; kill iff floor_pass && classifier==='kill'.
    // `enabled` is OMITTED so the runtime resolves it through the developmentAgent
    // dark-feature gate (resolveDevAgentGate): LIVE on a dev agent, DARK on the fleet.
    // `dryRun: true` is the canary — live-on-dev scans/classifies/LOGS would-kills but
    // kills NOTHING until a deliberate PIN-gated arm. The numeric kill-gate knobs are
    // read-time clamped to code-defined minimums. Registered in DEV_GATED_FEATURES.
    externalHogSentinel: {
      dryRun: true,
      scanIntervalMs: 60_000,
      cpuCoreThreshold: 1.5,
      sustainedSampleCount: 3,
      sampleWindowMs: 30_000,
      singleFlightBudgetMs: 20_000,
      killTimeCpuRecheckWindowMs: 2_500,
      sigtermGraceMs: 12_000,
      inFlightKillTtlMs: 36_000,
      maxKillDeferrals: 3,
      killLedgerMaxPerSignaturePerHour: 3,
      maxClassificationsPerScan: 4,
      classifierCacheTtlMs: 300_000,
      classifierCacheMaxEntries: 256,
      inFlightKillSetMax: 64,
      noticeBudgetPerWindow: 4,
      noticeWindowMs: 600_000,
    },
    // Turn-End Self-Deferral Guard (Phase A / shadow; docs/specs/turn-end-self-
    // deferral-guard.md): the UnjustifiedStopGate authority OFFERS an allow-class
    // U_SELF_DEFERRAL classification on every turn-end and RECORDS it as shadow
    // telemetry (widened StopGateDb columns). Phase A blocks NOTHING. `enabled`
    // is OMITTED so the runtime resolves it through the developmentAgent dark-
    // feature gate (resolveDevAgentGate): LIVE on a dev agent, DARK on the fleet.
    // OFF-state = the base stop-gate runs unchanged, no U_SELF_DEFERRAL rule in
    // the prompt, no self-deferral columns recorded. Registered in
    // DEV_GATED_FEATURES. Empty block = the gate decides at runtime.
    selfDeferralGuard: {},
    // Durable-Output Hygiene Standard §2 (Layer B — "What Persists Must Be
    // Clean", docs/specs/durable-output-hygiene-standard.md): the config-gated
    // DurableOutputScrubber redacts credential SPANS from LLM output at durable-
    // output persistence chokepoints BEFORE the write. `enabled` is OMITTED so the
    // runtime resolves it through the developmentAgent dark-feature gate
    // (resolveDevAgentGate): LIVE on a dev agent, DARK on the fleet. `dryRun: true`
    // is the canary — live-on-dev COMPUTES + records would-redact metrics but
    // stores the ORIGINAL text (no durable mutation) until a deliberate
    // dryRun:false flip, which is the OPERATOR'S endpoint decision (a false-positive
    // redaction destroys data — Frontloaded Decision #4; the dev agent self-flips
    // only on the §Frontloaded-Decision-#4 soak criterion). DO NOT hardcode
    // `enabled` here — a baked-in false would dark dev agents too (the #1001 shape
    // the dark-gate lint forbids for a dev-gated block). perStore is the per-store
    // opt-out map (the bypass-carries-its-own-cap per-store control).
    durableOutputScrub: {
      dryRun: true,
      perStore: {},
    },
    // StrandedTopicSentinel (stranded-inbound-self-heal): a PURE-SIGNAL detector
    // that surfaces a topic whose owner machine is online-by-heartbeat but unable
    // to serve (quota-walled or adapter-disconnected) while a healthy machine
    // holds the lease, so inbound is silently dead for that topic. Raises ONE
    // aggregated attention item per (owner-machine, stranding window); MUTATES
    // NOTHING. `enabled` is OMITTED so the runtime resolves it through the
    // standard developmentAgent dark-feature gate (resolveDevAgentGate): LIVE on a
    // dev agent, DARK on the fleet. Registered in DEV_GATED_FEATURES; GET /guards.
    strandedTopicSentinel: {
      tickMs: 60_000,
      dwellMs: 30_000,
      freshnessBoundMs: 45_000,
      clearAfterTicks: 3,
    },
    // Build-Session Yield Safety (ACT-839): a reaped session with uncommitted
    // worktree work becomes resume-eligible + gets a tracked commit-or-preserve
    // obligation. `enabled` is OMITTED so the developmentAgent dark-feature gate
    // resolves it (LIVE on dev, DARK on fleet) per the Maturation Path standard;
    // registered in DEV_GATED_FEATURES. Only the tuning knobs are defaulted here.
    yieldSafety: {
      dirtyCheckTimeoutMs: 5_000,
      dirtyCheckCacheTtlMs: 30_000,
      resurrectionCap: 2,
      residueDenylist: ['dist/', 'build/', 'out/', '.next/', '.nuxt/', '.turbo/', 'node_modules/', 'coverage/', '.cache/', '*.log', '*.tsbuildinfo'],
      preservationMaxFileBytes: 52_428_800,
      preservationMaxTotalBytes: 104_857_600,
    },
    // Operator Authorization Request (agent proposes → operator approves one-tap).
    // `enabled` is OMITTED (Maturation Path) — resolved via resolveDevAgentGate so it
    // ships enabled-on-dev / dark-on-fleet. Only the non-gating knob is defaulted here.
    authorizationRequests: {
      pendingCapPerAgent: 10,
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
    // Failure-Learning Loop (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md). DEV-GATED
    // (CMT-1438): `enabled` is OMITTED so resolveDevAgentGate decides — LIVE on a
    // developmentAgent, DARK on the fleet (when off, /failures routes 503-stub; the
    // surface still exists for capability probing). The ingestion sources below
    // default off, so live-on-dev is observe-only. Registers on the rollout board.
    failureLearning: {
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
    //
    // "Self-Unblock Before Escalating" (docs/specs/self-unblock-before-escalating.md)
    // EXTENDS this gate (no parallel kill-switch): the nested selfUnblockChecklist
    // + durableVaultSession blocks ALSO OMIT `enabled` so the same developmentAgent
    // dark-feature gate resolves them — LIVE on a development agent, DARK on the
    // fleet. Registered in DEV_GATED_FEATURES. The empty nested objects are present
    // so applyDefaults backfills the dotted gate path on existing agents.
    blockerLedger: {
      // The self-unblock sub-feature OMITS `enabled` (dev-gate decides) and ships
      // with an EMPTY operator-declared scope map — the fail-closed default. With no
      // declared tags, no probe is ever surfaced as relevant, runs always exhaust,
      // and the feature behaves exactly like today (under-self-unblock, never
      // mis-apply). The operator opts a source IN by declaring its scope tags.
      selfUnblockChecklist: { credentialScopeTags: {} },
      durableVaultSession: {},
    },
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
    // Bias-to-Action standing-authorization signal (BIAS-TO-ACTION-SPEC, D8).
    // Dev-gated DARK: `enabled` is intentionally OMITTED so the development-agent
    // gate resolves it (live-on-dev / dark-on-fleet, the standard pattern). The
    // non-`enabled` knobs ship so a dev agent gets the safe defaults: OBSERVE-ONLY
    // (never alters a message) + the conservative D9 look-back window.
    biasToAction: {
      observeOnly: true,
      lookback: { maxRows: 40, windowMs: 24 * 60 * 60 * 1000 },
    },
    // Promise-Beacon Escalation (PROMISE-BEACON-ESCALATION-SPEC §5). When a
    // beacon-enabled commitment's owning session dies, escalate (revive → honest
    // status → loud give-up) instead of silently terminalizing it. Ships DARK:
    // `enabled` is deliberately OMITTED so the runtime resolves it via the
    // developmentAgent gate (LIVE on the dev agent, DARK fleet-wide), and
    // `dryRun: true` holds it to audit-only "would escalate" logging until the
    // evidence-gated promotion. Backfilled to existing agents via applyDefaults.
    promiseBeacon: {
      escalation: {
        dryRun: true,
        maxEscalationAttempts: 3,
        minEscalationIntervalMs: 120000,
        maxConcurrentEscalations: 2,
        maxEscalationSpawnsPerTick: 1,
        reviveSettleMs: 30000,
        escalationGraceMs: 10000,
        rung2MaxNotifications: 4,
        rung2MinIntervalMs: 1800000,
        rung2DigestWindowMs: 600000,
        revalidationTtlMs: 1800000,
      },
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
    // §4.2). DEV-GATED (CMT-1438): `enabled` is OMITTED so resolveDevAgentGate
    // decides — LIVE on a developmentAgent, DARK on the fleet. Repo-gated: inert
    // unless the install has an analyzable instar git repo. Inert-on-enable for
    // SENDS: ticks are driven by the SEPARATE off-by-default release-readiness-check
    // job (two-switch). Thresholds default silent <2d, LOW ≥2d, MEDIUM ≥4d, HIGH ≥7d.
    releaseReadiness: {
      tickIntervalMs: 21_600_000,
      backlogAgeDaysSilent: 2,
      backlogAgeDaysLow: 2,
      backlogAgeDaysMedium: 4,
      backlogAgeDaysHigh: 7,
      hysteresisHours: 12,
      staleEpisodeTtlDays: 30,
      fetchTimeoutMs: 30_000,
    },
    // green-pr-automerge-enforcement R7: the background watcher that merges a
    // green, mergeable, non-held PR this agent authored (Phase 7 becomes
    // machinery). DARK_GATE_EXCLUSIONS: deliberate-fleet-default — off fleet-wide,
    // flipped on (with expectedGhLogin) per dev agent. Repo-gated.
    greenPrAutoMerge: {
      enabled: false,
      dryRun: false,
      tickIntervalMs: 600_000,
      maxAttempts: 3,
      maxRearmEpisodes: 3,
      breakerThreshold: 3,
      deadlineKillBreakerThreshold: 3,
      busySkipBreakerThreshold: 3,
      breakerCooldownMin: 60,
      mergeTimeoutMs: 1_500_000,
      mergeKillGraceMs: 60_000,
      expectedGhLogin: '',
      identityRecheckTicks: 6,
      holdReleaseTicks: 2,
      staleHoldDays: 7,
      floorDriftCheckTicks: 6,
      floorDriftLookbackPrs: 10,
      floorDriftLookbackCommits: 30,
      // red-pr-watchdog: signal-only backstop, default on. Raises ONE deduped,
      // age-escalating attention line when a self-authored open PR is stuck RED
      // past redThresholdMs (2h). Only runs while the parent watcher is enabled.
      redPrWatchdog: { enabled: true, redThresholdMs: 7_200_000 },
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
    // Single-negotiator lock (Threadline Robustness Phase 1, CMT-1362). The
    // per-conversation lease that makes exactly ONE session own a conversation's
    // outbound voice (G1, closes F1). `enabled` is OMITTED on purpose — it rides
    // the developmentAgent dark-feature gate (resolveDevAgentGate): LIVE on a dev
    // agent, DARK on the fleet. Writing `enabled: false` here would force-dark
    // even dev agents (the PR #1001 anti-pattern) and starve the FD-7 dry-run
    // telemetry the lease needs before it can ever enforce. dryRun stays default-
    // true, so on a dev agent the gate engages but logs the verdict it WOULD
    // reach and still sends — measuring the false-positive rate while withholding
    // nothing. G2 (prose inertness) + G3 (honest ack wiring) ship live in CORE
    // and are NOT gated by this — only the lease's hard-block is. applyDefaults
    // deep-merges this under `threadline` on update (Migration Parity). Spec:
    // docs/specs/THREADLINE-SINGLE-NEGOTIATOR-SPEC.md.
    singleNegotiator: {
      dryRun: true,
      leaseTtlMs: 90000, // 90s — long enough not to thrash mid-reply, short enough a dead owner reclaims fast
      holdingNoticeMinIntervalMs: 300000, // 5 min global floor per thread (FD-3)
      dryRunRetentionDays: 7,
    },
    // Canonical, symmetric history + conversation discipline (Threadline
    // Robustness Phase 2, CMT-1362). The canonical per-thread log + append funnel
    // + read-source UNION + symmetry DETECTION are CORE/ungated (additive,
    // gain-only, observability). The ONE behavior change — the D-E resolver JOIN
    // that reroutes which threadId an outbound send uses (a one-way wire effect) —
    // is DEV-GATED + dry-run-first: `conversationDiscipline.enabled` is deliberately
    // OMITTED so the server resolves it via the developmentAgent gate
    // (`enabled ?? !!config.developmentAgent`) — live on a dev agent, dark on the
    // fleet — and `dryRun:true` only LOGS the would-join decision (performs no
    // reroute) until an operator flips it off after telemetry proves the join/fork
    // rate. applyDefaults deep-merges this under `threadline` on update (Migration
    // Parity). Spec: docs/specs/THREADLINE-CANONICAL-HISTORY-SPEC.md.
    canonicalHistory: {
      conversationDiscipline: {
        // `enabled` OMITTED on purpose (dev-gate decides). NEVER hardcode it here.
        dryRun: true,
      },
      workstreamKeyMode: 'subject-slug', // 'subject-slug' | 'peer-only' | 'off'
      maxEntriesPerThread: 2000,         // live-segment cap before archive/ rotation
      seenSetMaxPerThread: 5000,         // in-memory dedup cache bound (live log is authority)
      seenSetMaxThreads: 512,            // LRU ceiling on in-memory per-thread state
      headCacheCoalesceMs: 500,          // coalesced head-cache debounce (never per-message CAS)
      appendFailureAlertThreshold: 3,    // N consecutive append failures → ONE Attention item
      inlineMaxBytes: 8192,              // body inline cap before a store reference
      backfillOutboxTailLines: 5000,     // tail-bounded outbox scan for one-time backfill
      backfillMaxDigestsPerRequest: 100, // bounded, participant-authorized backfill caps
      backfillMaxRecordsPerResponse: 50,
      backfillRequestsPerPeerPerMinute: 6, // rate-limits episode INITIATION, not in-episode requests
    },
    // Secure A2A Verified Pairing — mutual SAS identity verification + the
    // credential-share gate (docs/specs/secure-a2a-verified-pairing.md §3.10).
    // DARK-SHIP: `enabled` is deliberately OMITTED so the server resolves it via
    // the developmentAgent gate (resolveDevAgentGate: `enabled ?? !!developmentAgent`)
    // — live on a dev agent, dark on the fleet. Writing `enabled: false` here would
    // force-dark even dev agents (the PR #1001 anti-pattern) and defeat dogfooding.
    // Per FD10 the OUTBOUND credential-share refusal is ALWAYS live when enabled (a
    // leak gate has no allow-by-default soak); `dryRun:true` governs ONLY inbound
    // observability + attention verbosity, and `credentialShareEnforced:false` arms
    // inbound credential-ingestion enforcement (read live at the chokepoint, no
    // restart). applyDefaults deep-merges this nested block under the existing
    // `threadline` key on update (Migration Parity §5), so existing agents backfill
    // dryRun + credentialShareEnforced without an explicit patch; an operator's
    // existing values are NEVER overwritten. Mirrors `singleNegotiator` posture.
    verifiedPairing: {
      // `enabled` OMITTED on purpose (dev-gate decides). NEVER hardcode it here.
      dryRun: true,
      credentialShareEnforced: false,
    },
    // Hub-intent recognizer (Conversion #3, docs/specs/keyword-intent-conversions-1-and-3.md).
    // The "open this"/"tie this to <topic>" hub-bind DECISION is inferred by an LLM
    // over the message + recent conversation (HubIntentClassifier), NOT the anchored
    // regexes it replaced — which SWALLOWED the message before the agent saw it, so a
    // misread silently EATS a real message (the highest-care conversion). `enabled` is
    // DELIBERATELY OMITTED (not hardcoded false) so resolveDevAgentGate decides — DARK
    // on the fleet, LIVE on a development agent (registered in DEV_GATED_FEATURES,
    // configPath threadline.hubIntent.enabled). Ships dry-run FIRST: on a dev agent the
    // classifier RUNS and LOGS would-swallow vs would-pass to logs/hub-intent.jsonl, but
    // the message ALWAYS passes through (never swallowed) until a deliberate dryRun:false
    // — proving the false-positive rate collapsed before it can eat a message. Fail-OPEN
    // on any uncertainty. applyDefaults deep-merges this under `threadline` on update
    // (Migration Parity), so existing agents backfill it without an explicit patch.
    hubIntent: {
      dryRun: true,
      minConfidence: 0.85,
      timeoutMs: 4000,
      contextWindowTurns: 6,
      modelTier: 'fast',
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
    visibleEcho: true,
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
  // Evolution action-queue stale cleanup. Live in dry-run first: only ordinary
  // pending actions are candidates; critical/pinned/future-deadline work is kept.
  evolutionActions: {
    autoExpiry: {
      enabled: true,
      maxAgeDays: 21,
      sweepIntervalMs: 21600000,
      dryRun: true,
    },
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
    // Class-Closure Gate (docs/specs/class-closure-gate.md) — ships dark +
    // report-only (the CI lint logs findings and always exits 0 until an
    // operator flips enabled+!dryRun). backfilled to existing agents via the
    // add-missing applyDefaults path, exactly like prGate.phase.
    classClosure: {
      enabled: false,
      dryRun: true,
      escalatorDrafting: false,
    },
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
    // Seamless LLM Orchestrator (docs/specs/llm-seamlessness-orchestrator.md).
    // A lease-gated tier-1 LLM loop for ANTICIPATORY working-set preload — PROPOSE-
    // ONLY / SIGNAL-ONLY (it never moves a conversation; placement stays with the
    // deterministic RebalancePlanner/PlacementExecutor). `enabled` is deliberately
    // OMITTED — the dev-agent dark-feature gate (resolveDevAgentGate) resolves it:
    // LIVE on a development agent, DARK on the fleet. `dryRun` ships TRUE (FD-7
    // telemetry pattern): the loop logs would-actuate + audits, and actuates
    // NOTHING, until a deliberate operator flip to dryRun:false. applyDefaults()
    // deep-merges this under an existing multiMachine block WITHOUT clobbering an
    // operator-set value (Migration Parity). Numeric knobs are range-validated at
    // startup.
    seamlessOrchestrator: {
      dryRun: true,
      cadenceMs: 900000,        // 15 min full cadence
      idleCadenceMs: 1800000,   // 30 min while idle (no proposals)
      maxProposalsPerTick: 3,   // F6 proposal cap
      llmLiftThreshold: 0.15,   // F4 deterministic-first: skip the LLM on a clear winner
      perTopicCooldownMs: 1800000, // 30 min per-topic cooldown between actuations
      maxDailyCents: 100,       // F7 LLM daily spend cap (background lane)
      prefetchWindowByteBudget: 33554432, // 32MB per-window auto-prefetch disk budget
    },
    // Standby-Write Reconciliation (docs/specs/standby-write-reconciliation.md §7).
    // `enabled` is deliberately OMITTED — the dev-agent dark-feature gate
    // (resolveDevAgentGate) resolves it: LIVE on a development agent, DARK on
    // the fleet. Dry-run FIRST even on dev (FD-7 telemetry pattern): the
    // legacy blanket standby guard keeps enforcing while the new layer logs
    // would-verdicts; refusal authority additionally requires the wave-2
    // inventory latch (WRITE_SURFACE_INVENTORY_COMPLETE).
    writeAdmission: {
      dryRun: true,
      refusalAggregateThreshold: 5,
    },
    // multi-machine-lease-self-heal (docs/specs/multi-machine-lease-self-heal.md).
    // F1 tick self-heal ships ENABLED (safe-by-construction: bounded await + a
    // monotonic watchdog that only re-arms/recovers, never changes authority);
    // F2 staleHolderTakeover + F3 silentStandbyRelinquish ship DARK; F4
    // preferredAwakeMachineId is opt-in (null = off). applyDefaults() deep-merges
    // this under an existing multiMachine block WITHOUT clobbering an operator-set
    // value — so existing agents get F1-enabled + the dark flags on update
    // (Migration Parity). `leaseRole` is intentionally OMITTED (defaults to the
    // back-compat derivation from telegramPolling); a follow-up migration may seed
    // it to the concrete resolved value to retire the derivation. Numeric factors
    // are range-validated at startup.
    leaseSelfHeal: {
      tickWatchdog: {
        enabled: true,
        staleFactorMissedTicks: 5,
        awaitTimeoutMs: 20000,
        maxReArmsPerHour: 6,
      },
      staleHolderTakeover: {
        enabled: false,
        nonRenewalMissedObservations: 6,
      },
      silentStandbyRelinquish: {
        enabled: false,
      },
      // multi-transport-mesh-comms Layer 3 — DARK by default (authority-bearing).
      // Classified in DARK_GATE_EXCLUSIONS (action-bearing). When enabled + a
      // preferredAwakeMachineId is set, a preferred stationary captain holds its
      // lease when its sole peer is presumed-gone by liveness-silence.
      soloCaptainHold: {
        enabled: false,
      },
      // U4.4 (docs/specs/u4-4-lease-handback.md §5) — hand the lease BACK to the
      // F4 preferred captain after a failover. ACTION-BEARING lease authority
      // (moves real serving authority) → ships HARD-DARK on EVERY agent (dev
      // included), enabled:false + dryRun:true, classified in
      // DARK_GATE_EXCLUSIONS (action-bearing) exactly like its F2/F3/L3
      // siblings. dryRun:false additionally REQUIRES pollFollowsLease live —
      // validated at boot (validateHandbackEnableChokepoint), refused loudly.
      preferredCaptainHandback: {
        enabled: false,
        dryRun: true,
        healthWindowMs: 600000,
        deferralCeilingMs: 7200000,
        operatorLatchMs: 86400000,
        maxPerWindow: 2,
        windowMs: 21600000,
      },
      preferredAwakeMachineId: null,
      // B2 (multimachine-lease-poll-robustness, Decision 8) — the flap breaker.
      // `enabled` OMITTED ⇒ developmentAgent gate; dryRun:true observes/logs the
      // would-latch without applying the deterministic role (the dark stage).
      churnDetector: { dryRun: true, maxFlipsPerWindow: 4, windowMs: 600000, maxLatchesPerHour: 3 },
      // B3 (multimachine-lease-poll-robustness) — dedicated renew timer (TTL/2) so
      // a held lease never lapses between heartbeat ticks (stops the epoch climb).
      // `enabled` OMITTED ⇒ developmentAgent gate (live-on-dev / dark-on-fleet).
      // Pure timing; never relaxes the monotonic self-fence.
      resilientRenew: {},
      // B4 (multimachine-lease-poll-robustness, Decision 10) — skew-immune lease
      // peer liveness (routerReceivedAt vs skew-contaminated lastSeen). `enabled`
      // OMITTED ⇒ developmentAgent gate. Conservative + lastSeen fallback.
      skewImmuneLiveness: {},
    },
    // B1 (multimachine-lease-poll-robustness) — tie Telegram poll-ownership to the
    // fenced lease. `enabled` OMITTED ⇒ developmentAgent gate; dryRun:true logs the
    // would-action WITHOUT changing ingress (the live flip is gated on the Phase-4
    // two-host proof + B2/B5 live, so it can't disturb the Phase-0 stabilization).
    pollFollowsLease: { dryRun: true },
    // G2 nobody-polling RECOVERY (MESH-SELF-HEAL-SPEC §3.2). OMIT `enabled` ⇒
    // dev-agent gate (live-on-dev / dark-on-fleet); dryRun:true ⇒ the evaluator
    // detects + elects + records the soak counterfactual but performs NO actuation
    // (no fenced-CAS acquire, no poll-lever write). Flipping dryRun:false is the
    // deliberate enforce promotion (gated on the pollSucceeded-watermark plumbing +
    // the Phase-5 second-pass live-verify on the real pair).
    nobodyPollingRecovery: { dryRun: true },
    // G1 zombie self-relinquish (lease↔job binding, MESH-SELF-HEAL-SPEC §3.1). OMIT
    // `enabled` ⇒ dev-agent gate; dryRun:true ⇒ the holder-branch evaluator detects
    // a confirmed zombie + records "would relinquish" but performs NO actuation (no
    // relinquishAndBroadcast). Flipping dryRun:false is the deliberate enforce
    // promotion (gated on the pollSucceeded/serve watermark refinements + the
    // Phase-5 second-pass live-verify on the real pair).
    zombieRelinquish: { dryRun: true },
    // multi-transport-mesh-comms (Layers 0-2) — multi-rope mesh transport
    // (Tailscale/LAN/Cloudflare hedged failover). Ships ENABLED (strictly additive;
    // a single-machine agent is a no-op and keeps its 127.0.0.1 bind — the 0.0.0.0
    // bind is gated on multiMachine.enabled). FLAT knobs to dodge the one-level-deep
    // applyDefaults merge hazard. Spec: docs/specs/multi-transport-mesh-comms.md.
    meshTransport: {
      enabled: true,
      hedgeDelayMs: 1500,
      priorityTailscale: 10,
      priorityLan: 20,
      priorityCloudflare: 30,
      tailscaleEnabled: true,
      lanSubnetGate: true,
      unhealthyAfterFailures: 3,
      endpointEvictionMs: 3600000,
      maxProbeBackoffMs: 300000,
      // U4.3 — traffic-independent rope-health recovery probe
      // (docs/specs/u4-3-breaker-recovery-probe.md §5). `recoveryProbeEnabled`
      // is DELIBERATELY OMITTED (not hardcoded false) so resolveDevAgentGate
      // decides at runtime — LIVE (in dry-run) on a development agent, DARK on
      // the fleet. Registered in DEV_GATED_FEATURES (`ropeRecoveryProbe`).
      recoveryProbeDryRun: true,
      recoveryProbeFloorMs: 900000,
      recoveryProbeExhaustAttempts: 20,
      recoveryProbeReopenEpisodeWindowMs: 600000,
      recoveryProbeMidIntervalMs: 45000,
      recoveryProbeMaxUnreclaimedSuccesses: 20,
    },
    // WS5.2 Account Follow-Me (docs/specs/ws52-account-follow-me-security.md). The
    // `enabled` literal is DELIBERATELY OMITTED (not hardcoded false) so
    // resolveDevAgentGate decides at runtime — DARK on the fleet (the security spec's
    // reserved-dark default), and LIVE on a development agent for dogfooding (the goal
    // is to prove follow-me live on the operator's own machines). Registered in
    // DEV_GATED_FEATURES (configPath multiMachine.accountFollowMe.enabled). Even when
    // resolved live there is NO live-credential code path in PR1 — only the non-credential
    // metadata projection + the security primitives exist; so dev-live is functionally
    // inert until the later wiring PRs. `credentialTransport` is the per-provider
    // allowlist for Mechanism A (sealed-transport) — default EMPTY, and anthropic is
    // REFUSED regardless (its ToS forbids relocating Claude OAuth tokens). `maxFollowMachines`
    // bounds the per-account fan-out (R7).
    accountFollowMe: {
      credentialTransport: {},
      maxFollowMachines: 5,
      // WS5.2 R12.iii — reconnect-deadline before an offline-pending revocation wipe escalates to
      // the LOUD `revocation-FAILED — rotate at provider NOW` attention item (gap 9; lean: hours,
      // not days, for a live credential — operator-tunable). Default 6h.
      revocationReconnectDeadlineMs: 6 * 60 * 60_000,
      // WS5.2 R6b — the scrape-timeout budget (ms) for a REMOTE/cloud follow-me
      // enrollment drive. Cloud→provider latency + the two-code Claude window do
      // NOT fit the local-LAN 60s assumption, so the follow-me start path threads
      // this LARGER budget to FrameworkLoginDriver (3min default). Normal LOCAL
      // enrollment (/subscription-pool/enroll) is unchanged — it never reads this
      // and keeps the driver's 60s default.
      remoteScrapeTimeoutMs: 180000,
      // WS5.2 R7a — per-account SPEND-SLICE control plane. The ceiling is denominated
      // in provider quota-FRACTION (0..1); a borrowed account is sliced so the sum of
      // OUTSTANDING slices across N machines can never exceed the ceiling (the
      // sum-of-leases bound, owned by the FENCED lease holder). The renewal knobs below
      // bound the requester-side control plane so N VMs on one hot account produce
      // O(per-account-cap) renewal RPCs, never an O(N) herd:
      //  - ceilingQuotaFraction: the account-wide spend ceiling (fraction of a provider
      //    quota window) that the holder slices among machines (default 0.8 — leave the
      //    holder's own headroom).
      //  - minRenewIntervalMs: per-account renewal rate cap (the floor between RPCs).
      //  - renewBackoffMultiplier / maxRenewIntervalMs: exponential backoff on refusal/
      //    failure, ceilinged so the interval cannot grow unbounded.
      //  - breakerThreshold / breakerCooldownMs: the P19 sustained-failure breaker — after
      //    N consecutive transport FAILURES (slow/partitioned/unreachable holder) a VM
      //    FAILS CLOSED TO ITS OWN ACCOUNT for the cooldown rather than retry-storming.
      spendSlice: {
        ceilingQuotaFraction: 0.8,
        minRenewIntervalMs: 5000,
        renewBackoffMultiplier: 2,
        maxRenewIntervalMs: 300000,
        breakerThreshold: 3,
        breakerCooldownMs: 60000,
      },
    },
    // WS3 one-voice gate (MULTI-MACHINE-SEAMLESSNESS-SPEC). Ships DARK: with
    // ws3OneVoice false the SpeakerElection returns "speak" unconditionally —
    // byte-for-byte today's behavior. Single-machine pools are a strict no-op
    // even when enabled (the election never engages below 2 online machines).
    seamlessness: {
      // WS3 one-voice gate. DEV-AGENT DARK GATE (operator directive 2026-06-13,
      // topic 13481 — "NOTHING should ship dark on development agents"):
      // `ws3OneVoice` is DELIBERATELY OMITTED here (not hardcoded false) so
      // resolveDevAgentGate decides at runtime — LIVE on a development agent
      // (dogfooding across the operator's own machines), DARK on the fleet until
      // explicitly flipped on. Hardcoding `false` would force-dark even a dev
      // agent (the PR #1001 bug). Registered in DEV_GATED_FEATURES
      // (src/core/devGatedFeatures.ts). When dark/single-machine the
      // SpeakerElection returns "speak" unconditionally (byte-for-byte today's
      // behavior); the election never engages below 2 online machines, so a
      // single-machine dev agent is a strict no-op even when resolved live.
      ws3DwellMs: 60000,
      // WS1.3 ownership reconcile: bounded pin/owner convergence (cooperative
      // transfer→claim while the owner lives; force only with owner-death
      // evidence + quorum). DEV-AGENT DARK GATE: `ws13Reconcile` is DELIBERATELY
      // OMITTED here (not hardcoded false) so resolveDevAgentGate decides at
      // runtime — LIVE on a development agent, DARK on the fleet. Its dry-run
      // sub-knob (ws13DryRun, default true) STAYS a plain hardcoded default — it
      // is the in-component "log intended CAS actions without performing them"
      // rung, NOT the dev-gate, so the reconcile loop runs live on dev but in
      // dry-run (no destructive CAS) exactly as the rollout ladder intends.
      ws13DryRun: true,
      ws13TickMs: 30000,
      // WS2.1 preferences pool: cross-machine read-replication of the
      // correction-learning preference store so a preference learned on machine A
      // is honored on machine B. DARK default; single-machine agents are a strict
      // no-op even when on. Plain seamlessness boolean (read live at the serve/
      // receive/union sites), mirroring the ws3OneVoice/ws13Reconcile siblings —
      // NOT named `enabled`, so it is outside the dev-agent dark-gate lint (which
      // matches the literal `enabled: false` spelling only).
      ws21PreferencesPool: false,
      // WS4.1 follow-up "durable operator-bound /ack" (CMT-1416). When an
      // operator acks a pooled attention item whose OWNER is briefly offline,
      // the ack intent is persisted (with the authenticated operator principal)
      // and re-delivered when the owner returns — so the intent survives a dark
      // owner instead of evaporating. DEV-AGENT DARK GATE (operator directive
      // 2026-06-13, topic 13481): `ws41DurableAck` is DELIBERATELY OMITTED here
      // (not hardcoded false) so resolveDevAgentGate decides at runtime — LIVE on
      // a development agent, DARK on the fleet. Registered in DEV_GATED_FEATURES.
      // When dark, POST /attention/:id/remote-ack 503s and the receiver's
      // remote-ack precedence guard is a no-op; single-machine agents are a
      // strict no-op even when resolved live (no peers to route to).
      // WS4.3 role-guard-at-spawn (CMT-1416 follow-up to the merged WS4.3 jobs
      // read-side, PR #1104). When on, the scheduler refuses to spawn a
      // STATE-WRITING job (JobDefinition.writesState) on a machine that does NOT
      // hold the lease — the spawn-boundary re-check that closes the TOCTOU hole
      // where a machine awake at boot demotes to read-only standby mid-run while
      // its cron tasks keep firing (the scheduler is constructed only when awake
      // but is never torn down on demotion). DEV-AGENT DARK GATE (operator
      // directive 2026-06-13, topic 13481): `ws43RoleGuard` is DELIBERATELY
      // OMITTED here (not hardcoded false) so resolveDevAgentGate decides at
      // runtime — LIVE on a development agent, DARK on the fleet. Registered in
      // DEV_GATED_FEATURES. When dark, the guard is a strict no-op (byte-for-byte
      // today's behavior). Single-machine agents always hold the lease, so the
      // guard never fires there even when resolved live (it can only ever refuse,
      // never wrongly spawn — the safe direction).
      // WS4.3 journal-lease cutover (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.3,
      // "Cutover discipline"). When on AND the pool is flag-coherent (every
      // online peer advertises ws43JournalLease), job claims upgrade from the
      // best-effort AgentBus broadcast to a durable, epoch-fenced lease over the
      // replicated journal. The cutover gate (JobLeaseCutoverGate) guarantees the
      // two mechanisms are NEVER both live for a job set (the named migration
      // hazard: one machine leasing via journal while a peer broadcasts via bus).
      // DEV-AGENT DARK GATE (operator directive 2026-06-13, topic 13481):
      // `ws43JournalLease` is DELIBERATELY OMITTED here (not hardcoded false) so
      // resolveDevAgentGate decides at runtime — LIVE on a development agent,
      // DARK on the fleet. Registered in DEV_GATED_FEATURES. When dark, or in a
      // mixed/older pool, or single-machine, the scheduler stays on the legacy
      // bus path (byte-for-byte today's behavior); the JobLeaseCutoverGate's
      // flag-coherence requirement means a single-machine dev agent (no peers)
      // is a strict no-op even when the flag resolves live.
      //
      // WS4.3 journal-lease DRY-RUN (the WS-wide "log intended claims" posture).
      // `ws43JournalLeaseDryRun` is ALSO DELIBERATELY OMITTED so the dev-gate
      // resolves it COHERENTLY with ws43JournalLease: on a dev agent the cutover
      // goes LIVE (dryRun → false) so the journal-lease path is actually
      // exercised (not just logged); on the fleet it resolves to the safe dry-run
      // default (true). The consumer computes `dryRun: cfg?.ws43JournalLeaseDryRun
      // ?? !resolveDevAgentGate(undefined, config)` — an explicit config value
      // still wins. A genuine live cutover only engages when the flag resolves
      // live AND the pool is flag-coherent (≥2 machines all advertising the
      // capability not-dry-run), so a single-machine dev agent never half-migrates.
      // WS4.4 "links that survive machine boundaries". DEV-AGENT DARK GATE:
      // `ws44PoolLinks` is DELIBERATELY OMITTED here (not hardcoded false) so
      // resolveDevAgentGate decides at runtime — LIVE on a development agent
      // (dogfooding), DARK on the fleet until explicitly flipped on. Hardcoding
      // `false` would force-dark even a dev agent (the PR #1001 bug). Registered
      // in DEV_GATED_FEATURES (src/core/devGatedFeatures.ts). When dark, the
      // /view/:id route is local-only (byte-for-byte today's behavior).
      // WS4.4 (f) load-shed threshold: over this 1-min load-per-core, holder
      // resolution serves last-cached (stale-tagged) instead of re-fanning-out.
      // (A tunable, not a gate — a concrete default is correct here.)
      ws44LoadShedLoadPerCore: 1.5,
      // WS4.4 (f) global pool-cache unification (CMT-1416 follow-up). DEV-AGENT
      // DARK GATE: `ws44PoolCache` is DELIBERATELY OMITTED here (not hardcoded
      // false) so resolveDevAgentGate decides at runtime — LIVE on a development
      // agent (dogfooding), DARK on the fleet until explicitly flipped on.
      // Hardcoding `false` would force-dark even a dev agent (the PR #1001 bug).
      // Registered in DEV_GATED_FEATURES (src/core/devGatedFeatures.ts). When
      // ON, every pool-scope surface (sessions/jobs/attention/guards/…) routes
      // its per-peer fan-out through ONE shared PoolPollCache so a dashboard
      // polling several tabs hits each peer ONCE per interval instead of once
      // per surface per client; over the load-shed threshold the cache serves
      // last-cached (stale-tagged) instead of re-fanning. When dark, surfaces
      // keep their existing direct per-peer fetch (byte-for-byte today's
      // behavior). NOT named `enabled`, so it is outside the dark-gate lint.
      // ws44PoolCache DELIBERATELY OMITTED — see comment above.
      // The shared poll interval (ms). Within this window a (peer, route) pair
      // is served from cache without a network call. A tunable, not a gate.
      ws44PoolCacheTtlMs: 3000,
    },
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
      // §L4 move-intent recognizer (docs/specs/nickname-move-intent-llm-rebuild.md).
      // The "move/run/pin this on <nickname>" decision is inferred by an LLM over
      // the message + recent conversation (MoveIntentClassifier), NOT a keyword
      // verb list (the 2026-07-03 hijack). `enabled` is DELIBERATELY OMITTED (not
      // hardcoded false) so resolveDevAgentGate decides — DARK on the fleet, LIVE
      // on a development agent (registered in DEV_GATED_FEATURES, configPath
      // multiMachine.sessionPool.moveIntent.enabled). Ships dry-run FIRST: on a
      // dev agent the classifier RUNS and LOGS would-hijack vs would-pass to
      // logs/move-intent.jsonl, but the message ALWAYS passes through (never
      // hijacked) until a deliberate dryRun:false — proving the false-positive
      // rate collapsed before it can eat a message. Fail-OPEN on any uncertainty.
      moveIntent: {
        dryRun: true,
        minConfidence: 0.85,
        timeoutMs: 4000,
        contextWindowTurns: 6,
        modelTier: 'fast',
      },
      // G3 — lease-gated spawn (MESH-SELF-HEAL-SPEC §3.3, FD6). "Spawn iff I hold
      // the fenced awake-lease, else forward to the holder" — stops the
      // duplicate-session harm (the 2026-06-27 incident). Ships DARK (enabled:
      // false + dryRun:true) — registered in DARK_GATE_EXCLUSIONS per
      // lint-dev-agent-dark-gate. Single-machine + flag-off = byte-for-byte
      // legacy spawn (the gate is a strict no-op there). dryRun logs the
      // would-forward intent but still spawns (observe-only soak).
      ownershipCheckedSpawn: {
        enabled: false,
        dryRun: true,
      },
      // Durable Inbound Message Queue (docs/specs/durable-inbound-message-queue.md
      // §Config). Ships DARK (enabled:false + dryRun:true) — registered in
      // DEV_GATED_FEATURES per lint-dev-agent-dark-gate. Both flags boot-read;
      // the six cross-knob invariants are validated at construction
      // (validateInboundQueueInvariants) — a violation keeps the queue OFF for
      // that boot, never half-configured.
      inboundQueue: {
        enabled: false,
        dryRun: true,
        maxPerSession: 50,
        maxTotal: 500,
        hardMaxTotal: 1000,
        maxHeldTotal: 150,
        maxPayloadBytes: 65536,
        entryTtlMs: 1800000,
        staleCustodyTtlMs: 120000,
        maxNapDeliveryAgeMs: 600000,
        deliveredRetentionMs: 86400000,
        drainTickMs: 15000,
        drainBatchSize: 25,
        drainConcurrency: 3,
        minInterPassMs: 500,
        passDeadlineMs: 60000,
        baseBackoffMs: 5000,
        maxBackoffMs: 300000,
        maxAttempts: 10,
        claimStaleMs: 120000,
        refusalNegativeCacheMs: 60000,
        maxFailoverRespawns: 5,
        maxFailoverReleasesPerTick: 5,
        dispatchDeadlineMs: 60000,
        pauseMaxMs: 14400000,
      },
      // Hold-for-stability (same spec §4). Trails inboundQueue one rollout
      // stage behind by operator discipline (frontmatter rollout-criteria).
      holdForStability: {
        enabled: false,
        holdMaxMs: 90000,
        holdRecheckMs: 10000,
        flapThresholdPerHour: 6,
      },
      // U4.2 (docs/specs/u4-2-stale-owner-release.md §5) — stale-owner release
      // (the CMT-1786 auto-failover as Case C's evidence upgrade). `enabled` is
      // DELIBERATELY OMITTED (never hardcoded false) so resolveDevAgentGate
      // decides at runtime — dev-live-in-dryRun, DARK on the fleet; registered
      // in DEV_GATED_FEATURES. dryRun:true is the canary: the evidence pass +
      // /pool/stale-owner-release surface run live but no CAS ever lands until
      // a deliberate dryRun:false (gated on the §5 quantified soak). Subordinate
      // to sessionPool being live AND ≥2 registered machines. The §2.3
      // TTL-ordering invariant is validated at startup (a violating combination
      // is REJECTED loudly, never degraded silently).
      staleOwnerRelease: {
        dryRun: true,
        deathEvidenceMs: 180000,
        probeTimeoutMs: 8000,
        ambiguityCeilingMultiple: 3,
        maxClaimsPerTick: 2,
        bootstrapNonObservationMultiple: 3,
        selfFenceTtlMs: 60000,
      },
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
      replication: {
        maxBatchBytes: 262144,
        // One-shot replicated-record journal compaction. Explicit opt-in only;
        // first activation reports N -> M without touching disk.
        compaction: { run: false, dryRun: true },
      },
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
        // intelligent-working-set-lazy-sync (F3/F8). recordInteractive is the
        // recorder kill-switch READ BY THE PostToolUse hook (a standalone JS file
        // that can't dev-gate) — DARK by default (false ⇒ the hook early-exits, no
        // interactive artifact is recorded). recordTtlDays is the record-GC horizon
        // (distinct from the 7d pending-pull TTL above); rows older are purged at boot.
        recordInteractive: false,
        recordTtlDays: 30,
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
      // WS2.1 preferences pool (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS2.1). Rides
      // multiMachine.seamlessness.ws21PreferencesPool (NOT replication.enabled).
      // Independent page-sizing so preferences tune separately from commitments
      // (review WS2.1 finding #7). No `enabled` field — pure bounded-behavior dials.
      preferences: {
        syncPageBytes: 262144,
        maxSyncPagesPerTick: 4,
        replicaStaleWarnMs: 600000,
        maxReplicatedPreferences: 500,
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
    // Replicated-store foundation (multi-machine-replicated-store-foundation §10).
    // Ships DARK per store: there is NO per-store key here yet (the first concrete
    // store registers its own `enabled:false` flag with WS2.1) — this block seeds
    // ONLY the FOUNDATION-LEVEL knobs every replicated store shares. None is named
    // `enabled`, so the block is outside the dev-agent dark-gate lint (which
    // matches the literal `enabled: false` spelling). validateStateSyncInvariants()
    // rejects an out-of-range value at startup (maxDriftMs ∈ [60s,15min]; budgets
    // > 0). applyDefaults add-missing semantics → migrateConfig backfills these
    // literals on existing agents (Migration Parity). With no per-store flag on,
    // the entire foundation is inert (no replicated kinds emitted) — the default
    // preserves today's behavior exactly; a single-machine agent is a strict no-op.
    stateSync: {
      aggregateJournalBudgetBytes: 67108864, // 64 MiB (§10.2)
      maxDriftMs: 300000, // 5 min — the §3.4 default, within the [60s,15min] clamp
      maxCachedSnapshots: 16, // §8.2 snapshot-cache count ceiling
      maxCacheBytes: 67108864, // 64 MiB — §8.2 snapshot-cache byte ceiling (reconciled to spec §8.2 from the 32 MiB Step-2 literal)
      // ── The 7 stateSync memory stores follow the developmentAgent dark-feature
      //    gate (standard_development_agent_dark_feature_gate), MOVED from
      //    DARK_GATE_EXCLUSIONS on 2026-06-13 per operator directive topic 13481:
      //    "NOTHING should ship dark on development agents — every multi-machine
      //    feature must be live on dev agents so it actually gets tested, not rot."
      //    Each store OMITS `enabled` so resolveDevAgentGate decides at runtime —
      //    LIVE on a dev agent (Echo/the Mini, the dogfooding ground), DARK on the
      //    fleet. A literal `enabled: false` would force-dark dev agents too (the
      //    #1001 shape the §12.5 dark-gate lint forbids for a dev-gated block) — so
      //    it is OMITTED, NOT baked false. The four consumer funnels
      //    (selfStateSyncReceive, ReplicatedStoreReader.isLive, isStoreEmissionEnabled,
      //    and the /preferences/session-context route) read the gate-RESOLVED stores
      //    map built at the construction boundary in server.ts (resolveStateSyncStores),
      //    so the gate genuinely flips them live — not just registry array-shuffling.
      //    UNLIKE credentialRepointing (whose keychain WRITE is destructive, so it keeps
      //    dryRun:true as the write-safety canary), these stores replicate between the
      //    operator's OWN machines with NO external egress and NO destructive/irreversible
      //    write — fully reversible via the foundation's rollback-unmerge (disabling a
      //    store atomically drops that origin's contribution). A dry-run would defeat
      //    "actually gets tested", so `dryRun: false` (genuinely live). An operator's
      //    EXPLICIT `enabled` in .instar/config.json remains the documented force-dark /
      //    fleet-flip override. applyDefaults is add-missing-only deep-merge, so existing
      //    agents backfill these on update (Migration Parity) and an operator's existing
      //    values are NEVER overwritten.
      // WS2.1 (multi-machine-replicated-store-foundation §4/§10.1) — `pref-record`.
      // SUPERSEDES the legacy seamlessness path (CMT-1416).
      preferences: {
        dryRun: false,
      },
      // WS2.3 (ws23-relationships-userregistry-security) — `relationship-record`, the
      // FIRST PII kind. Every replicated field is type-clamped on receive; a peer
      // record is quoted UNTRUSTED data, never the authoritative "who is messaging me";
      // a delete propagates a tombstone. PII crosses ONLY between the operator's own
      // machines (transit-encrypted).
      relationships: {
        dryRun: false,
      },
      // WS2.2 (multi-machine-replicated-store-foundation) — `learning-record`, the SECOND
      // memory-family kind. The local LRN-NNN id is NEVER replicated (the recordKey is a
      // content fingerprint).
      learnings: {
        dryRun: false,
      },
      // WS2.4 (multi-machine-replicated-store-foundation) — `knowledge-record`, the THIRD
      // memory-family kind. Only catalog METADATA crosses (NEVER the file body or the
      // local path); the local generated id is never replicated.
      knowledge: {
        dryRun: false,
      },
      // WS2.5 (multi-machine-replicated-store-foundation) — `evolution-action-record`, the
      // FOURTH memory-family kind (the agent's self-improvement action queue). The local
      // ACT-NNN id is NEVER replicated; the load-bearing cross-machine field is `status` —
      // a peer must SEE an action was already completed/in_progress elsewhere so it does
      // not redo it.
      evolutionActions: {
        dryRun: false,
      },
      // WS2.6 (multi-machine-replicated-store-foundation) — `user-record`, the SECOND PII
      // kind (the multi-user registry). The local userId is NEVER replicated — the recordKey
      // is the channel-set identity surface; inbound-principal RESOLUTION stays LOCAL-ONLY
      // (the local channel index is always authoritative). User PII crosses ONLY between the
      // operator's own machines (transit-encrypted).
      userRegistry: {
        dryRun: false,
      },
      // WS2.6 (multi-machine-replicated-store-foundation) — `topic-operator-record`, the
      // THIRD PII kind (which VERIFIED operator a topic was bound to). The recordKey is
      // sha256(topicId + ":" + verified-uid), NEVER a content-name. THE LOAD-BEARING SAFETY
      // INVARIANT: a replicated topic-operator record is UNTRUSTED peer data — NEVER this
      // machine's authoritative answer to "who is my verified operator?" (only the local
      // authenticated setOperator binds the principal; Know-Your-Principal).
      topicOperator: {
        dryRun: false,
      },
      // Secure A2A Verified Pairing §3.8 (FD11) — `threadline-pairing-record`, the EIGHTH
      // replicated-store consumer. Replicates ONLY the verified-IDENTITY RESULT of a pairing
      // { peerFp, peerIdentityPub, state:'mutual-verified', verifiedAt, verifiedOnMachine } —
      // NEVER the SAS words, shared secret, or relay token (those stay machine-local BY DESIGN,
      // bound to the machine-local handshake's ephemeral secret). Machine B honors a replicated
      // record ONLY by pinning peerIdentityPub; inherited = identity-verified, NOT channel-ready.
      // UNLIKE the 7 WS2 memory stores above (which OMIT `enabled` so the developmentAgent gate
      // decides), this store is a CREDENTIAL-GATING surface, so per the spec it ships fully DARK
      // with an EXPLICIT `enabled:false` + `dryRun:true` on EVERY agent (dev agents included) —
      // the cautious rollout posture for a feature that feeds the credential-share gate. Flag-off
      // ⇒ strict no-op (single-machine agents unaffected). applyDefaults add-missing semantics →
      // migrateConfig backfills these on update (Migration Parity); an operator's existing values
      // are NEVER overwritten.
      threadlinePairing: {
        enabled: false,
        dryRun: true,
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
      // Scope-Accretion Completion Discipline (spec: autonomous-scope-accretion-
      // completion.md §4). Default ON (monotone-safe, operator-requested — the
      // documented maturation-path exception). SNAPSHOT SEMANTICS: this config is
      // snapshotted SERVER-SIDE at run registration, so a mid-run edit to this
      // file changes nothing for the running session; the operator's LIVE lever
      // is the PIN-gated route POST /autonomous/:topic/scope-accretion-override
      // (dashboard PIN — audited, principal-verified). Editing `enabled:false`
      // here is the rollback for FUTURE runs.
      scopeAccretion: {
        enabled: true,
        // K consecutive scope-accretion holds with an unchanged unbuilt-set hash
        // and no new corroboration/ratification trip the breaker (min 2): ONE
        // loud labeled exit, then the gate disengages for the run (R26/R39).
        breakerK: 3,
      },
    },
    // Server-side ceiling (ms) on a registered run's endAt — POST /autonomous/
    // register CLAMPS endAt to now + maxDurationMs so a session cannot register
    // an unbounded run (R43/R49). Default 48h.
    maxDurationMs: 172800000,
  },
  // Cartographer doc-tree — hierarchical semantic map with git-hash staleness
  // (cartographer-doc-tree-schema spec #1). `enabled` is deliberately OMITTED so
  // the runtime resolves it through the standard developmentAgent dark-feature
  // gate (`enabled ?? !!developmentAgent`, standard_development_agent_dark_feature_gate):
  // LIVE on a dev agent (the zero-cost read surfaces dogfood there), DARK fleet-wide.
  // Registered in DEV_GATED_FEATURES (src/core/devGatedFeatures.ts). The live-fleet
  // flip is registering `enabled: true` here. Spec: DEV-AGENT-DARK-GATE-ENFORCEMENT.
  // PromiseBeacon — commitment follow-through heartbeats. Read at TOP LEVEL
  // (`config.promiseBeacon`, NOT `monitoring.promiseBeacon`) by server.ts; these
  // are the keys the runtime actually consumes. HONEST-PROGRESS-MESSAGING B1/B1b/B2:
  // silence the zero-information "still on it, no new output" filler by default,
  // surface a sparse liveness line so long tasks aren't fully dark, and close out
  // a finished turn instead of heart-beating into an empty room. The deep-merge
  // add-missing backfill carries these to existing agents that already have a
  // `promiseBeacon` block; the honest-progress-messaging-defaults migrator is the
  // audited belt-and-suspenders backfill for agents without one.
  // C1+C2 "The Agent Carries the Loop" (spec agent-owned-followthrough §4.8).
  // Top-level `commitments` config — the resolver reads
  // config.commitments.agentOwnedFollowthrough. `enabled` is DELIBERATELY OMITTED
  // here: it is resolved via the developmentAgent gate (dark-on-fleet /
  // live-on-dev) — migrateConfig must never write the enabled literal (round-13
  // dev-gate lesson). These are the operator's tuning/opt-out dials; dryRun
  // defaults true so the dark→live promotion is the operator's deliberate flip.
  commitments: {
    autoExpiry: {
      enabled: true,
      maxAgeDays: 21,
      sweepIntervalMs: 21_600_000,
      dryRun: true,
    },
    agentOwnedFollowthrough: {
      dryRun: true,
      // externalBlockWindowMs / externalBlockCeilingMs / externalBlockSweepMs:
      // left to the code defaults (24h / 14d / 1h) unless the operator tunes them.
    },
  },
  promiseBeacon: {
    suppressUnchangedHeartbeats: true, // B1 — false restores the legacy every-tick templated heartbeat (rollback)
    beaconLivenessIntervalMs: 3_600_000, // B1b — at most one sparse "still watching" line per 60m
    turnFinishedCloseoutChecks: 3, // B2/FD-1 — N idle-frame checks before the one-shot close-out
  },
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
    // Offender #1 conversion (docs/specs/keyword-intent-conversions-1-and-3.md).
    // The "change this topic's framework/model/thinking" decision is inferred by an
    // LLM over the message + recent conversation (ProfileIntentClassifier), NOT the
    // keyword regexes that used to live in parseProfileTrigger (the 2026-07-03
    // keyword-intent audit's offender #1). `enabled` is DELIBERATELY OMITTED (not
    // hardcoded false) so resolveDevAgentGate decides — DARK on the fleet, LIVE on a
    // development agent (registered in DEV_GATED_FEATURES, configPath
    // topicProfiles.intentClassifier.enabled). Ships dry-run FIRST: on a dev agent
    // the classifier RUNS and LOGS would-actuate vs would-pass to
    // logs/profile-intent.jsonl, but the message ALWAYS passes through (never
    // actuated) until a deliberate dryRun:false — proving the false-positive rate
    // collapsed before it can wrongly respawn a session. Fail-OPEN on any
    // uncertainty. Enforces "Intelligence Infers, Keywords Only Guard".
    intentClassifier: {
      dryRun: true,
      minConfidence: 0.85,
      timeoutMs: 4000,
      contextWindowTurns: 6,
      modelTier: 'fast',
    },
  },
  // Live credential re-pointing (spec: live-credential-repointing-rebalancer.md).
  // developmentAgent dark-feature gate (operator directive 2026-06-13): `enabled` is
  // OMITTED so resolveDevAgentGate resolves it LIVE on a dev agent + DARK on the fleet
  // (the DEV_GATED_FEATURES entry). The destructive credential WRITE is gated by the
  // SEPARATE dryRun flag (default true): live-on-dev runs the full decision loop +
  // audits what it WOULD do, but the CredentialSwapExecutor returns before any keychain
  // write while dryRun holds — the dry-run canary. Real writes need a deliberate
  // dryRun:false (gated behind the §5 livetest promotion). DO NOT hardcode enabled here
  // (a baked-in false would dark dev agents too — the #1001 shape the dark-gate lint
  // forbids for a dev-gated block).
  subscriptionPool: {
    credentialRepointing: {
      dryRun: true,
      manualLeversEnabled: true,
    },
  },
  // Playwright profile↔accounts registry (spec: playwright-profile-registry.md).
  // developmentAgent dark-feature gate: `enabled` is OMITTED so resolveDevAgentGate
  // resolves it LIVE on a dev agent + DARK on the fleet (the DEV_GATED_FEATURES
  // entry). The only destructive op (activate: MCP-config rewrite + session restart)
  // is gated by the SEPARATE dryRun flag (default true): live-on-dev computes + audits
  // the intended rewrite/refresh but performs NEITHER while dryRun holds — the
  // dry-run canary, mirroring credentialRepointing/topicProfiles. A real switch needs
  // a deliberate dryRun:false. DO NOT hardcode `enabled` here (a baked-in false would
  // dark dev agents too — the #1001 shape the dark-gate lint forbids for a dev-gated
  // block).
  playwrightRegistry: {
    dryRun: true,
  },
  // Durable conversation identity (docs/specs/durable-conversation-identity.md §9).
  // recording is the ALWAYS-ON foundation's runtime kill-switch (default true —
  // flipping it false forces the §3.6 legacy-identical in-memory degradation
  // without a redeploy; the CommitmentTracker-freeze precedent). followThrough
  // gates DELIVERY only and is a developmentAgent dark feature: `enabled` is
  // OMITTED so resolveDevAgentGate resolves it LIVE on a dev agent + DARK on the
  // fleet (the DEV_GATED_FEATURES entry), with dryRun:true FIRST because delivery
  // is externally visible (typed §5.1 non-deliveries + would-deliver audit lines
  // until a deliberate dryRun:false). DO NOT hardcode followThrough.enabled here
  // (a baked-in false would dark dev agents too — the #1001 shape the dark-gate
  // lint forbids for a dev-gated block). mintBreaker carries the §3.3 pinned
  // defaults (existence-checked add-missing on update — Migration Parity).
  conversationIdentity: {
    recording: {
      enabled: true,
      disableJournalFsync: false,
    },
    followThrough: {
      dryRun: true,
    },
    mintBreaker: {
      windowMs: 600000,
      speculativePerWindow: 200,
      durableBindingPerWindow: 50,
    },
  },
  // Feedback-factory processing wiring (docs/specs/feedback-factory-migration.md
  // §191 — "the processor job is actually constructed and scheduled, not dead
  // code"). Turns the already-parity'd processUnprocessed clustering pass into a
  // real triggerable capability: GET /feedback-factory/stats (read-only counts) +
  // POST /feedback-factory/process (one clustering pass over the canonical store) +
  // a cadenced built-in job (feedback-factory-process) that drives the trigger.
  // developmentAgent dark-feature gate: `enabled` is OMITTED so resolveDevAgentGate
  // resolves it LIVE on a dev agent + DARK on the fleet (when off, both routes 503
  // and the job exits silently). The processor only appends local JSONL (clusters +
  // unprocessed→processing flips) — zero external side effects. DO NOT hardcode
  // `enabled` here (a baked-in false would dark dev agents too — the #1001 shape the
  // dark-gate lint forbids for a dev-gated block).
  feedbackFactory: {
    processing: {},
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
