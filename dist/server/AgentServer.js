/**
 * Agent Server — HTTP server wrapping Express.
 *
 * Provides health checks, session management, job triggering,
 * and event querying over a simple REST API.
 *
 * Also serves the dashboard UI at /dashboard and handles
 * WebSocket connections for real-time terminal streaming.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRoutes } from './routes.js';
import { createFileRoutes } from './fileRoutes.js';
import { mountWhatsAppWebhooks } from '../messaging/backends/WhatsAppWebhookRoutes.js';
import { createMachineRoutes } from './machineRoutes.js';
import { corsMiddleware, authMiddleware, requestTimeout, errorHandler, dashboardSecurityHeaders } from './middleware.js';
import { WebSocketManager } from './WebSocketManager.js';
export class AgentServer {
    app;
    server = null;
    wsManager = null;
    config;
    startTime;
    sessionManager;
    state;
    hookEventReceiver;
    routeContext = null;
    constructor(options) {
        this.config = options.config;
        this.startTime = new Date();
        this.sessionManager = options.sessionManager;
        this.state = options.state;
        this.hookEventReceiver = options.hookEventReceiver ?? undefined;
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
        const pinAttempts = new Map();
        const MAX_ATTEMPTS = 5;
        const WINDOW_MS = 5 * 60 * 1000; // 5-minute window
        const configRef = this.config;
        this.app.post('/dashboard/unlock', (req, res) => {
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
                    localMachineId: coord.identity.machineId,
                },
                localMachineId: coord.identity.machineId,
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
        // WhatsApp Business API webhook routes — mounted BEFORE auth middleware because
        // Meta's webhook verification sends GET requests without Bearer tokens.
        if (options.whatsappBusinessBackend) {
            // Import is at top of file — mountWhatsAppWebhooks is synchronous
            mountWhatsAppWebhooks({
                app: this.app,
                backend: options.whatsappBusinessBackend,
            });
        }
        this.app.use(authMiddleware(options.config.authToken));
        this.app.use(requestTimeout(options.config.requestTimeoutMs));
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
            handshakeManager: options.handshakeManager ?? null,
            threadlineRelayClient: options.threadlineRelayClient ?? null,
            listenerManager: options.listenerManager ?? null,
            responseReviewGate: options.responseReviewGate ?? null,
            telemetryHeartbeat: options.telemetryHeartbeat ?? null,
            pasteManager: options.pasteManager ?? null,
            wsManager: null, // Set after WebSocket manager is initialized
            soulManager: options.soulManager ?? null,
            featureRegistry: options.featureRegistry ?? null,
            discoveryEvaluator: options.discoveryEvaluator ?? null,
            startTime: this.startTime,
        };
        this.routeContext = routeCtx;
        const routes = createRoutes(routeCtx);
        this.app.use(routes);
        // File viewer routes (after auth middleware)
        const fileRoutes = createFileRoutes({ config: options.config, liveConfig: options.liveConfig });
        this.app.use(fileRoutes);
        // Error handler (must be last)
        this.app.use(errorHandler);
    }
    /**
     * Resolve the dashboard directory.
     * In dev: ../../../dashboard (relative to src/server/)
     * In dist (published): ../../dashboard (relative to dist/server/)
     */
    resolveDashboardDir() {
        const thisDir = path.dirname(fileURLToPath(import.meta.url));
        // Try dist layout first (package root/dashboard)
        const fromDist = path.resolve(thisDir, '..', '..', 'dashboard');
        // Try dev layout (src/server -> project root/dashboard)
        const fromSrc = path.resolve(thisDir, '..', '..', '..', 'dashboard');
        if (fs.existsSync(fromDist))
            return fromDist;
        if (fs.existsSync(fromSrc))
            return fromSrc;
        return fromDist;
    }
    /**
     * Start the HTTP server.
     */
    async start() {
        return new Promise((resolve, reject) => {
            const host = this.config.host || '127.0.0.1';
            this.server = this.app.listen(this.config.port, host, () => {
                console.log(`[instar] Server listening on ${host}:${this.config.port}`);
                console.log(`[instar] Dashboard: http://${host}:${this.config.port}/dashboard`);
                // Initialize WebSocket manager after server is listening
                this.wsManager = new WebSocketManager({
                    server: this.server,
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
                resolve();
            });
            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${this.config.port} is already in use. Is another instar server running?`));
                }
                else {
                    reject(err);
                }
            });
        });
    }
    /**
     * Stop the HTTP server gracefully.
     * Closes keep-alive connections after a timeout to prevent hanging.
     */
    async stop() {
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
                if (resolved)
                    return;
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
    getApp() {
        return this.app;
    }
}
//# sourceMappingURL=AgentServer.js.map