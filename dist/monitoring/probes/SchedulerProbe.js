/**
 * Scheduler Probe — Tier 1 (Core Survival)
 *
 * Verifies the job scheduler is correctly loading, scheduling, and tracking jobs.
 * Does NOT execute jobs.
 */
import fs from 'node:fs';
export function createSchedulerProbes(deps) {
    const tier = 1;
    const feature = 'Job Scheduler';
    const timeoutMs = 5000;
    const prerequisites = () => {
        // Scheduler may not be enabled in all setups
        try {
            deps.getStatus();
            return true;
        }
        catch { // @silent-fallback-ok — prerequisites return false to skip probe, not a degradation
            return false;
        }
    };
    return [
        {
            id: 'instar.scheduler.loaded',
            name: 'Scheduler Jobs Loaded',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const jobs = deps.getJobs();
                    if (!Array.isArray(jobs)) {
                        return {
                            ...base,
                            passed: false,
                            description: 'getJobs() returned non-array',
                            error: `Expected array, got ${typeof jobs}`,
                            remediation: ['Check JobScheduler initialization'],
                        };
                    }
                    // Cross-reference with jobs.json if it exists
                    let fileJobCount = null;
                    try {
                        if (fs.existsSync(deps.jobsFilePath)) {
                            const content = fs.readFileSync(deps.jobsFilePath, 'utf-8');
                            const parsed = JSON.parse(content);
                            fileJobCount = Array.isArray(parsed) ? parsed.length
                                : Array.isArray(parsed.jobs) ? parsed.jobs.length
                                    : null;
                        }
                    }
                    catch {
                        // jobs.json may not be valid JSON — that's a signal worth reporting
                    }
                    const mismatch = fileJobCount !== null && fileJobCount !== jobs.length;
                    if (mismatch) {
                        return {
                            ...base,
                            passed: false,
                            description: `Job count mismatch: scheduler has ${jobs.length}, jobs.json has ${fileJobCount}`,
                            expected: `${fileJobCount} jobs (from jobs.json)`,
                            actual: `${jobs.length} jobs loaded in scheduler`,
                            diagnostics: { schedulerCount: jobs.length, fileCount: fileJobCount },
                            remediation: [
                                'jobs.json may have been edited while the scheduler was running',
                                'Restart the server to reload job definitions',
                            ],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `${jobs.length} job(s) loaded${fileJobCount !== null ? ' (matches jobs.json)' : ''}`,
                        diagnostics: { count: jobs.length },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to get job definitions',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check JobScheduler initialization and jobs.json format'],
                    };
                }
            },
        },
        {
            id: 'instar.scheduler.running',
            name: 'Scheduler Running',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const status = deps.getStatus();
                    if (!status.running) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Scheduler is not running',
                            error: 'Scheduler stopped — jobs are not being executed',
                            diagnostics: { status },
                            remediation: [
                                'Scheduler may have hit an unhandled exception',
                                'Check server logs for scheduler errors',
                                'Restart the server',
                            ],
                        };
                    }
                    if (status.paused) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Scheduler is paused',
                            error: 'Scheduler is running but paused — jobs are queued but not executing',
                            diagnostics: { status },
                            remediation: [
                                'This may be intentional (e.g., during maintenance)',
                                'Unpause via API: POST /scheduler/resume',
                            ],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `Scheduler running: ${status.enabledJobs} enabled jobs, ${status.queueLength} queued`,
                        diagnostics: { status },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to get scheduler status',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check JobScheduler — may not be properly initialized'],
                    };
                }
            },
        },
        {
            id: 'instar.scheduler.queue',
            name: 'Scheduler Queue Health',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const status = deps.getStatus();
                    // A very large queue suggests jobs are backing up
                    const queueThreshold = 20;
                    if (status.queueLength > queueThreshold) {
                        return {
                            ...base,
                            passed: false,
                            description: `Queue backlog: ${status.queueLength} jobs queued`,
                            error: `Queue has ${status.queueLength} items (threshold: ${queueThreshold})`,
                            diagnostics: { queueLength: status.queueLength, threshold: queueThreshold },
                            remediation: [
                                'Jobs may be queuing faster than they can execute',
                                'Check if sessions are at capacity (job execution requires sessions)',
                                'Consider increasing maxSessions or reducing job frequency',
                            ],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `Queue healthy: ${status.queueLength} pending`,
                        diagnostics: { queueLength: status.queueLength },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to check scheduler queue',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check JobScheduler queue state'],
                    };
                }
            },
        },
    ];
}
//# sourceMappingURL=SchedulerProbe.js.map