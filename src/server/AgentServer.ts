/**
 * Agent Server — HTTP server wrapping Express.
 *
 * Provides health checks, session management, job triggering,
 * and event querying over a simple REST API.
 */

import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { AgentKitConfig } from '../core/types.js';
import type { RelationshipManager } from '../core/RelationshipManager.js';
import type { FeedbackManager } from '../core/FeedbackManager.js';
import type { UpdateChecker } from '../core/UpdateChecker.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';
import { createRoutes } from './routes.js';
import { corsMiddleware, authMiddleware, errorHandler } from './middleware.js';

export class AgentServer {
  private app: Express;
  private server: Server | null = null;
  private config: AgentKitConfig;
  private startTime: Date;

  constructor(options: {
    config: AgentKitConfig;
    sessionManager: SessionManager;
    state: StateManager;
    scheduler?: JobScheduler;
    telegram?: TelegramAdapter;
    relationships?: RelationshipManager;
    feedback?: FeedbackManager;
    updateChecker?: UpdateChecker;
    quotaTracker?: QuotaTracker;
  }) {
    this.config = options.config;
    this.startTime = new Date();
    this.app = express();

    // Middleware
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(corsMiddleware);
    this.app.use(authMiddleware(options.config.authToken));

    // Routes
    const routes = createRoutes({
      config: options.config,
      sessionManager: options.sessionManager,
      state: options.state,
      scheduler: options.scheduler ?? null,
      telegram: options.telegram ?? null,
      relationships: options.relationships ?? null,
      feedback: options.feedback ?? null,
      updateChecker: options.updateChecker ?? null,
      quotaTracker: options.quotaTracker ?? null,
      startTime: this.startTime,
    });
    this.app.use(routes);

    // Error handler (must be last)
    this.app.use(errorHandler);
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        console.log(`[instar] Server listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server gracefully.
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
        this.server = null;
      });
    });
  }

  /**
   * Expose the Express app for testing with supertest.
   */
  getApp(): Express {
    return this.app;
  }
}
