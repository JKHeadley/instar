import { describe, it, expect } from 'vitest';
import {
  detectTailscaleIp,
  pickPrimaryLanIp,
  computeSelfMeshEndpoints,
  endpointsEqual,
  advertiseSelfMeshEndpoints,
  resolveTailscaleBin,
  resolveMeshBindHost,
  type NetIfaces,
  type MeshUrlRecorder,
} from '../../src/core/MeshUrlAdvertiser.js';
import type { MeshEndpoint } from '../../src/core/types.js';

describe('detectTailscaleIp', () => {
  it('returns the 100.64/10 address from `tailscale ip -4`', async () => {
    const exec = (_f: string, _a: string[], cb: (e: Error | null, s: string) => void) => cb(null, '100.64.165.27\n');
    const ip = await detectTailscaleIp({ execFileFn: exec, bin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' });
    expect(ip).toBe('100.64.165.27');
  });
  it('rejects a non-CGNAT address (spoofed/unexpected)', async () => {
    const exec = (_f: string, _a: string[], cb: (e: Error | null, s: string) => void) => cb(null, '192.168.1.5\n');
    expect(await detectTailscaleIp({ execFileFn: exec, bin: 'tailscale' })).toBeNull();
  });
  it('takes only the FIRST line (multi-address output)', async () => {
    const exec = (_f: string, _a: string[], cb: (e: Error | null, s: string) => void) => cb(null, '100.64.165.27\nfd7a::1\n');
    expect(await detectTailscaleIp({ execFileFn: exec, bin: 'tailscale' })).toBe('100.64.165.27');
  });
  it('fails silent (null) on exec error', async () => {
    const exec = (_f: string, _a: string[], cb: (e: Error | null, s: string) => void) => cb(new Error('ENOENT'), '');
    expect(await detectTailscaleIp({ execFileFn: exec, bin: 'tailscale' })).toBeNull();
  });
  it('null bin ⇒ null (tailscale not present)', async () => {
    expect(await detectTailscaleIp({ bin: null })).toBeNull();
  });
});

describe('resolveTailscaleBin', () => {
  it('prefers the macOS app-bundle path when it exists', () => {
    const exists = (p: string) => p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    expect(resolveTailscaleBin(undefined, exists)).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  });
  it('falls back to the PATH name when no absolute path exists', () => {
    expect(resolveTailscaleBin(undefined, () => false)).toBe('tailscale');
  });
});

describe('pickPrimaryLanIp', () => {
  it('picks the first non-internal RFC-1918 IPv4 on an en*/eth* iface', () => {
    const ifaces: NetIfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '192.168.87.67', family: 'IPv4', internal: false },
      ],
    };
    expect(pickPrimaryLanIp(ifaces)).toBe('192.168.87.67');
  });
  it('skips a CGNAT (tailscale) address — that is the tailscale rope, not lan', () => {
    const ifaces: NetIfaces = {
      utun3: [{ address: '100.64.165.27', family: 'IPv4', internal: false }], // not en*/eth*
      en0: [{ address: '10.0.0.5', family: 4, internal: false }],
    };
    expect(pickPrimaryLanIp(ifaces)).toBe('10.0.0.5');
  });
  it('returns null when no private IPv4 present', () => {
    const ifaces: NetIfaces = { en0: [{ address: '8.8.8.8', family: 'IPv4', internal: false }] };
    expect(pickPrimaryLanIp(ifaces)).toBeNull();
  });
});

describe('computeSelfMeshEndpoints', () => {
  it('assembles all three ropes when present', () => {
    const out = computeSelfMeshEndpoints({
      cloudflareUrl: 'https://echo-mini.dawn-tunnel.dev',
      lanIp: '192.168.87.67',
      tailscaleIp: '100.64.165.27',
      port: 4042,
    });
    expect(out).toEqual([
      { kind: 'tailscale', url: 'http://100.64.165.27:4042' },
      { kind: 'lan', url: 'http://192.168.87.67:4042' },
      { kind: 'cloudflare', url: 'https://echo-mini.dawn-tunnel.dev' },
    ]);
  });
  it('omits absent ropes (cloudflare-only when no lan/tailscale)', () => {
    const out = computeSelfMeshEndpoints({ cloudflareUrl: 'https://x.dev', lanIp: null, tailscaleIp: null, port: 4042 });
    expect(out).toEqual([{ kind: 'cloudflare', url: 'https://x.dev' }]);
  });
  it('omits tailscale when tailscaleEnabled=false', () => {
    const out = computeSelfMeshEndpoints({
      cloudflareUrl: null,
      lanIp: '10.0.0.5',
      tailscaleIp: '100.64.0.9',
      port: 4042,
      tailscaleEnabled: false,
    });
    expect(out.map((e) => e.kind)).toEqual(['lan']);
  });
});

describe('advertiseSelfMeshEndpoints', () => {
  function mkRecorder(): MeshUrlRecorder & { written: MeshEndpoint[] | undefined } {
    let stored: MeshEndpoint[] | undefined;
    return {
      written: undefined,
      getMachineUrl: () => null,
      updateMachineUrl: () => {},
      getMachineEndpoints: () => stored,
      updateMachineEndpoints(_id, eps) {
        stored = eps;
        (this as { written?: MeshEndpoint[] }).written = eps;
      },
    };
  }
  const eps: MeshEndpoint[] = [{ kind: 'tailscale', url: 'http://100.64.0.1:4042' }];

  it('writes on first advertise, returns true', () => {
    const r = mkRecorder();
    expect(advertiseSelfMeshEndpoints(r, 'self', eps)).toBe(true);
    expect(r.written).toEqual(eps);
  });
  it('is idempotent (no re-write when unchanged)', () => {
    const r = mkRecorder();
    advertiseSelfMeshEndpoints(r, 'self', eps);
    expect(advertiseSelfMeshEndpoints(r, 'self', eps)).toBe(false);
  });
  it('no-op when the recorder does not support endpoints (un-upgraded)', () => {
    const r: MeshUrlRecorder = { getMachineUrl: () => null, updateMachineUrl: () => {} };
    expect(advertiseSelfMeshEndpoints(r, 'self', eps)).toBe(false);
  });
  it('endpointsEqual is order-independent', () => {
    expect(endpointsEqual([eps[0], { kind: 'lan', url: 'http://10.0.0.1:4042' }], [{ kind: 'lan', url: 'http://10.0.0.1:4042' }, eps[0]])).toBe(true);
    expect(endpointsEqual(eps, [])).toBe(false);
  });
});

describe('resolveMeshBindHost (1.3.630 bind-inert regression)', () => {
  // THE regression: loadConfig ALWAYS defaults host to '127.0.0.1', so a mesh-active
  // agent with no explicit host MUST still bind 0.0.0.0 — the bug was that the
  // loopback default shadowed the mesh default, leaving the server on 127.0.0.1.
  it('mesh-active + defaulted loopback host ⇒ 0.0.0.0 (the bug)', () => {
    expect(resolveMeshBindHost({ configHost: '127.0.0.1', meshBindActive: true })).toBe('0.0.0.0');
  });
  it('mesh-active + undefined host ⇒ 0.0.0.0', () => {
    expect(resolveMeshBindHost({ configHost: undefined, meshBindActive: true })).toBe('0.0.0.0');
  });
  it("mesh-active + 'localhost'/'::1' treated as loopback ⇒ 0.0.0.0", () => {
    expect(resolveMeshBindHost({ configHost: 'localhost', meshBindActive: true })).toBe('0.0.0.0');
    expect(resolveMeshBindHost({ configHost: '::1', meshBindActive: true })).toBe('0.0.0.0');
  });
  it('NOT mesh-active (single machine) ⇒ 127.0.0.1 (never newly exposed)', () => {
    expect(resolveMeshBindHost({ configHost: '127.0.0.1', meshBindActive: false })).toBe('127.0.0.1');
    expect(resolveMeshBindHost({ configHost: undefined, meshBindActive: false })).toBe('127.0.0.1');
  });
  it('explicit NON-loopback host wins over the mesh default', () => {
    expect(resolveMeshBindHost({ configHost: '192.168.1.50', meshBindActive: true })).toBe('192.168.1.50');
    expect(resolveMeshBindHost({ configHost: '0.0.0.0', meshBindActive: false })).toBe('0.0.0.0');
  });
  it('meshTransport.bindHost is the escape hatch (force loopback on a mesh agent)', () => {
    expect(resolveMeshBindHost({ configHost: '127.0.0.1', meshBindActive: true, meshBindHostOverride: '127.0.0.1' })).toBe('127.0.0.1');
  });
  it('explicit non-loopback host outranks bindHost override', () => {
    expect(resolveMeshBindHost({ configHost: '10.1.2.3', meshBindActive: true, meshBindHostOverride: '0.0.0.0' })).toBe('10.1.2.3');
  });
});
