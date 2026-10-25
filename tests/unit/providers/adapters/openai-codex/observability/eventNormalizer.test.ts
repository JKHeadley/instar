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

  it('classifies the 404 model-removal signature as unsupported too', () => {
    // The SECOND retirement shape (observed 2026-09-09 for gpt-5.5). When
    // OpenAI removes an id outright rather than de-listing it from the
    // ChatGPT surface, Codex returns a 404 with backtick-quoted wording. This
    // previously fell through to 'unknown', so the model-retirement self-heal
    // in CodexCliIntelligenceProvider never fired and every call using that id
    // failed forever — the fleet-wide outage this test exists to prevent.
    const result = normalizeCodexJsonlEvent(
      JSON.stringify({
        type: 'error',
        message:
          'Reconnecting... 2/5 (unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.)',
      }),
    );
    expect(result?.type).toBe('error');
    if (result?.type === 'error') expect(result.errorKind).toBe('unsupported');
  });

  it('matches the 404 removal signature regardless of how the id is quoted', () => {
    for (const quoted of ['`gpt-5.5`', "'gpt-5.5'", '"gpt-5.5"']) {
      const result = normalizeCodexJsonlEvent(
        JSON.stringify({
          type: 'error',
          message: `The model ${quoted} does not exist or you do not have access to it.`,
        }),
      );
      expect(result?.type).toBe('error');
      if (result?.type === 'error') expect(result.errorKind).toBe('unsupported');
    }
  });

  it('does NOT let the model-not-found wording mask a real auth / throttle failure', () => {
    // ORDERING GUARD. A single Codex message can carry BOTH a specific failure
    // token AND the model-not-found wording. If the 404 branch is matched
    // first, those messages silently reclassify as a retryable retirement —
    // hiding a genuine auth or rate-limit failure from every consumer of
    // errorKind and sending the self-heal off to swap models over a problem
    // that swapping cannot fix. The 404 branch must stay BELOW the specific
    // ones; this test fails if anyone moves it back up.
    const cases: Array<[string, string]> = [
      ['unexpected status 403 Forbidden: The model `gpt-6-pro` does not exist or you do not have access to it.', 'auth'],
      ['invalid token: The model "gpt-5.5" does not exist or you do not have access to it.', 'auth'],
      ['unexpected status 429 rate limit: The model `gpt-6-astra` does not exist or you do not have access to it.', 'rate-limit'],
      ['quota exceeded: The model `gpt-6-astra` does not exist or you do not have access to it.', 'quota'],
    ];
    for (const [message, expected] of cases) {
      const result = normalizeCodexJsonlEvent(JSON.stringify({ type: 'error', message }));
      expect(result?.type).toBe('error');
      if (result?.type === 'error') expect(result.errorKind).toBe(expected);
    }
  });

  it('sits ABOVE timeout as well as above network, per the source comment', () => {
    // Closes the one remaining slot of slack. The two bounds above still pass
    // if the branch is moved down by exactly one, to between `timeout` and
    // `network` — which contradicts the ordering the source comment states and
    // leaves a genuine 504/408-carrying retirement message classified as a
    // timeout. Pinning this makes the stated ordering binding rather than
    // aspirational, so the comment and the behaviour cannot drift apart.
    const result = normalizeCodexJsonlEvent(
      JSON.stringify({
        type: 'error',
        message:
          'unexpected status 504 Gateway Timeout: The model `gpt-5.5` does not exist or you do not have access to it.',
      }),
    );
    expect(result?.type).toBe('error');
    if (result?.type === 'error') expect(result.errorKind).toBe('unsupported');
  });

  it('still classifies the REAL outage message as a retirement, despite Reconnecting/ECONN', () => {
    // LOWER ORDERING BOUND. The verbatim message from the 2026-09-09 fleet
    // outage. Codex prefixes its retries with "Reconnecting... 2/5 (…)", and
    // "R-ECONN-ecting" matches the network branch's /ECONN/i — so if the 404
    // branch is placed BELOW `network`, this real message classifies as
    // 'network', the self-heal never fires, and the outage this whole change
    // exists to fix stays unfixed. That is not hypothetical: it is what
    // happened when the branch was first moved to the end of the chain.
    const result = normalizeCodexJsonlEvent(
      JSON.stringify({
        type: 'error',
        message:
          'Reconnecting... 2/5 (unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.)',
      }),
    );
    expect(result?.type).toBe('error');
    if (result?.type === 'error') expect(result.errorKind).toBe('unsupported');
  });

  it('does NOT treat a generic 404 as a retryable model retirement', () => {
    // The retry authority swaps models on 'unsupported'. A 404 that is not
    // Codex's quoted-model-id wording (a bad route, a missing rollout file)
    // must stay unclassified so the caller surfaces it unchanged instead of
    // silently retrying on a different model.
    for (const message of [
      '404 Not Found',
      'unexpected status 404 Not Found: no such endpoint',
      'The file does not exist or you do not have access to it.',
    ]) {
      const result = normalizeCodexJsonlEvent(JSON.stringify({ type: 'error', message }));
      expect(result?.type).toBe('error');
      if (result?.type === 'error') expect(result.errorKind).not.toBe('unsupported');
    }
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
