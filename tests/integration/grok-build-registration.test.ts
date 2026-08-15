/**
 * Integration tests — grok-build gated registration + reviewer-family wiring
 * (grok-build framework integration spec §7, §8).
 *
 * Exercises the REAL registration funnel (bootRegistration) against isolated
 * registries, plus the cross-model reviewer registry membership — the two
 * wiring seams a dark-shipped framework can silently miss.
 */

import { describe, it, expect } from 'vitest';
import { Registry } from '../../src/providers/registry.js';
import {
  registerGrokBuildAdapters,
} from '../../src/providers/bootRegistration.js';
import {
  SUPPORTED_REVIEWER_FRAMEWORKS,
  TRUSTED_REVIEWER_FRAMEWORKS,
  resolveActiveReviewerFrameworks,
  isTrustedReviewerFramework,
} from '../../src/core/crossModelReviewer.js';
import { CapabilityFlag } from '../../src/providers/capabilities.js';

const STUB_GROK = '/bin/echo';

describe('registerGrokBuildAdapters — the dark-ship gate', () => {
  it('DARK DEFAULT: unset enabledFrameworks registers nothing', async () => {
    const reg = new Registry();
    const result = await registerGrokBuildAdapters({ registryInstance: reg, grokPath: STUB_GROK });
    expect(result.skippedReason).toBe('grok-not-enabled');
    expect(result.registered).toHaveLength(0);
    expect(reg.get('grok-build' as never)).toBeUndefined();
  });

  it('DARK DEFAULT: enabledFrameworks without grok-build registers nothing', async () => {
    const reg = new Registry();
    const result = await registerGrokBuildAdapters({
      enabledFrameworks: ['claude-code', 'codex-cli', 'pi-cli'],
      grokPath: STUB_GROK,
      registryInstance: reg,
    });
    expect(result.skippedReason).toBe('grok-not-enabled');
  });

  it('OPT-IN: enabledFrameworks with grok-build + binary registers the adapter', async () => {
    const reg = new Registry();
    const result = await registerGrokBuildAdapters({
      enabledFrameworks: ['claude-code', 'grok-build'],
      grokPath: STUB_GROK,
      model: 'grok-4.6',
      registryInstance: reg,
    });
    expect(result.skippedReason).toBeUndefined();
    expect(result.registered.map(String)).toContain('grok-build');
    const adapter = reg.get('grok-build' as never);
    expect(adapter).toBeDefined();
    // Wiring integrity: every DECLARED capability resolves to a real impl.
    for (const cap of adapter!.capabilities) {
      expect(adapter!.primitive(cap)).toBeTruthy();
    }
    // The honest floor: one-shot declared; the unprobed ACP face is NOT.
    expect(adapter!.capabilities).toContain(CapabilityFlag.OneShotCompletion);
    expect(adapter!.capabilities).not.toContain(CapabilityFlag.AgenticSessionRpc);
  });

  it('BINARY GATE: enabled but explicitly-null binary skips visibly, never throws', async () => {
    const reg = new Registry();
    // grokPath null → falls to detection; on a host WITH grok installed the
    // gate legitimately passes. Accept either outcome, require coherence.
    const result = await registerGrokBuildAdapters({
      enabledFrameworks: ['grok-build'],
      grokPath: null,
      registryInstance: reg,
    });
    if (result.skippedReason) {
      expect(result.skippedReason).toBe('grok-binary-missing');
      expect(result.registered).toHaveLength(0);
    } else {
      expect(result.registered.map(String)).toContain('grok-build');
    }
  });

  it('IDEMPOTENT: re-registration reports alreadyRegistered, no duplicate', async () => {
    const reg = new Registry();
    await registerGrokBuildAdapters({
      enabledFrameworks: ['grok-build'],
      grokPath: STUB_GROK,
      registryInstance: reg,
    });
    const again = await registerGrokBuildAdapters({
      enabledFrameworks: ['grok-build'],
      grokPath: STUB_GROK,
      registryInstance: reg,
    });
    expect(again.alreadyRegistered.map(String)).toContain('grok-build');
    expect(again.registered).toHaveLength(0);
  });
});

describe('cross-model reviewer registry — grok as the THIRD family (spec §8)', () => {
  it('grok-build is in the supported registry, ordered after codex + gemini', () => {
    const ids = SUPPORTED_REVIEWER_FRAMEWORKS.map((f) => f.id);
    expect(ids).toContain('grok-build');
    expect(ids.indexOf('grok-build')).toBeGreaterThan(ids.indexOf('codex-cli'));
    expect(ids.indexOf('grok-build')).toBeGreaterThan(ids.indexOf('gemini-cli'));
  });

  it('grok-build is classified crossFamily (a genuinely independent model line)', () => {
    const grok = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'grok-build');
    expect(grok?.crossFamily).toBe(true);
  });

  it('grok-build is on the trusted first-party allowlist', () => {
    expect(TRUSTED_REVIEWER_FRAMEWORKS).toContain('grok-build');
    expect(isTrustedReviewerFramework('grok-build')).toBe(true);
  });

  it('grok-build is REGISTERED in the active list, but DETECTION is dark by default (round-6)', () => {
    // Registry membership is config-independent (classification); the
    // AVAILABILITY gate is detection, which requires the explicit
    // enabledFrameworks opt-in — absent list refuses with grok-not-enabled.
    const active = resolveActiveReviewerFrameworks(undefined).map((f) => f.id);
    expect(active).toContain('grok-build');
    const grok = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'grok-build')!;
    const detection = grok.detect({ grokPathDetected: '/bin/echo', env: { HOME: '/tmp' } });
    expect(detection).toMatchObject({ available: false, reason: 'grok-not-enabled' });
  });

  it('review degrades (never throws) when detection says unavailable', async () => {
    const grok = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'grok-build')!;
    const outcome = await grok.review({
      promptText: 'test prompt',
      detectionOverride: { available: false, reason: 'grok-not-authed' },
    } as never);
    expect(outcome.status).toBe('degraded');
    expect(outcome.framework).toBe('grok-build');
  });
});
