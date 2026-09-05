/**
 * Stage-B certified-set manifest (spec: stage-b-evidence-code-binding).
 * Maintained ONLY by scripts/stage-b-certified-fingerprint.mjs --write, which
 * refuses to rebind old evidence onto changed code. Every closure member is
 * either certified (fingerprinted) or excluded with a written reason; the
 * --check partition is fail-closed for anything new.
 */
export const STAGE_B_CERTIFIED_SET = {
  "roots": [
    "src/core/InboundDeliveryStore.ts",
    "src/core/CodexDeliveryObserver.ts",
    "src/core/CodexComposerAdapter.ts",
    "src/core/CodexLifecycleProductionComposition.ts",
    "src/core/StageBStartupReadiness.ts"
  ],
  "certified": [
    "src/core/CodexComposerAdapter.ts",
    "src/core/CodexDeliveryObserver.ts",
    "src/core/CodexLifecycleProductionComposition.ts",
    "src/core/InboundDeliveryStore.ts",
    "src/core/SessionRecoveryChannel.ts",
    "src/core/SessionRecoveryConsumer.ts",
    "src/core/StageBStartupReadiness.ts"
  ],
  "excluded": [
    {
      "file": "src/core/AccountFollowMeGrants.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/AccountFollowMeSpendSlice.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/AnthropicSubscriptionRouter.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/CircuitBreakingIntelligenceProvider.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/ClaudeCliIntelligenceProvider.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/CodexCliIntelligenceProvider.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/Config.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/CredentialAuditEmit.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/CredentialWriteFunnel.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/GateSignalDetectors.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/GeminiCliIntelligenceProvider.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/InFlightSyncOpMarker.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/InstrumentAssessment.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/InteractivePoolIntelligenceProvider.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/JargonDetector.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/JudgmentProvenanceLog.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/LlmCircuitBreaker.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/MessagingToneGate.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/ModelTierEscalation.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/OAuthRefresher.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/PhysicalEffectLock.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/PiCliIntelligenceProvider.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/ProjectRoundLock.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/SafeFsExecutor.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/SafeGitExecutor.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/SecretMigrator.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/SecretStore.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/SessionLivenessOracle.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/SourceTreeGuard.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/SpawnCapIntelligenceProvider.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/SqliteRegistry.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/StageBActivationGate.ts",
      "reason": "release policy, not canaried delivery behavior; binding it would force irrelevant two-hour canaries for gate-policy fixes (incl. the code-binding fix itself), and it adds no adversarial protection since the manifest is equally PR-editable"
    },
    {
      "file": "src/core/canonicalFeedback.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/claudeForbiddenGuard.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/decisionQualityTypes.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/deferral-floor.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/devAgentGate.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/durableSecretScrub.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/dynamicMcpConfig.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/frameworkFacts.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/hostSemaphoreCore.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/hostSpawnSemaphore.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/inboundQueueConfig.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/intelligenceProviderFactory.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/internal-id-leak.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/machineCoherenceAdvert.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/machineCoherenceManifest.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/machineServesChannel.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/models.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/seamlessnessConfig.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/core/self-stop-floor.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/core/types.ts",
      "reason": "universal shared type module; changes routinely for every subsystem"
    },
    {
      "file": "src/data/codexStageBReleaseEvidence.ts",
      "reason": "the evidence itself; bound by artifactDigest, fingerprinting it would be circular"
    },
    {
      "file": "src/data/provenanceCoverage.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/data/stageBCertifiedSet.ts",
      "reason": "this manifest; self-reference would be circular"
    },
    {
      "file": "src/monitoring/CredentialProvider.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/monitoring/DegradationReporter.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/monitoring/ErrorCodeExtractor.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/monitoring/Redactor.ts",
      "reason": "cross-cutting utility shared far beyond Codex delivery, certified by its own suite; binding it would re-freeze releases on unrelated churn"
    },
    {
      "file": "src/providers/adapters/gemini-cli/models.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/gemini-cli/observability/geminiCapacityPolicy.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/gemini-cli/transport/geminiSpawn.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/openai-codex/errors.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/openai-codex/models.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/openai-codex/observability/eventNormalizer.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/openai-codex/transport/codexSpawn.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/openai-codex/transport/codexUsageParser.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/pi-cli/config.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/pi-cli/errors.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/pi-cli/policy.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/pi-cli/transport/oneShotCompletion.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/adapters/pi-cli/transport/piSpawn.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/capabilities.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/costAwareRouting.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/errors.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/events.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/primitives/observability/usageMeterProvider.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/primitives/transport/oneShotCompletion.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/registry.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/routing.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    },
    {
      "file": "src/providers/types.ts",
      "reason": "LLM-provider plumbing reached through a dynamic import in a certified module; shared across every internal LLM feature and certified by its own suites — binding it would re-freeze releases on unrelated provider churn"
    }
  ],
  "fingerprint": "f1aacb47b41db1f9385f30b67cd53dfe1febac2ea1e555dbd61f5002ac55512f",
  "artifactDigest": "a2db23a95530681953ffa3002ab14e349ebf53d19be2a54c1f4afacc3aead997",
  "fileHashes": {
    "src/core/CodexComposerAdapter.ts": "8d4753c45f317092f3d1e8d6e5a73a875dbf046cbac20066220fa036b4f0e065",
    "src/core/CodexDeliveryObserver.ts": "0d70e29ef427af8ceda05a2434858639b48f120edc3490a439c90c26ab450fe3",
    "src/core/CodexLifecycleProductionComposition.ts": "a94897fbd317af61c5ea8d09da7484b2799b985ef44af2e2cc304f769fff62a4",
    "src/core/InboundDeliveryStore.ts": "9a20293ef6cf10938718e64cae357d51c14605b17631d13c0001cb4710c1c9b2",
    "src/core/SessionRecoveryChannel.ts": "d38b8ebc6d073008ae2d9f9109a254019813499d5d327a3ff00e4b2a72272b65",
    "src/core/SessionRecoveryConsumer.ts": "6a00ca4993d188f1c95eaa7d156795804f00f7e10e600ea12fa2e8cd40423268",
    "src/core/StageBStartupReadiness.ts": "92275608368d44abc98802f9a445acc6419fd57bddb8c2e4935f32961d401183"
  },
  "boundAt": "2026-09-05",
  "boundBy": "echo (fresh exact-candidate certification, topic 59199, 2026-09-04)",
  "note": "Fresh binding after the first candidate correctly failed closed on three busy-session false-unknown outcomes. Candidate cfe468dc5 then passed 50/50 deliveries over 7,213,141 ms, the full required case matrix, 30/30 responsiveness samples, and zero forbidden outcomes; its signed evidence digest is bound here."
} as const;

export type StageBCertifiedSet = typeof STAGE_B_CERTIFIED_SET;
