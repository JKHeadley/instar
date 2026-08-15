/**
 * Configuration shape for the grok-build adapter (grok-build framework
 * integration spec §2, §3).
 *
 * Grok Build auth (probed 2026-08-14, grok 1.0.4):
 *   - `grok login --device-auth` stores a subscription session in
 *     `$GROK_HOME/auth.json` (default `~/.grok/auth.json`, mode 0600) with an
 *     `expires_at` and a JWT whose scope carries `grok-cli:access`.
 *   - `XAI_API_KEY` is the CLI's documented FALLBACK when no session is
 *     active. The adapter refuses to run when any API/deployment key is in
 *     the environment (policy.ts) — the no-silent-metering rule.
 *
 * Home resolution (review-2 finding 12): every path the adapter reads
 * (binary, auth.json, sessions) resolves from ONE root, the same way the
 * binary does — `GROK_HOME` if set, else `~/.grok`. Auth in one home and a
 * binary from another is a misconfiguration, not something to paper over.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { detectGrokPath } from '../../../core/Config.js';

export interface GrokBuildConfig {
  /**
   * Absolute path to the `grok` CLI binary. NEVER the sibling `agent`
   * symlink — that name collides with Cursor's CLI (spec §2.1).
   */
  grokPath: string;
  /** The grok home dir (auth.json, sessions, config.toml live here). */
  grokHome: string;
  /**
   * Model id passed via `-m`. When unset, grok's own default applies
   * (grok-4.6 as probed). The abstract ModelTier vocabulary maps loosely:
   * every tier resolves to this configured model (grok exposes few models;
   * tier distinctions live server-side).
   */
  model?: string;
  /** Default timeout for one-shot calls (ms). */
  timeoutMs?: number;
  /** Hard cap on captured stdout/stderr bytes per stream. */
  maxOutputBytes?: number;
  /**
   * Prompt-size refusal bound in bytes (spec §4.1): a prompt over this is
   * REFUSED (never truncated) before any file is written — with the weekly
   * pool invisible in advance, an unbounded prompt is unbounded spend.
   */
  maxPromptBytes?: number;
  /**
   * Per-run token warn threshold (spec §6.1) — WIRED at envelope-parse time
   * in oneShotCompletion (a run whose reported total exceeds this logs a
   * loud accounting-anomaly line). The pre-spawn hard bound is
   * maxPromptBytes; this is the post-run tripwire.
   */
  perRunTokenWarnThreshold?: number;
}

/** Resolve the grok home the same way the binary does: GROK_HOME || ~/.grok. */
export function resolveGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['GROK_HOME'] || path.join(os.homedir(), '.grok');
}

/** Path to the session/auth file inside a grok home. */
export function grokAuthPath(grokHome: string): string {
  return path.join(grokHome, 'auth.json');
}

/**
 * THE canonical grok binary resolution (spec §2.1 normative order, first hit
 * wins) — ONE function every consumer calls:
 *   (1) `GROK_BUILD_PATH` — the per-invocation env lever;
 *   (2) `frameworkBinaryPaths['grok-build']` — the persisted config lever;
 *   (3) `$GROK_HOME/bin/grok` when GROK_HOME is set;
 *   (4) `detectGrokPath()` (standard install locations, `grok` name only),
 *       falling back to the home-relative path.
 *
 * Round-9 (adversarial): (3) and (4) were INVERTED here, so with GROK_HOME set
 * and a stale `~/.grok` install still present the adapter ran a binary from one
 * root while reading auth and `config.toml` from another —
 * violating this file's own "every path resolves from ONE root" invariant.
 *
 * Round-10 (decision-completeness): the TWO operator levers were split across
 * consumers — this module read only `GROK_BUILD_PATH`, the session-lane fence
 * read only `frameworkBinaryPaths`. Setting either relocated one lane while the
 * other resolved elsewhere: the same split-roots failure, arriving through the
 * levers instead of the defaults. Hence one exported resolver, not three
 * parallel ladders that agree only by review vigilance.
 */
export function resolveGrokBinaryPath(input: {
  env?: NodeJS.ProcessEnv;
  /** `frameworkBinaryPaths['grok-build']` from the agent config, when known. */
  configuredPath?: string | undefined;
} = {}): string {
  const env = input.env ?? process.env;
  const grokHome = resolveGrokHome(env);
  const homeRelativeBinary = path.join(grokHome, 'bin', 'grok');
  return (
    env['GROK_BUILD_PATH']
    || input.configuredPath
    || (env['GROK_HOME'] ? homeRelativeBinary : (detectGrokPath() || homeRelativeBinary))
  );
}

/**
 * Build a config from environment variables, with sensible defaults.
 * Binary resolution is delegated to `resolveGrokBinaryPath` above.
 */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { configuredPath?: string | undefined } = {},
): GrokBuildConfig {
  const grokHome = resolveGrokHome(env);
  return {
    grokPath: resolveGrokBinaryPath({ env, configuredPath: opts.configuredPath }),
    grokHome,
    // Undefined → grok's own default model applies (grok-4.6 as probed).
    model: env['GROK_BUILD_MODEL'],
    timeoutMs: 120_000,
    perRunTokenWarnThreshold: 200_000,
  };
}
