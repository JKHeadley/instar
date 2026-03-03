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

/** Drop-in replacement for execSync that avoids its security concerns. */
function shellExec(cmd: string, timeout = 5000): string {
  return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8', timeout }).stdout ?? '';
}
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { InstarConfig, IntelligenceProvider } from '../core/types.js';

export enum EscalationLevel {
  Monitoring = 0,
  CtrlC = 1,
  SigTerm = 2,
  SigKill = 3,
  KillSession = 4,
}

interface ChildProcessInfo {
  pid: number;
  command: string;
  elapsedMs: number;
}

interface EscalationState {
  level: EscalationLevel;
  levelEnteredAt: number;
  stuckChildPid: number;
  stuckCommand: string;
  retryCount: number;
}

export interface InterventionEvent {
  sessionName: string;
  level: EscalationLevel;
  action: string;
  stuckCommand: string;
  stuckPid: number;
  timestamp: number;
}

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
const ESCALATION_DELAYS: Record<EscalationLevel, number> = {
  [EscalationLevel.Monitoring]: 0,
  [EscalationLevel.CtrlC]: 0,
  [EscalationLevel.SigTerm]: 15_000,
  [EscalationLevel.SigKill]: 10_000,
  [EscalationLevel.KillSession]: 5_000,
};

const DEFAULT_STUCK_THRESHOLD_MS = 180_000; // 3 minutes
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_RETRIES = 2;

export interface WatchdogEvents {
  intervention: [event: InterventionEvent];
  recovery: [sessionName: string, fromLevel: EscalationLevel];
}

export class SessionWatchdog extends EventEmitter {
  private config: InstarConfig;
  private sessionManager: SessionManager;
  private state: StateManager;
  private interval: ReturnType<typeof setInterval> | null = null;
  private escalationState = new Map<string, EscalationState>();
  private interventionHistory: InterventionEvent[] = [];
  private enabled = true;
  private running = false;

  private stuckThresholdMs: number;
  private pollIntervalMs: number;

  /** Intelligence provider — gates escalation entry with LLM command analysis */
  intelligence: IntelligenceProvider | null = null;

  /** Temporarily exempted commands (LLM confirmed as legitimate long-running) */
  private temporaryExclusions = new Set<number>(); // PIDs

  constructor(config: InstarConfig, sessionManager: SessionManager, state: StateManager) {
    super();
    this.config = config;
    this.sessionManager = sessionManager;
    this.state = state;

    const wdConfig = config.monitoring.watchdog;
    this.stuckThresholdMs = (wdConfig?.stuckCommandSec ?? 180) * 1000;
    this.pollIntervalMs = wdConfig?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.interval) return;
    console.log(`[Watchdog] Starting (poll: ${this.pollIntervalMs / 1000}s, threshold: ${this.stuckThresholdMs / 1000}s)`);
    this.interval = setInterval(() => this.poll(), this.pollIntervalMs);
    setTimeout(() => this.poll(), 5000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.escalationState.clear();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isManaging(sessionName: string): boolean {
    const s = this.escalationState.get(sessionName);
    return s !== undefined && s.level > EscalationLevel.Monitoring;
  }

  getStatus(): {
    enabled: boolean;
    sessions: Array<{ name: string; escalation: EscalationState | null }>;
    interventionHistory: InterventionEvent[];
  } {
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

  private async poll(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;

    try {
      const sessions = this.sessionManager.listRunningSessions();
      for (const session of sessions) {
        try {
          await this.checkSession(session.tmuxSession);
        } catch (err) {
          console.error(`[Watchdog] Error checking "${session.tmuxSession}":`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async checkSession(tmuxSession: string): Promise<void> {
    const existing = this.escalationState.get(tmuxSession);

    if (existing && existing.level > EscalationLevel.Monitoring) {
      this.handleEscalation(tmuxSession, existing);
      return;
    }

    // Find Claude PID in the tmux session
    const claudePid = this.getClaudePid(tmuxSession);
    if (!claudePid) return;

    const children = this.getChildProcesses(claudePid);
    const stuckChild = children.find(
      c => !this.isExcluded(c.command) &&
           !this.temporaryExclusions.has(c.pid) &&
           c.elapsedMs > this.stuckThresholdMs
    );

    if (stuckChild) {
      // LLM gate: check if this command is legitimately long-running before escalating
      const isStuck = await this.isCommandStuck(stuckChild.command, stuckChild.elapsedMs);
      if (!isStuck) {
        // LLM says legitimate — temporarily exclude this PID from future checks
        this.temporaryExclusions.add(stuckChild.pid);
        return;
      }

      const state: EscalationState = {
        level: EscalationLevel.CtrlC,
        levelEnteredAt: Date.now(),
        stuckChildPid: stuckChild.pid,
        stuckCommand: stuckChild.command,
        retryCount: existing?.retryCount ?? 0,
      };
      this.escalationState.set(tmuxSession, state);

      console.log(
        `[Watchdog] "${tmuxSession}": stuck command (${Math.round(stuckChild.elapsedMs / 1000)}s): ` +
        `${stuckChild.command.slice(0, 80)} — sending Ctrl+C`
      );

      this.sessionManager.sendKey(tmuxSession, 'C-c');
      this.recordIntervention(tmuxSession, EscalationLevel.CtrlC, 'Sent Ctrl+C', stuckChild);
    } else if (existing) {
      this.escalationState.delete(tmuxSession);
    }

    // Clean up temporary exclusions for dead processes
    for (const pid of this.temporaryExclusions) {
      if (!this.isProcessAlive(pid)) {
        this.temporaryExclusions.delete(pid);
      }
    }
  }

  private handleEscalation(tmuxSession: string, state: EscalationState): void {
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

    const delayForNext = ESCALATION_DELAYS[nextLevel as EscalationLevel] ?? 15_000;
    if (timeInLevel < delayForNext) return;

    state.level = nextLevel as EscalationLevel;
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
  private async isCommandStuck(command: string, elapsedMs: number): Promise<boolean> {
    if (!this.intelligence) return true; // No LLM → fail-open

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
        return false;
      }
      return true;
    } catch (err) {
      // @silent-fallback-ok — LLM intelligence is optional; fail-open to recover stuck processes
      console.warn(`[Watchdog] LLM command check failed, assuming stuck:`, err);
      return true; // Fail-open
    }
  }

  // --- Process utilities (self-contained, no shared module) ---

  private getClaudePid(tmuxSession: string): number | null {
    try {
      // Get pane PID
      const panePidStr = shellExec(
        `${this.config.sessions.tmuxPath} list-panes -t "=${tmuxSession}" -F "#{pane_pid}" 2>/dev/null`
      ).trim().split('\n')[0];
      if (!panePidStr) return null;
      const panePid = parseInt(panePidStr, 10);
      if (isNaN(panePid)) return null;

      // Find claude child
      const claudePidStr = shellExec(
        `pgrep -P ${panePid} -f claude 2>/dev/null | head -1`
      ).trim();
      if (!claudePidStr) return null;
      const pid = parseInt(claudePidStr, 10);
      return isNaN(pid) ? null : pid;
    } catch {
      // @silent-fallback-ok — process detection returns null
      return null;
    }
  }

  private getChildProcesses(pid: number): ChildProcessInfo[] {
    try {
      const childPidsStr = shellExec(`pgrep -P ${pid} 2>/dev/null`).trim();
      if (!childPidsStr) return [];

      const childPids = childPidsStr.split('\n').filter(Boolean).join(',');
      if (!childPids) return [];

      const output = shellExec(`ps -o pid=,etime=,command= -p ${childPids} 2>/dev/null`).trim();
      if (!output) return [];

      const results: ChildProcessInfo[] = [];
      for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+([\d:.-]+)\s+(.+)$/);
        if (!match) continue;
        const childPid = parseInt(match[1], 10);
        if (isNaN(childPid)) continue;
        results.push({
          pid: childPid,
          command: match[3],
          elapsedMs: this.parseElapsed(match[2]),
        });
      }
      return results;
    } catch {
      // @silent-fallback-ok — process enumeration returns empty
      return [];
    }
  }

  private isExcluded(command: string): boolean {
    for (const pattern of EXCLUDED_PATTERNS) {
      if (command.includes(pattern)) return true;
    }
    for (const prefix of EXCLUDED_PREFIXES) {
      if (command.startsWith(prefix)) return true;
    }
    return false;
  }

  private parseElapsed(elapsed: string): number {
    let days = 0;
    let timePart = elapsed;
    if (elapsed.includes('-')) {
      const [d, t] = elapsed.split('-');
      days = parseInt(d, 10);
      timePart = t;
    }
    const parts = timePart.split(':').map(Number);
    let seconds = 0;
    if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
    else seconds = parts[0];
    return (days * 86400 + seconds) * 1000;
  }

  private sendSignal(pid: number, signal: string): void {
    try {
      process.kill(pid, signal as NodeJS.Signals);
    } catch (err: any) {
      // @silent-fallback-ok — ESRCH expected for dead processes
      if (err.code !== 'ESRCH') {
        console.error(`[Watchdog] Failed to send ${signal} to ${pid}:`, err);
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // @silent-fallback-ok — signal 0 check
      return false;
    }
  }

  private killTmuxSession(tmuxSession: string): void {
    try {
      shellExec(`${this.config.sessions.tmuxPath} kill-session -t "=${tmuxSession}" 2>/dev/null`);
    } catch {}
  }

  private recordIntervention(
    sessionName: string,
    level: EscalationLevel,
    action: string,
    child: { pid: number; command: string; elapsedMs: number },
  ): void {
    const event: InterventionEvent = {
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
  }
}
