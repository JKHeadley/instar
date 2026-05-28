---
title: Under the Hood
description: How around 48 background systems keep your agent alive, responsive, and self-healing.
---

Your agent isn't just Claude in a terminal. Behind every session, **around 48 background systems** work continuously to keep things running — recovering from crashes, delivering messages reliably, syncing state across machines, and cleaning up after themselves.

**None of these were designed upfront.** Every system on this page exists because something actually broke in production. Sessions stalled silently, messages vanished, laptops slept and agents went brain-dead, logs filled disks, orphaned processes ate memory. Each problem showed up during real usage, got diagnosed, and got solved — then the solution became a permanent part of the platform. This isn't speculative architecture. It's roughly four dozen battle scars turned into armor — and the count grows over time as new failure modes show up and earn permanent solutions.

This page gives you the bird's-eye view. Scan the overview, then open any category to look inside the engine.

## The Nine Categories

| Category | What It Does | Processes |
|----------|-------------|-----------|
| [Session Management](#session-management) | Catches crashes, recovers sessions, keeps you from losing work | 4 |
| [Health Monitoring](#health-monitoring) | Watches the agent's own health and alerts when something degrades | 4 |
| [Core Infrastructure](#core-infrastructure) | Updates, config hot-reload, sleep recovery, process integrity | 7 |
| [Messaging](#messaging) | Reliable message delivery, intelligent routing, notification batching | 5 |
| [Agent Network](#agent-network) | Discovery and communication between agents (Threadline) | 6 |
| [Dashboard & Streaming](#dashboard--streaming) | Real-time terminal output and session monitoring in your browser | 3 |
| [Housekeeping](#housekeeping) | Cleans up zombie sessions, rotates logs, prunes old data | 8 |
| [Lifecycle](#lifecycle) | Sleep/wake recovery and graceful shutdown | 2 |
| [Platform Services](#platform-services) | Quota tracking, commitments, evolution, memory monitoring | 9 |

---

## Session Management

**The safety net.** Four systems work together in layers — each catches what the previous one misses.

<details>
<summary>See the 4-layer recovery stack</summary>

### SessionWatchdog
Polls every 30 seconds for stuck bash commands. If a command has been running longer than 3 minutes, it asks an LLM: "Is this legitimately long-running (like `npm install`) or actually stuck?" If stuck, it escalates through Ctrl+C → SIGTERM → SIGKILL, giving the session time to recover at each step. Sessions almost always survive — the nuclear option (killing the whole session) requires a process to survive both SIGTERM and SIGKILL twice.

### SessionRecovery
The fast mechanical layer. Analyzes the conversation JSONL file to detect three failure patterns:
- **Tool stalls** — Claude sent a tool call but never got a result back
- **Crashes** — Process died with an incomplete conversation
- **Error loops** — Same error repeated 3+ times

When detected, it truncates the conversation to a safe point and respawns. No LLM needed — pure file analysis. Handles ~60-70% of failures instantly.

### TriageOrchestrator
The intelligent layer. Has 8 battle-tested heuristic patterns that resolve ~90% of remaining cases without any LLM call:
- Session dead → auto-restart
- Message lost (prompt visible but message pending) → re-inject
- JSONL actively being written → wait and check back in 5 minutes
- Fatal errors (out of memory, segfault) → auto-restart
- Context exhausted (≤3% remaining) → auto-restart

Only when no heuristic matches does it spawn a scoped Claude session to diagnose the problem. Even then, deterministic safety predicates gate every auto-action — the LLM can suggest, but only verified conditions trigger automatic recovery.

### SessionMonitor
The proactive eye. Polls every 60 seconds to classify each session as healthy, idle, unresponsive, or dead. Feeds problems into the recovery stack before users notice. Won't spam you — one notification per issue, with a 30-minute cooldown per topic.

**How they connect:** SessionMonitor detects the problem → SessionRecovery tries a fast fix → if that doesn't work, TriageOrchestrator runs heuristics → if those don't match, it spawns an LLM diagnosis. Meanwhile, SessionWatchdog independently catches stuck commands at the process level.

</details>

---

## Health Monitoring

**The self-awareness layer.** The agent continuously checks its own health and tells you when something breaks.

<details>
<summary>See the 4 monitoring systems</summary>

### CoherenceMonitor
Every 5 minutes, runs checks across 5 categories: process integrity (is the binary stale?), config coherence (does the file match what's in memory?), state durability (are state files intact?), output sanity (is the agent producing reasonable responses?), and feature readiness (are tokens and credentials properly set?).

### SystemReviewer
Every 6 hours, runs deep functional probes — not just "is this component alive?" but "does it actually work?" Tests session spawning, scheduler health, messaging connectivity, and platform resources. Trends results over a 10-review window to detect persistent failures vs transient blips.

### StallDetector
Monitors message delivery. When a message is injected into a session and gets no response within 5 minutes, it verifies whether the session is truly stalled (not just busy), then triggers the recovery pipeline. Also tracks "promise detection" — when the agent says "working on it" but never follows up.

### DegradationReporter
Event-driven — fires whenever a system falls back from its primary path to a secondary one. For example, if SQLite-backed memory fails and falls back to JSONL, the reporter logs it, files a bug report, and sends you a human-readable Telegram notification. Ensures no fallback happens silently.

</details>

---

## Core Infrastructure

**The invisible plumbing.** You never think about these until they save you.

<details>
<summary>See the 7 infrastructure systems</summary>

### AutoUpdater
Checks for new versions every 30 minutes. When an update is found, it coalesces rapid-fire releases (waits 5 minutes for additional updates before acting), checks if there are active sessions (defers restart if so, forces after 30 minutes), and handles the restart cleanly. Can be disabled in config.

### GitSyncManager
Automatic git-based state synchronization for multi-machine setups. Debounces commits (30 seconds), runs a full sync cycle every 30 minutes, and has multi-stage conflict resolution: programmatic merging for simple cases, LLM-powered resolution for complex ones, human escalation as a last resort.

### LiveConfig
Watches `config.json` every 5 seconds for changes. When a value changes, it emits events so other systems can hot-reload without a server restart.

### SleepWakeDetector
Ticks every 2 seconds. If the gap between ticks exceeds 10 seconds, your machine slept. On wake, it fires an event that triggers: tunnel reconnection, Telegram re-polling, session health re-checks, and heartbeat resumption. Without this, opening your laptop would leave the agent looking online but actually broken.

### CaffeinateManager
macOS only. Runs `caffeinate -s` to prevent your Mac from sleeping while the agent is running. Monitors the process every 30 seconds and restarts it if it dies.

### ProcessIntegrity
Freezes the running version at startup and compares it to what's on disk. Detects when `npm install -g` updated the binary but the running process still has old code in memory.

### ForegroundRestartWatcher
When running without a supervisor, watches for restart signals (written by AutoUpdater after an update). Notifies you, waits 3 seconds for graceful shutdown, then exits so the process manager can restart with the new code.

</details>

---

## Messaging

**Reliable delivery with intelligent routing.** Messages don't get lost, and they go to the right session.

<details>
<summary>See the 5 messaging systems</summary>

### SessionSummarySentinel
Every 60 seconds, captures terminal output from each active session and generates a structured summary via Haiku. Uses hash-based change detection to skip sessions with no new output. These summaries enable intelligent message routing — when you send a message marked "send to best session," the system scores each session's relevance and picks the right one.

### SessionActivitySentinel
Every 30 minutes, creates condensed digests of what each session accomplished. Splits activity into meaningful chunks, summarizes each via LLM, and stores them in episodic memory. When a session completes, generates a full synthesis. This is how the agent builds long-term memory of what it's done.

### NotificationBatcher
Three tiers of notification urgency:
- **Immediate** — quota exhaustion, critical stalls (sent instantly)
- **Summary** — job completions, session lifecycle (batched every 30 minutes)
- **Digest** — routine system notices (batched every 2 hours)

Uses state-change-only deduplication: repeated identical notifications are suppressed until the content actually changes. Supports quiet hours (demotes Summary → Digest during configured times).

### DeliveryRetryManager
Three layers of retry for inter-agent messages:
- **Layer 1** — Server unreachable (exponential backoff, up to 4 hours)
- **Layer 2** — Session unavailable (30-second intervals, up to 5 minutes)
- **Layer 3** — ACK timeout (escalates unacknowledged messages)

Plus a post-injection watchdog: 10 seconds after delivering a message, checks if the session is still alive. If it crashed during injection, the message goes back to the retry queue.

### MessageStore
File-based message persistence. Atomic writes (temp file + rename for crash safety), deduplication, dead-letter archiving for failed messages (30-day retention), and JSONL indexes for fast queries.

</details>

---

## Agent Network

**Inter-agent communication.** Optional — only activates when Threadline is enabled.

<details>
<summary>See the agent network systems</summary>

### AgentDiscovery
5-second heartbeat. Announces this agent's presence in the shared registry, discovers other agents on the same machine.

### HandshakeManager
Ed25519 identity key management for end-to-end encrypted communication between agents.

### TrustManager
Maintains trust levels for known agents: untrusted → verified → trusted → autonomous. Determines what actions other agents can take.

### ThreadlineRouter
Routes messages between agents via the Threadline protocol. Handles trust verification, payload validation, and delivery.

### InboundMessageGate
Validates incoming relay messages against trust levels. Blocks oversized payloads (>64KB).

### Relay Client
WebSocket connection to the cloud relay for cross-machine agent communication.

</details>

---

## Dashboard & Streaming

**Real-time visibility** into what your agent is doing.

<details>
<summary>See the 3 dashboard systems</summary>

### WebSocketManager
Manages dashboard connections. Handles authentication, client subscriptions, and message routing between the browser and the server.

### Terminal Stream
Captures terminal output from subscribed sessions every 500ms, computes diffs, and sends only changed content to connected dashboard clients. Efficient — no captures happen when nobody is watching.

### Session List Broadcast
Sends the running session list to all connected clients every 5 seconds. Includes session metadata, display names, and telemetry (tool usage, subagent activity).

</details>

---

## Housekeeping

**Keeps things clean.** Without these, logs grow forever and zombie processes accumulate.

<details>
<summary>See the 8 housekeeping systems</summary>

### OrphanProcessReaper
Every 60 seconds, detects orphaned Claude processes that aren't tracked by the session manager. Classifies them (managed vs orphaned vs external IDE processes), auto-kills orphans after 1 hour, and reports external processes to you.

### JSONL Rotation
Lazy, size-based rotation built into all append-only log files. When a file exceeds 10MB, it keeps the newest 75% and atomically replaces the file. Non-fatal — rotation failure doesn't block writes.

### Session File Cleanup
Removes session state files for completed sessions (after 24 hours) and killed sessions (after 1 hour).

### Triage Evidence Cleanup
Every 6 hours, removes stale triage evidence files and cleans up abandoned triage sessions.

### Recovery Backup Cleanup
Every 6 hours, removes `.bak` files created during conversation JSONL truncation that are older than 24 hours.

### Dead-Letter Cleanup
Every 6 hours, removes failed messages from the dead-letter queue that are older than 30 days.

### Temp File Cleanup
On server startup, removes temporary Telegram files older than 7 days.

### Global Install Cleanup
On server startup, removes stale global instar installations.

</details>

---

## Lifecycle

**Handles the transitions** — starting up, shutting down, and everything in between.

<details>
<summary>See the 2 lifecycle systems</summary>

### SleepWakeDetector
Described in [Core Infrastructure](#core-infrastructure) — detects when your machine sleeps and triggers recovery on wake.

### Graceful Shutdown
Signal handlers (SIGTERM/SIGINT) that ensure clean shutdown: stops all polling, persists state, disconnects messaging, closes WebSocket connections, kills the caffeinate process, and unregisters from the agent registry.

</details>

---

## Platform Services

**The higher-level systems** that give the agent capabilities beyond just running code.

<details>
<summary>See the 9 platform services</summary>

### QuotaTracker
Monitors Claude API token usage in real-time. Sends Telegram warnings when approaching limits, enforces quotas to prevent runaway sessions, and can auto-switch between accounts if configured.

### CommitmentTracker
When you tell your agent to change a setting ("always use Haiku for jobs"), this system watches for config changes that revert your instruction and alerts you if it happens.

### EvolutionManager
The self-improvement loop. Detects gaps in the agent's capabilities, generates improvement proposals, and implements approved changes. Runs the full pipeline: gap detection → proposal → review → implementation.

### AgentRegistry Heartbeat
Every 30 seconds, writes a heartbeat to the global agent registry so other agents and tools can discover this agent.

### TopicResumeMap
Every 60 seconds, updates the mapping between Telegram topics and session UUIDs. When a session dies and respawns, this mapping ensures the new session can resume with full conversation context via `--resume`.

### CommitmentSentinel
Scans Telegram messages every 5 minutes to detect promises the agent made ("I'll deploy on Friday") that weren't formally registered.

### MemoryMonitor
Tracks heap memory usage. Triggers orphan cleanup when memory exceeds 80% of available capacity.

### WorktreeMonitor
Monitors git worktrees created for isolated agent work. Detects stale branches, reaps orphaned worktrees.

### HealthChecker
Legacy health probe system — superseded by SystemReviewer's more comprehensive tiered probe architecture.

</details>

---

## Subsystem class inventory

The sections above describe what each subsystem does at a behavioral level. The lists below enumerate every top-level class shipped under `src/<subsystem>/` so you can grep from a class name straight to its owning page. This is meant as a navigation aid — see the per-subsystem feature pages for actual descriptions.

### `src/core/` — agent fundamentals, gates, orchestration

`AccessControl`, `AdaptationValidator`, `AdaptiveTrust`, `AgentBus`, `AgentConnector`, `AgentRegistry`, `AgentWorktreeDetector`, `AuditTrail`, `AutoApprover`, `AutoDispatcher`, `AutoUpdater`, `AutonomousEvolution`, `AutonomyProfileManager`, `AutonomySkill`, `BackupManager`, `BitwardenProvider`, `BlockerLearningLoop`, `BranchManager`, `CaffeinateManager`, `CallbackRegistry`, `CanonicalState`, `CapabilityMapper`, `CapabilityRegistryGenerator`, `CircuitBreakingIntelligenceProvider`, `ClaudeCliIntelligenceProvider`, `CodexCliIntelligenceProvider`, `CoherenceGate`, `CoherenceReviewer`, `CommitmentSweeper`, `Config`, `ConflictNegotiator`, `ContextHierarchy`, `ContextSnapshotBuilder`, `ContextualEvaluator`, `ConvergenceChecker`, `CoordinationProtocol`, `CustomReviewerLoader`, `DecisionJournal`, `DeferredDispatchTracker`, `DiscoveryEvaluator`, `DispatchDecisionJournal`, `DispatchExecutor`, `DispatchManager`, `DispatchScopeEnforcer`, `DispatchVerifier`, `DriftSpendLedger`, `EvolutionManager`, `ExecutionJournal`, `ExternalOperationGate`, `FeatureDefinitions`, `FeatureRegistry`, `FeedbackManager`, `FileClassifier`, `ForegroundRestartWatcher`, `FrameworkSessionStore`, `GitStateManager`, `GitSync`, `GlobalInstallCleanup`, `GlobalSecretStore`, `HandoffManager`, `HeartbeatManager`, `IdentityRenderer`, `InitiativeTracker`, `InputGuard`, `InstarWorktreeManager`, `IntentDriftDetector`, `JargonDetector`, `JobReflector`, `LLMConflictResolver`, `LlmCircuitBreaker`, `LearnSkillBridge`, `LedgerAuth`, `LedgerParaphraseDetector`, `LedgerSessionRegistry`, `MachineHeartbeat`, `MachineIdentity`, `MessageSentinel`, `MessagingToneGate`, `MigrationProvenance`, `MigratorStepEngine`, `MultiMachineCoordinator`, `NonceStore`, `OrgIntentManager`, `OutboundDedupGate`, `OverlapGuard`, `PairingProtocol`, `ParallelDevWiring`, `PatternAnalyzer`, `PlanDocParser`, `PlatformActivityRegistry`, `PolicyEnforcementLayer`, `PortRegistry`, `PostUpdateMigrator`, `PreCompactionFlush`, `Prerequisites`, `ProcessIntegrity`, `ProjectAutoAdvancePoller`, `ProjectDigestCache`, `ProjectDriftChecker`, `ProjectDriftCheckerCache`, `ProjectMapper`, `ProjectRoundCompleteMessage`, `ProjectRoundExecution`, `ProjectRoundLock`, `ProjectRoundRunner`, `ProjectRoundWorktrees`, `PromptBuildRecall`, `PromptGuard`, `RecipientResolver`, `ReflectionConsolidator`, `RelationshipManager`, `RelevanceFilter`, `ResearchRateLimiter`, `ResumeValidator`, `SafeFsExecutor`, `SafeGitExecutor`, `SafeYaml`, `ScopeCoherenceTracker`, `ScopeVerifier`, `SecretManager`, `SecretMigrator`, `SecretRedactor`, `SecretStore`, `SecurityLog`, `SendGateway`, `SessionMaintenanceRunner`, `SessionManager`, `SessionRefresh`, `SharedStateLedger`, `SleepWakeDetector`, `SoulManager`, `SourceTreeGuard`, `StageTransitionValidator`, `StaleProcessGuard`, `StateManager`, `StateWriteAuthority`, `StopGateDb`, `StuckInputSentinel`, `SurfacingTemplates`, `SyncOrchestrator`, `TemporalCoherenceChecker`, `TopicClassifier`, `TopicFrameworksStore`, `TopicLocalModelStore`, `TopicResumeMap`, `TrustElevationTracker`, `TrustRecovery`, `UnjustifiedStopGate`, `UpdateChecker`, `UpdateGate`, `UpgradeGuideProcessor`, `UpgradeNotifyManager`, `WorkLedger`, `WorktreeKeyVault`, `WorktreeManager`.

### `src/monitoring/` — sentinels, watchdogs, observability

`AccountSwitcher`, `AttributionResolver`, `BurnAlertButtons`, `BurnDetectionSubscriber`, `BurnDetector`, `BurnThrottleRunbook`, `BurnVerifier`, `CoherenceMonitor`, `CommitmentSentinel`, `CommitmentTracker`, `CompactionSentinel`, `CrashLoopPauser`, `CredentialProvider`, `DegradationReporter`, `ErrorCodeExtractor`, `FeedbackAnomalyDetector`, `FrameworkParitySentinel`, `HealthChecker`, `HelperWatchdog`, `HomeostasisMonitor`, `HookEventReceiver`, `InputClassifier`, `InstructionsVerifier`, `LlmQueue`, `LlmRateGate`, `MemoryPressureMonitor`, `NativeHealDegradationBridge`, `OrphanProcessReaper`, `PresenceProxy`, `PromiseBeacon`, `PromptGate`, `ProxyCoordinator`, `QuotaCollector`, `QuotaExhaustionDetector`, `QuotaManager`, `QuotaNotifier`, `QuotaTracker`, `Redactor`, `ReflectionMetrics`, `SessionActivitySentinel`, `SessionCredentialManager`, `SessionMigrator`, `SessionMonitor`, `SessionRecovery`, `SessionWatchdog`, `StallTriageNurse`, `SubagentTracker`, `SystemReviewer`, `TelemetryAuth`, `TelemetryCollector`, `TelemetryHeartbeat`, `TokenLedger`, `TokenLedgerPoller`, `TriageOrchestrator`, `WorktreeMonitor`, `WorktreeReaper`.

### `src/threadline/` — agent-to-agent protocol stack

`A2AGateway`, `AgentCard`, `AgentDiscovery`, `AgentTrustManager`, `ApprovalQueue`, `AuthorizationPolicy`, `AutonomyGate`, `BackfillCore`, `CircuitBreaker`, `ComputeMeter`, `ContentClassifier`, `ContextThreadMap`, `DNSVerifier`, `DigestCollector`, `DiscoveryWaterfall`, `HandshakeManager`, `HeartbeatWatchdog`, `HeartbeatWriter`, `InboundMessageGate`, `InvitationManager`, `ListenerSessionManager`, `MCPAuth`, `MessageSecurity`, `OpenClawBridge`, `OpenClawSkillManifest`, `PipeSessionSpawner`, `RateLimiter`, `RelayGroundingPreamble`, `RelaySpawnFailureHandler`, `SalienceGate`, `SecureInvitation`, `SessionLifecycle`, `SpawnLedger`, `SpawnNonce`, `TelegramBridge`, `TelegramBridgeConfig`, `ThreadResumeMap`, `ThreadlineBootstrap`, `ThreadlineCrypto`, `ThreadlineEndpoints`, `ThreadlineMCPServer`, `ThreadlineNicknames`, `ThreadlineObservability`, `ThreadlineRouter`, `TopicLinkageHandler`, `TrustAuditLog`, `TrustBootstrap`, `TrustEvaluator`, `UnifiedTrustWiring`, `WakeSocketServer`.

### `src/memory/` — conversational + semantic memory

`ActivityPartitioner`, `Chunker`, `EmbeddingProvider`, `EpisodicMemory`, `EvidenceRenderer`, `MemoryExporter`, `MemoryIndex`, `MemoryMigrator`, `NativeModuleHealer`, `SemanticMemory`, `TopicMemory`, `TopicSummarizer`, `VectorSearch`, `WorkingMemoryAssembler`.

### `src/messaging/` — channel adapters and routing

`AdapterRegistry`, `AgentTokenManager`, `DeliveryRetryManager`, `DropPickup`, `GitSyncTransport`, `MessageDelivery`, `MessageFormatter`, `MessageRouter`, `MessageStore`, `NotificationBatcher`, `SessionSummarySentinel`, `SpawnRequestManager`, `TelegramAdapter`, `TelegramMarkdownFormatter`, `TopicContentValidator`, `WhatsAppAdapter`.

### `src/scheduler/` — cron + agentmd job execution

`AgentMdAtomicSave`, `AgentMdJobLoader`, `AgentMdLockFile`, `AgentMdReconcile`, `DisabledBodyDrift`, `InstallBuiltinJobs`, `IntegrationGate`, `JobClaimManager`, `JobLoader`, `JobRunHistory`, `JobScheduler`, `MigrationInvariants`, `MigrationLedger`, `SkipLedger`.

### `src/identity/` — machine + agent cryptographic identity

`IdentityManager`, `KeyEncryption`, `KeyRevocation`, `KeyRotation`, `Migration`, `RecoveryPhrase`.

### `src/lifeline/` — persistent supervisor

`LifelineHealthWatchdog`, `MessageQueue`, `RestartOrchestrator`, `ServerSupervisor`, `SlackLifeline`, `TelegramLifeline`.

### `src/knowledge/` — self-knowledge tree

`CoverageAuditor`, `IntegrityManager`, `KnowledgeManager`, `ProbeRegistry`, `SelfKnowledgeTree`, `TreeGenerator`, `TreeSynthesis`, `TreeTraversal`, `TreeTriage`.

### `src/users/` — multi-user identity + GDPR

`GdprCommands`, `OnboardingGate`, `UserContextBuilder`, `UserManager`, `UserOnboarding`, `UserPropagator`.

### `src/remediation/` — Self-Healing Remediator v2

`IntentJournal`, `MachineLock`, `NovelFailureReviewer`, `PrimaryAggregatorLease`, `Remediator`, `RemediatorBootstrap`, `RemediationContext`, `RemediationKeyVault`, `TrustElevationSource`.

### `src/tasks/` — durable task flow registry

`DivergenceChecker`, `LruCache`, `RateLimiter`, `TaskFlowDueWaker`, `TaskFlowMaintenanceSweeper`, `TaskFlowRegistry`, `ThreadlineFlowBridge`.

### `src/paste/` — paste content lifecycle

`PasteManager`, `TruncationDetector`.

### `src/privacy/` — sensitive-response routing

`OutputPrivacyRouter`.

### `src/moltbridge/` — agent profile + trust network

`MoltBridgeClient`, `ProfileCompiler`.

### `src/security/` — cryptographic primitives

`SecretRedactor`.

### `src/tunnel/` — Cloudflare tunnel management

`TunnelManager`.

### `src/providers/` — cross-framework intelligence routing

`AnthropicIntelligenceProvider`, `CostAwareRoutingPolicy`, `LocalModelAdapter`, `ProviderRegistry`, `StallTriageNurse` (provider-side fork), `TierResolver`.

## Inter-agent comms (agent-to-agent Telegram primitive)

- **`AgentTelegramComms`** (`src/messaging/AgentTelegramComms.ts`) — the agent-to-agent
  Telegram comms primitive's pure logic: marker parse/format, the recipient routing
  matrix (incl. user-spoof defense + per-source role acceptance), and cycle-detection.
- **`AgentTelegramLedger`** (`src/messaging/AgentTelegramLedger.ts`) — append-only JSONL
  audit trail of every a2a send and every receive decision (routed or dropped, with the
  reason code). Best-effort + non-throwing.
- **`ProcessedIdStore`** (`src/messaging/ProcessedIdStore.ts`) — bounded persistent set
  of recently-processed marker ids; idempotency against Telegram retry / adapter restart.

Spec: `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2a.
