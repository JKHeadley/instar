/**
 * CrossPlatformAlerts — Bridges messaging adapters for disconnect alerts
 * and cross-platform attention routing.
 *
 * When WhatsApp disconnects, alerts on Telegram (and vice versa).
 * Surfaces attention items on WhatsApp with interactive buttons.
 */
import type { TelegramAdapter } from '../TelegramAdapter.js';
import type { WhatsAppAdapter } from '../WhatsAppAdapter.js';
import type { BusinessApiBackend } from '../backends/BusinessApiBackend.js';
export interface CrossPlatformAlertsConfig {
    telegram?: TelegramAdapter;
    whatsapp?: WhatsAppAdapter;
    /** BusinessApiBackend instance (only when using business-api backend) */
    businessApiBackend?: BusinessApiBackend;
    /** State manager for reading alert topic IDs */
    getAlertTopicId?: () => number | null;
    /** Owner's WhatsApp JID for attention items */
    ownerWhatsAppJid?: string;
}
export interface AttentionItem {
    id: string;
    title: string;
    body: string;
    actions: Array<{
        id: string;
        title: string;
    }>;
    priority: 'low' | 'medium' | 'high';
    source: string;
}
export declare class CrossPlatformAlerts {
    private config;
    private unsubscribers;
    private started;
    private alertHistory;
    private static readonly MAX_HISTORY;
    constructor(config: CrossPlatformAlertsConfig);
    /** Wire up event listeners across adapters. */
    start(): void;
    /** Stop and clean up all listeners. */
    stop(): void;
    /** Send an alert message on Telegram (used when WhatsApp has issues). */
    alertOnTelegram(message: string): Promise<void>;
    /** Send an alert message on WhatsApp (used when Telegram has issues). */
    alertOnWhatsApp(message: string): Promise<void>;
    /**
     * Send an attention item on WhatsApp with interactive buttons.
     * Falls back to plain text if BusinessApiBackend is not available.
     */
    sendAttentionItem(item: AttentionItem): Promise<void>;
    /** Get recent alert history. */
    getAlertHistory(): Array<{
        timestamp: string;
        platform: string;
        message: string;
    }>;
    /** Check if the module is started and has any adapters configured. */
    getStatus(): {
        started: boolean;
        telegramAvailable: boolean;
        whatsappAvailable: boolean;
        alertsSent: number;
    };
    private recordAlert;
}
//# sourceMappingURL=CrossPlatformAlerts.d.ts.map