/**
 * Telegram Messaging Adapter — send/receive messages via Telegram Bot API.
 *
 * Uses long polling to receive messages. Supports forum topics
 * (each user gets a topic thread). Includes topic-session registry,
 * message logging, voice transcription, photo handling, stall detection,
 * auth gating, and delivery confirmation.
 *
 * No external dependencies — uses native fetch for Telegram API calls.
 */
import type { MessagingAdapter, Message, OutgoingMessage, IntelligenceProvider } from '../core/types.js';
import { NotificationBatcher, NotificationTier } from './NotificationBatcher.js';
import type { ContentValidationConfig } from './TopicContentValidator.js';
import { MessagingEventBus } from './shared/MessagingEventBus.js';
import type { DetectedPrompt } from '../monitoring/PromptGate.js';
export interface TelegramConfig {
    /** Bot token from @BotFather */
    token: string;
    /** Forum chat ID (the supergroup where topics live) */
    chatId: string;
    /** Polling interval in ms */
    pollIntervalMs?: number;
    /** Authorized Telegram user IDs (only these users' messages are processed) */
    authorizedUserIds?: number[];
    /** Voice transcription provider: 'groq' or 'openai' (auto-detects if not set) */
    voiceProvider?: string;
    /** Stall detection timeout in minutes (default: 5, 0 to disable) */
    stallTimeoutMinutes?: number;
    /** Promise follow-through timeout in minutes (default: 10, 0 to disable) */
    promiseTimeoutMinutes?: number;
    /** Lifeline topic thread ID — the always-available channel. Auto-recreated if deleted. */
    lifelineTopicId?: number;
    /** Dashboard topic thread ID — auto-broadcasts tunnel URL on startup. */
    dashboardTopicId?: number;
    /** Dashboard PIN (for including in broadcast messages). */
    dashboardPin?: string;
    /** Content validation configuration — validates outbound messages against topic purpose */
    contentValidation?: ContentValidationConfig;
    /** Prompt Gate configuration for Telegram relay */
    promptGate?: {
        /** Telegram user ID of the session owner (only this user can respond to prompts) */
        ownerId?: number;
        /** Timeout in seconds for relay responses (default: 300 = 5 min) */
        relayTimeoutSeconds?: number;
    };
}
export interface SendResult {
    /** Telegram message ID */
    messageId: number;
    /** Topic the message was sent to */
    topicId?: number;
}
interface LogEntry {
    messageId: number;
    topicId: number | null;
    text: string;
    fromUser: boolean;
    timestamp: string;
    sessionName: string | null;
    senderName?: string;
    senderUsername?: string;
    telegramUserId?: number;
}
export interface AttentionItem {
    id: string;
    title: string;
    summary: string;
    description?: string;
    category: string;
    priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
    status: 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'DONE' | 'WONT_DO';
    sourceContext?: string;
    createdAt: string;
    updatedAt: string;
    topicId?: number;
}
/**
 * Standard topic styles for visual organization in Telegram forum.
 * Colors are the 6 values Telegram's Bot API accepts for icon_color.
 * Emojis prefix topic names for at-a-glance scanning.
 */
export declare const TOPIC_STYLE: {
    /** Green — core infrastructure (Lifeline) */
    readonly SYSTEM: {
        readonly color: 9367192;
        readonly emoji: "🛡️";
    };
    /** Purple — automated recurring jobs */
    readonly JOB: {
        readonly color: 13338331;
        readonly emoji: "⚙️";
    };
    /** Green — interactive user sessions */
    readonly SESSION: {
        readonly color: 9367192;
        readonly emoji: "💬";
    };
    /** Blue — informational (Dashboard, Updates) */
    readonly INFO: {
        readonly color: 7322096;
        readonly emoji: "📢";
    };
    /** Yellow — needs user attention */
    readonly ALERT: {
        readonly color: 16766590;
        readonly emoji: "🔔";
    };
};
/**
 * Select an appropriate emoji for a topic based on its name.
 * Matches keywords case-insensitively. Falls back to 💬 for unmatched names.
 */
export declare function selectTopicEmoji(topicName: string): string;
export declare class TelegramAdapter implements MessagingAdapter {
    readonly platform = "telegram";
    private config;
    private handler;
    private polling;
    /** True when this adapter is actively polling for messages (false in send-only mode). */
    get isPolling(): boolean;
    private pollTimeout;
    private lastUpdateId;
    private startedAt;
    private consecutivePollErrors;
    private notAForum;
    private notAForumWarned;
    private topicToSession;
    private sessionToTopic;
    private topicToName;
    private topicToPurpose;
    private registryPath;
    private messageLogPath;
    private offsetPath;
    private stateDir;
    private attentionItemToTopic;
    private attentionTopicToItem;
    private attentionItems;
    private attentionFilePath;
    private pendingMessages;
    private stallCheckInterval;
    private pendingPromises;
    onTopicMessage: ((message: Message) => void) | null;
    onInterruptSession: ((sessionName: string) => Promise<boolean>) | null;
    onRestartSession: ((sessionName: string, topicId: number) => Promise<void>) | null;
    onListSessions: (() => Array<{
        name: string;
        tmuxSession: string;
        status: string;
        alive: boolean;
    }>) | null;
    onIsSessionAlive: ((tmuxSession: string) => boolean) | null;
    onIsSessionActive: ((tmuxSession: string) => Promise<boolean>) | null;
    onMessageLogged: ((entry: {
        messageId: number;
        topicId: number | null;
        text: string;
        fromUser: boolean;
        timestamp: string;
        sessionName: string | null;
        senderName?: string;
        senderUsername?: string;
        telegramUserId?: number;
    }) => void) | null;
    onSentinelIntercept: ((message: string, topicId: number) => Promise<{
        category: 'emergency-stop' | 'pause' | 'redirect' | 'normal';
        action: {
            type: string;
            message?: string;
        };
        reason?: string;
    } | null>) | null;
    onSentinelKillSession: ((sessionName: string) => boolean) | null;
    onSentinelPauseSession: ((sessionName: string) => void) | null;
    onAttentionStatusChange: ((itemId: string, status: string) => Promise<void>) | null;
    onSwitchAccountRequest: ((target: string, replyTopicId: number) => Promise<void>) | null;
    onQuotaStatusRequest: ((replyTopicId: number) => Promise<void>) | null;
    onLoginRequest: ((email: string | null, replyTopicId: number) => Promise<void>) | null;
    onClassifySessionDeath: ((sessionName: string) => Promise<{
        cause: string;
        detail: string;
    } | null>) | null;
    /** LLM-powered stall triage — called instead of generic stall alert when set */
    onStallDetected: ((topicId: number, sessionName: string, messageText: string, injectedAt: number) => Promise<{
        resolved: boolean;
    }>) | null;
    /** Get triage status for a topic — returns null if no active triage, or status summary */
    onGetTriageStatus: ((topicId: number) => {
        active: boolean;
        classification?: string;
        checkCount: number;
        lastCheck?: string;
    } | null) | null;
    onGetRegistrationPolicy: (() => {
        policy: string;
        contactHint?: string;
        agentName?: string;
    }) | null;
    onNotifyAdminJoinRequest: ((request: {
        name: string;
        username?: string;
        telegramUserId: number;
    }) => Promise<void>) | null;
    onValidateInviteCode: ((code: string, telegramUserId: number) => Promise<{
        valid: boolean;
        error?: string;
    }>) | null;
    onStartMiniOnboarding: ((telegramUserId: number, firstName: string, username?: string) => Promise<void>) | null;
    private unknownUserRateLimit;
    private static readonly UNKNOWN_USER_COOLDOWN_MS;
    private batcher;
    intelligence: IntelligenceProvider | null;
    onFlushNotifications: ((replyTopicId: number) => Promise<void>) | null;
    private callbackRegistry;
    private pendingPromptReply;
    private promptGateDisclosureSent;
    /** Callback to inject a response into a tmux session. Wired by server.ts. */
    onPromptResponse: ((sessionName: string, key: string) => boolean) | null;
    /** Callback to inject text input into a tmux session. Wired by server.ts. */
    onPromptTextResponse: ((sessionName: string, text: string) => boolean) | null;
    /** Callback when relay lease should extend idle timeout for a session */
    onRelayLeaseStart: ((sessionName: string) => void) | null;
    /** Callback when relay lease is released (response received or timeout) */
    onRelayLeaseEnd: ((sessionName: string) => void) | null;
    private sharedLogger;
    private sharedRegistry;
    private sharedStallDetector;
    private sharedCommandRouter;
    private sharedAuthGate;
    private eventBus;
    /** Get the event bus for external subscribers (Phase 1e). Returns null if flag is off. */
    getEventBus(): MessagingEventBus | null;
    constructor(config: TelegramConfig, stateDir: string);
    /**
     * Register all Telegram commands with the shared CommandRouter (Phase 1a).
     * Each command delegates back to the existing handler logic.
     */
    private registerSharedCommands;
    start(): Promise<void>;
    stop(): Promise<void>;
    send(message: OutgoingMessage): Promise<SendResult>;
    /**
     * Log an inbound user message that arrived via an external path (e.g. Lifeline
     * forwarding through /internal/telegram-forward). This ensures the message
     * appears in both JSONL and TopicMemory even when the normal polling handler
     * didn't receive it.
     */
    logInboundMessage(entry: {
        messageId: number;
        topicId: number;
        text: string;
        timestamp: string;
        senderName?: string;
        senderUsername?: string;
        telegramUserId?: number;
    }): void;
    /**
     * Send a message to a specific forum topic.
     * Returns the Telegram message ID for delivery confirmation.
     */
    sendToTopic(topicId: number, text: string, options?: {
        silent?: boolean;
        skipStallClear?: boolean;
    }): Promise<SendResult>;
    /**
     * Send a notification through the batcher, falling back to direct send.
     * Use this for internal system notifications that should be batched.
     */
    notifyTopic(topicId: number, text: string, tier: NotificationTier, category: string): Promise<void>;
    /**
     * Configure the notification batcher. Call before start() to enable batching.
     * The batcher's send function is wired to sendToTopic automatically.
     */
    configureBatcher(config?: {
        summaryIntervalMinutes?: number;
        digestIntervalMinutes?: number;
        quietHours?: {
            enabled: boolean;
            start: string;
            end: string;
        };
    }): NotificationBatcher;
    /**
     * Get the notification batcher (if configured).
     */
    getBatcher(): NotificationBatcher | null;
    /**
     * Create a forum topic in the supergroup.
     */
    createForumTopic(name: string, iconColor?: number): Promise<{
        topicId: number;
        name: string;
    }>;
    /**
     * Edit a forum topic's name and/or icon color.
     * Best-effort — silently ignores failures (topic may not exist).
     */
    editForumTopic(topicId: number, name?: string, iconColor?: number): Promise<boolean>;
    /**
     * Find an existing topic by name, or create a new one if none exists.
     * Prevents duplicate topics when sessions respawn or the server restarts.
     */
    findOrCreateForumTopic(name: string, iconColor?: number): Promise<{
        topicId: number;
        name: string;
        reused: boolean;
    }>;
    /**
     * Get the Lifeline topic ID (if configured).
     */
    getLifelineTopicId(): number | undefined;
    /**
     * Ensure the Lifeline topic exists. If it was deleted, recreate it.
     * Called on startup and can be called periodically.
     */
    ensureLifelineTopic(): Promise<number | null>;
    /**
     * Persist the Lifeline topic ID back to config.json so it survives restarts.
     */
    private persistLifelineTopicId;
    /**
     * Get the Dashboard topic ID (if configured).
     */
    getDashboardTopicId(): number | undefined;
    /**
     * Whether the chat supports forum topics. False if we detected
     * "the chat is not a forum" from the Telegram API.
     */
    get isForumChat(): boolean;
    /**
     * Ensure the Dashboard topic exists. Creates it on first run, verifies on restart.
     * Same resilience pattern as the lifeline topic.
     */
    ensureDashboardTopic(): Promise<number | null>;
    /**
     * Broadcast the dashboard URL to the Dashboard topic.
     *
     * Edit-in-place pattern: instead of posting a new message each restart (which
     * creates unread badges), we edit the existing pinned message. This means the
     * Dashboard topic never shows as "unread" — it's a quiet reference the user
     * checks when they need the link.
     *
     * Fallback: if the pinned message was deleted or doesn't exist yet, we send
     * a new one, pin it, and save its ID for future edits.
     */
    broadcastDashboardUrl(url: string, tunnelType: 'quick' | 'named'): Promise<void>;
    private formatDashboardMessage;
    private loadDashboardMessageId;
    private saveDashboardMessageId;
    /**
     * Persist the Dashboard topic ID back to config.json.
     */
    private persistDashboardTopicId;
    /**
     * Close a forum topic.
     */
    closeForumTopic(topicId: number): Promise<boolean>;
    onMessage(handler: (message: Message) => Promise<void>): void;
    resolveUser(channelIdentifier: string): Promise<string | null>;
    /**
     * Check if a message is from an authorized user.
     * If no authorizedUserIds configured, all messages are accepted.
     */
    private isAuthorized;
    /**
     * Handle a message from an unknown/unauthorized Telegram user.
     * Checks the registration policy and responds appropriately:
     * - admin-only: Gated message + notify admin
     * - invite-only: Ask for invite code
     * - open: Start mini-onboarding (rate limited)
     *
     * Rate-limited to prevent spam from the same unknown user.
     */
    private handleUnknownUser;
    registerTopicSession(topicId: number, sessionName: string, topicName?: string): void;
    unregisterTopic(topicId: number): void;
    getSessionForTopic(topicId: number): string | null;
    /**
     * Get all active topic→session mappings.
     * Used by TopicResumeMap heartbeat to proactively persist UUIDs.
     */
    getAllTopicSessions(): Map<number, string>;
    getTopicForSession(sessionName: string): number | null;
    getTopicName(topicId: number): string | null;
    /**
     * Set the purpose for a topic (e.g., "billing", "technical").
     * Purpose is used for outbound content validation.
     */
    setTopicPurpose(topicId: number, purpose: string): void;
    /**
     * Get the purpose for a topic. Checks runtime map first, then config.
     * Returns null if no purpose is set (permissive — all content allowed).
     */
    getTopicPurpose(topicId: number): string | null;
    /**
     * Get all topic purposes (runtime + config merged).
     */
    getAllTopicPurposes(): Record<number, string>;
    /**
     * Validate outbound content against topic purpose.
     * Returns the validation result. Callers decide how to handle rejection.
     */
    validateOutboundContent(topicId: number, text: string, options?: {
        bypass?: boolean;
    }): {
        allowed: boolean;
        reason: string | null;
        detectedCategory: string | null;
        topicPurpose: string | null;
        suggestion: string | null;
    };
    /**
     * Classify content using the configured categories.
     * Useful for debugging and API endpoints.
     */
    classifyContent(text: string): {
        category: string | null;
        confidence: string;
        matchedKeywords: string[];
    };
    /**
     * Get all topic-session mappings (for admin/debug UIs).
     */
    getAllTopicMappings(): Array<{
        topicId: number;
        sessionName: string;
        topicName: string | null;
    }>;
    /**
     * Track that a message was injected into a session.
     * Used by stall detection to alert if no response comes back.
     */
    trackMessageInjection(topicId: number, sessionName: string, messageText: string): void;
    private clearStallForTopic;
    /**
     * Public interface for external callers (e.g., StallTriageNurse) to clear
     * stall tracking for a topic after successful recovery.
     */
    clearStallTracking(topicId: number): void;
    /** Clear promise tracking for a topic (e.g., after successful recovery) */
    clearPromiseTracking(topicId: number): void;
    /** Detect "work-in-progress" messages that imply the agent will follow up */
    private isPromiseMessage;
    /** Detect messages that indicate the agent delivered on its promise */
    private isFollowThroughMessage;
    /**
     * LLM gate for fallback stall/promise alerts.
     *
     * Before sending a user-facing alert about a stall or expired promise,
     * check with the intelligence provider whether the alert is warranted.
     * This prevents false positives when the StallTriageNurse is unavailable.
     *
     * Returns true if the alert should be sent, false to suppress.
     * If no intelligence provider is available, returns true (fail-open for safety).
     */
    private confirmStallAlert;
    /** Get all active topic-session mappings (used by SessionMonitor) */
    getActiveTopicSessions(): Map<number, string>;
    /** Get recent message log entries for analysis */
    getMessageLog(limit?: number): Array<{
        topicId: number;
        text: string;
        fromUser: boolean;
        timestamp: string;
    }>;
    private checkForStalls;
    /**
     * Handle stall events from the shared StallDetector (Phase 1c).
     * Bridges shared events back to Telegram-specific alert logic
     * (triage nurse, quota classification, LLM gate, user notifications).
     */
    private handleSharedStallEvent;
    getStatus(): {
        started: boolean;
        uptime: number | null;
        pendingStalls: number;
        pendingPromises: number;
        topicMappings: number;
    };
    /**
     * Download a file from Telegram by file_id.
     */
    private downloadFile;
    /**
     * Resolve voice transcription provider from config or environment.
     * Checks explicit config, then env vars, then auto-detects.
     */
    private resolveTranscriptionProvider;
    /**
     * Transcribe a voice message using the configured provider.
     */
    private transcribeVoice;
    /**
     * Download a photo from Telegram and save it locally.
     * Returns the local file path.
     */
    private downloadPhoto;
    /**
     * Download a document from Telegram and save it locally.
     * Preserves the original filename when available.
     * Returns the local file path.
     */
    private downloadDocument;
    /**
     * Process Telegram commands. Returns true if the message was a command.
     */
    private handleCommand;
    /**
     * Search the message log with flexible filters.
     * Supports text query, topicId filter, date range, and pagination.
     */
    searchLog(opts?: {
        query?: string;
        topicId?: number;
        since?: Date;
        limit?: number;
    }): LogEntry[];
    /**
     * Get message log statistics.
     */
    getLogStats(): {
        totalMessages: number;
        logSizeBytes: number;
        logPath: string;
    };
    /**
     * Get recent messages for a topic (for thread history on respawn).
     */
    getTopicHistory(topicId: number, limit?: number): LogEntry[];
    private appendToLog;
    /** Keep only the last 75,000 lines when log exceeds 100,000 lines.
     *  High limits because message history is core agent memory.
     *  At ~200 bytes/line average, 100k lines ~ 20MB — fine for a dedicated machine. */
    private maybeRotateLog;
    /**
     * Create an attention item and its Telegram topic.
     */
    createAttentionItem(item: Omit<AttentionItem, 'createdAt' | 'updatedAt' | 'status' | 'topicId'>): Promise<AttentionItem>;
    /**
     * Update attention item status. Called by /ack, /done, /wontdo, /reopen commands.
     */
    updateAttentionStatus(itemId: string, status: AttentionItem['status']): Promise<boolean>;
    /**
     * Get all attention items, optionally filtered by status.
     */
    getAttentionItems(status?: string): AttentionItem[];
    /**
     * Get a specific attention item.
     */
    getAttentionItem(itemId: string): AttentionItem | undefined;
    /**
     * Check if a topic is an attention topic.
     */
    isAttentionTopic(topicId: number): boolean;
    /**
     * Handle commands in attention topics (/ack, /done, /wontdo, /reopen).
     * Returns true if handled, false if not an attention command.
     */
    handleAttentionCommand(topicId: number, text: string): Promise<boolean>;
    private loadAttentionItems;
    private saveAttentionItems;
    private escapeHtml;
    private loadRegistry;
    private saveRegistry;
    private loadOffset;
    private saveOffset;
    private poll;
    /**
     * Process a single Telegram update (text, voice, photo, or callback query).
     */
    private processUpdate;
    /**
     * Handle an incoming voice message: download, transcribe, route as text.
     */
    private handleVoiceMessage;
    /**
     * Handle an incoming photo message: download, save, route with path.
     */
    private handlePhotoMessage;
    /**
     * Handle an incoming document message: download, save, route with path.
     */
    private handleDocumentMessage;
    /**
     * Relay a detected prompt to a Telegram topic with inline keyboard buttons.
     * For prompts with options: sends buttons. For questions: sends text asking for reply.
     * Returns the Telegram message ID of the relay message.
     */
    relayPrompt(topicId: number, prompt: DetectedPrompt): Promise<number>;
    /**
     * Format a detected prompt into Telegram-friendly text.
     * Differentiates by prompt type and escapes Markdown special chars.
     */
    private formatPromptMessage;
    /**
     * Escape Markdown special characters for Telegram.
     */
    private escapeMarkdown;
    /**
     * Handle a forwarded callback query from the Lifeline process.
     * In send-only mode the server doesn't poll for callbacks, so the
     * Lifeline forwards them via /internal/telegram-callback.
     */
    handleForwardedCallback(query: any): Promise<void>;
    /**
     * Handle a Telegram callback query from an inline keyboard button press.
     */
    private processCallbackQuery;
    /**
     * Handle a text reply to a Prompt Gate relay message (for text-input prompts).
     * Returns true if the message was intercepted, false to fall through to normal routing.
     */
    private handlePendingPromptReply;
    /**
     * Edit a Telegram message with retry on failure.
     * Uses exponential backoff (1s, 2s, 4s) for up to 3 attempts.
     */
    private editMessageWithRetry;
    /**
     * Clean up Prompt Gate state for a session (call when session ends).
     */
    cleanupPromptGate(sessionName: string): void;
    /**
     * Proactively prune expired relay prompts and send timeout messages.
     * Call periodically (e.g. every 60s) to handle cases where no new message
     * arrives to trigger the expiry check in handlePendingPromptReply.
     */
    pruneExpiredRelays(): Promise<void>;
    /**
     * Stop the callback registry (call on adapter shutdown).
     */
    stopPromptGate(): void;
    private getUpdates;
    private apiCall;
}
export {};
//# sourceMappingURL=TelegramAdapter.d.ts.map