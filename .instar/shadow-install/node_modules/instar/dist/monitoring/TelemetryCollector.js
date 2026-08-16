/**
 * TelemetryCollector — Collects and aggregates metrics for Baseline telemetry submissions.
 *
 * Reads from SkipLedger and JobRunHistory to compute per-job and agent-level
 * metrics for a 6-hour submission window. Produces BaselineSubmission payloads
 * ready for signing and transmission.
 *
 * Design:
 *   - Reads only from existing ledger files (no new data stores)
 *   - Stateless: computes metrics fresh each window from ledger data
 *   - Maps internal SkipReasons to Baseline's telemetry-specific taxonomy
 *   - Caps all count fields at 10,000 per spec validation requirements
 */
import os from 'node:os';
const COUNT_CAP = 10_000;
const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Feature flags safe to include in telemetry (usage/adoption only, never security-posture) */
const FEATURE_WHITELIST = [
    'threadline',
    'telemetry',
    'evolution',
    'playbook',
    'publishing',
    'tunnel',
    'relationships',
    'promptGate',
    'triage',
    'triageOrchestrator',
];
/**
 * Map internal SkipReasons to Baseline's telemetry taxonomy.
 * Some internal reasons don't have a 1:1 mapping.
 */
function mapSkipReason(reason) {
    switch (reason) {
        case 'quota': return 'quota';
        case 'disabled': return 'disabled';
        case 'paused': return 'disabled'; // Paused is a form of explicit disable
        case 'capacity': return 'priority'; // Capacity constraint = priority-like
        case 'claimed': return null; // Multi-machine internal, not relevant to telemetry
        case 'machine-scope': return null; // Multi-machine internal
        default: return null;
    }
}
export class TelemetryCollector {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Build a complete Baseline submission payload for the given window.
     */
    collect(installationId, windowStart, windowEnd) {
        const windowHours = (windowEnd.getTime() - windowStart.getTime()) / 3600000;
        const sinceHours = Math.ceil(windowHours);
        return {
            v: 1,
            installationId,
            version: this.deps.version,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            agent: this.collectAgentMetrics(),
            jobs: this.collectJobMetrics(sinceHours, windowStart, windowEnd),
        };
    }
    collectAgentMetrics() {
        const jobs = this.deps.getJobs();
        const enabledJobs = jobs.filter(j => j.enabled);
        const sessionCount = this.deps.getSessionCount24h();
        const config = this.deps.getConfig();
        // Extract feature flags from config (whitelist only)
        const features = {};
        for (const flag of FEATURE_WHITELIST) {
            features[flag] = this.resolveFeatureFlag(config, flag);
        }
        // Quota pressure from skip ledger (last 24h)
        const quotaSkips = this.deps.skipLedger.getSkips({ reason: 'quota', sinceHours: 24 });
        const metrics = {
            version: this.deps.version,
            nodeVersion: process.version.replace('v', ''),
            os: os.platform(),
            arch: os.arch(),
            uptimeHours: Math.round((Date.now() - this.deps.startTime) / 3600000 * 10) / 10,
            totalJobs: cap(jobs.length),
            enabledJobs: cap(enabledJobs.length),
            disabledJobs: cap(jobs.length - enabledJobs.length),
            features,
            sessionsBucket: bucketSessions(sessionCount),
            gateTriggersLast24h: cap(quotaSkips.length),
            blocksLast24h: cap(quotaSkips.length), // Currently same signal; can split later
        };
        // Watchdog metrics (if available)
        if (this.deps.getWatchdogStats) {
            const sinceMs = Date.now() - 24 * 60 * 60 * 1000; // Last 24h
            const wdStats = this.deps.getWatchdogStats(sinceMs);
            metrics.watchdog = {
                interventions: cap(wdStats.interventionsTotal),
                byLevel: wdStats.interventionsByLevel,
                recoveries: cap(wdStats.recoveries),
                deaths: cap(wdStats.sessionDeaths),
                llmGateOverrides: cap(wdStats.llmGateOverrides),
            };
        }
        // Mechanical recovery metrics (if available)
        if (this.deps.getRecoveryStats) {
            const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
            const rs = this.deps.getRecoveryStats(sinceMs);
            metrics.recovery = {
                attempts: { stall: cap(rs.attempts.stall), crash: cap(rs.attempts.crash), errorLoop: cap(rs.attempts.errorLoop) },
                successes: { stall: cap(rs.successes.stall), crash: cap(rs.successes.crash), errorLoop: cap(rs.successes.errorLoop) },
            };
        }
        // Triage orchestrator metrics (if available)
        if (this.deps.getTriageStats) {
            const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
            const ts = this.deps.getTriageStats(sinceMs);
            metrics.triage = {
                activations: cap(ts.activations),
                heuristicResolutions: cap(ts.heuristicResolutions),
                llmResolutions: cap(ts.llmResolutions),
                failures: cap(ts.failures),
                actionCounts: ts.actionCounts,
            };
        }
        // Notification batcher metrics (if available)
        if (this.deps.getNotificationStats) {
            const ns = this.deps.getNotificationStats();
            metrics.notifications = {
                flushed: cap(ns.flushed),
                suppressed: cap(ns.suppressed),
                summaryQueueSize: cap(ns.summaryQueueSize),
                digestQueueSize: cap(ns.digestQueueSize),
            };
        }
        // Process staleness metrics (if available)
        if (this.deps.getStalenessStats) {
            metrics.staleness = this.deps.getStalenessStats();
        }
        return metrics;
    }
    collectJobMetrics(sinceHours, windowStart, windowEnd) {
        const skips = this.collectSkipMetrics(sinceHours);
        const runs = this.getRunsInWindow(windowStart, windowEnd);
        const results = this.collectResultMetrics(runs);
        const durations = this.collectDurationMetrics(runs);
        const models = this.collectModelMetrics(runs);
        const adherence = this.collectAdherenceMetrics(windowStart, windowEnd);
        return { skips, results, durations, models, adherence };
    }
    collectSkipMetrics(sinceHours) {
        const rawSkips = this.deps.skipLedger.getSkips({ sinceHours });
        const counts = new Map();
        for (const skip of rawSkips) {
            if (!SLUG_RE.test(skip.slug))
                continue;
            const reason = mapSkipReason(skip.reason);
            if (!reason)
                continue;
            const key = `${skip.slug}:${reason}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const metrics = [];
        for (const [key, count] of counts) {
            const [slug, reason] = key.split(':');
            metrics.push({ slug, reason: reason, count: cap(count) });
        }
        return metrics;
    }
    getRunsInWindow(windowStart, windowEnd) {
        // JobRunHistory.query uses sinceHours, so we compute the window in hours
        // and then manually filter to the exact window bounds
        const sinceHours = Math.ceil((Date.now() - windowStart.getTime()) / 3600000);
        const allRuns = this.deps.runHistory.query({
            sinceHours,
            limit: 10000,
        });
        const startISO = windowStart.toISOString();
        const endISO = windowEnd.toISOString();
        return allRuns.runs.filter(r => r.result !== 'pending' &&
            r.startedAt >= startISO &&
            r.startedAt <= endISO);
    }
    collectResultMetrics(runs) {
        const slugMap = new Map();
        for (const run of runs) {
            if (!SLUG_RE.test(run.slug))
                continue;
            const entry = slugMap.get(run.slug) ?? { success: 0, error: 0, timeout: 0 };
            if (run.result === 'success')
                entry.success++;
            else if (run.result === 'failure' || run.result === 'spawn-error')
                entry.error++;
            else if (run.result === 'timeout')
                entry.timeout++;
            slugMap.set(run.slug, entry);
        }
        return Array.from(slugMap.entries()).map(([slug, counts]) => ({
            slug,
            success: cap(counts.success),
            error: cap(counts.error),
            timeout: cap(counts.timeout),
        }));
    }
    collectDurationMetrics(runs) {
        const slugMap = new Map();
        for (const run of runs) {
            if (!SLUG_RE.test(run.slug) || !run.durationSeconds)
                continue;
            const entry = slugMap.get(run.slug) ?? { totalMs: 0, count: 0 };
            entry.totalMs += run.durationSeconds * 1000;
            entry.count++;
            slugMap.set(run.slug, entry);
        }
        return Array.from(slugMap.entries()).map(([slug, data]) => ({
            slug,
            meanMs: Math.round(data.totalMs / data.count),
            count: cap(data.count),
        }));
    }
    collectModelMetrics(runs) {
        const key = (slug, model) => `${slug}:${model}`;
        const counts = new Map();
        for (const run of runs) {
            if (!SLUG_RE.test(run.slug))
                continue;
            const model = run.model ?? 'unknown';
            const k = key(run.slug, model);
            counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return Array.from(counts.entries()).map(([k, runCount]) => {
            const [slug, model] = k.split(':');
            return { slug, model, runCount: cap(runCount) };
        });
    }
    collectAdherenceMetrics(windowStart, windowEnd) {
        const jobs = this.deps.getJobs().filter(j => j.enabled && SLUG_RE.test(j.slug));
        const windowMs = windowEnd.getTime() - windowStart.getTime();
        return jobs.map(job => {
            // Estimate expected runs from schedule (simple heuristic based on expectedDurationMinutes)
            const expectedRuns = this.estimateExpectedRuns(job, windowMs);
            const sinceHours = Math.ceil((Date.now() - windowStart.getTime()) / 3600000);
            const startISO = windowStart.toISOString();
            const endISO = windowEnd.toISOString();
            const actualRuns = this.deps.runHistory.query({
                slug: job.slug,
                sinceHours,
                limit: 10000,
            }).runs.filter(r => r.result !== 'pending' &&
                r.startedAt >= startISO &&
                r.startedAt <= endISO).length;
            return {
                slug: job.slug,
                expectedRuns: cap(expectedRuns),
                actualRuns: cap(actualRuns),
            };
        }).filter(m => m.expectedRuns > 0 || m.actualRuns > 0);
    }
    /**
     * Estimate how many times a job should run in a given window.
     * Parses simple cron patterns for common intervals.
     */
    estimateExpectedRuns(job, windowMs) {
        const schedule = job.schedule;
        const windowHours = windowMs / 3600000;
        // Match common patterns: */N or 0/N in the minute/hour fields
        // "0 */4 * * *" = every 4 hours
        // "*/15 * * * *" = every 15 minutes
        const parts = schedule.split(/\s+/);
        if (parts.length < 5)
            return 0;
        const [minute, hour] = parts;
        // Every N hours
        const hourMatch = hour.match(/^\*\/(\d+)$/) ?? hour.match(/^0\/(\d+)$/);
        if (hourMatch) {
            const intervalHours = parseInt(hourMatch[1], 10);
            return Math.floor(windowHours / intervalHours);
        }
        // Every N minutes
        const minMatch = minute.match(/^\*\/(\d+)$/) ?? minute.match(/^0\/(\d+)$/);
        if (minMatch && (hour === '*' || hour === '*/1')) {
            const intervalMinutes = parseInt(minMatch[1], 10);
            return Math.floor((windowHours * 60) / intervalMinutes);
        }
        // Fixed hour schedule (e.g., "0 6 * * *" = once a day)
        if (/^\d+$/.test(hour) && /^\d+$/.test(minute)) {
            // Once per day — in a 6h window, expect 0 or 1
            return windowHours >= 24 ? 1 : 0;
        }
        // Fallback: assume once per window for enabled jobs
        return 1;
    }
    /**
     * Resolve a feature flag from config. Checks common config paths.
     */
    resolveFeatureFlag(config, flag) {
        // Check monitoring subsection
        const monitoring = config.monitoring;
        if (monitoring) {
            const sub = monitoring[flag];
            if (typeof sub === 'boolean')
                return sub;
            if (sub && typeof sub === 'object' && 'enabled' in sub)
                return !!sub.enabled;
        }
        // Check top-level config sections
        const section = config[flag];
        if (typeof section === 'boolean')
            return section;
        if (section && typeof section === 'object' && 'enabled' in section)
            return !!section.enabled;
        return false;
    }
}
function cap(n) {
    return Math.min(n, COUNT_CAP);
}
function bucketSessions(count) {
    if (count === 0)
        return '0';
    if (count <= 5)
        return '1-5';
    if (count <= 20)
        return '6-20';
    return '20+';
}
//# sourceMappingURL=TelemetryCollector.js.map