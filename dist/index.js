/**
 * instar — Persistent autonomy infrastructure for AI agents.
 *
 * Public API for programmatic usage.
 */
// Core
export { SessionManager } from './core/SessionManager.js';
export { StateManager } from './core/StateManager.js';
export { RelationshipManager } from './core/RelationshipManager.js';
export { ClaudeCliIntelligenceProvider } from './core/ClaudeCliIntelligenceProvider.js';
export { AnthropicIntelligenceProvider } from './core/AnthropicIntelligenceProvider.js';
export { ANTHROPIC_MODELS, CLI_MODEL_FLAGS, resolveModelId, resolveCliFlag, getValidTiers, isValidTier } from './core/models.js';
export { FeedbackManager } from './core/FeedbackManager.js';
export { EvolutionManager } from './core/EvolutionManager.js';
export { DecisionJournal } from './core/DecisionJournal.js';
export { DispatchDecisionJournal } from './core/DispatchDecisionJournal.js';
export { ContextSnapshotBuilder } from './core/ContextSnapshotBuilder.js';
export { DispatchVerifier } from './core/DispatchVerifier.js';
export { RelevanceFilter } from './core/RelevanceFilter.js';
export { ContextualEvaluator } from './core/ContextualEvaluator.js';
export { DeferredDispatchTracker } from './core/DeferredDispatchTracker.js';
export { AdaptationValidator } from './core/AdaptationValidator.js';
export { ExecutionJournal } from './core/ExecutionJournal.js';
export { PatternAnalyzer } from './core/PatternAnalyzer.js';
export { ReflectionConsolidator } from './core/ReflectionConsolidator.js';
export { JobReflector } from './core/JobReflector.js';
export { IntentDriftDetector } from './core/IntentDriftDetector.js';
export { OrgIntentManager } from './core/OrgIntentManager.js';
export { DispatchManager } from './core/DispatchManager.js';
export { UpdateChecker } from './core/UpdateChecker.js';
export { UpgradeNotifyManager } from './core/UpgradeNotifyManager.js';
export { PostUpdateMigrator } from './core/PostUpdateMigrator.js';
export { loadConfig, detectTmuxPath, detectClaudePath, detectProjectDir, ensureStateDir, resolveAgentDir, standaloneAgentsDir } from './core/Config.js';
export { LiveConfig } from './config/LiveConfig.js';
export { BackupManager } from './core/BackupManager.js';
export { loadRegistry, saveRegistry, registerAgent, unregisterAgent, updateStatus, heartbeat as agentHeartbeat, startHeartbeat as startAgentHeartbeat, listAgents, getAgent, allocatePort, validateAgentName, listInstances, forceRemoveRegistryLock, } from './core/AgentRegistry.js';
export { MachineIdentityManager, generateSigningKeyPair, generateEncryptionKeyPair, generateMachineId, sign, verify, ensureGitignore, base64ToSigningPem, base64ToEncryptionPem } from './core/MachineIdentity.js';
export { SecurityLog } from './core/SecurityLog.js';
export { generatePairingCode, comparePairingCodes, deriveSAS, generateEphemeralKeyPair, deriveSessionKey, encrypt, decrypt, createPairingSession, isPairingSessionValid, validatePairingCode, } from './core/PairingProtocol.js';
export { NonceStore } from './core/NonceStore.js';
export { HeartbeatManager } from './core/HeartbeatManager.js';
export { MultiMachineCoordinator } from './core/MultiMachineCoordinator.js';
export { SecretStore, MasterKeyManager, encryptForSync, decryptFromSync } from './core/SecretStore.js';
export { migrateSecrets, mergeConfigWithSecrets } from './core/SecretMigrator.js';
export { GitSyncManager, mergeRelationship } from './core/GitSync.js';
export { LLMConflictResolver } from './core/LLMConflictResolver.js';
export { FileClassifier } from './core/FileClassifier.js';
export { WorkLedger } from './core/WorkLedger.js';
export { BranchManager } from './core/BranchManager.js';
export { OverlapGuard } from './core/OverlapGuard.js';
export { HandoffManager } from './core/HandoffManager.js';
export { GitStateManager } from './core/GitStateManager.js';
export { ProjectMapper } from './core/ProjectMapper.js';
export { CapabilityMapper } from './core/CapabilityMapper.js';
export { ScopeVerifier } from './core/ScopeVerifier.js';
export { CoherenceGate } from './core/CoherenceGate.js';
export { CapabilityRegistryGenerator } from './core/CapabilityRegistryGenerator.js';
export { BlockerLearningLoop } from './core/BlockerLearningLoop.js';
export { ResearchRateLimiter } from './core/ResearchRateLimiter.js';
export { ContextHierarchy } from './core/ContextHierarchy.js';
export { CanonicalState } from './core/CanonicalState.js';
export { PlatformActivityRegistry } from './core/PlatformActivityRegistry.js';
export { TemporalCoherenceChecker } from './core/TemporalCoherenceChecker.js';
export { ExternalOperationGate, computeRiskLevel, scopeFromCount, AUTONOMY_PROFILES } from './core/ExternalOperationGate.js';
export { MessageSentinel } from './core/MessageSentinel.js';
export { AdaptiveTrust } from './core/AdaptiveTrust.js';
export { AutonomyProfileManager } from './core/AutonomyProfileManager.js';
export { TrustElevationTracker } from './core/TrustElevationTracker.js';
export { AutonomousEvolution } from './core/AutonomousEvolution.js';
export { DispatchScopeEnforcer } from './core/DispatchScopeEnforcer.js';
export { TrustRecovery } from './core/TrustRecovery.js';
export { AutonomySkill } from './core/AutonomySkill.js';
export { SecretRedactor } from './core/SecretRedactor.js';
export { PromptGuard } from './core/PromptGuard.js';
export { LedgerAuth } from './core/LedgerAuth.js';
export { AccessControl } from './core/AccessControl.js';
export { AuditTrail } from './core/AuditTrail.js';
export { AgentBus } from './core/AgentBus.js';
export { CoordinationProtocol } from './core/CoordinationProtocol.js';
export { ConflictNegotiator } from './core/ConflictNegotiator.js';
export { SyncOrchestrator } from './core/SyncOrchestrator.js';
// Memory
export { MemoryIndex } from './memory/MemoryIndex.js';
export { SemanticMemory } from './memory/SemanticMemory.js';
export { MemoryExporter } from './memory/MemoryExporter.js';
export { EpisodicMemory } from './memory/EpisodicMemory.js';
export { ActivityPartitioner } from './memory/ActivityPartitioner.js';
export { chunkMarkdown, chunkJson, chunkJsonl, estimateTokens } from './memory/Chunker.js';
// Users
export { UserManager } from './users/UserManager.js';
export { generateVerificationCode, generateConnectCode, hashCode, generateRecoveryKey, hashRecoveryKey, buildConsentDisclosure, buildCondensedConsentDisclosure, createConsentRecord, createDataManifest, VerificationManager, JoinRequestManager, buildUserProfile, getDefaultAutonomyConfig, } from './users/UserOnboarding.js';
export { UserPropagator } from './users/UserPropagator.js';
// Scheduler
export { JobScheduler } from './scheduler/JobScheduler.js';
export { IntegrationGate } from './scheduler/IntegrationGate.js';
export { SkipLedger } from './scheduler/SkipLedger.js';
export { loadJobs, validateJob, validateCommonBlockers } from './scheduler/JobLoader.js';
export { JobClaimManager } from './scheduler/JobClaimManager.js';
// Server
export { AgentServer } from './server/AgentServer.js';
export { createRoutes, formatUptime } from './server/routes.js';
export { corsMiddleware, authMiddleware, rateLimiter, requestTimeout, errorHandler } from './server/middleware.js';
export { machineAuthMiddleware, signRequest, ChallengeStore } from './server/machineAuth.js';
export { createMachineRoutes } from './server/machineRoutes.js';
// Monitoring
export { HealthChecker } from './monitoring/HealthChecker.js';
export { QuotaTracker } from './monitoring/QuotaTracker.js';
export { classifySessionDeath } from './monitoring/QuotaExhaustionDetector.js';
export { AccountSwitcher } from './monitoring/AccountSwitcher.js';
export { QuotaNotifier } from './monitoring/QuotaNotifier.js';
export { KeychainCredentialProvider, ClaudeConfigCredentialProvider, createDefaultProvider, redactToken, redactEmail } from './monitoring/CredentialProvider.js';
export { SessionCredentialManager } from './monitoring/SessionCredentialManager.js';
export { QuotaCollector, RetryHelper, RequestBudget, ConcurrencyLimiter, AdaptivePoller, JsonlParser, classifyToken } from './monitoring/QuotaCollector.js';
export { SessionMigrator } from './monitoring/SessionMigrator.js';
export { QuotaManager } from './monitoring/QuotaManager.js';
export { StallTriageNurse } from './monitoring/StallTriageNurse.js';
export { TriageOrchestrator } from './monitoring/TriageOrchestrator.js';
export { FeedbackAnomalyDetector } from './monitoring/FeedbackAnomalyDetector.js';
export { SessionMonitor } from './monitoring/SessionMonitor.js';
export { CoherenceMonitor } from './monitoring/CoherenceMonitor.js';
export { CommitmentTracker } from './monitoring/CommitmentTracker.js';
export { CommitmentSentinel } from './monitoring/CommitmentSentinel.js';
export { SessionActivitySentinel } from './monitoring/SessionActivitySentinel.js';
export { HookEventReceiver } from './monitoring/HookEventReceiver.js';
export { WorktreeMonitor } from './monitoring/WorktreeMonitor.js';
export { SubagentTracker } from './monitoring/SubagentTracker.js';
export { InstructionsVerifier } from './monitoring/InstructionsVerifier.js';
export { TelemetryHeartbeat } from './monitoring/TelemetryHeartbeat.js';
export { HTTP_HOOK_TEMPLATES, buildHttpHookSettings } from './data/http-hook-templates.js';
export { SleepWakeDetector } from './core/SleepWakeDetector.js';
// Messaging — Telegram & Notifications
export { TelegramAdapter, TOPIC_STYLE, selectTopicEmoji } from './messaging/TelegramAdapter.js';
export { classifyContent, validateTopicContent, getTopicPurpose } from './messaging/TopicContentValidator.js';
export { NotificationBatcher } from './messaging/NotificationBatcher.js';
// Messaging — Inter-Agent Messaging (Phase 1)
// Note: MessageType and AgentMessage are aliased to avoid conflict with AgentBus exports.
// Use InterAgentMessageType/InterAgentMessage for the new messaging system,
// or import directly from 'instar/messaging/types' for unaliased access.
export { MessageStore } from './messaging/MessageStore.js';
export { MessageFormatter } from './messaging/MessageFormatter.js';
export { MessageDelivery } from './messaging/MessageDelivery.js';
export { MessageRouter, canonicalJSON } from './messaging/MessageRouter.js';
export { generateAgentToken, getAgentToken, verifyAgentToken, computeDropHmac, verifyDropHmac, deleteAgentToken, listAgentTokens, ensureTokenDir, } from './messaging/AgentTokenManager.js';
export { pickupDroppedMessages } from './messaging/DropPickup.js';
export { VALID_TRANSITIONS, ALLOWED_INJECTION_PROCESSES, DEFAULT_TTL, DEFAULT_RETENTION_DAYS, DEFAULT_RATE_LIMITS, THREAD_MAX_DEPTH, THREAD_STALE_MINUTES, MAX_BODY_SIZE, MAX_PAYLOAD_SIZE, MAX_SUBJECT_LENGTH, PAYLOAD_INLINE_THRESHOLD, CLOCK_SKEW_TOLERANCE, } from './messaging/types.js';
// Knowledge
export { KnowledgeManager } from './knowledge/KnowledgeManager.js';
// Self-Knowledge Tree
export { SelfKnowledgeTree } from './knowledge/SelfKnowledgeTree.js';
export { TreeGenerator } from './knowledge/TreeGenerator.js';
export { TreeTriage } from './knowledge/TreeTriage.js';
export { TreeTraversal } from './knowledge/TreeTraversal.js';
export { TreeSynthesis } from './knowledge/TreeSynthesis.js';
export { ProbeRegistry, ProbeExecutionError, ProbeTimeoutError } from './knowledge/ProbeRegistry.js';
export { CoverageAuditor } from './knowledge/CoverageAuditor.js';
// Publishing
export { TelegraphService, markdownToNodes, parseInline } from './publishing/TelegraphService.js';
export { PrivateViewer } from './publishing/PrivateViewer.js';
// Tunnel
export { TunnelManager } from './tunnel/TunnelManager.js';
export { toInbound, toPipeline, toInjection, toLogEntry, formatHistoryLine, buildInjectionTag } from './types/pipeline.js';
// Utils
export { maybeRotateJsonl } from './utils/jsonl-rotation.js';
//# sourceMappingURL=index.js.map