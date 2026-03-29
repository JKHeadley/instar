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
import type { MessagingAdapter, Message, OutgoingMessage } from '../../core/types.js';
import { MessageLogger, type LogEntry } from '../shared/MessageLogger.js';
import { MessagingEventBus } from '../shared/MessagingEventBus.js';
import { type StallEvent, type IsSessionAliveCheck } from '../shared/StallDetector.js';
import type { ConnectionInfo } from './types.js';
export declare class IMessageAdapter implements MessagingAdapter {
    readonly platform = "imessage";
    private config;
    private stateDir;
    private backend;
    private logger;
    readonly eventBus: MessagingEventBus;
    private registry;
    private stallDetector;
    private messageHandler;
    private started;
    private authorizedSenders;
    private receivedMessageIds;
    private logPurgeTimer;
    onMessageLogged: ((entry: LogEntry) => void) | null;
    onStallDetected: ((sender: string, sessionName: string, messageText: string) => void) | null;
    constructor(config: Record<string, unknown>, stateDir: string);
    start(): Promise<void>;
    stop(): Promise<void>;
    /**
     * Send is NOT supported from the server process.
     * iMessages must be sent from Claude Code sessions via imessage-reply.sh.
     */
    send(_message: OutgoingMessage): Promise<void>;
    onMessage(handler: (message: Message) => Promise<void>): void;
    resolveUser(channelIdentifier: string): Promise<string | null>;
    /** Register a session for a sender identifier. */
    registerSession(sender: string, sessionName: string): void;
    /** Get the session mapped to a sender, if any. */
    getSessionForSender(sender: string): string | null;
    /** Get the sender mapped to a session, if any. */
    getSenderForSession(sessionName: string): string | null;
    /** Track a message injection for stall detection. */
    trackMessageInjection(sender: string, sessionName: string, text: string): void;
    /** Clear stall tracking for a sender (called when reply is received). */
    clearStallForSender(sender: string): void;
    /** Set session liveness checker for stall detection. */
    setIsSessionAlive(check: IsSessionAliveCheck): void;
    /** Wire stall detection callback. */
    setOnStall(callback: (event: StallEvent, alive: boolean) => Promise<void>): void;
    /** Get conversation context formatted for session bootstrap. */
    getConversationContext(sender: string, limit?: number): string;
    /** List recent chats. */
    listChats(limit?: number): unknown;
    /** Get message history for a chat. */
    getChatHistory(chatId: string, limit?: number): unknown;
    /** Get current connection info. */
    getConnectionInfo(): ConnectionInfo;
    /** Check if a sender is authorized. */
    isAuthorized(sender: string): boolean;
    /** Get the message logger (for routes/searching). */
    get messageLogger(): MessageLogger;
    /** Log an outbound message (called by /imessage/reply endpoint). */
    logOutboundMessage(recipient: string, text: string): void;
    /** Mask a phone number for logging (privacy). */
    static maskIdentifier(id: string): string;
    private _handleIncomingMessage;
    private _trackReceivedId;
    private _logMessage;
    private _startLogPurge;
}
//# sourceMappingURL=IMessageAdapter.d.ts.map