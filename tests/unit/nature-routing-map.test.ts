/**
 * Unit tests for the pure nature-axis routing MAP composer (src/core/natureRoutingMap.ts).
 * Verifies the map resolves a known component to its expected ordered chain + concrete
 * model ids + per-position/per-component flags, that the chains resolve correctly, and
 * that the composer is PURE (no writes, stable across calls, does not mutate its inputs).
 */
import { describe, it, expect } from 'vitest';
import { buildNatureRoutingMap, traceComponent } from '../../src/core/natureRoutingMap.js';
import {
  NATURE_ROUTING_DEFAULT_CHAINS,
  LLM_ROUTING_NATURE,
  ROUTING_LABEL_TO_MODEL_ID,
  NATURE_ROUTING_CRITICAL_GATES,
} from '../../src/data/llmBenchCoverage.js';

describe('buildNatureRoutingMap (pure composition)', () => {
  it('exposes the four canonical chains in order with resolved model ids', () => {
    const map = buildNatureRoutingMap();
    expect(map.chains.map((c) => c.chain)).toEqual(['FAST', 'SORT', 'JUDGE', 'WRITE']);

    const judge = map.chains.find((c) => c.chain === 'JUDGE')!;
    // JUDGE[0] is pi-cli/gpt-5.5 → resolves to the concrete id via the label registry.
    expect(judge.positions[0]).toMatchObject({
      door: 'pi-cli',
      doorClass: 'cli',
      label: 'gpt-5.5',
      modelId: ROUTING_LABEL_TO_MODEL_ID['pi-cli']['gpt-5.5'],
      moneyGated: false,
      skippedInIncrementA: false,
    });
    // JUDGE contains a metered openrouter position — money-gated + skipped in Increment A.
    const metered = judge.positions.find((p) => p.door === 'openrouter-api');
    expect(metered).toMatchObject({ doorClass: 'metered', moneyGated: true, skippedInIncrementA: true });
    expect(metered!.keyRef).toBe('metered_openrouter_bench');
  });

  it('flags the Groq WRITE door as unsafe for untrusted input (injectionSafe=false)', () => {
    const write = buildNatureRoutingMap().chains.find((c) => c.chain === 'WRITE')!;
    const groq = write.positions.find((p) => p.door === 'groq-api')!;
    expect(groq.injectionSafe).toBe(false);
    // Every non-Groq WRITE position defaults to injection-safe.
    for (const p of write.positions) {
      if (p.door !== 'groq-api') expect(p.injectionSafe).toBe(true);
    }
  });

  it('resolves a known component to its declared nature + chain + full ordered route', () => {
    const map = buildNatureRoutingMap();
    // MessagingToneGate is a nature-B JUDGE critical gate.
    const tone = map.components.find((c) => c.component === 'MessagingToneGate')!;
    expect(tone.nature).toBe('B');
    expect(tone.chain).toBe('JUDGE');
    expect(tone.criticalGate).toBe(true);
    expect(tone.untrustedInput).toBe(true);
    // Its route is exactly the resolved JUDGE chain (ordered).
    const judgeIds = NATURE_ROUTING_DEFAULT_CHAINS.JUDGE.map(
      (p) => ROUTING_LABEL_TO_MODEL_ID[p.door]?.[p.model] ?? p.model,
    );
    expect(tone.route.map((p) => p.modelId)).toEqual(judgeIds);
    expect(tone.route.map((p) => p.door)).toEqual(NATURE_ROUTING_DEFAULT_CHAINS.JUDGE.map((p) => p.door));
  });

  it('marks an unmapped component as legacy (null nature/chain, empty route)', () => {
    const map = buildNatureRoutingMap();
    const unmapped = map.components.find((c) => !LLM_ROUTING_NATURE[c.component]);
    expect(unmapped).toBeDefined();
    expect(unmapped!.nature).toBeNull();
    expect(unmapped!.chain).toBeNull();
    expect(unmapped!.route).toEqual([]);
  });

  it('surfaces the critical-gate set faithfully', () => {
    const map = buildNatureRoutingMap();
    const gates = map.components.filter((c) => c.criticalGate).map((c) => c.component).sort();
    // Only components in the shipped critical-gate set that are also known components.
    const known = new Set(map.components.map((c) => c.component));
    const expected = [...NATURE_ROUTING_CRITICAL_GATES].filter((g) => known.has(g)).sort();
    expect(gates).toEqual(expected);
  });

  it('surfaces the FD5b injection-exposure classification per component', () => {
    const map = buildNatureRoutingMap();
    expect(map.injectionExposureSource).toBe('FD5b-exposure-map');
    // MessageSentinel is exposed via user content (an inbound user message).
    const ms = map.components.find((c) => c.component === 'MessageSentinel')!;
    expect(ms.injectionExposure).toBeDefined();
    expect(ms.injectionExposure!.exposed).toBe(true);
    expect(ms.injectionExposure!.channels.user).toBe(true);
  });

  it('injects the live enforced framework via the callback (read-only annotation)', () => {
    const map = buildNatureRoutingMap({ enforcedFrameworkFor: () => 'codex-cli' });
    expect(map.components.every((c) => c.enforcedFramework === 'codex-cli')).toBe(true);
    // Without the callback, no enforcedFramework key is present.
    const bare = buildNatureRoutingMap();
    expect(bare.components.every((c) => c.enforcedFramework === undefined)).toBe(true);
  });

  it('is PURE — repeated calls are deep-equal and inputs are not mutated', () => {
    const chainsSnapshot = JSON.stringify(NATURE_ROUTING_DEFAULT_CHAINS);
    const a = buildNatureRoutingMap();
    const b = buildNatureRoutingMap();
    expect(a).toEqual(b);
    // The shared static input map is untouched.
    expect(JSON.stringify(NATURE_ROUTING_DEFAULT_CHAINS)).toBe(chainsSnapshot);
  });

  it('traceComponent returns a single entry or undefined for an unknown name', () => {
    expect(traceComponent('MessagingToneGate')?.chain).toBe('JUDGE');
    expect(traceComponent('__does-not-exist__')).toBeUndefined();
  });
});
