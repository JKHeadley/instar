/**
 * ClaudeCliIntelligenceProvider — IntelligenceProvider using the Claude CLI.
 *
 * Uses `claude -p` (print mode) to route judgment calls through the Agent SDK
 * credit path (prepaid as part of the Max subscription) and, by extension, the
 * subscription floor when credits exhaust. This is the only IntelligenceProvider
 * implementation in Instar — direct Anthropic API calls are forbidden per
 * Rule 2 of the path constraints
 * (specs/provider-portability/04-anthropic-path-constraints.md).
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { resolveCliFlag } from './models.js';
import { assertClaudeAllowed } from './claudeForbiddenGuard.js';

const DEFAULT_MODEL = 'fast';
const DEFAULT_TIMEOUT_MS = 30_000;

const REVIEWER_SCRATCH_DIR_PREFIX = 'instar-claude-review-scratch-';

let cachedReviewerScratchDir: string | null = null;

/**
 * Lazily create + return an EMPTY, unguessable-named scratch cwd for a hardened
 * reviewer call (REVIEWER-DOOR-REWIRING §1.4). Running `claude -p` in the repo
 * root would let project-doc / cwd discovery see repo context; a neutral scratch
 * dir (mode 0700, random suffix via mkdtemp — like the codex provider's) is the
 * clean-notepad. Re-verified each call (a tmp-reaper may delete it).
 */
function resolveReviewerScratchDir(): string {
  if (cachedReviewerScratchDir && existsSync(cachedReviewerScratchDir)) return cachedReviewerScratchDir;
  cachedReviewerScratchDir = mkdtempSync(join(tmpdir(), REVIEWER_SCRATCH_DIR_PREFIX));
  return cachedReviewerScratchDir;
}

/**
 * The env-key ALLOWLIST for a hardened reviewer child (REVIEWER-DOOR-REWIRING
 * §1.4). Only what `claude -p` itself needs — NEVER agent secrets like
 * `INSTAR_AUTH_TOKEN`, `GITHUB_TOKEN`, vault material, etc. Prefix matches
 * (`LC_`, `ANTHROPIC_`) preserve locale + the operator's OWN configured
 * `ANTHROPIC_BASE_URL` proxy (§Security — the operator-controlled-endpoint
 * property), without leaking anything else.
 */
const REVIEWER_ENV_ALLOW_EXACT = new Set<string>([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
]);
const REVIEWER_ENV_ALLOW_PREFIXES = ['LC_', 'ANTHROPIC_'] as const;

/**
 * Build the ALLOWLIST-only child env for a hardened reviewer call. Strips every
 * key not on the allowlist (agent secrets never cross), and — belt-and-suspenders
 * — deletes the Claude Code session markers so a nested session can't wedge it.
 */
export function buildClaudeReviewerChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (REVIEWER_ENV_ALLOW_EXACT.has(k) || REVIEWER_ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  delete out.CLAUDECODE;
  delete out.CLAUDE_SESSION_ID;
  return out;
}

/**
 * Build the hardened `claude` argv for a reviewer call (REVIEWER-DOOR-REWIRING
 * §1.4). The prompt is NOT a positional arg (it travels via stdin), so it never
 * appears in argv. `--allowedTools ''` is an explicit EMPTY allow-list (a new
 * tool category cannot escape it, unlike a `--disallowedTools '*'` denylist);
 * `--strict-mcp-config` refuses user MCP servers. `--setting-sources user`
 * excludes project/local CLAUDE.md (kept from the base door).
 */
export function buildClaudeReviewerArgs(model: string): string[] {
  return [
    '--print',
    '--allowedTools', '',
    '--strict-mcp-config',
    '--model', model,
    '--max-turns', '1',
    '--output-format', 'json',
    '--setting-sources', 'user',
  ];
}

export class ClaudeCliIntelligenceProvider implements IntelligenceProvider {
  private claudePath: string;

  constructor(claudePath: string) {
    // Codex-only enforcement (Structure > Willpower): on a codex-only agent
    // (enabledFrameworks without 'claude-code'), constructing a Claude
    // intelligence provider is forbidden. Throw loudly here rather than
    // letting a fallback path silently use Claude on a machine where the
    // claude binary happens to be installed. Callers with a legitimate
    // "no LLM available" degradation catch ClaudeForbiddenError and disable
    // the LLM-backed feature instead of reaching for Claude.
    assertClaudeAllowed('ClaudeCliIntelligenceProvider');
    this.claudePath = claudePath;
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    // Reviewer inbound-safety hardening (REVIEWER-DOOR-REWIRING §1.4): the CONCRETE
    // resolved pin travels via reviewerHardening.model (never a tier word), and
    // the call runs locked down (empty allowed-tools, strict-mcp-config, neutral
    // scratch cwd, stdin prompt, env allowlist).
    const hardened = options?.reviewerHardening;
    const model = resolveCliFlag(hardened?.model ?? options?.model ?? DEFAULT_MODEL);
    // Observable Intelligence: surface the resolved provider/model before the
    // call runs, so the metrics funnel can attribute it even on error/timeout.
    try { options?.onModel?.({ model, framework: 'claude-code' }); } catch { /* @silent-fallback-ok: onModel is pure observability — a throw must never break the LLM path */ }

    return new Promise((resolve, reject) => {
      const args = hardened
        ? buildClaudeReviewerArgs(model)
        : [
            '-p', prompt,
            '--model', model,
            '--max-turns', '1',
            // JSON (not text) so the response carries a `usage` block. We extract the
            // answer from `.result` and surface token counts via options.onUsage —
            // the only way per-feature token cost reaches /metrics/features (the tap
            // had no usage to record under text output, so it always logged 0).
            // Iris-audit item 1, spec iris-audit-session-observability.md.
            '--output-format', 'json',
            // Exclude project/local CLAUDE.md to prevent identity context
            // from contaminating classification and evaluation prompts.
            '--setting-sources', 'user',
          ];

      // Env: hardened calls use the ALLOWLIST-only env (agent secrets never
      // cross); the default path strips only the Claude Code session markers so a
      // nested session can't wedge it (unchanged behavior).
      const childEnv = hardened
        ? buildClaudeReviewerChildEnv(process.env)
        : (() => {
            const e = { ...process.env };
            delete e.CLAUDECODE;
            delete e.CLAUDE_SESSION_ID;
            return e;
          })();

      const child = execFile(this.claudePath, args, {
        // Honor a caller-supplied per-call budget (IntelligenceOptions.timeoutMs);
        // fall back to the 30s default so every caller that omits it is unchanged.
        // LLM-backed callers on a synchronous HTTP path (e.g. the standards-
        // conformance gate reviewing a full spec) need more than 30s.
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        // Hardened reviewer replies are full spec reviews — allow a larger buffer.
        maxBuffer: hardened ? 8 * 1024 * 1024 : 1024 * 1024,
        env: childEnv,
        // Neutral scratch cwd for a hardened call (§1.4) — never the repo root.
        ...(hardened ? { cwd: resolveReviewerScratchDir() } : {}),
      }, (error, stdout, stderr) => {
        if (error) {
          // Timeout or other error — reject so caller can fall back. Include a
          // generous stderr slice so the circuit breaker's rate-limit
          // classifier (isRateLimitError) can see usage/limit language that
          // often appears past the first 200 chars. (Rate-limit detection reads
          // stderr, so the stdout text→json switch does not affect it.)
          reject(new Error(`Claude CLI error: ${error.message}${stderr ? ` — ${stderr.slice(0, 600)}` : ''}`));
          return;
        }

        resolve(parseJsonResult(stdout, options?.onUsage));
      });

      // Hardened calls pass the prompt over STDIN (§1.4) so it never appears in
      // ps-visible argv; the default path already carries it as the `-p` arg.
      if (hardened) {
        child.stdin?.write(prompt);
      }
      // Write prompt via stdin for very long prompts (belt and suspenders)
      child.stdin?.end();
    });
  }
}

/**
 * Parse `claude -p --output-format json` stdout into the response text, and
 * surface token usage via onUsage. The CLI emits a single JSON object shaped
 * `{ result: string, usage: { input_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, output_tokens, ... }, ... }`.
 *
 * Defensive by design — usage observability must never break the LLM path:
 *  - If stdout isn't valid JSON, or has no string `result`, fall back to the
 *    raw trimmed stdout (degraded, but non-crashing — same shape as the old
 *    text path would have produced).
 *  - tokensIn sums the input components actually processed (fresh + cache
 *    creation + cache read), since each is a real cost; tokensOut is
 *    output_tokens. Missing fields count as 0. onUsage fires only when at least
 *    one token count is present, and never throws into the caller.
 *  - cachedTokens (token-audit-completeness) is cache_read_input_tokens ONLY —
 *    a SUBSET of tokensIn (tokensIn's meaning unchanged). Cache CREATION costs
 *    ~1.25× fresh and stays plain input; cache READS cost ~0.1× — collapsing
 *    them would point the cost signal in two directions at once.
 */
export function parseJsonResult(
  stdout: string,
  onUsage?: (usage: { inputTokens: number; outputTokens: number; cachedTokens?: number }) => void,
): string {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON (truncated / unexpected) — return raw text, no usage.
    return trimmed;
  }
  const obj = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : null;
  if (onUsage && obj && obj.usage && typeof obj.usage === 'object') {
    try {
      const u = obj.usage as Record<string, unknown>;
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const inputTokens =
        num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
      const outputTokens = num(u.output_tokens);
      const cachedTokens = num(u.cache_read_input_tokens);
      if (inputTokens > 0 || outputTokens > 0) {
        onUsage({ inputTokens, outputTokens, cachedTokens });
      }
    } catch {
      /* usage extraction must never break the result path */
    }
  }
  if (obj && typeof obj.result === 'string') {
    return obj.result.trim();
  }
  // Valid JSON but no string result — best effort, return raw.
  return trimmed;
}
