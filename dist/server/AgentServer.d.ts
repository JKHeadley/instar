/**
 * Agent Server — HTTP server wrapping Express.
 *
 * Provides health checks, session management, job triggering,
 * and event querying over a simple REST API.
 *
 * Also serves the dashboard UI at /dashboard and handles
 * WebSocket connections for real-time terminal streaming.
 */
import { type Express } from 'express';
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
export declare class AgentServer {
    private app;
    private server;
    private wsManager;
    private config;
    private startTime;
    private sessionManager;
    private state;
    private hookEventReceiver?;
    private routeContext;
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
        handshakeManager?: import('../threadline/HandshakeManager.js').HandshakeManager;
        threadlineRelayClient?: import('../threadline/client/ThreadlineClient.js').ThreadlineClient;
        listenerManager?: import('../threadline/ListenerSessionManager.js').ListenerSessionManager;
        responseReviewGate?: import('../core/CoherenceGate.js').CoherenceGate;
        telemetryHeartbeat?: import('../monitoring/TelemetryHeartbeat.js').TelemetryHeartbeat;
        pasteManager?: import('../paste/PasteManager.js').PasteManager;
        soulManager?: import('../core/SoulManager.js').SoulManager;
        featureRegistry?: import('../core/FeatureRegistry.js').FeatureRegistry;
        discoveryEvaluator?: import('../core/DiscoveryEvaluator.js').DiscoveryEvaluator;
        liveConfig?: {
            set(path: string, value: unknown): void;
        };
    });
    /**
     * Resolve the dashboard directory.
     * In dev: ../../../dashboard (relative to src/server/)
     * In dist (published): ../../dashboard (relative to dist/server/)
     */
    private resolveDashboardDir;
    /**
     * Start the HTTP server.
     */
    start(): Promise<void>;
    /**
     * Stop the HTTP server gracefully.
     * Closes keep-alive connections after a timeout to prevent hanging.
     */
    stop(): Promise<void>;
    /**
     * Expose the Express app for testing with supertest.
     */
    getApp(): Express;
}
//# sourceMappingURL=AgentServer.d.ts.map