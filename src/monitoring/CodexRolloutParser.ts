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

import crypto from 'node:crypto';

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

/**
 * One rollout entry, classified for the context-budget transcript detection
 * channel (context-budget-layered-summaries §9.1, §9.6 Codex column).
 *
 * Measured 2026-11-10 on this machine's rollouts (Codex CLI 0.156.1, 0.166.0,
 * 0.167.0; 173 `compacted` entries across a 606-file sample): Codex WRITES an
 * engine-native compaction entry, `{"type":"compacted","payload":{...}}`, with
 * a `window_id` on every one, an empty `message` (no summary) and the
 * replacement history. A forked (subagent) rollout copies its parent's
 * `compacted` entries into an inherited prefix BEFORE its own first
 * `token_count` (11 of 11 pre-usage entries were in forked rollouts; 0 in root
 * rollouts), so a compaction counts only after the rollout's first usage
 * reading — the caller tracks that per transcript.
 */
export type CodexRolloutEntry =
  | { kind: 'meta'; version: string | null; forkedFrom: string | null }
  | { kind: 'usage'; contextUsed: number | null; contextWindow: number | null }
  | { kind: 'compacted'; windowId: string; at: number | null; tokensBefore: number | null }
  /**
   * A real user prompt (a `response_item` message with role `user` whose text is
   * not one of Codex's own tagged context blocks such as `<environment_context>`).
   * `topic`: it names a topic (`[telegram:N]`), so the per-prompt hook would
   * carry the next-prompt seed (§9.6) on it. `textSha256` identifies the prompt.
   */
  | { kind: 'prompt'; at: number | null; topic: boolean; textSha256: string }
  /**
   * The next-prompt seed as the MODEL received it: a developer message with a
   * line that is the seed header (the per-prompt hook's output, recorded by
   * Codex as model input). `nonce`: the delivered packet's 8-hex nonce, or null.
   */
  | { kind: 'seed'; at: number | null; nonce: string | null };

/** The first line of a delivered Codex next-prompt seed (written by the server, read back from the rollout). */
export const CODEX_SEED_HEADER = '=== CONTEXT RECOVERY (post-compaction, delivered with this prompt) ===';

/** Cheap pre-filter: only these lines are parsed by the channel. */
export function codexRolloutLineMayMatter(line: string): boolean {
  return line.includes('"compacted"') || line.includes('"token_count"') || line.includes('"session_meta"') || line.includes('"role":"user"')
    || line.includes('CONTEXT RECOVERY (post-compaction, delivered with this prompt)');
}

export function classifyCodexRolloutEntry(d: Record<string, unknown>): CodexRolloutEntry | null {
  const type = d['type'];
  const payload = (d['payload'] && typeof d['payload'] === 'object' ? d['payload'] : {}) as Record<string, unknown>;
  if (type === 'session_meta') {
    return { kind: 'meta', version: typeof payload['cli_version'] === 'string' ? payload['cli_version'] as string : null, forkedFrom: typeof payload['forked_from_id'] === 'string' ? payload['forked_from_id'] as string : null };
  }
  if (type === 'event_msg' && payload['type'] === 'token_count') {
    const info = (payload['info'] && typeof payload['info'] === 'object' ? payload['info'] : {}) as Record<string, unknown>;
    const last = (info['last_token_usage'] && typeof info['last_token_usage'] === 'object' ? info['last_token_usage'] : {}) as Record<string, unknown>;
    const used = Number(last['input_tokens']);
    const win = Number(info['model_context_window']);
    return { kind: 'usage', contextUsed: Number.isFinite(used) && used > 0 ? used : null, contextWindow: Number.isFinite(win) && win > 0 ? win : null };
  }
  if (type === 'response_item' && payload['type'] === 'message' && (payload['role'] === 'user' || payload['role'] === 'developer')) {
    const content = Array.isArray(payload['content']) ? payload['content'] as Array<Record<string, unknown>> : [];
    const first = content.find((c) => typeof c?.['text'] === 'string');
    const raw = typeof first?.['text'] === 'string' ? first['text'] as string : '';
    const ts = typeof d['timestamp'] === 'string' ? Date.parse(d['timestamp'] as string) : NaN;
    const at = Number.isFinite(ts) ? ts : null;
    if (payload['role'] === 'developer') {
      // The hook prints the time block first, so the header is a line of the message, not necessarily its start.
      if (!raw.split('\n').some((ln) => ln.trim() === CODEX_SEED_HEADER)) return null;
      const m = /\n--- STANDING PACKET ([0-9a-f]{8}) ---\n/.exec(raw);
      return { kind: 'seed', at, nonce: m ? m[1] : null };
    }
    const text = raw.trimStart();
    if (text === '' || text.startsWith('<')) return null; // Codex's own context blocks travel as user-role messages
    return { kind: 'prompt', at, topic: /\[telegram:\d+/.test(text), textSha256: crypto.createHash('sha256').update(raw).digest('hex') };
  }
  if (type === 'compacted') {
    const windowId = payload['window_id'];
    if (typeof windowId !== 'string' || windowId.length === 0 || windowId.length > 200) return null;
    const ts = typeof d['timestamp'] === 'string' ? Date.parse(d['timestamp'] as string) : NaN;
    const rec = (payload['latest_token_usage_record'] && typeof payload['latest_token_usage_record'] === 'object' ? payload['latest_token_usage_record'] : null) as Record<string, unknown> | null;
    const usage = (rec?.['usage'] && typeof rec['usage'] === 'object' ? rec['usage'] : null) as Record<string, unknown> | null;
    const before = Number(usage?.['input_tokens']);
    return { kind: 'compacted', windowId, at: Number.isFinite(ts) ? ts : null, tokensBefore: Number.isFinite(before) && before > 0 ? before : null };
  }
  return null;
}
