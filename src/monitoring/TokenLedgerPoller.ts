/**
 * TokenLedgerPoller — periodically calls TokenLedger.scanAll() to keep
 * the SQLite rollup up to date with whatever Claude Code has written.
 *
 * Read-only observability: never mutates the source JSONL files.
 */
import type { TokenLedger } from './TokenLedger.js';
import { IdleAwareCadence } from './IdleAwareCadence.js';

export interface TokenLedgerPollerOptions {
  ledger: TokenLedger;
  /** Polling interval (ms) while the agent is active. Defaults to 60_000. */
  intervalMs?: number;
  /**
   * When provided, the poller backs off to {@link idleIntervalMs} while this
   * returns true (e.g. no active sessions). Scanning JSONL for token usage when
   * nothing is running is wasted work — this trims it from the idle CPU floor.
   * Omit for the prior fixed-cadence behavior. (Responsible Resource Usage.)
   */
  isIdle?: () => boolean;
  /** Polling interval (ms) while idle. Defaults to 5 minutes. */
  idleIntervalMs?: number;
  /** Optional logger (defaults to console.warn for errors only). */
  onError?: (err: unknown) => void;
  /** Optional hook that rides the existing token-ledger cadence after each scan. */
  afterTick?: () => void | Promise<void>;
  /**
   * When set, each tick ALSO scans this agent's Codex rollouts (attributed by
   * cwd) into the ledger's separate codex_token_sessions table. Leave unset on
   * Claude-only hosts — the Codex scan is then skipped entirely.
   */
  codexProjectDir?: string;
  /** Skip Codex rollouts older than this when scanning. Mirrors the Claude window. */
  codexMaxFileAgeMs?: number;
}

export class TokenLedgerPoller {
  private ledger: TokenLedger;
  private intervalMs: number;
  private idleIntervalMs: number;
  private isIdle: (() => boolean) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cadence: IdleAwareCadence | null = null;
  private running = false;
  private onError: (err: unknown) => void;
  private afterTick: (() => void | Promise<void>) | null;
  private codexProjectDir: string | null;
  private codexMaxFileAgeMs: number;

  constructor(opts: TokenLedgerPollerOptions) {
    this.ledger = opts.ledger;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.isIdle = opts.isIdle ?? null;
    this.idleIntervalMs = opts.idleIntervalMs && opts.idleIntervalMs > 0 ? opts.idleIntervalMs : 5 * 60_000;
    this.codexProjectDir = opts.codexProjectDir ?? null;
    this.codexMaxFileAgeMs = opts.codexMaxFileAgeMs && opts.codexMaxFileAgeMs > 0
      ? opts.codexMaxFileAgeMs
      : 30 * 24 * 60 * 60 * 1000;
    this.onError = opts.onError ?? ((err) => {
      console.warn('[token-ledger] scan error:', err);
    });
    this.afterTick = opts.afterTick ?? null;
  }

  start(): void {
    if (this.timer || this.cadence) return;
    // Immediate first tick (non-blocking) so the dashboard has data fast.
    queueMicrotask(() => this.tick());
    if (this.isIdle) {
      // Idle-aware: full cadence while active, back off while idle.
      this.cadence = new IdleAwareCadence({
        activeMs: this.intervalMs,
        idleMs: this.idleIntervalMs,
        isIdle: this.isIdle,
        tick: () => this.tick(),
      });
      this.cadence.start();
    } else {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cadence) {
      this.cadence.stop();
      this.cadence = null;
    }
  }

  private tick(): void {
    if (this.running) return;
    this.running = true;
    // Fire-and-forget the async scan; reentry guard above prevents stacking.
    // We do NOT await — setInterval already drives cadence, and awaiting
    // here would block other interval callbacks in this microtask queue.
    // The Codex scan (when configured) runs after the Claude scan; a failure
    // in either is reported but never stops the other or stacks ticks.
    this.ledger
      .scanAllAsync()
      .catch((err) => this.onError(err))
      .then(() => {
        if (!this.codexProjectDir) return undefined;
        return this.ledger
          .scanCodexRolloutsAsync({ projectDir: this.codexProjectDir, maxFileAgeMs: this.codexMaxFileAgeMs })
          .then(() => undefined)
          .catch((err) => this.onError(err));
      })
      .finally(() => {
        this.running = false;
        if (this.afterTick) {
          Promise.resolve()
            .then(() => this.afterTick!())
            .catch((err) => this.onError(err));
        }
      });
  }
}
