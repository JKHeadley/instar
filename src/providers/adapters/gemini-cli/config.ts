/**
 * Configuration shape for the gemini-cli adapter.
 *
 * Gemini CLI auth (per the verified facts, v0.25.2):
 *   - Cached OAuth credentials under `~/.gemini` (the subscription / cached-
 *     OAuth path). THIS IS THE ALLOWED PATH.
 *   - A `GEMINI_API_KEY` / `GOOGLE_API_KEY` / Vertex env path can route onto
 *     a BILLED API account. The env-allowlist (geminiSpawn.ts) unconditionally
 *     deletes those billing-capable vars from the child env — the Rule-1a
 *     analog. See credentials.ts for the rationale.
 */

import { detectGeminiPath } from '../../../core/Config.js';
import { GEMINI_DEFAULT_MODEL } from './models.js';
import type { GeminiCapacityPolicyConfig } from './observability/geminiCapacityPolicy.js';

/** Gemini's native approval surface (analog of Codex's sandbox modes). */
export type GeminiApprovalMode = 'default' | 'auto_edit' | 'yolo';

export interface GeminiCliConfig {
  /** Absolute path to the `gemini` CLI binary. */
  geminiPath: string;
  /**
   * Default model name. Resolves to the verified-working `gemini-2.5-flash`
   * when unset. Passed through to the CLI `-m <name>` flag.
   */
  defaultModel?: string;
  /**
   * Default approval mode for one-shot calls. `'default'` is the SAFE one-shot
   * mode and is pinned at the call site by the transport; `'yolo'` / `'auto_edit'`
   * are capability-only and never reachable from OneShotCompletion.
   */
  defaultApprovalMode?: GeminiApprovalMode;
  /** Default timeout for one-shot calls (ms). */
  defaultOneShotTimeoutMs?: number;
  /** Default session-spawn timeout (ms). */
  defaultSessionTimeoutMs?: number;
  /** Hard cap on captured stdout/stderr bytes per stream. */
  maxOutputBytes?: number;
  /** Working directory for tools that need one. */
  defaultWorkingDirectory?: string;
  /** Gemini quota/rate-limit handling. Defaults enabled. */
  capacityPolicy?: GeminiCapacityPolicyConfig;
}

/**
 * Build a config from environment variables, with sensible defaults.
 *
 * Binary detection: when `GEMINI_PATH` is not set, falls back to
 * `detectGeminiPath()` (the existing `detectFrameworkBinary('gemini')`
 * wrapper, which probes `~/.gemini/bin/gemini` + the standard install
 * locations). NEVER hardcode developer-specific paths here — the verified
 * `/opt/homebrew/bin/gemini` is a fact for THIS box, not a value to bake in.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GeminiCliConfig {
  return {
    geminiPath: env['GEMINI_PATH'] || detectGeminiPath() || 'gemini',
    // Undefined → resolveCliModelFlag picks the verified-working default
    // (gemini-2.5-flash) via the tier resolver.
    defaultModel: env['GEMINI_DEFAULT_MODEL'],
    defaultApprovalMode: 'default',
    defaultOneShotTimeoutMs: 60_000,
    defaultSessionTimeoutMs: 30_000,
  };
}

/** Re-export for callers that want the literal default without configFromEnv. */
export { GEMINI_DEFAULT_MODEL };
