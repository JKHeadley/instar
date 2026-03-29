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
import fs from 'node:fs';
import path from 'node:path';
// ── Implementation ──────────────────────────────────────────
// Prefix used to identify bridged messages and prevent loops
const BRIDGE_PREFIX_WA = '[via WhatsApp] ';
const BRIDGE_PREFIX_TG = '[via Telegram] ';
export class MessageBridge {
    config;
    links = [];
    unsubscribers = [];
    started = false;
    messagesBridged = 0;
    lastBridgedAt = null;
    constructor(config) {
        this.config = config;
        this.loadRegistry();
    }
    /** Start listening to event buses and forwarding messages. */
    start() {
        if (this.started)
            return;
        this.started = true;
        // Subscribe to WhatsApp messages → forward to Telegram
        if (this.config.whatsappEventBus && this.config.sendToTelegram) {
            const unsub = this.config.whatsappEventBus.on('message:logged', (event) => {
                this.handleWhatsAppMessage(event).catch(err => console.error(`[message-bridge] WhatsApp→Telegram error: ${err}`));
            });
            this.unsubscribers.push(unsub);
        }
        // Subscribe to Telegram messages → forward to WhatsApp
        if (this.config.telegramEventBus && this.config.sendToWhatsApp) {
            const unsub = this.config.telegramEventBus.on('message:logged', (event) => {
                this.handleTelegramMessage(event).catch(err => console.error(`[message-bridge] Telegram→WhatsApp error: ${err}`));
            });
            this.unsubscribers.push(unsub);
        }
    }
    /** Stop listening and cleanup. */
    stop() {
        for (const unsub of this.unsubscribers) {
            unsub();
        }
        this.unsubscribers = [];
        this.started = false;
    }
    // ── Link management ──────────────────────────────────────
    /** Create a bridge link between a WhatsApp JID and a Telegram topic. */
    addLink(whatsappChannelId, telegramTopicId, createdBy) {
        // Remove existing link for either end (one-to-one mapping)
        this.links = this.links.filter(l => l.whatsappChannelId !== whatsappChannelId && l.telegramTopicId !== telegramTopicId);
        this.links.push({
            whatsappChannelId,
            telegramTopicId,
            createdAt: new Date().toISOString(),
            createdBy,
        });
        this.saveRegistry();
    }
    /** Remove a bridge link by WhatsApp channel ID. */
    removeLinkByWhatsApp(whatsappChannelId) {
        const before = this.links.length;
        this.links = this.links.filter(l => l.whatsappChannelId !== whatsappChannelId);
        if (this.links.length < before) {
            this.saveRegistry();
            return true;
        }
        return false;
    }
    /** Remove a bridge link by Telegram topic ID. */
    removeLinkByTelegram(telegramTopicId) {
        const before = this.links.length;
        this.links = this.links.filter(l => l.telegramTopicId !== telegramTopicId);
        if (this.links.length < before) {
            this.saveRegistry();
            return true;
        }
        return false;
    }
    /** Get the Telegram topic linked to a WhatsApp JID. */
    getTelegramForWhatsApp(whatsappChannelId) {
        const link = this.links.find(l => l.whatsappChannelId === whatsappChannelId);
        return link?.telegramTopicId ?? null;
    }
    /** Get the WhatsApp JID linked to a Telegram topic. */
    getWhatsAppForTelegram(telegramTopicId) {
        const link = this.links.find(l => l.telegramTopicId === telegramTopicId);
        return link?.whatsappChannelId ?? null;
    }
    /** Get all active bridge links. */
    getLinks() {
        return [...this.links];
    }
    // ── Message forwarding ──────────────────────────────────
    async handleWhatsAppMessage(event) {
        // Only bridge user messages (not bot responses)
        if (!event.fromUser)
            return;
        // Loop detection: don't re-bridge already-bridged messages
        if (event.text.startsWith(BRIDGE_PREFIX_TG))
            return;
        const topicId = this.getTelegramForWhatsApp(event.channelId);
        if (!topicId || !this.config.sendToTelegram)
            return;
        const senderLabel = event.senderName ?? event.platformUserId ?? 'Unknown';
        const bridgedText = `${BRIDGE_PREFIX_WA}${senderLabel}: ${event.text}`;
        await this.config.sendToTelegram(topicId, bridgedText);
        this.messagesBridged++;
        this.lastBridgedAt = new Date().toISOString();
    }
    async handleTelegramMessage(event) {
        // Only bridge user messages
        if (!event.fromUser)
            return;
        // Loop detection
        if (event.text.startsWith(BRIDGE_PREFIX_WA))
            return;
        // Telegram channelId is the topic ID (string)
        const topicId = parseInt(event.channelId, 10);
        if (isNaN(topicId))
            return;
        const jid = this.getWhatsAppForTelegram(topicId);
        if (!jid || !this.config.sendToWhatsApp)
            return;
        const senderLabel = event.senderName ?? event.senderUsername ?? 'Unknown';
        const bridgedText = `${BRIDGE_PREFIX_TG}${senderLabel}: ${event.text}`;
        await this.config.sendToWhatsApp(jid, bridgedText);
        this.messagesBridged++;
        this.lastBridgedAt = new Date().toISOString();
    }
    // ── Status ──────────────────────────────────────────
    getStatus() {
        return {
            started: this.started,
            linkCount: this.links.length,
            messagesBridged: this.messagesBridged,
            lastBridgedAt: this.lastBridgedAt,
        };
    }
    // ── Persistence ──────────────────────────────────────
    loadRegistry() {
        try {
            if (!fs.existsSync(this.config.registryPath))
                return;
            const data = JSON.parse(fs.readFileSync(this.config.registryPath, 'utf-8'));
            if (Array.isArray(data.links)) {
                this.links = data.links;
            }
        }
        catch {
            // Start fresh
        }
    }
    saveRegistry() {
        try {
            const dir = path.dirname(this.config.registryPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.config.registryPath, JSON.stringify({ links: this.links }, null, 2));
        }
        catch (err) {
            console.error(`[message-bridge] Failed to save registry: ${err}`);
        }
    }
}
//# sourceMappingURL=MessageBridge.js.map