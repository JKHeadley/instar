/**
 * AgentBus — Transport-agnostic message bus for inter-agent communication.
 *
 * Supports two transport modes:
 *   1. HTTP — Real-time messaging via agent HTTP servers (tunnel-exposed)
 *   2. JSONL — File-based messaging via shared JSONL log (git-synced)
 *
 * Messages have typed payloads, delivery tracking, and TTL expiration.
 *
 * From INTELLIGENT_SYNC_SPEC Section 7.4 and Phase 7 (Real-Time Communication).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
import { NonceStore } from './NonceStore.js';
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_TTL = 30 * 60 * 1000; // 30 minutes
const DEFAULT_POLL_INTERVAL = 5000;
const MESSAGES_DIR = 'messages';
const OUTBOX_FILE = 'outbox.jsonl';
const INBOX_FILE = 'inbox.jsonl';
const AGENTBUS_TIMESTAMP_WINDOW = 5 * 60 * 1000; // 5 minutes per spec
// ── AgentBus ─────────────────────────────────────────────────────────
export class AgentBus extends EventEmitter {
    stateDir;
    machineId;
    transportMode;
    selfUrl;
    peerUrls;
    defaultTtlMs;
    pollIntervalMs;
    messagesDir;
    pollTimer;
    handlers;
    nonceStore;
    replayProtectionEnabled;
    outgoingSequence;
    constructor(config) {
        super();
        this.stateDir = config.stateDir;
        this.machineId = config.machineId;
        this.transportMode = config.transport;
        this.selfUrl = config.selfUrl;
        this.peerUrls = config.peerUrls ?? {};
        this.defaultTtlMs = config.defaultTtlMs ?? DEFAULT_TTL;
        this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
        this.handlers = new Map();
        this.outgoingSequence = 0;
        this.messagesDir = path.join(config.stateDir, 'state', MESSAGES_DIR);
        if (!fs.existsSync(this.messagesDir)) {
            fs.mkdirSync(this.messagesDir, { recursive: true });
        }
        // ── Replay Protection (Gap 1) ────────────────────────────────
        const rp = config.replayProtection;
        this.replayProtectionEnabled = rp?.enabled ?? false;
        if (this.replayProtectionEnabled) {
            const nonceDir = rp?.nonceStoreDir ?? path.join(config.stateDir, 'nonce-store');
            const timestampWindowMs = rp?.timestampWindowMs ?? AGENTBUS_TIMESTAMP_WINDOW;
            this.nonceStore = new NonceStore(nonceDir, {
                timestampWindowMs,
                // Nonces must survive at least as long as the timestamp window
                nonceMaxAgeMs: timestampWindowMs * 2,
                pruneIntervalMs: 5 * 60_000,
            });
            this.nonceStore.initialize();
        }
        else {
            this.nonceStore = null;
        }
    }
    // ── Sending ───────────────────────────────────────────────────────
    /**
     * Send a message to a specific machine or broadcast.
     */
    async send(opts) {
        const message = {
            id: `msg_${crypto.randomBytes(8).toString('hex')}`,
            type: opts.type,
            from: this.machineId,
            to: opts.to,
            timestamp: new Date().toISOString(),
            ttlMs: opts.ttlMs ?? this.defaultTtlMs,
            payload: opts.payload,
            replyTo: opts.replyTo,
            status: 'pending',
        };
        // Attach anti-replay fields when replay protection is enabled
        if (this.replayProtectionEnabled) {
            message.nonce = crypto.randomBytes(16).toString('hex'); // 16 bytes = 32 hex chars
            message.sequence = this.outgoingSequence++;
        }
        if (this.transportMode === 'http' && opts.to !== '*') {
            // HTTP: send directly to target
            const targetUrl = this.peerUrls[opts.to];
            if (targetUrl) {
                const delivered = await this.httpSend(message, targetUrl);
                message.status = delivered ? 'delivered' : 'failed';
            }
            else {
                // Fall back to JSONL if no URL known for target
                this.appendToOutbox(message);
            }
        }
        else {
            // JSONL: write to outbox for file-based delivery
            this.appendToOutbox(message);
        }
        this.emit('sent', message);
        return message;
    }
    /**
     * Send and wait for a reply (request/response pattern).
     */
    async request(opts) {
        const message = await this.send(opts);
        const timeoutMs = opts.timeoutMs ?? 30_000;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.off('message', handler);
                resolve(null);
            }, timeoutMs);
            const handler = (reply) => {
                if (reply.replyTo === message.id) {
                    clearTimeout(timer);
                    this.off('message', handler);
                    resolve(reply);
                }
            };
            this.on('message', handler);
        });
    }
    // ── Receiving ─────────────────────────────────────────────────────
    /**
     * Register a handler for a specific message type.
     */
    onMessage(type, handler) {
        const existing = this.handlers.get(type) ?? [];
        existing.push(handler);
        this.handlers.set(type, existing);
    }
    /**
     * Process incoming messages (call from poll loop or HTTP endpoint).
     */
    processIncoming(messages) {
        const now = Date.now();
        for (const msg of messages) {
            // Skip messages not for us
            if (msg.to !== this.machineId && msg.to !== '*')
                continue;
            // Skip our own broadcasts
            if (msg.from === this.machineId)
                continue;
            // Check TTL expiration
            if (msg.ttlMs > 0) {
                const expiresAt = new Date(msg.timestamp).getTime() + msg.ttlMs;
                if (now > expiresAt) {
                    msg.status = 'expired';
                    this.emit('expired', msg);
                    continue;
                }
            }
            // ── Replay Protection Validation (Gap 1) ──────────────────
            if (this.replayProtectionEnabled && this.nonceStore) {
                // Reject messages without anti-replay fields (fail-closed)
                if (!msg.nonce || msg.sequence === undefined || msg.sequence === null) {
                    this.emit('replay-rejected', msg, 'Missing nonce or sequence (replay protection required)');
                    continue;
                }
                const validation = this.nonceStore.validate(msg.timestamp, msg.nonce, msg.sequence, msg.from);
                if (!validation.valid) {
                    this.emit('replay-rejected', msg, validation.reason);
                    continue;
                }
            }
            msg.status = 'delivered';
            // Fire type-specific handlers
            const typeHandlers = this.handlers.get(msg.type) ?? [];
            for (const handler of typeHandlers) {
                handler(msg);
            }
            // Fire generic event
            this.emit('message', msg);
        }
    }
    // ── Polling (JSONL transport) ─────────────────────────────────────
    /**
     * Start polling for incoming messages (JSONL transport).
     */
    startPolling() {
        if (this.pollTimer)
            return;
        this.pollTimer = setInterval(() => {
            try {
                const messages = this.readInbox();
                if (messages.length > 0) {
                    this.processIncoming(messages);
                    this.clearInbox();
                }
            }
            catch (err) {
                // @silent-fallback-ok — error is emitted to listeners; polling continues on next tick
                this.emit('error', err instanceof Error ? err : new Error(String(err)));
            }
        }, this.pollIntervalMs);
    }
    /**
     * Stop polling.
     */
    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
    }
    // ── HTTP Transport Endpoint ───────────────────────────────────────
    /**
     * Handle an incoming HTTP message (call from Express route).
     * Returns true if the message was accepted.
     */
    handleHttpMessage(message) {
        if (message.to !== this.machineId && message.to !== '*') {
            return false;
        }
        this.processIncoming([message]);
        return true;
    }
    // ── Message History ───────────────────────────────────────────────
    /**
     * Read the outbox (sent messages).
     */
    readOutbox() {
        return this.readJsonl(path.join(this.messagesDir, OUTBOX_FILE));
    }
    /**
     * Read the inbox (received messages).
     */
    readInbox() {
        return this.readJsonl(path.join(this.messagesDir, INBOX_FILE));
    }
    /**
     * Get pending messages (from other machines' outboxes in shared state).
     * For JSONL transport: reads all machine outboxes and filters for messages to this machine.
     */
    getPendingMessages() {
        const pending = [];
        try {
            const dirs = fs.readdirSync(this.messagesDir);
            for (const dir of dirs) {
                const outboxPath = path.join(this.messagesDir, dir, OUTBOX_FILE);
                if (fs.existsSync(outboxPath)) {
                    const messages = this.readJsonl(outboxPath);
                    for (const msg of messages) {
                        if ((msg.to === this.machineId || msg.to === '*') && msg.from !== this.machineId) {
                            pending.push(msg);
                        }
                    }
                }
            }
        }
        catch {
            // Directory may not exist
        }
        return pending;
    }
    // ── Cleanup ───────────────────────────────────────────────────────
    /**
     * Expire old messages from outbox.
     */
    cleanExpired() {
        const outboxPath = path.join(this.messagesDir, OUTBOX_FILE);
        const messages = this.readJsonl(outboxPath);
        const now = Date.now();
        let expired = 0;
        const active = messages.filter(msg => {
            if (msg.ttlMs === 0)
                return true; // No expiration
            const expiresAt = new Date(msg.timestamp).getTime() + msg.ttlMs;
            if (now > expiresAt) {
                expired++;
                return false;
            }
            return true;
        });
        if (expired > 0) {
            this.writeJsonl(outboxPath, active);
        }
        return expired;
    }
    // ── Lifecycle ─────────────────────────────────────────────────────
    /**
     * Clean up resources (NonceStore timers, poll timers).
     */
    destroy() {
        this.stopPolling();
        if (this.nonceStore) {
            this.nonceStore.destroy();
        }
    }
    // ── Accessors ─────────────────────────────────────────────────────
    getMachineId() {
        return this.machineId;
    }
    getTransportMode() {
        return this.transportMode;
    }
    isReplayProtectionEnabled() {
        return this.replayProtectionEnabled;
    }
    getOutgoingSequence() {
        return this.outgoingSequence;
    }
    registerPeer(machineId, url) {
        this.peerUrls[machineId] = url;
    }
    // ── Private: JSONL I/O ────────────────────────────────────────────
    appendToOutbox(message) {
        const outboxPath = path.join(this.messagesDir, OUTBOX_FILE);
        maybeRotateJsonl(outboxPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
        fs.appendFileSync(outboxPath, JSON.stringify(message) + '\n');
    }
    appendToInbox(message) {
        const inboxPath = path.join(this.messagesDir, INBOX_FILE);
        maybeRotateJsonl(inboxPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
        fs.appendFileSync(inboxPath, JSON.stringify(message) + '\n');
    }
    clearInbox() {
        const inboxPath = path.join(this.messagesDir, INBOX_FILE);
        try {
            fs.writeFileSync(inboxPath, '');
        }
        catch { /* @silent-fallback-ok — best-effort inbox cleanup */ }
    }
    readJsonl(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return content.trim().split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line));
        }
        catch {
            // @silent-fallback-ok — file may not exist yet; empty array is the natural default
            return [];
        }
    }
    writeJsonl(filePath, messages) {
        const content = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
        fs.writeFileSync(filePath, content);
    }
    // ── Private: HTTP Transport ───────────────────────────────────────
    async httpSend(message, targetUrl) {
        try {
            const url = `${targetUrl.replace(/\/$/, '')}/messages/receive`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(message),
                signal: AbortSignal.timeout(10_000),
            });
            return response.ok;
        }
        catch {
            // @silent-fallback-ok — HTTP delivery failed; caller falls back to JSONL transport
            return false;
        }
    }
}
//# sourceMappingURL=AgentBus.js.map