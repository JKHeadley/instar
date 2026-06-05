/**
 * Unit tests for TunnelManager — provider/tier architecture.
 *
 * Rewritten 2026-06-05 against the tunnel-failure-resilience rewrite
 * (provider pool + TunnelLifecycle state machine + reachability probe).
 * The previous suite predated that rewrite: it mocked the `cloudflared`
 * module directly and could never pass because production drives a
 * provider pool with a REAL reachability probe (driveTier1 →
 * probeReachability fetches <url>/health and requires 2xx).
 *
 * This suite uses the constructor's injection seams exclusively:
 *   - `injections.providers` — fake TunnelProvider implementations
 *   - `injections.fetch`     — stubbed reachability probe
 * plus the public deterministic drivers (`runSelfHealCheck()`,
 * `grantConsent()`, `declineConsent()`) so no real timers, processes,
 * or network are involved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { TunnelManager } from '../../src/tunnel/TunnelManager.js';
import type { TunnelConfig } from '../../src/tunnel/TunnelManager.js';
import type {
  TunnelProvider,
  TunnelProviderHandle,
  ProviderName,
  ProviderTier,
} from '../../src/tunnel/TunnelProvider.js';
import type { PersistedTunnelState } from '../../src/tunnel/TunnelLifecycle.js';

// ── Fakes ───────────────────────────────────────────────────────────

class FakeHandle implements TunnelProviderHandle {
  readonly url: string;
  stopCalls = 0;
  constructor(url: string) {
    this.url = url;
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class FakeProvider implements TunnelProvider {
  readonly name: ProviderName;
  readonly tier: ProviderTier;
  available = true;
  startCalls = 0;
  /** Swappable behavior — tests flip this between failure and success. */
  startImpl: (port: number) => Promise<TunnelProviderHandle>;
  /** Every handle this provider ever produced (for stop assertions). */
  handles: FakeHandle[] = [];

  constructor(name: ProviderName, tier: ProviderTier, urlOrError?: string | Error) {
    this.name = name;
    this.tier = tier;
    if (urlOrError instanceof Error) {
      this.startImpl = async () => {
        throw urlOrError;
      };
    } else {
      const url = urlOrError ?? `https://${name}.example.test`;
      this.startImpl = async () => this.makeHandle(url);
    }
  }

  makeHandle(url: string): FakeHandle {
    const h = new FakeHandle(url);
    this.handles.push(h);
    return h;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async start(port: number): Promise<TunnelProviderHandle> {
    this.startCalls += 1;
    return this.startImpl(port);
  }
}

// ── Suite ───────────────────────────────────────────────────────────

describe('TunnelManager (provider/tier architecture)', () => {
  let project: TempProject;
  let managers: TunnelManager[];
  /** Probe behavior: per-test switchable. */
  let fetchOk: boolean;
  let fetchCalls: string[];
  let fetcher: typeof fetch;

  beforeEach(() => {
    project = createTempProject();
    managers = [];
    fetchOk = true;
    fetchCalls = [];
    fetcher = vi.fn(async (input: string | URL | Request) => {
      fetchCalls.push(String(input));
      return { ok: fetchOk } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    // Always tear down: clears backoff / post-exhausted / consent /
    // self-heal timers so no test leaks a handle into the next.
    for (const tm of managers) {
      try {
        await tm.stop();
      } catch {
        /* best effort */
      }
    }
    project.cleanup();
  });

  function createManager(
    providers: TunnelProvider[],
    configOverrides: Partial<TunnelConfig> = {},
  ): TunnelManager {
    const tm = new TunnelManager(
      {
        enabled: true,
        type: 'quick',
        port: 7777,
        stateDir: project.stateDir,
        ...configOverrides,
      },
      { providers, fetch: fetcher },
    );
    // EventEmitter throws on unhandled 'error' — every failure path
    // emits it, so absorb by default; tests assert via rejections.
    tm.on('error', () => {});
    managers.push(tm);
    return tm;
  }

  function readPersisted(): PersistedTunnelState {
    const raw = fs.readFileSync(path.join(project.stateDir, 'tunnel.json'), 'utf-8');
    return JSON.parse(raw) as PersistedTunnelState;
  }

  // ── Constructor / initial state ───────────────────────────────────

  describe('constructor', () => {
    it('initializes with null state and idle lifecycle', () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      expect(tm.url).toBeNull();
      expect(tm.isRunning).toBe(false);
      expect(tm.state.type).toBe('quick');
      expect(tm.state.startedAt).toBeNull();
      expect(tm.lifecycleState.lastState).toBe('idle');
      expect(tm.lifecycleState.rotationPending).toBe(false);
    });

    it('restores rotationPending + consent cooldown from tunnel.json', () => {
      const persisted: PersistedTunnelState = {
        version: 1,
        lastState: 'relay-active',
        lastUrl: 'https://old.example.test',
        activeProvider: 'localtunnel',
        rotationPending: true,
        consentCooldown: {
          consecutiveRefusals: 2,
          lastExtendedAt: Date.now(),
          activeUntil: Date.now() + 60_000,
        },
        episode: null,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(project.stateDir, 'tunnel.json'),
        JSON.stringify(persisted),
      );
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      const snap = tm.lifecycleState;
      expect(snap.rotationPending).toBe(true);
      expect(snap.consentCooldown.consecutiveRefusals).toBe(2);
      // State itself is NOT resumed — every boot starts at idle.
      expect(snap.lastState).toBe('idle');
    });

    it('tolerates a corrupted tunnel.json (starts fresh)', () => {
      fs.writeFileSync(path.join(project.stateDir, 'tunnel.json'), '{not json');
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      expect(tm.lifecycleState.lastState).toBe('idle');
      expect(tm.lifecycleState.rotationPending).toBe(false);
    });
  });

  // ── start(): happy path ───────────────────────────────────────────

  describe('start — happy path', () => {
    it('starts the first available Tier-1 provider and resolves its URL', async () => {
      const p1 = new FakeProvider('cloudflare-quick', 1, 'https://abc.trycloudflare.com');
      const tm = createManager([p1]);

      const url = await tm.start();
      expect(url).toBe('https://abc.trycloudflare.com');
      expect(tm.url).toBe('https://abc.trycloudflare.com');
      expect(tm.isRunning).toBe(true);
      expect(tm.state.startedAt).toBeTruthy();
      expect(p1.startCalls).toBe(1);
      expect(tm.lifecycleState.lastState).toBe('active');
      expect(tm.lifecycleState.activeProvider).toBe('cloudflare-quick');
    });

    it('probes reachability on <url>/health before declaring active', async () => {
      const tm = createManager([
        new FakeProvider('cloudflare-quick', 1, 'https://abc.trycloudflare.com/'),
      ]);
      await tm.start();
      // Trailing slash stripped — exactly one /health.
      expect(fetchCalls).toContain('https://abc.trycloudflare.com/health');
    });

    it('emits the url event on success', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1, 'https://u.example.test')]);
      const seen: string[] = [];
      tm.on('url', (u: string) => seen.push(u));
      await tm.start();
      expect(seen).toEqual(['https://u.example.test']);
    });

    it('persists lifecycle snapshot with lastUrl on success', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1, 'https://p.example.test')]);
      await tm.start();
      const saved = readPersisted();
      expect(saved.lastState).toBe('active');
      expect(saved.lastUrl).toBe('https://p.example.test');
      expect(saved.activeProvider).toBe('cloudflare-quick');
    });

    it('returns the existing URL when already running (no second provider start)', async () => {
      const p1 = new FakeProvider('cloudflare-quick', 1, 'https://once.example.test');
      const tm = createManager([p1]);
      await tm.start();
      const again = await tm.start();
      expect(again).toBe('https://once.example.test');
      expect(p1.startCalls).toBe(1);
    });

    it('coalesces concurrent start() calls into one attempt', async () => {
      const p1 = new FakeProvider('cloudflare-quick', 1, 'https://co.example.test');
      const tm = createManager([p1]);
      const [a, b] = await Promise.all([tm.start(), tm.start()]);
      expect(a).toBe('https://co.example.test');
      expect(b).toBe('https://co.example.test');
      expect(p1.startCalls).toBe(1);
    });

    it('rejects when tunnel.enabled is false', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)], { enabled: false });
      await expect(tm.start()).rejects.toThrow('tunnel.enabled is false');
    });
  });

  // ── start(): provider pool fallback ───────────────────────────────

  describe('start — provider pool fallback', () => {
    it('falls through to the next Tier-1 provider when the first fails', async () => {
      const named = new FakeProvider('cloudflare-named', 1, new Error('process exited code 1'));
      const quick = new FakeProvider('cloudflare-quick', 1, 'https://fallback.example.test');
      const tm = createManager([named, quick]);

      const url = await tm.start();
      expect(url).toBe('https://fallback.example.test');
      expect(named.startCalls).toBe(1);
      expect(quick.startCalls).toBe(1);
      expect(tm.lifecycleState.activeProvider).toBe('cloudflare-quick');
    });

    it('skips providers that report unavailable', async () => {
      const named = new FakeProvider('cloudflare-named', 1, 'https://should-not-start.test');
      named.available = false;
      const quick = new FakeProvider('cloudflare-quick', 1, 'https://avail.example.test');
      const tm = createManager([named, quick]);

      const url = await tm.start();
      expect(url).toBe('https://avail.example.test');
      expect(named.startCalls).toBe(0);
    });

    it('treats a failed reachability probe as provider failure (stops handle, tries next)', async () => {
      const flaky = new FakeProvider('cloudflare-named', 1);
      // Custom start that succeeds but whose URL will fail the probe.
      flaky.startImpl = async () => flaky.makeHandle('https://dead.example.test');
      const quick = new FakeProvider('cloudflare-quick', 1, 'https://alive.example.test');
      const tm = createManager([flaky, quick]);

      // Probe: fail for the dead URL, succeed for the live one.
      (fetcher as ReturnType<typeof vi.fn>).mockImplementation(
        async (input: string | URL | Request) => {
          const u = String(input);
          fetchCalls.push(u);
          return { ok: !u.startsWith('https://dead.example.test') } as Response;
        },
      );

      const url = await tm.start();
      expect(url).toBe('https://alive.example.test');
      // The unreachable handle was torn down.
      expect(flaky.handles).toHaveLength(1);
      expect(flaky.handles[0]?.stopCalls).toBe(1);
    });

    it('treats a throwing fetch as unreachable', async () => {
      const p1 = new FakeProvider('cloudflare-named', 1, 'https://boom.example.test');
      const p2 = new FakeProvider('cloudflare-quick', 1, 'https://calm.example.test');
      const tm = createManager([p1, p2]);
      (fetcher as ReturnType<typeof vi.fn>).mockImplementation(
        async (input: string | URL | Request) => {
          const u = String(input);
          if (u.startsWith('https://boom')) throw new Error('socket hang up');
          return { ok: true } as Response;
        },
      );
      const url = await tm.start();
      expect(url).toBe('https://calm.example.test');
    });

    it('never starts a Tier-2 provider during the automatic ladder', async () => {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const t2 = new FakeProvider('localtunnel', 2, 'https://relay.example.test');
      const tm = createManager([t1, t2]);
      tm.disableAutoReconnect();

      await expect(tm.start()).rejects.toThrow();
      expect(t2.startCalls).toBe(0); // consent-gated — never auto-started
    });
  });

  // ── start(): exhaustion ───────────────────────────────────────────

  describe('start — exhaustion', () => {
    it('rejects and lands in exhausted when all Tier-1 fail and no Tier-2 exists', async () => {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const tm = createManager([t1]);
      tm.disableAutoReconnect();

      await expect(tm.start()).rejects.toThrow('network unreachable');
      expect(tm.lifecycleState.lastState).toBe('exhausted');
      expect(tm.isRunning).toBe(false);
    });

    it('emits error on exhaustion', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1, new Error('boom'))]);
      tm.disableAutoReconnect();
      const errors: Error[] = [];
      tm.on('error', (e: Error) => errors.push(e));
      await expect(tm.start()).rejects.toThrow('boom');
      expect(errors).toHaveLength(1);
    });

    it('relaysEnabled=false goes straight to exhausted even with a Tier-2 available', async () => {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const t2 = new FakeProvider('localtunnel', 2, 'https://relay.example.test');
      const tm = createManager([t1, t2], { relaysEnabled: false });
      tm.disableAutoReconnect();

      await expect(tm.start()).rejects.toThrow();
      expect(tm.lifecycleState.lastState).toBe('exhausted');
      expect(tm.pendingConsent).toBeNull();
    });

    it("relayConsent='never' goes straight to exhausted even with a Tier-2 available", async () => {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const t2 = new FakeProvider('localtunnel', 2, 'https://relay.example.test');
      const tm = createManager([t1, t2], { relayConsent: 'never' });
      tm.disableAutoReconnect();

      await expect(tm.start()).rejects.toThrow();
      expect(tm.lifecycleState.lastState).toBe('exhausted');
      expect(tm.pendingConsent).toBeNull();
    });

    it('a second start() after exhaustion rejects with the lifecycle state', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1, new Error('down'))]);
      tm.disableAutoReconnect();
      await expect(tm.start()).rejects.toThrow('down');
      // Recovery is the background ladder's job — manual restart is rejected.
      await expect(tm.start()).rejects.toThrow('cannot start: lifecycle in state exhausted');
    });
  });

  // ── Consent flow (Tier-2 relays) ──────────────────────────────────

  describe('consent flow', () => {
    function consentSetup(configOverrides: Partial<TunnelConfig> = {}) {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const t2 = new FakeProvider('localtunnel', 2, 'https://relay.example.test');
      const tm = createManager([t1, t2], configOverrides);
      tm.disableAutoReconnect();
      return { tm, t1, t2 };
    }

    it('enters awaiting-consent with a pending nonce when Tier-1 exhausts and a Tier-2 is available', async () => {
      const { tm, t2 } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      expect(tm.lifecycleState.lastState).toBe('awaiting-consent');
      const pending = tm.pendingConsent;
      expect(pending).not.toBeNull();
      expect(pending?.provider).toBe('localtunnel');
      expect(pending?.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(t2.startCalls).toBe(0); // not started until granted
    });

    it('grantConsent with a wrong nonce is rejected and consumes nothing', async () => {
      const { tm, t2 } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      expect(await tm.grantConsent('0'.repeat(32))).toBe(false);
      expect(t2.startCalls).toBe(0);
      expect(tm.pendingConsent).not.toBeNull(); // still pending — wrong nonce burns nothing
    });

    it('grantConsent with the correct nonce starts the relay and enters relay-active', async () => {
      const { tm, t2 } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      const nonce = tm.pendingConsent?.nonce;
      expect(nonce).toBeTruthy();

      const ok = await tm.grantConsent(nonce as string);
      expect(ok).toBe(true);
      expect(t2.startCalls).toBe(1);
      expect(tm.url).toBe('https://relay.example.test');
      expect(tm.isRunning).toBe(true);
      expect(tm.lifecycleState.lastState).toBe('relay-active');
      // Entering relay-active marks credentials for mandatory rotation.
      expect(tm.lifecycleState.rotationPending).toBe(true);
      expect(readPersisted().rotationPending).toBe(true);
    });

    it('the consent nonce is single-use (replay loses)', async () => {
      const { tm } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      const nonce = tm.pendingConsent?.nonce as string;
      expect(await tm.grantConsent(nonce)).toBe(true);
      expect(await tm.grantConsent(nonce)).toBe(false);
    });

    it('declineConsent applies the cross-episode cooldown and exhausts', async () => {
      const { tm, t2 } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      const nonce = tm.pendingConsent?.nonce as string;

      expect(tm.declineConsent(nonce)).toBe(true);
      expect(tm.pendingConsent).toBeNull();
      expect(tm.lifecycleState.lastState).toBe('exhausted');
      expect(tm.lifecycleState.consentCooldown.consecutiveRefusals).toBe(1);
      expect(tm.lifecycleState.consentCooldown.activeUntil).toBeGreaterThan(Date.now());
      expect(t2.startCalls).toBe(0);
    });

    it('declineConsent with a wrong nonce is rejected', async () => {
      const { tm } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      expect(tm.declineConsent('f'.repeat(32))).toBe(false);
      expect(tm.pendingConsent).not.toBeNull();
    });

    it('consent prompt times out into exhausted via consentTimeoutMs', async () => {
      const { tm } = consentSetup({ consentTimeoutMs: 25 });
      await expect(tm.start()).rejects.toThrow();
      expect(tm.pendingConsent).not.toBeNull();

      await new Promise((r) => setTimeout(r, 80));
      expect(tm.pendingConsent).toBeNull();
      expect(tm.lifecycleState.lastState).toBe('exhausted');
      expect(tm.lifecycleState.consentCooldown.consecutiveRefusals).toBe(1);
    });

    it('an active consent cooldown suppresses the next consent prompt', async () => {
      // Persist a live cooldown, then construct fresh — the new episode
      // must go straight to exhausted without offering the relay.
      const persisted: PersistedTunnelState = {
        version: 1,
        lastState: 'exhausted',
        lastUrl: null,
        activeProvider: null,
        rotationPending: false,
        consentCooldown: {
          consecutiveRefusals: 1,
          lastExtendedAt: Date.now(),
          activeUntil: Date.now() + 60 * 60_000,
        },
        episode: null,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(project.stateDir, 'tunnel.json'), JSON.stringify(persisted));

      const { tm } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      expect(tm.lifecycleState.lastState).toBe('exhausted');
      expect(tm.pendingConsent).toBeNull();
    });

    it('a relay that fails its reachability probe after grant refuses + exhausts', async () => {
      const { tm, t2 } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      const nonce = tm.pendingConsent?.nonce as string;

      fetchOk = false; // relay URL won't probe
      expect(await tm.grantConsent(nonce)).toBe(false);
      expect(tm.lifecycleState.lastState).toBe('exhausted');
      expect(tm.isRunning).toBe(false);
      expect(t2.handles[0]?.stopCalls).toBe(1); // unreachable relay torn down
      expect(tm.lifecycleState.consentCooldown.consecutiveRefusals).toBe(1);
    });

    it('a relay whose start() throws after grant refuses + exhausts', async () => {
      const { tm, t2 } = consentSetup();
      await expect(tm.start()).rejects.toThrow();
      const nonce = tm.pendingConsent?.nonce as string;

      t2.startImpl = async () => {
        throw new Error('localtunnel rate limit');
      };
      expect(await tm.grantConsent(nonce)).toBe(false);
      expect(tm.lifecycleState.lastState).toBe('exhausted');
    });
  });

  // ── Self-heal (relay-active → Tier-1 recovery) ───────────────────

  describe('self-heal', () => {
    /** Drive the manager into relay-active with a failing Tier-1. */
    async function relayActiveSetup() {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const t2 = new FakeProvider('localtunnel', 2, 'https://relay.example.test');
      const tm = createManager([t1, t2]);
      tm.disableAutoReconnect();
      const rotator = vi.fn(async () => {});
      tm.setCredentialRotator(rotator);

      await expect(tm.start()).rejects.toThrow();
      const nonce = tm.pendingConsent?.nonce as string;
      expect(await tm.grantConsent(nonce)).toBe(true);
      expect(tm.lifecycleState.lastState).toBe('relay-active');
      return { tm, t1, t2, rotator };
    }

    it('reports inactive when not relay-active', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      await tm.start();
      expect(await tm.runSelfHealCheck()).toBe('inactive');
    });

    it('a failing Tier-1 probe resets the stability counter', async () => {
      const { tm } = await relayActiveSetup();
      expect(await tm.runSelfHealCheck()).toBe('reset');
      expect(tm.lifecycleState.lastState).toBe('relay-active'); // relay keeps serving
    });

    it('switches back only after N consecutive Tier-1 successes', async () => {
      const { tm, t1, t2, rotator } = await relayActiveSetup();

      // Tier-1 recovers.
      t1.startImpl = async () => t1.makeHandle('https://recovered.example.test');

      expect(await tm.runSelfHealCheck()).toBe('progress'); // 1
      expect(tm.url).toBe('https://relay.example.test'); // still the relay
      expect(await tm.runSelfHealCheck()).toBe('progress'); // 2
      expect(await tm.runSelfHealCheck()).toBe('switched'); // 3 → promote

      expect(tm.lifecycleState.lastState).toBe('active');
      expect(tm.lifecycleState.activeProvider).toBe('cloudflare-quick');
      expect(tm.url).toBe('https://recovered.example.test');
      // The relay handle was torn down; the promoted handle was not.
      expect(t2.handles[0]?.stopCalls).toBe(1);
      const promoted = t1.handles[t1.handles.length - 1];
      expect(promoted?.stopCalls).toBe(0);
      // Terminal exit from the relay episode rotated credentials.
      expect(rotator).toHaveBeenCalledTimes(1);
      expect(tm.lifecycleState.rotationPending).toBe(false);
    });

    it('a failure between successes resets the consecutive count', async () => {
      const { tm, t1 } = await relayActiveSetup();

      t1.startImpl = async () => t1.makeHandle('https://recovered.example.test');
      expect(await tm.runSelfHealCheck()).toBe('progress'); // 1
      expect(await tm.runSelfHealCheck()).toBe('progress'); // 2

      t1.startImpl = async () => {
        throw new Error('network unreachable');
      };
      expect(await tm.runSelfHealCheck()).toBe('reset'); // back to 0

      t1.startImpl = async () => t1.makeHandle('https://recovered.example.test');
      expect(await tm.runSelfHealCheck()).toBe('progress'); // 1
      expect(await tm.runSelfHealCheck()).toBe('progress'); // 2
      expect(await tm.runSelfHealCheck()).toBe('switched'); // 3
    });

    it('probe handles from non-final successes are released', async () => {
      const { tm, t1 } = await relayActiveSetup();
      t1.startImpl = async () => t1.makeHandle('https://recovered.example.test');

      await tm.runSelfHealCheck(); // progress — throwaway probe tunnel
      const probeHandle = t1.handles[t1.handles.length - 1];
      expect(probeHandle?.stopCalls).toBe(1);
    });

    it('emits self-healed with the recovered provider + url', async () => {
      const { tm, t1 } = await relayActiveSetup();
      t1.startImpl = async () => t1.makeHandle('https://recovered.example.test');
      const events: Array<{ provider: string; url: string }> = [];
      tm.on('self-healed', (e: { provider: string; url: string }) => events.push(e));

      await tm.runSelfHealCheck();
      await tm.runSelfHealCheck();
      await tm.runSelfHealCheck();

      expect(events).toEqual([
        { provider: 'cloudflare-quick', url: 'https://recovered.example.test' },
      ]);
    });
  });

  // ── stop() ────────────────────────────────────────────────────────

  describe('stop', () => {
    it('stops the handle, clears state, returns to idle, emits stopped', async () => {
      const p1 = new FakeProvider('cloudflare-quick', 1, 'https://s.example.test');
      const tm = createManager([p1]);
      await tm.start();

      let stopped = false;
      tm.on('stopped', () => {
        stopped = true;
      });
      await tm.stop();

      expect(tm.isRunning).toBe(false);
      expect(tm.url).toBeNull();
      expect(tm.state.startedAt).toBeNull();
      expect(p1.handles[0]?.stopCalls).toBe(1);
      expect(tm.lifecycleState.lastState).toBe('idle');
      expect(stopped).toBe(true);
      expect(readPersisted().lastState).toBe('idle');
      expect(readPersisted().lastUrl).toBeNull();
    });

    it('is safe to call when not running', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      await expect(tm.stop()).resolves.toBeUndefined();
    });

    it('forceStop delegates to stop', async () => {
      const p1 = new FakeProvider('cloudflare-quick', 1, 'https://fs.example.test');
      const tm = createManager([p1]);
      await tm.start();
      await tm.forceStop();
      expect(tm.isRunning).toBe(false);
      expect(p1.handles[0]?.stopCalls).toBe(1);
    });

    it('clears a pending consent prompt', async () => {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const t2 = new FakeProvider('localtunnel', 2);
      const tm = createManager([t1, t2]);
      tm.disableAutoReconnect();
      await expect(tm.start()).rejects.toThrow();
      expect(tm.pendingConsent).not.toBeNull();

      await tm.stop();
      expect(tm.pendingConsent).toBeNull();
    });

    it('stopping a relay episode rotates credentials', async () => {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const t2 = new FakeProvider('localtunnel', 2, 'https://relay.example.test');
      const tm = createManager([t1, t2]);
      tm.disableAutoReconnect();
      const rotator = vi.fn(async () => {});
      tm.setCredentialRotator(rotator);

      await expect(tm.start()).rejects.toThrow();
      await tm.grantConsent(tm.pendingConsent?.nonce as string);
      expect(tm.lifecycleState.rotationPending).toBe(true);

      await tm.stop();
      expect(rotator).toHaveBeenCalledTimes(1);
      expect(tm.lifecycleState.rotationPending).toBe(false);
    });

    it('a plain (non-relay) stop does NOT rotate credentials', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      const rotator = vi.fn(async () => {});
      tm.setCredentialRotator(rotator);
      await tm.start();
      await tm.stop();
      expect(rotator).not.toHaveBeenCalled();
    });
  });

  // ── Credential rotation ───────────────────────────────────────────

  describe('credential rotation', () => {
    it('runCredentialRotation is a no-op when nothing is pending', async () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      const rotator = vi.fn(async () => {});
      tm.setCredentialRotator(rotator);
      expect(await tm.runCredentialRotation('test')).toBe(false);
      expect(rotator).not.toHaveBeenCalled();
    });

    it('a throwing rotator leaves the flag set for retry and emits rotation-failed', async () => {
      const t1 = new FakeProvider('cloudflare-quick', 1, new Error('network unreachable'));
      const t2 = new FakeProvider('localtunnel', 2, 'https://relay.example.test');
      const tm = createManager([t1, t2]);
      tm.disableAutoReconnect();
      tm.setCredentialRotator(async () => {
        throw new Error('keychain locked');
      });
      const failures: unknown[] = [];
      tm.on('rotation-failed', (e: unknown) => failures.push(e));

      await expect(tm.start()).rejects.toThrow();
      await tm.grantConsent(tm.pendingConsent?.nonce as string);

      expect(await tm.runCredentialRotation('test')).toBe(false);
      expect(tm.lifecycleState.rotationPending).toBe(true); // NOT cleared on failure
      expect(failures).toHaveLength(1);
    });

    it('recoverPendingRotation rotates at boot from a persisted relay episode', async () => {
      const persisted: PersistedTunnelState = {
        version: 1,
        lastState: 'relay-active',
        lastUrl: 'https://relay.example.test',
        activeProvider: 'localtunnel',
        rotationPending: true,
        consentCooldown: { consecutiveRefusals: 0, lastExtendedAt: 0, activeUntil: 0 },
        episode: null,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(project.stateDir, 'tunnel.json'), JSON.stringify(persisted));

      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      const rotator = vi.fn(async () => {});
      tm.setCredentialRotator(rotator);

      expect(await tm.recoverPendingRotation()).toBe(true);
      expect(rotator).toHaveBeenCalledTimes(1);
      expect(tm.lifecycleState.rotationPending).toBe(false);
      expect(readPersisted().rotationPending).toBe(false);
    });

    it('an unwired rotator clears the flag loudly instead of looping forever', async () => {
      const persisted: PersistedTunnelState = {
        version: 1,
        lastState: 'relay-active',
        lastUrl: null,
        activeProvider: 'localtunnel',
        rotationPending: true,
        consentCooldown: { consecutiveRefusals: 0, lastExtendedAt: 0, activeUntil: 0 },
        episode: null,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(project.stateDir, 'tunnel.json'), JSON.stringify(persisted));

      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      // No rotator wired.
      expect(await tm.recoverPendingRotation()).toBe(false);
      expect(tm.lifecycleState.rotationPending).toBe(false); // cleared, not looping
    });
  });

  // ── getExternalUrl ────────────────────────────────────────────────

  describe('getExternalUrl', () => {
    it('returns null when not connected', () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      expect(tm.getExternalUrl('/view/123')).toBeNull();
    });

    it('constructs the full URL from the tunnel base', async () => {
      const tm = createManager([
        new FakeProvider('cloudflare-quick', 1, 'https://abc.trycloudflare.com'),
      ]);
      await tm.start();
      expect(tm.getExternalUrl('/view/123')).toBe('https://abc.trycloudflare.com/view/123');
    });

    it('handles paths without a leading slash', async () => {
      const tm = createManager([
        new FakeProvider('cloudflare-quick', 1, 'https://abc.trycloudflare.com'),
      ]);
      await tm.start();
      expect(tm.getExternalUrl('health')).toBe('https://abc.trycloudflare.com/health');
    });

    it('strips a trailing slash from the base URL', async () => {
      const tm = createManager([
        new FakeProvider('cloudflare-quick', 1, 'https://abc.trycloudflare.com/'),
      ]);
      await tm.start();
      expect(tm.getExternalUrl('/health')).toBe('https://abc.trycloudflare.com/health');
    });
  });

  // ── state accessor ────────────────────────────────────────────────

  describe('state', () => {
    it('returns a copy, not a live reference', () => {
      const tm = createManager([new FakeProvider('cloudflare-quick', 1)]);
      const s1 = tm.state;
      const s2 = tm.state;
      expect(s1).not.toBe(s2);
      expect(s1).toEqual(s2);
    });
  });
});
