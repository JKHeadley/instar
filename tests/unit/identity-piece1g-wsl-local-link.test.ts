/**
 * identity-security-piece1g: the one-time local link from a Windows browser to an agent in WSL.
 * Spec: docs/specs/identity-security-piece1g-wsl-local-link.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { arpMacFor, defaultRouteInterface, inCidr, natModeConfirmed, wslGatewayPeer, type WslNetProbe } from '../../src/core/wslLocalPeer.js';
import { LocalAccessService, WSL_GATEWAY_PER_MINUTE } from '../../src/server/localAccessRoutes.js';
import { runningUnderWsl } from '../../src/commands/dashboardOpen.js';

// Gateway 172.22.96.1 on eth0 (little-endian hex 0160 16AC = 01 60 16 AC).
const ROUTE = 'Iface\tDestination\tGateway\tFlags\nlo\t0000007F\t00000000\t0001\neth0\t00000000\t016016AC\t0003\neth0\t006016AC\t00000000\t0001\n';
const ARP = 'IP address       HW type     Flags       HW address            Mask     Device\n172.22.96.1      0x1         0x2         00:15:5d:7a:01:02     *        eth0\n';

function probe(over: Partial<WslNetProbe> = {}): WslNetProbe {
  return {
    isWsl: () => true,
    routeTable: () => ROUTE,
    arpTable: () => ARP,
    ifaceV4: (n) => (n === 'eth0' ? [{ address: '172.22.96.135', cidr: '172.22.96.135/20' }] : []),
    networkingMode: () => 'nat',
    ...over,
  };
}
const GW = { remoteAddress: '172.22.96.1', localAddress: '172.22.96.135' };

describe('parsing', () => {
  it('reads the default-route interface, the ARP MAC and subnets', () => {
    expect(defaultRouteInterface(ROUTE)).toBe('eth0');
    expect(arpMacFor(ARP, '172.22.96.1')).toBe('00:15:5d:7a:01:02');
    expect(inCidr('172.22.96.1', '172.22.96.135/20')).toBe(true);
    expect(inCidr('172.22.112.1', '172.22.96.135/20')).toBe(false);
    expect(inCidr('10.0.0.1', null)).toBe(false);
  });
});

describe('NAT mode is confirmed positively', () => {
  it('wslinfo nat → yes; mirrored → no; unknown → the Hyper-V MAC decides', () => {
    expect(natModeConfirmed(probe(), '172.22.96.1')).toBe(true);
    expect(natModeConfirmed(probe({ networkingMode: () => 'mirrored' }), '172.22.96.1')).toBe(false);
    expect(natModeConfirmed(probe({ networkingMode: () => null }), '172.22.96.1')).toBe(true);
    expect(natModeConfirmed(probe({ networkingMode: () => null, arpTable: () => ARP.replace('00:15:5d', 'a4:83:e7') }), '172.22.96.1')).toBe(false);
    expect(natModeConfirmed(probe({ networkingMode: () => null, arpTable: () => { throw new Error('no'); } }), '172.22.96.1')).toBe(false);
  });
});

describe('the gateway peer rule', () => {
  it('accepts the exact gateway on WSL\'s own default-route address', () => {
    expect(wslGatewayPeer(GW, probe())).toBe(true);
    expect(wslGatewayPeer({ remoteAddress: '::ffff:172.22.96.1', localAddress: '::ffff:172.22.96.135' }, probe())).toBe(true);
  });
  it('refuses everything else', () => {
    expect(wslGatewayPeer(GW, probe({ isWsl: () => false }))).toBe(false);
    expect(wslGatewayPeer({ ...GW, remoteAddress: '172.22.96.7' }, probe())).toBe(false); // not the gateway
    expect(wslGatewayPeer({ ...GW, localAddress: '127.0.0.1' }, probe())).toBe(false); // not WSL's own address
    expect(wslGatewayPeer(GW, probe({ ifaceV4: () => [{ address: '172.22.96.135', cidr: '172.22.0.0/30' }] }))).toBe(false); // gateway outside the subnet
    expect(wslGatewayPeer(GW, probe({ networkingMode: () => 'mirrored' }))).toBe(false);
    expect(wslGatewayPeer(GW, probe({ routeTable: () => { throw new Error('unreadable'); } }))).toBe(false);
  });
});

describe('the route guard', () => {
  function service(gateway: boolean): LocalAccessService {
    let t = 1_000_000;
    return new LocalAccessService({ enabled: () => true, wslGatewayPeer: () => gateway, now: () => t++ } as never);
  }
  const req = (remoteAddress: string, localAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress, localAddress }, headers }) as never;

  it('loopback is accepted as before; the gateway only through the WSL rule and without forwarding headers', () => {
    expect(service(false).redeemPeer(req('127.0.0.1', '127.0.0.1'))).toBe(true);
    expect(service(false).redeemPeer(req('172.22.96.1', '172.22.96.135'))).toBe(false);
    expect(service(true).redeemPeer(req('172.22.96.1', '172.22.96.135'))).toBe(true);
    expect(service(true).redeemPeer(req('172.22.96.1', '172.22.96.135', { 'x-forwarded-for': '1.2.3.4' }))).toBe(false);
  });

  it('the gateway is capped per minute, and the cap never blocks loopback', () => {
    const s = service(true);
    for (let i = 0; i < WSL_GATEWAY_PER_MINUTE; i++) expect(s.redeemPeer(req('172.22.96.1', '172.22.96.135'))).toBe(true);
    expect(s.redeemPeer(req('172.22.96.1', '172.22.96.135'))).toBe(false);
    expect(s.redeemPeer(req('127.0.0.1', '127.0.0.1'))).toBe(true);
  });
});

describe('the command', () => {
  it('knows when it runs inside WSL', () => {
    expect(runningUnderWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, () => '')).toBe(true);
    expect(runningUnderWsl({}, () => 'Linux version 6.6 (microsoft-standard-WSL2)')).toBe(true);
    expect(runningUnderWsl({}, () => 'Linux version 6.8 generic')).toBe(false);
    expect(runningUnderWsl({}, () => { throw new Error('none'); })).toBe(false);
  });
});

describe('the mounted routes (gateway peer)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/identity-piece1g-wsl-local-link.test.ts' }); });

  /** Mount on a stub app that collects handlers, so routes are called with exact socket addresses. */
  function mounted() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1g-routes-'));
    const dashboardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1g-dash-'));
    dirs.push(stateDir, dashboardDir);
    fs.writeFileSync(path.join(dashboardDir, 'local-access-open.js'), '// test');
    const svc = new LocalAccessService({
      stateDir, dashboardDir, agentName: () => 'proof', enabled: () => true,
      boundAddress: () => ({ address: '0.0.0.0', family: 'IPv4', port: 4040 }),
      wslGatewayPeer: (sock) => String(sock.remoteAddress).replace(/^::ffff:/, '') === '172.22.96.1',
    });
    const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
    const app = { get: (p: string, ...h: Array<(req: unknown, res: unknown) => unknown>) => routes.set(`GET ${p}`, h[h.length - 1]), post: (p: string, ...h: Array<(req: unknown, res: unknown) => unknown>) => routes.set(`POST ${p}`, h[h.length - 1]), use: () => undefined };
    svc.mount(app as never);
    return { svc, routes };
  }
  const call = (handler: ((req: unknown, res: unknown) => unknown) | undefined, remote: string, local: string, headers: Record<string, string> = {}, body: unknown = {}) => {
    const out: { status: number; body?: unknown } = { status: 200 };
    const res = { setHeader: () => undefined, status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; }, type() { return res; }, send(b: unknown) { out.body = b; return res; }, sendFile() { return res; }, end() { return res; } };
    handler?.({ socket: { remoteAddress: remote, localAddress: local, localPort: 4040 }, headers: { host: '127.0.0.1:4040', ...headers }, body }, res);
    return out;
  };
  const route = (routes: Map<string, (req: unknown, res: unknown) => unknown>, suffix: string) => [...routes.entries()].find(([k]) => k.endsWith(suffix))?.[1];

  it('the gateway can never mint; loopback still reaches the mint checks', () => {
    const { routes } = mounted();
    const mint = route(routes, '/mint');
    expect(mint).toBeTruthy();
    expect(call(mint, '172.22.96.1', '172.22.96.135', {}, { browserPort: 4040 }).status).toBe(404);
    expect(call(mint, '127.0.0.1', '127.0.0.1', {}, { browserPort: 4040 }).status).not.toBe(404);
  });

  it('the open page answers the gateway, but not with a forwarding header, and not a stranger peer', () => {
    const { routes } = mounted();
    const open = route(routes, '/open');
    expect(call(open, '172.22.96.1', '172.22.96.135').status).not.toBe(404);
    expect(call(open, '172.22.96.1', '172.22.96.135', { 'x-forwarded-for': '9.9.9.9' }).status).toBe(404);
    expect(call(open, '172.22.96.7', '172.22.96.135').status).toBe(404);
  });

  it('a gateway request naming the WSL address as its Host never gets a challenge', () => {
    const { routes } = mounted();
    const challenge = route(routes, '/challenge');
    const out = call(challenge, '172.22.96.1', '172.22.96.135', { host: '172.22.96.135:4040', origin: 'http://172.22.96.135:4040', 'content-type': 'application/json' }, { ticketId: 'x', secretProof: 'y', publicKey: 'z' });
    expect(out.status).not.toBe(200);
    expect(JSON.stringify(out.body ?? {})).not.toContain('challenge"');
  });

  it('the unlock check uses the same peer rule', () => {
    const { svc } = mounted();
    const spy = vi.spyOn(svc, 'redeemPeer');
    svc.verifyUnlockLocalAccess({ socket: { remoteAddress: '172.22.96.1', localAddress: '172.22.96.135' }, headers: { host: '127.0.0.1:4040', origin: 'http://127.0.0.1:4040' }, body: { localAccess: { credentialId: 'x', challenge: 'y', signature: 'z' } } } as never);
    expect(spy).toHaveBeenCalled();
  });
});
