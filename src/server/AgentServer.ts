/**
 * Agent Server — HTTP server wrapping Express.
 *
 * Provides health checks, session management, job triggering,
 * and event querying over a simple REST API.
 *
 * Also serves the dashboard UI at /dashboard and handles
 * WebSocket connections for real-time terminal streaming.
 */

import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual, createPrivateKey } from 'node:crypto';
import { ApprovalLedger } from '../core/ApprovalLedger.js';
import { resolveMeshBindHost } from '../core/MeshUrlAdvertiser.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { DynamicMcpService } from '../core/DynamicMcpService.js';
import { activeAutonomousJobs } from '../core/AutonomousSessions.js';
import { captureHeavyMcpPidsForSession, MCP_SERVER_NAME_TO_SIGNATURE } from '../core/mcpPidCapture.js';
import { makeMcpProcessReaperDeps } from '../monitoring/mcpProcessReaperDeps.js';
import { looksActivelyWorking } from '../monitoring/sentinelWiring.js';
import { resolveOwningSession } from '../monitoring/McpProcessReaper.js';
import { isHeavyMcpSignature } from '../monitoring/mcpIdleLiveOffload.js';
import { McpIdleOffloadSweep, type HeavyLiveMcpProc } from '../monitoring/McpIdleOffloadSweep.js';
import { TopicOperatorStore } from '../users/TopicOperatorStore.js';
import { ConversationRegistry } from '../core/ConversationRegistry.js';
import { createConversationBindAuth } from '../core/conversationBindToken.js';
import { MandateStore } from '../coordination/MandateStore.js';
import { AuthorizationRequestStore } from '../core/AuthorizationRequestStore.js';
import { UserManager } from '../users/UserManager.js';
import { MandateGate } from '../coordination/MandateGate.js';
import { MandateAudit } from '../coordination/MandateAudit.js';
import { ConditionsRegistry } from '../coordination/conditions.js';
import { ReviewExchangeEngine } from '../coordination/ReviewExchange.js';
import { DeliveredMandateStore } from '../coordination/DeliveredMandateStore.js';
import { packageMandateForDelivery, acceptDeliveredMandate } from '../coordination/AccountFollowMeMandateBridge.js';
import { readFollowMeBounds, acceptMandateDelivery } from '../coordination/AccountFollowMeMandateDelivery.js';
import { CutoverReadiness } from '../feedback-factory/cutoverReadiness.js';
import { InboxDrainer } from '../feedback-factory/inbox/InboxDrainer.js';
import { BlobInboxClient } from '../feedback-factory/inbox/BlobInboxClient.js';
import { JsonlFeedbackStore } from '../feedback-factory/store/JsonlFeedbackStore.js';
import { FeedbackProcessingService, resolveCanonicalStoreDir } from '../feedback-factory/processing/FeedbackProcessingService.js';
import { DurableParityMonitor, JsonlPassPersistence } from '../feedback-factory/monitor/parityMonitorStore.js';
import { HttpParitySource } from '../feedback-factory/dryrun/HttpParitySource.js';
import { runDryRunCompare } from '../feedback-factory/dryrun/dryRunCompare.js';
import { InMemoryImportTarget, runImport, type ImportRunResult } from '../feedback-factory/migration/importRunner.js';
import { SecretStore } from '../core/SecretStore.js';
import { secretKeyPaths } from '../core/SecretSync.js';
import { fileURLToPath } from 'node:url';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { MessageRouter } from '../messaging/MessageRouter.js';
import type { InstarConfig } from '../core/types.js';
import type { RelationshipManager } from '../core/RelationshipManager.js';
import type { FeedbackManager } from '../core/FeedbackManager.js';
import type { DispatchManager } from '../core/DispatchManager.js';
import type { UpdateChecker } from '../core/UpdateChecker.js';
import type { AutoUpdater } from '../core/AutoUpdater.js';
import type { AutoDispatcher } from '../core/AutoDispatcher.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';
import type { TelegraphService } from '../publishing/TelegraphService.js';
import type { PrivateViewer } from '../publishing/PrivateViewer.js';
import type { TunnelManager } from '../tunnel/TunnelManager.js';
import type { EvolutionManager } from '../core/EvolutionManager.js';
import type { SessionWatchdog } from '../monitoring/SessionWatchdog.js';
import type { StallTriageNurse } from '../monitoring/StallTriageNurse.js';
import type { MultiMachineCoordinator } from '../core/MultiMachineCoordinator.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import type { FeedbackAnomalyDetector } from '../monitoring/FeedbackAnomalyDetector.js';
import { createRoutes } from './routes.js';
import { getSelfActionGovernor } from '../monitoring/selfaction/governor.js';
import { createFileRoutes } from './fileRoutes.js';
import { mountWhatsAppWebhooks } from '../messaging/backends/WhatsAppWebhookRoutes.js';
import { createMachineRoutes } from './machineRoutes.js';
import { createWorktreeRoutes, createOidcWorktreeRoutes } from './worktreeRoutes.js';
import { registerRemediationProposalsRoutes } from './routes/remediation-proposals.js';
import { TrustElevationSource } from '../remediation/TrustElevationSource.js';
import { createTopicIntentRoutes } from './topicIntentRoutes.js';
import { FailureLedger } from '../monitoring/FailureLedger.js';
import { FailureAttributionEngine } from '../monitoring/FailureAttributionEngine.js';
import { CiFailurePoller } from '../monitoring/CiFailurePoller.js';
import { RevertDetector } from '../monitoring/RevertDetector.js';
import { CorrectionLedger } from '../monitoring/CorrectionLedger.js';
import { BlockerLedger } from '../monitoring/BlockerLedger.js';
import { buildB17SettleAuthority } from '../monitoring/blockerSettleAuthority.js';
import { SelfUnblockRunStore, SelfUnblockChecklist } from '../monitoring/SelfUnblockChecklist.js';
import { DurableVaultSession } from '../monitoring/DurableVaultSession.js';
import { buildProductionProbeProviders, deriveBitwardenSession } from '../monitoring/SelfUnblockProbeProviders.js';
import { BitwardenProvider } from '../core/BitwardenProvider.js';
import { GrowthMilestoneAnalyst, resolveGrowthSettings } from '../monitoring/GrowthMilestoneAnalyst.js';
import { DashboardInsightEngine } from '../monitoring/DashboardInsightEngine.js';
import { buildBuiltinInsightPages } from '../monitoring/dashboardInsightCollectors.js';
import { GrowthDigestPublisher, createGrowthDigestAuditSink } from '../monitoring/GrowthDigestPublisher.js';
import { ApprenticeshipProgram } from '../core/ApprenticeshipProgram.js';
import { ApprenticeshipCycleStore } from '../monitoring/ApprenticeshipCycleStore.js';
import { readApprenticeshipPeerCycles } from '../monitoring/ApprenticeshipPeerCycleReader.js';
import { ApprenticeshipCycleSlaMonitor } from '../monitoring/ApprenticeshipCycleSlaMonitor.js';
import { listAgents } from '../core/AgentRegistry.js';
import { getAgentToken } from '../messaging/AgentTokenManager.js';
import { GeminiCapacityEscalationMonitor } from '../monitoring/GeminiCapacityEscalationMonitor.js';
import { SafeGitExecutor, auditBootCredentialCoherence } from '../core/SafeGitExecutor.js';
import { createSpecReviewRoutes } from './specReviewRoutes.js';
import { createUsherRoutes } from './usherRoutes.js';
import { createHandoffInitiateRoutes } from './handoffInitiateRoutes.js';
import type { TopicIntentStore } from '../core/TopicIntent.js';
import type { WorktreeManager } from '../core/WorktreeManager.js';
import { corsMiddleware, authMiddleware, requestTimeout, buildRequestTimeoutOverrides, errorHandler, dashboardSecurityHeaders, dashboardCacheControl, DASHBOARD_STATIC_OPTIONS, duplicateResponseGuard } from './middleware.js';
import { WebSocketManager } from './WebSocketManager.js';
import { assertSqliteAvailable, PendingRelayStore } from '../messaging/pending-relay-store.js';
import { getOrCreateBootId } from './boot-id.js';
import { DeliveryFailureSentinel } from '../monitoring/delivery-failure-sentinel.js';
import os from 'node:os';
import { TokenLedger } from '../monitoring/TokenLedger.js';
import { BurnAlertDelivery } from '../monitoring/BurnAlertDelivery.js';
import { FeatureMetricsLedger } from '../monitoring/FeatureMetricsLedger.js';
import { BenchmarkDivergenceAnalyzer } from '../monitoring/BenchmarkDivergenceAnalyzer.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { RoutingPriceAuthority } from '../core/routingPriceAuthority.js';
import { MeteredSpendLedger } from '../core/MeteredSpendLedger.js';
import { RoutingSpendCapsStore } from '../core/RoutingSpendCapsStore.js';
import { MeteredSpendGate } from '../core/MeteredSpendGate.js';
import { RenderedPlanStore } from '../core/RenderedPlanStore.js';
import { PinAttemptStore } from '../core/PinAttemptStore.js';
import { SpendAlertResolver, buildStalePriceAlert } from '../core/SpendAlertResolver.js';
import { SpendAlertDispatcher } from '../core/SpendAlertDispatcher.js';
import { TelegramSpendTopicChannel, spendAlertDeliveryId } from '../core/TelegramSpendTopicChannel.js';
import { SpendAlertEmitters } from '../core/SpendAlertEmitters.js';
import { MachineIdentityManager } from '../core/MachineIdentity.js';
import { PendingRelayStore as SpendAlertRelayStore } from '../messaging/pending-relay-store.js';
import { ProviderCostReportStore } from '../monitoring/ProviderCostReportStore.js';
import { ProviderReconciliationSweep } from '../monitoring/ProviderReconciliationSweep.js';
import { meteredKeysFromChains } from '../core/routingSpendView.js';
import { DEFAULT_FRESHNESS_SLA_DAYS } from '../core/routingPriceAuthority.js';
import { METERED_ROUTING_DOORS } from '../data/llmBenchCoverage.js';
import { DEFAULT_METERED_CAPS } from '../core/routingSpendView.js';
import { A2ADeliveryTracker } from '../threadline/A2ADeliveryTracker.js';
import { setFeatureMetricsRecorder } from '../core/CircuitBreakingIntelligenceProvider.js';
import { DecisionQualityRecorderImpl, installDecisionQualityRecorder } from '../core/DecisionQualityRecorderImpl.js';
import { setDecisionQualityMachineId } from '../core/decisionQualityTypes.js';
import { TokenLedgerPoller } from '../monitoring/TokenLedgerPoller.js';
import { ResourceLedger } from '../monitoring/ResourceLedger.js';
import { ResourceLedgerPoller } from '../monitoring/ResourceLedgerPoller.js';
import { ParallelActivityIndex } from '../core/ParallelActivityIndex.js';
import { ParallelWorkSentinel } from '../monitoring/ParallelWorkSentinel.js';
import { ResourceSampler } from '../monitoring/ResourceSampler.js';
import { ProcessFootprintMonitor, defaultListProcesses } from '../monitoring/ProcessFootprintMonitor.js';
import { getLlmCircuitBreaker } from '../core/LlmCircuitBreaker.js';
import { FrameworkIssueLedger } from '../monitoring/FrameworkIssueLedger.js';
import { MentorOnboardingRunner, DEFAULT_MENTOR_CONFIG, resolveMentorDeliveryTopic, type MentorConfig } from '../scheduler/MentorOnboardingRunner.js';
import { buildAutoloopGoal } from '../scheduler/MentorAutonomousGuardian.js';
import {
  STAGE_A_ALLOWED_TOOLS,
  buildConversationSurface,
  parseMenteeReplies,
  parseMentorSent,
  type MenteeReplyLine,
  type MentorSentLine,
} from '../monitoring/MentorStageA.js';
import { analyzeForensics } from '../scheduler/MentorStageBForensics.js';
import { TelegramAdapter as MentorTelegramAdapter } from '../messaging/TelegramAdapter.js';
import { A2A_VERSION, type RecipientConfig } from '../messaging/AgentTelegramComms.js';
import { AgentTelegramLedger, defaultLedgerPaths as defaultA2aLedgerPaths } from '../messaging/AgentTelegramLedger.js';
import { DEFAULT_MENTEE_CONFIG, type MenteeConfig } from '../messaging/MenteeReceiverConfig.js';
import { ProcessedIdStore } from '../messaging/ProcessedIdStore.js';
import { buildAgentMessageHook, type RoleHandler } from '../messaging/installAgentMessageHook.js';
import { OutstandingPromptTracker } from '../scheduler/OutstandingPromptTracker.js';
import { parseCodexRollout } from '../monitoring/CodexRolloutParser.js';
import { extractCodexFinalMessage, extractClaudeFinalMessage, findClaudeTranscriptShallow } from '../monitoring/SessionReplyExtractor.js';
import type { ForensicFinding } from '../monitoring/FrameworkIssueLedger.js';
import { BurnDetector, type BurnDetectionConfig } from '../monitoring/BurnDetector.js';
import { EscalationGovernor } from '../core/EscalationGovernor.js';
import { ModelSwapService } from '../core/ModelSwapService.js';
import { EscalationHintStore } from '../core/EscalationHintStore.js';
import { UltraSessionCapMonitor, startOfUtcDayMs } from '../monitoring/UltraSessionCapMonitor.js';
import { escalatedModelIds, normalizeTierEscalationConfig } from '../core/ModelTierEscalation.js';
import { BurnThrottleRunbook, type BurnThrottleConfig } from '../monitoring/BurnThrottleRunbook.js';
import { BurnVerifier } from '../monitoring/BurnVerifier.js';
import { LlmRateGate } from '../monitoring/LlmRateGate.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { sendMentorVisibleEcho, type MentorVisibleEchoOptions } from '../core/MentorVisibleEcho.js';
import { registerBurnDetectionSubscriber } from '../monitoring/BurnDetectionSubscriber.js';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { bridgeNativeHealToDegradation } from '../monitoring/NativeHealDegradationBridge.js';

export function readMentorConfigFromDisk(
  stateDir: string | undefined,
  fallback: MentorConfig,
): MentorConfig {
  if (!stateDir) return fallback;
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { mentor?: unknown };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fallback;
    }
    if (parsed.mentor === undefined) {
      return { ...DEFAULT_MENTOR_CONFIG };
    }
    if (!parsed.mentor || typeof parsed.mentor !== 'object' || Array.isArray(parsed.mentor)) {
      return fallback;
    }
    return {
      ...DEFAULT_MENTOR_CONFIG,
      ...(parsed.mentor as Partial<MentorConfig>),
    };
  } catch {
    return fallback;
  }
}

/**
 * The request-time wiring for the live-test capstone runner (§6/§7.5). The route
 * builds a RealChannelDriver from whatever demo creds exist and calls `makeRunner`
 * to get a LiveTestRunner whose harness wraps that driver — sharing `artifactStore`
 * with the LiveTestGate so a run's artifact is exactly the artifact the gate verifies.
 */
export interface LiveTestRunnerWiring {
  artifactStore: import('../core/LiveTestArtifactStore.js').LiveTestArtifactStore;
  runnerFingerprint: string;
  /** Build a LiveTestRunner whose harness wraps the request-built driver (seat-move-first orchestration). */
  makeRunner: (
    driver: import('../core/LiveTestHarness.js').ChannelDriver,
  ) => import('../core/LiveTestRunner.js').LiveTestRunner;
  /** Build the harness directly (for running the richer §7.5 matrix after the seat-move gate). */
  makeHarness: (
    driver: import('../core/LiveTestHarness.js').ChannelDriver,
  ) => import('../core/LiveTestHarness.js').LiveTestHarness;
  /**
   * Optional injection seam: when present, the route uses THIS to build the request's
   * ChannelDriver instead of constructing the real Telegram/Slack senders from config.
   * Production leaves it undefined (the route builds the real, fail-closed driver);
   * tests provide a fake driver so a wired run can be exercised with no live network.
   */
  driverForRequest?: () => import('../core/LiveTestHarness.js').ChannelDriver;
  /**
   * Optional injection seam for the seat-move action. Production leaves it undefined
   * (the route POSTs the local /pool/transfer and reads the honest seatMoved signal);
   * tests inject a deterministic transfer so the capstone can be exercised end-to-end
   * without a live multi-machine pool.
   */
  transferForRequest?: (topicId: string, toMachine: string) => Promise<{ seatMoved: boolean; detail?: string }>;
}

export class AgentServer {
  private app: Express;
  private server: Server | null = null;
  private wsManager: WebSocketManager | null = null;
  private config: InstarConfig;
  /** multi-transport-mesh-comms (Layer 0.5) — see the bind site in start(). */
  private meshBindActive: boolean;
  private startTime: Date;
  private sessionManager: SessionManager;
  private state: StateManager;
  private hookEventReceiver?: import('../monitoring/HookEventReceiver.js').HookEventReceiver;
  private streamTicketStore?: import('./StreamTicketStore.js').StreamTicketStore;
  private poolStreamAllowRemoteInput = false;
  private poolStreamConnector?: import('./WebSocketManager.js').PoolStreamConnector;
  private poolLink?: import('./routes.js').RouteContext['poolLink'];
  private poolPollCache?: import('./PoolPollCache.js').PoolPollCache | null;
  private meshSelfId?: string;
  private deliverA2aToMachine?: (input: {
    machineId: string;
    targetAgent: string;
    text: string;
    topicId: number;
    senderAgent: string;
    senderBotId: string;
  }) => Promise<{ ok: boolean; agentMessage?: boolean; reason?: string }>;
  private routeContext: {
    wsManager: import('./WebSocketManager.js').WebSocketManager | null;
    pendingRelayLookup?: (deliveryId: string) => boolean;
    autonomousLivenessReconciler?:
      | import('../monitoring/AutonomousLivenessReconciler.js').AutonomousLivenessReconciler
      | null;
  } | null = null;
  private deliverySentinel: DeliveryFailureSentinel | null = null;
  private deliveryStore: PendingRelayStore | null = null;
  private toneGate: import('../core/MessagingToneGate.js').MessagingToneGate | null = null;
  private tokenLedger: TokenLedger | null = null;
  private featureMetricsLedger: FeatureMetricsLedger | null = null;
  /** Benchmark-Divergence Detector analyzer (benchmark-divergence-detector FD8) — null when the ledger failed. */
  private benchmarkDivergenceAnalyzer: BenchmarkDivergenceAnalyzer | null = null;
  private routingPriceAuthority: RoutingPriceAuthority | null = null;
  /** Increment B money layer — all null unless routingSpend.money.enabled === true (FD-16). */
  private meteredSpendLedger: MeteredSpendLedger | null = null;
  private routingSpendCapsStore: RoutingSpendCapsStore | null = null;
  private meteredSpendGate: MeteredSpendGate | null = null;
  private spendPlanStore: RenderedPlanStore | null = null;
  private pinAttemptStore: PinAttemptStore | null = null;
  private meteredSweepTimer: ReturnType<typeof setInterval> | null = null;
  private spendAlertResolver: SpendAlertResolver | null = null;
  private spendAlertTimer: ReturnType<typeof setInterval> | null = null;
  /** Increment C alert layer (dryRun-first live-on-dev — FD-16). */
  private spendAlertDispatcher: SpendAlertDispatcher | null = null;
  private spendAlertEmitters: SpendAlertEmitters | null = null;
  /** Lazily-opened durable relay handle for money-critical alert delivery. */
  private spendAlertRelayStore: SpendAlertRelayStore | null = null;
  /** Layer 1c provider-report store + reconciliation sweep (reporting-only; FD-21). */
  private providerCostReportStore: ProviderCostReportStore | null = null;
  private reconSweepTimer: ReturnType<typeof setInterval> | null = null;
  private featureMetricsPruneTimer: ReturnType<typeof setInterval> | null = null;
  private a2aDeliveryTracker: import('../threadline/A2ADeliveryTracker.js').A2ADeliveryTracker | null = null;
  private tokenLedgerPoller: TokenLedgerPoller | null = null;
  private resourceLedger: ResourceLedger | null = null;
  private resourceLedgerPoller: ResourceLedgerPoller | null = null;
  /** Per-machine process-footprint monitor (observe-only; the climb-measurement
   *  missing before the 2026-06-26 resource-exhaustion panic). Dark by default. */
  private processFootprintMonitor: ProcessFootprintMonitor | null = null;
  /** Approval-as-Data ledger (spec Part B, Phase 2). Read-only observability over
   *  operator approval decisions. Null when stateDir is unavailable. */
  private approvalLedger: ApprovalLedger | null = null;
  /** Verified per-topic operator binding (Know Your Principal #898, increment 2).
   *  The principal whose decisions the agent enacts in a topic, established ONLY
   *  from the authenticated sender uid. Null when stateDir is unavailable. */
  private topicOperatorStore: TopicOperatorStore | null = null;
  /** Coordination Mandate enforcement (spec §4): deny-by-default gate + signed
   *  store + hash-chained audit. Null when stateDir is unavailable. */
  private coordination: { store: MandateStore; gate: MandateGate; audit: MandateAudit; conditions: ConditionsRegistry; reviews: ReviewExchangeEngine } | null = null;
  /** WS5.2 R4a — durable store of cross-machine-DELIVERED account-follow-me mandates (target side).
   *  Null when coordination/stateDir is unavailable. */
  private deliveredMandateStore: import('../coordination/DeliveredMandateStore.js').DeliveredMandateStore | null = null;
  /** Operator Authorization Request (agent proposes → operator approves one-tap). Null
   *  when coordination/stateDir is unavailable. `enabled` is the resolved dev-gate. */
  private authorizationRequests: {
    store: import('../core/AuthorizationRequestStore.js').AuthorizationRequestStore;
    enabled: boolean;
    machineId: string;
    ownerDisplay: string;
    carrierSelfFp: string;
    resolvePrincipal: (slackUserId: string) => { name: string; registered: boolean } | null;
  } | null = null;
  private cutoverReadiness: CutoverReadiness | null = null;
  /** Option-B receiving end (feedback-factory-migration Q2b): drains the cloud
   *  Blob inbox into the durable canonical JsonlFeedbackStore. Null when dark
   *  (feedbackFactory.receiverPersistence.enabled !== true) → route 503s. */
  private inboxDrainer: InboxDrainer | null = null;
  /** Feedback-factory processing trigger (feedback-factory-migration §191): backs
   *  GET /feedback-factory/stats + POST /feedback-factory/process. Dev-gated —
   *  constructed only when resolveDevAgentGate(feedbackFactory.processing.enabled)
   *  is live; null on the fleet → both routes 503. */
  private feedbackProcessing: FeedbackProcessingService | null = null;
  private parallelActivityIndex: ParallelActivityIndex | null = null;
  private parallelWorkSentinel: ParallelWorkSentinel | null = null;
  private parallelWorkSentinelTimer: ReturnType<typeof setInterval> | null = null;
  // WS5.2 Account Follow-Me — delivered-mandate consumer (seam #1): drives enroll-start for
  // operator-approved+delivered mandates so a tapped Approve actually produces a login.
  private followMeConsumerTimer: ReturnType<typeof setInterval> | null = null;
  /** Dynamic MCP idle-offload sweep timer (dark + dryRun-first; cleared on stop). */
  private mcpIdleOffloadSweepTimer: ReturnType<typeof setInterval> | null = null;
  private followMeConsumerRunning = false;
  private resourceSampler: ResourceSampler | null = null;
  private frameworkIssueLedger: FrameworkIssueLedger | null = null;
  private mentorRunner: MentorOnboardingRunner | null = null;
  /** Wall-clock of the last mentor tick that ran, for the min-interval floor. */
  private mentorLastTickAt = 0;
  /** UTC day + run count for the per-day mentor cap (resets across days). */
  private mentorDayKey = '';
  private mentorRunsToday = 0;
  /** Lazily-constructed second TelegramAdapter for the mentor bot (gated on
   *  mentor.botToken). Per-token-cached so config reloads with the same token reuse the
   *  same adapter (avoids leaking a new bot poll loop on every send). Spec §Fix 2b. */
  private mentorBotAdapter: MentorTelegramAdapter | null = null;
  private mentorBotAdapterToken: string | null = null;
  /** Lazily-constructed a2a audit ledger (shared across mentor sends/recvs). */
  private a2aLedger: AgentTelegramLedger | null = null;
  /** Lazily-constructed processed-id store (idempotency for inbound mentor-reply). */
  private a2aProcessedIds: ProcessedIdStore | null = null;
  /** Lazily-constructed outstanding-prompt tracker (anti-ping-pong). */
  private mentorOutstanding: OutstandingPromptTracker | null = null;
  /** Reply-jsonl path (Codey's reply persisted here for Stage-B forensics). */
  private mentorReplyJsonlPath: string | null = null;
  /** Sent-jsonl path (mentor prompts persisted here for Stage-A surface). */
  private mentorSentJsonlPath: string | null = null;
  private failureLedger: FailureLedger | null = null;
  private failureAttributionEngine: FailureAttributionEngine | null = null;
  private ciFailurePoller: CiFailurePoller | null = null;
  private revertDetector: RevertDetector | null = null;
  private correctionLedger: CorrectionLedger | null = null;
  private blockerLedger: BlockerLedger | null = null;
  /** Self-Unblock checklist run store (the read surface + the store BlockerLedger verifies). */
  private selfUnblockRunStore: SelfUnblockRunStore | null = null;
  /**
   * The PRODUCTION Self-Unblock checklist — wired with real probe providers and the
   * durable run store. The PRODUCER half: routes RUN this to produce a verified
   * run (the gap that made settling a credential-blocker impossible until now).
   * Null when the self-unblock sub-feature is dark.
   */
  private selfUnblockChecklist: SelfUnblockChecklist | null = null;
  private growthMilestoneAnalyst: GrowthMilestoneAnalyst | null = null;
  private growthDigestPublisher: GrowthDigestPublisher | null = null;
  /** Dashboard Live-LLM-Insights engine (docs/specs/dashboard-live-insights.md).
   *  Null when the feature is dark (dashboard.liveInsights.enabled resolves false
   *  via the developmentAgent gate) → /insights* 503s. */
  private dashboardInsightEngine: DashboardInsightEngine | null = null;
  private apprenticeshipProgram: ApprenticeshipProgram | null = null;
  private apprenticeshipCycleStore: ApprenticeshipCycleStore | null = null;
  private apprenticeshipCycleSlaMonitor: ApprenticeshipCycleSlaMonitor | null = null;
  private geminiCapacityEscalationMonitor: GeminiCapacityEscalationMonitor | null = null;
  // Burn-detection-and-self-heal system (six-phase umbrella spec at
  // docs/specs/token-burn-detection-and-self-heal.md). Lazy-initialised
  // after the TokenLedger comes up — burn detection without a ledger is
  // a no-op.
  private burnDetector: BurnDetector | null = null;
  private burnThrottleRunbook: BurnThrottleRunbook | null = null;
  private burnVerifier: BurnVerifier | null = null;
  // Model-Tier Escalation (FABLE-MODEL-ESCALATION-SPEC): the §5.3 swap
  // engine (behind POST /sessions/:name/model-swap) and the §8 mid-run
  // ultra-cap monitor (rides BurnDetector's tick — no own poller).
  private modelTierSwap: ModelSwapService | null = null;
  private ultraCapMonitor: UltraSessionCapMonitor | null = null;
  // TOPIC-PROFILE-SPEC §8/§9 — retained so the orchestrator's escalation port
  // (wired late in server.ts via getEscalationGovernor()) can release a
  // profile-killed session's ultra lease. Nothing else reads it post-init.
  private escalationGovernorRef: EscalationGovernor | null = null;
  // WS5.3 (escalation-rides-topic) — the ephemeral per-topic escalation-hint
  // carrier. Always constructed (cheap, file-backed, inert while the WS5.3
  // sub-flag is off) so the /pool/transfer source-capture + destination
  // re-admit are ALIVE on the production init path; the feature gates itself
  // via config (tierEscalation.ridesTopic), never via missing wiring.
  private escalationHints: EscalationHintStore | null = null;
  // Stored from constructor options for use in start()'s listen callback.
  // The burn-detection system needs this to route alerts; no other
  // AgentServer code reads it (the route handlers go through routeCtx).
  private telegramAdapter: TelegramAdapter | null = null;

  constructor(options: {
    config: InstarConfig;
    sessionManager: SessionManager;
    /** Override the same-host apprenticeship peer read (tests/custom embeddings). */
    apprenticeshipPeerCycleReader?: (instanceId: string) => Promise<import('../monitoring/ApprenticeshipPeerCycleReader.js').ApprenticeshipPeerCycleRead>;
    state: StateManager;
    scheduler?: JobScheduler;
    telegram?: TelegramAdapter;
    relationships?: RelationshipManager;
    feedback?: FeedbackManager;
    dispatches?: DispatchManager;
    updateChecker?: UpdateChecker;
    autoUpdater?: AutoUpdater;
    autoDispatcher?: AutoDispatcher;
    quotaTracker?: QuotaTracker;
    publisher?: TelegraphService;
    viewer?: PrivateViewer;
    tunnel?: TunnelManager;
    evolution?: EvolutionManager;
    watchdog?: SessionWatchdog;
    triageNurse?: StallTriageNurse;
    topicMemory?: TopicMemory;
    feedbackAnomalyDetector?: FeedbackAnomalyDetector;
    projectMapper?: import('../core/ProjectMapper.js').ProjectMapper;
    cartographer?: import('../core/CartographerTree.js').CartographerTree;
    coherenceGate?: import('../core/ScopeVerifier.js').ScopeVerifier;
    contextHierarchy?: import('../core/ContextHierarchy.js').ContextHierarchy;
    canonicalState?: import('../core/CanonicalState.js').CanonicalState;
    operationGate?: import('../core/ExternalOperationGate.js').ExternalOperationGate;
    sentinel?: import('../core/MessageSentinel.js').MessageSentinel;
    adaptiveTrust?: import('../core/AdaptiveTrust.js').AdaptiveTrust;
    memoryMonitor?: import('../monitoring/MemoryPressureMonitor.js').MemoryPressureMonitor;
    orphanReaper?: import('../monitoring/OrphanProcessReaper.js').OrphanProcessReaper;
    coherenceMonitor?: import('../monitoring/CoherenceMonitor.js').CoherenceMonitor;
    commitmentTracker?: import('../monitoring/CommitmentTracker.js').CommitmentTracker;
    prHandLease?: import('../core/PrHandLease.js').PrHandLease;
    subscriptionPool?: import('../core/SubscriptionPool.js').SubscriptionPool;
    accountFollowMePeerViews?: import('./routes.js').RouteContext['accountFollowMePeerViews'];
    quotaPoller?: import('../core/QuotaPoller.js').QuotaPoller;
    quotaAwareScheduler?: import('../core/QuotaAwareScheduler.js').QuotaAwareScheduler;
    proactiveSwapMonitor?: import('../core/ProactiveSwapMonitor.js').ProactiveSwapMonitor;
    inUseAccountResolver?: import('../core/InUseAccountResolver.js').InUseAccountResolver;
    enrollmentWizard?: import('../core/EnrollmentWizard.js').EnrollmentWizard;
    accountFollowMeRevocation?: import('../core/AccountFollowMeRevocation.js').AccountFollowMeRevocation;
    credentialRepointing?: import('./routes.js').RouteContext['credentialRepointing'];
    semanticMemory?: import('../memory/SemanticMemory.js').SemanticMemory;
    activitySentinel?: import('../monitoring/SessionActivitySentinel.js').SessionActivitySentinel;
    rateLimitSentinel?: import('../monitoring/RateLimitSentinel.js').RateLimitSentinel;
    releaseReadinessSentinel?: import('../monitoring/ReleaseReadinessSentinel.js').ReleaseReadinessSentinel;
    greenPrAutoMerger?: import('../monitoring/GreenPrAutoMerger.js').GreenPrAutoMerger;
    guardLatchStore?: import('../monitoring/GuardLatchStore.js').GuardLatchStore;
    workingMemory?: import('../memory/WorkingMemoryAssembler.js').WorkingMemoryAssembler;
    quotaManager?: import('../monitoring/QuotaManager.js').QuotaManager;
    messageRouter?: MessageRouter;
    summarySentinel?: import('../messaging/SessionSummarySentinel.js').SessionSummarySentinel;
    spawnManager?: import('../messaging/SpawnRequestManager.js').SpawnRequestManager;
    systemReviewer?: import('../monitoring/SystemReviewer.js').SystemReviewer;
    capabilityMapper?: import('../core/CapabilityMapper.js').CapabilityMapper;
    selfKnowledgeTree?: import('../knowledge/SelfKnowledgeTree.js').SelfKnowledgeTree;
    coverageAuditor?: import('../knowledge/CoverageAuditor.js').CoverageAuditor;
    topicResumeMap?: import('../core/TopicResumeMap.js').TopicResumeMap;
    /** Topic Profile (TOPIC-PROFILE-SPEC) — store + resolver + write surface
     *  + shared confirm slots, constructed in server.ts. Backs the §9
     *  model-swap pin consult and the /topic-profile routes. */
    topicProfile?: {
      store: import('../core/TopicProfileStore.js').TopicProfileStore;
      resolver: import('../core/TopicProfileResolver.js').TopicProfileResolver;
      surface: import('../core/topicProfileWriteSurface.js').TopicProfileWriteSurface;
      confirmSlots: import('../core/topicProfileIngress.js').ProfileConfirmSlots;
      /** §8 orchestrator — model-swap route runExclusive wrap + ingress
       *  confirm surfaces. Null until the server wiring constructs it. */
      orchestrator?: import('../core/TopicProfileOrchestrator.js').TopicProfileOrchestrator | null;
      /** §5.3 transfer carrier — pendingTransferPull staleness on the read
       *  surface + the /pool/transfer acquire seam. Null on single-machine. */
      carrier?: import('../core/TopicProfileTransferCarrier.js').TopicProfileTransferCarrier | null;
    } | null;
    sessionRefresh?: import('../core/SessionRefresh.js').SessionRefresh;
    autonomyManager?: import('../core/AutonomyProfileManager.js').AutonomyProfileManager;
    trustElevationTracker?: import('../core/TrustElevationTracker.js').TrustElevationTracker;
    autonomousEvolution?: import('../core/AutonomousEvolution.js').AutonomousEvolution;
    coordinator?: MultiMachineCoordinator;
    /**
     * multi-transport-mesh-comms (Layer 0.5) — TRUE when this agent is genuinely
     * multi-machine (has a machine identity) AND the mesh transport is enabled, so
     * the server binds 0.0.0.0 (reachable on the advertised Tailscale/LAN endpoints)
     * instead of loopback. Computed in server.ts from `identityManager.hasIdentity()`
     * — NOT `config.multiMachine.enabled` (a near-dead field a real multi-machine
     * agent never sets; that wrong predicate shipped the bind inert in 1.3.630).
     */
    meshBindActive?: boolean;
    /** Multi-Machine Session Pool registry (§L2) — live MachineCapacity view behind GET /pool. */
    machinePoolRegistry?: import('../core/MachinePoolRegistry.js').MachinePoolRegistry;
    /** Durable Inbound Message Queue engine getter (late-bound; null = dark). */
    getInboundQueue?: () => import('../core/QueueDrainLoop.js').QueueDrainLoop | null;
    getMachineCoherence?: () => import('../monitoring/MachineCoherenceSentinel.js').MachineCoherenceSentinel | null;
    /** MeshRpc dispatcher (§L0) — receive side behind POST /mesh/rpc. */
    meshRpcDispatcher?: import('../core/MeshRpc.js').MeshRpcDispatcher;
    /** Signed cross-machine carrier into the recipient's existing A2A inbox. */
    deliverA2aToMachine?: AgentServer['deliverA2aToMachine'];
    /** Working-set pull coordinator (WORKING-SET-HANDOFF §3.3) — behind
     *  POST /coherence/fetch-working-set. Absent while the layer is dark. */
    workingSetPullCoordinator?: import('../core/WorkingSetPullCoordinator.js').WorkingSetPullCoordinator;
    workingSetArtifactManager?: import('../core/WorkingSetArtifactManager.js').WorkingSetArtifactManager;
    orchestratorPoller?: import('../monitoring/OrchestratorPoller.js').OrchestratorPoller | null;
    /** Commitments-coherence replica store (COMMITMENTS-COHERENCE §3.2) —
     *  merged GET /commitments?scope=mesh. Absent while dark. */
    commitmentReplicaStore?: import('../core/CommitmentsSync.js').CommitmentReplicaStore;
    /** Preferences-pool replica store (MULTI-MACHINE-SEAMLESSNESS §WS2.1) —
     *  union read folds these into GET /preferences/session-context. Absent while dark. */
    preferenceReplicaStore?: import('../core/PreferencesSync.js').PreferenceReplicaStore;
    /** WS2.1 SEND-SIDE: the journal-backed replicated-record emitter, forwarded to the
     *  RouteContext so the correction-loop's PreferencesManager can attach + emit. Absent while dark. */
    replicatedRecordEmitter?: import('../core/ReplicatedRecordEmitter.js').ReplicatedRecordEmitter;
    /** Replicated-store conflict ledger (replicated-store-foundation §7.2/§7.3).
     *  Backs GET /state/conflicts + POST /state/resolve-conflict. Absent while dark. */
    conflictStore?: import('../core/ConflictStore.js').ConflictStore;
    /** Rollback-unmerge engine (§7.4). Absent while dark. */
    rollbackUnmerge?: import('../core/RollbackUnmerge.js').RollbackUnmerge;
    /** Durable un-merged-origins registry (§7.4). Absent while dark. */
    droppedOriginRegistry?: import('../core/RollbackUnmerge.js').DroppedOriginRegistry;
    /** WS2.1 union reader for the `preferences` store (§7.2). The bypass-proof
     *  funnel GET /preferences/session-context reads the no-clobber union through
     *  when stateSync.preferences.enabled. Absent while dark. */
    preferencesUnionReader?: import('../core/ReplicatedStoreReader.js').ReplicatedStoreReader;
    /** P1.5b owner-routed mutation forward (§3.4). Absent while dark. */
    forwardCommitmentMutate?: (ownerMachineId: string, payload: import('../core/CommitmentMutation.js').CommitmentMutatePayload) => Promise<
      { kind: 'verdict'; outcome: import('../core/CommitmentMutation.js').MutateOutcome } | { kind: 'queued'; reason: string }
    >;
    /** Per-session ownership registry (§L3). */
    sessionOwnershipRegistry?: import('../core/SessionOwnershipRegistry.js').SessionOwnershipRegistry;
    /** Topic placement pin store (§L4) — backs GET /pool/placement + POST /pool/transfer. */
    topicPinStore?: import('../core/TopicPlacementPinStore.js').TopicPlacementPinStore;
    /** Durable conversation identity (durable-conversation-identity §8) — backs
     *  the read-only GET /conversations* surface. Always-on foundation. */
    conversationRegistry?: import('../core/ConversationRegistry.js').ConversationRegistry;
    /** durable-conversation-identity §7 bind-time authority (increment 2) —
     *  the stateless bind-token verifier. Default-constructed below so the bind
     *  gate is alive on every init path. */
    conversationBindAuth?: import('../core/conversationBindToken.js').ConversationBindAuth;
    /** §6.1 dark-window honesty (increment 2) — the live followThrough gate. */
    conversationFollowThrough?: () => { enabled: boolean; dryRun: boolean };
    /** U4.1 §2C — sticky skew-quarantine set (GET /pool/pin-quarantine + re-admit). */
    topicPinSkewQuarantine?: import('../core/TopicPinSkewQuarantine.js').TopicPinSkewQuarantine;
    /** U4.1 §2C — the answer-complete pin fold view (status + re-admit refold). */
    topicPinFoldView?: import('../core/TopicPinFoldView.js').TopicPinFoldView;
    /** Fix #3 observability: the WS1.3 OwnershipReconciler (for the /pool/reconciler readout). */
    ownershipReconciler?: import('../core/OwnershipReconciler.js').OwnershipReconciler;
    /** U4.2 — the stale-owner release engine (GET /pool/stale-owner-release; 503 when dark). */
    staleOwnerEngine?: import('../core/StaleOwnerReleaseEngine.js').StaleOwnerReleaseEngine;
    /** ownership-gated-spawn §3.8 — the unified watcher status surface + §3.5 provenance read. */
    duplicateReconciler?: import('../monitoring/DuplicateSessionReconciler.js').DuplicateSessionReconciler;
    ownerDarkLadder?: import('../core/OwnerDarkLadder.js').OwnerDarkLadder;
    spawnAdmission?: import('../core/SpawnAdmission.js').SpawnAdmission;
    judgmentProvenance?: import('../core/JudgmentProvenanceLog.js').JudgmentProvenanceLog;
    /** U4.4 — the lease hand-back reconciler + the operator-flip latch levers. */
    leaseHandback?: {
      status(): import('../core/LeaseHandbackReconciler.js').LeaseHandbackStatus;
      latchWrite(reason?: string): import('../core/handbackLatch.js').HandbackLatchRecord;
      latchClear(): void;
      latchRecord(): import('../core/handbackLatch.js').HandbackLatchRecord | null;
    };
    /** Pool Dashboard Streaming (§2.3) — shared single-use ticket store the
     *  WebSocketManager's /pool-stream upgrade consumes. */
    streamTicketStore?: import('./StreamTicketStore.js').StreamTicketStore;
    /** Pool Dashboard Streaming (§2.3) — may a PEER send input to a local
     *  session over /pool-stream? Default false (keystroke-forwarding is a
     *  lateral-movement vector). */
    poolStreamAllowRemoteInput?: boolean;
    /** Pool Dashboard Streaming requesting side (§2.2) — opens upstream
     *  /pool-stream links to peers so a remote-session subscribe streams. */
    poolStreamConnector?: import('./WebSocketManager.js').PoolStreamConnector;
    /** Cross-machine secret-sync (spec Phase 4) — backs GET /secrets/sync-status + POST /secrets/sync-now. */
    secretSync?: import('../core/SecretSync.js').SecretSyncHandle;
    /** U4.5 rope-health alerts monitor — backs GET /mesh/rope-health (null = dark → 503). */
    ropeHealthMonitor?: import('../monitoring/RopeHealthMonitor.js').RopeHealthMonitor | null;
    /** Standby-write reconciliation — ownership-scoped write admission + typed
     *  refusal (backs GET /write-admission; null = dark → 503). */
    writeAdmission?: import('../core/WriteAdmission.js').WriteAdmission | null;
    /** This machine's mesh id. */
    meshSelfId?: string;
    /** Resolve the lease-holder's base URL when this machine is not the holder (else null). */
    resolveRouterUrl?: () => string | null;
    /** WS1.2 sender leg: order the topic's owner (local or remote) to drain for a transfer. */
    sendDrain?: (ownerMachineId: string, sessionKey: string, target: string, ownershipEpoch: number) => Promise<{ ok: boolean; status?: string; reason?: string; noHandler?: boolean; runSuspended?: boolean }>;
    /** Every other active machine with a known URL — backs GET /sessions?scope=pool. */
    resolvePeerUrls?: () => Array<{ machineId: string; url: string }>;
    /** Guard runtime registry (GUARD-POSTURE-ENDPOINT-SPEC §2.1) — behind GET /guards. */
    guardRegistry?: import('../monitoring/GuardRegistry.js').GuardRegistry;
    /** EVERY registered, non-revoked machine (URL or not) — the /guards?scope=pool accounting boundary. */
    listPoolMachines?: () => Array<{ machineId: string; nickname?: string; lastKnownUrl?: string | null }>;
    /** WS4.4 "links that survive machine boundaries" — fronting proxy + holder verification handle (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4). */
    poolLink?: import('./routes.js').RouteContext['poolLink'];
    /** WS4.4(f) global pool-cache unification — the ONE shared per-peer poll cache pool-scope surfaces fan out through (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 clause (f)). */
    poolPollCache?: import('./PoolPollCache.js').PoolPollCache | null;
    /** Signed rollout-stage E2E result store (§Rollout). */
    sessionPoolE2EResultStore?: import('../core/SessionPoolE2EResultStore.js').SessionPoolE2EResultStore;
    localSigningKeyPem?: string;
    /** WS5.2 R4a — operator/issuer side: deliver an R4a-signed account-follow-me mandate to a REMOTE
     *  target over the signed mesh. Injected from server.ts (where the mesh client + peer-URL
     *  resolution live). Absent ⇒ this machine cannot deliver (single-machine / no mesh). */
    deliverMandateToMachine?: (args: {
      targetMachineId: string;
      portable: import('../coordination/AccountFollowMeMandateBridge.js').PortableMandate;
    }) => Promise<{ ok: boolean; status: number; reason?: string }>;
    /** Lease wire transport — receives peer lease broadcasts at /api/lease (spec §6). */
    leaseTransport?: { recordObserved: (lease: any) => void };
    /**
     * mesh-endpoint-http-propagation — records a peer's advertised mesh endpoints
     * (carried in the signed lease RPC body) into this machine's registry, bound to
     * the authenticated sender. Wired into the /api/lease + /api/lease/pull receivers.
     */
    peerEndpointRecorder?: import('../core/PeerEndpointRecorder.js').PeerEndpointRecorder;
    /**
     * mesh-endpoint-http-propagation — this machine's own validated self-endpoints,
     * served in the /api/lease/pull RESPONSE so a pulling peer learns our fast ropes.
     */
    getSelfMeshEndpoints?: () => import('../core/types.js').MeshEndpoint[] | undefined;
    /**
     * Serve this machine's current effective-view signed lease for an active PULL
     * (POST /api/lease/pull, Cross-Machine Coherence). Returns the signed lease (may
     * name a third machine — re-served) or null. Wired to LeaseCoordinator.currentLease().
     */
    onLeasePullRequest?: () => unknown | null;
    /**
     * Handoff wire transport — the point-to-point ack/yield channel for the
     * planned handoff (spec §8 G3d/G3e). The /api/handoff/ack route delivers the
     * incoming machine's verified echo via recordAck (resolves the outgoing's
     * awaitAck); /api/handoff/yield delivers the explicit yield via recordYield
     * (fires the incoming's registered yield handler → lease CAS). Absent → both
     * routes 503 (honest not-wired), never a silent ok.
     */
    handoffWireTransport?: { recordAck: (ack: any) => void; recordYield: () => void };
    /**
     * Incoming-side begin handler — invoked when a peer POSTs /api/handoff/begin
     * with its flush manifest (spec §8 G3d). server.ts binds this to store the
     * manifest and drive the HandoffReceiver's onBeginHandoff (build + send ack).
     * Absent → the begin route 503s.
     */
    onHandoffBegin?: (manifest: unknown, fromMachineId: string) => void;
    /**
     * Outgoing-side planned-handoff trigger (spec §8 G3e). server.ts binds this
     * to handoffSentinelWiring.initiate — the operator/test "hand off now" entry
     * point behind POST /handoff/initiate. Absent → the route 503s (not wired).
     */
    onHandoffInitiate?: () => Promise<'handed-off' | 'aborted-stay-awake' | 'failed'>;
    /**
     * Race-guard read for the planned handoff (HandoffSentinel.inProgress). The
     * reaper/scheduler can consult it so they do not act mid-handoff; also
     * surfaced at GET /handoff/status.
     */
    handoffInProgress?: () => boolean;
    /**
     * Exactly-once ingress ledger (spec §8 G3a) — present ONLY when
     * multiMachine.exactlyOnceIngress is enabled (server.ts constructs it).
     * Absent → the inbound/outbound message path behaves exactly as before.
     */
    messageLedger?: import('../messaging/MessageProcessingLedger.js').MessageProcessingLedger;
    /** Per-topic current-inbound dedupeKey map; paired with messageLedger. */
    currentInboundByTopic?: Map<string, string>;
    /**
     * Cross-machine reply-marker propagation (spec §8 G3a). The outbound reply
     * path broadcasts a marker to standby peers when a reply commits; present only
     * when the exactly-once ledger is wired. Absent → no cross-machine propagation.
     */
    replyMarkerTransport?: import('../core/ReplyMarkerTransport.js').ReplyMarkerTransport;
    /** Apply a peer's reply marker (→ machineRoutes /api/message-marker → ledger.applyRemoteReplyMarker). */
    onReplyMarker?: (marker: unknown, fromMachineId: string) => void;
    /**
     * Live-tail receiver — decrypts + applies a peer's encrypted live-tail flush
     * received at /api/live-tail (spec §8 G3b/c). Throws on decrypt/verify failure.
     */
    liveTailReceiver?: (
      flush: { topic: string; seq: number; enc: unknown; redactionVersion?: number },
      fromMachineId: string,
    ) => { applied: boolean; reason: string } | void;
    whatsapp?: import('../messaging/WhatsAppAdapter.js').WhatsAppAdapter;
    slack?: import('../messaging/slack/SlackAdapter.js').SlackAdapter;
    imessage?: import('../messaging/imessage/IMessageAdapter.js').IMessageAdapter;
    whatsappBusinessBackend?: import('../messaging/backends/BusinessApiBackend.js').BusinessApiBackend;
    messageBridge?: import('../messaging/shared/MessageBridge.js').MessageBridge;
    hookEventReceiver?: import('../monitoring/HookEventReceiver.js').HookEventReceiver;
    worktreeMonitor?: import('../monitoring/WorktreeMonitor.js').WorktreeMonitor;
    subagentTracker?: import('../monitoring/SubagentTracker.js').SubagentTracker;
    instructionsVerifier?: import('../monitoring/InstructionsVerifier.js').InstructionsVerifier;
    threadlineRouter?: import('../threadline/ThreadlineRouter.js').ThreadlineRouter;
    /** Threadline Phase 1 keystone — Conversation store + warrants-a-reply gate,
     *  so the local co-located inbound path gates like the relay funnel. */
    conversationStore?: import('../threadline/ConversationStore.js').ConversationStore;
    /** Robustness Phase 2 (D-A/D-B) — the canonical per-thread log + append funnel. */
    threadLog?: import('../threadline/ThreadLog.js').ThreadLog;
    threadMessageRecorder?: import('../threadline/recordThreadMessage.js').ThreadMessageRecorder;
    warrantsReplyGate?: import('../threadline/WarrantsReplyGate.js').WarrantsReplyGate;
    collaborationSurfacer?: import('../threadline/CollaborationSurfacer.js').CollaborationSurfacer; // CMT-509
    /** ThreadResumeMap — for topic-linkage outbound capture on /threadline/relay-send.
     *  Per THREAD-TOPIC-LINKAGE-SPEC.md. */
    threadResumeMap?: import('../threadline/ThreadResumeMap.js').ThreadResumeMap;
    /** Topic-linkage handler that ties threadline sends to Telegram topic sessions. */
    topicLinkageHandler?: import('../threadline/TopicLinkageHandler.js').TopicLinkageHandler;
    handshakeManager?: import('../threadline/HandshakeManager.js').HandshakeManager;
    threadlineRelayClient?: import('../threadline/client/ThreadlineClient.js').ThreadlineClient;
    threadlineReplyWaiters?: Map<string, { resolve: (reply: string) => void; threadId: string; senderAgent: string; timer: ReturnType<typeof setTimeout> }>;
    listenerManager?: import('../threadline/ListenerSessionManager.js').ListenerSessionManager;
    a2aDeliveryTracker?: import('../threadline/A2ADeliveryTracker.js').A2ADeliveryTracker;
    responseReviewGate?: import('../core/CoherenceGate.js').CoherenceGate;
    /** §D9.4b canary-battery driver (context-aware-outbound-review) — wired
     *  by server.ts alongside the response-review gate; the trigger route
     *  503s when absent or when the feature is dark. */
    reviewCanaryBattery?: import('../monitoring/ReviewCanaryBattery.js').ReviewCanaryBattery;
    messagingToneGate?: import('../core/MessagingToneGate.js').MessagingToneGate;
    outboundDedupGate?: import('../core/OutboundDedupGate.js').OutboundDedupGate;
    telemetryHeartbeat?: import('../monitoring/TelemetryHeartbeat.js').TelemetryHeartbeat;
    pasteManager?: import('../paste/PasteManager.js').PasteManager;
    soulManager?: import('../core/SoulManager.js').SoulManager;
    featureRegistry?: import('../core/FeatureRegistry.js').FeatureRegistry;
    discoveryEvaluator?: import('../core/DiscoveryEvaluator.js').DiscoveryEvaluator;
    completionEvaluator?: import('../core/CompletionEvaluator.js').CompletionEvaluator;
    /** Live-user-channel-proof completion gate (§4) — refuses "done" without a verified artifact. */
    liveTestGate?: import('../core/LiveTestGate.js').LiveTestGate;
    liveTestGateMode?: import('../core/LiveTestGate.js').LiveTestGateMode;
    /** Live-user-channel-proof CAPSTONE runner wiring (§6/§7.5) — dev-gated + dark.
     *  A factory (not a pre-bound runner) so the route can wrap the request-built
     *  RealChannelDriver, sharing the gate's artifact store. Undefined when dark/unwired. */
    liveTestRunnerCtx?: LiveTestRunnerWiring;
    unifiedTrust?: import('../threadline/UnifiedTrustWiring.js').UnifiedTrustSystem;
    liveConfig?: { set(path: string, value: unknown): void; get?<T>(path: string, def: T): T };
    /** Shared proxy coordinator (PresenceProxy ↔ PromiseBeacon ↔ /build heartbeat). */
    proxyCoordinator?: import('../monitoring/ProxyCoordinator.js').ProxyCoordinator;
    /** Integrated-Being shared-state ledger (v1). Null/undefined when disabled. */
    sharedStateLedger?: import('../core/SharedStateLedger.js').SharedStateLedger;
    /** Integrated-Being LedgerSessionRegistry (v2). Null/undefined when v2Enabled=false. */
    ledgerSessionRegistry?: import('../core/LedgerSessionRegistry.js').LedgerSessionRegistry;
    /** Worktree manager — parallel-dev isolation (PARALLEL-DEV-ISOLATION-SPEC.md). */
    worktreeManager?: WorktreeManager;
    /** Layer 1 of the Topic Intent Layer — per-topic confidence tracker. Null/undefined when disabled. */
    topicIntentStore?: TopicIntentStore;
    /** Layer 3 of the Topic Intent Layer — pre-send classifier. Same instance is used
     *  by the HTTP route AND the in-process outbound-gate caller in routes.ts. */
    topicIntentArcCheck?: import('../core/TopicIntentArcCheck.js').ArcCheck | null;
    /** Shared intelligence provider (subscription/REPL-pool) for the standards-conformance gate. */
    intelligence?: import('../core/types.js').IntelligenceProvider | null;
    /** Usher signal store (rung 4) — the read-only pull surface for re-surface signals. */
    usherSignalStore?: import('../core/UsherSignalStore.js').UsherSignalStore | null;
    /** OIDC verification function for the GH-check endpoint (injected for testability). */
    oidcVerify?: (token: string) => Promise<{ repository: string; workflow_ref: string; ref: string }>;
    /** Enrolled GitHub repos allowed to call the GH-check endpoint. */
    oidcEnrolledRepos?: Array<{ owner: string; repo: string }>;
    /** UnjustifiedStopGate authority (PR3 — context-death spec). */
    unjustifiedStopGate?: import('../core/UnjustifiedStopGate.js').UnjustifiedStopGate;
    /** Stop-gate SQLite persistence (PR3). */
    stopGateDb?: import('../core/StopGateDb.js').StopGateDb;
    /** notify-on-stop Layer B — surfaces genuinely-stuck unattended stops. */
    stopNotifier?: import('../monitoring/StopNotifier.js').StopNotifier | null;
    /** Initiative tracker — persisted record of multi-phase long-running work. */
    initiativeTracker?: import('../core/InitiativeTracker.js').InitiativeTracker;
    /** Project-scope round runner (Phase 1b PR 3). */
    projectRoundRunner?: import('../core/ProjectRoundRunner.js').ProjectRoundRunner;
    /** Project drift checker (Phase 1b connect-the-dots). Optional —
     *  when omitted, POST /projects/:id/drift-check returns 503. */
    projectDriftChecker?: import('../core/ProjectDriftChecker.js').ProjectDriftChecker;
    /** Multi-machine heartbeat + claim-ownership support (Phase 1b PR 4). */
    machineHeartbeat?: {
      api: import('../core/MachineHeartbeat.js').MachineHeartbeat;
      config: { machineId: string };
    };
    /** SessionReaper — pressure-aware idle-session reaper (off/dry-run by
     *  default). Powers GET /sessions/reaper. */
    sessionReaper?: import('../monitoring/SessionReaper.js').SessionReaper;
    /** AgentWorktreeReaper — reclaims stale CLI worktrees. Powers
     *  GET /worktrees/agent-reaper. */
    agentWorktreeReaper?: import('../monitoring/AgentWorktreeReaper.js').AgentWorktreeReaper;
    /** ExternalHogSentinel — the external-hog zombie auto-kill sentinel (CMT-1901). Powers
     *  GET /external-hog + the PIN-gated arm/disarm routes. */
    externalHogSentinel?: import('../monitoring/ExternalHogSentinel.js').ExternalHogSentinel;
    /** OrphanedWorkSentinel — the silent-uncommitted-death backstop. Powers
     *  GET /orphaned-work. */
    orphanedWorkSentinel?: import('../monitoring/OrphanedWorkSentinel.js').OrphanedWorkSentinel;
    /** McpProcessReaper — reclaims leaked MCP-server children of dead/stale
     *  sessions. Powers GET /processes/mcp-reaper. */
    mcpProcessReaper?: import('../monitoring/McpProcessReaper.js').McpProcessReaper;
    /** GeminiLoopRunner — multi-turn gemini loop-driver (need-gem-002). Powers
     *  POST + GET /gemini-loop/runs. */
    geminiLoopRunner?: import('../monitoring/GeminiLoopRunner.js').GeminiLoopRunner | null;
    /** SleepController — agent hard-sleep decision (Stage B). Powers GET /sleep. */
    sleepController?: import('../monitoring/SleepController.js').SleepController;
    /** AgentActivityState — shared idle signal bumped at the inbound chokepoint. */
    agentActivityState?: import('../monitoring/AgentActivityState.js').AgentActivityState;
    /** ReapLog — durable audit of every reap + skipped-reap (UNIFIED-SESSION-LIFECYCLE
     *  §P4). Powers GET /sessions/reap-log. */
    reapLog?: import('../monitoring/ReapLog.js').ReapLog;
    /** ResumeQueue + drainer (reap-notify spec R2.10) — /sessions/resume-queue*. */
    resumeQueue?: import('../monitoring/ResumeQueue.js').ResumeQueue | null;
    resumeDrainer?: import('../monitoring/ResumeQueueDrainer.js').ResumeQueueDrainer | null;
    autonomousLivenessReconciler?:
      | import('../monitoring/AutonomousLivenessReconciler.js').AutonomousLivenessReconciler
      | null;
    /** F2 enforced-termination watchdog status getter (spec: enforced-termination-watchdog.md).
     *  Powers GET /autonomous/enforced-termination. Function-typed to avoid a class import. */
    enforcedTerminationStatus?: (() => unknown) | null;
    /** Records operator stop instructions for the drainer's R2.6 validation. */
    operatorStopRecorder?: (topicId: number | null) => void;
    /** SleepWakeDetector — timer-drift sleep detection with CPU-starvation guard.
     *  Powers GET /monitoring/sleep-wake (wake + suppression telemetry). */
    sleepWakeDetector?: import('../core/SleepWakeDetector.js').SleepWakeDetector;
    /** Threadline → Telegram bridge config — toggles + allow/deny list. */
    telegramBridgeConfig?: import('../threadline/TelegramBridgeConfig.js').TelegramBridgeConfig;
    /** Threadline → Telegram bridge — relay-only mirror of threadline messages. */
    telegramBridge?: import('../threadline/TelegramBridge.js').TelegramBridge;
    /** Threadline observability — read-only views over inbox/outbox/bindings. */
    threadlineObservability?: import('../threadline/ThreadlineObservability.js').ThreadlineObservability;
    /** CMT-567: shared deps for the "open this" LLM topic-name + summary brief. */
    briefDeps?: import('../threadline/openConversationBrief.js').BriefDeps;
    /** TaskFlow registry — durable multi-step job records (OpenClaw import). */
    taskFlowRegistry?: import('../tasks/TaskFlowRegistry.js').TaskFlowRegistry;
    /** ThreadlineFlowBridge — resumes flows on cross-agent-callback inbound. */
    threadlineFlowBridge?: import('../tasks/ThreadlineFlowBridge.js').ThreadlineFlowBridge;
  }) {
    this.config = options.config;
    this.meshBindActive = options.meshBindActive ?? false;
    this.telegramAdapter = options.telegram ?? null;
    this.startTime = new Date();
    this.sessionManager = options.sessionManager;
    this.streamTicketStore = options.streamTicketStore;
    this.poolStreamAllowRemoteInput = options.poolStreamAllowRemoteInput ?? false;
    this.poolStreamConnector = options.poolStreamConnector;
    this.poolLink = options.poolLink ?? undefined;
    this.poolPollCache = options.poolPollCache ?? undefined;
    this.meshSelfId = options.meshSelfId ?? undefined;
    this.deliverA2aToMachine = options.deliverA2aToMachine;
    this.state = options.state;
    this.hookEventReceiver = options.hookEventReceiver ?? undefined;
    this.toneGate = options.messagingToneGate ?? null;
    this.app = express();

    // Middleware
    this.app.use(express.json({ limit: '12mb' }));
    this.app.use(duplicateResponseGuard);
    this.app.use(corsMiddleware);

    // Dashboard security headers — set before static serving so they apply to all dashboard responses
    this.app.use(dashboardSecurityHeaders);

    // Dashboard static files — served BEFORE auth middleware so the page loads
    // without a token. Auth happens via WebSocket/API calls from the page itself.
    const dashboardDir = this.resolveDashboardDir();
    // #1441 — dashboard statics must revalidate every load so a deploy can't pair a
    // fresh index.html with a stale glance.js. Header logic lives in
    // dashboardCacheControl / DASHBOARD_STATIC_OPTIONS (middleware.ts), exercised by
    // the same object in the integration test (no wiring drift).
    this.app.get('/dashboard', (_req, res) => {
      dashboardCacheControl(res);
      // cacheControl:false so send() does not re-stamp `public, max-age=0` over the
      // no-cache header above; etag/lastModified stay on for cheap 304 revalidation.
      res.sendFile(path.join(dashboardDir, 'index.html'), {
        cacheControl: false,
        etag: true,
        lastModified: true,
      });
    });
    this.app.use('/dashboard', express.static(dashboardDir, DASHBOARD_STATIC_OPTIONS));

    // PIN-based dashboard unlock — exchanges a short PIN for the auth token.
    // Placed before auth middleware so the dashboard can call it without a token.
    // Route is registered unconditionally so it works even when dashboardPin is
    // generated after AgentServer construction (first-boot timing issue).
    // Config values are checked at request time via this.config which may be
    // updated by LiveConfig/PostUpdateMigrator after construction.
    const pinAttempts = new Map<string, { count: number; resetAt: number }>();
    const MAX_ATTEMPTS = 5;
    const WINDOW_MS = 5 * 60 * 1000; // 5-minute window
    const configRef = this.config;

    this.app.post('/dashboard/unlock', (req: Request, res: Response) => {
      if (!configRef.dashboardPin || !configRef.authToken) {
        res.status(503).json({ error: 'PIN authentication not yet available. Try again shortly.' });
        return;
      }

      const ip = req.ip || req.socket.remoteAddress || 'unknown';

      // Rate limit by IP
      const now = Date.now();
      let entry = pinAttempts.get(ip);
      if (entry && now > entry.resetAt) {
        pinAttempts.delete(ip);
        entry = undefined;
      }
      if (entry && entry.count >= MAX_ATTEMPTS) {
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
      }

      const { pin } = req.body;
      if (!pin || typeof pin !== 'string') {
        res.status(400).json({ error: 'Missing PIN' });
        return;
      }

      const ha = createHash('sha256').update(pin).digest();
      const hb = createHash('sha256').update(configRef.dashboardPin).digest();
      if (!timingSafeEqual(ha, hb)) {
        // Track failed attempt
        if (!entry) {
          entry = { count: 0, resetAt: now + WINDOW_MS };
          pinAttempts.set(ip, entry);
        }
        entry.count++;
        const remaining = MAX_ATTEMPTS - entry.count;
        res.status(403).json({
          error: 'Incorrect PIN',
          attemptsRemaining: remaining,
        });
        return;
      }

      // PIN correct — return the auth token
      res.json({ token: configRef.authToken });
    });

    // Machine-to-machine routes — mounted BEFORE auth middleware because they use
    // their own machineAuth scheme (Ed25519 signatures, not bearer tokens).
    if (options.coordinator?.enabled) {
      const coord = options.coordinator;
      const machineRoutes = createMachineRoutes({
        identityManager: coord.managers.identityManager,
        heartbeatManager: coord.managers.heartbeatManager,
        securityLog: coord.managers.securityLog,
        authDeps: {
          identityManager: coord.managers.identityManager,
          nonceStore: coord.managers.nonceStore,
          securityLog: coord.managers.securityLog,
          localMachineId: coord.identity!.machineId,
        },
        localMachineId: coord.identity!.machineId,
        localSigningKeyPem: options.localSigningKeyPem ?? '',
        onDemote: () => coord.demoteToStandby('Remote heartbeat: another machine took over'),
        onPromote: () => coord.promoteToAwake('Remote handoff: awake machine handed off to us'),
        onHandoffRequest: async () => ({
          ready: true,
          state: { jobs: [], sessions: [] },
        }),
        messageRouter: options.messageRouter ?? null,
        onLeaseReceived: options.leaseTransport
          ? (lease: unknown) => options.leaseTransport!.recordObserved(lease as any)
          : undefined, // returns the resulting observed epoch → accept-ack (Decision 9)
        onLeasePullRequest: options.onLeasePullRequest,
        onLiveTailReceived: options.liveTailReceiver,
        onHandoffAck: options.handoffWireTransport
          ? (ack: unknown) => options.handoffWireTransport!.recordAck(ack)
          : undefined,
        onHandoffYield: options.handoffWireTransport
          ? () => options.handoffWireTransport!.recordYield()
          : undefined,
        onHandoffBegin: options.onHandoffBegin,
        onReplyMarker: options.onReplyMarker,
        peerEndpointRecorder: options.peerEndpointRecorder,
        getSelfMeshEndpoints: options.getSelfMeshEndpoints,
      });
      this.app.use(machineRoutes);
    }

    // Worktree GH-check endpoint — mounted BEFORE auth middleware because it uses
    // GitHub OIDC tokens, not bearer tokens. Authority for the parallel-dev isolation
    // push gate (PARALLEL-DEV-ISOLATION-SPEC.md, "Authoritative push gate" section).
    if (options.worktreeManager && options.oidcVerify) {
      const oidcRoutes = createOidcWorktreeRoutes({
        worktreeManager: options.worktreeManager,
        oidc: {
          enrolledRepos: options.oidcEnrolledRepos ?? [],
          verifyOidcToken: options.oidcVerify,
        },
      });
      this.app.use(oidcRoutes);
    }

    // WhatsApp Business API webhook routes — mounted BEFORE auth middleware because
    // Meta's webhook verification sends GET requests without Bearer tokens.
    if (options.whatsappBusinessBackend) {
      // Import is at top of file — mountWhatsAppWebhooks is synchronous
      mountWhatsAppWebhooks({
        app: this.app,
        backend: options.whatsappBusinessBackend,
      });
    }

    // Agent-id binding (spec telegram-delivery-robustness § Layer 1b):
    // pass projectName as the agent identity so the auth middleware can
    // structurally reject tokens sent to the wrong agent's server BEFORE
    // any token comparison runs. This closes the cross-tenant misroute
    // class proven by the Inspec/cheryl 2026-04-27 incident.
    // Resolve the token live (via a getter over the shared config object)
    // so tunnel credential rotation (Part 6 of the tunnel-failure-resilience
    // spec) takes effect on the running server — rotating authToken
    // immediately invalidates old bearer tokens AND old HMAC-signed view
    // URLs without a restart.
    this.app.use(authMiddleware(() => this.config.authToken, options.config.projectName));
    // Per-path request-timeout overrides for LLM-backed / third-party routes
    // (outbound messaging + the standards-conformance gate). The map and its
    // matching logic are the single source of truth in middleware.ts so a
    // wiring-integrity test asserts the exact production config. See
    // buildRequestTimeoutOverrides() for the per-route rationale.
    //
    // E2E-PAIRING: EXEMPT — tunes the request-timeout BUDGET of an existing
    // route (/spec/conformance-check), not a new route or feature. The route's
    // "feature is alive" lifecycle is already covered by
    // tests/e2e/standards-conformance-gate-lifecycle.test.ts; the budget itself
    // is verified at the unit level (AgentServer-outbound-timeout.test.ts via the
    // extracted production map/matcher). A 150s/180s budget is not E2E-observable.
    // The parity-pass/import-dryrun route budgets derive from the configured
    // live-source TOTAL fetch budget (feedbackMigration.paritySource.totalTimeoutMs)
    // so widening the source budget for a degraded source widens the response
    // window with it — see buildRequestTimeoutOverrides() for the live incident.
    const paritySourceTotalTimeoutMs = (options.config as { feedbackMigration?: { paritySource?: { totalTimeoutMs?: number } } })
      .feedbackMigration?.paritySource?.totalTimeoutMs;
    this.app.use(requestTimeout(options.config.requestTimeoutMs, buildRequestTimeoutOverrides({ paritySourceTotalTimeoutMs })));

    // ── Token Ledger ──────────────────────────────────────────────────
    // Read-only token-usage observability. Reads Claude Code's per-session
    // JSONL transcripts and rolls up into SQLite. Never mutates source files.
    try {
      if (options.config.stateDir) {
        const serverDataDir = path.join(options.config.stateDir, 'server-data');
        fs.mkdirSync(serverDataDir, { recursive: true });
        // Configure the native-module healer so any rebuild events land in
        // the agent's state directory rather than the system tmp fallback.
        // TokenLedger constructor uses NativeModuleHealer.openWithHealSync
        // for its better-sqlite3 open call — without this stateDir wiring,
        // a NODE_MODULE_VERSION mismatch would still get healed but its
        // observability log would be hard to find.
        NativeModuleHealer.configure({ stateDir: options.config.stateDir });
        // Surface heal failures on the DegradationReporter alert path so a
        // failed better-sqlite3 rebuild produces a Telegram alert instead of
        // silently leaving SemanticMemory / TopicMemory / MemoryIndex /
        // TokenLedger unavailable.
        bridgeNativeHealToDegradation();
        const dbPath = path.join(serverDataDir, 'token-ledger.db');
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        // Bound the first-boot scan: with deep history (eg one local agent
        // had 119k JSONLs / 12GB of transcripts), an unbounded synchronous
        // scan blocks the event loop for minutes. We cap per-tick work and
        // skip files older than the backfill window — the source JSONLs
        // remain authoritative if the operator wants to widen the window.
        this.tokenLedger = new TokenLedger({
          dbPath,
          claudeProjectsDir,
          maxFileAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
          maxFilesPerScan: 500,
          yieldEveryNFiles: 25,
          // Bounded Accumulation (Increment 2): per-store retention, dark by default.
          // The poller drives pruneToRetention on a sub-cadence; a no-op while disabled.
          retention: options.config.storage?.retention?.tokenLedger,
        });
      }
    } catch (err) {
      console.warn('[instar] token-ledger init failed (non-fatal):', err);
      this.tokenLedger = null;
    }

    // Framework-Onboarding Mentor System issue ledger — read-only observability,
    // signal-only (never gates). Its two tables auto-create on first boot (spec
    // §14.3 — no schema migration needed). DELIBERATELY in its OWN try/catch,
    // independent of TokenLedger: a TokenLedger init failure (e.g. a stale
    // token-ledger.db schema on an existing agent) must NOT cascade and take the
    // mentor ledger + runner down with it. (Found in production: an agent whose
    // TokenLedger threw `no such column: attribution_key` had the mentor routes
    // 503 purely because the two were sequenced in one try block.)
    if (options.config.stateDir) {
      try {
        const serverDataDir = path.join(options.config.stateDir, 'server-data');
        fs.mkdirSync(serverDataDir, { recursive: true });
        this.frameworkIssueLedger = new FrameworkIssueLedger({
          dbPath: path.join(serverDataDir, 'framework-issue-ledger.db'),
        });
        this.mentorRunner = this.buildMentorRunner(this.frameworkIssueLedger, options, serverDataDir);
      } catch (err) {
        console.warn('[instar] framework-issue-ledger init failed (non-fatal):', err);
        this.frameworkIssueLedger = null;
        this.mentorRunner = null;
      }
    }

    // Parallel-Work Awareness, Phase A (docs/specs/parallel-activity-coherence.md):
    // a thin CROSS-topic read index over the EXISTING Topic-Intent layer. No new
    // store; reads {stateDir}/topic-intent/*.json. Own try/catch (cascade isolation).
    // `running` is enriched from the live session list (which topics have a session now).
    if (options.config.stateDir) {
      try {
        const runningTopics = (): Set<number> => {
          const ids = new Set<number>();
          try {
            for (const s of options.sessionManager.listRunningSessions() as Array<{ topicId?: number | null }>) {
              if (typeof s.topicId === 'number') ids.add(s.topicId);
            }
          } catch { /* best-effort */ }
          return ids;
        };
        this.parallelActivityIndex = new ParallelActivityIndex({
          stateDir: options.config.stateDir,
          isRunning: (topicId) => runningTopics().has(topicId),
        });
      } catch (err) {
        console.warn('[instar] parallel-activity-index init failed (non-fatal):', err);
        this.parallelActivityIndex = null;
      }
    }

    // Parallel-Work Awareness, Phase B — the proactive overlap councilor sentinel.
    // DEV-GATED (CMT-1438): `enabled` is OMITTED from the ConfigDefaults block so the
    // developmentAgent gate decides — LIVE on a dev agent (the dogfooding ground),
    // DARK on the fleet. When on, it ticks on a cadence over the index, detects
    // cross-topic overlap, and emits ONE in-process nudge event (no listener wired).
    // Signal-only. Own try/catch (cascade isolation). Every transition is audited to
    // logs/sentinel-events.jsonl (house pattern). D4-verified observe-only.
    const pwsEnabled = resolveDevAgentGate(options.config.monitoring?.parallelWorkSentinel?.enabled, options.config);
    if (pwsEnabled && this.parallelActivityIndex && options.config.stateDir) {
      try {
        const index = this.parallelActivityIndex;
        const auditPath = path.join(options.config.stateDir, 'logs', 'sentinel-events.jsonl');
        this.parallelWorkSentinel = new ParallelWorkSentinel({
          getActivities: (nowMs) => index.activities(nowMs),
          audit: (ev) => {
            try {
              fs.appendFileSync(
                auditPath,
                JSON.stringify({ ts: new Date(ev.atMs).toISOString(), kind: `parallel-work:${ev.kind}`, pair: ev.pair }) + '\n',
              );
            } catch { /* best-effort audit; never break the tick */ }
          },
        });
        // Cadence (default 15 min). Lease-gating for multi-machine is a refinement;
        // shipping dark + single-machine common, so the tick runs when enabled.
        const cadenceMs = (options.config.monitoring?.parallelWorkSentinel?.cadenceMinutes ?? 15) * 60 * 1000;
        this.parallelWorkSentinelTimer = setInterval(() => {
          try { this.parallelWorkSentinel?.tick(Date.now()); } catch { /* never throw from the cadence */ }
        }, cadenceMs);
        if (typeof this.parallelWorkSentinelTimer.unref === 'function') this.parallelWorkSentinelTimer.unref();
      } catch (err) {
        console.warn('[instar] parallel-work-sentinel init failed (non-fatal):', err);
        this.parallelWorkSentinel = null;
      }
    }

    // Per-feature LLM metrics ledger — read-only observability for every gate/
    // sentinel's cost + hit-rate (docs/specs/llm-feature-metrics-spec.md). Own
    // try/catch, independent of the other ledgers (same cascade-isolation as
    // FrameworkIssueLedger). Phase 1a: this store + the /metrics/features route.
    // Phase 1b: the funnel tap — setFeatureMetricsRecorder() registers this
    // ledger as the module-level recorder every CircuitBreakingIntelligenceProvider
    // reads, so the single funnel writes per-feature metrics for ALL LLM systems.
    if (options.config.stateDir) {
      try {
        const serverDataDir = path.join(options.config.stateDir, 'server-data');
        fs.mkdirSync(serverDataDir, { recursive: true });
        // routing-control-room-spend Increment A: the daily spend rollup is maintained
        // only where the read-only spend view is live (dev agents; dark on the fleet).
        // The `door` column + batched prune are always active (additive/safe); this flag
        // bounds fleet blast radius to just the (tiny) daily-aggregate writes.
        const routingSpendCfg = (options.config as {
          routingSpend?: { enabled?: boolean; tokenRollupRetentionDays?: number };
        }).routingSpend;
        const routingSpendOn = resolveDevAgentGate(routingSpendCfg?.enabled, options.config);
        // The operator's RAW decision-row retention — threaded into the ledger
        // as the by_model reconcile's freeze-don't-zero floor
        // (benchmark-divergence-detector §Durable schema): the reconcile must
        // never zero a by_model day whose raw truth the prune already removed.
        const rawQualityRetentionDays =
          (options.config as { provenance?: { quality?: { decisionRetentionDays?: number } } }).provenance?.quality
            ?.decisionRetentionDays ?? 90;
        this.featureMetricsLedger = new FeatureMetricsLedger({
          dbPath: path.join(serverDataDir, 'feature-metrics.db'),
          maintainSpendRollup: routingSpendOn,
          rawRetentionDays: rawQualityRetentionDays,
        });
        // Phase 1b: wire the funnel → ledger. One injection point covers every
        // wrapped provider (current and future). Null-safe; no-op if it failed above.
        setFeatureMetricsRecorder(this.featureMetricsLedger);

        // LLM-Decision Quality Meter (llm-decision-quality-meter §5.5/§5.7):
        // the settlement recorder + annotate chokepoint, injected beside the
        // metrics recorder (the same module-singleton pattern — a constructor
        // option would reach only the one shared router; the singleton reaches
        // any instance). Gate resolution lives inside the recorder
        // (resolveDevAgentGate on provenance.uniformSeam.enabled; dryRun
        // default TRUE). machineId8 = the pool/mesh self id's first 8 chars
        // (§5.1.1 — the FD10 id segment); absent on single-machine installs.
        // Own try/catch: a recorder failure must never break the ledger block.
        try {
          installDecisionQualityRecorder(
            new DecisionQualityRecorderImpl({
              ledger: this.featureMetricsLedger,
              judgmentProvenance: options.judgmentProvenance ?? null,
              config: options.config,
              log: (m) => console.log(m),
            }),
          );
          setDecisionQualityMachineId(options.meshSelfId ?? null);
        } catch (err) {
          // @silent-fallback-ok: loud warn + the seam degrades to the null-recorder
          // no-op (the router's settlement write is a clean no-op without it) —
          // observability init must never break the ledger block or the server.
          console.warn('[instar] decision-quality recorder init failed (non-fatal — settlement seam stays no-op):', err);
        }

        // Benchmark-Divergence Detector (docs/specs/benchmark-divergence-detector.md
        // FD8/FD13): the stage-3 ANALYZE engine. Constructed whenever the ledger
        // exists — the dev-agent gate + dryRun are resolved INSIDE the analyzer at
        // call time, so a dark agent carries an inert instance and the routes 503.
        try {
          const peerExtraAllowlist = (options.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)
            ?.peerUrlAllowlist;
          this.benchmarkDivergenceAnalyzer = new BenchmarkDivergenceAnalyzer({
            ledger: this.featureMetricsLedger,
            config: options.config,
            machineId: options.meshSelfId ?? 'local',
            // Single-machine (no coordinator) counts as holder (FD8).
            isHolder: () => (options.coordinator?.enabled ? options.coordinator.getSyncStatus().holdsLease : true),
            holderMachineId: () =>
              options.coordinator?.enabled ? options.coordinator.getSyncStatus().leaseHolder ?? null : options.meshSelfId ?? 'local',
            resolvePeerUrls: options.resolvePeerUrls ?? null,
            isPeerUrlAllowed: (url) => isPeerUrlAllowedForCredentials(url, peerExtraAllowlist).ok,
            authToken: options.config.authToken,
          });
        } catch (err) {
          // @silent-fallback-ok: the detector is observe-only — a failed init
          // leaves the routes answering 503, never breaks the ledger block.
          console.warn('[instar] benchmark-divergence analyzer init failed (non-fatal):', err);
          this.benchmarkDivergenceAnalyzer = null;
        }

        // The reporting price authority (Layer 1) — reviewed manifest + machine-local
        // observed/overlay/credits. Read-only; constructed only when the view is live.
        if (routingSpendOn) {
          try {
            this.routingPriceAuthority = new RoutingPriceAuthority({
              projectDir: options.config.projectDir,
              stateDir: options.config.stateDir,
            });
          } catch (err) {
            console.warn('[instar] routing-price-authority init failed (non-fatal):', err);
            this.routingPriceAuthority = null;
          }
        }

        // Durable per-IP PIN-attempt lockout (S2-1) — hardens EVERY PIN route
        // (mandates, money surfaces, external-hog arm) so a restart no longer
        // resets brute-force lockout. Independent of the money layer.
        try {
          this.pinAttemptStore = new PinAttemptStore({ stateDir: options.config.stateDir });
        } catch (err) {
          // @silent-fallback-ok: loud warn + degrade to the pre-existing in-memory
          // lockout (defence-in-depth layer, never the auth decision itself).
          console.warn('[instar] pin-attempt store init failed (non-fatal — in-memory lockout only):', err);
          this.pinAttemptStore = null;
        }

        // ── Layer 1c provider-report store + reconciliation sweep (FD-21 —
        // REPORTING-only; rides the same dev-gated view flag as the summary;
        // structurally excluded from the money gate, which imports nothing here).
        if (routingSpendOn) {
          try {
            const rsCfg = (options.config as {
              routingSpend?: { providerReportRetentionDays?: number; reconciliation?: { sweepIntervalHours?: number; driftAlertPct?: number } };
            }).routingSpend;
            this.providerCostReportStore = new ProviderCostReportStore({
              dbPath: path.join(options.config.stateDir, 'server-data', 'provider-cost-reports.db'),
              retentionDays: rsCfg?.providerReportRetentionDays ?? 400,
            });
            this.providerCostReportStore.prune(); // boot prune (batched — scal-F4)
            const doorToKey = new Map(meteredKeysFromChains().map((m) => [m.door, m.keyRef]));
            const sweep = new ProviderReconciliationSweep({
              store: this.providerCostReportStore,
              // Internal-derived per (keyRef, door): the metered doors' daily token
              // buckets × the as-of reviewed price (the same reporting math the
              // summary uses) — reporting-side reads only, never the money mutex.
              internalDerivedUsd: (sinceMs, untilMs) => {
                const ledger = this.featureMetricsLedger;
                const prices = this.routingPriceAuthority;
                if (!ledger || !prices) return [];
                prices.reloadIfChanged();
                const sinceDays = Math.max(1, Math.ceil((untilMs - sinceMs) / 86_400_000) + 1);
                const buckets = ledger.spendTokenRollupDaily({ sinceDays });
                const agg = new Map<string, { keyRef: string; door: string; internalUsd: number }>();
                for (const b of buckets) {
                  const keyRef = doorToKey.get(b.door);
                  if (!keyRef) continue; // metered doors only
                  if (b.bucketStartMs < sinceMs - 86_400_000 || b.bucketStartMs > untilMs) continue;
                  const res = prices.resolve(b.door, b.modelId, b.bucketStartMs);
                  const cost = prices.reportingCost(res, b.tokensIn, b.tokensOut, b.tokensCached);
                  const e = agg.get(`${keyRef} ${b.door}`) ?? { keyRef, door: b.door, internalUsd: 0 };
                  e.internalUsd += cost.grossUsd;
                  agg.set(`${keyRef} ${b.door}`, e);
                }
                return [...agg.values()];
              },
              committedUsd: (keyRef) => {
                try {
                  return this.meteredSpendLedger?.committed(keyRef).committedLifetimeUsd ?? null;
                } catch {
                  // @silent-fallback-ok: committed is holder-known enrichment; a
                  // read failure records the comparison provider-vs-internal only.
                  return null;
                }
              },
              // The Increment-C emit surface (late-bound; dispatcher dryRun-soaked).
              onDrift: (keyRef, door, driftPct) => this.spendAlertEmitters?.onReconciliationDrift(keyRef, door, driftPct),
              driftAlertPct: rsCfg?.reconciliation?.driftAlertPct ?? 10,
            });
            const sweepMs = Math.max(1, rsCfg?.reconciliation?.sweepIntervalHours ?? 6) * 60 * 60 * 1000;
            this.reconSweepTimer = setInterval(() => void sweep.run(), sweepMs);
            this.reconSweepTimer.unref?.();
          } catch (err) {
            // @silent-fallback-ok: loud warn — a broken provider-report layer
            // degrades every row to internal-derived (labeled); it never touches
            // money admission or the router path.
            console.warn('[instar] provider-cost report layer init failed (non-fatal — internal-derived reporting remains):', err);
            this.providerCostReportStore = null;
          }
        }

        // ── Increment B MONEY layer (routing-control-room-spend §Layer 3 / Surface 2).
        // EXPLICIT enable only (`routingSpend.money.enabled === true`) — a documented
        // DARK_GATE_EXCLUSIONS action-bearing case (FD-16): NEVER resolveDevAgentGate.
        // Even enabled, every door stays deny-by-default until a per-door PIN go-live.
        const moneyCfg = (options.config as {
          routingSpend?: { money?: { enabled?: boolean; reserveTtlMs?: number } };
        }).routingSpend?.money;
        if (moneyCfg?.enabled === true) {
          try {
            this.meteredSpendLedger = new MeteredSpendLedger({
              stateDir: options.config.stateDir,
              reserveTtlMs: moneyCfg.reserveTtlMs,
            });
            this.routingSpendCapsStore = new RoutingSpendCapsStore({
              stateDir: options.config.stateDir,
              knownKeyRefs: new Set(Object.keys(DEFAULT_METERED_CAPS)),
              knownDoors: new Set([...METERED_ROUTING_DOORS] as string[]),
            });
            this.spendPlanStore = new RenderedPlanStore();
            const machineId = (options.config as { machineId?: string }).machineId ?? 'single-machine';
            const poolOn = (options.config as {
              multiMachine?: { sessionPool?: { enabled?: boolean; stage?: string } };
            }).multiMachine?.sessionPool?.enabled === true;
            this.meteredSpendGate = this.routingPriceAuthority
              ? new MeteredSpendGate({
                  ledger: this.meteredSpendLedger,
                  prices: this.routingPriceAuthority,
                  capsStore: this.routingSpendCapsStore,
                  machineId,
                  // Increment C observer (signal-only, late-bound — the alert layer
                  // constructs after this block; null while dark).
                  onGateEvent: (ev) => this.spendAlertEmitters?.onGateEvent(ev),
                  // Single-machine trivially self-confirms (it IS the pool). On a
                  // multi-machine pool the REAL designation re-confirmation plumbing
                  // lands with the metered dispatch seam — until then the gate
                  // SELF-FENCES (fails closed) there, the safe direction, matching
                  // the spec's own "paid routing is single-machine until D".
                  leaseConfirmedAgoMs: () => (poolOn ? null : 0),
                })
              : null;
            // Reserve-expiry sweep: at boot + cadence (money-side; takes the per-key mutex).
            // @silent-fallback-ok: a failed sweep pass retries on the next cadence tick;
            // un-expired reserves only ever OVER-count committed (the safe direction).
            const sweep = () => void this.meteredSpendLedger?.sweepExpired().catch(() => {});
            sweep();
            this.meteredSweepTimer = setInterval(sweep, 5 * 60 * 1000);
            this.meteredSweepTimer.unref?.();

            // Stale-price / observed-drift alerts ride Increment B (C5-5: stale pricing
            // changes money ADMISSION behavior, so its alarm belongs to the money
            // increment) on the minimal resolver foundation — ladder + lifeline fallback.
            const alertsCfg = (options.config as {
              routingSpend?: { alerts?: { telegramTopicId?: number | null }; money?: { priceStaleCheckIntervalHours?: number } };
            }).routingSpend;
            const tg = this.telegramAdapter;
            if (tg) {
              this.spendAlertResolver ??= this.buildSpendAlertResolver(tg, options.config, poolOn);
              const staleCheck = () => {
                try {
                  const prices = this.routingPriceAuthority;
                  const caps = this.routingSpendCapsStore;
                  const resolver = this.spendAlertResolver;
                  if (!prices || !caps || !resolver) return;
                  prices.reloadIfChanged();
                  const store = caps.read();
                  for (const [door, g] of Object.entries(store.goLive)) {
                    if (!g.enabled) continue; // staleness only alarms where money can move
                    const res = prices.resolve(door, '__staleness-probe__', Date.now());
                    if (res.priceStale && res.newestPointAgeDays !== null) {
                      const meta = prices.doorMetaFor(door);
                      const alert = buildStalePriceAlert(door, res.newestPointAgeDays, meta?.freshnessSlaDays ?? DEFAULT_FRESHNESS_SLA_DAYS);
                      // Increment C: prefer the dispatcher (lane dedup + coalescing +
                      // dryRun soak); the B resolver-direct path remains the fallback
                      // when the alert layer is dark (byte-identical B behavior).
                      const dispatcher = this.spendAlertDispatcher;
                      if (dispatcher) void dispatcher.dispatch(alert);
                      else void resolver.emit(alert);
                    }
                  }
                } catch {
                  // @silent-fallback-ok: the alert cadence is observability — a failed
                  // pass retries next tick; it must never disturb the server loop.
                }
              };
              const staleIntervalMs = Math.max(1, alertsCfg?.money?.priceStaleCheckIntervalHours ?? 6) * 60 * 60 * 1000;
              staleCheck();
              this.spendAlertTimer = setInterval(staleCheck, staleIntervalMs);
              this.spendAlertTimer.unref?.();
            }
          } catch (err) {
            // @silent-fallback-ok: NOT a silent fallback — fail CLOSED, loudly: a
            // money-layer init failure leaves every component null, the routes 503,
            // and no metered admission is possible anywhere.
            console.error('[instar] routing-spend MONEY layer init FAILED (fail-closed — money routes 503):', err);
            this.meteredSpendLedger = null;
            this.routingSpendCapsStore = null;
            this.meteredSpendGate = null;
            this.spendPlanStore = null;
          }
        }

        // ── Increment C alert layer (routing-control-room-spend §Surface 2 Alerts).
        // dryRun-FIRST live-on-dev (FD-16): `routingSpend.alerts.enabled` rides the
        // dev-agent gate; `alerts.dryRun` defaults TRUE so a dev agent soaks the
        // dispatch decisions in logs/routing-spend-alerts.jsonl before anything is
        // delivered. Independent of the money layer — door-dark/fallback alerts can
        // flow with no door ever armed (that is WHY the SERVING lease owns creation).
        try {
          const alertsCfgC = (options.config as {
            routingSpend?: { alerts?: { enabled?: boolean; dryRun?: boolean } };
          }).routingSpend?.alerts;
          const alertsOn = resolveDevAgentGate(alertsCfgC?.enabled, options.config);
          const tgC = this.telegramAdapter;
          if (alertsOn && tgC) {
            const poolOnC = (options.config as {
              multiMachine?: { sessionPool?: { enabled?: boolean } };
            }).multiMachine?.sessionPool?.enabled === true;
            this.spendAlertResolver ??= this.buildSpendAlertResolver(tgC, options.config, poolOnC);
            const auditPath = path.join(options.config.projectDir, 'logs', 'routing-spend-alerts.jsonl');
            const auditSink = (entry: Record<string, unknown>) => {
              try {
                fs.mkdirSync(path.dirname(auditPath), { recursive: true });
                fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
              } catch {
                // @silent-fallback-ok: the audit line is observability — never blocks dispatch.
              }
            };
            const channel = new TelegramSpendTopicChannel({
              resolver: this.spendAlertResolver,
              sendToTopic: async (topicId, text) => {
                await tgC.sendToTopic(topicId, text);
                return true;
              },
              lifelineTopicId: () => tgC.getLifelineTopicId(),
              // Money-critical kinds ride the durable relay when the store opens
              // (retry-until-delivered — delivery-robustness Layers 2/3; the
              // DeliveryFailureSentinel drains this store). Opened lazily,
              // per-agent-id isolated, degrade-to-direct-send on ANY failure.
              enqueueDurable: (topicId, text) => {
                try {
                  this.spendAlertRelayStore ??= SpendAlertRelayStore.open(options.config.projectName, options.config.stateDir);
                  const store = this.spendAlertRelayStore;
                  const id = spendAlertDeliveryId(topicId, text);
                  return store.enqueue({
                    delivery_id: id,
                    topic_id: topicId,
                    text_hash: id,
                    text,
                    http_code: 0,
                    attempted_port: options.config.port ?? 0,
                    next_attempt_at: new Date().toISOString(),
                  });
                } catch {
                  // @silent-fallback-ok: no sqlite / store unavailable — the channel
                  // degrades to the direct send + lifeline ladder (delivery degrades,
                  // never dies; the dispatcher's latch still requires a confirmed leg).
                  return false;
                }
              },
              audit: auditSink,
            });
            this.spendAlertDispatcher = new SpendAlertDispatcher({
              channels: [channel],
              dryRun: alertsCfgC?.dryRun !== false, // FD-16 dryRun-first
              auditPath,
            });
            const machineIdC = (options.config as { machineId?: string }).machineId ?? 'single-machine';
            this.spendAlertEmitters = new SpendAlertEmitters({
              dispatcher: this.spendAlertDispatcher,
              machineId: machineIdC,
            });
          }
        } catch (err) {
          // @silent-fallback-ok: loud warn — a broken alert layer degrades to the
          // Increment-B behavior (resolver-direct stale-price emission); it never
          // touches money admission or the router path.
          console.warn('[instar] routing-spend alert layer init failed (non-fatal — B-level alerts remain):', err);
          this.spendAlertDispatcher = null;
          this.spendAlertEmitters = null;
        }

        // Observable Intelligence × Responsible Resource: the audit trail is kept
        // long enough to see behaviour/performance trends, then aged out — never
        // hoarded forever. Default 30d; tune via monitoring.featureMetrics.retentionDays
        // (0/negative disables pruning). Prune once at boot + every 6h thereafter.
        const fmCfg = (options.config as {
          monitoring?: { featureMetrics?: { retentionDays?: number } };
        }).monitoring?.featureMetrics;
        const retentionDays = fmCfg?.retentionDays ?? 30;
        // The daily spend rollup has its OWN (longer) horizon, decoupled from the 30d raw
        // rows (routing-control-room-spend scal-F3) — default 400 days.
        const rollupRetentionDays = routingSpendCfg?.tokenRollupRetentionDays ?? 400;
        // Decision-quality substrate retention (llm-decision-quality-meter §5.5):
        // the four quality tables carry their OWN 90d horizon, decoupled from both
        // the 30d raw rows and the spend rollup. The quality arm on the condition
        // below keeps this timer constructed even when featureMetrics retention is
        // 0 and routing-spend is dark — without it the quality tables would never
        // prune and the periodic reconcile would never run (INT/LES r3).
        const qualityCfg = (options.config as {
          provenance?: { quality?: { decisionRetentionDays?: number; rollupRetentionDays?: number } };
        }).provenance?.quality;
        const qualityDecisionRetentionDays = qualityCfg?.decisionRetentionDays ?? 90;
        const qualityRollupRetentionDays = qualityCfg?.rollupRetentionDays ?? 90;
        const qualityPruneOn = qualityDecisionRetentionDays > 0 || qualityRollupRetentionDays > 0;
        if (retentionDays > 0 || routingSpendOn || qualityPruneOn) {
          const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
          const prune = () => {
            try { if (retentionDays > 0) this.featureMetricsLedger?.pruneOlderThan(Date.now() - retentionMs); } catch { /* @silent-fallback-ok: retention prune is best-effort housekeeping — a failed prune just leaves old rows for the next tick */ }
            try { if (routingSpendOn && rollupRetentionDays > 0) this.featureMetricsLedger?.pruneSpendRollup(rollupRetentionDays); } catch { /* @silent-fallback-ok: rollup prune is best-effort housekeeping */ }
            // Quality-substrate housekeeping (§5.5): per-table prunes + the PERIODIC
            // arm of the bounded rollup reconcile (window 30d, mirroring spend; the
            // boot arm runs in the ledger constructor — the fold is idempotent).
            // Grading cursors: never pruned while their decision point is registered
            // — the census wiring (§5.6) threads the registered ids here when it
            // lands; until then only ≥horizon-stale cursors (abandoned points whose
            // grading job hasn't re-stamped them in 90d) are eligible.
            try {
              if (qualityDecisionRetentionDays > 0) {
                this.featureMetricsLedger?.pruneDecisionQuality(qualityDecisionRetentionDays);
                this.featureMetricsLedger?.pruneDecisionOutcomes(qualityDecisionRetentionDays);
                this.featureMetricsLedger?.pruneGradingCursors(qualityDecisionRetentionDays);
              }
              if (qualityRollupRetentionDays > 0) this.featureMetricsLedger?.pruneQualityRollup(qualityRollupRetentionDays);
              // benchmark-divergence-detector §Durable schema: the by_model
              // rollup + analysis watermark carry their OWN retention knob
              // (byModelRetentionDays, default 180 — P19 bounded), decoupled
              // from the meter's clocks; the reconcile carries the operator's
              // raw retention as its freeze-don't-zero floor.
              const bdRetentionDays = (options.config as {
                benchmarkDivergence?: { byModelRetentionDays?: number };
              }).benchmarkDivergence?.byModelRetentionDays ?? 180;
              if (bdRetentionDays > 0) {
                this.featureMetricsLedger?.pruneQualityRollupByModel(bdRetentionDays);
                this.featureMetricsLedger?.pruneBenchmarkWatermarks(bdRetentionDays);
              }
              this.featureMetricsLedger?.reconcileQualityRollup(30, { rawRetentionDays: qualityDecisionRetentionDays });
            } catch { /* @silent-fallback-ok: quality housekeeping is best-effort — a failed pass leaves rows for the next tick */ }
          };
          prune();
          this.featureMetricsPruneTimer = setInterval(prune, 6 * 60 * 60 * 1000);
          // Don't keep the event loop alive solely for retention housekeeping.
          this.featureMetricsPruneTimer.unref?.();
        }
      } catch (err) {
        console.warn('[instar] feature-metrics-ledger init failed (non-fatal):', err);
        this.featureMetricsLedger = null;
      }
    }

    // A2A delivery tracker (A2A-DURABLE-DELIVERY-SPEC.md) — durable per-peer
    // delivery lifecycle + peer-health. Production (commands/server.ts) injects
    // its instance via options; when not injected (e.g. an AgentServer booted
    // directly, as in e2e) we build it here from stateDir so the peer-health
    // routes are ALIVE on every entry path, not a 503-stub. Own try/catch
    // (cascade-isolation). Recording-only — never gates a send.
    if (!options.a2aDeliveryTracker && options.config.stateDir) {
      try {
        this.a2aDeliveryTracker = A2ADeliveryTracker.open(options.config.projectName, options.config.stateDir);
      } catch (err) {
        // @silent-fallback-ok: cascade-isolation — a tracker init failure must never 503
        // the server (mirrors the FeatureMetricsLedger block above). Logged; routes 503 cleanly.
        console.warn('[instar] a2a-delivery-tracker init failed (non-fatal):', err);
        this.a2aDeliveryTracker = null;
      }
    }

    // Per-agent ResourceLedger (Phase A: durable rate-limit-event capture). Its
    // OWN try/catch, independent of the other ledgers (cascade-isolation — a
    // chained init failure must not 503 the others). Read-only observability;
    // never gates. The poller subscribes to the global LlmCircuitBreaker's
    // trip/recover observer so breaker trips survive restart. Ships ON
    // (negligible, event-driven cost); opt out with
    // monitoring.resourceLedger.enabled:false. (Phase B = CPU/mem sampling,
    // gated separately below by the developmentAgent standard.)
    const rlCfg = (options.config as {
      monitoring?: {
        resourceLedger?: {
          enabled?: boolean;
          sampleIntervalMs?: number;
          idleSampleIntervalMs?: number;
          retentionDays?: number;
        };
      };
    }).monitoring?.resourceLedger;
    if (options.config.stateDir && rlCfg?.enabled !== false) {
      try {
        const serverDataDir = path.join(options.config.stateDir, 'server-data');
        fs.mkdirSync(serverDataDir, { recursive: true });
        this.resourceLedger = new ResourceLedger({
          dbPath: path.join(serverDataDir, 'resource-ledger.db'),
        });
        this.resourceLedgerPoller = new ResourceLedgerPoller({
          ledger: this.resourceLedger,
          breaker: getLlmCircuitBreaker(),
        });
        this.resourceLedgerPoller.start();

        // Phase B: continuous CPU% + RSS sampling of the agent's own server
        // process and its spawned sessions. Rides the developmentAgent dark-
        // feature gate (standard_development_agent_dark_feature_gate): when the
        // sampling switch is unset it resolves to ON for dev agents (echo) and
        // OFF on the fleet, so this dogfoods on echo before fleet rollout. This
        // is read-only observability — the sampler only reads ps/process.* and
        // writes the ledger; it never gates, throttles, or mutates anything.
        const samplingEnabled = resolveDevAgentGate(rlCfg?.enabled, options.config);
        if (samplingEnabled) {
          const sessionManager = options.sessionManager;
          this.resourceSampler = new ResourceSampler({
            ledger: this.resourceLedger,
            getSessionPids: () => {
              try {
                return sessionManager.getRunningSessionPanePids();
              } catch {
                return [];
              }
            },
            intervalMs: rlCfg?.sampleIntervalMs,
            idleIntervalMs: rlCfg?.idleSampleIntervalMs,
            retentionMs:
              rlCfg?.retentionDays && rlCfg.retentionDays > 0
                ? rlCfg.retentionDays * 24 * 60 * 60 * 1000
                : undefined,
          });
          this.resourceSampler.start();
        }
      } catch (err) {
        console.warn('[instar] resource-ledger init failed (non-fatal):', err);
        try { this.resourceSampler?.stop(); } catch { /* best-effort */ }
        this.resourceLedger = null;
        this.resourceLedgerPoller = null;
        this.resourceSampler = null;
      }
    }

    // Per-machine process-footprint monitor — the climb measurement missing before
    // the 2026-06-26 resource-exhaustion panic (steady-state process accumulation,
    // dominated by idle MCP servers, went unwatched until the host hit a kernel
    // limit). OBSERVE-ONLY: it samples the process count on a multi-minute interval
    // and exposes a trend; it never kills/gates (the reapers own reclamation). Rides
    // the dev-agent dark gate (ON for dev agents, OFF on the fleet). The threshold
    // heads-up is opt-in (`alertEnabled`, default false — measure first); wiring its
    // emitAttention sink to the aggregated attention surface is a tracked follow-up.
    try {
      const pfCfg = (options.config as {
        monitoring?: { processFootprintMonitor?: {
          enabled?: boolean; sampleIntervalMs?: number; windowSamples?: number;
          alertThreshold?: number; alertEnabled?: boolean;
        } };
      }).monitoring?.processFootprintMonitor;
      // Only construct when enabled (dev-gate resolves it) — a disabled monitor is
      // null so `/resources/footprint` 503s, matching the ResourceLedger contract.
      if (resolveDevAgentGate(pfCfg?.enabled, options.config)) {
        this.processFootprintMonitor = new ProcessFootprintMonitor(
          { listProcesses: defaultListProcesses },
          { ...(pfCfg ?? {}), enabled: true },
        );
        this.processFootprintMonitor.start();
      }
    } catch (err) {
      console.warn('[instar] process-footprint-monitor init failed (non-fatal):', err);
      this.processFootprintMonitor = null;
    }

    // Approval-as-Data ledger (docs/specs/AUTONOMOUS-OPERATION-JUDGMENT-AND-APPROVAL-AS-DATA-SPEC.md,
    // Part B / Phase 2). Durable, signed, append-only record of operator approval
    // decisions + per-class agreement ratios. Always constructed when stateDir is
    // available (read-only, low-cost; an empty ledger does nothing). The signer is
    // HMAC over the state secret (authToken) — integrity only; correctness is the
    // operator-authoritative-source rule documented on ApprovalLedger. Own try/catch
    // so it can never cascade into the other ledgers' init.
    try {
      if (options.config.stateDir) {
        const signKey = this.config.authToken || 'approval-ledger-unsigned-dev-key';
        const sign = (canonical: string) => createHmac('sha256', signKey).update(canonical).digest('hex');
        const verifySig = (canonical: string, signature: string) => {
          const expected = sign(canonical);
          try {
            return expected.length === signature.length
              && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
          } catch { /* @silent-fallback-ok — a malformed signature must verify FALSE (deny-safe), never throw */ return false; }
        };
        this.approvalLedger = new ApprovalLedger({
          filePath: path.join(options.config.stateDir, 'state', 'approval-ledger.jsonl'),
          sign,
          verifySig,
        });
      }
    } catch (err) {
      // @silent-fallback-ok — reported via console.warn; a ledger init failure must never block server boot.
      console.warn('[instar] approval-ledger init failed (non-fatal):', err);
      this.approvalLedger = null;
    }

    // Verified per-topic operator binding (Know Your Principal #898, increment 2).
    // The store is the authoritative answer to "who is this topic's operator?" —
    // established ONLY from the authenticated sender uid (a content name can never
    // become the operator by construction; the "Caroline" identity-bleed failure
    // mode is structurally impossible). Own try/catch so it can never cascade into
    // server boot; an empty store is fail-safe (the guard then treats every
    // attribution as unverifiable).
    try {
      if (options.config.stateDir) {
        this.topicOperatorStore = new TopicOperatorStore(path.join(options.config.stateDir, 'state'));
      }
    } catch (err) {
      // @silent-fallback-ok — reported via console.warn; an operator-store init failure must never block server boot.
      console.warn('[instar] topic-operator-store init failed (non-fatal):', err);
      this.topicOperatorStore = null;
    }

    // Coordination Mandate enforcement (docs/specs/coordination-mandate.md §4).
    // Deny-by-default: with NO valid mandate issued, the gate denies every
    // autonomous A2A action — the system is inert until the operator authors a
    // mandate through the PIN-gated issuance route. The issuance proof is an HMAC
    // over the server's issuance secret (authToken): the proof stops a forged or
    // edited AUTHORED mandate (T1/T2); local-file tamper by an attacker with disk
    // access is the same trust root as today (T12, out of scope, stated in-spec).
    // Conditions resolve from REAL state; unwired conditions evaluate false
    // (deny-safe) — the future execute-cutover authority wires real resolvers.
    // Own try/catch so a failure here can never cascade into the other inits.
    try {
      if (options.config.stateDir) {
        const issuanceKey = this.config.authToken || 'mandate-issuance-unsigned-dev-key';
        const mSign = (canonical: string) => createHmac('sha256', issuanceKey).update(canonical).digest('hex');
        const mVerify = (canonical: string, proof: string) => {
          const expected = mSign(canonical);
          try {
            return expected.length === proof.length
              && timingSafeEqual(Buffer.from(expected), Buffer.from(proof));
          } catch { /* @silent-fallback-ok — a malformed proof must verify FALSE (deny-safe), never throw */ return false; }
        };
        const store = new MandateStore({
          filePath: path.join(options.config.stateDir, 'state', 'coordination-mandates.json'),
          sign: mSign,
          verifySig: mVerify,
        });
        const audit = new MandateAudit({
          filePath: path.join(options.config.stateDir, 'state', 'mandate-audit.jsonl'),
        });
        const conditions = new ConditionsRegistry();
        // Cutover-READINESS (spec §7 G2.4, scoped by decision 1A: everything UP TO
        // the door — the flip itself stays the operator's manual click). The two
        // objective conditions resolve from REAL durable state (T7): the persisted
        // import IntegrityReport and the durable zero-divergence parity window.
        // An agent can TRIGGER a server-side parity pass; it can never assert one.
        const parityMonitor = new DurableParityMonitor(
          new JsonlPassPersistence(path.join(options.config.stateDir, 'state', 'feedback-parity-passes.jsonl')),
        );
        const migrationCfg = (this.config as { feedbackMigration?: { paritySource?: { baseUrl?: string; secretKey?: string; pageSize?: number; status?: string; pageTimeoutMs?: number; totalTimeoutMs?: number } } }).feedbackMigration;
        const paritySourceCfg = migrationCfg?.paritySource;
        const runParityCheck = paritySourceCfg?.baseUrl
          ? async () => {
            const token = String(new SecretStore({ stateDir: options.config.stateDir }).get(paritySourceCfg.secretKey ?? 'portal.instarReadToken') ?? '');
            if (!token) throw new Error(`parity source token "${paritySourceCfg.secretKey ?? 'portal.instarReadToken'}" not found in the SecretStore`);
            const source = new HttpParitySource({
              baseUrl: paritySourceCfg.baseUrl!,
              token,
              // Parity-pass needs ONLY the clusters (invariant-1 fingerprint) and
              // Portal returns the full cluster set on every page — so stop after
              // page 0 instead of grinding all ~146 feedback pages. Without this
              // the contended server can't finish inside the single-flight
              // max-hold budget and the parity window goes permanently stale (#948).
              clustersOnly: true,
              ...(paritySourceCfg.pageSize ? { pageSize: paritySourceCfg.pageSize } : {}),
              ...(paritySourceCfg.status ? { status: paritySourceCfg.status } : {}),
              ...(paritySourceCfg.pageTimeoutMs ? { pageTimeoutMs: paritySourceCfg.pageTimeoutMs } : {}),
              ...(paritySourceCfg.totalTimeoutMs ? { totalTimeoutMs: paritySourceCfg.totalTimeoutMs } : {}),
            });
            await source.prepare();
            return runDryRunCompare(source);
          }
          : null;
        // Import REHEARSAL (dry-run): live source fetch with raw capture → AS-IS
        // import into an in-memory target → integrity gate over the readback.
        // Zero durable data writes; the envelope lands at the SEPARATE dry-run
        // path below, never the canonical integrity report (readiness honesty).
        const runImportDryRunCheck = paritySourceCfg?.baseUrl
          ? async () => {
            const token = String(new SecretStore({ stateDir: options.config.stateDir }).get(paritySourceCfg.secretKey ?? 'portal.instarReadToken') ?? '');
            if (!token) throw new Error(`parity source token "${paritySourceCfg.secretKey ?? 'portal.instarReadToken'}" not found in the SecretStore`);
            const source = new HttpParitySource({
              baseUrl: paritySourceCfg.baseUrl!,
              token,
              captureRaw: true,
              ...(paritySourceCfg.pageSize ? { pageSize: paritySourceCfg.pageSize } : {}),
              ...(paritySourceCfg.status ? { status: paritySourceCfg.status } : {}),
              ...(paritySourceCfg.pageTimeoutMs ? { pageTimeoutMs: paritySourceCfg.pageTimeoutMs } : {}),
              ...(paritySourceCfg.totalTimeoutMs ? { totalTimeoutMs: paritySourceCfg.totalTimeoutMs } : {}),
            });
            await source.prepare();
            return runImport(
              { clusters: source.readRawClusters(), feedback: source.readRawFeedback() },
              new InMemoryImportTarget(),
            );
          }
          : null;
        // REAL pre-click integrity pass: spawn the import-integrity runner as a CHILD
        // process so the full-corpus captureRaw fetch + AS-IS import into a persisted
        // shadow runs OFF the server event loop. The in-process import-dryrun closure
        // above CANNOT settle the 145K-row fetch inside the single-flight budget (#948);
        // a child process has no event-loop contention (measured ~2.7min). The child
        // prints the verdict JSON to stdout; we parse it into an ImportRunResult for
        // CutoverReadiness.runIntegrityPass() to record to the canonical integrity path.
        const runIntegrityImport = paritySourceCfg?.baseUrl
          ? async (): Promise<ImportRunResult> => {
            const token = String(new SecretStore({ stateDir: options.config.stateDir }).get(paritySourceCfg.secretKey ?? 'portal.instarReadToken') ?? '');
            if (!token) throw new Error(`parity source token "${paritySourceCfg.secretKey ?? 'portal.instarReadToken'}" not found in the SecretStore`);
            const runnerPath = fileURLToPath(new URL('../feedback-factory/migration/integrityPassRunner.js', import.meta.url));
            const shadowDir = path.join(options.config.stateDir, 'state', 'cutover-integrity-shadow');
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);
            let stdout: string;
            try {
              ({ stdout } = await execFileAsync(
                process.execPath,
                ['--max-old-space-size=4096', runnerPath],
                {
                  env: { ...process.env, TOKEN: token, BASE_URL: paritySourceCfg.baseUrl!, SHADOW_DIR: shadowDir },
                  maxBuffer: 16 * 1024 * 1024,
                  timeout: 11 * 60 * 1000, // child wall-clock cap, under CutoverReadiness's 12min max-hold
                },
              ));
            } catch (err) {
              // Exit code 1 = ran-but-failed/aborted — the runner STILL printed a valid
              // verdict on stdout (a failing integrity report we must record to flip the
              // door closed). Only a no-verdict crash (exit 2 / killed) is a real error.
              const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
              if (e && typeof e.stdout === 'string' && e.stdout.trim()) {
                stdout = e.stdout;
              } else {
                throw new Error(`integrity-pass runner failed (code ${e?.code ?? '?'}): ${e?.stderr || e?.message || String(err)}`);
              }
            }
            const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
            let verdict: { passed: boolean; imported: ImportRunResult['imported']; abortedPreImport: ImportRunResult['abortedPreImport']; report: ImportRunResult['report'] };
            try {
              verdict = JSON.parse(lastLine);
            } catch {
              throw new Error(`integrity-pass runner produced no parseable verdict (stdout tail: ${lastLine.slice(0, 200)})`);
            }
            return { passed: verdict.passed, imported: verdict.imported, abortedPreImport: verdict.abortedPreImport, report: verdict.report };
          }
          : null;
        const readiness = new CutoverReadiness({
          parityMonitor,
          integrityReportPath: path.join(options.config.stateDir, 'state', 'feedback-integrity-report.json'),
          runParityCheck,
          importDryRunReportPath: path.join(options.config.stateDir, 'state', 'feedback-import-dryrun.json'),
          runImportDryRun: runImportDryRunCheck,
          runIntegrityImport,
        });
        // The REAL resolvers (replacing the former deny-safe stubs): both read
        // durable server-side state; both stay false until that state genuinely
        // clears. The first mandate has no conditioned authority, so behavior is
        // unchanged until an execute-cutover authority is ever issued.
        conditions.register('integrity-gate-pass', () => readiness.integrityStatus().passed);
        conditions.register('parity-zero-divergence', () => {
          const p = readiness.parityStatus();
          return p.cleared && !p.stale;
        });
        this.cutoverReadiness = readiness;
        const gate = new MandateGate({ store, conditions, audit });
        // ReviewExchange (spec §7 G2.3): mutual code-review sign-offs, every
        // signature evaluated through the SAME gate (same audit chain).
        const reviews = new ReviewExchangeEngine({
          filePath: path.join(options.config.stateDir, 'state', 'review-exchanges.json'),
          gate,
        });
        this.coordination = { store, gate, audit, conditions, reviews };

        // WS5.2 R4a — ONE-DASHBOARD cross-machine mandate delivery: the durable store of mandates
        // delivered+verified to THIS machine from the operator machine. Built on the SAME stateDir
        // as the mandate store; it retains the full R4a-signed PortableMandate so the enroll-start
        // route re-verifies at point-of-use. No new authority path — a delivered mandate is trusted
        // ONLY via the R4a asymmetric signature (verified by the mesh handler), never local authorship.
        try {
          this.deliveredMandateStore = new DeliveredMandateStore({
            filePath: path.join(options.config.stateDir, 'state', 'delivered-mandates.json'),
          });
        } catch (dmErr) {
          // @silent-fallback-ok — null leaves the delivered-mandate path inert (enroll-start falls
          // back to deny-by-default), never blocks boot.
          console.warn('[instar] delivered-mandate store init failed (non-fatal):', dmErr);
          this.deliveredMandateStore = null;
        }

        // Operator Authorization Request — agent proposes → operator approves one-tap.
        // Built on the SAME stateDir; the approve route issues grants via `store` above
        // (the existing signed MandateStore), so no new authority path is introduced.
        // `enabled` is dev-gated (enabled-on-dev / dark-on-fleet); routes 503 when off.
        try {
          const arUsers = new UserManager(options.config.stateDir, options.config.users);
          const arStore = new AuthorizationRequestStore({
            filePath: path.join(options.config.stateDir, 'state', 'authorization-requests.json'),
            pendingCapPerAgent: options.config.monitoring?.authorizationRequests?.pendingCapPerAgent,
          });
          const arMachineId = os.hostname();
          this.authorizationRequests = {
            store: arStore,
            enabled: resolveDevAgentGate(options.config.monitoring?.authorizationRequests?.enabled, options.config),
            machineId: arMachineId,
            ownerDisplay: 'operator',
            carrierSelfFp: arMachineId,
            resolvePrincipal: (slackUserId: string) => {
              const u = arUsers.resolveFromSlackUserId(slackUserId);
              return u ? { name: u.name || slackUserId, registered: true } : null;
            },
          };
        } catch (arErr) {
          // @silent-fallback-ok — non-fatal; null leaves the routes 503 (feature-off), never blocks boot.
          console.warn('[instar] authorization-request init failed (non-fatal):', arErr);
          this.authorizationRequests = null;
        }
      }
    } catch (err) {
      // @silent-fallback-ok — reported via console.warn; init failure leaves the engine null → routes 503 (deny-safe), never blocks boot.
      console.warn('[instar] coordination-mandate init failed (non-fatal):', err);
      this.coordination = null;
    }

    // Feedback-inbox drainer (feedback-factory-migration Q2b, Option-B receiving
    // end): the cloud Blob inbox → durable canonical JsonlFeedbackStore mover.
    // Ships DARK — constructed only when feedbackFactory.receiverPersistence is
    // explicitly enabled AND the Blob token env var is set; otherwise the
    // /feedback-inbox/status route 503s. Own try/catch: an init failure here can
    // never block boot (deny-safe null → 503).
    try {
      const rp = options.config.feedbackFactory?.receiverPersistence;
      if (rp?.enabled === true && options.config.stateDir) {
        const tokenEnv = rp.blobTokenEnv ?? 'FEEDBACK_INBOX_BLOB_TOKEN';
        const token = process.env[tokenEnv];
        if (!token) {
          console.warn(`[feedback-inbox] receiverPersistence enabled but env ${tokenEnv} is unset — drainer stays dark`);
        } else {
          const dataDir = rp.dataDir ?? path.join(options.config.stateDir, 'state', 'feedback-factory', 'store');
          const store = new JsonlFeedbackStore(dataDir);
          const client = new BlobInboxClient({ token, apiBase: rp.blobApiBase });
          this.inboxDrainer = new InboxDrainer({
            client,
            store,
            pollIntervalMs: rp.pollIntervalMs,
            log: (msg) => console.log(msg),
          });
          this.inboxDrainer.start();
          console.log(`[feedback-inbox] drainer started (store: ${dataDir})`);
        }
      }
    } catch (err) {
      // @silent-fallback-ok — reported via console.warn; init failure leaves the drainer null → route 503s (deny-safe), never blocks boot.
      console.warn('[feedback-inbox] drainer init failed (non-fatal):', err);
      this.inboxDrainer = null;
    }

    // Feedback-factory PROCESSING trigger (feedback-factory-migration §191: "the
    // processor job is actually constructed and scheduled, not dead code"). Wires
    // the already-parity'd processUnprocessed pass into a real triggerable
    // capability: GET /feedback-factory/stats + POST /feedback-factory/process,
    // driven on a cadence by the feedback-factory-process built-in job. DEV-GATED:
    // `enabled` is OMITTED in ConfigDefaults so resolveDevAgentGate decides — LIVE
    // on a development agent, DARK on the fleet (both routes 503 + the job exits
    // silently when null). Resolves the SAME canonical store dir the InboxDrainer
    // fills. Own try/catch so an init failure can never block boot (deny-safe
    // null → 503).
    try {
      if (resolveDevAgentGate(options.config.feedbackFactory?.processing?.enabled, options.config)) {
        const dataDir = resolveCanonicalStoreDir(options.config);
        if (!dataDir) {
          console.warn('[feedback-factory] processing gate live but no stateDir/dataDir — trigger stays dark');
        } else {
          this.feedbackProcessing = new FeedbackProcessingService({ dataDir });
          console.log(`[feedback-factory] processing trigger live (store: ${dataDir})`);
        }
      }
    } catch (err) {
      // @silent-fallback-ok — reported via console.warn; init failure leaves the service null → routes 503 (deny-safe), never blocks boot.
      console.warn('[feedback-factory] processing trigger init failed (non-fatal):', err);
      this.feedbackProcessing = null;
    }

    // Failure-Learning Loop (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md) — instar
    // self-hosting dev-process forensics. DEV-GATED (CMT-1438): `enabled` is OMITTED
    // from the ConfigDefaults block so the developmentAgent gate decides — LIVE on a
    // dev agent, DARK on the fleet (the inline /failures routes 503-stub via the null
    // ledger when off). D4-verified observe-only at default sub-flags: append-only
    // ledger, ingestion sources all off by default, no auto-send. Toolchain
    // attribution is instar-repo-local (§3 scope). Own try/catch so a failure here
    // can never cascade into the other ledgers' init.
    try {
      if (resolveDevAgentGate(options.config.monitoring?.failureLearning?.enabled, options.config) && options.config.stateDir) {
        this.failureLedger = new FailureLedger({
          dbPath: path.join(options.config.stateDir, 'failure-ledger.db'),
        });
        const tracker = options.initiativeTracker ?? null;
        const projectDir = options.config.projectDir;
        this.failureAttributionEngine = new FailureAttributionEngine({
          getInitiative: (id) => {
            const i = tracker?.get(id);
            if (!i) return null;
            return {
              id: i.id,
              parentProjectId: i.parentProjectId ?? undefined,
              specPath: i.specPath ?? undefined,
              mergeCommitOid: i.mergeCommitOid ?? undefined,
              // coveredFiles (bugfix-commit cross-check) joins from the trace
              // when that ingestion source is wired (later rollout slice).
            };
          },
          commitTouchedFiles: (oid) => {
            try {
              // Read-only git via the SafeGitExecutor funnel (lint-no-direct-destructive).
              // sourceTreeReadOk: this attribution read legitimately runs against
              // the instar source tree on dogfooding agents (Echo). `show` is in
              // SOURCE_TREE_READ_TIER_VERBS — without the flag, SourceTreeGuard
              // silently blocked every attribution lookup on Echo.
              const out = SafeGitExecutor.readSync(['show', '--name-only', '--pretty=format:', oid], {
                cwd: projectDir,
                operation: 'failure-learning:commit-touched-files',
                sourceTreeReadOk: true,
              });
              return out.split('\n').map((s) => s.trim()).filter(Boolean);
            } catch { return []; }
          },
        });

        // Ingestion source: `ci` (spec §3.1). Constructed gated on
        // sources.ci; started in the post-listen callback, stopped on shutdown.
        const sources = options.config.monitoring?.failureLearning?.sources;
        if (sources?.ci === true && this.failureLedger) {
          this.ciFailurePoller = new CiFailurePoller({
            ledger: this.failureLedger,
            resolveByMergeCommit: (oid) => {
              const i = tracker?.findByMergeCommit(oid);
              // `origin` (loop self-exclusion, §4.3) lands with slice 2's origin
              // threading onto Initiative; until then there are no loop-origin
              // initiatives, so the exclusion is correctly inert.
              return i ? { id: i.id, projectId: i.parentProjectId ?? undefined, specPath: i.specPath ?? undefined } : undefined;
            },
            resolveRepo: () => {
              try {
                // sourceTreeReadOk: this resolver legitimately reads the agent's
                // own remote URL on dogfooding agents whose checkout IS the
                // instar source. `remote` is in SOURCE_TREE_READ_TIER_VERBS;
                // without the flag, SourceTreeGuard silently blocked the
                // resolver on Echo and the CI poller never knew which repo to
                // poll.
                const url = SafeGitExecutor.readSync(['remote', 'get-url', 'origin'], {
                  cwd: projectDir,
                  operation: 'failure-learning:ci-resolve-repo',
                  sourceTreeReadOk: true,
                }).trim();
                const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
                return m ? m[1] : null; // validated by REPO_RE inside the poller
              } catch { return null; }
            },
            intervalMs: sources.ciPollMinutes && sources.ciPollMinutes > 0 ? sources.ciPollMinutes * 60_000 : undefined,
            maxRunsPerTick: sources.ciMaxRunsPerTick,
          });
        }

        // Ingestion source: `revert` (spec §3.2). Gated on sources.revert;
        // started post-listen, stopped on shutdown.
        if (sources?.revert === true && this.failureLedger) {
          this.revertDetector = new RevertDetector({
            ledger: this.failureLedger,
            cwd: projectDir,
            resolveByCommit: (oid) => {
              const i = tracker?.findByMergeCommit(oid);
              // `origin` (loop self-exclusion §4.3) arrives with slice 2; inert until then.
              return i ? { id: i.id, projectId: i.parentProjectId ?? undefined, specPath: i.specPath ?? undefined } : undefined;
            },
          });
        }

        // Sources whose CONFIG FLAGS exist but whose IMPLEMENTATIONS have not
        // shipped yet are silent no-ops — turning them on creates a false sense
        // of coverage. Surface that boundary loudly at boot so the operator
        // (and any tier-1 supervisor) sees the gap instead of trusting an
        // invisible-and-broken pipeline. Per the 2026-05-29 pipeline post-mortem:
        // "specced but not wired" was a recurring class behind shipped bugs.
        const unimplementedActive: string[] = [];
        if (sources?.regression === true) unimplementedActive.push('regression');
        if (Array.isArray(sources?.degradation) && sources.degradation.length > 0) unimplementedActive.push('degradation');
        if (unimplementedActive.length > 0) {
          console.warn(
            `[instar] failure-learning: source(s) [${unimplementedActive.join(', ')}] are configured ON ` +
            `but have no implementation yet — they are silent no-ops. ` +
            `Set them back to off (regression: false, degradation: []) until the source impl ships, ` +
            `or you'll have a flag that lies about coverage.`,
          );
        }
      }
    } catch (err) {
      console.warn('[instar] failure-learning init failed (non-fatal):', err);
      this.failureLedger = null;
      this.failureAttributionEngine = null;
      this.ciFailurePoller = null;
      this.revertDetector = null;
    }

    // Correction & Preference Learning Sentinel (docs/specs/CORRECTION-PREFERENCE-
    // LEARNING-SENTINEL-SPEC.md) — Slice 1b ledger. Ships OFF; constructed only
    // when enabled (else the inline /corrections routes 503-stub via the null
    // ledger). SIGNAL-ONLY — never blocks/rewrites an outbound message. Own
    // try/catch so a failure here can never cascade into other init.
    try {
      if (options.config.monitoring?.correctionLearning?.enabled === true && options.config.stateDir) {
        this.correctionLedger = new CorrectionLedger({
          dbPath: path.join(options.config.stateDir, 'correction-ledger.db'),
        });
      }
    } catch (err) {
      console.warn('[instar] correction-learning ledger init failed (non-fatal):', err);
      this.correctionLedger = null;
    }

    // BlockerLedger (docs/specs/AUTONOMY-PRINCIPLES-ENFORCEMENT-SPEC.md, Piece 1)
    // — the resolution-workflow + memory layer completing Principle 1 ("almost
    // every blocker is a false blocker — work it through"). Dev-gated dark feature
    // (DEV_GATED_FEATURES): `enabled` resolves via resolveDevAgentGate — LIVE on a
    // development agent (dogfood), DARK on the fleet (the /blockers routes
    // 503-stub via the null ledger). The `true-blocker` settle judgment routes
    // through the injected Tier-1 B17 authority, built from the shared intelligence
    // provider (fails CLOSED when no provider is available). Own try/catch so an
    // init failure can never cascade into other init.
    try {
      const blockerLedgerEnabled = resolveDevAgentGate(
        options.config.monitoring?.blockerLedger?.enabled,
        options.config,
      );
      if (blockerLedgerEnabled && options.config.stateDir) {
        // The gate can resolve true on a dev agent with no config block at all.
        const bl = options.config.monitoring?.blockerLedger ?? ({} as NonNullable<NonNullable<typeof options.config.monitoring>['blockerLedger']>);
        // "Self-Unblock Before Escalating" (docs/specs/self-unblock-before-escalating.md,
        // §5.1) EXTENDS the ledger (no parallel gate). Its OWN dev-gate resolves
        // independently — when ON, we inject the durable run store so the true-blocker
        // settle DERIVES the failed attempt from a VERIFIED persisted checklist run
        // (a caller-embedded failedAttempt with no run is HARD-rejected). When OFF
        // (the dark default), the store is not injected and BlockerLedger's existing
        // caller-supplied path is unchanged.
        const selfUnblockEnabled = resolveDevAgentGate(
          bl.selfUnblockChecklist?.enabled,
          options.config,
        );
        this.selfUnblockRunStore = selfUnblockEnabled
          ? new SelfUnblockRunStore({ stateDir: options.config.stateDir })
          : null;
        this.blockerLedger = new BlockerLedger({
          stateDir: options.config.stateDir,
          settleAuthority: buildB17SettleAuthority(options.intelligence ?? null),
          selfUnblockRunStore: this.selfUnblockRunStore ?? undefined,
          archiveAfterDays: bl.archiveAfterDays,
          recheckAfterDays: bl.recheckAfterDays,
          maxNoEvidenceResettles: bl.maxNoEvidenceResettles,
          maxFreeTextChars: bl.maxFreeTextChars,
        });

        // The PRODUCER half (docs/specs/self-unblock-before-escalating.md §5):
        // when the self-unblock sub-feature is ON, build the PRODUCTION checklist
        // wired with REAL probe providers + the durable run store. Without this,
        // nothing could PRODUCE a verified run, so settling a credential-blocker
        // was impossible (the gate demands a run that could not be made). The
        // DurableVaultSession is built only when its OWN sub-gate is on (mirrors how
        // the run store is gated) — its deriveSession unlocks the org Bitwarden vault
        // via the existing BitwardenProvider path, reading the master password from
        // the agent's own vault key `bw-master-password` (NO new on-disk secret; if
        // the master pw isn't available, deriveSession returns null and the org-vault
        // probe reports unreachable).
        if (selfUnblockEnabled && this.selfUnblockRunStore) {
          const stateDir = options.config.stateDir;
          const agentName = options.config.projectName;
          const credentialScopeTags = bl.selfUnblockChecklist?.credentialScopeTags;

          // DurableVaultSession is gated on its OWN sub-flag (the §5.3 standing-
          // privilege tradeoff). resolveDevAgentGate so it is LIVE on a dev agent,
          // DARK on the fleet — exactly like the run store.
          const durableVaultEnabled = resolveDevAgentGate(
            bl.durableVaultSession?.enabled,
            options.config,
          );
          let durableVaultSession: DurableVaultSession | undefined;
          if (durableVaultEnabled) {
            const bw = new BitwardenProvider({ agentName });
            durableVaultSession = new DurableVaultSession({
              ttlMs: bl.durableVaultSession?.ttlMs,
              idleMs: bl.durableVaultSession?.idleMs,
              // Derive a fresh org-vault session via the testable helper: read the
              // operator-held master password from the agent's own vault (existing
              // key — no new secret), unlock via BitwardenProvider, and return the
              // live session from getSessionKey() (NOT process.env — unlock() stores
              // it in a private field). Used in-process only; never logged.
              deriveSession: (): string | null =>
                deriveBitwardenSession({
                  getMasterPassword: (): string | null => {
                    const v = new SecretStore({ stateDir }).get('bw-master-password');
                    return typeof v === 'string' && v.length > 0 ? v : null;
                  },
                  bw,
                }),
            });
          }

          // Build the production providers. Vault-key listing is NAMES ONLY (never
          // values); the cloudflare token getter reads an existing vault key. All
          // external access is injected so the checklist stays test-isolated.
          const providers = buildProductionProbeProviders({
            credentialScopeTags,
            durableVaultSession,
            getVaultKeys: (): string[] => {
              try {
                return secretKeyPaths(new SecretStore({ stateDir }).read());
              } catch {
                // @silent-fallback-ok — locked/decrypt-failed vault → no keys (probe unreachable).
                return [];
              }
            },
            getCloudflareToken: (): string | null => {
              try {
                const v = new SecretStore({ stateDir }).get('cloudflare-token');
                return typeof v === 'string' && v.length > 0 ? v : null;
              } catch {
                // @silent-fallback-ok — no token available → cloudflare probe unreachable.
                return null;
              }
            },
          });
          this.selfUnblockChecklist = new SelfUnblockChecklist({
            providers,
            store: this.selfUnblockRunStore,
          });
        }
      }
    } catch (err) {
      // @silent-fallback-ok — reported via console.warn; a blocker-ledger init
      // failure must never block server boot. Leaves the ledger null → /blockers
      // routes 503 (deny-safe), exactly as if the feature were dark.
      console.warn('[instar] blocker-ledger init failed (non-fatal):', err);
      this.blockerLedger = null;
    }

    // GrowthMilestoneAnalyst (docs/specs/PROACTIVE-GROWTH-MILESTONE-ANALYST-SPEC.md)
    // — the proactive growth & milestone analyst. Resolved through the standard
    // developmentAgent dark-feature gate (standard_development_agent_dark_feature_gate):
    // `enabled ?? !!developmentAgent` → LIVE on the dev agent (the dogfooding
    // ground), DARK fleet-wide. An explicit `enabled` in config always wins (set
    // false to force-dark a dev agent, true for the live-fleet flip). When the
    // gate resolves false the analyst stays null and /growth/* routes 503-stub
    // (the "off → 503" contract). Composes the InitiativeTracker (rollout stages
    // + staleness), ApprovalLedger (approve-vs-change), and CorrectionLedger
    // (recurrence) — all read-only. Own try/catch so a failure here can never
    // cascade into other init.
    const growthAnalystEnabled =
      resolveDevAgentGate(options.config.monitoring?.growthAnalyst?.enabled, options.config);
    try {
      if (growthAnalystEnabled && options.config.stateDir && options.initiativeTracker) {
        this.growthMilestoneAnalyst = new GrowthMilestoneAnalyst({
          stateDir: options.config.stateDir,
          // Feed the gate-resolved enabled into settings so GET /growth/status
          // honestly reports `enabled: true` on a dev agent (config omits the
          // flag → resolveGrowthSettings would otherwise read false while the
          // routes are live). Optional-chained: the gate can be true with no
          // monitoring.growthAnalyst block present (dev agent, defaults only).
          settings: resolveGrowthSettings({
            ...(options.config.monitoring?.growthAnalyst ?? {}),
            enabled: growthAnalystEnabled,
          }),
          tracker: options.initiativeTracker,
          approvalLedger: this.approvalLedger,
          correctionLedger: this.correctionLedger,
          // evidenceCounter intentionally unwired in this slice → proof:'unknown'
          // (honest: a feature with no evidence source cannot be promotion-ready).
          // R6 dev-gate conformance: feed the live config so the analyst can flag
          // a registered dev-gated feature observed DARK on this dev agent.
          liveConfig: options.config,
          onError: (where, err) => console.warn(`[GrowthMilestoneAnalyst] ${where}:`, err),
        });
      }
    } catch (err) {
      console.warn('[instar] growth-milestone-analyst init failed (non-fatal):', err);
      this.growthMilestoneAnalyst = null;
    }

    // Dashboard Live-LLM-Insights (docs/specs/dashboard-live-insights.md) — the
    // per-page Insight Strip. Dev-gated dark: `dashboard.liveInsights.enabled` is
    // OMITTED so resolveDevAgentGate resolves it (LIVE on a dev agent, DARK on the
    // fleet; /insights* 503 when null). `dryRun:true` (dev default) is the spend
    // canary — the deterministic floor renders live, the LLM layer is inert until a
    // deliberate dryRun:false. Own try/catch so init can never cascade.
    const liveInsightsEnabled = resolveDevAgentGate(
      options.config.dashboard?.liveInsights?.enabled,
      options.config,
    );
    try {
      if (liveInsightsEnabled) {
        const li = options.config.dashboard?.liveInsights ?? {};
        const pages = buildBuiltinInsightPages({ featureMetricsLedger: this.featureMetricsLedger });
        this.dashboardInsightEngine = new DashboardInsightEngine({
          pages,
          intelligence: options.intelligence ?? null,
          enabled: liveInsightsEnabled,
          dryRun: li.dryRun ?? true,
          ttlMs: (li.ttlSeconds ?? 300) * 1000,
          maxLines: li.maxLines ?? 3,
          llmTimeoutMs: li.llmTimeoutMs ?? 12000,
          recordEvent: (outcome, page) =>
            this.featureMetricsLedger?.record({ feature: 'dashboard-insights', kind: 'event', outcome, verdictId: page }),
          logger: (line) => console.log(line),
        });
      }
    } catch (err) {
      console.warn('[instar] dashboard-insight-engine init failed (non-fatal):', err);
      this.dashboardInsightEngine = null;
    }

    // GrowthDigestPublisher (Slice 2 — docs/specs/PROACTIVE-GROWTH-DIGEST-PUBLISHER-SLICE2-SPEC.md)
    // — the cadence + delivery VOICE for the analyst above. Constructed ONLY when
    // the analyst exists AND digestDelivery !== 'off' (the default 'off' means
    // merging the code sends nothing). Lease-gated so only the awake machine sends
    // (an in-process cron runs on BOTH the awake and standby machine — §3.7). The
    // guarded sender (postToUpdatesTopic) is attached later at route registration,
    // so the publisher can never reach sendToTopic without the shared
    // evaluateOutbound funnel. Own try/catch so an init failure can never cascade.
    const digestDelivery = options.config.monitoring?.growthAnalyst?.digestDelivery ?? 'off';
    try {
      if (this.growthMilestoneAnalyst && digestDelivery !== 'off' && options.config.stateDir) {
        const analyst = this.growthMilestoneAnalyst;
        const stateRoot = options.config.stateDir;
        const auditSink = createGrowthDigestAuditSink(stateRoot);
        const supersededJobPath = path.join(stateRoot, 'jobs', 'schedule', 'initiative-digest-review.json');
        this.growthDigestPublisher = new GrowthDigestPublisher({
          buildDigest: (now) => analyst.buildDigest(now),
          cron: options.config.monitoring?.growthAnalyst?.digestCron ?? '0 11 * * 1',
          timezone: options.config.monitoring?.growthAnalyst?.digestTimezone,
          mode: digestDelivery,
          sendOnCalmWeeks: options.config.monitoring?.growthAnalyst?.digestSendOnCalmWeeks === true,
          // Multi-machine lease gate. MultiMachineCoordinator.isAwake is a GETTER
          // (not a method); the single-machine no-op keys on `.enabled`, matching
          // the server.ts scheduler / ActivitySentinel precedents.
          isAwake: () => (options.coordinator?.enabled ? options.coordinator.isAwake : true),
          audit: auditSink.write,
          recordedWindows: auditSink.recordedWindows,
          // §3.5 belt: a SIGNAL (never a mutation) on a live send while the
          // superseded initiative-digest-review job is still enabled. The durable
          // supersede flips the SOURCE template at the live-flip (a later change);
          // this read is the awareness backstop. Enabled flag lives in the
          // schedule manifest (the update-preserved one), not the .md template.
          supersededJobStillEnabled: () => {
            try {
              const m = JSON.parse(fs.readFileSync(supersededJobPath, 'utf-8')) as { enabled?: boolean };
              return m.enabled === true;
            } catch {
              // @silent-fallback-ok — a missing/unreadable supersede manifest is an
              // expected state (no job installed); not-conflicting is the correct
              // read, not a degradation. The belt is a one-time awareness signal only.
              return false;
            }
          },
          onError: (where, err) => console.warn(`[GrowthDigestPublisher] ${where}:`, err),
        });
        this.growthDigestPublisher.start(); // sender attached at route registration
      }
    } catch (err) {
      // @silent-fallback-ok — mirrors the sibling component-init guards above; the
      // publisher is a non-critical observe-only-derived component, so nulling it on
      // an init failure (logged here) is the safe direction, never a degradation.
      console.warn('[instar] growth-digest-publisher init failed (non-fatal):', err);
      this.growthDigestPublisher = null;
    }

    // Apprenticeship Program (Step 1) — the instance-as-project registry + the
    // retro-gate (pending→active) and doc-as-required-artifact gate
    // (active→complete). Ships ON (additive, passive registry; no config flag —
    // spec §6). Own try/catch so a failure here can never cascade into other
    // init. The live ledger-count dep is instance-scoped: it counts framework
    // issues whose relatedSpec/dedupKey references THIS instance (never merely
    // any framework entry), so unrelated history can't satisfy the doc-gate.
    try {
      if (options.config.stateDir) {
        const frameworkLedger = this.frameworkIssueLedger;
        this.apprenticeshipProgram = new ApprenticeshipProgram({
          stateDir: options.config.stateDir,
          projectDir: options.config.projectDir,
          deps: {
            countInstanceLedgerEntries: (instance) => {
              if (!frameworkLedger) return 0;
              try {
                const rows = frameworkLedger.listIssues({ framework: instance.framework });
                return rows.filter(
                  (r) =>
                    (r.relatedSpec && r.relatedSpec.includes(instance.id)) ||
                    (r.dedupKey && r.dedupKey.includes(instance.id)),
                ).length;
              } catch {
                return 0;
              }
            },
            detectorAuditExists: (instance) => {
              // The instance-scoped detector-audit artifact (need-003). Run in
              // Step 2/3; the gate checks for its presence on disk.
              try {
                const auditPath = path.join(
                  options.config.stateDir!,
                  'apprenticeship',
                  'detector-audits',
                  `${instance.id}.json`,
                );
                return fs.existsSync(auditPath);
              } catch {
                return false;
              }
            },
          },
        });
      }
    } catch (err) {
      console.warn('[instar] apprenticeship program init failed (non-fatal):', err);
      this.apprenticeshipProgram = null;
    }

    // Apprenticeship differential-cycle capture — durable, queryable records for
    // mentee output → mentor flags → overseer differential → coaching. Ships ON
    // whenever stateDir exists; route layer returns 503 if this store fails.
    try {
      if (options.config.stateDir) {
        const serverDataDir = path.join(options.config.stateDir, 'server-data');
        fs.mkdirSync(serverDataDir, { recursive: true });
        this.apprenticeshipCycleStore = new ApprenticeshipCycleStore({
          dbPath: path.join(serverDataDir, 'apprenticeship-cycles.db'),
        });
      }
    } catch (err) {
      console.warn('[instar] apprenticeship cycle store init failed (non-fatal):', err);
      this.apprenticeshipCycleStore = null;
    }

    // Apprenticeship overdue-cycle SLA signal — observe-only and ships OFF.
    // When enabled, it rides TokenLedgerPoller's existing cadence via afterTick;
    // it never owns a timer and never mutates the cycle store.
    try {
      const cfg = options.config.monitoring?.apprenticeshipCycleSla;
      if (cfg?.enabled === true && this.apprenticeshipCycleStore) {
        const telegram = this.telegramAdapter;
        this.apprenticeshipCycleSlaMonitor = new ApprenticeshipCycleSlaMonitor({
          store: this.apprenticeshipCycleStore,
          config: cfg,
          raiseAttention: telegram
            ? (item) => telegram.createAttentionItem(item)
            : undefined,
        });
      }
    } catch (err) {
      console.warn('[instar] apprenticeship cycle SLA monitor init failed (non-fatal):', err);
      this.apprenticeshipCycleSlaMonitor = null;
    }

    // Gemini long-capacity-block escalation — observe-only, ships OFF. Reads the
    // capacity gate module-global; rides the same afterTick cadence below; never
    // mutates the gate or blocks a call.
    try {
      const cfg = options.config.monitoring?.geminiCapacityEscalation;
      if (cfg?.enabled === true) {
        const telegram = this.telegramAdapter;
        this.geminiCapacityEscalationMonitor = new GeminiCapacityEscalationMonitor({
          config: cfg,
          raiseAttention: telegram
            ? (item) => telegram.createAttentionItem(item)
            : undefined,
        });
      }
    } catch (err) {
      console.warn('[instar] gemini capacity escalation monitor init failed (non-fatal):', err);
      this.geminiCapacityEscalationMonitor = null;
    }

    // ── Model-Tier Escalation (FABLE-MODEL-ESCALATION-SPEC §5.3/§7/§8) ──
    // Always constructed (cheap, file-backed, inert while enabled:false) so
    // the swap route is ALIVE on the production init path — the feature
    // gates itself via config, never via missing wiring. Worst-case failure
    // of any piece here = sessions stay on their default model (§3.5).
    try {
      const teConfig = () =>
        normalizeTierEscalationConfig(
          (options.config as { models?: { tierEscalation?: unknown } }).models?.tierEscalation,
        );
      const escalationGovernor = new EscalationGovernor({
        stateDir: options.config.stateDir,
        getConfig: teConfig,
        // CACHED quota snapshot only (§7 — never a live poll). For a session
        // pinned to a pool account, that account's snapshot; otherwise the
        // freshest cached snapshot in the pool. No pool / no snapshot ⇒ null
        // ⇒ fail closed when requireQuotaHeadroom.
        quotaSnapshot: (accountId) => {
          const pool = options.subscriptionPool ?? null;
          if (!pool) return null;
          if (accountId !== 'default') return pool.get(accountId)?.lastQuota ?? null;
          const snapshots = pool
            .list()
            .map((a) => a.lastQuota)
            .filter((q): q is NonNullable<typeof q> => q != null);
          if (snapshots.length === 0) return null;
          snapshots.sort((a, b) => (b.measuredAt ?? '').localeCompare(a.measuredAt ?? ''));
          return snapshots[0];
        },
        // §8 daily-cap admission input: today's (UTC) ultra-model spend from
        // the read-only token ledger. Ledger absent ⇒ null ⇒ fail closed
        // when a cap is configured.
        ultraTokensTodayUtc: () => {
          const ledger = this.tokenLedger;
          if (!ledger) return null;
          const ultraIds = [...escalatedModelIds(teConfig())];
          if (ultraIds.length === 0) return 0;
          try {
            return ledger.tokensByModelSince(ultraIds, startOfUtcDayMs(Date.now()));
          } catch {
            // @silent-fallback-ok: a ledger read error ⇒ null ⇒ the §8 daily-cap
            // admission fails CLOSED (conservative — denies escalation when a cap
            // is configured), exactly as a missing ledger does. Never crashes init.
            return null;
          }
        },
        // Lease reclaim probe: the holder's session record must still be
        // running. Unknown id ⇒ not live ⇒ reclaimable (TTL also bounds it).
        isHolderLive: (instanceId) => {
          try {
            return options.sessionManager
              .listRunningSessions()
              .some((s) => s.id === instanceId);
          } catch {
            // @silent-fallback-ok: a liveness-probe error ⇒ keep the lease
            // (conservative — never reclaims on a transient error); the lease's
            // TTL still bounds it, so a genuinely dead holder is reclaimed anyway.
            return true;
          }
        },
      });
      // TOPIC-PROFILE-SPEC §9: expose the governor so the orchestrator's
      // escalation port (server.ts wiring) can release a profile-killed
      // session's lease BEFORE expected-live is computed.
      this.escalationGovernorRef = escalationGovernor;
      // WS5.3 — the ephemeral hint carrier, file-backed alongside the governor
      // state. Inert until tierEscalation.ridesTopic is on (the route + resume
      // seams gate on the live config); constructing it unconditionally keeps
      // the wiring present so the feature is config-gated, not wiring-gated.
      this.escalationHints = new EscalationHintStore({
        filePath: path.join(options.config.stateDir, 'state', 'model-tier-escalation', 'rides-topic-hints.json'),
      });
      // §7: release the lease on the SAME close event that retires the
      // session (the reap-log emit) — crash-safe alongside TTL + liveness.
      options.sessionManager.on(
        'sessionReaped',
        (e: { session: { id: string } }) => {
          try {
            escalationGovernor.releaseLease(e.session.id);
          } catch { /* @silent-fallback-ok: a release error is non-fatal — the lease is lazy-reclaimable via TTL + liveness probe, so the next escalation reclaims it regardless. */ }
        },
      );
      const telegramForSwap = this.telegramAdapter;
      // swap-unconfirmed routes to the maturation-track audit breadcrumb, not
      // Attention (TOPIC-PROFILE-SPEC §11/§14 — maturing-feature-health-no-alerts).
      this.modelTierSwap = new ModelSwapService({
        stateDir: options.config.stateDir,
        sessions: options.sessionManager,
        saveSession: (s) => options.state.saveSession(s),
        protectedSessions: () => options.sessionManager.getProtectedSessions(),
        getConfig: teConfig,
        governor: escalationGovernor,
        // TOPIC-PROFILE-SPEC §9 — the server-side pin consult (in-memory,
        // O(1)). NOT gated by topicProfiles.enabled: honor-on-read covers the
        // escalation arm (§5.2(c) — disabling the feature must not silently
        // flip a "never escalate this topic" into 2x-cost escalation).
        topicProfileConsult: (session) => {
          const tp = options.topicProfile;
          const tg = telegramForSwap;
          if (!tp || !tg) return null;
          const topicId = tg.getTopicForSession(session.tmuxSession);
          if (topicId == null) return null;
          const resolved = tp.resolver.resolve(topicId);
          // Only a PIN counts as the topic baseline (§9 round-4): a model
          // sourced from config defaults is not operator intent — tier:
          // 'default' then falls to FABLE's global default as today.
          const pinned =
            resolved.sources.model === 'profile-pin' || resolved.sources.model === 'profile-tier-pin';
          return {
            suppressEscalation: resolved.escalationOverride === 'suppress',
            baselineModel: pinned ? resolved.model ?? null : null,
          };
        },
        // swap-continuity-antithrash §4.2/Q5 — the model-swap SUBAGENT idle
        // leg. Only consulted when `subagentIdleLeg` is true (concrete default
        // false — dark; graduates on its own rung, spec §10 rung 3a). A
        // missing claudeSessionId is 'absent' (R5-M1: behaves like a failed
        // probe — refuse, never a blind swap under live background subagents).
        subagentLegProbe: (session) => {
          const tracker = options.subagentTracker;
          if (!tracker) return 'indeterminate';
          const id = session.claudeSessionId ?? null;
          if (!id) return 'absent';
          try {
            return tracker.hasActiveSubagents(id) ? 'active' : 'idle';
          } catch {
            return 'indeterminate';
          }
        },
      });
      // §8 mid-run cap monitor — rides BurnDetector's tick (constructed in
      // setupTokenLedgerObservability; the field is read there).
      this.ultraCapMonitor = new UltraSessionCapMonitor({
        ledger: this.tokenLedger,
        listRunningSessions: () => options.sessionManager.listRunningSessions(),
        getConfig: teConfig,
        attention: telegramForSwap
          ? (item) => telegramForSwap.createAttentionItem(item)
          : undefined,
      });
    } catch (err) {
      // @silent-fallback-ok: cascade-isolation — a model-tier init failure must never 503 the server; the feature degrades to no-escalation (default model) and re-attempts on the next boot.
      console.warn('[instar] model-tier escalation init failed (non-fatal):', err);
      this.modelTierSwap = null;
      this.ultraCapMonitor = null;
      this.escalationGovernorRef = null;
      this.escalationHints = null;
    }

    // Dynamic MCP Lifecycle (DYNAMIC-MCP-LIFECYCLE-SPEC) — build the composition
    // service with the host's REAL primitives. Dark by default (the explicit
    // sessions.dynamicMcp.enabled flag; flips to the dev-gate once the full
    // load-on-demand + offload path is complete + the live-as-operator proof
    // passes). Fail-safe: a construction error ⇒ null ⇒ the /mcp/* routes 503.
    // The FULL lifecycle is wired: load (restart via SessionRefresh, isPreapproved
    // via the autonomous registry) AND offload (real heavy-child PID capture via the
    // reaper deps + reap-after-restart; mid-tool-use via the live pane frame).
    const dynamicMcpService = ((): import('../core/DynamicMcpService.js').DynamicMcpService | null => {
      try {
        const tg = options.telegram ?? null;
        const sr = options.sessionRefresh ?? null;
        const stateDir = options.config.stateDir;
        const sm = options.sessionManager;
        const framework = options.config.sessions?.framework ?? 'claude-code';
        // Reaper deps (real ps-based MCP-process listing + tmux pane map + kill),
        // built once and reused for the offload capture-then-reap (C1).
        const reaperDeps = makeMcpProcessReaperDeps({
          sessionManager: sm,
          tmuxPath: options.config.sessions?.tmuxPath ?? 'tmux',
          auditPath: stateDir ? path.join(stateDir, '..', 'logs', 'mcp-reaper-audit.jsonl') : '/dev/null',
        });
        const MAX_HOPS = 12;
        return new DynamicMcpService({
          projectDir: options.config.projectDir,
          enabled: () => options.config.sessions?.dynamicMcp?.enabled === true,
          config: () => options.config.sessions?.dynamicMcp,
          restart: async (topicId: number) => {
            const sessionName = tg?.getSessionForTopic(topicId) ?? null;
            if (!sessionName || !sr) return { ok: false, code: 'not_telegram_bound' };
            const r = await sr.refreshSession({ sessionName, reason: 'dynamic-mcp change' });
            return r.ok ? { ok: true } : { ok: false, code: r.code };
          },
          isPreapproved: (topicId: number) => {
            try { return !!stateDir && activeAutonomousJobs(stateDir).some((j) => String(j.topic) === String(topicId)); }
            catch { return false; } // fail-closed
          },
          captureHeavyPids: (topicId: number, server: string) => {
            try {
              const sessionName = tg?.getSessionForTopic(topicId) ?? null;
              if (!sessionName) return [];
              return captureHeavyMcpPidsForSession({
                sessionName, server,
                procs: reaperDeps.listMcpProcesses(),
                tree: reaperDeps.getProcessTree(),
                paneMap: reaperDeps.getTmuxPaneMap(),
                maxHops: MAX_HOPS,
              });
            } catch { return []; } // fail-safe: capture nothing rather than risk a wrong kill
          },
          reapPids: (pids: number[]) => {
            for (const pid of pids) { try { reaperDeps.killProcess(pid); } catch { /* best-effort reclaim */ } }
          },
          isMidToolUse: (topicId: number) => {
            try {
              const sessionName = tg?.getSessionForTopic(topicId) ?? null;
              if (!sessionName) return null;            // can't resolve ⇒ null ⇒ offload aborts (fail-closed)
              const frame = sm.captureOutput(sessionName, 40);
              if (frame == null) return null;           // can't capture ⇒ fail-closed
              return looksActivelyWorking(frame, framework);
            } catch { return null; }
          },
        });
      } catch { return null; }
    })();

    // Dynamic MCP idle-offload sweep — the automatic "offload a heavy server once
    // it's been idle a while" trigger. Dark + dryRun-first: it only runs when BOTH
    // sessions.dynamicMcp.enabled AND .sweep.enabled, and dryRun defaults true (logs
    // "would offload" without acting). Fail-safe: any construction error ⇒ no sweep.
    try {
      const sweepCfg = options.config.sessions?.dynamicMcp?.sweep;
      const featureEnabled = options.config.sessions?.dynamicMcp?.enabled === true;
      if (dynamicMcpService && featureEnabled && sweepCfg?.enabled === true) {
        const tg = options.telegram ?? null;
        const sm = options.sessionManager;
        const stateDir = options.config.stateDir;
        const framework = options.config.sessions?.framework ?? 'claude-code';
        const keepWarm = new Set(options.config.sessions?.dynamicMcp?.keepWarm ?? []);
        const sweepDeps = makeMcpProcessReaperDeps({
          sessionManager: sm,
          tmuxPath: options.config.sessions?.tmuxPath ?? 'tmux',
          auditPath: stateDir ? path.join(stateDir, '..', 'logs', 'mcp-reaper-audit.jsonl') : '/dev/null',
        });
        const sigToServer = new Map(Object.entries(MCP_SERVER_NAME_TO_SIGNATURE).map(([name, sig]) => [sig, name]));
        const MAX_HOPS = 12;
        const sweep = new McpIdleOffloadSweep(
          {
            listHeavyLiveMcpProcs: (): HeavyLiveMcpProc[] => {
              const procs = sweepDeps.listMcpProcesses();
              const tree = sweepDeps.getProcessTree();
              const paneMap = sweepDeps.getTmuxPaneMap();
              const out: HeavyLiveMcpProc[] = [];
              for (const p of procs) {
                if (!isHeavyMcpSignature(p.signatureId)) continue;
                const sessionName = resolveOwningSession(p.pid, tree, paneMap, MAX_HOPS);
                if (sessionName) out.push({ pid: p.pid, signatureId: p.signatureId, sessionName });
              }
              return out;
            },
            sessionToTopic: (sessionName) => tg?.getTopicForSession(sessionName) ?? null,
            signatureToServer: (sig) => sigToServer.get(sig) ?? null,
            isMidToolUse: (sessionName) => {
              try { const f = sm.captureOutput(sessionName, 40); return f == null ? null : looksActivelyWorking(f, framework); }
              catch { return null; }
            },
            isKeepWarm: (server) => keepWarm.has(server),
            requestOffload: (topicId, server) => dynamicMcpService.requestOffload(topicId, server, { kind: 'agent' }),
            now: () => Date.now(),
            log: (msg) => console.log(msg),
          },
          {
            enabled: true,
            idleOffloadMs: sweepCfg.idleOffloadMs ?? 30 * 60 * 1000,
            dryRun: sweepCfg.dryRun !== false, // default true
          },
        );
        const intervalMs = sweepCfg.intervalMs ?? 5 * 60 * 1000;
        this.mcpIdleOffloadSweepTimer = setInterval(() => { void sweep.tick().catch(() => undefined); }, intervalMs);
        if (typeof this.mcpIdleOffloadSweepTimer.unref === 'function') this.mcpIdleOffloadSweepTimer.unref();
      }
    } catch { /* sweep is best-effort; a wiring fault never breaks boot */ }

    // Routes
    const routeCtx = {
      config: options.config,
      sessionManager: options.sessionManager,
      state: options.state,
      scheduler: options.scheduler ?? null,
      dynamicMcpService,
      // SelfActionGovernor (unified-self-action-backpressure Increment B):
      // the module-level core — process-global anchored, so this is the SAME
      // instance server boot initialized (or an uninitialized core reporting
      // `initialized: false` honestly on a build that never wired it).
      selfActionGovernor: getSelfActionGovernor(),
      telegram: options.telegram ?? null,
      relationships: options.relationships ?? null,
      feedback: options.feedback ?? null,
      dispatches: options.dispatches ?? null,
      updateChecker: options.updateChecker ?? null,
      autoUpdater: options.autoUpdater ?? null,
      autoDispatcher: options.autoDispatcher ?? null,
      quotaTracker: options.quotaTracker ?? null,
      publisher: options.publisher ?? null,
      viewer: options.viewer ?? null,
      tunnel: options.tunnel ?? null,
      evolution: options.evolution ?? null,
      watchdog: options.watchdog ?? null,
      triageNurse: options.triageNurse ?? null,
      topicMemory: options.topicMemory ?? null,
      feedbackAnomalyDetector: options.feedbackAnomalyDetector ?? null,
      projectMapper: options.projectMapper ?? null,
      cartographer: options.cartographer ?? null,
      coherenceGate: options.coherenceGate ?? null,
      contextHierarchy: options.contextHierarchy ?? null,
      canonicalState: options.canonicalState ?? null,
      operationGate: options.operationGate ?? null,
      sentinel: options.sentinel ?? null,
      adaptiveTrust: options.adaptiveTrust ?? null,
      memoryMonitor: options.memoryMonitor ?? null,
      orphanReaper: options.orphanReaper ?? null,
      coherenceMonitor: options.coherenceMonitor ?? null,
      commitmentTracker: options.commitmentTracker ?? null,
      prHandLease: options.prHandLease ?? null,
      subscriptionPool: options.subscriptionPool ?? null,
      accountFollowMePeerViews: options.accountFollowMePeerViews,
      quotaPoller: options.quotaPoller ?? null,
      quotaAwareScheduler: options.quotaAwareScheduler ?? null,
      proactiveSwapMonitor: options.proactiveSwapMonitor,
      inUseAccountResolver: options.inUseAccountResolver,
      enrollmentWizard: options.enrollmentWizard ?? null,
      accountFollowMeRevocation: options.accountFollowMeRevocation ?? null,
      credentialRepointing: options.credentialRepointing ?? null,
      semanticMemory: options.semanticMemory ?? null,
      activitySentinel: options.activitySentinel ?? null,
      rateLimitSentinel: options.rateLimitSentinel ?? null,
      releaseReadinessSentinel: options.releaseReadinessSentinel ?? null,
      greenPrAutoMerger: options.greenPrAutoMerger ?? null,
      guardLatchStore: options.guardLatchStore ?? null,
      workingMemory: options.workingMemory ?? null,
      quotaManager: options.quotaManager ?? null,
      messageRouter: options.messageRouter ?? null,
      summarySentinel: options.summarySentinel ?? null,
      spawnManager: options.spawnManager ?? null,
      systemReviewer: options.systemReviewer ?? null,
      capabilityMapper: options.capabilityMapper ?? null,
      selfKnowledgeTree: options.selfKnowledgeTree ?? null,
      coverageAuditor: options.coverageAuditor ?? null,
      topicResumeMap: options.topicResumeMap ?? null,
      topicProfile: options.topicProfile ?? null,
      sessionRefresh: options.sessionRefresh ?? null,
      modelTierSwap: this.modelTierSwap,
      escalationHints: this.escalationHints,
      autonomyManager: options.autonomyManager ?? null,
      trustElevationTracker: options.trustElevationTracker ?? null,
      autonomousEvolution: options.autonomousEvolution ?? null,
      whatsapp: options.whatsapp ?? null,
      slack: options.slack ?? null,
      imessage: options.imessage ?? null,
      messageBridge: options.messageBridge ?? null,
      hookEventReceiver: options.hookEventReceiver ?? null,
      worktreeMonitor: options.worktreeMonitor ?? null,
      subagentTracker: options.subagentTracker ?? null,
      instructionsVerifier: options.instructionsVerifier ?? null,
      threadlineRouter: options.threadlineRouter ?? null,
      conversationStore: options.conversationStore,
      threadLog: options.threadLog,
      threadMessageRecorder: options.threadMessageRecorder,
      warrantsReplyGate: options.warrantsReplyGate,
      collaborationSurfacer: options.collaborationSurfacer,
      threadResumeMap: options.threadResumeMap ?? null,
      topicLinkageHandler: options.topicLinkageHandler ?? null,
      handshakeManager: options.handshakeManager ?? null,
      threadlineRelayClient: options.threadlineRelayClient ?? null,
      listenerManager: options.listenerManager ?? null,
      a2aDeliveryTracker: options.a2aDeliveryTracker ?? this.a2aDeliveryTracker,
      responseReviewGate: options.responseReviewGate ?? null,
      reviewCanaryBattery: options.reviewCanaryBattery ?? null,
      messagingToneGate: options.messagingToneGate ?? null,
      // Live-config READ handle — routes that must honor config flips without
      // a restart (outbound-advisory rollback contract, spec
      // outbound-jargon-filepath-gap §5) read through this. Absent on older
      // callers/tests → consumers fall back to code defaults (feature on).
      liveConfig:
        typeof options.liveConfig?.get === 'function'
          ? { get: options.liveConfig.get.bind(options.liveConfig) }
          : null,
      topicIntentArcCheck: options.topicIntentArcCheck ?? null,
      usherSignalStore: options.usherSignalStore ?? null,
      outboundDedupGate: options.outboundDedupGate ?? null,
      telemetryHeartbeat: options.telemetryHeartbeat ?? null,
      pasteManager: options.pasteManager ?? null,
      wsManager: null, // Set after WebSocket manager is initialized
      soulManager: options.soulManager ?? null,
      featureRegistry: options.featureRegistry ?? null,
      discoveryEvaluator: options.discoveryEvaluator ?? null,
      completionEvaluator: options.completionEvaluator ?? null,
      liveTestGate: options.liveTestGate ?? null,
      liveTestGateMode: options.liveTestGateMode ?? 'dry-run',
      liveTestRunnerCtx: options.liveTestRunnerCtx ?? null,
      unifiedTrust: options.unifiedTrust ?? null,
      threadlineReplyWaiters: options.threadlineReplyWaiters ?? new Map(),
      proxyCoordinator: options.proxyCoordinator ?? null,
      sharedStateLedger: options.sharedStateLedger ?? null,
      ledgerSessionRegistry: options.ledgerSessionRegistry ?? null,
      unjustifiedStopGate: options.unjustifiedStopGate ?? null,
      stopGateDb: options.stopGateDb ?? null,
      stopNotifier: options.stopNotifier ?? null,
      initiativeTracker: options.initiativeTracker ?? null,
      projectRoundRunner: options.projectRoundRunner ?? null,
      projectDriftChecker: options.projectDriftChecker ?? null,
      machineHeartbeat: options.machineHeartbeat ?? null,
      tokenLedger: this.tokenLedger,
      featureMetricsLedger: this.featureMetricsLedger,
      benchmarkDivergenceAnalyzer: this.benchmarkDivergenceAnalyzer,
      routingPriceAuthority: this.routingPriceAuthority,
      meteredSpendLedger: this.meteredSpendLedger,
      routingSpendCapsStore: this.routingSpendCapsStore,
      meteredSpendGate: this.meteredSpendGate,
      spendPlanStore: this.spendPlanStore,
      pinAttemptStore: this.pinAttemptStore,
      providerCostReportStore: this.providerCostReportStore,
      resourceLedger: this.resourceLedger,
      processFootprintMonitor: this.processFootprintMonitor,
      approvalLedger: this.approvalLedger,
      topicOperatorStore: this.topicOperatorStore,
      coordination: this.coordination,
      deliveredMandateStore: this.deliveredMandateStore,
      // WS5.2 R4a — operator side: package an issued mandate with the asymmetric issuance signature
      // using THIS machine's Ed25519 identity key + fingerprint (meshSelfId). Null when no mesh
      // identity (single-machine) — the issue-for-machine route then 503s on a remote target.
      packageMandateForDelivery: (() => {
        const pem = options.localSigningKeyPem;
        const selfId = options.meshSelfId;
        if (!pem || !selfId) return null;
        return (mandate: import('../coordination/types.js').CoordinationMandate) => {
          const priv = createPrivateKey(pem);
          return packageMandateForDelivery(mandate, selfId, priv);
        };
      })(),
      deliverMandateToMachine: options.deliverMandateToMachine ?? null,
      // WS5.2 R4a — target side: re-verify a DELIVERED mandate AT POINT OF USE against the operator
      // key recorded at delivery (defense-in-depth; never trust a stored flag). Returns the verified
      // account-follow-me bounds, or null on any failure (fail-closed).
      verifyDeliveredMandate: this.deliveredMandateStore
        ? (mandateId: string) => {
            const record = this.deliveredMandateStore!.get(mandateId);
            if (!record) return null;
            const accept = acceptDeliveredMandate({
              portable: record.portable,
              operatorEd25519PublicKey: record.operatorPublicKeyPem,
              expectedOperatorMachineFingerprint: record.deliveredBy,
            });
            if (!accept.accepted) return null;
            return readFollowMeBounds(accept.mandate);
          }
        : null,
      authorizationRequests: this.authorizationRequests,
      cutoverReadiness: this.cutoverReadiness,
      inboxDrainer: this.inboxDrainer,
      feedbackProcessing: this.feedbackProcessing,
      parallelActivityIndex: this.parallelActivityIndex,
      frameworkIssueLedger: this.frameworkIssueLedger,
      mentorRunner: this.mentorRunner,
      dashboardInsightEngine: this.dashboardInsightEngine,
      failureLedger: this.failureLedger,
      failureAttributionEngine: this.failureAttributionEngine,
      correctionLedger: this.correctionLedger,
      blockerLedger: this.blockerLedger,
      selfUnblockRunStore: this.selfUnblockRunStore,
      selfUnblockChecklist: this.selfUnblockChecklist,
      growthMilestoneAnalyst: this.growthMilestoneAnalyst,
      growthDigestPublisher: this.growthDigestPublisher,
      apprenticeshipProgram: this.apprenticeshipProgram,
      apprenticeshipCycleStore: this.apprenticeshipCycleStore,
      apprenticeshipPeerCycleReader: options.apprenticeshipPeerCycleReader ?? ((instanceId: string) =>
        readApprenticeshipPeerCycles(instanceId, {
          selfAgent: options.config.projectName,
          listAgents,
          getAgentToken,
        })),
      apprenticeshipCycleSlaMonitor: this.apprenticeshipCycleSlaMonitor,
      geminiCapacityEscalationMonitor: this.geminiCapacityEscalationMonitor,
      sessionReaper: options.sessionReaper ?? null,
      agentWorktreeReaper: options.agentWorktreeReaper ?? null,
      externalHogSentinel: options.externalHogSentinel ?? null,
      orphanedWorkSentinel: options.orphanedWorkSentinel ?? null,
      mcpProcessReaper: options.mcpProcessReaper ?? null,
      geminiLoopRunner: options.geminiLoopRunner ?? null,
      sleepController: options.sleepController ?? null,
      agentActivityState: options.agentActivityState ?? null,
      reapLog: options.reapLog ?? null,
      resumeQueue: options.resumeQueue ?? null,
      resumeDrainer: options.resumeDrainer ?? null,
      autonomousLivenessReconciler: options.autonomousLivenessReconciler ?? null,
      enforcedTerminationStatus: options.enforcedTerminationStatus ?? null,
      operatorStopRecorder: options.operatorStopRecorder ?? null,
      sleepWakeDetector: options.sleepWakeDetector ?? null,
      telegramBridgeConfig: options.telegramBridgeConfig ?? null,
      telegramBridge: options.telegramBridge ?? null,
      threadlineObservability: options.threadlineObservability ?? null,
      briefDeps: options.briefDeps ?? null,
      taskFlowRegistry: options.taskFlowRegistry ?? null,
      threadlineFlowBridge: options.threadlineFlowBridge ?? null,
      coordinator: options.coordinator ?? null,
      machinePoolRegistry: options.machinePoolRegistry ?? null,
      getInboundQueue: options.getInboundQueue ?? null,
      getMachineCoherence: options.getMachineCoherence ?? null,
      meshRpcDispatcher: options.meshRpcDispatcher ?? null,
      workingSetPullCoordinator: options.workingSetPullCoordinator ?? null,
      workingSetArtifactManager: options.workingSetArtifactManager ?? null,
      orchestratorPoller: options.orchestratorPoller ?? null,
      commitmentReplicaStore: options.commitmentReplicaStore ?? null,
      preferenceReplicaStore: options.preferenceReplicaStore ?? null,
      replicatedRecordEmitter: options.replicatedRecordEmitter ?? null,
      conflictStore: options.conflictStore ?? null,
      rollbackUnmerge: options.rollbackUnmerge ?? null,
      droppedOriginRegistry: options.droppedOriginRegistry ?? null,
      preferencesUnionReader: options.preferencesUnionReader ?? null,
      forwardCommitmentMutate: options.forwardCommitmentMutate ?? null,
      sessionOwnershipRegistry: options.sessionOwnershipRegistry ?? null,
      topicPinStore: options.topicPinStore ?? null,
      // Durable conversation identity: the bootstrap's fully-wired instance
      // (workspace source, attention, live kill-switch) takes precedence; the
      // fallback keeps the READ surface alive on any init path that predates
      // the bootstrap wiring (routes are read-only, so a fallback instance can
      // never become a second journal WRITER — eager mint uses the bootstrap
      // instance only). GET /conversations/health must answer 200, not 503.
      conversationRegistry:
        options.conversationRegistry ??
        new ConversationRegistry({
          stateDir: options.config.stateDir,
          machineId: () => 'agent-server',
        }),
      // durable-conversation-identity §7: default-construct the bind-token
      // verifier so the POST /commitments bind gate is alive on EVERY init
      // path — a minted-id bind is fail-closed from day one (the read-only-
      // fallback precedent above). The bootstrap-wired instance takes
      // precedence when present.
      conversationBindAuth:
        options.conversationBindAuth ?? createConversationBindAuth(options.config.stateDir),
      conversationFollowThrough: options.conversationFollowThrough,
      topicPinSkewQuarantine: options.topicPinSkewQuarantine ?? null,
      topicPinFoldView: options.topicPinFoldView ?? null,
      ownershipReconciler: options.ownershipReconciler ?? null,
      staleOwnerEngine: options.staleOwnerEngine ?? null,
      duplicateReconciler: options.duplicateReconciler ?? null,
      ownerDarkLadder: options.ownerDarkLadder ?? null,
      spawnAdmission: options.spawnAdmission ?? null,
      judgmentProvenance: options.judgmentProvenance ?? null,
      leaseHandback: options.leaseHandback ?? null,
      secretSync: options.secretSync ?? null,
      ropeHealthMonitor: options.ropeHealthMonitor ?? null,
      writeAdmission: options.writeAdmission ?? null,
      meshSelfId: options.meshSelfId ?? null,
      resolveRouterUrl: options.resolveRouterUrl ?? null,
      sendDrain: options.sendDrain ?? null,
      resolvePeerUrls: options.resolvePeerUrls ?? null,
      guardRegistry: options.guardRegistry ?? null,
      listPoolMachines: options.listPoolMachines ?? null,
      poolLink: options.poolLink ?? null,
      poolPollCache: options.poolPollCache ?? null,
      sessionPoolE2EResultStore: options.sessionPoolE2EResultStore ?? null,
      messageLedger: options.messageLedger ?? null,
      currentInboundByTopic: options.currentInboundByTopic ?? null,
      replyMarkerTransport: options.replyMarkerTransport ?? null,
      // The shared intelligence provider (an IntelligenceRouter when per-component
      // framework routing is wired) — backs GET /intelligence/routing.
      intelligence: options.intelligence ?? null,
      startTime: this.startTime,
    };
    this.routeContext = routeCtx;
    const routes = createRoutes(routeCtx);
    this.app.use(routes);

    // File viewer routes (after auth middleware)
    const fileRoutes = createFileRoutes({ config: options.config, liveConfig: options.liveConfig });
    this.app.use(fileRoutes);

    // Worktree manager (auth-required) routes — bindings, locks, preflight, sign-trailer.
    if (options.worktreeManager) {
      const worktreeRoutes = createWorktreeRoutes({
        worktreeManager: options.worktreeManager,
        projectDir: options.config.projectDir,
      });
      this.app.use(worktreeRoutes);
    }

    // Remediation Proposals routes (Tier-3 S-2 of self-healing remediator v2).
    // Mounted unconditionally — proposal files only exist once S-1 (the
    // NovelFailureReviewer) has emitted them, and the list endpoint returns
    // [] gracefully when no proposals-<machineId>/ directory is present.
    // Trust source uses the agent's configured `autonomyProfile`; no
    // approval channels are wired here since dismiss only consults
    // `hasCollaborativeTrust()` per §A26.
    try {
      const profile = (options.config as { autonomyProfile?: import('../core/types.js').AutonomyProfileLevel }).autonomyProfile ?? 'supervised';
      const trustSource = new TrustElevationSource({ profile, channels: [] });
      registerRemediationProposalsRoutes({
        app: this.app,
        stateDir: options.config.stateDir,
        trustSource,
      });
    } catch (err) {
      // Non-fatal: a wiring error must not prevent the rest of the server
      // from starting (matches the burn-detection-system convention).
      // eslint-disable-next-line no-console
      console.warn('[agent-server] failed to register remediation-proposals routes:', err);
    }

    // Topic Intent Layer (Layer 1) diagnostics + read-only routes.
    // Framework-agnostic: works under Claude Code AND Codex sessions; the
    // store itself is file-based with no framework-specific dependencies.
    // Mounted unconditionally — if the store is disabled, the route module
    // returns a 503 stub so the surface always exists for capability probing.
    const topicIntentRoutes = createTopicIntentRoutes({
      topicIntentStore: options.topicIntentStore ?? null,
      arcCheck: options.topicIntentArcCheck ?? null,
    });
    this.app.use(topicIntentRoutes);

    // Standards-conformance gate (rung-3 normative slice): the spec-review gate
    // reads docs/STANDARDS-REGISTRY.md and signals possible standard violations.
    // Mounted unconditionally; 503-stubs when disabled or the constitution is
    // unreadable (e.g. a deployed agent without the repo's docs/). Signal-only.
    // Spec: docs/specs/standards-conformance-gate.md.
    try {
      const projectDir = options.config.projectDir;
      this.app.use(createSpecReviewRoutes({
        intelligence: options.intelligence ?? null,
        registryPath: path.join(projectDir, 'docs', 'STANDARDS-REGISTRY.md'),
        specsDir: path.join(projectDir, 'docs', 'specs'),
        stateDir: options.config.stateDir,
        enabled: options.config.specReview?.conformance?.enabled !== false,
      }));
    } catch (err) {
      console.warn('[agent-server] failed to register spec-review routes:', err);
    }

    // Usher (rung 4) — read-only pull surface for mid-task re-surface signals.
    // Mounted unconditionally; 503-stubs when the store is absent. Signal-only.
    // Spec: docs/specs/cwa-usher.md.
    this.app.use(createUsherRoutes({ signalStore: options.usherSignalStore ?? null }));

    // Planned-handoff operator/test trigger (spec §8 G3e). Bearer-authed (mounted
    // after the global auth middleware). server.ts supplies onHandoffInitiate +
    // handoffInProgress from the outgoing-side handoffSentinelWiring; absent →
    // the /handoff surface 503s honestly.
    this.app.use(createHandoffInitiateRoutes({
      onInitiate: options.onHandoffInitiate ?? null,
      inProgress: options.handoffInProgress ?? null,
    }));

    // Error handler (must be last)
    this.app.use(errorHandler);
  }

  /**
   * Resolve the dashboard directory.
   * In dev: ../../../dashboard (relative to src/server/)
   * In dist (published): ../../dashboard (relative to dist/server/)
   */
  private resolveDashboardDir(): string {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    // Try dist layout first (package root/dashboard)
    const fromDist = path.resolve(thisDir, '..', '..', 'dashboard');
    // Try dev layout (src/server -> project root/dashboard)
    const fromSrc = path.resolve(thisDir, '..', '..', '..', 'dashboard');
    if (fs.existsSync(fromDist)) return fromDist;
    if (fs.existsSync(fromSrc)) return fromSrc;
    return fromDist;
  }

  /**
   * Wire the mentor-onboarding runner (§19.4) from real services. Ships DORMANT:
   * the config defaults to mentor.enabled=false / mode='off', so tick() returns
   * {ran:false, reason:'disabled'} in production until a human flips it via the
   * graduated-rollout track. The live spawn/forensics paths are real code, gated
   * behind that flag and validated via test-as-self before promotion.
   */
  /** Find the N most recently-modified rollout .jsonl files under a codex sessions
   *  dir (nested year/month/day). Best-effort; returns [] on any error. */
  private findRecentRolloutFiles(sessionsDir: string, n: number): string[] {
    const found: Array<{ path: string; mtime: number }> = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.name.endsWith('.jsonl')) {
          try {
            found.push({ path: full, mtime: fs.statSync(full).mtimeMs });
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(sessionsDir, 0);
    return found.sort((a, b) => b.mtime - a.mtime).slice(0, n).map((f) => f.path);
  }

  /**
   * Extract a completed mentee session's FINAL assistant message from its
   * persisted transcript (clean prose), rather than the racy tmux-pane read.
   * Returns null when no transcript reply is found — the caller then keeps the
   * tmux-capture fallback.
   *
   * - Codex sessions: the newest rollout JSONL under $CODEX_HOME/sessions that
   *   was written at/after the spawn → `task_complete.last_agent_message`.
   * - Claude sessions: the session's JSONL transcript (by claudeSessionId) →
   *   the last assistant text block.
   */
  private async extractMenteeReplyFromTranscript(
    session: { id: string; claudeSessionId?: string; framework?: string },
    spawnTs: number,
  ): Promise<string | null> {
    try {
      const framework = String(session.framework ?? '');
      // ── Codex path ──
      if (framework.startsWith('codex')) {
        const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
        // The mentee rollout is the newest rollout written since the spawn
        // (allow a small skew for the rollout file's first write lag).
        const candidates = this.findRecentRolloutFiles(sessionsDir, 5);
        for (const f of candidates) {
          try {
            if (fs.statSync(f).mtimeMs < spawnTs - 5_000) continue;
            const text = extractCodexFinalMessage(fs.readFileSync(f, 'utf-8'));
            if (text && text.trim()) return text;
          } catch { /* try next candidate */ }
        }
        return null;
      }
      // ── Claude path ──
      // Two async lags after the session leaves the running list: (1)
      // claudeSessionId is flushed to the session record by a hook, and (2)
      // the transcript JSONL's FINAL assistant message is written progressively
      // (the last block lands after the session exits). So poll the WHOLE
      // resolve-id → read-transcript → extract chain until it yields content,
      // not just until the id exists. Use the exact <claudeSessionId>.jsonl —
      // never newest-by-mtime, since many Claude sessions run concurrently and
      // mtime would grab an unrelated one.
      const projectsDir = path.join(os.homedir(), '.claude', 'projects');
      // Claude Code writes transcripts at projectsDir/<encoded-cwd>/<claudeId>.jsonl
      // — i.e. DEPTH 1. findClaudeTranscriptShallow scans only the immediate
      // children (NOT a recursive walk): ~/.claude/projects can hold >10k nested
      // dirs on a busy agent, so a guarded depth-first walk exhausts its budget
      // deep in an unrelated subtree before reaching ours — the exact bug that
      // made Stage-A capture silently return empty.
      // Poll up to ~240s: the spawned session's listRunningSessions
      // registration can lag (so the caller's completion-wait may exit at
      // iteration 0, before the session even started), and claudeSessionId is
      // only flushed to the session record when the session COMPLETES — which,
      // under heavy concurrent load on this machine, can be 2+ minutes for a
      // Stage-A haiku session. claudeSessionId appearing IS the completion
      // signal; the transcript's final assistant block lands with it. Poll long
      // enough to cover the session's own maxDuration (5 min) rather than race
      // it. The mentor tick is async fire-and-forget, so the wait is fine.
      for (let i = 0; i < 240; i++) {
        let claudeId = session.claudeSessionId;
        if (!claudeId) {
          try { claudeId = this.state.getSession(session.id)?.claudeSessionId ?? undefined; } catch { /* best-effort */ }
        }
        if (claudeId) {
          const tf = findClaudeTranscriptShallow(projectsDir, claudeId);
          if (tf) {
            try {
              const text = extractClaudeFinalMessage(fs.readFileSync(tf, 'utf-8'));
              if (text && text.trim()) return text;
            } catch { /* transcript mid-write; retry */ }
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return null;
    } catch (err) {
      console.warn(`[mentee] transcript extraction failed (falling back to tmux capture): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Lazily construct + cache the mentor-bot TelegramAdapter for the given token. Uses
   * PR 2a's multi-instance support (subDir + suppressLifelineAutoCreate) so the second
   * bot can't clobber the primary bot's state files OR auto-create a second Lifeline
   * topic. Reconfiguration (token change) tears down the old adapter first.
   * Returns null on construction failure (logged) — caller treats as "no delivery."
   */
  private getOrCreateMentorBot(botToken: string, menteeChatId: string): MentorTelegramAdapter | null {
    if (this.mentorBotAdapter && this.mentorBotAdapterToken === botToken) {
      return this.mentorBotAdapter;
    }
    if (this.mentorBotAdapter && this.mentorBotAdapterToken !== botToken) {
      this.mentorBotAdapter.stop().catch(() => {});
      this.mentorBotAdapter = null;
      this.mentorBotAdapterToken = null;
    }
    try {
      this.mentorBotAdapter = new MentorTelegramAdapter(
        { token: botToken, chatId: menteeChatId },
        this.config.stateDir,
        { subDir: 'agent-telegram/mentor-bot', suppressLifelineAutoCreate: true },
      );
      this.mentorBotAdapterToken = botToken;
      // Install the mentor-reply recipient hook now that the adapter is up. The handler
      // clears the outstanding-prompt by corr + persists the reply for Stage-B.
      const mentorBotId = botToken.split(':')[0];
      this.installMentorReceiverHook(this.mentorBotAdapter, mentorBotId);
      return this.mentorBotAdapter;
    } catch (err) {
      console.warn('[mentor] mentor-bot adapter construction failed (non-fatal):', err instanceof Error ? err.message : String(err));
      this.mentorBotAdapter = null;
      this.mentorBotAdapterToken = null;
      return null;
    }
  }

  /** Lazily construct + cache the a2a audit ledger. Paths default under stateDir. */
  private getOrCreateA2aLedger(): AgentTelegramLedger {
    if (!this.a2aLedger) {
      this.a2aLedger = new AgentTelegramLedger(defaultA2aLedgerPaths(this.config.stateDir));
    }
    return this.a2aLedger;
  }

  /** Lazily construct + cache the processed-id store (idempotency for inbound replies). */
  private getOrCreateA2aProcessedIds(): ProcessedIdStore {
    if (!this.a2aProcessedIds) {
      this.a2aProcessedIds = new ProcessedIdStore({
        filePath: path.join(this.config.stateDir, 'a2a-processed-ids.json'),
      });
    }
    return this.a2aProcessedIds;
  }

  /** Lazily construct + cache the outstanding-prompt tracker (anti-ping-pong). */
  private getOrCreateMentorOutstanding(): OutstandingPromptTracker {
    if (!this.mentorOutstanding) {
      this.mentorOutstanding = new OutstandingPromptTracker({
        filePath: path.join(this.config.stateDir, 'mentor-outstanding-prompts.json'),
      });
    }
    return this.mentorOutstanding;
  }

  /**
   * Install the mentor-reply recipient hook on the mentor-bot adapter. Called from
   * getOrCreateMentorBot once the adapter is up. The hook routes role=`mentor-reply`
   * from Codey to a handler that (1) clears the outstanding-prompt entry by `corr`
   * (so the next mentor tick can send again), and (2) persists the reply to a
   * jsonl file Stage-B forensics reads. This is the capability-handle invariant from
   * the spec: the reply-ingestion path CANNOT call spawnStageA / deliverToMentee /
   * scheduler / Threadline — it only writes the reply + clears tracking.
   */
  private installMentorReceiverHook(bot: MentorTelegramAdapter, mentorBotId: string): void {
    const cfg = this.getMentorConfigSnapshot();
    if (!cfg.menteeBotId) return;
    const menteeAgent = cfg.menteeAgentName || `instar-${cfg.menteeFramework}`;
    const recipientCfg: RecipientConfig = {
      localAgent: 'echo',
      knownAgents: { [menteeAgent]: { botId: String(cfg.menteeBotId) } },
      acceptRoles: { [menteeAgent]: ['mentor-reply'] },
      skewWindowMs: 24 * 60 * 60 * 1000,
      maxVersion: A2A_VERSION,
    };
    const outstanding = this.getOrCreateMentorOutstanding();
    const replyJsonl = path.join(this.config.stateDir, 'mentor-replies.jsonl');
    this.mentorReplyJsonlPath = replyJsonl;

    const mentorReplyHandler: RoleHandler = async (msg, ctx) => {
      // (1) Clear the outstanding-prompt by corr (the next tick can send again).
      const had = outstanding.clearByCorr(msg.corr);
      if (!had) {
        // Spurious / late reply (no outstanding match). Still persist it for forensics.
        console.warn(`[mentor] mentor-reply for unknown corr=${msg.corr} (late after orphan-sweep?); persisting anyway`);
      }
      // (2) Persist the reply for Stage-B (append-only JSONL). Capability-handle
      // invariant: this is the ONLY outbound effect; no spawn/deliver/schedule.
      try {
        fs.mkdirSync(path.dirname(replyJsonl), { recursive: true });
        const row = {
          ts: Date.now(),
          fromAgent: msg.from,
          corr: msg.corr,
          replyId: msg.id,
          topicId: ctx.topicId,
          message: msg.body,
        };
        fs.appendFileSync(replyJsonl, JSON.stringify(row) + '\n', 'utf-8');
      } catch (err) {
        console.warn('[mentor] mentor-reply persist failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }
    };

    const hook = buildAgentMessageHook({
      config: recipientCfg,
      ledger: this.getOrCreateA2aLedger(),
      processedIds: this.getOrCreateA2aProcessedIds(),
      roleHandlers: new Map<string, RoleHandler>([['mentor-reply', mentorReplyHandler]]),
    });
    bot.setAgentMessageHook(hook);
  }

  /**
   * Install the agent-message hook on the PRIMARY TelegramAdapter for mentee
   * agents. Mirror of `installMentorReceiverHook` (which runs on the mentor BOT
   * adapter to catch mentor-REPLIES); this runs on the primary adapter where
   * the agent normally polls for user messages, and catches inbound
   * mentor PROMPTS from allowlisted mentor agents
   * (MENTOR-LIVE-READINESS-SPEC §Recipient side).
   *
   * Hook is installed iff `config.mentee.enabled === true` AND all of
   * `localAgentName`, `knownMentors`, `replyChatId`, `replyTopicId` are set.
   * Each missing piece logs a one-line skip and bails — no partial wiring.
   * The wiring stays dark by default (`enabled: false`).
   *
   * The role-handler:
   *   1. Spawns a mentee session with `msg.body` as the prompt (the agent's
   *      default tool grant — not the Stage-A empty-tools constraint).
   *   2. Bounded-waits up to `sessionTimeoutMs` (default 5 min). On timeout
   *      the session is killed and an empty reply is logged — no partial
   *      transcript is sent.
   *   3. Captures the tmux pane transcript as the reply.
   *   4. Sends the reply back through the canonical A2A delivery seam with
   *      `role='mentor-reply'` and `corr=msg.corr || msg.id` so the
   *      mentor's `OutstandingPromptTracker` can clear by correlation.
   *
   * Reply-out happens in the handler's orchestrator section (NOT through a
   * capability passed to the handler) per the spec's capability-handle
   * anti-loop discipline: handlers are capture-only, and the only outbound
   * role they may emit is `mentor-reply` (declared in `allowedRoles`).
   */
  private installMentorMessageHook(): void {
    const adapter = this.telegramAdapter;
    if (!adapter) return;

    const self = this;
    const ledger = this.getOrCreateA2aLedger();
    const localAgent = this.config.projectName;

    // The primary adapter's hook carries ALL a2a roles this agent accepts —
    // both as-mentee (`mentor`) and as-mentor (`mentor-reply`). Same-machine
    // a2a (Telegram blocks bot-to-bot) routes through /a2a/inbox → this hook.
    const knownAgents: Record<string, { botId: string }> = {};
    const acceptRoles: Record<string, string[]> = {};
    const roleHandlers = new Map<string, RoleHandler>();

    // ── Mentee side: accept `mentor` from configured known-mentors ──
    const menteeCfg = this.getMenteeConfigSnapshot();
    const menteeReady =
      menteeCfg.enabled &&
      !!menteeCfg.localAgentName &&
      Object.keys(menteeCfg.knownMentors).length > 0 &&
      !!menteeCfg.replyChatId &&
      !!menteeCfg.replyTopicId;
    if (menteeCfg.enabled && !menteeReady) {
      console.warn(
        '[mentee] receiver wiring skipped — mentee.enabled but missing localAgentName / knownMentors / replyChatId / replyTopicId',
      );
    }
    if (menteeReady) {
      for (const [mentorName, info] of Object.entries(menteeCfg.knownMentors)) {
        // Coerce botId to string (config may store it as a JSON number; the
        // marker senderBotId is always a string + the allowlist uses ===).
        knownAgents[mentorName] = { botId: String(info.botId) };
        acceptRoles[mentorName] = [...(acceptRoles[mentorName] ?? []), 'mentor'];
      }
      const sessionTimeoutMs = menteeCfg.sessionTimeoutMs;
      const mentorMessageHandler: RoleHandler = async (msg, _ctx) => {
        // Spawn a mentee session, bounded-wait, capture the reply. Capture the
        // last non-empty pane snapshot WHILE the session is alive — the post-
        // completion capture races the reaper (the session's tmux pane is gone
        // by the time we detect completion, so captureOutput returns empty).
        let reply = '';
        let sessionId = '';
        const spawnTs = Date.now();
        try {
          const session = await self.sessionManager.spawnSession({
            name: `mentee-handle-${Date.now()}`,
            prompt: msg.body,
            maxDurationMinutes: Math.max(1, Math.ceil(sessionTimeoutMs / 60_000)),
          });
          sessionId = session.id;
          const tmux = session.tmuxSession;
          const pollIntervalMs = 2_000;
          const pollIterations = Math.max(1, Math.ceil(sessionTimeoutMs / pollIntervalMs));
          let finished = false;
          for (let i = 0; i < pollIterations; i++) {
            const stillRunning = self.sessionManager
              .listRunningSessions()
              .some((s) => s.id === session.id);
            // Capture-while-alive: keep the last non-empty snapshot so a
            // completed-then-reaped session still yields its output.
            const snapshot = self.sessionManager.captureOutput(tmux, 200) ?? '';
            if (snapshot.trim()) reply = snapshot;
            if (!stillRunning) { finished = true; break; }
            await new Promise((r) => setTimeout(r, pollIntervalMs));
          }
          if (!finished) {
            try { self.sessionManager.killSession(session.id); } catch { /* best-effort */ }
            console.warn(
              `[mentee] session ${session.id} timed out at ${sessionTimeoutMs}ms (corr=${msg.corr}); sending best-effort partial reply`,
            );
          }
          // Robust capture: prefer the session's persisted transcript (clean
          // assistant prose) over the racy tmux-pane read. The pane read is
          // only a fallback for when no transcript is found.
          const fromTranscript = await self.extractMenteeReplyFromTranscript(session, spawnTs);
          if (fromTranscript && fromTranscript.trim()) reply = fromTranscript;
        } catch (err) {
          console.warn(
            `[mentee] mentor-message handler spawn failed (corr=${msg.corr}, sessionId=${sessionId}):`,
            err instanceof Error ? err.message : String(err),
          );
          return;
        }

        if (!reply.trim()) {
          console.warn(
            `[mentee] mentee session produced empty reply for corr=${msg.corr}; skipping reply-out`,
          );
          return;
        }

        // Reply OUT via the a2a transport (same-machine /a2a/inbox when the
        // mentor is a local peer; Telegram fallback otherwise). The handler
        // stays capture-only — deliverA2aMessage is an orchestrator method,
        // not a capability handed into the handler.
        await self.deliverA2aMessage({
          fromAgent: localAgent,
          toAgent: msg.from,
          role: 'mentor-reply',
          corr: msg.corr || msg.id,
          body: reply,
          allowedRoles: new Set(['mentor-reply']),
          telegramTopicId: menteeCfg.replyTopicId,
          // fromBotId = THIS agent's own bot id, so the mentor's allowlist
          // (knownAgents[instar-codey].botId === senderBotId) passes.
          fromBotId: self.ownPrimaryBotId(),
          toBotId: menteeCfg.knownMentors[msg.from]?.botId,
          targetMachineId: menteeCfg.knownMentors[msg.from]?.machineId,
        });
      };
      roleHandlers.set('mentor', mentorMessageHandler);
    }

    // ── Mentor side: accept `mentor-reply` from the configured mentee ──
    // So a mentee's reply arriving via /a2a/inbox reaches the same
    // finding-emission-only handler that installMentorReceiverHook uses on
    // the mentor-BOT adapter (spec §250 — capability-handle, capture-only).
    const mentorCfg = this.getMentorConfigSnapshot();
    if (mentorCfg.menteeBotId) {
      const menteeAgent = mentorCfg.menteeAgentName || `instar-${mentorCfg.menteeFramework}`;
      // Coerce to string — config may store the bot id as a JSON number, but
      // the a2a marker's senderBotId is always a string; the allowlist compares
      // with === so a number/string mismatch silently drops every reply.
      knownAgents[menteeAgent] = { botId: String(mentorCfg.menteeBotId) };
      acceptRoles[menteeAgent] = [...(acceptRoles[menteeAgent] ?? []), 'mentor-reply'];
      const outstanding = this.getOrCreateMentorOutstanding();
      const replyJsonl = path.join(this.config.stateDir, 'mentor-replies.jsonl');
      this.mentorReplyJsonlPath = replyJsonl;
      const mentorReplyHandler: RoleHandler = async (msg, ctx) => {
        const had = outstanding.clearByCorr(msg.corr);
        if (!had) {
          console.warn(`[mentor] mentor-reply for unknown corr=${msg.corr} (late after orphan-sweep?); persisting anyway`);
        }
        try {
          fs.mkdirSync(path.dirname(replyJsonl), { recursive: true });
          const row = {
            ts: Date.now(),
            fromAgent: msg.from,
            corr: msg.corr,
            replyId: msg.id,
            topicId: ctx.topicId,
            message: msg.body,
            transport: 'a2a-inbox-local',
          };
          fs.appendFileSync(replyJsonl, JSON.stringify(row) + '\n', 'utf-8');
          console.log(`[mentor] mentor-reply persisted (corr=${msg.corr}, from=${msg.from}) → mentor-replies.jsonl`);
        } catch (err) {
          console.warn('[mentor] mentor-reply persist failed (non-fatal):', err instanceof Error ? err.message : String(err));
        }
      };
      roleHandlers.set('mentor-reply', mentorReplyHandler);
    }

    if (roleHandlers.size === 0) {
      // Neither side configured — nothing to install. /a2a/inbox will return
      // agentMessage:false until a role-handler exists.
      return;
    }

    const recipientCfg: RecipientConfig = {
      localAgent,
      knownAgents,
      acceptRoles,
      skewWindowMs: 24 * 60 * 60 * 1000,
      maxVersion: A2A_VERSION,
    };
    const hook = buildAgentMessageHook({
      config: recipientCfg,
      ledger,
      processedIds: this.getOrCreateA2aProcessedIds(),
      roleHandlers,
    });
    adapter.setAgentMessageHook(hook);
    console.log(
      `[a2a] primary-adapter hook installed — localAgent=${localAgent}, roles=[${[...roleHandlers.keys()].join(',')}], knownAgents=[${Object.keys(knownAgents).join(',')}]`,
    );
  }

  /**
   * Deliver an a2a message to another agent. Same-machine peers (registered in
   * AgentRegistry) receive it via HTTP POST to their `/a2a/inbox` endpoint —
   * the canonical transport because Telegram structurally blocks bot-to-bot
   * delivery. Cross-machine peers fall back to the Telegram bot path (preserved
   * but currently unreachable due to the same block; tracked follow-up).
   *
   * Used by BOTH directions: the mentor's `deliverToMentee` (role=mentor) and
   * the mentee's reply (role=mentor-reply). Returns true iff delivered.
   */
  private async deliverA2aMessage(opts: {
    fromAgent: string;
    toAgent: string;
    role: string;
    corr: string;
    body: string;
    allowedRoles: ReadonlySet<string>;
    telegramTopicId?: number;
    targetMachineId?: string;
    /** The recipient's bot id — used ONLY by the Telegram fallback's toBotId. */
    toBotId?: string;
    /** The SENDER's own bot id — sent as the inbox `senderBotId` so the
     *  recipient's allowlist check (knownAgents[from].botId === senderBotId)
     *  passes. Must be the from-agent's bot id, NOT the recipient's. */
    fromBotId?: string;
    /** Telegram fallback bits (mentor→mentee only). */
    telegramBot?: { sendToTopic: (topicId: number, text: string) => Promise<{ messageId: number }> };
    botToken?: string;
    /** Observability mirror only — never participates in delivery authority. */
    visibleEcho?: MentorVisibleEchoOptions;
  }): Promise<boolean> {
    const ledger = this.getOrCreateA2aLedger();
    const id = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // ── Same-machine: POST to peer's /a2a/inbox ──
    try {
      const { listAgents } = await import('../core/AgentRegistry.js');
      const { getAgentToken } = await import('../messaging/AgentTokenManager.js');
      const peers = listAgents();
      const localPeer = peers.find(
        (a) => a.name === opts.toAgent && a.name !== this.config.projectName,
      );
      if (localPeer?.port) {
        const peerToken = getAgentToken(localPeer.name);
        if (peerToken) {
          const tsNow = Date.now();
          const marker = `[a2a:from=${opts.fromAgent} to=${opts.toAgent} role=${opts.role} id=${id} corr=${opts.corr} ts=${tsNow} v=${A2A_VERSION}]`;
          const fullText = `${marker}\n\n${opts.body}`;
          const resp = await fetch(`http://localhost:${localPeer.port}/a2a/inbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${peerToken}` },
            body: JSON.stringify({
              text: fullText,
              topicId: opts.telegramTopicId ?? 0,
              senderAgent: opts.fromAgent,
              senderIsBot: true,
              senderBotId: opts.fromBotId ?? `${opts.fromAgent}-local`,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (resp.ok) {
            const result = (await resp.json().catch(() => ({}))) as { agentMessage?: boolean; reason?: string };
            if (result.agentMessage === true) {
              try {
                ledger.appendSent({
                  ts: tsNow, from: opts.fromAgent, to: opts.toAgent, role: opts.role,
                  id, corr: opts.corr, result: 'sent', transport: 'a2a-inbox-local',
                } as never);
              } catch { /* best-effort */ }
              console.log(`[a2a] delivered → ${opts.toAgent} via local /a2a/inbox (role=${opts.role}, corr=${opts.corr})`);
              if (opts.visibleEcho) {
                // Observability only: never delay or alter the canonical delivery
                // return/ledger/outstanding state while Telegram is slow or down.
                void sendMentorVisibleEcho(opts.body, opts.visibleEcho).catch((err) => {
                  console.warn(`[mentor-echo] unexpected failure after delivery: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
              return true;
            }
            console.warn(`[a2a] local /a2a/inbox refused (to=${opts.toAgent}, role=${opts.role}, reason=${result.reason ?? 'unknown'})`);
          } else {
            console.warn(`[a2a] local /a2a/inbox HTTP ${resp.status} (to=${opts.toAgent}, role=${opts.role})`);
          }
        } else {
          console.warn(`[a2a] no token for local peer ${localPeer.name}; cannot deliver ${opts.role}`);
        }
      }
    } catch (err) {
      console.warn(`[a2a] local-inbox delivery attempt failed (to=${opts.toAgent}): ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Cross-machine: signed MeshRpc → recipient's EXISTING inbox hook ──
    // Telegram remains a visible mirror only. It can never make this branch
    // successful because Telegram bots do not receive other bots' messages.
    if (opts.targetMachineId && this.deliverA2aToMachine && opts.telegramTopicId !== undefined) {
      const tsNow = Date.now();
      const marker = `[a2a:from=${opts.fromAgent} to=${opts.toAgent} role=${opts.role} id=${id} corr=${opts.corr} ts=${tsNow} v=${A2A_VERSION}]`;
      const result: { ok: boolean; agentMessage?: boolean; reason?: string } = await this.deliverA2aToMachine({
        machineId: opts.targetMachineId,
        targetAgent: opts.toAgent,
        text: `${marker}\n\n${opts.body}`,
        topicId: opts.telegramTopicId,
        senderAgent: opts.fromAgent,
        senderBotId: opts.fromBotId ?? `${opts.fromAgent}-mesh`,
      }).catch((err) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
      if (result.ok && result.agentMessage === true) {
        try {
          ledger.appendSent({
            ts: tsNow, from: opts.fromAgent, to: opts.toAgent, role: opts.role,
            id, corr: opts.corr, result: 'sent', transport: 'a2a-inbox-mesh',
          } as never);
        } catch { /* best-effort */ }
        console.log(`[a2a] delivered → ${opts.toAgent} via signed mesh inbox (machine=${opts.targetMachineId}, role=${opts.role}, corr=${opts.corr})`);
        if (opts.visibleEcho) {
          void sendMentorVisibleEcho(opts.body, opts.visibleEcho).catch((err) => {
            console.warn(`[mentor-echo] unexpected failure after mesh delivery: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        return true;
      }
      console.warn(`[a2a] signed mesh inbox refused (machine=${opts.targetMachineId}, to=${opts.toAgent}, role=${opts.role}, reason=${result.reason ?? 'not-routed'})`);
      return false;
    }

    // Telegram bot-to-bot sends are never a delivery authority: bots do not
    // receive other bots' messages. A visible mirror is emitted only above,
    // after the local or signed-mesh inbox explicitly accepts the envelope.
    return false;
  }

  /** Snapshot of mentee config for the receiver-wiring installer. */
  private getMenteeConfigSnapshot(): MenteeConfig {
    return {
      ...DEFAULT_MENTEE_CONFIG,
      ...((this.config as unknown as { mentee?: Partial<MenteeConfig> }).mentee ?? {}),
    };
  }

  /**
   * This agent's own primary Telegram bot id (the numeric prefix of its
   * messaging bot token), or undefined if no Telegram messaging is configured.
   * Used as the a2a `senderBotId` so a recipient's allowlist check
   * (knownAgents[from].botId === senderBotId) passes — the sender must
   * identify with its OWN bot id.
   */
  private ownPrimaryBotId(): string | undefined {
    const tg = (this.config.messaging ?? []).find(
      (m) => m.type === 'telegram' && m.enabled,
    ) as { config?: { token?: string } } | undefined;
    const token = tg?.config?.token;
    return token ? token.split(':')[0] : undefined;
  }

  /** Snapshot of mentor config for use outside the runner's getConfig closure. */
  private getMentorConfigSnapshot(): MentorConfig {
    return {
      ...DEFAULT_MENTOR_CONFIG,
      ...((this.config as unknown as { mentor?: Partial<MentorConfig> }).mentor ?? {}),
    };
  }

  /**
   * Read the mentee's recent replies from `<stateDir>/mentor-replies.jsonl` for
   * the Stage-A conversation surface. Best-effort: a missing/garbled file yields
   * an empty list (the surface degrades to "(no prior conversation)" — never
   * throws into the tick). Only the mentee's own replies are user-visible
   * conversation, so this is two-hats-safe. `ts` is coerced from string|number.
   */
  private readRecentMenteeReplies(stateDir: string | undefined, menteeAgent: string): MenteeReplyLine[] {
    if (!stateDir) return [];
    try {
      const raw = fs.readFileSync(path.join(stateDir, 'mentor-replies.jsonl'), 'utf-8');
      return parseMenteeReplies(raw, menteeAgent);
    } catch {
      return []; // no replies yet (or unreadable) — surface shows no prior conversation
    }
  }

  /**
   * Read the mentor's own sent prompts from `<stateDir>/mentor-sent.jsonl` for
   * the Stage-A conversation surface. Best-effort like replies: missing or
   * garbled logs degrade to no mentor-side history rather than breaking ticks.
   */
  private readRecentMentorSent(stateDir: string | undefined, menteeAgent: string): MentorSentLine[] {
    if (!stateDir) return [];
    try {
      const raw = fs.readFileSync(path.join(stateDir, 'mentor-sent.jsonl'), 'utf-8');
      return parseMentorSent(raw, menteeAgent);
    } catch {
      return [];
    }
  }

  private appendMentorSent(stateDir: string | undefined, row: {
    ts: number;
    fromAgent: string;
    toAgent: string;
    corr: string;
    topicId?: number;
    message: string;
  }): void {
    if (!stateDir) return;
    const sentJsonl = path.join(stateDir, 'mentor-sent.jsonl');
    this.mentorSentJsonlPath = sentJsonl;
    try {
      fs.mkdirSync(path.dirname(sentJsonl), { recursive: true });
      fs.appendFileSync(sentJsonl, JSON.stringify(row) + '\n', 'utf-8');
    } catch (err) {
      console.warn('[mentor] mentor-sent persist failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  private buildMentorRunner(
    ledger: FrameworkIssueLedger,
    options: { config: { stateDir?: string }; intelligence?: import('../core/types.js').IntelligenceProvider | null },
    serverDataDir: string,
  ): MentorOnboardingRunner {
    const startupMentorConfig: MentorConfig = {
      ...DEFAULT_MENTOR_CONFIG,
      ...((options.config as unknown as { mentor?: Partial<MentorConfig> }).mentor ?? {}),
    };
    const getConfig = (): MentorConfig => readMentorConfigFromDisk(options.config.stateDir, startupMentorConfig);
    const intelligence = options.intelligence ?? null;
    const self = this;
    // Durable lastResult: persist the loop's last outcome to the state dir so a
    // server restart doesn't erase it. On a frequent-release day restart cadence
    // matched the 15-min tick cadence, so GET /mentor/status.lastResult read
    // null essentially always — the loop was undiagnosable from its own status
    // route. Absent stateDir ⇒ in-memory only (old behavior).
    const lastResultPath = options.config.stateDir
      ? path.join(options.config.stateDir, 'mentor-last-result.json')
      : null;
    return new MentorOnboardingRunner(
      {
        capture: (input) => ledger.captureRun(input),
        loadLastResult: lastResultPath
          ? () => {
              try {
                const raw = fs.readFileSync(lastResultPath, 'utf-8');
                const parsed = JSON.parse(raw) as { ran?: unknown; at?: unknown };
                // Minimal shape check — a corrupt/foreign file hydrates as null.
                if (typeof parsed?.at === 'number' && typeof parsed?.ran === 'boolean') {
                  return parsed as import('../scheduler/MentorOnboardingRunner.js').MentorRunResult & { at: number };
                }
              } catch { /* @silent-fallback-ok — missing/corrupt file ⇒ null (old in-memory start) */ }
              return null;
            }
          : undefined,
        saveLastResult: lastResultPath
          ? (r) => {
              try {
                fs.mkdirSync(path.dirname(lastResultPath), { recursive: true });
                const tmp = `${lastResultPath}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify(r, null, 2), 'utf-8');
                fs.renameSync(tmp, lastResultPath);
              } catch (err) {
                console.warn('[mentor] lastResult persist failed (non-fatal):', err instanceof Error ? err.message : String(err));
              }
            }
          : undefined,
        // Record a keystone `mentor-mentee-differential` CYCLE per tick — the
        // structural version of the manual differential-oversight loop. No-ops
        // unless `mentor.apprenticeshipInstanceId` is set AND the cycle store is
        // wired. Reads `self.apprenticeshipCycleStore` LAZILY (at tick time, not
        // construction time) because buildMentorRunner runs before the store is
        // constructed during boot.
        recordCycle: (input) => {
          const instanceId = getConfig().apprenticeshipInstanceId;
          const store = self.apprenticeshipCycleStore;
          if (!instanceId || !store) return;
          try {
            const existing = store.list({ instanceId });
            const cycleNumber = existing.length
              ? Math.max(...existing.map((c) => c.cycleNumber)) + 1
              : 1;
            store.record({
              instanceId,
              cycleNumber,
              task: input.task,
              menteeOutput: input.menteeOutput,
              overseerDifferential: input.differential,
              kind: 'mentor-mentee-differential',
            });
          } catch (err) {
            // @silent-fallback-ok — cycle capture is observability; a record
            // failure must never crash a mentor tick. Logged, not swallowed.
            console.warn('[mentor] recordCycle failed (non-fatal):', err instanceof Error ? err.message : String(err));
          }
        },
        // Stage A spawns with the EMPTY tool grant (structural two-hats boundary,
        // §4); we bounded-wait for it to finish, then capture its transcript.
        spawnStageA: async (prompt: string): Promise<string> => {
          const spawnTs = Date.now();
          const spawnOnce = () =>
            self.sessionManager.spawnSession({
              name: `mentor-stage-a-${Date.now()}`,
              prompt,
              model: 'haiku',
              allowedTools: [...STAGE_A_ALLOWED_TOOLS], // empty → no tools
              maxDurationMinutes: 5,
            });
          // E2E-PAIRING: EXEMPT — hardens an existing internal closure (the
          // Stage-A compose-session spawn: retry + clear error surfacing). Adds
          // no API route; covered by MentorOnboardingRunner.test.ts.
          // Robustness: a Stage-A compose-session spawn can fail transiently on a
          // busy box (session-cap pressure / load). Retry once with a brief
          // backoff; on a persistent failure throw a CLEAR, specific error
          // (surfaced in GET /mentor/status.lastResult.error) instead of an
          // opaque throw that collapses to 'stage-a-failed' with no cause.
          const session = await spawnOnce().catch(async () => {
            await new Promise((r) => setTimeout(r, 3000));
            return spawnOnce().catch((err) => {
              const why = err instanceof Error ? err.message : String(err);
              throw new Error(
                `stage-a-spawn-failed: could not spawn the Stage-A compose session after 2 attempts — ${why}`,
              );
            });
          });
          const tmux = session.tmuxSession;
          let finished = false;
          let lastSnapshot = '';
          for (let i = 0; i < 90; i++) {
            const stillRunning = self.sessionManager.listRunningSessions().some((s) => s.id === session.id);
            // Capture-while-alive: keep the last non-empty pane snapshot so a
            // completed-then-reaped session still yields SOMETHING (tmux
            // fallback). The Stage-A session produces its prompt ~8-10s in then
            // completes + is reaped within ~2s, so a post-loop pane read races
            // the reaper and returns empty.
            const snap = self.sessionManager.captureOutput(tmux, 200) ?? '';
            if (snap.trim()) lastSnapshot = snap;
            if (!stillRunning) { finished = true; break; }
            await new Promise((r) => setTimeout(r, 2000));
          }
          if (!finished) {
            // Poll exhausted (~180s) and the session is still running: KILL it (no
            // orphaned tmux pane) and throw, so the tick captures a clean
            // stage-a-failed finding rather than reading a partial transcript.
            try { self.sessionManager.killSession(session.id); } catch { /* best-effort */ }
            throw new Error('stage-a-timeout: Stage-A session did not complete within the poll window');
          }
          // Prefer the persisted transcript (clean prose, robust to the reap
          // race) — Stage A is a Claude session; the helper re-fetches its
          // claudeSessionId post-completion and reads that exact JSONL. Fall
          // back to the captured pane snapshot only if no transcript is found.
          console.log(`[stage-a-diag] session ${session.id} finished=${finished} framework=${session.framework} spawnClaudeId=${session.claudeSessionId} lastSnapshotLen=${lastSnapshot.length}`);
          const fromTranscript = await self.extractMenteeReplyFromTranscript(
            { id: session.id, claudeSessionId: session.claudeSessionId, framework: session.framework },
            spawnTs,
          );
          console.log(`[stage-a-diag] transcript extract → ${fromTranscript ? `${fromTranscript.length} chars` : 'NULL'}`);
          return (fromTranscript && fromTranscript.trim())
            ? fromTranscript
            : (lastSnapshot || (self.sessionManager.captureOutput(tmux, 200) ?? ''));
        },
        // Stage-B deep forensics (§3.2): assemble the mentee's real signals
        // (recent server-log errors/sentinel lines + a codex-rollout usage digest)
        // and classify them into bucketed findings via the LLM. Returns [] when no
        // intelligence provider or no signals (so the funnel still logs the run).
        // The pure prompt/parse logic lives in MentorStageBForensics (tested);
        // this closure only does the I/O (read logs/rollouts).
        runStageBForensics: async (framework: string): Promise<ForensicFinding[]> => {
          if (!intelligence) return [];
          let signals = '';
          try {
            const logPath = path.join(options.config.stateDir!, 'logs', 'server.log');
            if (fs.existsSync(logPath)) {
              const buf = fs.readFileSync(logPath, 'utf-8');
              const errLines = buf
                .split('\n')
                .filter((l) => /error|sentinel|delivery|fail|timeout|degrad/i.test(l))
                .slice(-40);
              if (errLines.length) signals += `## Recent server-log signals\n${errLines.join('\n')}\n\n`;
            }
            // Codex-rollout usage digest (rate-limit pressure / token burn) for codex frameworks.
            if (framework.startsWith('codex')) {
              const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
              const recent = self.findRecentRolloutFiles(sessionsDir, 3);
              for (const f of recent) {
                const parsed = parseCodexRollout(fs.readFileSync(f, 'utf-8'));
                if (parsed) {
                  signals += `## Codex session ${parsed.sessionId.slice(0, 8)} (model ${parsed.model ?? '?'})\n` +
                    `tokens=${parsed.totalTokens} primaryRateLimit=${parsed.primaryUsedPercent ?? '?'}% ` +
                    `secondaryRateLimit=${parsed.secondaryUsedPercent ?? '?'}% turns=${parsed.tokenCountEvents}\n\n`;
                }
              }
            }
          } catch (err) {
            console.warn('[mentor] Stage-B signal gathering failed (non-fatal):', err);
          }
          return analyzeForensics({
            framework,
            signals,
            evaluate: (prompt) => intelligence.evaluate(prompt, { model: 'capable', maxTokens: 1500, attribution: { component: 'mentor-stage-b' } }),
          });
        },
        // Safe-window: the mentee is "busy" iff there is an OUTSTANDING mentor
        // prompt already in-flight to it (the OutstandingPromptTracker is the
        // honest per-mentee busy signal — a prompt sent + not yet replied).
        // The mentee is REMOTE (a separate agent/process), so Echo's own
        // local session count says nothing about whether the mentee is free;
        // the prior code (listRunningSessions().length > 0) wrongly blocked
        // every tick because Echo always has sessions running. Gating on the
        // outstanding-prompt tracker means: don't send a new prompt while the
        // last one is unanswered — exactly the anti-ping-pong invariant.
        isMenteeBusy: () => {
          const cfg = getConfig();
          const menteeAgent = cfg.menteeAgentName || `instar-${cfg.menteeFramework}`;
          return !self.getOrCreateMentorOutstanding().canSendTo(menteeAgent).ok;
        },
        minIntervalElapsed: () => {
          const cfg = getConfig();
          return Date.now() - self.mentorLastTickAt >= cfg.minIntervalMs;
        },
        budgetOk: () => {
          const cfg = getConfig();
          const day = new Date().toISOString().slice(0, 10);
          if (self.mentorDayKey !== day) {
            self.mentorDayKey = day;
            self.mentorRunsToday = 0;
          }
          return self.mentorRunsToday < cfg.maxRoundsPerDay;
        },
        getSurface: (framework: string) => {
          const cfg = getConfig();
          const menteeAgent = cfg.menteeAgentName || `instar-${framework}`;
          // Real surface: the mentor's own agenda (its plan) + the mentee's recent
          // replies (what a user would see). Replaces the old empty-surface stub
          // that left Stage A blind → always observe-only / generic check-ins.
          return buildConversationSurface({
            framework,
            onboardingAgenda: cfg.onboardingAgenda,
            mentorSent: self.readRecentMentorSent(options.config.stateDir, menteeAgent),
            menteeReplies: self.readRecentMenteeReplies(options.config.stateDir, menteeAgent),
            nowMs: Date.now(),
          });
        },
        // Live delivery via the agent-to-agent Telegram comms primitive (spec
        // MENTOR-LIVE-READINESS §Fix 2b — Justin's substrate correction replaced the
        // earlier file-outbox design). Echo's mentor-bot (a second TelegramAdapter, gated
        // on mentor.botToken being set) sends a tagged [a2a:…] message to the mentee's
        // bot in a dedicated mentor topic. The anti-spawn-loop discipline lives in the
        // primitive (one outbound producer per role, no auto-reply, audit ledger). If
        // the bot isn't configured yet, this no-ops with a log — the dark default.
        deliverToMentee: async (framework: string, message: string) => {
          const cfg = getConfig();
          // Prefer the explicit registry name; fall back to the framework-derived
          // name (back-compat). framework=codex-cli but the agent registers as
          // instar-codey — using the derived name silently broke peer lookup.
          const menteeAgent = cfg.menteeAgentName || `instar-${framework}`;
          const corr = `mp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

          // Anti-ping-pong (spec §Fix 2b item 4 + Justin's original concern). Same
          // logic regardless of transport. Refuse to send a new prompt while a
          // prior one is unanswered within replyTimeoutMs.
          const outstanding = self.getOrCreateMentorOutstanding();
          const orphans = outstanding.sweepExpired();
          for (const orphan of orphans) {
            if (outstanding.recordOrphanNotified(orphan.corr)) {
              console.warn(`[mentor] orphaned prompt — no reply within ${orphan.ageMs}ms (corr=${orphan.corr}, mentee=${orphan.mentee})`);
              try {
                DegradationReporter.getInstance().report({
                  feature: 'mentor.reply-orphaned',
                  primary: 'mentor receives Codey reply within replyTimeoutMs',
                  fallback: 'tick continues; no auto-resend; Stage-B sees the routed-sent row + no matching reply row',
                  reason: `outstanding prompt corr=${orphan.corr} aged ${orphan.ageMs}ms without a mentor-reply`,
                  impact: 'mentor cycle silently lost a reply; next tick allowed to retry',
                });
              } catch { /* best-effort */ }
            }
          }
          const check = outstanding.canSendTo(menteeAgent);
          if (!check.ok) {
            console.warn(`[mentor] deliverToMentee deferred — prior-prompt-in-flight (corr=${check.outstandingCorr}, sentAt=${check.sentAt})`);
            return;
          }

          // Deliver via the unified a2a transport: same-machine /a2a/inbox
          // when the mentee is a local peer (Telegram blocks bot-to-bot, so
          // this is the canonical path), else the Telegram bot fallback
          // (cross-machine; currently unreachable, tracked follow-up).
          const telegramBot =
            cfg.botToken && cfg.menteeChatId
              ? self.getOrCreateMentorBot(cfg.botToken, cfg.menteeChatId) ?? undefined
              : undefined;
          const delivered = await self.deliverA2aMessage({
            fromAgent: 'echo',
            toAgent: menteeAgent,
            role: 'mentor',
            corr,
            body: message,
            allowedRoles: new Set(['mentor']),
            // Route the mentor exchange to a DEDICATED mentor topic when one is
            // configured, so the mentor's a2a check-ins don't interleave with
            // the human↔mentee conversation topic (menteeTopicId). This one id
            // drives both the /a2a/inbox body (where the mentee binds its
            // session) and the Telegram fallback, so the whole exchange moves
            // together. Falls back to menteeTopicId (backward-compatible).
            telegramTopicId: resolveMentorDeliveryTopic(cfg),
            targetMachineId: cfg.menteeMachineId,
            // fromBotId = echo's mentor-bot id, so the mentee's allowlist
            // (knownMentors[echo].botId === senderBotId) passes.
            fromBotId: cfg.botToken ? cfg.botToken.split(':')[0] : undefined,
            toBotId: cfg.menteeBotId,
            telegramBot: telegramBot
              ? { sendToTopic: (t, txt) => telegramBot.sendToTopic(t, txt) }
              : undefined,
            botToken: cfg.botToken,
            visibleEcho: {
              enabled: cfg.visibleEcho !== false,
              bot: telegramBot
                ? { sendToTopic: (t, txt) => telegramBot.sendToTopic(t, txt) }
                : undefined,
              topicId: resolveMentorDeliveryTopic(cfg),
              roleTag: '[mentor]',
              reportFailure: (reason) => {
                DegradationReporter.getInstance().report({
                  feature: 'mentor.visible-echo',
                  primary: 'successful inbox-local mentor delivery is mirrored visibly in Telegram',
                  fallback: 'canonical /a2a/inbox delivery remains successful; operator may see a phantom prompt',
                  reason,
                  impact: 'mentor exchange was delivered but its visible chat mirror is partial or absent',
                });
              },
            },
          });
          if (delivered) {
            self.appendMentorSent(options.config.stateDir, {
              ts: Date.now(),
              fromAgent: self.config.projectName,
              toAgent: menteeAgent,
              corr,
              topicId: resolveMentorDeliveryTopic(cfg),
              message,
            });
            outstanding.markSent(corr, menteeAgent);
          } else {
            console.warn(`[mentor] deliverToMentee did not deliver (corr=${corr}, mentee=${menteeAgent}) — no local peer + telegram fallback unavailable/blocked`);
          }
        },
        onTickRan: () => {
          self.mentorLastTickAt = Date.now();
          self.mentorRunsToday += 1;
        },
        // --- Autonomous-fix loop ("just be Echo") services (MENTOR-AUTONOMOUS-
        //     FIX-LOOP-SPEC). Only consulted when mentor.autonomousFix.enabled.
        //     E2E-PAIRING: EXEMPT — these are internal closures wired into the
        //     existing /mentor/tick + /mentor/status routes (no new API surface);
        //     covered by MentorAutonomousGuardian.test.ts (unit) + the mentor
        //     integration/E2E suites. ---
        loopSessionAlive: (): boolean => {
          const cfg = getConfig();
          const prefix = cfg.autonomousFix?.sessionNamePrefix || 'mentor-autoloop';
          // Single-instance: a loop session is any running session whose name
          // carries the prefix. A cycle outlives many heartbeats, so this is the
          // gate that prevents spawn-storming expensive Opus sessions.
          return self.sessionManager.listRunningSessions().some((s) => s.name?.startsWith(prefix));
        },
        buildAutoloopGoal: (framework: string): string =>
          buildAutoloopGoal({
            menteeAgentName: getConfig().menteeAgentName || `instar-${framework}`,
            menteeFramework: framework,
            // Report into the human's topic (autonomousFix.reportTopicId), else
            // the resolved mentor/mentee delivery topic.
            reportTopicId: getConfig().autonomousFix?.reportTopicId ?? resolveMentorDeliveryTopic(getConfig()),
            menteeTopicId: getConfig().menteeTopicId,
          }),
        spawnLoopSession: async (goal: string, model: string): Promise<{ sessionName: string }> => {
          const cfg = getConfig();
          const prefix = cfg.autonomousFix?.sessionNamePrefix || 'mentor-autoloop';
          const name = `${prefix}-${Date.now()}`;
          const maxCycleMinutes = cfg.autonomousFix?.maxCycleMinutes ?? 120;
          // Full-tool grant: omit allowedTools so the loop session gets Echo's
          // default toolset (bash/edit/git/gh) — it must actually be able to
          // ship fixes. Opus by config (Justin's constraint: all fixing on Opus).
          // spawnSession resolves once the session has STARTED (not completed),
          // so the guardian returns 'spawned' immediately while the cycle runs.
          // disableProjectMcp: a headless one-shot session that inherits the
          // project .mcp.json HANGS on boot (the auth-required remote MCP servers
          // can't OAuth headless). The loop uses built-in tools + bash + curl, not
          // MCP — so spawn with NO project MCP servers (verified: 4.5-min stall →
          // ~9s boot). Found by the live dogfood of the autonomous-fix loop.
          await self.sessionManager.spawnSession({
            name,
            prompt: goal,
            model: model || 'opus',
            maxDurationMinutes: Math.max(5, maxCycleMinutes),
            disableProjectMcp: true,
          });
          return { sessionName: name };
        },
        now: () => Date.now(),
      },
      getConfig,
    );
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    // Layer 2 boot self-check (spec § 2a "Runtime dependency"). Probes the
    // sqlite3 CLI + better-sqlite3 in-process driver and emits degradation
    // events on missing/broken substrate. Never throws — Layer 2 is best-
    // effort signal infrastructure, not a critical-path dependency.
    try {
      assertSqliteAvailable();
    } catch (err) {
      // Defensive: assertSqliteAvailable is documented as non-throwing,
      // but a malformed DegradationReporter could still raise. Log and
      // continue.
      console.warn('[instar] sqlite boot self-check raised:', err);
    }

    // Layer 3 spec §3b: create boot.id SYNCHRONOUSLY before binding the
    // listener. The sentinel reads this at start() to disambiguate stale
    // leases from prior boots (PID reuse). Any I/O failure here is
    // non-fatal — boot id is best-effort infrastructure for the sentinel,
    // which is itself feature-flagged default-off.
    try {
      if (this.config.stateDir) {
        getOrCreateBootId(this.config.stateDir, this.config.version);
      }
    } catch (err) {
      console.warn('[instar] boot.id creation raised (sentinel will fail to start):', err);
    }

    // Inc-P3d boot credential-coherence sample (Caroline-class observability).
    // Signal-only: compares the agent's repo-local identity against the
    // machine's other identity surfaces (inherited env, global gitconfig) and
    // records one boot-coherence line in credential-resolution.jsonl. Pure fs
    // reads; never throws; never blocks boot.
    try {
      // stateDir is <projectDir>/.instar — the repo whose local identity is
      // the agent's expected identity is its PARENT.
      const agentRepoDir = this.config.stateDir ? path.dirname(this.config.stateDir) : process.cwd();
      const coherence = auditBootCredentialCoherence(agentRepoDir);
      if (coherence && coherence.divergences.length > 0) {
        console.warn(
          `[instar] credential-coherence: ${coherence.divergences.length} identity surface(s) diverge from the agent's repo-local identity (see .instar/audit/credential-resolution.jsonl)`,
        );
      }
    } catch (err) {
      console.warn('[instar] boot credential-coherence sample raised:', err);
    }

    return new Promise((resolve, reject) => {
      // multi-transport-mesh-comms (Layer 0.5) — when this agent is MULTI-MACHINE
      // and the mesh transport is enabled, the server listens on the Tailscale/LAN
      // interfaces (not just localhost) so peers can reach it on the advertised
      // endpoints. `meshBindActive` is computed in server.ts from the CANONICAL
      // multi-machine signal `identityManager.hasIdentity()` — NOT the near-dead
      // `config.multiMachine.enabled` field a real multi-machine agent never sets
      // (that wrong predicate shipped the bind inert in 1.3.630; caught in
      // live-verify). A SINGLE-machine agent (no identity) keeps its 127.0.0.1 bind
      // (no peers ⇒ no benefit, and we must not newly expose it on the LAN). For a
      // multi-machine agent this is strictly LESS exposure than the always-on public
      // Cloudflare tunnel it already runs (every /api/* route keeps machine-auth, the
      // dashboard its PIN, the rest the Bearer token). Reversible:
      // meshTransport.enabled:false → back to 127.0.0.1. (Decision 17.)
      const meshTransport = this.config.multiMachine?.meshTransport;
      const host = resolveMeshBindHost({
        configHost: this.config.host,
        meshBindActive: this.meshBindActive,
        meshBindHostOverride: meshTransport?.bindHost,
      });
      this.server = this.app.listen(this.config.port, host, () => {
        console.log(`[instar] Server listening on ${host}:${this.config.port}`);
        console.log(`[instar] Dashboard: http://${host}:${this.config.port}/dashboard`);

        // Initialize WebSocket manager after server is listening
        this.wsManager = new WebSocketManager({
          server: this.server!,
          sessionManager: this.sessionManager,
          state: this.state,
          authToken: this.config.authToken,
          instarDir: this.config.stateDir,
          hookEventReceiver: this.hookEventReceiver,
          streamTicketStore: this.streamTicketStore,
          poolStreamAllowRemoteInput: this.poolStreamAllowRemoteInput,
          poolStreamConnector: this.poolStreamConnector,
          selfMachineId: this.meshSelfId,
        });

        // Update route context with WebSocket manager (deferred — created after routes)
        if (this.routeContext) {
          this.routeContext.wsManager = this.wsManager;
        }

        // ── Account Follow-Me delivered-mandate consumer (WS5.2 seam #1) ──
        // A boot-sweep + periodic tick that turns an operator-approved+delivered
        // mandate into an actual login on this target machine. Idempotent (skips
        // already-pending/enrolled accounts) and authority-free (it nudges the real
        // enroll-start route, which enforces the dev-gate + deny-by-default + the
        // point-of-use mandate re-verify). Inert when there's no delivered-mandate
        // store. Boot-sweep is delayed a few seconds so routes are fully wired.
        if (this.deliveredMandateStore) {
          // .unref() both timers so they NEVER keep the event loop alive — otherwise a
          // test (or any short-lived boot) that constructs AgentServer hangs waiting for
          // these handles to drain (the CI shard-4/4 hang). Matches the sibling pollers.
          const bootSweep = setTimeout(() => { void this.driveDeliveredFollowMeEnrollments(); }, 8_000);
          if (typeof bootSweep.unref === 'function') bootSweep.unref();
          this.followMeConsumerTimer = setInterval(() => {
            void this.driveDeliveredFollowMeEnrollments();
          }, 60_000);
          if (typeof this.followMeConsumerTimer.unref === 'function') this.followMeConsumerTimer.unref();
        }

        // ── Token Ledger Poller ─────────────────────────────────────────
        // 60s tick scans `~/.claude/projects/*/*.jsonl` and rolls up into
        // the token_events table. Strictly read-only against source files.
        // On Codex-engine hosts it ALSO scans this agent's Codex rollouts
        // (`$CODEX_HOME/sessions`, attributed by cwd) into the separate
        // codex_token_sessions table — closing the "ledger blind to Codex"
        // gap. process.cwd() is the agent's project dir (launchd sets the
        // server's working directory to it), matching session_meta.cwd.
        if (this.tokenLedger) {
          try {
            this.tokenLedgerPoller = new TokenLedgerPoller({
              ledger: this.tokenLedger,
              codexProjectDir: process.cwd(),
              // Idle-aware cadence (Responsible Resource Usage): back off the
              // JSONL scan while no sessions are running — there are no new
              // tokens to attribute, so the full-cadence scan is wasted.
              isIdle: () => this.sessionManager.listRunningSessions().length === 0,
              afterTick: async () => {
                await this.apprenticeshipCycleSlaMonitor?.tick();
                await this.geminiCapacityEscalationMonitor?.tick();
              },
            });
            this.tokenLedgerPoller.start();
          } catch (err) {
            console.warn('[instar] token-ledger poller start failed:', err);
          }

          // ── Burn-detection auto-heal system ──────────────────────────
          // Wires the six phases together. Detector polls the ledger,
          // emits degradation events; runbook subscribes via the existing
          // DegradationReporter healer surface; verifier schedules the
          // post-throttle re-sample. The full pipeline is signal-only on
          // observation paths and Tier-2 Remediator authority on decision
          // paths — see docs/specs/token-burn-detection-and-self-heal.md.
          //
          // Operator control: `monitoring.burnDetection.*` (all optional;
          // absence preserves the shipped defaults). `enabled: false` is the
          // master kill-switch — the whole system stays down. The other knobs
          // (absoluteShareThreshold, absoluteShareActivityFloorTokens,
          // alertTopicId, autoThrottle, autoThrottleOnUnknown) tune behaviour
          // without code changes. The activity floor is the 2026-06-03 fix that
          // stops a finished heavy session re-alarming for a full 24h.
          const burnCfg = this.config.monitoring?.burnDetection;
          if (burnCfg?.enabled === false) {
            console.log('[instar] burn-detection disabled via monitoring.burnDetection.enabled=false');
          } else {
            try {
              const ledger = this.tokenLedger;
              const reporter = DegradationReporter.getInstance();
              const gate = LlmRateGate.instance();
              const telegram = this.telegramAdapter;
              const burnAlertDelivery = telegram && typeof (telegram as { sendToTopic?: unknown }).sendToTopic === 'function'
                && typeof (telegram as { createAttentionItem?: unknown }).createAttentionItem === 'function'
                ? new BurnAlertDelivery({
                    sendToTopic: (topicId, text) => telegram.sendToTopic(topicId, text),
                    raiseAttention: (item) => telegram.createAttentionItem(item),
                    hasAttentionItem: (id) => telegram.getAttentionItem(id) !== undefined,
                    stateFile: this.config.stateDir
                      ? path.join(this.config.stateDir, 'state', 'burn-alert-delivery.json')
                      : undefined,
                  })
                : undefined;
              if (burnAlertDelivery) {
                void burnAlertDelivery.recoverPending().catch((err: unknown) => {
                  console.error(`[burn-detection] pending terminal notice recovery failed: ${(err as Error)?.message ?? err}`);
                });
              }
              const sendTelegram = burnAlertDelivery
                ? (topicId: number, text: string) => burnAlertDelivery.deliver(topicId, text)
                : undefined;

              // Build partial configs WITHOUT undefined keys — a `{ x: undefined }`
              // override would clobber the constructor's default for x.
              const runbookConfig: Partial<BurnThrottleConfig> = {};
              if (burnCfg?.autoThrottle !== undefined) runbookConfig.autoThrottle = burnCfg.autoThrottle;
              if (burnCfg?.autoThrottleOnUnknown !== undefined) runbookConfig.autoThrottleOnUnknown = burnCfg.autoThrottleOnUnknown;

              const detectorConfig: Partial<BurnDetectionConfig> = {};
              if (burnCfg?.absoluteShareThreshold !== undefined) detectorConfig.absoluteShareThreshold = burnCfg.absoluteShareThreshold;
              if (burnCfg?.absoluteShareActivityFloorTokens !== undefined) detectorConfig.absoluteShareActivityFloorTokens = burnCfg.absoluteShareActivityFloorTokens;

              this.burnThrottleRunbook = new BurnThrottleRunbook({
                gate,
                sendTelegram,
                alertTopicId: burnCfg?.alertTopicId,
                config: runbookConfig,
              });
              this.burnVerifier = new BurnVerifier({ ledger, sendTelegram, alertTopicId: burnCfg?.alertTopicId });
              registerBurnDetectionSubscriber(reporter, this.burnThrottleRunbook, (outcome, event) => {
                this.burnVerifier!.scheduleVerification(outcome, event);
              });
              this.burnDetector = new BurnDetector({
                ledger,
                reporter,
                config: detectorConfig,
                // §8 ultra-cap monitor rides this tick (no new poller —
                // FABLE-MODEL-ESCALATION-SPEC round-3 Integration-NEW-2).
                ...(this.ultraCapMonitor ? { ultraCapMonitor: this.ultraCapMonitor } : {}),
              });
              this.burnDetector.start();
              console.log('[instar] burn-detection auto-heal system started');
            } catch (err) {
              console.warn('[instar] burn-detection start failed (non-fatal):', err);
            }
          }
        }

        // ── Mentee receiver wiring (MENTOR-LIVE-READINESS-SPEC §Recipient side) ──
        // Installs the agent-message hook on the PRIMARY TelegramAdapter so
        // inbound mentor PROMPTS from allowlisted mentor agents are routed
        // to a mentee role-handler (spawn session → bounded-wait →
        // mentor-reply). Ships dormant: `mentee.enabled` defaults false.
        // No-ops cleanly when `telegramAdapter === null` (agents without
        // Telegram) or when the config block is incomplete (each missing
        // piece logs one line and bails — no partial wiring).
        try {
          this.installMentorMessageHook();
        } catch (err) {
          console.warn('[mentee] receiver wiring raised (non-fatal):', err);
        }

        // ── Layer 3 DeliveryFailureSentinel — default-OFF feature flag ──
        // Spec § 3j: `monitoring.deliveryFailureSentinel.enabled` defaults
        // false. The sentinel only spins up when an operator explicitly
        // opts in. Layer 1 + Layer 2 ship unconditionally; Layer 3 is the
        // opt-in upgrade for general delivery resilience.
        const monitoringCfg = (this.config as { monitoring?: { deliveryFailureSentinel?: { enabled?: boolean } } }).monitoring;
        const sentinelEnabled = monitoringCfg?.deliveryFailureSentinel?.enabled === true;
        if (sentinelEnabled && this.config.stateDir) {
          try {
            this.startDeliverySentinel().catch((err) => {
              console.warn('[instar] delivery-failure-sentinel start failed:', err);
            });
          } catch (err) {
            console.warn('[instar] delivery-failure-sentinel start raised:', err);
          }
        }

        // Ingestion source `ci` (spec §3.1) — start the poller (constructed
        // gated on sources.ci) after listen, like the token-ledger poller.
        if (this.ciFailurePoller) {
          try {
            this.ciFailurePoller.start();
          } catch (err) {
            console.warn('[instar] ci-failure poller start failed:', err);
          }
        }
        // Ingestion source `revert` (spec §3.2).
        if (this.revertDetector) {
          try {
            this.revertDetector.start();
          } catch (err) {
            console.warn('[instar] revert-detector start failed:', err);
          }
        }

        resolve();
      });
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.config.port} is already in use. Is another instar server running?`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Spin up the Layer 3 DeliveryFailureSentinel. Opens the per-agent
   * pending-relay SQLite store (creating it lazily if needed), wires
   * the sentinel into the WebSocket event stream so `delivery_failed`
   * events drive recovery in <1s, and arms the watchdog tick.
   *
   * Failures here are isolated — the sentinel is opt-in default-OFF
   * infrastructure, not a critical-path dependency. Any error here is
   * logged and the rest of the server continues running.
   */
  /**
   * WS5.2 Account Follow-Me — the DELIVERED-MANDATE CONSUMER (seam #1 of the live-proof fix).
   *
   * After the operator taps Approve on their dashboard, the mandate is issued + delivered to THIS
   * (target) machine's DeliveredMandateStore — but nothing turned that into an actual login, so the
   * proof stalled with "machine logging in now" then silence (2026-06-18, topic 13481). This sweep is
   * the missing caller: it walks the delivered-mandate store and drives the enroll-start for each
   * account-follow-me mandate that hasn't already produced a pending login or an enrolled account.
   *
   * Idempotent + re-mint-safe by construction (no separate single-flight store needed): it SKIPS any
   * account that already has a pending login (in-flight) or is already in the pool (done), so a fresh
   * tick never re-drives a login that's underway or complete. It reuses the REAL enroll-start route
   * (self-POST to localhost) so all auth/gate/email-resolution/device-code logic stays in one place —
   * including the point-of-use mandate re-verify and the seam #2 peer-view email resolution. The route
   * enforces the dev-gate (503 when off) + deny-by-default, so this consumer carries NO authority of
   * its own; it only nudges the route for mandates the operator already approved + delivered.
   */
  private async driveDeliveredFollowMeEnrollments(): Promise<void> {
    if (this.followMeConsumerRunning) return; // re-entrancy guard (a slow tick must not overlap)
    if (!this.deliveredMandateStore) return;
    this.followMeConsumerRunning = true;
    try {
      const now = Date.now();
      const delivered = this.deliveredMandateStore.list().filter((r) => {
        const m = r.portable?.mandate;
        if (!m || m.revoked) return false;
        if (m.expiresAt && Date.parse(m.expiresAt) <= now) return false;
        return (m.authorities ?? []).some((a) => a.action === 'account-follow-me' && (a.bounds ?? {}).accountId);
      });
      if (delivered.length === 0) return;

      const host = this.config.host || '127.0.0.1';
      const base = `http://${host}:${this.config.port}`;
      const authHeader = { Authorization: `Bearer ${this.config.authToken ?? ''}` };

      // Build the set of accounts already handled (pending login in flight, or already enrolled) so a
      // tick never re-drives — the durable idempotency (pending logins + pool both persist on disk).
      const handled = new Set<string>();
      try {
        const [pl, sp] = await Promise.all([
          fetch(`${base}/subscription-pool/pending-logins`, { headers: authHeader, signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch(`${base}/subscription-pool`, { headers: authHeader, signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]) as [{ logins?: Array<{ id?: string }> } | null, { accounts?: Array<{ id?: string }> } | null];
        for (const l of pl?.logins ?? []) if (l?.id) handled.add(l.id);
        for (const a of sp?.accounts ?? []) if (a?.id) handled.add(a.id);
      } catch { /* best-effort — a read failure just means we may attempt; the route is idempotent-enough */ }

      for (const rec of delivered) {
        const m = rec.portable.mandate;
        const accountId = ((m.authorities ?? []).find((a) => a.action === 'account-follow-me')?.bounds ?? {}).accountId as string | undefined;
        if (!accountId || handled.has(accountId)) continue; // already pending or enrolled — never re-drive
        try {
          const resp = await fetch(`${base}/subscription-pool/follow-me/enroll/start`, {
            method: 'POST',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ mandateId: rec.id, accountId }),
            // Generous bound (the device-code drive legitimately runs up to ~180s) but never
            // unbounded — so a wedged drive can't hang the loop / a test process.
            signal: AbortSignal.timeout(200_000),
          });
          const ok = resp.ok;
          console.log(`[follow-me-consumer] drove enroll-start for ${accountId} (mandate ${rec.id}) → ${resp.status}${ok ? '' : ' (will retry next tick)'}`);
          if (ok) handled.add(accountId); // don't double-drive within this same tick
        } catch (err) {
          console.warn(`[follow-me-consumer] enroll-start self-call failed for ${accountId} (mandate ${rec.id}):`, err);
        }
      }
    } catch (err) {
      console.warn('[follow-me-consumer] sweep failed (non-fatal):', err);
    } finally {
      this.followMeConsumerRunning = false;
    }
  }

  private async startDeliverySentinel(): Promise<void> {
    const stateDir = this.config.stateDir;
    const agentId = this.config.projectName;
    if (!stateDir || !agentId) return;

    let store: PendingRelayStore;
    try {
      store = PendingRelayStore.open(agentId, stateDir);
    } catch (err) {
      console.warn('[delivery-sentinel] pending-relay-store open failed; sentinel disabled:', err);
      return;
    }
    this.deliveryStore = store;
    // §2.1 redrive exemption (outbound-jargon-filepath-gap): let the reply
    // route validate an X-Instar-DeliveryId against an ACTUAL queue row so a
    // legacy kindless redrive is exempt from the bypass breadcrumb while a
    // fabricated header is not. Read-only, best-effort.
    if (this.routeContext) {
      this.routeContext.pendingRelayLookup = (deliveryId: string) => {
        try {
          return store.findByDeliveryId(deliveryId) !== null;
        } catch {
          /* @silent-fallback-ok — observe-only breadcrumb exemption: a store read failure means no exemption (false), never an error surface */
          return false;
        }
      };
    }

    const bootId = (await import('./boot-id.js')).getCurrentBootId();
    if (!bootId) {
      console.warn('[delivery-sentinel] bootId not initialized; sentinel cannot start');
      return;
    }

    const configPath = path.join(stateDir, 'config.json');
    const sentinel = new DeliveryFailureSentinel(
      {
        store,
        configPath,
        readConfig: () => ({
          port: this.config.port,
          authToken: this.config.authToken ?? '',
          agentId,
        }),
        bootId,
        toneGate: this.toneGate,
        subscribeFailureEvents: this.wsManager
          ? (listener) => {
              const handler = (event: Record<string, unknown>) => {
                if (event.type === 'delivery_failed' && event.agentId === agentId) {
                  listener(event as unknown as { delivery_id: string; topic_id: number; agentId: string });
                }
              };
              return this.wsManager!.subscribeEvents(handler);
            }
          : undefined,
      },
    );
    this.deliverySentinel = sentinel;
    await sentinel.start();
    console.log('[instar] delivery-failure-sentinel started (Layer 3 recovery active)');
  }

  /**
   * Stop the HTTP server gracefully.
   * Closes keep-alive connections after a timeout to prevent hanging.
   */
  async stop(): Promise<void> {
    // Stop the feedback-inbox drainer's poll loop (pure timer; store appends are
    // synchronous so there is no in-flight write to wait on).
    if (this.inboxDrainer) {
      try {
        this.inboxDrainer.stop();
      } catch {
        // best-effort
      }
      this.inboxDrainer = null;
    }
    // Stop the mentor bot adapter first (it has its own poll loop + state files
    // under the subDir; clean shutdown avoids stranded background work).
    if (this.mentorBotAdapter) {
      try {
        await this.mentorBotAdapter.stop();
      } catch (err) {
        console.warn('[mentor] mentor-bot adapter stop raised:', err);
      }
      this.mentorBotAdapter = null;
      this.mentorBotAdapterToken = null;
    }
    // Stop the Layer 3 sentinel BEFORE the WebSocket manager — the
    // sentinel's SSE subscription needs an alive wsManager to clean up
    // its listener. Order: sentinel → wsManager → server.
    if (this.deliverySentinel) {
      try {
        await this.deliverySentinel.stop();
      } catch (err) {
        console.warn('[instar] delivery-failure-sentinel stop raised:', err);
      }
      this.deliverySentinel = null;
    }
    if (this.deliveryStore) {
      try {
        this.deliveryStore.close();
      } catch {
        // best-effort
      }
      this.deliveryStore = null;
    }

    // Stop the burn-detector before the ledger closes — the detector's tick
    // would otherwise hit a closed DB handle.
    if (this.burnDetector) {
      try {
        this.burnDetector.stop();
      } catch {
        // best-effort
      }
      this.burnDetector = null;
    }
    // Drop references so any pending verifier timers can no-op gracefully.
    this.burnThrottleRunbook = null;
    this.burnVerifier = null;

    // Stop the CI-failure poller (ingestion source §3.1).
    if (this.ciFailurePoller) {
      try {
        this.ciFailurePoller.stop();
      } catch {
        // best-effort
      }
      this.ciFailurePoller = null;
    }
    // Stop the revert detector (ingestion source §3.2).
    if (this.revertDetector) {
      try {
        this.revertDetector.stop();
      } catch {
        // best-effort
      }
      this.revertDetector = null;
    }
    // Stop the token-ledger poller and close its DB.
    if (this.tokenLedgerPoller) {
      try {
        this.tokenLedgerPoller.stop();
      } catch {
        // best-effort
      }
      this.tokenLedgerPoller = null;
    }
    // Stop the resource-ledger poller (unsubscribes the breaker observer) + the
    // Phase-B CPU/mem sampler + close the ledger.
    if (this.resourceSampler) {
      try { this.resourceSampler.stop(); } catch { /* best-effort */ }
      this.resourceSampler = null;
    }
    if (this.resourceLedgerPoller) {
      try { this.resourceLedgerPoller.stop(); } catch { /* best-effort */ }
      this.resourceLedgerPoller = null;
    }
    // Stop the AutonomousLivenessReconciler tick loop (clears its unref'd timer).
    try { this.routeContext?.autonomousLivenessReconciler?.stop(); } catch { /* best-effort */ }
    if (this.parallelWorkSentinelTimer) {
      try { clearInterval(this.parallelWorkSentinelTimer); } catch { /* best-effort */ }
      this.parallelWorkSentinelTimer = null;
    }
    if (this.followMeConsumerTimer) {
      try { clearInterval(this.followMeConsumerTimer); } catch { /* best-effort */ }
      try { if (this.mcpIdleOffloadSweepTimer) clearInterval(this.mcpIdleOffloadSweepTimer); } catch { /* best-effort */ }
      this.followMeConsumerTimer = null;
    }
    // Stop the growth-digest publisher's cron + pending catch-up timer.
    if (this.growthDigestPublisher) {
      try { this.growthDigestPublisher.stop(); } catch { /* @silent-fallback-ok — best-effort teardown at shutdown */ }
      this.growthDigestPublisher = null;
    }
    this.parallelWorkSentinel = null;
    if (this.resourceLedger) {
      try { this.resourceLedger.close(); } catch { /* best-effort */ }
      this.resourceLedger = null;
    }
    try { this.benchmarkDivergenceAnalyzer?.stop(); } catch { /* @silent-fallback-ok: pending-jitter teardown is best-effort cleanup at shutdown */ }
    if (this.featureMetricsPruneTimer) {
      try { clearInterval(this.featureMetricsPruneTimer); } catch { /* @silent-fallback-ok: timer teardown is best-effort cleanup at shutdown */ }
      try { if (this.meteredSweepTimer) clearInterval(this.meteredSweepTimer); } catch { /* @silent-fallback-ok: timer teardown is best-effort cleanup at shutdown */ }
      try { if (this.spendAlertTimer) clearInterval(this.spendAlertTimer); } catch { /* @silent-fallback-ok: timer teardown is best-effort cleanup at shutdown */ }
      try { await this.spendAlertDispatcher?.flushDigest(); } catch { /* @silent-fallback-ok: a failed final digest flush loses only a coalesced NOTICE at shutdown */ }
      try { if (this.reconSweepTimer) clearInterval(this.reconSweepTimer); } catch { /* @silent-fallback-ok: timer teardown is best-effort cleanup at shutdown */ }
      this.featureMetricsPruneTimer = null;
    }
    if (this.tokenLedger) {
      try {
        this.tokenLedger.close();
      } catch {
        // best-effort
      }
      this.tokenLedger = null;
    }
    if (this.apprenticeshipCycleStore) {
      try {
        this.apprenticeshipCycleStore.close();
      } catch {
        // best-effort
      }
      this.apprenticeshipCycleStore = null;
    }
    this.apprenticeshipCycleSlaMonitor = null;
    this.geminiCapacityEscalationMonitor = null;

    // Shutdown WebSocket manager first
    if (this.wsManager) {
      this.wsManager.shutdown();
      this.wsManager = null;
    }

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceTimer);
        this.server = null;
        resolve();
      };

      // Force-close after 5 seconds if graceful close hangs (keep-alive connections)
      const forceTimer = setTimeout(() => {
        console.log('[instar] Force-closing server (keep-alive timeout)');
        this.server?.closeAllConnections?.();
        done();
      }, 5000);
      forceTimer.unref(); // Don't prevent process exit during shutdown

      this.server.close(() => done());
    });
  }

  /**
   * Expose the Express app for testing with supertest.
   */
  getApp(): Express {
    return this.app;
  }

  /**
   * WS5.2 R4a — TARGET-side acceptance of a cross-machine-delivered account-follow-me mandate (the
   * brains behind the `account-follow-me-mandate-deliver` mesh handler, which is wired in server.ts
   * where the peer-key resolver lives). `sender` MUST be the mesh-AUTHENTICATED envelope sender;
   * `operatorPublicKeyPem` is that sender's REGISTERED Ed25519 key (resolved by the caller from the
   * same registered-identity store verifyEnvelope used) — never a key from the payload. FAIL CLOSED:
   * feature dark / no store / signature-or-bounds failure → refuse + persist nothing.
   */
  acceptDeliveredMandateCommand(
    sender: string,
    portable: import('../coordination/AccountFollowMeMandateBridge.js').PortableMandate | undefined | null,
    operatorPublicKeyPem: string | null,
  ): { accepted: boolean; reason?: string; mandateId?: string } {
    if (!this.deliveredMandateStore) return { accepted: false, reason: 'delivered-mandate-store-unavailable' };
    const enabled = resolveDevAgentGate(
      (this.config as unknown as { multiMachine?: { accountFollowMe?: { enabled?: boolean } } })
        .multiMachine?.accountFollowMe?.enabled,
      this.config,
    );
    const result = acceptMandateDelivery(
      {
        enabled: () => enabled,
        selfMachineId: () => this.meshSelfId ?? (this.config as { machineId?: string }).machineId ?? 'local',
        operatorMachinePublicKey: () => operatorPublicKeyPem,
        store: this.deliveredMandateStore,
        log: (m) => console.log(m),
      },
      sender,
      portable,
    );
    return result.accepted
      ? { accepted: true, mandateId: result.mandateId }
      : { accepted: false, reason: result.reason };
  }

  /** Wiring-integrity accessor: the ParallelWorkSentinel when constructed (enabled), else null. */
  getParallelWorkSentinel(): ParallelWorkSentinel | null {
    return this.parallelWorkSentinel;
  }

  /**
   * Wiring-integrity accessor: the PRODUCTION Self-Unblock checklist (real probe
   * providers + durable run store) when the self-unblock sub-feature is on, else
   * null. The PRODUCER surface POST /blockers/self-unblock-run runs this.
   */
  getSelfUnblockChecklist(): SelfUnblockChecklist | null {
    return this.selfUnblockChecklist;
  }

  /**
   * The topic-operator store (Know Your Principal #898). Exposed so the inbound
   * routing seam (`wireTelegramRouting`, increment 2e) binds the operator on the
   * POLLING ingress path with the SAME instance the routes use — the store caches
   * its map in memory, so constructing a second instance on the same file would
   * lose updates between the two caches.
   */
  /** Increment C — the router fan-out + gate observer reach the emitters here (late-bound; null while dark). */
  getSpendAlertEmitters(): SpendAlertEmitters | null {
    return this.spendAlertEmitters;
  }

  /**
   * Shared builder for the "💰 Routing & Spend Alerts" topic resolver — used by
   * BOTH the Increment-B money block (stale-price cadence) and the Increment-C
   * alert layer, whichever constructs first. Rung 2 carries both halves: the
   * machine-local persisted record AND the pool-published registry field
   * (FD-6 — a future serving-lease holder inherits the id, never re-creates).
   */
  private buildSpendAlertResolver(
    tg: TelegramAdapter,
    config: { stateDir: string; machineId?: string; routingSpend?: { alerts?: { telegramTopicId?: number | null } } },
    poolOn: boolean,
  ): SpendAlertResolver {
    const persistPath = path.join(config.stateDir, 'state', 'routing-spend-alert-topic.json');
    const machineId = (config as { machineId?: string }).machineId;
    const registry = new MachineIdentityManager(config.stateDir);
    return new SpendAlertResolver({
      configuredTopicId: () => {
        const id = config.routingSpend?.alerts?.telegramTopicId;
        return typeof id === 'number' && Number.isFinite(id) ? id : undefined;
      },
      readPersistedTopicId: () => {
        try {
          const raw = JSON.parse(fs.readFileSync(persistPath, 'utf-8')) as { topicId?: number };
          return typeof raw.topicId === 'number' ? raw.topicId : undefined;
        } catch {
          // @silent-fallback-ok: no persisted record yet — rung 2 simply misses.
          return undefined;
        }
      },
      persistTopicId: (topicId) => {
        try {
          const tmp = persistPath + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify({ topicId }), { mode: 0o600 });
          fs.renameSync(tmp, persistPath);
        } catch {
          // @silent-fallback-ok: a failed persist means the next resolve re-runs
          // the ladder; creation stays fenced, so no duplicate can result.
        }
      },
      // FD-6 rung 2, pool half: the replicated machine-registry field.
      readPoolPublishedTopicId: () => registry.readAnyRoutingSpendAlertTopic(),
      publishTopicId: (topicId) => {
        if (!machineId) return; // single-machine installs: the local record suffices
        registry.updateRoutingSpendAlertTopic(machineId, topicId);
      },
      // Single machine trivially self-confirms (it IS the serving lease); on a
      // multi-machine pool the confirmed-lease plumbing is a tracked follow-up —
      // until then this machine does NOT create (fail toward the lifeline)
      // <!-- tracked: CMT-1929 -->.
      servingLeaseConfirmedAgoMs: () => (poolOn ? null : 0),
      createTopic: async () => {
        const t = await tg.createForumTopic('💰 Routing & Spend Alerts', undefined, {
          origin: 'system',
          bounded: true,
          label: 'routing-spend-alerts',
        });
        return t.topicId;
      },
      sendToTopic: async (topicId, text) => {
        await tg.sendToTopic(topicId, text);
        return true;
      },
      lifelineTopicId: () => tg.getLifelineTopicId(),
    });
  }

  getTopicOperatorStore(): TopicOperatorStore | null {
    return this.topicOperatorStore;
  }

  /**
   * TOPIC-PROFILE-SPEC §9 — the escalation governor, exposed for the
   * orchestrator's escalation port (server.ts wiring late-binds through the
   * AgentServer ref so a profile-triggered kill releases the topic's ultra
   * lease). Null when model-tier escalation failed to initialize.
   */
  getEscalationGovernor(): EscalationGovernor | null {
    return this.escalationGovernorRef;
  }

  /**
   * WS5.3 (escalation-rides-topic) — the ephemeral per-topic escalation-hint
   * carrier, exposed so the server.ts wiring can (a) let the topic-profile
   * pull serve-handler PEEK the hint to carry it across the acquire pull, and
   * (b) drive the destination CONSUME + re-admit when the resumed session
   * spawns. Null when model-tier escalation failed to initialize.
   */
  getEscalationHintStore(): EscalationHintStore | null {
    return this.escalationHints;
  }

  /**
   * TOPIC-PROFILE-SPEC §7 — the FABLE in-flight swap engine, exposed for the
   * orchestrator's inFlightSwap port (the §7 in-flight row delegates to the
   * SAME ModelSwapService the /sessions/:name/model-swap route uses, so the
   * §10.2 closed-enum + cost-guard + idle disciplines apply identically).
   */
  getModelTierSwap(): ModelSwapService | null {
    return this.modelTierSwap;
  }
}
