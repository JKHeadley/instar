/** SEC-139: the relay's registry rate-limit maps stay bounded, and the caller-address setting is wired. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayServer } from '../../../../src/threadline/relay/RelayServer.js';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';

type Limiter = { checkRegistryRateLimit(p: string, m: string, ip: string, k: string | undefined, a: boolean): boolean; registryRateLimits: Map<string, unknown> };

const dirs: string[] = [];
const make = (cfg: Record<string, unknown> = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec139-relay-'));
  dirs.push(dir);
  return new RelayServer({ host: '127.0.0.1', port: 0, registryDataDir: dir, ...cfg });
};
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/threadline/relay/relay-registry-rate-bounded.test.ts' });
});

describe('registry rate limits (SEC-139)', () => {
  it('expired per-address entries are swept, an active limit still holds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    const relay = make() as unknown as Limiter;
    for (let i = 0; i < 500; i++) relay.checkRegistryRateLimit('/v1/registry/search', 'GET', `10.2.${i >> 8}.${i & 255}`, undefined, false);
    for (let i = 0; i < 30; i++) relay.checkRegistryRateLimit('/v1/registry/search', 'GET', '203.0.113.9', undefined, false);
    expect(relay.checkRegistryRateLimit('/v1/registry/search', 'GET', '203.0.113.9', undefined, false)).toBe(false);
    expect(relay.registryRateLimits.size).toBe(501);
    vi.setSystemTime(new Date('2026-11-20T00:01:01Z'));
    relay.checkRegistryRateLimit('/v1/registry/search', 'GET', '192.0.2.1', undefined, false);
    expect(relay.registryRateLimits.size).toBe(1);
  });

  it('keeps at most MAX_REGISTRY_RATE_KEYS entries', () => {
    const relay = make() as unknown as Limiter;
    for (let i = 0; i < RelayServer.MAX_REGISTRY_RATE_KEYS + 200; i++) {
      relay.checkRegistryRateLimit('/v1/registry/search', 'GET', `2001:db8::${i.toString(16)}`, undefined, false);
    }
    expect(relay.registryRateLimits.size).toBeLessThanOrEqual(RelayServer.MAX_REGISTRY_RATE_KEYS);
  });
});

describe('caller-address setting wiring (SEC-139)', () => {
  it('passes the configured header to the A2A bridge, and defaults to none', () => {
    const configured = make({ clientAddressHeader: 'fly-client-ip' }) as unknown as { a2aBridge: { config: { clientAddressHeader: string } } };
    expect(configured.a2aBridge.config.clientAddressHeader).toBe('fly-client-ip');
    const plain = make() as unknown as { a2aBridge: { config: { clientAddressHeader: string } }; config: { clientAddressHeader: string } };
    expect(plain.config.clientAddressHeader).toBe('');
    expect(plain.a2aBridge.config.clientAddressHeader).toBe('');
  });
  it('the Fly deployment names fly-client-ip', () => {
    expect(fs.readFileSync(path.join(process.cwd(), 'fly.toml'), 'utf8')).toMatch(/^\s*RELAY_CLIENT_IP_HEADER = "fly-client-ip"$/m);
    expect(fs.readFileSync(path.join(process.cwd(), 'src/commands/relay.ts'), 'utf8')).toContain('clientAddressHeader: process.env.RELAY_CLIENT_IP_HEADER');
  });
});
