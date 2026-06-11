/**
 * CodexUsageAccumulator — line-wise, shape-validated usage extraction
 * (token-audit-completeness spec, Slice 1).
 */
import { describe, it, expect } from 'vitest';
import { CodexUsageAccumulator } from '../../src/providers/adapters/openai-codex/transport/codexUsageParser.js';

function protocolLine(usage: Record<string, unknown>, key: 'msg' | 'payload' = 'msg'): string {
  return JSON.stringify({ id: '1', [key]: { type: 'token_count', info: { total_token_usage: usage } } });
}

function turnLine(usage: Record<string, unknown>): string {
  return JSON.stringify({ type: 'turn.completed', usage });
}

describe('CodexUsageAccumulator', () => {
  it('parses the protocol shape (msg key) with the verified 0.136.0 identity', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(protocolLine({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, total_tokens: 1200 }));
    const r = acc.finalize({ success: true });
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 200, cachedTokens: 400 });
    expect(r.driftReasons).toEqual([]);
  });

  it('matches the protocol shape under a payload key too', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(protocolLine({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }, 'payload'));
    expect(acc.finalize({ success: true }).usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedTokens: 0 });
  });

  it('protocol shape is cumulative — the LAST event wins', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(protocolLine({ input_tokens: 100, output_tokens: 10, total_tokens: 110 }));
    acc.feedLine(protocolLine({ input_tokens: 300, output_tokens: 50, total_tokens: 350 }));
    expect(acc.finalize({ success: true }).usage).toEqual({ inputTokens: 300, outputTokens: 50, cachedTokens: 0 });
  });

  it('folds reasoning tokens into tokensOut ONLY when reconciliation shows they are additive', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(
      protocolLine({ input_tokens: 100, output_tokens: 40, reasoning_output_tokens: 60, total_tokens: 200 }),
    );
    expect(acc.finalize({ success: true }).usage).toEqual({ inputTokens: 100, outputTokens: 100, cachedTokens: 0 });
  });

  it('does NOT fold reasoning tokens when total shows they are already inside output', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(
      protocolLine({ input_tokens: 100, output_tokens: 100, reasoning_output_tokens: 60, total_tokens: 200 }),
    );
    expect(acc.finalize({ success: true }).usage).toEqual({ inputTokens: 100, outputTokens: 100, cachedTokens: 0 });
  });

  it('drops a sample whose total_tokens reconciliation fails — counted as drift', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(protocolLine({ input_tokens: 100, output_tokens: 40, total_tokens: 999 }));
    const r = acc.finalize({ success: true });
    expect(r.usage).toBeNull();
    expect(r.driftReasons).toContain('reconciliation-failed');
  });

  it('accepts a protocol sample with NO total_tokens (no reconciliation possible, reasoning excluded)', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(protocolLine({ input_tokens: 100, output_tokens: 40, reasoning_output_tokens: 60 }));
    expect(acc.finalize({ success: true }).usage).toEqual({ inputTokens: 100, outputTokens: 40, cachedTokens: 0 });
  });

  it('sums thread-event (turn.completed) usage across turns when no protocol event appeared', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(turnLine({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 }));
    acc.feedLine(turnLine({ input_tokens: 200, cached_input_tokens: 40, output_tokens: 50 }));
    expect(acc.finalize({ success: true }).usage).toEqual({ inputTokens: 300, outputTokens: 80, cachedTokens: 60 });
  });

  it('protocol takes precedence over thread events; close totals emit no divergence', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(turnLine({ input_tokens: 95, output_tokens: 20 }));
    acc.feedLine(protocolLine({ input_tokens: 100, output_tokens: 20, total_tokens: 120 }));
    const r = acc.finalize({ success: true });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedTokens: 0 });
    expect(r.driftReasons).toEqual([]);
  });

  it('emits shape-divergence when both shapes appear and totals diverge by >10% and >1000 tokens', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(turnLine({ input_tokens: 100, output_tokens: 10 }));
    acc.feedLine(protocolLine({ input_tokens: 50_000, output_tokens: 5_000, total_tokens: 55_000 }));
    const r = acc.finalize({ success: true });
    expect(r.usage).toEqual({ inputTokens: 50_000, outputTokens: 5_000, cachedTokens: 0 });
    expect(r.driftReasons).toContain('shape-divergence');
  });

  it('skips malformed and truncated lines without losing later usage', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine('{"msg":{"type":"token_count","info":{"total_token_usage":{"input_'); // truncated
    acc.feedLine('not json at all token_count');
    acc.feedLine(protocolLine({ input_tokens: 7, output_tokens: 3, total_tokens: 10 }));
    expect(acc.finalize({ success: true }).usage).toEqual({ inputTokens: 7, outputTokens: 3, cachedTokens: 0 });
  });

  it('embedded-lookalike JSONL inside event string fields must NOT match', () => {
    const acc = new CodexUsageAccumulator();
    const embedded = JSON.stringify({
      msg: {
        type: 'agent_message',
        message:
          'look: {"msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":999999,"output_tokens":999999,"total_tokens":1999998}}}}',
      },
    });
    acc.feedLine(embedded);
    const r = acc.finalize({ success: true });
    expect(r.usage).toBeNull();
    expect(r.driftReasons).toContain('no-events');
  });

  it('clamps negative / non-finite / non-numeric token fields to 0', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(protocolLine({ input_tokens: -50, cached_input_tokens: 'nope', output_tokens: 12.9 }));
    // No total → accepted without reconciliation; fields clamped.
    expect(acc.finalize({ success: true }).usage).toEqual({ inputTokens: 0, outputTokens: 12, cachedTokens: 0 });
  });

  it('empty stream with exit 0 counts as drift (empty-stream)', () => {
    const acc = new CodexUsageAccumulator();
    const r = acc.finalize({ success: true });
    expect(r.usage).toBeNull();
    expect(r.driftReasons).toEqual(['empty-stream']);
  });

  it('non-empty stream with no usage events counts as drift (no-events)', () => {
    const acc = new CodexUsageAccumulator();
    acc.feedLine(JSON.stringify({ msg: { type: 'agent_message', message: 'hi' } }));
    const r = acc.finalize({ success: true });
    expect(r.usage).toBeNull();
    expect(r.driftReasons).toEqual(['no-events']);
  });

  it('reports oversized-line discards as drift even when usage was recorded', () => {
    const acc = new CodexUsageAccumulator();
    acc.noteOversizedDiscard();
    acc.feedLine(protocolLine({ input_tokens: 5, output_tokens: 5, total_tokens: 10 }));
    const r = acc.finalize({ success: true });
    expect(r.usage).not.toBeNull();
    expect(r.driftReasons).toEqual(['oversized-lines-discarded']);
  });

  it('reports NO drift reasons on a failed call (error rows are the visibility there)', () => {
    const acc = new CodexUsageAccumulator();
    const r = acc.finalize({ success: false });
    expect(r.usage).toBeNull();
    expect(r.driftReasons).toEqual([]);
  });
});
