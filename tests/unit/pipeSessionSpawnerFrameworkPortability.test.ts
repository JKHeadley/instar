/**
 * Unit tests — PipeSessionSpawner provider-portability.
 *
 * Verifies the three classifier/summarizer/spawn paths route through
 * the shared IntelligenceProvider + buildHeadlessLaunch helper instead
 * of hardcoding `claude -p`. These are the v1.0.0 regression guards
 * that keep Codex agents working in pipe-mode after the refactor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyIntent, summarizeThreadHistory, PipeSessionSpawner } from '../../src/threadline/PipeSessionSpawner.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

class StubIntelligence implements IntelligenceProvider {
  public calls: { prompt: string; options?: IntelligenceOptions }[] = [];
  constructor(private readonly response: string) {}
  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    this.calls.push({ prompt, options });
    return this.response;
  }
}

describe('classifyIntent — provider portability', () => {
  it('returns pipe when IntelligenceProvider responds QUERY', async () => {
    const intel = new StubIntelligence('QUERY');
    const verdict = await classifyIntent('what is the status?', { intelligence: intel });
    expect(verdict).toBe('pipe');
    expect(intel.calls).toHaveLength(1);
    expect(intel.calls[0].prompt).toContain('<classify-input>');
  });

  it('returns interactive when IntelligenceProvider responds TASK', async () => {
    const intel = new StubIntelligence('TASK');
    const verdict = await classifyIntent('refactor the auth module', { intelligence: intel });
    expect(verdict).toBe('interactive');
  });

  it('fails closed to interactive when no IntelligenceProvider is supplied', async () => {
    // v1.0.0 portability: the legacy shell-exec to bare `claude` is
    // gone. With no provider, the safe verdict is interactive — never
    // skip a TASK by guessing it's a QUERY.
    const verdict = await classifyIntent('any message');
    expect(verdict).toBe('interactive');
  });

  it('fails closed to interactive when provider throws', async () => {
    const intel: IntelligenceProvider = {
      async evaluate() { throw new Error('provider boom'); },
    };
    const verdict = await classifyIntent('msg', { intelligence: intel });
    expect(verdict).toBe('interactive');
  });

  it('asks for fast tier with bounded maxTokens', async () => {
    const intel = new StubIntelligence('QUERY');
    await classifyIntent('msg', { intelligence: intel });
    expect(intel.calls[0].options?.model).toBe('fast');
    expect(intel.calls[0].options?.maxTokens).toBeLessThanOrEqual(16);
  });
});

describe('summarizeThreadHistory — provider portability', () => {
  it('returns trimmed provider response when given history', async () => {
    const intel = new StubIntelligence('  - point 1\n- point 2  ');
    const summary = await summarizeThreadHistory(['hello', 'world'], { intelligence: intel });
    expect(summary).toBe('- point 1\n- point 2');
    expect(intel.calls).toHaveLength(1);
  });

  it('returns unavailable placeholder when no provider given', async () => {
    const summary = await summarizeThreadHistory(['hello']);
    expect(summary).toContain('unavailable');
  });

  it('returns empty string for empty history regardless of provider', async () => {
    const intel = new StubIntelligence('should not be called');
    const summary = await summarizeThreadHistory([], { intelligence: intel });
    expect(summary).toBe('');
    expect(intel.calls).toHaveLength(0);
  });

  it('handles provider error gracefully', async () => {
    const intel: IntelligenceProvider = {
      async evaluate() { throw new Error('summarize boom'); },
    };
    const summary = await summarizeThreadHistory(['hello'], { intelligence: intel });
    expect(summary).toContain('unavailable');
  });
});

describe('PipeSessionSpawner — framework-aware spawn config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-test-pipe-fw-'));
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tmp'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/pipeSessionSpawnerFrameworkPortability.test.ts' });
  });

  it('accepts framework=codex-cli + custom binaryPath in constructor', () => {
    const spawner = new PipeSessionSpawner({
      stateDir: tmpDir,
      framework: 'codex-cli',
      binaryPath: '/usr/local/bin/codex',
    });
    // Smoke check — eligibility logic still works (the framework field
    // doesn't break the rest of the spawner's surface).
    const result = spawner.shouldUsePipeMode({
      threadId: 't1',
      messageText: 'hi',
      fromFingerprint: 'abc',
      fromName: 'peer',
      trustLevel: 'trusted',
      iqsBand: 80,
    });
    expect(result.eligible).toBe(true);
  });

  it('defaults framework to claude-code when constructor field omitted', () => {
    const spawner = new PipeSessionSpawner({ stateDir: tmpDir });
    const metrics = spawner.getMetrics();
    // No way to introspect framework without spawning; this test is a
    // smoke check that the default branch doesn't throw at construction.
    expect(metrics.active).toBe(0);
  });
});
