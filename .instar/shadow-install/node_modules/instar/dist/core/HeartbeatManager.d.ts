/**
 * Heartbeat manager for distributed coordination.
 *
 * Handles:
 * - Awake machine broadcasts heartbeat every 2 minutes
 * - Standby machines monitor heartbeat and auto-failover
 * - Split-brain detection via cross-heartbeat processing
 * - Graceful handoff coordination
 * - Failover hardening (cooldown, max attempts, optional confirmation)
 *
 * Phase 5 of the multi-machine spec.
 */
import type { MachineRole } from './types.js';
export interface Heartbeat {
    /** Machine ID of the heartbeat sender */
    holder: string;
    /** Current role of the sender */
    role: MachineRole;
    /** ISO timestamp of the heartbeat */
    timestamp: string;
    /** ISO timestamp when this heartbeat expires */
    expiresAt: string;
}
export interface FailoverConfig {
    /** Whether auto-failover is enabled */
    enabled: boolean;
    /** Milliseconds of silence before failover (default: 15 min) */
    timeoutMs: number;
    /** Whether to require human confirmation before failover */
    requireConfirmation: boolean;
}
export interface FailoverState {
    /** Timestamps of recent auto-failover events */
    recentFailovers: number[];
    /** Whether auto-failover has been disabled due to instability */
    disabled: boolean;
    /** Reason auto-failover was disabled */
    disabledReason?: string;
}
export type HeartbeatCheckResult = {
    status: 'healthy';
    holder: string;
    ageMs: number;
} | {
    status: 'stale';
    holder: string;
    ageMs: number;
} | {
    status: 'expired';
    holder: string;
    ageMs: number;
} | {
    status: 'missing';
} | {
    status: 'split-brain';
    holder: string;
    myId: string;
};
export declare class HeartbeatManager {
    private stateDir;
    private machineId;
    private failoverConfig;
    private failoverState;
    constructor(stateDir: string, machineId: string, failoverConfig?: Partial<FailoverConfig>);
    get heartbeatPath(): string;
    /**
     * Write a heartbeat as the awake machine.
     */
    writeHeartbeat(): Heartbeat;
    /**
     * Read the current heartbeat from disk.
     * Returns null if no heartbeat file exists.
     */
    readHeartbeat(): Heartbeat | null;
    /**
     * Check the heartbeat status relative to this machine.
     * This is the critical hot-path check before every Telegram poll.
     */
    checkHeartbeat(): HeartbeatCheckResult;
    /**
     * Determine if this machine should demote based on the heartbeat.
     * Called as the hot-path check before Telegram polling.
     *
     * Returns true if this machine should stop being awake (another machine
     * has a valid heartbeat claiming the awake role).
     */
    shouldDemote(): boolean;
    /**
     * Process an incoming heartbeat from another machine (received via tunnel).
     * Handles split-brain detection.
     *
     * Returns 'demote' if this machine should demote, 'ignore' if not.
     */
    processIncomingHeartbeat(incoming: Heartbeat): 'demote' | 'ignore' | 'they-should-demote';
    /**
     * Check if auto-failover should trigger.
     * Called periodically by standby machines.
     */
    shouldFailover(): {
        should: boolean;
        reason?: string;
    };
    /**
     * Record that a failover occurred.
     */
    recordFailover(): void;
    /**
     * Get the current failover state (for diagnostics).
     */
    getFailoverState(): FailoverState;
    /**
     * Reset failover state (re-enable after manual intervention).
     */
    resetFailoverState(): void;
    /**
     * Write an incoming heartbeat to the local file (not our own).
     */
    private writeIncomingHeartbeat;
}
//# sourceMappingURL=HeartbeatManager.d.ts.map