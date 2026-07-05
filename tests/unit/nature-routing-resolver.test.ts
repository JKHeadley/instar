/**
 * Unit tests — S4 Increment A2: the dark/dryRun nature-axis routing MECHANISM.
 * Spec: docs/specs/nature-axis-routing.md (§Resolver, FD3, FD4, FD4.1/FD-LABEL, FD9).
 *
 * Covers BOTH sides of every decision boundary (Testing Integrity Standard, kind 5):
 *  - resolveNatureAndChain: map hit / per-op suffix / tighten / E,B tie→map / non-enum
 *    ignored / downgrade ignored / unmapped.
 *  - resolveRoute: all FOUR load-bearing outcomes (route / fall-through / no-route / throw),
 *    ordering, metered-door skip, primary+tail.
 *  - FD4.1 concrete-id pin: the `balanced` token resolves to the real Sonnet id, and the
 *    NEW nature-scoped clamp is a SEPARATE fn from A1's clampClaudeCliSwapModel.
 *  - FD4 allowlist clamp: accepts the reserve id, rejects every other claude-code id
 *    (deny-by-default), WRITE exempt.
 *  - THE load-bearing safety case: evaluate() is BYTE-IDENTICAL when natureRouting is off.
 *  - dryRun observes (logs the plan) but does NOT change the selected (door, model).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  IntelligenceRouter,
  resolveNatureAndChain,
  resolveRoute,
  resolvePositionModelId,
  clampToReserveOnCleanDoor,
  clampClaudeCliSwapModel,
  mergeNatureRoutingChains,
  validateNatureRoutingChains,
  validateChainPosition,
  isNatureRoutingChainsValid,
  isComponentInjectionExposed,
  RouterFailClosedError,
  type NatureRoutingRuntime,
  type NatureRoutePlan,
  type ResolvedRoutePosition,
} from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import {
  ROUTING_LABEL_TO_MODEL_ID,
  CLAUDE_CODE_RESERVE_MODEL_ID,
  NATURE_ROUTING_DEFAULT_CHAINS,
  resolveInjectionExposure,
  type RoutingDoor,
  type ChainPosition,
  type NatureRoutingChains,
} from '../../src/data/llmBenchCoverage.js';

// All CLI doors reachable, all metered doors unreachable (Increment A default).
const allCliReachable = { isDoorReachable: (_d: RoutingDoor) => true };

function fakeProvider(label: string): IntelligenceProvider & { calls: Array<IntelligenceOptions | undefined> } {
  const calls: Array<IntelligenceOptions | undefined> = [];
  return {
    calls,
    async evaluate(_prompt: string, _opts?: IntelligenceOptions): Promise<string> {
      calls.push(_opts);
      return label;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveNatureAndChain (FD3)', () => {
  it('returns the component map row by default (authoritative per-component chain)', () => {
    // MessageSentinel = A/FAST, CommitmentSentinel = A/SORT — a pure nature→chain fn
    // could not preserve this per-component split.
    expect(resolveNatureAndChain('MessageSentinel')).toEqual({ resolvedNature: 'A', resolvedChain: 'FAST' });
    expect(resolveNatureAndChain('CommitmentSentinel')).toEqual({ resolvedNature: 'A', resolvedChain: 'SORT' });
    expect(resolveNatureAndChain('MessagingToneGate')).toEqual({ resolvedNature: 'B', resolvedChain: 'JUDGE' });
  });

  it('resolves a per-operation "/segment" suffix, then the base component', () => {
    // Base fallback (no exact key for the suffixed form) → the base row.
    expect(resolveNatureAndChain('CompletionEvaluator/judge')).toEqual({ resolvedNature: 'B', resolvedChain: 'JUDGE' });
    expect(resolveNatureAndChain('server:MessagingToneGate')).toEqual({ resolvedNature: 'B', resolvedChain: 'JUDGE' });
  });

  it('unmapped component ⇒ undefined (→ legacy fall-through)', () => {
    expect(resolveNatureAndChain('TotallyUnknownThing')).toBeUndefined();
    expect(resolveNatureAndChain(undefined)).toBeUndefined();
  });

  it('a declared nature that TIGHTENS raises the tier → deterministically JUDGE', () => {
    // MessageSentinel maps A; a callsite declaring B (a judgment) tightens → JUDGE.
    expect(resolveNatureAndChain('MessageSentinel', 'B')).toEqual({ resolvedNature: 'B', resolvedChain: 'JUDGE' });
    // A→E likewise tightens (E is JUDGE-tier).
    expect(resolveNatureAndChain('MessageSentinel', 'E')).toEqual({ resolvedNature: 'E', resolvedChain: 'JUDGE' });
    // A (SORT) → D tightens to the higher tier (D>A) → JUDGE (the safe direction).
    expect(resolveNatureAndChain('CommitmentSentinel', 'D')).toEqual({ resolvedNature: 'D', resolvedChain: 'JUDGE' });
  });

  it('a same-tier (E vs B) tie resolves to the MAP value — the override never swaps within a tier', () => {
    // MessagingToneGate maps B (JUDGE); a declared E is the SAME tier → map wins.
    expect(resolveNatureAndChain('MessagingToneGate', 'E')).toEqual({ resolvedNature: 'B', resolvedChain: 'JUDGE' });
  });

  it('a declared nature that would DOWNGRADE is ignored (map wins — never widen)', () => {
    // MessagingToneGate maps B; a declared A (lower tier) is ignored.
    expect(resolveNatureAndChain('MessagingToneGate', 'A')).toEqual({ resolvedNature: 'B', resolvedChain: 'JUDGE' });
    expect(resolveNatureAndChain('MessagingToneGate', 'D')).toEqual({ resolvedNature: 'B', resolvedChain: 'JUDGE' });
  });

  it('a declared nature outside {A,B,D,E} is ignored (fail-safe)', () => {
    expect(resolveNatureAndChain('MessageSentinel', 'Z' as unknown)).toEqual({ resolvedNature: 'A', resolvedChain: 'FAST' });
    expect(resolveNatureAndChain('MessageSentinel', 42 as unknown)).toEqual({ resolvedNature: 'A', resolvedChain: 'FAST' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FD4.1 / FD-LABEL — benchmark-label → concrete model id', () => {
  it('the `balanced` token on claude-code pins to the concrete Sonnet-4.6 id', () => {
    // THE load-bearing FD4.1 assertion the brief calls out.
    expect(ROUTING_LABEL_TO_MODEL_ID['claude-code'].balanced).toBe('claude-sonnet-4-6');
    expect(CLAUDE_CODE_RESERVE_MODEL_ID).toBe('claude-sonnet-4-6');
    expect(resolvePositionModelId({ door: 'claude-code', model: 'balanced' })).toBe('claude-sonnet-4-6');
  });

  it('a tier hint NOT in the registry (fast/capable) passes through unchanged', () => {
    expect(resolvePositionModelId({ door: 'claude-code', model: 'fast' })).toBe('fast');
    expect(resolvePositionModelId({ door: 'claude-code', model: 'capable' })).toBe('capable');
  });

  it('metered-door labels resolve to their concrete ids', () => {
    expect(resolvePositionModelId({ door: 'gemini-api', model: 'flash-lite' })).toBe('gemini-3.1-flash-lite');
    expect(resolvePositionModelId({ door: 'openrouter-api', model: 'opus-4.8' })).toBe('anthropic/claude-opus-4-8');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('FD4 place-3 — harness-door ALLOWLIST clamp (deny-by-default)', () => {
  const rp = (door: RoutingDoor, modelId: string): ResolvedRoutePosition => ({ door, label: modelId, modelId, clamped: false });

  it('accepts the sanctioned reserve id on claude-code in a bounded/gating chain', () => {
    const out = clampToReserveOnCleanDoor(rp('claude-code', CLAUDE_CODE_RESERVE_MODEL_ID), 'JUDGE');
    expect(out.clamped).toBe(false);
    expect(out.modelId).toBe(CLAUDE_CODE_RESERVE_MODEL_ID);
  });

  it('REJECTS every other claude-code id in FAST/SORT/JUDGE → clamps to the reserve', () => {
    for (const chain of ['FAST', 'SORT', 'JUDGE'] as const) {
      const out = clampToReserveOnCleanDoor(rp('claude-code', 'claude-opus-4-8'), chain);
      expect(out.clamped).toBe(true);
      expect(out.modelId).toBe(CLAUDE_CODE_RESERVE_MODEL_ID);
    }
    // A future/unrecognized capable id is ALSO clamped (allowlist, not denylist).
    const future = clampToReserveOnCleanDoor(rp('claude-code', 'claude-opus-9-9-future'), 'JUDGE');
    expect(future.clamped).toBe(true);
    expect(future.modelId).toBe(CLAUDE_CODE_RESERVE_MODEL_ID);
  });

  it('WRITE is exempt — claude-code/capable (Opus) passes through unclamped', () => {
    const out = clampToReserveOnCleanDoor(rp('claude-code', 'capable'), 'WRITE');
    expect(out.clamped).toBe(false);
    expect(out.modelId).toBe('capable');
  });

  it('a non-claude-code door is never touched', () => {
    const out = clampToReserveOnCleanDoor(rp('pi-cli', 'gpt-5.5'), 'JUDGE');
    expect(out.clamped).toBe(false);
    expect(out.modelId).toBe('gpt-5.5');
  });

  it('is a SEPARATE fn from A1 clampClaudeCliSwapModel — A1 still returns the `balanced` TIER token (untouched)', () => {
    // A1's always-on degrade/swap clamp must NOT change (byte-identical-when-off depends on it).
    const a1 = clampClaudeCliSwapModel('claude-code', 'capable');
    expect(a1).toEqual({ model: 'balanced', clamped: true });
    expect(a1.model).not.toBe(CLAUDE_CODE_RESERVE_MODEL_ID); // A2 pins a concrete id; A1 keeps the tier token
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('resolveRoute — the four load-bearing outcomes', () => {
  it("OUTCOME 'route': orders available positions, resolves ids, applies the clamp (primary + tail)", () => {
    // SORT default = codex-cli → pi-cli → gemini-api(metered) → claude-code/balanced.
    const res = resolveRoute('CommitmentSentinel', undefined, NATURE_ROUTING_DEFAULT_CHAINS, allCliReachable);
    expect(res.outcome).toBe('route');
    if (res.outcome !== 'route') return;
    expect(res.resolvedChain).toBe('SORT');
    // gemini-api (metered) is SKIPPED in Increment A — primary is codex-cli, tail is pi-cli then the claude reserve.
    expect(res.primary).toMatchObject({ door: 'codex-cli', modelId: 'gpt-5.4-mini' });
    expect(res.swapTail.map((p) => p.door)).toEqual(['pi-cli', 'claude-code']);
    // The claude-code reserve resolved to the concrete pinned id (allowlisted, not clamped).
    const reserve = res.swapTail.find((p) => p.door === 'claude-code');
    expect(reserve?.modelId).toBe(CLAUDE_CODE_RESERVE_MODEL_ID);
  });

  it("OUTCOME 'fall-through': an unmapped component returns fall-through (→ legacy routing)", () => {
    expect(resolveRoute('TotallyUnknownThing', undefined, NATURE_ROUTING_DEFAULT_CHAINS, allCliReachable))
      .toEqual({ outcome: 'fall-through' });
  });

  it("OUTCOME 'no-route': a low-stakes mapped component with NO available door", () => {
    // No CLI door reachable AND metered skipped ⇒ empty set; low-stakes ⇒ no-route (caller heuristic).
    const res = resolveRoute('CommitmentSentinel', undefined, NATURE_ROUTING_DEFAULT_CHAINS, { isDoorReachable: () => false });
    expect(res).toEqual({ outcome: 'no-route' });
  });

  it('OUTCOME throw RouterFailClosedError: a CRITICAL GATE with no available door fails CLOSED', () => {
    // MessagingToneGate (nature B, JUDGE, critical) with every door down ⇒ throw, never no-route/fall-through.
    expect(() => resolveRoute('MessagingToneGate', undefined, NATURE_ROUTING_DEFAULT_CHAINS, { isDoorReachable: () => false }))
      .toThrow(RouterFailClosedError);
    // MessageSentinel is nature-A but R2-critical ⇒ also fail-closed.
    expect(() => resolveRoute('MessageSentinel', undefined, NATURE_ROUTING_DEFAULT_CHAINS, { isDoorReachable: () => false }))
      .toThrow(RouterFailClosedError);
  });

  it('metered doors are always skipped in Increment A (FAST → pi-cli, gemini-api skipped)', () => {
    const res = resolveRoute('MessageSentinel', undefined, NATURE_ROUTING_DEFAULT_CHAINS, allCliReachable);
    expect(res.outcome).toBe('route');
    if (res.outcome !== 'route') return;
    // FAST default = gemini-api(metered, skipped) → pi-cli. Primary must be pi-cli.
    expect(res.primary).toMatchObject({ door: 'pi-cli', modelId: 'gpt-5.5' });
    expect(res.swapTail).toEqual([]);
  });

  it('a JUDGE route on claude-code is clamped to the reserve id at selection time (place-3 in the fold)', () => {
    // If ONLY claude-code is reachable, the JUDGE terminal reserve is the primary — and pinned to the reserve id.
    const onlyClaude = { isDoorReachable: (d: RoutingDoor) => d === 'claude-code' };
    const res = resolveRoute('MessagingToneGate', undefined, NATURE_ROUTING_DEFAULT_CHAINS, onlyClaude);
    expect(res.outcome).toBe('route');
    if (res.outcome !== 'route') return;
    expect(res.primary).toMatchObject({ door: 'claude-code', modelId: CLAUDE_CODE_RESERVE_MODEL_ID });
  });

  it('a caller-declared tightening nature reroutes a low-stakes call onto the JUDGE ladder', () => {
    const res = resolveRoute('CommitmentSentinel', 'B', NATURE_ROUTING_DEFAULT_CHAINS, allCliReachable);
    expect(res.outcome).toBe('route');
    if (res.outcome !== 'route') return;
    expect(res.resolvedChain).toBe('JUDGE'); // not SORT — tightened
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('mergeNatureRoutingChains', () => {
  it('unset override ⇒ the built-in v3 defaults verbatim', () => {
    expect(mergeNatureRoutingChains(undefined)).toBe(NATURE_ROUTING_DEFAULT_CHAINS);
  });
  it('a partial override replaces only the named chain; others keep the default', () => {
    const merged = mergeNatureRoutingChains({ SORT: [{ door: 'pi-cli', model: 'gpt-5.5' }] });
    expect(merged.SORT).toEqual([{ door: 'pi-cli', model: 'gpt-5.5' }]);
    expect(merged.JUDGE).toBe(NATURE_ROUTING_DEFAULT_CHAINS.JUDGE);
    expect(merged.FAST).toBe(NATURE_ROUTING_DEFAULT_CHAINS.FAST);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE load-bearing safety case: evaluate() wiring.
// ─────────────────────────────────────────────────────────────────────────────
function makeRouterWithNature(nature: NatureRoutingRuntime | undefined, onPlan?: (p: NatureRoutePlan) => void) {
  const defaultProvider = fakeProvider('claude');
  const built: Partial<Record<IntelligenceFramework, IntelligenceProvider>> = {};
  const router = new IntelligenceRouter({
    defaultProvider,
    defaultFramework: 'claude-code',
    resolveConfig: () => undefined, // componentFrameworks unconfigured — the common fleet shape
    buildProvider: (fw) => built[fw] ?? null,
    resolveNatureRouting: () => nature,
    onNatureRoutePlan: onPlan,
  });
  return { router, defaultProvider };
}

describe('evaluate() — nature routing is BYTE-IDENTICAL when unset/off', () => {
  const opts: IntelligenceOptions = { model: 'capable', attribution: { component: 'MessagingToneGate' } };

  it('natureRouting UNSET ⇒ selection unchanged, onNatureRoutePlan NEVER called', async () => {
    // THE safety case (named test): the resolve path is bit-for-bit today's behavior when off.
    const onPlan = vi.fn();
    const { router, defaultProvider } = makeRouterWithNature(undefined, onPlan);
    const out = await router.evaluate('p', opts);
    expect(out).toBe('claude');
    expect(defaultProvider.calls).toHaveLength(1);
    expect(defaultProvider.calls[0]).toBe(opts); // SAME options object — nothing rewritten
    expect(onPlan).not.toHaveBeenCalled();
  });

  it('natureRouting enabled:false ⇒ still byte-identical, onNatureRoutePlan NEVER called', async () => {
    const onPlan = vi.fn();
    const { router, defaultProvider } = makeRouterWithNature({ enabled: false, dryRun: true }, onPlan);
    const out = await router.evaluate('p', opts);
    expect(out).toBe('claude');
    expect(defaultProvider.calls[0]).toBe(opts);
    expect(onPlan).not.toHaveBeenCalled();
  });

  it('DRYRUN observes (logs the plan) but does NOT change the selected (door, model)', async () => {
    const onPlan = vi.fn();
    const { router, defaultProvider } = makeRouterWithNature({ enabled: true, dryRun: true }, onPlan);
    const out = await router.evaluate('p', opts);
    // Selection is UNCHANGED — the same default provider is called with the SAME options.
    expect(out).toBe('claude');
    expect(defaultProvider.calls[0]).toBe(opts);
    // …but the plan WAS observed.
    expect(onPlan).toHaveBeenCalledTimes(1);
    const plan = onPlan.mock.calls[0][0] as NatureRoutePlan;
    expect(plan.dryRun).toBe(true);
    expect(plan.component).toBe('MessagingToneGate');
  });

  it("DRYRUN records a critical-gate fail-closed plan WITHOUT throwing into the call path", async () => {
    // Force fail-closed: default framework 'gemini-cli' is NOT in the JUDGE chain, so pi-cli,
    // codex-cli, and claude-code all resolve unreachable (buildProvider → null) and the metered
    // doors are skipped ⇒ empty set for the critical gate MessagingToneGate ⇒ resolveRoute throws.
    // In dryRun that throw must be SWALLOWED (recorded as failClosed), never surfaced to the caller.
    const onPlan = vi.fn();
    const defaultProvider = fakeProvider('gemini');
    const router = new IntelligenceRouter({
      defaultProvider,
      defaultFramework: 'gemini-cli',
      resolveConfig: () => undefined,
      buildProvider: () => null,
      resolveNatureRouting: () => ({ enabled: true, dryRun: true }),
      onNatureRoutePlan: onPlan,
    });
    const out = await router.evaluate('p', { attribution: { component: 'MessagingToneGate' } });
    expect(out).toBe('gemini'); // dryRun never threw into the call path
    expect(defaultProvider.calls).toHaveLength(1);
    const plan = onPlan.mock.calls[0][0] as NatureRoutePlan;
    expect(plan.failClosed).toBe(true);
  });

  it('a resolver plan for a mapped critical gate is emitted in dryRun (observability)', async () => {
    const onPlan = vi.fn();
    const { router } = makeRouterWithNature({ enabled: true, dryRun: true }, onPlan);
    await router.evaluate('p', { attribution: { component: 'MessagingToneGate' } });
    const plan = onPlan.mock.calls[0][0] as NatureRoutePlan;
    // claude-code default is reachable ⇒ the JUDGE terminal reserve is available ⇒ a route plan.
    expect(plan.resolution?.outcome).toBe('route');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FD4.3 — the resolve-time + config-load CHAIN VALIDATOR (the pure predicate that
// rejects a banned chain at config LOAD and at RESOLVE time). Spec §221-225 / §Resolver
// step 3 / FD8 §393. The runtime companion to the build-lint; dev-gated / byte-identical
// when nature-routing is unset/off (the load-bearing safety property, asserted below).
// ─────────────────────────────────────────────────────────────────────────────
const CLEAN_FAST: ReadonlyArray<ChainPosition> = [{ door: 'pi-cli', model: 'gpt-5.5' }];

/** A full chains object with a BANNED JUDGE chain (Opus on claude-code) and clean others. */
function bannedJudgeChains(): NatureRoutingChains {
  return {
    FAST: NATURE_ROUTING_DEFAULT_CHAINS.FAST,
    SORT: NATURE_ROUTING_DEFAULT_CHAINS.SORT,
    JUDGE: [{ door: 'claude-code', model: 'claude-opus-4-8' }],
    WRITE: NATURE_ROUTING_DEFAULT_CHAINS.WRITE,
  };
}

describe('FD4.3 validateNatureRoutingChains (the pure predicate)', () => {
  it('the v3 default chains are CLEAN — zero violations, isValid true', () => {
    expect(validateNatureRoutingChains(NATURE_ROUTING_DEFAULT_CHAINS)).toEqual([]);
    expect(isNatureRoutingChainsValid(NATURE_ROUTING_DEFAULT_CHAINS)).toBe(true);
  });

  it('an Opus-family claude-code position in FAST/SORT/JUDGE is a violation (non-reserve)', () => {
    for (const chain of ['FAST', 'SORT', 'JUDGE'] as const) {
      const v = validateChainPosition(chain, { door: 'claude-code', model: 'claude-opus-4-8' }, 0);
      expect(v?.rule).toBe('claude-code-non-reserve');
    }
  });

  it('a claude-code TIER LABEL (capable) in a bounded/gating chain is a violation (must be the pinned reserve id)', () => {
    const v = validateChainPosition('SORT', { door: 'claude-code', model: 'capable' }, 0);
    expect(v?.rule).toBe('claude-code-tier-label');
  });

  it('the registry-pinned `balanced` label (→ concrete reserve id) on claude-code is ACCEPTED in FAST/SORT/JUDGE', () => {
    for (const chain of ['FAST', 'SORT', 'JUDGE'] as const) {
      expect(validateChainPosition(chain, { door: 'claude-code', model: 'balanced' }, 0)).toBeNull();
    }
    // …and the literal concrete reserve id is equally accepted.
    expect(validateChainPosition('JUDGE', { door: 'claude-code', model: CLAUDE_CODE_RESERVE_MODEL_ID }, 0)).toBeNull();
  });

  it('WRITE is EXEMPT — claude-code/capable (Opus) passes (open-ended writing is the legitimate Opus-CLI lane)', () => {
    expect(validateChainPosition('WRITE', { door: 'claude-code', model: 'capable' }, 0)).toBeNull();
  });

  it('a NON-claude-code door is never a harness-door violation (openrouter opus API door is clean)', () => {
    expect(validateChainPosition('JUDGE', { door: 'openrouter-api', model: 'opus-4.8' }, 0)).toBeNull();
  });

  it('a Fable model is banned on EVERY chain, including WRITE (FD8 §393)', () => {
    for (const chain of ['FAST', 'SORT', 'JUDGE', 'WRITE'] as const) {
      const v = validateChainPosition(chain, { door: 'claude-code', model: 'claude-fable-5' }, 0);
      expect(v?.rule).toBe('fable-banned');
    }
  });
});

describe('FD4.3 config-load rejection (mergeNatureRoutingChains)', () => {
  it('a banned override chain is REJECTED at load → the built-in default; onReject fires with the violations', () => {
    const onReject = vi.fn();
    const merged = mergeNatureRoutingChains({ JUDGE: bannedJudgeChains().JUDGE }, onReject);
    // The banned JUDGE override was dropped for the default (the banned route never reaches config).
    expect(merged.JUDGE).toBe(NATURE_ROUTING_DEFAULT_CHAINS.JUDGE);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][0]).toBe('JUDGE');
    expect((onReject.mock.calls[0][1] as unknown[]).length).toBeGreaterThan(0);
  });

  it('a CLEAN override is passed through verbatim (no rejection)', () => {
    const onReject = vi.fn();
    const merged = mergeNatureRoutingChains({ FAST: CLEAN_FAST }, onReject);
    expect(merged.FAST).toEqual(CLEAN_FAST);
    expect(merged.JUDGE).toBe(NATURE_ROUTING_DEFAULT_CHAINS.JUDGE);
    expect(onReject).not.toHaveBeenCalled();
  });
});

describe('FD4.3 resolve-time rejection (resolveRoute)', () => {
  it('a live banned JUDGE chain is REJECTED → built-in defaults; onInvalidChain fires; the banned Opus route never resolves', () => {
    const onInvalidChain = vi.fn();
    const onlyClaude = { isDoorReachable: (d: RoutingDoor) => d === 'claude-code', onInvalidChain };
    // MessagingToneGate is JUDGE; pass a banned JUDGE chain (claude-code opus). The validator must
    // reject it → fall back to the DEFAULT JUDGE chain, whose only reachable position is the pinned
    // reserve — NEVER the banned Opus id.
    const res = resolveRoute('MessagingToneGate', undefined, bannedJudgeChains(), onlyClaude);
    expect(res.outcome).toBe('route');
    if (res.outcome !== 'route') return;
    expect(res.primary).toMatchObject({ door: 'claude-code', modelId: CLAUDE_CODE_RESERVE_MODEL_ID });
    expect(res.primary.modelId).not.toBe('claude-opus-4-8');
    expect(onInvalidChain).toHaveBeenCalledTimes(1);
    expect(onInvalidChain.mock.calls[0][0]).toBe('JUDGE');
  });

  it('a clean chain resolves WITHOUT invoking the rejection notice', () => {
    const onInvalidChain = vi.fn();
    const res = resolveRoute('CommitmentSentinel', undefined, NATURE_ROUTING_DEFAULT_CHAINS, {
      isDoorReachable: () => true,
      onInvalidChain,
    });
    expect(res.outcome).toBe('route');
    expect(onInvalidChain).not.toHaveBeenCalled();
  });
});

describe('FD4.3 is BYTE-IDENTICAL when nature-routing is OFF (the validator never runs)', () => {
  it('enabled:false + a BANNED chains override ⇒ selection unchanged, no plan, no validation side-effect', async () => {
    const onPlan = vi.fn();
    // Even with a banned JUDGE override present, an OFF feature never merges/validates/resolves —
    // the default provider is called with the SAME options object (bit-for-bit today's behavior).
    const { router, defaultProvider } = makeRouterWithNature(
      { enabled: false, dryRun: true, chains: { JUDGE: bannedJudgeChains().JUDGE } },
      onPlan,
    );
    const opts: IntelligenceOptions = { model: 'capable', attribution: { component: 'MessagingToneGate' } };
    const out = await router.evaluate('p', opts);
    expect(out).toBe('claude');
    expect(defaultProvider.calls[0]).toBe(opts); // SAME object — nothing merged, validated, or rewritten
    expect(onPlan).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FD5b — the injection-exposure gate in resolveRoute (spec §283-294). An
// injection-EXPOSED component may never land on a NON-injection-safe door
// (`injectionSafe: false`). NO-OP in Increment A over the real defaults (the only
// such door, groq-api, is ALSO metered → already skipped), so these tests use a
// SYNTHETIC chain with a non-injection-safe CLI door to exercise the gate in
// isolation from the metered dimension.
// ─────────────────────────────────────────────────────────────────────────────

/** A SORT chain whose FIRST position is a reachable CLI door marked injectionSafe:false. */
const UNSAFE_FIRST_SORT: NatureRoutingChains = {
  FAST: NATURE_ROUTING_DEFAULT_CHAINS.FAST,
  SORT: [
    { door: 'pi-cli', model: 'gpt-5.5', injectionSafe: false }, // non-injection-safe CLI door (synthetic)
    { door: 'codex-cli', model: 'gpt-5.4-mini' },
  ],
  JUDGE: NATURE_ROUTING_DEFAULT_CHAINS.JUDGE,
  WRITE: NATURE_ROUTING_DEFAULT_CHAINS.WRITE,
};

describe('FD5b injection gate (resolveRoute)', () => {
  it('an EXPOSED component SKIPS the non-injection-safe door; a NON-exposed component keeps it', () => {
    // CommitmentSentinel is SORT + statically exposed:true.
    const asExposed = resolveRoute('CommitmentSentinel', undefined, UNSAFE_FIRST_SORT, {
      isDoorReachable: () => true,
      isInjectionExposed: () => true,
    });
    expect(asExposed.outcome).toBe('route');
    if (asExposed.outcome !== 'route') return;
    // pi-cli (injectionSafe:false) is skipped ⇒ primary is codex-cli.
    expect(asExposed.primary.door).toBe('codex-cli');
    expect(asExposed.swapTail.map((p) => p.door)).not.toContain('pi-cli');

    // Same chain + same reachability, but NOT exposed ⇒ the non-injection door is eligible.
    const asTrusted = resolveRoute('CommitmentSentinel', undefined, UNSAFE_FIRST_SORT, {
      isDoorReachable: () => true,
      isInjectionExposed: () => false,
    });
    expect(asTrusted.outcome).toBe('route');
    if (asTrusted.outcome !== 'route') return;
    expect(asTrusted.primary.door).toBe('pi-cli'); // kept — no injection risk
  });

  it('defaults to the STATIC map when isInjectionExposed is omitted (CommitmentSentinel is exposed ⇒ skipped)', () => {
    const res = resolveRoute('CommitmentSentinel', undefined, UNSAFE_FIRST_SORT, {
      isDoorReachable: () => true,
    });
    expect(res.outcome).toBe('route');
    if (res.outcome !== 'route') return;
    // No isInjectionExposed dep ⇒ resolveInjectionExposure (static) ⇒ CommitmentSentinel exposed ⇒ pi-cli skipped.
    expect(res.primary.door).toBe('codex-cli');
    expect(resolveInjectionExposure('CommitmentSentinel')).toBe(true);
  });

  it('a critical gate that would land ONLY on a non-injection door when exposed FAILS CLOSED (never routes there)', () => {
    // Chain: the ONLY reachable position is a non-injection-safe door. MessagingToneGate is a critical
    // gate ⇒ an exposed call skips it and, with no other door, throws (fail-closed) rather than route unsafe.
    const unsafeOnlyJudge: NatureRoutingChains = {
      FAST: NATURE_ROUTING_DEFAULT_CHAINS.FAST,
      SORT: NATURE_ROUTING_DEFAULT_CHAINS.SORT,
      JUDGE: [{ door: 'pi-cli', model: 'gpt-5.5', injectionSafe: false }],
      WRITE: NATURE_ROUTING_DEFAULT_CHAINS.WRITE,
    };
    expect(() =>
      resolveRoute('MessagingToneGate', undefined, unsafeOnlyJudge, {
        isDoorReachable: () => true,
        isInjectionExposed: () => true,
      }),
    ).toThrow(RouterFailClosedError);
    // …but a NON-exposed call on the same chain routes onto that door (no injection risk).
    const trusted = resolveRoute('MessagingToneGate', undefined, unsafeOnlyJudge, {
      isDoorReachable: () => true,
      isInjectionExposed: () => false,
    });
    expect(trusted.outcome).toBe('route');
  });

  it('the real default chains are UNAFFECTED by the gate for an exposed component (Increment A no-op)', () => {
    // groq-api (the only injectionSafe:false default door) is metered ⇒ already skipped; the gate changes nothing.
    const res = resolveRoute('CommitmentSentinel', undefined, NATURE_ROUTING_DEFAULT_CHAINS, {
      isDoorReachable: () => true,
      isInjectionExposed: () => true, // exposed
    });
    const resTrusted = resolveRoute('CommitmentSentinel', undefined, NATURE_ROUTING_DEFAULT_CHAINS, {
      isDoorReachable: () => true,
      isInjectionExposed: () => false, // trusted
    });
    expect(res).toEqual(resTrusted); // identical — no default door is a non-metered injection door
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FD5b — injection-cache isolation (spec §764-766, combined-safety r5). Door
// HEALTH may be cached; the injection POLICY skip is re-evaluated FRESH per call.
// resolveRoute recomputes exposure every call from the injected predicate, so the
// SAME cached door-health verdict yields DIFFERENT eligibility for a trusted vs an
// exposed call — proving the policy is never baked into a cached full verdict.
// ─────────────────────────────────────────────────────────────────────────────
describe('FD5b injection-cache isolation', () => {
  it('the SAME cached door health yields a DIFFERENT injection verdict per call (policy is fresh, not cached)', () => {
    // One shared isDoorReachable closure = a single cached door-health source, reused by both calls.
    let doorHealthQueries = 0;
    const cachedHealth = {
      isDoorReachable: (_d: RoutingDoor) => {
        doorHealthQueries++;
        return true; // pi-cli + codex-cli both "healthy" (cached)
      },
    };

    // Call 1 — a NON-exposed call: pi-cli (injectionSafe:false) is HEALTHY and ELIGIBLE.
    const trusted = resolveRoute('CommitmentSentinel', undefined, UNSAFE_FIRST_SORT, {
      ...cachedHealth,
      isInjectionExposed: () => false,
    });
    expect(trusted.outcome === 'route' && trusted.primary.door).toBe('pi-cli');

    // Call 2 — an EXPOSED call within the same "TTL" (same cached health source): pi-cli is STILL healthy
    // but is skipped by a FRESHLY-evaluated injection policy — NOT served from call 1's full verdict.
    const exposedCall = resolveRoute('CommitmentSentinel', undefined, UNSAFE_FIRST_SORT, {
      ...cachedHealth,
      isInjectionExposed: () => true,
    });
    expect(exposedCall.outcome === 'route' && exposedCall.primary.door).toBe('codex-cli');
    expect(doorHealthQueries).toBeGreaterThan(0); // door health WAS consulted (cached source), yet the verdict diverged
  });

  it('isComponentInjectionExposed — static exposure OR the per-call tighten (never relaxes static)', () => {
    // Statically exposed:false — the per-call flag may TIGHTEN it to exposed.
    expect(isComponentInjectionExposed('InteractivePoolCanaryJudge')).toBe(false);
    expect(isComponentInjectionExposed('InteractivePoolCanaryJudge', true)).toBe(true); // tightened
    expect(isComponentInjectionExposed('InteractivePoolCanaryJudge', false)).toBe(false);
    // Statically exposed:true — the per-call flag can NEVER relax it (fail-safe).
    expect(isComponentInjectionExposed('MessagingToneGate')).toBe(true);
    expect(isComponentInjectionExposed('MessagingToneGate', false)).toBe(true); // still exposed
    // Unknown component — fail-closed exposed regardless of the flag.
    expect(isComponentInjectionExposed('UnknownThing')).toBe(true);
    expect(isComponentInjectionExposed(undefined)).toBe(true);
  });
});
