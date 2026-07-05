/**
 * FD5b injection-exposure static-map ratchet — the test-side enforcement of the
 * nature-axis routing injection gate (docs/specs/nature-axis-routing.md §283-294,
 * semantic-drift row detail §370-384).
 *
 * Guarantees, structurally (mirrors the untrustedInput / bench-coverage ratchets):
 *   1. EXHAUSTIVE over COMPONENT_CATEGORY — every LLM component carries an EXPLICIT
 *      injection-exposure row (a MISSING key fails) AND every map key names a real
 *      component (a DANGLING key fails). No default toward the unguarded state.
 *   2. FAIL-SAFE resolve — an unknown/unmapped/absent component resolves EXPOSED.
 *   3. The argued NOT-EXPOSED set is pinned SHRINK-ONLY, each with a real reason and
 *      an all-false input-shape (audited: no untrusted content can enter).
 *   4. INPUT-SHAPE coherence (spec §371) — `exposed ⟺ (user||model||tool content)`.
 *   5. CROSS-CHECK vs LLM_UNTRUSTED_INPUT — injection exposure is the SAME predicate
 *      as untrusted-input, so the two reviewed axes can never silently diverge.
 *   6. R8 (spec §308-310) — the input-classifier components MUST stay exposed:true.
 */
import { describe, it, expect } from 'vitest';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import {
  LLM_ROUTING_INJECTION_EXPOSURE,
  LLM_UNTRUSTED_INPUT,
  resolveInjectionExposure,
  type UntrustedInputFlag,
} from '../../src/data/llmBenchCoverage.js';

function isUntrustedArguedFalse(v: UntrustedInputFlag): v is { false: string } {
  return typeof v === 'object' && v !== null && 'false' in v;
}

// ── Pinned NOT-EXPOSED baseline (2026-07-05). SHRINK-ONLY: flipping a row to
// exposed:true removes it here; ADDING a name means you are declaring a component
// carries NO untrusted content — argue the reason in src/data/llmBenchCoverage.ts
// AND add it here (a visible, reviewed act). It MIRRORS the untrustedInput
// argued-false set (cross-checked below). ──
const NOT_EXPOSED_BASELINE = [
  'PromiseBeacon',
  'InteractivePoolCanaryJudge',
  'AutoApprover',
  'IntegrationGate',
  'CoherenceGate',
  'InputDetector',
].sort();

describe('FD5b injection-exposure static-map ratchet', () => {
  it('EXHAUSTIVE — every COMPONENT_CATEGORY key has an explicit injection-exposure row (a MISSING entry FAILS)', () => {
    const missing = Object.keys(COMPONENT_CATEGORY).filter(
      (k) => !(k in LLM_ROUTING_INJECTION_EXPOSURE),
    );
    expect(
      missing,
      `LLM component(s) with no injection-exposure row: ${missing.join(', ')}.\n` +
        'Add each to LLM_ROUTING_INJECTION_EXPOSURE in src/data/llmBenchCoverage.ts — `exposed(<inputShape>)` ' +
        '(it carries untrusted content) or `notExposed("<argued reason>")` (audited: no untrusted content — ALSO ' +
        'add it to NOT_EXPOSED_BASELINE in this test). nature-axis-routing.md FD5b §286.',
    ).toEqual([]);
  });

  it('no DANGLING entries — every map key names a real COMPONENT_CATEGORY component (a dangling key FAILS)', () => {
    const dangling = Object.keys(LLM_ROUTING_INJECTION_EXPOSURE).filter(
      (k) => !(k in COMPONENT_CATEGORY),
    );
    expect(
      dangling,
      `injection-exposure rows for unknown components: ${dangling.join(', ')}`,
    ).toEqual([]);
  });

  it('FAIL-SAFE — an unknown / unmapped / absent component resolves EXPOSED (fail-closed skip)', () => {
    expect(resolveInjectionExposure(undefined)).toBe(true);
    expect(resolveInjectionExposure('TotallyUnknownComponent')).toBe(true);
    expect(resolveInjectionExposure('')).toBe(true);
  });

  it('resolve strips the "/segment" suffix and "server:" prefix before lookup', () => {
    // CompletionEvaluator is exposed:true; a suffixed/prefixed callsite label resolves the same.
    expect(resolveInjectionExposure('CompletionEvaluator/stop-judge')).toBe(true);
    expect(resolveInjectionExposure('server:correction-learning')).toBe(true);
    // InteractivePoolCanaryJudge is exposed:false; its suffixed form stays false.
    expect(resolveInjectionExposure('InteractivePoolCanaryJudge/probe')).toBe(false);
  });

  it('the argued NOT-EXPOSED set matches the pinned shrink-only baseline exactly', () => {
    const actual = Object.entries(LLM_ROUTING_INJECTION_EXPOSURE)
      .filter(([, v]) => v.exposed === false)
      .map(([k]) => k)
      .sort();
    expect(
      actual,
      'The NOT-EXPOSED set drifted from the pinned baseline. Flipping a false→true is a shrink ' +
        '(remove it from NOT_EXPOSED_BASELINE); adding a new NOT-EXPOSED requires editing this pinned ' +
        'baseline — a visible, reviewed act.',
    ).toEqual(NOT_EXPOSED_BASELINE);
  });

  it('every NOT-EXPOSED row carries a real reason (>= 40 chars) AND an all-false input-shape', () => {
    for (const [k, v] of Object.entries(LLM_ROUTING_INJECTION_EXPOSURE)) {
      if (v.exposed !== false) continue;
      expect((v.reason ?? '').trim().length, `${k}: NOT-EXPOSED reason too short`).toBeGreaterThanOrEqual(40);
      expect(
        v.inputShape.userContent || v.inputShape.modelContent || v.inputShape.toolContent,
        `${k}: NOT-EXPOSED must declare an all-false input-shape (nothing untrusted can enter)`,
      ).toBe(false);
    }
  });

  it('INPUT-SHAPE coherence (spec §371) — exposed ⟺ (userContent || modelContent || toolContent)', () => {
    const violations: string[] = [];
    for (const [k, v] of Object.entries(LLM_ROUTING_INJECTION_EXPOSURE)) {
      const anyChannel = v.inputShape.userContent || v.inputShape.modelContent || v.inputShape.toolContent;
      if (v.exposed !== anyChannel) {
        violations.push(`${k}: exposed=${v.exposed} but input-shape any-channel=${anyChannel}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('CROSS-CHECK — injection exposure equals the reviewed untrustedInput classification (never diverges)', () => {
    const mismatches: string[] = [];
    for (const k of Object.keys(COMPONENT_CATEGORY)) {
      const exposed = LLM_ROUTING_INJECTION_EXPOSURE[k]?.exposed;
      const untrusted = LLM_UNTRUSTED_INPUT[k];
      const untrustedTrue = untrusted === true; // `{false}` or absent ⇒ not untrusted
      if (exposed !== untrustedTrue) {
        mismatches.push(`${k}: injectionExposed=${exposed} but untrustedInput=${untrustedTrue}`);
      }
    }
    expect(
      mismatches,
      'injection exposure diverged from the untrustedInput axis (same predicate — a component carries ' +
        'injection-bearing content iff it judges untrusted content):\n' + mismatches.join('\n'),
    ).toEqual([]);
  });

  it('the untrustedInput argued-false set and the NOT-EXPOSED set are the same components', () => {
    const untrustedFalse = Object.entries(LLM_UNTRUSTED_INPUT)
      .filter(([, v]) => isUntrustedArguedFalse(v))
      .map(([k]) => k)
      .sort();
    expect(untrustedFalse).toEqual(NOT_EXPOSED_BASELINE);
  });

  it('R8 (spec §308-310) — the input-classifier components are exposed:true and can never be relaxed', () => {
    for (const c of ['InputClassifier', 'MessageSentinel', 'TaskClassifier']) {
      expect(LLM_ROUTING_INJECTION_EXPOSURE[c]?.exposed, `${c} must be exposed:true (R8)`).toBe(true);
      expect(resolveInjectionExposure(c), `${c} must resolve exposed:true (R8)`).toBe(true);
    }
  });

  it('the map is non-empty and every row has a well-formed input-shape', () => {
    expect(Object.keys(LLM_ROUTING_INJECTION_EXPOSURE).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(LLM_ROUTING_INJECTION_EXPOSURE)) {
      expect(typeof v.exposed, `${k}: exposed must be boolean`).toBe('boolean');
      for (const ch of ['userContent', 'modelContent', 'toolContent'] as const) {
        expect(typeof v.inputShape[ch], `${k}: inputShape.${ch} must be boolean`).toBe('boolean');
      }
    }
  });
});
