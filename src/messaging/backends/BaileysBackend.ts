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
 *
 * Baileys is an optional dependency — only imported when WhatsApp is configured.
 * Prefers v7 (`baileys` package) over deprecated v6 (`@whiskeysockets/baileys`).
 * This module provides a clean interface for the WhatsAppAdapter to consume
 * without knowing Baileys internals.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WhatsAppAdapter, BaileysConfig, ConnectionState, BackendCapabilities } from '../WhatsAppAdapter.js';

// ── Reconnection constants ──────────────────────────────

const BASE_DELAYS = [2000, 5000, 10000, 30000, 60000]; // ms

function getReconnectDelay(attempt: number): number {
  const base = BASE_DELAYS[Math.min(attempt, BASE_DELAYS.length - 1)];
  const jitter = Math.random() * base * 0.3; // 30% jitter prevents thundering herd
  return Math.round(base + jitter);
}

// ── Event types (for testing without Baileys) ──────────────────

export interface BaileysEventHandlers {
  onQrCode: (qr: string) => void;
  onPairingCode: (code: string) => void;
  onConnected: (phoneNumber: string) => void;
  onDisconnected: (reason: string, shouldReconnect: boolean) => void;
  onMessage: (jid: string, messageId: string, text: string, senderName?: string, timestamp?: number, msgKey?: unknown) => void;
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

// ── Backend implementation ──────────────────────────────

export class BaileysBackend {
  private config: Required<BaileysConfig>;
  private handlers: BaileysEventHandlers;
  private adapter: WhatsAppAdapter;

  private connected = false;
  private phoneNumber: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socket: any = null; // Baileys WASocket
  private _pairingCodeRequested = false;

  // Outbound message ID tracking — used to distinguish bot-sent messages
  // from user-sent self-chat messages (both have fromMe=true).
  private sentMessageIds = new Set<string>();
  private static readonly SENT_IDS_MAX_SIZE = 5000;

  constructor(
    adapter: WhatsAppAdapter,
    config: Required<BaileysConfig>,
    handlers: BaileysEventHandlers,
  ) {
    this.adapter = adapter;
    this.config = config;
    this.handlers = handlers;

    // Ensure auth directory exists
    fs.mkdirSync(this.config.authDir, { recursive: true });
  }

  /** Start the Baileys connection. */
  async connect(): Promise<void> {
    try {
      // Dynamic import — Baileys is an optional dependency
      // Try v7 (baileys) first (preferred), then v6 (@whiskeysockets/baileys, deprecated)
      let baileys = await import('baileys').catch(() => null) as any;
      if (!baileys) {
        // @ts-expect-error — try deprecated v6 package name
        baileys = await import('@whiskeysockets/baileys').catch(() => null);
      }
      if (!baileys) {
        throw new Error(
          'Baileys is not installed. Run: npm install baileys\n' +
          'Baileys is required for WhatsApp Web support.',
        );
      }
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);

      // Resolve WhatsApp Web protocol version:
      // 1. User-specified version in config (highest priority)
      // 2. Dynamically fetched from WhatsApp servers (prevents 405 from stale versions)
      // 3. Baileys built-in default (fallback)
      let version: [number, number, number] | undefined = this.config.version || undefined;
      if (!version && fetchLatestWaWebVersion) {
        try {
          const fetched = await fetchLatestWaWebVersion();
          if (fetched?.version) {
            version = fetched.version as [number, number, number];
            console.log(`[baileys] Using fetched WA Web version: ${version.join('.')}`);
          }
        } catch (versionErr) {
          console.log(`[baileys] Could not fetch latest WA version, using Baileys default: ${versionErr instanceof Error ? versionErr.message : versionErr}`);
        }
      }

      // Browser identifier determines the platform sent to WhatsApp servers.
      // Default: ['Mac OS', 'Chrome', '14.4.1'] which maps to Platform.MACOS.
      // Platform.WEB (the old default in some Baileys versions) causes 405 errors.
      const browser: [string, string, string] = this.config.browser || ['Mac OS', 'Chrome', '14.4.1'];

      // Note: printQRInTerminal is deprecated in v7. QR codes are captured
      // via the connection.update event handler below.
      this.socket = makeWASocket({
        auth: state,
        markOnlineOnConnect: this.config.markOnline,
        ...(version ? { version } : {}),
        browser,
      });

      // Auth state persistence
      this.socket.ev.on('creds.update', saveCreds);

      // Connection events
      this.socket.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (this.config.authMethod === 'qr') {
            this.adapter.setConnectionState('qr-pending');
            this.adapter.setQrCode(qr);
            this.handlers.onQrCode(qr);
          }

          // Pairing code auth: request on first QR event.
          // The QR event indicates the socket is connected to WhatsApp servers
          // and ready for auth. requestPairingCode() is an alternative to QR scanning.
          // This CANNOT be in the connection === 'open' block because 'open' only
          // fires AFTER auth completes — chicken-and-egg problem.
          if (this.config.authMethod === 'pairing-code' && this.config.pairingPhoneNumber && !this._pairingCodeRequested) {
            this._pairingCodeRequested = true;
            try {
              const code = await this.socket.requestPairingCode(this.config.pairingPhoneNumber);
              console.log('[whatsapp] Pairing code:', code);
              this.handlers.onPairingCode(code);
            } catch (pairErr) {
              console.error('[baileys] Failed to request pairing code:', pairErr);
              this._pairingCodeRequested = false; // Allow retry on next QR event
              this.handlers.onError(new Error(
                `Failed to request pairing code: ${pairErr instanceof Error ? pairErr.message : pairErr}`,
              ));
            }
          }
        }

        if (connection === 'open') {
          this.connected = true;
          this.reconnectAttempts = 0;
          this._pairingCodeRequested = false; // Reset for future reconnections
          const me = this.socket?.user;
          this.phoneNumber = me?.id?.split(':')[0] ?? null;
          this.adapter.setConnectionState('connected', this.phoneNumber ?? undefined);

          // Inject full backend capabilities (Phase 4)
          const sock = this.socket;
          const capabilities: BackendCapabilities = {
            sendText: async (jid, text) => {
              const sent = await sock?.sendMessage(jid, { text });
              // Track outbound message ID to prevent feedback loops.
              // When we receive this message back (fromMe=true, type=append),
              // we'll skip it instead of processing it as a user command.
              if (sent?.key?.id) {
                this.sentMessageIds.add(sent.key.id);
                if (this.sentMessageIds.size > BaileysBackend.SENT_IDS_MAX_SIZE) {
                  const excess = this.sentMessageIds.size - BaileysBackend.SENT_IDS_MAX_SIZE;
                  let count = 0;
                  for (const id of this.sentMessageIds) {
                    if (count >= excess) break;
                    this.sentMessageIds.delete(id);
                    count++;
                  }
                }
              }
            },
            sendTyping: async (jid) => {
              await sock?.sendPresenceUpdate('composing', jid);
            },
            stopTyping: async (jid) => {
              await sock?.sendPresenceUpdate('available', jid);
            },
            sendReadReceipt: async (jid, _messageId, msgKey) => {
              if (msgKey) {
                await sock?.readMessages([msgKey]);
              }
            },
            sendReaction: async (jid, _messageId, emoji, msgKey) => {
              if (msgKey) {
                await sock?.sendMessage(jid, { react: { text: emoji, key: msgKey } });
              }
            },
          };
          this.adapter.setBackendCapabilities(capabilities);
          this.handlers.onConnected(this.phoneNumber ?? 'unknown');
        }

        if (connection === 'close') {
          this.connected = false;

          // Extract status code — Baileys v6 uses Boom errors with .output.statusCode,
          // v7 may use plain Error objects. Check both patterns.
          const err = lastDisconnect?.error as any;
          const statusCode = err?.output?.statusCode  // Boom error (v6)
            ?? err?.statusCode                         // Plain error with statusCode
            ?? err?.data?.reason;                      // v7 data.reason field
          const errorMessage = err?.message ?? '';
          const loggedOut = statusCode === DisconnectReason?.loggedOut
            || statusCode === 401;

          // Detect terminal failures that should NOT trigger reconnect
          const isTerminalFailure = loggedOut
            || statusCode === 405
            || statusCode === 403
            || errorMessage.includes('405')
            || errorMessage.includes('Connection Failure');

          if (loggedOut) {
            // Check if this is a stale credential from incomplete pairing.
            // When a pairing code is generated but never completed, Baileys saves
            // partial creds. On restart, it tries to login with them → 401.
            // If creds are < 5 minutes old, auto-clear and retry instead of giving up.
            const credsPath = path.join(this.config.authDir, 'creds.json');
            let isStaleIncomplete = false;
            try {
              const stat = fs.statSync(credsPath);
              const ageMs = Date.now() - stat.mtimeMs;
              isStaleIncomplete = ageMs < 5 * 60 * 1000; // < 5 minutes old
            } catch { /* @silent-fallback-ok — no creds file = not stale */ }

            if (isStaleIncomplete) {
              console.log('[baileys] 401 with recent credentials — likely incomplete pairing. Clearing auth state and retrying.');
              try {
                fs.rmSync(this.config.authDir, { recursive: true, force: true });
                fs.mkdirSync(this.config.authDir, { recursive: true });
              } catch (clearErr) {
                console.error('[baileys] Failed to clear auth state:', clearErr);
              }
              this._pairingCodeRequested = false;
              this.scheduleReconnect();
            } else {
              // Session expired — need new QR scan
              this.adapter.setConnectionState('disconnected');
              this.handlers.onDisconnected('logged-out', false);
              console.log('[baileys] Session expired. Delete auth state and restart to re-authenticate.');
            }
          } else if (isTerminalFailure) {
            // Registration/connection failure — likely Baileys version incompatibility or protocol change
            const reason = statusCode === 405 || errorMessage.includes('405')
              ? 'HTTP 405 (Method Not Allowed)'
              : `Connection Failure (${statusCode ?? errorMessage})`;
            const errorMsg = `WhatsApp connection failed: ${reason}. Baileys version may be outdated. Try: npm install baileys@latest`;
            console.error(`[baileys] ${errorMsg}`);
            this.adapter.setConnectionState('disconnected');
            this.adapter.setLastError(errorMsg);
            this.handlers.onError(new Error(errorMsg));
            // Don't reconnect — terminal failures won't resolve by retrying
          } else {
            // Transient failure — attempt reconnection
            this.scheduleReconnect();
          }
        }
      });

      // Message events
      // Accept both 'notify' (real-time incoming) and 'append' (outbound echoes, self-chat).
      // History sync messages are filtered by other types we don't accept.
      this.socket.ev.on('messages.upsert', (m: any) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages) {
          if (!msg.message) continue;

          // Filter outbound echoes by checking if we sent this message.
          // Self-chat messages from the user's phone also have fromMe=true,
          // but their IDs won't be in our sentMessageIds set.
          if (msg.key.fromMe && this.sentMessageIds.has(msg.key.id)) continue;

          const jid = msg.key.remoteJid;
          if (!jid) continue;

          // Extract text from various message types
          const text =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            msg.message.imageMessage?.caption ??
            msg.message.videoMessage?.caption ??
            null;

          if (!text) continue; // Skip non-text messages for now

          const senderName = msg.pushName ?? undefined;
          const timestamp = msg.messageTimestamp;

          this.handlers.onMessage(
            jid,
            msg.key.id ?? `${Date.now()}`,
            text,
            senderName,
            typeof timestamp === 'number' ? timestamp : undefined,
            msg.key,
          );
        }
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handlers.onError(error);
      this.adapter.setConnectionState('disconnected');
    }
  }

  /** Disconnect and cleanup. */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.connected = false;
    this.adapter.setConnectionState('closed');
  }

  /** Schedule a reconnection attempt with exponential backoff + jitter. */
  private scheduleReconnect(): void {
    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
      console.error(`[baileys] Circuit breaker: ${this.reconnectAttempts} reconnect attempts exhausted.`);
      this.adapter.setConnectionState('disconnected');
      this.handlers.onDisconnected('circuit-breaker', false);
      return;
    }

    const delay = getReconnectDelay(this.reconnectAttempts - 1);
    console.log(`[baileys] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
    this.adapter.setConnectionState('reconnecting');
    this.handlers.onDisconnected(`reconnecting (attempt ${this.reconnectAttempts})`, true);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(err => {
        console.error(`[baileys] Reconnect failed: ${err}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Get current backend status. */
  getStatus(): BaileysBackendStatus {
    return {
      connected: this.connected,
      phoneNumber: this.phoneNumber,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      authDir: this.config.authDir,
      authMethod: this.config.authMethod,
    };
  }
}

// Export the reconnect delay calculator for testing
export { getReconnectDelay };
