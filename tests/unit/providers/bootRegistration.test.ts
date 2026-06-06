/**
 * Unit tests for src/providers/bootRegistration.ts — the production
 * registration of the Anthropic adapters (the deferred Phase-5 "separate
 * cycle"). Covers both sides of every gate, idempotency, the no-eager-spawn
 * guarantee, and the TTL-cached SDK-credit reader.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => ''),
    execFile: vi.fn(),
  };
});

import { execFileSync } from 'node:child_process';
import {
  registerAnthropicAdapters,
  buildReadSdkCredit,
} from '../../../src/providers/bootRegistration.js';
import { Registry, type ProviderAdapter } from '../../../src/providers/registry.js';
import { CapabilityFlag } from '../../../src/providers/capabilities.js';
import {
  setClaudeForbidden,
  clearClaudeForbidden,
} from '../../../src/core/claudeForbiddenGuard.js';
import type { AgentSdkCreditSnapshot } from '../../../src/providers/primitives/observability/usageMeterProvider.js';

afterEach(() => {
  clearClaudeForbidden();
  vi.mocked(execFileSync).mockClear();
});

describe('registerAnthropicAdapters — gates', () => {
  it('skips entirely when Claude is process-forbidden (codex-only agent)', async () => {
    setClaudeForbidden("enabledFrameworks=['codex-cli'], no claude-code");
    const reg = new Registry();
    const result = await registerAnthropicAdapters({ registryInstance: reg });
    expect(result.skippedReason).toBe('claude-forbidden');
    expect(result.registered).toEqual([]);
    expect(reg.list()).toEqual([]);
    expect(await result.readSdkCredit()).toBeNull();
  });

  it('skips when enabledFrameworks excludes claude-code', async () => {
    const reg = new Registry();
    const result = await registerAnthropicAdapters({
      registryInstance: reg,
      enabledFrameworks: ['codex-cli'],
    });
    expect(result.skippedReason).toBe('claude-code-not-enabled');
    expect(reg.list()).toEqual([]);
  });

  it('registers both adapters when claude-code is enabled', async () => {
    const reg = new Registry();
    const result = await registerAnthropicAdapters({
      registryInstance: reg,
      enabledFrameworks: ['claude-code', 'codex-cli'],
    });
    expect(result.skippedReason).toBeUndefined();
    expect(result.registered.sort()).toEqual([
      'anthropic-headless',
      'anthropic-interactive-pool',
    ]);
    expect(reg.list().sort()).toEqual(['anthropic-headless', 'anthropic-interactive-pool']);
    expect(result.headless).toBeDefined();
    expect(result.pool).toBeDefined();
  });

  it('treats unset/empty enabledFrameworks as the historical claude-code default', async () => {
    const regA = new Registry();
    const a = await registerAnthropicAdapters({ registryInstance: regA });
    expect(a.registered).toHaveLength(2);

    const regB = new Registry();
    const b = await registerAnthropicAdapters({ registryInstance: regB, enabledFrameworks: [] });
    expect(b.registered).toHaveLength(2);
  });
});

describe('registerAnthropicAdapters — idempotency + laziness', () => {
  it('is idempotent: a second call registers nothing and reports alreadyRegistered', async () => {
    const reg = new Registry();
    await registerAnthropicAdapters({ registryInstance: reg });
    const second = await registerAnthropicAdapters({ registryInstance: reg });
    expect(second.registered).toEqual([]);
    expect(second.alreadyRegistered.sort()).toEqual([
      'anthropic-headless',
      'anthropic-interactive-pool',
    ]);
    expect(reg.list()).toHaveLength(2);
    // The already-registered adapters are still returned for wiring.
    expect(second.headless).toBeDefined();
    expect(second.pool).toBeDefined();
  });

  it('is idempotent under CONCURRENT calls (single-flight, no duplicate-register throw)', async () => {
    const reg = new Registry();
    const [a, b] = await Promise.all([
      registerAnthropicAdapters({ registryInstance: reg }),
      registerAnthropicAdapters({ registryInstance: reg }),
    ]);
    // Both callers share one registration run — same result, no throw.
    expect(reg.list()).toHaveLength(2);
    expect(a.registered).toEqual(b.registered);
    expect(a.skippedReason).toBeUndefined();
    expect(b.skippedReason).toBeUndefined();
  });

  it('spawns NOTHING at registration time (lazy pool — boot must stay cheap)', async () => {
    const reg = new Registry();
    await registerAnthropicAdapters({ registryInstance: reg });
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('passes claudePath/tmuxPath and pool overrides through to the adapters', async () => {
    const reg = new Registry();
    const result = await registerAnthropicAdapters({
      registryInstance: reg,
      claudePath: '/custom/claude',
      tmuxPath: '/custom/tmux',
      pool: { poolSize: 1, model: 'haiku' },
    });
    // The pool adapter exposes its pool; its config is private, so assert
    // via the spawn argv when a session would spawn — covered by the pool
    // model-flag tests. Here we assert the adapter constructed cleanly.
    expect(result.pool?.id).toBe('anthropic-interactive-pool');
  });
});

function fakeAdapterWithMeter(read: () => Promise<unknown>): ProviderAdapter {
  return {
    id: 'anthropic-headless' as ProviderAdapter['id'],
    capabilities: { transport: [], capability: [], observability: [], control: [], integration: [] } as unknown as ProviderAdapter['capabilities'],
    primitive(cap: CapabilityFlag): unknown {
      if (cap === CapabilityFlag.UsageMeterProvider) {
        return { capability: CapabilityFlag.UsageMeterProvider, isAuthoritative: () => true, read };
      }
      throw new Error(`unexpected capability ${cap}`);
    },
  };
}

const SNAPSHOT: AgentSdkCreditSnapshot = {
  remainingUsd: 150,
  totalUsd: 200,
  resetsAt: '2026-07-01T00:00:00Z',
  overageEnabled: false,
};

describe('buildReadSdkCredit', () => {
  it('returns the agentSdkCredit snapshot from the usage meter', async () => {
    const adapter = fakeAdapterWithMeter(async () => ({
      capturedAt: 'now',
      source: 'authoritative',
      windows: [],
      agentSdkCredit: SNAPSHOT,
    }));
    const read = buildReadSdkCredit(adapter);
    expect(await read()).toEqual(SNAPSHOT);
  });

  it('returns null when the meter omits agentSdkCredit (state unknown)', async () => {
    const adapter = fakeAdapterWithMeter(async () => ({
      capturedAt: 'now',
      source: 'authoritative',
      windows: [],
      agentSdkCredit: null,
    }));
    expect(await buildReadSdkCredit(adapter)()).toBeNull();
  });

  it('returns null instead of throwing when the meter read fails', async () => {
    const adapter = fakeAdapterWithMeter(async () => {
      throw new Error('401 from usage API');
    });
    expect(await buildReadSdkCredit(adapter)()).toBeNull();
  });

  it('caches within the TTL — at most one meter read per window', async () => {
    const read = vi.fn(async () => ({
      capturedAt: 'now',
      source: 'authoritative' as const,
      windows: [],
      agentSdkCredit: SNAPSHOT,
    }));
    const reader = buildReadSdkCredit(fakeAdapterWithMeter(read), 60_000);
    await reader();
    await reader();
    await reader();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => ({
        capturedAt: 'now',
        source: 'authoritative' as const,
        windows: [],
        agentSdkCredit: SNAPSHOT,
      }));
      const reader = buildReadSdkCredit(fakeAdapterWithMeter(read), 1_000);
      await reader();
      vi.advanceTimersByTime(1_500);
      await reader();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
