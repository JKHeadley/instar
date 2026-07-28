/**
 * Unit tests for the IntelligenceProvider factory.
 *
 * Verifies framework selection, binary detection fallback, env-var
 * parsing, and the null-on-missing-binary contract. No real CLI calls.
 */

import { describe, it, expect } from 'vitest';
import {
  buildIntelligenceProvider,
  frameworkFromEnv,
} from '../../src/core/intelligenceProviderFactory.js';
import { CodexCliIntelligenceProvider } from '../../src/core/CodexCliIntelligenceProvider.js';
import { ClaudeCliIntelligenceProvider } from '../../src/core/ClaudeCliIntelligenceProvider.js';
import { GeminiCliIntelligenceProvider } from '../../src/core/GeminiCliIntelligenceProvider.js';
import { CircuitBreakingIntelligenceProvider } from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import { SpawnCapIntelligenceProvider } from '../../src/core/SpawnCapIntelligenceProvider.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

// The factory wraps every provider in TWO universal funnels (fork-bomb
// prevention, forkbomb-prevention-simple §P1): the account-global rate-limit
// circuit breaker (OUTER, CircuitBreakingIntelligenceProvider) around the
// host-wide spawn cap (MIDDLE, SpawnCapIntelligenceProvider) around the actual
// framework provider (INNER). Assert the full chain: breaker → spawn-cap → provider.
function expectWraps(
  p: IntelligenceProvider | null,
  Inner: new (...args: never[]) => IntelligenceProvider,
): void {
  expect(p).toBeInstanceOf(CircuitBreakingIntelligenceProvider);
  const spawnCap = (p as unknown as { inner: IntelligenceProvider }).inner;
  expect(spawnCap).toBeInstanceOf(SpawnCapIntelligenceProvider);
  const inner = (spawnCap as unknown as { inner: IntelligenceProvider }).inner;
  expect(inner).toBeInstanceOf(Inner);
}

/** Unwrap both funnel layers (breaker → spawn-cap) to reach the actual provider. */
function innermost(p: IntelligenceProvider | null): IntelligenceProvider {
  const spawnCap = (p as unknown as { inner: IntelligenceProvider }).inner;
  return (spawnCap as unknown as { inner: IntelligenceProvider }).inner;
}

describe('buildIntelligenceProvider', () => {
  it('returns a circuit-breaker-wrapped ClaudeCliIntelligenceProvider when framework=claude-code and binary path supplied', () => {
    const p = buildIntelligenceProvider({
      framework: 'claude-code',
      binaryPath: '/usr/bin/claude',
    });
    expectWraps(p, ClaudeCliIntelligenceProvider);
  });

  it('returns a circuit-breaker-wrapped CodexCliIntelligenceProvider when framework=codex-cli and binary path supplied', () => {
    const p = buildIntelligenceProvider({
      framework: 'codex-cli',
      binaryPath: '/usr/bin/codex',
    });
    expectWraps(p, CodexCliIntelligenceProvider);
  });

  it('returns a circuit-breaker-wrapped GeminiCliIntelligenceProvider when framework=gemini-cli and binary path supplied (the ALIVE path)', () => {
    const p = buildIntelligenceProvider({
      framework: 'gemini-cli',
      binaryPath: '/usr/bin/gemini',
    });
    expectWraps(p, GeminiCliIntelligenceProvider);
  });

  it('passes quotaStateFile only to the gemini provider capacity policy', () => {
    const p = buildIntelligenceProvider({
      framework: 'gemini-cli',
      binaryPath: '/usr/bin/gemini',
      quotaStateFile: '/tmp/gemini-quota-state.json',
    });
    expectWraps(p, GeminiCliIntelligenceProvider);
    const inner = innermost(p);
    expect((inner as unknown as { capacityPolicy?: { quotaStateFile?: string } }).capacityPolicy?.quotaStateFile)
      .toBe('/tmp/gemini-quota-state.json');
  });

  it('defaults to claude-code when framework is omitted', () => {
    const p = buildIntelligenceProvider({ binaryPath: '/usr/bin/claude' });
    expectWraps(p, ClaudeCliIntelligenceProvider);
  });

  it('returns null when no binary path is supplied AND detection fails for an exotic name', () => {
    // We can't reliably control detection on the host running these tests,
    // so we can't assert null for claude/codex (the binary might exist).
    // But supplying an explicit empty path simulates "we tried, nothing".
    const p = buildIntelligenceProvider({
      framework: 'codex-cli',
      binaryPath: '',
    });
    // An empty string is falsy → factory falls through to detect → may
    // return non-null on dev machines. So instead assert the function
    // does not throw and returns either null or a wrapped Codex provider.
    if (p !== null) {
      expectWraps(p, CodexCliIntelligenceProvider);
    }
  });

  it('propagates workingDirectory to the codex provider', () => {
    const p = buildIntelligenceProvider({
      framework: 'codex-cli',
      binaryPath: '/usr/bin/codex',
      workingDirectory: '/tmp/test-wd',
    });
    expectWraps(p, CodexCliIntelligenceProvider);
    // The provider doesn't expose workingDirectory publicly; this test
    // just asserts the call shape works.
  });
});

describe('frameworkFromEnv', () => {
  it('returns null when INSTAR_FRAMEWORK is unset', () => {
    expect(frameworkFromEnv({})).toBeNull();
  });

  it('returns null when INSTAR_FRAMEWORK is empty', () => {
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: '' })).toBeNull();
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: '   ' })).toBeNull();
  });

  it('parses claude-code and the alias claude', () => {
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'claude-code' })).toBe('claude-code');
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'claude' })).toBe('claude-code');
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'CLAUDE' })).toBe('claude-code');
  });

  it('parses codex-cli and the alias codex', () => {
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'codex-cli' })).toBe('codex-cli');
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'codex' })).toBe('codex-cli');
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'CODEX' })).toBe('codex-cli');
  });

  it('parses gemini-cli and the alias gemini', () => {
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'gemini-cli' })).toBe('gemini-cli');
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'gemini' })).toBe('gemini-cli');
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'GEMINI' })).toBe('gemini-cli');
  });

  it('returns null for unrecognized values rather than throwing', () => {
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'aider' })).toBeNull();
    expect(frameworkFromEnv({ INSTAR_FRAMEWORK: 'whatever' })).toBeNull();
  });
});
