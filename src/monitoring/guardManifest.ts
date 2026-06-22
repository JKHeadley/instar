/**
 * guardManifest — the STATIC DECLARED MANIFEST of every guard this codebase
 * ships (GUARD-POSTURE-ENDPOINT-SPEC §2.1).
 *
 * The authoritative discovery boundary for the /guards inventory: the shared
 * extractor (guardPosture.ts) covers config-shaped guards generically; this
 * manifest declares the rest — guards with no config key at all (default-ON
 * in code), guards living outside `monitoring.*`, sub-guards that must not
 * hide inside an on-confirmed parent, and out-of-process (lifeline) guards —
 * plus per-guard metadata the honest-state derivation needs (expected tick
 * cadence for staleness, liveConfig divergence suppression, dry-run paths).
 *
 * The companion `NOT_A_GUARD` list classifies every other boot-constructed
 * component that LOOKS guard-shaped but deliberately is not in the inventory,
 * with a reason. scripts/lint-guard-manifest.js enforces that every candidate
 * component appears in exactly one of the two lists — a future guard cannot
 * be forgotten (Structure > Willpower; the lint follows the
 * lint-dev-agent-dark-gate.js + exclusions-list precedent).
 */

export type GuardKind = 'config' | 'code-default';
export type GuardProcess = 'server' | 'lifeline';

export interface GuardManifestEntry {
  /** Canonical inventory key (matches the shared extractor's key where both cover a guard). */
  key: string;
  kind: GuardKind;
  /** kind 'config': dotted path to the enabled boolean in the agent config. */
  configPath?: string;
  /** kind 'code-default': the shipped in-code value. Also the fallback default
   *  for kind 'config' guards whose default is deliberately OMITTED from
   *  ConfigDefaults (runtime-fallback pattern, e.g. contextWedge autoRecovery). */
  defaultEnabled: boolean;
  /** Dotted path to a dry-run flag, when the guard has one. */
  dryRunConfigPath?: string;
  /** Self-declared tick cadence; staleness threshold = 5 × this (spec §2.2). */
  expectedTickMs?: number;
  /** Component re-reads config per use → `diverged-pending-restart` is
   *  SUPPRESSED (the change is already live; the state would lie). */
  liveConfig?: boolean;
  process: GuardProcess;
  /** True only where the component ACTUALLY self-registers a runtime getter
   *  into the GuardRegistry at boot. An enabled guard with expectRuntime that
   *  registered nothing reports `missing` (reconciliation, spec §2.1). Keep
   *  this exactly in sync with the registration callsites — an aspirational
   *  `true` here manufactures phantom `missing` rows. */
  expectRuntime: boolean;
  /** Implementing component (class/module name) — the lint's join key. */
  component?: string;
  description: string;
}

export const GUARD_MANIFEST: readonly GuardManifestEntry[] = [
  // ── Durable Inbound Message Queue (spec §Observability; keys === configPath) ──
  {
    key: 'multiMachine.sessionPool.inboundQueue.enabled',
    kind: 'config',
    configPath: 'multiMachine.sessionPool.inboundQueue.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'multiMachine.sessionPool.inboundQueue.dryRun',
    expectedTickMs: 15_000,
    process: 'server',
    expectRuntime: false,
    component: 'QueueDrainLoop',
    description: 'Durable custody for undeliverable inbound messages + the drain that delivers them (ships dark).',
  },
  {
    key: 'multiMachine.sessionPool.holdForStability.enabled',
    kind: 'config',
    configPath: 'multiMachine.sessionPool.holdForStability.enabled',
    defaultEnabled: false,
    process: 'server',
    // §4.2: the runtime getter reports the EFFECTIVE state (always-failover
    // default ⇒ enabled:false) and registers on the UNCONDITIONAL boot path,
    // so the orphaned-config case (hold on, queue off) derives
    // off-runtime-divergent rather than on-unverified.
    expectRuntime: true,
    component: 'OwnerHoldVerdict',
    description: 'Hold-for-stability: briefly-wobbly machines get up to holdMaxMs to recover before their conversations move (ships dark; trails inboundQueue one stage).',
  },
  // ── Session lifecycle guards ──
  {
    key: 'monitoring.sessionReaper.enabled',
    kind: 'config',
    configPath: 'monitoring.sessionReaper.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.sessionReaper.dryRun',
    expectedTickMs: 120_000,
    process: 'server',
    expectRuntime: true,
    component: 'SessionReaper',
    description: 'Pressure-aware reaper of idle-but-alive sessions (the guard the Mini ran without for a week).',
  },
  {
    key: 'monitoring.resumeQueue.enabled',
    kind: 'config',
    configPath: 'monitoring.resumeQueue.enabled',
    // Code-defaulted true (#1157 keeps resume-queue keys OUT of ConfigDefaults to
    // preserve the fleet flip; this is the runtime-fallback default).
    defaultEnabled: true,
    dryRunConfigPath: 'monitoring.resumeQueue.dryRun',
    process: 'server',
    // The runtime getter (ResumeQueue.guardStatus) registers UNCONDITIONALLY at
    // boot, so a disabled queue (e.g. an un-healable foreign-host lock) derives
    // off-runtime-divergent (config on, runtime off) rather than `missing` —
    // the alerting class that makes a silently-disabled revival guard loud.
    expectRuntime: true,
    component: 'ResumeQueue',
    description: 'Mid-work resume queue: revives a reaped registered autonomous run (#1157). A disabled queue reports off-runtime-divergent so it is never silently inert (an autonomous run must outlive its session).',
  },
  {
    key: 'monitoring.reapNotify.enabled',
    kind: 'config',
    configPath: 'monitoring.reapNotify.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'ReapNotify',
    description: 'User-facing notice when a session is autonomously shut down.',
  },
  {
    key: 'monitoring.greenPrAutoMerge.enabled',
    kind: 'config',
    configPath: 'monitoring.greenPrAutoMerge.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.greenPrAutoMerge.dryRun',
    expectedTickMs: 600_000,
    process: 'server',
    expectRuntime: true,
    component: 'GreenPrAutoMerger',
    description: 'Background watcher that merges a green, mergeable, non-held PR this agent authored (Phase 7 becomes machinery). Repo-gated; lease-serialized; runtime rollback + breaker.',
  },
  {
    key: 'monitoring.watchdog.enabled',
    kind: 'config',
    configPath: 'monitoring.watchdog.enabled',
    defaultEnabled: true,
    expectedTickMs: 30_000,
    liveConfig: true,
    process: 'server',
    expectRuntime: true,
    component: 'SessionWatchdog',
    description: 'Stuck-process detection + escalating kill sequence.',
  },
  {
    key: 'monitoring.socketDisconnectSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.socketDisconnectSentinel.enabled',
    defaultEnabled: true,
    expectedTickMs: 15_000,
    process: 'server',
    expectRuntime: true,
    component: 'SocketDisconnectSentinel',
    description: 'Detects sessions that silently dropped their socket.',
  },
  {
    key: 'monitoring.activeWorkSilenceSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.activeWorkSilenceSentinel.enabled',
    defaultEnabled: true,
    expectedTickMs: 60_000,
    process: 'server',
    expectRuntime: true,
    component: 'ActiveWorkSilenceSentinel',
    description: 'Detects sessions frozen mid-task (active work gone silent).',
  },
  {
    key: 'monitoring.contextWedgeSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.contextWedgeSentinel.enabled',
    defaultEnabled: true,
    expectedTickMs: 20_000,
    process: 'server',
    expectRuntime: true,
    component: 'ContextWedgeSentinel',
    description: 'Detects the thinking-block/AUP wedge that permanently kills a session.',
  },
  {
    // Sub-guard (spec §2.1): the destructive fresh-respawn arm inside the
    // wedge sentinel. Its own inventory row so "autoRecovery silently off
    // inside an on-confirmed sentinel" cannot hide. Default is the runtime
    // fallback in server.ts (deliberately OMITTED from ConfigDefaults).
    key: 'monitoring.contextWedgeSentinel.autoRecovery.enabled',
    kind: 'config',
    configPath: 'monitoring.contextWedgeSentinel.autoRecovery.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.contextWedgeSentinel.autoRecovery.dryRun',
    process: 'server',
    expectRuntime: true,
    component: 'ContextWedgeSentinel',
    description: 'Auto-recovery (kill + fresh respawn) arm of the context-wedge sentinel.',
  },
  {
    key: 'monitoring.agentWorktreeReaper.enabled',
    kind: 'config',
    configPath: 'monitoring.agentWorktreeReaper.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.agentWorktreeReaper.dryRun',
    expectedTickMs: 86_400_000,
    process: 'server',
    expectRuntime: false,
    component: 'AgentWorktreeReaper',
    description: 'Reclaims merged+clean+unused agent worktrees.',
  },
  {
    // `enabled` is deliberately OMITTED from ConfigDefaults — the runtime resolves
    // it through the developmentAgent dark-feature gate (dark on the fleet, live on
    // a dev agent). defaultEnabled:false reflects the fleet default.
    key: 'monitoring.orphanedWorkSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.orphanedWorkSentinel.enabled',
    defaultEnabled: false,
    expectedTickMs: 600_000,
    process: 'server',
    expectRuntime: false,
    component: 'OrphanedWorkSentinel',
    description: 'Detects agent worktrees with uncommitted work whose owning session died + settled.',
  },
  {
    // tmux Event-Loop Resilience (C). `enabled` is deliberately OMITTED from
    // ConfigDefaults — the runtime resolves it through the developmentAgent
    // dark-feature gate (dark on the fleet, live on a dev agent). defaultEnabled:false
    // reflects the fleet default. NO expectedTickMs: it is EVENT-DRIVEN (fed by
    // (A)'s tmux-call latency + (B)'s 'stall' events), so a quiet/healthy tmux is
    // not stale — setting expectedTickMs would derive a false on-stale. expectRuntime:
    // true REQUIRES the server-boot guardRegistry.register callsite (a pure in-memory
    // guardStatus getter); an enabled-but-unregistered guard reports `missing`.
    key: 'monitoring.degradedTmuxGuard.enabled',
    kind: 'config',
    configPath: 'monitoring.degradedTmuxGuard.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: true,
    component: 'DegradedTmuxGuard',
    description: 'Signal-only watcher: raises ONE deduped agent-health Attention item when the shared tmux server is degraded (slow sync calls / event-loop stalls). NEVER kills the shared socket.',
  },
  {
    key: 'monitoring.mcpProcessReaper.enabled',
    kind: 'config',
    configPath: 'monitoring.mcpProcessReaper.enabled',
    defaultEnabled: false,
    expectedTickMs: 1_800_000,
    process: 'server',
    expectRuntime: false,
    component: 'McpProcessReaper',
    description: 'Reaps orphaned MCP server processes.',
  },
  {
    key: 'monitoring.staleBackstop.enabled',
    kind: 'config',
    configPath: 'monitoring.staleBackstop.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'StaleBackstop',
    description: 'Backstop cleanup for stale session state.',
  },
  {
    key: 'monitoring.agentSleep.enabled',
    kind: 'config',
    configPath: 'monitoring.agentSleep.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'AgentSleep',
    description: 'Agent sleep/idle power management.',
  },
  // ── Liveness / health guards ──
  {
    key: 'monitoring.bootHealthBeacon.enabled',
    kind: 'config',
    configPath: 'monitoring.bootHealthBeacon.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'BootHealthBeacon',
    description: 'Boot-time health beacon endpoint (dev-gated, CMT-1438).',
  },
  {
    key: 'monitoring.rateLimitSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.rateLimitSentinel.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'RateLimitSentinel',
    description: 'Detects provider rate-limit walls and schedules recovery.',
  },
  {
    key: 'monitoring.parallelWorkSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.parallelWorkSentinel.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'ParallelWorkSentinel',
    description: 'Cross-topic overlap councilor (dev-gated, Phase B).',
  },
  {
    key: 'monitoring.resourceLedger.enabled',
    kind: 'config',
    configPath: 'monitoring.resourceLedger.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'ResourceLedger',
    description: 'CPU/memory sampling + rate-limit-event ledger (read-only observability).',
  },
  {
    key: 'monitoring.memoryMonitoring',
    kind: 'config',
    configPath: 'monitoring.memoryMonitoring',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'MemoryPressureMonitor',
    description: 'Memory-pressure sampling that feeds load-shed decisions.',
  },
  {
    key: 'monitoring.quotaTracking',
    kind: 'config',
    configPath: 'monitoring.quotaTracking',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'QuotaTracker',
    description: 'Threshold-based LLM quota tracking + load shedding.',
  },
  {
    key: 'monitoring.telemetry.enabled',
    kind: 'config',
    configPath: 'monitoring.telemetry.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'TelemetryCollector',
    description: 'Job/session telemetry collection.',
  },
  {
    key: 'monitoring.burnDetection.enabled',
    kind: 'config',
    configPath: 'monitoring.burnDetection.enabled',
    // Defaults deliberately OMITTED from ConfigDefaults (shipped defaults live
    // in AgentServer); absence preserves default-ON.
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'BurnDetector',
    description: 'Per-component token-burn share/rate alerts.',
  },
  {
    key: 'monitoring.sentinelTelegramEscalation',
    kind: 'config',
    configPath: 'monitoring.sentinelTelegramEscalation',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'SentinelEscalationFlag',
    description: 'Opt-in Telegram delivery of coalesced sentinel escalations.',
  },
  // ── Triage / learning guards ──
  {
    key: 'monitoring.triage.enabled',
    kind: 'config',
    configPath: 'monitoring.triage.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'StallTriageNurse',
    description: 'Stall triage nurse (classification of stuck sessions).',
  },
  {
    key: 'monitoring.triageOrchestrator.enabled',
    kind: 'config',
    configPath: 'monitoring.triageOrchestrator.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'TriageOrchestrator',
    description: 'Orchestrates triage outcomes into recovery actions.',
  },
  {
    key: 'monitoring.failureLearning.enabled',
    kind: 'config',
    configPath: 'monitoring.failureLearning.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'FailureLearningLoop',
    description: 'Failure-Learning Loop capture + pattern surfacing (dev-gated, CMT-1438).',
  },
  {
    key: 'monitoring.correctionLearning.enabled',
    kind: 'config',
    configPath: 'monitoring.correctionLearning.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'CorrectionLearningLoop',
    description: 'Correction & preference learning sentinel.',
  },
  {
    // Sub-guard: plain-boolean flag INSIDE the correctionLearning block (not
    // `.enabled`-shaped, so the generic extractor cannot see it).
    key: 'monitoring.correctionLearning.selfViolationSignal',
    kind: 'config',
    configPath: 'monitoring.correctionLearning.selfViolationSignal',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'CorrectionLearningLoop',
    description: 'Self-violation observe-only signal inside correction learning.',
  },
  {
    key: 'monitoring.apprenticeshipCycleSla.enabled',
    kind: 'config',
    configPath: 'monitoring.apprenticeshipCycleSla.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'ApprenticeshipCycleSlaMonitor',
    description: 'Observe-only overdue-apprenticeship-cycle signal.',
  },
  {
    key: 'monitoring.geminiCapacityEscalation.enabled',
    kind: 'config',
    configPath: 'monitoring.geminiCapacityEscalation.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'GeminiCapacityEscalation',
    description: 'Gemini capacity escalation monitor.',
  },
  {
    key: 'monitoring.releaseReadiness.enabled',
    kind: 'config',
    configPath: 'monitoring.releaseReadiness.enabled',
    defaultEnabled: false,
    expectedTickMs: 21_600_000,
    process: 'server',
    expectRuntime: false,
    component: 'ReleaseReadinessSentinel',
    description: 'Stalled-release watchdog (dev-gated; maintainer environments).',
  },
  {
    key: 'monitoring.promptGate.enabled',
    kind: 'config',
    configPath: 'monitoring.promptGate.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'PromptGate',
    description: 'Prompt-quality gate on outbound LLM calls.',
  },
  // ── Dev-gated observability guards (enabled omitted; gate-resolved) ──
  {
    key: 'monitoring.growthAnalyst.enabled',
    kind: 'config',
    configPath: 'monitoring.growthAnalyst.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'GrowthMilestoneAnalyst',
    description: 'Proactive growth & milestone analyst (dev-gated).',
  },
  {
    key: 'monitoring.blockerLedger.enabled',
    kind: 'config',
    configPath: 'monitoring.blockerLedger.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'BlockerLedger',
    description: 'Blocker ledger resolution pipeline (dev-gated).',
  },
  // ── Non-monitoring roots ──
  {
    key: 'scheduler.enabled',
    kind: 'config',
    configPath: 'scheduler.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: true,
    component: 'JobScheduler',
    description: 'Cron job scheduler (registration is not life: runtime carries lastTickAt/jobCount/pausedJobCount).',
  },
  {
    key: 'models.tierEscalation.enabled',
    kind: 'config',
    configPath: 'models.tierEscalation.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'models.tierEscalation.dryRun',
    process: 'server',
    expectRuntime: false,
    component: 'ModelTierEscalation',
    description: 'Model-tier escalation policy (COST-INCREASING enable).',
  },
  {
    // Out-of-process guard (spec §2.1): config-derived states ONLY
    // (`on-unverified` at best) — the sync in-memory getter contract cannot
    // cross processes, so this entry must never carry expectRuntime.
    key: 'lifeline.driftPromoter.enabled',
    kind: 'config',
    configPath: 'lifeline.driftPromoter.enabled',
    defaultEnabled: true,
    process: 'lifeline',
    expectRuntime: false,
    component: 'LifelineDriftPromoter',
    description: 'Lifeline version-drift self-restart promoter (runs in the lifeline process).',
  },
  {
    key: 'multiMachine.secretSync.enabled',
    kind: 'config',
    configPath: 'multiMachine.secretSync.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'SecretSync',
    description: 'Cross-machine secret sync, receive side (dev-gated).',
  },
  {
    key: 'multiMachine.sessionPool.enabled',
    kind: 'config',
    configPath: 'multiMachine.sessionPool.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'SessionPool',
    description: 'Multi-machine session pool (ships dark behind stage).',
  },
  {
    key: 'multiMachine.coherenceJournal.enabled',
    kind: 'config',
    configPath: 'multiMachine.coherenceJournal.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'CoherenceJournal',
    description: 'Cross-machine coherence journal (dev-gated).',
  },
  // ── Code-default guards (no config key; default-ON in code) ──
  {
    key: 'messaging.attentionTopicGuard',
    kind: 'code-default',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'AttentionTopicGuard',
    description: 'Topic-Flood Guard — per-source attention-topic circuit breaker (default-ON in code; tunable via messaging[].config.attentionTopicGuard).',
  },
  {
    key: 'messaging.topicCreationBudget',
    kind: 'code-default',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'TopicCreationBudget',
    description: 'Bounded Notification Surface — last-resort budget on every auto-created topic (default-ON in code).',
  },
] as const;

/**
 * Boot-constructed components that match the guard shape (enabled-style
 * switch or tick loop in src/monitoring, src/messaging, src/lifeline,
 * src/core) but are DELIBERATELY not inventory guards. The lint requires
 * every candidate to appear here or in GUARD_MANIFEST — with a real reason
 * (≥12 non-whitespace chars, same bar as DARK_GATE_EXCLUSIONS).
 */
export interface NotAGuardEntry {
  component: string;
  reason: string;
}

export const NOT_A_GUARD: readonly NotAGuardEntry[] = [
  { component: 'rawTextRequestDetector', reason: 'Pure stateless predicate (high-precision pattern match) feeding the observe-only ask-for-access signal in checkOutboundMessage; no enabled flag, no runtime getter, takes no protective action — a detector that produces a signal, never a guard with posture.' },
  { component: 'GuardPostureTripwire', reason: 'The boot-transition detector OVER the guard inventory — meta-layer, not a guard itself; always-on, no enabled flag.' },
  { component: 'GuardRegistry', reason: 'Infrastructure of this feature: the runtime-getter registry the inventory reads; not a guard.' },
  { component: 'GuardPostureProbe', reason: 'Consumer of the inventory (probe family); its cadence rides SystemReviewer, not an own enabled switch.' },
  { component: 'SystemReviewer', reason: 'Probe scheduler/aggregator — operational reviewer, not a behavior-protecting guard; covered indirectly by its probes.' },
  { component: 'CompactionSentinel', reason: 'Always-on internal recovery lifecycle with no config enabled switch; recovery engine, not an operator-flippable guard.' },
  { component: 'SessionMonitor', reason: 'Event-driven session bookkeeping with no enabled switch; pure observability plumbing.' },
  { component: 'WorktreeMonitor', reason: 'Always-active worktree scan plumbing, no enabled switch, takes no protective action.' },
  { component: 'CoherenceMonitor', reason: 'Multi-machine coherence bookkeeping rides multiMachine gating; no own guard switch.' },
  { component: 'CommitmentSentinel', reason: 'Rides the commitments feature lifecycle; commitment bookkeeping, not a safety guard with an operator switch.' },
  { component: 'SleepWakeDetector', reason: 'Always-on OS sleep/wake event detector; pure signal source with no enabled switch.' },
  { component: 'PresenceProxy', reason: 'Standby heartbeat messenger; messaging-liveness feature, tuned not toggled — no guard semantics.' },
  { component: 'PromiseBeacon', reason: 'Commitment follow-through heartbeats; user-facing feature behavior, not a protective guard.' },
  { component: 'CommitmentTracker', reason: 'Commitment lifecycle store; data layer, no guard semantics.' },
  { component: 'LlmQueue', reason: 'Rate-limited LLM call queue; shared infrastructure, not an operator-flippable guard.' },
  { component: 'HelperWatchdog', reason: 'Signal-only subagent stall detector wired into SubagentTracker; no config enabled switch, consumers own actions.' },
  { component: 'DeliveryFailureSentinel', reason: 'Telegram relay recovery engine; delivery-robustness layer, always-on with the relay, no guard switch.' },
  { component: 'TemplatesDriftVerifier', reason: 'Deployed-script drift lint; CI-style verifier, not a runtime guard.' },
  { component: 'TokenLedger', reason: 'Read-only token observability (never gates); the spec class-precedent for always-on read-only features.' },
  { component: 'TokenLedgerPoller', reason: 'Background scanner feeding TokenLedger; observability plumbing.' },
  { component: 'CrashLoopPauser', reason: 'Auto-pause of runaway jobs is scheduler-internal mechanics; surfaced via scheduler.enabled + job state, not its own guard.' },
  { component: 'QuotaTrackerPoller', reason: 'Polling arm of QuotaTracker; covered by monitoring.quotaTracking.' },
  { component: 'StuckSignatureClassifier', reason: 'Pure classifier (standby honesty); signal-only, no enabled switch, no action.' },
  { component: 'MessageSentinel', reason: 'Emergency-stop message classifier; inbound-dispatch mechanics inseparable from messaging, no operator switch.' },
  { component: 'TelegramAdapter', reason: 'Platform transport adapter; messaging infrastructure, not a guard.' },
  { component: 'SlackAdapter', reason: 'Platform transport adapter; messaging infrastructure, not a guard.' },
  { component: 'WhatsAppAdapter', reason: 'Platform transport adapter; messaging infrastructure, not a guard.' },
  { component: 'IMessageAdapter', reason: 'Platform transport adapter; messaging infrastructure, not a guard.' },
  { component: 'MessageRouter', reason: 'Topic→adapter routing; messaging infrastructure, not a guard.' },
  { component: 'DeliveryRetryManager', reason: 'Delivery retry mechanics; messaging infrastructure, not a guard.' },
  { component: 'PendingRelayStore', reason: 'Durable relay queue; storage layer, not a guard.' },
  { component: 'MessageStore', reason: 'Message persistence; storage layer, not a guard.' },
  { component: 'SpawnRequestManager', reason: 'Cross-session spawn coordination; session mechanics, not a guard.' },
  { component: 'SessionManager', reason: 'Core session lifecycle engine; the thing guards act ON, not a guard.' },
  { component: 'StateManager', reason: 'Core state persistence; storage layer.' },
  { component: 'SourceTreeGuard', reason: 'Hard invariant on destructive ops against the source tree — always-on by design with NO off switch, so posture (on/off) is meaningless for it.' },
  { component: 'SafeGitExecutor', reason: 'Single-funnel for destructive git ops; hard invariant, no off switch, posture meaningless.' },
  { component: 'SafeFsExecutor', reason: 'Single-funnel for destructive fs ops; hard invariant, no off switch, posture meaningless.' },
  { component: 'UpdateChecker', reason: 'Auto-update polling; lifecycle infrastructure, not a protective guard.' },
  { component: 'SleepWakeCoordinator', reason: 'Multi-machine awake/standby lease mechanics; coordination layer, not an operator-flippable guard.' },
  { component: 'MachinePoolRegistry', reason: 'In-memory pool state from heartbeats; data layer this feature reads, not a guard.' },
  { component: 'PendingInjectStore', reason: 'Durable inject ledger; storage layer.' },
  { component: 'LifelineProbe', reason: 'Server→lifeline health probe in the probe family; rides SystemReviewer cadence.' },
  { component: 'LifelineDriftMonitor', reason: 'Version-handshake observer feeding the driftPromoter (which IS the guard, declared in the manifest).' },
  // ── lint-guard-manifest backfill (spec §2.1 "complete backfill" sweep) ──
  { component: 'A2ARedeliverySentinel', reason: 'A2A delivery-loop closer (redelivery + per-peer escalation) gated by monitoring.a2aRedelivery, default-OFF; threadline delivery-robustness mechanics, deliberately not in the protective-guard inventory.' },
  { component: 'AgentWorktreeDetector', reason: 'One-shot per-startup worktree-convention scan emitting at most one aggregated attention item; no running lifecycle or enabled switch, so posture is not expressible.' },
  { component: 'FeedbackAnomalyDetector', reason: 'In-memory rate/burst screening of feedback submissions; feedback-service input validation, not a session-protecting guard.' },
  { component: 'AccountFollowMeDetector', reason: 'Pure deterministic decision helper (WS5.2) computing which depth-zero machines to OFFER an enrollment consent for; no boot lifecycle, no enabled switch, never blocks — a computation library, not a guard.' },
  { component: 'FrameworkParitySentinel', reason: 'Parity-rules registry consumer surfacing framework-native drift; mentor/parity feature mechanics riding enabledFrameworks, not an operator-flippable protective guard.' },
  { component: 'GeminiCapacityEscalationMonitor', reason: 'Implementation file of the manifest guard monitoring.geminiCapacityEscalation.enabled — declared there under component name GeminiCapacityEscalation; this entry classifies the file-basename alias only.' },
  { component: 'HandoffSentinel', reason: 'Planned-handoff lifecycle state machine (multi-machine coordination mechanics); coordination layer, not an operator-flippable guard.' },
  { component: 'HomeostasisMonitor', reason: 'Work-velocity awareness suggesting pause prompts during long sessions; advisory session-quality feature, takes no protective action.' },
  { component: 'InputGuard', reason: 'Inbound provenance/injection screening that warns-never-blocks before messages reach sessions; messaging-ingress mechanics with no operator enabled switch.' },
  { component: 'IntentDriftDetector', reason: 'Pure deterministic analyzer over decision-journal windows (alignment scoring); computation library with no boot lifecycle or switch.' },
  { component: 'JargonDetector', reason: 'Signal-only jargon classifier feeding MessagingToneGate (the authority); pure function, never blocks, no posture.' },
  { component: 'LedgerParaphraseDetector', reason: 'Signal-only paraphrase cross-check against SharedStateLedger feeding MessagingToneGate; observability data, never blocks.' },
  { component: 'LifelineHealthWatchdog', reason: 'Lifeline-internal stuck-loop signal source for the RestartOrchestrator (the authority); always-on self-health mechanics in the lifeline process, no operator switch.' },
  { component: 'OrphanProcessReaper', reason: 'Always-on untracked-CLI-process hygiene started unconditionally at boot with no config enabled switch; on/off posture is not expressible (CompactionSentinel class).' },
  { component: 'OverlapGuard', reason: 'Work-overlap detection wrapper around WorkLedger for the intelligent-sync feature; sync mechanics, not a boot-constructed posture guard.' },
  { component: 'PeerVisibilityGuard', reason: 'Pure hygiene-signal helpers over the machine registry (improper-revocation detection); stateless functions, no lifecycle or switch.' },
  { component: 'PrincipalGuard', reason: 'Pure-logic cross-principal crediting detector consumed by the principal-coherence pipeline; library code, the observe-only wiring rides monitoring.principalCoherence.' },
  { component: 'ProactiveSwapMonitor', reason: 'Pre-limit subscription-account swap engine (subscriptionPool.proactiveSwap); quota-continuity feature lever, not a failure-protecting guard.' },
  { component: 'PromptGuard', reason: 'Prompt-injection defense helpers (filtering/output validation) for LLM conflict resolution; pure library, no boot lifecycle.' },
  { component: 'QuotaExhaustionDetector', reason: 'Post-mortem classifier of why a dead session died (pattern-matching over tmux output); pure library, no lifecycle or switch.' },
  { component: 'ReapGuard', reason: 'Stateless KEEP-check helper consulted by the single ReapAuthority before any terminate; precondition logic inside the reap path, not a posture guard itself.' },
  { component: 'RevertDetector', reason: 'Read-only git revert scan feeding the FailureLedger; failure-learning ingestion plumbing, fail-open, no operator switch.' },
  { component: 'SelfViolationDetector', reason: 'Observe-only detector arm of the correctionLearning.selfViolationSignal sub-guard, which IS declared in the manifest under component CorrectionLearningLoop.' },
  { component: 'SessionActivitySentinel', reason: 'Mid-session activity digests + completion synthesis; session observability/digest feature, takes no protective action.' },
  { component: 'SessionServerGuard', reason: 'Pure decision helper validating session-server actions; stateless validation logic, no boot lifecycle or enabled switch.' },
  { component: 'SessionSummarySentinel', reason: 'Real-time session summaries for intelligent message routing (session: "best"); routing-quality plumbing, not a protective guard.' },
  { component: 'StaleProcessGuard', reason: 'Stale-state detection helpers (version/config drift checks); meta-infrastructure library, no boot-constructed lifecycle.' },
  { component: 'StaleSessionBackstop', reason: 'Implementation file of the manifest guard monitoring.staleBackstop.enabled — declared there under component name StaleBackstop; this entry classifies the file-basename alias only.' },
  { component: 'StallDetector', reason: 'Platform-agnostic stall/promise-tracking helper embedded in messaging adapters; adapter plumbing with no own lifecycle.' },
  { component: 'StuckInputSentinel', reason: 'Always-on restart-safe recovery sweep for messages wedged at the tmux prompt; injection-delivery mechanics inseparable from session messaging, no enabled switch.' },
  { component: 'UltraSessionCapMonitor', reason: 'Mid-run ultra-token-cap watcher inside model-tier escalation; rides models.tierEscalation (declared in the manifest as ModelTierEscalation), no own switch.' },
  { component: 'WorktreeReaper', reason: 'Dormant parallel-dev-isolation orphan-worktree reaper — exported but constructed nowhere (no importer); nothing runs, so there is no posture until it is wired.' },
  { component: 'claudeForbiddenGuard', reason: 'Hard invariant enforcing Codex-only agents never invoke Claude; always-on by design with no off switch, posture meaningless (SourceTreeGuard class).' },
  { component: 'registryReplayGuard', reason: 'Pure validation of pulled registry entries (replay/epoch/unknown-key checks); stateless function, not a runtime guard.' },
] as const;

/** Lookup helpers (used by the lint's unit test and the registry reconciliation). */
export function manifestByKey(): Map<string, GuardManifestEntry> {
  const map = new Map<string, GuardManifestEntry>();
  for (const entry of GUARD_MANIFEST) map.set(entry.key, entry);
  return map;
}

export function manifestComponents(): Set<string> {
  const set = new Set<string>();
  for (const entry of GUARD_MANIFEST) if (entry.component) set.add(entry.component);
  return set;
}

export function notAGuardComponents(): Set<string> {
  return new Set(NOT_A_GUARD.map(e => e.component));
}
