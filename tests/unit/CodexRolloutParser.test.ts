/**
 * Unit tests for CodexRolloutParser — the pure parser for Codex CLI persisted
 * rollout JSONL. Fixtures mirror the empirically-captured Codex 0.133.0 shape
 * (session_meta / turn_context / event_msg+token_count).
 */
import { describe, it, expect } from 'vitest';
import { parseCodexRollout } from '../../src/monitoring/CodexRolloutParser.js';

/** Build a realistic rollout from a sequence of cumulative token totals. */
function rollout(opts: {
  id?: string;
  cwd?: string;
  ts?: string;
  model?: string;
  planType?: string;
  // each entry = the CUMULATIVE total_token_usage at that token_count event
  totals: Array<{ input: number; cached: number; output: number; reasoning: number; total: number }>;
  primaryPct?: number[];
  secondaryPct?: number[];
}): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: 'session_meta',
    payload: {
      id: opts.id ?? '019e5791-4ba8-7171-ac13-986c8a8b3215',
      timestamp: opts.ts ?? '2026-05-24T01:20:00.514Z',
      cwd: opts.cwd ?? '/Users/justin/Documents/Projects/instar-codey',
      model_provider: 'openai',
    },
  }));
  lines.push(JSON.stringify({
    type: 'turn_context',
    payload: { turn_id: 't1', model: opts.model ?? 'gpt-5.2', cwd: opts.cwd ?? '/Users/justin/Documents/Projects/instar-codey' },
  }));
  opts.totals.forEach((t, i) => {
    lines.push(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: t.input, cached_input_tokens: t.cached,
            output_tokens: t.output, reasoning_output_tokens: t.reasoning, total_tokens: t.total,
          },
          last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: opts.primaryPct?.[i] ?? 10, window_minutes: 300, resets_at: 1779588009 },
          secondary: { used_percent: opts.secondaryPct?.[i] ?? 2, window_minutes: 10080, resets_at: 1780174809 },
          plan_type: opts.planType ?? 'prolite',
        },
      },
    }));
  });
  return lines.join('\n') + '\n';
}

describe('parseCodexRollout', () => {
  it('extracts the cumulative session total from the LAST token_count event', () => {
    const content = rollout({
      totals: [
        { input: 100, cached: 90, output: 10, reasoning: 5, total: 110 },
        { input: 196779, cached: 191232, output: 2227, reasoning: 1128, total: 199006 },
      ],
    });
    const p = parseCodexRollout(content);
    expect(p).not.toBeNull();
    // last reading wins (cumulative), not a sum of the two
    expect(p!.totalTokens).toBe(199006);
    expect(p!.inputTokens).toBe(196779);
    expect(p!.cachedInputTokens).toBe(191232);
    expect(p!.outputTokens).toBe(2227);
    expect(p!.reasoningOutputTokens).toBe(1128);
    expect(p!.tokenCountEvents).toBe(2);
  });

  it('captures session id, cwd, model and plan type', () => {
    const p = parseCodexRollout(rollout({
      id: 'abc-123', cwd: '/tmp/proj', model: 'gpt-5.5', planType: 'pro',
      totals: [{ input: 1, cached: 0, output: 1, reasoning: 0, total: 2 }],
    }));
    expect(p!.sessionId).toBe('abc-123');
    expect(p!.cwd).toBe('/tmp/proj');
    expect(p!.model).toBe('gpt-5.5');
    expect(p!.planType).toBe('pro');
  });

  it('captures the latest subscription usage percentages', () => {
    const p = parseCodexRollout(rollout({
      totals: [
        { input: 1, cached: 0, output: 1, reasoning: 0, total: 2 },
        { input: 2, cached: 0, output: 2, reasoning: 0, total: 4 },
      ],
      primaryPct: [5, 12.5],
      secondaryPct: [1, 3],
    }));
    expect(p!.primaryUsedPercent).toBe(12.5);
    expect(p!.secondaryUsedPercent).toBe(3);
  });

  it('parses session_meta.timestamp into firstTs (epoch ms)', () => {
    const p = parseCodexRollout(rollout({
      ts: '2026-05-24T01:20:00.514Z',
      totals: [{ input: 1, cached: 0, output: 1, reasoning: 0, total: 2 }],
    }));
    expect(p!.firstTs).toBe(Date.parse('2026-05-24T01:20:00.514Z'));
  });

  it('returns null when there is no usage reading (empty/aborted session)', () => {
    const onlyMeta = JSON.stringify({ type: 'session_meta', payload: { id: 'x', timestamp: '2026-05-24T01:20:00.514Z', cwd: '/tmp' } }) + '\n';
    expect(parseCodexRollout(onlyMeta)).toBeNull();
  });

  it('returns null when there is no session id', () => {
    const noId = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5 } }, rate_limits: {} },
    }) + '\n';
    expect(parseCodexRollout(noId)).toBeNull();
  });

  it('tolerates malformed and partial lines without throwing', () => {
    const content = rollout({ totals: [{ input: 10, cached: 0, output: 5, reasoning: 0, total: 15 }] })
      + 'this is not json\n'
      + '{"type":"event_msg","payload":{"type":"token_count","info":{"total_to';  // truncated
    const p = parseCodexRollout(content);
    expect(p).not.toBeNull();
    expect(p!.totalTokens).toBe(15);
  });

  it('returns null on empty input', () => {
    expect(parseCodexRollout('')).toBeNull();
  });
});
