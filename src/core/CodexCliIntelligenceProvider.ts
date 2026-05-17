/**
 * CodexCliIntelligenceProvider — IntelligenceProvider using the OpenAI Codex CLI.
 *
 * Sibling of ClaudeCliIntelligenceProvider. Routes judgment calls through
 * `codex exec` for non-Claude installs. Same fast/balanced/capable tier
 * mapping the Codex adapter uses for first-class calls; same timeout
 * semantics; same fail-loudly behavior so callers can fall back.
 *
 * Provider-portability v1.0.0: this is the second IntelligenceProvider
 * implementation. Reviewers, sentinels, canaries, and JobReflector now
 * have a non-Claude path. The composition root picks the right
 * implementation based on the agent's configured framework.
 */

import { execFile } from 'node:child_process';
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { resolveCliModelFlag } from '../providers/adapters/openai-codex/models.js';
import { buildCodexChildEnv } from '../providers/adapters/openai-codex/transport/codexSpawn.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface CodexCliIntelligenceProviderOptions {
  /** Absolute path to the `codex` CLI binary. */
  codexPath: string;
  /**
   * Optional sandbox mode. Defaults to `read-only` — judgment calls
   * should never need to write to disk; if they do, the caller has a
   * design problem, not a sandbox problem.
   */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /**
   * Working directory for the codex CLI invocation. Defaults to
   * process.cwd(). Reviewer / canary calls don't depend on cwd content
   * but Codex CLI honors the flag so it's safe to pass.
   */
  workingDirectory?: string;
}

export class CodexCliIntelligenceProvider implements IntelligenceProvider {
  private readonly codexPath: string;
  private readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  private readonly workingDirectory: string;

  constructor(options: CodexCliIntelligenceProviderOptions) {
    this.codexPath = options.codexPath;
    this.sandboxMode = options.sandboxMode ?? 'read-only';
    this.workingDirectory = options.workingDirectory ?? process.cwd();
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const model = resolveCliModelFlag(options?.model);

    return new Promise((resolve, reject) => {
      const args = [
        'exec',
        '--model', model,
        '--sandbox', this.sandboxMode,
        '--cd', this.workingDirectory,
        // Reviewer/sentinel/canary calls are deterministic short prompts
        // that don't depend on the cwd being a trusted git repo. Codex
        // CLI's default behavior is to refuse to run when --cd points at
        // a non-git directory (it surfaces as
        //   "Not inside a trusted directory and --skip-git-repo-check was not specified")
        // which breaks every Codex-based agent whose state directory
        // isn't a git checkout. Skip the check — these calls are bounded
        // and never modify the cwd.
        '--skip-git-repo-check',
        // Pass the prompt as a positional arg. Codex CLI reads stdin
        // for very long prompts but the positional path is fine for the
        // narrow prompts reviewers/sentinels send (a few hundred tokens
        // at most).
        prompt,
      ];

      // Spec 12 Rule 1a — Codex spawns MUST use the allowlist-built env,
      // never inherit `process.env` wholesale. The previous {...process.env}
      // approach leaked OPENAI_API_KEY into the Codex child whenever any
      // process in echo's env happened to set it (e.g., a sibling agent's
      // test fixture), silently billing the wrong account. This callsite
      // was missed in the cycle 1.1 audit (caught by the fresh second-pass
      // reviewer); routing through buildCodexChildEnv closes it.
      //
      // CLAUDECODE / CLAUDE_SESSION_ID are not in the allowlist so they
      // are dropped automatically — the prior explicit deletes are now
      // redundant but the hygiene intent is preserved by the allowlist.
      const childEnv = buildCodexChildEnv();

      const child = execFile(
        this.codexPath,
        args,
        {
          timeout: DEFAULT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: childEnv,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `Codex CLI error: ${error.message}` +
                  (stderr ? ` — ${stderr.slice(0, 200)}` : ''),
              ),
            );
            return;
          }
          resolve(stdout.trim());
        },
      );

      // Stdin must be explicitly closed or Codex hangs waiting for EOF
      // even when the prompt was passed as a positional. Same bug class
      // we fixed in the openai-codex adapter's transport/codexSpawn.ts.
      child.stdin?.end();
    });
  }
}
