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
import path from 'node:path';
import fs from 'node:fs';
import { SlackApiClient } from './SlackApiClient.js';
import { SocketModeClient } from './SocketModeClient.js';
import { ChannelManager } from './ChannelManager.js';
import { FileHandler } from './FileHandler.js';
import { RingBuffer } from './RingBuffer.js';
import { MessageLogger } from '../shared/MessageLogger.js';
import { sanitizeDisplayName } from './sanitize.js';
const RING_BUFFER_CAPACITY = 50;
const SLACK_MAX_TEXT_LENGTH = 4000;
const AUTO_ARCHIVE_DAYS = 7;
const LOG_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily
export class SlackAdapter {
    platform = 'slack';
    // Config
    config;
    stateDir;
    // Components
    apiClient;
    socketClient = null;
    channelManager;
    fileHandler;
    logger;
    // Workspace behavior (resolved from config + mode defaults)
    workspaceMode;
    autoJoinChannels;
    respondMode;
    botUserId = null;
    // State
    messageHandler = null;
    started = false;
    authorizedUsers;
    channelHistory = new Map();
    pendingPrompts = new Map();
    userCache = new Map();
    promptEvictionTimer = null;
    housekeepingTimer = null;
    logPurgeTimer = null;
    // Channel ↔ Session Registry (persisted to disk)
    channelToSession = new Map();
    channelRegistryPath;
    // Channel Resume Map (persisted — maps channel IDs to Claude session UUIDs for resume)
    channelResumeMap = new Map();
    channelResumeMapPath;
    // Callbacks (wired by server.ts)
    /** Called when a prompt gate response is received */
    onPromptResponse = null;
    /** Called when a message is logged (for dual-write to SQLite) */
    onMessageLogged = null;
    /** Called when a stall is detected */
    onStallDetected = null;
    constructor(config, stateDir) {
        this.config = config;
        this.stateDir = stateDir;
        // Validate required fields
        if (!this.config.botToken)
            throw new Error('[slack] botToken is required');
        if (!this.config.appToken)
            throw new Error('[slack] appToken is required');
        if (!Array.isArray(this.config.authorizedUserIds)) {
            throw new Error('[slack] authorizedUserIds is required (array of Slack user IDs)');
        }
        // Fail-closed: empty array means deny all
        this.authorizedUsers = new Set(this.config.authorizedUserIds);
        if (this.authorizedUsers.size === 0) {
            console.warn('[slack] authorizedUserIds is empty — all messages will be rejected (fail-closed)');
        }
        // Resolve workspace mode and defaults
        this.workspaceMode = this.config.workspaceMode ?? 'dedicated';
        const isDedicated = this.workspaceMode === 'dedicated';
        this.autoJoinChannels = this.config.autoJoinChannels ?? isDedicated;
        this.respondMode = this.config.respondMode ?? (isDedicated ? 'all' : 'mention-only');
        console.log(`[slack] Workspace mode: ${this.workspaceMode} (autoJoin: ${this.autoJoinChannels}, respond: ${this.respondMode})`);
        // Initialize components
        this.apiClient = new SlackApiClient(this.config.botToken, this.config.appToken);
        const rawAgentName = this.config.workspaceName?.replace(/-agent$/i, '') || 'agent';
        const agentName = rawAgentName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        this.channelManager = new ChannelManager(this.apiClient, agentName);
        this.fileHandler = new FileHandler(this.apiClient, this.config.botToken, stateDir);
        this.logger = new MessageLogger({
            logPath: path.join(stateDir, 'slack-messages.jsonl'),
            maxLines: 100_000,
            keepLines: 75_000,
        });
        // Channel registry and resume map persistence
        this.channelRegistryPath = path.join(stateDir, 'slack-channel-registry.json');
        this.channelResumeMapPath = path.join(stateDir, 'slack-channel-resume-map.json');
        this._loadChannelRegistry();
        this._loadChannelResumeMap();
    }
    // ── MessagingAdapter Interface ──
    async start() {
        const handlers = {
            onEvent: async (type, payload) => this._handleEvent(type, payload),
            onInteraction: async (payload) => this._handleInteraction(payload),
            onConnected: () => {
                console.log('[slack] Socket Mode connected');
                this.started = true;
            },
            onDisconnected: (reason) => {
                console.log(`[slack] Disconnected: ${reason}`);
            },
            onError: (err, permanent) => {
                if (permanent) {
                    console.error(`[slack] Permanent error: ${err.message}`);
                }
                else {
                    console.warn(`[slack] Transient error: ${err.message}`);
                }
            },
        };
        this.socketClient = new SocketModeClient(this.apiClient, handlers);
        // Connect with a 15-second timeout to prevent server startup hangs
        const SLACK_CONNECT_TIMEOUT_MS = 15000;
        const connectPromise = this.socketClient.connect();
        const timeoutPromise = new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('Slack Socket Mode connection timeout after 15s')), SLACK_CONNECT_TIMEOUT_MS);
        });
        await Promise.race([connectPromise, timeoutPromise]);
        this.started = true;
        // Fetch bot user ID (needed for @mention detection in shared mode)
        try {
            const authResult = await this.apiClient.call('auth.test', {});
            this.botUserId = authResult.user_id ?? null;
            if (this.botUserId) {
                console.log(`[slack] Bot user ID: ${this.botUserId}`);
            }
        }
        catch {
            console.warn('[slack] Could not fetch bot user ID — mention detection may not work');
        }
        // Auto-join all public channels if in dedicated mode
        if (this.autoJoinChannels) {
            this._autoJoinAllChannels();
        }
        // Start pending prompt TTL eviction
        this._startPromptEviction();
        // Start channel housekeeping (auto-archive idle channels)
        this._startHousekeeping();
        // Start log retention purge (daily)
        this._startLogPurge();
        // Purge stale log entries on startup
        this._purgeOldLogs();
    }
    async stop() {
        this.started = false;
        if (this.promptEvictionTimer) {
            clearInterval(this.promptEvictionTimer);
            this.promptEvictionTimer = null;
        }
        if (this.housekeepingTimer) {
            clearInterval(this.housekeepingTimer);
            this.housekeepingTimer = null;
        }
        if (this.logPurgeTimer) {
            clearInterval(this.logPurgeTimer);
            this.logPurgeTimer = null;
        }
        if (this.socketClient) {
            await this.socketClient.disconnect();
            this.socketClient = null;
        }
    }
    async send(message) {
        const channelId = message.channel?.identifier;
        if (!channelId) {
            console.error('[slack] Cannot send: no channel identifier');
            return;
        }
        // Chunk long messages
        const chunks = this._chunkText(message.content);
        let lastResult = null;
        for (const chunk of chunks) {
            const params = {
                channel: channelId,
                text: chunk,
            };
            // If there's thread_ts in metadata, reply in thread
            if (message.channel?.type === 'slack' && message.threadTs) {
                params.thread_ts = message.threadTs;
            }
            lastResult = await this.apiClient.call('chat.postMessage', params);
        }
        return lastResult;
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    async resolveUser(channelIdentifier) {
        // For Slack, the channel identifier IS the user reference
        return channelIdentifier || null;
    }
    // ── Slack-Specific Public Methods ──
    /** Get the current workspace behavior config. */
    getWorkspaceConfig() {
        return {
            mode: this.workspaceMode,
            autoJoinChannels: this.autoJoinChannels,
            respondMode: this.respondMode,
        };
    }
    /** Check if a user is authorized. */
    isAuthorized(userId) {
        return this.authorizedUsers.has(userId);
    }
    /** Send a message to a specific channel. */
    async sendToChannel(channelId, text, options) {
        const params = { channel: channelId, text };
        if (options?.thread_ts)
            params.thread_ts = options.thread_ts;
        const result = await this.apiClient.call('chat.postMessage', params);
        return result.ts;
    }
    /** Add a reaction (fire-and-forget). */
    addReaction(channelId, timestamp, emoji) {
        this.apiClient.call('reactions.add', { channel: channelId, timestamp, name: emoji }).catch(() => { });
    }
    /** Remove a reaction (fire-and-forget). */
    removeReaction(channelId, timestamp, emoji) {
        this.apiClient.call('reactions.remove', { channel: channelId, timestamp, name: emoji }).catch(() => { });
    }
    /** Update an existing message. */
    async updateMessage(channelId, timestamp, text) {
        await this.apiClient.call('chat.update', { channel: channelId, ts: timestamp, text });
    }
    /** Pin a message. */
    async pinMessage(channelId, timestamp) {
        await this.apiClient.call('pins.add', { channel: channelId, timestamp });
    }
    /** Send an ephemeral message (visible only to one user). */
    async postEphemeral(channelId, userId, text) {
        await this.apiClient.call('chat.postEphemeral', { channel: channelId, user: userId, text });
    }
    /** Send a message with Block Kit blocks. */
    async sendBlocks(channelId, blocks, text) {
        const params = { channel: channelId, blocks };
        if (text)
            params.text = text; // Fallback text for notifications
        const result = await this.apiClient.call('chat.postMessage', params);
        return result.ts;
    }
    /** Get cached channel messages from ring buffer. */
    getChannelMessages(channelId, limit = 30) {
        const buffer = this.channelHistory.get(channelId);
        if (!buffer)
            return [];
        const all = buffer.toArray();
        return limit >= all.length ? all : all.slice(-limit);
    }
    /** Get user info (cached for 5 minutes). */
    async getUserInfo(userId) {
        const cached = this.userCache.get(userId);
        if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
            return { id: userId, name: cached.name };
        }
        const result = await this.apiClient.call('users.info', { user: userId });
        const user = result.user;
        const name = user.real_name || user.name;
        this.userCache.set(userId, { name, fetchedAt: Date.now() });
        return { id: userId, name };
    }
    /** Create a channel. */
    async createChannel(name, isPrivate) {
        return this.channelManager.createChannel(name, isPrivate);
    }
    /** Archive a channel. */
    async archiveChannel(channelId) {
        return this.channelManager.archiveChannel(channelId);
    }
    /** Upload a file. */
    async uploadFile(channelId, filePath, title) {
        return this.fileHandler.uploadFile(channelId, filePath, title);
    }
    /** Download a file. */
    async downloadFile(url, destPath) {
        return this.fileHandler.downloadFile(url, destPath);
    }
    /** Get the underlying API client (for routes). */
    get api() {
        return this.apiClient;
    }
    // ── Channel ↔ Session Registry ──
    /** Register a channel → session binding. Persisted to disk. */
    registerChannelSession(channelId, sessionName, channelName) {
        this.channelToSession.set(channelId, {
            sessionName,
            channelName,
            registeredAt: new Date().toISOString(),
        });
        this._saveChannelRegistry();
    }
    /** Look up which session is bound to a channel. */
    getSessionForChannel(channelId) {
        return this.channelToSession.get(channelId)?.sessionName ?? null;
    }
    /** Look up which channel is bound to a session. */
    getChannelForSession(sessionName) {
        for (const [channelId, entry] of this.channelToSession) {
            if (entry.sessionName === sessionName)
                return channelId;
        }
        return null;
    }
    /** Remove a channel → session binding. */
    unregisterChannel(channelId) {
        this.channelToSession.delete(channelId);
        this._saveChannelRegistry();
    }
    /** Get all channel → session mappings. */
    getChannelRegistry() {
        const result = {};
        for (const [channelId, entry] of this.channelToSession) {
            result[channelId] = { sessionName: entry.sessionName, channelName: entry.channelName };
        }
        return result;
    }
    // ── Channel Resume Map ──
    /** Save a session UUID for resume when a channel goes idle. */
    saveChannelResume(channelId, uuid, sessionName) {
        this.channelResumeMap.set(channelId, {
            uuid,
            savedAt: new Date().toISOString(),
            sessionName,
        });
        this._saveChannelResumeMap();
    }
    /** Get the resume UUID for a channel (returns null if none or expired). */
    getChannelResume(channelId) {
        const entry = this.channelResumeMap.get(channelId);
        if (!entry)
            return null;
        // Expire entries older than 24 hours
        const age = Date.now() - new Date(entry.savedAt).getTime();
        if (age > 24 * 60 * 60 * 1000) {
            this.channelResumeMap.delete(channelId);
            this._saveChannelResumeMap();
            return null;
        }
        return { uuid: entry.uuid, sessionName: entry.sessionName };
    }
    /** Remove a resume entry (consumed after resume). */
    removeChannelResume(channelId) {
        this.channelResumeMap.delete(channelId);
        this._saveChannelResumeMap();
    }
    // ── Registry Persistence ──
    _loadChannelRegistry() {
        try {
            if (fs.existsSync(this.channelRegistryPath)) {
                const data = JSON.parse(fs.readFileSync(this.channelRegistryPath, 'utf-8'));
                for (const [k, v] of Object.entries(data.channelToSession ?? {})) {
                    this.channelToSession.set(k, v);
                }
            }
        }
        catch { /* non-fatal */ }
    }
    _saveChannelRegistry() {
        try {
            const data = { channelToSession: Object.fromEntries(this.channelToSession) };
            const tmp = this.channelRegistryPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, this.channelRegistryPath);
        }
        catch { /* non-fatal */ }
    }
    _loadChannelResumeMap() {
        try {
            if (fs.existsSync(this.channelResumeMapPath)) {
                const data = JSON.parse(fs.readFileSync(this.channelResumeMapPath, 'utf-8'));
                for (const [k, v] of Object.entries(data)) {
                    this.channelResumeMap.set(k, v);
                }
            }
        }
        catch { /* non-fatal */ }
    }
    _saveChannelResumeMap() {
        try {
            const data = Object.fromEntries(this.channelResumeMap);
            const tmp = this.channelResumeMapPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, this.channelResumeMapPath);
        }
        catch { /* non-fatal */ }
    }
    // ── Test Helpers (underscore-prefixed) ──
    /** Inject a simulated message for testing. */
    async _testInjectMessage(event) {
        await this._handleEvent('message', { event });
    }
    /** Inject a simulated interaction for testing. */
    async _testInjectInteraction(payload) {
        await this._handleInteraction(payload);
    }
    // ── Internal Event Handling ──
    async _handleEvent(type, payload) {
        const event = (payload.event ?? payload);
        if (type === 'message' || event.type === 'message') {
            await this._handleMessage(event);
        }
        else if (type === 'file_shared') {
            await this._handleFileShared(event);
        }
        else if (type === 'channel_created' && this.autoJoinChannels) {
            // Auto-join newly created channels in dedicated mode
            const channel = event.channel;
            const newChannelId = channel?.id ?? event.channel;
            if (newChannelId) {
                this.apiClient.call('conversations.join', { channel: newChannelId }).then(() => {
                    console.log(`[slack] Auto-joined new channel ${newChannelId}`);
                }).catch((err) => {
                    console.warn(`[slack] Could not auto-join new channel: ${err.message}`);
                });
            }
        }
    }
    async _handleMessage(event) {
        const userId = event.user;
        const text = event.text ?? '';
        const channelId = event.channel;
        const ts = event.ts;
        const threadTs = event.thread_ts;
        const files = event.files;
        // Skip bot messages and most subtypes (edits, deletes, etc.)
        // Allow file_share subtype through — that's how Slack sends messages with attachments
        if (event.bot_id)
            return;
        const subtype = event.subtype;
        if (subtype && subtype !== 'file_share')
            return;
        if (!userId || !channelId)
            return;
        // AuthGate — fail-closed
        if (!this.isAuthorized(userId)) {
            return; // Silently drop unauthorized messages
        }
        // In mention-only mode, skip messages that don't @mention the bot (except DMs and commands)
        const isDM = channelId.startsWith('D');
        if (this.respondMode === 'mention-only' && !isDM && !this._isBotMentioned(text)) {
            // Still populate ring buffer for context, but don't process
            const buffer = this.channelHistory.get(channelId) ?? new RingBuffer(RING_BUFFER_CAPACITY);
            buffer.push({ ts, user: userId, text, channel: channelId, thread_ts: threadTs });
            this.channelHistory.set(channelId, buffer);
            return;
        }
        // Handle commands (Slack intercepts / prefix, so we use ! prefix)
        // Supports both !command and /command (in case Slack delivers it)
        if (text.startsWith('!') || text.startsWith('/')) {
            const normalizedText = text.startsWith('!') ? '/' + text.slice(1) : text;
            const handled = await this._handleSlashCommand(normalizedText, channelId, ts);
            if (handled)
                return;
        }
        // Strip @mention of the bot from message text (so sessions see clean content)
        let cleanText = text;
        if (this.botUserId) {
            cleanText = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
        }
        // Download attached files (images, documents) and append [image:path]/[document:path] tags
        const filePaths = [];
        if (files && files.length > 0) {
            for (const file of files) {
                const url = file.url_private;
                const mimetype = file.mimetype ?? '';
                const filename = file.name ?? 'file';
                if (!url)
                    continue;
                try {
                    const isImage = mimetype.startsWith('image/');
                    const destName = `${isImage ? 'photo' : 'file'}-${Date.now()}-${file.id ?? ts}.${filename.split('.').pop() ?? 'bin'}`;
                    const destPath = path.join(this.fileHandler.downloadDir, destName);
                    const savedPath = await this.fileHandler.downloadFile(url, destPath);
                    filePaths.push(savedPath);
                    if (isImage) {
                        cleanText = cleanText ? `${cleanText} [image:${savedPath}]` : `[image:${savedPath}]`;
                    }
                    else {
                        cleanText = cleanText ? `${cleanText} [document:${savedPath}]` : `[document:${savedPath}]`;
                    }
                }
                catch (err) {
                    console.warn(`[slack] Failed to download file ${filename}: ${err.message}`);
                    const isImage = mimetype.startsWith('image/');
                    cleanText = cleanText ? `${cleanText} [${isImage ? 'image' : 'document'}:download-failed]` : `[${isImage ? 'image' : 'document'}:download-failed]`;
                }
            }
        }
        // Populate ring buffer (authorized messages only — prevents cache poisoning)
        const buffer = this.channelHistory.get(channelId) ?? new RingBuffer(RING_BUFFER_CAPACITY);
        buffer.push({ ts, user: userId, text: cleanText, channel: channelId, thread_ts: threadTs });
        this.channelHistory.set(channelId, buffer);
        // Resolve user name
        let senderName = userId;
        try {
            const info = await this.getUserInfo(userId);
            senderName = info.name;
        }
        catch {
            // Use userId as fallback
        }
        // Log inbound message
        const logEntry = {
            messageId: ts,
            channelId,
            text: cleanText,
            fromUser: true,
            timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
            sessionName: null,
            senderName: sanitizeDisplayName(senderName),
            platformUserId: userId,
            platform: 'slack',
        };
        this.logger.append(logEntry);
        this.onMessageLogged?.(logEntry);
        // Acknowledge with reaction (fire-and-forget)
        this.addReaction(channelId, ts, 'eyes');
        // Convert to Instar Message format
        const message = {
            id: `slack-${ts}`,
            userId,
            content: cleanText,
            channel: {
                type: 'slack',
                identifier: channelId,
            },
            receivedAt: new Date(parseFloat(ts) * 1000).toISOString(),
            metadata: {
                slackUserId: userId,
                senderName: sanitizeDisplayName(senderName),
                ts,
                threadTs: threadTs,
                channelId,
                isDM,
            },
        };
        // Route to handler
        if (this.messageHandler) {
            try {
                await this.messageHandler(message);
            }
            catch (err) {
                console.error('[slack] Message handler error:', err.message);
            }
        }
        // Mark complete (replace eyes with checkmark)
        this.removeReaction(channelId, ts, 'eyes');
        this.addReaction(channelId, ts, 'white_check_mark');
    }
    async _handleInteraction(payload) {
        const userId = payload.user?.id;
        if (!userId)
            return;
        // AuthGate check
        if (!this.isAuthorized(userId)) {
            console.warn(`[slack] Unauthorized interaction from ${userId}`);
            return;
        }
        const action = payload.actions?.[0];
        if (!action)
            return;
        if (action.action_id.startsWith('prompt::')) {
            const parts = action.action_id.split('::');
            const promptId = parts[1];
            // Validate this is a prompt we sent
            const messageTs = payload.message?.ts;
            if (!messageTs || !this.pendingPrompts.has(messageTs)) {
                console.warn(`[slack] Interaction for unknown prompt ts: ${messageTs}`);
                return;
            }
            this.pendingPrompts.delete(messageTs);
            // Update message to show selection
            if (payload.channel?.id && messageTs) {
                await this.updateMessage(payload.channel.id, messageTs, `Answered: ${action.text?.text ?? action.value ?? 'selected'}`).catch(() => { });
            }
        }
    }
    async _handleFileShared(event) {
        // Files attached to messages are handled inline in _handleMessage.
        // This handler catches standalone file_shared events (e.g., drag-and-drop without text).
        const userId = event.user_id ?? event.user;
        // AuthGate — check before download (prevents disk exhaustion from unauthorized users)
        if (!userId || !this.isAuthorized(userId)) {
            return;
        }
        // Standalone file_shared events are rare — most files come as message attachments.
        // The file_id is in the event, but we'd need files.info to get the URL.
        // For now, message-embedded files (handled in _handleMessage) cover the primary use case.
        const fileId = event.file_id;
        if (fileId) {
            console.log(`[slack] file_shared event for ${fileId} — handled inline with message`);
        }
    }
    // ── Prompt Gate ──
    /** Register a pending prompt (for interaction validation). */
    registerPendingPrompt(messageTs, promptId, channelId) {
        this.pendingPrompts.set(messageTs, {
            promptId,
            channelId,
            messageTs,
            createdAt: Date.now(),
        });
    }
    _startPromptEviction() {
        const ttl = (this.config.promptGate?.relayTimeoutSeconds ?? 300) * 1000;
        this.promptEvictionTimer = setInterval(() => {
            const now = Date.now();
            for (const [ts, prompt] of this.pendingPrompts) {
                if (now - prompt.createdAt > ttl) {
                    this.pendingPrompts.delete(ts);
                }
            }
        }, 60_000); // Check every 60s
    }
    // ── Utilities ──
    // ── Prompt Gate (Block Kit) ──
    /**
     * Relay a prompt to the user via Block Kit interactive message.
     * Registers the prompt for validation against spoofed button presses.
     */
    async relayPrompt(channelId, promptId, question, options) {
        const blocks = [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: `*Agent needs your input:*\n${question}` },
            },
            {
                type: 'actions',
                elements: options.map((opt, i) => ({
                    type: 'button',
                    text: { type: 'plain_text', text: opt.label },
                    value: opt.value,
                    action_id: `prompt::${promptId}::${i}`,
                    ...(opt.primary ? { style: 'primary' } : {}),
                })),
            },
        ];
        const ts = await this.sendBlocks(channelId, blocks, question);
        this.registerPendingPrompt(ts, promptId, channelId);
    }
    // ── Message Search ──
    /** Search the JSONL message log. */
    searchLog(params) {
        return this.logger.search(params);
    }
    /** Get message log statistics. */
    getLogStats() {
        return this.logger.getStats();
    }
    // ── Channel Housekeeping ──
    /**
     * Auto-archive channels idle for more than AUTO_ARCHIVE_DAYS.
     * Runs periodically. Only archives session channels (sess- prefix).
     */
    async _archiveIdleChannels() {
        try {
            const channels = await this.channelManager.listChannels();
            const now = Date.now();
            const threshold = AUTO_ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
            for (const channel of channels) {
                // Only auto-archive session channels, not system/job channels
                if (!channel.name.includes('-sess-') || channel.is_archived)
                    continue;
                // Check last message time from ring buffer
                const history = this.channelHistory.get(channel.id);
                const lastMessage = history?.toArray().at(-1);
                if (lastMessage) {
                    const lastTs = parseFloat(lastMessage.ts) * 1000;
                    if (now - lastTs > threshold) {
                        await this.channelManager.archiveChannel(channel.id);
                        console.log(`[slack] Auto-archived idle channel: ${channel.name}`);
                    }
                }
            }
        }
        catch (err) {
            console.error('[slack] Channel housekeeping error:', err.message);
        }
    }
    _startHousekeeping() {
        // Run every 6 hours
        this.housekeepingTimer = setInterval(() => {
            this._archiveIdleChannels().catch(() => { });
        }, 6 * 60 * 60 * 1000);
        if (this.housekeepingTimer.unref)
            this.housekeepingTimer.unref();
    }
    // ── Log Retention ──
    /** Purge log entries older than logRetentionDays. */
    _purgeOldLogs() {
        const retentionDays = this.config.logRetentionDays ?? 90;
        if (retentionDays === 0)
            return; // Unlimited
        const logPath = path.join(this.stateDir, 'slack-messages.jsonl');
        if (!fs.existsSync(logPath))
            return;
        try {
            const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
            const content = fs.readFileSync(logPath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            const kept = lines.filter(line => {
                try {
                    const entry = JSON.parse(line);
                    return new Date(entry.timestamp) >= cutoff;
                }
                catch {
                    return true; // Keep unparseable lines
                }
            });
            if (kept.length < lines.length) {
                fs.writeFileSync(logPath, kept.join('\n') + '\n');
                console.log(`[slack] Log purge: removed ${lines.length - kept.length} entries older than ${retentionDays} days`);
            }
        }
        catch {
            // Non-fatal — will retry on next cycle
        }
    }
    _startLogPurge() {
        this.logPurgeTimer = setInterval(() => {
            this._purgeOldLogs();
        }, LOG_PURGE_INTERVAL_MS);
        if (this.logPurgeTimer.unref)
            this.logPurgeTimer.unref();
    }
    // ── Dashboard ──
    /**
     * Broadcast the tunnel URL to the dashboard channel.
     * Called by server.ts when tunnel is established.
     */
    /** Last broadcast dashboard URL and message timestamp (for update-in-place) */
    lastDashboardUrl = null;
    lastDashboardMessageTs = null;
    async broadcastDashboardUrl(tunnelUrl) {
        const dashboardChannelId = this.config.dashboardChannelId;
        if (!dashboardChannelId)
            return;
        // Skip if URL hasn't changed
        if (this.lastDashboardUrl === tunnelUrl)
            return;
        const text = `Dashboard available at: ${tunnelUrl}`;
        try {
            if (this.lastDashboardMessageTs) {
                // Update existing message in-place
                await this.updateMessage(dashboardChannelId, this.lastDashboardMessageTs, text);
            }
            else {
                // First time — post new message and pin it
                const ts = await this.sendToChannel(dashboardChannelId, text);
                this.lastDashboardMessageTs = ts;
                try {
                    await this.pinMessage(dashboardChannelId, ts);
                }
                catch { /* already pinned or can't pin */ }
            }
            this.lastDashboardUrl = tunnelUrl;
        }
        catch (err) {
            // If update fails (message deleted?), post new
            try {
                const ts = await this.sendToChannel(dashboardChannelId, text);
                this.lastDashboardMessageTs = ts;
                this.lastDashboardUrl = tunnelUrl;
                try {
                    await this.pinMessage(dashboardChannelId, ts);
                }
                catch { /* ignore */ }
            }
            catch (err2) {
                console.error('[slack] Dashboard broadcast failed:', err2.message);
            }
        }
    }
    // ── Unanswered Message Detection ──
    /**
     * Get count of unanswered user messages in a channel.
     * A message is "unanswered" if it's from a user and no agent reply follows.
     */
    getUnansweredCount(channelId) {
        const messages = this.getChannelMessages(channelId);
        let unanswered = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            // Messages from authorized users are "user" messages
            if (this.authorizedUsers.has(msg.user)) {
                unanswered++;
            }
            else {
                break; // Agent reply found — stop counting
            }
        }
        return unanswered;
    }
    // ── Slash Commands (Telegram parity) ──
    /** Handle slash commands from Slack messages. Returns true if handled. */
    async _handleSlashCommand(text, channelId, ts) {
        const parts = text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');
        switch (cmd) {
            case '/sessions': {
                // List running sessions
                const sessions = this.getChannelRegistry();
                const lines = Object.entries(sessions).map(([chId, info]) => `• ${info.sessionName}${info.channelName ? ` (#${info.channelName})` : ` (${chId})`}`);
                const reply = lines.length > 0
                    ? `Running Slack sessions:\n${lines.join('\n')}`
                    : 'No active Slack sessions.';
                await this.sendToChannel(channelId, reply);
                return true;
            }
            case '/new': {
                // Create new session with Slack channel
                const name = args || `session-${Date.now()}`;
                const channelName = `${(this.config.workspaceName?.replace(/-agent$/i, '') || 'agent').toLowerCase().replace(/[^a-z0-9]/g, '-')}-sess-${name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40)}`;
                try {
                    const newChannelId = await this.createChannel(channelName);
                    // Invite authorized users
                    for (const uid of this.config.authorizedUserIds) {
                        this.apiClient.call('conversations.invite', { channel: newChannelId, users: uid }).catch(() => { });
                    }
                    await this.sendToChannel(channelId, `Created new session channel: #${channelName}`);
                    await this.sendToChannel(newChannelId, `Session "${name}" is ready. Send a message here to start working.`);
                }
                catch (err) {
                    await this.sendToChannel(channelId, `Failed to create session: ${err.message}`);
                }
                return true;
            }
            case '/help': {
                await this.sendToChannel(channelId, `Available commands (use \`!\` prefix in Slack — Slack intercepts \`/\`):\n` +
                    `• \`!sessions\` — List running Slack sessions\n` +
                    `• \`!new [name]\` — Create a new session with a Slack channel\n` +
                    `• \`!help\` — Show this help message`);
                return true;
            }
            default:
                // Unknown command — don't handle, let it pass through as a regular message
                return false;
        }
    }
    /**
     * Auto-join all public channels in the workspace.
     * Only called in dedicated mode or when autoJoinChannels is true.
     * Runs asynchronously — doesn't block startup.
     */
    async _autoJoinAllChannels() {
        try {
            const result = await this.apiClient.call('conversations.list', {
                types: 'public_channel',
                limit: 200,
                exclude_archived: true,
            });
            const channels = (result.channels ?? []);
            let joined = 0;
            for (const ch of channels) {
                if (ch.is_member)
                    continue;
                try {
                    await this.apiClient.call('conversations.join', { channel: ch.id });
                    joined++;
                }
                catch (err) {
                    // channels:join scope might not be available — log and continue
                    console.warn(`[slack] Could not auto-join #${ch.name}: ${err.message}`);
                }
            }
            if (joined > 0) {
                console.log(`[slack] Auto-joined ${joined} channel(s)`);
            }
        }
        catch (err) {
            console.warn(`[slack] Auto-join channel scan failed: ${err.message}`);
        }
    }
    /**
     * Check if a message mentions the bot (via @mention).
     * Slack encodes mentions as <@U12345> in message text.
     */
    _isBotMentioned(text) {
        if (!this.botUserId)
            return false;
        return text.includes(`<@${this.botUserId}>`);
    }
    _chunkText(text) {
        if (text.length <= SLACK_MAX_TEXT_LENGTH)
            return [text];
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= SLACK_MAX_TEXT_LENGTH) {
                chunks.push(remaining);
                break;
            }
            // Try to break at a newline
            let breakPoint = remaining.lastIndexOf('\n', SLACK_MAX_TEXT_LENGTH);
            if (breakPoint < SLACK_MAX_TEXT_LENGTH / 2) {
                // No good newline break — try space
                breakPoint = remaining.lastIndexOf(' ', SLACK_MAX_TEXT_LENGTH);
            }
            if (breakPoint < SLACK_MAX_TEXT_LENGTH / 2) {
                // No good break point — hard break
                breakPoint = SLACK_MAX_TEXT_LENGTH;
            }
            chunks.push(remaining.slice(0, breakPoint));
            remaining = remaining.slice(breakPoint).trimStart();
        }
        return chunks;
    }
}
//# sourceMappingURL=SlackAdapter.js.map