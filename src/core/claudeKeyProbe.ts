/**
 * claudeKeyProbe — one real authenticated call with exactly the given key, for ClaudeKeyHealth
 * (spec cloud-key-internal-calls). Its own door: an open circuit breaker sheds calls without spawning,
 * and the subscription router could answer from the pool without testing the key at all. It keeps the
 * host-wide spawn cap, and a cap shed concludes nothing.
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

import { execFile } from 'node:child_process';
import { classifyClaudeAuthFailure } from './claudeChildAuth.js';
import { USAGE_WALL_PATTERNS } from '../monitoring/rateLimitDetection.js';
import type { UsageProbeResult } from './UsageLimitWatch.js';
import type { ClaudeKeyProbeResult } from './ClaudeKeyHealth.js';
import { resolveCliFlag } from './models.js';
import { wrapIntelligenceWithSpawnCap } from './SpawnCapIntelligenceProvider.js';

const PROBE_TIMEOUT_MS = 30_000;

/** Read a finished call. Anything but a clean answer or a named auth failure concludes nothing. */
export function interpretProbe(failed: boolean, stdout: string): ClaudeKeyProbeResult {
  const auth = classifyClaudeAuthFailure(stdout);
  if (auth) return auth;
  if (failed) return 'inconclusive';
  try {
    return (JSON.parse(stdout) as { is_error?: unknown }).is_error === false ? 'ok' : 'inconclusive';
  } catch { return 'inconclusive'; } // @silent-fallback-ok: unreadable output concludes nothing, by design
}

/**
 * Whether this call's stdout says the account is out of usage. A 429 alone can be a server throttle,
 * so it also needs the banner's own wording (USAGE_WALL_PATTERNS, real panes and real CLI output).
 */
export function isUsageLimitOutput(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { is_error?: unknown; result?: unknown };
    return parsed?.is_error === true && typeof parsed.result === 'string' && USAGE_WALL_PATTERNS.some((p) => p.test(parsed.result as string));
  } catch { return false; } // @silent-fallback-ok: unreadable output says nothing about usage
}

function runProbe(claudePath: string, key: string, baseUrl: string | undefined): Promise<ClaudeKeyProbeResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: key };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDECODE;
  delete env.CLAUDE_SESSION_ID;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  const args = ['-p', 'Reply with OK.', '--model', resolveCliFlag('fast'), '--max-turns', '1', '--tools', '', '--output-format', 'json', '--setting-sources', 'user'];
  return new Promise((resolve) => {
    const child = execFile(claudePath, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env }, (error, stdout) => {
      resolve(interpretProbe(Boolean(error), stdout));
    });
    child.stdin?.end();
  });
}

export function buildClaudeKeyProbe(deps: { claudePath: () => string | null; baseUrl: () => string | undefined }): (key: string) => Promise<ClaudeKeyProbeResult> {
  return async (key) => {
    const claudePath = deps.claudePath();
    if (!claudePath) return 'inconclusive';
    let result: ClaudeKeyProbeResult = 'inconclusive';
    const capped = wrapIntelligenceWithSpawnCap({
      evaluate: async () => { result = await runProbe(claudePath, key, deps.baseUrl()); return result; },
    });
    try { await capped?.evaluate('claude-key-probe'); }
    catch { return 'inconclusive'; } // @silent-fallback-ok: a cap shed concludes nothing, by design
    return result;
  };
}

function runUsageProbe(claudePath: string, key: string | undefined, baseUrl: string | undefined): Promise<UsageProbeResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (key) { env.CLAUDE_CODE_OAUTH_TOKEN = key; delete env.ANTHROPIC_API_KEY; }
  delete env.CLAUDECODE;
  delete env.CLAUDE_SESSION_ID;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  const args = ['-p', 'Reply with OK.', '--model', resolveCliFlag('fast'), '--max-turns', '1', '--tools', '', '--output-format', 'json', '--setting-sources', 'user'];
  return new Promise((resolve) => {
    const child = execFile(claudePath, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env }, (error, stdout) => {
      if (isUsageLimitOutput(stdout)) { resolve('limited'); return; }
      resolve(interpretProbe(Boolean(error), stdout) === 'ok' ? 'ok' : 'other');
    });
    child.stdin?.end();
  });
}

/** One real call on the login in use (the configured key, else the default login), for UsageLimitWatch. */
export function buildUsageProbe(deps: { claudePath: () => string | null; key: () => string | undefined; baseUrl: () => string | undefined }): () => Promise<UsageProbeResult> {
  return async () => {
    const claudePath = deps.claudePath();
    if (!claudePath) return 'other';
    let result: UsageProbeResult = 'other';
    const capped = wrapIntelligenceWithSpawnCap({
      evaluate: async () => { result = await runUsageProbe(claudePath, deps.key(), deps.baseUrl()); return result; },
    });
    try { await capped?.evaluate('claude-usage-probe'); }
    catch { return 'other'; } // @silent-fallback-ok: a cap shed concludes nothing, by design
    return result;
  };
}
