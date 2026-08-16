/**
 * Configuration shape for the anthropic-interactive-pool adapter.
 */

import type { CanaryLlmFallback } from './canary/emptyPromptCanary.js';

export interface InteractivePoolConfig {
  /** Absolute path to the `claude` CLI binary. */
  claudePath: string;
  /** Absolute path to the `tmux` binary. */
  tmuxPath: string;
  /** Pool size (number of warm REPL sessions kept available). */
  poolSize: number;
  /** Auto-retire a session after this many messages (defends context window). */
  maxMessagesPerSession: number;
  /** Auto-retire a session after this many minutes idle. */
  maxIdleMinutes: number;
  /** Max wait time when allocating from an empty pool (ms). */
  allocateTimeoutMs: number;
  /** Optional Anthropic credential — OAuth subscription token preferred. */
  credential?: string;
  /** Optional API base URL override. */
  apiBaseUrl?: string;
  /** Working directory for the REPL sessions. */
  workingDirectory?: string;
  /**
   * Idle markers used to detect prompt completion. Inherited from the
   * feasibility prototype.
   */
  idleMarkers: ReadonlyArray<string>;
  /** Seconds of buffer stability before declaring a response complete. */
  stabilitySeconds: number;
  /** Per-prompt max wait in seconds before giving up. */
  maxPromptWaitSeconds: number;
  /** Tmux pane width (columns) — wider gives more usable output. */
  paneWidth: number;
  /** Tmux pane height (rows). */
  paneHeight: number;
  /**
   * Interval in milliseconds between scheduled empty-prompt canary
   * checks. Default 1 hour. Setting to 0 disables the scheduled
   * recurrence (canary still runs at startup). The recurring canary
   * picks a ready pool session, allocates it, runs a known round-trip,
   * and self-heals or surfaces failure per Rule 3 of the path
   * constraints.
   */
  canaryIntervalMs: number;
  /**
   * Optional LLM fallback for the empty-prompt canary. When deterministic
   * re-derivation fails (structure shifted enough that the canary can't
   * extract a new signature), the canary calls this function with the
   * captured pane to ask a small model whether Claude Code is idle.
   * Wire via `buildCanaryLlmFallback(intelligence)` from this adapter's
   * index. Omitting it leaves the canary deterministic-only.
   */
  llmFallback?: CanaryLlmFallback;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): InteractivePoolConfig {
  return {
    claudePath: env['CLAUDE_PATH'] || '/opt/homebrew/bin/claude',
    tmuxPath: env['TMUX_PATH'] || '/opt/homebrew/bin/tmux',
    poolSize: parseInt(env['INTERACTIVE_POOL_SIZE'] || '2', 10),
    maxMessagesPerSession: parseInt(env['INTERACTIVE_POOL_MAX_MESSAGES'] || '50', 10),
    maxIdleMinutes: parseInt(env['INTERACTIVE_POOL_MAX_IDLE_MINUTES'] || '30', 10),
    allocateTimeoutMs: 60_000,
    credential: env['CLAUDE_CODE_OAUTH_TOKEN'] || env['ANTHROPIC_API_KEY'],
    apiBaseUrl: env['ANTHROPIC_BASE_URL'],
    idleMarkers: ['? for shortcuts', 'bypass permissions on', 'shift+tab to cycle'],
    stabilitySeconds: 4,
    maxPromptWaitSeconds: 120,
    paneWidth: 200,
    paneHeight: 50,
    canaryIntervalMs: parseInt(env['INTERACTIVE_POOL_CANARY_INTERVAL_MS'] || '3600000', 10),
  };
}
