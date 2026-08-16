/**
 * MessageBridge — cross-platform message forwarding between adapters.
 *
 * When a user has linked identities across WhatsApp and Telegram, messages
 * sent on one platform are echoed on the other with a platform prefix.
 *
 * Design:
 * - Subscribes to message:logged events on both adapters' event buses
 * - Checks if the channel has a cross-platform link in the bridge registry
 * - Forwards with prefix: "[via WhatsApp]" or "[via Telegram]"
 * - Loop detection: bridged messages are tagged and not re-bridged
 *
 * Phase 4 feature — works alongside CrossPlatformAlerts (alerts vs messages).
 */
import type { MessagingEventBus } from './MessagingEventBus.js';
export interface BridgeLink {
    whatsappChannelId: string;
    telegramTopicId: number;
    createdAt: string;
    createdBy: string;
}
export interface MessageBridgeConfig {
    /** Path to the bridge registry file */
    registryPath: string;
    /** Function to send a message to a Telegram topic */
    sendToTelegram?: (topicId: number, text: string) => Promise<void>;
    /** Function to send a message to a WhatsApp JID */
    sendToWhatsApp?: (jid: string, text: string) => Promise<void>;
    /** WhatsApp event bus */
    whatsappEventBus?: MessagingEventBus;
    /** Telegram event bus */
    telegramEventBus?: MessagingEventBus;
}
export interface MessageBridgeStatus {
    started: boolean;
    linkCount: number;
    messagesBridged: number;
    lastBridgedAt: string | null;
}
export declare class MessageBridge {
    private config;
    private links;
    private unsubscribers;
    private started;
    private messagesBridged;
    private lastBridgedAt;
    constructor(config: MessageBridgeConfig);
    /** Start listening to event buses and forwarding messages. */
    start(): void;
    /** Stop listening and cleanup. */
    stop(): void;
    /** Create a bridge link between a WhatsApp JID and a Telegram topic. */
    addLink(whatsappChannelId: string, telegramTopicId: number, createdBy: string): void;
    /** Remove a bridge link by WhatsApp channel ID. */
    removeLinkByWhatsApp(whatsappChannelId: string): boolean;
    /** Remove a bridge link by Telegram topic ID. */
    removeLinkByTelegram(telegramTopicId: number): boolean;
    /** Get the Telegram topic linked to a WhatsApp JID. */
    getTelegramForWhatsApp(whatsappChannelId: string): number | null;
    /** Get the WhatsApp JID linked to a Telegram topic. */
    getWhatsAppForTelegram(telegramTopicId: number): string | null;
    /** Get all active bridge links. */
    getLinks(): BridgeLink[];
    private handleWhatsAppMessage;
    private handleTelegramMessage;
    getStatus(): MessageBridgeStatus;
    private loadRegistry;
    private saveRegistry;
}
//# sourceMappingURL=MessageBridge.d.ts.map