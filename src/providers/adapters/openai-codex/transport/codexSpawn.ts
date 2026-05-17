/**
 * Spawn helper for Codex CLI.
 *
 * Codex CLI reads stdin even when the prompt is supplied as a positional
 * argument — without an explicit EOF it hangs indefinitely. Node's
 * `execFile` / `exec` don't close stdin for us, so this helper uses
 * `spawn` and explicitly calls `child.stdin.end()` immediately.
 *
 * Empirically observed 2026-05-15: without this fix, oneShotCompletion
 * hangs for the full timeout window (30-60s) and returns empty. With it,
 * a Reply-with-PONGXYZ smoke call completes in ~4-5 seconds.
 *
 * Used by all transport primitives that spawn `codex exec` (one-shot,
 * structured one-shot). The agenticSessionHeadless primitive spawns
 * codex inside tmux, where tmux owns stdin — that path is unaffected.
 */

import { spawn } from 'node:child_process';

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Rule 1a — env allowlist for Codex child processes.
 *
 * Per `specs/provider-portability/12-openai-path-constraints.md`, Codex
 * spawns MUST NOT inherit `process.env` wholesale. The Codex CLI prefers
 * `OPENAI_API_KEY` over the stored OAuth token when both are present in
 * its env; agents running on machines where another project sets the env
 * var (echo is the canonical example) would silently bill against the
 * OpenAI API account instead of the ChatGPT subscription.
 *
 * This is the explicit allowlist of variables that flow through. Anything
 * not on this list is dropped. Adding to this list requires a spec
 * amendment.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: critical — a leak silently bills the user's OpenAI API
 *                account at full per-token rates; the runaway-cost ceiling
 *                is the user's funded balance
 *   Frequency:   per-spawn (every Codex child process construction)
 *   Stability:   stable — env-allowlist is internal Instar code; the
 *                Codex CLI's env-var preference contract is the upstream
 *                surface this defends against, and that's checked by the
 *                openaiKeyLeakageCanary at adapter init
 *   Fallback:    none — the structural invariant is "no leak, ever"; a
 *                detected violation requires a code fix, not self-heal
 *   Verdict:     deterministic structural construction (allowlist + hard
 *                deletes), gated by a startup canary that asserts no leak
 *                under sentinel-injection in the parent env
 */
const CODEX_ENV_ALLOWLIST = [
  // Filesystem / user identity
  'HOME',
  'USER',
  'LOGNAME',
  // Subprocess execution
  'PATH',
  'SHELL',
  'TMPDIR',
  // Locale
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  // Terminal sizing (Codex CLI's TUI honors these)
  'COLUMNS',
  'LINES',
  'ROWS',
  'TERM',
  // Codex CLI configuration
  'CODEX_HOME',
  'CODEX_DEFAULT_MODEL',
  'CODEX_DEFAULT_PROFILE',
  // XDG base-dir conventions (used by codex on Linux)
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  // Spec 12 kill-switch — passed through so the child can see it
  'INSTAR_DISABLE_RULE1_OPENAI',
] as const;

/**
 * Boot-time snapshot of OPENAI_BASE_URL. Captured once at module load so a
 * mid-process mutation of `process.env.OPENAI_BASE_URL` (by a hostile plugin,
 * a dispatch action, or a future maintainer mistake) cannot reach Codex
 * spawns. Spec 12 § "Boot-time snapshot."
 */
const BOOT_OPENAI_BASE_URL: string | undefined = process.env.OPENAI_BASE_URL;

export interface BuildCodexChildEnvOptions {
  /**
   * Explicit OPENAI_API_KEY to pass through to the child process.
   *
   * @deprecated Phase A only. The API-key path is forbidden as a routine
   * path per Spec 12 Rule 1. Phase B refuses construction when this is set.
   * Use ChatGPT subscription OAuth in `~/.codex/auth.json` instead.
   * @internal
   */
  apiKey?: string;
  /** Override for CODEX_HOME (caller-provided). */
  codexHome?: string;
}

/**
 * Build the env for a `codex` child process per Rule 1a.
 *
 * Constructs an explicit allowlist (NOT a blocklist) — variables not listed
 * are dropped. `OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` are
 * defensively hard-deleted even if accidentally allowlisted in the future.
 *
 * Exceptions to the strict allowlist:
 *   - `OPENAI_BASE_URL` from the boot-time snapshot is passed through (Spec 12
 *     § "Scope clarification — what 'Codex traffic' means": user-installed
 *     proxies are user-owned compatibility).
 *   - When `INSTAR_DISABLE_RULE1_OPENAI=1` is set in the parent env, the
 *     `OPENAI_API_KEY` from parent env is passed through (Spec 12 § "Escape-hatch
 *     interaction with Rule 1a"). Sunset-date enforcement and audit-log codes
 *     are layered in by the credential validation cycle.
 *   - When the caller passes `options.apiKey`, that value is set on the child
 *     env regardless of the parent env's `OPENAI_API_KEY`. This is the
 *     deprecated explicit-config path; staged for removal at Phase B.
 */
export function buildCodexChildEnv(options?: BuildCodexChildEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (BOOT_OPENAI_BASE_URL !== undefined) {
    env.OPENAI_BASE_URL = BOOT_OPENAI_BASE_URL;
  }

  // Defensive hard-delete — belt-and-suspenders against any allowlist
  // expansion mistake that includes an OpenAI-billing variable.
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_ORG_ID;
  delete env.OPENAI_PROJECT_ID;

  // Kill-switch handling. Spec 12 § "Escape-hatch interaction with Rule 1a".
  if (
    process.env.INSTAR_DISABLE_RULE1_OPENAI === '1' &&
    typeof process.env.OPENAI_API_KEY === 'string' &&
    process.env.OPENAI_API_KEY.length > 0
  ) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  }

  // Explicit caller-provided key (Phase A deprecated path).
  if (options?.apiKey) {
    env.OPENAI_API_KEY = options.apiKey;
  }

  if (options?.codexHome) {
    env.CODEX_HOME = options.codexHome;
  }

  return env;
}

/**
 * Build the session-env tuples passed via tmux `-e VAR=VAL` flags for a
 * Codex tmux session.
 *
 * Mirrors `buildCodexChildEnv`'s allowlist-with-defensive-deletes shape but
 * emits `[key, value]` tuples for tmux's flag format and accepts
 * session-scoped extras (the agent-level `INSTAR_SESSION_ID` marker, an
 * optional `CODEX_HOME` override, and caller-supplied env filtered through
 * a session-extras allowlist).
 *
 * Caller-supplied `extraEnv` is filtered against `SESSION_EXTRA_ALLOWLIST`.
 * `OPENAI_API_KEY` / `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` are never
 * emitted as tmux flags regardless of allowlist contents — defensive
 * hard-block matching the env-allowlist's posture. Spec 12 §
 * "Compliance boundary at the process edge".
 *
 * The tmux `-e VAR=VAL` flag *adds* to the session's env on top of what
 * tmux itself inherits. Callers passing the result of this function to
 * `tmux new-session` MUST also pass `env: buildCodexChildEnv(...)` to the
 * `execFileSync(tmuxPath, ...)` that spawns tmux — otherwise tmux's own
 * inherited env carries the leak the allowlist exists to defeat.
 */
const SESSION_EXTRA_ALLOWLIST: ReadonlySet<string> = new Set([
  // Codex CLI configuration knobs that callers may want to override
  // per-session. Anything not in this set is dropped.
  'CODEX_DEFAULT_MODEL',
  'CODEX_DEFAULT_PROFILE',
  // Locale + terminal overrides — safe to vary per session.
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'COLUMNS',
  'LINES',
  'ROWS',
  'TERM',
]);

const SESSION_EXTRA_HARD_BLOCK: ReadonlySet<string> = new Set([
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
]);

export interface BuildCodexTmuxSessionEnvOptions {
  sessionId: string;
  codexHome?: string;
  extraEnv?: Readonly<Record<string, string>>;
}

export function buildCodexTmuxSessionEnv(
  options: BuildCodexTmuxSessionEnvOptions,
): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['INSTAR_SESSION_ID', options.sessionId],
  ];
  if (options.codexHome) {
    out.push(['CODEX_HOME', options.codexHome]);
  }
  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) {
      if (SESSION_EXTRA_HARD_BLOCK.has(k)) continue;
      if (!SESSION_EXTRA_ALLOWLIST.has(k)) continue;
      out.push([k, v]);
    }
  }
  return out;
}

export async function spawnCodexAndWait(
  binary: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, options.timeoutMs);
    timer.unref();

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));

    child.on('error', (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (aborted) {
        const e: Error & { name?: string } = new Error('Aborted');
        e.name = 'AbortError';
        return reject(e);
      }
      if (timedOut) {
        const e: Error & { signal?: string; killed?: boolean; stderr?: string } = new Error(
          `Codex timed out after ${options.timeoutMs}ms`,
        );
        e.signal = 'SIGTERM';
        e.killed = true;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ exitCode: code, stdout, stderr });
    });

    // Close stdin immediately so Codex doesn't wait for input.
    child.stdin.end();
  });
}
