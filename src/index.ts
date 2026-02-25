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
export { FeedbackManager } from './core/FeedbackManager.js';
export { EvolutionManager } from './core/EvolutionManager.js';
export { DecisionJournal } from './core/DecisionJournal.js';
export type { DecisionJournalStats } from './core/DecisionJournal.js';
export { DispatchManager } from './core/DispatchManager.js';
export { UpdateChecker } from './core/UpdateChecker.js';
export type { RollbackResult, UpdateCheckerConfig } from './core/UpdateChecker.js';
export { PostUpdateMigrator } from './core/PostUpdateMigrator.js';
export type { MigrationResult, MigratorConfig } from './core/PostUpdateMigrator.js';
export { loadConfig, detectTmuxPath, detectClaudePath, detectProjectDir, ensureStateDir, resolveAgentDir, standaloneAgentsDir } from './core/Config.js';
export { BackupManager } from './core/BackupManager.js';
export {
  loadRegistry,
  saveRegistry,
  registerAgent,
  unregisterAgent,
  updateStatus,
  heartbeat as agentHeartbeat,
  startHeartbeat as startAgentHeartbeat,
  listAgents,
  getAgent,
  allocatePort,
  validateAgentName,
  listInstances,
} from './core/AgentRegistry.js';
export { MachineIdentityManager, generateSigningKeyPair, generateEncryptionKeyPair, generateMachineId, sign, verify, ensureGitignore, base64ToSigningPem, base64ToEncryptionPem } from './core/MachineIdentity.js';
export { SecurityLog } from './core/SecurityLog.js';
export type { SecurityEvent, SecurityEventType } from './core/SecurityLog.js';
export {
  generatePairingCode,
  comparePairingCodes,
  deriveSAS,
  generateEphemeralKeyPair,
  deriveSessionKey,
  encrypt,
  decrypt,
  createPairingSession,
  isPairingSessionValid,
  validatePairingCode,
} from './core/PairingProtocol.js';
export type { PairingSession, EphemeralKeyPair } from './core/PairingProtocol.js';
export { NonceStore } from './core/NonceStore.js';
export { HeartbeatManager } from './core/HeartbeatManager.js';
export type { Heartbeat, FailoverConfig, FailoverState, HeartbeatCheckResult } from './core/HeartbeatManager.js';
export { MultiMachineCoordinator } from './core/MultiMachineCoordinator.js';
export type { CoordinatorConfig, CoordinatorEvents } from './core/MultiMachineCoordinator.js';
export { SecretStore, MasterKeyManager, encryptForSync, decryptFromSync } from './core/SecretStore.js';
export type { SecretStoreConfig, Secrets, EncryptedSecretPayload } from './core/SecretStore.js';
export { migrateSecrets, mergeConfigWithSecrets } from './core/SecretMigrator.js';
export { GitSyncManager, mergeRelationship } from './core/GitSync.js';
export type { GitSyncConfig, SyncResult } from './core/GitSync.js';
export type { MigrationResult as SecretMigrationResult } from './core/SecretMigrator.js';
export { GitStateManager } from './core/GitStateManager.js';

// Memory
export { MemoryIndex } from './memory/MemoryIndex.js';
export { chunkMarkdown, chunkJson, chunkJsonl, estimateTokens } from './memory/Chunker.js';
export type { Chunk } from './memory/Chunker.js';

// Users
export { UserManager } from './users/UserManager.js';
export {
  generateVerificationCode,
  generateConnectCode,
  hashCode,
  generateRecoveryKey,
  hashRecoveryKey,
  buildConsentDisclosure,
  buildCondensedConsentDisclosure,
  createConsentRecord,
  createDataManifest,
  VerificationManager,
  JoinRequestManager,
  buildUserProfile,
  getDefaultAutonomyConfig,
} from './users/UserOnboarding.js';

// Scheduler
export { JobScheduler } from './scheduler/JobScheduler.js';
export { SkipLedger } from './scheduler/SkipLedger.js';
export { loadJobs, validateJob } from './scheduler/JobLoader.js';

// Server
export { AgentServer } from './server/AgentServer.js';
export { createRoutes, formatUptime } from './server/routes.js';
export type { RouteContext } from './server/routes.js';
export { corsMiddleware, authMiddleware, rateLimiter, requestTimeout, errorHandler } from './server/middleware.js';
export { machineAuthMiddleware, signRequest, ChallengeStore } from './server/machineAuth.js';
export type { MachineAuthContext, MachineAuthDeps, SignedHeaders, Challenge } from './server/machineAuth.js';
export { createMachineRoutes } from './server/machineRoutes.js';
export type { MachineRouteContext } from './server/machineRoutes.js';

// Monitoring
export { HealthChecker } from './monitoring/HealthChecker.js';
export { QuotaTracker } from './monitoring/QuotaTracker.js';
export type { RemoteQuotaResult } from './monitoring/QuotaTracker.js';
export { classifySessionDeath } from './monitoring/QuotaExhaustionDetector.js';
export { AccountSwitcher } from './monitoring/AccountSwitcher.js';
export { QuotaNotifier } from './monitoring/QuotaNotifier.js';
export { SleepWakeDetector } from './core/SleepWakeDetector.js';

// Messaging
export { TelegramAdapter } from './messaging/TelegramAdapter.js';
export type { TelegramConfig } from './messaging/TelegramAdapter.js';

// Publishing
export { TelegraphService, markdownToNodes, parseInline } from './publishing/TelegraphService.js';
export type { TelegraphConfig, TelegraphNode, TelegraphElement, TelegraphPage, PublishedPage } from './publishing/TelegraphService.js';
export { PrivateViewer } from './publishing/PrivateViewer.js';
export type { PrivateView, PrivateViewerConfig } from './publishing/PrivateViewer.js';

// Tunnel
export { TunnelManager } from './tunnel/TunnelManager.js';
export type { TunnelConfig, TunnelState } from './tunnel/TunnelManager.js';

// Types
export type {
  Session,
  SessionStatus,
  SessionManagerConfig,
  ModelTier,
  JobDefinition,
  JobPriority,
  JobExecution,
  JobState,
  JobSchedulerConfig,
  UserProfile,
  UserChannel,
  UserPreferences,
  Message,
  OutgoingMessage,
  MessagingAdapter,
  MessagingAdapterConfig,
  QuotaState,
  AccountQuota,
  SessionDeathCause,
  SessionDeathClassification,
  HealthStatus,
  ComponentHealth,
  ActivityEvent,
  InstarConfig,
  MonitoringConfig,
  RelationshipRecord,
  RelationshipManagerConfig,
  InteractionSummary,
  FeedbackItem,
  FeedbackConfig,
  UpdateInfo,
  UpdateResult,
  DispatchConfig,
  UpdateConfig,
  PublishingConfig,
  TunnelConfigType,
  SkipReason,
  SkipEvent,
  WorkloadSignal,
  AutoTuneState,
  IntelligenceProvider,
  IntelligenceOptions,
  EvolutionProposal,
  EvolutionType,
  EvolutionStatus,
  LearningEntry,
  LearningSource,
  CapabilityGap,
  GapCategory,
  ActionItem,
  EvolutionManagerConfig,
  DecisionJournalEntry,
  MachineIdentity,
  MachineRegistry,
  MachineRegistryEntry,
  MachineStatus,
  MachineRole,
  MachineCapability,
  MultiMachineConfig,
  AgentAutonomyLevel,
  UserRegistrationPolicy,
  AgentAutonomyCapabilities,
  AgentAutonomyConfig,
  RecoveryKeyConfig,
  ConsentRecord,
  DataCollectedManifest,
  VerificationCode,
  JoinRequest,
  AgentType,
  AgentStatus,
  AgentRegistryEntry,
  AgentRegistry,
  BackupSnapshot,
  BackupConfig,
  GitStateConfig,
  GitLogEntry,
  GitStatus,
  MemorySearchConfig,
  MemorySource,
  MemorySearchResult,
  MemoryIndexStats,
} from './core/types.js';
export type { Dispatch, DispatchCheckResult, DispatchEvaluation, EvaluationDecision, DispatchFeedback, DispatchStats } from './core/DispatchManager.js';
