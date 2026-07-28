/**
 * LA4 unconditional degrade-path safety clamp — INSTAR-Bench v3, Task-4 S4 Increment A1.
 *
 * The router's degrade-to-default path (`evaluate()`, the `if (!primary)` block) fires
 * when a component's routed framework binary is missing. On `main` it degrades to
 * `defaultProvider.evaluate(prompt, options)` UNCLAMPED — so a binary-missing
 * bounded/gating `capable` degrade with a `claude-code` default lands Opus-via-Claude-CLI:
 * the one MEASURED-BANNED route for a bounded verdict (99.1% clean-API vs 81.7% via the
 * Claude Code CLI; emergency-stop 73%). The merged S2 clamp only guarded the failure-swap
 * loop, leaving this exit open.
 *
 * A1 closes it as a STANDALONE safety narrowing that fires REGARDLESS of
 * `sessions.natureRouting` (it is NOT gated on the S4 feature flag — spec FD4 / LA4-r2):
 *   - a bounded/gating degrade (mapped non-WRITE nature, or `attribution.gating`) onto a
 *     `claude-code` default requesting `capable` is clamped to the Sonnet-4.6-CLI reserve
 *     (`balanced`, the SAME reserve `clampClaudeCliSwapModel` uses);
 *   - a `WRITE`-chain component (its Opus-via-CLI quality lane) and an unmapped, non-gating
 *     call are left UNCHANGED (no collateral over-clamp);
 *   - a non-`claude-code` default door is never clamped (Opus-via-API is fine).
 *
 * Bench evidence: docs/LLM-ROUTING-REGISTRY.md R1/R2; spec docs/specs/nature-axis-routing.md FD4.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  IntelligenceRouter,
  isBoundedGatingDegrade,
  routingNatureFor,
  type ComponentFrameworksConfig,
} from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { LLM_ROUTING_NATURE } from '../../src/data/llmBenchCoverage.js';

/** A provider that records the FULL options it was called with (so we can inspect the model tier). */
function capturingProvider(label: string): IntelligenceProvider & { seen: IntelligenceOptions[] } {
  const seen: IntelligenceOptions[] = [];
  return {
    seen,
    async evaluate(_prompt: string, opts?: IntelligenceOptions): Promise<string> {
      seen.push(opts ?? {});
      return label;
    },
  };
}

function makeRouter(opts: {
  config?: ComponentFrameworksConfig;
  defaultFramework?: IntelligenceFramework;
  built?: Partial<Record<IntelligenceFramework, IntelligenceProvider | null>>;
  onDegrade?: (i: unknown) => void;
}) {
  const defaultProvider = capturingProvider('default');
  const buildProvider = vi.fn((fw: IntelligenceFramework) => opts.built?.[fw] ?? null);
  const router = new IntelligenceRouter({
    defaultProvider,
    defaultFramework: opts.defaultFramework ?? 'claude-code',
    resolveConfig: () => opts.config,
    buildProvider,
    onDegrade: opts.onDegrade as never,
  });
  return { router, defaultProvider };
}

// Route ANY component to a framework whose binary is missing (built=null) so evaluate()
// takes the degrade-to-default path. `other` category catches every unmapped component too.
const DEGRADE_CONFIG: ComponentFrameworksConfig = {
  categories: {
    sentinel: 'gemini-cli',
    gate: 'gemini-cli',
    reflector: 'gemini-cli',
    job: 'gemini-cli',
    other: 'gemini-cli',
  },
};

describe('routingNatureFor — static map lookup (per-operation key handling)', () => {
  it('resolves an exact component key', () => {
    expect(routingNatureFor('MessageSentinel')).toEqual({ nature: 'A', chain: 'FAST' });
    expect(routingNatureFor('CompletionEvaluator')).toEqual({ nature: 'B', chain: 'JUDGE' });
  });

  it('falls back to the base name for a "/segment" operation suffix', () => {
    expect(routingNatureFor('CompletionEvaluator/P13')).toEqual({ nature: 'B', chain: 'JUDGE' });
  });

  it('strips a leading "server:" prefix like categoryForComponent', () => {
    expect(routingNatureFor('server:MessagingToneGate')).toEqual({ nature: 'B', chain: 'JUDGE' });
  });

  it('returns undefined for an unmapped component or no component', () => {
    expect(routingNatureFor('SomethingUnknown')).toBeUndefined();
    expect(routingNatureFor(undefined)).toBeUndefined();
  });
});

describe('isBoundedGatingDegrade — the R1/R2 clamp predicate', () => {
  it('is true when the caller declares attribution.gating, regardless of the map', () => {
    expect(isBoundedGatingDegrade('SomethingUnknown', { attribution: { gating: true } })).toBe(true);
    // gating dominates even a component that has no nature entry
    expect(isBoundedGatingDegrade(undefined, { attribution: { gating: true } })).toBe(true);
  });

  it('is true for a mapped bounded/gating component (A/FAST, A/SORT, B/JUDGE, D/SORT)', () => {
    expect(isBoundedGatingDegrade('MessageSentinel', undefined)).toBe(true); // A/FAST
    expect(isBoundedGatingDegrade('CommitmentSentinel', undefined)).toBe(true); // A/SORT
    expect(isBoundedGatingDegrade('CompletionEvaluator', undefined)).toBe(true); // B/JUDGE
    expect(isBoundedGatingDegrade('SessionSummarySentinel', undefined)).toBe(true); // D/SORT
  });

  it('is false for an unmapped, non-gating component (out of R1 scope — no over-clamp)', () => {
    expect(isBoundedGatingDegrade('SomethingUnknown', undefined)).toBe(false);
    expect(isBoundedGatingDegrade('SomethingUnknown', { attribution: { component: 'x' } })).toBe(false);
    expect(isBoundedGatingDegrade(undefined, undefined)).toBe(false);
  });

  it('keys exactly on chain !== WRITE (WRITE is the sanctioned Opus-CLI lane) — property over the whole map', () => {
    // Proves the WRITE-exemption discriminator is wired even before A2 adds any WRITE row:
    // for every currently-mapped component the predicate must equal (chain !== 'WRITE').
    for (const [component, row] of Object.entries(LLM_ROUTING_NATURE)) {
      expect(isBoundedGatingDegrade(component, undefined)).toBe(row.chain !== 'WRITE');
    }
  });
});

describe('LA4 degrade-path clamp in evaluate() — the load-bearing safety property', () => {
  it('clamps capable→balanced on a bounded/gating degrade to a claude-code default (natureRouting UNSET)', async () => {
    const degrades: Array<{ reason: string }> = [];
    const { router, defaultProvider } = makeRouter({
      config: DEGRADE_CONFIG,
      defaultFramework: 'claude-code',
      built: {}, // gemini-cli binary missing → degrade
      onDegrade: (d) => degrades.push(d as { reason: string }),
    });

    // No natureRouting anywhere — the clamp fires purely off the static map + the door.
    const r = await router.evaluate('p', {
      model: 'capable',
      attribution: { component: 'MessageSentinel' }, // A/FAST → bounded/gating
    });

    expect(r).toBe('default'); // served by the default (claude-code) provider
    expect(defaultProvider.seen).toHaveLength(1);
    expect(defaultProvider.seen[0].model).toBe('balanced'); // Opus-CLI → Sonnet-CLI reserve
    // the LA4 clamp emitted its own degrade note
    expect(degrades.some((d) => /degrade-path-model-clamp \(LA4\)/.test(d.reason))).toBe(true);
  });

  it('clamps a gating-flagged call even when the component is unmapped', async () => {
    const { router, defaultProvider } = makeRouter({
      config: DEGRADE_CONFIG,
      defaultFramework: 'claude-code',
      built: {},
    });
    const r = await router.evaluate('p', {
      model: 'capable',
      attribution: { component: 'SomethingUnknown', gating: true },
    });
    expect(r).toBe('default');
    expect(defaultProvider.seen[0].model).toBe('balanced');
  });

  it('does NOT clamp an unmapped, non-gating degrade — no collateral over-clamp', async () => {
    const { router, defaultProvider } = makeRouter({
      config: DEGRADE_CONFIG,
      defaultFramework: 'claude-code',
      built: {},
    });
    const r = await router.evaluate('p', {
      model: 'capable',
      attribution: { component: 'SomethingUnknown' }, // unmapped + not gating
    });
    expect(r).toBe('default');
    expect(defaultProvider.seen[0].model).toBe('capable'); // untouched
  });

  it('does NOT clamp when the default door is not claude-code (Opus-via-API is fine)', async () => {
    // BOTH-defaultFramework arm: a bounded/gating degrade onto a codex-cli default is left alone.
    const { router, defaultProvider } = makeRouter({
      config: { categories: { sentinel: 'gemini-cli' } }, // route sentinel to a missing binary
      defaultFramework: 'codex-cli',
      built: {}, // gemini-cli missing → degrade to codex-cli default
    });
    const r = await router.evaluate('p', {
      model: 'capable',
      attribution: { component: 'MessageSentinel' }, // bounded/gating
    });
    expect(r).toBe('default');
    expect(defaultProvider.seen[0].model).toBe('capable'); // no clamp on a non-claude door
  });

  it('leaves a non-capable tier untouched on the degrade path (only capable=Opus is banned)', async () => {
    const { router, defaultProvider } = makeRouter({
      config: DEGRADE_CONFIG,
      defaultFramework: 'claude-code',
      built: {},
    });
    await router.evaluate('p', { model: 'balanced', attribution: { component: 'MessageSentinel' } });
    expect(defaultProvider.seen[0].model).toBe('balanced'); // unchanged
  });
});
