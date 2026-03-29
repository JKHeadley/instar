/**
 * QuotaCollector — TypeScript module for collecting Claude Code quota data.
 *
 * Replaces the Python quota-collector.py with a native TypeScript implementation
 * suitable for the Instar npm package. Two-source strategy:
 *
 *   1. PRIMARY: Anthropic OAuth API (/api/oauth/usage + /api/oauth/profile)
 *   2. FALLBACK: JSONL conversation file parsing (estimated, cannot trigger migrations)
 *
 * Features:
 * - Retry/backoff with jitter for API resilience
 * - Adaptive polling interval based on utilization level (with hysteresis)
 * - Multi-account polling with concurrency limiting
 * - Token expiry detection and degradation path
 * - Request budget enforcement (max N requests per 5-minute window)
 *
 * Part of Phase 2 of the Instar Quota Migration spec.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { DegradationReporter } from './DegradationReporter.js';
const DEFAULT_RETRY = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    jitterFactor: 0.3,
};
export function classifyToken(creds) {
    if (!creds || !creds.accessToken)
        return 'missing';
    if (!creds.expiresAt)
        return 'valid'; // No expiry info — assume valid
    const now = Date.now();
    if (creds.expiresAt < now)
        return 'expired';
    if (creds.expiresAt < now + 3600000)
        return 'expiring_soon'; // Within 1 hour
    return 'valid';
}
// ── Retry Helper ─────────────────────────────────────────────────────
export class RetryHelper {
    /**
     * Execute an async function with exponential backoff and jitter.
     * Handles 429 (Retry-After), 5xx (server errors), and network errors.
     * On 401 (unauthorized), throws immediately without retry.
     */
    static async withRetry(fn, config = DEFAULT_RETRY) {
        let lastError = null;
        for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
            try {
                return await fn();
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                // 401 — never retry, throw immediately
                if (lastError.message.includes('401')) {
                    throw lastError;
                }
                // Last attempt — throw
                if (attempt === config.maxRetries) {
                    throw lastError;
                }
                // Calculate backoff delay
                let delayMs = config.baseDelayMs * Math.pow(2, attempt);
                // Check for Retry-After hint
                const retryAfterMatch = lastError.message.match(/retry-after[:\s]+(\d+)/i);
                if (retryAfterMatch) {
                    delayMs = Math.max(delayMs, parseInt(retryAfterMatch[1], 10) * 1000);
                }
                // Apply jitter
                const jitter = delayMs * config.jitterFactor * (Math.random() * 2 - 1);
                delayMs = Math.min(delayMs + jitter, config.maxDelayMs);
                delayMs = Math.max(delayMs, 0);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        throw lastError ?? new Error('Retry exhausted');
    }
    /**
     * Calculate the delay for a specific attempt (for testing).
     */
    static calculateDelay(attempt, config = DEFAULT_RETRY, jitterSeed) {
        let delayMs = config.baseDelayMs * Math.pow(2, attempt);
        const jitter = delayMs * config.jitterFactor * ((jitterSeed ?? Math.random()) * 2 - 1);
        delayMs = Math.min(delayMs + jitter, config.maxDelayMs);
        return Math.max(delayMs, 0);
    }
}
// ── Request Budget ───────────────────────────────────────────────────
export class RequestBudget {
    requests = [];
    limit;
    windowMs = 5 * 60 * 1000; // 5 minutes
    constructor(limit = 60) {
        this.limit = limit;
    }
    /** Check if a request is allowed and consume budget if so */
    consume() {
        this.prune();
        if (this.requests.length >= this.limit)
            return false;
        this.requests.push(Date.now());
        return true;
    }
    /** Check without consuming */
    canRequest() {
        this.prune();
        return this.requests.length < this.limit;
    }
    /** How many requests remain in the current window */
    get remaining() {
        this.prune();
        return Math.max(0, this.limit - this.requests.length);
    }
    /** When the oldest request in the window expires (allowing a new one) */
    get resetsAt() {
        this.prune();
        if (this.requests.length === 0)
            return new Date();
        return new Date(this.requests[0] + this.windowMs);
    }
    get used() {
        this.prune();
        return this.requests.length;
    }
    prune() {
        const cutoff = Date.now() - this.windowMs;
        while (this.requests.length > 0 && this.requests[0] < cutoff) {
            this.requests.shift();
        }
    }
}
// ── Concurrency Limiter ──────────────────────────────────────────────
export class ConcurrencyLimiter {
    limit;
    running = 0;
    queue = [];
    constructor(limit = 2) {
        this.limit = limit;
    }
    async run(fn) {
        await this.acquire();
        try {
            return await fn();
        }
        finally {
            this.release();
        }
    }
    acquire() {
        if (this.running < this.limit) {
            this.running++;
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.queue.push(() => {
                this.running++;
                resolve();
            });
        });
    }
    release() {
        this.running--;
        const next = this.queue.shift();
        if (next)
            next();
    }
}
export class AdaptivePoller {
    state = {
        currentIntervalMs: 10 * 60 * 1000,
        currentTier: 'low',
        consecutiveBelowThreshold: 0,
    };
    /** Hysteresis: require this many consecutive below-threshold readings before slowing down */
    hysteresisCount = 3;
    /**
     * Calculate the ideal polling interval based on current utilization.
     * Uses the shortest interval from both weekly and 5-hour checks.
     */
    static calculateInterval(weeklyPercent, fiveHourPercent) {
        let intervalMs = 10 * 60 * 1000; // 10 min default
        let tier = 'low';
        // Weekly-based intervals
        if (weeklyPercent > 92) {
            intervalMs = 1 * 60 * 1000;
            tier = 'critical';
        }
        else if (weeklyPercent > 85) {
            intervalMs = 2 * 60 * 1000;
            tier = 'high';
        }
        else if (weeklyPercent >= 70) {
            intervalMs = 5 * 60 * 1000;
            tier = 'elevated';
        }
        // 5-hour can override to faster
        if (typeof fiveHourPercent === 'number') {
            if (fiveHourPercent > 80) {
                intervalMs = Math.min(intervalMs, 1 * 60 * 1000);
                tier = 'critical';
            }
            else if (fiveHourPercent >= 70) {
                intervalMs = Math.min(intervalMs, 3 * 60 * 1000);
                if (tier === 'low')
                    tier = 'elevated';
            }
        }
        return { intervalMs, tier };
    }
    /**
     * Update the polling state with a new reading.
     * Applies hysteresis: speeds up immediately, slows down after consecutive below-threshold readings.
     */
    update(weeklyPercent, fiveHourPercent) {
        const { intervalMs: idealMs, tier } = AdaptivePoller.calculateInterval(weeklyPercent, fiveHourPercent);
        if (idealMs < this.state.currentIntervalMs) {
            // Speed up immediately
            this.state.currentIntervalMs = idealMs;
            this.state.currentTier = tier;
            this.state.consecutiveBelowThreshold = 0;
        }
        else if (idealMs > this.state.currentIntervalMs) {
            // Slow down only after hysteresis
            this.state.consecutiveBelowThreshold++;
            if (this.state.consecutiveBelowThreshold >= this.hysteresisCount) {
                this.state.currentIntervalMs = idealMs;
                this.state.currentTier = tier;
                this.state.consecutiveBelowThreshold = 0;
            }
        }
        else {
            // Same interval — reset counter
            this.state.consecutiveBelowThreshold = 0;
        }
        return this.state.currentIntervalMs;
    }
    getState() {
        return { ...this.state };
    }
}
export class JsonlParser {
    /**
     * Find all JSONL files in the Claude projects directory that have been
     * modified since the given cutoff date.
     */
    static findFiles(claudeProjectsDir, sinceTimestamp) {
        const files = [];
        try {
            const entries = fs.readdirSync(claudeProjectsDir);
            for (const entry of entries) {
                if (!entry.startsWith('-Users-'))
                    continue;
                const projectDir = path.join(claudeProjectsDir, entry);
                try {
                    const stat = fs.statSync(projectDir);
                    if (!stat.isDirectory())
                        continue;
                }
                catch {
                    // @silent-fallback-ok — directory may be inaccessible
                    continue;
                }
                try {
                    const projectEntries = fs.readdirSync(projectDir);
                    for (const file of projectEntries) {
                        if (!file.endsWith('.jsonl'))
                            continue;
                        const filePath = path.join(projectDir, file);
                        try {
                            const fileStat = fs.statSync(filePath);
                            if (fileStat.mtimeMs >= sinceTimestamp) {
                                files.push(filePath);
                            }
                        }
                        catch {
                            // @silent-fallback-ok — file may be inaccessible
                            continue;
                        }
                    }
                }
                catch {
                    // @silent-fallback-ok — directory listing may fail
                    continue;
                }
            }
        }
        catch {
            // @silent-fallback-ok — projects directory may not exist
        }
        return files;
    }
    /**
     * Parse a JSONL file and extract token counts for entries within a time window.
     */
    static parseFile(filePath, windowStart, windowEnd) {
        const result = {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalBilled: 0,
        };
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.type !== 'assistant')
                        continue;
                    const message = entry.message;
                    if (!message || message.role !== 'assistant')
                        continue;
                    const usage = message.usage;
                    if (!usage)
                        continue;
                    // Check timestamp window
                    if (entry.timestamp) {
                        const ts = new Date(entry.timestamp);
                        if (ts < windowStart || ts >= windowEnd)
                            continue;
                    }
                    result.inputTokens += usage.input_tokens || 0;
                    result.outputTokens += usage.output_tokens || 0;
                    result.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
                    result.cacheReadTokens += usage.cache_read_input_tokens || 0;
                }
                catch {
                    // @silent-fallback-ok — individual JSONL line may be malformed
                    continue;
                }
            }
        }
        catch {
            // @silent-fallback-ok — file may be inaccessible or corrupt
        }
        result.totalBilled = result.inputTokens + result.outputTokens +
            result.cacheCreationTokens + result.cacheReadTokens;
        return result;
    }
    /**
     * Estimate weekly utilization from token counts using a budget estimate.
     * The budget is a rough estimate — JSONL data is always 'estimated' confidence.
     */
    static estimateUtilization(tokenCounts, estimatedBudget = 7_500_000_000) {
        if (estimatedBudget <= 0)
            return 0;
        return Math.min(200, Math.round((tokenCounts.totalBilled / estimatedBudget) * 1000) / 10);
    }
}
// ── QuotaCollector ───────────────────────────────────────────────────
export class QuotaCollector extends EventEmitter {
    provider;
    tracker;
    config;
    retryConfig;
    budget;
    limiter;
    poller;
    fetchFn;
    lastCollectionAt = null;
    lastCollectionDurationMs = 0;
    /**
     * Cross-poll circuit breaker for OAuth 429s.
     * When 3+ consecutive polls receive 429, we stop hitting the OAuth API
     * for `oauthBackoffUntil` ms to avoid a runaway retry loop.
     */
    oauthConsecutive429s = 0;
    oauthBackoffUntil = null;
    static OAUTH_429_TRIP_COUNT = 3;
    static OAUTH_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes
    constructor(provider, tracker, config = {}) {
        super();
        this.provider = provider;
        this.tracker = tracker;
        this.config = {
            oauthEnabled: config.oauthEnabled ?? true,
            staleAfterMs: config.staleAfterMs ?? 900000,
            concurrencyLimit: config.concurrencyLimit ?? 2,
            requestBudgetPer5Min: config.requestBudgetPer5Min ?? 60,
            ...config,
        };
        this.retryConfig = { ...DEFAULT_RETRY, ...config.retry };
        this.budget = new RequestBudget(this.config.requestBudgetPer5Min);
        this.limiter = new ConcurrencyLimiter(this.config.concurrencyLimit);
        this.poller = new AdaptivePoller();
        this.fetchFn = config.fetchFn ?? globalThis.fetch;
    }
    /**
     * Execute a single collection cycle.
     *
     * 1. Read credentials from provider
     * 2. Try OAuth API (authoritative)
     * 3. Fall back to JSONL if OAuth fails/disabled
     * 4. Update the QuotaTracker with new state
     * 5. Update adaptive polling interval
     * 6. Emit events (token_expired, threshold_crossed, etc.)
     */
    async collect() {
        const startTime = Date.now();
        const errors = [];
        let result = {
            success: false,
            dataSource: 'none',
            dataConfidence: 'none',
            state: null,
            durationMs: 0,
            errors,
        };
        try {
            // Step 1: Read credentials
            const creds = await this.provider.readCredentials();
            const tokenState = classifyToken(creds);
            // Emit token state events
            if (tokenState === 'expired') {
                this.emit('token_expired', {
                    email: creds?.email ?? 'unknown',
                    expiredAt: creds?.expiresAt ? new Date(creds.expiresAt).toISOString() : 'unknown',
                });
            }
            else if (tokenState === 'expiring_soon') {
                this.emit('token_expiring', {
                    email: creds?.email ?? 'unknown',
                    expiresAt: creds?.expiresAt ? new Date(creds.expiresAt).toISOString() : 'unknown',
                });
            }
            // Step 2: Try OAuth API
            const oauthCircuitOpen = this.oauthBackoffUntil !== null && Date.now() < this.oauthBackoffUntil;
            if (this.config.oauthEnabled && creds?.accessToken && tokenState !== 'expired' && !oauthCircuitOpen) {
                try {
                    const oauthResult = await this.collectFromOAuth(creds.accessToken);
                    // Any non-throwing response means the OAuth endpoint is reachable — reset circuit breaker
                    this.oauthConsecutive429s = 0;
                    this.oauthBackoffUntil = null;
                    if (oauthResult) {
                        result = {
                            ...result,
                            success: true,
                            dataSource: 'oauth',
                            dataConfidence: 'authoritative',
                            state: oauthResult.state,
                            oauth: oauthResult.oauth,
                            account: oauthResult.account,
                        };
                    }
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`OAuth collection failed: ${msg}`);
                    // Circuit breaker: track consecutive 429s to prevent runaway polling
                    if (msg.includes('429')) {
                        this.oauthConsecutive429s++;
                        if (this.oauthConsecutive429s >= QuotaCollector.OAUTH_429_TRIP_COUNT) {
                            this.oauthBackoffUntil = Date.now() + QuotaCollector.OAUTH_BACKOFF_MS;
                            const backoffMin = Math.round(QuotaCollector.OAUTH_BACKOFF_MS / 60000);
                            errors.push(`OAuth circuit breaker tripped after ${this.oauthConsecutive429s} consecutive 429s — ` +
                                `pausing OAuth for ${backoffMin} minutes`);
                        }
                    }
                    DegradationReporter.getInstance().report({
                        feature: 'QuotaCollector.collect.oauth',
                        primary: 'Collect quota data from Anthropic OAuth API',
                        fallback: 'Falling back to JSONL-based estimation (lower confidence)',
                        reason: `OAuth failed: ${msg}`,
                        impact: 'Quota data may be estimated rather than authoritative',
                    });
                    // 401 means token expired — emit event
                    if (msg.includes('401')) {
                        this.emit('token_expired', {
                            email: creds?.email ?? 'unknown',
                            expiredAt: new Date().toISOString(),
                        });
                    }
                }
            }
            // Step 3: JSONL fallback if OAuth failed/disabled
            if (!result.success && this.config.jsonlFallback?.enabled !== false) {
                try {
                    const jsonlResult = this.collectFromJsonl();
                    if (jsonlResult) {
                        result = {
                            ...result,
                            success: true,
                            dataSource: 'jsonl-fallback',
                            dataConfidence: 'estimated',
                            state: jsonlResult,
                        };
                    }
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`JSONL fallback failed: ${msg}`);
                    DegradationReporter.getInstance().report({
                        feature: 'QuotaCollector.collect.jsonlFallback',
                        primary: 'Collect quota data from JSONL conversation files',
                        fallback: 'No quota data available from any source',
                        reason: `JSONL fallback failed: ${msg}`,
                        impact: 'Quota tracking unavailable — spawn gating and migration cannot operate',
                    });
                    this.emit('jsonl_parse_error', { path: this.getJsonlDir(), error: msg });
                }
            }
            // Step 4: Multi-account polling
            if (this.config.registryPath && result.success) {
                try {
                    result.accountSnapshots = await this.pollMultipleAccounts();
                }
                catch (err) {
                    errors.push(`Multi-account polling failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            // Step 5: Update QuotaTracker
            if (result.state) {
                try {
                    this.tracker.updateState(result.state);
                }
                catch (err) {
                    errors.push(`Failed to update tracker: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            // Step 6: Update adaptive polling
            if (result.state) {
                this.poller.update(result.state.usagePercent, result.state.fiveHourPercent);
            }
        }
        catch (err) {
            errors.push(`Collection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const durationMs = Date.now() - startTime;
        result.durationMs = durationMs;
        result.errors = errors;
        this.lastCollectionAt = new Date();
        this.lastCollectionDurationMs = durationMs;
        return result;
    }
    /**
     * Get the current adaptive polling interval in milliseconds.
     */
    getPollingIntervalMs() {
        return this.poller.getState().currentIntervalMs;
    }
    /**
     * Get the polling state for status reporting.
     */
    getPollingState() {
        return this.poller.getState();
    }
    /**
     * Get request budget status.
     */
    getBudgetStatus() {
        const now = Date.now();
        return {
            used: this.budget.used,
            remaining: this.budget.remaining,
            limit: this.config.requestBudgetPer5Min,
            resetsAt: this.budget.resetsAt.toISOString(),
            oauthCircuitBreaker: {
                open: this.oauthBackoffUntil !== null && now < this.oauthBackoffUntil,
                consecutive429s: this.oauthConsecutive429s,
                backoffUntil: this.oauthBackoffUntil ? new Date(this.oauthBackoffUntil).toISOString() : null,
            },
        };
    }
    /**
     * Get the last collection timestamp.
     */
    getLastCollectionAt() {
        return this.lastCollectionAt;
    }
    /**
     * Get the last collection duration.
     */
    getLastCollectionDurationMs() {
        return this.lastCollectionDurationMs;
    }
    // ── Private: OAuth Collection ────────────────────────────────────
    async collectFromOAuth(token) {
        // Check request budget
        if (!this.budget.canRequest()) {
            throw new Error('Request budget exhausted for current window');
        }
        // Fetch usage data with retry
        const usageData = await this.oauthGet('usage', token);
        if (!usageData?.seven_day)
            return null;
        const weeklyUtil = Math.round(usageData.seven_day.utilization * 10) / 10;
        const fiveHourUtil = usageData.five_hour
            ? Math.round(usageData.five_hour.utilization * 10) / 10
            : undefined;
        // Build QuotaState (compatible with existing QuotaTracker)
        const state = {
            usagePercent: weeklyUtil,
            fiveHourPercent: fiveHourUtil,
            lastUpdated: new Date().toISOString(),
        };
        // OAuth details
        const oauth = {
            weeklyUtilization: weeklyUtil,
            weeklyResetsAt: usageData.seven_day?.resets_at ?? null,
            fiveHourUtilization: fiveHourUtil ?? null,
            fiveHourResetsAt: usageData.five_hour?.resets_at ?? null,
            sonnetUtilization: usageData.seven_day_sonnet
                ? Math.round(usageData.seven_day_sonnet.utilization * 10) / 10
                : null,
            opusUtilization: usageData.seven_day_opus
                ? Math.round(usageData.seven_day_opus.utilization * 10) / 10
                : null,
        };
        // Try to get profile (non-critical — don't fail collection if this fails)
        let account;
        try {
            if (this.budget.canRequest()) {
                const profileData = await this.oauthGet('profile', token);
                if (profileData) {
                    account = {
                        name: profileData.account?.full_name ?? null,
                        email: profileData.account?.email ?? null,
                        hasClaudeMax: profileData.account?.has_claude_max ?? false,
                        hasClaudePro: profileData.account?.has_claude_pro ?? false,
                        organizationType: profileData.organization?.organization_type ?? null,
                        rateLimitTier: profileData.organization?.rate_limit_tier ?? null,
                        subscriptionStatus: profileData.organization?.subscription_status ?? null,
                    };
                }
            }
        }
        catch {
            // @silent-fallback-ok — profile fetch is non-critical; usage data is sufficient
        }
        return { state, oauth, account };
    }
    async oauthGet(endpoint, token) {
        if (!this.budget.consume()) {
            throw new Error('Request budget exhausted');
        }
        return RetryHelper.withRetry(async () => {
            const response = await this.fetchFn(`https://api.anthropic.com/api/oauth/${endpoint}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'anthropic-beta': 'oauth-2025-04-20',
                },
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) {
                const retryAfter = response.headers.get('retry-after');
                const msg = `OAuth ${endpoint} returned ${response.status}${retryAfter ? ` retry-after: ${retryAfter}` : ''}`;
                throw new Error(msg);
            }
            return response.json();
        }, this.retryConfig);
    }
    // ── Private: JSONL Fallback ──────────────────────────────────────
    collectFromJsonl() {
        const projectsDir = this.getJsonlDir();
        if (!fs.existsSync(projectsDir))
            return null;
        // Look at files from the last 7 days
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const files = JsonlParser.findFiles(projectsDir, sevenDaysAgo);
        if (files.length === 0)
            return null;
        const windowStart = new Date(sevenDaysAgo);
        const windowEnd = new Date();
        let totalCounts = {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalBilled: 0,
        };
        for (const file of files) {
            const counts = JsonlParser.parseFile(file, windowStart, windowEnd);
            totalCounts.inputTokens += counts.inputTokens;
            totalCounts.outputTokens += counts.outputTokens;
            totalCounts.cacheCreationTokens += counts.cacheCreationTokens;
            totalCounts.cacheReadTokens += counts.cacheReadTokens;
            totalCounts.totalBilled += counts.totalBilled;
        }
        if (totalCounts.totalBilled === 0)
            return null;
        const estimatedPercent = JsonlParser.estimateUtilization(totalCounts);
        return {
            usagePercent: estimatedPercent,
            lastUpdated: new Date().toISOString(),
        };
    }
    getJsonlDir() {
        return this.config.jsonlFallback?.claudeProjectsDir
            ?? path.join(os.homedir(), '.claude', 'projects');
    }
    // ── Private: Multi-Account Polling ───────────────────────────────
    async pollMultipleAccounts() {
        if (!this.config.registryPath)
            return [];
        let registry;
        try {
            if (!fs.existsSync(this.config.registryPath))
                return [];
            registry = JSON.parse(fs.readFileSync(this.config.registryPath, 'utf-8'));
        }
        catch {
            // @silent-fallback-ok — registry may be missing or corrupt
            return [];
        }
        const snapshots = [];
        const activeEmail = registry.activeAccountEmail;
        const accounts = Object.entries(registry.accounts)
            .filter(([email]) => email !== activeEmail); // Active account already collected
        const tasks = accounts.map(([email, acct]) => {
            return this.limiter.run(async () => {
                if (!acct.cachedOAuth?.accessToken) {
                    snapshots.push({
                        email,
                        percentUsed: acct.lastQuotaSnapshot?.percentUsed ?? 0,
                        fiveHourUtilization: acct.lastQuotaSnapshot?.fiveHourUtilization ?? null,
                        isStale: true,
                        error: 'No cached token',
                    });
                    return;
                }
                // Check token expiry
                if (acct.cachedOAuth.expiresAt && acct.cachedOAuth.expiresAt < Date.now()) {
                    snapshots.push({
                        email,
                        percentUsed: acct.lastQuotaSnapshot?.percentUsed ?? 0,
                        fiveHourUtilization: acct.lastQuotaSnapshot?.fiveHourUtilization ?? null,
                        isStale: true,
                        error: 'Token expired',
                    });
                    return;
                }
                // Try to fetch usage
                try {
                    if (!this.budget.canRequest()) {
                        snapshots.push({
                            email,
                            percentUsed: acct.lastQuotaSnapshot?.percentUsed ?? 0,
                            fiveHourUtilization: acct.lastQuotaSnapshot?.fiveHourUtilization ?? null,
                            isStale: true,
                            error: 'Request budget exhausted',
                        });
                        return;
                    }
                    const usage = await this.oauthGet('usage', acct.cachedOAuth.accessToken);
                    if (usage?.seven_day) {
                        const percent = Math.round(usage.seven_day.utilization * 10) / 10;
                        const fiveHour = usage.five_hour
                            ? Math.round(usage.five_hour.utilization * 10) / 10
                            : null;
                        snapshots.push({
                            email,
                            percentUsed: percent,
                            fiveHourUtilization: fiveHour,
                            isStale: false,
                        });
                    }
                    else {
                        snapshots.push({
                            email,
                            percentUsed: acct.lastQuotaSnapshot?.percentUsed ?? 0,
                            fiveHourUtilization: acct.lastQuotaSnapshot?.fiveHourUtilization ?? null,
                            isStale: true,
                            error: 'OAuth returned no usage data',
                        });
                    }
                }
                catch (err) {
                    snapshots.push({
                        email,
                        percentUsed: acct.lastQuotaSnapshot?.percentUsed ?? 0,
                        fiveHourUtilization: acct.lastQuotaSnapshot?.fiveHourUtilization ?? null,
                        isStale: true,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            });
        });
        await Promise.all(tasks);
        return snapshots;
    }
}
//# sourceMappingURL=QuotaCollector.js.map