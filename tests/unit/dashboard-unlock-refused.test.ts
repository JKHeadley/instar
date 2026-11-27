import { describe, expect, it } from 'vitest';
import { arrivedOverLocalTls, dashboardUnlockRefused, defaultGatewayFromProcRoute, wslWindowsHostAddress } from '../../src/core/desktopTransport.js';

const NO_WSL = null;
const WSL_HOST = '172.22.96.1';

describe('dashboardUnlockRefused — the rule the console checks before showing a PIN box', () => {
  it('never refuses when remote desktop is off, whatever the connection', () => {
    expect(dashboardUnlockRefused(false, false, '100.101.95.10', undefined, NO_WSL)).toBe(false);
    expect(dashboardUnlockRefused(false, false, undefined, undefined, NO_WSL)).toBe(false);
  });
  it('with remote desktop on, accepts a secure or a local connection', () => {
    expect(dashboardUnlockRefused(true, true, '100.101.95.10', undefined, NO_WSL)).toBe(false);
    expect(dashboardUnlockRefused(true, false, '127.0.0.1', undefined, NO_WSL)).toBe(false);
    expect(dashboardUnlockRefused(true, false, '::ffff:127.0.0.1', undefined, NO_WSL)).toBe(false);
    expect(dashboardUnlockRefused(true, false, '::1', undefined, NO_WSL)).toBe(false);
  });
  it('with remote desktop on, refuses a plain connection from another address', () => {
    expect(dashboardUnlockRefused(true, false, '100.101.95.10', undefined, NO_WSL)).toBe(true);
    expect(dashboardUnlockRefused(true, false, '172.24.80.1', undefined, NO_WSL)).toBe(true);
    expect(dashboardUnlockRefused(true, false, undefined, undefined, NO_WSL)).toBe(true);
  });
  it('a forwarded-https mark is trusted only from the Windows host of a WSL machine (the Mama PC case)', () => {
    // Tailscale serve on Windows terminates TLS and forwards through Windows port forwarding.
    expect(dashboardUnlockRefused(true, false, WSL_HOST, 'https', WSL_HOST)).toBe(false);
    expect(dashboardUnlockRefused(true, false, `::ffff:${WSL_HOST}`, 'https', WSL_HOST)).toBe(false);
    // Plain http through the same forwarding: refused.
    expect(dashboardUnlockRefused(true, false, WSL_HOST, undefined, WSL_HOST)).toBe(true);
    expect(dashboardUnlockRefused(true, false, WSL_HOST, 'http', WSL_HOST)).toBe(true);
    // The mark from any other address, or on a machine that is not WSL: refused.
    expect(dashboardUnlockRefused(true, false, '100.124.55.70', 'https', WSL_HOST)).toBe(true);
    expect(dashboardUnlockRefused(true, false, WSL_HOST, 'https', NO_WSL)).toBe(true);
  });
});

describe('WSL host detection', () => {
  const ROUTE = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'eth0\t00000000\t016016AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n'
    + 'eth0\t006016AC\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0\n';
  it('reads the default gateway from /proc/net/route', () => {
    expect(defaultGatewayFromProcRoute(ROUTE)).toBe('172.22.96.1');
    expect(defaultGatewayFromProcRoute('Iface\tDestination\tGateway\n')).toBeNull();
  });
  it('is null off WSL', () => {
    if (process.platform === 'linux' && process.env.WSL_DISTRO_NAME) return;
    const read = (f: string) => (f === '/proc/version' ? 'Linux version 6.1 (gcc)' : ROUTE);
    expect(wslWindowsHostAddress(Date.now() + 10 * 60_000, read)).toBeNull();
  });
  it('arrivedOverLocalTls: TLS socket and loopback always count', () => {
    expect(arrivedOverLocalTls(true, '8.8.8.8', undefined, NO_WSL)).toBe(true);
    expect(arrivedOverLocalTls(false, '127.0.0.1', undefined, NO_WSL)).toBe(true);
  });
});
