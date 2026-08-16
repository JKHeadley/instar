/**
 * ChannelManager — Slack channel CRUD operations.
 *
 * Handles channel creation (with naming conventions), archiving,
 * listing, and history retrieval. Uses conversations.* API methods.
 */
import type { SlackApiClient } from './SlackApiClient.js';
import type { SlackChannel, SlackMessage } from './types.js';
export declare class ChannelManager {
    private api;
    private agentName;
    constructor(api: SlackApiClient, agentName: string);
    /**
     * Create a channel. Returns the channel ID.
     * Validates name format. Checks for existing channel first (idempotent).
     */
    createChannel(name: string, isPrivate?: boolean): Promise<string>;
    /** Create a system channel with the agent prefix. */
    createSystemChannel(category: string, descriptor: string): Promise<string>;
    /** Archive a channel (reversible). */
    archiveChannel(channelId: string): Promise<void>;
    /** Unarchive a channel. */
    unarchiveChannel(channelId: string): Promise<void>;
    /** List all channels the bot is in. */
    listChannels(): Promise<SlackChannel[]>;
    /** Get channel info. */
    getChannelInfo(channelId: string): Promise<SlackChannel>;
    /**
     * Get channel message history (for cold start / cache miss only).
     * Use ring buffer for hot-path reads.
     */
    getChannelHistory(channelId: string, limit?: number): Promise<SlackMessage[]>;
    /** Find a channel by name (returns first match or null). */
    private findChannelByName;
}
//# sourceMappingURL=ChannelManager.d.ts.map