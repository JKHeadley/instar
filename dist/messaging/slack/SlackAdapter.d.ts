/**
 * SlackAdapter — Native Slack messaging adapter for Instar.
 *
 * Implements the MessagingAdapter interface using Socket Mode (WebSocket)
 * for event intake and the Slack Web API for outbound messages.
 *
 * Key design decisions:
 * - DIY app model (each user creates their own Slack app)
 * - Socket Mode (no public URLs, no webhooks)
 * - Zero external SDK (direct HTTP to Slack Web API)
 * - authorizedUserIds is required and fail-closed
 * - Ring buffer scoped to authorized users only
 * - JSON-encoded context files (no delimiter-based injection)
 *
 * Required bot scopes (each event subscription requires its read scope):
 *   app_mentions:read, channels:history, channels:join, channels:manage,
 *   channels:read, chat:write, files:read, groups:history, im:history,
 *   im:read, im:write, pins:write, reactions:read, reactions:write, users:read
 */
import type { MessagingAdapter, Message, OutgoingMessage } from '../../core/types.js';
import { SlackApiClient } from './SlackApiClient.js';
import { type LogEntry } from '../shared/MessageLogger.js';
import type { SlackMessage, InteractionPayload, SlackWorkspaceMode, SlackRespondMode } from './types.js';
export declare class SlackAdapter implements MessagingAdapter {
    readonly platform = "slack";
    private config;
    private stateDir;
    private apiClient;
    private socketClient;
    private channelManager;
    private fileHandler;
    private logger;
    private workspaceMode;
    private autoJoinChannels;
    private respondMode;
    private botUserId;
    private messageHandler;
    private started;
    private authorizedUsers;
    private channelHistory;
    private pendingPrompts;
    private userCache;
    private promptEvictionTimer;
    private housekeepingTimer;
    private logPurgeTimer;
    private channelToSession;
    private channelRegistryPath;
    private channelResumeMap;
    private channelResumeMapPath;
    /** Called when a prompt gate response is received */
    onPromptResponse: ((channelId: string, promptId: string, value: string) => void) | null;
    /** Called when a message is logged (for dual-write to SQLite) */
    onMessageLogged: ((entry: LogEntry) => void) | null;
    /** Called when a stall is detected */
    onStallDetected: ((channelId: string, sessionName: string, messageText: string) => void) | null;
    constructor(config: Record<string, unknown>, stateDir: string);
    start(): Promise<void>;
    stop(): Promise<void>;
    send(message: OutgoingMessage): Promise<void | unknown>;
    onMessage(handler: (message: Message) => Promise<void>): void;
    resolveUser(channelIdentifier: string): Promise<string | null>;
    /** Get the current workspace behavior config. */
    getWorkspaceConfig(): {
        mode: SlackWorkspaceMode;
        autoJoinChannels: boolean;
        respondMode: SlackRespondMode;
    };
    /** Check if a user is authorized. */
    isAuthorized(userId: string): boolean;
    /** Send a message to a specific channel. */
    sendToChannel(channelId: string, text: string, options?: {
        thread_ts?: string;
    }): Promise<string>;
    /** Add a reaction (fire-and-forget). */
    addReaction(channelId: string, timestamp: string, emoji: string): void;
    /** Remove a reaction (fire-and-forget). */
    removeReaction(channelId: string, timestamp: string, emoji: string): void;
    /** Update an existing message. */
    updateMessage(channelId: string, timestamp: string, text: string): Promise<void>;
    /** Pin a message. */
    pinMessage(channelId: string, timestamp: string): Promise<void>;
    /** Send an ephemeral message (visible only to one user). */
    postEphemeral(channelId: string, userId: string, text: string): Promise<void>;
    /** Send a message with Block Kit blocks. */
    sendBlocks(channelId: string, blocks: unknown[], text?: string): Promise<string>;
    /** Get cached channel messages from ring buffer. */
    getChannelMessages(channelId: string, limit?: number): SlackMessage[];
    /** Get user info (cached for 5 minutes). */
    getUserInfo(userId: string): Promise<{
        id: string;
        name: string;
    }>;
    /** Create a channel. */
    createChannel(name: string, isPrivate?: boolean): Promise<string>;
    /** Archive a channel. */
    archiveChannel(channelId: string): Promise<void>;
    /** Upload a file. */
    uploadFile(channelId: string, filePath: string, title?: string): Promise<void>;
    /** Download a file. */
    downloadFile(url: string, destPath: string): Promise<string>;
    /** Get the underlying API client (for routes). */
    get api(): SlackApiClient;
    /** Register a channel → session binding. Persisted to disk. */
    registerChannelSession(channelId: string, sessionName: string, channelName?: string): void;
    /** Look up which session is bound to a channel. */
    getSessionForChannel(channelId: string): string | null;
    /** Look up which channel is bound to a session. */
    getChannelForSession(sessionName: string): string | null;
    /** Remove a channel → session binding. */
    unregisterChannel(channelId: string): void;
    /** Get all channel → session mappings. */
    getChannelRegistry(): Record<string, {
        sessionName: string;
        channelName?: string;
    }>;
    /** Save a session UUID for resume when a channel goes idle. */
    saveChannelResume(channelId: string, uuid: string, sessionName: string): void;
    /** Get the resume UUID for a channel (returns null if none or expired). */
    getChannelResume(channelId: string): {
        uuid: string;
        sessionName: string;
    } | null;
    /** Remove a resume entry (consumed after resume). */
    removeChannelResume(channelId: string): void;
    private _loadChannelRegistry;
    private _saveChannelRegistry;
    private _loadChannelResumeMap;
    private _saveChannelResumeMap;
    /** Inject a simulated message for testing. */
    _testInjectMessage(event: Record<string, unknown>): Promise<void>;
    /** Inject a simulated interaction for testing. */
    _testInjectInteraction(payload: InteractionPayload): Promise<void>;
    private _handleEvent;
    private _handleMessage;
    private _handleInteraction;
    private _handleFileShared;
    /** Register a pending prompt (for interaction validation). */
    registerPendingPrompt(messageTs: string, promptId: string, channelId: string): void;
    private _startPromptEviction;
    /**
     * Relay a prompt to the user via Block Kit interactive message.
     * Registers the prompt for validation against spoofed button presses.
     */
    relayPrompt(channelId: string, promptId: string, question: string, options: Array<{
        label: string;
        value: string;
        primary?: boolean;
    }>): Promise<void>;
    /** Search the JSONL message log. */
    searchLog(params: {
        query?: string;
        channelId?: string;
        since?: Date;
        limit?: number;
    }): LogEntry[];
    /** Get message log statistics. */
    getLogStats(): {
        totalMessages: number;
        logSizeBytes: number;
        logPath: string;
    };
    /**
     * Auto-archive channels idle for more than AUTO_ARCHIVE_DAYS.
     * Runs periodically. Only archives session channels (sess- prefix).
     */
    private _archiveIdleChannels;
    private _startHousekeeping;
    /** Purge log entries older than logRetentionDays. */
    private _purgeOldLogs;
    private _startLogPurge;
    /**
     * Broadcast the tunnel URL to the dashboard channel.
     * Called by server.ts when tunnel is established.
     */
    /** Last broadcast dashboard URL and message timestamp (for update-in-place) */
    private lastDashboardUrl;
    private lastDashboardMessageTs;
    broadcastDashboardUrl(tunnelUrl: string): Promise<void>;
    /**
     * Get count of unanswered user messages in a channel.
     * A message is "unanswered" if it's from a user and no agent reply follows.
     */
    getUnansweredCount(channelId: string): number;
    /** Handle slash commands from Slack messages. Returns true if handled. */
    private _handleSlashCommand;
    /**
     * Auto-join all public channels in the workspace.
     * Only called in dedicated mode or when autoJoinChannels is true.
     * Runs asynchronously — doesn't block startup.
     */
    private _autoJoinAllChannels;
    /**
     * Check if a message mentions the bot (via @mention).
     * Slack encodes mentions as <@U12345> in message text.
     */
    private _isBotMentioned;
    private _chunkText;
}
//# sourceMappingURL=SlackAdapter.d.ts.map