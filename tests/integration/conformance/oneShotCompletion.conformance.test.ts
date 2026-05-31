/**
 * OneShotCompletion conformance — real behavior tests for both Anthropic adapters.
 *
 * Replaces the no-op stub assertions in `src/providers/conformance/transport/
 * oneShotCompletion.ts` for the OneShotCompletion primitive specifically.
 * The audit (specs/provider-portability/audit_substrate.md) found that the
 * Phase 2 conformance framework declared 51 suites that all called a
 * `getAssertions()` helper returning no-op stubs — i.e., running the
 * entire conformance run verified nothing at runtime. This file is the
 * template for the real behavior assertions that replace those stubs.
 *
 * Pattern this file establishes:
 *   1. Conformance test files live under tests/conformance/ where vitest
 *      `describe` / `it` / `expect` are first-class.
 *   2. Each suite tests one primitive against EVERY adapter that claims
 *      the capability (read from the registry or hardcoded for now).
 *   3. Tests parameterize over real-API gating (INSTAR_REAL_API=1).
 *      Structural tests always run; behavior tests skip without real API.
 *   4. Behavior tests share the same scenarios as the Phase 3c parity
 *      harness so a failure here mirrors a failure there — keeps the
 *      two layers consistent.
 */

import { describe, it, expect } from 'vitest';
import { createAnthropicHeadlessAdapter } from '../../../src/providers/adapters/anthropic-headless/index.js';
import { createAnthropicInteractivePoolAdapter } from '../../../src/providers/adapters/anthropic-interactive-pool/index.js';
import { createOpenAiCodexAdapter } from '../../../src/providers/adapters/openai-codex/index.js';
import { CapabilityFlag } from '../../../src/providers/capabilities.js';
import type { OneShotCompletion } from '../../../src/providers/primitives/transport/oneShotCompletion.js';

const realApi = process.env['INSTAR_REAL_API'] === '1';

interface AdapterUnderTest {
  id: string;
  // Functions returning fresh adapter instances per test.
  factory: () => {
    primitive(cap: CapabilityFlag): unknown;
    capabilities: ReadonlySet<CapabilityFlag>;
    start?(): Promise<void>;
    dispose?(): Promise<void>;
  };
}

const ADAPTERS: AdapterUnderTest[] = [
  {
    id: 'anthropic-headless',
    factory: () => createAnthropicHeadlessAdapter(),
  },
  {
    id: 'anthropic-interactive-pool',
    factory: () => createAnthropicInteractivePoolAdapter({ poolSize: 1, canaryIntervalMs: 0 }),
  },
  {
    // Codex declares OneShotCompletion (capabilities.ts) but was absent from this harness —
    // a parity-coverage gap from the 2026-05-31 audit. Contract-shape conformance runs the
    // same assertions against codex; the realApi behavior case stays opt-in.
    id: 'openai-codex',
    factory: () => createOpenAiCodexAdapter(),
  },
];

for (const adapter of ADAPTERS) {
  describe(`OneShotCompletion conformance — ${adapter.id}`, () => {
    it('declares the OneShotCompletion capability flag', () => {
      const instance = adapter.factory();
      expect(instance.capabilities.has(CapabilityFlag.OneShotCompletion)).toBe(true);
    });

    it('returns a primitive that has the OneShotCompletion capability marker', () => {
      const instance = adapter.factory();
      const prim = instance.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
      expect(prim).toBeDefined();
      expect(prim.capability).toBe(CapabilityFlag.OneShotCompletion);
    });

    it('exposes evaluate as a function', () => {
      const instance = adapter.factory();
      const prim = instance.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
      expect(typeof prim.evaluate).toBe('function');
    });

    it.runIf(realApi)(
      'returns a structurally-valid result when called with a simple arithmetic prompt',
      async () => {
        const instance = adapter.factory();
        await instance.start?.();
        try {
          const prim = instance.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
          const result = await prim.evaluate(
            'What is 2+2? Reply with only the number, no other text.',
            { model: 'fast', timeoutMs: 120_000 },
          );
          expect(typeof result.text).toBe('string');
          expect(result.text.length).toBeGreaterThan(0);
          expect(/4/.test(result.text)).toBe(true);
          // usage field present (may be null) — structural requirement.
          expect('usage' in result).toBe(true);
        } finally {
          await instance.dispose?.();
        }
      },
      180_000,
    );

    it.runIf(realApi)(
      'surfaces AbortSignal cancellation as a thrown error rather than a fabricated response',
      async () => {
        const instance = adapter.factory();
        await instance.start?.();
        try {
          const prim = instance.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
          const controller = new AbortController();
          controller.abort();
          await expect(
            prim.evaluate('what is 2+2?', { signal: controller.signal, timeoutMs: 5_000 }),
          ).rejects.toBeInstanceOf(Error);
        } finally {
          await instance.dispose?.();
        }
      },
      30_000,
    );
  });
}
