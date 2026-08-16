/**
 * Platform-agnostic session-channel registry.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Maps channels (topics, chats, etc.) to sessions bidirectionally.
 * Persists to disk as JSON for crash recovery.
 */
export interface ChannelMapping {
    channelId: string;
    sessionName: string;
    channelName: string | null;
    channelPurpose: string | null;
}
export interface SessionChannelRegistryConfig {
    /** Path to the JSON registry file */
    registryPath: string;
}
export declare class SessionChannelRegistry {
    private channelToSession;
    private sessionToChannel;
    private channelToName;
    private channelToPurpose;
    private registryPath;
    constructor(config: SessionChannelRegistryConfig);
    register(channelId: string, sessionName: string, channelName?: string): void;
    unregister(channelId: string): void;
    getSessionForChannel(channelId: string): string | null;
    getChannelForSession(sessionName: string): string | null;
    getChannelName(channelId: string): string | null;
    setChannelName(channelId: string, name: string): void;
    getChannelPurpose(channelId: string): string | null;
    setChannelPurpose(channelId: string, purpose: string): void;
    /**
     * Get all active channel-session mappings.
     */
    getAllMappings(): ChannelMapping[];
    /**
     * Get all channel-session pairs as a Map (used by heartbeat/monitoring).
     */
    getAllChannelSessions(): Map<string, string>;
    /**
     * Get count of registered mappings.
     */
    get size(): number;
    private load;
    private save;
}
//# sourceMappingURL=SessionChannelRegistry.d.ts.map