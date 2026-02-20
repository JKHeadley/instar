/**
 * Session Manager — spawn and monitor Claude Code sessions via tmux.
 *
 * This is the core capability that transforms Claude Code from a CLI tool
 * into a persistent agent. Sessions run in tmux, survive terminal disconnects,
 * and can be monitored/reaped by the server.
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
import type { Session, SessionManagerConfig, SessionStatus, ModelTier } from './types.js';
import { StateManager } from './StateManager.js';

/** Sanitize a string for use as part of a tmux session name. */
function sanitizeSessionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export interface SessionManagerEvents {
  sessionComplete: [session: Session];
}

export class SessionManager extends EventEmitter {
  private config: SessionManagerConfig;
  private state: StateManager;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private monitoringInProgress = false;

  constructor(config: SessionManagerConfig, state: StateManager) {
    super();
    this.config = config;
    this.state = state;
  }

  /**
   * Start polling for completed sessions. Emits 'sessionComplete' when
   * a running session's tmux process disappears.
   *
   * Uses async tmux calls to avoid blocking the event loop when
   * many sessions are running.
   */
  startMonitoring(intervalMs: number = 5000): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(() => {
      // Prevent overlapping monitor ticks
      if (this.monitoringInProgress) return;
      this.monitorTick().catch(err => {
        console.error(`[SessionManager] Monitor tick error: ${err}`);
      });
    }, intervalMs);
  }

  private async monitorTick(): Promise<void> {
    this.monitoringInProgress = true;
    try {
      const running = this.state.listSessions({ status: 'running' });
      for (const session of running) {
        const alive = await this.isSessionAliveAsync(session.tmuxSession);
        if (!alive) {
          session.status = 'completed';
          session.endedAt = new Date().toISOString();
          this.state.saveSession(session);
          this.emit('sessionComplete', session);
          continue;
        }

        // Enforce session timeout (prevents zombie sessions)
        if (session.maxDurationMinutes && session.startedAt) {
          const elapsed = (Date.now() - new Date(session.startedAt).getTime()) / 60000;
          const limit = session.maxDurationMinutes * 1.2; // 20% buffer
          if (elapsed > limit && !this.config.protectedSessions.includes(session.tmuxSession)) {
            console.warn(`[SessionManager] Session "${session.name}" exceeded timeout (${Math.round(elapsed)}m > ${session.maxDurationMinutes}m). Killing.`);
            try {
              await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`]);
            } catch { /* ignore */ }
            session.status = 'killed';
            session.endedAt = new Date().toISOString();
            this.state.saveSession(session);
            this.emit('sessionComplete', session);
          }
        }
      }
    } finally {
      this.monitoringInProgress = false;
    }
  }

  /**
   * Stop the monitoring poll.
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Spawn a new Claude Code session in tmux.
   */
  async spawnSession(options: {
    name: string;
    prompt: string;
    model?: ModelTier;
    jobSlug?: string;
    triggeredBy?: string;
    maxDurationMinutes?: number;
  }): Promise<Session> {
    const runningSessions = this.listRunningSessions();
    if (runningSessions.length >= this.config.maxSessions) {
      throw new Error(
        `Max sessions (${this.config.maxSessions}) reached. ` +
        `Running: ${runningSessions.map(s => s.name).join(', ')}`
      );
    }

    const sessionId = this.generateId();
    const safeName = sanitizeSessionName(options.name);
    const tmuxSession = `${path.basename(this.config.projectDir)}-${safeName}`;

    // Check if tmux session already exists
    if (this.tmuxSessionExists(tmuxSession)) {
      throw new Error(`tmux session "${tmuxSession}" already exists`);
    }

    // Write prompt to temp file to avoid shell injection via bash -c string interpolation.
    // The prompt is user-controlled (arrives via HTTP API), so we must never pass it
    // through a shell interpreter. Writing to a file and reading it back is safe.
    const promptDir = path.join(os.tmpdir(), 'instar-prompts');
    fs.mkdirSync(promptDir, { recursive: true });
    const promptFile = path.join(promptDir, `${sessionId}.txt`);
    fs.writeFileSync(promptFile, options.prompt);

    // Build a shell command that reads the prompt from the temp file
    const claudeArgs = ['--dangerously-skip-permissions'];
    if (options.model) {
      claudeArgs.push('--model', options.model);
    }
    // Use execFileSync with argument arrays for the tmux call.
    // The inner command reads the prompt from a file, avoiding shell interpretation of user input.
    const quotedClaudePath = `'${this.config.claudePath.replace(/'/g, "'\\''")}'`;
    const quotedPromptFile = `'${promptFile.replace(/'/g, "'\\''")}'`;
    const claudeCmd = `${quotedClaudePath} ${claudeArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} -p "$(cat ${quotedPromptFile})" ; rm -f ${quotedPromptFile}`;
    try {
      execFileSync(this.config.tmuxPath, [
        'new-session', '-d',
        '-s', tmuxSession,
        '-c', this.config.projectDir,
        'bash', '-c', claudeCmd,
      ], { encoding: 'utf-8' });
    } catch (err) {
      // Clean up prompt file on failure
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      throw new Error(`Failed to create tmux session: ${err}`);
    }

    const session: Session = {
      id: sessionId,
      name: options.name,
      status: 'running',
      jobSlug: options.jobSlug,
      tmuxSession,
      startedAt: new Date().toISOString(),
      triggeredBy: options.triggeredBy,
      model: options.model,
      prompt: options.prompt,
      maxDurationMinutes: options.maxDurationMinutes,
    };

    this.state.saveSession(session);
    return session;
  }

  /**
   * Check if a session is still running by checking tmux (sync version).
   */
  isSessionAlive(tmuxSession: string): boolean {
    return this.tmuxSessionExists(tmuxSession);
  }

  /**
   * Check if a session is still running by checking tmux (async version).
   * Used by the monitoring loop to avoid blocking the event loop.
   */
  private async isSessionAliveAsync(tmuxSession: string): Promise<boolean> {
    try {
      await execFileAsync(this.config.tmuxPath, ['has-session', '-t', `=${tmuxSession}`], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kill a session by terminating its tmux session.
   */
  killSession(sessionId: string): boolean {
    const session = this.state.getSession(sessionId);
    if (!session) return false;

    // Don't kill protected sessions
    if (this.config.protectedSessions.includes(session.tmuxSession)) {
      throw new Error(`Cannot kill protected session: ${session.tmuxSession}`);
    }

    try {
      execFileSync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`], {
        encoding: 'utf-8',
      });
    } catch {
      // Session might already be dead
    }

    session.status = 'killed';
    session.endedAt = new Date().toISOString();
    this.state.saveSession(session);
    return true;
  }

  /**
   * Capture the current output of a tmux session.
   */
  captureOutput(tmuxSession: string, lines: number = 100): string | null {
    try {
      // Note: use `=session:` (trailing colon) for pane-level tmux commands
      return execFileSync(
        this.config.tmuxPath,
        ['capture-pane', '-t', `=${tmuxSession}:`, '-p', '-S', `-${lines}`],
        { encoding: 'utf-8', timeout: 5000 }
      );
    } catch {
      return null;
    }
  }

  /**
   * Send input to a running tmux session.
   */
  sendInput(tmuxSession: string, input: string): boolean {
    try {
      // Note: use `=session:` (trailing colon) for pane-level tmux commands
      // Send text literally, then Enter separately
      execFileSync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${tmuxSession}:`, '-l', input],
        { encoding: 'utf-8', timeout: 5000 }
      );
      execFileSync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${tmuxSession}:`, 'Enter'],
        { encoding: 'utf-8', timeout: 5000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all sessions that are currently running.
   */
  listRunningSessions(): Session[] {
    const sessions = this.state.listSessions({ status: 'running' });

    // Verify each is actually still alive in tmux
    return sessions.filter(s => {
      const alive = this.isSessionAlive(s.tmuxSession);
      if (!alive) {
        // Mark as completed if tmux session is gone
        s.status = 'completed';
        s.endedAt = new Date().toISOString();
        this.state.saveSession(s);
      }
      return alive;
    });
  }

  /**
   * Detect if a session has completed by checking output patterns.
   */
  detectCompletion(tmuxSession: string): boolean {
    const output = this.captureOutput(tmuxSession, 30);
    if (!output) return false;

    return this.config.completionPatterns.some(pattern =>
      output.includes(pattern)
    );
  }

  /**
   * Reap completed/zombie sessions.
   */
  reapCompletedSessions(): string[] {
    const running = this.state.listSessions({ status: 'running' });
    const reaped: string[] = [];

    for (const session of running) {
      if (this.config.protectedSessions.includes(session.tmuxSession)) continue;

      if (!this.isSessionAlive(session.tmuxSession) || this.detectCompletion(session.tmuxSession)) {
        session.status = 'completed';
        session.endedAt = new Date().toISOString();
        this.state.saveSession(session);
        reaped.push(session.id);

        // Kill the tmux session if it's still hanging around
        if (this.isSessionAlive(session.tmuxSession)) {
          try {
            execFileSync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`], {
              encoding: 'utf-8',
            });
          } catch { /* ignore */ }
        }
      }
    }

    return reaped;
  }

  /**
   * Spawn an interactive Claude Code session (no -p prompt — opens at the REPL).
   * Used for Telegram-driven conversational sessions.
   * Optionally sends an initial message after Claude is ready.
   */
  async spawnInteractiveSession(initialMessage?: string, name?: string): Promise<string> {
    const sanitized = name
      ? name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      : null;
    const projectBase = path.basename(this.config.projectDir);
    const tmuxSession = sanitized ? `${projectBase}-${sanitized}` : `${projectBase}-interactive-${Date.now()}`;

    if (this.tmuxSessionExists(tmuxSession)) {
      // Session already exists — just reuse it
      if (initialMessage) {
        this.injectMessage(tmuxSession, initialMessage);
      }
      return tmuxSession;
    }

    // Enforce session cap (same check as spawnSession)
    const runningSessions = this.listRunningSessions();
    if (runningSessions.length >= this.config.maxSessions) {
      throw new Error(
        `Max sessions (${this.config.maxSessions}) reached. ` +
        `Running: ${runningSessions.map(s => s.name).join(', ')}`
      );
    }

    // Respect the user's configured auth method (API key or OAuth subscription)
    // Use execFileSync with argument arrays to prevent command injection
    const quotedPath = `'${this.config.claudePath.replace(/'/g, "'\\''")}'`;
    const claudeCmd = `cd '${this.config.projectDir.replace(/'/g, "'\\''")}' && ${quotedPath} --dangerously-skip-permissions`;
    try {
      execFileSync(this.config.tmuxPath, [
        'new-session', '-d',
        '-s', tmuxSession,
        '-x', '200', '-y', '50',
        'bash', '-c', claudeCmd,
      ], { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Failed to create interactive tmux session: ${err}`);
    }

    // Track it in state
    const session: Session = {
      id: this.generateId(),
      name: name || tmuxSession,
      status: 'running',
      tmuxSession,
      startedAt: new Date().toISOString(),
      prompt: initialMessage,
    };
    this.state.saveSession(session);

    // Wait for Claude to be ready, then send the initial message
    if (initialMessage) {
      this.waitForClaudeReady(tmuxSession).then((ready) => {
        if (ready) {
          this.injectMessage(tmuxSession, initialMessage);
        } else {
          console.error(`[SessionManager] Claude not ready in session "${tmuxSession}" after timeout`);
        }
      }).catch((err) => {
        console.error(`[SessionManager] Error waiting for Claude ready in "${tmuxSession}": ${err}`);
      });
    }

    return tmuxSession;
  }

  /**
   * Inject a Telegram message into a tmux session.
   * Short messages go via send-keys; long messages are written to a temp file.
   */
  injectTelegramMessage(tmuxSession: string, topicId: number, text: string): void {
    const FILE_THRESHOLD = 500;
    const taggedText = `[telegram:${topicId}] ${text}`;

    if (taggedText.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, taggedText);
      return;
    }

    // Write full message to temp file
    const tmpDir = path.join('/tmp', 'instar-telegram');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `msg-${topicId}-${Date.now()}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText);

    const ref = `[telegram:${topicId}] [Long message saved to ${filepath} — read it to see the full message]`;
    this.injectMessage(tmuxSession, ref);
  }

  /**
   * Send text to a tmux session via send-keys.
   * Uses -l (literal) flag for text, then sends Enter separately.
   */
  private injectMessage(tmuxSession: string, text: string): void {
    const exactTarget = `=${tmuxSession}:`;
    try {
      // Send the text literally
      execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '-l', text], {
        encoding: 'utf-8', timeout: 5000,
      });
      // Send Enter separately
      execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, 'Enter'], {
        encoding: 'utf-8', timeout: 5000,
      });
    } catch (err) {
      console.error(`[SessionManager] Failed to inject message into ${tmuxSession}: ${err}`);
    }
  }

  /**
   * Wait for Claude to be ready in a tmux session by polling output.
   */
  private async waitForClaudeReady(tmuxSession: string, timeoutMs: number = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const output = this.captureOutput(tmuxSession, 10);
      if (output && (output.includes('❯') || output.includes('>') || output.includes('$'))) {
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  private tmuxSessionExists(name: string): boolean {
    try {
      execFileSync(this.config.tmuxPath, ['has-session', '-t', `=${name}`], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private generateId(): string {
    return randomUUID();
  }
}
