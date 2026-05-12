/**
 * Unit tests for SalienceGate — decides whether a threadline reply surfaces
 * to the originating Telegram topic.
 *
 * Per THREAD-TOPIC-LINKAGE-SPEC.md §5.4.
 *
 * Covers:
 *  - LLM-backed classifier passthrough (success + caller receives verdict)
 *  - Classifier error → fallback rule applies (user-visible on first reply,
 *    agent-internal on subsequent)
 *  - Classifier timeout → fallback rule applies
 *  - No classifier configured → fallback rule applies
 *  - Fallback never throws — always returns a verdict
 */

import { describe, it, expect, vi } from 'vitest';
import { SalienceGate, type SalienceClassifyInput } from '../../src/threadline/SalienceGate.js';

function baseInput(overrides: Partial<SalienceClassifyInput> = {}): SalienceClassifyInput {
  return {
    replyBody: 'here is the data you asked for',
    purpose: 'ask agent for stripe data',
    history: [],
    isFirstReply: true,
    remoteAgent: 'ai-guy',
    ...overrides,
  };
}

describe('SalienceGate', () => {
  describe('with no classifier configured', () => {
    it('returns fallback (user-visible on first reply)', async () => {
      const gate = new SalienceGate();
      const out = await gate.evaluate(baseInput({ isFirstReply: true }));
      expect(out.verdict).toBe('user-visible');
      expect(out.fromFallback).toBe(true);
      expect(out.reason).toContain('no-classifier-configured');
    });

    it('returns fallback (agent-internal on subsequent reply)', async () => {
      const gate = new SalienceGate();
      const out = await gate.evaluate(baseInput({ isFirstReply: false }));
      expect(out.verdict).toBe('agent-internal');
      expect(out.fromFallback).toBe(true);
    });
  });

  describe('with a healthy classifier', () => {
    it('returns the classifier verdict (user-visible)', async () => {
      const classify = vi.fn().mockResolvedValue({ verdict: 'user-visible', reason: 'final answer' });
      const gate = new SalienceGate({ classify });
      const out = await gate.evaluate(baseInput());
      expect(out.verdict).toBe('user-visible');
      expect(out.reason).toBe('final answer');
      expect(out.fromFallback).toBe(false);
      expect(classify).toHaveBeenCalledTimes(1);
    });

    it('returns the classifier verdict (agent-internal)', async () => {
      const classify = vi.fn().mockResolvedValue({ verdict: 'agent-internal', reason: 'mid-negotiation' });
      const gate = new SalienceGate({ classify });
      const out = await gate.evaluate(baseInput({ isFirstReply: false }));
      expect(out.verdict).toBe('agent-internal');
      expect(out.fromFallback).toBe(false);
    });
  });

  describe('with a failing classifier', () => {
    it('falls back on thrown error (user-visible on first reply)', async () => {
      const classify = vi.fn().mockRejectedValue(new Error('rate-limited'));
      const gate = new SalienceGate({ classify });
      const out = await gate.evaluate(baseInput({ isFirstReply: true }));
      expect(out.verdict).toBe('user-visible');
      expect(out.fromFallback).toBe(true);
      expect(out.reason).toContain('rate-limited');
    });

    it('falls back on thrown error (agent-internal on subsequent reply)', async () => {
      const classify = vi.fn().mockRejectedValue(new Error('boom'));
      const gate = new SalienceGate({ classify });
      const out = await gate.evaluate(baseInput({ isFirstReply: false }));
      expect(out.verdict).toBe('agent-internal');
      expect(out.fromFallback).toBe(true);
    });
  });

  describe('with a slow classifier', () => {
    it('aborts after timeoutMs and falls back', async () => {
      const classify = vi.fn(async (_input, signal: AbortSignal) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(resolve, 1000);
        });
        return { verdict: 'user-visible' as const, reason: 'too late' };
      });
      const gate = new SalienceGate({ classify, timeoutMs: 25 });
      const out = await gate.evaluate(baseInput({ isFirstReply: true }));
      expect(out.fromFallback).toBe(true);
      expect(out.verdict).toBe('user-visible'); // first reply → user-visible
    });
  });

  describe('fallback rule (deterministic)', () => {
    it('is exposed publicly for inspection / tests', () => {
      const gate = new SalienceGate();
      const first = gate.fallback(baseInput({ isFirstReply: true }), 'forced');
      const subsequent = gate.fallback(baseInput({ isFirstReply: false }), 'forced');
      expect(first.verdict).toBe('user-visible');
      expect(subsequent.verdict).toBe('agent-internal');
      expect(first.fromFallback).toBe(true);
      expect(first.reason).toContain('forced');
    });
  });
});
