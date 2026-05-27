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
import { createHash, timingSafeEqual } from 'node:crypto';
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
import { createFileRoutes } from './fileRoutes.js';
import { mountWhatsAppWebhooks } from '../messaging/backends/WhatsAppWebhookRoutes.js';
import { createMachineRoutes } from './machineRoutes.js';
import { createWorktreeRoutes, createOidcWorktreeRoutes } from './worktreeRoutes.js';
import { registerRemediationProposalsRoutes } from './routes/remediation-proposals.js';
import { TrustElevationSource } from '../remediation/TrustElevationSource.js';
import { createTopicIntentRoutes } from './topicIntentRoutes.js';
import { FailureLedger } from '../monitoring/FailureLedger.js';
import { FailureAttributionEngine } from '../monitoring/FailureAttributionEngine.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { createSpecReviewRoutes } from './specReviewRoutes.js';
import { createUsherRoutes } from './usherRoutes.js';
import type { TopicIntentStore } from '../core/TopicIntent.js';
import type { WorktreeManager } from '../core/WorktreeManager.js';
import { corsMiddleware, authMiddleware, requestTimeout, buildRequestTimeoutOverrides, errorHandler, dashboardSecurityHeaders } from './middleware.js';
import { WebSocketManager } from './WebSocketManager.js';
import { assertSqliteAvailable, PendingRelayStore } from '../messaging/pending-relay-store.js';
import { getOrCreateBootId } from './boot-id.js';
import { DeliveryFailureSentinel } from '../monitoring/delivery-failure-sentinel.js';
import os from 'node:os';
import { TokenLedger } from '../monitoring/TokenLedger.js';
import { TokenLedgerPoller } from '../monitoring/TokenLedgerPoller.js';
import { FrameworkIssueLedger } from '../monitoring/FrameworkIssueLedger.js';
import { MentorOnboardingRunner, DEFAULT_MENTOR_CONFIG, type MentorConfig } from '../scheduler/MentorOnboardingRunner.js';
import { STAGE_A_ALLOWED_TOOLS } from '../monitoring/MentorStageA.js';
import { analyzeForensics } from '../scheduler/MentorStageBForensics.js';
import { parseCodexRollout } from '../monitoring/CodexRolloutParser.js';
import type { ForensicFinding } from '../monitoring/FrameworkIssueLedger.js';
import { BurnDetector } from '../monitoring/BurnDetector.js';
import { BurnThrottleRunbook } from '../monitoring/BurnThrottleRunbook.js';
import { BurnVerifier } from '../monitoring/BurnVerifier.js';
import { LlmRateGate } from '../monitoring/LlmRateGate.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { registerBurnDetectionSubscriber } from '../monitoring/BurnDetectionSubscriber.js';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { bridgeNativeHealToDegradation } from '../monitoring/NativeHealDegradationBridge.js';

export class AgentServer {
  private app: Express;
  private server: Server | null = null;
  private wsManager: WebSocketManager | null = null;
  private config: InstarConfig;
  private startTime: Date;
  private sessionManager: SessionManager;
  private state: StateManager;
  private hookEventReceiver?: import('../monitoring/HookEventReceiver.js').HookEventReceiver;
  private routeContext: { wsManager: import('./WebSocketManager.js').WebSocketManager | null } | null = null;
  private deliverySentinel: DeliveryFailureSentinel | null = null;
  private deliveryStore: PendingRelayStore | null = null;
  private toneGate: import('../core/MessagingToneGate.js').MessagingToneGate | null = null;
  private tokenLedger: TokenLedger | null = null;
  private tokenLedgerPoller: TokenLedgerPoller | null = null;
  private frameworkIssueLedger: FrameworkIssueLedger | null = null;
  private mentorRunner: MentorOnboardingRunner | null = null;
  /** Wall-clock of the last mentor tick that ran, for the min-interval floor. */
  private mentorLastTickAt = 0;
  /** UTC day + run count for the per-day mentor cap (resets across days). */
  private mentorDayKey = '';
  private mentorRunsToday = 0;
  private failureLedger: FailureLedger | null = null;
  private failureAttributionEngine: FailureAttributionEngine | null = null;
  // Burn-detection-and-self-heal system (six-phase umbrella spec at
  // docs/specs/token-burn-detection-and-self-heal.md). Lazy-initialised
  // after the TokenLedger comes up — burn detection without a ledger is
  // a no-op.
  private burnDetector: BurnDetector | null = null;
  private burnThrottleRunbook: BurnThrottleRunbook | null = null;
  private burnVerifier: BurnVerifier | null = null;
  // Stored from constructor options for use in start()'s listen callback.
  // The burn-detection system needs this to route alerts; no other
  // AgentServer code reads it (the route handlers go through routeCtx).
  private telegramAdapter: TelegramAdapter | null = null;

  constructor(options: {
    config: InstarConfig;
    sessionManager: SessionManager;
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
    semanticMemory?: import('../memory/SemanticMemory.js').SemanticMemory;
    activitySentinel?: import('../monitoring/SessionActivitySentinel.js').SessionActivitySentinel;
    rateLimitSentinel?: import('../monitoring/RateLimitSentinel.js').RateLimitSentinel;
    releaseReadinessSentinel?: import('../monitoring/ReleaseReadinessSentinel.js').ReleaseReadinessSentinel;
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
    sessionRefresh?: import('../core/SessionRefresh.js').SessionRefresh;
    autonomyManager?: import('../core/AutonomyProfileManager.js').AutonomyProfileManager;
    trustElevationTracker?: import('../core/TrustElevationTracker.js').TrustElevationTracker;
    autonomousEvolution?: import('../core/AutonomousEvolution.js').AutonomousEvolution;
    coordinator?: MultiMachineCoordinator;
    localSigningKeyPem?: string;
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
    responseReviewGate?: import('../core/CoherenceGate.js').CoherenceGate;
    messagingToneGate?: import('../core/MessagingToneGate.js').MessagingToneGate;
    outboundDedupGate?: import('../core/OutboundDedupGate.js').OutboundDedupGate;
    telemetryHeartbeat?: import('../monitoring/TelemetryHeartbeat.js').TelemetryHeartbeat;
    pasteManager?: import('../paste/PasteManager.js').PasteManager;
    soulManager?: import('../core/SoulManager.js').SoulManager;
    featureRegistry?: import('../core/FeatureRegistry.js').FeatureRegistry;
    discoveryEvaluator?: import('../core/DiscoveryEvaluator.js').DiscoveryEvaluator;
    completionEvaluator?: import('../core/CompletionEvaluator.js').CompletionEvaluator;
    unifiedTrust?: import('../threadline/UnifiedTrustWiring.js').UnifiedTrustSystem;
    liveConfig?: { set(path: string, value: unknown): void };
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
    /** Threadline → Telegram bridge config — toggles + allow/deny list. */
    telegramBridgeConfig?: import('../threadline/TelegramBridgeConfig.js').TelegramBridgeConfig;
    /** Threadline → Telegram bridge — relay-only mirror of threadline messages. */
    telegramBridge?: import('../threadline/TelegramBridge.js').TelegramBridge;
    /** Threadline observability — read-only views over inbox/outbox/bindings. */
    threadlineObservability?: import('../threadline/ThreadlineObservability.js').ThreadlineObservability;
    /** TaskFlow registry — durable multi-step job records (OpenClaw import). */
    taskFlowRegistry?: import('../tasks/TaskFlowRegistry.js').TaskFlowRegistry;
    /** ThreadlineFlowBridge — resumes flows on cross-agent-callback inbound. */
    threadlineFlowBridge?: import('../tasks/ThreadlineFlowBridge.js').ThreadlineFlowBridge;
  }) {
    this.config = options.config;
    this.telegramAdapter = options.telegram ?? null;
    this.startTime = new Date();
    this.sessionManager = options.sessionManager;
    this.state = options.state;
    this.hookEventReceiver = options.hookEventReceiver ?? undefined;
    this.toneGate = options.messagingToneGate ?? null;
    this.app = express();

    // Middleware
    this.app.use(express.json({ limit: '12mb' }));
    this.app.use(corsMiddleware);

    // Dashboard security headers — set before static serving so they apply to all dashboard responses
    this.app.use(dashboardSecurityHeaders);

    // Dashboard static files — served BEFORE auth middleware so the page loads
    // without a token. Auth happens via WebSocket/API calls from the page itself.
    const dashboardDir = this.resolveDashboardDir();
    this.app.get('/dashboard', (_req, res) => {
      res.sendFile(path.join(dashboardDir, 'index.html'));
    });
    this.app.use('/dashboard', express.static(dashboardDir));

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
    this.app.use(requestTimeout(options.config.requestTimeoutMs, buildRequestTimeoutOverrides()));

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

    // Failure-Learning Loop (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md) — instar
    // self-hosting dev-process forensics. Ships OFF; constructed only when
    // enabled (else the inline /failures routes 503-stub via the null ledger).
    // Toolchain attribution is instar-repo-local (§3 scope). Own try/catch so a
    // failure here can never cascade into the other ledgers' init.
    try {
      if (options.config.monitoring?.failureLearning?.enabled === true && options.config.stateDir) {
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
              const out = SafeGitExecutor.readSync(['show', '--name-only', '--pretty=format:', oid], {
                cwd: projectDir, operation: 'failure-learning:commit-touched-files',
              });
              return out.split('\n').map((s) => s.trim()).filter(Boolean);
            } catch { return []; }
          },
        });
      }
    } catch (err) {
      console.warn('[instar] failure-learning init failed (non-fatal):', err);
      this.failureLedger = null;
      this.failureAttributionEngine = null;
    }

    // Routes
    const routeCtx = {
      config: options.config,
      sessionManager: options.sessionManager,
      state: options.state,
      scheduler: options.scheduler ?? null,
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
      semanticMemory: options.semanticMemory ?? null,
      activitySentinel: options.activitySentinel ?? null,
      rateLimitSentinel: options.rateLimitSentinel ?? null,
      releaseReadinessSentinel: options.releaseReadinessSentinel ?? null,
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
      sessionRefresh: options.sessionRefresh ?? null,
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
      warrantsReplyGate: options.warrantsReplyGate,
      collaborationSurfacer: options.collaborationSurfacer,
      threadResumeMap: options.threadResumeMap ?? null,
      topicLinkageHandler: options.topicLinkageHandler ?? null,
      handshakeManager: options.handshakeManager ?? null,
      threadlineRelayClient: options.threadlineRelayClient ?? null,
      listenerManager: options.listenerManager ?? null,
      responseReviewGate: options.responseReviewGate ?? null,
      messagingToneGate: options.messagingToneGate ?? null,
      outboundDedupGate: options.outboundDedupGate ?? null,
      telemetryHeartbeat: options.telemetryHeartbeat ?? null,
      pasteManager: options.pasteManager ?? null,
      wsManager: null, // Set after WebSocket manager is initialized
      soulManager: options.soulManager ?? null,
      featureRegistry: options.featureRegistry ?? null,
      discoveryEvaluator: options.discoveryEvaluator ?? null,
      completionEvaluator: options.completionEvaluator ?? null,
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
      frameworkIssueLedger: this.frameworkIssueLedger,
      mentorRunner: this.mentorRunner,
      failureLedger: this.failureLedger,
      failureAttributionEngine: this.failureAttributionEngine,
      sessionReaper: options.sessionReaper ?? null,
      telegramBridgeConfig: options.telegramBridgeConfig ?? null,
      telegramBridge: options.telegramBridge ?? null,
      threadlineObservability: options.threadlineObservability ?? null,
      taskFlowRegistry: options.taskFlowRegistry ?? null,
      threadlineFlowBridge: options.threadlineFlowBridge ?? null,
      coordinator: options.coordinator ?? null,
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

  private buildMentorRunner(
    ledger: FrameworkIssueLedger,
    options: { config: { stateDir?: string }; intelligence?: import('../core/types.js').IntelligenceProvider | null },
    serverDataDir: string,
  ): MentorOnboardingRunner {
    const getConfig = (): MentorConfig => ({
      ...DEFAULT_MENTOR_CONFIG,
      ...((options.config as unknown as { mentor?: Partial<MentorConfig> }).mentor ?? {}),
    });
    const intelligence = options.intelligence ?? null;
    const self = this;
    return new MentorOnboardingRunner(
      {
        capture: (input) => ledger.captureRun(input),
        // Stage A spawns with the EMPTY tool grant (structural two-hats boundary,
        // §4); we bounded-wait for it to finish, then capture its transcript.
        spawnStageA: async (prompt: string): Promise<string> => {
          const session = await self.sessionManager.spawnSession({
            name: `mentor-stage-a-${Date.now()}`,
            prompt,
            model: 'haiku',
            allowedTools: [...STAGE_A_ALLOWED_TOOLS], // empty → no tools
            maxDurationMinutes: 5,
          });
          const tmux = session.tmuxSession;
          let finished = false;
          for (let i = 0; i < 90; i++) {
            const stillRunning = self.sessionManager.listRunningSessions().some((s) => s.id === session.id);
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
          return self.sessionManager.captureOutput(tmux, 200) ?? '';
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
        // Safe-window: any other running (non-protected) session means the system
        // is busy — conservative "don't interrupt." Refined per-mentee at live
        // validation. <!-- tracked: topic-13435 -->
        isMenteeBusy: () => self.sessionManager.listRunningSessions().length > 0,
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
        getSurface: (framework: string) => ({ framework, threadlineHistory: '' }),
        // Persist-only delivery (§6): append the Stage-A message to a durable
        // per-mentee outbox the mentee's already-running session picks up. This
        // does NOT call threadline_send / spawn a counterpart session — the
        // structural fix for the cross-agent spawn loop. Best-effort + never throws
        // (delivery failure must not crash a tick). Called ONLY in live mode.
        deliverToMentee: (framework: string, message: string) => {
          try {
            const outboxDir = path.join(serverDataDir, 'mentor-outbox');
            fs.mkdirSync(outboxDir, { recursive: true });
            const line = JSON.stringify({ ts: Date.now(), framework, message }) + '\n';
            fs.appendFileSync(path.join(outboxDir, `${framework.replace(/[^\w.-]/g, '_')}.jsonl`), line);
          } catch (err) {
            console.warn('[mentor] deliverToMentee outbox write failed (non-fatal):', err);
          }
        },
        onTickRan: () => {
          self.mentorLastTickAt = Date.now();
          self.mentorRunsToday += 1;
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

    return new Promise((resolve, reject) => {
      const host = this.config.host || '127.0.0.1';
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
        });

        // Update route context with WebSocket manager (deferred — created after routes)
        if (this.routeContext) {
          this.routeContext.wsManager = this.wsManager;
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
          try {
            const ledger = this.tokenLedger;
            const reporter = DegradationReporter.getInstance();
            const gate = LlmRateGate.instance();
            const telegram = this.telegramAdapter;
            const sendTelegram = telegram && typeof (telegram as { sendToTopic?: unknown }).sendToTopic === 'function'
              ? (topicId: number, text: string) => {
                  // Fire-and-forget — the runbook and verifier do not block on
                  // alert delivery; failed sends are logged elsewhere.
                  const send = (telegram as { sendToTopic: (t: number, s: string) => Promise<unknown> }).sendToTopic;
                  void send.call(telegram, topicId, text).catch((err: unknown) => {
                    console.warn(`[burn-detection] telegram send failed (non-fatal): ${(err as Error)?.message ?? err}`);
                  });
                }
              : undefined;

            this.burnThrottleRunbook = new BurnThrottleRunbook({ gate, sendTelegram });
            this.burnVerifier = new BurnVerifier({ ledger, sendTelegram });
            registerBurnDetectionSubscriber(reporter, this.burnThrottleRunbook, (outcome, event) => {
              this.burnVerifier!.scheduleVerification(outcome, event);
            });
            this.burnDetector = new BurnDetector({ ledger, reporter });
            this.burnDetector.start();
            console.log('[instar] burn-detection auto-heal system started');
          } catch (err) {
            console.warn('[instar] burn-detection start failed (non-fatal):', err);
          }
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

    // Stop the token-ledger poller and close its DB.
    if (this.tokenLedgerPoller) {
      try {
        this.tokenLedgerPoller.stop();
      } catch {
        // best-effort
      }
      this.tokenLedgerPoller = null;
    }
    if (this.tokenLedger) {
      try {
        this.tokenLedger.close();
      } catch {
        // best-effort
      }
      this.tokenLedger = null;
    }

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
}
