/**
 * Configuration shape for the openai-codex adapter.
 *
 * Codex CLI auth modes (per `codex --help`, `codex login --help`):
 *   - ChatGPT subscription: OAuth token stored in `~/.codex/auth.json`,
 *     refreshed by the CLI. Subscription path (analog of Anthropic's
 *     CLAUDE_CODE_OAUTH_TOKEN / interactive-pool subscription path).
 *   - API key: `OPENAI_API_KEY` env var, or `codex login --with-api-key`.
 *     Direct-API path. Per Rule 2 (specs/provider-portability/04-anthropic-
 *     path-constraints.md) the corresponding Anthropic mode is forbidden;
 *     for OpenAI we treat API-key mode as the "Agent SDK credit pot
 *     analog" — usage-priced but acceptable because there's no
 *     subscription-equivalent flat-rate path at OpenAI to compete with.
 *
 * Both auth paths are surfaced through `codex exec`; the CLI internally
 * routes. The adapter doesn't need to discriminate at the call site.
 */

import { detectCodexPath, detectTmuxPath } from '../../../core/Config.js';

export interface OpenAiCodexConfig {
  /** Absolute path to the `codex` CLI binary. */
  codexPath: string;
  /** Absolute path to the `tmux` binary (used for the interactive REPL fallback). */
  tmuxPath: string;
  /**
   * Default model name. Codex resolves model selection via `--model <name>`,
   * `--profile <name>`, or `config.toml`. Adapter passes through to CLI.
   * Examples: `gpt-5.2-codex`, `gpt-5-codex`, `gpt-4o`, `o3`.
   */
  defaultModel?: string;
  /**
   * Default sandbox mode for `codex exec`: 'read-only' | 'workspace-write' |
   * 'danger-full-access'. Read-only is the safe default for one-shot calls.
   */
  defaultSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Default named profile from config.toml. Mutually exclusive with
   * explicit model + sandbox flags — caller chooses.
   */
  defaultProfile?: string;
  /**
   * OPENAI_API_KEY (sk-...). If omitted, the adapter relies on the
   * CLI's stored OAuth token in ~/.codex/auth.json.
   */
  apiKey?: string;
  /** Optional CODEX_HOME override (defaults to `~/.codex`). */
  codexHome?: string;
  /** Default timeout for one-shot calls (ms). */
  defaultOneShotTimeoutMs?: number;
  /** Default session-spawn timeout (ms). */
  defaultSessionTimeoutMs?: number;
  /** Default max-duration for agentic sessions (minutes). */
  defaultSessionDurationMinutes?: number;
  /** Default idle-prompt-kill (minutes) for agentic sessions. */
  defaultIdlePromptKillMinutes?: number;
  /** Working directory for tools that need one. */
  defaultWorkingDirectory?: string;
}

/**
 * Build a config from environment variables, with sensible defaults.
 *
 * Binary detection: when `CODEX_PATH` is not set, falls back to
 * `detectCodexPath()` which searches standard install locations
 * (npm global, Homebrew, nvm, PATH). NEVER hardcode developer-specific
 * paths here — they leak across installs and break every other machine.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAiCodexConfig {
  return {
    codexPath: env['CODEX_PATH'] || detectCodexPath() || 'codex',
    tmuxPath: env['TMUX_PATH'] || detectTmuxPath() || '/opt/homebrew/bin/tmux',
    // Default to undefined so resolveCliModelFlag picks the 'balanced' tier
    // (gpt-5.3-codex) — works on ChatGPT subscription auth. Codex CLI's own
    // default (gpt-5.2-codex) is API-only after the 2026-04-14 retirement.
    defaultModel: env['CODEX_DEFAULT_MODEL'],
    defaultSandboxMode: 'read-only',
    defaultProfile: env['CODEX_DEFAULT_PROFILE'],
    apiKey: env['OPENAI_API_KEY'],
    codexHome: env['CODEX_HOME'],
    defaultOneShotTimeoutMs: 60_000,
    defaultSessionTimeoutMs: 30_000,
    defaultSessionDurationMinutes: 240,
    defaultIdlePromptKillMinutes: 15,
  };
}
