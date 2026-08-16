/**
 * BaileysBackend — WhatsApp Web protocol connection manager.
 *
 * Handles:
 * - QR code authentication + persistent session
 * - Pairing code authentication (headless)
 * - WebSocket connection management
 * - Reconnection with exponential backoff + jitter + circuit breaker
 * - Message deduplication on reconnect
 * - Auth state persistence (atomic writes)
 * - Audio/voice message transcription (Groq Whisper or OpenAI Whisper)
 *
 * Baileys is an optional dependency — only imported when WhatsApp is configured.
 * Prefers v7 (`baileys` package) over deprecated v6 (`@whiskeysockets/baileys`).
 * This module provides a clean interface for the WhatsAppAdapter to consume
 * without knowing Baileys internals.
 */
import type { WhatsAppAdapter, BaileysConfig } from '../WhatsAppAdapter.js';
declare function getReconnectDelay(attempt: number): number;
export interface BaileysEventHandlers {
    onQrCode: (qr: string) => void;
    onPairingCode: (code: string) => void;
    onConnected: (phoneNumber: string) => void;
    onDisconnected: (reason: string, shouldReconnect: boolean) => void;
    onMessage: (jid: string, messageId: string, text: string, senderName?: string, timestamp?: number, msgKey?: unknown, participant?: string, mentionedJids?: string[]) => void;
    onError: (error: Error) => void;
}
export interface BaileysBackendStatus {
    connected: boolean;
    phoneNumber: string | null;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    authDir: string;
    authMethod: 'qr' | 'pairing-code';
}
export declare class BaileysBackend {
    private config;
    private handlers;
    private adapter;
    private connected;
    private phoneNumber;
    private reconnectAttempts;
    private reconnectTimer;
    private socket;
    private _pairingCodeRequested;
    private sentMessageIds;
    private static readonly SENT_IDS_MAX_SIZE;
    constructor(adapter: WhatsAppAdapter, config: Required<BaileysConfig>, handlers: BaileysEventHandlers);
    /** Start the Baileys connection. */
    connect(): Promise<void>;
    /** Disconnect and cleanup. */
    disconnect(): Promise<void>;
    /** Schedule a reconnection attempt with exponential backoff + jitter. */
    private scheduleReconnect;
    /**
     * Resolve the voice transcription provider (Groq or OpenAI).
     * Checks explicit voiceProvider config on WhatsAppAdapter, then auto-detects from env.
     */
    private resolveTranscriptionProvider;
    /**
     * Transcribe an audio file using the configured provider.
     */
    private transcribeAudio;
    /**
     * Download and transcribe a WhatsApp audio/voice message.
     * Uses Baileys' downloadContentFromMessage for media retrieval.
     * Falls back to [Audio] placeholder if transcription fails or no provider configured.
     */
    private handleAudioMessage;
    /** Get current backend status. */
    getStatus(): BaileysBackendStatus;
}
export { getReconnectDelay };
//# sourceMappingURL=BaileysBackend.d.ts.map