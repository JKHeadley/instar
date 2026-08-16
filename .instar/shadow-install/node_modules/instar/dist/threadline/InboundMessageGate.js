/**
 * InboundMessageGate — Pre-filter for relay inbound messages.
 *
 * Gates on sender identity, trust level, rate limits, payload size, and replay.
 * Does NOT determine delivery mode — that's AutonomyGate's job.
 *
 * Part of PROP-relay-auto-connect.
 */
/** Operations that are probes (don't spawn sessions) */
const PROBE_OPS = new Set(['ping', 'health']);
/** Default rate limits per trust level */
const DEFAULT_RATE_LIMITS = {
    untrusted: { probesPerHour: 5, messagesPerHour: 0, messagesPerDay: 0 },
    verified: { probesPerHour: 20, messagesPerHour: 10, messagesPerDay: 50 },
    trusted: { probesPerHour: 100, messagesPerHour: 50, messagesPerDay: 200 },
    autonomous: { probesPerHour: 500, messagesPerHour: 500, messagesPerDay: 10_000 },
};
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64KB
/** Seen messageId TTL for replay protection (10 minutes) */
const SEEN_MESSAGE_TTL_MS = 10 * 60 * 1000;
class PerSenderRateLimiter {
    probeWindows = new Map();
    messageHourWindows = new Map();
    messageDayWindows = new Map();
    isProbeRateLimited(fingerprint, limit) {
        return this.isLimited(this.probeWindows, fingerprint, limit, 60 * 60 * 1000);
    }
    isMessageHourLimited(fingerprint, limit) {
        if (limit <= 0)
            return true; // 0 = blocked
        return this.isLimited(this.messageHourWindows, fingerprint, limit, 60 * 60 * 1000);
    }
    isMessageDayLimited(fingerprint, limit) {
        if (limit <= 0)
            return true;
        return this.isLimited(this.messageDayWindows, fingerprint, limit, 24 * 60 * 60 * 1000);
    }
    isLimited(windows, key, limit, windowMs) {
        const now = Date.now();
        let window = windows.get(key);
        if (!window) {
            window = { timestamps: [] };
            windows.set(key, window);
        }
        // Prune expired timestamps
        window.timestamps = window.timestamps.filter(t => now - t < windowMs);
        if (window.timestamps.length >= limit) {
            return true;
        }
        window.timestamps.push(now);
        return false;
    }
    /**
     * Evict stale entries to prevent unbounded memory growth.
     */
    cleanup(maxAgeMs = 24 * 60 * 60 * 1000) {
        const now = Date.now();
        for (const windows of [this.probeWindows, this.messageHourWindows, this.messageDayWindows]) {
            for (const [key, window] of windows) {
                window.timestamps = window.timestamps.filter(t => now - t < maxAgeMs);
                if (window.timestamps.length === 0) {
                    windows.delete(key);
                }
            }
        }
    }
}
// ── Implementation ───────────────────────────────────────────────────
export class InboundMessageGate {
    trustManager;
    router;
    config;
    rateLimiter = new PerSenderRateLimiter();
    maxPayloadBytes;
    cleanupTimer = null;
    /** Seen messageId cache for replay protection */
    seenMessageIds = new Map();
    // Metrics
    metrics = {
        passed: 0,
        blocked: 0,
        blockedByTrust: 0,
        blockedByRate: 0,
        blockedBySize: 0,
        blockedByReplay: 0,
        probesHandled: 0,
    };
    constructor(trustManager, router, config = {}) {
        this.trustManager = trustManager;
        this.router = router;
        this.config = config;
        this.maxPayloadBytes = config.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
        // Periodic cleanup of rate limiter state and seen-messageId cache (every 30 minutes)
        this.cleanupTimer = setInterval(() => {
            this.rateLimiter.cleanup();
            this.pruneSeenMessageIds();
        }, 30 * 60 * 1000);
        if (this.cleanupTimer.unref)
            this.cleanupTimer.unref();
    }
    /**
     * Late-bind the router after server initialization.
     * The router isn't available at bootstrap time — it's created in server.ts
     * after the Threadline bootstrap completes.
     */
    setRouter(router) {
        this.router = router;
    }
    /**
     * Evaluate an inbound relay message.
     * Returns 'pass' to route to ThreadlineRouter/AutonomyGate,
     * or 'block' with reason.
     */
    async evaluate(message) {
        const fingerprint = message.from;
        // 0a. Replay protection — check seen-messageId cache
        const messageId = this.extractMessageId(message);
        if (messageId && this.seenMessageIds.has(messageId)) {
            this.metrics.blocked++;
            this.metrics.blockedByReplay++;
            return { action: 'block', reason: 'replay_detected', fingerprint };
        }
        // 0b. Payload size check
        const payloadSize = this.estimatePayloadSize(message);
        if (payloadSize > this.maxPayloadBytes) {
            this.metrics.blocked++;
            this.metrics.blockedBySize++;
            return { action: 'block', reason: 'payload_too_large', fingerprint };
        }
        // 1. Determine operation type
        const opType = this.classifyOperation(message);
        const isProbe = PROBE_OPS.has(opType);
        // 2. Trust check (keyed by fingerprint)
        const trust = this.trustManager.getTrustLevelByFingerprint(fingerprint);
        const limits = this.getRateLimits(trust);
        // 3. Handle probes (don't require 'message' permission)
        if (isProbe) {
            if (this.rateLimiter.isProbeRateLimited(fingerprint, limits.probesPerHour)) {
                this.metrics.blocked++;
                this.metrics.blockedByRate++;
                return { action: 'block', reason: 'probe_rate_limited', fingerprint };
            }
            this.metrics.probesHandled++;
            // Probes are handled inline — return pass with probe flag
            return { action: 'pass', message, trustLevel: trust, reason: 'probe' };
        }
        // 4. Message permission check
        const allowedOps = this.trustManager.getAllowedOperationsByFingerprint(fingerprint);
        if (!allowedOps.includes(opType)) {
            this.metrics.blocked++;
            this.metrics.blockedByTrust++;
            return { action: 'block', reason: 'insufficient_trust', fingerprint };
        }
        // 5. Rate limit check (per-sender, trust-level-aware)
        if (this.rateLimiter.isMessageHourLimited(fingerprint, limits.messagesPerHour)) {
            this.metrics.blocked++;
            this.metrics.blockedByRate++;
            return { action: 'block', reason: 'rate_limited_hourly', fingerprint };
        }
        if (this.rateLimiter.isMessageDayLimited(fingerprint, limits.messagesPerDay)) {
            this.metrics.blocked++;
            this.metrics.blockedByRate++;
            return { action: 'block', reason: 'rate_limited_daily', fingerprint };
        }
        // 6. Record interaction (debounced)
        this.trustManager.recordMessageReceivedByFingerprint(fingerprint);
        // 7. Record messageId for replay protection
        if (messageId) {
            this.seenMessageIds.set(messageId, Date.now());
        }
        // 8. Pass to ThreadlineRouter -> AutonomyGate handles delivery mode
        this.metrics.passed++;
        return { action: 'pass', message, trustLevel: trust };
    }
    /**
     * Get gate metrics for observability.
     */
    getMetrics() {
        return { ...this.metrics };
    }
    /**
     * Shutdown: cleanup timers.
     */
    shutdown() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    // ── Private ─────────────────────────────────────────────────────
    classifyOperation(message) {
        // Check for explicit operation type in content
        const content = message.content;
        if (typeof content === 'object' && content !== null && 'type' in content) {
            return content.type;
        }
        // Default: treat as 'message'
        return 'message';
    }
    estimatePayloadSize(message) {
        try {
            return Buffer.byteLength(JSON.stringify(message.content), 'utf-8');
        }
        catch {
            return 0;
        }
    }
    getRateLimits(trust) {
        return {
            ...DEFAULT_RATE_LIMITS[trust],
            ...this.config.rateLimits?.[trust],
        };
    }
    /**
     * Extract messageId from a ReceivedMessage.
     */
    extractMessageId(message) {
        // ReceivedMessage has a messageId field directly
        if (message.messageId)
            return message.messageId;
        // Also check content for a messageId field
        if (typeof message.content === 'object' && message.content !== null) {
            const c = message.content;
            if (typeof c.messageId === 'string')
                return c.messageId;
        }
        return null;
    }
    /**
     * Prune expired entries from the seen-messageId cache.
     */
    pruneSeenMessageIds() {
        const now = Date.now();
        for (const [id, timestamp] of this.seenMessageIds) {
            if (now - timestamp > SEEN_MESSAGE_TTL_MS) {
                this.seenMessageIds.delete(id);
            }
        }
    }
}
//# sourceMappingURL=InboundMessageGate.js.map