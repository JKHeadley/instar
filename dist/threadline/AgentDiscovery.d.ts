/**
 * AgentDiscovery — Discovery layer for finding and connecting to Threadline-capable agents.
 *
 * Provides:
 * - Local agent discovery via the shared AgentRegistry
 * - Threadline capability detection via /threadline/health endpoint pings
 * - Agent verification using Ed25519 signatures (via ThreadlineCrypto)
 * - Presence heartbeat with jitter for liveness tracking
 * - Capability-based agent search
 * - Atomic file persistence for self and known-agent metadata
 *
 * Part of Threadline Protocol Phase 4.
 */
export interface ThreadlineAgentInfo {
    /** Agent display name */
    name: string;
    /** Server port */
    port: number;
    /** Project path */
    path: string;
    /** Agent status */
    status: 'active' | 'inactive' | 'unverified';
    /** Capabilities this agent advertises */
    capabilities: string[];
    /** Human-readable description */
    description?: string;
    /** Whether the agent supports Threadline */
    threadlineEnabled: boolean;
    /** Threadline protocol version */
    threadlineVersion?: string;
    /** Ed25519 identity public key (hex) */
    publicKey?: string;
    /** Agent framework */
    framework: 'instar' | 'claude-code' | 'other';
    /** Last time this agent was verified */
    lastVerified?: string;
    /** Machine identifier for paired machine agents */
    machine?: string;
}
export interface AgentInfoFile {
    name: string;
    port: number;
    path: string;
    capabilities: string[];
    description?: string;
    threadlineVersion: string;
    publicKey?: string;
    framework: 'instar' | 'claude-code' | 'other';
    machine?: string;
    updatedAt: string;
}
/** Injectable HTTP fetcher for testing */
export type HttpFetcher = (url: string, options?: {
    method?: string;
    timeout?: number;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<any>;
}>;
export declare class AgentDiscovery {
    private readonly stateDir;
    private readonly threadlineDir;
    private readonly selfPath;
    private readonly selfName;
    private readonly selfPort;
    private readonly fetcher;
    private heartbeatTimers;
    private heartbeatInterval;
    constructor(options: {
        stateDir: string;
        selfPath: string;
        selfName: string;
        selfPort: number;
        fetcher?: HttpFetcher;
    });
    /**
     * Discover local Threadline-capable agents.
     * Reads the shared AgentRegistry, pings each agent's /threadline/health endpoint,
     * and returns a list of Threadline-capable agents.
     */
    discoverLocal(): Promise<ThreadlineAgentInfo[]>;
    /**
     * Ping an agent's /threadline/health endpoint and build ThreadlineAgentInfo.
     * Returns null if the agent doesn't support Threadline.
     */
    private pingThreadlineHealth;
    /**
     * Announce this agent's Threadline presence.
     * Writes/updates the agent's own Threadline metadata file.
     */
    announcePresence(selfInfo: {
        capabilities: string[];
        description?: string;
        threadlineVersion: string;
        publicKey?: string;
        framework?: ThreadlineAgentInfo['framework'];
        machine?: string;
    }): void;
    /**
     * Read the current agent info file.
     */
    getSelfInfo(): AgentInfoFile | null;
    /**
     * Verify a remote agent by sending a challenge nonce and verifying the Ed25519 signature.
     * Returns the verified agent info on success, or null on failure.
     */
    verifyAgent(agentName: string, port: number): Promise<ThreadlineAgentInfo | null>;
    /**
     * Start a periodic presence heartbeat that pings known agents.
     * Marks agents as inactive after MISSED_HEARTBEAT_THRESHOLD missed beats.
     * Adds ±30s jitter to the interval.
     * Returns a cleanup function to stop the heartbeat.
     */
    startPresenceHeartbeat(intervalMs?: number): () => void;
    /**
     * Single heartbeat tick — pings all known agents.
     */
    private heartbeatTick;
    /**
     * Record a missed heartbeat for an agent.
     * Marks as inactive after MISSED_HEARTBEAT_THRESHOLD missed beats.
     */
    private recordMissedBeat;
    /**
     * Search known agents by capability.
     * Returns agents that advertise the given capability string (case-insensitive).
     */
    searchByCapability(capability: string): ThreadlineAgentInfo[];
    /**
     * Get only agents that have been cryptographically verified
     * (i.e., have a lastVerified timestamp and active status).
     */
    getVerifiedAgents(): ThreadlineAgentInfo[];
    /**
     * Load known agents from cache file.
     */
    loadKnownAgents(): ThreadlineAgentInfo[];
    /**
     * Save known agents to cache file (atomic write).
     */
    private saveKnownAgents;
    /**
     * Update a single known agent entry (upsert by name).
     */
    private updateKnownAgent;
    /**
     * Get the heartbeat tracker map (for testing).
     */
    getHeartbeatTrackers(): Map<string, {
        missedBeats: number;
        lastSeen: string;
    }>;
}
//# sourceMappingURL=AgentDiscovery.d.ts.map