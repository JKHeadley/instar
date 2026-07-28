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
import { mkdtempSync, promises as fsp, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeFsExecutor } from '../../../../core/SafeFsExecutor.js';

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
  /** tmux session name — exposed as INSTAR_SESSION_NAME for Threadline binding. */
  sessionName?: string;
  codexHome?: string;
  extraEnv?: Readonly<Record<string, string>>;
}

export function buildCodexTmuxSessionEnv(
  options: BuildCodexTmuxSessionEnvOptions,
): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['INSTAR_SESSION_ID', options.sessionId],
  ];
  if (options.sessionName) {
    // Threadline binding: attributes a relay-send to its origin session.
    out.push(['INSTAR_SESSION_NAME', options.sessionName]);
  }
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
    // Swallow readable-side pipe errors (EIO/EBADF) — an unhandled stream
    // 'error' is an uncaughtException; the failure surfaces via close/exit.
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

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

// ── codex exec --json streaming spawn (token-audit-completeness spec) ──────
//
// The `--json` event stream is strictly larger than plain output, and
// execFile's maxBuffer overflow does not truncate — it KILLS the child and
// fails the call, making long calls (the cartographer-sweep class) MORE
// likely to fail. This streaming helper bounds memory instead: lines are
// assembled across chunk boundaries via a carry buffer capped at 2 MB (an
// over-cap line is discarded unparsed and counted — usage events are <1 KB,
// so the cap cannot lose usage), stderr is drained continuously (an
// undrained pipe wedges a chatty-stderr child on the 64 KB OS buffer — a
// hang class execFile did not have), and the promise settles from the
// `close` handler after the carry flush, so ALL onLine callbacks complete
// before settlement. A bounded post-`exit` grace (default 5 s) covers a
// grandchild holding the inherited stdout fd past SIGKILL.

/** Carry-buffer cap for event-line assembly (2 MB). */
export const EXEC_JSON_CARRY_CAP_BYTES = 2 * 1024 * 1024;

export interface SpawnCodexExecJsonOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  /**
   * Prompt text written to the child's stdin (then stdin is ended). The
   * prompt moves OFF argv in --json mode: process argv is world-readable
   * (`ps`), cartographer-sweep-class prompts embed repo content, and macOS
   * ARG_MAX (~1 MB) would hard-fail large prompts.
   */
  prompt: string;
  /** Complete event lines, called BEFORE the promise settles. Must not throw. */
  onLine: (line: string) => void;
  /** An over-cap line was discarded unparsed (counted for the drift tripwire). */
  onOversizedLine?: () => void;
  /**
   * Optional early-terminal-settle predicate. Called after `onLine` for each
   * complete line; return true once the stream has delivered a terminal result
   * the caller already holds (codex emits its final `agent_message` item, then
   * `turn.completed`). On the FIRST true return the child is given
   * `terminalSettleGraceMs` to exit on its own; if it is STILL running after
   * the grace, the promise settles immediately (`terminalCompletion: true`) and
   * the lingering child is reaped (SIGTERM → sigkillGrace → SIGKILL).
   *
   * WHY (codex 0.144 shutdown-linger regression, 2026-07-09): `codex exec
   * --json` on 0.144 writes `--output-last-message` and exits ~16-30s AFTER
   * emitting `turn.completed` (empirically measured; the linger scales with
   * host concurrency). Waiting for that deferred exit trips the caller's
   * timeout on an ALREADY-COMPLETED call AND holds the host spawn-cap slot for
   * the entire linger — which is exactly the ~92% internal-call failure the
   * upgrade produced. This lets the caller settle on the result it already
   * holds via the structured event stream. A CLI that exits PROMPTLY (no
   * linger) settles via `close` BEFORE the grace elapses, so its behavior is
   * byte-for-byte unchanged (`terminalCompletion` stays false) — the divergence
   * is confined to the linger regime.
   */
  settleOnTerminalLine?: (line: string) => boolean;
  /** Grace before reaping a lingering child after the terminal line (default 750ms). */
  terminalSettleGraceMs?: number;
  /** Test seams. */
  spawnImpl?: typeof spawn;
  /** Bounded post-exit grace before forced settlement (default 5000 ms). */
  postExitGraceMs?: number;
  /** SIGTERM → SIGKILL grace (house standard 2000 ms). */
  sigkillGraceMs?: number;
}

export interface ExecJsonResult {
  exitCode: number | null;
  /** Rolling tail (last 600 chars) of the child's stderr. */
  stderrTail: string;
  /**
   * True when the promise settled via the early-terminal-settle path (the turn
   * terminally completed but the child was still lingering past
   * `terminalSettleGraceMs`, so it was reaped). `exitCode` is then whatever the
   * child had reported by then (usually null — it had not exited yet). When
   * false/absent, settlement came from the child's own exit/close (or timeout),
   * exactly as before. See `settleOnTerminalLine`.
   */
  terminalCompletion?: boolean;
}

export class CodexExecJsonTimeoutError extends Error {
  readonly stderrTail: string;
  readonly killed = true;
  readonly signal = 'SIGTERM';
  constructor(timeoutMs: number, stderrTail: string) {
    super(`Codex exec --json timed out after ${timeoutMs}ms`);
    this.name = 'CodexExecJsonTimeoutError';
    this.stderrTail = stderrTail;
  }
}

/**
 * Spawn `codex exec --json ...` and stream its event lines to `onLine`.
 *
 * Settlement contract (the spec's "settlement ordering"): the timeout timer
 * only INITIATES the kill sequence (SIGTERM → sigkillGraceMs → SIGKILL); the
 * promise settles from the `close` handler — after the carry flush — or at a
 * bounded post-`exit` grace when `close` is deferred by a held fd. Either
 * way, every onLine callback (including the final post-SIGTERM flush) has
 * completed before the promise settles, exactly once.
 *
 * Resolution: `{ exitCode, stderrTail }` for ANY exit (the caller decides
 * what a non-zero exit means). Rejection: spawn error, or timeout
 * (CodexExecJsonTimeoutError — after the final flush, so already-parsed
 * usage is never lost to the reject path).
 */
export async function spawnCodexExecJson(
  binary: string,
  args: string[],
  options: SpawnCodexExecJsonOptions,
): Promise<ExecJsonResult> {
  const spawnFn = options.spawnImpl ?? spawn;
  const postExitGraceMs = options.postExitGraceMs ?? 5000;
  const sigkillGraceMs = options.sigkillGraceMs ?? 2000;
  const terminalSettleGraceMs = options.terminalSettleGraceMs ?? 750;

  return new Promise<ExecJsonResult>((resolve, reject) => {
    const child = spawnFn(binary, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    let exitCode: number | null | undefined;
    let stderrTail = '';
    let carry = '';
    let discardingOversized = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let killEscalation: NodeJS.Timeout | undefined;
    let terminalArmed = false;
    let terminalGraceTimer: NodeJS.Timeout | undefined;

    const emitLine = (line: string): void => {
      try {
        options.onLine(line);
      } catch {
        /* @silent-fallback-ok: a consumer throw must never wedge the stream */
      }
      // Early-terminal-settle detection runs AFTER onLine so the usage
      // accumulator (and any result capture) has already seen this line —
      // e.g. turn.completed's usage is parsed before we consider reaping.
      if (!terminalArmed && !settled && options.settleOnTerminalLine) {
        let hit = false;
        try {
          hit = options.settleOnTerminalLine(line);
        } catch {
          /* @silent-fallback-ok: a predicate throw must never wedge the stream */
        }
        if (hit) armTerminalReap();
      }
    };

    const noteOversized = (): void => {
      try {
        options.onOversizedLine?.();
      } catch {
        /* @silent-fallback-ok */
      }
    };

    const processChunk = (chunk: string): void => {
      let data = chunk;
      while (data.length > 0) {
        const nl = data.indexOf('\n');
        if (discardingOversized) {
          if (nl === -1) return; // keep discarding until the line ends
          discardingOversized = false;
          noteOversized();
          data = data.slice(nl + 1);
          continue;
        }
        if (nl === -1) {
          carry += data;
          if (carry.length > EXEC_JSON_CARRY_CAP_BYTES) {
            carry = '';
            discardingOversized = true;
          }
          return;
        }
        const line = carry + data.slice(0, nl);
        carry = '';
        if (line.length > EXEC_JSON_CARRY_CAP_BYTES) {
          noteOversized(); // complete line over the cap — discarded unparsed
        } else if (line.length > 0) {
          emitLine(line);
        }
        data = data.slice(nl + 1);
      }
    };

    const flushCarry = (): void => {
      if (discardingOversized) {
        discardingOversized = false;
        noteOversized();
      } else if (carry.length > 0) {
        emitLine(carry);
      }
      carry = '';
    };

    const settle = (opts?: { terminal?: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killEscalation) clearTimeout(killEscalation);
      if (terminalGraceTimer) clearTimeout(terminalGraceTimer);
      // Final accounting BEFORE settlement — the post-SIGTERM token_count
      // flush must reach the consumer before any reject is observable.
      flushCarry();
      try {
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* @silent-fallback-ok */
      }
      if (spawnError) return reject(spawnError);
      if (timedOut) return reject(new CodexExecJsonTimeoutError(options.timeoutMs, stderrTail));
      resolve({ exitCode: exitCode ?? null, stderrTail, terminalCompletion: opts?.terminal === true });
    };

    // Early-terminal-settle: the caller signalled (via settleOnTerminalLine)
    // that the stream delivered a terminal result it already holds. Give the
    // child a brief grace to exit on its own (preserving the normal exit/close
    // path for a prompt-exiting CLI); if it is still lingering after the grace
    // (the codex 0.144 shutdown-linger regression), settle NOW with the result
    // in hand and reap the child so the spawn-cap slot + process free
    // immediately instead of stalling the caller's timeout.
    const armTerminalReap = (): void => {
      if (terminalArmed || settled) return;
      terminalArmed = true;
      terminalGraceTimer = setTimeout(() => {
        if (settled) return; // child exited on its own within the grace
        // Resolve FIRST (settle() runs the final flush, so turn.completed's
        // usage has already reached the accumulator), THEN reap the lingering
        // child. The reap timers are unref'd so they never hold the event loop.
        settle({ terminal: true });
        try {
          child.kill('SIGTERM');
        } catch {
          /* @silent-fallback-ok */
        }
        const esc = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* @silent-fallback-ok */
          }
        }, sigkillGraceMs);
        esc.unref();
      }, terminalSettleGraceMs);
      terminalGraceTimer.unref();
    };

    // Timeout: the timer only INITIATES the kill sequence; settlement waits
    // for close (or the post-exit grace) so the final flush is never lost.
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* @silent-fallback-ok */
      }
      killEscalation = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* @silent-fallback-ok */
        }
      }, sigkillGraceMs);
      killEscalation.unref();
    }, options.timeoutMs);
    killTimer.unref();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => processChunk(chunk));
    // Readable-side stream errors (rare: EIO/EBADF on the pipe) are the same
    // uncaughtException-takes-down-the-server class the stdin handler guards;
    // the failure surfaces via the exit/close path.
    child.stdout.on('error', () => {});

    // stderr drained CONTINUOUSLY for the child's lifetime — rolling
    // 600-char tail, chunks discarded.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-600);
    });
    child.stderr.on('error', () => {});

    child.on('error', (err) => {
      spawnError = err instanceof Error ? err : new Error(String(err));
      settle();
    });

    child.on('exit', (code) => {
      exitCode = code;
      // `close` can be indefinitely deferred by a grandchild holding the
      // inherited stdout fd past SIGKILL — bound it.
      graceTimer = setTimeout(settle, postExitGraceMs);
      graceTimer.unref();
    });

    child.on('close', (code) => {
      if (exitCode === undefined) exitCode = code;
      settle();
    });

    // stdin error contract: the designed failure paths (old-CLI unknown-flag
    // fast-exit; SIGTERM mid-drain) close the pipe while a cartographer-class
    // multi-MB prompt may still be writing — an unhandled stream 'error' is
    // an uncaughtException that takes down the whole agent server. The
    // failure itself is surfaced via the non-zero-exit / timeout paths.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
      /* other stdin errors are equally non-actionable here — the exit path reports */
    });
    // Write the prompt, then end (json mode's stdin hygiene: write+end).
    child.stdin.end(options.prompt);
  });
}

// ── per-call out-dir lifecycle + bounded stale sweep ───────────────────────
//
// The --output-last-message file lives in a FRESH per-call mkdtemp dir
// (0700, unguessable suffix) — NOT the long-lived cached scratch dir, whose
// existsSync reuse branch does not re-verify ownership/mode and must never
// have model output written into or read from it.

const CODEX_OUT_DIR_PREFIX = 'instar-codex-out-';

/** In-process registry of live out-dirs — the stale sweep always skips these. */
const inFlightOutDirs = new Set<string>();

export function createCodexOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), CODEX_OUT_DIR_PREFIX));
  inFlightOutDirs.add(dir);
  return dir;
}

/**
 * Remove a per-call out-dir. Pinned nesting per spec:
 * `try { safeRm(dir) } finally { set.delete(dir) }` — a throwing deletion
 * (EPERM, sandbox-revoked tmp access) cannot leak the in-flight entry.
 * Never throws into the call path.
 */
export function cleanupCodexOutDir(dir: string): void {
  try {
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'codex exec-json out-dir cleanup',
      });
    } finally {
      inFlightOutDirs.delete(dir);
    }
  } catch {
    /* @silent-fallback-ok: cleanup must never throw into the judgment-call path; the stale sweep is the backstop */
  }
}

/** Sweep brakes (P19 — every one unit-tested). */
export const CODEX_OUT_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // rate floor: once/hour/process
export const CODEX_OUT_SWEEP_AGE_MS = 6 * 60 * 60 * 1000; // ≫ any supported judgment-call timeout
export const CODEX_OUT_SWEEP_MAX_DELETIONS = 20;
export const CODEX_OUT_SWEEP_MAX_CANDIDATES = 200;

let lastSweepAt = 0;

export interface SweepStaleCodexOutDirsOptions {
  /** Test seams. */
  now?: () => number;
  tmpDirOverride?: string;
  lstatImpl?: (p: string) => Promise<Stats>;
}

/**
 * Opportunistic, bounded sweep of stale `instar-codex-out-*` dirs left by
 * CRASHED processes (the in-process `finally` covers everything else).
 *
 * Fire-and-forget async — NEVER awaited by evaluate() (os.tmpdir() population
 * scales with the whole machine; a synchronous readdir+lstat pass inside a
 * judgment call would block the single server event loop on foreign state).
 * `lastSweepAt` is set BEFORE the pass starts so concurrent calls cannot
 * double-trigger. os.tmpdir() is hostile on Linux (world-writable /tmp): each
 * candidate is lstat-verified — a directory, NOT a symlink, owned by this
 * uid, mtime older than the threshold — and EPERM/ENOENT during deletion is
 * swallowed, never thrown into the call path.
 *
 * Returns the sweep promise when a pass started (for tests), null when
 * rate-floored.
 */
export function maybeSweepStaleCodexOutDirs(
  options: SweepStaleCodexOutDirsOptions = {},
): Promise<void> | null {
  const now = options.now?.() ?? Date.now();
  if (now - lastSweepAt < CODEX_OUT_SWEEP_INTERVAL_MS) return null;
  lastSweepAt = now; // set before the pass starts — no double-trigger
  const tmp = options.tmpDirOverride ?? tmpdir();
  const lstat = options.lstatImpl ?? fsp.lstat;

  return (async () => {
    try {
      const entries = await fsp.readdir(tmp);
      let examined = 0;
      let deleted = 0;
      for (const name of entries) {
        if (!name.startsWith(CODEX_OUT_DIR_PREFIX)) continue;
        if (examined >= CODEX_OUT_SWEEP_MAX_CANDIDATES) break;
        if (deleted >= CODEX_OUT_SWEEP_MAX_DELETIONS) break;
        const full = join(tmp, name);
        // A live long call's dir can never be deleted from this process.
        if (inFlightOutDirs.has(full)) continue;
        examined++;
        let st: Stats;
        try {
          st = await lstat(full);
        } catch {
          continue;
        }
        // lstat: a symlink reports isSymbolicLink, not isDirectory — planted
        // symlinks and foreign dirs are skipped.
        if (!st.isDirectory()) continue;
        const uid = process.getuid?.();
        if (uid !== undefined && st.uid !== uid) continue;
        if (now - st.mtimeMs < CODEX_OUT_SWEEP_AGE_MS) continue;
        try {
          await SafeFsExecutor.safeRm(full, {
            recursive: true,
            force: true,
            operation: 'codex exec-json stale out-dir sweep',
          });
          deleted++;
        } catch {
          /* @silent-fallback-ok: EPERM/ENOENT on a hostile tmp entry is skipped, never thrown */
        }
      }
    } catch {
      /* @silent-fallback-ok: the sweep is belt-and-suspenders housekeeping */
    }
  })();
}

/** Test-only internals. */
export const _codexOutDirInternals = {
  inFlightOutDirs,
  resetSweepClock(): void {
    lastSweepAt = 0;
  },
};
