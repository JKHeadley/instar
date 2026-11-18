/**
 * The Instar app reaches imported history with the owner's signed device
 * (docs/specs/import-from-claude-chatgpt.md §B.3, §D): owner only, never a browser device.
 */
import { describe, expect, it } from 'vitest';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';
import { isOwnerAppDevice } from '../../src/server/importedHistoryRoutes.js';

const rule = (method: string, p: string) => DEVICE_ALLOWLIST.find((r) => r.method === method && r.re.test(p.toLowerCase()));

describe('imported history on the device allowlist', () => {
  it('lists, reads, searches, previews and applies, owner only and not for browsers', () => {
    for (const [m, p] of [
      ['GET', '/mobile/imported-history/conversations'],
      ['GET', '/mobile/imported-history/projects'],
      ['GET', '/mobile/imported-history/conversations/imported%3Aclaude%3A5f1c2d3e-aaaa-bbbb-cccc-1234567890ab'],
      ['GET', '/mobile/imported-history/conversations/imported:chatgpt:67a1b2c3-0000-1111-2222-333344445555'],
      ['GET', '/mobile/imported-history/search'],
      ['POST', '/mobile/imported-history/preview'],
      ['POST', '/mobile/imported-history/apply'],
    ] as const) {
      const r = rule(m, p);
      expect(r, `${m} ${p}`).toBeDefined();
      expect(r!.ownerOnly).toBe(true);
      expect(r!.browser).toBeUndefined();
    }
  });

  it('does not open anything else under that prefix', () => {
    expect(rule('GET', '/mobile/imported-history/conversations/../../secrets')).toBeUndefined();
    expect(rule('DELETE', '/mobile/imported-history/conversations')).toBeUndefined();
    expect(rule('POST', '/mobile/imported-history/conversations')).toBeUndefined();
  });
});

describe('who counts as the owner\'s app device', () => {
  const req = (x: Record<string, unknown>) => x as never;
  it('the owner\'s signed device only', () => {
    expect(isOwnerAppDevice(req({ instarPrincipal: { kind: 'device' }, instarDevicePerson: { role: 'owner' } }))).toBe(true);
    expect(isOwnerAppDevice(req({ instarPrincipal: { kind: 'device' }, instarDevicePerson: { role: 'owner' }, instarDeviceClient: 'browser' }))).toBe(false);
    expect(isOwnerAppDevice(req({ instarPrincipal: { kind: 'device' }, instarDevicePerson: { role: 'team' } }))).toBe(false);
    expect(isOwnerAppDevice(req({ instarPrincipal: { kind: 'device-notify' }, instarDevicePerson: { role: 'owner' } }))).toBe(false);
    expect(isOwnerAppDevice(req({}))).toBe(false);
  });
});
