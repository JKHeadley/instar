/** Identity A4 point 4: what the computer can tell about its network (src/core/SameNetworkNetwork.ts). */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { defaultRouteFromMacRoute, defaultRouteFromProcRoute, networkIdOf, observeNetwork, rangeOf, rfc1918Block, isWslNatAdapter, wslNatAddress } from '../../src/core/SameNetworkNetwork.js';

const PROC = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
  'eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  'wlan0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0',
].join('\n');
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const hvNetvsc = () => true; // the interface is WSL's own NAT adapter (hv_netvsc); see the isWslNatAdapter tests
const ifaces = (iface: string, address: string, netmask: string) => () => ({ [iface]: [{ address, netmask, family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', cidr: null }] }) as never;

describe('same-network network observation', () => {
  it('reads the lowest-metric default route from /proc/net/route', () => {
    expect(defaultRouteFromProcRoute(PROC)).toEqual({ iface: 'eth0', router: '10.0.0.1' });
    expect(defaultRouteFromProcRoute('Iface\tDestination\n')).toBeNull();
  });

  it('skips a default route that is down or has no router flag, and one with a non-zero mask', () => {
    const t = ['Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t0100000A\t0001\t0\t0\t100\t00000000\t0\t0\t0',
      'eth1\t00000000\t0200000A\t0003\t0\t0\t100\t00FFFFFF\t0\t0\t0',
      'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0'].join('\n');
    expect(defaultRouteFromProcRoute(t)).toEqual({ iface: 'wlan0', router: '192.168.1.1' });
  });

  it('reads macOS `route -n get default`', () => {
    expect(defaultRouteFromMacRoute('   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n')).toEqual({ iface: 'en0', router: '192.168.1.1' });
    expect(defaultRouteFromMacRoute('route: writing to routing socket: not in table')).toBeNull();
  });

  it('computes the address range, and refuses a non-contiguous netmask', () => {
    expect(rangeOf('192.168.1.20', '255.255.255.0')).toBe('192.168.1.0/24');
    expect(rangeOf('10.1.2.3', '255.255.0.0')).toBe('10.1.0.0/16');
    expect(rangeOf('10.1.2.3', '255.0.255.0')).toBeNull();
  });

  it('Linux: observed from the default route and that interface', async () => {
    const o = await observeNetwork({ platform: 'linux', wsl: false, readFile: () => PROC, interfaces: ifaces('eth0', '10.0.0.7', '255.255.255.0') });
    expect(o).toEqual({ kind: 'observed', network: { iface: 'eth0', router: '10.0.0.1', address: '10.0.0.7', range: '10.0.0.0/24' } });
    if (o.kind === 'observed') expect(networkIdOf(o.network)).toBe('eth0|10.0.0.1|10.0.0.0/24');
  });

  it('WSL: the agent sees none of the PC\'s networks; the Windows app observes', async () => {
    expect(await observeNetwork({ platform: 'linux', wsl: true })).toEqual({ kind: 'delegated', observer: 'windows-app' });
  });

  it('unknown when anything cannot be read: no route, no address, two addresses, an unread platform', async () => {
    expect((await observeNetwork({ platform: 'linux', wsl: false, readFile: () => 'Iface\n', interfaces: ifaces('eth0', '10.0.0.7', '255.255.255.0') })).kind).toBe('unknown');
    expect((await observeNetwork({ platform: 'linux', wsl: false, readFile: () => PROC, interfaces: () => ({}) as never })).kind).toBe('unknown');
    const two = () => ({ eth0: [
      { address: '10.0.0.7', netmask: '255.255.255.0', family: 'IPv4', internal: false },
      { address: '10.0.0.8', netmask: '255.255.255.0', family: 'IPv4', internal: false },
    ] }) as never;
    expect((await observeNetwork({ platform: 'linux', wsl: false, readFile: () => PROC, interfaces: two })).kind).toBe('unknown');
    expect((await observeNetwork({ platform: 'win32' })).kind).toBe('unknown');
    expect((await observeNetwork({ platform: 'darwin', macRoute: async () => { throw new Error('no route'); }, interfaces: () => ({}) as never })).kind).toBe('unknown');
  });

  it('WSL: binds to its own NAT address only in NAT mode (measured live: WSL loopback is not reachable from Windows)', () => {
    const nat = ['Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t01E01910\t0003\t0\t0\t0\t00000000\t0\t0\t0'].join('\n'); // router 16.25.224.1: outside the address's network
    const natRoute = ['Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t01E019AC\t0003\t0\t0\t0\t00000000\t0\t0\t0'].join('\n'); // 172.25.224.1
    expect(wslNatAddress(natRoute, ifaces('eth0', '172.25.237.197', '255.255.240.0')(), hvNetvsc)).toBe('172.25.237.197');
    // Mirrored mode on a 192.168.x home LAN has the same SHAPE now that every RFC 1918 block is accepted:
    // the shape check is not the protection. wslBindPlan binds it only when NAT mode was READ (see
    // same-network-wsl-mode.test.ts, "mirrored ... is never bound on the LAN address").
    expect(wslNatAddress(PROC.replace('0100000A', '0101A8C0'), ifaces('eth0', '192.168.1.20', '255.255.255.0')(), hvNetvsc)).toBe('192.168.1.20');
    // A router outside the address's network: not provably NAT.
    expect(wslNatAddress(nat, ifaces('eth0', '172.25.237.197', '255.255.240.0')(), hvNetvsc)).toBeNull();
  });

  it('WSL NAT shape: any RFC 1918 block, with the router in the same block and subnet (found live 2026-11-26)', () => {
    const route = (gwHexLE: string) => ['Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      `eth0\t00000000\t${gwHexLE}\t0003\t0\t0\t0\t00000000\t0\t0\t0`].join('\n');
    // The failing case from the Windows 11 VM: the host on 172.24.x, so WSL took 192.168.144.0/20.
    expect(wslNatAddress(route('0190A8C0'), ifaces('eth0', '192.168.150.7', '255.255.240.0')(), hvNetvsc)).toBe('192.168.150.7'); // gw 192.168.144.1
    // A 10.x NAT network.
    expect(wslNatAddress(route('0100000A'), ifaces('eth0', '10.0.3.9', '255.255.0.0')(), hvNetvsc)).toBe('10.0.3.9'); // gw 10.0.0.1, both in 10.0.0.0/16
    // Router in a different RFC 1918 block from the address: not this interface's NAT network.
    expect(wslNatAddress(route('01E019AC'), ifaces('eth0', '192.168.150.7', '255.255.240.0')(), hvNetvsc)).toBeNull(); // gw 172.25.224.1
    // Only the same-block rule refuses this one: with netmask 128.0.0.0 both sit in 128.0.0.0/1.
    expect(wslNatAddress(route('01E019AC'), ifaces('eth0', '192.168.150.7', '128.0.0.0')(), hvNetvsc)).toBeNull(); // gw 172.25.224.1
    expect(wslNatAddress(route('01E019AC'), ifaces('eth0', '192.168.150.7', '0.0.0.0')(), hvNetvsc)).toBeNull();
    // Same block, different subnet: refused.
    expect(wslNatAddress(route('0101A8C0'), ifaces('eth0', '192.168.150.7', '255.255.240.0')(), hvNetvsc)).toBeNull(); // gw 192.168.1.1
    // Public addresses are never a NAT address, whatever the router.
    expect(wslNatAddress(route('01004064'), ifaces('eth0', '100.64.0.9', '255.192.0.0')(), hvNetvsc)).toBeNull(); // CGNAT 100.64.0.1
    expect(wslNatAddress(route('01020308'), ifaces('eth0', '8.3.2.9', '255.255.255.0')(), hvNetvsc)).toBeNull(); // 8.3.2.1
    // Exactly one IPv4 address on the default-route interface.
    const two = () => ({ eth0: [
      { address: '192.168.150.7', netmask: '255.255.240.0', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', cidr: null },
      { address: '192.168.150.8', netmask: '255.255.240.0', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', cidr: null },
    ] }) as never;
    expect(wslNatAddress(route('0190A8C0'), two(), hvNetvsc)).toBeNull();
  });

  it('WSL NAT bind needs a POSITIVE adapter identification: a VPN owning the default route is never bound (identity 163a07b2)', () => {
    const route = (iface: string, gwHexLE: string) => ['Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      `${iface}\t00000000\t${gwHexLE}\t0003\t0\t0\t0\t00000000\t0\t0\t0`].join('\n');
    const onlyEth0 = (iface: string) => iface === 'eth0';
    // A VPN inside WSL that took the default route, in a broadened range (10.8.0.2 via 10.8.0.1) ...
    expect(wslNatAddress(route('tun0', '0100080A'), ifaces('tun0', '10.8.0.2', '255.255.255.0')(), onlyEth0)).toBeNull();
    // ... in 192.168/16 ...
    expect(wslNatAddress(route('tun0', '0100A8C0'), ifaces('tun0', '192.168.0.2', '255.255.255.0')(), onlyEth0)).toBeNull();
    // ... and in the old 172.16/12 range (172.30.0.2 via 172.30.0.1), which the first build would have bound.
    expect(wslNatAddress(route('tun0', '01001EAC'), ifaces('tun0', '172.30.0.2', '255.255.255.0')(), onlyEth0)).toBeNull();
    // The same shape on the identified adapter is bound.
    expect(wslNatAddress(route('eth0', '01001EAC'), ifaces('eth0', '172.30.0.2', '255.255.255.0')(), onlyEth0)).toBe('172.30.0.2');
    // Unknown adapter (no positive identification): closed.
    expect(wslNatAddress(route('eth0', '01001EAC'), ifaces('eth0', '172.30.0.2', '255.255.255.0')(), () => false)).toBeNull();
  });

  it('isWslNatAdapter: true only for the ONE Hyper-V NIC (driver hv_netvsc)', () => {
    const links: Record<string, string> = {
      '/sys/class/net/eth0/device/driver': '/sys/bus/vmbus/drivers/hv_netvsc',
      '/sys/class/net/eth1/device/driver': '/sys/bus/pci/drivers/e1000e',
    };
    const realpath = (p: string) => { const r = links[p]; if (!r) throw enoent(); return r; };
    const list = () => ['lo', 'eth0', 'eth1', 'tun0', 'wg0'];
    expect(isWslNatAdapter('eth0', realpath, list)).toBe(true);
    expect(isWslNatAdapter('eth1', realpath, list)).toBe(false); // another driver
    expect(isWslNatAdapter('tun0', realpath, list)).toBe(false); // tunnels have no device link
    expect(isWslNatAdapter('wg0', realpath, list)).toBe(false);
    // A second Hyper-V NIC makes ownership ambiguous: closed for both.
    const two = { ...links, '/sys/class/net/eth2/device/driver': '/sys/bus/vmbus/drivers/hv_netvsc' };
    const realpath2 = (p: string) => { const r = two[p]; if (!r) throw enoent(); return r; };
    expect(isWslNatAdapter('eth0', realpath2, () => ['eth0', 'eth2'])).toBe(false);
    expect(isWslNatAdapter('eth2', realpath2, () => ['eth0', 'eth2'])).toBe(false);
    // An EXPECTED absent device link (ENOENT) on another interface means "not Hyper-V"; an UNEXPECTED read
    // error on another interface means uniqueness cannot be established: closed.
    const flaky = (p: string) => { if (p === '/sys/class/net/eth9/device/driver') throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return realpath(p); };
    expect(isWslNatAdapter('eth0', flaky, () => ['eth0', 'tun0'])).toBe(true);
    expect(isWslNatAdapter('eth0', flaky, () => ['eth0', 'eth9'])).toBe(false);
    expect(isWslNatAdapter('eth0', realpath, () => ['eth0', 'bad/name'])).toBe(false);
    // The interface list cannot be read: not provably the only one, closed.
    expect(isWslNatAdapter('eth0', realpath, () => { throw new Error('EACCES'); })).toBe(false);
    for (const bad of ['', '.', '..', '../eth0', 'eth0/../../x', 'a'.repeat(16), 'eth 0']) expect(isWslNatAdapter(bad, () => '/sys/bus/vmbus/drivers/hv_netvsc', () => [bad])).toBe(false);
    expect(isWslNatAdapter('eth0', () => { throw new Error('EACCES'); }, list)).toBe(false);
  });

  it('wslNatAddress uses the real adapter check by default (reads /sys at call time)', () => {
    const realpath = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: string) => {
      if (p === '/sys/class/net/eth0/device/driver') return '/sys/bus/vmbus/drivers/hv_netvsc';
      throw enoent();
    }) as never);
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation((() => ['lo', 'eth0']) as never);
    try {
      const route = ['Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
        'eth0\t00000000\t0190A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0'].join('\n');
      expect(wslNatAddress(route, ifaces('eth0', '192.168.150.7', '255.255.240.0')())).toBe('192.168.150.7');
      expect(realpath).toHaveBeenCalled();
      const tunRoute = route.replace(/^eth0/m, 'tun0').replace('\neth0', '\ntun0');
      expect(wslNatAddress(tunRoute, ifaces('tun0', '192.168.150.7', '255.255.240.0')())).toBeNull();
    } finally {
      realpath.mockRestore();
      readdir.mockRestore();
    }
  });

  it('rfc1918Block names the block and refuses everything else', () => {
    expect(rfc1918Block('10.255.0.1')).toBe('10/8');
    expect(rfc1918Block('172.16.0.1')).toBe('172.16/12');
    expect(rfc1918Block('172.31.255.254')).toBe('172.16/12');
    expect(rfc1918Block('192.168.0.1')).toBe('192.168/16');
    for (const ip of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '100.64.0.1', '169.254.1.1', '127.0.0.1', '256.1.1.1', '10.0.0', '10.0.0.1.2', 'a.b.c.d', '']) {
      expect(rfc1918Block(ip)).toBeNull();
    }
  });

  it('macOS: observed through route and the interface table', async () => {
    const o = await observeNetwork({ platform: 'darwin', macRoute: async () => 'gateway: 192.168.1.1\ninterface: en0\n', interfaces: ifaces('en0', '192.168.1.20', '255.255.255.0') });
    expect(o).toEqual({ kind: 'observed', network: { iface: 'en0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } });
  });
});
