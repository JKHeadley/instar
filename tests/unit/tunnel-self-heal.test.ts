/**
 * Unit tests for the self-heal stability gate (PR 8 of the
 * tunnel-failure-resilience chain).
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md Part 5.
 *
 * While a relay is active, a low-frequency probe tests Tier-1 recovery.
 * The manager migrates back only after N CONSECUTIVE successful Tier-1
 * establishments (a single success during flapping must NOT switch), via
 * an atomic new-then-old switch-back, and rotates credentials on the way
 * to `active` (the relay episode terminally ended).
 *
 * Tests drive `runSelfHealCheck()` directly (the production timer calls
 * it on a cadence) so the stability gate is exercised without real waits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TunnelManager, type TunnelMessagingAdapter } from '../../src/tunnel/TunnelManager.js';
import type { TunnelProvider, TunnelProviderHandle, ProviderName, ProviderTier } from '../../src/tunnel/TunnelProvider.js';

/** A Tier-1 provider whose start() behavior is switchable across calls. */
function controllableTier1() {
  let mode: 'fail' | 'ok' = 'fail';
  const relayStops: number[] = [];
  void relayStops;
  const provider: TunnelProvider = {
    name: 'cloudflare-quick',
    tier: 1,
    isAvailable: vi.fn(async () => true),
    start: vi.fn(async (): Promise<TunnelProviderHandle> => {
      if (mode === 'fail') throw new Error('rate-limited: 1015');
      return { url: 'https://cf-recovered.example', stop: vi.fn(async () => undefined) };
    }),
  };
  return { provider, setMode: (m: 'fail' | 'ok') => { mode = m; } };
}

/** A Tier-2 relay whose handle.stop is spyable (to assert teardown). */
function spyableTier2(): { provider: TunnelProvider; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async () => undefined);
  const provider: TunnelProvider = {
    name: 'localtunnel',
    tier: 2,
    isAvailable: vi.fn(async () => true),
    start: vi.fn(async (): Promise<TunnelProviderHandle> => ({ url: 'https://relay.loca.lt', stop })),
  };
  return { provider, stop };
}

function mockAdapter(): { adapter: TunnelMessagingAdapter; invoke: (a: 'grant' | 'decline', n: string) => Promise<string> } {
  let h: ((action: 'grant' | 'decline', nonce: string) => Promise<string>) | null = null;
  const adapter: TunnelMessagingAdapter = {
    sendToTopic: vi.fn(async () => undefined),
    sendToOwnerDM: vi.fn(async () => undefined),
    getDashboardTopicId: () => 42,
    getLifelineTopicId: () => 43,
    sendOwnerConsentPrompt: vi.fn(async () => 1001),
    setTunnelConsentHandler: (fn) => { h = fn; },
  };
  return { adapter, invoke: (a, n) => h!(a, n) };
}

const okFetch = vi.fn(async () => new Response('ok', { status: 200 }));
const baseConfig = { enabled: true, type: 'quick' as const, port: 4040, stateDir: '' };

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-selfheal-')); });
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/tunnel-self-heal.test.ts:cleanup' }); } catch { /* ignore */ }
});

/** Drive a manager to relay-active with a controllable Tier-1 + spyable relay. */
async function inRelayActive(rotate: () => Promise<void>) {
  const t1 = controllableTier1();
  const t2 = spyableTier2();
  const m = mockAdapter();
  const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [t1.provider, t2.provider], fetch: okFetch });
  mgr.setCredentialRotator(rotate);
  mgr.attachTelegram(m.adapter, () => '123456');
  await expect(mgr.start()).rejects.toBeInstanceOf(Error); // Tier-1 fails → awaiting-consent
  await m.invoke('grant', mgr.pendingConsent!.nonce);       // → relay-active
  expect(mgr.lifecycleState.lastState).toBe('relay-active');
  expect(mgr.url).toBe('https://relay.loca.lt');
  return { mgr, t1, t2 };
}

describe('TunnelManager self-heal stability gate', () => {
  it('migrates back only after N CONSECUTIVE Tier-1 successes (atomic switch + rotation)', async () => {
    const rotate = vi.fn(async () => undefined);
    const { mgr, t1, t2 } = await inRelayActive(rotate);
    t1.setMode('ok'); // Cloudflare has recovered

    expect(await mgr.runSelfHealCheck()).toBe('progress'); // 1
    expect(await mgr.runSelfHealCheck()).toBe('progress'); // 2
    expect(mgr.lifecycleState.lastState).toBe('relay-active'); // still on relay
    expect(t2.stop).not.toHaveBeenCalled();

    expect(await mgr.runSelfHealCheck()).toBe('switched');  // 3 → switch back

    // Atomic new-then-old: URL is the recovered Cloudflare URL, state active.
    expect(mgr.url).toBe('https://cf-recovered.example');
    expect(mgr.lifecycleState.lastState).toBe('active');
    // The relay was torn down…
    expect(t2.stop).toHaveBeenCalled();
    // …and credentials were rotated (terminal exit from relay-active).
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(mgr.lifecycleState.rotationPending).toBe(false);
  });

  it('a single success during flapping does NOT accumulate — the counter resets on failure', async () => {
    const rotate = vi.fn(async () => undefined);
    const { mgr, t1, t2 } = await inRelayActive(rotate);

    t1.setMode('ok');
    expect(await mgr.runSelfHealCheck()).toBe('progress'); // 1
    expect(await mgr.runSelfHealCheck()).toBe('progress'); // 2

    t1.setMode('fail'); // Cloudflare flaps back down
    expect(await mgr.runSelfHealCheck()).toBe('reset');    // counter → 0, stay on relay
    expect(mgr.lifecycleState.lastState).toBe('relay-active');
    expect(t2.stop).not.toHaveBeenCalled();

    // Now it takes a FRESH run of 3 consecutive successes to switch.
    t1.setMode('ok');
    expect(await mgr.runSelfHealCheck()).toBe('progress'); // 1
    expect(await mgr.runSelfHealCheck()).toBe('progress'); // 2
    expect(mgr.lifecycleState.lastState).toBe('relay-active');
    expect(await mgr.runSelfHealCheck()).toBe('switched'); // 3
    expect(mgr.lifecycleState.lastState).toBe('active');
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it('runSelfHealCheck is inactive (and stops the probe) once not relay-active', async () => {
    const { mgr } = await inRelayActive(async () => undefined);
    await mgr.stop();
    expect(await mgr.runSelfHealCheck()).toBe('inactive');
  });
});
