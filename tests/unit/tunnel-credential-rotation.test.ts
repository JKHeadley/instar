/**
 * Unit tests for tunnel credential rotation (PR 7 of the
 * tunnel-failure-resilience chain).
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md Part 6.
 *
 * Covers the manager's WHEN of rotation — the lifecycle triggers and the
 * mandatory-rotation invariant (flag set on relay-active entry, cleared
 * only after the rotator resolves):
 *   - relay-active → idle (stop) rotates; non-relay stop does not.
 *   - boot-recovery rotates when the persisted flag is set.
 *   - a thrown rotator leaves the flag set so the next stop/boot retries.
 *   - no rotator wired → flag cleared with a loud warning (no infinite loop).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TunnelManager, type TunnelMessagingAdapter } from '../../src/tunnel/TunnelManager.js';
import type {
  TunnelProvider,
  TunnelProviderHandle,
  ProviderName,
  ProviderTier,
} from '../../src/tunnel/TunnelProvider.js';

function mockProvider(opts: { name: ProviderName; tier?: ProviderTier; available?: boolean; startResult?: 'success' | { error: string }; url?: string }): TunnelProvider {
  return {
    name: opts.name,
    tier: opts.tier ?? 1,
    isAvailable: vi.fn(async () => opts.available !== false),
    start: vi.fn(async (): Promise<TunnelProviderHandle> => {
      if (opts.startResult && typeof opts.startResult === 'object') throw new Error(opts.startResult.error);
      return { url: opts.url ?? `https://${opts.name}.example`, stop: async () => undefined };
    }),
  };
}

function mockAdapter() {
  let consentHandler: ((action: 'grant' | 'decline', nonce: string) => Promise<string>) | null = null;
  const adapter: TunnelMessagingAdapter = {
    sendToTopic: vi.fn(async () => undefined),
    sendToOwnerDM: vi.fn(async () => undefined),
    getDashboardTopicId: () => 42,
    getLifelineTopicId: () => 43,
    sendOwnerConsentPrompt: vi.fn(async () => 1001),
    setTunnelConsentHandler: (fn) => { consentHandler = fn; },
  };
  return { adapter, invoke: (a: 'grant' | 'decline', n: string) => consentHandler!(a, n) };
}

const okFetch = vi.fn(async () => new Response('ok', { status: 200 }));
const baseConfig = { enabled: true, type: 'quick' as const, port: 4040, stateDir: '' };

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-rotate-')); });
afterEach(() => {
  try {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/tunnel-credential-rotation.test.ts:cleanup' });
  } catch { /* ignore */ }
});

/** Build a manager, drive Tier-1 exhaustion → grant → relay-active. */
async function managerInRelayActive(rotator: () => Promise<void>) {
  const m = mockAdapter();
  const tier1 = mockProvider({ name: 'cloudflare-quick', startResult: { error: 'rate-limited: 1015' } });
  const tier2 = mockProvider({ name: 'localtunnel', tier: 2, available: true, url: 'https://relay.loca.lt' });
  const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [tier1, tier2], fetch: okFetch });
  mgr.setCredentialRotator(rotator);
  mgr.attachTelegram(m.adapter, () => '123456');
  await expect(mgr.start()).rejects.toBeInstanceOf(Error);
  const nonce = mgr.pendingConsent!.nonce;
  await m.invoke('grant', nonce);
  expect(mgr.lifecycleState.lastState).toBe('relay-active');
  expect(mgr.lifecycleState.rotationPending).toBe(true);
  return mgr;
}

describe('TunnelManager credential rotation', () => {
  it('stop() from relay-active rotates credentials and clears rotationPending', async () => {
    const rotate = vi.fn(async () => undefined);
    const mgr = await managerInRelayActive(rotate);

    await mgr.stop();

    expect(rotate).toHaveBeenCalledTimes(1);
    expect(mgr.lifecycleState.rotationPending).toBe(false);
  });

  it('stop() from a non-relay state does NOT rotate', async () => {
    const rotate = vi.fn(async () => undefined);
    const tier1 = mockProvider({ name: 'cloudflare-quick', url: 'https://q.example' });
    const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [tier1], fetch: okFetch });
    mgr.setCredentialRotator(rotate);
    await mgr.start();
    expect(mgr.lifecycleState.rotationPending).toBe(false);

    await mgr.stop();

    expect(rotate).not.toHaveBeenCalled();
  });

  it('runCredentialRotation is a no-op when nothing is pending', async () => {
    const rotate = vi.fn(async () => undefined);
    const mgr = new TunnelManager({ ...baseConfig, stateDir }, { providers: [mockProvider({ name: 'cloudflare-quick' })], fetch: okFetch });
    mgr.setCredentialRotator(rotate);

    const did = await mgr.runCredentialRotation('test');

    expect(did).toBe(false);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('a thrown rotator leaves rotationPending SET so the next attempt retries', async () => {
    const rotate = vi.fn(async () => { throw new Error('config write failed'); });
    const mgr = await managerInRelayActive(rotate);

    const did = await mgr.runCredentialRotation('stop');

    expect(did).toBe(false);
    expect(rotate).toHaveBeenCalledTimes(1);
    // Invariant: the mandatory-rotation flag must NOT be cleared on failure.
    expect(mgr.lifecycleState.rotationPending).toBe(true);
  });

  it('no rotator wired → clears the flag with a warning (no permanent-pending loop)', async () => {
    const mgr = await managerInRelayActive(async () => undefined);
    mgr.setCredentialRotator(null); // simulate misconfiguration
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const did = await mgr.runCredentialRotation('stop');

    expect(did).toBe(false);
    expect(mgr.lifecycleState.rotationPending).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('boot-recovery: a fresh manager restores rotationPending and rotates before serving', async () => {
    // First manager reaches relay-active (persists rotationPending=true), then
    // the process "dies" without a clean stop (no rotation).
    await managerInRelayActive(async () => undefined);

    // A new manager over the SAME stateDir restores the persisted flag.
    const rotate = vi.fn(async () => undefined);
    const mgr2 = new TunnelManager({ ...baseConfig, stateDir }, { providers: [mockProvider({ name: 'cloudflare-quick' })], fetch: okFetch });
    mgr2.setCredentialRotator(rotate);
    expect(mgr2.lifecycleState.rotationPending).toBe(true);

    const did = await mgr2.recoverPendingRotation();

    expect(did).toBe(true);
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(mgr2.lifecycleState.rotationPending).toBe(false);
  });
});
