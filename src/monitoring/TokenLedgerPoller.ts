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
  /**
   * Bounded Accumulation (Increment 2): how often to drive the ledger's retention
   * prune (TokenLedger.pruneToRetention). Default 6h (matches the feature-metrics
   * prune cadence). The prune itself is a no-op when retention is disabled on the
   * ledger, so this always-runs hook is cheap when off. When a prune reports a
   * remaining backlog (`more`), the next tick prunes again to drain it without one
   * giant blocking DELETE. */
  retentionPruneIntervalMs?: number;
  /** Injectable clock for cadence testing. Default Date.now. */
  now?: () => number;
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
  private retentionPruneIntervalMs: number;
  private now: () => number;
  /** Wall-clock of the last retention prune; 0 = never. */
  private lastRetentionPruneAtMs = 0;
  /** True while a backlog prune is draining — forces the next tick to prune again. */
  private retentionDraining = false;

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
    this.retentionPruneIntervalMs =
      opts.retentionPruneIntervalMs && opts.retentionPruneIntervalMs > 0
        ? opts.retentionPruneIntervalMs
        : 6 * 60 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Drive the ledger's retention prune on a sub-cadence (the scan runs every
   * intervalMs; the prune only every retentionPruneIntervalMs). A no-op when
   * retention is disabled on the ledger. If a prune leaves a backlog (`more`), the
   * next tick prunes again to drain it gradually rather than in one blocking DELETE.
   * Fail-open: a prune error is reported and resets the cadence, never throws.
   */
  private maybePruneRetention(): void {
    const now = this.now();
    if (!this.retentionDraining && now - this.lastRetentionPruneAtMs < this.retentionPruneIntervalMs) {
      return;
    }
    try {
      const res = this.ledger.pruneToRetention(now);
      this.lastRetentionPruneAtMs = now;
      this.retentionDraining = res.more === true;
    } catch (err) {
      this.onError(err);
      this.lastRetentionPruneAtMs = now;
      this.retentionDraining = false;
    }
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
        // Retention prune rides the existing cadence, off the scan path (no-op when
        // retention is disabled on the ledger). Synchronous + fail-open inside.
        this.maybePruneRetention();
        if (this.afterTick) {
          Promise.resolve()
            .then(() => this.afterTick!())
            .catch((err) => this.onError(err));
        }
      });
  }
}
