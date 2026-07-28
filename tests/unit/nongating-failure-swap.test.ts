/**
 * Unit tests for the NON-GATING bounded failure-swap in IntelligenceRouter
 * (docs/specs/nongating-failure-swap.md).
 *
 * The production defect: a NON-gating internal component (TopicIntentExtractor) routed
 * to codex-cli by the provider-fallback default policy surfaced a 28% error rate — every
 * error row zero-usage (an INVOCATION-level codex-exec failure). Gating calls errored at
 * 1.5% because they ride the failure-swap tail; non-gating calls HARD-ERRORED straight to
 * their heuristic. This extends the swap to non-gating calls with a TIGHTER bound.
 *
 * Covers:
 *  - non-gating primary INVOCATION failure (zero usage) → ONE swap to the next active
 *    framework → the swapped answer is returned + attributed (onDegrade to='pi-cli').
 *  - content/parse error that CARRIED tokens → NO swap (caller fail-opens it, §6.4).
 *  - swap disabled via config (and absent config) → old hard-error behavior.
 *  - circuit-open / down next framework → skip/fail cleanly (original error re-thrown).
 *  - herd-safety (§6.2): a non-gating call NEVER swaps onto claude-code / the default
 *    framework, whereas a GATING call still may (gating unchanged).
 *  - maxAttempts bound (default 1; configurable).
 *  - model-tier preserved across a non-gating swap (Q5).
 *  - a provider that never surfaces usage (gemini) → treated as invocation-level (swap).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IntelligenceRouter,
  type ComponentFrameworksConfig,
  type RouterDegradeInfo,
} from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

/** A non-gating internal call (the TopicIntentExtractor class). */
const NON_GATING: IntelligenceOptions = { attribution: { component: 'TopicIntentExtractor' } };
/** A gating call (the control for "gating is unchanged"). */
const GATING: IntelligenceOptions = { attribution: { component: 'ExternalOperationGate', gating: true } };

/** INVOCATION-level failure: throws WITHOUT ever surfacing usage (zero tokens produced). */
function invocationFailProvider(msg = 'codex exec failed (empty output)'): IntelligenceProvider {
  return { async evaluate() { throw new Error(msg); } };
}

/** Content/parse error: surfaces usage (tokens burned) THEN throws — the §6.4 caller-handled class. */
function contentErrorProvider(
  msg = 'post-success parse failure',
  usage = { inputTokens: 120, outputTokens: 30 },
): IntelligenceProvider {
  return {
    async evaluate(_p, opts) {
      opts?.onUsage?.(usage); // tokens WERE burned before the failure
      throw new Error(msg);
    },
  };
}

/** A provider that succeeds, recording the model tier it saw and its call count. */
function okProvider(answer: string): IntelligenceProvider & { calls: number; sawModel?: string } {
  return {
    calls: 0,
    async evaluate(_p: string, opts?: IntelligenceOptions): Promise<string> {
      this.calls++;
      this.sawModel = opts?.model;
      return answer;
    },
  } as IntelligenceProvider & { calls: number; sawModel?: string };
}

/** Base config: codex primary, tail = pi → gemini → claude. */
const CODEX_PRIMARY: ComponentFrameworksConfig = {
  default: 'codex-cli',
  failureSwap: ['pi-cli', 'gemini-cli', 'claude-code'],
};

function build(opts: {
  providers: Partial<Record<IntelligenceFramework, IntelligenceProvider>>;
  defaultProvider?: IntelligenceProvider;
  config?: ComponentFrameworksConfig | undefined;
  nonGating?: { enabled: boolean; maxAttempts?: number } | undefined;
  swapAttemptTimeoutMs?: number;
  nonGatingSwapTimeoutMs?: number;
  onDegrade?: (i: RouterDegradeInfo) => void;
  onResolved?: (component: string, framework: string) => void;
}): IntelligenceRouter {
  return new IntelligenceRouter({
    defaultProvider: opts.defaultProvider ?? invocationFailProvider('claude default down'),
    defaultFramework: 'claude-code',
    resolveConfig: () => (opts.config === undefined ? CODEX_PRIMARY : opts.config),
    buildProvider: (fw) => opts.providers[fw] ?? null,
    ...(opts.nonGating !== undefined ? { nonGatingFailureSwap: opts.nonGating } : {}),
    ...(opts.swapAttemptTimeoutMs !== undefined ? { swapAttemptTimeoutMs: opts.swapAttemptTimeoutMs } : {}),
    ...(opts.nonGatingSwapTimeoutMs !== undefined ? { nonGatingSwapTimeoutMs: opts.nonGatingSwapTimeoutMs } : {}),
    ...(opts.onDegrade ? { onDegrade: opts.onDegrade } : {}),
    ...(opts.onResolved ? { onResolved: opts.onResolved } : {}),
  });
}

describe('non-gating failure-swap — the core fix', () => {
  it('non-gating primary INVOCATION failure (zero usage) → ONE swap to the next active framework', async () => {
    const pi = okProvider('pi-answer');
    const degrades: RouterDegradeInfo[] = [];
    const resolved: string[] = [];
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGating: { enabled: true },
      onDegrade: (i) => degrades.push(i),
      onResolved: (_c, f) => resolved.push(f),
    });

    const result = await router.evaluate('x', NON_GATING);

    expect(result).toBe('pi-answer'); // the swap served the answer instead of hard-erroring
    expect(pi.calls).toBe(1);
    // attributed to the serving framework (in production the pi CircuitBreaking wrapper also
    // records pi's own feature_metrics row; here we assert the swap routed to pi-cli).
    expect(degrades.some((d) => d.to === 'pi-cli' && d.reason.startsWith('nongating-failure-swap:'))).toBe(true);
    expect(resolved).toContain('codex-cli'); // onResolved auto-resolves the failed primary's degradation
  });

  it('content/parse error that CARRIED tokens → NO swap (caller fail-opens per §6.4)', async () => {
    const pi = okProvider('pi-answer');
    const router = build({
      providers: { 'codex-cli': contentErrorProvider(), 'pi-cli': pi },
      nonGating: { enabled: true },
    });

    await expect(router.evaluate('x', NON_GATING)).rejects.toThrow('post-success parse failure');
    expect(pi.calls).toBe(0); // a token-carrying error is NOT an invocation failure — no swap
  });

  it('swap DISABLED via config → old hard-error behavior (no swap)', async () => {
    const pi = okProvider('pi-answer');
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGating: { enabled: false },
    });
    await expect(router.evaluate('x', NON_GATING)).rejects.toThrow('codex exec failed');
    expect(pi.calls).toBe(0);
  });

  it('feature ABSENT (opts.nonGatingFailureSwap undefined) → byte-identical old behavior', async () => {
    const pi = okProvider('pi-answer');
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGating: undefined, // never passed → feature off
    });
    await expect(router.evaluate('x', NON_GATING)).rejects.toThrow('codex exec failed');
    expect(pi.calls).toBe(0);
  });

  it('next framework down / circuit-open → skip cleanly, re-throw the ORIGINAL primary error', async () => {
    const router = build({
      providers: {
        'codex-cli': invocationFailProvider('original codex failure'),
        'pi-cli': invocationFailProvider('pi circuit-open'), // the swap target is also down
      },
      nonGating: { enabled: true },
    });
    // pi (the one target under maxAttempts=1) throws → give up → the original codex error surfaces.
    await expect(router.evaluate('x', NON_GATING)).rejects.toThrow('original codex failure');
  });

  it('a provider that never surfaces usage (gemini primary) → treated as invocation-level → swap', async () => {
    const pi = okProvider('pi-answer');
    const router = build({
      providers: { 'gemini-cli': invocationFailProvider('gemini down'), 'pi-cli': pi },
      // gemini primary, tail = pi (excludes gemini/claude/default)
      config: { default: 'gemini-cli', failureSwap: ['pi-cli', 'claude-code'] },
      nonGating: { enabled: true },
    });
    // gemini never calls onUsage → primaryProducedTokens stays false → the conservative swap fires.
    expect(await router.evaluate('x', NON_GATING)).toBe('pi-answer');
    expect(pi.calls).toBe(1);
  });
});

describe('non-gating failure-swap — herd-safety (§6.2): never onto claude-code / default', () => {
  it('non-gating NEVER swaps onto claude-code (the only tail entry) — but a GATING call does', async () => {
    const claude = okProvider('claude-tail');
    // config tail is ONLY claude-code (the last resort).
    const cfg: ComponentFrameworksConfig = { default: 'codex-cli', failureSwap: ['claude-code'] };

    // NON-gating: claude-code excluded → no eligible target → hard-error (herd-safe).
    const ngRouter = build({
      providers: { 'codex-cli': invocationFailProvider('codex down') },
      defaultProvider: claude,
      config: cfg,
      nonGating: { enabled: true },
    });
    await expect(ngRouter.evaluate('x', NON_GATING)).rejects.toThrow('codex down');
    expect(claude.calls).toBe(0); // non-gating background traffic never herds onto Claude

    // GATING: the SAME config DOES swap onto the claude tail (gating unchanged).
    const claude2 = okProvider('claude-tail');
    const gRouter = build({
      providers: { 'codex-cli': invocationFailProvider('codex down') },
      defaultProvider: claude2,
      config: cfg,
      nonGating: { enabled: true },
    });
    expect(await gRouter.evaluate('x', { ...GATING, attribution: { component: 'ExternalOperationGate', gating: true } })).toBe('claude-tail');
    expect(claude2.calls).toBe(1);
  });

  it('gating calls are entirely unchanged by the non-gating feature (full-tail swap preserved)', async () => {
    const pi = okProvider('pi-answer');
    // codex primary fails; gating swaps the full tail → pi is the first live target.
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGating: { enabled: true }, // ON, but the gating path must ignore it
    });
    expect(await router.evaluate('x', GATING)).toBe('pi-answer');
    expect(pi.calls).toBe(1);
  });
});

describe('non-gating failure-swap — bounded (maxAttempts) + tier preserved', () => {
  it('default maxAttempts=1 → only ONE tail step tried (second live target NOT reached)', async () => {
    const pi = invocationFailProvider('pi down');
    const gemini = okProvider('gemini-answer');
    const router = build({
      providers: { 'codex-cli': invocationFailProvider('codex down'), 'pi-cli': pi, 'gemini-cli': gemini },
      nonGating: { enabled: true }, // maxAttempts defaults to 1
    });
    // targets (excluding claude/default/codex) = [pi, gemini]; slice(0,1) = [pi]. pi down → give up.
    await expect(router.evaluate('x', NON_GATING)).rejects.toThrow('codex down');
    expect(gemini.calls).toBe(0); // the second step is NOT taken under the default bound
  });

  it('maxAttempts=2 → walks two tail steps (pi down → gemini serves)', async () => {
    const gemini = okProvider('gemini-answer');
    const router = build({
      providers: {
        'codex-cli': invocationFailProvider('codex down'),
        'pi-cli': invocationFailProvider('pi down'),
        'gemini-cli': gemini,
      },
      nonGating: { enabled: true, maxAttempts: 2 },
    });
    expect(await router.evaluate('x', NON_GATING)).toBe('gemini-answer');
    expect(gemini.calls).toBe(1);
  });

  it('model tier travels verbatim across a non-gating swap (Q5 — never silently upgraded)', async () => {
    const pi = okProvider('pi-answer');
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGating: { enabled: true },
    });
    await router.evaluate('x', { ...NON_GATING, model: 'fast' });
    expect(pi.sawModel).toBe('fast');
  });

  it('the per-attempt cap flows through as the swap provider timeoutMs', async () => {
    let sawTimeout: number | undefined;
    const capturing: IntelligenceProvider = {
      async evaluate(_p, opts) { sawTimeout = opts?.timeoutMs; return 'pi-answer'; },
    };
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': capturing },
      nonGating: { enabled: true },
      nonGatingSwapTimeoutMs: 5000,
    });
    expect(await router.evaluate('x', NON_GATING)).toBe('pi-answer');
    expect(sawTimeout).toBe(5000);
  });
});

describe('non-gating failure-swap — slow target abandoned at the cap', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function latencyProvider(label: string, latencyMs: number): IntelligenceProvider & { calls: number; sawTimeoutMs?: number } {
    return {
      calls: 0,
      evaluate(this: { calls: number; sawTimeoutMs?: number }, _p: string, opts?: IntelligenceOptions) {
        this.calls++;
        this.sawTimeoutMs = opts?.timeoutMs;
        return new Promise<string>((res) => { setTimeout(() => res(label), latencyMs); });
      },
    };
  }

  it('non-gating swaps use the dedicated 15s cap, so a 6s cold-start provider succeeds', async () => {
    const pi = latencyProvider('pi-answer', 6000);
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGating: { enabled: true },
      swapAttemptTimeoutMs: 5000,
      nonGatingSwapTimeoutMs: 15000,
    });

    const p = router.evaluate('x', NON_GATING);
    await vi.advanceTimersByTimeAsync(6000);

    expect(await p).toBe('pi-answer');
    expect(pi.calls).toBe(1);
    expect(pi.sawTimeoutMs).toBe(15000);
  });

  it('gating swaps still use the global 5s cap, unchanged by the non-gating timeout', async () => {
    const pi = latencyProvider('pi-answer', 6000);
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': pi },
      nonGating: { enabled: true },
      swapAttemptTimeoutMs: 5000,
      nonGatingSwapTimeoutMs: 15000,
    });

    const p = router.evaluate('x', GATING);
    const rejection = expect(p).rejects.toThrow('codex exec failed');
    await vi.advanceTimersByTimeAsync(5001);

    await rejection;
    expect(pi.calls).toBe(1);
    expect(pi.sawTimeoutMs).toBe(5000);
  });

  it('a SLOW (never-erroring) swap target is abandoned at the cap; a later target serves', async () => {
    const gate = new Promise<void>(() => { /* never resolves — a hung provider */ });
    const slowPi: IntelligenceProvider = { async evaluate() { await gate; return 'too-late'; } };
    const gemini = okProvider('gemini-answer');
    const router = build({
      providers: { 'codex-cli': invocationFailProvider(), 'pi-cli': slowPi, 'gemini-cli': gemini },
      nonGating: { enabled: true, maxAttempts: 2 },
      nonGatingSwapTimeoutMs: 5000,
    });
    const p = router.evaluate('x', NON_GATING);
    // pi hangs; the cap fires at 5s → pi is abandoned → gemini serves (proving the cap fired
    // and the loop advanced within the bound, mirroring the gating-loop M1 test).
    await vi.advanceTimersByTimeAsync(5001);
    expect(await p).toBe('gemini-answer');
    expect(gemini.calls).toBe(1);
  });
});
