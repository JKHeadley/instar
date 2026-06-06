/**
 * Unit tests for the pool `model` config knob.
 *
 * The interactive pool runs ONE model per pool (set at spawn via
 * `--model`). The intelligence funnel sets this to a small model so
 * high-volume judgment calls don't draw the subscription's large-model
 * quota. These tests assert the spawn argv both ways without touching
 * real tmux/claude binaries (execFileSync is mocked at the module level).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
    execFile: vi.fn(),
  };
});

import { execFileSync } from 'node:child_process';
import { InteractivePool } from '../../../../../src/providers/adapters/anthropic-interactive-pool/pool.js';
import { configFromEnv } from '../../../../../src/providers/adapters/anthropic-interactive-pool/config.js';

function spawnArgsFor(model?: string): string[] {
  const cfg = { ...configFromEnv({}), poolSize: 1, ...(model ? { model } : {}) };
  const pool = new InteractivePool(cfg);
  // Skip the readiness poll and the startup canary — argv construction is
  // the unit under test, not session lifecycle.
  (pool as unknown as { waitForReady: () => Promise<boolean> }).waitForReady = async () => true;
  (pool as unknown as { canaryHasRunInCurrentLifetime: boolean }).canaryHasRunInCurrentLifetime =
    true;
  return (pool as unknown as { spawnOne: () => Promise<void> })
    .spawnOne()
    .then(() => {
      const calls = vi.mocked(execFileSync).mock.calls;
      // First call is the `tmux new-session` spawn.
      return calls[0]![1] as string[];
    }) as unknown as string[];
}

describe('InteractivePool — model flag at spawn', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
  });

  it('appends --model <m> to the claude argv when config.model is set', async () => {
    const args = await spawnArgsFor('haiku');
    const claudeIdx = args.indexOf('--dangerously-skip-permissions');
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(args[claudeIdx + 1]).toBe('--model');
    expect(args[claudeIdx + 2]).toBe('haiku');
  });

  it('omits --model entirely when config.model is unset (today\'s argv unchanged)', async () => {
    const args = await spawnArgsFor(undefined);
    expect(args).not.toContain('--model');
    // The claude binary + skip-permissions flag remain the argv tail.
    expect(args[args.length - 1]).toBe('--dangerously-skip-permissions');
  });

  it('configFromEnv picks up INTERACTIVE_POOL_MODEL', async () => {
    const { configFromEnv: fresh } = await import(
      '../../../../../src/providers/adapters/anthropic-interactive-pool/config.js'
    );
    expect(fresh({ INTERACTIVE_POOL_MODEL: 'haiku' } as NodeJS.ProcessEnv).model).toBe('haiku');
    expect(fresh({} as NodeJS.ProcessEnv).model).toBeUndefined();
  });
});
