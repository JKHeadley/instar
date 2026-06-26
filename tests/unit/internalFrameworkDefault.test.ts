/**
 * Unit tests for the provider-fallback DEFAULT POLICY resolver + the named
 * preference constant (docs/specs/provider-fallback-default-policy.md §4.1–4.2, §7).
 *
 * Pure resolver: chain × active-sets → correct categories (sentinel/gate/reflector
 * ONLY — never `job`/`other`) + ordered failureSwap tail; claude-only → no-op;
 * codex-missing → primary=pi (not claude); empty → no-op. The constant is validated
 * against the real IntelligenceFramework enum so an unknown name never ships.
 */

import { describe, it, expect } from 'vitest';
import {
  INTERNAL_FRAMEWORK_PREFERENCE,
  LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE,
  resolveInternalFrameworkDefault,
} from '../../src/core/internalFrameworkDefault.js';
import {
  buildIntelligenceProvider,
  type IntelligenceFramework,
} from '../../src/core/intelligenceProviderFactory.js';

// The full set of frameworks the factory recognizes — derived from the exhaustive
// switch in intelligenceProviderFactory. The constant must be a subset of THIS.
const KNOWN_FRAMEWORKS: readonly IntelligenceFramework[] = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'pi-cli',
];

describe('INTERNAL_FRAMEWORK_PREFERENCE (named constant)', () => {
  it('is exactly the directed chain codex → pi → gemini → claude (claude last)', () => {
    expect(INTERNAL_FRAMEWORK_PREFERENCE).toEqual([
      'codex-cli',
      'pi-cli',
      'gemini-cli',
      'claude-code',
    ]);
    // claude-code is the TAIL — the true last resort.
    expect(INTERNAL_FRAMEWORK_PREFERENCE[INTERNAL_FRAMEWORK_PREFERENCE.length - 1]).toBe('claude-code');
  });

  it('every entry is a real IntelligenceFramework enum value (build-time validity)', () => {
    for (const fw of INTERNAL_FRAMEWORK_PREFERENCE) {
      expect(KNOWN_FRAMEWORKS).toContain(fw);
      // It must also be a framework the factory's switch handles (no throw on an
      // unknown name; buildIntelligenceProvider returns null when a binary is absent,
      // but it never throws for a KNOWN framework name).
      expect(() => buildIntelligenceProvider({ framework: fw, binaryPath: undefined })).not.toThrow();
    }
  });

  it('has no duplicates', () => {
    expect(new Set(INTERNAL_FRAMEWORK_PREFERENCE).size).toBe(INTERNAL_FRAMEWORK_PREFERENCE.length);
  });
});

describe('resolveInternalFrameworkDefault — category computation', () => {
  it('all active: sentinel/reflector=codex (load-spread), gate=pi (FASTEST), failureSwap=[pi,gemini,claude]', () => {
    const cfg = resolveInternalFrameworkDefault(['codex-cli', 'pi-cli', 'gemini-cli', 'claude-code']);
    expect(cfg.categories).toEqual({
      sentinel: 'codex-cli',
      gate: 'pi-cli', // latency-sensitive → fastest off-Claude, NOT codex-first
      reflector: 'codex-cli',
    });
    // M3 regression guard: `job` (and `other`) are NEVER in the computed categories.
    expect(cfg.categories).not.toHaveProperty('job');
    expect(cfg.categories).not.toHaveProperty('other');
    expect(cfg.failureSwap).toEqual(['pi-cli', 'gemini-cli', 'claude-code']);
    expect(cfg.fallback).toBe('default');
  });

  it('codex MISSING → primary=pi (NOT claude), tail keeps order', () => {
    // pi+gemini+claude active, codex absent — the §3.2 "real work" case.
    const cfg = resolveInternalFrameworkDefault(['pi-cli', 'gemini-cli', 'claude-code']);
    expect(cfg.categories).toEqual({
      sentinel: 'pi-cli',
      gate: 'pi-cli',
      reflector: 'pi-cli',
    });
    expect(cfg.failureSwap).toEqual(['gemini-cli', 'claude-code']);
  });

  it('codex + claude only → primary=codex, tail=[claude]', () => {
    const cfg = resolveInternalFrameworkDefault(['codex-cli', 'claude-code']);
    expect(cfg.categories?.sentinel).toBe('codex-cli');
    expect(cfg.failureSwap).toEqual(['claude-code']);
  });

  it('gemini only (no codex/pi) → primary=gemini, tail=[claude] when claude also active', () => {
    const cfg = resolveInternalFrameworkDefault(['gemini-cli', 'claude-code']);
    expect(cfg.categories?.sentinel).toBe('gemini-cli');
    expect(cfg.failureSwap).toEqual(['claude-code']);
  });

  it('claude-only → NO-OP (no category routing, empty swap) — byte-identical to today', () => {
    const cfg = resolveInternalFrameworkDefault(['claude-code']);
    expect(cfg.categories).toBeUndefined();
    expect(cfg.failureSwap).toEqual([]);
    expect(cfg.fallback).toBe('default');
  });

  it('empty active-set → NO-OP', () => {
    const cfg = resolveInternalFrameworkDefault([]);
    expect(cfg.categories).toBeUndefined();
    expect(cfg.failureSwap).toEqual([]);
  });

  it('single off-Claude provider active (no claude) → primary set, empty swap', () => {
    // e.g. a codex-only agent whose default framework IS codex-cli — claude never
    // appears in the active set. Primary=codex, no tail.
    const cfg = resolveInternalFrameworkDefault(['codex-cli']);
    expect(cfg.categories?.sentinel).toBe('codex-cli');
    // gate diverges to the fastest active — here only codex is active, so gate===codex.
    expect(cfg.categories?.gate).toBe('codex-cli');
    expect(cfg.failureSwap).toEqual([]);
  });
});

describe('LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE (the gate-only fast order)', () => {
  it('is exactly fastest→slowest: pi → gemini → codex → claude (claude last)', () => {
    expect(LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE).toEqual([
      'pi-cli',
      'gemini-cli',
      'codex-cli',
      'claude-code',
    ]);
    expect(LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE[LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE.length - 1]).toBe('claude-code');
  });

  it('every entry is a real IntelligenceFramework enum value', () => {
    for (const fw of LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE) {
      expect(KNOWN_FRAMEWORKS).toContain(fw);
    }
  });

  it('has no duplicates and is a permutation of the general preference chain', () => {
    expect(new Set(LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE).size).toBe(LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE.length);
    expect([...LATENCY_SENSITIVE_FRAMEWORK_PREFERENCE].sort()).toEqual([...INTERNAL_FRAMEWORK_PREFERENCE].sort());
  });
});

describe('resolveInternalFrameworkDefault — the gate is latency-sensitive (the F5/Phase-A fix)', () => {
  it('gate prefers the FASTEST off-Claude framework while sentinels keep codex-first', () => {
    // The exact production case: all four active. Background categories spread load
    // onto codex (slow but fine — no human waits); the user-facing gate goes to pi
    // (fastest) so it never times out the 20s outbound-review budget.
    const cfg = resolveInternalFrameworkDefault(['codex-cli', 'pi-cli', 'gemini-cli', 'claude-code']);
    expect(cfg.categories?.gate).toBe('pi-cli');
    expect(cfg.categories?.sentinel).toBe('codex-cli');
    expect(cfg.categories?.reflector).toBe('codex-cli');
    // The gate's primary is NOT the slow codex (the 2026-06-25 timeout class).
    expect(cfg.categories?.gate).not.toBe('codex-cli');
  });

  it('pi DOWN, gemini up → gate falls to gemini (the next-fastest), not codex (task-2 case)', () => {
    // pi unavailable at boot; codex + gemini + claude active. The gate must pick the
    // fastest REMAINING off-Claude framework — gemini — and gemini is in failureSwap.
    const cfg = resolveInternalFrameworkDefault(['codex-cli', 'gemini-cli', 'claude-code']);
    expect(cfg.categories?.gate).toBe('gemini-cli'); // fastest active, NOT codex
    expect(cfg.categories?.sentinel).toBe('codex-cli'); // background keeps codex-first
    // gemini is reachable as a fallback for the gate's primary too.
    expect(cfg.failureSwap).toContain('gemini-cli');
  });

  it('pi AND gemini both down → gate falls to codex (only off-Claude left), never worse than today', () => {
    const cfg = resolveInternalFrameworkDefault(['codex-cli', 'claude-code']);
    expect(cfg.categories?.gate).toBe('codex-cli'); // identical to sentinel — no divergence possible
    expect(cfg.categories?.sentinel).toBe('codex-cli');
  });

  it('only one off-Claude framework active → gate === sentinel (byte-identical no-op)', () => {
    const cfg = resolveInternalFrameworkDefault(['gemini-cli', 'claude-code']);
    expect(cfg.categories?.gate).toBe('gemini-cli');
    expect(cfg.categories?.gate).toBe(cfg.categories?.sentinel);
  });
});
