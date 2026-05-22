/**
 * Unit tests for the TunnelProvider abstraction and the two Cloudflare
 * provider implementations.
 *
 * Strategy: this layer covers what can be asserted without spawning
 * cloudflared. The actual spawn → URL emit pathway is integration
 * territory (see tests/integration/tunnel-resilience-* in a later
 * commit). Here we lock in:
 *
 *   - The TunnelProvider interface shape — name/tier/isAvailable/start
 *     are present and have the right types/values.
 *   - CloudflareQuickProvider.name === 'cloudflare-quick', tier === 1.
 *   - CloudflareNamedProvider.name === 'cloudflare-named', tier === 1.
 *   - isAvailable() — quick is available whenever the cloudflared bin
 *     path resolves; named is unavailable without token AND without
 *     configFile, and unavailable when the configFile path doesn't
 *     exist.
 *   - Named-provider start() rejects with binary-missing when neither
 *     token nor configFile is configured.
 *   - Named-provider start() with a missing configFile rejects with
 *     binary-missing.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { CloudflareQuickProvider } from '../../src/tunnel/CloudflareQuickProvider.js';
import { CloudflareNamedProvider } from '../../src/tunnel/CloudflareNamedProvider.js';
import type { TunnelProvider } from '../../src/tunnel/TunnelProvider.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-providers-'));
}

describe('CloudflareQuickProvider', () => {
  it('has the cloudflare-quick name + tier 1', () => {
    const p = new CloudflareQuickProvider({ port: 4040, stateDir: tmpdir() });
    expect(p.name).toBe('cloudflare-quick');
    expect(p.tier).toBe(1);
  });

  it('exposes the TunnelProvider interface (name, tier, isAvailable, start)', () => {
    const p: TunnelProvider = new CloudflareQuickProvider({ port: 4040, stateDir: tmpdir() });
    expect(typeof p.name).toBe('string');
    expect(typeof p.tier).toBe('number');
    expect(typeof p.isAvailable).toBe('function');
    expect(typeof p.start).toBe('function');
  });

  it('isAvailable returns true when the cloudflared bin path is resolvable', async () => {
    const p = new CloudflareQuickProvider({ port: 4040, stateDir: tmpdir() });
    await expect(p.isAvailable()).resolves.toBe(true);
  });
});

describe('CloudflareNamedProvider', () => {
  it('has the cloudflare-named name + tier 1', () => {
    const p = new CloudflareNamedProvider({});
    expect(p.name).toBe('cloudflare-named');
    expect(p.tier).toBe(1);
  });

  it('isAvailable returns false when neither token nor configFile is configured', async () => {
    const p = new CloudflareNamedProvider({});
    await expect(p.isAvailable()).resolves.toBe(false);
  });

  it('isAvailable returns false when the configFile path does not exist', async () => {
    const p = new CloudflareNamedProvider({ configFile: '/no/such/path/cloudflared.yml' });
    await expect(p.isAvailable()).resolves.toBe(false);
  });

  it('isAvailable returns true when a token is configured', async () => {
    const p = new CloudflareNamedProvider({ token: 'fake-token', hostname: 'example.tld' });
    await expect(p.isAvailable()).resolves.toBe(true);
  });

  it('isAvailable returns true when the configFile path exists', async () => {
    const dir = tmpdir();
    const configFile = path.join(dir, 'cloudflared.yml');
    fs.writeFileSync(configFile, 'tunnel: test\n');
    const p = new CloudflareNamedProvider({ configFile, hostname: 'example.tld' });
    await expect(p.isAvailable()).resolves.toBe(true);
  });

  it('start() rejects with binary-missing when neither token nor configFile is configured', async () => {
    const p = new CloudflareNamedProvider({});
    await expect(p.start(4040)).rejects.toThrow(/binary-missing/);
  });

  it('start() rejects with binary-missing when configFile path does not exist', async () => {
    const p = new CloudflareNamedProvider({ configFile: '/no/such/path/cloudflared.yml', hostname: 'example.tld' });
    await expect(p.start(4040)).rejects.toThrow(/binary-missing/);
  });
});
