/**
 * ChannelManager — Slack channel CRUD operations.
 *
 * Handles channel creation (with naming conventions), archiving,
 * listing, and history retrieval. Uses conversations.* API methods.
 */

import type { SlackApiClient } from './SlackApiClient.js';
import type { SlackChannel, SlackMessage } from './types.js';
import { validateChannelName } from './sanitize.js';

export class ChannelManager {
  private api: SlackApiClient;
  private agentName: string;

  constructor(api: SlackApiClient, agentName: string) {
    this.api = api;
    this.agentName = agentName;
  }

  /**
   * Create a channel. Returns the channel ID.
   * Validates name format. Checks for existing channel first (idempotent).
   */
  async createChannel(name: string, isPrivate = false): Promise<string> {
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

    return (result.channel as SlackChannel).id;
  }

  /** Create a system channel with the agent prefix. */
  async createSystemChannel(category: string, descriptor: string): Promise<string> {
    const name = `${this.agentName}-${category}-${descriptor}`;
    return this.createChannel(name);
  }

  /** Archive a channel (reversible). */
  async archiveChannel(channelId: string): Promise<void> {
    try {
      await this.api.call('conversations.archive', { channel: channelId });
    } catch (err) {
      // Ignore "already_archived" error
      if ((err as Error).message?.includes('already_archived')) return;
      throw err;
    }
  }

  /** Unarchive a channel. */
  async unarchiveChannel(channelId: string): Promise<void> {
    try {
      await this.api.call('conversations.unarchive', { channel: channelId });
    } catch (err) {
      // Ignore "not_archived" error
      if ((err as Error).message?.includes('not_archived')) return;
      throw err;
    }
  }

  /** List all channels the bot is in. */
  async listChannels(): Promise<SlackChannel[]> {
    const result = await this.api.call('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: false,
      limit: 200,
    });
    return (result.channels as SlackChannel[]) ?? [];
  }

  /** Get channel info. */
  async getChannelInfo(channelId: string): Promise<SlackChannel> {
    const result = await this.api.call('conversations.info', { channel: channelId });
    return result.channel as SlackChannel;
  }

  /**
   * Get channel message history (for cold start / cache miss only).
   * Use ring buffer for hot-path reads.
   */
  async getChannelHistory(channelId: string, limit = 50): Promise<SlackMessage[]> {
    const result = await this.api.call('conversations.history', {
      channel: channelId,
      limit: Math.min(limit, 200),
    });
    const messages = (result.messages as SlackMessage[]) ?? [];
    // Slack returns newest-first; reverse to oldest-first
    return messages.reverse();
  }

  /** Find a channel by name (returns first match or null). */
  private async findChannelByName(name: string): Promise<SlackChannel | null> {
    const channels = await this.listChannels();
    return channels.find(c => c.name === name) ?? null;
  }
}
