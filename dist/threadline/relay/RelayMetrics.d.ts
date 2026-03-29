/**
 * RelayMetrics — Monitoring and metrics collection for the relay.
 *
 * Collects counters and gauges for message throughput, connections,
 * auth failures, abuse events, and queue stats. Exports in both
 * JSON and Prometheus text format.
 *
 * Part of Threadline Relay Phase 5.
 */
export interface MetricsSnapshot {
    messagesRouted: number;
    messagesDelivered: number;
    messagesQueued: number;
    messagesRejected: number;
    messagesExpired: number;
    connectionsTotal: number;
    connectionsActive: number;
    authFailures: number;
    abuseBansIssued: number;
    discoveryQueries: number;
    messagesPerMinute: number;
    a2aRequestsTotal: number;
    a2aRequestsRejected: number;
    uptimeSeconds: number;
}
export declare class RelayMetrics {
    private readonly nowFn;
    private readonly startTime;
    private _messagesRouted;
    private _messagesDelivered;
    private _messagesQueued;
    private _messagesRejected;
    private _messagesExpired;
    private _connectionsTotal;
    private _authFailures;
    private _abuseBansIssued;
    private _discoveryQueries;
    private _a2aRequestsTotal;
    private _a2aRequestsRejected;
    private _connectionsActive;
    private readonly messageTimestamps;
    constructor(nowFn?: () => number);
    recordMessageRouted(): void;
    recordMessageDelivered(): void;
    recordMessageQueued(): void;
    recordMessageRejected(): void;
    recordMessageExpired(): void;
    recordConnection(): void;
    recordAuthFailure(): void;
    recordAbuseBan(): void;
    recordDiscoveryQuery(): void;
    recordA2ARequest(): void;
    recordA2ARequestRejected(): void;
    setActiveConnections(count: number): void;
    getSnapshot(): MetricsSnapshot;
    toPrometheus(): string;
    /**
     * Reset all metrics (for testing).
     */
    reset(): void;
}
//# sourceMappingURL=RelayMetrics.d.ts.map