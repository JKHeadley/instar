import { describe, it, expect } from 'vitest';
import { resolveToneGateOperatorConfig } from '../../src/core/MessagingToneGate.js';

/**
 * Wiring-integrity tests for the tone-gate operator-config resolver — the
 * single point where config.json reaches the gate's live getter.
 *
 * Regression class (2026-07-24 candidate-body wiring gap): the construction
 * site read `config.messaging?.toneGate` (structurally dead — `messaging` is
 * an ARRAY of adapter configs) and whitelisted only three of the four knobs,
 * so `recordCandidateBody: true` never reached the gate and zero candidate
 * bodies were ever captured despite the feature merging green.
 */
describe('resolveToneGateOperatorConfig', () => {
  it('passes all four knobs through from the top-level toneGate block (realistic config shape)', () => {
    const config = {
      // messaging is an ARRAY in every real config — the shape that killed the
      // legacy messaging.toneGate read.
      messaging: [{ type: 'telegram', config: { token: 'x' } }],
      toneGate: {
        failClosedOnExhaustion: false,
        failClosedMode: 'tiered' as const,
        toneTierDryRun: true,
        recordCandidateBody: true,
      },
    };
    expect(resolveToneGateOperatorConfig(config)).toEqual({
      failClosedOnExhaustion: false,
      failClosedMode: 'tiered',
      toneTierDryRun: true,
      recordCandidateBody: true,
    });
  });

  it('resolves every knob undefined when the block is absent (gate defaults preserved)', () => {
    const resolved = resolveToneGateOperatorConfig({ messaging: [] });
    expect(resolved.failClosedOnExhaustion).toBeUndefined();
    expect(resolved.failClosedMode).toBeUndefined();
    expect(resolved.toneTierDryRun).toBeUndefined();
    expect(resolved.recordCandidateBody).toBeUndefined();
  });

  it('recordCandidateBody specifically survives the resolver (the knob the old whitelist dropped)', () => {
    const resolved = resolveToneGateOperatorConfig({ toneGate: { recordCandidateBody: true } });
    expect(resolved.recordCandidateBody).toBe(true);
  });

  it('does NOT resurrect the structurally-dead messaging.toneGate location', () => {
    // A hand-authored object-shaped messaging block must stay a dead key:
    // no config ever worked from there, and honoring it now would create a
    // second, conflicting source of truth.
    const resolved = resolveToneGateOperatorConfig({
      messaging: { toneGate: { recordCandidateBody: true, failClosedOnExhaustion: false } },
    } as unknown);
    expect(resolved.recordCandidateBody).toBeUndefined();
    expect(resolved.failClosedOnExhaustion).toBeUndefined();
  });

  it('tolerates null/undefined config without throwing (live getter runs on every review)', () => {
    expect(resolveToneGateOperatorConfig(null)).toEqual({
      failClosedOnExhaustion: undefined,
      failClosedMode: undefined,
      toneTierDryRun: undefined,
      recordCandidateBody: undefined,
    });
    expect(resolveToneGateOperatorConfig(undefined)).toEqual({
      failClosedOnExhaustion: undefined,
      failClosedMode: undefined,
      toneTierDryRun: undefined,
      recordCandidateBody: undefined,
    });
  });
});
