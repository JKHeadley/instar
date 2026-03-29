/**
 * RelayRateLimiter — Rate limiting for the relay server.
 *
 * Adapts the existing Threadline RateLimiter pattern for relay-specific limits.
 * Uses sliding window counters. In-memory only (no persistence needed for relay).
 */
const DEFAULTS = {
    perAgentPerMinute: 60,
    perAgentPerHour: 1000,
    perIPPerMinute: 120,
    globalPerMinute: 5000,
    discoveryPerMinute: 10,
    authAttemptsPerMinute: 100,
};
export class RelayRateLimiter {
    config;
    windows = new Map();
    nowFn;
    constructor(config, nowFn) {
        this.config = { ...DEFAULTS, ...config };
        this.nowFn = nowFn ?? (() => Date.now());
    }
    /**
     * Check if a message from an agent is allowed.
     */
    checkMessage(agentId, ip) {
        // Check per-agent per-minute
        const agentMin = this.check(`agent:min:${agentId}`, this.config.perAgentPerMinute, 60_000);
        if (!agentMin.allowed)
            return { ...agentMin, limitType: 'per_agent_minute' };
        // Check per-agent per-hour
        const agentHour = this.check(`agent:hour:${agentId}`, this.config.perAgentPerHour, 3_600_000);
        if (!agentHour.allowed)
            return { ...agentHour, limitType: 'per_agent_hour' };
        // Check per-IP per-minute
        const ipMin = this.check(`ip:min:${ip}`, this.config.perIPPerMinute, 60_000);
        if (!ipMin.allowed)
            return { ...ipMin, limitType: 'per_ip_minute' };
        // Check global per-minute
        const globalMin = this.check('global:min', this.config.globalPerMinute, 60_000);
        if (!globalMin.allowed)
            return { ...globalMin, limitType: 'global_minute' };
        return { allowed: true, remaining: agentMin.remaining, resetInMs: 0, limitType: 'none' };
    }
    /**
     * Record a message event.
     */
    recordMessage(agentId, ip) {
        this.record(`agent:min:${agentId}`, 60_000);
        this.record(`agent:hour:${agentId}`, 3_600_000);
        this.record(`ip:min:${ip}`, 60_000);
        this.record('global:min', 60_000);
    }
    /**
     * Check if a discovery query is allowed.
     */
    checkDiscovery(agentId) {
        const result = this.check(`discover:${agentId}`, this.config.discoveryPerMinute, 60_000);
        return { ...result, limitType: 'discovery_minute' };
    }
    /**
     * Record a discovery event.
     */
    recordDiscovery(agentId) {
        this.record(`discover:${agentId}`, 60_000);
    }
    /**
     * Check if an auth attempt is allowed.
     */
    checkAuth(ip) {
        const result = this.check(`auth:${ip}`, this.config.authAttemptsPerMinute, 60_000);
        return { ...result, limitType: 'auth_minute' };
    }
    /**
     * Record an auth attempt.
     */
    recordAuth(ip) {
        this.record(`auth:${ip}`, 60_000);
    }
    /**
     * Reset all rate limits (for testing).
     */
    reset() {
        this.windows.clear();
    }
    // ── Private ─────────────────────────────────────────────────────
    check(key, limit, windowMs) {
        const now = this.nowFn();
        const window = this.getWindow(key);
        const cutoff = now - windowMs;
        const active = window.events.filter(t => t > cutoff);
        window.events = active;
        const remaining = Math.max(0, limit - active.length);
        const resetInMs = active.length > 0 ? (active[0] + windowMs) - now : 0;
        return {
            allowed: active.length < limit,
            remaining,
            resetInMs: Math.max(0, resetInMs),
            limitType: '',
        };
    }
    record(key, windowMs) {
        const now = this.nowFn();
        const window = this.getWindow(key);
        const cutoff = now - windowMs;
        window.events = window.events.filter(t => t > cutoff);
        window.events.push(now);
    }
    getWindow(key) {
        if (!this.windows.has(key)) {
            this.windows.set(key, { events: [] });
        }
        return this.windows.get(key);
    }
}
//# sourceMappingURL=RelayRateLimiter.js.map