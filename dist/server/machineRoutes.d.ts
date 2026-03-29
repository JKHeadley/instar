/**
 * Multi-machine API routes.
 *
 * Endpoints for inter-machine communication:
 *   POST /api/heartbeat          — Receive heartbeat from another machine
 *   POST /api/pair               — Handle pairing requests
 *   POST /api/handoff/challenge  — Generate challenge for handoff
 *   POST /api/handoff/request    — Request role handoff
 *   POST /api/secrets/challenge  — Generate challenge for secret sync
 *   POST /api/secrets/sync       — Receive encrypted secrets
 *   POST /api/sync/state         — Sync operational state
 *
 * All endpoints (except /api/pair) require machine-to-machine authentication.
 *
 * Part of Phases 4-5 of the multi-machine spec.
 */
import { Router } from 'express';
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import type { HeartbeatManager } from '../core/HeartbeatManager.js';
import type { SecurityLog } from '../core/SecurityLog.js';
import type { MachineAuthDeps } from './machineAuth.js';
import type { MessageRouter } from '../messaging/MessageRouter.js';
export interface MachineRouteContext {
    /** Machine identity manager */
    identityManager: MachineIdentityManager;
    /** Heartbeat manager for coordination */
    heartbeatManager: HeartbeatManager;
    /** Security log */
    securityLog: SecurityLog;
    /** Machine auth dependencies (for middleware) */
    authDeps: MachineAuthDeps;
    /** This machine's ID */
    localMachineId: string;
    /** This machine's signing private key (PEM) */
    localSigningKeyPem: string;
    /** Callback when this machine should demote to standby */
    onDemote?: () => void;
    /** Callback when this machine should promote to awake */
    onPromote?: () => void;
    /** Callback to get current handoff readiness */
    onHandoffRequest?: () => Promise<{
        ready: boolean;
        state?: unknown;
    }>;
    /** Message router for cross-machine message relay */
    messageRouter?: MessageRouter | null;
}
export declare function createMachineRoutes(ctx: MachineRouteContext): Router;
//# sourceMappingURL=machineRoutes.d.ts.map