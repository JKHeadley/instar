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
  /**
   * Emitted when an attempt to spawn (or re-spawn) a pool session fails.
   * `attempt` is 0 for the original spawn attempt, 1+ for retry attempts.
   * The pool will schedule a retry with exponential backoff up to
   * `MAX_REPLACEMENT_ATTEMPTS` total; after that, `pool:degraded_persistent`
   * fires once and no more retries are scheduled.
   */
  'pool:degraded': { error: Error; attempt: number };
  /**
   * Emitted exactly once when a replacement-retry sequence succeeds. The
   * pool is back at steady-state size.
   */
  'pool:healed': { afterAttempts: number };
  /**
   * Emitted exactly once when all retries have been exhausted without
   * success. The pool is below steady-state size and will stay there
   * until something external triggers another replacement (next retire,
   * manual intervention).
   */
  'pool:degraded_persistent': { totalAttempts: number };
  'pool:shutdown': void;
}

/** Maximum number of retry attempts after the initial replacement spawn fails. */
const MAX_REPLACEMENT_ATTEMPTS = 5;
/** Maximum backoff between retries (ms). */
const MAX_REPLACEMENT_BACKOFF_MS = 30_000;

export class InteractivePool extends EventEmitter {
  private readonly sessions = new Map<string, PoolSession>();
  private readonly waiters: Array<{
    resolve: (s: PoolSession) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  /** Pending retry timers for replacement spawns. Cleared on shutdown. */
  private readonly pendingRetryTimers = new Set<NodeJS.Timeout>();
  /** Has the startup empty-prompt canary already run in this process lifetime? */
  private canaryHasRunInCurrentLifetime = false;
  /** Interval handle for the scheduled recurring canary. Cleared on shutdown. */
  private scheduledCanaryTimer: NodeJS.Timeout | null = null;
  /** Lock to prevent overlapping scheduled-canary runs if the previous one is slow. */
  private scheduledCanaryInFlight = false;
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
    // Schedule recurring canary if enabled (default hourly).
    if (this.config.canaryIntervalMs > 0) {
      this.scheduleRecurringCanary();
    }
  }

  /**
   * Schedule the recurring empty-prompt canary. Each tick allocates a
   * ready session, runs the canary, releases. Self-healing and
   * degradation surfacing reuse the same paths as the startup canary.
   * Re-entrancy is guarded by `scheduledCanaryInFlight` — if the
   * previous tick is still running when the next interval fires
   * (shouldn't happen at default 1h cadence but possible under
   * misconfiguration), the new tick is skipped.
   */
  private scheduleRecurringCanary(): void {
    if (this.shuttingDown) return;
    this.scheduledCanaryTimer = setInterval(async () => {
      if (this.shuttingDown || this.scheduledCanaryInFlight) return;
      this.scheduledCanaryInFlight = true;
      try {
        await this.runScheduledCanary();
      } catch (err) {
        console.error('[interactive-pool] scheduled canary tick failed:', err);
      } finally {
        this.scheduledCanaryInFlight = false;
      }
    }, this.config.canaryIntervalMs);
    // Allow process to exit even if interval is still scheduled.
    this.scheduledCanaryTimer.unref?.();
  }

  /**
   * Run one canary cycle on a borrowed pool session. Handles result
   * surfacing identically to the startup canary path in spawnOne.
   */
  private async runScheduledCanary(): Promise<void> {
    if (this.shuttingDown) return;
    let session: PoolSession;
    try {
      session = await this.allocate();
    } catch {
      // Pool fully busy or shutting down — skip this tick; next one will try again.
      return;
    }
    try {
      const { runEmptyPromptCanary } = await import('./canary/emptyPromptCanary.js');
      const result = await runEmptyPromptCanary(this, session, this.config, {
        llmFallback: this.config.llmFallback,
      });
      if (result.status === 'fail') {
        const { DegradationReporter } = await import('../../../monitoring/DegradationReporter.js');
        DegradationReporter.getInstance().report({
          feature: 'anthropic-interactive-pool.empty-prompt-canary',
          primary: 'Recurring empty-prompt canary verifies detector still reads Claude Code correctly',
          fallback: 'Pool continues serving with current signature; consumers may receive corrupted responses',
          reason: result.message,
          impact:
            'Subscription-path pool may return truncated or corrupted responses — '
            + 'manual intervention required to determine if Claude Code UI evolution requires code update.',
        });
      } else if (result.status === 'self-healed') {
        console.log(`[interactive-pool] scheduled canary self-healed: ${result.message}`);
      }
      // pass: silent (success path is quietly correct per Rule 3.2).
    } finally {
      await this.release(session);
    }
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

    // Run the empty-prompt canary on the FIRST session that comes up.
    // The signature it derives applies to every subsequent session
    // (signature is process-wide). Skip canary on subsequent sessions
    // since the signature is already valid and the canary cost (a real
    // prompt round-trip per session) would otherwise compound at pool
    // start. Recurring drift detection between restarts is a follow-up.
    // Per Rule 3 of the path constraints.
    if (!this.canaryHasRunInCurrentLifetime) {
      let canaryResult: import('./canary/emptyPromptCanary.js').CanaryResult | null = null;
      try {
        const { runEmptyPromptCanary } = await import('./canary/emptyPromptCanary.js');
        canaryResult = await runEmptyPromptCanary(this, session, this.config, {
          llmFallback: this.config.llmFallback,
        });
        this.canaryHasRunInCurrentLifetime = true;
      } catch (canaryErr) {
        // Canary infrastructure (import / promise chain) crashed — distinct
        // from "canary returned fail status." Log loudly but don't block
        // pool startup; missing canary is protection-in-depth, not a
        // primary failure path.
        console.error('[interactive-pool] canary infrastructure error:', canaryErr);
      }
      if (canaryResult?.status === 'fail') {
        // Canary returned a structured failure — surface and refuse to
        // bring the session ready. Report to DegradationReporter so the
        // surface lands in the right place (echo Telegram by default).
        const { DegradationReporter } = await import('../../../monitoring/DegradationReporter.js');
        DegradationReporter.getInstance().report({
          feature: 'anthropic-interactive-pool.empty-prompt-canary',
          primary: 'Empty-prompt detector verified by startup canary',
          fallback: 'Pool refuses to start; consumers route to anthropic-headless via registry',
          reason: canaryResult.message,
          impact:
            'Subscription-path pool unavailable — Anthropic work routes through the Agent SDK '
            + 'credit pot instead. May exhaust credits faster than usual.',
        });
        session.state = 'dead';
        this.sessions.delete(id);
        this.emit('session:died', session);
        throw new UnexpectedError(
          `Pool session ${id} failed empty-prompt canary: ${canaryResult.message}`,
          ANTHROPIC_INTERACTIVE_POOL_ID,
        );
      }
      if (canaryResult?.status === 'self-healed') {
        // Self-heal succeeded — log locally, no user-facing alert per
        // Rule 3.2 ("success path is quietly correct").
        console.log(`[interactive-pool] canary self-healed: ${canaryResult.message}`);
      }
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
    // RULE 3: EXEMPT — raw byte capture, no state parsing. The bytes are
    // returned verbatim to callers (promptRunner, canary, sentinels) which
    // are the authorities that interpret them. The state-detection logic
    // lives in those callers (covered by the empty-prompt canary and the
    // poolDecayCanary). This function is a transport-layer signal source.
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
      // Replace, with retry-on-failure and observable degradation events.
      // Previous behavior was `.catch(console.error)` — spawn failures were
      // swallowed and the pool decayed silently. Now spawn failures emit
      // `pool:degraded`, schedule an exponential-backoff retry up to
      // MAX_REPLACEMENT_ATTEMPTS, and emit `pool:healed` on recovery or
      // `pool:degraded_persistent` after final exhaustion.
      this.replaceRetired();
    }
  }

  private replaceRetired(): void {
    if (this.shuttingDown) return;
    this.spawnOne().catch((err) => {
      this.emit('pool:degraded', { error: err as Error, attempt: 0 });
      this.scheduleRetryReplacement(1);
    });
  }

  private scheduleRetryReplacement(attempt: number): void {
    if (this.shuttingDown) return;
    if (attempt > MAX_REPLACEMENT_ATTEMPTS) {
      this.emit('pool:degraded_persistent', { totalAttempts: attempt - 1 });
      return;
    }
    const backoffMs = Math.min(
      MAX_REPLACEMENT_BACKOFF_MS,
      1_000 * Math.pow(2, attempt - 1),
    );
    const timer = setTimeout(async () => {
      this.pendingRetryTimers.delete(timer);
      if (this.shuttingDown) return;
      try {
        await this.spawnOne();
        this.emit('pool:healed', { afterAttempts: attempt });
      } catch (err) {
        this.emit('pool:degraded', { error: err as Error, attempt });
        this.scheduleRetryReplacement(attempt + 1);
      }
    }, backoffMs);
    this.pendingRetryTimers.add(timer);
  }

  /** Force-kill a session without graceful retirement. */
  async hardKill(s: PoolSession): Promise<void> {
    await this.retire(s); // same effect, no graceful drain
  }

  /** Shutdown the pool. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.scheduledCanaryTimer !== null) {
      clearInterval(this.scheduledCanaryTimer);
      this.scheduledCanaryTimer = null;
    }
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new UnexpectedError('Pool shutting down', ANTHROPIC_INTERACTIVE_POOL_ID));
    }
    this.waiters.length = 0;
    for (const t of this.pendingRetryTimers) clearTimeout(t);
    this.pendingRetryTimers.clear();
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
