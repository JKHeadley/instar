# Guard verifiability under ruling 1(a) — the 28 and the 44

**Ruling (management pass, window 7 cycle 1):** *"Apply the design to the twenty-eight adoptable
guards and report the forty-four as structurally unverifiable, each with its named reason."*

**Source:** `docs/audits/phase-b/chokepoint-survey.json` — per-guard invocation tracing with controls
passed, against v1.3.1126 (`2197591`).


## Summary

| class | count | caller-owned `looked` available? |
|---|---:|---|
| TICK-LOOP | 19 | **yes** — a shared scheduler/interval invokes it |
| FUNNEL | 9 | **yes** — a shared admission chokepoint |
| EVENT-DRIVEN | 16 | no |
| SELF-DRIVEN | 26 | no |
| UNKNOWN | 2 | undetermined |
| **in scope (a)** | **28** | |
| **unverifiable-by-construction** | **44** | |

## The 28 — in scope for the schema

| guard | invocation | the caller that can own `looked` |
|---|---|---|
| `apprenticeship.stallCoverageGate.enabled` | FUNNEL | ApprenticeshipProgram transition gate |
| `intelligence.selfActionGovernor.enabled` | FUNNEL | SelfActionGovernor.admit/admitSync admission funnel |
| `messaging.attentionTopicGuard` | FUNNEL | TelegramAdapter attention-topic creation path |
| `messaging.topicCreationBudget` | FUNNEL | TelegramAdapter createForumTopic path |
| `models.tierEscalation.enabled` | FUNNEL | model tier escalation admission/swap service |
| `monitoring.completionClaimVerification.enabled` | FUNNEL | completion-claim observation route |
| `monitoring.correctionLearning.selfViolationSignal` | FUNNEL | outbound message check funnel |
| `subscriptionPool.proactiveSwap.antiThrash.enabled` | FUNNEL | ProactiveSwapMonitor swap decision path |
| `writeAdmission` | FUNNEL | StateManager write-admission funnel |
| `intelligence.testRunnerCap` | TICK-LOOP | server test-runner guard refresh interval |
| `monitoring.apprenticeshipCycleSla.enabled` | TICK-LOOP | TokenLedgerPoller afterTick server hook |
| `monitoring.externalHogSentinel.enabled` | TICK-LOOP | server external-hog sentinel interval |
| `monitoring.failureLearning.enabled` | TICK-LOOP | off-by-default built-in scheduler job hitting analyzer route |
| `monitoring.geminiCapacityEscalation.enabled` | TICK-LOOP | TokenLedgerPoller afterTick server hook |
| `monitoring.machineCoherence.enabled` | TICK-LOOP | server peerPresenceTick interval |
| `monitoring.missingLoginSession.enabled` | TICK-LOOP | server peerPresenceTick interval |
| `monitoring.parallelWorkSentinel.enabled` | TICK-LOOP | AgentServer parallel-work interval |
| `monitoring.permissionPromptAutoResolver.enabled` | TICK-LOOP | SessionManager monitor loop |
| `monitoring.proactiveAutonomousCompaction.enabled` | TICK-LOOP | server proactive-compaction interval |
| `monitoring.promptGate.enabled` | TICK-LOOP | SessionManager capture/monitor path |
| `monitoring.releaseReadiness.enabled` | TICK-LOOP | release-readiness scheduler route |
| `monitoring.singleMachineFailoverGap.enabled` | TICK-LOOP | server peerPresenceTick interval |
| `multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled` | TICK-LOOP | MultiMachineCoordinator lease-pull tick hook |
| `multiMachine.meshTransport.recoveryProbeEnabled` | TICK-LOOP | MultiMachineCoordinator lease-pull tick listener |
| `multiMachine.seamlessness.ws13Reconcile` | TICK-LOOP | server WS13 reconciliation interval |
| `multiMachine.sessionPool.holdForStability.enabled` | TICK-LOOP | QueueDrainLoop holdVerdict inside inbound queue tick |
| `multiMachine.sessionPool.inboundQueue.enabled` | TICK-LOOP | server inbound queue drain interval |
| `multiMachine.sessionPool.staleOwnerRelease.enabled` | TICK-LOOP | OwnershipReconciler tick |

## The 44 — `unverifiable-by-construction`, each with its named reason

**This is not a bucket.** Every row states why *this* guard cannot carry a caller-owned count,
grounded in the source path that drives it. A reader can check any single row.

| guard | class | named reason | what drives it |
|---|---|---|---|
| `monitoring.blockerLedger.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | blocker ledger route/API calls |
| `monitoring.blockerLifecycleLedger.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | commitment/blocker lifecycle event hooks |
| `monitoring.bootHealthBeacon.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | server boot lifecycle |
| `monitoring.correctionClassReview.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | correction record/review capture paths |
| `monitoring.correctionLearning.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | correction capture hooks plus backlog/analyzer paths |
| `monitoring.degradedTmuxGuard.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | SessionManager tmux exec and sleep-wake stall feeds |
| `monitoring.durableOutputScrub.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | durable-output persistence chokepoints |
| `monitoring.growthAnalyst.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | digest build and route callers |
| `monitoring.rateLimitSentinel.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | watchdog, idle-error, and codex-poll report feeds |
| `monitoring.reapNotify.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | session reaped event plus ReapNoticeDrain |
| `monitoring.resourceLedger.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | breaker and rate-limit event subscriptions |
| `monitoring.triage.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | Telegram/Slack stall-detected handlers |
| `multiMachine.seamlessness.ws13PinReplicate` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | TopicPinMutation emit/read paths |
| `multiMachine.secretSync.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | mesh secret-share receive/deliver handlers |
| `multiMachine.sessionPool.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | session pool delivery/claim/queue paths |
| `subscriptionPool.swapContinuity.enabled` | EVENT-DRIVEN | invoked from scattered callsites with no common caller — no single place exists to count invocations | multiple session refresh/swap mutation paths |
| `lifeline.driftPromoter.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | lifeline drift promoter process/service |
| `monitoring.activeWorkSilenceSentinel.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | ActiveWorkSilenceSentinel.start() owns its own interval |
| `monitoring.agentSleep.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | SleepController.start() owns the sleep decision loop |
| `monitoring.agentWorktreeReaper.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | AgentWorktreeReaper.start() owns its own interval |
| `monitoring.burnDetection.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | BurnDetector.start() owns its own interval |
| `monitoring.contextWedgeSentinel.autoRecovery.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | ContextWedgeSentinel parent tick |
| `monitoring.contextWedgeSentinel.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | ContextWedgeSentinel.start() owns its own interval |
| `monitoring.enforcedTermination.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | EnforcedTerminationWatchdog.start() owns its own loop |
| `monitoring.greenPrAutoMerge.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | GreenPrAutoMerger.start() owns its own interval |
| `monitoring.growthAnalyst.blockedDigestEscalation.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | GrowthDigestPublisher.start() owns delivery cadence |
| `monitoring.mcpProcessReaper.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | McpProcessReaper.start() owns its own interval |
| `monitoring.memoryMonitoring` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | MemoryPressureMonitor.start() owns its own monitor loop |
| `monitoring.orphanedWorkSentinel.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | OrphanedWorkSentinel.start() owns its own interval |
| `monitoring.processFootprintMonitor.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | ProcessFootprintMonitor.start() owns its own interval |
| `monitoring.quotaTracking` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | QuotaManager/QuotaPoller service loop |
| `monitoring.resumeQueue.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | ResumeQueue/ResumeDrainer start lifecycle |
| `monitoring.ropeHealth.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | RopeHealthMonitor.start() owns its own interval |
| `monitoring.sessionReaper.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | SessionReaper.start() owns its own interval |
| `monitoring.socketDisconnectSentinel.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | SocketDisconnectSentinel.start() owns its own interval |
| `monitoring.staleBackstop.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | StaleBackstop service start lifecycle |
| `monitoring.strandedTopicSentinel.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | StrandedTopicSentinel.start() owns its own interval |
| `monitoring.telemetry.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | TelemetryHeartbeat.start() owns the heartbeat loop |
| `monitoring.watchdog.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | SessionWatchdog.start() owns its own polling interval |
| `multiMachine.coherenceJournal.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | CoherenceJournal flush/retry timers |
| `multiMachine.peerExecution.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | MutualSshRuntime.start() owns its own interval |
| `scheduler.enabled` | SELF-DRIVEN | owns its own timer — nothing external invokes it, so no caller can count an invocation it did not make | JobScheduler.start() owns Cron callbacks |
| `monitoring.sentinelTelegramEscalation` | UNKNOWN | invocation path could not be determined from source — reported as undetermined rather than guessed | not determined; appears as a notifier/escalation config flag |
| `monitoring.triageOrchestrator.enabled` | UNKNOWN | invocation path could not be determined from source — reported as undetermined rather than guessed | not determined from the traced source |

## What `unverifiable-by-construction` does and does not say

**Says:** no external party currently invokes this guard, so nothing outside it can count that it
looked. Any `looked` it reported would be self-reported, and self-reported diligence is the exact
conflict of interest the design exists to remove.

**Does NOT say:** the guard is broken, dark, or useless. Most are working. The claim is strictly about
**what can be verified**, not about what works.

> **Reporting 44 guards this way is more honest than the status quo, in which they read `on` and look
> fine.** A named limit that a reader can check beats a green light nobody can question — which is the
> argument the operator ruled on.

## The route out is ruling 1(b), not a workaround

Option (b) — moving guard families onto shared chokepoints — is **not rejected**; it is a named Phase B
branch requiring its own spec through full multi-model review, because it changes how Instar runs
guards. **Each row above is a candidate for that branch**, and the `class` column is its difficulty
estimate: SELF-DRIVEN needs an external tick owner, EVENT-DRIVEN needs a funnel that does not yet exist.

Nothing in (a) forecloses (b). A guard moved onto a chokepoint by (b) simply changes class and becomes
adoptable — the 28 is a floor, not a ceiling.
