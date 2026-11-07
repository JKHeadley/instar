/**
 * claudeChildAuth — hands the agent's configured Claude sign-in key to server-side `claude`
 * children (spec cloud-key-internal-calls, fb-03ec0234-b5b).
 *
 * A key-only agent (every headless cloud install) has no stored login, so a child that runs with
 * the server's own environment answers "Not logged in". The value is the one session launch already
 * reads: `resolveAnthropicLaunchFields` into `config.sessions.anthropicApiKey`. This module adds no
 * second place to configure a key, only the way to pass it on.
 *
 * Only an oauth-token is passed. A pay-per-call API key stays with sessions: internal calls spending
 * on one needs the explicit opt-in that selectIntelligenceProvider enforces.
 *
 * The key never goes in argv. Direct children take it through their env; a child started through a
 * shell string or tmux sources a private file that the same shell deletes.
 *
 * RULE 3.1 RATIONALE (registry: core/claudeChildAuth.ts, core/claudeKeyProbe.ts)
 * Criticality: moderate. Reads a Claude CLI verdict. A wrong `rejected` would tell an operator to
 *   replace a good key, so it needs a numeric 401 seen twice. A missed verdict leaves a key undetected.
 * Frequency: per failed model call, plus probes that back off to one an hour.
 * Stability: semi-stable. `--output-format json` is a documented surface; its error fields are not.
 * Fallback: a changed shape reads as "no verdict", which concludes nothing: never a false alarm, but a
 *   dead key would go unreported until the login-screen detector sees it.
 * Verdict: deterministic, with the real CLI output pinned in tests/unit/ClaudeKeyHealth.test.ts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const OAUTH_KEY_PREFIX = 'sk-ant-oat';

let keySource: (() => string | undefined) | null = null;
let baseUrlSource: (() => string | undefined) | null = null;

/** Called once per process, right after loadConfig. Read per call, so a restored key applies at once. */
export function configureClaudeChildAuth(
  source: (() => string | undefined) | null,
  baseUrl: (() => string | undefined) | null = null,
): void {
  keySource = source;
  baseUrlSource = baseUrl;
}

/** The configured oauth-token, or undefined when none is set (or the key is not an oauth-token). */
export function configuredClaudeOauthKey(): string | undefined {
  const value = keySource?.();
  return typeof value === 'string' && value.startsWith(OAUTH_KEY_PREFIX) ? value : undefined;
}

/**
 * Set the key on a child env, the same pairing session launch uses: the token set and any API key
 * cleared, since the CLI prefers an API key over the token. Leaves the env alone when no oauth-token
 * is configured, so an agent on a stored login is unchanged.
 */
export function applyClaudeChildAuth<T extends NodeJS.ProcessEnv>(env: T): T {
  const key = configuredClaudeOauthKey();
  if (key) {
    const target: NodeJS.ProcessEnv = env;
    target.CLAUDE_CODE_OAUTH_TOKEN = key;
    delete target.ANTHROPIC_API_KEY;
    const baseUrl = baseUrlSource?.();
    if (baseUrl) target.ANTHROPIC_BASE_URL = baseUrl;
  }
  return env;
}

/** How a `claude -p` failed on auth, from its stdout JSON. Null when it was not an auth failure. */
export type ClaudeAuthFailure = 'rejected' | 'no-auth';

/**
 * Read the CLI's own verdict. Both failures exit 1 with nothing useful on stderr; the reason is only
 * in the stdout JSON (measured on Claude Code 2.1.316). `rejected` is Anthropic's 401. `no-auth` is
 * the CLI saying it has nothing to send, which with a key configured means the key never arrived.
 */
export function classifyClaudeAuthFailure(stdout: string): ClaudeAuthFailure | null {
  let parsed: { is_error?: unknown; api_error_status?: unknown; result?: unknown };
  try { parsed = JSON.parse(stdout) as typeof parsed; } catch { return null; } // @silent-fallback-ok: non-JSON output is simply not an auth verdict
  if (parsed?.is_error !== true) return null;
  if (parsed.api_error_status === 401) return 'rejected';
  return typeof parsed.result === 'string' && /^not logged in\b/i.test(parsed.result) ? 'no-auth' : null;
}

/** Heard by ClaudeKeyHealth. A signal only: it asks for a probe and decides nothing. */
export type ClaudeCallOutcome = 'ok' | ClaudeAuthFailure;
let outcomeListener: ((outcome: ClaudeCallOutcome) => void) | null = null;

export function setClaudeCallOutcomeListener(listener: ((outcome: ClaudeCallOutcome) => void) | null): void {
  outcomeListener = listener;
}

export function reportClaudeCallOutcome(outcome: ClaudeCallOutcome): void {
  try { outcomeListener?.(outcome); } catch { /* @silent-fallback-ok: a signal must never break the model call */ }
}

/** Heard by UsageLimitWatch: an internal call was refused for usage. A signal only. */
let usageLimitedListener: (() => void) | null = null;

export function setClaudeUsageLimitedListener(listener: (() => void) | null): void {
  usageLimitedListener = listener;
}

export function reportClaudeUsageLimited(): void {
  try { usageLimitedListener?.(); } catch { /* @silent-fallback-ok: a signal must never break the model call */ }
}

/**
 * Write a private file a shell can source to pick up the key, for children started through a shell
 * string or tmux, where an env option cannot reach the child and argv is not acceptable. The caller's
 * shell must delete it right after sourcing. Null when no oauth-token is configured.
 */
export function writeClaudeAuthEnvFile(dir: string): string | null {
  const key = configuredClaudeOauthKey();
  if (!key) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `.claude-auth-${crypto.randomBytes(8).toString('hex')}.env`);
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const baseUrl = baseUrlSource?.();
  const lines = [`export CLAUDE_CODE_OAUTH_TOKEN=${quote(key)}`, 'unset ANTHROPIC_API_KEY'];
  if (baseUrl) lines.push(`export ANTHROPIC_BASE_URL=${quote(baseUrl)}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

/** Shell prefix for a launch that already runs through a shell. Sources the file, then deletes it. */
export function claudeAuthShellPrefix(file: string): string {
  return `. "${file}"; rm -f "${file}";`;
}

/** Argv prefix for a launch with no shell: the key arrives through the file, then `exec` runs the real argv. */
export function claudeAuthExecPrefix(file: string): string[] {
  return ['/bin/sh', '-c', '. "$0"; rm -f "$0"; exec "$@"', file];
}

/** For a launch that failed, so its shell never ran to delete the file. */
export function removeClaudeAuthEnvFile(file: string | null): void {
  if (!file) return;
  try { SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/core/claudeChildAuth.ts:failed-launch' }); }
  catch { /* @silent-fallback-ok: already gone, which is the goal */ }
}

const SWEEP_MIN_AGE_MS = 60_000;

/** A crash between writing and sourcing can leave a file behind. Called at boot. */
export function sweepClaudeAuthEnvFiles(dir: string, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; } // @silent-fallback-ok: no directory means nothing to sweep
  for (const name of names) {
    if (!/^\.claude-auth-[0-9a-f]{16}\.env$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs < SWEEP_MIN_AGE_MS) continue; // a launch may be about to read it
      SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/core/claudeChildAuth.ts:sweep' });
      removed++;
    } catch { /* @silent-fallback-ok: already gone, which is the goal */ }
  }
  return removed;
}

/** A Claude token from `claude setup-token`. Checked by shape only: it lasts a year and is used at the first session. */
export function looksLikeClaudeToken(value: string): boolean {
  return /^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

/**
 * Writes the server sign-in token where sessions read it: `sessions.credentials.anthropic` as an
 * oauth-token (fb-7cb86d4b-1fd, read since 1.3.1615). Never the legacy field. Keeps a configured `baseUrl`.
 */
export function writeClaudeKeyToConfig(configFile: string, token: string): void {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
  const sessions = (config.sessions && typeof config.sessions === 'object' ? config.sessions : {}) as Record<string, unknown>;
  const credentials = (sessions.credentials && typeof sessions.credentials === 'object' ? sessions.credentials : {}) as Record<string, unknown>;
  const previous = credentials.anthropic as { baseUrl?: unknown } | undefined;
  credentials.anthropic = {
    kind: 'oauth-token',
    value: token.trim(),
    ...(typeof previous?.baseUrl === 'string' ? { baseUrl: previous.baseUrl } : {}),
  };
  sessions.credentials = credentials;
  config.sessions = sessions;
  const tmp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configFile);
}
