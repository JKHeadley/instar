/**
 * IMessageAdapter — Native iMessage messaging adapter for Instar.
 *
 * Implements the MessagingAdapter interface using the NativeBackend
 * (direct SQLite reads from chat.db + polling for new messages).
 *
 * Key design decisions:
 * - macOS-only (requires Messages.app + Full Disk Access on node)
 * - Read-only from server context (NativeBackend reads chat.db)
 * - Sending happens from Claude Code sessions via imessage-reply.sh
 * - authorizedSenders is required and fail-closed
 * - SessionChannelRegistry maps senders to sessions
 * - StallDetector monitors for unanswered messages
 */
import path from 'node:path';
import { NativeBackend } from './NativeBackend.js';
import { MessageLogger } from '../shared/MessageLogger.js';
import { MessagingEventBus } from '../shared/MessagingEventBus.js';
import { SessionChannelRegistry } from '../shared/SessionChannelRegistry.js';
import { StallDetector } from '../shared/StallDetector.js';
const RECEIVED_IDS_MAX_SIZE = 1_000;
const LOG_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export class IMessageAdapter {
    platform = 'imessage';
    // Config
    config;
    stateDir;
    // Components
    backend;
    logger;
    eventBus;
    registry;
    stallDetector;
    // State
    messageHandler = null;
    started = false;
    authorizedSenders;
    receivedMessageIds = new Set();
    logPurgeTimer = null;
    // Callbacks (wired by server.ts)
    onMessageLogged = null;
    onStallDetected = null;
    constructor(config, stateDir) {
        this.config = config;
        this.stateDir = stateDir;
        if (!Array.isArray(this.config.authorizedSenders)) {
            throw new Error('[imessage] authorizedSenders is required (array of phone numbers or email addresses)');
        }
        this.authorizedSenders = new Set(this.config.authorizedSenders.map((s) => s.trim().toLowerCase()));
        if (this.authorizedSenders.size === 0) {
            console.warn('[imessage] authorizedSenders is empty — all messages will be rejected (fail-closed)');
        }
        // Initialize backend (read-only)
        this.backend = new NativeBackend({
            dbPath: this.config.dbPath,
            pollIntervalMs: this.config.pollIntervalMs,
            includeAttachments: this.config.includeAttachments,
        });
        // Initialize logger
        this.logger = new MessageLogger({
            logPath: path.join(stateDir, 'imessage-messages.jsonl'),
            maxLines: 100_000,
            keepLines: 75_000,
        });
        // Initialize event bus
        this.eventBus = new MessagingEventBus('imessage');
        // Initialize session-channel registry
        this.registry = new SessionChannelRegistry({
            registryPath: path.join(stateDir, 'imessage-sessions.json'),
        });
        // Initialize stall detector
        this.stallDetector = new StallDetector({
            stallTimeoutMinutes: this.config.stallTimeoutMinutes ?? 5,
            promiseTimeoutMinutes: this.config.promiseTimeoutMinutes ?? 10,
        });
        // Wire backend message events
        this.backend.on('message', (msg) => this._handleIncomingMessage(msg));
        this.backend.on('stateChange', (state) => {
            console.log(`[imessage] Connection state: ${state}`);
        });
    }
    // ── MessagingAdapter Interface ──
    async start() {
        if (this.started)
            return;
        await this.backend.connect();
        this.started = true;
        // Start stall detection
        this.stallDetector.start();
        // Start log retention purge
        this._startLogPurge();
        console.log('[imessage] Adapter started (backend: native)');
    }
    async stop() {
        this.started = false;
        if (this.logPurgeTimer) {
            clearInterval(this.logPurgeTimer);
            this.logPurgeTimer = null;
        }
        this.stallDetector.stop();
        await this.backend.disconnect();
        console.log('[imessage] Adapter stopped');
    }
    /**
     * Send is NOT supported from the server process.
     * iMessages must be sent from Claude Code sessions via imessage-reply.sh.
     */
    async send(_message) {
        throw new Error('[imessage] Cannot send from server process — AppleScript Automation permission ' +
            'does not propagate through LaunchAgent. Use imessage-reply.sh from session context.');
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    async resolveUser(channelIdentifier) {
        return channelIdentifier || null;
    }
    // ── Session Management ──
    /** Register a session for a sender identifier. */
    registerSession(sender, sessionName) {
        this.registry.register(sender.toLowerCase(), sessionName, sender);
    }
    /** Get the session mapped to a sender, if any. */
    getSessionForSender(sender) {
        return this.registry.getSessionForChannel(sender.toLowerCase());
    }
    /** Get the sender mapped to a session, if any. */
    getSenderForSession(sessionName) {
        return this.registry.getChannelForSession(sessionName);
    }
    // ── Stall Detection ──
    /** Track a message injection for stall detection. */
    trackMessageInjection(sender, sessionName, text) {
        this.stallDetector.trackMessageInjection(sender.toLowerCase(), sessionName, text);
    }
    /** Clear stall tracking for a sender (called when reply is received). */
    clearStallForSender(sender) {
        this.stallDetector.clearStallForChannel(sender.toLowerCase());
    }
    /** Set session liveness checker for stall detection. */
    setIsSessionAlive(check) {
        this.stallDetector.setIsSessionAlive(check);
    }
    /** Wire stall detection callback. */
    setOnStall(callback) {
        this.stallDetector.setOnStall(callback);
    }
    // ── Context & History ──
    /** Get conversation context formatted for session bootstrap. */
    getConversationContext(sender, limit = 20) {
        return this.backend.getConversationContext(sender, limit);
    }
    /** List recent chats. */
    listChats(limit = 20) {
        return this.backend.listChats(limit);
    }
    /** Get message history for a chat. */
    getChatHistory(chatId, limit = 50) {
        return this.backend.getChatHistory(chatId, limit);
    }
    // ── Connection Info ──
    /** Get current connection info. */
    getConnectionInfo() {
        return {
            state: this.backend.state,
            connectedAt: this.started ? new Date().toISOString() : undefined,
            lastError: undefined,
            reconnectAttempts: 0,
        };
    }
    // ── Auth ──
    /** Check if a sender is authorized. */
    isAuthorized(sender) {
        return this.authorizedSenders.has(sender.trim().toLowerCase());
    }
    // ── Logging ──
    /** Get the message logger (for routes/searching). */
    get messageLogger() {
        return this.logger;
    }
    /** Log an outbound message (called by /imessage/reply endpoint). */
    logOutboundMessage(recipient, text) {
        this._logMessage({
            messageId: `out-${Date.now()}`,
            channelId: recipient,
            text,
            fromUser: false,
            timestamp: new Date().toISOString(),
            sessionName: null,
            platform: 'imessage',
        });
    }
    /** Mask a phone number for logging (privacy). */
    static maskIdentifier(id) {
        if (id.startsWith('+') && id.length > 6) {
            return id.slice(0, 4) + '***' + id.slice(-4);
        }
        if (id.includes('@')) {
            const [local, domain] = id.split('@');
            return local.slice(0, 2) + '***@' + domain;
        }
        return '***';
    }
    // ── Internal ──
    async _handleIncomingMessage(msg) {
        // Skip own outbound messages
        if (msg.isFromMe)
            return;
        // Skip duplicate notifications
        if (this.receivedMessageIds.has(msg.messageId))
            return;
        this._trackReceivedId(msg.messageId);
        // Authorization check (fail-closed)
        const senderNormalized = msg.sender.trim().toLowerCase();
        if (!this.authorizedSenders.has(senderNormalized)) {
            console.log(`[imessage] Rejected message from unauthorized sender: ${IMessageAdapter.maskIdentifier(msg.sender)}`);
            return;
        }
        // Log inbound message
        this._logMessage({
            messageId: msg.messageId,
            channelId: msg.chatId,
            text: msg.text,
            fromUser: true,
            timestamp: new Date(msg.timestamp * 1000).toISOString(),
            sessionName: null,
            senderName: msg.senderName,
            platformUserId: msg.sender,
            platform: 'imessage',
        });
        // Emit on event bus
        await this.eventBus.emit('message:incoming', {
            channelId: msg.chatId,
            userId: msg.sender,
            text: msg.text,
            timestamp: new Date(msg.timestamp * 1000).toISOString(),
            raw: msg,
        });
        // Route to registered message handler
        if (this.messageHandler) {
            const message = {
                id: msg.messageId,
                userId: msg.sender,
                content: msg.text,
                channel: { type: 'imessage', identifier: msg.sender },
                receivedAt: new Date(msg.timestamp * 1000).toISOString(),
                metadata: {
                    chatId: msg.chatId,
                    senderName: msg.senderName,
                    service: msg.service,
                    attachments: msg.attachments,
                },
            };
            try {
                await this.messageHandler(message);
            }
            catch (err) {
                console.error(`[imessage] Message handler error: ${err.message}`);
            }
        }
    }
    _trackReceivedId(messageId) {
        this.receivedMessageIds.add(messageId);
        if (this.receivedMessageIds.size > RECEIVED_IDS_MAX_SIZE) {
            const oldest = this.receivedMessageIds.values().next().value;
            if (oldest !== undefined)
                this.receivedMessageIds.delete(oldest);
        }
    }
    _logMessage(entry) {
        this.logger.append(entry);
        if (this.onMessageLogged) {
            this.onMessageLogged(entry);
        }
    }
    _startLogPurge() {
        const retentionDays = this.config.logRetentionDays ?? 90;
        if (retentionDays <= 0)
            return;
        this.logPurgeTimer = setInterval(() => {
            try {
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - retentionDays);
                this.logger.search({ since: cutoff, limit: 1 });
            }
            catch { /* non-critical */ }
        }, LOG_PURGE_INTERVAL_MS);
    }
}
//# sourceMappingURL=IMessageAdapter.js.map