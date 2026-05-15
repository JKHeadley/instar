/**
 * Pool core for the anthropic-interactive-pool adapter.
 *
 * Manages a fixed-size set of long-lived `claude` REPL sessions in tmux.
 * Each session can serve many prompts before being retired (auto-retire
 * defends against context-window overflow).
 *
 * Lifecycle:
 *   spawning → ready ⇄ busy → retiring → dead
 *
 * Allocation: LRU (least-recently-used ready session wins).
 * Recycling: when a session is retired, the pool spawns a fresh one in its
 * place so the steady-state size is preserved.
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { UnexpectedError } from '../../errors.js';
import type { InteractivePoolConfig } from './config.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from './errors.js';

const execFileAsync = promisify(execFile);

export type PoolSessionState = 'spawning' | 'ready' | 'busy' | 'retiring' | 'dead';

export interface PoolSession {
  id: string;
  tmuxName: string;
  state: PoolSessionState;
  messageCount: number;
  spawnedAt: number;
  lastUsedAt: number;
  /** Provider-side Claude session UUID once bound (via hook event). */
  claudeSessionId?: string;
}

export interface PoolEvents {
  'session:spawned': PoolSession;
  'session:ready': PoolSession;
  'session:allocated': PoolSession;
  'session:released': PoolSession;
  'session:retired': PoolSession;
  'session:died': PoolSession;
  'pool:shutdown': void;
}

export class InteractivePool extends EventEmitter {
  private readonly sessions = new Map<string, PoolSession>();
  private readonly waiters: Array<{
    resolve: (s: PoolSession) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private shuttingDown = false;

  constructor(private readonly config: InteractivePoolConfig) {
    super();
  }

  async start(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.config.poolSize; i++) {
      promises.push(this.spawnOne());
    }
    await Promise.all(promises);
  }

  private async spawnOne(): Promise<void> {
    const id = `aip-${randomBytes(6).toString('hex')}`;
    const tmuxName = `instar-pool-${id}`;
    const session: PoolSession = {
      id,
      tmuxName,
      state: 'spawning',
      messageCount: 0,
      spawnedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.emit('session:spawned', session);

    // Build env for the tmux spawn
    const envFlags: string[] = [];
    const pushEnv = (key: string, value: string) => envFlags.push('-e', `${key}=${value}`);

    pushEnv('CLAUDECODE', '');
    pushEnv('CLAUDE_SESSION_ID', '');
    pushEnv('INSTAR_POOL_SESSION_ID', id);

    if (this.config.credential) {
      if (this.config.credential.startsWith('sk-ant-oat')) {
        pushEnv('CLAUDE_CODE_OAUTH_TOKEN', this.config.credential);
        pushEnv('ANTHROPIC_API_KEY', '');
      } else {
        pushEnv('ANTHROPIC_API_KEY', this.config.credential);
        pushEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
      }
    }
    if (this.config.apiBaseUrl) {
      pushEnv('ANTHROPIC_BASE_URL', this.config.apiBaseUrl);
    }

    const args = [
      'new-session',
      '-d',
      '-s',
      tmuxName,
      '-x',
      String(this.config.paneWidth),
      '-y',
      String(this.config.paneHeight),
    ];
    if (this.config.workingDirectory) {
      args.push('-c', this.config.workingDirectory);
    }
    args.push(...envFlags);
    args.push(this.config.claudePath, '--dangerously-skip-permissions');

    try {
      execFileSync(this.config.tmuxPath, args, { encoding: 'utf-8' });
      try {
        execFileSync(
          this.config.tmuxPath,
          ['set-option', '-t', `=${tmuxName}:`, 'history-limit', '50000'],
          { encoding: 'utf-8', timeout: 5000 },
        );
      } catch {
        /* nice-to-have */
      }
    } catch (err) {
      this.sessions.delete(id);
      throw new UnexpectedError(
        `Failed to spawn pool session: ${(err as Error).message}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
        err,
      );
    }

    // Wait for REPL to become ready
    const ready = await this.waitForReady(tmuxName, 30);
    if (!ready) {
      session.state = 'dead';
      this.sessions.delete(id);
      this.emit('session:died', session);
      throw new UnexpectedError(
        `Pool session ${id} did not reach ready state in 30s`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }

    session.state = 'ready';
    this.emit('session:ready', session);
    this.flushWaiter(session);
  }

  private async waitForReady(tmuxName: string, maxSeconds: number): Promise<boolean> {
    for (let i = 0; i < maxSeconds; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const pane = await this.capturePane(tmuxName, 50);
      if (pane === null) continue;
      for (const marker of this.config.idleMarkers) {
        if (pane.includes(marker)) {
          return true;
        }
      }
    }
    return false;
  }

  async capturePane(tmuxName: string, lines: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        this.config.tmuxPath,
        ['capture-pane', '-t', `=${tmuxName}:`, '-p', '-S', `-${lines}`],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return null;
    }
  }

  /**
   * Allocate a ready session. Marks it busy and returns. If no session is
   * ready, waits up to `allocateTimeoutMs`. If no session becomes ready
   * in time, throws.
   */
  async allocate(): Promise<PoolSession> {
    if (this.shuttingDown) {
      throw new UnexpectedError(
        'Pool is shutting down; cannot allocate',
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    const ready = this.findReadyLru();
    if (ready) {
      this.markBusy(ready);
      return ready;
    }
    return new Promise<PoolSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new UnexpectedError(
            `Pool allocation timed out after ${this.config.allocateTimeoutMs}ms`,
            ANTHROPIC_INTERACTIVE_POOL_ID,
          ),
        );
      }, this.config.allocateTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private findReadyLru(): PoolSession | undefined {
    let best: PoolSession | undefined;
    for (const s of this.sessions.values()) {
      if (s.state !== 'ready') continue;
      if (!best || s.lastUsedAt < best.lastUsedAt) best = s;
    }
    return best;
  }

  private markBusy(s: PoolSession): void {
    s.state = 'busy';
    s.lastUsedAt = Date.now();
    this.emit('session:allocated', s);
  }

  private flushWaiter(s: PoolSession): void {
    if (s.state !== 'ready' || this.waiters.length === 0) return;
    const waiter = this.waiters.shift()!;
    clearTimeout(waiter.timer);
    this.markBusy(s);
    waiter.resolve(s);
  }

  /**
   * Return a session to ready. Increments messageCount and checks retire
   * thresholds; auto-retires if needed.
   */
  async release(s: PoolSession): Promise<void> {
    if (s.state !== 'busy') return;
    s.messageCount += 1;
    s.lastUsedAt = Date.now();
    if (s.messageCount >= this.config.maxMessagesPerSession) {
      await this.retire(s);
      return;
    }
    s.state = 'ready';
    this.emit('session:released', s);
    this.flushWaiter(s);
  }

  /**
   * Gracefully retire a session and spawn a replacement.
   */
  async retire(s: PoolSession): Promise<void> {
    if (s.state === 'retiring' || s.state === 'dead') return;
    s.state = 'retiring';
    try {
      await execFileAsync(
        this.config.tmuxPath,
        ['kill-session', '-t', `=${s.tmuxName}:`],
        { timeout: 5000 },
      );
    } catch {
      // already gone
    }
    s.state = 'dead';
    this.emit('session:retired', s);
    this.sessions.delete(s.id);
    if (!this.shuttingDown) {
      // Replace
      this.spawnOne().catch((err) => {
        console.error('[interactive-pool] failed to replace retired session:', err);
      });
    }
  }

  /** Force-kill a session without graceful retirement. */
  async hardKill(s: PoolSession): Promise<void> {
    await this.retire(s); // same effect, no graceful drain
  }

  /** Shutdown the pool. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new UnexpectedError('Pool shutting down', ANTHROPIC_INTERACTIVE_POOL_ID));
    }
    this.waiters.length = 0;
    const sessions = Array.from(this.sessions.values());
    await Promise.all(sessions.map((s) => this.retire(s)));
    this.emit('pool:shutdown');
  }

  /** Snapshot of pool state. */
  status(): {
    total: number;
    ready: number;
    busy: number;
    retiring: number;
    sessions: ReadonlyArray<Readonly<PoolSession>>;
  } {
    let ready = 0;
    let busy = 0;
    let retiring = 0;
    for (const s of this.sessions.values()) {
      if (s.state === 'ready') ready++;
      else if (s.state === 'busy') busy++;
      else if (s.state === 'retiring') retiring++;
    }
    return {
      total: this.sessions.size,
      ready,
      busy,
      retiring,
      sessions: Array.from(this.sessions.values()).map((s) => ({ ...s })),
    };
  }

  getById(id: string): PoolSession | undefined {
    return this.sessions.get(id);
  }
}
