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
 *
 * token-audit-completeness: by default calls run as `codex exec --json`
 * (streaming event parse → per-call token usage via onUsage; result read
 * ONLY from the --output-last-message file). The kill-switch
 * `intelligence.codexExecJson: false` (or env `INSTAR_CODEX_EXEC_JSON=0`)
 * restores the previous plain-output invocation byte-for-byte.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { resolveCliModelFlag } from '../providers/adapters/openai-codex/models.js';
import {
  buildCodexChildEnv,
  spawnCodexExecJson,
  createCodexOutDir,
  cleanupCodexOutDir,
  maybeSweepStaleCodexOutDirs,
} from '../providers/adapters/openai-codex/transport/codexSpawn.js';
import { CodexUsageAccumulator } from '../providers/adapters/openai-codex/transport/codexUsageParser.js';

const DEFAULT_TIMEOUT_MS = 30_000;

const INTELLIGENCE_SCRATCH_DIR_PREFIX = 'instar-codex-intel-scratch-';

/**
 * Fail-loudly ceiling for the --output-last-message file. The old execFile
 * path had a 1 MB maxBuffer; with that gone, an unbounded read into a string
 * is the replacement hazard — so the file is size-checked before read.
 */
const MAX_RESULT_FILE_BYTES = 16 * 1024 * 1024;

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
 * NOTE: model output is NEVER written into or read from this dir — its
 * `existsSync` reuse branch does not re-verify ownership/mode. The
 * --output-last-message file lives in a fresh per-call dir instead
 * (createCodexOutDir).
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

/** Both recovery levers, named in every unknown-flag error (the kill-switch
 * contract: a recovery instruction that is false on the path emitting it is
 * a broken rollback contract). */
const EXEC_JSON_RECOVERY_LEVERS =
  'If this codex CLI predates --json/--output-last-message (< 0.20), disable exec-json mode via ' +
  '`intelligence.codexExecJson: false` in .instar/config.json or env INSTAR_CODEX_EXEC_JSON=0.';

function unknownFlagHint(stderrTail: string): string {
  return /unexpected argument|unrecognized option|unknown (option|flag)/i.test(stderrTail)
    ? ` ${EXEC_JSON_RECOVERY_LEVERS}`
    : '';
}

/** Env-only default for exec-json mode (default ON). Used when no config
 * closure was threaded (config-less construction sites keep a working
 * rollback lever). */
function execJsonEnvDefault(): boolean {
  return process.env.INSTAR_CODEX_EXEC_JSON !== '0';
}

let warnedConfigParseFailure = false;

/**
 * Build the per-call kill-switch resolver for construction sites that have a
 * project dir. Pinned closure body (spec): a TTL-cached (30 s) raw
 * `readFileSync` + `JSON.parse` of `.instar/config.json` reading ONLY
 * `intelligence.codexExecJson` — never `loadConfig()` (which drags a
 * synchronous SecretStore keychain execFileSync onto every judgment call),
 * and never a boot-time closure over the in-memory config object (no config
 * hot-reload exists, so it would never see a disk flip).
 *
 * Resolution order: the config key wins when the file parses AND the key is
 * present; otherwise — including parse/read failure — fall through to the
 * env lever (itself default-on). An operator hand-editing config under
 * pressure who leaves a JSON slip gets a once-per-process parse-failure
 * warning and a still-working env lever, not a silently-ignored kill-switch.
 * A config flip applies within 30 s, no restart.
 */
export function createCodexExecJsonConfigResolver(
  configPath: string = join(process.cwd(), '.instar', 'config.json'),
  ttlMs: number = 30_000,
): () => boolean {
  let cachedAt = 0;
  let cached: boolean | null = null;
  return () => {
    const now = Date.now();
    if (cached !== null && now - cachedAt < ttlMs) return cached;
    cachedAt = now;
    let raw: string | null = null;
    try {
      raw = readFileSync(configPath, 'utf-8');
    } catch {
      // @silent-fallback-ok: missing/unreadable config is NORMAL for
      // config-less installs — resolution falls through to the env lever
      // below, which is the designed default, not a degradation
      raw = null;
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { intelligence?: { codexExecJson?: unknown } };
        const v = parsed?.intelligence?.codexExecJson;
        if (typeof v === 'boolean') {
          cached = v;
          return v;
        }
      } catch (err) {
        // @silent-fallback-ok: NOT silent — warns once per process; an
        // operator JSON slip keeps a working env lever instead of a
        // silently-ignored kill-switch (the spec's pinned resolution order)
        if (!warnedConfigParseFailure) {
          warnedConfigParseFailure = true;
          console.warn(
            `[CodexCliIntelligenceProvider] .instar/config.json failed to parse (${(err as Error).message}) — ` +
              `intelligence.codexExecJson unavailable; falling back to env INSTAR_CODEX_EXEC_JSON`,
          );
        }
      }
    }
    cached = execJsonEnvDefault();
    return cached;
  };
}

// ── usage-parse drift tripwire ──────────────────────────────────────────────
//
// Emission is gated to ONCE PER PROCESS LIFETIME (module-level flag):
// DegradationReporter's legacy path files an external feedback report per
// event with no feedback-side cooldown, so an hourly emission would spam the
// maintainer webhook ~24×/day/machine forever (P17). Once-per-boot is
// sufficient: the durable, always-current surface is usageCoverage in
// /metrics/features, not the event. The feature string is a FIXED CONSTANT —
// it is the Telegram dedup key, and a fixed constant prevents the P17
// unique-source dodge.
const CODEX_USAGE_DRIFT_FEATURE = 'codex-usage-parse-drift';
let emittedUsageDrift = false;

function emitUsageDriftOnce(reasons: string[]): void {
  if (emittedUsageDrift) return;
  emittedUsageDrift = true;
  // Lazy import keeps the provider constructible in contexts where the
  // monitoring layer isn't initialized (CLI one-shots).
  void import('../monitoring/DegradationReporter.js')
    .then(({ DegradationReporter }) => {
      DegradationReporter.getInstance().report({
        feature: CODEX_USAGE_DRIFT_FEATURE,
        primary: 'codex exec --json per-call token usage parsed into the feature metrics ledger',
        fallback: 'call completed but token usage was not (fully) recorded',
        reason: reasons.join(','),
        impact:
          'codex-routed calls may be token-blind in /metrics/features (usageCoverage shows the live ratio)',
      });
    })
    .catch(() => {
      /* @silent-fallback-ok: drift reporting must never break the judgment path */
    });
}

/** Test-only seam. */
export function _resetUsageDriftEmissionForTest(): void {
  emittedUsageDrift = false;
  warnedConfigParseFailure = false;
}

/**
 * Parse one `codex exec --json` line for the two fields the exec-json result
 * path needs to settle EARLY under the codex 0.144 shutdown-linger regression
 * (see codexSpawn.ts `settleOnTerminalLine`): the agent's final answer text
 * (`item.completed` → `agent_message` → `text`) and whether the turn terminally
 * completed (`turn.completed`).
 *
 * SECURITY / SIGNAL-vs-AUTHORITY: this is a TYPED, top-level `JSON.parse` with
 * explicit shape checks — the SAME trust surface the usage parser already
 * applies to `turn.completed.usage` (never substring/regex matching, which
 * model content embedded in a string field could match). The `agent_message`
 * `text` field is codex's OWN structured final-answer channel — it carries the
 * IDENTICAL bytes codex writes to `--output-last-message` (codex writes that
 * file FROM the same last message). It is used as the result ONLY on the
 * early-terminal-settle path (when the child lingered past the grace and the
 * file has not yet been written); a promptly-exiting CLI still reads the file
 * as the authority, unchanged.
 */
function tryParseCodexResultEvent(
  line: string,
): { agentMessageText?: string; turnCompleted?: boolean } | null {
  const t = line.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  // Perf pre-filter — decides only whether to ATTEMPT the parse; it cannot
  // extract values (extraction is strictly the top-level JSON.parse below).
  if (!t.includes('turn.completed') && !t.includes('agent_message')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p['type'] === 'turn.completed') return { turnCompleted: true };
  if (p['type'] === 'item.completed') {
    const item = p['item'];
    if (
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>)['type'] === 'agent_message' &&
      typeof (item as Record<string, unknown>)['text'] === 'string'
    ) {
      return { agentMessageText: (item as Record<string, unknown>)['text'] as string };
    }
  }
  return null;
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
  /**
   * Per-call kill-switch read for exec-json mode (token-audit-completeness).
   * The IntelligenceRouter caches built providers, so a PER-CALL closure read
   * is what survives that caching. Construction sites with config thread
   * `createCodexExecJsonConfigResolver()`; absent the closure, the provider
   * resolves env `INSTAR_CODEX_EXEC_JSON !== '0'` so config-less sites keep a
   * working rollback lever.
   */
  resolveExecJson?: () => boolean;
}

export class CodexCliIntelligenceProvider implements IntelligenceProvider {
  private readonly codexPath: string;
  private readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  private readonly resolveExecJson: () => boolean;

  constructor(options: CodexCliIntelligenceProviderOptions) {
    this.codexPath = options.codexPath;
    this.sandboxMode = options.sandboxMode ?? 'read-only';
    this.resolveExecJson = options.resolveExecJson ?? execJsonEnvDefault;
    // options.workingDirectory is intentionally NOT stored: judgment calls
    // always run in an empty scratch dir (resolveIntelligenceScratchDir), so
    // the agent's project identity + hooks never load. The option is retained
    // on the type for API compatibility (the factory still forwards it).
    try {
      if (!this.resolveExecJson()) {
        console.warn(
          '[CodexCliIntelligenceProvider] codex exec-json disabled — codex calls are token-blind ' +
            '(usageCoverage for codex-cli will read 0)',
        );
      }
    } catch {
      /* @silent-fallback-ok: a throwing resolver must never block construction; evaluate() re-reads per call */
    }
  }

  /** Hygiene args shared by BOTH modes (clean-call spec; pinned by the
   * both-modes unit test). */
  private hygieneArgs(model: string, scratchDir: string): string[] {
    return [
      '--model',
      model,
      '--sandbox',
      this.sandboxMode,
      // Run judgment calls in an empty scratch dir, NOT the agent's project
      // dir. The project dir loads the full ~26 KB AGENTS.md identity AND
      // fires the project's .codex/hooks.json (session_start /
      // user_prompt_submit / stop) on every call. The scratch dir is the
      // Codex analog of ClaudeCliIntelligenceProvider's `--setting-sources
      // user`. See resolveIntelligenceScratchDir + the spec.
      '--cd',
      scratchDir,
      // Belt-and-suspenders: hard-disable project-doc (AGENTS.md) loading
      // even if a stray doc ever lands at or above the scratch path.
      '-c',
      'project_doc_max_bytes=0',
      // Reviewer/sentinel/canary calls are deterministic short prompts
      // that don't depend on the cwd being a trusted git repo. Codex
      // CLI's default behavior is to refuse to run when --cd points at
      // a non-git directory (it surfaces as
      //   "Not inside a trusted directory and --skip-git-repo-check was not specified")
      // which breaks every Codex-based agent whose state directory
      // isn't a git checkout. Skip the check — these calls are bounded
      // and never modify the cwd.
      '--skip-git-repo-check',
    ];
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const model = resolveCliModelFlag(options?.model);
    // Observable Intelligence: surface the resolved provider/model up front so
    // the metrics funnel attributes the call to codex on every path (including
    // failures and the plain mode, which surfaces no token usage).
    try { options?.onModel?.({ model, framework: 'codex-cli' }); } catch { /* @silent-fallback-ok: onModel is pure observability — a throw must never break the LLM path */ }

    let execJson: boolean;
    try {
      execJson = this.resolveExecJson();
    } catch {
      execJson = execJsonEnvDefault(); // a throwing resolver must not take the call down
    }
    if (execJson) {
      return this.evaluateExecJson(prompt, options, model);
    }
    return this.evaluatePlain(prompt, options, model);
  }

  /**
   * Kill-switch path — the pre-exec-json invocation, byte-for-byte (result
   * semantics included: stdout.trim(), empty answer resolves '').
   *
   * SECURITY NOTE (disclosed tradeoff, not a regression): this legacy path
   * passes the prompt as a positional argv element (ps-visible to local
   * users) and execFile's error.message embeds the full command line —
   * including the prompt — into thrown Errors. The exec-json path fixes
   * both (prompt via stdin; errors carry only a bounded stderr tail).
   * Flipping the kill-switch therefore re-opens this pre-existing
   * prompt-disclosure channel in addition to going token-blind.
   */
  private evaluatePlain(
    prompt: string,
    options: IntelligenceOptions | undefined,
    model: string,
  ): Promise<string> {
    const scratchDir = resolveIntelligenceScratchDir();

    return new Promise((resolve, reject) => {
      const args = [
        'exec',
        ...this.hygieneArgs(model, scratchDir),
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
            // Generous stderr slice so the circuit breaker's rate-limit
            // classifier can see usage/limit language past the first 200 chars.
            reject(
              new Error(
                `Codex CLI error: ${error.message}` +
                  (stderr ? ` — ${stderr.slice(0, 600)}` : ''),
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

  /**
   * Default path — `codex exec --json` with streaming usage parse. The
   * result is read from the --output-last-message file, AND ONLY from there
   * (stdout events never become the result: injection surface; Signal vs
   * Authority — events are observability signal, the file is the authority).
   */
  private async evaluateExecJson(
    prompt: string,
    options: IntelligenceOptions | undefined,
    model: string,
  ): Promise<string> {
    const scratchDir = resolveIntelligenceScratchDir();
    const outDir = createCodexOutDir();
    // Pinned ABSOLUTE: a relative path would resolve against --cd — i.e.
    // into the long-lived cached scratch dir, which must never hold model
    // output. createCodexOutDir returns an absolute mkdtemp path.
    const outFile = join(outDir, 'last-message.txt');
    const acc = new CodexUsageAccumulator();
    let exitedZero = false;
    // Early-terminal-settle capture (codex 0.144 shutdown-linger regression):
    // codex writes --output-last-message and exits ~16-30s AFTER emitting
    // turn.completed, which trips the 30s timeout on an ALREADY-COMPLETED call.
    // We capture the agent's final answer from the structured event stream so
    // the call can settle on the result it already holds. See
    // spawnCodexExecJson `settleOnTerminalLine` + `tryParseCodexResultEvent`.
    let agentMessageText: string | null = null;
    let sawTerminalTurn = false;

    try {
      const args = [
        'exec',
        '--json',
        '--output-last-message',
        outFile,
        ...this.hygieneArgs(model, scratchDir),
        // The prompt moves OFF argv in --json mode (argv is world-readable
        // via `ps`; macOS ARG_MAX ~1 MB would hard-fail large prompts). The
        // positional becomes `-` and the prompt is written to stdin.
        '-',
      ];

      const result = await spawnCodexExecJson(this.codexPath, args, {
        timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: buildCodexChildEnv(), // Spec 12 Rule 1a — both modes
        prompt,
        onLine: (line) => {
          acc.feedLine(line);
          const ev = tryParseCodexResultEvent(line);
          if (ev?.agentMessageText != null) agentMessageText = ev.agentMessageText;
          if (ev?.turnCompleted) sawTerminalTurn = true;
        },
        onOversizedLine: () => acc.noteOversizedDiscard(),
        // Settle EARLY once the terminal turn completed AND we hold its final
        // message — the codex 0.144 process may then linger ~16-30s before
        // writing the file and exiting. Requiring BOTH signals means a turn
        // that produced no message never early-settles (it falls through to
        // the file/exit path below), and a turn.failed (never turn.completed)
        // is still a genuine failure.
        settleOnTerminalLine: () => sawTerminalTurn && agentMessageText !== null,
      });

      if (result.terminalCompletion) {
        // The turn terminally completed and we hold its result via the
        // structured agent_message event; the child was reaped instead of
        // waiting for codex 0.144 to write the file and exit (which trips the
        // timeout on an already-completed call and holds the spawn-cap slot).
        // The turn completed successfully → finalize usage as a success.
        exitedZero = true;
        return (agentMessageText ?? '').trim();
      }

      if (result.exitCode === 0) exitedZero = true;
      if (result.exitCode !== 0) {
        // Bounded stderr tail only — JSONL payloads are never concatenated
        // wholesale into thrown Errors.
        throw new Error(
          `Codex CLI error (exec --json, exit ${result.exitCode})` +
            (result.stderrTail ? ` — ${result.stderrTail}` : '') +
            unknownFlagHint(result.stderrTail),
        );
      }

      // Result extraction — file only. Missing file after exit 0 rejects:
      // resolving '' would silently mask --output-last-message argument rot,
      // the worse failure (documented asymmetry vs plain mode's empty '').
      let size: number;
      try {
        size = statSync(outFile).size;
      } catch {
        throw new Error(
          'Codex CLI error: --output-last-message file missing after exit 0 ' +
            '(possible argument rot in the codex CLI).' +
            ` ${EXEC_JSON_RECOVERY_LEVERS}`,
        );
      }
      if (size > MAX_RESULT_FILE_BYTES) {
        throw new Error(
          `Codex CLI error: result file is ${size} bytes (cap ${MAX_RESULT_FILE_BYTES}) — refusing unbounded read`,
        );
      }
      // Empty-after-trim with exit 0 resolves '' (mode-equivalent with plain).
      return readFileSync(outFile, 'utf-8').trim();
    } finally {
      // Usage accounting runs BEFORE evaluate()'s promise settles (async
      // finally semantics), so the funnel's error row carries already-burned
      // tokens even on timeout/reject. onUsage fires exactly once whenever
      // usage was parsed — independent of whether the call succeeded.
      try {
        const { usage, driftReasons } = acc.finalize({ success: exitedZero });
        if (usage) {
          try {
            options?.onUsage?.({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedTokens: usage.cachedTokens,
            });
          } catch {
            /* @silent-fallback-ok: onUsage is pure observability */
          }
        }
        if (driftReasons.length > 0) emitUsageDriftOnce(driftReasons);
      } finally {
        // finally-cleanup covers ALL outcomes; the bounded stale sweep is the
        // crashed-process backstop. Fire-and-forget — never awaited.
        cleanupCodexOutDir(outDir);
        maybeSweepStaleCodexOutDirs();
      }
    }
  }
}
