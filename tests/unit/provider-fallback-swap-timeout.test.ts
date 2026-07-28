/**
 * Unit tests for the §4.5 bounded per-attempt swap timeout in IntelligenceRouter,
 * plus the §4.6 layered resolveConfig contract and the §4.4 boot-snapshot detection
 * (docs/specs/provider-fallback-default-policy.md §4.4–4.6, §7).
 *
 * Covers:
 *  - M1: a SLOW (never-erroring) swap target is abandoned at the cap; total ≤ cap×(1+tail).
 *  - N1: a swap target whose promise REJECTS *after* the cap fired does not crash
 *        (Promise.race form) and is not used.
 *  - timeoutMs passthrough: the per-attempt `timeoutMs` reaches the provider (= cap).
 *  - Q5: model-size/tier preserved across a swap.
 *  - M7: `{}` rollback → all-default, empty swap.
 *  - M5: the boot-snapshot is NOT fooled by an in-memory auto-vivify; the layered
 *        resolveConfig keeps the computed default while honoring a live override slot.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IntelligenceRouter,
  type ComponentFrameworksConfig,
} from '../../src/core/IntelligenceRouter.js';
import { resolveInternalFrameworkDefault } from '../../src/core/internalFrameworkDefault.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const GATING: IntelligenceOptions = { attribution: { component: 'ExternalOperationGate', gating: true } };

function throwingProvider(msg = 'down'): IntelligenceProvider {
  return { async evaluate() { throw new Error(msg); } };
}

/** A provider that NEVER resolves until released — to simulate a slow-but-not-erroring target. */
function slowProvider(): IntelligenceProvider & { sawTimeoutMs: number | undefined; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return {
    sawTimeoutMs: undefined,
    release,
    async evaluate(_p: string, opts?: IntelligenceOptions): Promise<string> {
      // record the per-call timeout the router passed through
      (this as { sawTimeoutMs?: number }).sawTimeoutMs = opts?.timeoutMs;
      await gate; // hang until released
      return 'slow';
    },
  };
}

describe('§4.5 bounded per-attempt swap timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('M1: a SLOW (never-erroring) target is abandoned at the cap and the loop advances', async () => {
    const slow = slowProvider();
    const fast = { calls: 0, async evaluate() { this.calls++; return 'pi'; } };
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider('claude rate-limited'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli', 'pi-cli'] }),
      buildProvider: (fw: IntelligenceFramework) =>
        fw === 'codex-cli' ? slow : fw === 'pi-cli' ? (fast as unknown as IntelligenceProvider) : null,
      swapAttemptTimeoutMs: 5000,
    });

    const p = router.evaluate('x', GATING);
    // advance past the cap so the slow codex attempt times out → advance to pi
    await vi.advanceTimersByTimeAsync(5001);
    const result = await p;

    expect(result).toBe('pi');
    expect(fast.calls).toBe(1);
    // the cap was passed THROUGH to the provider as its per-call timeoutMs.
    expect(slow.sawTimeoutMs).toBe(5000);
  });

  it('M1: total swap latency is bounded by cap × (1 + tail length), not the slow wait', async () => {
    // primary (pi-cli, throwing) fails; tail = codex(slow→abandoned), gemini(slow→abandoned),
    // claude-code(ok). Each slow attempt is abandoned at the 5s cap; total ≈ 2×5s, not 2×∞.
    // Routing the gate to pi-cli keeps claude-code a usable distinct tail (the
    // `target === framework` guard would otherwise skip the primary's own framework).
    // NOTE: in the router, the claude-code swap target resolves to the DEFAULT provider
    // (claude-code IS the default framework), so the default provider IS the claude tail.
    const slow1 = slowProvider();
    const slow2 = slowProvider();
    const router = new IntelligenceRouter({
      defaultProvider: { async evaluate() { return 'claude-tail'; } },
      defaultFramework: 'claude-code',
      resolveConfig: () => ({
        categories: { gate: 'pi-cli' },
        failureSwap: ['codex-cli', 'gemini-cli', 'claude-code'],
      }),
      buildProvider: (fw: IntelligenceFramework) =>
        fw === 'pi-cli'
          ? throwingProvider('pi primary down')
          : fw === 'codex-cli'
            ? slow1
            : fw === 'gemini-cli'
              ? slow2
              : null,
      swapAttemptTimeoutMs: 5000,
    });

    const p = router.evaluate('x', GATING);
    // codex abandoned at cap, then gemini abandoned at cap, then claude tail resolves.
    // Advance well past 2× the cap in one go so both abandonments fire and the loop
    // reaches the claude tail.
    await vi.advanceTimersByTimeAsync(10002);
    const result = await p;
    expect(result).toBe('claude-tail');
  });

  it('emits a distinct swap-attempt-timeout degrade reason when the cap fires', async () => {
    const slow = slowProvider();
    const ok = { async evaluate() { return 'pi'; } };
    const degrades: Array<{ reason: string; to: string }> = [];
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider(),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli', 'pi-cli'] }),
      buildProvider: (fw: IntelligenceFramework) =>
        fw === 'codex-cli' ? slow : fw === 'pi-cli' ? (ok as unknown as IntelligenceProvider) : null,
      swapAttemptTimeoutMs: 5000,
      onDegrade: (i) => degrades.push(i as { reason: string; to: string }),
    });
    const p = router.evaluate('x', GATING);
    await vi.advanceTimersByTimeAsync(5001);
    await p;
    // one timeout degrade (codex) + one success degrade (served by pi)
    expect(degrades.some((d) => d.reason.startsWith('swap-attempt-timeout:') && d.reason.includes('codex-cli'))).toBe(true);
    expect(degrades.some((d) => d.to === 'pi-cli' && d.reason.startsWith('failure-swap:'))).toBe(true);
  });
});

describe('§4.5 N1 orphaned-attempt safety (Promise.race — no crash)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a swap target that REJECTS after the cap fired does not crash and is not used', async () => {
    // codex hangs then rejects late; pi answers. The late rejection must be handled
    // by Promise.race (no unhandledRejection) and must not affect the result.
    let rejectCodex!: (e: Error) => void;
    const codexLateReject: IntelligenceProvider = {
      evaluate: () => new Promise<string>((_, rej) => { rejectCodex = rej; }),
    };
    const pi = { async evaluate() { return 'pi'; } };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const router = new IntelligenceRouter({
        defaultProvider: throwingProvider(),
        defaultFramework: 'claude-code',
        resolveConfig: () => ({ failureSwap: ['codex-cli', 'pi-cli'] }),
        buildProvider: (fw: IntelligenceFramework) =>
          fw === 'codex-cli' ? codexLateReject : fw === 'pi-cli' ? (pi as unknown as IntelligenceProvider) : null,
        swapAttemptTimeoutMs: 5000,
      });
      const p = router.evaluate('x', GATING);
      await vi.advanceTimersByTimeAsync(5001); // codex abandoned at cap → pi serves
      const result = await p;
      expect(result).toBe('pi');
      // NOW the abandoned codex attempt rejects late — must be swallowed by the race.
      rejectCodex(new Error('late codex failure'));
      await vi.advanceTimersByTimeAsync(0);
      // let any microtasks flush
      await Promise.resolve();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a swap target that RESOLVES after the cap must NOT be used (loop already advanced)', async () => {
    let resolveCodex!: (v: string) => void;
    const codexLate: IntelligenceProvider = {
      evaluate: () => new Promise<string>((res) => { resolveCodex = res; }),
    };
    const pi = { async evaluate() { return 'pi'; } };
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider(),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli', 'pi-cli'] }),
      buildProvider: (fw: IntelligenceFramework) =>
        fw === 'codex-cli' ? codexLate : fw === 'pi-cli' ? (pi as unknown as IntelligenceProvider) : null,
      swapAttemptTimeoutMs: 5000,
    });
    const p = router.evaluate('x', GATING);
    await vi.advanceTimersByTimeAsync(5001);
    // codex resolves LATE — must be ignored; pi's answer wins.
    resolveCodex('STALE-codex');
    const result = await p;
    expect(result).toBe('pi');
  });
});

describe('§4.5 Q5 model-tier preservation across swap', () => {
  it('a fast-tier gating call keeps model:"fast" on the swap target', async () => {
    let sawModel: string | undefined;
    const codex: IntelligenceProvider = {
      async evaluate(_p, opts) { sawModel = opts?.model; return 'codex'; },
    };
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider(),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli'] }),
      buildProvider: (fw) => (fw === 'codex-cli' ? codex : null),
      swapAttemptTimeoutMs: 5000,
    });
    const r = await router.evaluate('x', { ...GATING, model: 'fast' });
    expect(r).toBe('codex');
    expect(sawModel).toBe('fast'); // tier travels per-call, not silently upgraded
  });
});

describe('§4.5 cap dominates an internal rateLimitWaitMs', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a target internally waiting on rateLimitWaitMs is abandoned at the 5s cap', async () => {
    // simulate a provider that honors a long rateLimitWaitMs internally (hangs ~120s)
    const waiting: IntelligenceProvider = {
      evaluate: () => new Promise<string>((res) => { setTimeout(() => res('too-late'), 120000); }),
    };
    const pi = { async evaluate() { return 'pi'; } };
    const router = new IntelligenceRouter({
      defaultProvider: throwingProvider(),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ failureSwap: ['codex-cli', 'pi-cli'] }),
      buildProvider: (fw) => (fw === 'codex-cli' ? waiting : fw === 'pi-cli' ? (pi as unknown as IntelligenceProvider) : null),
      swapAttemptTimeoutMs: 5000,
    });
    const p = router.evaluate('x', GATING);
    await vi.advanceTimersByTimeAsync(5001); // cap fires well before the 120s internal wait
    expect(await p).toBe('pi');
  });
});

describe('§4.6 layered resolveConfig + §4.4 boot-snapshot (M5)', () => {
  // Simulate the server wiring: a computed default for a codex-active agent, layered
  // under any live in-memory override, with the operator-set boolean snapshotted ONCE.
  function makeWiredRouter(opts: {
    liveConfig: () => ComponentFrameworksConfig | undefined;
    operatorSetAtBoot: boolean;
    activeSet: IntelligenceFramework[];
  }) {
    const computedDefault = resolveInternalFrameworkDefault(opts.activeSet);
    const resolveConfig = (): ComponentFrameworksConfig | undefined => {
      const live = opts.liveConfig();
      if (opts.operatorSetAtBoot) return live;
      if (!live) return computedDefault;
      return {
        ...computedDefault,
        ...live,
        categories: { ...computedDefault.categories, ...live.categories },
        ...(live.overrides ? { overrides: live.overrides } : {}),
        ...(live.failureSwap !== undefined ? { failureSwap: live.failureSwap } : {}),
      };
    };
    const providers: Record<string, IntelligenceProvider> = {
      'codex-cli': { async evaluate() { return 'codex'; } },
      'gemini-cli': { async evaluate() { return 'gemini'; } },
    };
    return new IntelligenceRouter({
      defaultProvider: { async evaluate() { return 'claude'; } },
      defaultFramework: 'claude-code',
      resolveConfig,
      buildProvider: (fw) => providers[fw] ?? null,
      swapAttemptTimeoutMs: 5000,
    });
  }

  it('operator NOT set at boot → computed default applies (sentinels → codex)', async () => {
    const router = makeWiredRouter({
      liveConfig: () => undefined,
      operatorSetAtBoot: false,
      activeSet: ['codex-cli', 'gemini-cli', 'claude-code'],
    });
    expect(await router.evaluate('x', { attribution: { component: 'PresenceProxy' } })).toBe('codex');
  });

  it('M5: a CartographerSweep-style in-memory auto-vivify AFTER boot does NOT fool the snapshot', async () => {
    // The live object STARTS undefined (operator did not set it at boot), then a
    // CartographerSweep-style mutator vivifies overrides.CartographerSweep at runtime.
    // Because operatorSetAtBoot was snapshotted false, the computed default still
    // applies AND the live override is layered ON TOP for its own slot.
    let live: ComponentFrameworksConfig | undefined = undefined;
    const router = makeWiredRouter({
      liveConfig: () => live,
      operatorSetAtBoot: false, // snapshotted at boot when live was undefined
      activeSet: ['codex-cli', 'gemini-cli', 'claude-code'],
    });
    // before vivify: default policy routes sentinels to codex
    expect(await router.evaluate('x', { attribution: { component: 'PresenceProxy' } })).toBe('codex');
    // CartographerSweep auto-vivifies its override at runtime
    live = { overrides: { CartographerSweep: 'gemini-cli' } };
    // the default still routes sentinels to codex (NOT silently disabled) …
    expect(await router.evaluate('x', { attribution: { component: 'PresenceProxy' } })).toBe('codex');
    // … AND the live override wins for ITS slot (CartographerSweep → gemini).
    expect(await router.evaluate('x', { attribution: { component: 'CartographerSweep' } })).toBe('gemini');
  });

  it('operator SET at boot → operator block used verbatim, computed default ignored', async () => {
    // operator pinned ONLY a gate override; the default must NOT layer in (sentinels
    // stay on claude default because the operator block has no sentinel routing).
    const router = makeWiredRouter({
      liveConfig: () => ({ categories: { gate: 'codex-cli' } }),
      operatorSetAtBoot: true,
      activeSet: ['codex-cli', 'gemini-cli', 'claude-code'],
    });
    // a sentinel resolves to the DEFAULT (claude), NOT codex — default policy is off.
    expect(await router.evaluate('x', { attribution: { component: 'PresenceProxy' } })).toBe('claude');
    // the operator's gate routing still works.
    expect(await router.evaluate('x', { attribution: { component: 'PromptGate' } })).toBe('codex');
  });

  it('M7: {} rollback → every category resolves to the default framework, empty swap', async () => {
    // operator explicitly set componentFrameworks = {} at boot → operator-set true,
    // and the live block is {} → everything resolves to the default framework.
    const router = makeWiredRouter({
      liveConfig: () => ({}),
      operatorSetAtBoot: true,
      activeSet: ['codex-cli', 'gemini-cli', 'claude-code'],
    });
    expect(await router.evaluate('x', { attribution: { component: 'PresenceProxy' } })).toBe('claude');
    expect(await router.evaluate('x', { attribution: { component: 'PromptGate' } })).toBe('claude');
    expect(await router.evaluate('x', { attribution: { component: 'JobReflector' } })).toBe('claude');
    // and a gating failure with an empty {} block has no swap → fails closed.
    const failing = new IntelligenceRouter({
      defaultProvider: throwingProvider(),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({}),
      buildProvider: () => null,
      swapAttemptTimeoutMs: 5000,
    });
    await expect(failing.evaluate('x', GATING)).rejects.toThrow();
  });
});
