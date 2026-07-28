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
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';
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
  _resetDecisionQualityForTest();
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

  it('records the circuit-open skip as outcome=shed (no call ran) and throws LlmCircuitOpenError', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: vi.fn(async () => 'should-not-run') };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker({ allow: false, waitAllow: false }));

    await expect(p.evaluate('x', { attribution: { component: 'X' }, rateLimitWaitMs: 200 } as any)).rejects.toBeInstanceOf(LlmCircuitOpenError);
    expect(inner.evaluate).not.toHaveBeenCalled();
    // 'shed' (NOT 'noop'): the breaker refused the call, nothing ran — so it must
    // not count toward real round-trips. This is the 0ms-latency confound fix.
    expect(recorded[0]).toMatchObject({ feature: 'X', outcome: 'shed', waited: true });
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
      // Two circuit-OPEN skips: no call runs → recorded as 'shed', excluded from realCalls.
      await expect(new CircuitBreakingIntelligenceProvider(ok, fakeBreaker({ allow: false, waitAllow: false }))
        .evaluate('d', { attribution: { component: 'ToneGate' }, rateLimitWaitMs: 50 } as any)).rejects.toThrow();
      await expect(new CircuitBreakingIntelligenceProvider(ok, fakeBreaker({ allow: false, waitAllow: false }))
        .evaluate('e', { attribution: { component: 'ToneGate' }, rateLimitWaitMs: 50 } as any)).rejects.toThrow();

      const tone = ledger.byFeature().find(f => f.feature === 'ToneGate')!;
      expect(tone.calls).toBe(5);       // all funnel rows (incl. shed)
      expect(tone.shed).toBe(2);        // breaker refused 2 — no round-trip
      expect(tone.realCalls).toBe(3);   // calls − shed = honest call count
      expect(tone.llmCalls).toBe(5);
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

  // ── Observable Intelligence: provider/model attribution + fired verdict ──

  it('forwards provider model/framework (onModel) into the recorder', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = {
      evaluate: async (_p, opts) => { opts?.onModel?.({ model: 'gpt-5.4-mini', framework: 'codex-cli' }); return 'ok'; },
    };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x', { attribution: { component: 'MessageSentinel' } });
    expect(recorded[0]).toMatchObject({ feature: 'MessageSentinel', outcome: 'noop', model: 'gpt-5.4-mini', framework: 'codex-cli' });
  });

  it('composes with (does not clobber) a caller-supplied onModel', async () => {
    setFeatureMetricsRecorder(recorder);
    const callerSpy = vi.fn();
    const inner: IntelligenceProvider = {
      evaluate: async (_p, opts) => { opts?.onModel?.({ model: 'claude-haiku-4-5', framework: 'claude-code' }); return 'ok'; },
    };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x', { onModel: callerSpy } as any);
    expect(callerSpy).toHaveBeenCalledWith({ model: 'claude-haiku-4-5', framework: 'claude-code' });
    expect(recorded[0]).toMatchObject({ model: 'claude-haiku-4-5', framework: 'claude-code' });
  });

  it('attributes the model/framework on the error path too', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = {
      evaluate: async (_p, opts) => { opts?.onModel?.({ model: 'gpt-5.4-mini', framework: 'codex-cli' }); throw new Error('boom'); },
    };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await expect(p.evaluate('x', { attribution: { component: 'X' } })).rejects.toThrow('boom');
    expect(recorded[0]).toMatchObject({ outcome: 'error', model: 'gpt-5.4-mini', framework: 'codex-cli' });
  });

  it('classifyVerdict(acted:true) records outcome=fired; the caller verdictId is RELOCATED off verdict_id (FD8)', async () => {
    // llm-decision-quality-meter FD8: verdict_id on kind:'llm' rows is single-writer
    // for the seam-minted correlation id. A caller-supplied classifyVerdict.verdictId
    // no longer lands there (it becomes callerRef in the provenance row via the
    // router's settlement — the breaker drops it for llm metric rows). This direct
    // (router-bypassing) call gets a breaker-local 'b-' mint.
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'emergency-stop' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x', {
      attribution: { component: 'MessageSentinel' },
      classifyVerdict: (r) => ({ acted: r === 'emergency-stop', verdictId: 'v1' }),
    } as any);
    expect(recorded[0]).toMatchObject({ outcome: 'fired' });
    expect(recorded[0].verdictId).not.toBe('v1');
    expect(recorded[0].verdictId).toMatch(/^b-/);
  });

  it('EVERY llm metric row carries a correlation id in verdictId — success, error, and shed (always-on)', async () => {
    setFeatureMetricsRecorder(recorder);
    const ok: IntelligenceProvider = { evaluate: async () => 'ok' };
    const bad: IntelligenceProvider = { evaluate: async () => { throw new Error('boom'); } };
    await new CircuitBreakingIntelligenceProvider(ok, fakeBreaker()).evaluate('a');
    await expect(new CircuitBreakingIntelligenceProvider(bad, fakeBreaker()).evaluate('b')).rejects.toThrow('boom');
    await expect(
      new CircuitBreakingIntelligenceProvider(ok, fakeBreaker({ allow: false, waitAllow: false }))
        .evaluate('c', { rateLimitWaitMs: 50 } as any),
    ).rejects.toBeInstanceOf(LlmCircuitOpenError);
    expect(recorded).toHaveLength(3);
    for (const row of recorded) expect(row.verdictId).toMatch(/^b-/); // direct calls = breaker mints
    // Distinct decisions get distinct ids (uuid-based, never reused).
    expect(new Set(recorded.map((r) => r.verdictId)).size).toBe(3);
  });

  it('classifyVerdict(acted:false) records outcome=noop', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'normal' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x', {
      attribution: { component: 'MessageSentinel' },
      classifyVerdict: () => ({ acted: false }),
    } as any);
    expect(recorded[0]).toMatchObject({ outcome: 'noop' });
  });

  it('a throwing classifyVerdict defaults to noop and never breaks the call', async () => {
    setFeatureMetricsRecorder(recorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await expect(p.evaluate('x', { classifyVerdict: () => { throw new Error('bad'); } } as any)).resolves.toBe('ok');
    expect(recorded[0]).toMatchObject({ outcome: 'noop' });
  });

  it('surfaces provider/model + fired in the REAL ledger rollup (frameworks/models/fireRate)', async () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    try {
      setFeatureMetricsRecorder(ledger);
      const acted: IntelligenceProvider = {
        evaluate: async (_p, opts) => { opts?.onModel?.({ model: 'gpt-5.4-mini', framework: 'codex-cli' }); return 'fire'; },
      };
      const quiet: IntelligenceProvider = {
        evaluate: async (_p, opts) => { opts?.onModel?.({ model: 'gpt-5.4-mini', framework: 'codex-cli' }); return 'normal'; },
      };
      const cv = (r: string) => ({ acted: r === 'fire' });
      await new CircuitBreakingIntelligenceProvider(acted, fakeBreaker()).evaluate('a', { attribution: { component: 'MS' }, classifyVerdict: cv } as any);
      await new CircuitBreakingIntelligenceProvider(quiet, fakeBreaker()).evaluate('b', { attribution: { component: 'MS' }, classifyVerdict: cv } as any);

      const ms = ledger.byFeature().find(f => f.feature === 'MS')!;
      expect(ms.frameworks).toEqual(['codex-cli']);
      expect(ms.models).toEqual(['gpt-5.4-mini']);
      expect(ms.fired).toBe(1);
      expect(ms.noop).toBe(1);
      expect(ms.fireRate).toBeCloseTo(0.5, 5);
    } finally {
      ledger.close();
    }
  });
});
