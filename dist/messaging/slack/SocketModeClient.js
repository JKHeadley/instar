/**
 * SocketModeClient — WebSocket connection manager for Slack Socket Mode.
 *
 * Handles the full lifecycle: connect, receive events, acknowledge,
 * reconnect with hardened strategy (exponential backoff, active heartbeat,
 * too_many_websockets handling, proactive rotation).
 *
 * Uses Node's built-in WebSocket (Node 22+) or falls back to 'ws' package.
 */
import { SlackApiError } from './SlackApiClient.js';
const MAX_OUTBOUND_QUEUE = 100;
const HEARTBEAT_TIMEOUT_MS = 3_600_000; // 1 hour — quiet channels have no events; WebSocket close handles real disconnections
const MAX_BACKOFF_MS = 60_000;
const TOO_MANY_WS_DELAY_MS = 30_000;
export class SocketModeClient {
    apiClient;
    handlers;
    ws = null;
    started = false;
    reconnecting = false;
    consecutiveErrors = 0;
    heartbeatTimer = null;
    lastEventAt = 0;
    outboundQueue = [];
    connectionTime = null;
    constructor(apiClient, handlers) {
        this.apiClient = apiClient;
        this.handlers = handlers;
    }
    get isConnected() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    async connect() {
        this.started = true;
        await this._openConnection();
    }
    async disconnect() {
        this.started = false;
        this._clearHeartbeat();
        if (this.ws) {
            this.ws.close(1000, 'client disconnect');
            this.ws = null;
        }
    }
    /** Queue an outbound message for sending (or send immediately if connected). */
    queueOutbound(data) {
        if (this.isConnected && this.ws) {
            this.ws.send(data);
        }
        else {
            this.outboundQueue.push({ data, enqueuedAt: Date.now() });
            if (this.outboundQueue.length > MAX_OUTBOUND_QUEUE) {
                this.outboundQueue.shift(); // Drop oldest
            }
        }
    }
    async _openConnection() {
        try {
            const response = await this.apiClient.call('apps.connections.open', {}, { useAppToken: true });
            if (!response.url) {
                throw new Error('No WebSocket URL in apps.connections.open response');
            }
            this.connectionTime = response.approximate_connection_time ?? null;
            this._connectWebSocket(response.url);
            this.consecutiveErrors = 0;
        }
        catch (err) {
            if (err instanceof SlackApiError && err.permanent) {
                this.handlers.onError(err, true);
                this.started = false; // Don't retry permanent failures
                return;
            }
            this.handlers.onError(err, false);
            if (this.started) {
                await this._backoffReconnect();
            }
        }
    }
    _connectWebSocket(url) {
        this.ws = new WebSocket(url);
        this.ws.addEventListener('open', () => {
            this.lastEventAt = Date.now();
            this._startHeartbeat();
            this._drainQueue();
            this.handlers.onConnected();
        });
        this.ws.addEventListener('message', (event) => {
            this.lastEventAt = Date.now();
            this._handleRawMessage(typeof event.data === 'string' ? event.data : String(event.data));
        });
        this.ws.addEventListener('close', (event) => {
            this._clearHeartbeat();
            this.ws = null;
            this.handlers.onDisconnected(event.reason || 'connection closed');
            if (this.started) {
                this._backoffReconnect();
            }
        });
        this.ws.addEventListener('error', () => {
            // Error event is always followed by close event — handle reconnection there
        });
    }
    async _handleRawMessage(raw) {
        let envelope;
        try {
            envelope = JSON.parse(raw);
        }
        catch {
            console.error('[slack-socket] Failed to parse WebSocket message');
            return;
        }
        // Handle disconnect events (no envelope_id to ack)
        if (envelope.type === 'disconnect') {
            const reason = envelope.payload?.reason
                ?? envelope.reason
                ?? 'unknown';
            this._handleDisconnect(reason);
            return;
        }
        // Acknowledge immediately (must be within 3 seconds)
        if (envelope.envelope_id) {
            this.ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        }
        // Process event with exception guard (post-ack — Slack won't redeliver)
        try {
            if (envelope.type === 'interactive') {
                await this.handlers.onInteraction(envelope.payload);
            }
            else if (envelope.type === 'events_api') {
                const event = envelope.payload.event;
                const eventType = event?.type ?? 'unknown';
                await this.handlers.onEvent(eventType, envelope.payload);
            }
        }
        catch (err) {
            console.error('[slack-socket] Event processing failed after ack:', err.message);
        }
    }
    _handleDisconnect(reason) {
        this._clearHeartbeat();
        // Prevent close event handler from triggering a second reconnect
        const wasStarted = this.started;
        this.started = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.started = wasStarted;
        this.handlers.onDisconnected(reason);
        if (!this.started)
            return;
        if (reason === 'refresh_requested') {
            // Slack container rotation — reconnect immediately
            this._openConnection();
        }
        else if (reason === 'too_many_websockets') {
            // Wait 30s before reconnecting
            setTimeout(() => {
                if (this.started)
                    this._openConnection();
            }, TOO_MANY_WS_DELAY_MS);
        }
        else {
            this._backoffReconnect();
        }
    }
    async _backoffReconnect() {
        if (this.reconnecting || !this.started)
            return;
        this.reconnecting = true;
        this.consecutiveErrors++;
        // Exponential backoff from first attempt: 1s, 2s, 4s, 8s... max 60s
        const delay = Math.min(1000 * Math.pow(2, this.consecutiveErrors - 1), MAX_BACKOFF_MS);
        await new Promise(r => setTimeout(r, delay));
        this.reconnecting = false;
        if (this.started) {
            await this._openConnection();
        }
    }
    _startHeartbeat() {
        this._clearHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            const elapsed = Date.now() - this.lastEventAt;
            if (elapsed > HEARTBEAT_TIMEOUT_MS) {
                console.warn('[slack-socket] No events for 1h — connection presumed dead, reconnecting');
                if (this.ws) {
                    this.ws.close();
                    this.ws = null;
                }
                // Close event handler will trigger reconnect
            }
        }, HEARTBEAT_TIMEOUT_MS / 2); // Check every 30min
    }
    _clearHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    _drainQueue() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        for (const item of this.outboundQueue) {
            this.ws.send(item.data);
        }
        this.outboundQueue = [];
    }
}
//# sourceMappingURL=SocketModeClient.js.map