/**
 * RelayMetrics — Monitoring and metrics collection for the relay.
 *
 * Collects counters and gauges for message throughput, connections,
 * auth failures, abuse events, and queue stats. Exports in both
 * JSON and Prometheus text format.
 *
 * Part of Threadline Relay Phase 5.
 */
// ── Implementation ─────────────────────────────────────────────────
export class RelayMetrics {
    nowFn;
    startTime;
    // Counters
    _messagesRouted = 0;
    _messagesDelivered = 0;
    _messagesQueued = 0;
    _messagesRejected = 0;
    _messagesExpired = 0;
    _connectionsTotal = 0;
    _authFailures = 0;
    _abuseBansIssued = 0;
    _discoveryQueries = 0;
    _a2aRequestsTotal = 0;
    _a2aRequestsRejected = 0;
    // Gauge (set externally)
    _connectionsActive = 0;
    // Rate tracking (messages per minute)
    messageTimestamps = [];
    constructor(nowFn) {
        this.nowFn = nowFn ?? (() => Date.now());
        this.startTime = this.nowFn();
    }
    // ── Recording Methods ────────────────────────────────────────────
    recordMessageRouted() {
        this._messagesRouted++;
        this.messageTimestamps.push(this.nowFn());
    }
    recordMessageDelivered() {
        this._messagesDelivered++;
    }
    recordMessageQueued() {
        this._messagesQueued++;
    }
    recordMessageRejected() {
        this._messagesRejected++;
    }
    recordMessageExpired() {
        this._messagesExpired++;
    }
    recordConnection() {
        this._connectionsTotal++;
    }
    recordAuthFailure() {
        this._authFailures++;
    }
    recordAbuseBan() {
        this._abuseBansIssued++;
    }
    recordDiscoveryQuery() {
        this._discoveryQueries++;
    }
    recordA2ARequest() {
        this._a2aRequestsTotal++;
    }
    recordA2ARequestRejected() {
        this._a2aRequestsRejected++;
    }
    setActiveConnections(count) {
        this._connectionsActive = count;
    }
    // ── Snapshot ─────────────────────────────────────────────────────
    getSnapshot() {
        const now = this.nowFn();
        // Calculate messages per minute (last 60 seconds)
        const minuteAgo = now - 60_000;
        const recentMessages = this.messageTimestamps.filter(t => t > minuteAgo);
        // Clean up old timestamps (keep last 5 minutes for rate calculation)
        const fiveMinAgo = now - 5 * 60_000;
        while (this.messageTimestamps.length > 0 && this.messageTimestamps[0] <= fiveMinAgo) {
            this.messageTimestamps.shift();
        }
        return {
            messagesRouted: this._messagesRouted,
            messagesDelivered: this._messagesDelivered,
            messagesQueued: this._messagesQueued,
            messagesRejected: this._messagesRejected,
            messagesExpired: this._messagesExpired,
            connectionsTotal: this._connectionsTotal,
            connectionsActive: this._connectionsActive,
            authFailures: this._authFailures,
            abuseBansIssued: this._abuseBansIssued,
            discoveryQueries: this._discoveryQueries,
            messagesPerMinute: recentMessages.length,
            a2aRequestsTotal: this._a2aRequestsTotal,
            a2aRequestsRejected: this._a2aRequestsRejected,
            uptimeSeconds: Math.round((now - this.startTime) / 1000),
        };
    }
    // ── Prometheus Export ────────────────────────────────────────────
    toPrometheus() {
        const s = this.getSnapshot();
        const lines = [];
        const counter = (name, help, value) => {
            lines.push(`# HELP ${name} ${help}`);
            lines.push(`# TYPE ${name} counter`);
            lines.push(`${name} ${value}`);
        };
        const gauge = (name, help, value) => {
            lines.push(`# HELP ${name} ${help}`);
            lines.push(`# TYPE ${name} gauge`);
            lines.push(`${name} ${value}`);
        };
        counter('threadline_messages_routed_total', 'Total messages routed by the relay', s.messagesRouted);
        counter('threadline_messages_delivered_total', 'Total messages delivered to online agents', s.messagesDelivered);
        counter('threadline_messages_queued_total', 'Total messages queued for offline agents', s.messagesQueued);
        counter('threadline_messages_rejected_total', 'Total messages rejected', s.messagesRejected);
        counter('threadline_messages_expired_total', 'Total queued messages that expired', s.messagesExpired);
        counter('threadline_connections_total', 'Total WebSocket connections established', s.connectionsTotal);
        gauge('threadline_connections_active', 'Currently active WebSocket connections', s.connectionsActive);
        counter('threadline_auth_failures_total', 'Total authentication failures', s.authFailures);
        counter('threadline_abuse_bans_total', 'Total abuse bans issued', s.abuseBansIssued);
        counter('threadline_discovery_queries_total', 'Total discovery queries', s.discoveryQueries);
        gauge('threadline_messages_per_minute', 'Messages routed in the last minute', s.messagesPerMinute);
        counter('threadline_a2a_requests_total', 'Total A2A HTTP requests', s.a2aRequestsTotal);
        counter('threadline_a2a_requests_rejected_total', 'Total rejected A2A requests', s.a2aRequestsRejected);
        gauge('threadline_uptime_seconds', 'Relay uptime in seconds', s.uptimeSeconds);
        return lines.join('\n') + '\n';
    }
    /**
     * Reset all metrics (for testing).
     */
    reset() {
        this._messagesRouted = 0;
        this._messagesDelivered = 0;
        this._messagesQueued = 0;
        this._messagesRejected = 0;
        this._messagesExpired = 0;
        this._connectionsTotal = 0;
        this._connectionsActive = 0;
        this._authFailures = 0;
        this._abuseBansIssued = 0;
        this._discoveryQueries = 0;
        this._a2aRequestsTotal = 0;
        this._a2aRequestsRejected = 0;
        this.messageTimestamps.length = 0;
    }
}
//# sourceMappingURL=RelayMetrics.js.map