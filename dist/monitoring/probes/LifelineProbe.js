/**
 * Lifeline Probe — Tier 1 (Core Survival)
 *
 * Verifies the lifeline process (crash recovery) is alive and functional.
 * Checks the supervisor, queue, and lock file without modifying state.
 */
import fs from 'node:fs';
export function createLifelineProbes(deps) {
    const tier = 1;
    const feature = 'Lifeline';
    const timeoutMs = 5000;
    const prerequisites = () => deps.isEnabled();
    return [
        {
            id: 'instar.lifeline.process',
            name: 'Lifeline Process',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    // Check lock file to verify lifeline is running
                    if (!fs.existsSync(deps.lockFilePath)) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Lifeline lock file not found — process may not be running',
                            error: `Expected lock file at ${deps.lockFilePath}`,
                            remediation: [
                                'Lifeline may not have been started',
                                'Run: instar lifeline start',
                                'Check launch agent/systemd service configuration',
                            ],
                        };
                    }
                    const lockContent = fs.readFileSync(deps.lockFilePath, 'utf-8');
                    let lockData;
                    try {
                        lockData = JSON.parse(lockContent);
                    }
                    catch {
                        return {
                            ...base,
                            passed: false,
                            description: 'Lifeline lock file is corrupt',
                            error: 'Lock file exists but contains invalid JSON',
                            remediation: [
                                'Delete the lock file and restart lifeline',
                                `Path: ${deps.lockFilePath}`,
                            ],
                        };
                    }
                    // Check if the PID is still alive
                    let processAlive = false;
                    try {
                        process.kill(lockData.pid, 0);
                        processAlive = true;
                    }
                    catch {
                        // process.kill(pid, 0) throws if process doesn't exist
                    }
                    if (!processAlive) {
                        return {
                            ...base,
                            passed: false,
                            description: `Lifeline PID ${lockData.pid} is not running (stale lock)`,
                            error: `Lock claims PID ${lockData.pid} started at ${lockData.startedAt}, but process is dead`,
                            diagnostics: { lockData },
                            remediation: [
                                'Lifeline process crashed without cleaning up its lock file',
                                `Delete ${deps.lockFilePath} and restart: instar lifeline start`,
                            ],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `Lifeline process alive (PID ${lockData.pid}, since ${lockData.startedAt})`,
                        diagnostics: { pid: lockData.pid, startedAt: lockData.startedAt },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to check lifeline process',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check lifeline lock file permissions and path'],
                    };
                }
            },
        },
        {
            id: 'instar.lifeline.supervisor',
            name: 'Lifeline Supervisor',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const status = deps.getSupervisorStatus();
                    if (status.circuitBroken) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Supervisor circuit breaker is TRIPPED',
                            error: `${status.totalFailures} total failures — auto-restart disabled`,
                            diagnostics: {
                                totalFailures: status.totalFailures,
                                retryCount: status.circuitBreakerRetryCount,
                                maxRetries: status.maxCircuitBreakerRetries,
                                lastCrashOutput: status.lastCrashOutput?.slice(0, 500),
                            },
                            remediation: [
                                'Circuit breaker tripped due to excessive failures',
                                'Fix the root cause, then run: /lifeline reset',
                                'Check lastCrashOutput in diagnostics for crash details',
                            ],
                        };
                    }
                    if (!status.running) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Supervisor reports server is not running',
                            error: status.coolingDown
                                ? `Server down, cooling down (${Math.round(status.cooldownRemainingMs / 1000)}s remaining)`
                                : `Server down, restart attempts: ${status.restartAttempts}`,
                            diagnostics: {
                                restartAttempts: status.restartAttempts,
                                coolingDown: status.coolingDown,
                                cooldownRemainingMs: status.cooldownRemainingMs,
                            },
                            remediation: [
                                'Server may have crashed — supervisor will auto-restart',
                                'If persistent, check server logs for crash cause',
                                status.coolingDown
                                    ? 'Currently in cooldown — wait or manually restart'
                                    : 'Check restart attempts — approaching circuit breaker threshold',
                            ],
                        };
                    }
                    if (!status.healthy) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Supervisor reports server running but unhealthy',
                            error: status.inMaintenanceWait
                                ? 'Server in maintenance wait (planned restart)'
                                : 'Health checks failing — server may be unresponsive',
                            diagnostics: {
                                lastHealthy: status.lastHealthy
                                    ? new Date(status.lastHealthy).toISOString()
                                    : 'never',
                                inMaintenanceWait: status.inMaintenanceWait,
                                maintenanceWaitElapsedMs: status.maintenanceWaitElapsedMs,
                            },
                            remediation: [
                                status.inMaintenanceWait
                                    ? 'Planned restart in progress — wait for completion'
                                    : 'Server process exists but not responding to health checks',
                                'Check server logs for errors or resource exhaustion',
                            ],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: 'Supervisor healthy — server running and responsive',
                        diagnostics: {
                            running: status.running,
                            healthy: status.healthy,
                            lastHealthy: new Date(status.lastHealthy).toISOString(),
                            totalFailures: status.totalFailures,
                        },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to get supervisor status',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: [
                            'Lifeline supervisor may not be properly initialized',
                            'PID mismatch — lifeline may be watching wrong process',
                        ],
                    };
                }
            },
        },
        {
            id: 'instar.lifeline.queue',
            name: 'Lifeline Queue Health',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const length = deps.getQueueLength();
                    // A very large queue suggests messages aren't being delivered
                    const queueThreshold = 50;
                    if (length > queueThreshold) {
                        const messages = deps.peekQueue();
                        const oldest = messages.length > 0 ? messages[0] : null;
                        const ageMs = oldest ? Date.now() - new Date(oldest.timestamp).getTime() : 0;
                        return {
                            ...base,
                            passed: false,
                            description: `Queue backlog: ${length} messages pending`,
                            error: `Queue has ${length} items (threshold: ${queueThreshold})`,
                            diagnostics: {
                                queueLength: length,
                                threshold: queueThreshold,
                                oldestMessageAge: oldest
                                    ? `${Math.round(ageMs / 60000)}m`
                                    : 'unknown',
                            },
                            remediation: [
                                'Messages are queuing faster than replay can deliver',
                                'Check if the server is accepting forwarded messages',
                                'Queue may be stuck — check /internal/telegram-forward endpoint',
                            ],
                        };
                    }
                    // Check for stale messages (queued > 1 hour = likely stuck)
                    if (length > 0) {
                        const messages = deps.peekQueue();
                        const oldest = messages.length > 0 ? messages[0] : null;
                        const ageMs = oldest ? Date.now() - new Date(oldest.timestamp).getTime() : 0;
                        const staleThresholdMs = 60 * 60 * 1000; // 1 hour
                        if (ageMs > staleThresholdMs) {
                            return {
                                ...base,
                                passed: false,
                                description: `Queue has stale messages (oldest: ${Math.round(ageMs / 60000)}m ago)`,
                                error: `${length} message(s) queued, oldest is ${Math.round(ageMs / 60000)} minutes old`,
                                diagnostics: {
                                    queueLength: length,
                                    oldestTimestamp: oldest?.timestamp,
                                    ageMinutes: Math.round(ageMs / 60000),
                                },
                                remediation: [
                                    'Queue replay may be stuck or server is persistently down',
                                    'Check supervisor health — server may not be accepting messages',
                                    'If server is healthy, check /internal/telegram-forward route',
                                ],
                            };
                        }
                    }
                    return {
                        ...base,
                        passed: true,
                        description: length === 0
                            ? 'Queue empty — all messages delivered'
                            : `Queue has ${length} pending message(s) (within limits)`,
                        diagnostics: { queueLength: length },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to check lifeline queue',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: [
                            'Queue file may be corrupted — check file integrity',
                            'Check lifeline-queue.json for valid JSON',
                        ],
                    };
                }
            },
        },
    ];
}
//# sourceMappingURL=LifelineProbe.js.map