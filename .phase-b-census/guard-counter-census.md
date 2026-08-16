Total guards: 80. Class counts: full 4, partial 7, none 62, unknown 7. Most misleading partial counter surfaces: monitoring.completionClaimVerification.enabled (candidate/flagged counters but no didAct), writeAdmission (wouldRefuse/refused per-domain counters but no looked denominator), and monitoring.sessionReaper.enabled (reapsLastHour plus per-session verdicts, but no monotonic looked counter).

## Method Notes

- Tree provenance: commit 2197591 2026-08-05 02:19:20 +0000; package version 1.3.1126.
- Required CrashLoopPauser source-search control returned 4 before the census; counter-zero control found `wouldDeny` at `src/monitoring/selfaction/types.ts:232`.
- The advertised live server on port 4042 refused loopback HTTP from this lane even though `lsof` showed a Node listener. Denominator was reconstructed from the exact `/guards` source path: `buildGuardInventory()` uses `buildCompleteGuardPosture()` over the manifest/config union (`src/monitoring/guardPostureView.ts:381-384`).
- `none` means no source-confirmed looked/wouldAct/didAct counter fields were found for the guard surface after the positive control. `unknown` is used for config-derived `/guards` rows that are not in `GUARD_MANIFEST` and whose owning status surface could not be confirmed from source.

## Counts By Class

- full: 4
- partial: 7
- none: 62
- unknown: 7

## Partial Surfaces

- `intelligence.testRunnerCap` route `/test-runner-limiter`: looked `null`, wouldAct `skipHistogram`, didAct `null`. Evidence: src/core/hostTestRunnerSemaphore.ts:1902 recentEvents; src/core/hostTestRunnerSemaphore.ts:1903 skipHistogram; src/server/routes.ts:10995 exposes status()
- `monitoring.agentWorktreeReaper.enabled` route `/worktrees/agent-reaper`: looked `null`, wouldAct `reclaimable`, didAct `reapedLastPass`. Evidence: src/monitoring/AgentWorktreeReaper.ts:465 reapedLastPass; src/monitoring/AgentWorktreeReaper.ts:468 reclaimable; src/server/routes.ts:8406 exposes snapshot()
- `monitoring.completionClaimVerification.enabled` route `/completion-claim/stats`: looked `stats.candidateTurns`, wouldAct `stats.flaggedTurns`, didAct `null`. Evidence: src/monitoring/CompletionClaimVerifier.ts:63 candidateTurns; src/monitoring/CompletionClaimVerifier.ts:68 flaggedTurns; src/server/routes.ts:24627 exposes stats
- `monitoring.mcpProcessReaper.enabled` route `/processes/mcp-reaper`: looked `null`, wouldAct `reapEligible`, didAct `reapedLastPass`. Evidence: src/monitoring/McpProcessReaper.ts:305 reapedLastPass; src/monitoring/McpProcessReaper.ts:307 reapEligible; src/server/routes.ts:8494 exposes snapshot()
- `monitoring.orphanedWorkSentinel.enabled` route `/orphaned-work`: looked `null`, wouldAct `orphanedCount`, didAct `null`. Evidence: src/monitoring/OrphanedWorkSentinel.ts:310 orphanedCount; src/monitoring/OrphanedWorkSentinel.ts:300 snapshot takes no action; src/server/routes.ts:8480 exposes snapshot()
- `monitoring.sessionReaper.enabled` route `/sessions/reaper`: looked `null`, wouldAct `sessions[].verdict`, didAct `reapsLastHour`. Evidence: src/monitoring/SessionReaper.ts:1233 reapsLastHour; src/monitoring/SessionReaper.ts:1234 sessions[].verdict; src/server/routes.ts:8360 exposes snapshot()
- `writeAdmission` route `/write-admission`: looked `null`, wouldAct `domains[].wouldRefuse`, didAct `domains[].refused`. Evidence: src/core/WriteAdmission.ts:191 refused; src/core/WriteAdmission.ts:192 wouldRefuse; src/core/WriteAdmission.ts:612 exposes domains counters

## Full Surfaces

- `intelligence.selfActionGovernor.enabled` route `/self-action-governor`: looked `classes[].counters.admits`, wouldAct `classes[].counters.wouldDeny`, didAct `classes[].counters.denies`. Evidence: src/monitoring/selfaction/types.ts:229 admits; src/monitoring/selfaction/types.ts:232 wouldDeny; src/monitoring/selfaction/types.ts:233 denies; src/server/routes.ts:10929 exposes posture.classes
- `monitoring.machineCoherence.enabled` route `/pool/machine-coherence`: looked `counters.ticks`, wouldAct `counters.skewsConfirmed`, didAct `calm.calmRaises`. Evidence: src/monitoring/MachineCoherenceSentinel.ts:231 counters.ticks/counters.skewsConfirmed; src/monitoring/MachineCoherenceSentinel.ts:222 calm.calmRaises; src/server/routes.ts:18429 exposes sentinel.status()
- `monitoring.missingLoginSession.enabled` route `/pool/missing-login`: looked `counters.ticks`, wouldAct `counters.wouldRaise`, didAct `counters.raises`. Evidence: src/monitoring/MissingLoginSessionDetector.ts:144 counters.ticks/counters.wouldRaise/counters.raises; src/server/routes.ts:18457 exposes s.status()
- `monitoring.singleMachineFailoverGap.enabled` route `/pool/failover-gap`: looked `counters.ticks`, wouldAct `counters.wouldRaise`, didAct `counters.raises`. Evidence: src/monitoring/SingleMachineFailoverGapDetector.ts:132 counters.ticks/counters.wouldRaise/counters.raises; src/server/routes.ts:18444 exposes s.status()

## Unknown Rows

- `models.tierEscalation.dryRun`: src/monitoring/guardPosture.ts:148 tierEscalation dryRun extractor; zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.a2aRedelivery.enabled`: src/monitoring/guardPosture.ts:79 monitoring boolean extractor; src/monitoring/guardPosture.ts:82 monitoring .enabled extractor; zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.collaborationRedrive.enabled`: src/monitoring/guardPosture.ts:79 monitoring boolean extractor; src/monitoring/guardPosture.ts:82 monitoring .enabled extractor; zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.deliveryFailureSentinel.enabled`: src/monitoring/guardPosture.ts:79 monitoring boolean extractor; src/monitoring/guardPosture.ts:82 monitoring .enabled extractor; zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.orgIntentLlmJudge.enabled`: src/monitoring/guardPosture.ts:79 monitoring boolean extractor; src/monitoring/guardPosture.ts:82 monitoring .enabled extractor; zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.principalCoherence.enabled`: src/monitoring/guardPosture.ts:79 monitoring boolean extractor; src/monitoring/guardPosture.ts:82 monitoring .enabled extractor; zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.reportExternalProcesses`: src/monitoring/guardPosture.ts:79 monitoring boolean extractor; src/monitoring/guardPosture.ts:82 monitoring .enabled extractor; zero-search control passed at src/monitoring/selfaction/types.ts:232

## None Rows

- `apprenticeship.stallCoverageGate.enabled`: src/monitoring/guardManifest.ts:1092 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `lifeline.driftPromoter.enabled`: src/monitoring/guardManifest.ts:1032 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `messaging.attentionTopicGuard`: src/monitoring/guardManifest.ts:1073 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `messaging.topicCreationBudget`: src/monitoring/guardManifest.ts:1082 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `models.tierEscalation.enabled`: src/monitoring/guardManifest.ts:992 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.activeWorkSilenceSentinel.enabled`: src/monitoring/guardManifest.ts:393 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.agentSleep.enabled`: src/monitoring/guardManifest.ts:680 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.apprenticeshipCycleSla.enabled`: src/monitoring/guardManifest.ts:904 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.autonomousLivenessReconciler.enabled` route `/autonomous/liveness-reconciler`: src/server/routes.ts:6336-6342 exposes status(); no source-confirmed looked/would/did field found after control
- `monitoring.blockerLedger.enabled`: src/monitoring/guardManifest.ts:971 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.blockerLifecycleLedger.enabled`: src/monitoring/guardManifest.ts:701 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.bootHealthBeacon.enabled`: src/monitoring/guardManifest.ts:691 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.burnDetection.enabled`: src/monitoring/guardManifest.ts:803 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.contextWedgeSentinel.autoRecovery.enabled`: src/monitoring/guardManifest.ts:490 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.contextWedgeSentinel.enabled`: src/monitoring/guardManifest.ts:475 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.correctionClassReview.enabled`: src/monitoring/guardManifest.ts:866 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.correctionLearning.enabled`: src/monitoring/guardManifest.ts:856 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.correctionLearning.selfViolationSignal`: src/monitoring/guardManifest.ts:894 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.degradedTmuxGuard.enabled`: src/monitoring/guardManifest.ts:649 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.durableOutputScrub.enabled`: src/monitoring/guardManifest.ts:630 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.enforcedTermination.enabled`: src/monitoring/guardManifest.ts:711 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.externalHogSentinel.enabled` route `/external-hog`: src/monitoring/ExternalHogSentinel.ts:94-113 status shape lacks triad counters; src/server/routes.ts:8417 exposes status()
- `monitoring.failureLearning.enabled`: src/monitoring/guardManifest.ts:846 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.geminiCapacityEscalation.enabled`: src/monitoring/guardManifest.ts:914 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.greenPrAutoMerge.enabled`: src/monitoring/guardManifest.ts:358 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.growthAnalyst.blockedDigestEscalation.enabled`: src/monitoring/guardManifest.ts:961 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.growthAnalyst.enabled`: src/monitoring/guardManifest.ts:946 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.memoryMonitoring`: src/monitoring/guardManifest.ts:773 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.parallelWorkSentinel.enabled`: src/monitoring/guardManifest.ts:743 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.permissionPromptAutoResolver.enabled`: src/monitoring/guardManifest.ts:404 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.proactiveAutonomousCompaction.enabled`: src/monitoring/guardManifest.ts:731 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.processFootprintMonitor.enabled`: src/monitoring/guardManifest.ts:763 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.promptGate.enabled` route `/prompt-gate/status`: src/server/routes.ts:33159-33176 exposes enabled/dryRun only, not looked/would/did counters
- `monitoring.quotaTracking`: src/monitoring/guardManifest.ts:783 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.rateLimitSentinel.enabled` route `/rate-limit/status`: src/server/routes.ts:3929-3943 exposes enabled/active attempts, not looked/would/did counters
- `monitoring.reapNotify.enabled`: src/monitoring/guardManifest.ts:348 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.releaseReadiness.enabled`: src/monitoring/guardManifest.ts:924 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.resourceLedger.enabled`: src/monitoring/guardManifest.ts:753 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.resumeQueue.enabled`: src/monitoring/guardManifest.ts:331 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.ropeHealth.enabled`: src/monitoring/guardManifest.ts:197 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.sentinelTelegramEscalation`: src/monitoring/guardManifest.ts:815 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.socketDisconnectSentinel.enabled`: src/monitoring/guardManifest.ts:382 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.staleBackstop.enabled`: src/monitoring/guardManifest.ts:670 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.strandedTopicSentinel.enabled`: src/monitoring/guardManifest.ts:598 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.telemetry.enabled`: src/monitoring/guardManifest.ts:793 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.triage.enabled`: src/monitoring/guardManifest.ts:826 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.triageOrchestrator.enabled`: src/monitoring/guardManifest.ts:836 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `monitoring.watchdog.enabled` route `/watchdog/status`: src/monitoring/SessionWatchdog.ts:320-334 getStatus exposes sessions/interventionHistory, not looked/would/did counters; src/server/routes.ts:23082 exposes getStatus()
- `multiMachine.coherenceJournal.enabled`: src/monitoring/guardManifest.ts:1062 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled`: src/monitoring/guardManifest.ts:257 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.meshTransport.recoveryProbeEnabled`: src/monitoring/guardManifest.ts:173 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.peerExecution.enabled`: src/monitoring/guardManifest.ts:69 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.seamlessness.ws13PinReplicate`: src/monitoring/guardManifest.ts:153 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.seamlessness.ws13Reconcile`: src/core/OwnershipReconciler.ts:852-872 status exposes lastReport/machinesCount, not triad counters; no dedicated route found after control
- `multiMachine.secretSync.enabled`: src/monitoring/guardManifest.ts:1042 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.sessionPool.enabled`: src/monitoring/guardManifest.ts:1052 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.sessionPool.holdForStability.enabled`: src/monitoring/guardManifest.ts:217 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.sessionPool.inboundQueue.enabled`: src/monitoring/guardManifest.ts:86 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `multiMachine.sessionPool.staleOwnerRelease.enabled`: src/monitoring/guardManifest.ts:235 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `scheduler.enabled`: src/monitoring/guardManifest.ts:982 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `subscriptionPool.proactiveSwap.antiThrash.enabled`: src/monitoring/guardManifest.ts:283 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
- `subscriptionPool.swapContinuity.enabled`: src/monitoring/guardManifest.ts:306 (manifest key); zero-search control passed at src/monitoring/selfaction/types.ts:232
