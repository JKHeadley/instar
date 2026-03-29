/**
 * Multi-machine coordinator — orchestrates distributed agent lifecycle.
 *
 * Brings together HeartbeatManager, MachineIdentityManager, SecurityLog,
 * and NonceStore into a single coordinator that the server lifecycle uses.
 *
 * Responsibilities:
 * - Determine this machine's role on startup (awake/standby)
 * - Periodic heartbeat writes (awake) / monitoring (standby)
 * - Auto-failover when the awake machine goes silent
 * - StateManager read-only enforcement on standby
 * - Graceful shutdown handoff attempt
 *
 * Part of Phase 5 (distributed coordination).
 */
import { EventEmitter } from 'node:events';
import { MachineIdentityManager } from './MachineIdentity.js';
import { HeartbeatManager } from './HeartbeatManager.js';
import { SecurityLog } from './SecurityLog.js';
import { NonceStore } from './NonceStore.js';
import type { StateManager } from './StateManager.js';
import type { MachineRole, MachineIdentity, MultiMachineConfig, CoordinationMode } from './types.js';
export interface CoordinatorConfig {
    /** State directory (.instar) */
    stateDir: string;
    /** Multi-machine config from config.json */
    multiMachine?: MultiMachineConfig;
}
export interface CoordinatorEvents {
    /** Emitted when this machine should promote to awake */
    promote: () => void;
    /** Emitted when this machine should demote to standby */
    demote: () => void;
    /** Emitted when auto-failover triggers */
    failover: (reason: string) => void;
    /** Emitted on role change */
    roleChange: (from: MachineRole, to: MachineRole) => void;
}
export declare class MultiMachineCoordinator extends EventEmitter {
    private identityManager;
    private heartbeatManager;
    private securityLog;
    private nonceStore;
    private state;
    private config;
    private _role;
    private _identity;
    private _enabled;
    private heartbeatWriteTimer;
    private heartbeatCheckTimer;
    constructor(state: StateManager, config: CoordinatorConfig);
    /** Whether multi-machine is enabled (has identity). */
    get enabled(): boolean;
    /** This machine's current role. */
    get role(): MachineRole;
    /** This machine's identity (null if not initialized). */
    get identity(): MachineIdentity | null;
    /** Whether this machine is the awake (primary) machine. */
    get isAwake(): boolean;
    /** The coordination mode (default: 'primary-standby'). */
    get coordinationMode(): CoordinationMode;
    /** The underlying managers (for route wiring). */
    get managers(): {
        identityManager: MachineIdentityManager;
        heartbeatManager: HeartbeatManager;
        securityLog: SecurityLog;
        nonceStore: NonceStore;
    };
    /**
     * Initialize and start the coordinator.
     * Returns the determined role for this machine.
     */
    start(): MachineRole;
    /**
     * Stop the coordinator. Call on server shutdown.
     */
    stop(): void;
    /**
     * Promote this machine to awake.
     * Called on failover or explicit wakeup.
     */
    promoteToAwake(reason: string): void;
    /**
     * Demote this machine to standby.
     * Called when another machine takes over.
     */
    demoteToStandby(reason: string): void;
    /**
     * The hot-path check that runs before every Telegram poll.
     * Returns true if this machine should NOT process messages.
     */
    shouldSkipProcessing(): boolean;
    /**
     * Start periodic heartbeat writes (awake machine only).
     */
    private startHeartbeatWriter;
    /**
     * Start periodic heartbeat monitoring (all machines).
     */
    private startHeartbeatMonitor;
    /**
     * Check the heartbeat and take action if needed.
     */
    private checkHeartbeatAndAct;
}
//# sourceMappingURL=MultiMachineCoordinator.d.ts.map