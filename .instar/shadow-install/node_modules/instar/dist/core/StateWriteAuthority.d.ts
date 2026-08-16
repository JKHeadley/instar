/**
 * State Write Authority — enforces primary-machine-writes-only model.
 *
 * In multi-machine setups:
 * - The primary machine is the canonical writer for agent state files
 * - Secondary machines submit changes via API to the primary
 * - If primary is offline, secondaries queue changes locally
 * - Write-tokens are scoped to non-escalating operations
 *
 * Project files (source code) are unaffected — normal git workflow.
 */
import type { AgentAutonomyConfig } from './types.js';
export type WriteOperation = 'addMemory' | 'updateProfile' | 'heartbeat' | 'modifyUser' | 'modifyPermissions' | 'transferPrimary';
export interface WriteToken {
    /** 32-byte random token */
    token: string;
    /** Machine ID this token was issued to */
    machineId: string;
    /** ISO timestamp of issuance */
    issuedAt: string;
    /** Whether this token has been revoked */
    revoked: boolean;
}
export interface OfflineQueueEntry {
    /** ISO timestamp of the queued operation */
    timestamp: string;
    /** Operation type */
    operation: WriteOperation;
    /** Operation payload */
    payload: Record<string, unknown>;
    /** Number of replay attempts */
    retryCount: number;
    /** Machine that queued this operation */
    sourceMachineId: string;
}
/**
 * Generate a new write token for a machine.
 */
export declare function generateWriteToken(machineId: string): WriteToken;
/**
 * Validate a write token.
 */
export declare function validateWriteToken(token: string, storedTokens: WriteToken[]): {
    valid: boolean;
    machineId?: string;
    error?: string;
};
/**
 * Check if an operation can be performed by a secondary machine.
 * Escalating operations require interactive confirmation from primary admin.
 */
export declare function canPerformOperation(operation: WriteOperation): {
    allowed: boolean;
    requiresConfirmation: boolean;
    reason?: string;
};
/**
 * Manages the offline queue for secondary machines.
 * When the primary is unreachable, changes are queued locally.
 */
export declare class OfflineQueue {
    private queueDir;
    private queueFile;
    constructor(stateDir: string, agentId: string);
    /**
     * Add an operation to the offline queue.
     * Only non-escalating operations can be queued.
     */
    enqueue(operation: WriteOperation, payload: Record<string, unknown>, machineId: string): boolean;
    /**
     * Read and drain the offline queue (for replay on reconnect).
     * Returns entries in order. Expired entries (>7 days) are skipped.
     */
    drain(): OfflineQueueEntry[];
    /**
     * Get the count of queued operations.
     */
    count(): number;
}
export interface ConflictResolution {
    file: string;
    machineA: {
        machineId: string;
        change: string;
    };
    machineB: {
        machineId: string;
        change: string;
    };
    agentRecommendation?: string;
    autoResolvable: boolean;
}
/**
 * Assess a merge conflict and determine if it can be auto-resolved.
 * users.json additions can be merged; config.json always escalates.
 */
export declare function assessConflict(file: string, autonomy?: AgentAutonomyConfig): {
    autoResolvable: boolean;
    reason: string;
};
//# sourceMappingURL=StateWriteAuthority.d.ts.map