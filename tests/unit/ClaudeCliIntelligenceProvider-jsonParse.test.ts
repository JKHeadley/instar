/**
 * Iris-audit item 1 (spec iris-audit-session-observability.md): the Claude CLI
 * provider now runs `--output-format json` and parses the result object for the
 * answer text + token usage. parseJsonResult is the pure parser; these tests
 * pin its contract — extract .result, surface usage via onUsage (summing the
 * input components), and degrade safely (never throw, never lose the answer)
 * when the output isn't the expected JSON.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseJsonResult } from '../../src/core/ClaudeCliIntelligenceProvider.js';

function jsonOut(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'the answer',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 42,
    },
    ...over,
  });
}

describe('parseJsonResult', () => {
  it('returns the trimmed .result text', () => {
    expect(parseJsonResult(jsonOut({ result: '  the answer  ' }))).toBe('the answer');
  });

  it('fires onUsage with input components summed and output_tokens', () => {
    const onUsage = vi.fn();
    parseJsonResult(jsonOut(), onUsage);
    // 10 + 100 + 1000 = 1110 input, 42 output
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 1110, outputTokens: 42 });
  });

  it('treats missing usage sub-fields as 0', () => {
    const onUsage = vi.fn();
    parseJsonResult(jsonOut({ usage: { output_tokens: 7 } }), onUsage);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 0, outputTokens: 7 });
  });

  it('does NOT fire onUsage when all token counts are zero/absent', () => {
    const onUsage = vi.fn();
    parseJsonResult(jsonOut({ usage: { input_tokens: 0, output_tokens: 0 } }), onUsage);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('does NOT fire onUsage when there is no usage block', () => {
    const onUsage = vi.fn();
    const out = JSON.stringify({ result: 'hi' });
    expect(parseJsonResult(out, onUsage)).toBe('hi');
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('falls back to raw trimmed stdout when output is not JSON (never loses the answer)', () => {
    const onUsage = vi.fn();
    expect(parseJsonResult('  plain text answer  ', onUsage)).toBe('plain text answer');
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('falls back to raw trimmed when JSON has no string result', () => {
    const out = JSON.stringify({ usage: { input_tokens: 5, output_tokens: 1 }, no_result: true });
    // No string `result` → return the raw JSON (best effort), but usage still fires.
    const onUsage = vi.fn();
    const res = parseJsonResult(out, onUsage);
    expect(res).toBe(out);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 5, outputTokens: 1 });
  });

  it('never throws when onUsage is omitted', () => {
    expect(() => parseJsonResult(jsonOut())).not.toThrow();
    expect(parseJsonResult(jsonOut())).toBe('the answer');
  });
});
