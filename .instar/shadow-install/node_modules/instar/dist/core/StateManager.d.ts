/**
 * File-based state management.
 *
 * All state is stored as JSON files — no database dependency.
 * This is intentional: agent infrastructure should be portable
 * and not require running a DB server.
 */
import type { Session, JobState, ActivityEvent } from './types.js';
export declare class StateManager {
    private stateDir;
    private _readOnly;
    private _machineId;
    constructor(stateDir: string);
    /**
     * Set the machine ID for this StateManager instance.
     * When set, all activity events are automatically stamped with the originating machineId
     * (Phase 4D — Gap 6: machine-prefixed state).
     */
    setMachineId(machineId: string): void;
    /** Get the configured machine ID (null if not set). */
    get machineId(): string | null;
    /** Whether this StateManager is in read-only mode (standby machine). */
    get readOnly(): boolean;
    /**
     * Set read-only mode. When true, all write operations throw.
     * Used on standby machines to prevent accidental state forks.
     */
    setReadOnly(readOnly: boolean): void;
    /** Guard that throws if in read-only mode. */
    private guardWrite;
    /** Validate a key/ID contains only safe characters to prevent path traversal. */
    private validateKey;
    getSession(sessionId: string): Session | null;
    saveSession(session: Session): void;
    listSessions(filter?: {
        status?: Session['status'];
    }): Session[];
    removeSession(sessionId: string): boolean;
    getJobState(slug: string): JobState | null;
    saveJobState(state: JobState): void;
    appendEvent(event: ActivityEvent): void;
    queryEvents(options: {
        since?: Date;
        type?: string;
        limit?: number;
    }): ActivityEvent[];
    get<T>(key: string): T | null;
    set<T>(key: string, value: T): void;
    delete(key: string): boolean;
    /**
     * Write a file atomically — write to .tmp then rename.
     * Prevents corruption from power loss or disk-full mid-write.
     */
    private atomicWrite;
}
//# sourceMappingURL=StateManager.d.ts.map