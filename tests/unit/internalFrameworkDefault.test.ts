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
  it('all active: primary=codex, failureSwap=[pi,gemini,claude], categories only sentinel/gate/reflector', () => {
    const cfg = resolveInternalFrameworkDefault(['codex-cli', 'pi-cli', 'gemini-cli', 'claude-code']);
    expect(cfg.categories).toEqual({
      sentinel: 'codex-cli',
      gate: 'codex-cli',
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
    expect(cfg.failureSwap).toEqual([]);
  });
});
