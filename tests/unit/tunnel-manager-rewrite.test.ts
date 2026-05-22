/**
 * Unit tests for the rewritten TunnelManager (PR 2 of the
 * tunnel-failure-resilience chain).
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md.
 *
 * Strategy: inject mock providers + mock fetch + mock notifier sink
 * to drive the manager through its state transitions without
 * spawning real cloudflared. The provider mocks return controllable
 * URLs / errors; the fetch mock returns Response objects with the
 * status the manager's reachability probe expects.
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
import type { NotifierSink } from '../../src/tunnel/TunnelNotifier.js';

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-mgr-'));
}

interface MockProviderOpts {
  name: ProviderName;
  tier?: ProviderTier;
  available?: boolean;
  startResult?: 'success' | { error: string };
  url?: string;
  stop?: () => Promise<void>;
}

function mockProvider(opts: MockProviderOpts): TunnelProvider {
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

function okResponse(): Response {
  return new Response('ok', { status: 200 });
}

function badResponse(): Response {
  return new Response('bad', { status: 500 });
}

const baseConfig = {
  enabled: true,
  type: 'quick' as const,
  port: 4040,
  stateDir: '',
};

let stateDir: string;
beforeEach(() => { stateDir = tmpStateDir(); });
afterEach(() => {
  try {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/tunnel-manager-rewrite.test.ts:cleanup',
    });
  } catch { /* ignore */ }
});

describe('TunnelManager (rewrite) — Tier-1 happy path', () => {
  it('drives the first available provider and resolves with its URL', async () => {
    const named = mockProvider({ name: 'cloudflare-named', url: 'https://named.example' });
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [named, quick], fetch: vi.fn(async () => okResponse()) },
    );
    const url = await mgr.start();
    expect(url).toBe('https://named.example');
    expect(mgr.url).toBe('https://named.example');
    expect(mgr.isRunning).toBe(true);
    expect(named.start).toHaveBeenCalledTimes(1);
    expect(quick.start).not.toHaveBeenCalled();
  });

  it('skips an unavailable provider and falls through to the next', async () => {
    const named = mockProvider({ name: 'cloudflare-named', available: false });
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [named, quick], fetch: vi.fn(async () => okResponse()) },
    );
    const url = await mgr.start();
    expect(url).toBe('https://quick.example');
    expect(named.start).not.toHaveBeenCalled();
    expect(quick.start).toHaveBeenCalledTimes(1);
  });

  it('persists the lifecycle snapshot to tunnel.json on success', async () => {
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [quick], fetch: vi.fn(async () => okResponse()) },
    );
    await mgr.start();
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'tunnel.json'), 'utf-8'));
    expect(persisted.lastUrl).toBe('https://quick.example');
    expect(persisted.lastState).toBe('active');
    expect(persisted.activeProvider).toBe('cloudflare-quick');
  });
});

describe('TunnelManager (rewrite) — reachability probe', () => {
  it('rejects a provider whose URL does not pass /health and falls through', async () => {
    const named = mockProvider({ name: 'cloudflare-named', url: 'https://broken.example' });
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const fetch = vi.fn(async (req: string) => {
      if (req.includes('broken.example')) return badResponse();
      return okResponse();
    });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [named, quick], fetch },
    );
    const url = await mgr.start();
    expect(url).toBe('https://quick.example');
    expect(named.start).toHaveBeenCalledTimes(1);
    expect(quick.start).toHaveBeenCalledTimes(1);
  });

  it('tears down the failed provider before trying the next', async () => {
    const stop = vi.fn(async () => undefined);
    const named = mockProvider({ name: 'cloudflare-named', url: 'https://broken.example', stop });
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const fetch = vi.fn(async (req: string) =>
      req.includes('broken.example') ? badResponse() : okResponse());
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [named, quick], fetch },
    );
    await mgr.start();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('TunnelManager (rewrite) — provider failure → next provider', () => {
  it('classifies a rate-limit failure and tries the next provider', async () => {
    const named = mockProvider({
      name: 'cloudflare-named',
      startResult: { error: 'rate-limited: 429 too many requests' },
    });
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [named, quick], fetch: vi.fn(async () => okResponse()) },
    );
    const url = await mgr.start();
    expect(url).toBe('https://quick.example');
    const snap = mgr.lifecycleState;
    expect(snap.episode?.attemptedProviders).toContain('cloudflare-named');
  });

  it('records each failed attempt against the current episode', async () => {
    const a = mockProvider({ name: 'cloudflare-named', startResult: { error: 'rate-limited: 1015' } });
    const b = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [a, b], fetch: vi.fn(async () => okResponse()) },
    );
    await mgr.start();
    const snap = mgr.lifecycleState;
    expect(snap.episode?.tier1Attempts).toBe(1);
    expect(snap.episode?.lastFailureReason).toBe('rate-limited');
  });
});

describe('TunnelManager (rewrite) — stop + back-compat surface', () => {
  it('stop() transitions to idle and emits stopped', async () => {
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [quick], fetch: vi.fn(async () => okResponse()) },
    );
    await mgr.start();
    const stopped = new Promise<void>((resolve) => mgr.once('stopped', () => resolve()));
    await mgr.stop();
    await stopped;
    expect(mgr.isRunning).toBe(false);
    expect(mgr.url).toBeNull();
  });

  it('forceStop() behaves like stop()', async () => {
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [quick], fetch: vi.fn(async () => okResponse()) },
    );
    await mgr.start();
    await mgr.forceStop();
    expect(mgr.isRunning).toBe(false);
  });

  it('getExternalUrl returns the absolute URL when up, null when down', async () => {
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [quick], fetch: vi.fn(async () => okResponse()) },
    );
    expect(mgr.getExternalUrl('/foo')).toBeNull();
    await mgr.start();
    expect(mgr.getExternalUrl('/foo')).toBe('https://quick.example/foo');
    expect(mgr.getExternalUrl('bar')).toBe('https://quick.example/bar');
  });

  it('enableAutoReconnect / disableAutoReconnect retain back-compat behavior', () => {
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [quick] },
    );
    expect(() => mgr.enableAutoReconnect()).not.toThrow();
    expect(() => mgr.disableAutoReconnect()).not.toThrow();
  });

  it('start() returns the same URL on repeat calls while running', async () => {
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [quick], fetch: vi.fn(async () => okResponse()) },
    );
    const a = await mgr.start();
    const b = await mgr.start();
    expect(a).toBe(b);
    expect(quick.start).toHaveBeenCalledTimes(1);
  });
});

describe('TunnelManager (rewrite) — notifier wiring', () => {
  it('emits a transition event to the notifier sink on successful start', async () => {
    const sink: NotifierSink = {
      sendGroup: vi.fn(async () => undefined),
      sendOwnerDM: vi.fn(async () => undefined),
    };
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [quick], fetch: vi.fn(async () => okResponse()), notifierSink: sink },
    );
    await mgr.start();
    // The first 'starting' → 'active' transition is the initial startup; the
    // notifier composes nothing user-visible for it (initial startup is a
    // non-event from the user's perspective). No group/DM messages expected.
    expect((sink.sendGroup as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('emits a group message when an episode advances retrying after a failure', async () => {
    const sink: NotifierSink = {
      sendGroup: vi.fn(async () => undefined),
      sendOwnerDM: vi.fn(async () => undefined),
    };
    const a = mockProvider({ name: 'cloudflare-named', startResult: { error: 'rate-limited: 429' } });
    const b = mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [a, b], fetch: vi.fn(async () => okResponse()), notifierSink: sink },
    );
    await mgr.start();
    // One transition to retrying → notifier emits the "couldn't reach" message.
    const groupCalls = (sink.sendGroup as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(groupCalls.some((m) => m.includes("Couldn't reach"))).toBe(true);
  });
});

describe('TunnelManager (rewrite) — attachTelegram wires the notifier sink', () => {
  it('falls back to the Lifeline topic when no Dashboard topic is configured', async () => {
    const sendToTopic = vi.fn(async () => undefined);
    const adapter = {
      sendToTopic,
      sendToOwnerDM: vi.fn(async () => undefined),
      getDashboardTopicId: () => undefined,
      getLifelineTopicId: () => 77,
    };
    const named = mockProvider({ name: 'cloudflare-named', startResult: { error: 'rate-limited: 1015' } });
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://q.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [named, quick], fetch: vi.fn(async () => okResponse()) },
    );
    mgr.attachTelegram(adapter, () => undefined);
    await mgr.start();
    const topicIds = sendToTopic.mock.calls.map((c) => c[0]);
    expect(topicIds).toContain(77);
  });

  it('routes the "couldn\'t reach" group message to the Dashboard topic id', async () => {
    const sendToTopic = vi.fn(async () => undefined);
    const adapter = {
      sendToTopic,
      sendToOwnerDM: vi.fn(async () => undefined),
      getDashboardTopicId: () => 42,
      getLifelineTopicId: () => 43,
    };
    const named = mockProvider({ name: 'cloudflare-named', startResult: { error: 'rate-limited: 1015' } });
    const quick = mockProvider({ name: 'cloudflare-quick', url: 'https://q.example' });
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [named, quick], fetch: vi.fn(async () => okResponse()) },
    );
    mgr.attachTelegram(adapter, () => '999000');
    await mgr.start();
    const calls = sendToTopic.mock.calls.map((c) => ({ topicId: c[0] as number, text: c[1] as string }));
    expect(calls.some((c) => c.topicId === 42 && c.text.includes("Couldn't reach"))).toBe(true);
  });

  it('owner-DM message carries the live URL and current PIN (credential substitution)', async () => {
    const dms: string[] = [];
    const adapter = {
      sendToTopic: vi.fn(async () => undefined),
      sendToOwnerDM: vi.fn(async (text: string) => { dms.push(text); }),
      getDashboardTopicId: () => 42,
      getLifelineTopicId: () => 43,
    };
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [
        mockProvider({ name: 'cloudflare-named', startResult: { error: 'rate-limited' } }),
        mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' }),
      ], fetch: vi.fn(async () => okResponse()) },
    );
    mgr.attachTelegram(adapter, () => '111222');
    await mgr.start();
    expect(dms.some((d) => d.includes('https://quick.example') && d.includes('111222'))).toBe(true);
  });
});

describe('TunnelManager (rewrite) — restoration of persisted snapshot', () => {
  it('restores the rotation-pending flag from tunnel.json on construction', () => {
    const snap = {
      version: 1,
      lastState: 'idle',
      lastUrl: null,
      activeProvider: null,
      rotationPending: true,
      consentCooldown: { consecutiveRefusals: 2, lastExtendedAt: 100, activeUntil: 0 },
      episode: null,
      savedAt: new Date().toISOString(),
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tunnel.json'), JSON.stringify(snap));

    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' })] },
    );
    expect(mgr.lifecycleState.rotationPending).toBe(true);
    expect(mgr.lifecycleState.consentCooldown.consecutiveRefusals).toBe(2);
  });

  it('ignores a corrupted state file and starts fresh', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tunnel.json'), 'not json');
    const mgr = new TunnelManager(
      { ...baseConfig, stateDir },
      { providers: [mockProvider({ name: 'cloudflare-quick', url: 'https://quick.example' })] },
    );
    expect(mgr.lifecycleState.rotationPending).toBe(false);
  });
});
