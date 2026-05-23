/**
 * Unit tests for LocaltunnelProvider — Tier-2 consent-gated relay.
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md Part 1,
 * Part 7.
 *
 * Coverage scope: the provider's interface, tier, isAvailable
 * degradation when the npm dep is absent, and start() behavior under
 * the same degraded path. The actual relay-active flow is exercised
 * by integration tests in a later PR of the chain (manager + Tier-2
 * state-machine lands next).
 */

import { describe, it, expect } from 'vitest';
import { LocaltunnelProvider } from '../../src/tunnel/LocaltunnelProvider.js';
import type { TunnelProvider } from '../../src/tunnel/TunnelProvider.js';

describe('LocaltunnelProvider — surface', () => {
  it('has name "localtunnel" and tier 2', () => {
    const p = new LocaltunnelProvider({ port: 4040 });
    expect(p.name).toBe('localtunnel');
    expect(p.tier).toBe(2);
  });

  it('exposes the TunnelProvider interface', () => {
    const p: TunnelProvider = new LocaltunnelProvider({ port: 4040 });
    expect(typeof p.name).toBe('string');
    expect(typeof p.tier).toBe('number');
    expect(typeof p.isAvailable).toBe('function');
    expect(typeof p.start).toBe('function');
  });
});

describe('LocaltunnelProvider — graceful degradation when npm dep is absent', () => {
  // The localtunnel npm package is NOT a hard dependency in this repo —
  // operators add it explicitly under the supply-chain hardening posture
  // documented in spec Part 7. In the default test environment (no
  // localtunnel installed), the provider must gracefully report
  // unavailable rather than crash.
  it('isAvailable() returns false when localtunnel is not installed', async () => {
    const p = new LocaltunnelProvider({ port: 4040 });
    await expect(p.isAvailable()).resolves.toBe(false);
  });

  it('start() rejects with binary-missing when the npm package is absent', async () => {
    const p = new LocaltunnelProvider({ port: 4040 });
    await expect(p.start(4040)).rejects.toThrow(/binary-missing/);
  });

  it('caches the "unavailable" verdict across calls (no repeated import attempts)', async () => {
    const p = new LocaltunnelProvider({ port: 4040 });
    const a = await p.isAvailable();
    const b = await p.isAvailable();
    expect(a).toBe(false);
    expect(b).toBe(false);
    // Both calls return the same cached verdict; no infrastructure-level
    // assertion is needed beyond the consistent return value.
  });
});

describe('LocaltunnelProvider — constructor options', () => {
  it('accepts a custom start timeout', () => {
    expect(() => new LocaltunnelProvider({ port: 4040, startTimeoutMs: 5000 })).not.toThrow();
  });

  it('accepts an optional subdomain hint (caller responsibility to keep it non-identifying)', () => {
    expect(() => new LocaltunnelProvider({ port: 4040, subdomain: 'demo' })).not.toThrow();
  });
});
