import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { MacLocalNetworkAccessMonitor, isLocalNetworkHost, localNetworkReport, curlReach, installMacLocalNetworkMonitor, MAC_LOCAL_NETWORK_FEATURE } from '../../src/core/MacLocalNetworkAccess.js';

function make(over: Partial<ConstructorParameters<typeof MacLocalNetworkAccessMonitor>[0]> = {}) {
  const reports: unknown[] = [];
  let t = 1_000_000;
  const confirms: string[] = [];
  const m = new MacLocalNetworkAccessMonitor({
    platform: 'darwin', execPath: '/x/node', now: () => t,
    confirm: async (h, p) => { confirms.push(`${h}:${p}`); return 'reachable'; },
    report: (e) => reports.push(e), ...over,
  });
  return { m, reports, confirms, advance: (ms: number) => { t += ms; } };
}

describe('isLocalNetworkHost', () => {
  it('admits private and link-local, refuses public and Tailscale', () => {
    for (const h of ['10.0.0.1', '172.16.3.4', '172.31.9.9', '192.168.87.47', '169.254.1.1', 'fd12:3456::1', 'fe80::1', 'studio.local']) expect(isLocalNetworkHost(h)).toBe(true);
    for (const h of ['100.124.55.70', '172.32.0.1', '8.8.8.8', 'echo-studio.dawn-tunnel.dev', '127.0.0.1']) expect(isLocalNetworkHost(h)).toBe(false);
  });
});

describe('MacLocalNetworkAccessMonitor', () => {
  it('reports a denial when node is refused but curl connects', async () => {
    const { m, reports } = make();
    expect(await m.observe('192.168.87.47', 4042, 'EHOSTUNREACH')).toBe('denied');
    expect(reports).toHaveLength(1);
    const r = reports[0] as ReturnType<typeof localNetworkReport>;
    expect(r.feature).toBe(MAC_LOCAL_NETWORK_FEATURE);
    expect(r.impact).toContain('Privacy & Security');
    expect(r.impact).toContain('/x/node');
    expect(m.getState()).toMatchObject({ verdict: 'denied', lastDeniedHost: '192.168.87.47' });
  });

  it('says nothing when curl cannot connect either (a really dead peer)', async () => {
    const { m, reports } = make({ confirm: async () => 'unreachable' });
    expect(await m.observe('192.168.87.47', 4042, 'EHOSTUNREACH')).toBe('not-denied');
    expect(reports).toHaveLength(0);
    expect(m.getState().verdict).toBe('unknown');
  });

  it('ignores other platforms, other errors, and non-home-network hosts', async () => {
    const { m, confirms } = make();
    expect(await m.observe('192.168.87.47', 4042, 'ECONNREFUSED')).toBe('ignored');
    expect(await m.observe('100.124.55.70', 4042, 'EHOSTUNREACH')).toBe('ignored');
    const linux = make({ platform: 'linux' });
    expect(await linux.m.observe('192.168.87.47', 4042, 'EHOSTUNREACH')).toBe('ignored');
    expect(confirms).toHaveLength(0);
  });

  it('confirms the same host at most every 10 minutes and re-reports a persisting denial every 25', async () => {
    const { m, reports, confirms, advance } = make();
    await m.observe('192.168.87.47', 4042, 'EHOSTUNREACH');
    advance(60_000);
    await m.observe('192.168.87.47', 4042, 'EHOSTUNREACH');
    expect(confirms).toHaveLength(1);
    expect(reports).toHaveLength(1);
    advance(9 * 60_000); // 10 min since first confirm
    await m.observe('192.168.87.47', 4042, 'EHOSTUNREACH');
    expect(confirms).toHaveLength(2);
    expect(reports).toHaveLength(1); // under 25 min since the report
    advance(16 * 60_000);
    await m.observe('192.168.87.47', 4042, 'EHOSTUNREACH');
    expect(reports).toHaveLength(2);
  });

  it('a later home-network connect clears the verdict', async () => {
    const { m } = make();
    await m.observe('192.168.87.47', 4042, 'EHOSTUNREACH');
    m.noteConnected('192.168.87.47');
    expect(m.getState().verdict).toBe('unknown');
  });

  it('a throwing reporter never breaks the caller', async () => {
    const { m } = make({ report: () => { throw new Error('boom'); } });
    await expect(m.observe('192.168.87.47', 4042, 'EHOSTUNREACH')).resolves.toBe('denied');
  });
});

describe('curlReach (real /usr/bin/curl)', () => {
  it.runIf(process.platform === 'darwin')('reads a listening port as reachable and a closed one as unreachable', async () => {
    const srv = http.createServer((_q, s) => s.end('ok'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    expect(await curlReach('127.0.0.1', port)).toBe('reachable');
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await curlReach('127.0.0.1', port)).toBe('unreachable');
  });
});

describe('installMacLocalNetworkMonitor (wiring)', () => {
  it('is a no-op off macOS and returns a live monitor on macOS', () => {
    expect(installMacLocalNetworkMonitor({ platform: 'linux', report: () => {} })).toBeNull();
    const m = installMacLocalNetworkMonitor({ platform: 'darwin', report: () => {} });
    expect(m).not.toBeNull();
    expect(m!.getState().platform).toBe('darwin');
  });
});
