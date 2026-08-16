/**
 * Session Probe — Tier 1 (Core Survival)
 *
 * Verifies the session management system can track, query, and report on sessions.
 * Does NOT spawn sessions (expensive, uses quota).
 */
import { execFileSync } from 'node:child_process';
export function createSessionProbes(deps) {
    const tier = 1;
    const feature = 'Session Management';
    const timeoutMs = 5000; // Tier 1: fast
    const prerequisites = () => {
        try {
            execFileSync(deps.tmuxPath, ['-V'], { encoding: 'utf-8', timeout: 3000 });
            return true;
        }
        catch { // @silent-fallback-ok — prerequisites return false to skip probe, not a degradation
            return false;
        }
    };
    return [
        {
            id: 'instar.session.list',
            name: 'Session List',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const sessions = deps.listRunningSessions();
                    if (!Array.isArray(sessions)) {
                        return {
                            ...base,
                            passed: false,
                            description: 'listRunningSessions() returned non-array',
                            error: `Expected array, got ${typeof sessions}`,
                            remediation: ['Check StateManager — sessions.json may be corrupt'],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `Listed ${sessions.length} running session(s)`,
                        diagnostics: { count: sessions.length },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to list sessions',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: [
                            'Check StateManager — sessions.json may be corrupt or locked',
                            'Check tmux availability — sessions may exist in state but not in tmux',
                        ],
                    };
                }
            },
        },
        {
            id: 'instar.session.diagnostics',
            name: 'Session Diagnostics',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const diag = deps.getSessionDiagnostics();
                    if (!diag || !Array.isArray(diag.sessions)) {
                        return {
                            ...base,
                            passed: false,
                            description: 'getSessionDiagnostics() returned invalid structure',
                            error: 'Expected { sessions: Array }, got unexpected shape',
                            remediation: ['Check SessionManager.getSessionDiagnostics() implementation'],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `Diagnostics available for ${diag.sessions.length} session(s)`,
                        diagnostics: {
                            sessionCount: diag.sessions.length,
                            oldestMinutes: diag.sessions.length > 0
                                ? Math.max(...diag.sessions.map(s => s.ageMinutes))
                                : 0,
                        },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to get session diagnostics',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: [
                            'tmux may have crashed — sessions exist in state but not in tmux',
                            'Check if tmux server is running: tmux list-sessions',
                        ],
                    };
                }
            },
        },
        {
            id: 'instar.session.limits',
            name: 'Session Limit Consistency',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const sessions = deps.listRunningSessions();
                    const count = sessions.length;
                    const max = deps.maxSessions;
                    if (max <= 0) {
                        return {
                            ...base,
                            passed: false,
                            description: 'maxSessions is invalid',
                            error: `maxSessions = ${max} (must be > 0)`,
                            remediation: ['Check config.sessions.maxSessions — must be a positive integer'],
                        };
                    }
                    // Session count should never exceed 3x maxSessions (the absolute limit)
                    const absoluteLimit = max * 3;
                    if (count > absoluteLimit) {
                        return {
                            ...base,
                            passed: false,
                            description: 'Session count exceeds absolute limit',
                            error: `${count} sessions running, absolute limit is ${absoluteLimit} (3x maxSessions=${max})`,
                            expected: `<= ${absoluteLimit} sessions`,
                            actual: `${count} sessions`,
                            remediation: [
                                'Kill excess sessions: instar nuke or manually terminate tmux sessions',
                                'Check OrphanProcessReaper — it should prevent this accumulation',
                            ],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `${count}/${max} sessions (within limits)`,
                        diagnostics: { running: count, maxSessions: max, absoluteLimit },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to verify session limits',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check SessionManager and config for consistency'],
                    };
                }
            },
        },
        {
            id: 'instar.session.tmux-alive',
            name: 'Session tmux Verification',
            tier,
            feature,
            timeoutMs,
            prerequisites,
            async run() {
                const base = { probeId: this.id, name: this.name, tier, durationMs: 0 };
                try {
                    const sessions = deps.listRunningSessions();
                    if (sessions.length === 0) {
                        return {
                            ...base,
                            passed: true,
                            description: 'No running sessions to verify',
                        };
                    }
                    const orphans = [];
                    for (const session of sessions) {
                        try {
                            execFileSync(deps.tmuxPath, ['has-session', '-t', session.tmuxSession], {
                                encoding: 'utf-8',
                                timeout: 3000,
                                stdio: ['pipe', 'pipe', 'pipe'],
                            });
                        }
                        catch {
                            orphans.push(session.tmuxSession);
                        }
                    }
                    if (orphans.length > 0) {
                        return {
                            ...base,
                            passed: false,
                            description: `${orphans.length} session(s) in state but missing from tmux`,
                            error: `Orphaned session state: ${orphans.join(', ')}`,
                            diagnostics: { orphans, total: sessions.length },
                            remediation: [
                                'These sessions exist in sessions.json but not in tmux',
                                'Run session reaping to clean up: the SessionManager monitor tick should handle this',
                                'If persistent, check if tmux server crashed and restarted',
                            ],
                        };
                    }
                    return {
                        ...base,
                        passed: true,
                        description: `All ${sessions.length} session(s) verified alive in tmux`,
                        diagnostics: { verified: sessions.length },
                    };
                }
                catch (err) {
                    return {
                        ...base,
                        passed: false,
                        description: 'Failed to verify tmux sessions',
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                        remediation: ['Check tmux binary availability and permissions'],
                    };
                }
            },
        },
    ];
}
//# sourceMappingURL=SessionProbe.js.map