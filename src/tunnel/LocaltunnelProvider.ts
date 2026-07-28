/**
 * LocaltunnelProvider — Tier-2 consent-gated relay tunnel via *.loca.lt.
 *
 * Per spec specs/dev-infrastructure/tunnel-failure-resilience.md Part 1
 * (provider abstraction, Tier 2) and Part 7 (supply-chain hardening).
 *
 * SECURITY POSTURE:
 *   - localtunnel routes the agent's local server traffic through
 *     loca.lt servers. The relay operator (and anyone who logs the URL)
 *     can see dashboard PIN + signed view URLs while the relay is active.
 *     This is exactly why the spec gates Tier-2 providers behind owner
 *     consent — see Part 3 (consent flow) and Part 6 (mandatory
 *     credential rotation on relay-episode end).
 *   - The agent never spins this up without an explicit per-episode
 *     consent record bound to the owner principal — that's enforced in
 *     TunnelManager's state machine, not in this provider.
 *
 * Supply-chain hardening (Part 7):
 *   - The npm package `localtunnel` is pinned at exact version in
 *     package.json (no caret range).
 *   - The provider spawns the localtunnel client via its programmatic
 *     API; a future hardening PR can switch to child-process isolation
 *     once the spec's checksum-verified install path is added.
 *   - `isAvailable()` resolves false if the npm package cannot be
 *     loaded, so a missing dep degrades gracefully (provider skipped)
 *     instead of crashing.
 *
 * The provider does NOT own retry/reconnect/notification — those are
 * the manager's responsibility per the single-owner mandate (PR 2).
 */

import type {
  TunnelProvider,
  TunnelProviderHandle,
  ProviderName,
  ProviderTier,
} from './TunnelProvider.js';

export interface LocaltunnelProviderOptions {
  /** Local port the relay should point at. */
  port: number;
  /** Start timeout in milliseconds (default: 20_000). */
  startTimeoutMs?: number;
  /**
   * Optional subdomain hint passed to localtunnel. When set, the
   * service will try to allocate the requested name; when unavailable
   * (already taken or rate-limited), localtunnel falls back to a
   * random subdomain. NEVER use the agent's identity here — the
   * subdomain is publicly visible on *.loca.lt.
   */
  subdomain?: string;
}

/**
 * Minimal shape for the imported `localtunnel` module. The real
 * package exports a function; we import dynamically so test environments
 * (and agents without the dep installed) can detect-not-fail.
 */
interface LocaltunnelClient {
  url: string;
  close(): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

interface LocaltunnelModule {
  default?: (opts: { port: number; subdomain?: string }) => Promise<LocaltunnelClient>;
}

export class LocaltunnelProvider implements TunnelProvider {
  readonly name: ProviderName = 'localtunnel';
  readonly tier: ProviderTier = 2;

  private readonly port: number;
  private readonly startTimeoutMs: number;
  private readonly subdomain: string | undefined;
  /**
   * Cached dynamic-import result. The first `isAvailable()` call
   * detects whether the npm package is present; subsequent calls reuse
   * the cached resolution.
   */
  private _moduleResolved: LocaltunnelModule | 'unavailable' | undefined;

  constructor(opts: LocaltunnelProviderOptions) {
    this.port = opts.port;
    this.startTimeoutMs = opts.startTimeoutMs ?? 20_000;
    this.subdomain = opts.subdomain;
  }

  async isAvailable(): Promise<boolean> {
    const mod = await this.loadModule();
    return mod !== 'unavailable';
  }

  async start(localPort: number): Promise<TunnelProviderHandle> {
    const mod = await this.loadModule();
    if (mod === 'unavailable') {
      throw new Error('binary-missing: localtunnel npm package is not installed');
    }
    const lt = mod.default;
    if (typeof lt !== 'function') {
      throw new Error('binary-missing: localtunnel module did not expose the expected factory');
    }

    const port = localPort || this.port;

    return new Promise<TunnelProviderHandle>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        reject(new Error('timeout: localtunnel did not emit a URL within the start budget'));
      }, this.startTimeoutMs);

      lt({ port, subdomain: this.subdomain }).then(
        (client) => {
          if (resolved) {
            try { client.close(); } catch { /* best effort */ }
            return;
          }
          resolved = true;
          clearTimeout(timeout);

          if (!client.url) {
            reject(new Error('process-exit: localtunnel returned no URL'));
            return;
          }

          client.on('error', () => { /* swallow — handler is at manager level */ });

          resolve({
            url: client.url,
            stop: async () => {
              try { client.close(); } catch { /* already dead */ }
            },
          });
        },
        (err: Error) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          const msg = (err?.message ?? '').toLowerCase();
          if (msg.includes('rate') || msg.includes('429')) {
            reject(new Error(`rate-limited: localtunnel: ${err.message}`));
            return;
          }
          if (msg.includes('econnrefused') || msg.includes('dns')) {
            reject(new Error(`network: localtunnel: ${err.message}`));
            return;
          }
          reject(new Error(`process-exit: localtunnel start failed: ${err.message}`));
        },
      );
    });
  }

  private async loadModule(): Promise<LocaltunnelModule | 'unavailable'> {
    if (this._moduleResolved !== undefined) return this._moduleResolved;
    try {
      // Dynamic specifier so TypeScript doesn't require an installed
      // `@types/localtunnel`. The npm package itself is an optional
      // peer-style dep — agents without it installed degrade
      // gracefully via the catch below.
      const specifier = 'localtunnel';
      const mod = (await import(/* @vite-ignore */ specifier)) as LocaltunnelModule;
      this._moduleResolved = mod;
    } catch {
      this._moduleResolved = 'unavailable';
    }
    return this._moduleResolved;
  }
}
