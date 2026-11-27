/** Identity A4 point 4: what the computer can tell about its network (src/core/SameNetworkNetwork.ts). */
import { describe, it, expect } from 'vitest';
import { defaultRouteFromMacRoute, defaultRouteFromProcRoute, networkIdOf, observeNetwork, rangeOf, wslNatAddress } from '../../src/core/SameNetworkNetwork.js';

const PROC = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
  'eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  'wlan0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0',
].join('\n');
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
    expect(wslNatAddress(natRoute, ifaces('eth0', '172.25.237.197', '255.255.240.0')())).toBe('172.25.237.197');
    // Mirrored mode: the LAN's own address and router; never bound.
    expect(wslNatAddress(PROC.replace('0100000A', '0101A8C0'), ifaces('eth0', '192.168.1.20', '255.255.255.0')())).toBeNull();
    // A router outside the address's network: not provably NAT.
    expect(wslNatAddress(nat, ifaces('eth0', '172.25.237.197', '255.255.240.0')())).toBeNull();
  });

  it('macOS: observed through route and the interface table', async () => {
    const o = await observeNetwork({ platform: 'darwin', macRoute: async () => 'gateway: 192.168.1.1\ninterface: en0\n', interfaces: ifaces('en0', '192.168.1.20', '255.255.255.0') });
    expect(o).toEqual({ kind: 'observed', network: { iface: 'en0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } });
  });
});
