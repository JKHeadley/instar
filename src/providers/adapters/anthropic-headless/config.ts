/**
 * Configuration shape for the anthropic-headless adapter.
 */

export interface AnthropicHeadlessConfig {
  /** Absolute path to the `claude` CLI binary. */
  claudePath: string;
  /** Absolute path to the `tmux` binary. */
  tmuxPath: string;
  /** Default model tier when callers don't specify. */
  defaultModel?: 'fast' | 'balanced' | 'capable';
  /**
   * Anthropic credential. Either the OAuth subscription token
   * (sk-ant-oat...) routed to CLAUDE_CODE_OAUTH_TOKEN, or the API key
   * (sk-ant-api...) routed to ANTHROPIC_API_KEY. Adapter detects which.
   * If omitted at construction, the adapter reads from the environment.
   */
  credential?: string;
  /** Optional Anthropic API base URL (for proxies / Meridian). */
  apiBaseUrl?: string;
  /**
   * Model id for the credential-probe validation ping (a 4-token
   * Messages-API "ping" that verifies a credential works). Threaded from
   * `intelligence.pinnedModels.anthropicCredentialProbe` at server boot
   * (LLM-ROUTING-REGISTRY.md risk item #7). Unset ⇒ ANTHROPIC_MODELS.haiku
   * — the probe only needs the cheapest valid model on the account.
   */
  credentialProbeModel?: string;
  /** Default timeout for one-shot calls (ms). */
  defaultOneShotTimeoutMs?: number;
  /** Default max-duration for agentic sessions (minutes). */
  defaultSessionDurationMinutes?: number;
  /** Default idle-prompt-kill (minutes) for agentic sessions. */
  defaultIdlePromptKillMinutes?: number;
  /** Working directory for tools that need one. */
  defaultWorkingDirectory?: string;
}

/**
 * Build a config from environment variables, with sensible defaults.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicHeadlessConfig {
  return {
    claudePath: env['CLAUDE_PATH'] || '/opt/homebrew/bin/claude',
    tmuxPath: env['TMUX_PATH'] || '/opt/homebrew/bin/tmux',
    defaultModel: 'balanced',
    credential: env['ANTHROPIC_API_KEY'] || env['CLAUDE_CODE_OAUTH_TOKEN'],
    apiBaseUrl: env['ANTHROPIC_BASE_URL'],
    defaultOneShotTimeoutMs: 30_000,
    defaultSessionDurationMinutes: 240,
    defaultIdlePromptKillMinutes: 15,
  };
}
