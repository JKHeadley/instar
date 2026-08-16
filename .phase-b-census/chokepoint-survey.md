# Phase B Chokepoint Survey

Tree provenance/control:

- Commit: `2197591 2026-08-05 02:19:20 +0000`
- Package version: `1.3.1126`
- CrashLoopPauser control: `4` matching files under `src` (`> 0`, control passed)
- Search controls also found known scheduler/tick chokepoints: `JobScheduler` Cron at `src/scheduler/JobScheduler.ts:444`, WS13 interval at `src/commands/server.ts:20701`, peer presence interval at `src/commands/server.ts:23736`, outbound funnel at `src/server/routes.ts:2531`.

## Counts

| Invocation class | Count |
| --- | ---: |
| TICK-LOOP | 19 |
| FUNNEL | 9 |
| EVENT-DRIVEN | 16 |
| SELF-DRIVEN | 26 |
| UNKNOWN | 2 |
| **Total** | **72** |

## Load-bearing answer

**28 guards can have caller-owned `looked` today without new plumbing.**

That number is `TICK-LOOP + FUNNEL` (`19 + 9`). These are the only classes where the current source already has a caller outside the guard's own diligence surface that can count each invocation before the guard evaluates.

## Per-class answer

### TICK-LOOP: 19 guards, caller-owned looked exists today

These guards are invoked by a shared scheduler/interval or tick carrier. The caller can increment `looked` immediately before invoking the guard:

- `multiMachine.sessionPool.inboundQueue.enabled` via server inbound queue interval (`src/commands/server.ts:22888`)
- `multiMachine.seamlessness.ws13Reconcile` via WS13 interval (`src/commands/server.ts:20701`)
- `multiMachine.meshTransport.recoveryProbeEnabled` via lease-pull listener (`src/commands/server.ts:5740`)
- `multiMachine.sessionPool.holdForStability.enabled` via QueueDrainLoop hold verdict (`src/commands/server.ts:22800`)
- `multiMachine.sessionPool.staleOwnerRelease.enabled` via OwnershipReconciler tick (`src/commands/server.ts:20575`)
- `multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled` via lease-pull tick hook (`src/core/MultiMachineCoordinator.ts:1405`)
- `monitoring.permissionPromptAutoResolver.enabled` via SessionManager monitor loop (`src/core/SessionManager.ts:1795`)
- `monitoring.externalHogSentinel.enabled` via server interval (`src/commands/server.ts:19055`)
- `monitoring.machineCoherence.enabled`, `monitoring.singleMachineFailoverGap.enabled`, `monitoring.missingLoginSession.enabled` via peerPresenceTick (`src/commands/server.ts:23661`, `src/commands/server.ts:23730`, `src/commands/server.ts:23734`)
- `monitoring.proactiveAutonomousCompaction.enabled` via server interval (`src/commands/server.ts:12555`)
- `monitoring.parallelWorkSentinel.enabled` via AgentServer interval (`src/server/AgentServer.ts:1266`)
- `monitoring.failureLearning.enabled` via builtin scheduler job/analyzer route (`src/server/routes.ts:13364`)
- `monitoring.apprenticeshipCycleSla.enabled`, `monitoring.geminiCapacityEscalation.enabled` via TokenLedgerPoller afterTick (`src/server/AgentServer.ts:5168`, `src/server/AgentServer.ts:5170`)
- `monitoring.releaseReadiness.enabled` via scheduler route (`src/server/routes.ts:12813`)
- `monitoring.promptGate.enabled` via SessionManager capture path (`src/core/SessionManager.ts:2082`)
- `intelligence.testRunnerCap` via server refresh interval (`src/commands/server.ts:6971`)

### FUNNEL: 9 guards, caller-owned looked exists today

These guards have a shared admission/chokepoint function. The chokepoint caller can count `looked` before invoking the guard:

- `writeAdmission` via StateManager write funnel (`src/core/StateManager.ts:160`)
- `subscriptionPool.proactiveSwap.antiThrash.enabled` via ProactiveSwapMonitor swap decision path (`src/core/ProactiveSwapMonitor.ts:325`)
- `intelligence.selfActionGovernor.enabled` via SelfActionGovernor admission (`src/monitoring/selfaction/governor.ts:1673`)
- `monitoring.completionClaimVerification.enabled` via completion-claim observation route (`src/server/routes.ts:24594`)
- `monitoring.correctionLearning.selfViolationSignal` via outbound message funnel (`src/server/routes.ts:3174`)
- `models.tierEscalation.enabled` via model escalation admission/service wiring (`src/server/AgentServer.ts:3105`)
- `messaging.attentionTopicGuard` via Telegram attention-topic creation path (`src/messaging/TelegramAdapter.ts:3995`)
- `messaging.topicCreationBudget` via Telegram forum-topic creation path (`src/messaging/TelegramAdapter.ts:1489`)
- `apprenticeship.stallCoverageGate.enabled` via ApprenticeshipProgram transition gate (`src/core/ApprenticeshipProgram.ts:652`)

### EVENT-DRIVEN: 16 guards, needs new plumbing

These are scattered across events, hooks, routes, or multiple mutation paths without a single common caller outside the guard. They need either a new common admission/reporting wrapper or explicit `looked` counters at every event source:

- `multiMachine.seamlessness.ws13PinReplicate`
- `subscriptionPool.swapContinuity.enabled`
- `monitoring.reapNotify.enabled`
- `monitoring.durableOutputScrub.enabled`
- `monitoring.degradedTmuxGuard.enabled`
- `monitoring.bootHealthBeacon.enabled`
- `monitoring.blockerLifecycleLedger.enabled`
- `monitoring.rateLimitSentinel.enabled`
- `monitoring.resourceLedger.enabled`
- `monitoring.triage.enabled`
- `monitoring.correctionLearning.enabled`
- `monitoring.correctionClassReview.enabled`
- `monitoring.growthAnalyst.enabled`
- `monitoring.blockerLedger.enabled`
- `multiMachine.secretSync.enabled`
- `multiMachine.sessionPool.enabled`

### SELF-DRIVEN: 26 guards, needs timer ownership moved

These own their own interval/timer/service cadence. A `looked` counter inside the guard would still be self-reported, so these need an external scheduler/tick wrapper or a parent caller that owns the counter before calling the guard:

- `multiMachine.peerExecution.enabled`
- `monitoring.ropeHealth.enabled`
- `monitoring.sessionReaper.enabled`
- `monitoring.resumeQueue.enabled`
- `monitoring.greenPrAutoMerge.enabled`
- `monitoring.watchdog.enabled`
- `monitoring.socketDisconnectSentinel.enabled`
- `monitoring.activeWorkSilenceSentinel.enabled`
- `monitoring.contextWedgeSentinel.enabled`
- `monitoring.contextWedgeSentinel.autoRecovery.enabled`
- `monitoring.agentWorktreeReaper.enabled`
- `monitoring.orphanedWorkSentinel.enabled`
- `monitoring.strandedTopicSentinel.enabled`
- `monitoring.mcpProcessReaper.enabled`
- `monitoring.staleBackstop.enabled`
- `monitoring.agentSleep.enabled`
- `monitoring.enforcedTermination.enabled`
- `monitoring.processFootprintMonitor.enabled`
- `monitoring.memoryMonitoring`
- `monitoring.quotaTracking`
- `monitoring.telemetry.enabled`
- `monitoring.burnDetection.enabled`
- `monitoring.growthAnalyst.blockedDigestEscalation.enabled`
- `scheduler.enabled`
- `lifeline.driftPromoter.enabled`
- `multiMachine.coherenceJournal.enabled`

### UNKNOWN: 2 guards, needs invocation identification first

These should not be counted until the source-level invocation seam is identified:

- `monitoring.sentinelTelegramEscalation`: found as notifier/escalation config wiring, not a concrete guard tick/evaluate/admission caller (`src/commands/server.ts:12643`)
- `monitoring.triageOrchestrator.enabled`: manifest/server context exists, but I did not identify a concrete common invocation caller confidently (`src/monitoring/guardManifest.ts:836`)

## Output files

- Machine-readable rows: `.phase-b-census/chokepoint-survey.json`
- This summary: `.phase-b-census/chokepoint-survey.md`
