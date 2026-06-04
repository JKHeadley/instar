/**
 * ClaudeCliIntelligenceProvider — IntelligenceProvider using the Claude CLI.
 *
 * Uses `claude -p` (print mode) to route judgment calls through the Agent SDK
 * credit path (prepaid as part of the Max subscription) and, by extension, the
 * subscription floor when credits exhaust. This is the only IntelligenceProvider
 * implementation in Instar — direct Anthropic API calls are forbidden per
 * Rule 2 of the path constraints
 * (specs/provider-portability/04-anthropic-path-constraints.md).
 */

import { execFile } from 'node:child_process';
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { resolveCliFlag } from './models.js';
import { assertClaudeAllowed } from './claudeForbiddenGuard.js';

const DEFAULT_MODEL = 'fast';
const DEFAULT_TIMEOUT_MS = 30_000;

export class ClaudeCliIntelligenceProvider implements IntelligenceProvider {
  private claudePath: string;

  constructor(claudePath: string) {
    // Codex-only enforcement (Structure > Willpower): on a codex-only agent
    // (enabledFrameworks without 'claude-code'), constructing a Claude
    // intelligence provider is forbidden. Throw loudly here rather than
    // letting a fallback path silently use Claude on a machine where the
    // claude binary happens to be installed. Callers with a legitimate
    // "no LLM available" degradation catch ClaudeForbiddenError and disable
    // the LLM-backed feature instead of reaching for Claude.
    assertClaudeAllowed('ClaudeCliIntelligenceProvider');
    this.claudePath = claudePath;
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const model = resolveCliFlag(options?.model ?? DEFAULT_MODEL);

    return new Promise((resolve, reject) => {
      const args = [
        '-p', prompt,
        '--model', model,
        '--max-turns', '1',
        // JSON (not text) so the response carries a `usage` block. We extract the
        // answer from `.result` and surface token counts via options.onUsage —
        // the only way per-feature token cost reaches /metrics/features (the tap
        // had no usage to record under text output, so it always logged 0).
        // Iris-audit item 1, spec iris-audit-session-observability.md.
        '--output-format', 'json',
        // Exclude project/local CLAUDE.md to prevent identity context
        // from contaminating classification and evaluation prompts.
        '--setting-sources', 'user',
      ];

      // Strip Claude Code session markers to prevent "nested session" error.
      // When instar runs inside (or is started from) a Claude Code session, these
      // env vars propagate to child processes. The Claude CLI refuses to run if
      // CLAUDECODE is set. SessionManager already does this for tmux spawning.
      const childEnv = { ...process.env };
      delete childEnv.CLAUDECODE;
      delete childEnv.CLAUDE_SESSION_ID;

      const child = execFile(this.claudePath, args, {
        // Honor a caller-supplied per-call budget (IntelligenceOptions.timeoutMs);
        // fall back to the 30s default so every caller that omits it is unchanged.
        // LLM-backed callers on a synchronous HTTP path (e.g. the standards-
        // conformance gate reviewing a full spec) need more than 30s.
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB
        env: childEnv,
      }, (error, stdout, stderr) => {
        if (error) {
          // Timeout or other error — reject so caller can fall back. Include a
          // generous stderr slice so the circuit breaker's rate-limit
          // classifier (isRateLimitError) can see usage/limit language that
          // often appears past the first 200 chars. (Rate-limit detection reads
          // stderr, so the stdout text→json switch does not affect it.)
          reject(new Error(`Claude CLI error: ${error.message}${stderr ? ` — ${stderr.slice(0, 600)}` : ''}`));
          return;
        }

        resolve(parseJsonResult(stdout, options?.onUsage));
      });

      // Write prompt via stdin for very long prompts (belt and suspenders)
      child.stdin?.end();
    });
  }
}

/**
 * Parse `claude -p --output-format json` stdout into the response text, and
 * surface token usage via onUsage. The CLI emits a single JSON object shaped
 * `{ result: string, usage: { input_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, output_tokens, ... }, ... }`.
 *
 * Defensive by design — usage observability must never break the LLM path:
 *  - If stdout isn't valid JSON, or has no string `result`, fall back to the
 *    raw trimmed stdout (degraded, but non-crashing — same shape as the old
 *    text path would have produced).
 *  - tokensIn sums the input components actually processed (fresh + cache
 *    creation + cache read), since each is a real cost; tokensOut is
 *    output_tokens. Missing fields count as 0. onUsage fires only when at least
 *    one token count is present, and never throws into the caller.
 */
export function parseJsonResult(
  stdout: string,
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
): string {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON (truncated / unexpected) — return raw text, no usage.
    return trimmed;
  }
  const obj = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : null;
  if (onUsage && obj && obj.usage && typeof obj.usage === 'object') {
    try {
      const u = obj.usage as Record<string, unknown>;
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const inputTokens =
        num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
      const outputTokens = num(u.output_tokens);
      if (inputTokens > 0 || outputTokens > 0) {
        onUsage({ inputTokens, outputTokens });
      }
    } catch {
      /* usage extraction must never break the result path */
    }
  }
  if (obj && typeof obj.result === 'string') {
    return obj.result.trim();
  }
  // Valid JSON but no string result — best effort, return raw.
  return trimmed;
}
