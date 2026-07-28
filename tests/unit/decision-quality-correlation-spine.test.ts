/**
 * P2 — the correlation spine of the LLM-Decision Quality Meter
 * (docs/specs/llm-decision-quality-meter.md §5.1; FD1/FD7/FD8).
 *
 * Layer A always-on correlation, unit-tier:
 *  - mint uniqueness + `d-`/`b-` prefix shapes + machineId8 presence/absence;
 *  - the caller's options object is NEVER mutated (router-internal clone);
 *  - onCorrelationId fires synchronously at mint, exactly once per evaluate()
 *    invocation (including throwing calls), never after settlement, and a
 *    THROWING callback is contained + counted;
 *  - the mint marker is single-use at the breaker (a reused options object does
 *    not re-authorize); an inbound unmarked id is discarded;
 *  - verdict_id is stamped on every kind:'llm' metric row, always-on; a
 *    caller-supplied classifyVerdict.verdictId is relocated to callerRef
 *    (enrolled) or dropped (FD8);
 *  - options.provenance is stripped at BOTH the router and the breaker;
 *  - per-attempt capture scoping (a failed primary's usage never attributes to
 *    the settled swap attempt; a post-settlement late callback is discarded);
 *  - settlement fires exactly once on EVERY reachable evaluate() exit arm.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IntelligenceRouter, RouterFailClosedError } from '../../src/core/IntelligenceRouter.js';
import {
  CircuitBreakingIntelligenceProvider,
  setFeatureMetricsRecorder,
  type FeatureMetricsRecorder,
} from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import {
  DECISION_CORRELATION_ID,
  DECISION_MINT_MARKER,
  mintRouterCorrelationId,
  mintBreakerCorrelationId,
  setDecisionQualityMachineId,
  setDecisionQualityRecorder,
  getDecisionQualityCounters,
  _resetDecisionQualityForTest,
  type DecisionSettlement,
} from '../../src/core/decisionQualityTypes.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function fakeBreaker(opts: { allow?: boolean; waitAllow?: boolean } = {}): any {
  return {
    acquire: () => ({ allow: opts.allow ?? true, retryAfterMs: 1000 }),
    acquireOrWait: vi.fn(async () => ({ allow: opts.waitAllow ?? true, retryAfterMs: 1000 })),
    onResolved: vi.fn(),
    onRateLimited: vi.fn(),
  };
}

/** Wrap a provider in its own funnel breaker (the factory shape). */
function wrap(p: IntelligenceProvider): IntelligenceProvider {
  return new CircuitBreakingIntelligenceProvider(p, fakeBreaker());
}

/** A provider that emits model/usage then answers (or throws). */
function emittingProvider(spec: {
  label: string;
  model?: string;
  framework?: string;
  usage?: { inputTokens: number; outputTokens: number };
  throws?: string;
}): IntelligenceProvider & { seen: Array<IntelligenceOptions | undefined> } {
  const seen: Array<IntelligenceOptions | undefined> = [];
  return {
    seen,
    async evaluate(_p: string, o?: IntelligenceOptions): Promise<string> {
      seen.push(o);
      if (spec.model) o?.onModel?.({ model: spec.model, framework: spec.framework });
      if (spec.usage) o?.onUsage?.(spec.usage);
      if (spec.throws) throw new Error(spec.throws);
      return spec.label;
    },
  };
}

const metricRows: Array<Record<string, unknown>> = [];
const metricsRecorder: FeatureMetricsRecorder = {
  record: (e) => { metricRows.push(e as Record<string, unknown>); },
};

const settlements: DecisionSettlement[] = [];

beforeEach(() => {
  _resetDecisionQualityForTest();
  setDecisionQualityRecorder({ recordSettlement: (s) => { settlements.push(s); } });
});

afterEach(() => {
  setFeatureMetricsRecorder(null);
  _resetDecisionQualityForTest();
  metricRows.length = 0;
  settlements.length = 0;
  vi.restoreAllMocks();
});

function makeRouter(opts: {
  defaultProvider?: IntelligenceProvider;
  defaultFramework?: IntelligenceFramework;
  config?: unknown;
  built?: Partial<Record<IntelligenceFramework, IntelligenceProvider | null>>;
  swapAttemptTimeoutMs?: number;
  nonGatingFailureSwap?: { enabled: boolean; maxAttempts?: number };
  natureEnforcing?: boolean;
}): IntelligenceRouter {
  return new IntelligenceRouter({
    defaultProvider: opts.defaultProvider ?? emittingProvider({ label: 'default-answer', model: 'default-m' }),
    defaultFramework: opts.defaultFramework ?? 'claude-code',
    resolveConfig: () => opts.config as never,
    buildProvider: (fw) => opts.built?.[fw] ?? null,
    swapAttemptTimeoutMs: opts.swapAttemptTimeoutMs,
    nonGatingFailureSwap: opts.nonGatingFailureSwap,
    resolveNatureRouting: opts.natureEnforcing ? () => ({ enabled: true, dryRun: false }) : undefined,
  });
}

// ── 1. Mint shapes: prefixes, uuid base, machineId8 presence/absence ────────

describe('correlation-id minting — shapes + uniqueness', () => {
  it('router mints d-<uuid> with NO machine segment on a single-machine install', () => {
    const id = mintRouterCorrelationId();
    expect(id).toMatch(new RegExp(`^d-${UUID}$`));
  });

  it('router mints d-<machineId8>-<uuid> when a machine id is injected (first 8 chars)', () => {
    setDecisionQualityMachineId('abcdef1234567890');
    expect(mintRouterCorrelationId()).toMatch(new RegExp(`^d-abcdef12-${UUID}$`));
    expect(mintBreakerCorrelationId()).toMatch(new RegExp(`^b-abcdef12-${UUID}$`));
  });

  it('breaker mints b-<uuid> without a machine id', () => {
    expect(mintBreakerCorrelationId()).toMatch(new RegExp(`^b-${UUID}$`));
  });

  it('an empty/null machine id omits the segment (setter clears)', () => {
    setDecisionQualityMachineId('abcdef1234567890');
    setDecisionQualityMachineId(null);
    expect(mintRouterCorrelationId()).toMatch(new RegExp(`^d-${UUID}$`));
    setDecisionQualityMachineId('');
    expect(mintRouterCorrelationId()).toMatch(new RegExp(`^d-${UUID}$`));
  });

  it('mints are unique across calls (uuid-based, never time+seq)', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintRouterCorrelationId()));
    expect(ids.size).toBe(200);
  });

  it('the router threads its d- mint down to the provider options (symbol-keyed)', async () => {
    const seen: unknown[] = [];
    const provider: IntelligenceProvider = {
      evaluate: async (_p, o) => {
        seen.push((o as Record<PropertyKey, unknown> | undefined)?.[DECISION_CORRELATION_ID]);
        return 'ok';
      },
    };
    const router = makeRouter({ defaultProvider: provider, config: undefined });
    await router.evaluate('p', { attribution: { component: 'MessageSentinel' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(new RegExp(`^d-${UUID}$`));
    expect(settlements[0].correlationId).toBe(seen[0]);
  });
});

// ── 2. The caller's options object is NEVER mutated ─────────────────────────

describe('router-internal clone — caller object never mutated', () => {
  it('leaves the caller options byte-identical: no symbols, provenance intact, callbacks unswapped', async () => {
    const onUsage = vi.fn();
    const onModel = vi.fn();
    const onCorrelationId = vi.fn();
    const options: IntelligenceOptions = {
      model: 'fast',
      attribution: { component: 'MessageSentinel' },
      onUsage,
      onModel,
      provenance: { decisionPoint: 'test-point', promptId: 'p-v1', onCorrelationId },
    };
    const router = makeRouter({ config: undefined });
    await router.evaluate('p', options);
    expect(Object.getOwnPropertySymbols(options)).toHaveLength(0);
    expect(options.provenance).toBeDefined();
    expect(options.provenance!.decisionPoint).toBe('test-point');
    expect(options.onUsage).toBe(onUsage);
    expect(options.onModel).toBe(onModel);
    expect(Object.keys(options).sort()).toEqual(['attribution', 'model', 'onModel', 'onUsage', 'provenance']);
  });

  it('an inbound correlation id/marker on the CALLER object is ignored — the router mint wins (FD8)', async () => {
    const seen: unknown[] = [];
    const provider: IntelligenceProvider = {
      evaluate: async (_p, o) => {
        seen.push((o as Record<PropertyKey, unknown> | undefined)?.[DECISION_CORRELATION_ID]);
        return 'ok';
      },
    };
    const options = { attribution: { component: 'X' } } as IntelligenceOptions;
    (options as Record<PropertyKey, unknown>)[DECISION_CORRELATION_ID] = 'd-injected-by-caller';
    (options as Record<PropertyKey, unknown>)[DECISION_MINT_MARKER] = true;
    const router = makeRouter({ defaultProvider: provider, config: undefined });
    await router.evaluate('p', options);
    expect(seen[0]).not.toBe('d-injected-by-caller');
    expect(seen[0]).toMatch(new RegExp(`^d-${UUID}$`));
    expect(settlements[0].correlationId).toBe(seen[0]);
  });
});

// ── 3. onCorrelationId contract ──────────────────────────────────────────────

describe('onCorrelationId — mint-time, exactly once, contained', () => {
  it('fires synchronously at mint, BEFORE the first attempt, with the settled id', async () => {
    const order: string[] = [];
    let handed: string | undefined;
    const provider: IntelligenceProvider = {
      evaluate: async () => { order.push('attempt'); return 'ok'; },
    };
    const router = makeRouter({ defaultProvider: provider, config: undefined });
    await router.evaluate('p', {
      attribution: { component: 'X' },
      provenance: {
        decisionPoint: 'dp',
        onCorrelationId: (id) => { order.push('cb'); handed = id; },
      },
    });
    expect(order).toEqual(['cb', 'attempt']); // mint-time, never after settlement
    expect(handed).toMatch(new RegExp(`^d-${UUID}$`));
    expect(settlements[0].correlationId).toBe(handed);
  });

  it('fires exactly once INCLUDING calls that later throw', async () => {
    const cb = vi.fn();
    const provider: IntelligenceProvider = { evaluate: async () => { throw new Error('boom'); } };
    const router = makeRouter({ defaultProvider: provider, config: undefined });
    await expect(
      router.evaluate('p', {
        attribution: { component: 'X' },
        provenance: { decisionPoint: 'dp', onCorrelationId: cb },
      }),
    ).rejects.toThrow('boom');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].verdictClass).toBe('<errored>');
  });

  it('a THROWING callback is contained (the call succeeds) and counted', async () => {
    const router = makeRouter({ config: undefined });
    const res = await router.evaluate('p', {
      attribution: { component: 'X' },
      provenance: {
        decisionPoint: 'dp',
        onCorrelationId: () => { throw new Error('audit trail must never fail the call'); },
      },
    });
    expect(res).toBe('default-answer');
    expect(getDecisionQualityCounters().onCorrelationIdThrows).toBe(1);
    expect(settlements).toHaveLength(1); // still settled normally
  });

  it('is NOT fired on a router-BYPASSED (direct funnel) call — the breaker strips the block', async () => {
    setFeatureMetricsRecorder(metricsRecorder);
    const cb = vi.fn();
    const inner = emittingProvider({ label: 'ok' });
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x', {
      attribution: { component: 'X' },
      provenance: { decisionPoint: 'dp', onCorrelationId: cb },
    });
    expect(cb).not.toHaveBeenCalled();
    expect(getDecisionQualityCounters().provenanceStrippedAtBreaker).toBe(1);
    expect(inner.seen[0]?.provenance).toBeUndefined();
  });
});

// ── 4/5. Breaker floor: marker single-use + inbound-id discard ──────────────

describe('breaker floor — marker consumption + inbound-id discard (§5.1.2)', () => {
  it('a marked id is honored ONCE; the SAME reused options object gets a b- re-mint on the second use', async () => {
    setFeatureMetricsRecorder(metricsRecorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    const o = { attribution: { component: 'X' } } as IntelligenceOptions;
    (o as Record<PropertyKey, unknown>)[DECISION_CORRELATION_ID] = 'd-marked-once';
    (o as Record<PropertyKey, unknown>)[DECISION_MINT_MARKER] = true;
    await p.evaluate('a', o);
    await p.evaluate('b', o); // marker was consumed single-use — must NOT re-authorize
    expect(metricRows[0].verdictId).toBe('d-marked-once');
    expect(metricRows[1].verdictId).not.toBe('d-marked-once');
    expect(metricRows[1].verdictId).toMatch(new RegExp(`^b-${UUID}$`));
    expect(getDecisionQualityCounters().inboundCorrelationIdDiscarded).toBe(1);
  });

  it('an inbound UNMARKED id is discarded and re-minted with the b- prefix', async () => {
    setFeatureMetricsRecorder(metricsRecorder);
    const inner: IntelligenceProvider = { evaluate: async () => 'ok' };
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    const o = { attribution: { component: 'X' } } as IntelligenceOptions;
    (o as Record<PropertyKey, unknown>)[DECISION_CORRELATION_ID] = 'd-forged-no-marker';
    await p.evaluate('x', o);
    expect(metricRows[0].verdictId).not.toBe('d-forged-no-marker');
    expect(metricRows[0].verdictId).toMatch(new RegExp(`^b-${UUID}$`));
    expect(getDecisionQualityCounters().inboundCorrelationIdDiscarded).toBe(1);
  });

  it('a router-driven decision stamps the SAME d- id on EVERY swap-attempt metric row (N rows, ONE id)', async () => {
    setFeatureMetricsRecorder(metricsRecorder);
    const primary = emittingProvider({ label: '', model: 'm1', framework: 'codex-cli', throws: 'primary down' });
    const target = emittingProvider({ label: 'swap-answer', model: 'm2', framework: 'pi-cli' });
    const router = makeRouter({
      config: { categories: { sentinel: 'codex-cli' }, failureSwap: ['pi-cli'] },
      built: { 'codex-cli': wrap(primary), 'pi-cli': wrap(target) },
    });
    const res = await router.evaluate('p', { attribution: { component: 'MessageSentinel', gating: true } });
    expect(res).toBe('swap-answer');
    expect(metricRows).toHaveLength(2); // primary error row + swap success row
    expect(metricRows[0].outcome).toBe('error');
    expect(metricRows[1].outcome).toBe('noop');
    expect(metricRows[0].verdictId).toMatch(new RegExp(`^d-${UUID}$`));
    expect(metricRows[1].verdictId).toBe(metricRows[0].verdictId); // ONE decision, ONE id
    expect(settlements).toHaveLength(1);
    expect(settlements[0].correlationId).toBe(metricRows[0].verdictId);
  });
});

// ── FD8: callerRef relocation ────────────────────────────────────────────────

describe('classifyVerdict.verdictId relocation (FD8)', () => {
  it('an ENROLLED call records the caller verdictId as settlement callerRef — never in verdict_id', async () => {
    setFeatureMetricsRecorder(metricsRecorder);
    const provider = wrap(emittingProvider({ label: 'fire' }));
    const router = makeRouter({ defaultProvider: provider, config: undefined });
    await router.evaluate('p', {
      attribution: { component: 'MessageSentinel' },
      classifyVerdict: (r) => ({ acted: r === 'fire', verdictId: 'CMT-123' }),
      provenance: { decisionPoint: 'dp' },
    });
    expect(settlements[0].enrolled).toBe(true);
    expect(settlements[0].callerRef).toBe('CMT-123');
    expect(settlements[0].verdictClass).toBe('fired');
    expect(metricRows[0].verdictId).not.toBe('CMT-123'); // single-writer: the mint occupies verdict_id
    expect(metricRows[0].verdictId).toBe(settlements[0].correlationId);
  });

  it('a NON-enrolled call DROPS the caller verdictId (no provenance row to carry it)', async () => {
    setFeatureMetricsRecorder(metricsRecorder);
    const provider = wrap(emittingProvider({ label: 'fire' }));
    const router = makeRouter({ defaultProvider: provider, config: undefined });
    await router.evaluate('p', {
      attribution: { component: 'MessageSentinel' },
      classifyVerdict: () => ({ acted: true, verdictId: 'CMT-123' }),
    });
    expect(settlements[0].enrolled).toBe(false);
    expect(settlements[0].callerRef).toBeUndefined();
    expect(metricRows[0].verdictId).not.toBe('CMT-123');
  });
});

// ── 6. Provenance stripped at BOTH layers ────────────────────────────────────

describe('options.provenance stripped at both layers (§5.1.6)', () => {
  it('ROUTER layer: an unwrapped provider never sees provenance (but carries the mint symbols)', async () => {
    const provider = emittingProvider({ label: 'ok' });
    const router = makeRouter({ defaultProvider: provider, config: undefined });
    await router.evaluate('p', {
      attribution: { component: 'X' },
      provenance: { decisionPoint: 'dp', promptId: 'p-v1' },
    });
    const seen = provider.seen[0] as Record<PropertyKey, unknown>;
    expect(seen.provenance).toBeUndefined(); // stripped by the router before the attempt spread
    expect(seen[DECISION_CORRELATION_ID]).toMatch(new RegExp(`^d-${UUID}$`)); // the mint rides
  });

  it('BREAKER layer: the inner adapter sees neither provenance NOR the correlation symbols', async () => {
    const inner = emittingProvider({ label: 'ok' });
    const router = makeRouter({ defaultProvider: wrap(inner), config: undefined });
    await router.evaluate('p', {
      attribution: { component: 'X' },
      provenance: { decisionPoint: 'dp' },
    });
    const seen = inner.seen[0] as Record<PropertyKey, unknown>;
    expect(seen.provenance).toBeUndefined();
    expect(seen[DECISION_CORRELATION_ID]).toBeUndefined();
    expect(seen[DECISION_MINT_MARKER]).toBeUndefined();
  });

  it('BREAKER layer counts a strip on the direct/bypass path', async () => {
    const inner = emittingProvider({ label: 'ok' });
    const p = new CircuitBreakingIntelligenceProvider(inner, fakeBreaker());
    await p.evaluate('x', { provenance: { decisionPoint: 'dp' } } as IntelligenceOptions);
    expect(inner.seen[0]?.provenance).toBeUndefined();
    expect(getDecisionQualityCounters().provenanceStrippedAtBreaker).toBe(1);
  });
});

// ── 7. Per-attempt capture scoping (§5.1.5) ─────────────────────────────────

describe('per-attempt capture scoping', () => {
  it("a FAILED primary's usage/model never attribute to the settled swap attempt", async () => {
    const callerUsage = vi.fn();
    const primary = emittingProvider({
      label: '', model: 'm1', framework: 'codex-cli',
      usage: { inputTokens: 100, outputTokens: 10 }, throws: 'primary down',
    });
    const target = emittingProvider({
      label: 'swap-answer', model: 'm2', framework: 'pi-cli',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const router = makeRouter({
      config: { categories: { sentinel: 'codex-cli' }, failureSwap: ['pi-cli'] },
      built: { 'codex-cli': wrap(primary), 'pi-cli': wrap(target) },
    });
    await router.evaluate('p', {
      attribution: { component: 'MessageSentinel', gating: true },
      onUsage: callerUsage,
    });
    expect(settlements).toHaveLength(1);
    // Only the attempt whose promise the router returned contributes:
    expect(settlements[0].settledAttempt).toEqual({
      model: 'm2', framework: 'pi-cli', usage: { inputTokens: 7, outputTokens: 3 },
    });
    // …while the CALLER's own composed callback still saw both attempts (contract preserved).
    expect(callerUsage).toHaveBeenCalledTimes(2);
  });

  it('a late callback + resolution from a withSwapTimeout-ABANDONED attempt is discarded after settlement', async () => {
    // The primary fails fast; the FIRST swap target hangs and is ABANDONED at the
    // per-attempt cap (withSwapTimeout); the SECOND swap target serves. The
    // abandoned attempt's late callbacks/resolution must change nothing.
    let hangOpts: IntelligenceOptions | undefined;
    let resolveHang: ((v: string) => void) | undefined;
    const primary = emittingProvider({ label: '', throws: 'primary down' });
    const hanging: IntelligenceProvider = {
      evaluate: (_p, o) => {
        hangOpts = o;
        return new Promise<string>((res) => { resolveHang = res; });
      },
    };
    const target = emittingProvider({
      label: 'swap-answer', model: 'm2', framework: 'gemini-cli',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const router = makeRouter({
      config: { categories: { sentinel: 'codex-cli' }, failureSwap: ['pi-cli', 'gemini-cli'] },
      built: { 'codex-cli': wrap(primary), 'pi-cli': wrap(hanging), 'gemini-cli': wrap(target) },
      swapAttemptTimeoutMs: 40, // the hanging pi attempt is ABANDONED at the cap
    });
    const res = await router.evaluate('p', { attribution: { component: 'MessageSentinel', gating: true } });
    expect(res).toBe('swap-answer');
    expect(hangOpts).toBeDefined(); // the hanging attempt really ran and was abandoned
    expect(settlements).toHaveLength(1);
    expect(settlements[0].settledAttempt.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    // The abandoned attempt wakes up AFTER settlement — its callbacks must change nothing.
    hangOpts?.onUsage?.({ inputTokens: 999_999, outputTokens: 999_999 });
    hangOpts?.onModel?.({ model: 'zombie-model', framework: 'pi-cli' });
    resolveHang?.('late-zombie-answer');
    await new Promise((r) => setTimeout(r, 5)); // let any stray microtasks run
    expect(settlements).toHaveLength(1); // still exactly one settlement (write-once)
    expect(settlements[0].settledAttempt).toEqual({
      model: 'm2', framework: 'gemini-cli', usage: { inputTokens: 7, outputTokens: 3 },
    });
  });
});

// ── 8. Settlement — write-once on EVERY exit arm (FD7) ──────────────────────

describe('settlement — exactly once per evaluate() exit arm', () => {
  it('ladder SUCCESS settles once (verdictClass from classifyVerdict where implemented)', async () => {
    const codex = emittingProvider({ label: 'fire', model: 'm1', framework: 'codex-cli' });
    const router = makeRouter({
      config: { categories: { sentinel: 'codex-cli' } },
      built: { 'codex-cli': wrap(codex) },
    });
    await router.evaluate('p', {
      attribution: { component: 'MessageSentinel' },
      classifyVerdict: (r) => ({ acted: r === 'fire' }),
    });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      mintedBy: 'router', enrolled: false, verdictClass: 'fired',
      settledAttempt: { model: 'm1', framework: 'codex-cli' },
    });
    expect(settlements[0].settledAtMs).toBeGreaterThanOrEqual(settlements[0].mintedAtMs);
  });

  it("no classifyVerdict ⇒ verdictClass 'unclassified'", async () => {
    const router = makeRouter({ config: undefined });
    await router.evaluate('p', { attribution: { component: 'X' } });
    expect(settlements).toHaveLength(1);
    expect(settlements[0].verdictClass).toBe('unclassified');
  });

  it("ladder-FINAL failure settles once as '<errored>' with the error class", async () => {
    const primary = emittingProvider({ label: '', throws: 'primary down' });
    const router = makeRouter({
      config: { categories: { sentinel: 'codex-cli' }, failureSwap: ['pi-cli'] }, // pi not built → all down
      built: { 'codex-cli': wrap(primary) },
    });
    await expect(
      router.evaluate('p', { attribution: { component: 'MessageSentinel', gating: true } }),
    ).rejects.toThrow('primary down');
    expect(settlements).toHaveLength(1);
    expect(settlements[0].verdictClass).toBe('<errored>');
    expect(settlements[0].errorClass).toBe('Error');
  });

  it('the !cfg EARLY RETURN settles once (the arm the first draft missed)', async () => {
    const router = makeRouter({ config: undefined });
    const res = await router.evaluate('p', { attribution: { component: 'X' } });
    expect(res).toBe('default-answer');
    expect(settlements).toHaveLength(1);
    expect(settlements[0].settledAttempt.model).toBe('default-m'); // capture composed on the early-return attempt too
  });

  it('the provider-unavailable DEGRADE arm settles once (fires on every binary-missing agent)', async () => {
    const router = makeRouter({
      config: { categories: { sentinel: 'codex-cli' } }, // codex not built → degrade to default
      built: {},
    });
    const res = await router.evaluate('p', { attribution: { component: 'MessageSentinel' } });
    expect(res).toBe('default-answer');
    expect(settlements).toHaveLength(1);
    expect(settlements[0].verdictClass).toBe('unclassified');
  });

  it("the fallback-'none' unavailable THROW settles once as '<errored>'", async () => {
    const router = makeRouter({
      config: { categories: { sentinel: 'codex-cli' }, fallback: 'none' },
      built: {},
    });
    await expect(
      router.evaluate('p', { attribution: { component: 'MessageSentinel' } }),
    ).rejects.toThrow(/unavailable and fallback is 'none'/);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].verdictClass).toBe('<errored>');
  });

  it("the enforcedNoRoute THROW settles once as '<errored>' (nature enforcing, low-stakes, no doors)", async () => {
    // CommitmentSentinel maps to SORT; with default gemini-cli (not in SORT) and no
    // built providers, every chain door is unreachable ⇒ 'no-route' throw.
    const router = makeRouter({
      defaultProvider: emittingProvider({ label: 'gemini-default' }),
      defaultFramework: 'gemini-cli',
      config: undefined,
      built: {},
      natureEnforcing: true,
    });
    await expect(
      router.evaluate('p', { attribution: { component: 'CommitmentSentinel' } }),
    ).rejects.toThrow(/no-route/);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].verdictClass).toBe('<errored>');
    expect(settlements[0].errorClass).toBe('Error');
  });

  it("the RouterFailClosedError RETHROW settles once as '<errored>' with the typed class", async () => {
    // MessagingToneGate is a JUDGE critical gate; every door down ⇒ fail closed.
    const router = makeRouter({
      defaultProvider: emittingProvider({ label: 'gemini-default' }),
      defaultFramework: 'gemini-cli',
      config: undefined,
      built: {},
      natureEnforcing: true,
    });
    await expect(
      router.evaluate('p', { attribution: { component: 'MessagingToneGate' } }),
    ).rejects.toThrow(RouterFailClosedError);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].verdictClass).toBe('<errored>');
    expect(settlements[0].errorClass).toBe('RouterFailClosedError');
  });

  it('two invocations = two decisions with distinct ids (one settlement each)', async () => {
    const router = makeRouter({ config: undefined });
    await router.evaluate('p', { attribution: { component: 'X' } });
    await router.evaluate('p', { attribution: { component: 'X' } });
    expect(settlements).toHaveLength(2);
    expect(settlements[0].correlationId).not.toBe(settlements[1].correlationId);
  });

  it('no recorder injected ⇒ clean no-op (the call is unaffected)', async () => {
    setDecisionQualityRecorder(null);
    const router = makeRouter({ config: undefined });
    await expect(router.evaluate('p', { attribution: { component: 'X' } })).resolves.toBe('default-answer');
    expect(settlements).toHaveLength(0);
  });

  it('a THROWING recorder never breaks the decision path', async () => {
    setDecisionQualityRecorder({ recordSettlement: () => { throw new Error('substrate down'); } });
    const router = makeRouter({ config: undefined });
    await expect(router.evaluate('p', { attribution: { component: 'X' } })).resolves.toBe('default-answer');
  });

  it('a THROWING classifyVerdict at settlement is contained (verdictClass stays unclassified)', async () => {
    const router = makeRouter({ config: undefined });
    await expect(
      router.evaluate('p', {
        attribution: { component: 'X' },
        classifyVerdict: () => { throw new Error('bad classifier'); },
      }),
    ).resolves.toBe('default-answer');
    expect(settlements).toHaveLength(1);
    expect(settlements[0].verdictClass).toBe('unclassified');
  });

  it('the consumed provenance block rides the settlement (callback omitted)', async () => {
    const router = makeRouter({ config: undefined });
    await router.evaluate('p', {
      attribution: { component: 'X' },
      provenance: {
        decisionPoint: 'dp-1',
        context: { factA: 1 },
        optionsPresented: ['kill', 'leave'],
        promptId: 'hog-v1',
        onCorrelationId: () => {},
      },
    });
    expect(settlements[0].enrolled).toBe(true);
    expect(settlements[0].provenance).toEqual({
      decisionPoint: 'dp-1',
      context: { factA: 1 },
      optionsPresented: ['kill', 'leave'],
      promptId: 'hog-v1',
    });
    expect('onCorrelationId' in (settlements[0].provenance as object)).toBe(false);
  });
});
