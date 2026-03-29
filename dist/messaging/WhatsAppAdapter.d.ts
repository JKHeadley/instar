/**
 * WhatsApp Messaging Adapter — send/receive messages via WhatsApp.
 *
 * Supports two backends:
 * - Baileys (WhatsApp Web protocol): Free, personal use, QR auth
 * - Business API (Meta Cloud API): Paid, enterprise, webhook-based
 *
 * Phase 2 implements the Baileys backend only. Business API is Phase 3.
 *
 * Uses shared infrastructure: MessageLogger, SessionChannelRegistry,
 * StallDetector, CommandRouter, AuthGate, MessagingEventBus.
 */
import type { MessagingAdapter, Message, OutgoingMessage } from '../core/types.js';
import { CommandRouter } from './shared/CommandRouter.js';
import { AuthGate } from './shared/AuthGate.js';
import { MessagingEventBus } from './shared/MessagingEventBus.js';
import { PrivacyConsent } from './shared/PrivacyConsent.js';
export type WhatsAppBackend = 'baileys' | 'business-api';
export interface BaileysConfig {
    /** Path to store auth state (QR code session persistence). Defaults to {stateDir}/whatsapp-auth/ */
    authDir?: string;
    /** Whether to mark as "available" (suppresses phone notifications if true). Default: false */
    markOnline?: boolean;
    /** Reconnect attempts before circuit breaker trips. Default: 10 */
    maxReconnectAttempts?: number;
    /** Auth method: 'qr' (scan QR code) or 'pairing-code' (8-digit code for headless). Default: 'qr' */
    authMethod?: 'qr' | 'pairing-code';
    /** Phone number for pairing code auth (required when authMethod is 'pairing-code') */
    pairingPhoneNumber?: string;
    /** Override WhatsApp Web protocol version [major, minor, patch]. Auto-fetched if not set. */
    version?: [number, number, number];
    /** Browser identifier [platform, browser, version]. Default: ['Mac OS', 'Chrome', '14.4.1'] (MACOS platform). */
    browser?: [string, string, string];
}
export interface BusinessApiConfig {
    /** Phone Number ID from Meta */
    phoneNumberId: string;
    /** Access token */
    accessToken: string;
    /** Webhook verify token */
    webhookVerifyToken: string;
    /** Webhook port (if different from Instar server port) */
    webhookPort?: number;
}
export interface WhatsAppConfig {
    /** Which backend to use. Default: 'baileys' */
    backend?: WhatsAppBackend;
    /** Baileys-specific config */
    baileys?: BaileysConfig;
    /** Business API-specific config (Phase 3) */
    businessApi?: BusinessApiConfig;
    /**
     * Authorized phone numbers (E.164 format: +1234567890).
     * Empty/missing = deny all (safe default). Use ['*'] to explicitly allow all.
     */
    authorizedNumbers?: string[];
    /** Voice transcription provider (shared with Telegram) */
    voiceProvider?: string;
    /** Stall detection timeout in minutes. Default: 5 */
    stallTimeoutMinutes?: number;
    /** Promise tracking timeout in minutes. Default: 10 */
    promiseTimeoutMinutes?: number;
    /** Max WhatsApp message length before chunking. Default: 4000 */
    maxMessageLength?: number;
    /** Busy-state handling mode. Default: 'queue' */
    busyMode?: 'queue' | 'interrupt' | 'reject-with-ack';
    /** Max queued messages per session. Default: 10 */
    maxQueuedMessages?: number;
    /** Per-user rate limit (messages per minute). Default: 20 */
    rateLimitPerMinute?: number;
    /** Whether privacy consent is required before processing messages. Default: true */
    requireConsent?: boolean;
    /** Custom privacy consent message */
    consentMessage?: string;
    /** Send typing indicators when processing messages. Baileys only. Default: true */
    sendTypingIndicators?: boolean;
    /** Send read receipts (blue ticks) on message receive. Default: true */
    sendReadReceipts?: boolean;
    /** Emoji to react with on message receive (ack reaction). Set false to disable. Default: '👀' */
    ackReactionEmoji?: string | false;
    /** Prepend agent name to outbound messages for identity clarity. Default: true */
    prefixEnabled?: boolean;
    /** Custom prefix format. Supports WhatsApp markdown. Default: "*[{agentName}]* " */
    messagePrefix?: string;
    /** Agent display name, used in message prefix and group mentions. Default: 'Agent' */
    agentName?: string;
    /** Silently drop messages from unauthorized numbers (no response sent).
     *  Default: true. When false, uses AuthGate registration policy to respond.
     *  Recommended: true for linked-device mode (Baileys) to avoid revealing the agent to personal contacts. */
    silentReject?: boolean;
    /** Group messaging configuration */
    groups?: WhatsAppGroupConfig;
}
export interface WhatsAppGroupConfig {
    /** Enable group message handling. Default: false */
    enabled?: boolean;
    /** Authorized group JIDs (@g.us format). Empty = allow all groups the agent is in. */
    authorizedGroups?: string[];
    /** Default activation mode for groups. 'mention' = only respond when @mentioned. 'always' = respond to all messages. Default: 'mention' */
    defaultActivation?: 'mention' | 'always';
    /** Number of recent messages to buffer per group for context. Default: 50 */
    maxContextMessages?: number;
    /** Per-group overrides keyed by group JID */
    groupOverrides?: Record<string, {
        activation?: 'mention' | 'always';
    }>;
    /** Prefix agent responses with agent name for clarity (since Baileys uses the user's identity). Default: true */
    prefixResponses?: boolean;
    /** Agent display name for response prefixes. Defaults to the project name. */
    agentName?: string;
}
export interface BackendCapabilities {
    /** Send a text message. Required. */
    sendText: (jid: string, text: string) => Promise<void>;
    /** Send typing/composing indicator. Baileys only. */
    sendTyping?: (jid: string) => Promise<void>;
    /** Stop typing indicator. Baileys only. */
    stopTyping?: (jid: string) => Promise<void>;
    /** Mark messages as read (blue ticks). */
    sendReadReceipt?: (jid: string, messageId: string, msgKey?: unknown) => Promise<void>;
    /** React to a message with an emoji. */
    sendReaction?: (jid: string, messageId: string, emoji: string, msgKey?: unknown) => Promise<void>;
}
export type ConnectionState = 'disconnected' | 'connecting' | 'qr-pending' | 'connected' | 'reconnecting' | 'closed';
export interface WhatsAppStatus {
    state: ConnectionState;
    phoneNumber: string | null;
    reconnectAttempts: number;
    lastConnected: string | null;
    lastError: string | null;
    pendingMessages: number;
    stalledChannels: number;
    registeredSessions: number;
    totalMessagesLogged: number;
}
export declare class WhatsAppAdapter implements MessagingAdapter {
    readonly platform = "whatsapp";
    private config;
    private stateDir;
    private messageHandler;
    private connectionState;
    private phoneNumber;
    private reconnectAttempts;
    private lastConnected;
    private lastError;
    private logger;
    private registry;
    private stallDetector;
    private commandRouter;
    private authGate;
    private eventBus;
    private processedMessageIds;
    private static readonly DEDUP_MAX_SIZE;
    private rateLimitMap;
    private groupMessageBuffers;
    private static readonly GROUP_BUFFER_MAX;
    private outboundQueue;
    private privacyConsent;
    private capabilities;
    private get sendFunction();
    private currentQrCode;
    constructor(config: Record<string, unknown>, stateDir: string);
    /** Get the event bus for external subscribers. */
    getEventBus(): MessagingEventBus;
    /** Get the shared command router (for external command registration). */
    getCommandRouter(): CommandRouter;
    /** Get the shared auth gate (for runtime authorize/deauthorize). */
    getAuthGate(): AuthGate;
    /** Get the privacy consent tracker. */
    getPrivacyConsent(): PrivacyConsent;
    /** Set the backend send function (called by BaileysBackend after connection). */
    setSendFunction(fn: (jid: string, text: string) => Promise<void>): void;
    /** Set full backend capabilities (Phase 4: typing, read receipts, reactions). */
    setBackendCapabilities(caps: BackendCapabilities): void;
    /** Set QR code for dashboard display (called by BaileysBackend). */
    setQrCode(qr: string | null): void;
    /** Get current QR code (null if connected or not in QR state). */
    getQrCode(): string | null;
    /** Update connection state (called by backend). */
    setConnectionState(state: ConnectionState, phoneNumber?: string): Promise<void>;
    /** Record the last error message for status reporting. */
    setLastError(message: string): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    send(message: OutgoingMessage): Promise<void>;
    onMessage(handler: (message: Message) => Promise<void>): void;
    resolveUser(channelIdentifier: string): Promise<string | null>;
    /** Called by backend when a message is received. */
    handleIncomingMessage(jid: string, messageId: string, text: string, senderName?: string, timestamp?: number, msgKey?: unknown, participant?: string, mentionedJids?: string[]): Promise<void>;
    /** Handle an incoming group message. */
    private handleGroupMessage;
    /** Get recent group context as formatted string for agent context. */
    getGroupContext(groupJid: string): string;
    /** Get the group message buffer for a group (for testing/inspection). */
    getGroupBuffer(groupJid: string): Array<{
        sender: string;
        senderName?: string;
        text: string;
        timestamp: string;
    }>;
    private registerCommands;
    private handleStallEvent;
    private checkRateLimit;
    private flushOutboundQueue;
    /** Register a channel to a session. */
    registerSession(channelId: string, sessionName: string): void;
    /** Get the session for a channel. */
    getSessionForChannel(channelId: string): string | null;
    /** Get the channel for a session. */
    getChannelForSession(sessionName: string): string | null;
    getStatus(): WhatsAppStatus;
    /** Increment reconnect attempt counter. Returns current count. */
    incrementReconnectAttempts(): number;
    /** Get the Baileys config with defaults.
     * Falls back to top-level WhatsApp config values for authMethod and
     * pairingPhoneNumber, since users commonly place these at the top level
     * of the WhatsApp config object rather than nested under "baileys". */
    getBaileysConfig(): Required<BaileysConfig>;
    /** Expose voice transcription provider preference for BaileysBackend. */
    getVoiceProvider(): string | undefined;
    /** Expose state directory for BaileysBackend (audio file storage). */
    getStateDir(): string;
}
//# sourceMappingURL=WhatsAppAdapter.d.ts.map