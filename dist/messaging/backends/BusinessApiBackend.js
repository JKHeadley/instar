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
// ── API constants ──────────────────────────────────────
const META_API_BASE = 'https://graph.facebook.com/v21.0';
// ── Backend implementation ──────────────────────────────
export class BusinessApiBackend {
    config;
    handlers;
    adapter;
    connected = false;
    lastWebhookReceived = null;
    messagesSent = 0;
    messagesReceived = 0;
    constructor(adapter, config, handlers) {
        this.adapter = adapter;
        this.config = config;
        this.handlers = handlers;
    }
    /**
     * "Connect" — for Business API this means verifying the access token works.
     * Unlike Baileys, there's no persistent connection.
     */
    async connect() {
        try {
            // Verify token by fetching phone number info
            const response = await fetch(`${META_API_BASE}/${this.config.phoneNumberId}`, {
                headers: { Authorization: `Bearer ${this.config.accessToken}` },
            });
            if (!response.ok) {
                const body = await response.text();
                throw new Error(`Business API auth failed (${response.status}): ${body}`);
            }
            const data = await response.json();
            this.connected = true;
            const phoneNumber = data.display_phone_number ?? 'unknown';
            await this.adapter.setConnectionState('connected', phoneNumber);
            // Inject full backend capabilities (Phase 4)
            const capabilities = {
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
        }
        catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.handlers.onError(error);
            await this.adapter.setConnectionState('disconnected');
        }
    }
    /** Disconnect (no-op for stateless API, but updates state). */
    async disconnect() {
        this.connected = false;
        await this.adapter.setConnectionState('closed');
    }
    // ── Webhook handling ──────────────────────────────────
    /**
     * Handle webhook verification (GET request from Meta).
     * Returns the challenge string if the verify token matches.
     */
    verifyWebhook(mode, token, challenge) {
        if (mode === 'subscribe' && token === this.config.webhookVerifyToken) {
            return challenge;
        }
        return null;
    }
    /**
     * Handle incoming webhook payload (POST request from Meta).
     * Processes messages and status updates.
     */
    async handleWebhook(payload) {
        if (payload.object !== 'whatsapp_business_account')
            return;
        this.lastWebhookReceived = new Date().toISOString();
        for (const entry of payload.entry) {
            for (const change of entry.changes) {
                if (change.field !== 'messages')
                    continue;
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
                        }
                        else if (msg.type === 'interactive') {
                            const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
                            if (reply) {
                                this.handlers.onButtonReply(jid, msg.id, reply.id, reply.title);
                                // Also forward as a text message for command routing
                                this.handlers.onMessage(jid, msg.id, reply.title, senderName, timestamp);
                            }
                        }
                        else if (msg.type === 'image' && msg.image?.caption) {
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
    async sendTextMessage(to, text) {
        // Strip @s.whatsapp.net suffix if present
        const phoneNumber = to.replace(/@s\.whatsapp\.net$/, '');
        const response = await fetch(`${META_API_BASE}/${this.config.phoneNumberId}/messages`, {
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
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Business API send failed (${response.status}): ${body}`);
        }
        this.messagesSent++;
        const data = await response.json();
        return data.messages?.[0]?.id ?? null;
    }
    /** Send a template message (for proactive notifications). */
    async sendTemplateMessage(to, template) {
        const phoneNumber = to.replace(/@s\.whatsapp\.net$/, '');
        const response = await fetch(`${META_API_BASE}/${this.config.phoneNumberId}/messages`, {
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
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Template send failed (${response.status}): ${body}`);
        }
        this.messagesSent++;
        const data = await response.json();
        return data.messages?.[0]?.id ?? null;
    }
    /** Send an interactive button message. */
    async sendInteractiveMessage(to, message) {
        const phoneNumber = to.replace(/@s\.whatsapp\.net$/, '');
        if (message.action.buttons.length > 3) {
            throw new Error('WhatsApp interactive messages support a maximum of 3 buttons');
        }
        const response = await fetch(`${META_API_BASE}/${this.config.phoneNumberId}/messages`, {
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
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Interactive send failed (${response.status}): ${body}`);
        }
        this.messagesSent++;
        const data = await response.json();
        return data.messages?.[0]?.id ?? null;
    }
    // ── UX signals (Phase 4) ──────────────────────────────
    /** Mark a message as read (blue ticks). */
    async markMessageRead(messageId) {
        await fetch(`${META_API_BASE}/${this.config.phoneNumberId}/messages`, {
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
        });
        // Fire-and-forget: don't throw on failure
    }
    /** React to a message with an emoji. */
    async sendReaction(to, messageId, emoji) {
        const phoneNumber = to.replace(/@s\.whatsapp\.net$/, '');
        await fetch(`${META_API_BASE}/${this.config.phoneNumberId}/messages`, {
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
        });
        // Fire-and-forget: don't throw on failure
    }
    // ── Status ──────────────────────────────────────────
    getStatus() {
        return {
            connected: this.connected,
            phoneNumberId: this.config.phoneNumberId,
            webhookConfigured: !!this.config.webhookVerifyToken,
            lastWebhookReceived: this.lastWebhookReceived,
            messagesSent: this.messagesSent,
            messagesReceived: this.messagesReceived,
        };
    }
    /** Check if the backend is connected (token is valid). */
    isConnected() {
        return this.connected;
    }
}
//# sourceMappingURL=BusinessApiBackend.js.map