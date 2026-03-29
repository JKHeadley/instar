/**
 * RegistryStore — SQLite-backed persistent agent registry with FTS5 search.
 *
 * Implements the Threadline Agent Registry Specification v0.2.0.
 * Stores agent profiles keyed by Ed25519 public key with full-text search
 * across name, bio, interests, and capabilities.
 *
 * Part of Threadline Relay Phase 1.1.
 */
export interface RegistryEntry {
    publicKey: string;
    agentId: string;
    name: string;
    bio: string;
    interests: string[];
    capabilities: string[];
    framework: string;
    frameworkVisible: boolean;
    homepage: string;
    visibility: 'public' | 'unlisted';
    relayId: string;
    registeredAt: string;
    lastSeen: string;
    lastUpdated: string;
    online: boolean;
    stale: boolean;
    consentMethod: string;
    verified: boolean;
    verifiedDomain: string | null;
    version: number;
}
export interface RegistrySearchParams {
    q?: string;
    capability?: string;
    framework?: string;
    interest?: string;
    online?: boolean;
    limit?: number;
    cursor?: string;
    sort?: 'relevance' | 'lastSeen' | 'registeredAt' | 'name';
}
export interface RegistrySearchResult {
    count: number;
    total: number;
    agents: RegistryEntry[];
    pagination: {
        cursor: string | null;
        hasMore: boolean;
    };
}
export interface RegistryStats {
    totalAgents: number;
    onlineAgents: number;
    frameworkStats: {
        disclosed: number;
        hidden: number;
    };
    topCapabilities: Array<{
        capability: string;
        count: number;
    }>;
    registeredLast24h: number;
    registeredLast7d: number;
    cachedAt: string;
}
export interface RegistryStoreConfig {
    dataDir: string;
    relayId: string;
}
export declare function sanitizeFTS5Query(q: string): string;
export declare class RegistryStore {
    private db;
    private readonly relayId;
    private statsCache;
    private staleCronTimer;
    constructor(config: RegistryStoreConfig);
    private initSchema;
    /**
     * Reset all online flags on startup (crash recovery).
     */
    private resetOnlineStatus;
    /**
     * Register or update an agent in the registry.
     */
    upsert(params: {
        publicKey: string;
        agentId: string;
        name: string;
        bio: string;
        interests: string[];
        capabilities: string[];
        framework: string;
        frameworkVisible?: boolean;
        homepage?: string;
        visibility?: 'public' | 'unlisted';
        consentMethod: string;
    }): RegistryEntry;
    /**
     * Update specific fields of an agent's registry entry.
     */
    update(publicKey: string, fields: Partial<{
        name: string;
        bio: string;
        interests: string[];
        capabilities: string[];
        homepage: string;
        visibility: 'public' | 'unlisted';
        frameworkVisible: boolean;
    }>): RegistryEntry | null;
    getByPublicKey(publicKey: string): RegistryEntry | null;
    getByAgentId(agentId: string): RegistryEntry | null;
    /**
     * Check if agentId is ambiguous (maps to multiple public keys).
     */
    isAgentIdAmbiguous(agentId: string): boolean;
    search(params: RegistrySearchParams): RegistrySearchResult;
    setOnline(publicKey: string): void;
    setOffline(publicKey: string): void;
    updateLastSeen(publicKey: string): void;
    /**
     * Agent-initiated hard delete (GDPR compliant).
     * Immediately removes from search; fully purged from DB.
     */
    hardDelete(publicKey: string): boolean;
    getStats(): RegistryStats;
    getHealth(): {
        status: string;
        totalAgents: number;
        onlineAgents: number;
        ftsHealthy: boolean;
        lastStaleCron: string | null;
        dbSizeBytes: number;
    };
    runStaleCron(): {
        staled: number;
        softDeleted: number;
        hardDeleted: number;
    };
    private rowToEntry;
    /**
     * Resolve public key from agentId by looking up in the registry.
     */
    resolvePublicKey(agentId: string): string | null;
    /**
     * Clean shutdown.
     */
    destroy(): void;
}
//# sourceMappingURL=RegistryStore.d.ts.map