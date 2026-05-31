/**
 * Conformance — observability READ primitives across adapters.
 *
 * Closes the parity-coverage gap found in the 2026-05-31 codex audit: the
 * openai-codex adapter ships conversationLogReader / conversationLogTailer /
 * sessionResumeIndex implementations, but NO test exercised them — so a codex
 * adapter that silently dropped one of these (declared the capability but wired
 * no impl, or drifted the method shape) would pass CI. This runs the SAME
 * contract-shape suite against BOTH the anthropic and codex adapters, mirroring
 * oneShotCompletion.conformance.test.ts (which the codex adapter was also absent
 * from). Behavior-against-real-logs stays per-adapter + realApi-gated; this is
 * the contract-shape floor that must hold for every adapter that declares the
 * capability.
 */
import { describe, it, expect } from 'vitest';
import { createAnthropicHeadlessAdapter } from '../../../src/providers/adapters/anthropic-headless/index.js';
import { createOpenAiCodexAdapter } from '../../../src/providers/adapters/openai-codex/index.js';
import { CapabilityFlag } from '../../../src/providers/capabilities.js';

interface AdapterUnderTest {
  id: string;
  factory: () => {
    primitive(cap: CapabilityFlag): unknown;
    capabilities: ReadonlySet<CapabilityFlag>;
  };
}

const ADAPTERS: AdapterUnderTest[] = [
  { id: 'anthropic-headless', factory: () => createAnthropicHeadlessAdapter() },
  { id: 'openai-codex', factory: () => createOpenAiCodexAdapter() },
];

// Each observability READ primitive + the methods its interface requires.
const PRIMITIVES: ReadonlyArray<{ cap: CapabilityFlag; methods: readonly string[] }> = [
  { cap: CapabilityFlag.ConversationLogReader, methods: ['read', 'readStream'] },
  { cap: CapabilityFlag.ConversationLogTailer, methods: ['tail'] },
  { cap: CapabilityFlag.SessionResumeIndex, methods: ['findById', 'findRecent', 'listByProject', 'resume'] },
];

for (const adapter of ADAPTERS) {
  describe(`Observability-reader conformance — ${adapter.id}`, () => {
    for (const p of PRIMITIVES) {
      describe(p.cap, () => {
        it('declares the capability flag', () => {
          expect(adapter.factory().capabilities.has(p.cap)).toBe(true);
        });

        it('returns a primitive carrying the matching capability marker', () => {
          const prim = adapter.factory().primitive(p.cap) as { capability?: string } | undefined;
          expect(prim, `${adapter.id} declares ${p.cap} but primitive(${p.cap}) returned nothing`).toBeDefined();
          expect(prim!.capability).toBe(p.cap);
        });

        it('exposes its contract methods as callables', () => {
          const prim = adapter.factory().primitive(p.cap) as Record<string, unknown>;
          for (const m of p.methods) {
            expect(typeof prim[m], `${adapter.id} ${p.cap}.${m} must be a function`).toBe('function');
          }
        });
      });
    }
  });
}
