/**
 * Messaging Probe — Tier 1 (Core Survival)
 *
 * Verifies the Telegram adapter is connected and capable of message flow.
 * Does NOT send real messages.
 */
import fs from 'node:fs';
export function createMessagingProbes(deps) {
    const tier = 1;
    const feature = 'Telegram Messaging';
    const timeoutMs = 5000;
    const prerequisites = () => deps.isConfigured();
    return [
        {
            id: 'instar.messaging.connected',
            name: 'Telegram Connected',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const status = deps.getStatus();
                    if (!status.started) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Telegram adapter is not started',
                            error: 'Adapter exists but polling is not active',
                            diagnostics: { status },
                            remediation: [
                                'Check bot token validity — an invalid token prevents polling start',
                                'Check network connectivity to api.telegram.org',
                                'Check server logs for Telegram adapter errors on startup',
                            ],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `Telegram connected (uptime: ${status.uptime ? Math.round(status.uptime / 60000) + 'm' : 'unknown'})`,
                        diagnostics: { status },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to get Telegram status',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check TelegramAdapter — may not be properly initialized'],
                    };
                }
            },
        },
        {
            id: 'instar.messaging.polling',
            name: 'Telegram Polling Active',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const status = deps.getStatus();
                    if (!status.started) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Polling is not active',
                            error: 'Telegram adapter not started — cannot poll for messages',
                            remediation: ['Adapter must be started for polling to work'],
                        };
                    }
                    // Check uptime — if it's null, adapter may have just restarted
                    if (status.uptime !== null && status.uptime < 0) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Adapter uptime is negative — clock skew detected',
                            error: `Uptime: ${status.uptime}ms`,
                            remediation: ['System clock may have been adjusted — restart adapter'],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: 'Polling active',
                        diagnostics: {
                            uptime: status.uptime,
                            pendingStalls: status.pendingStalls,
                            pendingPromises: status.pendingPromises,
                        },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to check polling status',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check TelegramAdapter status method'],
                    };
                }
            },
        },
        {
            id: 'instar.messaging.log',
            name: 'Message Log Health',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    if (!fs.existsSync(deps.messageLogPath)) {
                        return {
                            ...base,
                            passed: true, // Not a failure — log may not exist yet
                            description: 'Message log does not exist yet (no messages received)',
                            diagnostics: { path: deps.messageLogPath, exists: false },
                        };
                    }
                    const stat = fs.statSync(deps.messageLogPath);
                    const ageMs = Date.now() - stat.mtimeMs;
                    const ageHours = ageMs / (1000 * 60 * 60);
                    // If the log hasn't been written to in 24h, it may indicate a problem
                    // (unless the bot simply hasn't received any messages)
                    const staleThresholdHours = 24;
                    if (ageHours > staleThresholdHours) {
                        return {
                            ...base,
                            passed: true, // Degraded but not failing — could just be quiet
                            description: `Message log last modified ${ageHours.toFixed(1)}h ago (may be stale)`,
                            diagnostics: {
                                path: deps.messageLogPath,
                                lastModified: new Date(stat.mtimeMs).toISOString(),
                                ageHours: Math.round(ageHours * 10) / 10,
                                sizeBytes: stat.size,
                            },
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `Message log active (last write: ${ageHours.toFixed(1)}h ago, ${(stat.size / 1024).toFixed(0)}KB)`,
                        diagnostics: {
                            lastModified: new Date(stat.mtimeMs).toISOString(),
                            ageHours: Math.round(ageHours * 10) / 10,
                            sizeBytes: stat.size,
                        },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to check message log',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: [
                            'Check file permissions on the message log',
                            `Expected path: ${deps.messageLogPath}`,
                        ],
                    };
                }
            },
        },
        {
            id: 'instar.messaging.topics',
            name: 'Topic Mapping',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const status = deps.getStatus();
                    if (status.topicMappings === 0) {
                        return {
                            ...base,
                            passed: true, // Not a failure — just means no users onboarded
                            description: 'No topic mappings (no users onboarded yet)',
                            diagnostics: { topicMappings: 0 },
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `${status.topicMappings} topic mapping(s) active`,
                        diagnostics: { topicMappings: status.topicMappings },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to check topic mappings',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check TelegramAdapter topic mapping state'],
                    };
                }
            },
        },
    ];
}
//# sourceMappingURL=MessagingProbe.js.map