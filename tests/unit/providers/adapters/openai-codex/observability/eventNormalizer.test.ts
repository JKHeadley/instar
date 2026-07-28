/**
 * Direct tests for the Codex event normalizer. Complements the canary
 * by asserting individual edge cases (empty lines, malformed JSON,
 * partial lines, unknown event types).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeCodexJsonlEvent,
  RECOGNIZED_CODEX_EVENT_TYPES,
} from '../../../../../../src/providers/adapters/openai-codex/observability/eventNormalizer.js';

describe('normalizeCodexJsonlEvent', () => {
  it('returns null for blank and non-JSON input', () => {
    expect(normalizeCodexJsonlEvent('')).toBeNull();
    expect(normalizeCodexJsonlEvent('   ')).toBeNull();
    expect(normalizeCodexJsonlEvent('plain text line')).toBeNull();
    expect(normalizeCodexJsonlEvent('{ broken json')).toBeNull();
  });

  it('maps thread.started to session-lifecycle (started) with threadId', () => {
    const result = normalizeCodexJsonlEvent('{"type":"thread.started","thread_id":"u1"}');
    expect(result?.type).toBe('session-lifecycle');
    if (result?.type === 'session-lifecycle') {
      expect(result.lifecycleKind).toBe('started');
    }
  });

  it('maps turn.completed with usage to turn-end + UsageReport', () => {
    const result = normalizeCodexJsonlEvent(
      '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":7,"cached_input_tokens":3}}',
    );
    expect(result?.type).toBe('turn-end');
    if (result?.type === 'turn-end') {
      expect(result.usage?.inputTokens).toBe(12);
      expect(result.usage?.outputTokens).toBe(7);
      expect(result.usage?.cachedTokens).toBe(3);
    }
  });

  it('classifies turn.failed as non-recoverable error', () => {
    const result = normalizeCodexJsonlEvent('{"type":"turn.failed","error":{"message":"boom"}}');
    expect(result?.type).toBe('error');
    if (result?.type === 'error') {
      expect(result.recoverable).toBe(false);
      expect(result.message).toBe('boom');
    }
  });

  it('classifies bare error as recoverable', () => {
    const result = normalizeCodexJsonlEvent('{"type":"error","message":"transient"}');
    expect(result?.type).toBe('error');
    if (result?.type === 'error') expect(result.recoverable).toBe(true);
  });

  it('routes unknown event types through provider-raw escape hatch', () => {
    const result = normalizeCodexJsonlEvent('{"type":"some.future.event","x":42}');
    expect(result?.type).toBe('provider-raw');
    if (result?.type === 'provider-raw') {
      expect(result.nativeName).toBe('some.future.event');
    }
  });

  it('classifies the exact ChatGPT model-retirement signature as unsupported', () => {
    const result = normalizeCodexJsonlEvent(
      '{"type":"error","message":"The \'gpt-5.2\' model is not supported when using Codex with a ChatGPT account."}',
    );
    expect(result?.type).toBe('error');
    if (result?.type === 'error') expect(result.errorKind).toBe('unsupported');
  });

  it('does not classify a different 400 or an auth failure as model retirement', () => {
    for (const message of ['400 invalid request body', '401 unauthorized']) {
      const result = normalizeCodexJsonlEvent(JSON.stringify({ type: 'error', message }));
      expect(result?.type).toBe('error');
      if (result?.type === 'error') expect(result.errorKind).not.toBe('unsupported');
    }
  });

  it('exports a stable set of recognized event types', () => {
    expect(RECOGNIZED_CODEX_EVENT_TYPES.has('thread.started')).toBe(true);
    expect(RECOGNIZED_CODEX_EVENT_TYPES.has('turn.completed')).toBe(true);
    expect(RECOGNIZED_CODEX_EVENT_TYPES.has('item.agentMessage.delta')).toBe(true);
    expect(RECOGNIZED_CODEX_EVENT_TYPES.size).toBeGreaterThanOrEqual(12);
  });
});
