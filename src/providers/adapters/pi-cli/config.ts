/**
 * Configuration shape for the pi-cli adapter.
 *
 * Pi auth (per the P0.1 hands-on eval, pi 0.78.1 — docs/specs/_drafts/
 * pi-eval-report.md):
 *   - pi reads `~/.pi/agent/auth.json` (subscription OAuth — Codex/ChatGPT,
 *     Claude Pro/Max, GitHub Copilot) and `~/.pi/agent/models.json` (custom
 *     provider definitions, e.g. an openai-completions endpoint). THESE ARE
 *     THE ALLOWED auth paths. Pi owns the provider quirks; we only pin HOME
 *     so pi can find them (see transport/piSpawn.ts).
 *   - A billing-capable provider key inherited from the parent env
 *     (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) could silently route spend onto
 *     an API account. The env-allowlist (piSpawn.ts) unconditionally deletes
 *     those billing-capable vars from the child env — the no-API-keys rule.
 *
 * The Anthropic-provider SUBSCRIPTION GUARD (allowAnthropicProviders below) is
 * the §4.3 structural flag; its ENFORCEMENT lives in policy.ts (a separate
 * file written in parallel), NOT here. This file only carries the flag.
 */

import { detectPiPath } from '../../../core/Config.js';

export interface PiCliConfig {
  /** Absolute path to the `pi` CLI binary. */
  piPath: string;
  /**
   * Default model pattern. A pi `provider/id` pattern (or bare id) passed
   * through to the CLI `--model <pattern>` flag. When unset, pi's OWN
   * configured default provider/model applies — tier vocabulary lives inside
   * the configured provider for pi (see transport/oneShotCompletion.ts).
   */
  model?: string;
  /** Default timeout for one-shot calls (ms). */
  timeoutMs?: number;
  /** Hard cap on captured stdout/stderr bytes per stream. */
  maxOutputBytes?: number;
  /**
   * SUBSCRIPTION GUARD (PI-HARNESS-INTEGRATION-SPEC §4.3). When FALSE (the
   * default), constructing a pi call against an Anthropic/Claude provider is
   * structurally DENIED — routing Claude work through pi bills as per-token
   * EXTRA USAGE, not plan limits. Set TRUE in `.instar/config.json` to opt in
   * (the call is then audit-logged with a cost warning). The enforcement of
   * this flag lives in policy.ts; this field is only the input to it.
   */
  allowAnthropicProviders?: boolean;
  /**
   * Override for pi's session-file directory (`--session-dir`). Pin this into
   * the agent-home state dir for durability + reap-log coherence (eval caveat
   * 4: session files are per-cwd-keyed by default). One-shot calls run
   * `--no-session` and do not touch it.
   */
  sessionDir?: string;
}

/**
 * Build a config from environment variables, with sensible defaults.
 *
 * Binary detection: when `PI_CLI_PATH` is not set, falls back to
 * `detectPiPath()` (the existing `detectFrameworkBinary('pi')` wrapper, which
 * probes the standard install locations). NEVER hardcode developer-specific
 * paths here — a verified box-local path is a fact for THIS box, not a value
 * to bake in.
 *
 * `allowAnthropicProviders` defaults to FALSE — the §4.3 subscription guard is
 * deny-by-default and the override is intentionally NOT env-settable (it must
 * be an explicit `.instar/config.json` line; see policy.ts).
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PiCliConfig {
  return {
    piPath: env['PI_CLI_PATH'] || detectPiPath() || 'pi',
    // Undefined → pi's own configured default provider/model applies.
    model: env['PI_CLI_MODEL'],
    timeoutMs: 60_000,
    allowAnthropicProviders: false,
  };
}
