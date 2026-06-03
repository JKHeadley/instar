/**
 * Phase 1b: verifies the CircuitBreakingIntelligenceProvider funnel tap records
 * per-feature metrics to the injected recorder — for success, error, the
 * circuit-open skip, and the rate-limit wait path — and is a safe no-op with no
 * recorder. Spec: docs/specs/llm-feature-metrics-spec.md.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CircuitBreakingIntelligenceProvider,
  setFeatureMetricsRecorder,
  type FeatureMetricsRecorder,
} from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import { LlmCircuitOpenError } from '../../src/core/LlmCircuitBreaker.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

function fakeBreaker(opts: {
  allow?: boolean;
  waitAllow?: boolean;
} = {}): any {
  return {
    acquire: () => ({ allow: opts.allow ?? true, retryAfterMs: 1000 }),
    acquireOrWait: vi.fn(async () => ({ allow: opts.waitAllow ?? true, retryAfterMs: 1000 })),
    onResolved: vi.fn(),
    onRateLimited: vi.fn(),
  };
}

const recorded: Array<Record<string, unknown>> = [];
const recorder: FeatureMetricsRecorder = { record: (e) => { recorded.push(e as Record<string, unknown>); } };

afterEach(() => {
  setFeatureMetricsRecorder(null);
  recorded.length = 0;
  vi.restoreAllMocks();
});

describe('CircuitBreakingIntelligenceProvider — feature metrics tap (Phase 1b)', () => {
  it('records a success as outcome=noop with the feature label + latency', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());

    const res = await p.evaluate('judge this', { attribution: { component: 'MessagingToneGate' } });

    expect(res).toBe('ok');
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toMatchObject({ feature: 'MessagingToneGate', kind: 'llm', outcome: 'noop', waited: false });
    expect(typeof recorded[0].latencyMs).toBe('number');
  });

  it('buckets calls with no attribution under "unlabeled"', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x');
    expect(recorded[0].feature).toBe('unlabeled');
  });

  it('records a failure as outcome=error and still rethrows', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: async () => { throw new Error('boom'); } };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());

    await expect(p.evaluate('x', { attribution: { component: 'CoherenceReviewer' } })).rejects.toThrow('boom');
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toMatchObject({ feature: 'CoherenceReviewer', outcome: 'error' });
  });

  it('records the rate-limit wait path with waited=true + waitMs', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    // circuit initially closed, but the wait path clears it.
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker({ allow: false, waitAllow: true }));

    const res = await p.evaluate('x', { attribution: { component: 'CoherenceGate' }, rateLimitWaitMs: 500 } as any);

    expect(res).toBe('ok');
    expect(recorded[0]).toMatchObject({ feature: 'CoherenceGate', outcome: 'noop', waited: true, waitMs: 500 });
  });

  it('records the circuit-open skip as a no-op (waited) and throws LlmCircuitOpenError', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: vi.fn(async () => 'should-not-run') };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker({ allow: false, waitAllow: false }));

    await expect(p.evaluate('x', { attribution: { component: 'X' }, rateLimitWaitMs: 200 } as any)).rejects.toBeInstanceOf(LlmCircuitOpenError);
    expect(inner.evaluate).not.toHaveBeenCalled();
    expect(recorded[0]).toMatchObject({ feature: 'X', outcome: 'noop', waited: true });
  });

  it('is a safe no-op when no recorder is set (and never breaks the call)', async () => {
    setFeatureMetricsRecorder(null);
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await expect(p.evaluate('x')).resolves.toBe('ok');
    expect(recorded.length).toBe(0);
  });

  it('a throwing recorder never breaks the LLM path', async () => {
    setFeatureMetricsRecorder({ record: () => { throw new Error('ledger down'); } });
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await expect(p.evaluate('x')).resolves.toBe('ok');
  });

  it('feeds the REAL FeatureMetricsLedger end-to-end (funnel → ledger → queryable rollup)', async () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    try {
      setFeatureMetricsRecorder(ledger); // FeatureMetricsLedger structurally satisfies FeatureMetricsRecorder
      const ok: IntelligenceProvider = { evaluate: async () => 'ok' };
      const bad: IntelligenceProvider = { evaluate: async () => { throw new Error('boom'); } };

      await new CircuitBreakingIntelligenceProvider(ok, fakeBreaker()).evaluate('a', { attribution: { component: 'ToneGate' } });
      await new CircuitBreakingIntelligenceProvider(ok, fakeBreaker()).evaluate('b', { attribution: { component: 'ToneGate' } });
      await expect(new CircuitBreakingIntelligenceProvider(bad, fakeBreaker()).evaluate('c', { attribution: { component: 'ToneGate' } })).rejects.toThrow();

      const tone = ledger.byFeature().find(f => f.feature === 'ToneGate')!;
      expect(tone.calls).toBe(3);
      expect(tone.llmCalls).toBe(3);
      expect(tone.errors).toBe(1);
      expect(tone.noop).toBe(2);
    } finally {
      ledger.close();
    }
  });

  // ── Iris-audit item 1: token usage now reaches the tap ──────────────────
  // Before this fix the tap recorded latency/outcome/count but NO tokens, so
  // /metrics/features always reported tokensIn:0/tokensOut:0. The provider now
  // surfaces usage via options.onUsage, which the funnel forwards to the recorder.

  it('forwards provider token usage (onUsage) into the recorder', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = {
      evaluate: async (_p, opts) => { opts?.onUsage?.({ inputTokens: 1234, outputTokens: 56 }); return 'ok'; },
    };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x', { attribution: { component: 'ToneGate' } });
    expect(recorded[0]).toMatchObject({ feature: 'ToneGate', outcome: 'noop', tokensIn: 1234, tokensOut: 56 });
  });

  it('composes with (does not clobber) a caller-supplied onUsage', async () => {
    setFeatureMetricsRecorder(recorder);
    const callerSpy = vi.fn();
    const inner: IntelligenceProvider = {
      evaluate: async (_p, opts) => { opts?.onUsage?.({ inputTokens: 10, outputTokens: 2 }); return 'ok'; },
    };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x', { onUsage: callerSpy });
    expect(callerSpy).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 2 });
    expect(recorded[0]).toMatchObject({ tokensIn: 10, tokensOut: 2 });
  });

  it('records no tokens when the provider surfaces none (back-compat, omitted not 0)', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x');
    expect(recorded[0].tokensIn).toBeUndefined();
    expect(recorded[0].tokensOut).toBeUndefined();
  });

  it('sums token usage into the REAL ledger rollup (tokensIn/tokensOut no longer 0)', async () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    try {
      setFeatureMetricsRecorder(ledger);
      const inner: IntelligenceProvider = {
        evaluate: async (_p, opts) => { opts?.onUsage?.({ inputTokens: 100, outputTokens: 20 }); return 'ok'; },
      };
      await new CircuitBreakingIntelligenceProvider(inner, fakeBreaker()).evaluate('a', { attribution: { component: 'Tok' } });
      await new CircuitBreakingIntelligenceProvider(inner, fakeBreaker()).evaluate('b', { attribution: { component: 'Tok' } });

      const tok = ledger.byFeature().find(f => f.feature === 'Tok')!;
      expect(tok.tokensIn).toBe(200);
      expect(tok.tokensOut).toBe(40);
    } finally {
      ledger.close();
    }
  });
});
