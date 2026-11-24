/** SEC-139: the relay never trusts a caller-written forwarding header unless the deployment names one. */
import { describe, it, expect } from 'vitest';
import { resolveClientAddress, resolveClientAddressParts, normalizeAddress, exactAddress } from '../../../../src/threadline/relay/clientAddress.js';

const req = (headers: Record<string, string | string[]>, remoteAddress = '10.0.0.1') =>
  ({ headers, socket: { remoteAddress } }) as unknown as Parameters<typeof resolveClientAddress>[0];

describe('resolveClientAddress (SEC-139)', () => {
  it('ignores x-forwarded-for when no header is named (the old spoof: first entry chosen by the caller)', () => {
    expect(resolveClientAddress(req({ 'x-forwarded-for': '6.6.6.6' }))).toBe('10.0.0.1');
    expect(resolveClientAddress(req({ 'x-forwarded-for': '6.6.6.6' }), '')).toBe('10.0.0.1');
  });
  it('uses a named single-address header such as fly-client-ip', () => {
    expect(resolveClientAddress(req({ 'fly-client-ip': '203.0.113.7' }), 'Fly-Client-IP')).toBe('203.0.113.7');
  });
  it('falls back to the socket when the named header is missing, not an IP, or a list', () => {
    expect(resolveClientAddress(req({}), 'fly-client-ip')).toBe('10.0.0.1');
    expect(resolveClientAddress(req({ 'fly-client-ip': 'x'.repeat(5000) }), 'fly-client-ip')).toBe('10.0.0.1');
    expect(resolveClientAddress(req({ 'fly-client-ip': '1.1.1.1, 2.2.2.2' }), 'fly-client-ip')).toBe('10.0.0.1');
  });
  it('x-forwarded-for as the named header means its right-most entry, never the caller-written first one', () => {
    expect(resolveClientAddress(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4' }), 'x-forwarded-for')).toBe('198.51.100.4');
  });
  it('folds IPv4-mapped IPv6 and case so one caller has one key', () => {
    expect(normalizeAddress('::ffff:192.0.2.5')).toBe('192.0.2.5');
    expect(resolveClientAddress(req({}, '::FFFF:192.0.2.5'))).toBe('192.0.2.5');
  });
  it('keys IPv6 by its /64 network, in one canonical form', () => {
    const k = '2001:0db8:0000:0001::/64';
    expect(normalizeAddress('2001:DB8:0:1::1')).toBe(k);
    expect(normalizeAddress('2001:db8:0:1:ffff:ffff:ffff:ffff')).toBe(k);
    expect(normalizeAddress('2001:db8::1:0:0:0:1')).toBe(k);
    expect(normalizeAddress('2001:db8:0:2::1')).not.toBe(k);
    expect(resolveClientAddress(req({ 'fly-client-ip': '2001:db8:0:1:aaaa::5' }), 'fly-client-ip')).toBe(k);
  });
  it('reports unknown only when there is no socket address', () => {
    expect(resolveClientAddress({ headers: {}, socket: {} } as never)).toBe('unknown');
  });
  it('keeps the exact address for scoping while the rate key is the /64', () => {
    const p = resolveClientAddressParts(req({}, '2001:db8:0:1::5'));
    expect(p.rateKey).toBe('2001:0db8:0000:0001::/64');
    expect(p.exact).toBe('2001:0db8:0000:0001:0000:0000:0000:0005');
    expect(exactAddress('2001:db8:0:1::6')).not.toBe(p.exact);
    expect(resolveClientAddressParts(req({}, '::ffff:192.0.2.5'))).toEqual({ exact: '192.0.2.5', rateKey: '192.0.2.5' });
  });
});
