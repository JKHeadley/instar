/**
 * Spawn helper for the Grok Build CLI (grok-build framework integration spec
 * §4.1; probed hands-on against grok 1.0.4, 2026-08-14).
 *
 * Mirrors pi-cli/transport/piSpawn.ts (process-level structure) but encodes
 * the grok-specific credential boundary and the canonical one-shot argv.
 *
 * PROMPT VIA FILE, NEVER ARGV (spec §4.1, review-2 finding 12): `-p <PROMPT>`
 * puts the full prompt into the process argument list — host-readable by any
 * process, and length-limited. The canonical argv therefore uses
 * `--prompt-file <path>`; the caller owns the temp file's lifecycle.
 *
 * Tool confinement (spec §8 / review findings 6+8): internal one-shot calls
 * deny grok's agentic tools and web access wholesale — a completion primitive
 * must not browse or run shell. The deny list below is passed on EVERY
 * one-shot spawn, not left to the caller's memory.
 *
 * Env: explicit allowlist + unconditional hard-delete of billing-capable
 * provider vars (the same no-API-keys rule as pi). HOME is load-bearing —
 * grok resolves `~/.grok/auth.json` relative to it — and GROK_HOME passes
 * through so a relocated home stays coherent (review-2 finding 12: one root
 * for binary + auth + sessions).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  getHostSpawnSemaphore,
  resolveSpawnAcquireMs,
  resolveSpawnWaitersMax,
} from '../../../../core/hostSpawnSemaphore.js';
import { LlmCapacityUnavailableError } from '../../../../core/SpawnCapIntelligenceProvider.js';

/** Default output cap: 8 MiB per stream (runaway-child protection). */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Tools denied on every internal one-shot call. Grok's bundled toolset
 * includes shell/file/web tools; a text-completion primitive needs none of
 * them, and each is an egress or filesystem path an untrusted prompt could
 * try to steer (review-1 finding 8: an empty scratch dir is not confinement —
 * the deny list is).
 */
export const GROK_ONESHOT_DENIED_TOOLS =
  'bash,read,write,edit,glob,grep,web_search,web_fetch';

/**
 * The canonical one-shot argv. PROBED (grok 1.0.4):
 *
 *   grok --prompt-file <file> --output-format json --disable-web-search
 *        --disallowed-tools <list> [-m <model>]
 *
 * - `--prompt-file` — prompt from a file, never argv (see header).
 * - `--output-format json` — one JSON envelope on stdout carrying `text`,
 *   `stopReason`, `usage{...}`, `total_cost_usd`, `modelUsage{...}`
 *   (envelope shape probed; parsing lives in oneShotCompletion.ts).
 * - `--disable-web-search` + `--deny <RULE>` × 8 + `--disallowed-tools` — the
 *   confinement floor. **`--deny` PERMISSION RULES are the primary bound**
 *   (round-19). `--tools ''` was removed: it is inert on 1.0.4, and naming it
 *   "the primary bound" here — 30 lines above the code that no longer emits it
 *   — is the stale-header defect a round-19 reviewer found while the body
 *   already carried the correction.
 *
 *   Residual, stated here because the body's measurement establishes it:
 *   `--deny` VALUES are unvalidated (`--deny BogusRuleXyz` leaks a canary that
 *   `--deny Read` blocks, with no error either way), so a vendor rule rename
 *   removes the bound silently. And the floor governs CLIENT-DISPATCHED tools
 *   only — grok's model-native server-side tools (X search at minimum) run
 *   under this exact argv and never reach the permission layer. See the spec's
 *   confinement section.
 *
 *   Why, measured against grok 1.0.4 rather than argued (2026-08-15):
 *     - flag NAMES are validated — `--disable-web-searchXYZ` exits 2
 *       ("unexpected argument"), so a vendor RENAMING or REMOVING a safety flag
 *       fails the spawn closed by the argument parser, not by our policy;
 *     - flag VALUES are NOT — `--disallowed-tools bogus_tool_xyz` exits 0
 *       silently. So a deny list is open-by-default against tool-NAME drift:
 *       rename a tool vendor-side and it silently stops being denied, with no
 *       error to notice. That is exactly the residual the spec had accepted as
 *       "widens the surface until re-pinned".
 *
 *   An empty allow list removes that residual instead of bounding it: the
 *   one-shot reviewer reads a prompt file and writes a verdict, so it needs NO
 *   built-in tool, and naming zero permitted tools cannot be drifted by any
 *   vendor rename or addition. Verified live on the real lane (exit 0, valid
 *   envelope, `stopReason: end_turn`) before this change landed — a confinement
 *   tightening that silently broke the only live lane would be the worse bug.
 * - `-m <model>` appended only when configured; else grok's default.
 */
/**
 * Permission DENY rules — the load-bearing confinement (round-18, measured).
 *
 * Capitalised rule names, which is grok's permission-rule vocabulary, distinct
 * from the lowercase tool ids `--disallowed-tools` takes. Verified to bind:
 * `--deny Read` stops a file read that succeeds without it.
 */
export const GROK_ONESHOT_DENY_RULES = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
] as const;

export function buildGrokOneShotArgv(model: string | undefined, promptFile: string): string[] {
  return [
    '--prompt-file',
    promptFile,
    '--output-format',
    'json',
    '--disable-web-search',
    // ROUND-18: the PRIMARY bound is `--deny` PERMISSION RULES. Round-17 put it
    // on `--tools ''`, which is INERT — measured against grok 1.0.4 with a
    // probe whose only success signal is a real side effect:
    //
    //   no tool flags at all      → read a scratch file (probe works)
    //   --tools ''                → read the file (empty allow list IGNORED)
    //   --disallowed-tools <list> → read the file (deny list IGNORED, either case)
    //   the EXACT round-17 argv   → read the file
    //   --deny Read               → BLOCKED
    //
    // grok has two mechanisms one character apart: `--disallowed-tools <TOOLS>`
    // ("built-in tools to remove") does nothing on this version, while
    // `--deny <RULE>` ("permission deny rule") binds. Round 17 measured that
    // grok validates flag NAMES but not flag VALUES, and then concluded an
    // empty VALUE would be honoured — its own measurement predicted the
    // opposite. The round-17 verification (exit 0, valid envelope,
    // `stopReason: end_turn`) is satisfied IDENTICALLY whether tools are
    // removed or the flag is discarded, and the test asserted `argv[i+1] === ''`
    // — our own constant against itself. Neither could detect this.
    //
    // Verified BOTH directions before landing: with these rules a file-read
    // attempt is BLOCKED, and an ordinary completion still returns its text.
    // A confinement change that silently broke the only live lane would be the
    // worse bug.
    ...GROK_ONESHOT_DENY_RULES.flatMap((rule) => ['--deny', rule]),
    // Retained as defence in depth ONLY, and explicitly NOT load-bearing: it is
    // inert on 1.0.4 and its names were Claude Code's, five of which match
    // nothing in grok. Kept in case a future version honours it; it must never
    // again be described as a bound.
    '--disallowed-tools',
    GROK_ONESHOT_DENIED_TOOLS,
    ...(model ? ['-m', model] : []),
  ];
}

/**
 * Env allowlist for grok child processes — the no-API-keys rule.
 *
 * Grok authenticates via `$GROK_HOME/auth.json` (subscription session from
 * `grok login`). HOME and GROK_HOME pass through so it resolves that file;
 * PATH so it can run. Billing-capable provider vars are hard-deleted — for
 * grok specifically, XAI_API_KEY present in the child env IS the documented
 * fallback billing path (spec §3.1), so its deletion is load-bearing, not
 * hygiene. (policy.ts refuses the call even earlier when the PARENT env
 * carries a key; this layer makes the child env clean regardless.)
 */
const GROK_ENV_ALLOWLIST = [
  // Filesystem / identity — HOME is load-bearing (auth.json resolution).
  'HOME',
  'USER',
  'LOGNAME',
  // Home relocation — binary/auth/sessions share this root.
  'GROK_HOME',
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

/** Billing-capable vars UNCONDITIONALLY deleted from the child env. */
export const GROK_BILLING_ENV_VARS = [
  'XAI_API_KEY',
  'GROK_DEPLOYMENT_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/** Build the env for a `grok` child process per the no-API-keys rule. */
export function buildGrokChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GROK_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of GROK_BILLING_ENV_VARS) {
    delete env[key];
  }
  // grok must not believe it runs inside a Claude Code session.
  delete env['CLAUDECODE'];
  // FORCED LOGIN-POLICY LOCKDOWN (security/adversarial round-4 HIGH): the
  // adapter OWNS the child env, so the vendor's api-key kill switch is
  // FORCED per spawn rather than trusted from mutable disk state. The CLI
  // treats this env as sticky (OR-ed into the merge base; a user config
  // cannot turn it back off) — so every adapter-spawned grok child runs
  // with the primary billing control in force regardless of which
  // verification path passed.
  env['GROK_DISABLE_API_KEY_AUTH'] = '1';
  return env;
}

export interface GrokSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the STDOUT capture hit the byte cap (the child is killed —
   *  the envelope is the payload, so a capped stdout is unrecoverable). */
  truncated: boolean;
  /** True when stderr hit its cap. Further stderr is DRAINED AND DISCARDED
   *  rather than killing the child (scalability round-5: chatty diagnostics
   *  must not discard a run whose tokens are already spent on an invisible
   *  pool); the run itself proceeds to its stdout envelope. */
  stderrTruncated: boolean;
}

export interface SpawnGrokOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  /** Working directory for the child. ALWAYS a fresh scratch dir — never the
   *  server's project root (security round-3 finding 5). */
  cwd?: string;
  signal?: AbortSignal;
  /** Hard cap on captured stdout/stderr bytes (each stream). */
  maxOutputBytes?: number;
}

/**
 * Spawn `grok` with the given argv and wait for completion. Same discipline
 * as spawnPiAndWait: immediate stdin EOF, SIGTERM→SIGKILL on timeout (2s
 * grace), AbortSignal handling, per-stream byte caps flagging `truncated`.
 * Spawned WITHOUT a shell — argv elements are never re-parsed.
 */
/** Poll interval for a host spawn slot (the budget + waiter ceiling come
 *  from the canonical resolvers — same knobs as every other funnel rider:
 *  INSTAR_SPAWN_ACQUIRE_MS / INSTAR_SPAWN_WAITERS_MAX, scalability r4). */
const SPAWN_SLOT_POLL_MS = 100;

// Grok waiters share the FLOOR's observability contract: a bounded count of
// concurrent pollers, shed loudly when full (never an unbounded spin set).
let _grokActiveWaiters = 0;
/** Test/observability seam: grok callers currently polling for a slot. */
export function grokActiveSpawnWaiters(): number {
  return _grokActiveWaiters;
}

export async function spawnGrokAndWait(
  binary: string,
  args: string[],
  options: SpawnGrokOptions,
): Promise<GrokSpawnResult> {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  // FORK-BOMB FLOOR (scalability round-3 finding 2): grok-build is excluded
  // from internal ROUTING, so its callers construct the adapter directly and
  // would otherwise bypass the host-wide spawn semaphore every other LLM
  // spawn rides ("every LLM provider rides the spawn-cap funnel" —
  // Bounded Blast Radius). Acquire a slot here, at the true spawn
  // chokepoint, with a bounded poll; saturation SHEDS (throws) rather than
  // stacking unbounded grok processes.
  const semaphore = getHostSpawnSemaphore();
  const slotId = `grok-build-${randomUUID()}`;
  const acquireMs = resolveSpawnAcquireMs();
  const waitersMax = resolveSpawnWaitersMax();
  const throwIfAborted = () => {
    if (options.signal?.aborted) {
      const e: Error & { name?: string } = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
  };
  throwIfAborted();
  let acquired = semaphore.acquire(slotId, 'background');
  if (!acquired) {
    if (_grokActiveWaiters >= waitersMax) {
      // Poller ceiling: shed instead of adding an unbounded spinner.
      throw new LlmCapacityUnavailableError('waiters-full', 0);
    }
    _grokActiveWaiters++;
    const start = Date.now();
    try {
      while (!acquired && Date.now() - start < acquireMs) {
        // Abort observed DURING the wait (adversarial round-5: an abort
        // fired while queued must not spawn a token-burning child that
        // then reports ordinary success).
        throwIfAborted();
        await new Promise<void>((r) => {
          const t = setTimeout(r, SPAWN_SLOT_POLL_MS);
          t.unref?.();
        });
        acquired = semaphore.acquire(slotId, 'background');
      }
    } finally {
      _grokActiveWaiters--;
    }
    if (!acquired) {
      throw new LlmCapacityUnavailableError('acquire-timeout', Date.now() - start);
    }
  }
  try {
    throwIfAborted(); // last check before the child exists
  } catch (e) {
    semaphore.release(slotId);
    throw e;
  }
  // Residency is measured from SPAWN, not from mkdtemp (scalability
  // round-7): the acquire wait elapses after the scratch dir's mtime was
  // set, so refresh it here — a queued call can never age past the
  // janitor's cutoff while still waiting for its slot.
  if (options.cwd) {
    try {
      const now = new Date();
      fs.utimesSync(options.cwd, now, now);
    } catch {
      /* best-effort */
    }
  }

  const runPromise = new Promise<GrokSpawnResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
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
      // Same escalation as the timeout/cap paths: an aborted child that
      // ignores SIGTERM must not linger burning tokens (adversarial r4).
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let stderrTruncated = false;
    const stdoutCapTriggered = () => {
      if (truncated) return;
      truncated = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };

    child.stdout.on('data', (b: Buffer) => {
      if (stdoutBytes >= maxBytes) {
        stdoutCapTriggered();
        return;
      }
      const remaining = maxBytes - stdoutBytes;
      if (b.length > remaining) {
        stdoutChunks.push(b.subarray(0, remaining));
        stdoutBytes = maxBytes;
        stdoutCapTriggered();
      } else {
        stdoutChunks.push(b);
        stdoutBytes += b.length;
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      // stderr cap: DRAIN AND DISCARD past the bound — never kill the child
      // for chatty diagnostics (the stdout envelope is the paid-for payload).
      if (stderrBytes >= maxBytes) {
        stderrTruncated = true;
        return;
      }
      const remaining = maxBytes - stderrBytes;
      if (b.length > remaining) {
        stderrChunks.push(b.subarray(0, remaining));
        stderrBytes = maxBytes;
        stderrTruncated = true;
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
          `grok timed out after ${options.timeoutMs}ms`,
        );
        e.signal = 'SIGTERM';
        e.killed = true;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ exitCode: code, stdout, stderr, truncated, stderrTruncated });
    });

    // Close stdin immediately so grok doesn't wait for input.
    child.stdin.end();
  });

  try {
    return await runPromise;
  } finally {
    try {
      semaphore.release(slotId);
    } catch {
      /* double-release is a no-op by construction */
    }
  }
}
