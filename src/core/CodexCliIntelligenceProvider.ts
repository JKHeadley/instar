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
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { resolveCliModelFlag } from '../providers/adapters/openai-codex/models.js';
import { buildCodexChildEnv } from '../providers/adapters/openai-codex/transport/codexSpawn.js';

const DEFAULT_TIMEOUT_MS = 30_000;

const INTELLIGENCE_SCRATCH_DIR_PREFIX = 'instar-codex-intel-scratch-';

let cachedScratchDir: string | null = null;

/**
 * Lazily create and return an EMPTY scratch directory used as the `--cd`
 * for every judgment call.
 *
 * Running `codex exec` in the agent's project directory loads the full
 * ~26 KB `AGENTS.md` identity AND fires the project's `.codex/hooks.json`
 * hooks (session_start / user_prompt_submit / stop) on every call — turning
 * a one-word classification into a full agent boot. An empty, hook-free
 * scratch dir gives these calls the clean-notepad guarantee that
 * `ClaudeCliIntelligenceProvider` gets via `--setting-sources user`:
 * no project doc, and no project hooks.
 *
 * SECURITY (why mkdtemp, not a fixed name): Codex discovers hooks by walking
 * UP from the cwd and fires any `.codex/hooks.json` it finds — and
 * `project_doc_max_bytes=0` does NOT cover hooks. On Linux `os.tmpdir()` is
 * the world-writable `/tmp`, so a fixed, guessable dir name could be
 * pre-created (or symlinked) by another local user with a planted
 * `.codex/hooks.json`, re-introducing hook execution under our identity.
 * `mkdtempSync` defeats this: it appends an unguessable random suffix, creates
 * the dir with mode 0700 owned by this process, and refuses to follow a
 * pre-existing path — so nothing can be planted in the cwd these calls run in.
 *
 * The dir is re-verified each call: a tmp-reaper may delete it during a
 * long-lived process, so we recreate it if it has gone missing.
 *
 * Bug (2026-05-26): ~1,550 such judgment spawns/day were re-injecting the
 * identity + firing session_start, causing notification spam and spawn-storm
 * delivery failures. Spec: CODEX-INTELLIGENCE-PROVIDER-CLEAN-CALL-SPEC.md.
 */
function resolveIntelligenceScratchDir(): string {
  if (cachedScratchDir && existsSync(cachedScratchDir)) return cachedScratchDir;
  cachedScratchDir = mkdtempSync(join(tmpdir(), INTELLIGENCE_SCRATCH_DIR_PREFIX));
  return cachedScratchDir;
}

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
   * Retained for API compatibility. NOTE: this is intentionally NOT used as
   * the `codex exec --cd` for judgment calls. Those always run in an empty
   * instar-managed scratch dir (see `resolveIntelligenceScratchDir`) so the
   * agent's project identity + hooks never load. These calls don't depend on
   * cwd content, so ignoring this value is safe.
   */
  workingDirectory?: string;
}

export class CodexCliIntelligenceProvider implements IntelligenceProvider {
  private readonly codexPath: string;
  private readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';

  constructor(options: CodexCliIntelligenceProviderOptions) {
    this.codexPath = options.codexPath;
    this.sandboxMode = options.sandboxMode ?? 'read-only';
    // options.workingDirectory is intentionally NOT stored: judgment calls
    // always run in an empty scratch dir (resolveIntelligenceScratchDir), so
    // the agent's project identity + hooks never load. The option is retained
    // on the type for API compatibility (the factory still forwards it).
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const model = resolveCliModelFlag(options?.model);

    const scratchDir = resolveIntelligenceScratchDir();

    return new Promise((resolve, reject) => {
      const args = [
        'exec',
        '--model', model,
        '--sandbox', this.sandboxMode,
        // Run judgment calls in an empty scratch dir, NOT the agent's project
        // dir. The project dir loads the full ~26 KB AGENTS.md identity AND
        // fires the project's .codex/hooks.json (session_start /
        // user_prompt_submit / stop) on every call. The scratch dir is the
        // Codex analog of ClaudeCliIntelligenceProvider's `--setting-sources
        // user`. See resolveIntelligenceScratchDir + the spec.
        '--cd', scratchDir,
        // Belt-and-suspenders: hard-disable project-doc (AGENTS.md) loading
        // even if a stray doc ever lands at or above the scratch path.
        '-c', 'project_doc_max_bytes=0',
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
          // Honor a caller-supplied per-call budget (IntelligenceOptions.timeoutMs);
          // fall back to the 30s default so every caller that omits it is unchanged.
          timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
