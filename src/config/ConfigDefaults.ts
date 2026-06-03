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

/** Fields shared across ALL agent types and contexts (init + migration) */
const SHARED_DEFAULTS: Record<string, unknown> = {
  monitoring: {
    memoryMonitoring: true,
    healthCheckIntervalMs: 30000,
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
    // SocketDisconnectSentinel + ActiveWorkSilenceSentinel — default-on so
    // every agent recovers from connection drops and silent mid-task freezes
    // without anyone having to notice manually. enabled:false restores
    // pre-feature behavior. See docs/specs/silently-stopped-trio.md.
    socketDisconnectSentinel: {
      enabled: true,
    },
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
