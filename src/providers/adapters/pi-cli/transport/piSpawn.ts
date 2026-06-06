/**
 * Spawn helper for the pi CLI.
 *
 * Mirrors gemini-cli/transport/geminiSpawn.ts (process-level, framework-
 * agnostic structure) but encodes the pi-specific credential boundary and the
 * canonical one-shot argv.
 *
 * The argv (`buildPiOneShotArgv`) and the JSONL event-stream facts the
 * one-shot parser depends on were verified HANDS-ON in the P0.1 eval (pi
 * 0.78.1, docs/specs/_drafts/pi-eval-report.md) — they are ground truth, not
 * inferred from docs.
 *
 * stdin discipline: like gemini, the binary may read stdin; without an
 * explicit EOF it can hang waiting for input. `spawn` + an immediate
 * `child.stdin.end()` defeats this (harmless and defensive regardless).
 *
 * Output-byte cap: captured stdout + stderr are hard-capped at
 * `maxOutputBytes` and the result is flagged `truncated` — a runaway/looping
 * child can never OOM the supervising process.
 */

import { spawn } from 'node:child_process';

/** Default output cap: 8 MiB per stream. A one-shot final message is tiny;
 *  the cap only fires on a runaway/looping child. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The canonical one-shot argv — pinned, no ambiguity. EVAL-VERIFIED (pi
 * 0.78.1, P0.1):
 *
 *   pi -p --mode json --no-session --offline [--model <pattern>] <prompt>
 *
 * - `-p` is pi's one-shot/print entrypoint.
 * - `--mode json` emits the typed JSONL event stream on stdout (the format
 *   `oneShotCompletion.ts` parses for the assistant `message_end`).
 * - `--no-session` keeps the call stateless — no session file is written
 *   (one-shot has nothing to resume).
 * - `--offline` blocks the first-boot binary fetch (pi otherwise pulls `fd` +
 *   `ripgrep` from GitHub on first run — eval caveat 2); a one-shot text
 *   completion needs neither.
 * - `--model <pattern>` is appended only when a model is configured; when
 *   omitted, pi's OWN configured default provider/model applies.
 * - The prompt is the SOLE trailing POSITIONAL — exactly ONE argv element. A
 *   leading-dash prompt (`"--help me"`, `"-y do X"`) can NEVER be re-parsed as
 *   a flag because it is the last element AND all flags precede it (same
 *   argument-injection hardening note as gemini's `-p <prompt>`).
 */
export function buildPiOneShotArgv(model: string | undefined, prompt: string): string[] {
  return [
    '-p',
    '--mode',
    'json',
    '--no-session',
    '--offline',
    ...(model ? ['--model', model] : []),
    prompt,
  ];
}

/**
 * Env allowlist for pi child processes — the no-API-keys rule.
 *
 * Pi authenticates via its OWN `~/.pi/agent/auth.json` (subscription OAuth) or
 * `~/.pi/agent/models.json` (custom-provider keys). HOME is passed through so
 * pi can find those files; PATH so it can run its tools. A billing-capable
 * provider key inherited from the parent process could silently route spend
 * onto an API account — the exact leak class the no-API-keys rule forbids. So
 * this is an explicit ALLOWLIST (anything not listed is dropped) PLUS an
 * unconditional hard-delete of every billing var below.
 */
const PI_ENV_ALLOWLIST = [
  // Filesystem / user identity — HOME is load-bearing: pi reads
  // ~/.pi/agent/auth.json + models.json relative to it.
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
  // XDG base-dir conventions
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const;

/**
 * Provider billing-capable vars UNCONDITIONALLY deleted from the child env,
 * regardless of allowlist contents. Any of these present could silently route
 * pi onto a billed API key instead of its auth.json subscription / models.json
 * custom-provider path. A false-negative (silent billing) is asymmetrically
 * costly, so the delete is unconditional.
 */
export const PI_BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/**
 * Build the env for a `pi` child process per the no-API-keys rule. Constructs
 * an explicit allowlist (variables not listed are dropped), then
 * UNCONDITIONALLY hard-deletes every billing-capable provider var and clears
 * `CLAUDECODE` (the Claude-Code session marker — pi must not believe it is
 * running inside a Claude Code session).
 */
export function buildPiChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of PI_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Unconditional hard-delete — belt-and-suspenders against any allowlist
  // expansion mistake AND any value that slipped through. Never billed.
  for (const key of PI_BILLING_ENV_VARS) {
    delete env[key];
  }

  // Pi must not inherit the Claude Code session marker.
  delete env['CLAUDECODE'];

  return env;
}

export interface PiSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout OR stderr capture hit the byte cap and was truncated. */
  truncated: boolean;
}

export interface SpawnPiOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Hard cap on captured stdout/stderr bytes (each stream). */
  maxOutputBytes?: number;
}

/**
 * Spawn `pi` with the given argv and wait for completion.
 *
 * - Closes stdin immediately (pi may otherwise block waiting for EOF).
 * - SIGTERM→SIGKILL on timeout (2s grace), AbortSignal handling.
 * - Bounds captured stdout/stderr at `maxOutputBytes` (default 8 MiB),
 *   killing the child and flagging `truncated` once the cap is exceeded.
 * - The caller fails only on a non-zero exit code; benign startup stderr lines
 *   are not treated as failures.
 */
export async function spawnPiAndWait(
  binary: string,
  args: string[],
  options: SpawnPiOptions,
): Promise<PiSpawnResult> {
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
          `Pi timed out after ${options.timeoutMs}ms`,
        );
        e.signal = 'SIGTERM';
        e.killed = true;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ exitCode: code, stdout, stderr, truncated });
    });

    // Close stdin immediately so pi doesn't wait for input.
    child.stdin.end();
  });
}
