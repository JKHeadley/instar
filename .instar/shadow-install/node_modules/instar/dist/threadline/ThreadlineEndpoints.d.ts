/**
 * ThreadlineEndpoints — HTTP route handlers for the Threadline protocol.
 *
 * Routes:
 *   GET  /threadline/health              — Health check + version
 *   POST /threadline/handshake/hello     — Initiate handshake (unauthenticated)
 *   POST /threadline/handshake/confirm   — Complete handshake (unauthenticated)
 *   POST /threadline/messages/receive    — Receive a message (authenticated)
 *   GET  /threadline/messages/thread/:id — Get thread messages (authenticated)
 *   GET  /threadline/blobs/:id           — Fetch blob content (authenticated)
 *
 * Authentication: Threadline-Relay token + signed headers for authenticated routes.
 * Content-Type: application/threadline+json; version=1.0
 *
 * Part of Threadline Protocol Phase 3.
 */
import { Router } from 'express';
import type { HandshakeManager } from './HandshakeManager.js';
import type { ThreadlineRouter } from './ThreadlineRouter.js';
export interface ThreadlineError {
    error: {
        code: string;
        message: string;
        retryable: boolean;
        retryAfterSeconds?: number;
    };
}
export interface ThreadlineEndpointsConfig {
    /** Name of this agent */
    localAgent: string;
    /** Threadline protocol version */
    version: string;
}
export declare function createThreadlineRoutes(handshakeManager: HandshakeManager, threadlineRouter: ThreadlineRouter | null, config: ThreadlineEndpointsConfig): Router;
//# sourceMappingURL=ThreadlineEndpoints.d.ts.map