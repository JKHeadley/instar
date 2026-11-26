/**
 * freshLoginProbe — one contained, real authenticated call on a pool account's STORED login
 * (spec docs/specs/stale-process-login-expired.md, D1).
 *
 * Why: one long-running Claude Code session can show "Login expired" while the stored login is fine
 * (it holds a token another process already refreshed away). The quota poller used to treat that
 * screen as proof the login was dead. This probe tests the stored login directly, with a brand-new
 * process that can use nothing BUT that stored login: no tools, no MCP servers, no hooks, no settings
 * sources, no credential env, no transcript.
 *
 * RULE 3.1 RATIONALE
 * Criticality: moderate. An `ok` lets the poller skip or release an expired-login hold; a wrong `ok`
 *   would keep a dead login in placement. So `ok` needs every structured success field AND proof that
 *   the stored login authenticated (apiKeySource none, served by Anthropic). Anything unrecognised is
 *   `unavailable`, which keeps today's conservative behaviour.
 * Frequency: at most 6 per account per 12 h, only while that account shows an expired screen.
 * Stability: semi-stable. `--output-format stream-json` is documented; the error fields are not. The
 *   real CLI output is pinned as fixtures in tests/fixtures/fresh-login-probe/.
 * Verdict: deterministic parse of the CLI's own structured result, never of the model's wording.
 */

import { execFile } from 'node:child_process';
import { classifyClaudeAuthFailure, isUsageLimitOutput } from './claudeChildAuth.js';
import { isCredentialEnvName } from './credentialEnvNames.js';
import { resolveCliFlag } from './models.js';

export type FreshProbeVerdict = 'ok' | 'refused' | 'unavailable' | 'not-run';

export interface FreshProbeResult {
  verdict: FreshProbeVerdict;
  /** Short non-secret reason token (never raw output). */
  reason: string;
  /** Usage for the metrics row; undefined fields stay undefined (never a fabricated zero). */
  usage?: { tokensIn?: number; tokensOut?: number; tokensCached?: number; model?: string; latencyMs?: number };
}

export const FRESH_PROBE_TIMEOUT_MS = 30_000;
export const FRESH_PROBE_PROMPT = 'Reply with OK.';

/** The exact argv (after the binary). No tools, MCP, hooks, settings sources or transcript. */
export function freshProbeArgs(): string[] {
  return [
    '-p', FRESH_PROBE_PROMPT,
    '--model', resolveCliFlag('fast'),
    '--max-turns', '1',
    '--tools', '',
    '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', '{"disableAllHooks":true}',
    '--no-session-persistence',
    '--disable-slash-commands',
  ];
}

/** Env names that would let something other than the stored login answer, beyond credential-shaped ones. */
const EXTRA_STRIP_EXACT = new Set([
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDECODE', 'CLAUDE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'AWS_PROFILE',
]);
const EXTRA_STRIP_PREFIX = /^(CLAUDE_CODE_USE_|ANTHROPIC_BEDROCK_|ANTHROPIC_VERTEX_)/;

/** The probe's environment: the parent's, minus every credential and provider switch, plus the login folder. */
export function freshProbeEnv(parent: NodeJS.ProcessEnv, configHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (isCredentialEnvName(k) || EXTRA_STRIP_EXACT.has(k) || EXTRA_STRIP_PREFIX.test(k)) continue;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = configHome;
  return env;
}

interface StreamLines { init: Record<string, unknown> | null; result: Record<string, unknown> | null; resultLine: string | null }

function readStream(stdout: string): StreamLines {
  let init: Record<string, unknown> | null = null;
  let result: Record<string, unknown> | null = null;
  let resultLine: string | null = null;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(t) as Record<string, unknown>; } catch { continue; } // @silent-fallback-ok: a non-JSON line is simply not a stream event
    if (obj.type === 'system' && obj.subtype === 'init' && !init) init = obj;
    if (obj.type === 'result') { result = obj; resultLine = t; }
  }
  return { init, result, resultLine };
}

function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined; }

/**
 * Classify a finished probe from its exit status and stdout. Pure; pinned against real CLI output.
 * `timedOut` is true when the process was killed by the timeout.
 */
export function classifyFreshProbe(input: { exitCode: number | null; timedOut: boolean; stdout: string }): FreshProbeResult {
  if (input.timedOut) return { verdict: 'unavailable', reason: 'timeout' };
  const { init, result, resultLine } = readStream(input.stdout);
  if (!result || !resultLine) return { verdict: 'unavailable', reason: 'no-result-line' };
  const u = (result.usage ?? {}) as Record<string, unknown>;
  const modelUsage = (result.modelUsage ?? {}) as Record<string, unknown>;
  const model = Object.keys(modelUsage)[0];
  const usage = {
    tokensIn: num(u.input_tokens) !== undefined || num(u.cache_creation_input_tokens) !== undefined || num(u.cache_read_input_tokens) !== undefined
      ? (num(u.input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0)
      : undefined,
    tokensOut: num(u.output_tokens),
    tokensCached: num(u.cache_read_input_tokens),
    model,
    latencyMs: num(result.duration_ms),
  };
  // Auth and usage-limit readers parse ONE JSON object: hand them the result line only.
  const auth = classifyClaudeAuthFailure(resultLine);
  if (auth) return { verdict: 'refused', reason: auth === 'rejected' ? 'auth-rejected' : 'not-logged-in', usage };
  if (isUsageLimitOutput(resultLine)) return { verdict: 'not-run', reason: 'usage-limit', usage };
  if (!init || init.apiKeySource !== 'none' || init.served_by_anthropic !== true) {
    return { verdict: 'unavailable', reason: 'non-login-auth', usage };
  }
  const success = input.exitCode === 0
    && result.is_error === false
    && result.subtype === 'success'
    && (num(result.num_turns) ?? 0) >= 1
    && Boolean(model)
    && (num(u.output_tokens) ?? 0) > 0;
  return success ? { verdict: 'ok', reason: 'answered', usage } : { verdict: 'unavailable', reason: 'not-a-clean-answer', usage };
}

export interface FreshProbeRunnerDeps {
  claudePath: () => string | null;
  /** Fixed working directory (created by the caller once), so .claude.json gains one project entry at most. */
  cwd: string;
  /** Parent env; defaults to process.env. */
  env?: () => NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Spawn one probe for a login folder. Never throws; never logs raw output. */
export function runFreshLoginProbe(deps: FreshProbeRunnerDeps, configHome: string): Promise<FreshProbeResult> {
  const claudePath = deps.claudePath();
  if (!claudePath) return Promise.resolve({ verdict: 'unavailable', reason: 'no-claude-binary' });
  const env = freshProbeEnv((deps.env ?? (() => process.env))(), configHome);
  const timeout = deps.timeoutMs ?? FRESH_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    try {
      const child = execFile(claudePath, freshProbeArgs(), { timeout, maxBuffer: 1024 * 1024, env, cwd: deps.cwd }, (error, stdout) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string }) | null;
        const timedOut = Boolean(err && (err.killed || err.signal === 'SIGTERM') && !(typeof err.code === 'number'));
        const exitCode = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        resolve(classifyFreshProbe({ exitCode, timedOut, stdout: String(stdout ?? '') }));
      });
      child.stdin?.end();
    } catch {
      resolve({ verdict: 'unavailable', reason: 'spawn-failed' }); // @silent-fallback-ok: a probe that cannot start concludes nothing
    }
  });
}
