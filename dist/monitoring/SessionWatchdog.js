/**
 * SessionWatchdog — Auto-remediation for stuck Claude sessions (Instar port).
 *
 * Detects when a Claude session has a long-running bash command and escalates
 * from gentle (Ctrl+C) to forceful (SIGKILL + session kill). Adapted from
 * Dawn Server's SessionWatchdog for Instar's self-contained architecture.
 *
 * Escalation pipeline:
 *   Level 0: Monitoring (default)
 *   Level 1: Ctrl+C via tmux send-keys
 *   Level 2: SIGTERM the stuck child PID
 *   Level 3: SIGKILL the stuck child PID
 *   Level 4: Kill tmux session
 */
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
/** Drop-in replacement for execSync that avoids its security concerns. */
function shellExec(cmd, timeout = 5000) {
    return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8', timeout }).stdout ?? '';
}
export var EscalationLevel;
(function (EscalationLevel) {
    EscalationLevel[EscalationLevel["Monitoring"] = 0] = "Monitoring";
    EscalationLevel[EscalationLevel["CtrlC"] = 1] = "CtrlC";
    EscalationLevel[EscalationLevel["SigTerm"] = 2] = "SigTerm";
    EscalationLevel[EscalationLevel["SigKill"] = 3] = "SigKill";
    EscalationLevel[EscalationLevel["KillSession"] = 4] = "KillSession";
})(EscalationLevel || (EscalationLevel = {}));
// Processes that are long-running by design
const EXCLUDED_PATTERNS = [
    'playwright-mcp', 'playwright-persistent', '@playwright/mcp',
    'chrome-native-host', 'claude-in-chrome-mcp', 'payments-mcp',
    'mcp-remote', '/mcp/', '.mcp/', 'caffeinate', 'exa-mcp-server',
    // Shell-snapshot sourcing is session initialization, not a stuck command
    '.claude/shell-snapshots',
];
const EXCLUDED_PREFIXES = [
    '/bin/zsh -c -l source',
    '/bin/bash -c -l source',
    // Shell-snapshot commands don't always include -l flag
    '/bin/zsh -c source',
    '/bin/bash -c source',
];
// Escalation delays (ms to wait before advancing to next level)
const ESCALATION_DELAYS = {
    [EscalationLevel.Monitoring]: 0,
    [EscalationLevel.CtrlC]: 0,
    [EscalationLevel.SigTerm]: 15_000,
    [EscalationLevel.SigKill]: 10_000,
    [EscalationLevel.KillSession]: 5_000,
};
const DEFAULT_STUCK_THRESHOLD_MS = 180_000; // 3 minutes
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_RETRIES = 2;
export class SessionWatchdog extends EventEmitter {
    config;
    sessionManager;
    state;
    interval = null;
    escalationState = new Map();
    interventionHistory = [];
    enabled = true;
    running = false;
    stuckThresholdMs;
    pollIntervalMs;
    logPath;
    /** Intelligence provider — gates escalation entry with LLM command analysis */
    intelligence = null;
    /** Temporarily exempted commands (LLM confirmed as legitimate long-running) */
    temporaryExclusions = new Set(); // PIDs
    /** Counter for LLM gate overrides (said "legitimate") — for telemetry */
    llmGateOverrides = 0;
    /** Pending outcome checks — maps sessionName to intervention event */
    pendingOutcomeChecks = new Map();
    constructor(config, sessionManager, state) {
        super();
        this.config = config;
        this.sessionManager = sessionManager;
        this.state = state;
        const wdConfig = config.monitoring.watchdog;
        this.stuckThresholdMs = (wdConfig?.stuckCommandSec ?? 180) * 1000;
        this.pollIntervalMs = wdConfig?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        // Persistent log path
        this.logPath = path.join(config.stateDir, 'watchdog-interventions.jsonl');
    }
    start() {
        if (this.interval)
            return;
        console.log(`[Watchdog] Starting (poll: ${this.pollIntervalMs / 1000}s, threshold: ${this.stuckThresholdMs / 1000}s)`);
        this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
        setTimeout(() => this.poll(), 5000);
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            this.escalationState.clear();
        }
    }
    isEnabled() {
        return this.enabled;
    }
    isManaging(sessionName) {
        const s = this.escalationState.get(sessionName);
        return s !== undefined && s.level > EscalationLevel.Monitoring;
    }
    getStatus() {
        const runningSessions = this.sessionManager.listRunningSessions();
        const sessions = runningSessions.map(s => ({
            name: s.tmuxSession,
            escalation: this.escalationState.get(s.tmuxSession) ?? null,
        }));
        return {
            enabled: this.enabled,
            sessions,
            interventionHistory: this.interventionHistory.slice(-20),
        };
    }
    // --- Core polling ---
    async poll() {
        if (!this.enabled || this.running)
            return;
        this.running = true;
        try {
            const sessions = this.sessionManager.listRunningSessions();
            for (const session of sessions) {
                try {
                    await this.checkSession(session.tmuxSession);
                }
                catch (err) {
                    console.error(`[Watchdog] Error checking "${session.tmuxSession}":`, err);
                }
            }
        }
        finally {
            this.running = false;
        }
    }
    async checkSession(tmuxSession) {
        const existing = this.escalationState.get(tmuxSession);
        if (existing && existing.level > EscalationLevel.Monitoring) {
            this.handleEscalation(tmuxSession, existing);
            return;
        }
        // Find Claude PID in the tmux session
        const claudePid = this.getClaudePid(tmuxSession);
        if (!claudePid)
            return;
        const children = this.getChildProcesses(claudePid);
        const stuckChild = children.find(c => !this.isExcluded(c.command) &&
            !this.temporaryExclusions.has(c.pid) &&
            c.elapsedMs > this.stuckThresholdMs);
        if (stuckChild) {
            // LLM gate: check if this command is legitimately long-running before escalating
            const isStuck = await this.isCommandStuck(stuckChild.command, stuckChild.elapsedMs);
            if (!isStuck) {
                // LLM says legitimate — temporarily exclude this PID from future checks
                this.temporaryExclusions.add(stuckChild.pid);
                return;
            }
            const state = {
                level: EscalationLevel.CtrlC,
                levelEnteredAt: Date.now(),
                stuckChildPid: stuckChild.pid,
                stuckCommand: stuckChild.command,
                retryCount: existing?.retryCount ?? 0,
            };
            this.escalationState.set(tmuxSession, state);
            console.log(`[Watchdog] "${tmuxSession}": stuck command (${Math.round(stuckChild.elapsedMs / 1000)}s): ` +
                `${stuckChild.command.slice(0, 80)} — sending Ctrl+C`);
            this.sessionManager.sendKey(tmuxSession, 'C-c');
            this.recordIntervention(tmuxSession, EscalationLevel.CtrlC, 'Sent Ctrl+C', stuckChild);
        }
        else if (existing) {
            this.escalationState.delete(tmuxSession);
        }
        // Clean up temporary exclusions for dead processes
        for (const pid of this.temporaryExclusions) {
            if (!this.isProcessAlive(pid)) {
                this.temporaryExclusions.delete(pid);
            }
        }
    }
    handleEscalation(tmuxSession, state) {
        const now = Date.now();
        if (!this.isProcessAlive(state.stuckChildPid)) {
            console.log(`[Watchdog] "${tmuxSession}": stuck process ${state.stuckChildPid} died — recovered`);
            this.emit('recovery', tmuxSession, state.level);
            this.escalationState.delete(tmuxSession);
            return;
        }
        const timeInLevel = now - state.levelEnteredAt;
        const nextLevel = state.level + 1;
        if (nextLevel > EscalationLevel.KillSession) {
            if (state.retryCount >= MAX_RETRIES) {
                console.log(`[Watchdog] "${tmuxSession}": max retries reached — giving up`);
                this.escalationState.delete(tmuxSession);
                return;
            }
            state.level = EscalationLevel.CtrlC;
            state.levelEnteredAt = now;
            state.retryCount++;
            this.sessionManager.sendKey(tmuxSession, 'C-c');
            this.recordIntervention(tmuxSession, EscalationLevel.CtrlC, `Retry ${state.retryCount}: Sent Ctrl+C`, {
                pid: state.stuckChildPid, command: state.stuckCommand, elapsedMs: 0,
            });
            return;
        }
        const delayForNext = ESCALATION_DELAYS[nextLevel] ?? 15_000;
        if (timeInLevel < delayForNext)
            return;
        state.level = nextLevel;
        state.levelEnteredAt = now;
        const child = { pid: state.stuckChildPid, command: state.stuckCommand, elapsedMs: 0 };
        switch (state.level) {
            case EscalationLevel.SigTerm:
                console.log(`[Watchdog] "${tmuxSession}": sending SIGTERM to ${state.stuckChildPid}`);
                this.sendSignal(state.stuckChildPid, 'SIGTERM');
                this.recordIntervention(tmuxSession, EscalationLevel.SigTerm, `SIGTERM ${state.stuckChildPid}`, child);
                break;
            case EscalationLevel.SigKill:
                console.log(`[Watchdog] "${tmuxSession}": sending SIGKILL to ${state.stuckChildPid}`);
                this.sendSignal(state.stuckChildPid, 'SIGKILL');
                this.recordIntervention(tmuxSession, EscalationLevel.SigKill, `SIGKILL ${state.stuckChildPid}`, child);
                break;
            case EscalationLevel.KillSession:
                console.log(`[Watchdog] "${tmuxSession}": killing tmux session`);
                this.killTmuxSession(tmuxSession);
                this.recordIntervention(tmuxSession, EscalationLevel.KillSession, 'Killed tmux session', child);
                this.escalationState.delete(tmuxSession);
                break;
        }
    }
    /**
     * LLM gate: Before entering escalation, ask whether the command is
     * legitimately long-running or actually stuck. This prevents the watchdog
     * from killing legitimate builds, installs, or data processing.
     *
     * Returns true if the command appears stuck and should be escalated.
     * Returns false if the LLM thinks it's a legitimate long-running task.
     * If no LLM is available, returns true (fail-open — stuck commands need recovery).
     */
    async isCommandStuck(command, elapsedMs) {
        if (!this.intelligence)
            return true; // No LLM → fail-open
        const elapsedMin = Math.round(elapsedMs / 60000);
        const prompt = [
            'You are evaluating whether a running process is stuck or legitimately long-running.',
            '',
            `Command: ${command.slice(0, 200)}`,
            `Running for: ${elapsedMin} minutes`,
            '',
            'Legitimate long-running commands include:',
            '- Package installs (npm install, pip install, cargo build, etc.)',
            '- Large builds (webpack, tsc with many files, docker build)',
            '- Database migrations or data processing',
            '- Test suites (pytest, vitest, jest with many tests)',
            '- Network operations (curl large files, git clone large repos)',
            '- Interactive processes (vim, less, ssh sessions)',
            '',
            'Likely stuck commands include:',
            '- Simple commands that should complete in seconds (ls, cat, echo)',
            '- Commands with no output that normally produce output quickly',
            '- Processes that appear to be waiting for input that will never come',
            '',
            'Is this command stuck or legitimate? Respond with exactly one word: stuck or legitimate.',
        ].join('\n');
        try {
            const response = await this.intelligence.evaluate(prompt, {
                maxTokens: 5,
                temperature: 0,
            });
            const answer = response.trim().toLowerCase();
            if (answer === 'legitimate') {
                console.log(`[Watchdog] LLM says "${command.slice(0, 60)}" is legitimate — skipping escalation`);
                this.llmGateOverrides++;
                return false;
            }
            return true;
        }
        catch (err) {
            // @silent-fallback-ok — LLM intelligence is optional; fail-open to recover stuck processes
            console.warn(`[Watchdog] LLM command check failed, assuming stuck:`, err);
            return true; // Fail-open
        }
    }
    // --- Process utilities (self-contained, no shared module) ---
    getClaudePid(tmuxSession) {
        try {
            // Get pane PID
            const panePidStr = shellExec(`${this.config.sessions.tmuxPath} list-panes -t "=${tmuxSession}" -F "#{pane_pid}" 2>/dev/null`).trim().split('\n')[0];
            if (!panePidStr)
                return null;
            const panePid = parseInt(panePidStr, 10);
            if (isNaN(panePid))
                return null;
            // Find claude child
            const claudePidStr = shellExec(`pgrep -P ${panePid} -f claude 2>/dev/null | head -1`).trim();
            if (!claudePidStr)
                return null;
            const pid = parseInt(claudePidStr, 10);
            return isNaN(pid) ? null : pid;
        }
        catch {
            // @silent-fallback-ok — process detection returns null
            return null;
        }
    }
    getChildProcesses(pid) {
        try {
            const childPidsStr = shellExec(`pgrep -P ${pid} 2>/dev/null`).trim();
            if (!childPidsStr)
                return [];
            const childPids = childPidsStr.split('\n').filter(Boolean).join(',');
            if (!childPids)
                return [];
            const output = shellExec(`ps -o pid=,etime=,command= -p ${childPids} 2>/dev/null`).trim();
            if (!output)
                return [];
            const results = [];
            for (const line of output.split('\n')) {
                const match = line.trim().match(/^(\d+)\s+([\d:.-]+)\s+(.+)$/);
                if (!match)
                    continue;
                const childPid = parseInt(match[1], 10);
                if (isNaN(childPid))
                    continue;
                results.push({
                    pid: childPid,
                    command: match[3],
                    elapsedMs: this.parseElapsed(match[2]),
                });
            }
            return results;
        }
        catch {
            // @silent-fallback-ok — process enumeration returns empty
            return [];
        }
    }
    isExcluded(command) {
        for (const pattern of EXCLUDED_PATTERNS) {
            if (command.includes(pattern))
                return true;
        }
        for (const prefix of EXCLUDED_PREFIXES) {
            if (command.startsWith(prefix))
                return true;
        }
        return false;
    }
    parseElapsed(elapsed) {
        let days = 0;
        let timePart = elapsed;
        if (elapsed.includes('-')) {
            const [d, t] = elapsed.split('-');
            days = parseInt(d, 10);
            timePart = t;
        }
        const parts = timePart.split(':').map(Number);
        let seconds = 0;
        if (parts.length === 3)
            seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        else if (parts.length === 2)
            seconds = parts[0] * 60 + parts[1];
        else
            seconds = parts[0];
        return (days * 86400 + seconds) * 1000;
    }
    sendSignal(pid, signal) {
        try {
            process.kill(pid, signal);
        }
        catch (err) {
            // @silent-fallback-ok — ESRCH expected for dead processes
            if (err.code !== 'ESRCH') {
                console.error(`[Watchdog] Failed to send ${signal} to ${pid}:`, err);
            }
        }
    }
    isProcessAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            // @silent-fallback-ok — signal 0 check
            return false;
        }
    }
    killTmuxSession(tmuxSession) {
        try {
            shellExec(`${this.config.sessions.tmuxPath} kill-session -t "=${tmuxSession}" 2>/dev/null`);
        }
        catch { }
    }
    recordIntervention(sessionName, level, action, child) {
        const event = {
            sessionName,
            level,
            action,
            stuckCommand: child.command.slice(0, 200),
            stuckPid: child.pid,
            timestamp: Date.now(),
        };
        this.interventionHistory.push(event);
        if (this.interventionHistory.length > 50) {
            this.interventionHistory = this.interventionHistory.slice(-50);
        }
        this.emit('intervention', event);
        // Schedule outcome check — 60s later, was the session still alive?
        if (level === EscalationLevel.CtrlC) {
            // Only track outcome from the first intervention (Ctrl+C)
            this.pendingOutcomeChecks.set(sessionName, event);
            setTimeout(() => this.checkOutcome(sessionName, event), 60_000);
        }
        // Persist to JSONL
        this.persistEvent(event);
    }
    /**
     * Check session health 60s after an intervention.
     * Did the session recover (still producing output) or die?
     */
    checkOutcome(sessionName, event) {
        const pending = this.pendingOutcomeChecks.get(sessionName);
        if (!pending || pending.timestamp !== event.timestamp)
            return;
        this.pendingOutcomeChecks.delete(sessionName);
        const sessions = this.sessionManager.listRunningSessions();
        const stillRunning = sessions.some(s => s.tmuxSession === sessionName);
        event.outcome = stillRunning ? 'recovered' : 'died';
        event.outcomeDelayMs = Date.now() - event.timestamp;
        // Persist the outcome update
        this.persistEvent({ ...event, _outcomeUpdate: true });
        this.emit('outcome', { sessionName, outcome: event.outcome, level: event.level });
    }
    /**
     * Append an event to the persistent JSONL log.
     * 30-day retention, auto-rotated.
     */
    persistEvent(event) {
        try {
            const dir = path.dirname(this.logPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n');
            maybeRotateJsonl(this.logPath); // 10MB default, keep 75%
        }
        catch {
            // @silent-fallback-ok — persistence failure is non-critical
        }
    }
    /**
     * Read persistent intervention log entries since a given time.
     */
    readLog(sinceMs) {
        try {
            if (!fs.existsSync(this.logPath))
                return [];
            const content = fs.readFileSync(this.logPath, 'utf-8').trim();
            if (!content)
                return [];
            const since = sinceMs ?? 0;
            return content.split('\n')
                .map(line => { try {
                return JSON.parse(line);
            }
            catch {
                return null;
            } })
                .filter((e) => e !== null && e.timestamp >= since);
        }
        catch {
            // @silent-fallback-ok — log read failure returns empty
            return [];
        }
    }
    /**
     * Get aggregated watchdog stats for a time window.
     * Used by TelemetryCollector for Baseline submissions.
     */
    getStats(sinceMs) {
        const events = this.readLog(sinceMs);
        const levelNames = ['monitoring', 'ctrl-c', 'sigterm', 'sigkill', 'kill-session'];
        const stats = {
            interventionsTotal: 0,
            interventionsByLevel: {},
            recoveries: 0,
            sessionDeaths: 0,
            outcomeUnknown: 0,
            llmGateOverrides: this.llmGateOverrides,
        };
        for (const event of events) {
            // Skip outcome update entries
            if (event._outcomeUpdate) {
                if (event.outcome === 'recovered')
                    stats.recoveries++;
                else if (event.outcome === 'died')
                    stats.sessionDeaths++;
                else
                    stats.outcomeUnknown++;
                continue;
            }
            stats.interventionsTotal++;
            const levelName = levelNames[event.level] ?? `level-${event.level}`;
            stats.interventionsByLevel[levelName] = (stats.interventionsByLevel[levelName] || 0) + 1;
        }
        return stats;
    }
    /**
     * Rotate the persistent log — remove entries older than 30 days.
     */
    rotateLog() {
        try {
            if (!fs.existsSync(this.logPath))
                return;
            const content = fs.readFileSync(this.logPath, 'utf-8').trim();
            if (!content)
                return;
            const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const lines = content.split('\n');
            const fresh = lines.filter(line => {
                try {
                    const e = JSON.parse(line);
                    return e.timestamp >= cutoff;
                }
                catch {
                    return false;
                }
            });
            if (fresh.length < lines.length) {
                fs.writeFileSync(this.logPath, fresh.join('\n') + (fresh.length > 0 ? '\n' : ''));
            }
        }
        catch {
            // @silent-fallback-ok — rotation failure is non-critical
        }
    }
}
//# sourceMappingURL=SessionWatchdog.js.map