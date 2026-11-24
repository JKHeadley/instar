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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WhatsAppAdapter, BusinessApiConfig, BackendCapabilities } from '../WhatsAppAdapter.js';

// ── API constants ──────────────────────────────────────

const META_API_BASE = 'https://graph.facebook.com/v21.0';
/** SEC-132: every Graph API call gives up after this long, so a stalled connection fails like any network error instead of hanging. */
const META_API_TIMEOUT_MS = 15_000;

// ── Types ──────────────────────────────────────────────

export interface WebhookMessage {
  from: string; // Phone number (e.g., "14155552671")
  id: string; // Message ID (e.g., "wamid.xxxx")
  timestamp: string; // Unix timestamp string
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'interactive' | 'button';
  text?: { body: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  image?: { id: string; mime_type: string; caption?: string };
  audio?: { id: string; mime_type: string };
}

export interface WebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: WebhookMessage[];
        statuses?: Array<{ id: string; status: string; timestamp: string }>;
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
    image?: { link: string };
  }>;
  sub_type?: 'quick_reply' | 'url';
  index?: number;
}

export interface InteractiveButton {
  type: 'reply';
  reply: { id: string; title: string };
}

export interface InteractiveMessage {
  type: 'button';
  header?: { type: 'text'; text: string };
  body: { text: string };
  footer?: { text: string };
  action: { buttons: InteractiveButton[] };
}

export interface BusinessApiBackendStatus {
  connected: boolean;
  phoneNumberId: string;
  webhookConfigured: boolean;
  /** SEC-086: an app secret is set, so deliveries are verified (unsigned ones refused). */
  webhookSignatureConfigured: boolean;
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
  /**
   * SEC-086 observe mode: a delivery was accepted without proof it came from Meta because no
   * app secret is configured. Fired at most once per process; the caller tells the owner once.
   */
  onUnverifiedDelivery?: () => void;
}

// ── Backend implementation ──────────────────────────────

export class BusinessApiBackend {
  private config: BusinessApiConfig;
  private handlers: BusinessApiEventHandlers;
  private adapter: WhatsAppAdapter;

  private connected = false;
  private lastWebhookReceived: string | null = null;
  private messagesSent = 0;
  private messagesReceived = 0;

  constructor(
    adapter: WhatsAppAdapter,
    config: BusinessApiConfig,
    handlers: BusinessApiEventHandlers,
  ) {
    this.adapter = adapter;
    this.config = config;
    this.handlers = handlers;
  }

  /**
   * "Connect" — for Business API this means verifying the access token works.
   * Unlike Baileys, there's no persistent connection.
   */
  async connect(): Promise<void> {
    try {
      // Verify token by fetching phone number info
      const response = await fetch(
        `${META_API_BASE}/${this.config.phoneNumberId}`,
        {
          signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${this.config.accessToken}` },
        },
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Business API auth failed (${response.status}): ${body}`);
      }

      const data = await response.json() as { display_phone_number?: string };
      this.connected = true;

      const phoneNumber = data.display_phone_number ?? 'unknown';
      await this.adapter.setConnectionState('connected', phoneNumber);

      // Inject full backend capabilities (Phase 4)
      const capabilities: BackendCapabilities = {
        sendText: async (jid, text) => {
          await this.sendTextMessage(jid, text);
        },
        // Typing indicators not supported by Business API
        sendReadReceipt: async (_jid, messageId) => {
          await this.markMessageRead(messageId);
        },
        sendReaction: async (jid, messageId, emoji) => {
          await this.sendReaction(jid, messageId, emoji);
        },
      };
      this.adapter.setBackendCapabilities(capabilities);
      this.handlers.onConnected(phoneNumber);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handlers.onError(error);
      await this.adapter.setConnectionState('disconnected');
    }
  }

  /** Disconnect (no-op for stateless API, but updates state). */
  async disconnect(): Promise<void> {
    this.connected = false;
    await this.adapter.setConnectionState('closed');
  }

  // ── Webhook handling ──────────────────────────────────

  /**
   * Handle webhook verification (GET request from Meta).
   * Returns the challenge string if the verify token matches.
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const expected = this.config.webhookVerifyToken;
    if (mode === 'subscribe' && typeof expected === 'string' && expected.length > 0
      && typeof token === 'string' && safeEqual(token, expected)) {
      return challenge;
    }
    return null;
  }

  /**
   * SEC-086: is this webhook POST really from Meta? Meta signs the exact request
   * body with the app secret (X-Hub-Signature-256: sha256=<hex>). Without a configured
   * secret the answer is 'no-secret': the route keeps delivering (observe mode) and the
   * owner is told once that deliveries are unverified. With a secret, a missing or wrong
   * signature is 'bad-signature' and the delivery is refused.
   */
  verifyPayloadSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): 'ok' | 'no-secret' | 'bad-signature' {
    const secret = this.config.appSecret;
    if (typeof secret !== 'string' || secret.length === 0) return 'no-secret';
    if (!rawBody || typeof signatureHeader !== 'string') return 'bad-signature';
    const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
    if (!m) return 'bad-signature';
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const given = Buffer.from(m[1], 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? 'ok' : 'bad-signature';
  }

  private unverifiedNoted = false;

  /**
   * SEC-086 observe mode (identity umbrella section 10): with no app secret set, deliveries keep
   * arriving, but nothing proves they came from Meta. Tell the owner once, not per message.
   */
  noteUnverifiedDelivery(): void {
    if (this.unverifiedNoted) return;
    this.unverifiedNoted = true;
    try { this.handlers.onUnverifiedDelivery?.(); } catch { /* a notice failure never blocks delivery */ }
  }

  /** Whether an app secret is configured (deliveries can be verified as Meta's). */
  hasAppSecret(): boolean {
    return typeof this.config.appSecret === 'string' && this.config.appSecret.length > 0;
  }

  /**
   * Handle incoming webhook payload (POST request from Meta).
   * Processes messages and status updates.
   */
  async handleWebhook(payload: WebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') return;

    this.lastWebhookReceived = new Date().toISOString();

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const { value } = change;

        // Process messages
        if (value.messages) {
          for (const msg of value.messages) {
            this.messagesReceived++;

            const senderName = value.contacts?.[0]?.profile?.name;
            const jid = `${msg.from}@s.whatsapp.net`;
            const timestamp = parseInt(msg.timestamp, 10);

            if (msg.type === 'text' && msg.text?.body) {
              this.handlers.onMessage(jid, msg.id, msg.text.body, senderName, timestamp);
            } else if (msg.type === 'interactive') {
              const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
              if (reply) {
                this.handlers.onButtonReply(jid, msg.id, reply.id, reply.title);
                // Also forward as a text message for command routing
                this.handlers.onMessage(jid, msg.id, reply.title, senderName, timestamp);
              }
            } else if (msg.type === 'image' && msg.image?.caption) {
              // Forward caption as text (image handling is Phase 4)
              this.handlers.onMessage(jid, msg.id, msg.image.caption, senderName, timestamp);
            }
          }
        }

        // Process status updates
        if (value.statuses) {
          for (const status of value.statuses) {
            this.handlers.onStatusUpdate(status.id, status.status);
          }
        }
      }
    }
  }

  // ── Sending messages ──────────────────────────────────

  /** Send a plain text message. */
  async sendTextMessage(to: string, text: string): Promise<string | null> {
    // Strip @s.whatsapp.net suffix if present
    const phoneNumber = to.replace(/@s\.whatsapp\.net$/, '');

    const response = await fetch(
      `${META_API_BASE}/${this.config.phoneNumberId}/messages`,
      {
        signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'text',
          text: { body: text },
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Business API send failed (${response.status}): ${body}`);
    }

    this.messagesSent++;
    const data = await response.json() as { messages?: Array<{ id: string }> };
    return data.messages?.[0]?.id ?? null;
  }

  /** Send a template message (for proactive notifications). */
  async sendTemplateMessage(to: string, template: TemplateMessage): Promise<string | null> {
    const phoneNumber = to.replace(/@s\.whatsapp\.net$/, '');

    const response = await fetch(
      `${META_API_BASE}/${this.config.phoneNumberId}/messages`,
      {
        signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'template',
          template: {
            name: template.name,
            language: { code: template.language },
            components: template.components,
          },
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Template send failed (${response.status}): ${body}`);
    }

    this.messagesSent++;
    const data = await response.json() as { messages?: Array<{ id: string }> };
    return data.messages?.[0]?.id ?? null;
  }

  /** Send an interactive button message. */
  async sendInteractiveMessage(to: string, message: InteractiveMessage): Promise<string | null> {
    const phoneNumber = to.replace(/@s\.whatsapp\.net$/, '');

    if (message.action.buttons.length > 3) {
      throw new Error('WhatsApp interactive messages support a maximum of 3 buttons');
    }

    const response = await fetch(
      `${META_API_BASE}/${this.config.phoneNumberId}/messages`,
      {
        signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'interactive',
          interactive: message,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Interactive send failed (${response.status}): ${body}`);
    }

    this.messagesSent++;
    const data = await response.json() as { messages?: Array<{ id: string }> };
    return data.messages?.[0]?.id ?? null;
  }

  // ── UX signals (Phase 4) ──────────────────────────────

  /** Mark a message as read (blue ticks). */
  async markMessageRead(messageId: string): Promise<void> {
    await fetch(
      `${META_API_BASE}/${this.config.phoneNumberId}/messages`,
      {
        signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      },
    );
    // Fire-and-forget: don't throw on failure
  }

  /** React to a message with an emoji. */
  async sendReaction(to: string, messageId: string, emoji: string): Promise<void> {
    const phoneNumber = to.replace(/@s\.whatsapp\.net$/, '');

    await fetch(
      `${META_API_BASE}/${this.config.phoneNumberId}/messages`,
      {
        signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'reaction',
          reaction: {
            message_id: messageId,
            emoji,
          },
        }),
      },
    );
    // Fire-and-forget: don't throw on failure
  }

  // ── Status ──────────────────────────────────────────

  getStatus(): BusinessApiBackendStatus {
    return {
      connected: this.connected,
      phoneNumberId: this.config.phoneNumberId,
      webhookConfigured: !!this.config.webhookVerifyToken,
      webhookSignatureConfigured: this.hasAppSecret(),
      lastWebhookReceived: this.lastWebhookReceived,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
    };
  }

  /** Check if the backend is connected (token is valid). */
  isConnected(): boolean {
    return this.connected;
  }
}

/** Constant-time string comparison (lengths may differ). */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a === b;
}

/** The one owner notice for SEC-086 observe mode (no app secret set). */
export const UNVERIFIED_DELIVERY_NOTICE = 'WhatsApp Business messages are reaching me, but I cannot yet check that they really come from Meta. Until your Meta app secret is set, anyone who finds my address could fake one. Tell me "send the WhatsApp secret link" and I will send you a Secret Drop link for the App Secret; from then on I check every message.';

/**
 * SEC-086 observe mode: tell the owner once, ever, that WhatsApp Business deliveries are unverified.
 * The marker is written only after the send is confirmed, so an owner with no reachable channel is
 * retried on a later process, never silently marked as told. Never throws.
 */
export async function notifyOwnerUnverifiedOnce(markerPath: string, send: ((text: string) => Promise<unknown>) | undefined): Promise<'sent' | 'already-sent' | 'not-sent'> {
  try {
    if (fs.existsSync(markerPath)) return 'already-sent';
    if (!send) return 'not-sent';
    const result = await send(UNVERIFIED_DELIVERY_NOTICE);
    if (result === null || result === undefined || result === false) return 'not-sent';
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ sentAt: new Date().toISOString() }));
    return 'sent';
  } catch { // @silent-fallback-ok: a failed notice is retried on a later process; delivery never depends on it
    return 'not-sent';
  }
}
