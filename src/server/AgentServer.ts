/**
 * Agent Server — HTTP server wrapping Express.
 *
 * Provides health checks, session management, job triggering,
 * and event querying over a simple REST API.
 *
 * Also serves the dashboard UI at /dashboard and handles
 * WebSocket connections for real-time terminal streaming.
 */

import express, { type Express } from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
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
import { createRoutes } from './routes.js';
import { corsMiddleware, authMiddleware, requestTimeout, errorHandler } from './middleware.js';
import { WebSocketManager } from './WebSocketManager.js';

export class AgentServer {
  private app: Express;
  private server: Server | null = null;
  private wsManager: WebSocketManager | null = null;
  private config: InstarConfig;
  private startTime: Date;
  private sessionManager: SessionManager;
  private state: StateManager;

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
  }) {
    this.config = options.config;
    this.startTime = new Date();
    this.sessionManager = options.sessionManager;
    this.state = options.state;
    this.app = express();

    // Middleware
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(corsMiddleware);

    // Dashboard static files — served BEFORE auth middleware so the page loads
    // without a token. Auth happens via WebSocket/API calls from the page itself.
    const dashboardDir = this.resolveDashboardDir();
    this.app.get('/dashboard', (_req, res) => {
      res.sendFile(path.join(dashboardDir, 'index.html'));
    });
    this.app.use('/dashboard', express.static(dashboardDir));

    this.app.use(authMiddleware(options.config.authToken));
    this.app.use(requestTimeout(options.config.requestTimeoutMs));

    // Routes
    const routes = createRoutes({
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
      startTime: this.startTime,
    });
    this.app.use(routes);

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
   * Start the HTTP server.
   */
  async start(): Promise<void> {
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
        });

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
   * Stop the HTTP server gracefully.
   * Closes keep-alive connections after a timeout to prevent hanging.
   */
  async stop(): Promise<void> {
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
