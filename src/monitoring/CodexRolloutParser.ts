/**
 * CodexRolloutParser — pure parser for Codex CLI persisted "rollout" files.
 *
 * Codex writes one rollout JSONL per session at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Unlike the
 * streaming `--json` exec vocabulary (`turn.completed` etc., handled by
 * `openai-codex/observability/eventNormalizer.ts`), the PERSISTED rollout
 * uses a different shape — empirically (Codex CLI 0.133.0, 2026-05-23):
 *
 *   {"type":"session_meta","payload":{"id":"<uuid>","timestamp":"...","cwd":"...","model_provider":"openai",...}}
 *   {"type":"turn_context","payload":{"model":"gpt-5.2","cwd":"...",...}}
 *   {"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{...},"last_token_usage":{...}},"rate_limits":{...}}}
 *
 * `total_token_usage` is CUMULATIVE for the session, so the LAST token_count
 * event holds the session total — we take that rather than summing per-turn
 * `last_token_usage` (which would double-count re-sent cached context).
 *
 * This module is intentionally pure (no I/O) so it is trivially unit-testable
 * against a captured rollout fixture. The TokenLedger owns persistence; the
 * poller owns the filesystem walk + per-agent cwd attribution.
 *
 * Drift risk: medium — Codex CLI may rename `token_count`/`total_token_usage`
 * across versions. A returned `null` (no usable usage) degrades to "this
 * session contributes nothing", never a crash. A canary should assert the
 * recognised shape after Codex upgrades.
 */

export interface ParsedCodexSession {
  /** Codex thread/session UUID (from session_meta.payload.id). */
  sessionId: string;
  /** Working directory the session ran in — used for per-agent attribution. */
  cwd: string | null;
  /** Latest model seen in turn_context (e.g. "gpt-5.2"). Best-effort. */
  model: string | null;
  /** Subscription plan tier from rate_limits.plan_type (e.g. "prolite"). */
  planType: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** rate_limits.primary.used_percent — rolling short window (e.g. 5h). */
  primaryUsedPercent: number | null;
  /** rate_limits.secondary.used_percent — rolling long window (e.g. weekly). */
  secondaryUsedPercent: number | null;
  /** session_meta.payload.timestamp parsed to epoch ms (session start). */
  firstTs: number;
  /** How many token_count events were seen (≈ turns with a usage reading). */
  tokenCountEvents: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse the full contents of a Codex rollout JSONL file. Returns null when the
 * file carries no session id or no usage reading (an empty/aborted session).
 * Tolerant of malformed lines (skipped) and trailing partial writes.
 */
export function parseCodexRollout(content: string): ParsedCodexSession | null {
  if (!content) return null;

  let sessionId = '';
  let cwd: string | null = null;
  let model: string | null = null;
  let planType: string | null = null;
  let firstTs = 0;
  let tokenCountEvents = 0;
  let latestTotal: Record<string, unknown> | null = null;
  let latestPrimaryPct: number | null = null;
  let latestSecondaryPct: number | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = d['type'];
    const payload = (d['payload'] ?? {}) as Record<string, unknown>;

    if (type === 'session_meta') {
      if (typeof payload['id'] === 'string') sessionId = payload['id'] as string;
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'] as string;
      const tsStr = payload['timestamp'];
      if (typeof tsStr === 'string') {
        const ms = Date.parse(tsStr);
        if (!Number.isNaN(ms)) firstTs = ms;
      }
    } else if (type === 'turn_context') {
      if (typeof payload['model'] === 'string') model = payload['model'] as string;
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'] as string;
    } else if (type === 'event_msg' && payload['type'] === 'token_count') {
      const info = (payload['info'] ?? {}) as Record<string, unknown>;
      const total = info['total_token_usage'];
      if (total && typeof total === 'object') {
        latestTotal = total as Record<string, unknown>;
        tokenCountEvents += 1;
      }
      const rl = (payload['rate_limits'] ?? {}) as Record<string, unknown>;
      if (typeof rl['plan_type'] === 'string') planType = rl['plan_type'] as string;
      const primary = rl['primary'] as Record<string, unknown> | undefined;
      const secondary = rl['secondary'] as Record<string, unknown> | undefined;
      if (primary && primary['used_percent'] != null) latestPrimaryPct = num(primary['used_percent']);
      if (secondary && secondary['used_percent'] != null) latestSecondaryPct = num(secondary['used_percent']);
    }
  }

  if (!sessionId || !latestTotal) return null;

  return {
    sessionId,
    cwd,
    model,
    planType,
    inputTokens: num(latestTotal['input_tokens']),
    cachedInputTokens: num(latestTotal['cached_input_tokens']),
    outputTokens: num(latestTotal['output_tokens']),
    reasoningOutputTokens: num(latestTotal['reasoning_output_tokens']),
    totalTokens: num(latestTotal['total_tokens']),
    primaryUsedPercent: latestPrimaryPct,
    secondaryUsedPercent: latestSecondaryPct,
    firstTs,
    tokenCountEvents,
  };
}
