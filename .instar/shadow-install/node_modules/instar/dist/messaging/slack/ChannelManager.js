/**
 * ChannelManager — Slack channel CRUD operations.
 *
 * Handles channel creation (with naming conventions), archiving,
 * listing, and history retrieval. Uses conversations.* API methods.
 */
import { validateChannelName } from './sanitize.js';
export class ChannelManager {
    api;
    agentName;
    constructor(api, agentName) {
        this.api = api;
        this.agentName = agentName;
    }
    /**
     * Create a channel. Returns the channel ID.
     * Validates name format. Checks for existing channel first (idempotent).
     */
    async createChannel(name, isPrivate = false) {
        if (!validateChannelName(name)) {
            throw new Error(`Invalid channel name: "${name}". Must be lowercase alphanumeric with hyphens/underscores, max 80 chars.`);
        }
        // Check if channel already exists
        const existing = await this.findChannelByName(name);
        if (existing) {
            // Unarchive if it was archived
            if (existing.is_archived) {
                await this.unarchiveChannel(existing.id);
            }
            return existing.id;
        }
        const result = await this.api.call('conversations.create', {
            name,
            is_private: isPrivate,
        });
        return result.channel.id;
    }
    /** Create a system channel with the agent prefix. */
    async createSystemChannel(category, descriptor) {
        const name = `${this.agentName}-${category}-${descriptor}`;
        return this.createChannel(name);
    }
    /** Archive a channel (reversible). */
    async archiveChannel(channelId) {
        try {
            await this.api.call('conversations.archive', { channel: channelId });
        }
        catch (err) {
            // Ignore "already_archived" error
            if (err.message?.includes('already_archived'))
                return;
            throw err;
        }
    }
    /** Unarchive a channel. */
    async unarchiveChannel(channelId) {
        try {
            await this.api.call('conversations.unarchive', { channel: channelId });
        }
        catch (err) {
            // Ignore "not_archived" error
            if (err.message?.includes('not_archived'))
                return;
            throw err;
        }
    }
    /** List all channels the bot is in. */
    async listChannels() {
        const result = await this.api.call('conversations.list', {
            types: 'public_channel,private_channel',
            exclude_archived: false,
            limit: 200,
        });
        return result.channels ?? [];
    }
    /** Get channel info. */
    async getChannelInfo(channelId) {
        const result = await this.api.call('conversations.info', { channel: channelId });
        return result.channel;
    }
    /**
     * Get channel message history (for cold start / cache miss only).
     * Use ring buffer for hot-path reads.
     */
    async getChannelHistory(channelId, limit = 50) {
        const result = await this.api.call('conversations.history', {
            channel: channelId,
            limit: Math.min(limit, 200),
        });
        const messages = result.messages ?? [];
        // Slack returns newest-first; reverse to oldest-first
        return messages.reverse();
    }
    /** Find a channel by name (returns first match or null). */
    async findChannelByName(name) {
        const channels = await this.listChannels();
        return channels.find(c => c.name === name) ?? null;
    }
}
//# sourceMappingURL=ChannelManager.js.map