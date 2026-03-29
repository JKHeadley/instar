/**
 * CoordinationProtocol — Work coordination primitives for multi-machine agents.
 *
 * Provides higher-level coordination on top of AgentBus:
 *   1. File avoidance requests ("please avoid file X for 30 min")
 *   2. Work announcements (broadcast what you're starting/finishing)
 *   3. Status queries (who is working on what?)
 *   4. ETA tracking (when will other machine finish with a file?)
 *   5. Leadership / awake-role management with fencing tokens
 *
 * From INTELLIGENT_SYNC_SPEC Sections 7.4, 8, 13.
 */
import type { AgentBus } from './AgentBus.js';
export interface FileAvoidanceRequest {
    /** Files to avoid. */
    files: string[];
    /** Duration in milliseconds. */
    durationMs: number;
    /** Reason for the request. */
    reason: string;
    /** Session ID of the requester. */
    sessionId?: string;
}
export interface FileAvoidanceResponse {
    /** Whether the request was accepted. */
    accepted: boolean;
    /** Files that cannot be avoided (already committed to). */
    conflictingFiles: string[];
    /** Reason for partial/full rejection. */
    reason?: string;
}
export interface WorkAnnouncement {
    /** Unique work item ID. */
    workId: string;
    /** Type of announcement. */
    action: 'started' | 'completed' | 'paused' | 'resumed' | 'abandoned';
    /** Session ID. */
    sessionId: string;
    /** Task description. */
    task: string;
    /** Files planned or modified. */
    files: string[];
    /** Branch name, if applicable. */
    branch?: string;
    /** Estimated completion time (ISO). */
    eta?: string;
}
export interface StatusQuery {
    /** What to query. */
    queryType: 'active-work' | 'file-owners' | 'machine-status';
    /** Filter by specific files (for file-owners). */
    files?: string[];
}
export interface StatusResponse {
    /** Machine ID of the responder. */
    machineId: string;
    /** Active work items on this machine. */
    activeWork: WorkAnnouncement[];
    /** Machine status. */
    status: 'active' | 'idle' | 'shutting-down';
    /** Current session ID. */
    sessionId?: string;
}
export interface LeadershipState {
    /** Current leader machine ID. */
    leaderId: string;
    /** Fencing token (monotonically increasing). */
    fencingToken: number;
    /** Role of this machine. */
    role: 'awake' | 'standby';
    /** Lease expiration (ISO). */
    leaseExpiresAt: string;
    /** When the lease was acquired. */
    acquiredAt: string;
}
export interface AvoidanceEntry {
    /** Requesting machine. */
    from: string;
    /** Files to avoid. */
    files: string[];
    /** When the avoidance expires. */
    expiresAt: number;
    /** Reason. */
    reason: string;
}
export interface CoordinationProtocolConfig {
    /** The AgentBus instance for communication. */
    bus: AgentBus;
    /** This machine's ID. */
    machineId: string;
    /** State directory (.instar). */
    stateDir: string;
    /** Lease TTL in ms (default: 15 min). */
    leaseTtlMs?: number;
    /** Timeout for status queries in ms (default: 10s). */
    statusQueryTimeoutMs?: number;
    /** Callback when a file avoidance request is received. */
    onAvoidanceRequest?: (req: FileAvoidanceRequest, from: string) => FileAvoidanceResponse;
    /** Callback when a work announcement is received. */
    onWorkAnnouncement?: (announcement: WorkAnnouncement, from: string) => void;
}
export interface CoordinationEvents {
    'avoidance-requested': (req: FileAvoidanceRequest, from: string) => void;
    'avoidance-response': (resp: FileAvoidanceResponse, from: string) => void;
    'work-announced': (announcement: WorkAnnouncement, from: string) => void;
    'status-response': (resp: StatusResponse) => void;
    'leadership-changed': (state: LeadershipState) => void;
}
export declare class CoordinationProtocol {
    private bus;
    private machineId;
    private stateDir;
    private leaseTtlMs;
    private statusQueryTimeoutMs;
    private coordDir;
    private avoidances;
    private peerWork;
    private onAvoidanceRequest?;
    private onWorkAnnouncement?;
    constructor(config: CoordinationProtocolConfig);
    /**
     * Request another machine to avoid specific files for a duration.
     */
    requestFileAvoidance(targetMachineId: string, request: FileAvoidanceRequest): Promise<FileAvoidanceResponse | null>;
    /**
     * Broadcast a file avoidance request to all machines.
     */
    broadcastFileAvoidance(request: FileAvoidanceRequest): Promise<void>;
    /**
     * Check if a file is currently under avoidance.
     */
    isFileAvoided(filePath: string): AvoidanceEntry | undefined;
    /**
     * Get all active avoidances.
     */
    getActiveAvoidances(): AvoidanceEntry[];
    /**
     * Announce work to all machines.
     */
    announceWork(announcement: WorkAnnouncement): Promise<void>;
    /**
     * Announce that work has started.
     */
    announceWorkStarted(opts: {
        sessionId: string;
        task: string;
        files: string[];
        branch?: string;
        eta?: string;
    }): Promise<string>;
    /**
     * Announce that work has completed.
     */
    announceWorkCompleted(workId: string, sessionId: string, files: string[]): Promise<void>;
    /**
     * Get known work from other machines.
     */
    getPeerWork(machineId?: string): WorkAnnouncement[];
    /**
     * Query a specific machine's status.
     */
    queryStatus(targetMachineId: string): Promise<StatusResponse | null>;
    /**
     * Query all machines for file owners.
     */
    queryFileOwners(files: string[]): Promise<StatusResponse[]>;
    /**
     * Attempt to claim the awake (leader) role.
     * Returns the new leadership state if successful.
     */
    claimLeadership(): LeadershipState | null;
    /**
     * Renew the leadership lease (must already be leader).
     */
    renewLease(): LeadershipState | null;
    /**
     * Relinquish leadership (transition to standby).
     */
    relinquishLeadership(): void;
    /**
     * Read current leadership state.
     */
    getLeadership(): LeadershipState | null;
    /**
     * Check if this machine is the current leader.
     */
    isLeader(): boolean;
    /**
     * Check if the current leader's lease has expired.
     */
    isLeaseExpired(): boolean;
    getMachineId(): string;
    private registerHandlers;
    private cleanExpiredAvoidances;
    private readLeadership;
    private writeLeadership;
}
//# sourceMappingURL=CoordinationProtocol.d.ts.map