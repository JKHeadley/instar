/**
 * Tests for PromptBuildRecall — bounded pre-reply memory recall primitive.
 *
 * Covers:
 *   - Disabled config → 'disabled' source, empty context.
 *   - No SemanticMemory → 'no-memory' source.
 *   - Empty search result → 'empty' source, caches.
 *   - Non-empty result → 'fresh' source, formats <active_memory_recall> block.
 *   - Cache: second identical call returns 'cached'.
 *   - Cache TTL expiry: re-runs after TTL elapsed.
 *   - Cache key normalization: case + whitespace insensitive.
 *   - Circuit breaker: opens after N failures, returns 'circuit-open' during cooldown.
 *   - Circuit breaker recovery: closes after cooldown.
 *   - maxRecallResults caps the number of entries pulled.
 *   - maxRecallChars caps the rendered block size; later entries are dropped.
 *   - reset() clears cache and circuit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PromptBuildRecall,
  DEFAULT_PROMPT_BUILD_RECALL_CONFIG,
  type PromptBuildRecallConfig,
} from '../../src/core/PromptBuildRecall.js';
import type { SemanticMemory } from '../../src/memory/SemanticMemory.js';

function makeStubMemory(
  results: Array<{ name: string; description?: string; confidence?: number }>,
  options: { throws?: Error } = {},
): SemanticMemory {
  let calls = 0;
  return {
    search: () => {
      calls++;
      if (options.throws) throw options.throws;
      return results;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _callCount: () => calls,
  } as unknown as SemanticMemory;
}

function makeRecall(
  results: Array<{ name: string; description?: string; confidence?: number }>,
  overrides: Partial<PromptBuildRecallConfig> = {},
  options: { throws?: Error; semanticMemory?: SemanticMemory | null; clock?: () => number } = {},
) {
  const config = { ...DEFAULT_PROMPT_BUILD_RECALL_CONFIG, enabled: true, ...overrides };
  const semanticMemory =
    options.semanticMemory === undefined ? makeStubMemory(results, { throws: options.throws }) : options.semanticMemory;
  let now = 1_000_000;
  const clock = options.clock ?? (() => now);
  const advance = (ms: number) => { now += ms; };
  return {
    recall: new PromptBuildRecall({ semanticMemory, now: clock }, config),
    advance,
  };
}

describe('PromptBuildRecall', () => {
  describe('gating', () => {
    it('returns disabled when config.enabled is false', () => {
      const { recall } = makeRecall([], { enabled: false });
      const r = recall.recall({ userMessage: 'hello' });
      expect(r.source).toBe('disabled');
      expect(r.contextText).toBe('');
    });

    it('returns no-memory when semanticMemory is null', () => {
      const { recall } = makeRecall([], {}, { semanticMemory: null });
      const r = recall.recall({ userMessage: 'hello' });
      expect(r.source).toBe('no-memory');
      expect(r.contextText).toBe('');
    });
  });

  describe('fresh recall', () => {
    it('returns fresh + formatted block on a successful search', () => {
      const { recall } = makeRecall([
        { name: 'echo-routing-pattern', description: 'use router.go() to navigate, never history.push' },
        { name: 'echo-prod-db-pool', description: 'max connections 20' },
      ]);
      const r = recall.recall({ userMessage: 'how do I route?' });
      expect(r.source).toBe('fresh');
      expect(r.resultsCount).toBe(2);
      expect(r.contextText).toContain('<active_memory_recall>');
      expect(r.contextText).toContain('echo-routing-pattern');
      expect(r.contextText).toContain('use router.go()');
      expect(r.contextText).toContain('</active_memory_recall>');
    });

    it('returns empty when search returns []', () => {
      const { recall } = makeRecall([]);
      const r = recall.recall({ userMessage: 'unknown question' });
      expect(r.source).toBe('empty');
      expect(r.contextText).toBe('');
      expect(r.resultsCount).toBe(0);
    });

    it('uses entry name even when description is missing', () => {
      const { recall } = makeRecall([{ name: 'name-only' }]);
      const r = recall.recall({ userMessage: 'x' });
      expect(r.contextText).toContain('- name-only');
      expect(r.contextText).not.toContain('- name-only:');
    });
  });

  describe('cache', () => {
    it('returns cached on identical second call within TTL', () => {
      const { recall } = makeRecall([{ name: 'a', description: 'b' }]);
      const r1 = recall.recall({ userMessage: 'hello world' });
      const r2 = recall.recall({ userMessage: 'hello world' });
      expect(r1.source).toBe('fresh');
      expect(r2.source).toBe('cached');
      expect(r2.contextText).toBe(r1.contextText);
    });

    it('normalizes case and whitespace in cache key', () => {
      const { recall } = makeRecall([{ name: 'a', description: 'b' }]);
      const r1 = recall.recall({ userMessage: '   Hello World   ' });
      const r2 = recall.recall({ userMessage: 'hello world' });
      expect(r1.source).toBe('fresh');
      expect(r2.source).toBe('cached');
    });

    it('re-runs after cache TTL elapses', () => {
      const { recall, advance } = makeRecall([{ name: 'a', description: 'b' }], { cacheTtlMs: 1000 });
      const r1 = recall.recall({ userMessage: 'q' });
      expect(r1.source).toBe('fresh');
      advance(1500);
      const r2 = recall.recall({ userMessage: 'q' });
      expect(r2.source).toBe('fresh');
    });

    it('caches the empty result too', () => {
      const { recall } = makeRecall([]);
      const r1 = recall.recall({ userMessage: 'q' });
      const r2 = recall.recall({ userMessage: 'q' });
      expect(r1.source).toBe('empty');
      expect(r2.source).toBe('cached');
    });
  });

  describe('circuit breaker', () => {
    it('opens after N consecutive failures', () => {
      const { recall } = makeRecall([], { circuitBreakerMaxFailures: 3 }, { throws: new Error('db down') });
      // Different user messages so cache doesn't hide the failures.
      expect(recall.recall({ userMessage: 'q1' }).source).toBe('error');
      expect(recall.recall({ userMessage: 'q2' }).source).toBe('error');
      expect(recall.recall({ userMessage: 'q3' }).source).toBe('error');
      // Fourth call should short-circuit before hitting search.
      expect(recall.recall({ userMessage: 'q4' }).source).toBe('circuit-open');
    });

    it('reopens after cooldown elapses', () => {
      const { recall, advance } = makeRecall(
        [],
        { circuitBreakerMaxFailures: 1, circuitBreakerCooldownMs: 10_000 },
        { throws: new Error('boom') },
      );
      expect(recall.recall({ userMessage: 'q1' }).source).toBe('error');
      expect(recall.recall({ userMessage: 'q2' }).source).toBe('circuit-open');
      advance(15_000);
      // After cooldown, breaker is willing to try again — search will fail again
      // since memory still throws, but the source is no longer 'circuit-open'.
      expect(recall.recall({ userMessage: 'q3' }).source).toBe('error');
    });

    it('resets failure count on a successful call', () => {
      // First, fail twice with a throwing memory, then swap in a working memory.
      // Easiest: stub a memory whose search behavior is configurable per call.
      let mode: 'throw' | 'ok' = 'throw';
      const mem = {
        search: () => {
          if (mode === 'throw') throw new Error('flaky');
          return [{ name: 'a', description: 'b' }];
        },
      } as unknown as SemanticMemory;
      const config = { ...DEFAULT_PROMPT_BUILD_RECALL_CONFIG, enabled: true, circuitBreakerMaxFailures: 3 };
      const recall = new PromptBuildRecall({ semanticMemory: mem }, config);
      expect(recall.recall({ userMessage: 'q1' }).source).toBe('error');
      expect(recall.recall({ userMessage: 'q2' }).source).toBe('error');
      mode = 'ok';
      const r = recall.recall({ userMessage: 'q3' });
      expect(r.source).toBe('fresh');
      // After the success, failure count is 0; subsequent throws would need 3 more
      // before the breaker opens.
      mode = 'throw';
      expect(recall.recall({ userMessage: 'q4' }).source).toBe('error');
      expect(recall.recall({ userMessage: 'q5' }).source).toBe('error');
      // Two failures should NOT have opened the breaker.
      expect(recall.recall({ userMessage: 'q6' }).source).toBe('error');
    });
  });

  describe('caps', () => {
    it('respects maxRecallResults', () => {
      const big = Array.from({ length: 20 }, (_, i) => ({ name: `e${i}`, description: `desc ${i}` }));
      const mem = { search: (_q: string, opts?: { limit?: number }) => big.slice(0, opts?.limit ?? 20) } as unknown as SemanticMemory;
      const config = { ...DEFAULT_PROMPT_BUILD_RECALL_CONFIG, enabled: true, maxRecallResults: 3 };
      const recall = new PromptBuildRecall({ semanticMemory: mem }, config);
      const r = recall.recall({ userMessage: 'x' });
      expect(r.resultsCount).toBe(3);
    });

    it('respects maxRecallChars (drops later entries that would exceed the cap)', () => {
      const big = Array.from({ length: 10 }, (_, i) => ({
        name: `entry-${i}`,
        description: 'x'.repeat(150),
      }));
      const { recall } = makeRecall(big, { maxRecallChars: 400 });
      const r = recall.recall({ userMessage: 'x' });
      expect(r.contextText.length).toBeLessThanOrEqual(400);
      // The header + footer + at least one entry should always fit.
      expect(r.contextText).toContain('<active_memory_recall>');
      expect(r.contextText).toContain('</active_memory_recall>');
    });
  });

  describe('reset', () => {
    it('clears cache and circuit', () => {
      const { recall } = makeRecall([{ name: 'a', description: 'b' }]);
      recall.recall({ userMessage: 'q' });
      expect(recall.getCacheSize()).toBe(1);
      recall.reset();
      expect(recall.getCacheSize()).toBe(0);
      const fresh = recall.recall({ userMessage: 'q' });
      expect(fresh.source).toBe('fresh');
    });
  });
});
