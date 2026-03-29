/**
 * SlackLifeline — Minimal persistent process that owns the Slack Socket Mode connection.
 *
 * Survives server crashes. When the main server is down:
 * - Keeps the Socket Mode WebSocket alive
 * - Queues incoming messages to disk
 * - Replays queued messages when server recovers
 *
 * Modeled after TelegramLifeline but simpler because Socket Mode
 * handles reconnection internally (no offset tracking needed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SlackApiClient } from '../messaging/slack/SlackApiClient.js';
export class SlackLifeline {
    config;
    apiClient;
    queuePath;
    queue = [];
    ws = null;
    started = false;
    serverHealthy = false;
    healthCheckTimer = null;
    reconnectTimer = null;
    constructor(config) {
        this.config = config;
        this.apiClient = new SlackApiClient(config.botToken, config.appToken);
        this.queuePath = path.join(config.stateDir, 'slack-lifeline-queue.json');
        this.loadQueue();
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        console.log('[slack-lifeline] Starting...');
        // Start Socket Mode connection
        await this.connectSocketMode();
        // Start health checking the main server
        this.startHealthCheck();
        console.log('[slack-lifeline] Running. Socket Mode active, health checking server.');
    }
    async stop() {
        this.started = false;
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close(1000, 'lifeline stopping');
            this.ws = null;
        }
    }
    async connectSocketMode() {
        try {
            const response = await this.apiClient.call('apps.connections.open', {}, { useAppToken: true });
            const url = response.url;
            if (!url)
                throw new Error('No WebSocket URL');
            this.ws = new WebSocket(url);
            this.ws.addEventListener('open', () => {
                console.log('[slack-lifeline] Socket Mode connected');
            });
            this.ws.addEventListener('message', (event) => {
                const raw = typeof event.data === 'string' ? event.data : String(event.data);
                this.handleMessage(raw);
            });
            this.ws.addEventListener('close', () => {
                console.log('[slack-lifeline] Socket Mode disconnected');
                this.ws = null;
                if (this.started) {
                    // Reconnect with backoff
                    this.reconnectTimer = setTimeout(() => {
                        this.connectSocketMode().catch(err => {
                            console.error('[slack-lifeline] Reconnect failed:', err.message);
                        });
                    }, 5000);
                }
            });
            this.ws.addEventListener('error', () => {
                // Close handler will trigger reconnect
            });
        }
        catch (err) {
            console.error('[slack-lifeline] Connection failed:', err.message);
            if (this.started) {
                this.reconnectTimer = setTimeout(() => {
                    this.connectSocketMode().catch(() => { });
                }, 10000);
            }
        }
    }
    handleMessage(raw) {
        try {
            const envelope = JSON.parse(raw);
            // Acknowledge immediately
            if (envelope.envelope_id && this.ws) {
                this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
            }
            // Handle disconnect events
            if (envelope.type === 'disconnect') {
                const reason = envelope.reason || envelope.payload?.reason || 'unknown';
                console.log(`[slack-lifeline] Disconnect event: ${reason}`);
                return;
            }
            // Extract message events
            if (envelope.type === 'events_api') {
                const event = envelope.payload?.event;
                if (event?.type === 'message' && event.user && event.text && !event.bot_id && !event.subtype) {
                    this.routeMessage({
                        channelId: event.channel,
                        userId: event.user,
                        text: event.text,
                        ts: event.ts,
                        threadTs: event.thread_ts,
                        timestamp: new Date().toISOString(),
                    });
                }
            }
        }
        catch (err) {
            console.error('[slack-lifeline] Message parse error:', err.message);
        }
    }
    routeMessage(msg) {
        if (this.serverHealthy) {
            // Forward to server
            this.forwardToServer(msg).catch(() => {
                // Server might have just died — queue it
                console.log('[slack-lifeline] Forward failed, queuing message');
                this.enqueue(msg);
            });
        }
        else {
            // Server is down — queue to disk
            console.log(`[slack-lifeline] Server down, queuing message from ${msg.userId}`);
            this.enqueue(msg);
        }
    }
    async forwardToServer(msg) {
        const url = `http://localhost:${this.config.serverPort}/internal/slack-forward`;
        const headers = {
            'Content-Type': 'application/json',
        };
        if (this.config.authToken) {
            headers['Authorization'] = `Bearer ${this.config.authToken}`;
        }
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                channelId: msg.channelId,
                text: `[slack:${msg.channelId}] ${msg.text}`,
                userId: msg.userId,
            }),
        });
        if (!response.ok) {
            throw new Error(`Forward failed: ${response.status}`);
        }
    }
    startHealthCheck() {
        this.healthCheckTimer = setInterval(async () => {
            try {
                const response = await fetch(`http://localhost:${this.config.serverPort}/health`, { signal: AbortSignal.timeout(3000) });
                const data = await response.json();
                const wasHealthy = this.serverHealthy;
                this.serverHealthy = data.status === 'ok';
                // Server just recovered — replay queued messages
                if (!wasHealthy && this.serverHealthy) {
                    console.log('[slack-lifeline] Server recovered! Replaying queued messages...');
                    await this.replayQueue();
                }
            }
            catch {
                if (this.serverHealthy) {
                    console.log('[slack-lifeline] Server unreachable — queuing messages');
                }
                this.serverHealthy = false;
            }
        }, 5000); // Check every 5 seconds
    }
    async replayQueue() {
        const messages = this.drain();
        console.log(`[slack-lifeline] Replaying ${messages.length} queued messages`);
        for (const msg of messages) {
            try {
                await this.forwardToServer(msg);
            }
            catch (err) {
                console.error('[slack-lifeline] Replay failed, re-queuing:', err.message);
                this.enqueue(msg);
                break; // Server might be down again
            }
        }
    }
    // ── Simple disk-persisted queue ──
    loadQueue() {
        try {
            if (fs.existsSync(this.queuePath)) {
                this.queue = JSON.parse(fs.readFileSync(this.queuePath, 'utf-8'));
            }
        }
        catch {
            this.queue = [];
        }
    }
    saveQueue() {
        try {
            fs.writeFileSync(this.queuePath, JSON.stringify(this.queue));
        }
        catch { /* non-fatal */ }
    }
    enqueue(msg) {
        this.queue.push(msg);
        this.saveQueue();
    }
    drain() {
        const msgs = [...this.queue];
        this.queue = [];
        this.saveQueue();
        return msgs;
    }
}
//# sourceMappingURL=SlackLifeline.js.map