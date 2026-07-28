/**
 * Unit tests for the consent state machine (PR 5 of the
 * tunnel-failure-resilience chain).
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md Part 2,
 * Part 3, Part 6.
 *
 * The security-load-bearing surface:
 *   - Tier-1 exhaustion transitions to `awaiting-consent` ONLY when a
 *     Tier-2 provider is available AND the cross-episode cooldown
 *     isn't active. Otherwise → `exhausted` directly (the no-relay
 *     path).
 *   - The pending-consent nonce is a 128-bit CSPRNG token. `grantConsent`
 *     accepts ONLY a matching nonce and ONLY while the state is
 *     `awaiting-consent` (single-use; replay-safe).
 *   - On grant: provider starts, URL is probed for reachability,
 *     transition to `relay-active` with rotationPending=true (the
 *     mandatory PIN+authToken rotation marker per spec Part 6).
 *   - On decline / timeout: transition to `exhausted` with cooldown
 *     advanced (cross-episode rate-limit per verification finding V2).
 *   - `stop()` clears the pending consent, preventing late-firing
 *     timers from acting on a torn-down manager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TunnelManager } from '../../src/tunnel/TunnelManager.js';
import type {
  TunnelProvider,
  TunnelProviderHandle,
  ProviderName,
  ProviderTier,
} from '../../src/tunnel/TunnelProvider.js';

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-consent-'));
}

interface MockOpts {
  name: ProviderName;
  tier?: ProviderTier;
  available?: boolean;
  startResult?: 'success' | { error: string };
  url?: string;
  stop?: () => Promise<void>;
}

function mockProvider(opts: MockOpts): TunnelProvider {
  const tier: ProviderTier = opts.tier ?? 1;
  return {
    name: opts.name,
    tier,
    isAvailable: vi.fn(async () => opts.available !== false),
    start: vi.fn(async (): Promise<TunnelProviderHandle> => {
      if (opts.startResult && typeof opts.startResult === 'object') {
        throw new Error(opts.startResult.error);
      }
      return {
        url: opts.url ?? `https://${opts.name}.example`,
        stop: opts.stop ?? (async () => undefined),
      };
    }),
  };
}

const okFetch = vi.fn(async () => new Response('ok', { status: 200 }));
const badFetch = vi.fn(async () => new Response('bad', { status: 500 }));

const baseConfig = { enabled: true, type: 'quick' as const, port: 4040, stateDir: '' };

let stateDir: string;
beforeEach(() => { stateDir = tmpStateDir(); });
afterEach(() => {
  try {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/tunnel-consent-state-machine.test.ts:cleanup',
    });
  } catch { /* ignore */ }
});

describe('TunnelManager — Tier-1 exhaustion → awaiting-consent (when Tier-2 available)', () => {
  it('transitions to awaiting-consent when Tier-1 fails AND a Tier-2 provider is available', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited: 1015' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );

    // start() rejects because Tier-1 failed; meanwhile the manager
    // transitioned to awaiting-consent and populated pendingConsent.
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);
    expect(mgr.lifecycleState.lastState).toBe('awaiting-consent');
    const pc = mgr.pendingConsent;
    expect(pc).not.toBeNull();
    expect(pc?.provider).toBe('localtunnel');
    expect(pc?.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('falls through to exhausted when NO Tier-2 provider is available', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'network: ECONNREFUSED' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: false });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );

    await expect(mgr.start()).rejects.toBeInstanceOf(Error);
    expect(mgr.lifecycleState.lastState).toBe('exhausted');
    expect(mgr.pendingConsent).toBeNull();
  });

  it('falls through to exhausted when consent cooldown is active', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });

    // Pre-seed a tunnel.json with cooldown active.
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tunnel.json'), JSON.stringify({
      version: 1,
      lastState: 'idle',
      lastUrl: null,
      activeProvider: null,
      rotationPending: false,
      consentCooldown: { consecutiveRefusals: 3, lastExtendedAt: Date.now(), activeUntil: Date.now() + 60 * 60_000 },
      episode: null,
      savedAt: new Date().toISOString(),
    }));

    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );

    await expect(mgr.start()).rejects.toBeInstanceOf(Error);
    expect(mgr.lifecycleState.lastState).toBe('exhausted');
    expect(mgr.pendingConsent).toBeNull();
  });
});

describe('TunnelManager — grantConsent', () => {
  it('starts the Tier-2 provider and transitions to relay-active on matching nonce', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const pc = mgr.pendingConsent;
    expect(pc).not.toBeNull();
    const granted = await mgr.grantConsent(pc!.nonce);
    expect(granted).toBe(true);
    expect(mgr.lifecycleState.lastState).toBe('relay-active');
    expect(mgr.url).toBe('https://relay.loca.lt');
    expect(mgr.lifecycleState.activeProvider).toBe('localtunnel');
    expect(mgr.lifecycleState.rotationPending).toBe(true);
    expect(tier2.start).toHaveBeenCalledTimes(1);
    expect(mgr.pendingConsent).toBeNull(); // single-use — cleared on grant
  });

  it('rejects a wrong nonce without mutating state', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const granted = await mgr.grantConsent('ffffffffffffffffffffffffffffffff');
    expect(granted).toBe(false);
    expect(mgr.lifecycleState.lastState).toBe('awaiting-consent');
    expect(mgr.pendingConsent).not.toBeNull(); // still pending
    expect(tier2.start).not.toHaveBeenCalled();
  });

  it('rejects a replay of the same nonce after a successful grant (single-use)', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const pc = mgr.pendingConsent;
    expect(await mgr.grantConsent(pc!.nonce)).toBe(true);
    // Replay attempt — should fail without affecting state.
    expect(await mgr.grantConsent(pc!.nonce)).toBe(false);
    expect(mgr.lifecycleState.lastState).toBe('relay-active');
    expect(tier2.start).toHaveBeenCalledTimes(1);
  });

  it('falls back to exhausted + cooldown when the relay starts but is unreachable', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://broken.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      // 1ms probe-retry delays: keep the reachability grace window fast.
      { providers: [tier1, tier2], fetch: badFetch, reachabilityRetryDelaysMs: [1] },
    );
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const pc = mgr.pendingConsent;
    const granted = await mgr.grantConsent(pc!.nonce);
    expect(granted).toBe(false);
    expect(mgr.lifecycleState.lastState).toBe('exhausted');
    expect(mgr.lifecycleState.consentCooldown.consecutiveRefusals).toBeGreaterThanOrEqual(1);
    expect(mgr.url).toBeNull();
  });

  it('falls back to exhausted when the relay provider.start() throws', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, startResult: { error: 'process-exit code 1' } });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const pc = mgr.pendingConsent;
    const granted = await mgr.grantConsent(pc!.nonce);
    expect(granted).toBe(false);
    expect(mgr.lifecycleState.lastState).toBe('exhausted');
    expect(mgr.lifecycleState.consentCooldown.consecutiveRefusals).toBeGreaterThanOrEqual(1);
  });
});

describe('TunnelManager — declineConsent', () => {
  it('transitions to exhausted + advances cooldown on matching nonce', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const pc = mgr.pendingConsent;
    const declined = mgr.declineConsent(pc!.nonce);
    expect(declined).toBe(true);
    expect(mgr.lifecycleState.lastState).toBe('exhausted');
    expect(mgr.lifecycleState.consentCooldown.consecutiveRefusals).toBe(1);
    expect(mgr.pendingConsent).toBeNull();
  });

  it('rejects a wrong nonce without mutating state', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    const declined = mgr.declineConsent('00000000000000000000000000000000');
    expect(declined).toBe(false);
    expect(mgr.lifecycleState.lastState).toBe('awaiting-consent');
    expect(mgr.lifecycleState.consentCooldown.consecutiveRefusals).toBe(0);
  });
});

describe('TunnelManager — stop() clears pending consent', () => {
  it('clears pendingConsent on stop() so timeouts cannot fire afterwards', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [tier1, tier2], fetch: okFetch },
    );
    await expect(mgr.start()).rejects.toBeInstanceOf(Error);
    expect(mgr.pendingConsent).not.toBeNull();

    await mgr.stop();
    expect(mgr.pendingConsent).toBeNull();
    expect(mgr.lifecycleState.lastState).toBe('idle');
  });
});
