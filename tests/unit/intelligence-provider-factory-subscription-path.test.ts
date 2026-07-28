/**
 * Unit tests for the factory's subscriptionPath option — the funnel half of
 * the June-15 interactive-only wiring (spec 04 Rule 1).
 *
 * The load-bearing invariant (truth T4 of the live-wiring spec): with NO
 * subscriptionPath option, the claude-code path is byte-for-byte today's
 * behavior — the exact `claude -p` argv, unchanged. With mode 'force', a
 * call is served by the pool and `claude` is NEVER exec'd.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        _path: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, JSON.stringify({ result: 'headless ok', usage: { input_tokens: 5, output_tokens: 2 } }), '');
        return { stdin: { end: () => {} } } as unknown as ReturnType<typeof actual.execFile>;
      },
    ),
    execFileSync: vi.fn(() => ''),
  };
});

import { execFile } from 'node:child_process';
import { buildIntelligenceProvider } from '../../src/core/intelligenceProviderFactory.js';
import { CapabilityFlag } from '../../src/providers/capabilities.js';
import type { ProviderAdapter } from '../../src/providers/registry.js';

function fakePoolAdapter(text: string): ProviderAdapter {
  return {
    id: 'anthropic-interactive-pool' as ProviderAdapter['id'],
    capabilities: {} as ProviderAdapter['capabilities'],
    primitive(cap: CapabilityFlag): unknown {
      if (cap === CapabilityFlag.OneShotCompletion) {
        return {
          capability: CapabilityFlag.OneShotCompletion,
          evaluate: async () => ({ text, usage: null }),
        };
      }
      throw new Error(`unexpected capability ${cap}`);
    },
  };
}

beforeEach(() => {
  vi.mocked(execFile).mockClear();
});

describe('buildIntelligenceProvider — subscriptionPath option', () => {
  it('WITHOUT the option: claude -p argv is byte-for-byte unchanged (T4)', async () => {
    const provider = buildIntelligenceProvider({
      framework: 'claude-code',
      binaryPath: '/fake/claude',
    });
    expect(provider).not.toBeNull();
    const out = await provider!.evaluate('judge this', { model: 'fast' });
    expect(out).toBe('headless ok');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    const [binary, args] = vi.mocked(execFile).mock.calls[0]! as unknown as [string, string[]];
    expect(binary).toBe('/fake/claude');
    // The exact argv today's fleet runs — any drift here is a silent
    // behavior change for every sentinel/gate on every agent.
    expect(args).toEqual([
      '-p', 'judge this',
      '--model', 'haiku',
      '--max-turns', '1',
      '--output-format', 'json',
      '--setting-sources', 'user',
    ]);
  });

  it("mode 'force': served by the pool, claude is NEVER exec'd", async () => {
    const provider = buildIntelligenceProvider({
      framework: 'claude-code',
      binaryPath: '/fake/claude',
      subscriptionPath: {
        mode: 'force',
        poolAdapter: fakePoolAdapter('pool served this'),
        readSdkCredit: async () => null,
      },
    });
    expect(provider).not.toBeNull();
    const out = await provider!.evaluate('judge this');
    expect(out).toBe('pool served this');
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it("mode 'auto' with unknown credit: served by the pool (subscription floor)", async () => {
    const provider = buildIntelligenceProvider({
      framework: 'claude-code',
      binaryPath: '/fake/claude',
      subscriptionPath: {
        mode: 'auto',
        poolAdapter: fakePoolAdapter('floor'),
        readSdkCredit: async () => null,
      },
    });
    expect(await provider!.evaluate('x')).toBe('floor');
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it("mode 'auto' with healthy credit: served by claude -p (drain the pot first)", async () => {
    const provider = buildIntelligenceProvider({
      framework: 'claude-code',
      binaryPath: '/fake/claude',
      subscriptionPath: {
        mode: 'auto',
        poolAdapter: fakePoolAdapter('pool'),
        readSdkCredit: async () => ({
          remainingUsd: 180,
          totalUsd: 200,
          resetsAt: '2026-07-01T00:00:00Z',
          overageEnabled: false,
        }),
      },
    });
    expect(await provider!.evaluate('x')).toBe('headless ok');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  it('non-claude frameworks ignore the option (codex unaffected)', () => {
    const provider = buildIntelligenceProvider({
      framework: 'codex-cli',
      binaryPath: '/fake/codex',
      subscriptionPath: {
        mode: 'force',
        poolAdapter: fakePoolAdapter('pool'),
        readSdkCredit: async () => null,
      },
    });
    // Codex provider builds normally; the Anthropic-only option is unused.
    expect(provider).not.toBeNull();
  });
});
