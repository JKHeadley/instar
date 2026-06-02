/**
 * Spawn helper for the Gemini CLI.
 *
 * Mirrors openai-codex/transport/codexSpawn.ts (process-level, framework-
 * agnostic structure) but encodes the Gemini-specific credential boundary
 * and the canonical one-shot argv.
 *
 * stdin discipline: like Codex, the binary may read stdin; without an
 * explicit EOF it can hang waiting for input. `spawn` + an immediate
 * `child.stdin.end()` defeats this (harmless and defensive regardless of
 * whether Gemini actually exhibits it).
 *
 * Output-byte cap (improves on codex): codexSpawn's `Buffer.concat` of
 * stdout chunks is UNBOUNDED — a runaway/looping child could OOM the
 * supervising process. `spawnGeminiAndWait` hard-caps captured stdout +
 * stderr at `maxOutputBytes` and flags the result `truncated`.
 */

import { spawn } from 'node:child_process';

/** Default output cap: 8 MiB per stream. A one-shot final message is tiny;
 *  the cap only fires on a runaway/looping child. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The canonical one-shot argv — pinned, no ambiguity.
 *
 *   gemini -m <model> --approval-mode default -p <prompt>
 *
 * - `-p/--prompt` is the documented one-shot entrypoint and takes the prompt
 *   as its SOLE value, so the prompt is exactly ONE argv element. A
 *   leading-dash prompt (`"--help me"`, `"-y do X"`) can NEVER be re-parsed
 *   as a flag — a thin but real argument-injection boundary. `--` is NOT
 *   used (the end-of-options separator is only meaningful for a positional
 *   prompt, which the canonical form never uses).
 * - `--approval-mode default` is pinned HERE (part of the canonical argv,
 *   not an optional add-on). `yolo`/`auto_edit`/`-y` let the model take
 *   filesystem/exec actions without confirmation — they are a capability-only
 *   mode, never reachable from this one-shot builder. (Analog of codex's
 *   `--sandbox read-only` pin at the call site.)
 */
export function buildGeminiOneShotArgv(model: string, prompt: string): string[] {
  return ['-m', model, '--approval-mode', 'default', '-p', prompt];
}

/**
 * Rule-1a analog — env allowlist for Gemini child processes.
 *
 * Gemini auths via `~/.gemini` cached OAuth credentials (the
 * subscription/cached-OAuth path). Like Codex, a present billing-capable
 * env var would silently route Gemini onto a billed API path instead of the
 * cached-OAuth path — the exact Codex Rule-1 leak class. This is an explicit
 * ALLOWLIST (not a blocklist): anything not listed is dropped.
 */
const GEMINI_ENV_ALLOWLIST = [
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
  // Terminal sizing
  'COLUMNS',
  'LINES',
  'ROWS',
  'TERM',
  // Gemini CLI configuration knobs (benign — model/dir overrides, NOT keys)
  'GEMINI_MODEL',
  'GEMINI_SYSTEM_MD',
  // XDG base-dir conventions
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const;

/**
 * The Google/Gemini billing-capable vars that are UNCONDITIONALLY deleted
 * from the child env, regardless of allowlist contents. Any of these present
 * would silently route Gemini onto a billed API path instead of the
 * cached-OAuth/subscription path. A false-negative (silent billing) is
 * asymmetrically costly, so the delete is unconditional and the
 * geminiKeyLeakageCanary asserts none of these ever reaches the child.
 */
export const GEMINI_BILLING_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
] as const;

/**
 * Build the env for a `gemini` child process per the Rule-1a analog.
 * Constructs an explicit allowlist (variables not listed are dropped), then
 * UNCONDITIONALLY hard-deletes every billing-capable Google/Gemini var.
 */
export function buildGeminiChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of GEMINI_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Unconditional hard-delete — belt-and-suspenders against any allowlist
  // expansion mistake AND any value that slipped through. Never billed.
  for (const key of GEMINI_BILLING_ENV_VARS) {
    delete env[key];
  }

  return env;
}

export interface GeminiSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout OR stderr capture hit the byte cap and was truncated. */
  truncated: boolean;
}

export interface SpawnGeminiOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Hard cap on captured stdout/stderr bytes (each stream). */
  maxOutputBytes?: number;
}

/**
 * Spawn `gemini` with the given argv and wait for completion.
 *
 * - Closes stdin immediately (Gemini may otherwise block waiting for EOF).
 * - SIGTERM→SIGKILL on timeout (2s grace), AbortSignal handling.
 * - Bounds captured stdout/stderr at `maxOutputBytes` (default 8 MiB),
 *   killing the child and flagging `truncated` once the cap is exceeded.
 * - The benign `Loaded cached credentials` stderr line is NOT treated as a
 *   failure — the caller only fails on a non-zero exit code.
 */
export async function spawnGeminiAndWait(
  binary: string,
  args: string[],
  options: SpawnGeminiOptions,
): Promise<GeminiSpawnResult> {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
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

    const capTriggered = () => {
      if (truncated) return;
      truncated = true;
      // Stop the runaway child once either stream hits the cap. Best-effort.
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };

    child.stdout.on('data', (b: Buffer) => {
      // Any data arriving once the cap is already full means we are dropping
      // output → flag truncated (covers the exact-boundary case where the
      // previous chunk landed us precisely AT the cap).
      if (stdoutBytes >= maxBytes) {
        capTriggered();
        return;
      }
      const remaining = maxBytes - stdoutBytes;
      if (b.length > remaining) {
        stdoutChunks.push(b.subarray(0, remaining));
        stdoutBytes = maxBytes;
        capTriggered();
      } else {
        stdoutChunks.push(b);
        stdoutBytes += b.length;
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      if (stderrBytes >= maxBytes) {
        capTriggered();
        return;
      }
      const remaining = maxBytes - stderrBytes;
      if (b.length > remaining) {
        stderrChunks.push(b.subarray(0, remaining));
        stderrBytes = maxBytes;
        capTriggered();
      } else {
        stderrChunks.push(b);
        stderrBytes += b.length;
      }
    });

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
          `Gemini timed out after ${options.timeoutMs}ms`,
        );
        e.signal = 'SIGTERM';
        e.killed = true;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ exitCode: code, stdout, stderr, truncated });
    });

    // Close stdin immediately so Gemini doesn't wait for input.
    child.stdin.end();
  });
}
