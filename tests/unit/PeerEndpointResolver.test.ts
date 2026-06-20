import { describe, it, expect } from 'vitest';
import {
  PeerEndpointResolver,
  PeerEndpointResolverConfig,
  MAX_ENDPOINTS,
  isTailscaleCgnat,
  isRfc1918,
  isForbiddenHost,
  isPublicHttps,
  ipv4ToInt,
  hostOf,
} from '../../src/core/PeerEndpointResolver.js';
import type { MeshEndpoint } from '../../src/core/types.js';

const TS = (ip = '100.64.165.27') => ({ kind: 'tailscale' as const, url: `http://${ip}:4042` });
const LAN = (ip = '192.168.87.10') => ({ kind: 'lan' as const, url: `http://${ip}:4042` });
const CF = (host = 'echo-mini.dawn-tunnel.dev') => ({ kind: 'cloudflare' as const, url: `https://${host}` });

function mkResolver(over: Partial<PeerEndpointResolverConfig> = {}, deps: { now?: () => number; ownCidrs?: () => string[] } = {}) {
  const config: PeerEndpointResolverConfig = {
    enabled: true,
    hedgeDelayMs: 1500,
    priorityTailscale: 10,
    priorityLan: 20,
    priorityCloudflare: 30,
    tailscaleEnabled: true,
    lanSubnetGate: true,
    unhealthyAfterFailures: 3,
    endpointEvictionMs: 3_600_000,
    maxProbeBackoffMs: 300_000,
    requestTimeoutMs: 30_000,
    ...over,
  };
  return new PeerEndpointResolver({ config, now: deps.now, ownCidrs: deps.ownCidrs ?? (() => ['192.168.87.67/24', '100.64.165.27/10']) });
}

describe('PeerEndpointResolver — host validation helpers', () => {
  it('isTailscaleCgnat accepts 100.64/10, rejects outside', () => {
    expect(isTailscaleCgnat('100.64.0.0')).toBe(true);
    expect(isTailscaleCgnat('100.94.220.125')).toBe(true);
    expect(isTailscaleCgnat('100.127.255.255')).toBe(true);
    expect(isTailscaleCgnat('100.128.0.1')).toBe(false);
    expect(isTailscaleCgnat('100.63.255.255')).toBe(false);
    expect(isTailscaleCgnat('192.168.1.1')).toBe(false);
  });
  it('isRfc1918 accepts 10/172.16/192.168, rejects CGNAT + public', () => {
    expect(isRfc1918('10.0.0.5')).toBe(true);
    expect(isRfc1918('172.16.4.9')).toBe(true);
    expect(isRfc1918('192.168.87.10')).toBe(true);
    expect(isRfc1918('100.64.0.1')).toBe(false); // CGNAT is not RFC-1918
    expect(isRfc1918('8.8.8.8')).toBe(false);
    expect(isRfc1918('172.32.0.1')).toBe(false); // just outside 172.16/12
  });
  it('isForbiddenHost rejects loopback, link-local, metadata, 0.0.0.0', () => {
    expect(isForbiddenHost('127.0.0.1')).toBe(true);
    expect(isForbiddenHost('localhost')).toBe(true);
    expect(isForbiddenHost('169.254.1.1')).toBe(true);
    expect(isForbiddenHost('169.254.169.254')).toBe(true);
    expect(isForbiddenHost('0.0.0.0')).toBe(true);
    expect(isForbiddenHost('192.168.1.1')).toBe(false);
    expect(isForbiddenHost('echo.dawn-tunnel.dev')).toBe(false);
  });
  it('isPublicHttps requires https + public DNS host', () => {
    expect(isPublicHttps('https://echo-mini.dawn-tunnel.dev')).toBe(true);
    expect(isPublicHttps('http://echo-mini.dawn-tunnel.dev')).toBe(false); // not https
    expect(isPublicHttps('https://192.168.1.1')).toBe(false); // ip literal
    expect(isPublicHttps('https://localhost')).toBe(false);
    expect(isPublicHttps('not a url')).toBe(false);
  });
  it('ipv4ToInt + hostOf', () => {
    expect(ipv4ToInt('1.2.3.4')).toBe(((1 << 24) | (2 << 16) | (3 << 8) | 4) >>> 0);
    expect(ipv4ToInt('256.0.0.1')).toBeNull();
    expect(hostOf('http://10.0.0.1:4042/x')).toBe('10.0.0.1');
    expect(hostOf('garbage')).toBeNull();
  });
});

describe('PeerEndpointResolver — resolve', () => {
  it('un-upgraded peer (no advertised) → single cloudflare from lastKnownUrl', () => {
    const r = mkResolver();
    const out = r.resolve('peerA', undefined, 'https://peer.dawn-tunnel.dev');
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('cloudflare');
    expect(out[0].url).toBe('https://peer.dawn-tunnel.dev');
  });

  it('orders tailscale < lan < cloudflare by priority when all healthy', () => {
    const r = mkResolver();
    // lastKnownUrl == the advertised cloudflare host (the real invariant) ⇒ dedupes to one cloudflare rope.
    const out = r.resolve('peerA', [CF('peer.dawn-tunnel.dev'), LAN(), TS()], 'https://peer.dawn-tunnel.dev');
    expect(out.map((e) => e.kind)).toEqual(['tailscale', 'lan', 'cloudflare']);
  });

  it('a divergent lastKnownUrl + advertised cloudflare yields two distinct cloudflare ropes (both valid, capped)', () => {
    const r = mkResolver();
    const out = r.resolve('peerA', [CF('a.dawn-tunnel.dev'), LAN(), TS()], 'https://b.dawn-tunnel.dev');
    expect(out.filter((e) => e.kind === 'cloudflare')).toHaveLength(2);
    expect(out.length).toBeLessThanOrEqual(MAX_ENDPOINTS);
  });

  it('drops a tailscale endpoint that is not in 100.64/10', () => {
    const r = mkResolver();
    const out = r.resolve('peerA', [{ kind: 'tailscale', url: 'http://10.0.0.9:4042' }, CF()], undefined);
    expect(out.map((e) => e.kind)).toEqual(['cloudflare']);
  });

  it('drops a lan endpoint on a DIFFERENT subnet (LAN-subnet gate)', () => {
    const r = mkResolver({}, { ownCidrs: () => ['192.168.87.67/24'] });
    const out = r.resolve('peerA', [LAN('10.1.2.3'), CF()], undefined);
    expect(out.map((e) => e.kind)).toEqual(['cloudflare']); // 10.1.2.3 not on our 192.168.87/24
  });

  it('keeps a lan endpoint on the SAME subnet', () => {
    const r = mkResolver({}, { ownCidrs: () => ['192.168.87.67/24'] });
    const out = r.resolve('peerA', [LAN('192.168.87.99'), CF()], undefined);
    expect(out.map((e) => e.kind)).toContain('lan');
  });

  it('lanSubnetGate=false dials any rfc1918 lan endpoint', () => {
    const r = mkResolver({ lanSubnetGate: false }, { ownCidrs: () => ['192.168.87.67/24'] });
    const out = r.resolve('peerA', [LAN('10.1.2.3'), CF()], undefined);
    expect(out.map((e) => e.kind)).toContain('lan');
  });

  it('tailscaleEnabled=false drops tailscale ropes', () => {
    const r = mkResolver({ tailscaleEnabled: false });
    const out = r.resolve('peerA', [TS(), CF()], undefined);
    expect(out.map((e) => e.kind)).toEqual(['cloudflare']);
  });

  it('rejects forbidden hosts (metadata / loopback) regardless of kind', () => {
    const r = mkResolver();
    const out = r.resolve('peerA', [{ kind: 'lan', url: 'http://169.254.169.254:4042' }, CF()], undefined);
    expect(out.map((e) => e.kind)).toEqual(['cloudflare']);
  });

  it('caps to MAX_ENDPOINTS by priority (drops the lowest-priority excess)', () => {
    const r = mkResolver();
    // 5 advertised + lastKnownUrl would be 6; cap to 4, keeping highest priority.
    const many: MeshEndpoint[] = [
      TS('100.64.0.1'),
      LAN('192.168.87.2'),
      CF('a.dawn-tunnel.dev'),
      CF('b.dawn-tunnel.dev'),
      CF('c.dawn-tunnel.dev'),
    ];
    const out = r.resolve('peerA', many, 'https://d.dawn-tunnel.dev');
    expect(out.length).toBe(MAX_ENDPOINTS);
    // tailscale + lan must survive (highest priority)
    expect(out.some((e) => e.kind === 'tailscale')).toBe(true);
    expect(out.some((e) => e.kind === 'lan')).toBe(true);
  });
});

describe('PeerEndpointResolver — health-driven ordering', () => {
  it('a dead rope (>= unhealthyAfterFailures) sinks behind a healthy lower-priority rope', () => {
    let t = 1_000_000;
    const r = mkResolver({}, { now: () => t });
    // Tailscale fails 3x → dead; cloudflare healthy. Order should put cloudflare first.
    for (let i = 0; i < 3; i++) r.recordResult('peerA', 'tailscale', false, 0);
    r.recordResult('peerA', 'cloudflare', true, 50);
    r.recordResult('peerA', 'cloudflare', true, 50);
    r.recordResult('peerA', 'cloudflare', true, 50); // earns last-known-good after hysteresis
    t += 1000; // not yet past probe backoff (5s) for the dead tailscale
    const out = r.resolve('peerA', [TS(), CF()], undefined);
    expect(out[0].kind).toBe('cloudflare');
    const ts = out.find((e) => e.kind === 'tailscale')!;
    expect(ts.dueForAttempt).toBe(false); // dead + not yet due for a probe
  });

  it('a dead rope becomes due-for-attempt again after exponential backoff', () => {
    let t = 1_000_000;
    const r = mkResolver({}, { now: () => t });
    for (let i = 0; i < 3; i++) r.recordResult('peerA', 'tailscale', false, 0);
    t += 6_000; // past the 5s base backoff
    const out = r.resolve('peerA', [TS(), CF()], undefined);
    const ts = out.find((e) => e.kind === 'tailscale')!;
    expect(ts.dueForAttempt).toBe(true);
  });

  it('last-known-good is earned only after recovery hysteresis (K=3 successes)', () => {
    let t = 1_000_000;
    const r = mkResolver({}, { now: () => t });
    r.recordResult('peerA', 'cloudflare', true, 50);
    expect(r.healthOf('peerA', 'cloudflare')!.lastKnownGood).toBe(false); // 1 success
    r.recordResult('peerA', 'cloudflare', true, 50);
    expect(r.healthOf('peerA', 'cloudflare')!.lastKnownGood).toBe(false); // 2
    r.recordResult('peerA', 'cloudflare', true, 50);
    expect(r.healthOf('peerA', 'cloudflare')!.lastKnownGood).toBe(true); // 3 ⇒ sticky
  });

  it('a slow-but-alive rope (EWMA latency > timeout/2) does NOT earn last-known-good', () => {
    let t = 1_000_000;
    const r = mkResolver({ requestTimeoutMs: 30_000 }, { now: () => t });
    // 20s latencies → EWMA quickly exceeds 15s (timeout/2)
    for (let i = 0; i < 6; i++) r.recordResult('peerA', 'tailscale', true, 20_000);
    expect(r.healthOf('peerA', 'tailscale')!.lastKnownGood).toBe(false);
  });

  it('a single failure clears last-known-good immediately', () => {
    const r = mkResolver();
    r.recordResult('peerA', 'cloudflare', true, 10);
    r.recordResult('peerA', 'cloudflare', true, 10);
    r.recordResult('peerA', 'cloudflare', true, 10);
    expect(r.healthOf('peerA', 'cloudflare')!.lastKnownGood).toBe(true);
    r.recordResult('peerA', 'cloudflare', false, 0);
    expect(r.healthOf('peerA', 'cloudflare')!.lastKnownGood).toBe(false);
    expect(r.healthOf('peerA', 'cloudflare')!.consecutiveFailures).toBe(1);
  });

  it('evicts health for an endpoint no longer advertised past the TTL', () => {
    let t = 1_000_000;
    const r = mkResolver({ endpointEvictionMs: 1000 }, { now: () => t });
    r.resolve('peerA', [TS(), CF()], undefined); // seeds tailscale + cloudflare health
    expect(r.healthOf('peerA', 'tailscale')).toBeDefined();
    t += 2000; // past eviction TTL
    r.resolve('peerA', [CF()], undefined); // tailscale no longer advertised
    expect(r.healthOf('peerA', 'tailscale')).toBeUndefined();
    expect(r.healthOf('peerA', 'cloudflare')).toBeDefined();
  });
});
