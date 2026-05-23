/**
 * Unit tests for the tunnel-failure-resilience config knobs (PR 9).
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md Part 4.
 *
 * The safety knobs MUST actually work — an opt-out that's only a config
 * field but isn't wired is a broken feature:
 *   - relaysEnabled=false  → Cloudflare-only; never offer a relay.
 *   - relayConsent='never' → Cloudflare-only; never prompt for consent.
 *   - relayProviders       → selects which Tier-2 relays the default pool
 *                            builds ('bore' is opt-in / not yet built).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TunnelManager, type TunnelConfig } from '../../src/tunnel/TunnelManager.js';
import type { TunnelProvider, TunnelProviderHandle, ProviderName, ProviderTier } from '../../src/tunnel/TunnelProvider.js';

function mockProvider(opts: { name: ProviderName; tier?: ProviderTier; available?: boolean; startResult?: { error: string }; url?: string }): TunnelProvider {
  return {
    name: opts.name,
    tier: opts.tier ?? 1,
    isAvailable: vi.fn(async () => opts.available !== false),
    start: vi.fn(async (): Promise<TunnelProviderHandle> => {
      if (opts.startResult) throw new Error(opts.startResult.error);
      return { url: opts.url ?? `https://${opts.name}.example`, stop: async () => undefined };
    }),
  };
}

const okFetch = vi.fn(async () => new Response('ok', { status: 200 }));
const base = { enabled: true, type: 'quick' as const, port: 4040 };

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-knobs-')); });
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/tunnel-config-knobs.test.ts:cleanup' }); } catch { /* ignore */ }
});

describe('tunnel relay config knobs (Part 4)', () => {
  it('relaysEnabled=false → Tier-1 exhaustion goes to `exhausted`, never `awaiting-consent`', async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited: 1015' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true });
    const cfg: TunnelConfig = { ...base, stateDir, relaysEnabled: false };
    const mgr = new TunnelManager(cfg, { providers: [tier1, tier2], fetch: okFetch });

    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    expect(mgr.lifecycleState.lastState).toBe('exhausted');
    expect(mgr.pendingConsent).toBeNull();
    // The Tier-2 relay was never even probed for availability.
    expect(tier2.isAvailable).not.toHaveBeenCalled();
  });

  it("relayConsent='never' → Cloudflare-only; no consent prompt", async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true });
    const cfg: TunnelConfig = { ...base, stateDir, relayConsent: 'never' };
    const mgr = new TunnelManager(cfg, { providers: [tier1, tier2], fetch: okFetch });

    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    expect(mgr.lifecycleState.lastState).toBe('exhausted');
    expect(mgr.pendingConsent).toBeNull();
  });

  it("default (relays on, 'ask') still offers consent on Tier-1 exhaustion", async () => {
    const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited' } });
    const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true });
    const cfg: TunnelConfig = { ...base, stateDir }; // no overrides
    const mgr = new TunnelManager(cfg, { providers: [tier1, tier2], fetch: okFetch });

    await expect(mgr.start()).rejects.toBeInstanceOf(Error);

    expect(mgr.lifecycleState.lastState).toBe('awaiting-consent');
    expect(mgr.pendingConsent).not.toBeNull();
  });

  it('default pool builds the localtunnel relay; relayProviders without it omits Tier-2', () => {
    const withRelay = new TunnelManager({ ...base, stateDir }, { fetch: okFetch });
    expect((withRelay as unknown as { providers: TunnelProvider[] }).providers.some((p) => p.tier === 2)).toBe(true);

    const noRelay = new TunnelManager({ ...base, stateDir, relayProviders: ['bore'] }, { fetch: okFetch });
    // 'bore' has no checksum-verified installer yet, so it is not built;
    // localtunnel isn't listed → no Tier-2 provider in the pool.
    expect((noRelay as unknown as { providers: TunnelProvider[] }).providers.some((p) => p.tier === 2)).toBe(false);

    const disabled = new TunnelManager({ ...base, stateDir, relaysEnabled: false }, { fetch: okFetch });
    expect((disabled as unknown as { providers: TunnelProvider[] }).providers.some((p) => p.tier === 2)).toBe(false);
  });
});
