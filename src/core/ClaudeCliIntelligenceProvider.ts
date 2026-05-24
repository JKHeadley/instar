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
        '--output-format', 'text',
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
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB
        env: childEnv,
      }, (error, stdout, stderr) => {
        if (error) {
          // Timeout or other error — return empty so caller can fall back
          reject(new Error(`Claude CLI error: ${error.message}${stderr ? ` — ${stderr.slice(0, 200)}` : ''}`));
          return;
        }

        resolve(stdout.trim());
      });

      // Write prompt via stdin for very long prompts (belt and suspenders)
      child.stdin?.end();
    });
  }
}
