/**
 * Integration — the LLM rate-limit circuit breaker at the construction
 * chokepoint.
 *
 * Proves the end-to-end wiring the unit tests can't: that providers built by
 * the real `buildIntelligenceProvider` factory are circuit-breaker-wrapped, and
 * that the breaker is ACCOUNT-GLOBAL — a rate-limit hit through ONE
 * factory-built provider stops a SECOND, independently-built provider from
 * spawning the underlying `claude -p` subprocess at all.
 *
 * The fake "claude" binary increments an on-disk counter on every spawn, so we
 * can assert — with real subprocess execution — that an open breaker yields
 * ZERO additional spawns. This is the property that actually stops the credit
 * bleed described in the 2026-05-28 wild-agent incident.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIntelligenceProvider } from '../../src/core/intelligenceProviderFactory.js';
import { CircuitBreakingIntelligenceProvider } from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import { LlmCircuitOpenError, RateLimitError, __resetLlmCircuitBreakerSingleton } from '../../src/core/LlmCircuitBreaker.js';
import { clearClaudeForbidden } from '../../src/core/claudeForbiddenGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let fakeClaude: string;
let spawnCounter: string;

function spawnCount(): number {
  try {
    return fs.readFileSync(spawnCounter, 'utf8').length; // one char per spawn
  } catch {
    return 0;
  }
}

beforeAll(() => {
  clearClaudeForbidden();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cb-chokepoint-'));
  spawnCounter = path.join(tmpDir, 'spawns');
  fakeClaude = path.join(tmpDir, 'fake-claude');
  // Records each spawn, then exits non-zero with a usage-limit message on stderr.
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh\nprintf 'x' >> "${spawnCounter}"\necho "Claude AI usage limit reached. Your limit will reset later." >&2\nexit 1\n`,
    { mode: 0o755 },
  );
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/llm-circuit-breaker-chokepoint.test.ts:afterAll',
  });
});

beforeEach(() => {
  __resetLlmCircuitBreakerSingleton();
  SafeFsExecutor.safeRmSync(spawnCounter, {
    force: true,
    operation: 'tests/integration/llm-circuit-breaker-chokepoint.test.ts:beforeEach',
  });
});

describe('LLM circuit breaker — construction chokepoint wiring', () => {
  it('the factory returns a circuit-breaker-wrapped provider', () => {
    const provider = buildIntelligenceProvider({ framework: 'claude-code', binaryPath: fakeClaude });
    expect(provider).toBeInstanceOf(CircuitBreakingIntelligenceProvider);
  });

  it('a rate-limit through one factory provider opens the shared breaker and stops a SECOND provider from spawning', async () => {
    const provider1 = buildIntelligenceProvider({ framework: 'claude-code', binaryPath: fakeClaude })!;
    const provider2 = buildIntelligenceProvider({ framework: 'claude-code', binaryPath: fakeClaude })!;

    // First real call spawns the fake binary, hits the usage limit, trips the breaker.
    await expect(provider1.evaluate('classify this')).rejects.toBeInstanceOf(RateLimitError);
    expect(spawnCount()).toBe(1);

    // The SECOND, independently-built provider now short-circuits — no spawn.
    await expect(provider2.evaluate('classify that')).rejects.toBeInstanceOf(LlmCircuitOpenError);
    expect(spawnCount()).toBe(1); // still 1 — the breaker is account-global

    // And the original provider also short-circuits on repeat — the bleed is stopped.
    for (let i = 0; i < 4; i++) {
      await expect(provider1.evaluate('again')).rejects.toBeInstanceOf(LlmCircuitOpenError);
    }
    expect(spawnCount()).toBe(1);
  });
});
