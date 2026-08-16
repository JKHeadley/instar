/**
 * BusinessApiBackend — Meta WhatsApp Business Cloud API connection manager.
 *
 * Handles:
 * - REST API communication with Meta's Cloud API
 * - Webhook verification (GET) and message reception (POST)
 * - Template message sending for proactive notifications
 * - Interactive button messages for attention items
 * - Media download from Meta's CDN
 *
 * Unlike BaileysBackend (persistent WebSocket), BusinessApiBackend is stateless —
 * messages arrive via webhooks and are sent via REST. No persistent connection needed.
 *
 * Meta Cloud API docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
import type { WhatsAppAdapter, BusinessApiConfig } from '../WhatsAppAdapter.js';
export interface WebhookMessage {
    from: string;
    id: string;
    timestamp: string;
    type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'interactive' | 'button';
    text?: {
        body: string;
    };
    interactive?: {
        type: 'button_reply' | 'list_reply';
        button_reply?: {
            id: string;
            title: string;
        };
        list_reply?: {
            id: string;
            title: string;
            description?: string;
        };
    };
    image?: {
        id: string;
        mime_type: string;
        caption?: string;
    };
    audio?: {
        id: string;
        mime_type: string;
    };
}
export interface WebhookPayload {
    object: string;
    entry: Array<{
        id: string;
        changes: Array<{
            value: {
                messaging_product: string;
                metadata: {
                    display_phone_number: string;
                    phone_number_id: string;
                };
                contacts?: Array<{
                    profile: {
                        name: string;
                    };
                    wa_id: string;
                }>;
                messages?: WebhookMessage[];
                statuses?: Array<{
                    id: string;
                    status: string;
                    timestamp: string;
                }>;
            };
            field: string;
        }>;
    }>;
}
export interface TemplateMessage {
    /** Template name (must be pre-approved by Meta) */
    name: string;
    /** Language code (e.g., 'en_US') */
    language: string;
    /** Template components (header, body, buttons) */
    components?: TemplateComponent[];
}
export interface TemplateComponent {
    type: 'header' | 'body' | 'button';
    parameters?: Array<{
        type: 'text' | 'image' | 'document';
        text?: string;
        image?: {
            link: string;
        };
    }>;
    sub_type?: 'quick_reply' | 'url';
    index?: number;
}
export interface InteractiveButton {
    type: 'reply';
    reply: {
        id: string;
        title: string;
    };
}
export interface InteractiveMessage {
    type: 'button';
    header?: {
        type: 'text';
        text: string;
    };
    body: {
        text: string;
    };
    footer?: {
        text: string;
    };
    action: {
        buttons: InteractiveButton[];
    };
}
export interface BusinessApiBackendStatus {
    connected: boolean;
    phoneNumberId: string;
    webhookConfigured: boolean;
    lastWebhookReceived: string | null;
    messagesSent: number;
    messagesReceived: number;
}
export interface BusinessApiEventHandlers {
    onConnected: (phoneNumber: string) => void;
    onMessage: (jid: string, messageId: string, text: string, senderName?: string, timestamp?: number) => void;
    onButtonReply: (jid: string, messageId: string, buttonId: string, buttonTitle: string) => void;
    onError: (error: Error) => void;
    onStatusUpdate: (messageId: string, status: string) => void;
}
export declare class BusinessApiBackend {
    private config;
    private handlers;
    private adapter;
    private connected;
    private lastWebhookReceived;
    private messagesSent;
    private messagesReceived;
    constructor(adapter: WhatsAppAdapter, config: BusinessApiConfig, handlers: BusinessApiEventHandlers);
    /**
     * "Connect" — for Business API this means verifying the access token works.
     * Unlike Baileys, there's no persistent connection.
     */
    connect(): Promise<void>;
    /** Disconnect (no-op for stateless API, but updates state). */
    disconnect(): Promise<void>;
    /**
     * Handle webhook verification (GET request from Meta).
     * Returns the challenge string if the verify token matches.
     */
    verifyWebhook(mode: string, token: string, challenge: string): string | null;
    /**
     * Handle incoming webhook payload (POST request from Meta).
     * Processes messages and status updates.
     */
    handleWebhook(payload: WebhookPayload): Promise<void>;
    /** Send a plain text message. */
    sendTextMessage(to: string, text: string): Promise<string | null>;
    /** Send a template message (for proactive notifications). */
    sendTemplateMessage(to: string, template: TemplateMessage): Promise<string | null>;
    /** Send an interactive button message. */
    sendInteractiveMessage(to: string, message: InteractiveMessage): Promise<string | null>;
    /** Mark a message as read (blue ticks). */
    markMessageRead(messageId: string): Promise<void>;
    /** React to a message with an emoji. */
    sendReaction(to: string, messageId: string, emoji: string): Promise<void>;
    getStatus(): BusinessApiBackendStatus;
    /** Check if the backend is connected (token is valid). */
    isConnected(): boolean;
}
//# sourceMappingURL=BusinessApiBackend.d.ts.map